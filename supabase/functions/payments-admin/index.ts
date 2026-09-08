// supabase/functions/payments-admin/index.ts
//
// Admin-portal payments mutations (super_admin only). One function, several
// actions, all writing the Platform DB with the service role so the merchant
// account tables (merchant_ryft_* AND merchant_stripe_accounts) stay
// service-role-write. The admin app's platform client is anonymous, and these
// tables are RLS select-only for authenticated — so a client-side .update() /
// .delete() is silently dropped (0 rows, no error). Route those writes here.
//
//   set_processor        { location_id, processor }                 → locations.payment_processor
//   stripe_pricing       { location_id, cardpresent, online, notes } → merchant_stripe_accounts markup
//   stripe_unlink        { location_id }                            → detach merchant_stripe_accounts row
//   ryft_create          { location_id, entity_type?, email?, business?, individual?, redirect_url? }
//   ryft_link            { location_id, ryft_account_id, redirect_url? }
//   ryft_sync            { location_id }
//   ryft_onboarding_link { location_id, redirect_url, email? }
//   ryft_pricing         { location_id, markup_percent, markup_fixed_pence, pricing_notes }
//   ryft_fees            { location_id }  → actual GMV / Ryft fees paid / markup collected
//   adyen_pricing        get/set the per-venue TIERED RATE CARD (v5.7.3) on
//                        merchant_adyen_accounts.rate_card + the platform default
//                        card on platform_settings.default_adyen_rate_card, with
//                        the v5.7.0 flat markup fields kept as the legacy
//                        card_present fallback (see handler comment)
//   saas_pricing         get/set each venue's SaaS plan (v5.7.4): plan +
//                        extra devices + HubRise add-on on OPS subscriptions,
//                        priced from the SAAS_CATALOG const below (the single
//                        source of truth), with paired-device counts, month
//                        card volume and advisory plan recommendations
//   revenue              { month } → per-location platform revenue for the admin
//                        Revenue section: processed volume + count by pricing
//                        tier, commission earned, itemized SaaS fees from ops
//                        subscriptions (plan + devices + HubRise, with advisory
//                        flags), Adyen fees where settlement reports have
//                        landed them
//
// Auth: Ops DB user_profiles.role = 'super_admin' (matches stripe-link-merchant).
// Ryft account API is the marketplace platform model — create a Sub-Account with
// the platform secret key, then mint a Hosted onboarding link. Verified against
// the Ryft OpenAPI spec.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { createSubAccount, getAccount, createAccountLink, authorizeAccount, listBalanceTransactions, listPlatformFees, ryftConfigured } from '../_shared/ryft.ts';
import { RATE_TIERS, resolveAdyenRateCard, sanitizeRateCard } from '../_shared/adyen.ts';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const opsAdmin = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  { auth: { autoRefreshToken: false, persistSession: false } },
);
const platformAdmin = createClient(
  Deno.env.get('PLATFORM_SUPABASE_URL') ?? '',
  Deno.env.get('PLATFORM_SUPABASE_SERVICE_ROLE_KEY') ?? '',
  { auth: { autoRefreshToken: false, persistSession: false } },
);

// ── SaaS plan catalog (v5.7.4) — the single source of truth for plan pricing.
//    UNITS, kept deliberately explicit because they differ:
//      · monthly / extra_device_monthly / hubrise_monthly are POUNDS
//        (ops subscriptions.monthly_fee is numeric pounds, e.g. '149.00')
//      · volume_min / volume_max are MINOR UNITS (pence), because card volume
//        is summed from platform adyen_payments.amount_minor
//    Bands: Free covers up to £8,000 monthly card volume, Growth £8,000.01 to
//    £15,000, Scale above £15,000. The bands are ADVISORY — the operator picks
//    the plan manually and the system only recommends when they disagree.
const SAAS_CATALOG = {
  plans: {
    free:   { label: 'Free',   monthly: 0,   devices: 2,  volume_min: 0,       volume_max: 800000 },
    growth: { label: 'Growth', monthly: 149, devices: 5,  volume_min: 800001,  volume_max: 1500000 },
    scale:  { label: 'Scale',  monthly: 299, devices: 10, volume_min: 1500001, volume_max: null },
  } as Record<string, { label: string; monthly: number; devices: number; volume_min: number; volume_max: number | null }>,
  extra_device_monthly: 39, // pounds per month, per device beyond the plan allowance
  hubrise_monthly: 45,      // pounds per month, per-venue add-on flag
};

// Which plan the volume band says a venue SHOULD be on. volumeMinor is PENCE.
function saasPlanForVolume(volumeMinor: number): string {
  for (const [key, p] of Object.entries(SAAS_CATALOG.plans)) {
    if (volumeMinor >= p.volume_min && (p.volume_max === null || volumeMinor <= p.volume_max)) return key;
  }
  return 'scale';
}

// Monthly fee in POUNDS for plan + extras — the number written to
// subscriptions.monthly_fee (2dp).
function saasMonthlyFee(plan: string, extraDevices: number, hubrise: boolean): number {
  const base = SAAS_CATALOG.plans[plan]?.monthly ?? 0;
  return Math.round((base + extraDevices * SAAS_CATALOG.extra_device_monthly + (hubrise ? SAAS_CATALOG.hubrise_monthly : 0)) * 100) / 100;
}

const SAAS_MIGRATION_NOTE = 'The extra devices and HubRise columns are not on the subscriptions table yet. Apply supabase/migrations/20260822_saas_plans.sql on the Ops database, then save again.';

// What the device count actually is — shown to the operator, so say it plainly.
const DEVICE_COUNT_NOTE = 'Paired devices on record for the venue in the devices registry (POS, kiosk, KDS and handheld rows not marked unpaired), whether or not currently online.';

// Ryft doesn't expose a single charges_enabled flag like Stripe — derive a
// usable status from the verification block + card capabilities, and keep the
// raw verification object for the UI to show what's still outstanding.
// Ryft surfaces field errors in errors[]; pull the first useful message.
function ryftErr(d: any): string | null {
  return d?.errors?.[0]?.message || d?.message || null;
}
// Ryft metadata values must be NON-EMPTY and contain NO WHITESPACE. Collapse
// whitespace to underscores and drop empties.
function cleanMeta(obj: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v == null) continue;
    const cleaned = String(v).trim().replace(/\s+/g, '_').slice(0, 60);
    if (cleaned) out[k] = cleaned;
  }
  return out;
}

function deriveStatus(account: any) {
  const v = account?.verification ?? {};
  const caps = account?.capabilities ?? {};
  const cardKeys = ['visaPayments', 'mastercardPayments', 'amexPayments', 'inPersonPayments'];
  const anyEnabled = cardKeys.some((k) => caps?.[k]?.status === 'Enabled');
  const charges_enabled = anyEnabled || v?.status === 'Verified';
  const details_submitted = !!v?.status && v.status !== 'Required';
  const country = account?.business?.registeredAddress?.country ?? account?.individual?.address?.country ?? null;
  return { charges_enabled, details_submitted, verification_status: v?.status ?? null, country, verification: v };
}

async function resolveLocation(location_id: string) {
  const { data, error } = await platformAdmin.from('locations')
    .select('id, company_id, name').eq('id', location_id).single();
  if (error || !data) return null;
  return data;
}

async function upsertRyftAccount(loc: any, accountId: string, account: any, userId: string | null) {
  const d = deriveStatus(account);
  const { error } = await platformAdmin.from('merchant_ryft_accounts').upsert({
    location_id: loc.id,
    company_id: loc.company_id,
    ryft_account_id: accountId,
    link_method: 'hosted',
    charges_enabled: d.charges_enabled,
    details_submitted: d.details_submitted,
    country: d.country,
    requirements: d.verification ?? null,
    linked_by_user_id: userId,
    last_webhook_at: null,
  }, { onConflict: 'location_id' });
  return { error, derived: d };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  // ── Auth: super_admin (Ops DB) ──────────────────────────────────────────
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return json({ error: 'Unauthorized' }, 401);
  const { data: { user: caller } } = await opsAdmin.auth.getUser(authHeader.replace('Bearer ', ''));
  if (!caller) return json({ error: 'Invalid token' }, 401);
  const { data: profile } = await opsAdmin.from('user_profiles').select('role').eq('id', caller.id).single();
  if (profile?.role !== 'super_admin') return json({ error: 'Requires super_admin' }, 403);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }
  const action = body?.action as string;
  const location_id = body?.location_id as string;
  if (!action) return json({ error: 'action required' }, 400);

  // ── ryft_status: read merchant_ryft_accounts for many locations. The table
  //    is RLS service-role-read, so the admin client (anonymous on the platform
  //    project) gets nothing — which made linked, live accounts show as "Not
  //    connected". Read it here with the service role instead. Multi-location,
  //    so handle BEFORE the single-location_id requirement below.
  if (action === 'ryft_status') {
    const ids = Array.isArray(body?.location_ids) ? body.location_ids.filter(Boolean) : [];
    if (!ids.length) return json({ accounts: [] });
    const { data, error } = await platformAdmin.from('merchant_ryft_accounts').select('*').in('location_id', ids);
    if (error) return json({ error: error.message }, 500);
    return json({ accounts: data ?? [] });
  }

  // ── adyen_pricing v2: get/set the ServOS Payments TIERED RATE CARD ──────
  //    Four tiers (v5.7.3, the model every competitor uses):
  //      card_present      in-person credit AND debit — one fee
  //      card_not_present  online orders
  //      amex              American Express + business/commercial cards
  //      keyed             manually keyed in (MOTO)
  //    Scopes (all back-compatible with the v5.7.0 flat client):
  //      { }                                → defaults (flat + rate card)
  //      { location_id }                    → venue row + defaults + resolved card
  //      { set:true, rate_card }            → set the platform default card
  //      { set:true, default_markup_percent, default_markup_fixed_pence }
  //                                         → set the legacy flat defaults
  //      { set:true, location_id, rate_card }               → set the venue card
  //      { set:true, location_id, markup_percent, markup_fixed_pence }
  //                                         → set the venue legacy flat override
  //    Only fields PRESENT in the body are written, so the old flat client and
  //    the new tiered editor never clobber each other's values.
  //    Resolution (resolveAdyenRateCard, shared with adyen-financial /
  //    adyen-webhook / adyen-onboard): per tier, venue card → default card →
  //    the legacy flat markup as the card_present tier only → null.
  //    merchant_adyen_accounts is RLS service-role-only, so both reads and
  //    writes MUST go through here. Handled BEFORE the location_id guard
  //    because the defaults scope has none. The rate_card columns land with
  //    hand-applied migration 20260821b — reads retry without them, writes
  //    that need them say so plainly.
  if (action === 'adyen_pricing') {
    const numOrNull = (v: unknown) => (v === '' || v === null || v === undefined ? null : Number(v));
    const intOrNull = (v: unknown) => (v === '' || v === null || v === undefined ? null : Math.round(Number(v)));
    const isMissingColumn = (msg: unknown) => /does not exist|42703|PGRST204|Could not find the/i.test(String(msg ?? ''));
    const migrationHint = 'rate-card columns missing — hand-apply migration 20260821b_adyen_rate_card.sql first';

    if (body.set === true && !location_id) {
      const patch: Record<string, unknown> = {
        updated_at: new Date().toISOString(),
        updated_by_user_id: caller.id,
      };
      if ('default_markup_percent' in body) patch.default_adyen_markup_percent = numOrNull(body.default_markup_percent);
      if ('default_markup_fixed_pence' in body) patch.default_adyen_markup_fixed_pence = intOrNull(body.default_markup_fixed_pence);
      if ('rate_card' in body) patch.default_adyen_rate_card = sanitizeRateCard(body.rate_card);
      const { error } = await platformAdmin.from('platform_settings').update(patch).eq('id', true);
      if (error) {
        if ('rate_card' in body && isMissingColumn(error.message)) return json({ error: migrationHint }, 500);
        return json({ error: `defaults update failed: ${error.message}` }, 500);
      }
      return json({ success: true });
    }

    if (body.set === true) {
      const aLoc = await resolveLocation(location_id);
      if (!aLoc) return json({ error: 'location not found in platform DB' }, 404);
      const patch: Record<string, unknown> = {
        location_id: aLoc.id,
        updated_at: new Date().toISOString(),
      };
      if ('markup_percent' in body) patch.markup_percent = numOrNull(body.markup_percent);
      if ('markup_fixed_pence' in body) patch.markup_fixed_pence = intOrNull(body.markup_fixed_pence);
      if ('rate_card' in body) patch.rate_card = sanitizeRateCard(body.rate_card);
      const { error } = await platformAdmin.from('merchant_adyen_accounts')
        .upsert(patch, { onConflict: 'location_id' });
      if (error) {
        if ('rate_card' in body && isMissingColumn(error.message)) return json({ error: migrationHint }, 500);
        return json({ error: `pricing update failed: ${error.message}` }, 500);
      }
      return json({ success: true });
    }

    // get — defaults first (flat + card), retrying without the card column
    // until migration 20260821b is applied.
    let rateCardLive = true;
    let { data: ps, error: psErr } = await platformAdmin.from('platform_settings')
      .select('default_adyen_markup_percent, default_adyen_markup_fixed_pence, default_adyen_rate_card')
      .eq('id', true).maybeSingle();
    if (psErr && isMissingColumn(psErr.message)) {
      rateCardLive = false;
      ({ data: ps, error: psErr } = await platformAdmin.from('platform_settings')
        .select('default_adyen_markup_percent, default_adyen_markup_fixed_pence').eq('id', true).maybeSingle());
    }
    if (psErr) return json({ error: `defaults read failed: ${psErr.message}` }, 500);
    const defaults = {
      default_markup_percent: ps?.default_adyen_markup_percent ?? null,
      default_markup_fixed_pence: ps?.default_adyen_markup_fixed_pence ?? null,
      rate_card: (ps as Record<string, unknown> | null)?.default_adyen_rate_card ?? null,
    };
    if (!location_id) return json({ ok: true, defaults, rate_card_ready: rateCardLive });

    const aLoc = await resolveLocation(location_id);
    if (!aLoc) return json({ error: 'location not found in platform DB' }, 404);
    const ACCT_COLS = 'markup_percent, markup_fixed_pence, receive_payments_ok, payouts_ok, balance_account_id, store_id';
    let { data: acct, error: aErr } = await platformAdmin.from('merchant_adyen_accounts')
      .select(`${ACCT_COLS}, rate_card`).eq('location_id', aLoc.id).maybeSingle();
    if (aErr && isMissingColumn(aErr.message)) {
      rateCardLive = false;
      ({ data: acct, error: aErr } = await platformAdmin.from('merchant_adyen_accounts')
        .select(ACCT_COLS).eq('location_id', aLoc.id).maybeSingle());
    }
    if (aErr) return json({ error: `account read failed: ${aErr.message}` }, 500);
    const resolved = resolveAdyenRateCard(
      { rate_card: (acct as Record<string, unknown> | null)?.rate_card ?? null, markup_percent: acct?.markup_percent, markup_fixed_pence: acct?.markup_fixed_pence },
      { default_adyen_rate_card: defaults.rate_card, default_adyen_markup_percent: defaults.default_markup_percent, default_adyen_markup_fixed_pence: defaults.default_markup_fixed_pence },
    );
    return json({
      ok: true,
      defaults,
      rate_card_ready: rateCardLive,
      account: {
        exists: !!acct,
        markup_percent: acct?.markup_percent ?? null,
        markup_fixed_pence: acct?.markup_fixed_pence ?? null,
        rate_card: (acct as Record<string, unknown> | null)?.rate_card ?? null,
        receive_payments_ok: !!acct?.receive_payments_ok,
        payouts_ok: !!acct?.payouts_ok,
        has_balance_account: !!acct?.balance_account_id,
      },
      // The full resolved card, per tier: { percent, fixed_pence, source }.
      resolved,
      // Legacy flat shape the v5.7.0 client reads — now the resolved
      // card_present tier, so the old UI keeps showing a true number.
      effective: {
        percent: resolved.card_present.percent,
        fixed_pence: resolved.card_present.fixed_pence,
      },
    });
  }

  // ── saas_pricing: get/set each venue's SaaS plan (v5.7.4) ────────────────
  //    Peter invoices SaaS manually through the CRM — the platform only STORES
  //    the plan per venue and REPORTS the money. Pricing comes from
  //    SAAS_CATALOG above (single source of truth); the computed monthly fee is
  //    written to ops subscriptions.monthly_fee in POUNDS.
  //      { }                                      → { catalog, venues, typed }
  //      { set:true, location_id, plan, extra_devices, hubrise } → update/insert
  //    subscriptions is an OPS DB table — every read and write here uses
  //    opsAdmin, never platformAdmin. Never touches stripe_* or gmv_* columns.
  //    Tolerates migration 20260822 not being applied yet: reads retry without
  //    the two new columns and return typed:false; writes that need them return
  //    a plain-English pointer to the migration.
  //    Handled BEFORE the location_id guard because the get scope has none.
  if (action === 'saas_pricing') {
    const isMissingColumn = (msg: unknown) => /does not exist|42703|PGRST204|Could not find the/i.test(String(msg ?? ''));

    if (body.set === true) {
      if (!location_id) return json({ error: 'location_id required' }, 400);
      const plan = String(body.plan ?? '');
      if (!SAAS_CATALOG.plans[plan]) return json({ error: `plan must be one of: ${Object.keys(SAAS_CATALOG.plans).join(', ')}` }, 400);
      const extra = Number(body.extra_devices);
      if (!Number.isInteger(extra) || extra < 0) return json({ error: 'extra_devices must be a whole number, zero or more' }, 400);
      if (typeof body.hubrise !== 'boolean') return json({ error: 'hubrise must be true or false' }, 400);
      const hubrise = body.hubrise as boolean;
      const monthly_fee = saasMonthlyFee(plan, extra, hubrise).toFixed(2); // POUNDS, 2dp
      const patch = { plan, extra_devices: extra, hubrise, monthly_fee, updated_at: new Date().toISOString() };

      const { data: updated, error: upErr } = await opsAdmin.from('subscriptions')
        .update(patch).eq('location_id', location_id).select('id');
      if (upErr) {
        if (isMissingColumn(upErr.message)) return json({ error: SAAS_MIGRATION_NOTE }, 500);
        return json({ error: `subscription update failed: ${upErr.message}` }, 500);
      }
      if (!updated || updated.length === 0) {
        // No subscription row for this venue yet — insert one, resolving
        // org_id the way the existing rows carry it: the ops locations.org_id
        // for the venue (verified identical on all six live rows).
        const { data: opsLoc, error: locErr } = await opsAdmin.from('locations')
          .select('id, org_id').eq('id', location_id).maybeSingle();
        if (locErr || !opsLoc) return json({ error: 'location not found in the ops database' }, 404);
        const { error: insErr } = await opsAdmin.from('subscriptions').insert({
          org_id: opsLoc.org_id,
          location_id,
          billing_period_start: new Date().toISOString().slice(0, 10),
          ...patch,
        });
        if (insErr) {
          if (isMissingColumn(insErr.message)) return json({ error: SAAS_MIGRATION_NOTE }, 500);
          // Two concurrent first-saves race the read-then-insert; the unique
          // index on location_id (20260822) turns the loser into 23505 —
          // finish it as the update it should have been.
          if (String((insErr as any).code ?? '') === '23505' || /duplicate key/i.test(insErr.message)) {
            const { error: reErr } = await opsAdmin.from('subscriptions')
              .update(patch).eq('location_id', location_id);
            if (reErr) return json({ error: `subscription update failed: ${reErr.message}` }, 500);
          } else {
            return json({ error: `subscription insert failed: ${insErr.message}` }, 500);
          }
        }
      }
      return json({ ok: true, success: true, plan, extra_devices: extra, hubrise, monthly_fee: Number(monthly_fee) });
    }

    // get — the catalog plus one entry per ops venue.
    let typed = true;
    let { data: subs, error: subErr } = await opsAdmin.from('subscriptions')
      .select('location_id, org_id, plan, monthly_fee, extra_devices, hubrise');
    if (subErr && isMissingColumn(subErr.message)) {
      typed = false;
      ({ data: subs, error: subErr } = await opsAdmin.from('subscriptions')
        .select('location_id, org_id, plan, monthly_fee'));
    }
    if (subErr) return json({ error: `subscriptions read failed: ${subErr.message}` }, 500);
    const subByLoc = new Map<string, any>();
    for (const s of subs ?? []) if (s.location_id) subByLoc.set(s.location_id, s);

    const { data: opsLocs, error: olErr } = await opsAdmin.from('locations').select('id, name, org_id');
    if (olErr) return json({ error: `locations read failed: ${olErr.message}` }, 500);

    // Paired device count per venue from the ops devices registry — a device
    // is POS, kiosk, KDS or handheld MPOS; "paired" = any row for the location
    // whose status is not 'unpaired' (live statuses today: active, online).
    // Counted as rows on record, NOT as currently-online. Breakdown by type.
    const { data: devs, error: devErr } = await opsAdmin.from('devices').select('location_id, type, status');
    if (devErr) return json({ error: `devices read failed: ${devErr.message}` }, 500);
    const devByLoc = new Map<string, { count: number; by_type: Record<string, number> }>();
    for (const d of devs ?? []) {
      if (!d.location_id || d.status === 'unpaired') continue;
      if (!devByLoc.has(d.location_id)) devByLoc.set(d.location_id, { count: 0, by_type: {} });
      const agg = devByLoc.get(d.location_id)!;
      agg.count++;
      const t = String(d.type ?? 'unknown');
      agg.by_type[t] = (agg.by_type[t] ?? 0) + 1;
    }

    // HubRise: a hubrise_connections row with status 'connected' is a live
    // connection (hubrise-connect writes status:'connected' on OAuth success
    // and the Back Office reads connected as exactly that check), so this is a
    // reliable signal. location_id there is the ops location id as text.
    const { data: hub, error: hubErr } = await opsAdmin.from('hubrise_connections').select('location_id, status');
    if (hubErr) return json({ error: `hubrise read failed: ${hubErr.message}` }, 500);
    const hubConnected = new Set((hub ?? []).filter((h: any) => h.status === 'connected').map((h: any) => String(h.location_id)));

    // Current-calendar-month card volume in MINOR UNITS per venue, from
    // platform adyen_payments — same success filter and same
    // locations.ops_location_id mapping as the revenue action.
    // The scan covers the PREVIOUS complete month plus the current month to
    // date. The plan recommendation is judged on whichever is higher: judging
    // on month-to-date alone would tell every paid venue "suggests Free" for
    // the first days of each month, while a genuine upgrade (MTD already past
    // the band) should nudge immediately.
    const now = new Date();
    const mFrom = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    const curStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
    const mTo = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    const { data: pLocs, error: plErr } = await platformAdmin.from('locations').select('id, ops_location_id');
    if (plErr) return json({ error: `platform locations read failed: ${plErr.message}` }, 500);
    const opsIdByPlatform = new Map<string, string>();
    for (const l of pLocs ?? []) if (l.ops_location_id) opsIdByPlatform.set(l.id, l.ops_location_id);
    const volByOps = new Map<string, number>();       // current month to date
    const prevVolByOps = new Map<string, number>();   // previous complete month
    let volumeCapped = true; // stays true only if the loop never sees a short page
    const VCAP = 20000, VPAGE = 1000;
    for (let idx = 0; idx < VCAP; idx += VPAGE) {
      const res = await platformAdmin.from('adyen_payments')
        .select('location_id, amount_minor, success, last_event_code, created_at')
        .gte('created_at', mFrom.toISOString()).lt('created_at', mTo.toISOString())
        .order('created_at', { ascending: true }).range(idx, idx + VPAGE - 1);
      if (res.error) return json({ error: `payments read failed: ${res.error.message}` }, 500);
      for (const r of (res.data ?? []) as any[]) {
        if (r.success !== true || r.last_event_code === 'CANCELLATION') continue;
        const opsId = r.location_id ? opsIdByPlatform.get(r.location_id) : null;
        if (!opsId) continue;
        const bucket = String(r.created_at) < curStart ? prevVolByOps : volByOps;
        bucket.set(opsId, (bucket.get(opsId) ?? 0) + (Number(r.amount_minor) || 0));
      }
      if ((res.data ?? []).length < VPAGE) { volumeCapped = false; break; }
    }

    const venues = (opsLocs ?? []).map((l: any) => {
      const sub = subByLoc.get(l.id) ?? null;
      const plan = String(sub?.plan ?? 'free');
      const planDef = SAAS_CATALOG.plans[plan] ?? null;
      const extra = typed ? Number(sub?.extra_devices) || 0 : 0;
      const hubOn = typed ? !!sub?.hubrise : false;
      const devices = devByLoc.get(l.id) ?? { count: 0, by_type: {} };
      const volume_minor = volByOps.get(l.id) ?? 0;
      const prev_volume_minor = prevVolByOps.get(l.id) ?? 0;
      const recommended = saasPlanForVolume(Math.max(volume_minor, prev_volume_minor));
      const allowance = planDef ? planDef.devices + extra : null;
      return {
        location_id: l.id,
        org_id: l.org_id,
        name: l.name ?? '(unnamed venue)',
        has_subscription: !!sub,
        plan,
        monthly_fee: Number(sub?.monthly_fee) || 0, // POUNDS as stored
        extra_devices: extra,
        hubrise: hubOn,
        devices,
        plan_device_allowance: planDef?.devices ?? null,
        volume_minor, // PENCE, current calendar month to date
        prev_volume_minor, // PENCE, previous complete month
        hubrise_detected: hubConnected.has(String(l.id)),
        // Advisory only. Free at low volume is a correct, configured state.
        recommended_plan: recommended !== plan ? recommended : null,
        devices_over: allowance != null && devices.count > allowance ? { count: devices.count, allowance } : null,
      };
    });
    venues.sort((a, b) => String(a.name).localeCompare(String(b.name)));

    return json({ ok: true, typed, catalog: SAAS_CATALOG, device_count_note: DEVICE_COUNT_NOTE, migration_note: typed ? null : SAAS_MIGRATION_NOTE, volume_capped: volumeCapped, venues });
  }

  // ── revenue: the internal platform-revenue report (admin Revenue section) ──
  //    { month: 'YYYY-MM' } → per location: processed volume + count by pricing
  //    tier (adyen_payments.rate_category), commission earned
  //    (sum commission_minor), Adyen fees where settlement reports have filled
  //    fee_minor, and the SaaS fee from the ops subscriptions table, itemized
  //    per venue (plan fee + extra devices + HubRise from SAAS_CATALOG) with
  //    advisory flags where volume or device count disagrees with the chosen
  //    plan. A venue on Free at £0 is a legitimately configured state.
  //    Honest about costs: what Adyen charges US arrives
  //    per payment only via settlement-report ingestion (fee_minor), so margin
  //    is computed only where fee data exists.
  if (action === 'revenue') {
    const month = String(body.month ?? '');
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return json({ error: 'month must be YYYY-MM' }, 400);
    const isMissingColumn = (msg: unknown) => /does not exist|42703|PGRST204|Could not find the/i.test(String(msg ?? ''));
    const from = new Date(`${month}-01T00:00:00Z`);
    const to = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1));

    // Payments for the month, paged. Retry ladder drops the columns whose
    // migrations have not been hand-applied yet (20260821b, then 20260820).
    const BASE_COLS = 'location_id, amount_minor, amount_refunded_minor, success, last_event_code, currency, applied_mods:raw->applied_modifications';
    const LADDER = [
      `${BASE_COLS}, rate_category, commission_minor, fee_minor`,
      `${BASE_COLS}, fee_minor`,
      BASE_COLS,
    ];
    let ladderIdx = 0;
    const rows: any[] = [];
    const CAP = 20000;
    const PAGE = 1000;
    for (let fromIdx = 0; fromIdx < CAP; fromIdx += PAGE) {
      let res = await platformAdmin.from('adyen_payments').select(LADDER[ladderIdx])
        .gte('created_at', from.toISOString()).lt('created_at', to.toISOString())
        .order('created_at', { ascending: true }).range(fromIdx, fromIdx + PAGE - 1);
      while (res.error && isMissingColumn(res.error.message) && ladderIdx < LADDER.length - 1) {
        ladderIdx++;
        res = await platformAdmin.from('adyen_payments').select(LADDER[ladderIdx])
          .gte('created_at', from.toISOString()).lt('created_at', to.toISOString())
          .order('created_at', { ascending: true }).range(fromIdx, fromIdx + PAGE - 1);
      }
      if (res.error) return json({ error: `payments read failed: ${res.error.message}` }, 500);
      const batch = (res.data ?? []) as any[];
      rows.push(...batch);
      if (batch.length < PAGE) break;
    }
    const classified = ladderIdx === 0;
    const feesLive = ladderIdx <= 1;

    // Location names (platform) + the ops mapping for the SaaS join.
    const { data: locs, error: locErr } = await platformAdmin.from('locations')
      .select('id, name, company_id, ops_location_id');
    if (locErr) return json({ error: `locations read failed: ${locErr.message}` }, 500);
    const locById = new Map<string, any>();
    const locByOps = new Map<string, any>();
    for (const l of locs ?? []) { locById.set(l.id, l); if (l.ops_location_id) locByOps.set(l.ops_location_id, l); }

    // SaaS (v5.7.4): ops subscriptions stores plan + extra_devices + hubrise +
    // the computed monthly_fee (POUNDS). Itemized per venue below from
    // SAAS_CATALOG. Reads retry without the two 20260822 columns and report
    // saas_typed:false until the migration is applied.
    let saasTyped = true;
    let { data: subs, error: subErr } = await opsAdmin.from('subscriptions')
      .select('location_id, org_id, plan, monthly_fee, extra_devices, hubrise');
    if (subErr && isMissingColumn(subErr.message)) {
      saasTyped = false;
      ({ data: subs, error: subErr } = await opsAdmin.from('subscriptions')
        .select('location_id, org_id, plan, monthly_fee'));
    }
    if (subErr) return json({ error: `subscriptions read failed: ${subErr.message}` }, 500);
    const { data: opsLocs } = await opsAdmin.from('locations').select('id, name');
    const opsNameById = new Map<string, string>();
    for (const l of opsLocs ?? []) opsNameById.set(l.id, l.name);

    // Paired device count per ops venue (devices registry rows not marked
    // unpaired — POS, kiosk, KDS, handheld) for the devices-over advisory.
    const { data: devRows } = await opsAdmin.from('devices').select('location_id, status');
    const devCountByOps = new Map<string, number>();
    for (const d of devRows ?? []) {
      if (!d.location_id || d.status === 'unpaired') continue;
      devCountByOps.set(d.location_id, (devCountByOps.get(d.location_id) ?? 0) + 1);
    }

    // Aggregate payments per platform location × tier.
    // Twin of the reseller statement's inclusion rule so the Revenue screen and
    // the FranPOS invoice never disagree: a CAPTURE_FAILED with no successful
    // capture anywhere never settled, so it is not revenue.
    const revHasCapture = (r: any) => Array.isArray(r?.applied_mods)
      && r.applied_mods.some((m: any) => String(m).startsWith('CAPTURE:') && String(m).endsWith(':true'));
    const isPayment = (r: any) => r.success === true
      && r.last_event_code !== 'CANCELLATION'
      && !(r.last_event_code === 'CAPTURE_FAILED' && !revHasCapture(r));
    type TierAgg = { count: number; volume_minor: number; commission_minor: number; commission_known: number };
    const blankTiers = () => {
      const t: Record<string, TierAgg> = {};
      for (const tier of [...RATE_TIERS, 'unclassified']) t[tier] = { count: 0, volume_minor: 0, commission_minor: 0, commission_known: 0 };
      return t;
    };
    const byLoc = new Map<string, { tiers: Record<string, TierAgg>; refunds_minor: number; fees_minor: number; fee_known: number; currency: string | null }>();
    let currency: string | null = null;
    for (const r of rows) {
      const key = r.location_id ?? 'unmatched';
      if (!byLoc.has(key)) byLoc.set(key, { tiers: blankTiers(), refunds_minor: 0, fees_minor: 0, fee_known: 0, currency: null });
      const agg = byLoc.get(key)!;
      if (r.currency) { agg.currency = agg.currency ?? r.currency; currency = currency ?? r.currency; }
      agg.refunds_minor += Number(r.amount_refunded_minor) || 0;
      if (!isPayment(r)) continue;
      const tier = classified && r.rate_category && (RATE_TIERS as readonly string[]).includes(r.rate_category) ? r.rate_category : 'unclassified';
      const t = agg.tiers[tier];
      t.count++;
      t.volume_minor += Number(r.amount_minor) || 0;
      if (classified && r.commission_minor != null) { t.commission_minor += Number(r.commission_minor) || 0; t.commission_known++; }
      if (feesLive && r.fee_minor != null) { agg.fees_minor += Number(r.fee_minor) || 0; agg.fee_known++; }
    }

    // SaaS per ops location → merged onto the platform row where the mapping
    // exists, listed standalone where it does not. Itemization from
    // SAAS_CATALOG (all POUNDS): plan fee + extra devices at 39 + HubRise at
    // 45; saas_total is the STORED monthly_fee — the number actually invoiced.
    const itemizeSaas = (sub: any) => {
      const plan = String(sub.plan ?? 'free');
      const planDef = SAAS_CATALOG.plans[plan] ?? null;
      const extra = saasTyped ? Number(sub.extra_devices) || 0 : 0;
      const hubrise = saasTyped ? !!sub.hubrise : false;
      return {
        plan,
        plan_fee: planDef ? planDef.monthly : null,
        extra_devices: extra,
        device_fee: extra * SAAS_CATALOG.extra_device_monthly,
        hubrise,
        hubrise_fee: hubrise ? SAAS_CATALOG.hubrise_monthly : 0,
        saas_total: Number(sub.monthly_fee) || 0,
        device_allowance: planDef ? planDef.devices + extra : null,
        // stale = the stored fee (what is invoiced) no longer matches the
        // catalog itemization — a pre-v5.7.4 row, or catalog prices changed.
        // Re-saving the venue in Processing refreshes it.
        stale: saasTyped && planDef
          ? Math.abs((planDef.monthly + extra * SAAS_CATALOG.extra_device_monthly + (hubrise ? SAAS_CATALOG.hubrise_monthly : 0)) - (Number(sub.monthly_fee) || 0)) > 0.005
          : false,
      };
    };
    const saasByPlatformLoc = new Map<string, { opsId: string; item: ReturnType<typeof itemizeSaas> }>();
    const saasUnmapped: any[] = [];
    const planCounts: Record<string, number> = {};
    for (const sub of subs ?? []) {
      const item = itemizeSaas(sub);
      planCounts[item.plan] = (planCounts[item.plan] ?? 0) + 1;
      const platformLoc = sub.location_id ? locByOps.get(sub.location_id) : null;
      if (platformLoc) saasByPlatformLoc.set(platformLoc.id, { opsId: sub.location_id, item });
      else saasUnmapped.push({ ops_location_id: sub.location_id, name: opsNameById.get(sub.location_id) ?? '(unknown venue)', plan: item.plan, monthly_fee: item.saas_total, saas: item });
    }

    const toPence = (pounds: number) => Math.round(pounds * 100);
    const out: any[] = [];
    const allLocIds = new Set<string>([...byLoc.keys(), ...saasByPlatformLoc.keys()]);
    for (const locId of allLocIds) {
      const agg = byLoc.get(locId);
      const saas = locId === 'unmatched' ? null : saasByPlatformLoc.get(locId) ?? null;
      const tiers = agg?.tiers ?? blankTiers();
      const commission_total = Object.values(tiers).reduce((s, t) => s + t.commission_minor, 0);
      const volume_total = Object.values(tiers).reduce((s, t) => s + t.volume_minor, 0);
      const count_total = Object.values(tiers).reduce((s, t) => s + t.count, 0);
      const fee_known = agg?.fee_known ?? 0;
      const saas_fee_minor = saas ? toPence(saas.item.saas_total) : null;
      // Advisory flags, computed against THIS month's card volume and today's
      // paired device count. A venue on Free with volume inside the Free band
      // is a correctly configured state — recommended_plan stays null there.
      let saasDetail: any = null;
      if (saas) {
        // A selected month still in progress has partial volume — a low number
        // must never whisper "downgrade" at a correctly configured paid venue.
        // Upgrade nudges stand (volume only grows within the month).
        const monthComplete = to.getTime() <= Date.now();
        const rank: Record<string, number> = { free: 0, growth: 1, scale: 2 };
        let recommended = saasPlanForVolume(volume_total);
        if (!monthComplete && (rank[recommended] ?? 0) <= (rank[saas.item.plan] ?? 0)) recommended = saas.item.plan;
        const devCount = devCountByOps.get(saas.opsId) ?? 0;
        saasDetail = {
          ...saas.item,
          recommended_plan: recommended !== saas.item.plan ? recommended : null,
          devices_over: saas.item.device_allowance != null && devCount > saas.item.device_allowance
            ? { count: devCount, allowance: saas.item.device_allowance } : null,
          device_count: devCount,
        };
      }
      out.push({
        location_id: locId === 'unmatched' ? null : locId,
        name: locId === 'unmatched' ? '(payments not matched to a venue)' : (locById.get(locId)?.name ?? '(unknown venue)'),
        currency: agg?.currency ?? null,
        by_category: tiers,
        payments_count: count_total,
        volume_minor: volume_total,
        refunds_minor: agg?.refunds_minor ?? 0,
        commission_minor: commission_total,
        fees_minor: fee_known > 0 ? agg!.fees_minor : null,
        fee_known,
        margin_minor: fee_known > 0 ? commission_total - agg!.fees_minor : null,
        saas_plan: saasDetail?.plan ?? null,
        saas_fee_minor,
        saas: saasDetail,
        revenue_minor: commission_total + (saas_fee_minor ?? 0),
      });
    }
    out.sort((a, b) => b.revenue_minor - a.revenue_minor || String(a.name).localeCompare(String(b.name)));

    const totals = {
      payments_count: out.reduce((s, r) => s + r.payments_count, 0),
      volume_minor: out.reduce((s, r) => s + r.volume_minor, 0),
      refunds_minor: out.reduce((s, r) => s + r.refunds_minor, 0),
      commission_minor: out.reduce((s, r) => s + r.commission_minor, 0),
      fees_minor: out.some((r) => r.fees_minor != null) ? out.reduce((s, r) => s + (r.fees_minor ?? 0), 0) : null,
      saas_fee_minor: out.reduce((s, r) => s + (r.saas_fee_minor ?? 0), 0) + saasUnmapped.reduce((s, r) => s + toPence(r.monthly_fee), 0),
      unclassified_count: out.reduce((s, r) => s + (r.by_category.unclassified?.count ?? 0), 0),
    };

    return json({
      ok: true,
      month,
      currency: currency ?? 'GBP',
      rows: out,
      totals: { ...totals, revenue_minor: totals.commission_minor + totals.saas_fee_minor },
      saas: { plans: planCounts, typed: saasTyped, unmapped: saasUnmapped },
      classified,
      fees_live: feesLive,
      capped: rows.length >= CAP,
    });
  }

  if (!location_id) return json({ error: 'location_id required' }, 400);

  const loc = await resolveLocation(location_id);
  if (!loc) return json({ error: 'location not found in platform DB' }, 404);

  // ── set_processor (works for both processors; no Ryft needed) ───────────
  if (action === 'set_processor') {
    const processor = body?.processor;
    if (processor !== 'stripe' && processor !== 'ryft' && processor !== 'adyen') return json({ error: "processor must be 'stripe', 'ryft' or 'adyen'" }, 400);
    const { error } = await platformAdmin.from('locations').update({ payment_processor: processor }).eq('id', loc.id);
    if (error) return json({ error: `processor update failed: ${error.message}` }, 500);
    return json({ success: true, processor });
  }

  // ── ryft_pricing (our MARKUP on top: % + per-txn pence; null = platform default) ──
  if (action === 'ryft_pricing') {
    const numOrNull = (v: unknown) => (v === '' || v === null || v === undefined ? null : Number(v));
    const intOrNull = (v: unknown) => (v === '' || v === null || v === undefined ? null : Math.round(Number(v)));
    const patch: Record<string, unknown> = {
      markup_percent: numOrNull(body.markup_percent),
      markup_fixed_pence: intOrNull(body.markup_fixed_pence),
      pricing_notes: body.pricing_notes || null,
    };
    const { error } = await platformAdmin.from('merchant_ryft_accounts').update(patch).eq('location_id', loc.id);
    if (error) return json({ error: `pricing update failed: ${error.message}` }, 500);
    return json({ success: true });
  }

  // ── ryft_fees: read ACTUAL fees from Ryft (cost + our markup collected) ──
  if (action === 'ryft_fees') {
    const { data: row } = await platformAdmin.from('merchant_ryft_accounts')
      .select('ryft_account_id').eq('location_id', loc.id).maybeSingle();
    if (!row?.ryft_account_id) return json({ success: true, linked: false });
    if (!ryftConfigured()) return json({ error: 'Ryft not configured' }, 500);
    const opts = { accountId: row.ryft_account_id };
    const [bt, pf] = await Promise.all([listBalanceTransactions(opts, 50), listPlatformFees(opts, 50)]);
    const btItems: any[] = bt.ok ? (bt.data?.items ?? []) : [];
    const pfItems: any[] = pf.ok ? (pf.data?.items ?? []) : [];
    const sum = (arr: any[], f: (x: any) => number) => arr.reduce((s, x) => s + (Number(f(x)) || 0), 0);
    const isCapture = (t: string) => /capture/i.test(t || '');
    return json({
      success: true, linked: true, currency: btItems[0]?.currency ?? pfItems[0]?.currency ?? 'GBP',
      gmv_minor: sum(btItems.filter((x) => isCapture(x.type)), (x) => x.amount),
      ryft_fees_minor: sum(btItems, (x) => x.feeTotal),
      markup_collected_minor: sum(pfItems, (x) => x.amount ?? x.fee ?? 0),
      txn_count: btItems.length, fee_count: pfItems.length,
    });
  }

  // ── ryft_unlink: detach the account row (does NOT delete it at Ryft) ─────
  if (action === 'ryft_unlink') {
    const { error } = await platformAdmin.from('merchant_ryft_accounts').delete().eq('location_id', loc.id);
    if (error) return json({ error: `unlink failed: ${error.message}` }, 500);
    return json({ success: true });
  }

  // ── stripe_pricing (our MARKUP on top: card-present % + online %; null = platform default) ──
  //    Mirrors ryft_pricing. merchant_stripe_accounts is RLS select-only for the
  //    anon admin client, so this write MUST run with the service role here.
  if (action === 'stripe_pricing') {
    const numOrNull = (v: unknown) => (v === '' || v === null || v === undefined ? null : Number(v));
    const patch: Record<string, unknown> = {
      cardpresent_markup_percent: numOrNull(body.cardpresent),
      online_markup_percent:      numOrNull(body.online),
      pricing_notes: body.notes || null,
    };
    const { error } = await platformAdmin.from('merchant_stripe_accounts').update(patch).eq('location_id', loc.id);
    if (error) return json({ error: `pricing update failed: ${error.message}` }, 500);
    return json({ success: true });
  }

  // ── stripe_unlink: detach the merchant account row (mirror of ryft_unlink) ──
  //    Same RLS reason as stripe_pricing — the client .delete() silently no-ops.
  if (action === 'stripe_unlink') {
    const { error } = await platformAdmin.from('merchant_stripe_accounts').delete().eq('location_id', loc.id);
    if (error) return json({ error: `unlink failed: ${error.message}` }, 500);
    return json({ success: true });
  }

  // Everything below talks to Ryft.
  if (!ryftConfigured()) return json({ error: 'Ryft not configured (RYFT_SECRET_KEY missing)' }, 500);

  // ── ryft_create: new Sub-Account + Hosted onboarding link ───────────────
  if (action === 'ryft_create') {
    // Don't silently orphan an existing merchant account.
    const { data: existing } = await platformAdmin.from('merchant_ryft_accounts')
      .select('ryft_account_id').eq('location_id', loc.id).maybeSingle();
    if (existing?.ryft_account_id) {
      return json({ error: `This location already has Ryft account ${existing.ryft_account_id}. Use "Continue onboarding" or "Sync", or unlink first.` }, 409);
    }
    if (!body.email) return json({ error: 'email is required to create a Hosted merchant' }, 400);
    const input: Record<string, unknown> = { onboardingFlow: 'Hosted', email: body.email };
    // Ryft REJECTS entityType unless its matching block is also present, so only
    // pre-fill when a COMPLETE block is supplied. For Hosted onboarding the
    // merchant fills entity type + KYC/KYB in Ryft's portal regardless.
    if (body.entity_type === 'Business' && body.business) { input.entityType = 'Business'; input.business = body.business; }
    else if (body.entity_type === 'Individual' && body.individual) { input.entityType = 'Individual'; input.individual = body.individual; }
    const meta = cleanMeta({ location_id: loc.id, location_name: loc.name, trading_name: body.trading_name });
    if (Object.keys(meta).length) input.metadata = meta;

    const created = await createSubAccount(input);
    if (!created.ok || !created.data?.id) {
      return json({ error: ryftErr(created.data) || `Ryft account create failed (${created.status})`, ryft: created.data }, 502);
    }
    const accountId = created.data.id as string;

    const { error: upErr, derived } = await upsertRyftAccount(loc, accountId, created.data, caller.id);
    if (upErr) return json({ error: `merchant_ryft_accounts upsert failed: ${upErr.message}` }, 500);

    // Mint the hosted onboarding link (best-effort — the account exists either way).
    let onboarding_url: string | null = null, expires_at: number | null = null, link_error: string | null = null;
    if (body.redirect_url) {
      const link = await createAccountLink({ accountId, redirectUrl: body.redirect_url });
      if (link.ok && link.data?.url) { onboarding_url = link.data.url; expires_at = link.data.expiresTimestamp ?? null; }
      else link_error = ryftErr(link.data) || `account-link failed (${link.status})`;
    }
    return json({ success: true, account_id: accountId, verification_status: derived.verification_status, charges_enabled: derived.charges_enabled, onboarding_url, expires_at, link_error });
  }

  // ── ryft_link: attach an existing ac_… account ──────────────────────────
  if (action === 'ryft_link') {
    const accountId = String(body.ryft_account_id ?? '').trim();
    if (!accountId.startsWith('ac_')) {
      const looksUuid = /^[0-9a-f-]{32,36}$/i.test(accountId);
      return json({ error: looksUuid
        ? "That looks like a location id, not a Ryft account id. The account id starts with 'ac_' and is on the account's page in the Ryft dashboard."
        : "A Ryft account id starts with 'ac_'." }, 400);
    }
    // A Ryft account can only belong to ONE location (ryft_account_id is unique).
    // Catch "already linked elsewhere" BEFORE the upsert so we return a clear
    // message instead of a raw duplicate-key DB error (this was surfacing as
    // "it loads but doesn't link").
    const { data: dup } = await platformAdmin.from('merchant_ryft_accounts')
      .select('location_id').eq('ryft_account_id', accountId).maybeSingle();
    if (dup && dup.location_id !== loc.id) {
      const { data: other } = await platformAdmin.from('locations').select('name').eq('id', dup.location_id).maybeSingle();
      return json({ error: `This Ryft account is already connected to ${other?.name ? `“${other.name}”` : 'another location'}. Unlink it there first, then connect it here.` }, 409);
    }
    const got = await getAccount(accountId);
    if (!got.ok || !got.data?.id) {
      return json({ error: `Ryft couldn't find account ${accountId}. We're in TEST mode — copy the id from the Ryft SANDBOX dashboard (a live account won't be found here).`, ryft: got.data }, 400);
    }
    const { error: upErr, derived } = await upsertRyftAccount(loc, accountId, got.data, caller.id);
    if (upErr) return json({ error: `Couldn't save the connection: ${upErr.message}` }, 500);
    return json({ success: true, account_id: accountId, verification_status: derived.verification_status, charges_enabled: derived.charges_enabled });
  }

  // ── ryft_inspect: look up an account so the admin SEES what they're about to
  //    connect (email, status, which location its metadata points to) before
  //    saving — removes the "is this the right account?" guesswork. Read-only.
  if (action === 'ryft_inspect') {
    const accountId = String(body.ryft_account_id ?? '').trim();
    if (!accountId.startsWith('ac_')) {
      // Most common mistake: pasting a location UUID (or some other id) instead
      // of the Ryft account id. Say so plainly.
      const looksUuid = /^[0-9a-f-]{32,36}$/i.test(accountId);
      return json({ error: looksUuid
        ? "That looks like a location id, not a Ryft account id. The account id starts with 'ac_' and is shown on the account's page in the Ryft dashboard."
        : "A Ryft account id starts with 'ac_'." }, 400);
    }
    const got = await getAccount(accountId);
    if (!got.ok || !got.data?.id) return json({ error: ryftErr(got.data) || `Ryft account not found (${got.status})` }, 404);
    const a = got.data;
    const d = deriveStatus(a);
    const metaLocId = a?.metadata?.location_id ?? null;
    // If this account is already linked to a location, surface that too.
    let linkedTo: string | null = null;
    const { data: existing } = await platformAdmin.from('merchant_ryft_accounts').select('location_id').eq('ryft_account_id', accountId).maybeSingle();
    if (existing?.location_id) linkedTo = existing.location_id;
    return json({
      success: true,
      account_id: accountId,
      email: a?.email ?? null,
      verification_status: d.verification_status,
      charges_enabled: d.charges_enabled,
      metadata_location_id: metaLocId,
      metadata_location_name: a?.metadata?.location_name ?? a?.metadata?.trading_name ?? null,
      matches_this_location: metaLocId ? metaLocId === loc.id : null,
      already_linked_location_id: linkedTo,
    });
  }

  // ── ryft_sync: refresh status from Ryft ─────────────────────────────────
  if (action === 'ryft_sync') {
    const { data: row } = await platformAdmin.from('merchant_ryft_accounts')
      .select('ryft_account_id').eq('location_id', loc.id).maybeSingle();
    if (!row?.ryft_account_id) return json({ error: 'No Ryft account linked to this location' }, 404);
    const got = await getAccount(row.ryft_account_id);
    if (!got.ok || !got.data?.id) return json({ error: ryftErr(got.data) || `Ryft fetch failed (${got.status})`, ryft: got.data }, 502);
    const { error: upErr, derived } = await upsertRyftAccount(loc, row.ryft_account_id, got.data, caller.id);
    if (upErr) return json({ error: `merchant_ryft_accounts update failed: ${upErr.message}` }, 500);
    return json({ success: true, account_id: row.ryft_account_id, verification_status: derived.verification_status, charges_enabled: derived.charges_enabled });
  }

  // ── ryft_onboarding_link: fresh hosted link to continue/finish KYC ──────
  if (action === 'ryft_onboarding_link') {
    if (!body.redirect_url) return json({ error: 'redirect_url required' }, 400);
    const { data: row } = await platformAdmin.from('merchant_ryft_accounts')
      .select('ryft_account_id').eq('location_id', loc.id).maybeSingle();
    if (!row?.ryft_account_id) return json({ error: 'No Ryft account linked to this location' }, 404);
    const link = await createAccountLink({ accountId: row.ryft_account_id, redirectUrl: body.redirect_url });
    if (link.ok && link.data?.url) return json({ success: true, onboarding_url: link.data.url, expires_at: link.data.expiresTimestamp ?? null, mode: 'onboard' });
    // A hosted onboarding link can't be minted once the merchant is fully
    // onboarded — fall back to an authorize (sign-in) link so the button always
    // opens their Ryft dashboard. Use the account's OWN email (the caller need
    // not pass it) — this is why the button looked dead on a "ready" account.
    let email = body.email as string | undefined;
    if (!email) { const got = await getAccount(row.ryft_account_id); email = got.ok ? (got.data?.email as string | undefined) : undefined; }
    if (email) {
      const auth = await authorizeAccount({ email, redirectUrl: body.redirect_url });
      if (auth.ok && auth.data?.url) return json({ success: true, onboarding_url: auth.data.url, expires_at: auth.data.expiresTimestamp ?? null, mode: 'manage' });
    }
    return json({ error: ryftErr(link.data) || `Couldn't create a Ryft portal link (${link.status})`, ryft: link.data }, 502);
  }

  // ── Reseller (FranPOS) residuals ──────────────────────────────────────────
  // We process on FranPOS's Adyen account, so every venue's card markup settles
  // to FranPOS. They keep the buy rate (0.10% + 5 minor units per transaction,
  // reseller terms 26 Aug 2026) and owe us the rest of each payment's stamped
  // commission. These actions compute that residual and run the invoice ledger,
  // because nothing arrives unless we bill them.

  if (action === 'reseller_statement' || action === 'reseller_invoice_create') {
    const month = String(body.month ?? '');
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return json({ error: 'month must be YYYY-MM' }, 400);
    // An invoice for a month that has not finished would silently exclude the
    // rest of the month, and the live unique key would then block the real one.
    // Statements for the open month remain viewable. UTC deliberately: the
    // bucketing below is on UTC boundaries, so UTC month-end is period close.
    if (action === 'reseller_invoice_create') {
      const nowMonth = new Date().toISOString().slice(0, 7);
      if (month >= nowMonth) {
        return json({ error: `${month} is still open. Create the invoice after the month ends so it covers every payment.` }, 400);
      }
    }
    const from = new Date(`${month}-01T00:00:00Z`);
    const to = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1));
    const isMissingColumn = (msg: unknown) => /does not exist|42703|PGRST204|Could not find the/i.test(String(msg ?? ''));

    // The buy rate for THIS month. Rate changes are effective-dated in
    // adyen_reseller_rate_history so a renegotiation never reprices history:
    // regenerating an old month resolves the rate that governed that month.
    // select('*') on the singleton row on purpose: naming the columns errors
    // whenever the deploy precedes the hand-applied migration, and that error
    // would silently revert a renegotiated rate to the hardcoded fallback.
    let buyPercent = 0.10, buyFixedMinor = 5, buyFromSettings = false;
    {
      const { data: st, error: stErr } = await platformAdmin.from('platform_settings').select('*').maybeSingle();
      if (!stErr && st) {
        if ((st as any).adyen_reseller_buy_percent != null) { buyPercent = Number((st as any).adyen_reseller_buy_percent); buyFromSettings = true; }
        if ((st as any).adyen_reseller_buy_fixed_minor != null) buyFixedMinor = Number((st as any).adyen_reseller_buy_fixed_minor);
        const hist = (st as any).adyen_reseller_rate_history;
        if (Array.isArray(hist) && hist.length) {
          const governing = hist
            .filter((h: any) => h && typeof h.from_month === 'string' && h.from_month <= month)
            .sort((a: any, b: any) => String(a.from_month).localeCompare(String(b.from_month)))
            .pop();
          if (governing && Number.isFinite(Number(governing.percent)) && Number.isFinite(Number(governing.fixed_minor))) {
            buyPercent = Number(governing.percent);
            buyFixedMinor = Number(governing.fixed_minor);
            buyFromSettings = true;
          }
        }
      }
    }

    // Column ladder so a pre-migration ledger degrades honestly instead of
    // erroring. applied_mods rides the raw jsonb (always present) because it is
    // the settlement truth for rows written before the captured_at column.
    const BASE = 'psp_reference, location_id, amount_minor, amount_refunded_minor, success, last_event_code, currency, applied_mods:raw->applied_modifications';
    const LADDER = [
      `${BASE}, commission_minor, authorised_at, capture_required, captured_at`,
      `${BASE}, commission_minor`,
      BASE,
    ];
    let ladderIdx = 0;
    const rows: any[] = [];
    // Bucket on the month the payment was AUTHORISED where stamped, with
    // created_at as the fallback for pre-migration rows. FranPOS reconciles
    // from Adyen's own payment dates, so webhook-arrival-month bucketing turns
    // every boundary payment (and every backfill-minted row) into a dispute.
    const monthFilter = (ladder: number) => ladder === 0
      ? `and(authorised_at.gte.${from.toISOString()},authorised_at.lt.${to.toISOString()}),and(authorised_at.is.null,created_at.gte.${from.toISOString()},created_at.lt.${to.toISOString()})`
      : null;
    // The pager fails LOUDLY at a ceiling instead of truncating: a silently
    // short statement under-bills FranPOS forever with nothing to notice it.
    // Secondary sort on the primary key: created_at ties (bulk ingests) make
    // offset paging over a non-unique key skip or duplicate boundary rows.
    const PAGE = 1000;
    const HARD_CEILING = 200000;
    for (let fromIdx = 0; ; fromIdx += PAGE) {
      const build = (ladder: number) => {
        let q = platformAdmin.from('adyen_payments').select(LADDER[ladder]);
        const or = monthFilter(ladder);
        if (or) q = q.or(or);
        else q = q.gte('created_at', from.toISOString()).lt('created_at', to.toISOString());
        return q.order('created_at', { ascending: true })
          .order('psp_reference', { ascending: true })
          .range(fromIdx, fromIdx + PAGE - 1);
      };
      let res = await build(ladderIdx);
      while (res.error && isMissingColumn(res.error.message) && ladderIdx < LADDER.length - 1) {
        ladderIdx++;
        res = await build(ladderIdx);
      }
      if (res.error) return json({ error: `payments read failed: ${res.error.message}` }, 500);
      const batch = (res.data ?? []) as any[];
      rows.push(...batch);
      if (batch.length < PAGE) break;
      if (rows.length > HARD_CEILING) {
        return json({ error: `More than ${HARD_CEILING} payments in ${month}. Move the aggregation into a SQL RPC before invoicing this month.` }, 500);
      }
    }

    const { data: locs } = await platformAdmin.from('locations').select('id, name');
    const nameById = new Map<string, string>();
    for (const l of locs ?? []) nameById.set(l.id, l.name);

    // Per currency, per venue. One invoice per currency: FranPOS cannot be
    // billed a GBP+USD blend on one line, and minor units never cross currencies.
    const isPayment = (r: any) => r.success === true && r.last_event_code !== 'CANCELLATION';
    // Did any capture SUCCEED on this row? raw.applied_modifications is the
    // settlement truth that survives out-of-order webhooks: a stale
    // CAPTURE_FAILED from an earlier attempt can overwrite last_event_code on a
    // payment that DID settle, and pre-migration rows have no captured_at.
    const hasSuccessfulCapture = (r: any) => Array.isArray(r.applied_mods)
      && r.applied_mods.some((m: any) => String(m).startsWith('CAPTURE:') && String(m).endsWith(':true'));
    // A payment whose money never actually moved on FranPOS's Adyen account
    // must not be invoiced: FranPOS reconciles against settlement and would
    // dispute it. Two shapes: a capture that failed with no successful capture
    // anywhere, and a manual-capture auth (US tip flow) never captured.
    const isUnsettled = (r: any) => {
      if (r.last_event_code === 'CAPTURE_FAILED' && !hasSuccessfulCapture(r)) return true;
      if (r.capture_required === true && !r.captured_at && !hasSuccessfulCapture(r)) return true;
      return false;
    };
    type VLine = {
      location_id: string; name: string;
      count: number; volume_minor: number;
      gross_commission_minor: number; buy_share_minor: number; net_due_minor: number;
      unrated_count: number; unrated_volume_minor: number;
      unsettled_count: number; unsettled_volume_minor: number; refunds_minor: number;
    };
    const byCur = new Map<string, Map<string, VLine>>();
    for (const r of rows) {
      const cur = String(r.currency || 'GBP');
      if (!byCur.has(cur)) byCur.set(cur, new Map());
      const perLoc = byCur.get(cur)!;
      const key = r.location_id ?? 'unmatched';
      if (!perLoc.has(key)) {
        perLoc.set(key, {
          location_id: key, name: key === 'unmatched' ? '(unmatched payments)' : (nameById.get(key) ?? key),
          count: 0, volume_minor: 0, gross_commission_minor: 0, buy_share_minor: 0, net_due_minor: 0,
          unrated_count: 0, unrated_volume_minor: 0,
          unsettled_count: 0, unsettled_volume_minor: 0, refunds_minor: 0,
        });
      }
      const line = perLoc.get(key)!;
      line.refunds_minor += Number(r.amount_refunded_minor) || 0;
      if (!isPayment(r)) continue;
      const amount = Number(r.amount_minor) || 0;
      if (isUnsettled(r)) {
        // Withheld, and SHOWN as withheld: hiding these would make the statement
        // disagree with FranPOS's settlement data with no visible reason.
        line.unsettled_count++;
        line.unsettled_volume_minor += amount;
        continue;
      }
      line.count++;
      line.volume_minor += amount;
      const gross = ladderIdx === 0 && r.commission_minor != null ? Number(r.commission_minor) : null;
      if (gross === null) {
        // No stamped commission: flag it, never invent it. These payments are
        // excluded from the invoice total and surfaced for a backfill.
        line.unrated_count++;
        line.unrated_volume_minor += amount;
        continue;
      }
      // FranPOS's cut, rounded the same half-up way commissionForAmount rounds
      // ours, so the two sides of the split are computed identically.
      const buy = Math.floor((amount * buyPercent) / 100 + 0.5) + buyFixedMinor;
      // A tiny payment can price below the buy rate. That is a real loss on the
      // transaction, and hiding it by clamping to zero would overstate what
      // FranPOS owes across the month.
      line.gross_commission_minor += gross;
      line.buy_share_minor += buy;
      line.net_due_minor += gross - buy;
    }

    const statements = [...byCur.entries()].map(([currency, perLoc]) => {
      const lines = [...perLoc.values()].sort((a, b) => b.net_due_minor - a.net_due_minor);
      const sum = (f: (l: VLine) => number) => lines.reduce((s, l) => s + f(l), 0);
      return {
        currency,
        lines,
        totals: {
          count: sum((l) => l.count), volume_minor: sum((l) => l.volume_minor),
          gross_commission_minor: sum((l) => l.gross_commission_minor),
          buy_share_minor: sum((l) => l.buy_share_minor),
          net_due_minor: sum((l) => l.net_due_minor),
          unrated_count: sum((l) => l.unrated_count), unrated_volume_minor: sum((l) => l.unrated_volume_minor),
          unsettled_count: sum((l) => l.unsettled_count), unsettled_volume_minor: sum((l) => l.unsettled_volume_minor),
          refunds_minor: sum((l) => l.refunds_minor),
        },
      };
    }).filter((s) => s.totals.count > 0 || s.totals.refunds_minor > 0);

    const config = { buy_percent: buyPercent, buy_fixed_minor: buyFixedMinor, from_settings: buyFromSettings, commission_classified: ladderIdx === 0 };

    if (action === 'reseller_statement') return json({ success: true, month, config, statements });

    // ── create: persist one invoice per currency ──
    if (!statements.length) return json({ error: 'Nothing to invoice for that month.' }, 400);
    const created: any[] = [];
    for (const s of statements) {
      // Revision-aware numbering: after a void-and-regenerate, FranPOS's
      // accounts payable must never receive a SECOND document with the SAME
      // number and different totals. That reads as fraud and freezes payment.
      // At insert time any prior rows for this key can only be void ones (a
      // live one makes the insert fail on reseller_invoices_live_key).
      const { count: prior, error: priorErr } = await platformAdmin.from('reseller_invoices')
        .select('id', { count: 'exact', head: true })
        .eq('counterparty', 'FranPOS').eq('period', month).eq('currency', s.currency);
      if (priorErr && !isMissingColumn(priorErr.message) && !/does not exist|42P01/i.test(String(priorErr.message))) {
        return json({ error: `invoice numbering check failed: ${priorErr.message}`, created }, 500);
      }
      const revision = (prior ?? 0) + 1;
      const row = {
        counterparty: 'FranPOS',
        period: month,
        currency: s.currency,
        invoice_number: revision === 1 ? `FP-${month}-${s.currency}` : `FP-${month}-${s.currency}-R${revision}`,
        payment_count: s.totals.count,
        volume_minor: s.totals.volume_minor,
        gross_commission_minor: s.totals.gross_commission_minor,
        buy_share_minor: s.totals.buy_share_minor,
        net_due_minor: s.totals.net_due_minor,
        unrated_count: s.totals.unrated_count,
        unrated_volume_minor: s.totals.unrated_volume_minor,
        buy_percent: buyPercent,
        buy_fixed_minor: buyFixedMinor,
        breakdown: {
          lines: s.lines,
          refunds_minor: s.totals.refunds_minor,
          unsettled_count: s.totals.unsettled_count,
          unsettled_volume_minor: s.totals.unsettled_volume_minor,
          replaces_note: revision > 1 ? `Replaces a voided earlier invoice for ${month} ${s.currency}` : null,
        },
        created_by: caller.id ?? null,
      };
      const { data: inv, error: invErr } = await platformAdmin.from('reseller_invoices')
        .insert(row).select().single();
      if (invErr) {
        const dup = /duplicate key|reseller_invoices_live_key/i.test(String(invErr.message));
        return json({
          error: dup
            ? `An invoice for ${month} ${s.currency} already exists. Void it first if it needs regenerating.`
            : (isMissingColumn(invErr.message)
              ? 'The reseller_invoices table is missing. Apply migration 20260826_PLATFORM_reseller_invoicing.sql first.'
              : `invoice insert failed: ${invErr.message}`),
          created,
        }, dup ? 409 : 500);
      }
      created.push(inv);
    }
    return json({ success: true, month, config, invoices: created });
  }

  if (action === 'reseller_invoices') {
    // The remittance block (addresses, bank details, payment terms, tax line)
    // rides along so the printed invoice carries what accounts payable demands.
    // Read BEFORE the invoices select so it survives the table_missing return.
    let remit: unknown = null;
    {
      const { data: st, error: rerr } = await platformAdmin.from('platform_settings').select('*').maybeSingle();
      if (!rerr) remit = (st as any)?.reseller_invoice_remit ?? null;
    }
    const { data, error } = await platformAdmin.from('reseller_invoices')
      .select('*').order('period', { ascending: false }).order('created_at', { ascending: false }).limit(60);
    if (error) {
      return /does not exist|42P01/i.test(String(error.message))
        ? json({ success: true, invoices: [], table_missing: true, remit })
        : json({ error: error.message }, 500);
    }
    return json({ success: true, invoices: data ?? [], remit });
  }

  if (action === 'reseller_invoice_mark') {
    const id = String(body.id ?? '');
    const status = String(body.status ?? '');
    if (!id) return json({ error: 'id required' }, 400);
    if (!['sent', 'paid', 'void'].includes(status)) return json({ error: 'status must be sent, paid or void' }, 400);
    const { data: cur, error: curErr } = await platformAdmin.from('reseller_invoices')
      .select('status, status_history, notes').eq('id', id).maybeSingle();
    if (curErr) {
      // Pre-migration table shape: degrade to the status column alone.
      const { data: bare } = await platformAdmin.from('reseller_invoices').select('status, notes').eq('id', id).maybeSingle();
      if (!bare) return json({ error: 'invoice not found' }, 404);
      (cur as any) = { ...bare, status_history: null };
    }
    if (!cur) return json({ error: 'invoice not found' }, 404);
    // Forward only, plus void from anywhere. Paid never silently un-pays.
    const legal: Record<string, string[]> = { draft: ['sent', 'void'], sent: ['paid', 'void'], paid: ['void'], void: [] };
    if (!legal[cur.status]?.includes(status)) {
      return json({ error: `cannot move an invoice from ${cur.status} to ${status}` }, 409);
    }
    // A void with no reason is unanswerable in six months when FranPOS asks
    // what happened to the number they were sent.
    const note = typeof body.notes === 'string' ? body.notes.slice(0, 2000) : '';
    if (status === 'void' && !note.trim()) return json({ error: 'A void needs a reason. Pass notes.' }, 400);
    const patch: Record<string, unknown> = { status };
    if (status === 'sent') patch.sent_at = new Date().toISOString();
    if (status === 'paid') patch.paid_at = new Date().toISOString();
    if (status === 'void') patch.voided_at = new Date().toISOString();
    // Audit trail: append, never overwrite. Who, when, from, to, why.
    const trail = Array.isArray((cur as any).status_history) ? [...(cur as any).status_history] : [];
    trail.push({ at: new Date().toISOString(), by: caller.id ?? null, from: cur.status, to: status, note: note || null });
    patch.status_history = trail;
    // Notes append with a stamp: an overwrite destroyed the previous note.
    if (note) {
      const stamped = `[${new Date().toISOString().slice(0, 16)}] ${note}`;
      patch.notes = cur.notes ? `${cur.notes}\n${stamped}`.slice(0, 8000) : stamped;
    }
    let { data, error } = await platformAdmin.from('reseller_invoices').update(patch).eq('id', id).select().single();
    if (error && /does not exist|42703|PGRST204|Could not find the/i.test(String(error.message))) {
      // Audit columns not applied yet: keep the transition, drop the trail.
      delete patch.status_history;
      delete patch.voided_at;
      ({ data, error } = await platformAdmin.from('reseller_invoices').update(patch).eq('id', id).select().single());
    }
    if (error) return json({ error: error.message }, 500);
    return json({ success: true, invoice: data });
  }

  if (action === 'reseller_config') {
    if (body.set) {
      const pct = Number(body.set.buy_percent);
      const fixed = Number(body.set.buy_fixed_minor);
      if (!Number.isFinite(pct) || pct < 0 || pct > 5) return json({ error: 'buy_percent must be between 0 and 5' }, 400);
      if (!Number.isInteger(fixed) || fixed < 0 || fixed > 100) return json({ error: 'buy_fixed_minor must be a whole number of minor units, 0 to 100' }, 400);
      // Effective-dated: the change governs from the CURRENT month onward and
      // is APPENDED to the rate history, so a statement or a void-and-recreate
      // for an old month always resolves the rate that governed that month.
      // A renegotiation must never quietly reprice history.
      const { data: st0 } = await platformAdmin.from('platform_settings').select('*').maybeSingle();
      const hist = Array.isArray((st0 as any)?.adyen_reseller_rate_history) ? [...(st0 as any).adyen_reseller_rate_history] : [];
      const fromMonth = new Date().toISOString().slice(0, 7);
      const idx = hist.findIndex((h: any) => h?.from_month === fromMonth);
      const entry = { percent: pct, fixed_minor: fixed, from_month: fromMonth, set_by: caller.id ?? null, set_at: new Date().toISOString() };
      if (idx >= 0) hist[idx] = entry; else hist.push(entry);
      const patch: Record<string, unknown> = {
        adyen_reseller_buy_percent: pct,
        adyen_reseller_buy_fixed_minor: fixed,
        adyen_reseller_rate_history: hist,
        updated_at: new Date().toISOString(),
        updated_by_user_id: caller.id ?? null,
      };
      let { error } = await platformAdmin.from('platform_settings').update(patch).eq('id', true);
      if (error && /does not exist|42703|PGRST204/i.test(String(error.message))) {
        // History column not applied yet: keep the flat rate change working.
        delete patch.adyen_reseller_rate_history;
        ({ error } = await platformAdmin.from('platform_settings').update(patch).eq('id', true));
      }
      if (error) {
        return /does not exist|42703|PGRST204/i.test(String(error.message))
          ? json({ error: 'platform_settings is missing the reseller columns. Apply migration 20260826_PLATFORM_reseller_invoicing.sql first.' }, 400)
          : json({ error: error.message }, 500);
      }
    }
    if (body.set_remit !== undefined) {
      // The invoice remittance block: from address, billed-to, bank details,
      // payment terms, tax line. Owner-entered, never hardcoded in the repo.
      const r = body.set_remit;
      if (r !== null && (typeof r !== 'object' || Array.isArray(r))) return json({ error: 'set_remit must be an object or null' }, 400);
      const clean = r === null ? null : Object.fromEntries(
        Object.entries(r).filter(([k]) => ['from_block', 'billed_to_block', 'bank_block', 'terms_days', 'tax_line'].includes(k))
          .map(([k, v]) => [k, k === 'terms_days' ? (Number(v) || 0) : String(v ?? '').slice(0, 1200)]),
      );
      const { error } = await platformAdmin.from('platform_settings')
        .update({ reseller_invoice_remit: clean, updated_at: new Date().toISOString(), updated_by_user_id: caller.id ?? null })
        .eq('id', true);
      if (error) {
        return /does not exist|42703|PGRST204/i.test(String(error.message))
          ? json({ error: 'platform_settings is missing reseller_invoice_remit. Apply migration 20260826_PLATFORM_reseller_invoicing.sql first.' }, 400)
          : json({ error: error.message }, 500);
      }
    }
    const { data: st } = await platformAdmin.from('platform_settings').select('*').maybeSingle();
    return json({
      success: true,
      buy_percent: (st as any)?.adyen_reseller_buy_percent ?? 0.10,
      buy_fixed_minor: (st as any)?.adyen_reseller_buy_fixed_minor ?? 5,
      from_settings: (st as any)?.adyen_reseller_buy_percent != null,
      rate_history: (st as any)?.adyen_reseller_rate_history ?? [],
      remit: (st as any)?.reseller_invoice_remit ?? null,
    });
  }

  return json({ error: `unknown action: ${action}` }, 400);
});
