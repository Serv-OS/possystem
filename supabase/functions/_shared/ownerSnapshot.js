// ownerSnapshot.js: the Owner app's numbers, built from the Ops database for one login's venues.
//
// 2 Oct 2026, Peter: "On the owner app I want to be able to have quick filters for today, this
// week, this month." This was the body of owner-snapshot/index.ts, which answered today only.
// It moved here, with the database client passed in, so `npm test` runs the WHOLE build
// against a stand in that caps every request at 1000 rows the way PostgREST does
// (src/lib/ownerSnapshot.test.js). index.ts keeps the sign in and the venue list.
//
// Per venue, on the venue's own clock (_shared/ownerPeriod.js has the date rules):
//   today, wtd, live, top_items   exactly what the function always answered, whatever the
//                                 period, so an app from before the filters reads it as before
//   range                         the dates the chosen period covers and is compared against
//   period_totals                 net sales, VAT, gross, orders, tips, average check, forecast
//                                 for the same days (wf_sales_forecast added up), labour and
//                                 labour % of sales, and the comparison
//   period_top_items              best sellers over the period
// Live orders and open tables are always "now".
//
// A DAY here is the venue's calendar day in its own time zone, the rule this function has
// always used for Today. The filters keep it so This week always ends in exactly the Today
// figure. (The Back Office reports use the business day start, 06:30 at Coffee Boy. The two
// only differ for a venue that trades after midnight: a 00:40 sale on the 1st is the new
// month here and the old month in Back Office. 2 Oct 2026: no Coffee Boy venue has closed a
// check before 06:30 in 60 days, so no live number differs.)
// PETER'S CALL, not made yet: moving to the business day moves Today as well (between
// midnight and the day start the app would show the day just finished, not an empty new
// one). To do it: read business_day_start beside timezone from the Platform locations row in
// index.ts, then businessDayOf() in dayKeyer and businessDayStartMs() for midnightIso, for
// today, the week to date and the period together (_shared/businessDay.js).
//
// VOLUME. A busy Coffee Boy closes about 260 checks a day, about 7,800 a month, and This month
// reads two months of sales columns. So:
//   * sales columns for the days that are needed and no others: the period, its comparison
//     span (NOT the whole of last month) and the week to date, each day read once
//     (mergeDayRanges), from the venue's own midnight to midnight;
//   * items, the heavy column, for the period's own days only, never the comparison;
//   * every read pages, and each page is added up as it arrives (pagedEach): the function
//     holds running totals per day and per item, never the rows;
//   * This month is read a week at a time, the weeks side by side, with at most MAX_READS
//     requests in flight for the whole snapshot. The tills use the same PostgREST.
// A read that fails throws. It is never shown as a period of zero sales.
//
// PURE apart from the client it is handed; runs under node --test and in Deno.

import { pagedRows, pagedEach, limiter } from './pagedRows.js';
import { SALES_CHECK_COLS, emptySales, addCheckSales } from './snapshotSales.js';
import { isVoidedCheck } from './accountingDay.js';
import { wallClock, wallTimeToInstant } from './businessDay.js';
import {
  ownerPeriod, periodRange, addDays, weekStartOf, inDays, mergeDayRanges, sliceDayRange,
  addCheckItems, topItems, periodTotals, rollupTotals, vsPct, r2,
} from './ownerPeriod.js';

/** Requests in flight at once, for the whole snapshot. */
export const MAX_READS = 8;
// Today and This week need at most 14 days of sales (Monday of last week to today): one
// window per venue, as before the filters. This month is cut into weeks read side by side.
const SLICE_DAYS = { today: 14, week: 14, month: 7 };
const LIVE_DONE = new Set(['collected', 'cancelled', 'canceled', 'rejected', 'refunded', 'completed', 'done', 'void', 'voided']);
const QUARTER_HOUR = 900000;

export function emptyRollup() {
  return { locations: 0, net_sales: 0, forecast: 0, orders: 0, tips: 0, labour: 0, live_orders: 0, open_tables: 0, wtd_net: 0, wtd_last_week: 0 };
}

// The venue-local date of an instant. Every time zone sits a whole number of quarter hours
// from UTC, so the date is the same right through a UTC quarter hour: one lookup per quarter
// hour, not one Intl call per check (60,000 of them in a month across a group).
function dayKeyer(tz) {
  const seen = new Map();
  return (ms) => {
    const k = Math.floor(ms / QUARTER_HOUR);
    let d = seen.get(k);
    if (!d) seen.set(k, (d = wallClock(k * QUARTER_HOUR, tz).ymd));
    return d;
  };
}

const midnightIso = (ymd, tz) => new Date(wallTimeToInstant(ymd, 0, tz)).toISOString();

/**
 * @param {object} a
 * @param {any} a.ops  the Ops database client (service role)
 * @param {string[]} a.opsIds  the venues this login may see
 * @param {Record<string, { name: string, tz: string, currency: string }>} a.meta
 * @param {Date} [a.now]
 * @param {string} [a.period]  'today' | 'week' | 'month'
 * @param {number} [a.maxReads]
 * @returns {Promise<{ period: string, locations: any[], rollup: any }>}
 */
export async function buildOwnerSnapshot({ ops, opsIds, meta, now = new Date(), period: asked, maxReads = MAX_READS }) {
  const period = ownerPeriod(asked);
  if (!opsIds.length) return { period, locations: [], rollup: { ...emptyRollup(), period_totals: rollupTotals([]) } };
  const nowMs = now.getTime();

  // Each venue's own dates: today, the week to date the app has always shown, and the period.
  const plan = {};
  for (const id of opsIds) {
    const tz = meta[id].tz;
    const dayOf = dayKeyer(tz);
    const today = dayOf(nowMs);
    const wkStart = weekStartOf(today);
    const lwStart = addDays(wkStart, -7);
    const range = periodRange(period, today);
    plan[id] = {
      tz, dayOf, today, lwToday: addDays(today, -7), wkStart, lwStart, lwEnd: addDays(today, -7), range,
      // A day in two of these is read once.
      salesDays: mergeDayRanges([{ from: lwStart, to: today }, { from: range.from, to: range.to }, { from: range.cmpFrom, to: range.cmpTo }]),
      startIso: midnightIso(range.from, tz), endIso: midnightIso(addDays(today, 1), tz),
    };
  }
  // Midnight to midnight on the venue's own clock, so two windows never share a check.
  const windowsOf = (id, ranges) => ranges
    .flatMap((r) => sliceDayRange(r.from, r.to, SLICE_DAYS[period]))
    .map((s) => ({ from: midnightIso(s.from, plan[id].tz), to: midnightIso(addDays(s.to, 1), plan[id].tz) }));

  const byDay = {};       // venue -> venue-local day -> sales
  const todayItems = {};  // venue -> Map of item name -> { name, qty, rev }
  const periodItems = {};
  for (const id of opsIds) { byDay[id] = {}; todayItems[id] = new Map(); periodItems[id] = new Map(); }

  // What customers paid for the goods, VAT apart; voided checks count for nothing
  // (_shared/snapshotSales.js). Bucketed by the venue-local day the check closed.
  const addSales = (id, rows) => {
    const dd = byDay[id], dayOf = plan[id].dayOf;
    for (const c of rows) {
      const ms = Date.parse(c.closed_at);
      if (Number.isFinite(ms)) addCheckSales((dd[dayOf(ms)] ??= emptySales()), c);
    }
  };
  const addItems = (id, rows) => {
    const { dayOf, today, range } = plan[id];
    for (const c of rows) {
      if (isVoidedCheck(c) || !Array.isArray(c.items)) continue;
      const ms = Date.parse(c.closed_at);
      if (!Number.isFinite(ms)) continue;
      const d = dayOf(ms);
      if (!inDays(d, range.from, today)) continue;
      addCheckItems(periodItems[id], c.items);
      if (d === today) addCheckItems(todayItems[id], c.items);
    }
  };

  // One queue for every request this snapshot makes.
  const gate = limiter(maxReads);
  const opts = { gate };
  const salesOf = (id) => Promise.all(windowsOf(id, plan[id].salesDays).map((w) =>
    pagedEach('closed checks', () => ops.from('closed_checks').select(SALES_CHECK_COLS)
      .eq('location_id', id).gte('closed_at', w.from).lt('closed_at', w.to).order('closed_at').order('id'), (rows) => addSales(id, rows), opts)));
  // Items for the period's own days only (today's, under Today): they are the heavy column.
  const itemsOf = (id) => Promise.all(windowsOf(id, [{ from: plan[id].range.from, to: plan[id].today }]).map((w) =>
    pagedEach('items sold', () => ops.from('closed_checks').select('id, closed_at, status, voided, items')
      .eq('location_id', id).gte('closed_at', w.from).lt('closed_at', w.to).order('closed_at').order('id'), (rows) => addItems(id, rows), opts)));

  // Forecasts and timesheets for every venue in one read each: the widest dates any venue
  // needs, then each row is kept only if it falls in its own venue's period.
  const all = opsIds.map((id) => plan[id]);
  const least = (xs) => xs.reduce((a, b) => (b < a ? b : a));
  const most = (xs) => xs.reduce((a, b) => (b > a ? b : a));
  const fcFrom = least(all.map((p) => p.range.from)), fcTo = most(all.map((p) => p.today));
  const tsFrom = least(all.map((p) => p.startIso)), tsTo = most(all.map((p) => p.endIso));

  const [, , fcRows, ts, oq, sess] = await Promise.all([
    Promise.all(opsIds.map(salesOf)),
    Promise.all(opsIds.map(itemsOf)),
    gate(() => pagedRows('forecasts', () => ops.from('wf_sales_forecast').select('location_id, forecast_date, amount').in('location_id', opsIds).gte('forecast_date', fcFrom).lte('forecast_date', fcTo).order('id'))),
    gate(() => pagedRows('timesheets', () => ops.from('wf_timesheets').select('location_id, clock_in, pay_amount, status').in('location_id', opsIds).gte('clock_in', tsFrom).lt('clock_in', tsTo).order('clock_in').order('id'))),
    gate(() => pagedRows('open orders', () => ops.from('order_queue').select('location_id, status').in('location_id', opsIds).order('location_id').order('ref'))),
    gate(() => pagedRows('open tables', () => ops.from('active_sessions').select('location_id').in('location_id', opsIds).order('id'))),
  ]);

  // Forecast per venue per day
  const fc = {};
  for (const f of fcRows) { (fc[f.location_id] ??= {})[String(f.forecast_date).slice(0, 10)] = Number(f.amount) || 0; }

  // Actual labour (approved or paid timesheets) by the venue-local day of the clock in
  const labourToday = {}, labourPeriod = {};
  for (const t of ts) {
    if (!['approved', 'paid'].includes(t.status)) continue;
    const p = plan[t.location_id];
    const ms = Date.parse(t.clock_in);
    if (!p || !Number.isFinite(ms)) continue;
    const d = p.dayOf(ms), pay = Number(t.pay_amount) || 0;
    if (d === p.today) labourToday[t.location_id] = (labourToday[t.location_id] || 0) + pay;
    if (inDays(d, p.range.from, p.today)) labourPeriod[t.location_id] = (labourPeriod[t.location_id] || 0) + pay;
  }

  // Live orders + open tables: always now
  const liveOrders = {};
  for (const o of oq) { if (LIVE_DONE.has(String(o.status || '').toLowerCase())) continue; liveOrders[o.location_id] = (liveOrders[o.location_id] || 0) + 1; }
  const openTables = {};
  for (const s of sess) { openTables[s.location_id] = (openTables[s.location_id] || 0) + 1; }

  const sumDays = (id, from, to) => {
    const a = emptySales();
    for (const [k, v] of Object.entries(byDay[id])) {
      if (!inDays(k, from, to)) continue;
      a.net += v.net; a.vat += v.vat; a.gross += v.gross; a.orders += v.orders; a.tips += v.tips;
    }
    return a;
  };

  const locations = opsIds.map((id) => {
    const d = plan[id], dd = byDay[id], range = d.range;
    const t = dd[d.today] || emptySales();
    const lwT = dd[d.lwToday] || { net: 0 };
    const forecast = fc[id]?.[d.today] ?? 0;
    const labour = labourToday[id] ?? 0;
    const wtd = r2(sumDays(id, d.wkStart, d.today).net);
    const lwWtd = r2(sumDays(id, d.lwStart, d.lwEnd).net);
    let periodForecast = 0;
    for (const [k, v] of Object.entries(fc[id] || {})) if (inDays(k, range.from, range.to)) periodForecast += v;
    return {
      ops_location_id: id, name: meta[id].name, currency: meta[id].currency, tz: meta[id].tz,
      today: {
        net_sales: r2(t.net), vat: r2(t.vat), gross_sales: r2(t.gross), orders: t.orders, tips: r2(t.tips),
        avg_check: t.orders ? r2(t.net / t.orders) : 0,
        forecast: r2(forecast), forecast_pct: forecast > 0 ? Math.round(t.net / forecast * 100) : null,
        labour: r2(labour), labour_pct: t.net > 0 ? r2(labour / t.net * 100) : null,
        last_week_sales: r2(lwT.net),
      },
      wtd: { net_sales: wtd, last_week_net_sales: lwWtd, vs_last_week_pct: vsPct(wtd, lwWtd) },
      live: { orders: liveOrders[id] || 0, tables: openTables[id] || 0 },
      top_items: topItems(todayItems[id]),
      range: { from: range.from, to: range.to, cmp_from: range.cmpFrom, cmp_to: range.cmpTo, days: range.days, cmp_days: range.cmpDays },
      period_totals: periodTotals({
        sales: sumDays(id, range.from, range.to),
        cmpNet: sumDays(id, range.cmpFrom, range.cmpTo).net,
        forecast: periodForecast,
        labour: labourPeriod[id] ?? 0,
      }),
      period_top_items: topItems(periodItems[id]),
    };
  }).sort((a, b) => b.period_totals.net_sales - a.period_totals.net_sales);

  const rollup = locations.reduce((acc, l) => ({
    locations: acc.locations + 1,
    net_sales: r2(acc.net_sales + l.today.net_sales),
    forecast: r2(acc.forecast + l.today.forecast),
    orders: acc.orders + l.today.orders,
    tips: r2(acc.tips + l.today.tips),
    labour: r2(acc.labour + l.today.labour),
    live_orders: acc.live_orders + l.live.orders,
    open_tables: acc.open_tables + l.live.tables,
    wtd_net: r2(acc.wtd_net + l.wtd.net_sales),
    wtd_last_week: r2(acc.wtd_last_week + l.wtd.last_week_net_sales),
  }), emptyRollup());
  rollup.forecast_pct = rollup.forecast > 0 ? Math.round(rollup.net_sales / rollup.forecast * 100) : null;
  rollup.labour_pct = rollup.net_sales > 0 ? r2(rollup.labour / rollup.net_sales * 100) : null;
  rollup.wtd_vs_last_week_pct = vsPct(rollup.wtd_net, rollup.wtd_last_week);
  rollup.period_totals = rollupTotals(locations.map((l) => l.period_totals));

  return { period, locations, rollup };
}
