// supabase/functions/uber-direct/index.ts
//
// Uber Direct control plane for ServOS. POST { action }:
//   quote            -> live delivery quote for a dropoff address (the surcharge source).
//                       Geocodes (postcodes.io, free) → radius check → Uber quote. Returns
//                       the raw quote + coords + the venue's surcharge policy; the client
//                       normalises + computes the customer fee (src/lib/delivery/*). Graceful
//                       fallback (out_of_radius / not_configured+fallback fee / unavailable).
//   get_config       -> non-secret per-venue config for the Back Office.
//   set_config       -> upsert venue_uber_config (BO user with location access).
//   record_surcharge -> on order confirm, log delivery_quotes + delivery_surcharges (margin).
//
// Creds (UBER_DIRECT_*) live in env, never in the DB or the browser (mirrors hubrise-*).
// Deployed --no-verify-jwt; this fn does its own auth.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { getAccessToken, getQuote, geocodePostcode, haversineMiles, createDelivery, getDelivery, parseDeliveryResp, mapUberStatus } from '../_shared/uber.ts';
import { createOrder as createHubriseOrder, patchOrder as patchHubriseOrder } from '../_shared/hubrise.ts';
import { cancelDelivery } from '../_shared/uber.ts';

const e164 = (raw: string) => {
  const s = String(raw || '').replace(/[\s()-]/g, '');
  if (!s) return '';
  if (s.startsWith('+')) return s;
  if (s.startsWith('0')) return '+44' + s.slice(1);
  if (s.startsWith('44')) return '+' + s;
  return s;
};

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const ENV_CLIENT_ID = Deno.env.get('UBER_DIRECT_CLIENT_ID') ?? '';
const ENV_CLIENT_SECRET = Deno.env.get('UBER_DIRECT_CLIENT_SECRET') ?? '';
const ENV_CUSTOMER_ID = Deno.env.get('UBER_DIRECT_CUSTOMER_ID') ?? '';
const ENV_DEFAULT = (Deno.env.get('UBER_DIRECT_ENV') ?? 'sandbox') as 'sandbox' | 'prod';
const sb = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { autoRefreshToken: false, persistSession: false } });

const NON_SECRET = [
  'location_id', 'enabled', 'uber_customer_id', 'pickup_address', 'pickup_contact',
  'radius_miles', 'dispatch_backend', 'surcharge_policy', 'fallback_fee_minor', 'sms_tracking', 'env',
];
const pickNonSecret = (row: any) => {
  const out: Record<string, unknown> = {};
  if (!row) return out;
  for (const k of NON_SECRET) out[k] = row[k];
  return out;
};

async function requireToken(req: Request): Promise<{ ok: true; userId: string } | { ok: false; res: Response }> {
  const token = (req.headers.get('Authorization') || '').replace('Bearer ', '').trim();
  if (!token) return { ok: false, res: json({ error: 'Unauthorized' }, 401) };
  if (token === SERVICE_ROLE) return { ok: true, userId: 'service' };
  const { data: { user } } = await sb.auth.getUser(token);
  if (!user) return { ok: false, res: json({ error: 'Invalid token' }, 401) };
  return { ok: true, userId: user.id };
}

async function requireAccess(req: Request, locationId: string): Promise<{ ok: true; userId: string } | { ok: false; res: Response }> {
  const t = await requireToken(req);
  if (!t.ok) return t;
  if (t.userId === 'service') return t;
  const [{ data: ul }, { data: prof }] = await Promise.all([
    sb.from('user_locations').select('location_id').eq('user_id', t.userId).eq('location_id', locationId).maybeSingle(),
    sb.from('user_profiles').select('role').eq('id', t.userId).maybeSingle(),
  ]);
  if (!ul && prof?.role !== 'super_admin') return { ok: false, res: json({ error: 'No access to this location' }, 403) };
  return t;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: 'Bad JSON' }, 400); }
  const action = body?.action;
  const loc = body?.ops_location_id;
  if (!action) return json({ error: 'action required' }, 400);

  try {
    // ── BO: read config ──────────────────────────────────────────────────────
    if (action === 'get_config') {
      const acc = await requireAccess(req, loc); if (!acc.ok) return acc.res;
      const { data } = await sb.from('venue_uber_config').select('*').eq('location_id', loc).maybeSingle();
      return json({ ok: true, config: pickNonSecret(data) });
    }

    // ── BO: write config ─────────────────────────────────────────────────────
    if (action === 'set_config') {
      const acc = await requireAccess(req, loc); if (!acc.ok) return acc.res;
      const patch = body?.patch || {};
      const allowed: Record<string, unknown> = { location_id: loc, updated_at: new Date().toISOString(), updated_by: acc.userId === 'service' ? null : acc.userId };
      for (const k of NON_SECRET) if (k !== 'location_id' && k in patch) allowed[k] = patch[k];
      const { error } = await sb.from('venue_uber_config').upsert(allowed, { onConflict: 'location_id' });
      if (error) return json({ error: error.message }, 500);
      const { data } = await sb.from('venue_uber_config').select('*').eq('location_id', loc).maybeSingle();
      return json({ ok: true, config: pickNonSecret(data) });
    }

    // ── POS/online/catering: live quote ──────────────────────────────────────
    if (action === 'quote') {
      const t = await requireToken(req); if (!t.ok) return t.res;
      const { data: cfg } = await sb.from('venue_uber_config').select('*').eq('location_id', loc).maybeSingle();
      if (!cfg || !cfg.enabled) return json({ ok: true, available: false, reason: 'disabled' });

      const policy = cfg.surcharge_policy || { mode: 'pass_through' };
      const radiusMiles = Number(cfg.radius_miles ?? 3);
      const currency = (cfg.pickup_address?.country === 'US' ? 'USD' : 'GBP');

      // Resolve dropoff coordinates (use supplied lat/lng, else geocode the postcode — free).
      let dropoff = { ...(body?.dropoff || {}) };
      if (dropoff.lat == null || dropoff.lng == null) {
        const geo = dropoff.postcode ? await geocodePostcode(dropoff.postcode) : null;
        if (geo) { dropoff.lat = geo.lat; dropoff.lng = geo.lng; }
      }
      const pickup = cfg.pickup_address || {};
      const distanceMiles = (pickup.lat != null && dropoff.lat != null) ? haversineMiles(pickup, dropoff) : null;
      const withinRadius = distanceMiles != null ? distanceMiles <= radiusMiles : null;

      if (withinRadius === false) {
        return json({ ok: true, available: false, reason: 'out_of_radius', distanceMiles, radiusMiles, policy, currency });
      }

      // HubRise Bridge dispatch can't quote live (the Bridge has no pre-order estimate) —
      // the customer fee is a CONFIGURED fee. Use fallback_fee_minor as the cost basis +
      // apply the surcharge policy. Set a flat policy (or fallback fee) for Bridge venues.
      if (cfg.dispatch_backend === 'hubrise_bridge') {
        const feeMinor = cfg.fallback_fee_minor != null ? cfg.fallback_fee_minor : 0;
        return json({ ok: true, available: true, fallback: true, configured: true, raw: { fee: feeMinor, currency }, dropoff, distanceMiles, withinRadius: true, policy, currency, radiusMiles });
      }

      const clientId = ENV_CLIENT_ID, clientSecret = ENV_CLIENT_SECRET;
      const customerId = cfg.uber_customer_id || ENV_CUSTOMER_ID;
      const env = (cfg.env || ENV_DEFAULT) as 'sandbox' | 'prod';

      // No creds yet (build-now, go-live owner-gated) → use the configured fallback fee if set.
      if (!clientId || !clientSecret || !customerId) {
        if (cfg.fallback_fee_minor != null) {
          return json({ ok: true, available: true, fallback: true, raw: { fee: cfg.fallback_fee_minor, currency }, dropoff, distanceMiles, withinRadius: true, policy, currency, radiusMiles });
        }
        return json({ ok: true, available: false, reason: 'not_configured', policy, currency });
      }

      try {
        const token = await getAccessToken(env, clientId, clientSecret);
        const raw = await getQuote({ env, token, customerId, pickup, dropoff });
        return json({ ok: true, available: true, raw, dropoff, distanceMiles, withinRadius: true, policy, currency, radiusMiles });
      } catch (e) {
        // Uber slow/unavailable → graceful fallback (configurable estimated fee), flagged.
        if (cfg.fallback_fee_minor != null) {
          return json({ ok: true, available: true, fallback: true, raw: { fee: cfg.fallback_fee_minor, currency }, dropoff, distanceMiles, withinRadius: true, policy, currency, radiusMiles, error: String((e as Error)?.message || e) });
        }
        return json({ ok: true, available: false, reason: 'quote_failed', error: String((e as Error)?.message || e), policy, currency });
      }
    }

    // ── On order confirm: log the quote + the surcharge (margin reporting) ────
    if (action === 'record_surcharge') {
      const t = await requireToken(req); if (!t.ok) return t.res;
      const s = body?.surcharge || {};
      const orderRef = body?.order_ref || null;
      const currency = s.currency || 'GBP';
      await sb.from('delivery_quotes').insert({
        location_id: loc, order_ref: orderRef, quote_id: s.quoteId || null,
        dropoff_address: body?.dropoff || null, dropoff_lat: body?.dropoff?.lat ?? null, dropoff_lng: body?.dropoff?.lng ?? null,
        distance_miles: s.distanceMiles ?? null, within_radius: s.withinRadius ?? null,
        uber_fee_minor: s.trueCostMinor ?? null, currency, eta_minutes: s.etaMinutes ?? null,
        expires_at: s.expiresAtMs ? new Date(s.expiresAtMs).toISOString() : null,
      });
      const { error } = await sb.from('delivery_surcharges').insert({
        location_id: loc, order_ref: orderRef, quote_id: s.quoteId || null,
        customer_fee_minor: s.customerFeeMinor ?? 0, true_cost_minor: s.trueCostMinor ?? 0,
        margin_minor: (s.customerFeeMinor ?? 0) - (s.trueCostMinor ?? 0), policy_applied: s.policyApplied || null, currency,
      });
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    // ── Dispatch a courier (slice 4). Routes by venue dispatch_backend. ───────
    if (action === 'create_delivery') {
      const t = await requireToken(req); if (!t.ok) return t.res;
      const { data: cfg } = await sb.from('venue_uber_config').select('*').eq('location_id', loc).maybeSingle();
      if (!cfg || !cfg.enabled) return json({ ok: false, reason: 'disabled' });
      const orderRef = body?.order_ref || null;
      const manifest = body?.manifest || {};

      // HubRise Bridge backend — push the order INTO HubRise; the Bridge (connected in the
      // HubRise back office) then dispatches it to Uber and syncs status back through the
      // existing hubrise order pipeline. Requires the venue to be HubRise-connected.
      if (cfg.dispatch_backend === 'hubrise_bridge') {
        const { data: conn } = await sb.from('hubrise_connections').select('access_token, hubrise_location_id, status').eq('location_id', loc).maybeSingle();
        if (!conn?.access_token || !conn?.hubrise_location_id) {
          return json({ ok: false, reason: 'hubrise_not_connected', message: 'Connect this venue to HubRise (with the Uber Direct Bridge enabled) to dispatch.' });
        }
        try {
          const hrOrder = body?.hubrise_order || {};
          const created = await createHubriseOrder(conn.access_token, conn.hubrise_location_id, hrOrder);
          const hubriseRef = created?.id || created?.order_id || null;
          const { data: row } = await sb.from('deliveries').insert({
            location_id: loc, order_ref: orderRef, dispatch_backend: 'hubrise_bridge', status: 'pending', hubrise_ref: hubriseRef,
          }).select('id').maybeSingle();
          return json({ ok: true, backend: 'hubrise_bridge', deliveryRowId: row?.id || null, hubriseRef });
        } catch (e) {
          return json({ ok: false, reason: 'hubrise_push_failed', error: String((e as Error)?.message || e) });
        }
      }

      // Fill pickup from server-side config (never trusted from the client).
      manifest.pickup = {
        name: cfg.pickup_contact?.name || 'Restaurant',
        phone: e164(cfg.pickup_contact?.phone || ''),
        address: cfg.pickup_address || null,
        instructions: cfg.pickup_contact?.instructions || '',
      };

      const customerId = cfg.uber_customer_id || ENV_CUSTOMER_ID;
      const env = (cfg.env || ENV_DEFAULT) as 'sandbox' | 'prod';
      if (!ENV_CLIENT_ID || !ENV_CLIENT_SECRET || !customerId) return json({ ok: false, reason: 'not_configured' });

      try {
        const token = await getAccessToken(env, ENV_CLIENT_ID, ENV_CLIENT_SECRET);
        const resp = await createDelivery({ env, token, customerId, manifest });
        const p = parseDeliveryResp(resp);
        const status = mapUberStatus(p.rawStatus);
        const { data: row } = await sb.from('deliveries').insert({
          location_id: loc, order_ref: orderRef, dispatch_backend: 'uber_api',
          uber_delivery_id: p.id, status, tracking_url: p.trackingUrl,
          courier_name: p.courierName, courier_phone: p.courierPhone, last_lat: p.lat, last_lng: p.lng,
        }).select('id').maybeSingle();
        return json({ ok: true, deliveryRowId: row?.id || null, deliveryId: p.id, trackingUrl: p.trackingUrl, status });
      } catch (e) {
        return json({ ok: false, reason: 'dispatch_failed', error: String((e as Error)?.message || e) });
      }
    }

    // ── Poll a delivery's status (staff board fallback to the webhook). ───────
    if (action === 'get_delivery') {
      const t = await requireToken(req); if (!t.ok) return t.res;
      const { data: cfg } = await sb.from('venue_uber_config').select('*').eq('location_id', loc).maybeSingle();
      const customerId = cfg?.uber_customer_id || ENV_CUSTOMER_ID;
      const env = (cfg?.env || ENV_DEFAULT) as 'sandbox' | 'prod';
      const id = body?.uber_delivery_id;
      if (!ENV_CLIENT_ID || !ENV_CLIENT_SECRET || !customerId || !id) return json({ ok: false, reason: 'not_configured' });
      try {
        const token = await getAccessToken(env, ENV_CLIENT_ID, ENV_CLIENT_SECRET);
        const p = parseDeliveryResp(await getDelivery(env, token, customerId, id));
        const status = mapUberStatus(p.rawStatus);
        await sb.from('deliveries').update({ status, tracking_url: p.trackingUrl, courier_name: p.courierName, courier_phone: p.courierPhone, last_lat: p.lat, last_lng: p.lng, updated_at: new Date().toISOString() }).eq('uber_delivery_id', id);
        return json({ ok: true, status, trackingUrl: p.trackingUrl, courierName: p.courierName, lat: p.lat, lng: p.lng });
      } catch (e) {
        return json({ ok: false, reason: 'lookup_failed', error: String((e as Error)?.message || e) });
      }
    }

    // ── Staff delivery board: list recent deliveries for the venue. ──────────
    if (action === 'list_deliveries') {
      const acc = await requireAccess(req, loc); if (!acc.ok) return acc.res;
      const limit = Math.min(200, Number(body?.limit) || 50);
      const { data } = await sb.from('deliveries').select('*').eq('location_id', loc).order('created_at', { ascending: false }).limit(limit);
      return json({ ok: true, deliveries: data || [] });
    }

    // ── Cancel a delivery (routes by backend). Note: a courier-accepted cancel may
    //    incur the merchant's contracted cancellation fee (reconciled separately). ──
    if (action === 'cancel_delivery') {
      const acc = await requireAccess(req, loc); if (!acc.ok) return acc.res;
      const id = body?.delivery_row_id;
      const { data: del } = await sb.from('deliveries').select('*').eq('id', id).eq('location_id', loc).maybeSingle();
      if (!del) return json({ ok: false, reason: 'not_found' });
      const { data: cfg } = await sb.from('venue_uber_config').select('*').eq('location_id', loc).maybeSingle();
      try {
        if (del.dispatch_backend === 'hubrise_bridge') {
          const { data: conn } = await sb.from('hubrise_connections').select('access_token, hubrise_location_id').eq('location_id', loc).maybeSingle();
          if (conn?.access_token && conn?.hubrise_location_id && del.hubrise_ref) {
            await patchHubriseOrder(conn.access_token, conn.hubrise_location_id, del.hubrise_ref, { status: 'cancelled' });
          }
        } else if (del.uber_delivery_id) {
          const customerId = cfg?.uber_customer_id || ENV_CUSTOMER_ID;
          const env = (cfg?.env || ENV_DEFAULT) as 'sandbox' | 'prod';
          if (ENV_CLIENT_ID && ENV_CLIENT_SECRET && customerId) {
            const token = await getAccessToken(env, ENV_CLIENT_ID, ENV_CLIENT_SECRET);
            await cancelDelivery(env, token, customerId, del.uber_delivery_id);
          }
        }
        await sb.from('deliveries').update({ status: 'canceled', updated_at: new Date().toISOString() }).eq('id', id);
        return json({ ok: true });
      } catch (e) {
        return json({ ok: false, reason: 'cancel_failed', error: String((e as Error)?.message || e) });
      }
    }

    // ── Reconciliation: charged-vs-actual delivery margin for the venue. ─────
    if (action === 'delivery_report') {
      const acc = await requireAccess(req, loc); if (!acc.ok) return acc.res;
      const sinceIso = body?.since || new Date(Date.now() - 30 * 86400_000).toISOString();
      const [{ data: sur }, { data: costs }] = await Promise.all([
        sb.from('delivery_surcharges').select('customer_fee_minor, true_cost_minor, margin_minor').eq('location_id', loc).gte('created_at', sinceIso),
        sb.from('delivery_costs_actual').select('total_minor').eq('location_id', loc).gte('recorded_at', sinceIso),
      ]);
      const sum = (rows: any[], k: string) => (rows || []).reduce((s, r) => s + (Number(r[k]) || 0), 0);
      const customerTotalMinor = sum(sur, 'customer_fee_minor');
      const quotedCostMinor = sum(sur, 'true_cost_minor');
      const actualCostMinor = sum(costs, 'total_minor');
      return json({ ok: true, report: {
        since: sinceIso,
        count: (sur || []).length,
        customerTotalMinor,                 // what customers paid for delivery
        quotedCostMinor,                    // Uber cost we quoted at order time
        actualCostMinor,                    // actual Uber cost (from terminal webhooks)
        quotedMarginMinor: customerTotalMinor - quotedCostMinor,
        actualMarginMinor: actualCostMinor ? customerTotalMinor - actualCostMinor : null,
      } });
    }

    return json({ error: `unknown action: ${action}` }, 400);
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
