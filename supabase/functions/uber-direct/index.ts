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
import { cancelDelivery, createOrganization, getOrganization, inviteOrgMember, parseOrgResp, UBER_ORG_SCOPE } from '../_shared/uber.ts';
import { getStuartToken, getStuartPricing, normaliseStuartPricing, cancelStuartJob, classifyStuartError } from '../_shared/stuart.ts';
import { dispatchCourier } from '../_shared/delivery-dispatch.ts';

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
// Platform "root" org id — sub-orgs (one per venue) are created beneath it via the
// Organizations API. This is the ServOS platform account's own customer_id/org id.
const ENV_PARENT_ORG_ID = Deno.env.get('UBER_DIRECT_PARENT_ORG_ID') ?? ENV_CUSTOMER_ID;
const ENV_DEFAULT = (Deno.env.get('UBER_DIRECT_ENV') ?? 'sandbox') as 'sandbox' | 'prod';
// Stuart courier (UK) — self-serve alternative; platform-level creds set by us.
const ENV_STUART_ID = Deno.env.get('STUART_CLIENT_ID') ?? '';
const ENV_STUART_SECRET = Deno.env.get('STUART_CLIENT_SECRET') ?? '';
const ENV_STUART_DEFAULT = (Deno.env.get('STUART_ENV') ?? ENV_DEFAULT) as 'sandbox' | 'prod';
const sb = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { autoRefreshToken: false, persistSession: false } });

const NON_SECRET = [
  'location_id', 'enabled', 'delivery_mode', 'uber_customer_id', 'pickup_address', 'pickup_contact',
  'radius_miles', 'dispatch_backend', 'surcharge_policy', 'flat_fee_minor', 'fallback_fee_minor', 'sms_tracking', 'env',
];
const pickNonSecret = (row: any) => {
  const out: Record<string, unknown> = {};
  if (!row) return out;
  for (const k of NON_SECRET) out[k] = row[k];
  // Per-location Stuart account: expose only whether it's connected, NEVER the creds.
  out.stuart_connected = !!(row.stuart_client_id && row.stuart_client_secret);
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

    // ── Platform onboarding: create an Uber Direct SUB-ORG for this venue (Organizations API).
    //    One platform root account (ENV creds + ENV_PARENT_ORG_ID) → a sub-org per venue. The
    //    returned organization_id IS the venue's customer_id for quotes/deliveries, so the
    //    merchant never touches API keys. Body may override name/email/merchant_type/billing_type.
    //    (Exact enum values for merchant_type / billing_type / contract_type are locked in sandbox.)
    if (action === 'onboard_org') {
      const acc = await requireAccess(req, loc); if (!acc.ok) return acc.res;
      if (!ENV_CLIENT_ID || !ENV_CLIENT_SECRET) return json({ ok: false, reason: 'platform_not_configured', error: 'Uber Direct platform credentials are not set on the server.' });
      if (!ENV_PARENT_ORG_ID) return json({ ok: false, reason: 'no_parent_org', error: 'No platform parent org id (UBER_DIRECT_PARENT_ORG_ID) is set on the server.' });
      const { data: cfg } = await sb.from('venue_uber_config').select('*').eq('location_id', loc).maybeSingle();
      if (cfg?.uber_customer_id) return json({ ok: true, already: true, customer_id: cfg.uber_customer_id });
      const env = (cfg?.env || ENV_DEFAULT) as 'sandbox' | 'prod';
      const pa = cfg?.pickup_address || {};
      const pc = cfg?.pickup_contact || {};
      const poc: Record<string, unknown> = {
        first_name: body?.first_name || (pc.name || '').split(' ')[0] || 'Manager',
        last_name: body?.last_name || (pc.name || '').split(' ').slice(1).join(' ') || 'Manager',
      };
      if (body?.email) poc.email = body.email;
      if (pc.phone) poc.phone_details = { phone_number: e164(pc.phone) };
      const orgBody = {
        info: {
          name: body?.name || pc.name || 'Venue',
          merchant_type: body?.merchant_type || 'MERCHANT_TYPE_RESTAURANT',
          billing_type: body?.billing_type || 'BILLING_TYPE_DECENTRALIZED',
          address: {
            street_address: [pa.line1, pa.line2].filter(Boolean),
            city: pa.city || '',
            state: pa.state || '',
            zip_code: pa.postcode || '',
            country: pa.country || 'GB',
          },
          point_of_contact: poc,
        },
        hierarchy_info: { parent_organization_id: ENV_PARENT_ORG_ID },
      };
      try {
        const token = await getAccessToken(env, ENV_CLIENT_ID, ENV_CLIENT_SECRET, UBER_ORG_SCOPE);
        const resp = await createOrganization(env, token, orgBody);
        const parsed = parseOrgResp(resp);
        if (!parsed.orgId) return json({ ok: false, reason: 'no_org_id', raw: resp });
        // Persist the new customer_id + flip the venue onto the Uber courier (API) backend.
        await sb.from('venue_uber_config').upsert({
          location_id: loc, uber_customer_id: parsed.orgId,
          delivery_mode: 'uber', dispatch_backend: 'uber_api', env,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'location_id' });
        // Best-effort: email the merchant an invite to manage their own org (billing etc.).
        let invited = false;
        if (body?.email) {
          try { await inviteOrgMember(env, token, parsed.orgId, { user_details: { email: body.email }, roles: ['ROLE_ADMIN'] }); invited = true; } catch (_e) { /* non-fatal */ }
        }
        return json({ ok: true, customer_id: parsed.orgId, name: parsed.name, invited });
      } catch (e) {
        return json({ ok: false, reason: 'org_create_failed', error: String((e as Error)?.message || e) });
      }
    }

    // ── BO: live org status (onboarded? billing active?) for a venue. ──────────
    if (action === 'org_status') {
      const acc = await requireAccess(req, loc); if (!acc.ok) return acc.res;
      const { data: cfg } = await sb.from('venue_uber_config').select('*').eq('location_id', loc).maybeSingle();
      if (!cfg?.uber_customer_id) return json({ ok: true, onboarded: false });
      if (!ENV_CLIENT_ID || !ENV_CLIENT_SECRET) return json({ ok: true, onboarded: true, customer_id: cfg.uber_customer_id });
      const env = (cfg?.env || ENV_DEFAULT) as 'sandbox' | 'prod';
      try {
        const token = await getAccessToken(env, ENV_CLIENT_ID, ENV_CLIENT_SECRET, UBER_ORG_SCOPE);
        const parsed = parseOrgResp(await getOrganization(env, token, cfg.uber_customer_id));
        return json({ ok: true, onboarded: true, customer_id: cfg.uber_customer_id, name: parsed.name, billingStatus: parsed.billingStatus });
      } catch (e) {
        return json({ ok: true, onboarded: true, customer_id: cfg.uber_customer_id, error: String((e as Error)?.message || e) });
      }
    }

    // ── BO: (re)send the merchant an invite to manage their org. ───────────────
    if (action === 'invite_org_member') {
      const acc = await requireAccess(req, loc); if (!acc.ok) return acc.res;
      const email = body?.email;
      if (!email) return json({ ok: false, reason: 'email_required' });
      const { data: cfg } = await sb.from('venue_uber_config').select('*').eq('location_id', loc).maybeSingle();
      if (!cfg?.uber_customer_id) return json({ ok: false, reason: 'not_onboarded' });
      const env = (cfg?.env || ENV_DEFAULT) as 'sandbox' | 'prod';
      try {
        const token = await getAccessToken(env, ENV_CLIENT_ID, ENV_CLIENT_SECRET, UBER_ORG_SCOPE);
        await inviteOrgMember(env, token, cfg.uber_customer_id, { user_details: { email }, roles: [body?.role || 'ROLE_ADMIN'] });
        return json({ ok: true });
      } catch (e) {
        return json({ ok: false, reason: 'invite_failed', error: String((e as Error)?.message || e) });
      }
    }

    // ── BO: connect THIS venue's own Stuart account (per-location, not platform-wide).
    //    Each location signs up its own Stuart account and pastes its Client ID + Secret
    //    here. We verify the creds by fetching a token, then store them (service-role only;
    //    never returned to the browser) and flip the venue onto the Stuart courier backend. ─
    if (action === 'set_stuart_creds') {
      const acc = await requireAccess(req, loc); if (!acc.ok) return acc.res;
      const id = String(body?.client_id || '').trim();
      const secret = String(body?.client_secret || '').trim();
      if (!id || !secret) return json({ ok: false, error: 'Enter both the Stuart Client ID and Client Secret.' });
      const senv = (body?.env === 'prod' ? 'prod' : 'sandbox') as 'sandbox' | 'prod';
      // Verify before saving — a bad key is caught here, not at the first delivery.
      try {
        await getStuartToken(senv, id, secret);
      } catch (e) {
        return json({ ok: false, reason: 'auth_failed', error: 'Stuart rejected those credentials — check the Client ID/Secret and the sandbox/production toggle. (' + String((e as Error)?.message || e) + ')' });
      }
      const { error } = await sb.from('venue_uber_config').upsert({
        location_id: loc, stuart_client_id: id, stuart_client_secret: secret,
        stuart_env: senv, env: senv,   // stuart_env is authoritative for Stuart; env kept in sync for the BO display
        dispatch_backend: 'stuart',
        updated_at: new Date().toISOString(), updated_by: acc.userId === 'service' ? null : acc.userId,
      }, { onConflict: 'location_id' });
      if (error) return json({ ok: false, error: error.message }, 500);
      return json({ ok: true, stuart_connected: true, env: senv });
    }

    // ── BO: test the venue's connected Stuart account (re-fetch a token). ──────
    if (action === 'test_stuart') {
      const acc = await requireAccess(req, loc); if (!acc.ok) return acc.res;
      const { data: cfg } = await sb.from('venue_uber_config').select('stuart_client_id, stuart_client_secret, stuart_env, env').eq('location_id', loc).maybeSingle();
      const id = cfg?.stuart_client_id || ENV_STUART_ID;
      const secret = cfg?.stuart_client_secret || ENV_STUART_SECRET;
      if (!id || !secret) return json({ ok: false, reason: 'not_connected', error: 'No Stuart account is connected for this venue.' });
      const senv = (cfg?.stuart_env || cfg?.env || ENV_STUART_DEFAULT) as 'sandbox' | 'prod';
      try {
        await getStuartToken(senv, id, secret);
        return json({ ok: true, env: senv, platform: !cfg?.stuart_client_id });
      } catch (e) {
        return json({ ok: false, reason: 'auth_failed', error: String((e as Error)?.message || e) });
      }
    }

    // ── BO: disconnect this venue's Stuart account (clear its creds). ──────────
    if (action === 'disconnect_stuart') {
      const acc = await requireAccess(req, loc); if (!acc.ok) return acc.res;
      const { error } = await sb.from('venue_uber_config').update({
        stuart_client_id: null, stuart_client_secret: null, updated_at: new Date().toISOString(),
      }).eq('location_id', loc);
      if (error) return json({ ok: false, error: error.message }, 500);
      return json({ ok: true, stuart_connected: false });
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

      // Out-of-radius blocks live/immediate orders (POS/online). Scheduled catering is bespoke +
      // operator-managed, so it isn't radius-blocked — it still gets the configured fee.
      if (withinRadius === false && !body?.scheduled) {
        return json({ ok: true, available: false, reason: 'out_of_radius', distanceMiles, radiusMiles, policy, currency });
      }

      // The venue's own delivery charge (used when there's no live Uber quote): self-delivery
      // and the HubRise-Bridge path. flat_fee_minor is preferred; fallback_fee_minor kept for
      // back-compat; 0 = free.
      const configuredFeeMinor = cfg.flat_fee_minor != null ? cfg.flat_fee_minor : (cfg.fallback_fee_minor != null ? cfg.fallback_fee_minor : 0);

      // SELF-DELIVERY — the venue delivers; the order just fires to the POS/kitchen. Charge the
      // configured flat fee (0 = free). No Uber call, no courier dispatch.
      if (cfg.delivery_mode !== 'uber') {
        return json({ ok: true, available: true, mode: 'self', dispatchable: false, self: true, configured: true, raw: { fee: configuredFeeMinor, currency }, dropoff, distanceMiles, withinRadius: true, policy, currency, radiusMiles });
      }

      // ── mode === 'uber' (courier dispatch) ───────────────────────────────────
      // Scheduled (catering / future event) → no live quote (it'd be stale); charge the
      // configured fee now, dispatch the courier at FIRE time. dispatchable:false = don't
      // dispatch at order time (the catering release path dispatches later).
      if (body?.scheduled) {
        return json({ ok: true, available: true, mode: 'uber', dispatchable: false, scheduled: true, fallback: true, configured: true, raw: { fee: configuredFeeMinor, currency }, dropoff, distanceMiles, withinRadius: true, policy, currency, radiusMiles });
      }

      // HubRise Bridge can't quote live → the customer fee is the configured flat fee.
      if (cfg.dispatch_backend === 'hubrise_bridge') {
        return json({ ok: true, available: true, mode: 'uber', dispatchable: true, fallback: true, configured: true, raw: { fee: configuredFeeMinor, currency }, dropoff, distanceMiles, withinRadius: true, policy, currency, radiusMiles });
      }

      // STUART courier (UK) — LIVE pricing quote. NOT configured → the surcharge markup policy
      // applies to Stuart's real cost (like the Uber API path). Falls back to the configured fee
      // if creds are missing or Stuart is unavailable.
      if (cfg.dispatch_backend === 'stuart') {
        const senv = (cfg.stuart_env || cfg.env || ENV_STUART_DEFAULT) as 'sandbox' | 'prod';
        // Per-location Stuart account (this venue's own creds), falling back to the
        // platform creds in env (used by our test venue until it connects its own).
        const sid = cfg.stuart_client_id || ENV_STUART_ID;
        const ssecret = cfg.stuart_client_secret || ENV_STUART_SECRET;
        if (!sid || !ssecret) {
          if (cfg.flat_fee_minor != null || cfg.fallback_fee_minor != null) {
            return json({ ok: true, available: true, mode: 'uber', dispatchable: true, fallback: true, configured: true, raw: { fee: configuredFeeMinor, currency }, dropoff, distanceMiles, withinRadius: true, policy, currency, radiusMiles });
          }
          return json({ ok: true, available: false, reason: 'not_configured', policy, currency });
        }
        try {
          const stoken = await getStuartToken(senv, sid, ssecret);
          const pricing = await getStuartPricing({ env: senv, token: stoken, pickup, dropoff });
          const raw = normaliseStuartPricing(pricing);
          if (!raw) throw new Error('no_price');
          return json({ ok: true, available: true, mode: 'uber', dispatchable: true, raw, dropoff, distanceMiles, withinRadius: true, policy, currency: raw.currency || currency, radiusMiles });
        } catch (e) {
          const kind = classifyStuartError(e);
          // DETERMINISTIC "Stuart can't deliver to/from this address" → delivery unavailable.
          // Do NOT silently fall back to a flat fee + accept an order no courier will collect.
          if (kind === 'out_of_coverage') {
            return json({ ok: true, available: false, reason: 'out_of_coverage', error: String((e as Error)?.message || e), policy, currency });
          }
          // TRANSIENT (Stuart slow/unreachable) → graceful fallback to the configured fee, flagged.
          if (cfg.flat_fee_minor != null || cfg.fallback_fee_minor != null) {
            return json({ ok: true, available: true, mode: 'uber', dispatchable: true, fallback: true, configured: true, raw: { fee: configuredFeeMinor, currency }, dropoff, distanceMiles, withinRadius: true, policy, currency, radiusMiles, error: String((e as Error)?.message || e) });
          }
          return json({ ok: true, available: false, reason: kind === 'auth' ? 'stuart_auth_failed' : 'quote_failed', error: String((e as Error)?.message || e), policy, currency });
        }
      }

      const clientId = ENV_CLIENT_ID, clientSecret = ENV_CLIENT_SECRET;
      const customerId = cfg.uber_customer_id || ENV_CUSTOMER_ID;
      const env = (cfg.env || ENV_DEFAULT) as 'sandbox' | 'prod';

      // No Uber creds yet (build-now, go-live owner-gated) → use the configured fallback fee if set.
      if (!clientId || !clientSecret || !customerId) {
        if (cfg.flat_fee_minor != null || cfg.fallback_fee_minor != null) {
          return json({ ok: true, available: true, mode: 'uber', dispatchable: true, fallback: true, configured: true, raw: { fee: configuredFeeMinor, currency }, dropoff, distanceMiles, withinRadius: true, policy, currency, radiusMiles });
        }
        return json({ ok: true, available: false, reason: 'not_configured', policy, currency });
      }

      try {
        const token = await getAccessToken(env, clientId, clientSecret);
        const raw = await getQuote({ env, token, customerId, pickup, dropoff });
        return json({ ok: true, available: true, mode: 'uber', dispatchable: true, raw, dropoff, distanceMiles, withinRadius: true, policy, currency, radiusMiles });
      } catch (e) {
        // Uber slow/unavailable → graceful fallback (configurable estimated fee), flagged.
        if (cfg.flat_fee_minor != null || cfg.fallback_fee_minor != null) {
          return json({ ok: true, available: true, mode: 'uber', dispatchable: true, fallback: true, configured: true, raw: { fee: configuredFeeMinor, currency }, dropoff, distanceMiles, withinRadius: true, policy, currency, radiusMiles, error: String((e as Error)?.message || e) });
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
      // Build + dispatch server-side via the single idempotent path (shared with the catering
      // fire-time cron). The client sends the raw order + accepted quote; pickup + bodies are
      // built server-side from config. Idempotent on order_ref → safe to call more than once.
      const order = body?.order || { ref: body?.order_ref || null };
      const quote = body?.quote || {};
      return json(await dispatchCourier(sb, { loc, cfg, order, quote }));
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
        await sb.from('courier_deliveries').update({ status, tracking_url: p.trackingUrl, courier_name: p.courierName, courier_phone: p.courierPhone, last_lat: p.lat, last_lng: p.lng, updated_at: new Date().toISOString() }).eq('uber_delivery_id', id);
        return json({ ok: true, status, trackingUrl: p.trackingUrl, courierName: p.courierName, lat: p.lat, lng: p.lng });
      } catch (e) {
        return json({ ok: false, reason: 'lookup_failed', error: String((e as Error)?.message || e) });
      }
    }

    // ── Staff delivery board: list recent deliveries for the venue. ──────────
    if (action === 'list_deliveries') {
      const acc = await requireAccess(req, loc); if (!acc.ok) return acc.res;
      const limit = Math.min(200, Number(body?.limit) || 50);
      const { data } = await sb.from('courier_deliveries').select('*').eq('location_id', loc).order('created_at', { ascending: false }).limit(limit);
      return json({ ok: true, deliveries: data || [] });
    }

    // ── Staff delivery board: full detail for one delivery (order + quote + surcharge +
    //    status timeline). Joins server-side so the BO makes a single call. ──────────
    if (action === 'get_delivery_detail') {
      const acc = await requireAccess(req, loc); if (!acc.ok) return acc.res;
      const id = body?.id || null;
      const reqRef = body?.order_ref || null;
      let del = null;
      if (id) { const { data } = await sb.from('courier_deliveries').select('*').eq('location_id', loc).eq('id', id).maybeSingle(); del = data; }
      else if (reqRef) { const { data } = await sb.from('courier_deliveries').select('*').eq('location_id', loc).eq('order_ref', reqRef).order('created_at', { ascending: false }).limit(1).maybeSingle(); del = data; }
      const ref = reqRef || del?.order_ref || null;
      const [orderRes, quoteRes, surchargeRes, eventsRes] = await Promise.all([
        ref ? sb.from('order_queue').select('ref, type, status, total, customer, items, created_at').eq('location_id', loc).eq('ref', ref).maybeSingle() : Promise.resolve({ data: null }),
        ref ? sb.from('delivery_quotes').select('*').eq('location_id', loc).eq('order_ref', ref).order('created_at', { ascending: false }).limit(1).maybeSingle() : Promise.resolve({ data: null }),
        ref ? sb.from('delivery_surcharges').select('*').eq('location_id', loc).eq('order_ref', ref).order('created_at', { ascending: false }).limit(1).maybeSingle() : Promise.resolve({ data: null }),
        ref ? sb.from('delivery_status_events').select('*').eq('location_id', loc).eq('order_ref', ref).order('created_at', { ascending: true }) : Promise.resolve({ data: [] }),
      ]);
      return json({ ok: true, delivery: del, order: orderRes.data || null, quote: quoteRes.data || null, surcharge: surchargeRes.data || null, events: eventsRes.data || [] });
    }

    // ── Cancel a delivery (routes by backend). Note: a courier-accepted cancel may
    //    incur the merchant's contracted cancellation fee (reconciled separately). ──
    if (action === 'cancel_delivery') {
      const acc = await requireAccess(req, loc); if (!acc.ok) return acc.res;
      const id = body?.delivery_row_id;
      const { data: del } = await sb.from('courier_deliveries').select('*').eq('id', id).eq('location_id', loc).maybeSingle();
      if (!del) return json({ ok: false, reason: 'not_found' });
      const { data: cfg } = await sb.from('venue_uber_config').select('*').eq('location_id', loc).maybeSingle();
      try {
        if (del.dispatch_backend === 'hubrise_bridge') {
          const { data: conn } = await sb.from('hubrise_connections').select('access_token, hubrise_location_id').eq('location_id', loc).maybeSingle();
          if (conn?.access_token && conn?.hubrise_location_id && del.hubrise_ref) {
            await patchHubriseOrder(conn.access_token, conn.hubrise_location_id, del.hubrise_ref, { status: 'cancelled' });
          }
        } else if (del.dispatch_backend === 'stuart') {
          const senv = (cfg?.stuart_env || cfg?.env || ENV_STUART_DEFAULT) as 'sandbox' | 'prod';
          const sid = cfg?.stuart_client_id || ENV_STUART_ID;
          const ssecret = cfg?.stuart_client_secret || ENV_STUART_SECRET;
          if (sid && ssecret && del.uber_delivery_id) {
            const stoken = await getStuartToken(senv, sid, ssecret);
            await cancelStuartJob(senv, stoken, del.uber_delivery_id);
          }
        } else if (del.uber_delivery_id) {
          const customerId = cfg?.uber_customer_id || ENV_CUSTOMER_ID;
          const env = (cfg?.env || ENV_DEFAULT) as 'sandbox' | 'prod';
          if (ENV_CLIENT_ID && ENV_CLIENT_SECRET && customerId) {
            const token = await getAccessToken(env, ENV_CLIENT_ID, ENV_CLIENT_SECRET);
            await cancelDelivery(env, token, customerId, del.uber_delivery_id);
          }
        }
        await sb.from('courier_deliveries').update({ status: 'canceled', updated_at: new Date().toISOString() }).eq('id', id);
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
