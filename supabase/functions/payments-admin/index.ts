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
//   revenue              { month } → per-location platform revenue for the admin
//                        Revenue section: processed volume + count by pricing
//                        tier, commission earned, SaaS fees from ops
//                        subscriptions, Adyen fees where settlement reports have
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
    const isMissingColumn = (msg: unknown) => /does not exist|42703/i.test(String(msg ?? ''));
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

  // ── revenue: the internal platform-revenue report (admin Revenue section) ──
  //    { month: 'YYYY-MM' } → per location: processed volume + count by pricing
  //    tier (adyen_payments.rate_category), commission earned
  //    (sum commission_minor), Adyen fees where settlement reports have filled
  //    fee_minor, and the SaaS fee from the ops subscriptions table
  //    (plan + monthly_fee — the only pricing that exists; if every plan is £0
  //    the response flags that SaaS pricing needs configuring rather than
  //    inventing numbers). Honest about costs: what Adyen charges US arrives
  //    per payment only via settlement-report ingestion (fee_minor), so margin
  //    is computed only where fee data exists.
  if (action === 'revenue') {
    const month = String(body.month ?? '');
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return json({ error: 'month must be YYYY-MM' }, 400);
    const isMissingColumn = (msg: unknown) => /does not exist|42703/i.test(String(msg ?? ''));
    const from = new Date(`${month}-01T00:00:00Z`);
    const to = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1));

    // Payments for the month, paged. Retry ladder drops the columns whose
    // migrations have not been hand-applied yet (20260821b, then 20260820).
    const BASE_COLS = 'location_id, amount_minor, amount_refunded_minor, success, last_event_code, currency';
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

    // SaaS: the ops subscriptions table is the only SaaS pricing that exists —
    // plan + monthly_fee per location.
    const { data: subs, error: subErr } = await opsAdmin.from('subscriptions')
      .select('location_id, org_id, plan, monthly_fee');
    if (subErr) return json({ error: `subscriptions read failed: ${subErr.message}` }, 500);
    const { data: opsLocs } = await opsAdmin.from('locations').select('id, name');
    const opsNameById = new Map<string, string>();
    for (const l of opsLocs ?? []) opsNameById.set(l.id, l.name);

    // Aggregate payments per platform location × tier.
    const isPayment = (r: any) => r.success === true && r.last_event_code !== 'CANCELLATION';
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
    // exists, listed standalone where it does not.
    const saasByPlatformLoc = new Map<string, { plan: string; monthly_fee: number }>();
    const saasUnmapped: any[] = [];
    const planCounts: Record<string, number> = {};
    let saasConfigured = false;
    for (const sub of subs ?? []) {
      const plan = String(sub.plan ?? 'free');
      planCounts[plan] = (planCounts[plan] ?? 0) + 1;
      const fee = Number(sub.monthly_fee) || 0;
      if (fee > 0) saasConfigured = true;
      const platformLoc = sub.location_id ? locByOps.get(sub.location_id) : null;
      if (platformLoc) saasByPlatformLoc.set(platformLoc.id, { plan, monthly_fee: fee });
      else saasUnmapped.push({ ops_location_id: sub.location_id, name: opsNameById.get(sub.location_id) ?? '(unknown venue)', plan, monthly_fee: fee });
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
      const saas_fee_minor = saas ? toPence(saas.monthly_fee) : null;
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
        saas_plan: saas?.plan ?? null,
        saas_fee_minor,
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
      saas: { plans: planCounts, amounts_configured: saasConfigured, unmapped: saasUnmapped },
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

  return json({ error: `unknown action: ${action}` }, 400);
});
