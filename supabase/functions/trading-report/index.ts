// supabase/functions/trading-report/index.ts
//
// Daily Trading / holistic P&L. Per day across a range it stitches together:
//   • Forecast net sales (wf_sales_forecast.amount) — operator-set, with a
//     "same weekday last year" suggestion learned from closed_checks.
//   • Actual net sales (ex-VAT, ex service/tip): what customers paid for the
//     goods after discounts and comps, read per tender like the accounting day
//     layer (_shared/tradingSales.js, 27 Sep 2026). Never the shelf subtotal.
//   • Theoretical labour (wf_shifts.computed_cost, the published rota).
//   • Actual labour (wf_timesheets.pay_amount, approved/paid).
//   • COGS (a configurable % of sales) + fixed daily overhead — both stored in
//     wf_venue_settings.settings (the system has no real cost data, so these are
//     operator estimates).
// → gross profit (sales − COGS) and operating profit (− labour − overhead),
//   theoretical vs actual, with variances + period totals.
//
//   get          { ops_location_id, from, to }   (YYYY-MM-DD)
//   set_forecast { ops_location_id, date, amount }
//   save_settings{ ops_location_id, cogs_pct, daily_overhead }
// Auth: staff with access to the location (user_locations) / super_admin / service-role.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { secondStepRefusal } from '../_shared/second-step.ts';
import { checkSalesParts } from '../_shared/tradingSales.js';
import { isVoidedCheck } from '../_shared/accountingDay.js';

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

const ymd = (d: Date, tz: string) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
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

// Sum closed_checks per venue-local day: net (ex-VAT) + VAT + gross (inc VAT), per check by
// checkSalesParts (_shared/tradingSales.js): the goods the customer paid for, after discounts
// and comps; loyalty and promo credit are discounts; service and tips are NOT sales.
async function salesByDay(ops: string, fromYmd: string, toYmd: string, tz: string): Promise<Record<string, { net: number; vat: number; gross: number }>> {
  const startUtc = new Date(fromYmd + 'T00:00:00Z'); startUtc.setUTCHours(startUtc.getUTCHours() - 14);   // tz padding
  const endUtc = new Date(toYmd + 'T23:59:59Z'); endUtc.setUTCHours(endUtc.getUTCHours() + 14);
  const out: Record<string, { net: number; vat: number; gross: number }> = {};
  const data = await pagedRows('closed checks', () => opsAdmin.from('closed_checks').select(CHECK_COLS)
    .eq('location_id', ops).gte('closed_at', startUtc.toISOString()).lte('closed_at', endUtc.toISOString())
    .order('closed_at').order('id'));
  for (const c of data) {
    if (isVoidedCheck(c)) continue;
    const key = ymd(new Date(c.closed_at), tz);
    const p = checkSalesParts(c);
    const e = (out[key] ??= { net: 0, vat: 0, gross: 0 });
    e.net += p.net; e.vat += p.vat; e.gross += p.gross;
  }
  return out;
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

  // venue settings (org_id, currency, cogs/overhead from settings jsonb) + tz
  const { data: vs } = await opsAdmin.from('wf_venue_settings').select('org_id, currency, settings').eq('location_id', ops).maybeSingle();
  const settings = (vs?.settings && typeof vs.settings === 'object') ? vs.settings : {};
  const cogsPct = Number(settings.cogs_pct ?? 0);
  const cogsBasis = String(settings.cogs_basis || 'estimate'); // 'estimate' (%) | 'recipe' (actual from stock ledger)
  const overhead = Number(settings.daily_overhead ?? 0);
  const currency = vs?.currency || 'GBP';
  const { data: ploc } = await platformAdmin.from('locations').select('timezone').or(`ops_location_id.eq.${ops},id.eq.${ops}`).maybeSingle();
  const tz = ploc?.timezone || 'Europe/London';

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
    // sales (this range + same-weekday-last-year for the suggestion)
    const lyFrom = shift364(from), lyTo = shift364(to);
    const [sales, lySales] = await Promise.all([salesByDay(ops, from, to, tz), salesByDay(ops, lyFrom, lyTo, tz)]);

    // forecasts
    const fc: Record<string, number> = {};
    const { data: fcRows } = await opsAdmin.from('wf_sales_forecast').select('forecast_date, amount').eq('location_id', ops).gte('forecast_date', from).lte('forecast_date', to);
    for (const r of fcRows ?? []) fc[r.forecast_date] = Number(r.amount) || 0;

    // theoretical labour (published rota), by shift_date
    const labTheo: Record<string, number> = {};
    const { data: shifts } = await opsAdmin.from('wf_shifts').select('shift_date, computed_cost, status').eq('location_id', ops).gte('shift_date', from).lte('shift_date', to);
    for (const s of shifts ?? []) { if (s.status === 'draft') continue; labTheo[s.shift_date] = (labTheo[s.shift_date] || 0) + (Number(s.computed_cost) || 0); }

    // actual labour (approved/paid timesheets), by venue-local clock_in day
    const labAct: Record<string, number> = {};
    const tsStart = new Date(from + 'T00:00:00Z'); tsStart.setUTCHours(tsStart.getUTCHours() - 14);
    const tsEnd = new Date(to + 'T23:59:59Z'); tsEnd.setUTCHours(tsEnd.getUTCHours() + 14);
    const ts = await pagedRows('timesheets', () => opsAdmin.from('wf_timesheets').select('clock_in, pay_amount, status').eq('location_id', ops).gte('clock_in', tsStart.toISOString()).lte('clock_in', tsEnd.toISOString()).order('clock_in').order('id'));
    for (const t of ts) { if (!['approved', 'paid'].includes(t.status)) continue; const k = ymd(new Date(t.clock_in), tz); labAct[k] = (labAct[k] || 0) + (Number(t.pay_amount) || 0); }

    // Stock-ledger costs per venue-local day: SALE_DEPLETION = recipe COGS of what sold;
    // WASTE = stock thrown away (a separate loss that also reduces operating profit).
    const recipeCogs: Record<string, number> = {};
    const wasteCost: Record<string, number> = {};
    const mv = await pagedRows('stock movements', () => opsAdmin.from('stock_movements').select('value_delta, occurred_at, movement_type').eq('location_id', ops).in('movement_type', ['SALE_DEPLETION', 'WASTE']).gte('occurred_at', tsStart.toISOString()).lte('occurred_at', tsEnd.toISOString()).order('occurred_at').order('id'));
    for (const m of mv) {
      const k = ymd(new Date(m.occurred_at), tz);
      const v = Math.abs(Number(m.value_delta) || 0);
      if (m.movement_type === 'WASTE') wasteCost[k] = (wasteCost[k] || 0) + v;
      else recipeCogs[k] = (recipeCogs[k] || 0) + v;
    }

    const rows = days.map((d) => {
      const forecast = fc[d] ?? 0;
      const s = sales[d] ?? { net: 0, vat: 0, gross: 0 };
      const actualSales = s.net;            // net, ex-VAT — the P&L basis
      const vat = s.vat;                    // VAT collected (HMRC's, not income)
      const grossSales = s.gross;           // gross takings inc VAT: paid for goods after discounts (never the shelf subtotal)
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
        vat: r2(vat), gross_sales: r2(grossSales),
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
      vat: sum('vat'), gross_sales: sum('gross_sales'),
      labour_theo: sum('labour_theo'), labour_actual: sum('labour_actual'),
      cogs_theo: sum('cogs_theo'), cogs_actual: sum('cogs_actual'),
      cogs_recipe: sum('cogs_recipe'), cogs_estimate: sum('cogs_estimate'), waste: sum('waste'), overhead: sum('overhead'),
      gp_theo: sum('gp_theo'), gp_actual: sum('gp_actual'), op_theo: sum('op_theo'), op_actual: sum('op_actual'),
      labour_pct_actual: sum('actual_sales') > 0 ? Math.round(sum('labour_actual') / sum('actual_sales') * 10000) / 100 : null,
    };
    return json({ ok: true, rows, totals, settings: { cogs_pct: cogsPct, cogs_basis: cogsBasis, daily_overhead: overhead, currency }, tz });
  } catch (e) {
    // A read that failed is never shown as a day of zero sales.
    return json({ error: (e as Error)?.message || 'Could not build the report' }, 500);
  }
});
