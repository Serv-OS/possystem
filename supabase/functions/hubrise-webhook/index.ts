// supabase/functions/hubrise-webhook/index.ts
//
// Active HubRise callback receiver (PUBLIC — authenticity is the HMAC signature).
// HubRise POSTs order.create / order.update events here; delivery is AT-LEAST-ONCE
// (6 retries, then dropped), so we:
//   1. verify X-HubRise-Hmac-SHA256 over the RAW body (keyed with client_secret),
//   2. DEDUP on the event id (unique constraint) — re-process unless already 'processed',
//   3. map new_state -> an order_queue row (source='hubrise') + hubrise_order_links,
//   4. ACK 200 FAST (well within the 20s window).
// Transient failures return 5xx so HubRise retries; we never return 4xx for a transient
// problem (4xx is treated as "acknowledged" and the event would be lost). Anything missed
// is recovered by the passive event log in hubrise-reconcile. ?loc=<ops_location_id>.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { verifyHmac, getOrder } from '../_shared/hubrise.ts';
import { ingestOrder } from '../_shared/hubrise-ingest.ts';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type, x-hubrise-hmac-sha256' };
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const CLIENT_SECRET = Deno.env.get('HUBRISE_CLIENT_SECRET') ?? '';
const sb = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { autoRefreshToken: false, persistSession: false } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return new Response('ok', { status: 200 });

  const url = new URL(req.url);
  const loc = url.searchParams.get('loc') || '';
  const raw = await req.text();

  // 1) Authenticity — HMAC over the raw bytes. Bad signature => drop.
  const sig = req.headers.get('x-hubrise-hmac-sha256');
  if (!(await verifyHmac(raw, sig, CLIENT_SECRET))) return new Response('invalid signature', { status: 401 });

  let event: any;
  try { event = JSON.parse(raw); } catch { return new Response('bad json', { status: 400 }); }

  const eventId = event?.id;
  const resourceType = event?.resource_type;
  const eventType = event?.event_type;
  if (!eventId) return new Response('ok', { status: 200 });

  try {
    // 2) Dedup. Insert (ignore conflicts). If the row already existed AND was already
    // processed, ack. Otherwise (new, or a prior failed/partial attempt) process it —
    // ingestOrder is idempotent, so reprocessing is safe.
    const { data: inserted, error: dupErr } = await sb.from('hubrise_events')
      .upsert({
        event_id: eventId, location_id: loc || event?.location_id || null,
        resource_type: resourceType, event_type: eventType, order_id: event?.order_id || null,
      }, { onConflict: 'event_id', ignoreDuplicates: true })
      .select('event_id');
    if (dupErr) return new Response('retry', { status: 503 });
    if (!inserted || inserted.length === 0) {
      const { data: prior } = await sb.from('hubrise_events').select('status').eq('event_id', eventId).maybeSingle();
      if (prior?.status === 'processed') return new Response('ok', { status: 200 });
      // else fall through and (re)process
    }

    if (resourceType === 'order' && (eventType === 'create' || eventType === 'update')) {
      let order = event?.new_state;
      if ((!order || !order.items) && event?.order_id) {
        const { data: conn } = await sb.from('hubrise_connections')
          .select('access_token, hubrise_location_id').eq('location_id', loc).maybeSingle();
        if (conn?.access_token && conn?.hubrise_location_id) {
          order = await getOrder(conn.access_token, conn.hubrise_location_id, event.order_id).catch(() => order);
        }
      }
      if (order?.id) {
        await ingestOrder(sb, loc, order, event?.created_at || null);
        try { await sb.from('hubrise_connections').update({ last_event_at: new Date().toISOString() }).eq('location_id', loc); } catch { /* non-fatal */ }
      }
    }

    await sb.from('hubrise_events').update({ status: 'processed', processed_at: new Date().toISOString() }).eq('event_id', eventId);
    return new Response('ok', { status: 200 });
  } catch (e) {
    await sb.from('hubrise_events').update({ status: 'error', error: e instanceof Error ? e.message : String(e) }).eq('event_id', eventId).catch(() => {});
    return new Response('error', { status: 503 });
  }
});
