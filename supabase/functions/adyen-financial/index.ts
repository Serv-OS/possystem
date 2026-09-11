// supabase/functions/adyen-financial/index.ts
//
// Per-venue Adyen financial reporting reads (Financial services Phase 1).
// Serves the Back Office report screens:
//   payments  → summary tiles + a paged payment list from adyen_payments
//   disputes  → the venue's merchant_adyen_disputes rows (list only in Phase 1 —
//               accept/challenge wiring is a later phase)
//
// Both tables live in the PLATFORM DB with service-role-only RLS, so the client
// cannot read them directly — this fn is the fence. Auth model copied from
// payments-onboard: a signed-in Ops user with access to the location
// (user_locations), or super_admin.
//
// PHASE 2 (v5.6.99) adds the settlement side, fed by adyen-report-ingest:
//   payouts        → settlement batches for the venue (gross / fees / net),
//                    including this venue's SLICE of a batch shared with other
//                    venues on the same merchant account
//   payout_detail  → every line inside one payout, joined to the payments ledger
//   statement      → one month's totals for the printable Documents statement
// 11 Sep 2026: every fee these actions return is the VENUE's card rate fee
// (commission_minor), never the settlement report's Adyen cost columns. The
// payments, payout_detail and statement selects name only columns that are
// live (migrations 20260820, 20260821b and 20260907 are all applied), so the
// old retry ladders for missing columns are gone.
//
// PHASE 3 (v5.7.0) adds:
//   settings       → the venue's effective processing rate (venue override else
//                    platform default) + account status flags, for the read-only
//                    Settings tab. Display only — nothing charges from it yet.
//                    v5.7.3 (settings v2): returns the full resolved TIERED rate
//                    card (card_present / card_not_present / amex / keyed, each
//                    venue → platform default → legacy flat → null) alongside
//                    the old flat `rates` shape, which now carries the resolved
//                    card_present tier so a stale client still shows a true
//                    number. `payments` v2 adds rate_category per row plus an
//                    optional rate_category filter for the payment-type chip
//                    and filter in the venue Payments tab.
//
// PHASE 4 (v5.7.1) adds the venue-facing side of payout onboarding:
//   balances          → live Total/Pending/Available from the venue's Adyen
//                       balance account (bcl v2), with the onboarding state
//                       machine the Overview tab renders: not_started |
//                       in_progress | awaiting_enablement | ready. A 401/403
//                       from Adyen is the EXPECTED pre-enablement state and is
//                       surfaced as awaiting_enablement, never a raw error.
//   payout_setup_link → mints a fresh hosted onboarding link for THIS venue's
//                       legal entity (links are single-use and expire in 4
//                       minutes, so storing one is pointless — the venue's
//                       "Complete your payout setup" button mints on click).
//                       Safe for the venue fence: it can only create a KYC page
//                       for the venue's own legal entity.
//
// ⚠ DEPLOY ME (edge functions deploy manually and drift silently):
//   npx supabase functions deploy adyen-financial --project-ref tbetcegmszzotrwdtqhi --no-verify-jwt

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
// VENUE FEES (11 Sep 2026, owner report "the fees are not pulling through").
// Every venue facing number here is the VENUE's: its card rate fee, stamped
// on each payment at authorisation as adyen_payments.commission_minor and
// reduced by the refund ratio (_shared/venueFees.ts). adyen_payments.fee_minor,
// fee_breakdown and the settlement report fee and net columns are ADYEN'S COST
// to the platform and are NEVER returned from any action in this fn. Test and
// live rows are never mixed: a live venue sees live rows (test rows only when
// asked, payments tab), a test venue sees rows whose live is not true. Times
// are the venue's: `timezone` in the answers is platform locations.timezone.
import { lemBase, balancePlatformBase, RATE_TIERS, resolveAdyenRateCard, adyenConfig, adyenEnvForLocation, adyenNotConfiguredMessage } from '../_shared/adyen.ts';
import {
  hasSuccessfulCapture, isUncapturedPayment, isCountedPayment, venueFeeFor, venueReceivesFor, summarizeVenueFees,
  venuePayoutLine, summarizeVenuePayout, venueTimeZoneFor, venueCurrentMonth, venueMonthBoundsIso,
} from '../_shared/venueFees.ts';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const opsAdmin = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '', { auth: { autoRefreshToken: false, persistSession: false } });
const platformAdmin = createClient(Deno.env.get('PLATFORM_SUPABASE_URL') ?? '', Deno.env.get('PLATFORM_SUPABASE_SERVICE_ROLE_KEY') ?? '', { auth: { autoRefreshToken: false, persistSession: false } });

// Summary sums are computed in-function (PostgREST aggregates are not enabled
// on the project). Hosted PostgREST returns at most 1000 rows per request, so
// every read that sums rows PAGES in 1000s with a secondary order on
// psp_reference (created_at ties would skip or repeat rows at a page edge),
// the same pager payments-admin uses. `.limit(5000)` silently stopped at 1000.
const PAGE_ROWS = 1000;
// The Payments tiles cover at most this many recent payments. Past it the
// answer says so (summary.capped), from a real read past the ceiling.
const SUMMARY_CAP = 20000;
// A statement is the venue's fee document and never truncates: past this it
// fails loudly.
const STATEMENT_CEILING = 100000;

// Read every row of a query in pages, up to `ceiling` rows. `build` returns a
// FRESH ordered query each call. capped is true only when a row exists past
// the ceiling.
// deno-lint-ignore no-explicit-any
async function readPaged(build: () => any, ceiling: number): Promise<{ rows: Record<string, unknown>[]; capped: boolean; error: string | null }> {
  const rows: Record<string, unknown>[] = [];
  for (let from = 0; from < ceiling; from += PAGE_ROWS) {
    const to = Math.min(from + PAGE_ROWS, ceiling) - 1;
    const { data, error } = await build().range(from, to);
    if (error) return { rows, capped: false, error: error.message };
    const batch = (data ?? []) as Record<string, unknown>[];
    rows.push(...batch);
    if (batch.length < to - from + 1) return { rows, capped: false, error: null };
  }
  const { data: more, error: moreErr } = await build().range(ceiling, ceiling);
  if (moreErr) return { rows, capped: false, error: moreErr.message };
  return { rows, capped: (more ?? []).length > 0, error: null };
}

// Postgres 42703 (column does not exist) — the fee columns until migration
// 20260820_adyen_fees.sql is hand-applied. Selects retry without them.
const isMissingColumn = (msg: unknown) => /does not exist|42703/i.test(String(msg ?? ''));

// ── Phase 4: minimal Adyen REST for the two venue-facing calls ──────────────
// Key fallbacks match adyen-onboard: dedicated LEM/BP keys when the live setup
// splits roles across ws users, else the main key (test setup).
// Keys and hosts come from the VENUE'S config (7 Sep 2026, per venue
// environment): cfg.lemKey / cfg.bpKey fall back to that set's API key.
async function adyenCall(key: string, method: string, url: string, body?: unknown): Promise<{ ok: boolean; status: number; data: any }> {
  const res = await fetch(url, {
    method,
    headers: { 'X-API-Key': key, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data: any = null;
  try { const t = await res.text(); data = t ? JSON.parse(t) : null; } catch { data = null; }
  return { ok: res.ok, status: res.status, data };
}
// 401/403 pre-enablement is the EXPECTED state — a waiting room, not a bug.
const isAwaitingEnablement = (status: number) => status === 401 || status === 403;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  // ── Auth: signed-in Ops user WITH access to this location (payments-onboard fence)
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return json({ error: 'Unauthorized' }, 401);
  const { data: { user: caller } } = await opsAdmin.auth.getUser(authHeader.replace('Bearer ', ''));
  if (!caller) return json({ error: 'Invalid token' }, 401);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }
  const action = body?.action as string;
  const opsLocationId = body?.ops_location_id as string;
  if (!action) return json({ error: 'action required' }, 400);
  if (!opsLocationId) return json({ error: 'ops_location_id required' }, 400);

  const [{ data: ul }, { data: prof }] = await Promise.all([
    opsAdmin.from('user_locations').select('location_id').eq('user_id', caller.id).eq('location_id', opsLocationId).maybeSingle(),
    opsAdmin.from('user_profiles').select('role').eq('id', caller.id).maybeSingle(),
  ]);
  if (!ul && prof?.role !== 'super_admin') return json({ error: 'No access to this location' }, 403);

  // Ops location → Platform location (the ledger keys on the platform id).
  const { data: loc, error: locErr } = await platformAdmin.from('locations')
    .select('id, name, timezone, currency').eq('ops_location_id', opsLocationId).maybeSingle();
  if (locErr) return json({ error: `location lookup failed: ${locErr.message}` }, 500);
  if (!loc) return json({ error: 'location not found in platform DB' }, 404);

  // The venue's Adyen environment AND region pick the secret set (the LEM and
  // BCL keys of that region's live set; the hosts are the same for UK and US)
  // for the two Adyen calls below (balances, payout setup link). The
  // environment also fences the read actions: test and live rows never mix.
  let cfg;
  let venueEnv: 'live' | 'test' = 'test';
  try {
    const target = await adyenEnvForLocation(platformAdmin, loc.id);   // { env, region }
    venueEnv = target.env === 'live' ? 'live' : 'test';
    cfg = adyenConfig(target);
  } catch (e) { return json({ error: (e as Error).message }, 500); }

  // Business time is the venue's clock, never the viewer's device.
  const venueTz = venueTimeZoneFor(loc);

  // isVisiblePayment (_shared/venueFees.ts) done in the query: a live venue
  // sees live = true (every row when includeTest); a test venue sees rows whose
  // live is not true (false, or null from before 7 Sep 2026).
  // deno-lint-ignore no-explicit-any
  const applyLiveFilter = (q: any, includeTest: boolean) =>
    venueEnv === 'live' ? (includeTest ? q : q.eq('live', true)) : q.not('live', 'is', true);

  // Payouts carry the same fence, shaped for adyen_payouts.live, which is null
  // when the source did not say. A live venue keeps true and null, so a real
  // live bank transfer is never hidden; a test venue keeps rows not true.
  // deno-lint-ignore no-explicit-any
  const applyPayoutLiveFilter = (q: any) =>
    venueEnv === 'live' ? q.not('live', 'is', false) : q.not('live', 'is', true);
  // deno-lint-ignore no-explicit-any
  const payoutVisible = (p: any) => (venueEnv === 'live' ? p?.live !== false : p?.live !== true);

  // What isCountedPayment and venueFeeFor need from a payment row (the capture
  // rule of payments-admin, and a hold's captured amount) plus when it was
  // taken. NEVER fee_minor or fee_breakdown (Adyen's cost).
  const CAPTURE_COLS = 'authorised_at, capture_required, captured_at, applied_mods:raw->applied_modifications, captured_minor:raw->captured_minor, last_mod_code:raw->last_modification->>eventCode, last_mod_ok:raw->last_modification->>success, last_mod_amount:raw->last_modification->amount->>value';
  // When a payment was taken: authorised_at (the payment's own time; a late
  // or replayed webhook mints created_at at arrival), else created_at.
  // deno-lint-ignore no-explicit-any
  const takenAt = (r: any) => r?.authorised_at ?? r?.created_at ?? null;
  // The payments-admin month rule as a PostgREST or() filter: authorised_at in
  // the window, or no authorised_at and created_at in the window. At least one
  // bound must be given.
  const takenWindowOr = (fromIso: string | null, toIso: string | null, upperOp: 'lt' | 'lte') => {
    const on = (col: string) => [
      fromIso ? `${col}.gte.${fromIso}` : null,
      toIso ? `${col}.${upperOp}.${toIso}` : null,
    ].filter(Boolean) as string[];
    const auth = on('authorised_at');
    const authPart = auth.length === 1 ? auth[0] : `and(${auth.join(',')})`;
    return `${authPart},and(authorised_at.is.null,${on('created_at').join(',')})`;
  };

  // ── payments: summary tiles + paged list ─────────────────────────────────
  if (action === 'payments') {
    const page = Math.max(0, Math.floor(Number(body.page) || 0));
    const pageSize = Math.min(200, Math.max(1, Math.floor(Number(body.page_size) || 50)));
    const isoOrNull = (v: unknown) => {
      if (!v) return null;
      const d = new Date(String(v));
      return isNaN(d.getTime()) ? null : d.toISOString();
    };
    const fromIso = isoOrNull(body.from);
    const toIso = isoOrNull(body.to);

    // Optional payment-type filter (v5.7.3): one of the four pricing tiers.
    // Applied to the tiles AND the list so both tell the same story.
    const typeFilter = (RATE_TIERS as readonly string[]).includes(String(body.rate_category ?? ''))
      ? String(body.rate_category) : null;
    // Test rows on a live venue only when the viewer turns the switch on.
    const includeTest = venueEnv === 'live' && body.include_test === true;

    // One filter set for the tiles, the list and the hidden test count, so all
    // three tell the same story. `live` decides test vs live separately.
    // deno-lint-ignore no-explicit-any
    const scoped = (q: any) => {
      q = q.eq('location_id', loc.id);
      // The window is on when the payment was taken (authorised_at, else
      // created_at), the same rule as the statement and payments-admin.
      if (fromIso || toIso) q = q.or(takenWindowOr(fromIso, toIso, 'lte'));
      if (typeFilter) q = q.eq('rate_category', typeFilter);
      return q;
    };

    // Summary. commission_minor is the venue fee stamped at authorisation;
    // fee_minor (Adyen's cost) is deliberately NOT read. Paged, so the tiles
    // are never silently the newest 1000 payments.
    const SUM_COLS = `psp_reference, amount_minor, amount_refunded_minor, success, last_event_code, currency, commission_minor, ${CAPTURE_COLS}`;
    const sumRead = await readPaged(() => applyLiveFilter(
      scoped(platformAdmin.from('adyen_payments').select(SUM_COLS)), includeTest,
    ).order('created_at', { ascending: false }).order('psp_reference', { ascending: true }), SUMMARY_CAP);
    if (sumRead.error) return json({ error: `summary read failed: ${sumRead.error}` }, 500);

    // ONE rule with the statement and the payouts (summarizeVenueFees): a
    // "payment" for the tiles is successful, not cancelled and captured.
    // Declines, cancellations and uncaptured holds stay visible in the list.
    const rowsForSum = sumRead.rows;
    const venue = summarizeVenueFees(rowsForSum);
    const summary = {
      count: venue.count,
      sum_minor: venue.gross_minor,
      // Refunds on counted payments only.
      refunds_minor: venue.refunds_minor,
      // What the venue paid on its card rates, reduced by any refunds.
      fees_minor: venue.fees_minor,
      // Amount less refunds less the venue fee. null while any counted
      // payment has no fee on record (its fee is not known yet).
      receives_minor: venue.receives_minor,
      // Counted payments with no fee on record, and their amount.
      fees_unrated: venue.fees_unrated,
      unrated_gross_minor: venue.unrated_gross_minor,
      // Successful authorisations whose money never moved.
      not_captured: venue.not_captured,
      // Kept for a client deployed before 11 Sep 2026 (its tooltip reads it).
      fee_known: venue.fees_rated,
      currency: (rowsForSum.find((r) => r.currency)?.currency as string | undefined) ?? 'GBP',
      capped: sumRead.capped,
      cap: SUMMARY_CAP,
    };

    // Hidden test payments on a live venue, for the "Show test payments (N)"
    // switch. Counted whether the switch is on or off, so it never disappears.
    let testCount = 0;
    if (venueEnv === 'live') {
      const { count: tc, error: tcErr } = await scoped(
        platformAdmin.from('adyen_payments').select('psp_reference', { count: 'exact', head: true }),
      ).not('live', 'is', true);
      if (tcErr) return json({ error: `test payment count failed: ${tcErr.message}` }, 500);
      testCount = tc ?? 0;
    }

    const LIST_COLS = `psp_reference, merchant_reference, channel, last_event_code, success, amount_minor, currency, amount_refunded_minor, card, matched_closed_check, created_at, rate_category, commission_minor, live, ${CAPTURE_COLS}`;
    const { data: listRows, error: listErr, count } = await applyLiveFilter(
      scoped(platformAdmin.from('adyen_payments').select(LIST_COLS, { count: 'exact' })), includeTest,
    ).order('created_at', { ascending: false }).order('psp_reference', { ascending: true })
      .range(page * pageSize, page * pageSize + pageSize - 1);
    if (listErr) return json({ error: `payments read failed: ${listErr.message}` }, 500);

    // Whitelisted row shape: fee_minor IS the venue fee here, never Adyen cost.
    // taken_at is when the card was taken, on which the screen and CSV show.
    const payments = ((listRows ?? []) as Record<string, unknown>[]).map((r) => ({
      psp_reference: r.psp_reference,
      merchant_reference: r.merchant_reference,
      channel: r.channel,
      last_event_code: r.last_event_code,
      success: r.success,
      amount_minor: r.amount_minor,
      amount_refunded_minor: r.amount_refunded_minor,
      currency: r.currency,
      card: r.card,
      matched_closed_check: r.matched_closed_check,
      created_at: r.created_at,
      authorised_at: r.authorised_at ?? null,
      taken_at: takenAt(r),
      rate_category: r.rate_category ?? null,
      live: r.live === true,
      // Money never moved (failed capture, or a hold never captured).
      not_captured: isUncapturedPayment(r),
      // A capture succeeded, so a stale CAPTURE_FAILED code is not the story.
      captured: hasSuccessfulCapture(r) || !!r.captured_at,
      counted: isCountedPayment(r),
      fee_minor: venueFeeFor(r),
      receives_minor: venueReceivesFor(r),
    }));

    return json({
      ok: true, summary, payments, page, page_size: pageSize, total: count ?? 0,
      typed: true,
      rate_category: typeFilter,
      environment: venueEnv,
      timezone: venueTz,
      test_count: testCount,
      include_test: includeTest,
    });
  }

  // ── disputes: list (Phase 1 — read-only) ─────────────────────────────────
  if (action === 'disputes') {
    const { data: disputes, error: dErr } = await platformAdmin.from('merchant_adyen_disputes')
      .select('dispute_psp_reference, payment_psp_reference, status, reason_code, reason, amount_minor, currency, respond_by, outcome, created_at, updated_at')
      .eq('location_id', loc.id)
      .order('created_at', { ascending: false })
      .limit(200);
    if (dErr) return json({ error: `disputes read failed: ${dErr.message}` }, 500);
    return json({ ok: true, disputes: disputes ?? [] });
  }

  // ── Shared by payouts and payout_detail ──────────────────────────────────
  // This venue's payments for a set of PSP references (location fence), with
  // only what a venue may see plus what venueFeeFor needs. NEVER fee_minor or
  // fee_breakdown.
  const PAY_JOIN_COLS = `psp_reference, merchant_reference, card, channel, created_at, amount_minor, amount_refunded_minor, success, last_event_code, commission_minor, ${CAPTURE_COLS}`;
  // deno-lint-ignore no-explicit-any
  const venuePaymentsByPsp = async (psps: unknown[]): Promise<{ map: Map<string, any>; error: string | null }> => {
    const unique = [...new Set(psps.filter(Boolean).map(String))];
    // deno-lint-ignore no-explicit-any
    const map = new Map<string, any>();
    for (let i = 0; i < unique.length; i += 200) {
      const { data, error } = await platformAdmin.from('adyen_payments')
        .select(PAY_JOIN_COLS).eq('location_id', loc.id).in('psp_reference', unique.slice(i, i + 200));
      if (error) return { map, error: error.message };
      for (const r of data ?? []) map.set(String(r.psp_reference), r);
    }
    return { map, error: null };
  };
  // Two kinds of adyen_payouts row. A settlement batch (adyen-report-ingest,
  // reference settlement:<merchant>:<batch>) carries the merchant level
  // report's gross, fees and net: Adyen's figures, never shown. A bank transfer
  // (adyen-bp-webhook, reference = transfer id) is money paid from the venue's
  // own balance to its bank: that amount IS the venue's.
  // deno-lint-ignore no-explicit-any
  const isSettlementBatch = (p: any) => !!p?.report_name || !!p?.merchant_account || String(p?.reference ?? '').startsWith('settlement:');

  // ── payouts: settlement batches and bank transfers for this venue ────────
  // A batch whose lines all resolve to one venue carries that venue's
  // location_id. A batch shared across venues on the same merchant account has
  // location_id null; the venue sees only its own lines, flagged shared: true.
  // Batch figures are the venue's: gross of its payment lines, its card rate
  // fees (payments matched by PSP reference) and what it receives.
  if (action === 'payouts') {
    // Test and live payouts never mix (applyPayoutLiveFilter).
    const { data: own, error: ownErr } = await applyPayoutLiveFilter(platformAdmin.from('adyen_payouts')
      .select('*').eq('location_id', loc.id))
      .order('payout_date', { ascending: false }).limit(100);
    if (ownErr) return json({ error: `payouts read failed: ${ownErr.message}` }, 500);

    // Lines: per-line location_id (shared batches) plus every line of a batch
    // the venue owns outright.
    const LINE_COLS = 'id, payout_id, psp_reference, line_type, gross_minor';
    // deno-lint-ignore no-explicit-any
    const lineById = new Map<string, any>();
    const { data: venueLines, error: vlErr } = await platformAdmin.from('adyen_payout_lines')
      .select(LINE_COLS).eq('location_id', loc.id).limit(5000);
    if (vlErr && !isMissingColumn(vlErr.message)) return json({ error: `payout lines read failed: ${vlErr.message}` }, 500);
    for (const l of venueLines ?? []) lineById.set(String(l.id), l);
    // deno-lint-ignore no-explicit-any
    const ownBatchIds = (own ?? []).filter(isSettlementBatch).map((p: any) => p.id);
    for (let i = 0; i < ownBatchIds.length; i += 50) {
      const { data, error } = await platformAdmin.from('adyen_payout_lines')
        .select(LINE_COLS).in('payout_id', ownBatchIds.slice(i, i + 50)).limit(5000);
      if (error) return json({ error: `payout lines read failed: ${error.message}` }, 500);
      for (const l of data ?? []) lineById.set(String(l.id), l);
    }
    const lines = [...lineById.values()];
    const { map: pays, error: joinErr } = await venuePaymentsByPsp(lines.map((l) => l.psp_reference));
    if (joinErr) return json({ error: `payments join failed: ${joinErr}` }, 500);

    // Venue figures per payout; cost and account lines drop out (null).
    // deno-lint-ignore no-explicit-any
    const figuresByPayout = new Map<string, any[]>();
    for (const l of lines) {
      if (!l.payout_id) continue;
      const f = venuePayoutLine(l, l.psp_reference ? (pays.get(String(l.psp_reference)) ?? null) : null);
      if (!f) continue;
      const arr = figuresByPayout.get(l.payout_id) ?? [];
      arr.push(f);
      figuresByPayout.set(l.payout_id, arr);
    }

    // deno-lint-ignore no-explicit-any
    const ownIds = new Set((own ?? []).map((p: any) => p.id));
    // deno-lint-ignore no-explicit-any
    const sharedIds = [...new Set((venueLines ?? []).map((l: any) => l.payout_id).filter((id: unknown) => id && !ownIds.has(id)))] as string[];
    // deno-lint-ignore no-explicit-any
    let shared: any[] = [];
    if (sharedIds.length) {
      const { data, error } = await applyPayoutLiveFilter(platformAdmin.from('adyen_payouts')
        .select('*').in('id', sharedIds.slice(0, 100)));
      if (error) return json({ error: `shared payouts read failed: ${error.message}` }, 500);
      shared = data ?? [];
    }
    // deno-lint-ignore no-explicit-any
    const shape = (p: any, isShared: boolean) => {
      const base = {
        id: p.id,
        payout_date: p.payout_date,
        batch_number: p.batch_number ?? null,
        reference: p.reference,
        status: p.status ?? null,
        currency: p.currency ?? 'GBP',
        destination_last4: p.destination_last4 ?? null,
        shared: isShared,
      };
      if (!isSettlementBatch(p)) {
        return { ...base, kind: 'bank_transfer', gross_minor: null, fees_minor: null, receives_minor: p.amount_minor ?? null, fees_unrated: 0, line_count: null };
      }
      const t = summarizeVenuePayout(figuresByPayout.get(p.id) ?? []);
      return { ...base, kind: 'settlement', gross_minor: t.gross_minor, fees_minor: t.fees_minor, receives_minor: t.receives_minor, fees_unrated: t.fees_unrated, line_count: t.line_count };
    };
    // deno-lint-ignore no-explicit-any
    const payouts = [...(own ?? []).map((p: any) => shape(p, false)), ...shared.map((p: any) => shape(p, true))]
      .sort((a, b) => String(b.payout_date ?? '').localeCompare(String(a.payout_date ?? '')));
    return json({ ok: true, payouts, timezone: venueTz, environment: venueEnv });
  }

  // ── payout_detail: every payment line inside one payout ──────────────────
  if (action === 'payout_detail') {
    const payoutId = String(body.payout_id ?? '');
    if (!payoutId) return json({ error: 'payout_id required' }, 400);
    const { data: payout, error: pErr } = await platformAdmin.from('adyen_payouts')
      .select('*').eq('id', payoutId).maybeSingle();
    if (pErr) return json({ error: `payout read failed: ${pErr.message}` }, 500);
    if (!payout) return json({ error: 'payout not found' }, 404);
    // The same test and live fence as the payouts list.
    if (!payoutVisible(payout)) return json({ error: 'payout not found for this venue' }, 404);

    // fee_minor and net_minor (Adyen's cost and net) are deliberately NOT read.
    const { data: allLines, error: lErr } = await platformAdmin.from('adyen_payout_lines')
      .select('id, payout_id, psp_reference, line_type, gross_minor, gratuity_minor, currency, location_id')
      .eq('payout_id', payoutId).order('id', { ascending: true }).limit(2000);
    if (lErr) return json({ error: `payout lines read failed: ${lErr.message}` }, 500);

    // Venue fence: own the payout, or hold lines inside it. A shared batch
    // shows ONLY this venue's lines (no leaking another venue's transactions).
    const isOwner = payout.location_id === loc.id;
    // deno-lint-ignore no-explicit-any
    const hasLines = (allLines ?? []).some((l: any) => l.location_id === loc.id);
    if (!isOwner && !hasLines) return json({ error: 'payout not found for this venue' }, 404);
    // deno-lint-ignore no-explicit-any
    const lines = isOwner ? (allLines ?? []) : (allLines ?? []).filter((l: any) => l.location_id === loc.id);

    // Join to this venue's payments for card, reference, timing and its fee.
    // deno-lint-ignore no-explicit-any
    const { map: pays, error: joinErr } = await venuePaymentsByPsp(lines.map((l: any) => l.psp_reference));
    if (joinErr) return json({ error: `payments join failed: ${joinErr}` }, 500);

    const figures = [];
    const shapedLines = [];
    for (const l of lines) {
      const pay = l.psp_reference ? (pays.get(String(l.psp_reference)) ?? null) : null;
      const f = venuePayoutLine(l, pay);
      if (!f) continue;   // Adyen cost or account level line: never shown to a venue
      figures.push(f);
      shapedLines.push({
        id: l.id, psp_reference: l.psp_reference, line_type: l.line_type,
        gross_minor: f.gross_minor, fee_minor: f.fee_minor, receives_minor: f.receives_minor,
        gratuity_minor: l.gratuity_minor ?? null, currency: l.currency ?? payout.currency ?? 'GBP',
        payment: pay ? {
          psp_reference: pay.psp_reference, merchant_reference: pay.merchant_reference, card: pay.card, channel: pay.channel,
          created_at: pay.created_at, authorised_at: pay.authorised_at ?? null, taken_at: takenAt(pay),
        } : null,
      });
    }
    const bank = !isSettlementBatch(payout);
    const t = summarizeVenuePayout(figures);

    return json({
      ok: true,
      timezone: venueTz,
      environment: venueEnv,
      payout: {
        id: payout.id, payout_date: payout.payout_date, batch_number: payout.batch_number ?? null,
        reference: payout.reference, status: payout.status ?? null,
        currency: payout.currency ?? 'GBP', destination_last4: payout.destination_last4 ?? null,
        shared: !isOwner,
        kind: bank ? 'bank_transfer' : 'settlement',
        gross_minor: bank ? null : t.gross_minor,
        fees_minor: bank ? null : t.fees_minor,
        receives_minor: bank ? (payout.amount_minor ?? null) : t.receives_minor,
        fees_unrated: bank ? 0 : t.fees_unrated,
      },
      lines: shapedLines,
    });
  }

  // ── statement: one month's totals for the printable Documents page ───────
  // The month runs on the VENUE clock (venue midnight on the 1st to venue
  // midnight on the 1st of the next month), and fees belong to the month the
  // payment was taken. Fees are the venue's card rate fees (commission_minor,
  // reduced by the refund ratio), known at authorisation, so a statement never
  // waits for a settlement report. Same live fence as payments.
  if (action === 'statement') {
    // No month asked for: the venue's current month on the venue clock, so a
    // New York venue at 21:30 on 30 Sep opens September, not October.
    const currentMonth = venueCurrentMonth(venueTz);
    const month = String(body.month ?? '') || currentMonth;
    const bounds = venueMonthBoundsIso(month, venueTz);
    if (!bounds) return json({ error: 'month must be YYYY-MM', current_month: currentMonth }, 400);
    const includeTest = venueEnv === 'live' && body.include_test === true;
    // fee_minor (Adyen's cost) is deliberately NOT read.
    const COLS = `psp_reference, amount_minor, amount_refunded_minor, success, last_event_code, currency, commission_minor, gratuity_minor, created_at, ${CAPTURE_COLS}`;
    // The month a payment belongs to is when it was taken (authorised_at,
    // else created_at), the same bucket as the FranPOS invoice. Paged: a
    // statement never silently stops at 1000 payments.
    const read = await readPaged(() => applyLiveFilter(
      platformAdmin.from('adyen_payments').select(COLS)
        .eq('location_id', loc.id)
        .or(takenWindowOr(bounds.fromIso, bounds.toIso, 'lt')),
      includeTest,
    ).order('created_at', { ascending: false }).order('psp_reference', { ascending: true }), STATEMENT_CEILING);
    if (read.error) return json({ error: `statement read failed: ${read.error}` }, 500);
    if (read.capped) {
      return json({ error: 'This month has too many card payments to build a statement here. Contact ServOS support.' }, 500);
    }

    // ONE rule with the Payments tiles and the payouts (summarizeVenueFees):
    // counted payments only, refunds on counted payments only, and no You
    // receive while any counted payment has no fee on record.
    const rows = read.rows;
    const venue = summarizeVenueFees(rows);
    const gratuity = rows.filter(isCountedPayment).reduce((s, r) => s + (Number(r.gratuity_minor) || 0), 0);
    const rated = venue.fees_rated > 0;
    return json({
      ok: true,
      venue: loc.name,
      month,
      current_month: currentMonth,
      timezone: venueTz,
      environment: venueEnv,
      month_bounds: bounds,
      currency: (rows.find((r) => r.currency)?.currency as string | undefined) ?? 'GBP',
      payments_count: venue.count,
      gross_minor: venue.gross_minor,
      refunds_minor: venue.refunds_minor,
      fees_minor: rated ? venue.fees_minor : null,
      gratuity_minor: gratuity || null,
      net_minor: rated && venue.fees_unrated === 0 ? venue.receives_minor : null,
      unrated_gross_minor: venue.unrated_gross_minor,
      not_captured: venue.not_captured,
      has_payments: venue.count > 0,
      has_fee_data: rated,
      fee_coverage: { with_fees: venue.fees_rated, payments: venue.count },
      capped: false,
    });
  }

  // ── settings v2: the venue's resolved TIERED rate card + account flags ───
  // Feeds the read-only Settings tab in Back Office → Card payments. Four
  // tiers (v5.7.3): card_present (credit & debit in person), card_not_present
  // (online orders), amex (American Express & business cards), keyed
  // (manually keyed). Resolution per tier — venue rate_card → platform
  // default rate_card → the legacy flat markup as the card_present tier only
  // → null (resolveAdyenRateCard, shared). Venue-facing, so this returns ONLY
  // the effective numbers (never cost/margin internals) plus account status
  // flags. The old flat `rates` shape stays and now carries the resolved
  // card_present tier, so a client deployed before this version still shows a
  // true number. All tiers null = the client's existing honest empty state.
  if (action === 'settings') {
    const ACCT_COLS = 'markup_percent, markup_fixed_pence, receive_payments_ok, payouts_ok, balance_account_id';
    const PS_COLS = 'default_adyen_markup_percent, default_adyen_markup_fixed_pence';
    let [{ data: acct, error: aErr }, { data: ps, error: pErr }] = await Promise.all([
      platformAdmin.from('merchant_adyen_accounts')
        .select(`${ACCT_COLS}, rate_card`).eq('location_id', loc.id).maybeSingle(),
      platformAdmin.from('platform_settings')
        .select(`${PS_COLS}, default_adyen_rate_card`).eq('id', true).maybeSingle(),
    ]);
    // Migration 20260821b not applied yet → fall back to the flat columns.
    if (aErr && isMissingColumn(aErr.message)) {
      ({ data: acct, error: aErr } = await platformAdmin.from('merchant_adyen_accounts')
        .select(ACCT_COLS).eq('location_id', loc.id).maybeSingle());
    }
    if (pErr && isMissingColumn(pErr.message)) {
      ({ data: ps, error: pErr } = await platformAdmin.from('platform_settings')
        .select(PS_COLS).eq('id', true).maybeSingle());
    }
    if (aErr) return json({ error: `account read failed: ${aErr.message}` }, 500);
    if (pErr) return json({ error: `settings read failed: ${pErr.message}` }, 500);

    const resolved = resolveAdyenRateCard(
      { rate_card: (acct as Record<string, unknown> | null)?.rate_card ?? null, markup_percent: acct?.markup_percent, markup_fixed_pence: acct?.markup_fixed_pence },
      { default_adyen_rate_card: (ps as Record<string, unknown> | null)?.default_adyen_rate_card ?? null, default_adyen_markup_percent: ps?.default_adyen_markup_percent, default_adyen_markup_fixed_pence: ps?.default_adyen_markup_fixed_pence },
    );
    // Venue-facing source collapses to venue/platform — the legacy flat rate
    // IS the venue's (or platform's) agreed rate, just recorded pre-tiers.
    const srcOut = (src: string | null) =>
      src === 'venue' || src === 'legacy_venue' ? 'venue'
      : src === 'platform' || src === 'legacy_platform' ? 'platform' : null;
    const rate_card: Record<string, unknown> = {};
    for (const tier of RATE_TIERS) {
      const t = resolved[tier];
      rate_card[tier] = (t.percent == null && t.fixed_pence == null)
        ? null
        : { percent: t.percent, fixed_pence: t.fixed_pence, source: srcOut(t.source) };
    }
    const cp = resolved.card_present;
    return json({
      ok: true,
      venue: loc.name,
      rate_card,
      rates: {
        percent: cp.percent,
        fixed_pence: cp.fixed_pence,
        source: srcOut(cp.source),
      },
      account: {
        exists: !!acct,
        receive_payments_ok: !!acct?.receive_payments_ok,
        payouts_ok: !!acct?.payouts_ok,
        has_balance_account: !!acct?.balance_account_id,
      },
    });
  }

  // ── balances: live balance tiles + the payout-onboarding state machine ───
  // Phase 4 (v5.7.1): feeds the Overview tab in Back Office → Card payments.
  // States:
  //   not_started         → no per-venue payout account exists yet (honest
  //                          "coming" card stays up)
  //   in_progress         → accounts exist but the balance account does not
  //                          yet / the venue still has KYC or bank to finish
  //   awaiting_enablement → the balance platform is not switched on for this
  //                          account yet (Adyen 401/403 — expected today)
  //   ready               → balance account answers; balances are returned
  if (action === 'balances') {
    const { data: acct, error: aErr } = await platformAdmin.from('merchant_adyen_accounts')
      .select('legal_entity_id, account_holder_id, balance_account_id, transfer_instrument_id, receive_payments_ok, payouts_ok, verification_status')
      .eq('location_id', loc.id).maybeSingle();
    if (aErr) return json({ error: `account read failed: ${aErr.message}` }, 500);

    const base = {
      ok: true,
      venue: loc.name,
      payouts_ok: !!acct?.payouts_ok,
      has_bank: !!acct?.transfer_instrument_id,
      // The venue can complete KYC/bank whenever a legal entity exists and
      // payouts are not fully allowed yet.
      can_complete_setup: !!acct?.legal_entity_id && !acct?.payouts_ok,
    };

    if (!acct || (!acct.legal_entity_id && !acct.balance_account_id)) {
      return json({ ...base, state: 'not_started', balances: null });
    }
    if (!acct.balance_account_id) {
      return json({ ...base, state: 'in_progress', balances: null });
    }
    if (cfg.live && !cfg.configured) return json({ ...base, state: 'in_progress', balances: null, detail: adyenNotConfiguredMessage(cfg) });
    const r = await adyenCall(cfg.bpKey, 'GET', `${balancePlatformBase(cfg)}/balanceAccounts/${encodeURIComponent(acct.balance_account_id)}`);
    if (r.ok) {
      const balances = (Array.isArray(r.data?.balances) ? r.data.balances : []).map((b: any) => ({
        currency: b?.currency ?? 'GBP',
        available_minor: Number(b?.available ?? 0),
        total_minor: Number(b?.balance ?? 0),
        pending_minor: Number(b?.pending ?? 0),
        reserved_minor: Number(b?.reserved ?? 0),
      }));
      return json({ ...base, state: 'ready', balances });
    }
    if (isAwaitingEnablement(r.status)) {
      return json({ ...base, state: 'awaiting_enablement', balances: null });
    }
    // A real error reads as in_progress to the venue (never a raw Adyen error
    // on an operator screen); the detail is in the response for diagnostics.
    console.error('[adyen-financial] balances read failed:', r.status, JSON.stringify(r.data ?? {}).slice(0, 300));
    return json({ ...base, state: 'in_progress', balances: null, detail: `balance read failed (${r.status})` });
  }

  // ── payout_setup_link: fresh hosted onboarding link for THIS venue ───────
  // Links are single-use and expire in 4 minutes, so they are minted on click,
  // never served from storage. The venue fence above already proved the caller
  // belongs to this location; the link can only open the venue's own KYC page.
  if (action === 'payout_setup_link') {
    const { data: acct, error: aErr } = await platformAdmin.from('merchant_adyen_accounts')
      .select('legal_entity_id').eq('location_id', loc.id).maybeSingle();
    if (aErr) return json({ error: `account read failed: ${aErr.message}` }, 500);
    if (!acct?.legal_entity_id) {
      return json({ error: 'Payout setup has not been started for this venue yet. ServOS starts it from the admin side.' }, 400);
    }
    if (cfg.live && !cfg.configured) return json({ error: adyenNotConfiguredMessage(cfg) }, 503);
    // The caller's return_url wins; the default is the live app host.
    const payload: Record<string, unknown> = { redirectUrl: String(body.return_url || 'https://app.serv-os.app/') };
    const r = await adyenCall(cfg.lemKey, 'POST', `${lemBase(cfg)}/legalEntities/${encodeURIComponent(acct.legal_entity_id)}/onboardingLinks`, payload);
    if (!r.ok || !r.data?.url) {
      if (isAwaitingEnablement(r.status)) {
        return json({ error: 'Payout setup is awaiting enablement from the payment partner. Nothing is needed from you yet.' }, 503);
      }
      console.error('[adyen-financial] payout_setup_link failed:', r.status, JSON.stringify(r.data ?? {}).slice(0, 300));
      return json({ error: 'We could not open the setup page right now. Try again in a moment.' }, 502);
    }
    // Best-effort audit stamp (the link itself dies in 4 minutes anyway).
    const expires_at = new Date(Date.now() + 4 * 60_000).toISOString();
    void platformAdmin.from('merchant_adyen_accounts')
      .update({ onboarding_link_url: r.data.url, onboarding_link_expires_at: expires_at, updated_at: new Date().toISOString() })
      .eq('location_id', loc.id).then(() => {}, () => {});
    return json({ ok: true, url: r.data.url, expires_at });
  }

  return json({ error: `unknown action: ${action}` }, 400);
});
