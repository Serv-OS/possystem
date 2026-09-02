// supabase/functions/stuart-webhook/index.ts
//
// Stuart courier webhook receiver. Stuart posts job/delivery status updates to the URL you
// register in the Stuart dashboard. We secure the endpoint with a shared secret on the URL
// (?key=<STUART_WEBHOOK_SECRET>), dedup on a synthesized event id (delivery_status_events.event_id
// UNIQUE → at-least-once safe), update the matching courier_deliveries row (matched by the Stuart
// job id stored in uber_delivery_id), and record the actual cost on a terminal state.
//
// Deployed --no-verify-jwt; does its own auth. Mirrors uber-webhook.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { parseStuartJob, mapStuartStatus, parseStuartCost, verifyStuartKey } from '../_shared/stuart.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const WEBHOOK_SECRET = Deno.env.get('STUART_WEBHOOK_SECRET') ?? '';
const sb = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { autoRefreshToken: false, persistSession: false } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok');
  if (req.method !== 'POST') return new Response('ok', { status: 200 });

  // Shared-secret auth via the registered URL's ?key= param.
  if (!verifyStuartKey(req.url, WEBHOOK_SECRET)) return new Response('unauthorized', { status: 401 });

  const raw = await req.text();
  let evt: any;
  try { evt = JSON.parse(raw); } catch { return new Response('bad json', { status: 400 }); }

  const p = parseStuartJob(evt);
  const status = mapStuartStatus(p.rawStatus);
  const jobId = p.id;
  // Stuart events have no guaranteed stable id → synthesize one from STABLE payload fields
  // (never Date.now(), which would defeat dedup and insert a new row on every retry).
  const stamp = evt?.data?.updated_at || evt?.updated_at || p.deliveredAt || p.pickedAt || p.etaDropoff || p.rawStatus || 'x';
  const eventId = evt?.id || evt?.event_id || `stuart:${jobId || 'evt'}:${p.rawStatus || 'x'}:${stamp}`;

  // Resolve the delivery this event belongs to BEFORE recording it. delivery_id is the ONLY
  // join key the timeline has (get_delivery_detail reads events by delivery_id), so writing
  // nulls here orphaned every event and the timeline was permanently empty. Read the row with
  // its own select rather than reusing the update below: the monotonic guard can legitimately
  // match no row (terminal row + late in-flight event), which would orphan the event again.
  let evDel: { id: string; location_id: string | null } | null = null;
  if (jobId) {
    const { data } = await sb.from('courier_deliveries')
      .select('id, location_id')
      .eq('uber_delivery_id', jobId).eq('dispatch_backend', 'stuart')
      .maybeSingle();
    evDel = (data as any) || null;
  }

  // Idempotency: first writer wins.
  const { data: inserted } = await sb.from('delivery_status_events')
    .upsert({ event_id: String(eventId), delivery_id: evDel?.id ?? null, location_id: evDel?.location_id ?? null, status, payload: evt, received_at: new Date().toISOString() }, { onConflict: 'event_id', ignoreDuplicates: true })
    .select('event_id');
  if (!inserted || inserted.length === 0) return new Response('ok (dup)', { status: 200 });

  if (jobId) {
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (p.rawStatus) patch.status = status;
    if (p.trackingUrl) patch.tracking_url = p.trackingUrl;
    if (p.courierName) patch.courier_name = p.courierName;
    if (p.courierPhone) patch.courier_phone = p.courierPhone;
    if (p.lat != null) patch.last_lat = p.lat;
    if (p.lng != null) patch.last_lng = p.lng;
    // Persist the time flow (the webhook is the primary real-time signal — without this,
    // delivered_at is NULL right when the order completes and no one is polling).
    const iso = (v: string | null) => { if (!v) return null; const d = new Date(v); return isNaN(d.getTime()) ? null : d.toISOString(); };
    const etaD = iso(p.etaDropoff); if (etaD) patch.eta = etaD;
    const etaP = iso(p.etaPickup); if (etaP) patch.pickup_eta = etaP;
    const pAt = iso(p.pickedAt); if (pAt) patch.picked_at = pAt;
    const dAt = iso(p.deliveredAt); if (dAt) patch.delivered_at = dAt;
    // Monotonic status: an out-of-order / at-least-once event must never regress a TERMINAL row
    // (delivered/canceled/returned) back to an in-flight status. A terminal event may still land.
    let upd = sb.from('courier_deliveries').update(patch).eq('uber_delivery_id', jobId).eq('dispatch_backend', 'stuart');
    const newTerminal = status === 'delivered' || status === 'canceled' || status === 'returned';
    if (!newTerminal) upd = upd.not('status', 'in', '(delivered,canceled,returned)');
    const { data: del } = await upd.select('id, location_id').maybeSingle();

    if (del?.id && (status === 'delivered' || status === 'canceled' || status === 'returned')) {
      const cost = parseStuartCost(evt);
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
