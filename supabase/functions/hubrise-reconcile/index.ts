// supabase/functions/hubrise-reconcile/index.ts
//
// Reliability cron (invoked by api/hubrise-cron.js). For every connected venue:
//   1. drain the PASSIVE callback event log (GET /callback/events) — the durable
//      replay path that recovers any active webhook missed (active deliveries are
//      dropped after 6 failed retries; List-Orders can't reconcile status changes
//      because it only filters by created_at). Each event is fetched, ingested
//      (idempotent), then acknowledged (DELETE) so it clears from HubRise.
//   2. retry failed outbound status pushes (hubrise_order_links.push_error set).
//
// Auth: x-run-secret === HUBRISE_RECONCILE_SECRET, or Bearer SERVICE_ROLE.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { listEvents, getEvent, ackEvent } from '../_shared/hubrise.ts';
import { ingestOrder, patchOrderStatus, resyncInventory } from '../_shared/hubrise-ingest.ts';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-run-secret' };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const RUN_SECRET = Deno.env.get('HUBRISE_RECONCILE_SECRET') ?? '';
const sb = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { autoRefreshToken: false, persistSession: false } });

const EVENTS_PER_RUN = 50;
const RETRIES_PER_RUN = 25;

function eventList(raw: any): any[] {
  if (Array.isArray(raw)) return raw;
  return raw?.events || raw?.data || [];
}

async function reconcileLocation(conn: any): Promise<{ drained: number; retried: number; errors: number }> {
  const loc = conn.location_id;
  const token = conn.access_token;
  let drained = 0, retried = 0, errors = 0;

  // 1) Passive event log
  try {
    const events = eventList(await listEvents(token)).slice(0, EVENTS_PER_RUN);
    for (const ev of events) {
      try {
        if (ev?.resource_type === 'order' && ev?.id) {
          const { data: prior } = await sb.from('hubrise_events').select('status').eq('event_id', ev.id).maybeSingle();
          if (prior?.status !== 'processed') {
            await sb.from('hubrise_events').upsert({
              event_id: ev.id, location_id: loc, resource_type: 'order', event_type: ev.event_type, order_id: ev.order_id || null,
            }, { onConflict: 'event_id', ignoreDuplicates: true });
            const full = await getEvent(token, ev.id);
            const order = full?.new_state;
            if (order?.id) await ingestOrder(sb, loc, order, ev.created_at || full?.created_at || null);
            await sb.from('hubrise_events').update({ status: 'processed', processed_at: new Date().toISOString() }).eq('event_id', ev.id);
          }
        }
        if (ev?.id) await ackEvent(token, ev.id); // clear from HubRise's log
        drained++;
      } catch { errors++; }
    }
  } catch { errors++; }

  // 2) Retry failed outbound status pushes
  try {
    const { data: failed } = await sb.from('hubrise_order_links')
      .select('ref, pushed_status').eq('location_id', loc).not('push_error', 'is', null).limit(RETRIES_PER_RUN);
    for (const link of (failed || [])) {
      if (!link.pushed_status) continue;
      try { await patchOrderStatus(sb, link.ref, link.pushed_status); retried++; } catch { errors++; }
    }
  } catch { errors++; }

  // 3) Inventory catch-up — ONLY when an instant push is known to have failed.
  //
  // This used to re-PUT the whole out-of-stock set every run, so a venue that had
  // changed nothing still pushed its full 86 list 720 times a day. 86 state is
  // pushed from the POS the moment it changes; the cron exists solely to recover
  // a push that did not land, which is what inventory_dirty records.
  if (conn.inventory_dirty) {
    try {
      await resyncInventory(sb, loc);
      await sb.from('hubrise_connections')
        .update({ inventory_dirty: false, inventory_pushed_at: new Date().toISOString() })
        .eq('location_id', loc);
    } catch { errors++; }
  }

  try { await sb.from('hubrise_connections').update({ last_reconcile_at: new Date().toISOString() }).eq('location_id', loc); } catch { /* non-fatal */ }
  return { drained, retried, errors };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  let body: any = {}; try { body = await req.json(); } catch { /* allow empty */ }
  const bearer = (req.headers.get('Authorization') ?? '').replace('Bearer ', '').trim();
  const secret = (req.headers.get('x-run-secret') ?? body?.secret ?? '').trim();
  if (!((bearer && bearer === SERVICE_ROLE) || (RUN_SECRET && secret === RUN_SECRET))) {
    return json({ error: 'unauthorised' }, 403);
  }

  const { data: conns } = await sb.from('hubrise_connections').select('*').eq('status', 'connected');
  const results: any[] = [];
  for (const conn of (conns || [])) {
    if (!conn.access_token) continue;
    try { results.push({ location_id: conn.location_id, ...(await reconcileLocation(conn)) }); }
    catch (e) { results.push({ location_id: conn.location_id, error: e instanceof Error ? e.message : String(e) }); }
  }
  return json({ ok: true, locations: results.length, results });
});
