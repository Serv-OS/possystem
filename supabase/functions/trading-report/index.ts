// supabase/functions/trading-report/index.ts
//
// Daily Trading / holistic P&L. Per day across a range it stitches together:
//   • Forecast net sales (wf_sales_forecast.amount) — operator-set, with a
//     "same weekday last year" suggestion learned from closed_checks.
//   • Actual net sales (ex-VAT, ex service/tip): what customers paid for the
//     goods after discounts and comps, read per tender like the accounting day
//     layer (_shared/tradingSales.js, 27 Sep 2026). Never the shelf subtotal.
//     Refunds come off on the day of the refund (28 Sep 2026).
//   • Theoretical labour (wf_shifts.computed_cost, the published rota), on its shift_date.
//   • Actual labour (wf_timesheets.pay_amount, approved/paid), on the business day most of
//     the shift falls in.
//   • COGS (a configurable % of sales) + fixed daily overhead — both stored in
//     wf_venue_settings.settings (the system has no real cost data, so these are
//     operator estimates).
// → gross profit (sales − COGS) and operating profit (− labour − overhead),
//   theoretical vs actual, with variances + period totals.
//
// A DAY is the venue business day (_shared/businessDay.js: platform locations.timezone and
// business_day_start), the day Sales summary and Xero use (28 Sep 2026; it was midnight).
//
//   get          { ops_location_id, from, to }   (YYYY-MM-DD)
//   set_forecast { ops_location_id, date, amount }
//   save_settings{ ops_location_id, cogs_pct, daily_overhead }
// Auth: staff with access to the location (user_locations) / super_admin / service-role.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { secondStepRefusal } from '../_shared/second-step.ts';
import { tradingDays, timesheetDays } from '../_shared/tradingSales.js';
import { businessDayOf, businessDayWindow } from '../_shared/businessDay.js';
import { venueClock } from '../_shared/accountingData.ts';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const opsAdmin = createClient(Deno.env.get('SUPABASE_URL') ?? '', SERVICE_ROLE, { auth: { autoRefreshToken: false, persistSession: false } });
const platformAdmin = createClient(Deno.env.get('PLATFORM_SUPABASE_URL') ?? '', Deno.env.get('PLATFORM_SUPABASE_SERVICE_ROLE_KEY') ?? '', { auth: { autoRefreshToken: false, persistSession: false } });

async function authed(req: Request, ops: string): Promise<boolean> {
  const token = (req.headers.get('Authorization') ?? '').replace('Bearer ', '').trim();
  if (!token) return false;
  if (token === SERVICE_ROLE) return true;
  const { data: { user } } = await opsAdmin.auth.getUser(token);
  if (!user) return false;
  const { data: ul } = await opsAdmin.from('user_locations').select('location_id').eq('user_id', user.id).eq('location_id', ops).maybeSingle();
  if (ul) return true;
  const { data: p } = await opsAdmin.from('user_profiles').select('role').eq('id', user.id).maybeSingle();
  return p?.role === 'super_admin';
}

function dayList(from: string, to: string): string[] {
  const out: string[] = []; const d = new Date(from + 'T00:00:00Z'); const end = new Date(to + 'T00:00:00Z');
  while (d <= end) { out.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); }
  return out;
}
const shift364 = (ymdStr: string) => { const d = new Date(ymdStr + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - 364); return d.toISOString().slice(0, 10); };

// PostgREST answers at most 1000 rows a request (max_rows on this project) whatever .limit()
// asks for, so every read here pages. Until 27 Sep 2026 the reads were one request with
// .limit(20000): a range with more than 1000 checks (about 5 days at Coffee Boy Leeds)
// silently lost the rest. A failed read throws; it is never reported as zero sales.
const PAGE = 1000;
async function pagedRows(what: string, build: () => any): Promise<any[]> {
  const out: any[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build().range(from, from + PAGE - 1);
    if (error) throw new Error(`Could not read ${what}: ${error.message}`);
    out.push(...(data ?? []));
    if (!data || data.length < PAGE) break;
  }
  return out;
}

// The columns the accounting layer reads a check's tenders from (legacy rows included), plus
// discounts for a 100% comp (_shared/tradingSales.js).
const CHECK_COLS = 'id, closed_at, subtotal, total, tax_amount, service, tip, status, voided, discounts, tenders, method, payment_method, source, processor, gift_card, loyalty, promo, payment_intents';

// How far back a refunded check can have closed and still have a refund inside the range
// (the same lookback the accounting layer uses, _shared/accountingData.ts).
const REFUND_LOOKBACK_DAYS = 400;
const DAY_MS = 86400000;

type Clock = { timezone: string; dayStart: string };
type DaySales = { gross: number; refunds: number; sales_vat: number; refund_vat: number; vat: number; net: number; checks: number; refund_count: number };

// The real instants a run of business days covers: [fromIso, toIso).
function rangeWindow(fromYmd: string, toYmd: string, clock: Clock) {
  return {
    fromIso: businessDayWindow(fromYmd, clock.timezone, clock.dayStart).fromIso,
    toIso: businessDayWindow(toYmd, clock.timezone, clock.dayStart).toIso,
  };
}

// Sales and refunds per business day (_shared/tradingSales.js tradingDays): the goods the
// customer paid for, after discounts and comps, less what went back on refunds, each on its
// own day; loyalty and promo credit are discounts; service and tips are NOT sales.
async function salesByDay(ops: string, fromYmd: string, toYmd: string, clock: Clock): Promise<Record<string, DaySales>> {
  const { fromIso, toIso } = rangeWindow(fromYmd, toYmd, clock);
  const since = new Date(Date.parse(fromIso) - REFUND_LOOKBACK_DAYS * DAY_MS).toISOString();
  const [saleRows, refundRows] = await Promise.all([
    pagedRows('closed checks', () => opsAdmin.from('closed_checks').select(CHECK_COLS)
      .eq('location_id', ops).gte('closed_at', fromIso).lt('closed_at', toIso)
      .order('closed_at').order('id')),
    pagedRows('refunds', () => opsAdmin.from('closed_checks').select(`${CHECK_COLS}, refunds`)
      .eq('location_id', ops).gte('closed_at', since).lt('closed_at', toIso).neq('refunds', '[]')
      .order('closed_at').order('id')),
  ]);
  return tradingDays({ saleRows, refundRows, dayOf: (ms: number) => businessDayOf(ms, clock.timezone, clock.dayStart) });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const secondStepBlock = await secondStepRefusal(req); if (secondStepBlock) return secondStepBlock; // docs/SECOND_STEP.md
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);
  let body: any; try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }
  const action = String(body?.action ?? 'get').trim();
  const ops = String(body?.ops_location_id ?? '').trim();
  if (!ops) return json({ error: 'ops_location_id required' }, 400);
  if (!(await authed(req, ops))) return json({ error: 'no access to this location' }, 403);

  // venue settings (org_id, currency, cogs/overhead from settings jsonb)
  const { data: vs } = await opsAdmin.from('wf_venue_settings').select('org_id, currency, settings').eq('location_id', ops).maybeSingle();
  const settings = (vs?.settings && typeof vs.settings === 'object') ? vs.settings : {};
  const cogsPct = Number(settings.cogs_pct ?? 0);
  const cogsBasis = String(settings.cogs_basis || 'estimate'); // 'estimate' (%) | 'recipe' (actual from stock ledger)
  const overhead = Number(settings.daily_overhead ?? 0);
  const currency = vs?.currency || 'GBP';

  // org_id for FK-valid inserts: prefer the venue-settings row, else resolve from
  // the ops locations table (same source wfData uses). Needed when a venue has no
  // workforce row yet but the owner still wants to set costs / forecasts.
  async function resolveOrg(): Promise<string | null> {
    if (vs?.org_id) return vs.org_id;
    const { data: loc } = await opsAdmin.from('locations').select('org_id').eq('id', ops).maybeSingle();
    return loc?.org_id ?? null;
  }

  if (action === 'save_settings') {
    const org = await resolveOrg();
    if (!org) return json({ error: 'could not resolve org for this location' }, 400);
    const next = { ...settings, cogs_pct: Math.max(0, Number(body.cogs_pct) || 0), daily_overhead: Math.max(0, Number(body.daily_overhead) || 0) };
    if (body.cogs_basis === 'recipe' || body.cogs_basis === 'estimate') next.cogs_basis = body.cogs_basis;
    const { error } = await opsAdmin.from('wf_venue_settings').upsert({
      location_id: ops, org_id: org, settings: next, updated_at: new Date().toISOString(),
    }, { onConflict: 'location_id' });
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  }

  if (action === 'set_forecast') {
    const org = await resolveOrg();
    if (!org) return json({ error: 'could not resolve org for this location' }, 400);
    const date = String(body.date ?? '').trim();
    const amount = Math.max(0, Number(body.amount) || 0);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: 'date (YYYY-MM-DD) required' }, 400);
    const { error } = await opsAdmin.from('wf_sales_forecast').upsert({
      location_id: ops, org_id: org, forecast_date: date, amount, currency, updated_at: new Date().toISOString(),
    }, { onConflict: 'location_id,forecast_date' });
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  }

  // ── get: build the daily P&L ──────────────────────────────────────────────
  const from = String(body.from ?? '').trim(); const to = String(body.to ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return json({ error: 'from/to (YYYY-MM-DD) required' }, 400);
  const days = dayList(from, to);
  if (days.length > 120) return json({ error: 'range too large (max ~120 days)' }, 400);

  try {
    // The venue's own clock (platform locations: time zone and business day start). A failed
    // read is an error: no day is ever cut on a guessed clock.
    const clock = await venueClock(platformAdmin, ops);
    const dayOf = (ms: number) => businessDayOf(ms, clock.timezone, clock.dayStart);
    const { fromIso, toIso } = rangeWindow(from, to, clock);

    // sales (this range + same-weekday-last-year for the suggestion)
    const lyFrom = shift364(from), lyTo = shift364(to);
    const [sales, lySales] = await Promise.all([salesByDay(ops, from, to, clock), salesByDay(ops, lyFrom, lyTo, clock)]);

    // forecasts
    const fc: Record<string, number> = {};
    const { data: fcRows } = await opsAdmin.from('wf_sales_forecast').select('forecast_date, amount').eq('location_id', ops).gte('forecast_date', from).lte('forecast_date', to);
    for (const r of fcRows ?? []) fc[r.forecast_date] = Number(r.amount) || 0;

    // theoretical labour (published rota), by shift_date
    const labTheo: Record<string, number> = {};
    const { data: shifts } = await opsAdmin.from('wf_shifts').select('shift_date, computed_cost, status').eq('location_id', ops).gte('shift_date', from).lte('shift_date', to);
    for (const s of shifts ?? []) { if (s.status === 'draft') continue; labTheo[s.shift_date] = (labTheo[s.shift_date] || 0) + (Number(s.computed_cost) || 0); }

    // actual labour (approved/paid timesheets), on the business day most of the shift falls
    // in. A shift that clocked in up to two days before the range can still belong to it.
    const tsFrom = new Date(Date.parse(fromIso) - 2 * DAY_MS).toISOString();
    const ts = await pagedRows('timesheets', () => opsAdmin.from('wf_timesheets').select('id, clock_in, clock_out, pay_amount, status').eq('location_id', ops).gte('clock_in', tsFrom).lt('clock_in', toIso).order('clock_in').order('id'));
    const labAct = timesheetDays({ timesheets: ts, dayOf });

    // Stock-ledger costs per business day: SALE_DEPLETION = recipe COGS of what sold;
    // WASTE = stock thrown away (a separate loss that also reduces operating profit).
    const recipeCogs: Record<string, number> = {};
    const wasteCost: Record<string, number> = {};
    const mv = await pagedRows('stock movements', () => opsAdmin.from('stock_movements').select('value_delta, occurred_at, movement_type').eq('location_id', ops).in('movement_type', ['SALE_DEPLETION', 'WASTE']).gte('occurred_at', fromIso).lt('occurred_at', toIso).order('occurred_at').order('id'));
    for (const m of mv) {
      const k = dayOf(Date.parse(m.occurred_at));
      const v = Math.abs(Number(m.value_delta) || 0);
      if (m.movement_type === 'WASTE') wasteCost[k] = (wasteCost[k] || 0) + v;
      else recipeCogs[k] = (recipeCogs[k] || 0) + v;
    }

    const rows = days.map((d) => {
      const forecast = fc[d] ?? 0;
      const s = sales[d];
      const actualSales = s?.net ?? 0;      // net, ex-VAT, after refunds: the P&L basis
      const vat = s?.vat ?? 0;              // VAT owed: on sales less on refunds (HMRC's, not income)
      const grossSales = s?.gross ?? 0;     // gross takings inc VAT: paid for goods after discounts (never the shelf subtotal), before refunds
      const refunds = s?.refunds ?? 0;      // refunded inc VAT, on the day of the refund
      const lastYear = lySales[shift364(d)]?.net ?? 0;
      const lt = labTheo[d] ?? 0, la = labAct[d] ?? 0;
      const recipeC = recipeCogs[d] || 0;                       // actual COGS from the stock ledger
      const wasteC = wasteCost[d] || 0;                         // stock wasted (separate loss, actual only)
      const cogsEst = actualSales * cogsPct / 100;              // flat-% estimate (full menu coverage)
      const cogsT = forecast * cogsPct / 100;                   // theoretical always on the % basis
      const cogsA = cogsBasis === 'recipe' ? recipeC : cogsEst; // actual basis: recipe ledger or % estimate
      const r2 = (n: number) => Math.round(n * 100) / 100;
      return {
        date: d,
        forecast: r2(forecast), actual_sales: r2(actualSales), last_year: r2(lastYear),
        vat: r2(vat), gross_sales: r2(grossSales), refunds: r2(refunds), refund_vat: r2(s?.refund_vat ?? 0),
        refund_count: s?.refund_count ?? 0,
        sales_variance: r2(actualSales - forecast),
        labour_theo: r2(lt), labour_actual: r2(la),
        labour_pct_theo: forecast > 0 ? r2(lt / forecast * 100) : null,
        labour_pct_actual: actualSales > 0 ? r2(la / actualSales * 100) : null,
        cogs_theo: r2(cogsT), cogs_actual: r2(cogsA),
        cogs_recipe: r2(recipeC), cogs_estimate: r2(cogsEst),
        cogs_pct_actual: actualSales > 0 ? r2(cogsA / actualSales * 100) : null,
        waste: r2(wasteC),
        overhead: r2(overhead),
        gp_theo: r2(forecast - cogsT), gp_actual: r2(actualSales - cogsA),
        op_theo: r2(forecast - cogsT - lt - overhead),
        op_actual: r2(actualSales - cogsA - wasteC - la - overhead),  // waste is a real loss
      };
    });
    const sum = (k: string) => Math.round(rows.reduce((s, r) => s + (Number((r as any)[k]) || 0), 0) * 100) / 100;
    const totals = {
      forecast: sum('forecast'), actual_sales: sum('actual_sales'), last_year: sum('last_year'),
      vat: sum('vat'), gross_sales: sum('gross_sales'), refunds: sum('refunds'), refund_vat: sum('refund_vat'),
      refund_count: rows.reduce((n, r) => n + r.refund_count, 0),
      labour_theo: sum('labour_theo'), labour_actual: sum('labour_actual'),
      cogs_theo: sum('cogs_theo'), cogs_actual: sum('cogs_actual'),
      cogs_recipe: sum('cogs_recipe'), cogs_estimate: sum('cogs_estimate'), waste: sum('waste'), overhead: sum('overhead'),
      gp_theo: sum('gp_theo'), gp_actual: sum('gp_actual'), op_theo: sum('op_theo'), op_actual: sum('op_actual'),
      labour_pct_actual: sum('actual_sales') > 0 ? Math.round(sum('labour_actual') / sum('actual_sales') * 10000) / 100 : null,
    };
    return json({ ok: true, rows, totals, settings: { cogs_pct: cogsPct, cogs_basis: cogsBasis, daily_overhead: overhead, currency }, tz: clock.timezone, day_start: clock.dayStart });
  } catch (e) {
    // A read that failed is never shown as a day of zero sales.
    return json({ error: (e as Error)?.message || 'Could not build the report' }, 500);
  }
});
