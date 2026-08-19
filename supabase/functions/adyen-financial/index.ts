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
// The fee columns (fee_minor etc.) land with hand-applied migration
// 20260820_adyen_fees.sql; every select that touches them retries without them
// so deploying this fn ahead of the migration can never break the Payments tab.
//
// PHASE 3 (v5.7.0) adds:
//   settings       → the venue's effective processing rate (venue override else
//                    platform default) + account status flags, for the read-only
//                    Settings tab. Display only — nothing charges from it yet.
//
// ⚠ DEPLOY ME (edge functions deploy manually and drift silently):
//   npx supabase functions deploy adyen-financial --project-ref tbetcegmszzotrwdtqhi --no-verify-jwt

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const opsAdmin = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '', { auth: { autoRefreshToken: false, persistSession: false } });
const platformAdmin = createClient(Deno.env.get('PLATFORM_SUPABASE_URL') ?? '', Deno.env.get('PLATFORM_SUPABASE_SERVICE_ROLE_KEY') ?? '', { auth: { autoRefreshToken: false, persistSession: false } });

// Summary sums are computed in-function over a capped slice (PostgREST
// aggregates are not enabled on the project). The cap is generous for a single
// venue's period; if it is ever hit the response says so honestly.
const SUMMARY_CAP = 5000;

// Postgres 42703 (column does not exist) — the fee columns until migration
// 20260820_adyen_fees.sql is hand-applied. Selects retry without them.
const isMissingColumn = (msg: unknown) => /does not exist|42703/i.test(String(msg ?? ''));

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
    .select('id, name').eq('ops_location_id', opsLocationId).maybeSingle();
  if (locErr) return json({ error: `location lookup failed: ${locErr.message}` }, 500);
  if (!loc) return json({ error: 'location not found in platform DB' }, 404);

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

    const SUM_COLS = 'amount_minor, amount_refunded_minor, success, last_event_code, currency';
    const buildSum = (cols: string) => {
      let q = platformAdmin.from('adyen_payments').select(cols).eq('location_id', loc.id).limit(SUMMARY_CAP);
      if (fromIso) q = q.gte('created_at', fromIso);
      if (toIso) q = q.lte('created_at', toIso);
      return q;
    };
    let feeColsLive = true;
    let { data: sumRows, error: sumErr } = await buildSum(`${SUM_COLS}, fee_minor`);
    if (sumErr && isMissingColumn(sumErr.message)) {
      feeColsLive = false;
      ({ data: sumRows, error: sumErr } = await buildSum(SUM_COLS));
    }
    if (sumErr) return json({ error: `summary read failed: ${sumErr.message}` }, 500);

    // A "payment" for the tiles = a successful authorisation that was not
    // cancelled. Declines and cancellations stay visible in the list.
    const isPayment = (r: any) => r.success === true && r.last_event_code !== 'CANCELLATION';
    const paid = (sumRows ?? []).filter(isPayment);
    // Fees: known only for payments a settlement report has touched. null (an
    // honest dash) until at least one row carries a fee; then the sum of the
    // rows that do — fee_known says how many that is.
    const feeKnown = feeColsLive ? (sumRows ?? []).filter((r: any) => r.fee_minor != null) : [];
    const summary = {
      count: paid.length,
      sum_minor: paid.reduce((s, r) => s + (Number(r.amount_minor) || 0), 0),
      refunds_minor: (sumRows ?? []).reduce((s, r) => s + (Number(r.amount_refunded_minor) || 0), 0),
      fees_minor: feeKnown.length ? feeKnown.reduce((s: number, r: any) => s + (Number(r.fee_minor) || 0), 0) : null,
      fee_known: feeKnown.length,
      currency: (sumRows ?? []).find((r) => r.currency)?.currency ?? 'GBP',
      capped: (sumRows ?? []).length >= SUMMARY_CAP,
    };

    const LIST_COLS = 'psp_reference, merchant_reference, channel, last_event_code, success, amount_minor, currency, amount_refunded_minor, card, matched_closed_check, created_at';
    const buildList = (cols: string) => {
      let q = platformAdmin.from('adyen_payments')
        .select(cols, { count: 'exact' })
        .eq('location_id', loc.id)
        .order('created_at', { ascending: false })
        .range(page * pageSize, page * pageSize + pageSize - 1);
      if (fromIso) q = q.gte('created_at', fromIso);
      if (toIso) q = q.lte('created_at', toIso);
      return q;
    };
    let { data: payments, error: listErr, count } = await buildList(`${LIST_COLS}, fee_minor, settled_at`);
    if (listErr && isMissingColumn(listErr.message)) {
      ({ data: payments, error: listErr, count } = await buildList(LIST_COLS));
    }
    if (listErr) return json({ error: `payments read failed: ${listErr.message}` }, 500);

    return json({ ok: true, summary, payments: payments ?? [], page, page_size: pageSize, total: count ?? 0 });
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

  // ── payouts: settlement batches for this venue ───────────────────────────
  // A batch whose lines all resolve to one venue carries that venue's
  // location_id and its row sums are shown as-is. A batch shared across venues
  // on the same merchant account has location_id null — the venue then sees
  // its SLICE (sums of its own lines) flagged shared: true.
  if (action === 'payouts') {
    const { data: own, error: ownErr } = await platformAdmin.from('adyen_payouts')
      .select('*').eq('location_id', loc.id)
      .order('payout_date', { ascending: false }).limit(100);
    if (ownErr) return json({ error: `payouts read failed: ${ownErr.message}` }, 500);

    // Venue slices come from per-line location_id (migration 20260820); before
    // the migration the column is missing, which just means "no shared batches".
    const slices = new Map<string, { gross: number; fees: number; net: number; count: number }>();
    const { data: venueLines, error: vlErr } = await platformAdmin.from('adyen_payout_lines')
      .select('payout_id, gross_minor, fee_minor, net_minor')
      .eq('location_id', loc.id).limit(5000);
    if (vlErr && !isMissingColumn(vlErr.message)) return json({ error: `payout lines read failed: ${vlErr.message}` }, 500);
    for (const l of venueLines ?? []) {
      if (!l.payout_id) continue;
      const s = slices.get(l.payout_id) ?? { gross: 0, fees: 0, net: 0, count: 0 };
      s.gross += Number(l.gross_minor) || 0;
      s.fees += Number(l.fee_minor) || 0;
      s.net += Number(l.net_minor) || 0;
      s.count++;
      slices.set(l.payout_id, s);
    }
    const ownIds = new Set((own ?? []).map((p: any) => p.id));
    const sharedIds = [...slices.keys()].filter((id) => !ownIds.has(id));
    let shared: any[] = [];
    if (sharedIds.length) {
      const { data, error } = await platformAdmin.from('adyen_payouts')
        .select('*').in('id', sharedIds.slice(0, 100));
      if (error) return json({ error: `shared payouts read failed: ${error.message}` }, 500);
      shared = data ?? [];
    }
    const shape = (p: any, isShared: boolean) => {
      const slice = slices.get(p.id);
      return {
        id: p.id,
        payout_date: p.payout_date,
        batch_number: p.batch_number ?? null,
        reference: p.reference,
        report_name: p.report_name ?? null,
        status: p.status ?? null,
        currency: p.currency ?? 'GBP',
        destination_last4: p.destination_last4 ?? null,
        shared: isShared,
        gross_minor: isShared && slice ? slice.gross : (p.gross_minor ?? null),
        fees_minor: isShared && slice ? slice.fees : (p.fees_minor ?? null),
        net_minor: isShared && slice ? slice.net : (p.amount_minor ?? null),
        line_count: slice?.count ?? null,
      };
    };
    const payouts = [...(own ?? []).map((p: any) => shape(p, false)), ...shared.map((p: any) => shape(p, true))]
      .sort((a, b) => String(b.payout_date ?? '').localeCompare(String(a.payout_date ?? '')));
    return json({ ok: true, payouts });
  }

  // ── payout_detail: every line inside one payout, joined to the ledger ────
  if (action === 'payout_detail') {
    const payoutId = String(body.payout_id ?? '');
    if (!payoutId) return json({ error: 'payout_id required' }, 400);
    const { data: payout, error: pErr } = await platformAdmin.from('adyen_payouts')
      .select('*').eq('id', payoutId).maybeSingle();
    if (pErr) return json({ error: `payout read failed: ${pErr.message}` }, 500);
    if (!payout) return json({ error: 'payout not found' }, 404);

    const { data: allLines, error: lErr } = await platformAdmin.from('adyen_payout_lines')
      .select('*').eq('payout_id', payoutId).order('id', { ascending: true }).limit(2000);
    if (lErr) return json({ error: `payout lines read failed: ${lErr.message}` }, 500);

    // Venue fence: own the payout, or hold lines inside it. A shared batch
    // shows ONLY this venue's lines (account-level rows stay with the owner
    // view — no leaking another venue's transactions).
    const isOwner = payout.location_id === loc.id;
    const hasLines = (allLines ?? []).some((l: any) => l.location_id === loc.id);
    if (!isOwner && !hasLines) return json({ error: 'payout not found for this venue' }, 404);
    const lines = isOwner ? (allLines ?? []) : (allLines ?? []).filter((l: any) => l.location_id === loc.id);

    // Join to the payments ledger for card / reference / timing.
    const psps = [...new Set(lines.map((l: any) => l.psp_reference).filter(Boolean))] as string[];
    const pay = new Map<string, any>();
    for (let i = 0; i < psps.length; i += 200) {
      const { data, error } = await platformAdmin.from('adyen_payments')
        .select('psp_reference, merchant_reference, card, channel, created_at')
        .in('psp_reference', psps.slice(i, i + 200));
      if (error) return json({ error: `payments join failed: ${error.message}` }, 500);
      for (const r of data ?? []) pay.set(r.psp_reference, r);
    }

    return json({
      ok: true,
      payout: {
        id: payout.id, payout_date: payout.payout_date, batch_number: payout.batch_number ?? null,
        reference: payout.reference, report_name: payout.report_name ?? null, status: payout.status ?? null,
        currency: payout.currency ?? 'GBP', destination_last4: payout.destination_last4 ?? null,
        gross_minor: payout.gross_minor ?? null, fees_minor: payout.fees_minor ?? null,
        net_minor: payout.amount_minor ?? null, shared: !isOwner,
      },
      lines: lines.map((l: any) => ({
        id: l.id, psp_reference: l.psp_reference, line_type: l.line_type,
        gross_minor: l.gross_minor, fee_minor: l.fee_minor, net_minor: l.net_minor,
        gratuity_minor: l.gratuity_minor ?? null, currency: l.currency ?? payout.currency ?? 'GBP',
        payment: l.psp_reference ? (pay.get(l.psp_reference) ?? null) : null,
      })),
    });
  }

  // ── statement: one month's totals for the printable Documents page ───────
  // Fees are attributed to the month the payment was TAKEN (they settle days
  // later but belong to that month's trading). has_fee_data drives the UI:
  // false = honest empty state, true = render the statement.
  if (action === 'statement') {
    const month = String(body.month ?? '');
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return json({ error: 'month must be YYYY-MM' }, 400);
    const from = new Date(`${month}-01T00:00:00Z`);
    const to = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1));
    const STMT_CAP = 10000;
    const BASE = 'amount_minor, amount_refunded_minor, success, last_event_code, currency';
    const build = (cols: string) => platformAdmin.from('adyen_payments').select(cols)
      .eq('location_id', loc.id)
      .gte('created_at', from.toISOString()).lt('created_at', to.toISOString())
      .limit(STMT_CAP);
    let feeLive = true;
    let { data: rows, error: sErr } = await build(`${BASE}, fee_minor, gratuity_minor`);
    if (sErr && isMissingColumn(sErr.message)) { feeLive = false; ({ data: rows, error: sErr } = await build(BASE)); }
    if (sErr) return json({ error: `statement read failed: ${sErr.message}` }, 500);

    const isPayment = (r: any) => r.success === true && r.last_event_code !== 'CANCELLATION';
    const paid = (rows ?? []).filter(isPayment);
    const feeKnown = feeLive ? paid.filter((r: any) => r.fee_minor != null) : [];
    const gross = paid.reduce((s: number, r: any) => s + (Number(r.amount_minor) || 0), 0);
    const refunds = (rows ?? []).reduce((s: number, r: any) => s + (Number(r.amount_refunded_minor) || 0), 0);
    const fees = feeKnown.reduce((s: number, r: any) => s + (Number(r.fee_minor) || 0), 0);
    const gratuity = feeLive ? paid.reduce((s: number, r: any) => s + (Number(r.gratuity_minor) || 0), 0) : 0;
    return json({
      ok: true,
      venue: loc.name,
      month,
      currency: (rows ?? []).find((r: any) => r.currency)?.currency ?? 'GBP',
      payments_count: paid.length,
      gross_minor: gross,
      refunds_minor: refunds,
      fees_minor: feeKnown.length ? fees : null,
      gratuity_minor: gratuity || null,
      net_minor: feeKnown.length ? gross - refunds - fees : null,
      has_fee_data: feeKnown.length > 0,
      fee_coverage: { with_fees: feeKnown.length, payments: paid.length },
      capped: (rows ?? []).length >= STMT_CAP,
    });
  }

  // ── settings: the venue's effective processing rate + account flags ──────
  // Phase 3 (v5.7.0): feeds the read-only Settings tab in Back Office → Card
  // payments. Effective rate = per-field venue override on
  // merchant_adyen_accounts (markup_percent / markup_fixed_pence), else the
  // platform default on platform_settings — the same fallback rule the Ryft
  // rate card uses. Venue-facing, so this returns ONLY the effective numbers
  // (never cost/margin internals) plus the account status flags.
  // ⚠ These rates are DISPLAY + future-billing configuration only in this
  // phase — nothing reads them at charge time. Splits / commission collection
  // is Phase 4.
  if (action === 'settings') {
    const [{ data: acct, error: aErr }, { data: ps, error: pErr }] = await Promise.all([
      platformAdmin.from('merchant_adyen_accounts')
        .select('markup_percent, markup_fixed_pence, receive_payments_ok, payouts_ok, balance_account_id')
        .eq('location_id', loc.id).maybeSingle(),
      platformAdmin.from('platform_settings')
        .select('default_adyen_markup_percent, default_adyen_markup_fixed_pence')
        .eq('id', true).maybeSingle(),
    ]);
    if (aErr) return json({ error: `account read failed: ${aErr.message}` }, 500);
    if (pErr) return json({ error: `settings read failed: ${pErr.message}` }, 500);
    const percent = acct?.markup_percent ?? ps?.default_adyen_markup_percent ?? null;
    const fixed = acct?.markup_fixed_pence ?? ps?.default_adyen_markup_fixed_pence ?? null;
    return json({
      ok: true,
      venue: loc.name,
      rates: {
        percent: percent == null ? null : Number(percent),
        fixed_pence: fixed == null ? null : Number(fixed),
        // 'venue' when this venue has its own agreed rate, 'platform' when it
        // rides the standard rate, null when no rate has been recorded yet.
        source: (acct?.markup_percent != null || acct?.markup_fixed_pence != null)
          ? 'venue'
          : (percent != null || fixed != null) ? 'platform' : null,
      },
      account: {
        exists: !!acct,
        receive_payments_ok: !!acct?.receive_payments_ok,
        payouts_ok: !!acct?.payouts_ok,
        has_balance_account: !!acct?.balance_account_id,
      },
    });
  }

  return json({ error: `unknown action: ${action}` }, 400);
});
