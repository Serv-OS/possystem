// supabase/functions/uber-webhook/index.ts
//
// Uber Direct delivery webhook receiver. Handles event.delivery_status (status changes)
// and event.courier_update (courier position ~every 20s). Verifies the x-uber-signature
// HMAC-SHA256 over the RAW body, dedups on the event id (delivery_status_events.event_id
// UNIQUE → at-least-once safe), updates the matching deliveries row, ACKs <20s.
//
// Deployed --no-verify-jwt; does its own signature auth. Mirrors hubrise-webhook.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { verifyUberSignature, parseDeliveryResp, mapUberStatus, parseDeliveryCost } from '../_shared/uber.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const SIGNING_KEY = Deno.env.get('UBER_DIRECT_WEBHOOK_SIGNING_KEY') ?? '';
const sb = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { autoRefreshToken: false, persistSession: false } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok');
  if (req.method !== 'POST') return new Response('ok', { status: 200 });

  // Read the EXACT raw bytes — never re-serialize before verifying the HMAC.
  const raw = await req.text();
  const sig = req.headers.get('x-uber-signature') || req.headers.get('x-postmates-signature');
  if (!(await verifyUberSignature(raw, sig, SIGNING_KEY))) {
    return new Response('bad signature', { status: 401 });
  }

  let evt: any;
  try { evt = JSON.parse(raw); } catch { return new Response('bad json', { status: 400 }); }

  const eventId = evt?.id || evt?.event_id || `${evt?.delivery_id || 'evt'}:${evt?.created || Date.now()}`;
  const deliveryId = evt?.delivery_id || evt?.data?.id || evt?.data?.delivery_id || null;
  const p = parseDeliveryResp(evt);
  const status = mapUberStatus(p.rawStatus);

  // Idempotency: first writer wins; a duplicate event is acked without reprocessing.
  const { data: inserted } = await sb.from('delivery_status_events')
    .upsert({ event_id: eventId, delivery_id: null, location_id: null, status, payload: evt, received_at: new Date().toISOString() }, { onConflict: 'event_id', ignoreDuplicates: true })
    .select('event_id');
  if (!inserted || inserted.length === 0) return new Response('ok (dup)', { status: 200 });

  // Update the matching delivery (by Uber id). courier_update carries position; delivery_status carries status.
  if (deliveryId) {
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (p.rawStatus) patch.status = status;
    if (p.trackingUrl) patch.tracking_url = p.trackingUrl;
    if (p.courierName) patch.courier_name = p.courierName;
    if (p.courierPhone) patch.courier_phone = p.courierPhone;
    if (p.lat != null) patch.last_lat = p.lat;
    if (p.lng != null) patch.last_lng = p.lng;
    const { data: del } = await sb.from('deliveries').update(patch).eq('uber_delivery_id', deliveryId).select('id, location_id').maybeSingle();

    // Reconciliation: on a terminal state, record the ACTUAL Uber cost against the delivery.
    if (del?.id && (status === 'delivered' || status === 'canceled' || status === 'returned')) {
      const cost = parseDeliveryCost(evt);
      if (cost) {
        await sb.from('delivery_costs_actual').upsert({
          delivery_id: del.id, location_id: del.location_id,
          base_minor: cost.totalMinor, total_minor: cost.totalMinor, currency: cost.currency,
          recorded_at: new Date().toISOString(),
        }, { onConflict: 'delivery_id' });
      }
    }
  }

  return new Response('ok', { status: 200 });
});
