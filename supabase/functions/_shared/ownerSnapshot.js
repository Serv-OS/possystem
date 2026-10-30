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
//   mix                           8 Oct 2026: item sales by sales group (Food, Drinks, Other
//                                 sales) with each group's share, and the comparison span's
//                                 share for the change in points (_shared/salesMix.js)
//   stock, stock_reason           v5.11.92 (multi site stock Drop 4a): the venue's stock block
//                                 from stock_report_league over the same business days, or null
//                                 and why ("the stock blocks" at the end of this file)
// Live orders and open tables are always "now".
//
// NET AND GROSS. 16 Oct 2026, Peter: "the owner app needs a switch to show net or gross sales".
// Every sales figure the app shows now comes both ways, from the same check parts
// (snapshotSales.js, tradingSales.checkSalesParts): gross is what the customer paid for the
// goods, VAT in, after discounts and comps, tips and service charge out, less refunds made on
// the day; net is gross less the VAT RECORDED on each sale and refund. The old net fields are
// unchanged; each gains a gross twin beside it (gross_sales, avg_check_gross, cmp_gross_sales,
// pct_gross, vs_cmp_pct_gross, wtd_gross, hours[].gross, week[].gross, order_types[].gross ...)
// and OWNER_FEATURES says 'gross'. Forecast % and labour % stay on net sales, as Daily trading.
// Gross here is Daily trading's Net sales plus VAT, which is its Gross takings LESS its Refunds
// column. It is NOT Daily trading's Gross column (that one is before refunds), so on a day with a
// refund the two differ by exactly that day's refunds; the app says 'after refunds' under it.
//
// A DAY IS THE VENUE'S BUSINESS DAY. 5 Oct 2026, Peter's decision on the Owner app day: "the
// BUSINESS day, same as Back Office, Daily trading and Xero." Until now a day here was midnight
// to midnight, so a late venue's 00:40 sale sat on a different day in the app and in Back Office.
// The day start is the Platform locations row's business_day_start (06:30 at five Coffee Boy
// venues, 00:00 at Barnsley Train Station; no row or no value is 06:00, as Back Office reads it
// in src/lib/locationTime.js getVenueClock). index.ts reads it beside the time zone and hands it
// in as meta[id].dayStart; _shared/businessDay.js turns it into instants, clock changes and all.
// Between midnight and the day start Today is the day still finishing, not an empty new one.
//
// THE COMPARISON. 5 Oct 2026, Peter: "same day last week, then for the week the week before and
// the month view the month before." The dates are periodRange's. Two things were added here:
//   * It is cut at the same time of day. At 10:00 on a Monday, Today was set against the whole
//     of last Monday, so every morning read deep red. The last day of the comparison span now
//     stops at the same clock time last week (or last month). A month whose comparison stops
//     early on a shorter last month has no matching day and is not cut. `range` says when the
//     cut is (cmp_until, cmp_time) so the screen can say "vs last Monday by 2pm".
//   * Each venue and the group carry a `compare` block with the reason word (_shared/
//     ownerPeriod.js compareOf, groupCompare). The week to date an older app shows under Today
//     is worked out by the same code, so the same days can never give two answers again
//     (the group card said about +529% on Today and +177% on This week for identical days).
//
// CURRENCIES ARE NEVER ADDED TOGETHER by a new app: rollup.by_currency is one total per
// currency. The plain rollup fields are still every venue added up, because the app live today
// reads them; rollup.currency is null when the venues do not share one.
//
// THE DETAIL CALL (buildOwnerDetail, below): the seven reports for one venue or the group.
//
// VOLUME. A busy Coffee Boy closes about 260 checks a day, about 7,800 a month, and This month
// reads two months of sales columns. So:
//   * sales columns for the days that are needed and no others: the period, its comparison
//     span (NOT the whole of last month) and the week to date, each day read once
//     (mergeDayRanges), from the venue's own day start to the next;
//   * items, the heavy column, for the period's own days only, never the comparison;
//   * every read pages, and each page is added up as it arrives (pagedEach): the function
//     holds running totals per day and per item, never the rows;
//   * This month is read a week at a time, the weeks side by side, with at most MAX_READS
//     requests in flight for the whole snapshot. The tills use the same PostgREST.
// A read that fails throws. It is never shown as a period of zero sales.
//
// DEMO HISTORY. 22 Oct 2026 (v5.11.99, Reports align): checks the demo files wrote are left out of
// every figure here by the one demo rule (_shared/demoHistory.js), as in Daily trading and Stock and
// GP, and a venue (or the detail) that had one says so: demo_left_out true ("Demo history left out").
// A real venue has none, so its figures are exactly what they were.
//
// PURE apart from the client it is handed; runs under node --test and in Deno.

import { pagedRows, pagedEach, limiter } from './pagedRows.js';
import { SALES_CHECK_COLS, emptySales, addCheckSales, addRefundSales, refundMadeAt } from './snapshotSales.js';
import { isVoidedCheck, checkTenderParts, MONEY_KINDS, GIFT_SALE_KIND } from './accountingDay.js';
import { checkSalesParts, refundSalesParts, chargedNothing, timesheetDayMs } from './tradingSales.js';
import { wallClock, wallTimeToInstant, businessDayOf, businessDayStartMs, dayStartMinutes, venueZone, DEFAULT_DAY_START, DEFAULT_VENUE_TZ } from './businessDay.js';
import {
  ownerPeriod, periodRange, addDays, weekStartOf, dayCount, inDays, mergeDayRanges, sliceDayRange, subtractDayRange,
  addCheckItems, topItems, rankItems, periodTotals, rollupTotals, compareOf, groupCompare, hhmm, r2,
} from './ownerPeriod.js';
import { makeMixResolver, categoriesOfSite, newMix, addCheckToMix, mixView, mixRollup, catFamilyKey, nameAcross } from './salesMix.js';
import { officeReachesVenue } from './stockOfficeReach.js';
import { withoutDemoRows, isDemoCheck } from './demoHistory.js';

/** Requests in flight at once, for the whole snapshot. */
export const MAX_READS = 8;
/** What this function can answer. An app checks for a name here before it shows the screen for it. */
export const OWNER_API = 2;
// 16 Oct 2026: 'gross' = every sales figure the app shows also comes including VAT (the Net /
// Gross switch). An app looks for it before it offers Gross, and shows net with a word if not.
// v5.11.92 (multi site stock Drop 4a): 'stock' = each venue carries a stock block (or a reason it
// has none) and the venue detail a Stock card, from the head office report functions (below).
export const OWNER_FEATURES = ['period', 'business_day', 'compare', 'by_currency', 'detail', 'mix', 'gross', 'stock'];
// 8 Oct 2026, Sales mix: the periods whose comparison span is read WITH items, for each group's
// change in share ("Food +3 pts"). Today adds a day of the heavy column, a week up to seven, a
// month up to 31 per venue. The coordinator may drop 'month' after a live timing: a period left
// out sends cmp_total null and the app shows no points for it.
export const MIX_CMP_PERIODS = ['today', 'week', 'month'];
// Today and This week need at most 14 days of sales (Monday of last week to today): one
// window per venue, as before the filters. This month is cut into weeks read side by side.
const SLICE_DAYS = { today: 14, week: 14, month: 7 };
const LIVE_DONE = new Set(['collected', 'cancelled', 'canceled', 'rejected', 'refunded', 'completed', 'done', 'void', 'voided']);
const QUARTER_HOUR = 900000;
const MINUTE = 60000;
const DAY_MS = 86400000;
// A refund counts on the day it was MADE, so the snapshot and the detail call also look at older
// checks that carry one (8 Oct 2026 review: the snapshot too, so the Today tile agrees with its own
// detail screen). The same reach as the Daily trading report (trading-report REFUND_LOOKBACK_DAYS).
const REFUND_LOOKBACK_DAYS = 400;
const TOP_N = 20;

export function emptyRollup() {
  return {
    locations: 0, net_sales: 0, forecast: 0, orders: 0, tips: 0, labour: 0, live_orders: 0, open_tables: 0, wtd_net: 0, wtd_last_week: 0,
    // 16 Oct 2026, the Net / Gross switch: the same figures including VAT.
    gross_sales: 0, vat: 0, wtd_gross: 0, wtd_last_week_gross: 0,
  };
}

/**
 * Each venue's name, clock, day start and currency, from the rows index.ts reads.
 *   platformRows  Platform locations: id, ops_location_id, name, timezone, currency, business_day_start
 *   settingsRows  Ops wf_venue_settings: location_id, currency
 * CURRENCY. 5 Oct 2026: The Cabin (a dollar venue) was labelled GBP. The function started every
 * venue on 'GBP' and only wf_venue_settings could change it, and that table has rows for two
 * venues and defaults to GBP itself. The Platform locations row is the authority (it is what
 * Back Office, the tills and Xero use), so it wins; the workforce setting is only a fallback
 * for a venue with no Platform row, and GBP only when nothing says anything.
 * @returns {Record<string, { name: string, tz: string, currency: string, dayStart: string, found: boolean }>}
 */
export function venueMeta(opsIds, platformRows, settingsRows) {
  const meta = {};
  const wanted = new Set(opsIds);
  const wf = {};
  for (const v of settingsRows || []) if (v?.location_id && v.currency) wf[v.location_id] = String(v.currency).trim().toUpperCase();
  // A row matched on ops_location_id beats one matched on its own id (legacy rows where the two are the same).
  const rows = [...(platformRows || [])].sort((a, b) => (a?.ops_location_id ? 0 : 1) - (b?.ops_location_id ? 0 : 1));
  for (const p of rows) {
    const k = p?.ops_location_id && wanted.has(p.ops_location_id) ? p.ops_location_id : p?.id;
    if (!k || !wanted.has(k) || meta[k]) continue;
    meta[k] = {
      name: p.name || 'Location', tz: p.timezone || DEFAULT_VENUE_TZ,
      currency: String(p.currency || wf[k] || 'GBP').trim().toUpperCase(),
      dayStart: p.business_day_start || DEFAULT_DAY_START, found: true,
    };
  }
  for (const id of opsIds) {
    if (!meta[id]) meta[id] = { name: 'Location', tz: DEFAULT_VENUE_TZ, currency: wf[id] || 'GBP', dayStart: DEFAULT_DAY_START, found: false };
  }
  return meta;
}

// The venue's business day of an instant. A day starts on a whole minute, and every time zone
// sits a whole number of quarter hours from UTC, so the day is the same right through a UTC
// quarter hour when the start is on one (06:30, 00:00), and right through a minute otherwise:
// one lookup per step, not one Intl call per check (60,000 of them in a month across a group).
function dayKeyer(tz, dayStart) {
  const step = dayStartMinutes(dayStart) % 15 === 0 ? QUARTER_HOUR : MINUTE;
  const seen = new Map();
  return (ms) => {
    const k = Math.floor(ms / step);
    let d = seen.get(k);
    if (!d) seen.set(k, (d = businessDayOf(k * step, tz, dayStart)));
    return d;
  };
}

// The hour on the venue's wall clock (0 to 23), looked up once per UTC quarter hour.
function hourKeyer(tz) {
  const seen = new Map();
  return (ms) => {
    const k = Math.floor(ms / QUARTER_HOUR);
    let h = seen.get(k);
    if (h === undefined) seen.set(k, (h = Math.floor(wallClock(k * QUARTER_HOUR, tz).minutes / 60)));
    return h;
  };
}

/**
 * Where a comparison span stops on its last day: the same clock time as now, so a morning is
 * set against a morning. null when the span's last day is not today's counterpart (a month
 * whose comparison stops early on a shorter last month): then whole days are compared.
 * After midnight on a late venue the business day is still yesterday, and so is the cut.
 * @returns {{ day: string, untilMs: number, time: string } | null}
 */
export function cmpCut({ range, today, nowMs, tz, dayStart }) {
  if (range.cmpDays !== range.days) return null;
  const wall = wallClock(nowMs, tz);
  const ahead = Math.max(0, dayCount(today, wall.ymd) - 1);
  const lo = businessDayStartMs(range.cmpTo, tz, dayStart), hi = businessDayStartMs(addDays(range.cmpTo, 1), tz, dayStart);
  const at = wallTimeToInstant(addDays(range.cmpTo, ahead), wall.minutes, tz) + (((nowMs % MINUTE) + MINUTE) % MINUTE);
  return { day: range.cmpTo, untilMs: Math.min(Math.max(at, lo), hi), time: hhmm(wall.minutes) };
}

// One venue's dates: today, the week to date the app has always shown, and the period.
function venuePlan(m, nowMs, period) {
  const tz = venueZone(m.tz), dayStart = m.dayStart || DEFAULT_DAY_START;
  const dayOf = dayKeyer(tz, dayStart);
  const today = dayOf(nowMs);
  const wkStart = weekStartOf(today);
  const lwStart = addDays(wkStart, -7);
  const range = periodRange(period, today);
  const week = period === 'week' ? range : periodRange('week', today);
  const cutArgs = { today, nowMs, tz, dayStart };
  const startOf = (ymd) => businessDayStartMs(ymd, tz, dayStart);
  return {
    tz, dayStart, dayOf, today, lwToday: addDays(today, -7), wkStart, lwStart, range, week, startOf,
    // The week and Today stop at the same instant (seven days back); a month has its own.
    cut: cmpCut({ range, ...cutArgs }), weekCut: cmpCut({ range: week, ...cutArgs }),
    // A day in two of these is read once.
    salesDays: mergeDayRanges([{ from: lwStart, to: today }, { from: range.from, to: range.to }, { from: range.cmpFrom, to: range.cmpTo }]),
    startMs: startOf(range.from), endMs: startOf(addDays(today, 1)),
  };
}

// Day start to day start on the venue's own clock, so two windows never share a check.
const windowsOf = (p, ranges, sliceDays) => ranges
  .flatMap((r) => sliceDayRange(r.from, r.to, sliceDays))
  .map((s) => ({ from: new Date(p.startOf(s.from)).toISOString(), to: new Date(p.startOf(addDays(s.to, 1))).toISOString() }));

const rangeOut = (range, cut) => ({
  from: range.from, to: range.to, cmp_from: range.cmpFrom, cmp_to: range.cmpTo, days: range.days, cmp_days: range.cmpDays,
  // Where the comparison stops on its last day: the instant, and the venue's clock time for the words.
  cmp_until: cut ? new Date(cut.untilMs).toISOString() : null, cmp_time: cut ? cut.time : null,
});

/** A day with fewer sales than this is somebody trying the till, not a day's trading. */
export const OPENING_MIN_SALES = 10;
// A venue's oldest checks are read this many at a time to find the day it opened, and at most
// this many times (300 checks: far more test sales than any site rings before it opens).
const FIRST_SALE_ROWS = 60;
const FIRST_SALE_PAGES = 5;

/** True once some day among these checks has OPENING_MIN_SALES sales or more that are not voided. */
export function hasOpeningDay(rows, dayOf) {
  const perDay = new Map();
  for (const c of rows || []) {
    const ms = Date.parse(c?.closed_at);
    if (!Number.isFinite(ms) || isVoidedCheck(c)) continue;
    const d = dayOf(ms);
    const n = (perDay.get(d) || 0) + 1;
    if (n >= OPENING_MIN_SALES) return true;
    perDay.set(d, n);
  }
  return false;
}

/**
 * The day a venue started trading, from its oldest checks (oldest first).
 * 5 Oct 2026: Huddersfield rang up three £0 checks on 27 Sep and five worth £8 on 28 Sep, then
 * opened on the 29th with 247 sales. Those test sales made it "trading" on Monday 28 Sep, so
 * a week later Today read about +22,000% against £7. A venue opens on its first day with
 * OPENING_MIN_SALES sales or more. A venue that has never had such a day among its oldest
 * checks (a very quiet one, or one still being set up) opens on its first sale.
 * Voided checks never count. null when it has never sold anything.
 * @param {any[]} rows   closed_checks rows: closed_at, status, voided
 * @param {(ms: number) => string} dayOf  the venue's business day of an instant
 */
export function firstTradingDay(rows, dayOf) {
  const perDay = new Map();
  for (const c of rows || []) {
    const ms = Date.parse(c?.closed_at);
    if (!Number.isFinite(ms) || isVoidedCheck(c)) continue;
    const d = dayOf(ms);
    perDay.set(d, (perDay.get(d) || 0) + 1);
  }
  const days = [...perDay.keys()].sort();
  return days.find((d) => perDay.get(d) >= OPENING_MIN_SALES) ?? days[0] ?? null;
}

// One small read per venue: its oldest checks that are not voided, for firstTradingDay.
// 5 Oct 2026: the read used to take the oldest 60 checks, voided ones included, and stop. A
// new site that rang up and voided 60 training tickets before it opened then had no first day
// at all and said "New" for ever; one with 60 small test sales fell back to its first test
// day, the Huddersfield percent again. So the database leaves the voided ones out (every
// voided row on the live table has voided = true; firstTradingDay still drops any other), and
// when no day in what was read is a real day's trading the next checks are read too.
async function firstSaleDay(ops, id, p, gate) {
  const rows = [];
  for (let page = 0; page < FIRST_SALE_PAGES; page += 1) {
    const { data, error } = await gate(() => ops.from('closed_checks').select('id, closed_at, status, voided')
      .eq('location_id', id).not('voided', 'is', true).order('closed_at').order('id')
      .range(page * FIRST_SALE_ROWS, (page + 1) * FIRST_SALE_ROWS - 1));
    if (error) throw new Error(`Could not read the first sale: ${error.message}`);
    // v5.11.99: a demo check is never the first sale (demoHistory.js).
    rows.push(...(data ?? []).filter((r) => !isDemoCheck(r)));
    if ((data ?? []).length < FIRST_SALE_ROWS || hasOpeningDay(rows, p.dayOf)) break;
  }
  return firstTradingDay(rows, p.dayOf);
}

// 29 Oct 2026 (v5.11.118, Drop C): a gift card sold at the till is a line of kind 'gift_card_sale'
// inside `items`, the heavy column the sales windows leave out on purpose (8 Oct 2026). Peter's
// call: money in, not sales. So each sales window first reads ONLY the checks that sold one
// (items @> [{ kind: 'gift_card_sale' }]: a handful a day), id and items, and those lines are put
// onto the sales rows before the one sales rule reads them (snapshotSales.addCheckSales), so net
// sales leave the gift money out here as in every report. Rows read with items already keep theirs.
// 30 Oct 2026 (5.11.122): a STRING. supabase-js turns a JavaScript array into a Postgres array literal
// ({[object Object]}), and the Owner app said "Could not read gift cards sold: invalid input syntax
// for type json". The jsonb containment filter needs the JSON text (as adyen-webhook's refunds read).
const GIFT_SALE_FILTER = JSON.stringify([{ kind: GIFT_SALE_KIND }]);
async function giftLinesOf(ops, id, windows, opts) {
  const map = new Map();
  const keep = (rows) => { for (const r of rows) map.set(r.id, r.items); };
  await Promise.all(windows.map((w) => pagedEach('gift cards sold', () => ops.from('closed_checks').select('id, items')
    .eq('location_id', id).contains('items', GIFT_SALE_FILTER).gte('closed_at', w.from).lt('closed_at', w.to).order('closed_at').order('id'), withoutDemoRows((rows) => keep(rows)), opts)));
  return map;
}
const withGiftLines = (map, rows) => (map.size ? rows.map((c) => (c && map.has(c.id) && !Array.isArray(c.items) ? { ...c, items: map.get(c.id) } : c)) : rows);

const addInto = (a, v) => {
  a.net += v.net; a.vat += v.vat; a.gross += v.gross; a.orders += v.orders; a.tips += v.tips;
  a.gift_sold = (a.gift_sold || 0) + (v.gift_sold || 0);
  a.refunds = (a.refunds || 0) + (v.refunds || 0); a.refund_vat = (a.refund_vat || 0) + (v.refund_vat || 0);
  a.vat_missing = (a.vat_missing || 0) + (v.vat_missing || 0);
  if (Array.isArray(v.vat_missing_refs) && v.vat_missing_refs.length) a.vat_missing_refs = [...(a.vat_missing_refs || []), ...v.vat_missing_refs].slice(0, 25);
};

/**
 * @param {object} a
 * @param {any} a.ops  the Ops database client (service role)
 * @param {string[]} a.opsIds  the venues this login may see
 * @param {Record<string, { name: string, tz: string, currency: string, dayStart?: string }>} a.meta
 * @param {Date} [a.now]
 * @param {string} [a.period]  'today' | 'week' | 'month'
 * @param {number} [a.maxReads]
 * @returns {Promise<{ period: string, locations: any[], rollup: any }>}
 */
export async function buildOwnerSnapshot({ ops, opsIds, meta, now = new Date(), period: asked, maxReads = MAX_READS }) {
  const period = ownerPeriod(asked);
  if (!opsIds.length) return { period, locations: [], rollup: { ...rollupOf([]), currency: null, currencies: [], by_currency: [] } };
  const nowMs = now.getTime();

  const plan = {};
  for (const id of opsIds) plan[id] = venuePlan(meta[id], nowMs, period);

  const byDay = {};       // venue -> business day -> sales
  const cuts = {};        // venue -> comparison day -> { untilMs, sales }: that day up to the same time
  const todayItems = {};  // venue -> Map of item name -> { name, qty, rev }
  const periodItems = {};
  const periodMix = {};   // venue -> the period's item sales by sales group (8 Oct 2026, _shared/salesMix.js)
  const cmpMix = {};      // venue -> the comparison span's, cut at the same time of day
  for (const id of opsIds) {
    byDay[id] = {}; todayItems[id] = new Map(); periodItems[id] = new Map();
    periodMix[id] = newMix(); cmpMix[id] = newMix();
    cuts[id] = new Map();
    for (const c of [plan[id].cut, plan[id].weekCut]) if (c && !cuts[id].has(c.day)) cuts[id].set(c.day, { untilMs: c.untilMs, sales: emptySales() });
  }

  // One queue for every request this snapshot makes.
  const gate = limiter(maxReads);
  const opts = { gate };
  // v5.11.99: the venues a demo check was left out of (demoHistory.js), for demo_left_out.
  const demoLeft = {};
  const markDemo = (id) => () => { demoLeft[id] = true; };
  // 8 Oct 2026, Sales mix (D2): every venue's menu categories and its Xero mapping, read before
  // the checks, make ONE resolver per venue, the very resolver the Back Office report and the
  // Xero invoice build, so an item sits in the same group on every surface. A venue with no
  // xero_config row resolves from its categories alone; a category with no group is Other sales.
  const [catRows, cfgRows] = await Promise.all([
    gate(() => pagedRows('menu categories', () => ops.from('menu_categories').select('id, location_id, parent_id, label, accounting_group, master_id').in('location_id', opsIds).order('id'))),
    gate(() => pagedRows('sales groups', () => ops.from('xero_config').select('location_id, mapping').in('location_id', opsIds).order('location_id'))),
  ]);
  const resolver = mixResolvers(opsIds, catRows, cfgRows);

  // What customers paid for the goods, VAT apart; voided checks count for nothing
  // (_shared/snapshotSales.js). Bucketed by the venue's business day the check closed in.
  // 8 Oct 2026 (the VAT audit): a refund comes OFF on the business day it was MADE, with its
  // VAT (snapshotSales.addRefundSales, the rule Daily trading and Xero use), so the app's VAT
  // and net sales agree with them. 8 Oct 2026 (review): refunds on the checks these windows read
  // AND on older checks that carry one (refundsOf below, the same 400 day reach as Daily trading
  // and the detail call), so a sale from three weeks ago refunded today comes off today's tile
  // too. Each refund counts once whichever read lands first (seenRefund).
  const seenRefund = new Set();
  const placeRefunds = (id, c) => {
    const dd = byDay[id], dayOf = plan[id].dayOf, cc = cuts[id];
    for (const [i, e] of (Array.isArray(c.refunds) ? c.refunds : []).entries()) {
      if (!e || typeof e !== 'object') continue;
      const key = `${c.id}|${e.id ?? i}`;
      if (seenRefund.has(key)) continue;
      seenRefund.add(key);
      const at = refundMadeAt(e, c);
      if (at == null) continue;
      const rd = dayOf(at);
      addRefundSales((dd[rd] ??= emptySales()), e, c);
      const rc = cc.get(rd);
      if (rc && at < rc.untilMs) addRefundSales(rc.sales, e, c);
    }
  };
  const addSales = (id, rows) => {
    const dd = byDay[id], dayOf = plan[id].dayOf, cc = cuts[id];
    for (const c of rows) {
      const ms = Date.parse(c.closed_at);
      if (!Number.isFinite(ms)) continue;
      const d = dayOf(ms);
      addCheckSales((dd[d] ??= emptySales()), c);
      const cut = cc.get(d);
      if (cut && ms < cut.untilMs) addCheckSales(cut.sales, c);
      placeRefunds(id, c);
    }
  };
  // Older checks that carry a refund: only their refunds are placed, never their sales.
  const addOlderRefunds = (id, rows) => { for (const c of rows) placeRefunds(id, c); };
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
      addCheckToMix(periodMix[id], c, resolver[id]);
    }
  };
  // The comparison span's lines, for each group's change in share: whole days up to its last,
  // then that day up to the same time as now (the rule cmpSales works to, so "Food +3 pts" sits
  // beside a percent worked out over the same hours).
  const addCmpItems = (id, rows) => {
    const { dayOf, range, cut } = plan[id];
    for (const c of rows) {
      if (isVoidedCheck(c) || !Array.isArray(c.items)) continue;
      const ms = Date.parse(c.closed_at);
      if (!Number.isFinite(ms)) continue;
      const d = dayOf(ms);
      if (!inDays(d, range.cmpFrom, range.cmpTo)) continue;
      if (cut && d === cut.day && ms >= cut.untilMs) continue;
      addCheckToMix(cmpMix[id], c, resolver[id]);
    }
  };

  // 29 Oct 2026: the gift cards sold (giftLinesOf, above) are read first and put onto the rows.
  const salesOf = async (id) => {
    const windows = windowsOf(plan[id], plan[id].salesDays, SLICE_DAYS[period]);
    const gifts = await giftLinesOf(ops, id, windows, opts);
    return Promise.all(windows.map((w) =>
      pagedEach('closed checks', () => ops.from('closed_checks').select(SALES_CHECK_COLS)
        .eq('location_id', id).gte('closed_at', w.from).lt('closed_at', w.to).order('closed_at').order('id'), withoutDemoRows((rows) => addSales(id, withGiftLines(gifts, rows)), markDemo(id)), opts)));
  };
  // Items for the period's own days only (today's, under Today): they are the heavy column.
  const itemsOf = (id) => Promise.all(windowsOf(plan[id], [{ from: plan[id].range.from, to: plan[id].today }], SLICE_DAYS[period]).map((w) =>
    pagedEach('items sold', () => ops.from('closed_checks').select('id, closed_at, status, voided, items')
      .eq('location_id', id).gte('closed_at', w.from).lt('closed_at', w.to).order('closed_at').order('id'), withoutDemoRows((rows) => addItems(id, rows), markDemo(id)), opts)));
  // 8 Oct 2026: the comparison span's items too, for the mix points, under MIX_CMP_PERIODS. The
  // span never overlaps the period, so no row is read twice with the heavy column; the same rows
  // were read with the sales columns by salesOf, which is cheap.
  const cmpItemsOf = (id) => (!MIX_CMP_PERIODS.includes(period) ? Promise.resolve([]) : Promise.all(windowsOf(plan[id], [{ from: plan[id].range.cmpFrom, to: plan[id].range.cmpTo }], SLICE_DAYS[period]).map((w) =>
    pagedEach('items sold', () => ops.from('closed_checks').select('id, closed_at, status, voided, items')
      .eq('location_id', id).gte('closed_at', w.from).lt('closed_at', w.to).order('closed_at').order('id'), withoutDemoRows((rows) => addCmpItems(id, rows), markDemo(id)), opts))));
  // 8 Oct 2026 (review): checks closed before the sales windows that carry a refund (few: a handful
  // a day at most), back the same 400 days Daily trading reaches, so a refund made in the period on
  // an older sale comes off the day it was made here too. The sales windows cover their own.
  const refundsOf = (id) => pagedEach('older refunds', () => ops.from('closed_checks').select(SALES_CHECK_COLS)
    .eq('location_id', id).gte('closed_at', new Date(plan[id].startOf(least(plan[id].salesDays.map((d) => d.from))) - REFUND_LOOKBACK_DAYS * DAY_MS).toISOString())
    .lt('closed_at', new Date(plan[id].startOf(least(plan[id].salesDays.map((d) => d.from)))).toISOString()).neq('refunds', '[]')
    .order('closed_at').order('id'), withoutDemoRows((rows) => addOlderRefunds(id, rows), markDemo(id)), opts);

  // Forecasts and timesheets for every venue in one read each: the widest dates any venue
  // needs, then each row is kept only if it falls in its own venue's period. A timesheet counts
  // on the business day most of the shift falls in (timesheetDayMs, as Daily trading), so the
  // read reaches a day either side: an opener clocks in before the day starts.
  const all = opsIds.map((id) => plan[id]);
  const least = (xs) => xs.reduce((a, b) => (b < a ? b : a));
  const most = (xs) => xs.reduce((a, b) => (b > a ? b : a));
  const fcFrom = least(all.map((p) => p.range.from)), fcTo = most(all.map((p) => p.today));
  const tsFrom = new Date(least(all.map((p) => p.startMs)) - DAY_MS).toISOString(), tsTo = new Date(most(all.map((p) => p.endMs)) + DAY_MS).toISOString();

  const [, , , , firstDays, fcRows, ts, oq, sess, stockBy] = await Promise.all([
    Promise.all(opsIds.map(salesOf)),
    Promise.all(opsIds.map(itemsOf)),
    Promise.all(opsIds.map(cmpItemsOf)),
    Promise.all(opsIds.map(refundsOf)),
    Promise.all(opsIds.map((id) => firstSaleDay(ops, id, plan[id], gate))),
    gate(() => pagedRows('forecasts', () => ops.from('wf_sales_forecast').select('location_id, forecast_date, amount').in('location_id', opsIds).gte('forecast_date', fcFrom).lte('forecast_date', fcTo).order('id'))),
    gate(() => pagedRows('timesheets', () => ops.from('wf_timesheets').select('location_id, clock_in, clock_out, pay_amount, status').in('location_id', opsIds).gte('clock_in', tsFrom).lt('clock_in', tsTo).order('clock_in').order('id'))),
    gate(() => pagedRows('open orders', () => ops.from('order_queue').select('location_id, status').in('location_id', opsIds).order('location_id').order('ref'))),
    gate(() => pagedRows('open tables', () => ops.from('active_sessions').select('location_id').in('location_id', opsIds).order('id'))),
    // v5.11.92 (multi site stock Drop 4a): the stock block per venue, from stock_report_league as
    // the service role, over the period's business days. Never throws: a venue without a true
    // figure carries stock null and the reason.
    stockBlocks({ ops, opsIds, meta, plan, gate }),
  ]);
  const firstDay = Object.fromEntries(opsIds.map((id, i) => [id, firstDays[i]]));

  // Forecast per venue per day
  const fc = {};
  for (const f of fcRows) { (fc[f.location_id] ??= {})[String(f.forecast_date).slice(0, 10)] = Number(f.amount) || 0; }

  // Actual labour (approved or paid timesheets) on the business day of the shift
  const labourToday = {}, labourPeriod = {};
  for (const t of ts) {
    if (!['approved', 'paid'].includes(t.status)) continue;
    const p = plan[t.location_id];
    const ms = timesheetDayMs(t);
    if (!p || ms == null) continue;
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
    for (const [k, v] of Object.entries(byDay[id])) if (inDays(k, from, to)) addInto(a, v);
    return a;
  };
  // The comparison span: whole days up to its last, then that day up to the same time as now.
  const cmpSales = (id, range, cut) => {
    if (!cut) return sumDays(id, range.cmpFrom, range.cmpTo);
    const a = sumDays(id, range.cmpFrom, addDays(range.cmpTo, -1));
    addInto(a, cuts[id].get(cut.day).sales);
    return a;
  };

  const locations = opsIds.map((id) => {
    const d = plan[id], dd = byDay[id], range = d.range;
    const t = dd[d.today] || emptySales();
    const lwT = dd[d.lwToday] || { net: 0, gross: 0 };
    const forecast = fc[id]?.[d.today] ?? 0;
    const labour = labourToday[id] ?? 0;
    const first = firstDay[id];
    const periodSales = sumDays(id, range.from, range.to);
    // 16 Oct 2026: gross (including VAT) rides beside net through every comparison, from the
    // same days and the same cut, so the Net / Gross switch never works a figure out itself.
    const cmpP = cmpSales(id, range, d.cut);
    const compare = compareOf({ net: periodSales.net, cmpNet: cmpP.net, gross: periodSales.gross, cmpGross: cmpP.gross, firstSaleDay: first, cmpFrom: range.cmpFrom });
    // The week to date an older app shows under Today: the same sum as the week's own compare.
    const wkNow = period === 'week' ? null : sumDays(id, d.week.from, d.week.to), wkThen = period === 'week' ? null : cmpSales(id, d.week, d.weekCut);
    const week = period === 'week' ? compare
      : compareOf({ net: wkNow.net, cmpNet: wkThen.net, gross: wkNow.gross, cmpGross: wkThen.gross, firstSaleDay: first, cmpFrom: d.week.cmpFrom });
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
        // The same weekday last week up to the same time as now (last_week_sales is the whole day).
        last_week_sales_by_now: r2(cuts[id].get(d.lwToday)?.sales.net ?? lwT.net),
        // 16 Oct 2026, the Net / Gross switch: the same three including VAT.
        avg_check_gross: t.orders ? r2(t.gross / t.orders) : 0,
        last_week_gross_sales: r2(lwT.gross || 0),
        last_week_gross_sales_by_now: r2(cuts[id].get(d.lwToday)?.sales.gross ?? (lwT.gross || 0)),
        // 8 Oct 2026: refunds made today (off net_sales and vat above) and sales with no VAT recorded, named.
        ...(t.refunds || t.vat_missing ? { refunds: r2(t.refunds || 0), refund_vat: r2(t.refund_vat || 0), vat_missing: t.vat_missing || 0, vat_missing_refs: t.vat_missing_refs || [] } : {}),
        // 29 Oct 2026 (Drop C): gift cards sold today, money in that is outside net_sales, vat and
        // gross_sales (the one sales rule, tradingSales.checkSalesParts giftCardsSold). Sent when any were sold.
        ...(t.gift_sold ? { gift_cards_sold: r2(t.gift_sold) } : {}),
      },
      wtd: {
        net_sales: week.net_sales, last_week_net_sales: week.cmp_net_sales, vs_last_week_pct: week.pct,
        gross_sales: week.gross_sales, last_week_gross_sales: week.cmp_gross_sales, vs_last_week_pct_gross: week.pct_gross,
      },
      live: { orders: liveOrders[id] || 0, tables: openTables[id] || 0 },
      top_items: topItems(todayItems[id]),
      range: rangeOut(range, d.cut),
      period_totals: periodTotals({
        sales: periodSales, cmpNet: compare.cmp_net_sales, cmpGross: compare.cmp_gross_sales, forecast: periodForecast, labour: labourPeriod[id] ?? 0, reason: compare.reason,
      }),
      period_top_items: topItems(periodItems[id]),
      // 8 Oct 2026, Sales mix (D4a): item sales by sales group for the period, with the
      // comparison span's share and the change in points where that span was read (MIX_CMP_PERIODS).
      mix: mixView(periodMix[id], MIX_CMP_PERIODS.includes(period) ? cmpMix[id] : null, resolver[id]),
      // 5 Oct 2026: the business day start this venue's days were cut on, its first trading
      // day, and the comparison with its reason word, for the period and for the week to date.
      day_start: hhmm(dayStartMinutes(d.dayStart)), first_sale_date: first,
      compare: { period, ...compare },
      week_compare: { period: 'week', ...week },
      week_range: rangeOut(d.week, d.weekCut),
      // v5.11.92 (multi site stock Drop 4a): the Stock line's figures, or null and why.
      stock: stockBy[id]?.stock ?? null,
      stock_reason: stockBy[id]?.stock_reason ?? null,
      // v5.11.99: true when demo checks were left out of this venue's figures.
      demo_left_out: !!demoLeft[id],
    };
  }).sort((a, b) => b.period_totals.net_sales - a.period_totals.net_sales);

  // One total per currency; the plain fields are every venue added up, as the live app reads them.
  const currencies = [...new Set(locations.map((l) => l.currency))].sort();
  const rollup = rollupOf(locations);
  rollup.currency = currencies.length === 1 ? currencies[0] : null;
  rollup.currencies = currencies;
  rollup.by_currency = currencies.map((c) => ({ currency: c, ...rollupOf(locations.filter((l) => l.currency === c)) }));
  // The plain rollup's mix would add pounds to dollars: it is kept only when every venue shares
  // a currency (the one group card then reads the whole rollup); each by_currency entry has its own.
  if (!rollup.currency) rollup.mix = null;

  return { period, locations, rollup };
}

// The group card for a set of venues. The week to date percent and the period percent come
// from the same like for like sum (groupCompare).
function rollupOf(locations) {
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
    gross_sales: r2(acc.gross_sales + (l.today.gross_sales || 0)),
    vat: r2(acc.vat + (l.today.vat || 0)),
    wtd_gross: r2(acc.wtd_gross + (l.wtd.gross_sales || 0)),
    wtd_last_week_gross: r2(acc.wtd_last_week_gross + (l.wtd.last_week_gross_sales || 0)),
    // 29 Oct 2026: gift cards sold today across the venues, present only when any were sold.
    ...(acc.gift_cards_sold || l.today.gift_cards_sold ? { gift_cards_sold: r2((acc.gift_cards_sold || 0) + (l.today.gift_cards_sold || 0)) } : {}),
  }), emptyRollup());
  rollup.forecast_pct = rollup.forecast > 0 ? Math.round(rollup.net_sales / rollup.forecast * 100) : null;
  rollup.labour_pct = rollup.net_sales > 0 ? r2(rollup.labour / rollup.net_sales * 100) : null;
  // 5 Oct 2026: this was all venues this week against all venues last week, the one line the
  // 2 Oct like for like fix missed. A venue that was not trading then is left out on both sides.
  const week = groupCompare(locations.map((l) => l.week_compare));
  rollup.wtd_vs_last_week_pct = week.pct;
  rollup.wtd_vs_last_week_pct_gross = week.pct_gross ?? null;
  const compares = locations.map((l) => l.compare);
  rollup.period_totals = rollupTotals(locations.map((l) => l.period_totals), compares);
  rollup.compare = groupCompare(compares);
  rollup.week_compare = week;
  // 8 Oct 2026: the venues' sales mix added per group (names from the first venue that names a
  // key, "Other sales" last, shares and points worked out again from the sums). rollupOf runs per
  // currency; the plain rollup's mix is set null in buildOwnerSnapshot when currencies differ.
  rollup.mix = mixRollup(locations.map((l) => l.mix));
  return rollup;
}

// One Sales mix resolver per venue (8 Oct 2026, D2): makeGroupResolver over the venue's OWN
// menu_categories rows plus its xero_config mapping, exactly what the Back Office report and
// the Xero daily invoice build, so an item is in the same group on every surface. A venue with
// no xero_config row, or a null mapping, resolves from its categories alone (D6).
function mixResolvers(ids, catRows, cfgRows) {
  const out = {};
  for (const id of ids) {
    const cfg = (cfgRows || []).find((r) => String(r?.location_id) === String(id));
    out[id] = makeMixResolver(cfg?.mapping && typeof cfg.mapping === 'object' ? cfg.mapping : {}, categoriesOfSite(catRows, id));
  }
  return out;
}

// ── the detail call ──────────────────────────────────────────────────────────
//
// 5 Oct 2026: a venue card did nothing when tapped. The detail call answers seven small
// reports for ONE venue, or for the group (every venue of one currency added up), for the
// chosen period, on each venue's own business day:
//   hours       sales by hour of the venue's clock, with the comparison span's hours beside
//               them (whole days, NOT cut at now: the faint line shows what the rest of the
//               day looked like last time)
//   week        Monday to Sunday, this week against last week (whatever the period)
//   payments    what each kind of tender took for goods, tax in, tips and service out, so the
//               money kinds add up to gross sales. Loyalty and promo credit are listed, marked
//               money: false (they are discounts, never takings).
//   order_types dine in, takeaway, drive thru ...; channels: till, kiosk, QR, online ...
//   exceptions  discounts, voids and refunds: how many, how much, the top reasons and who
//               approved. A refund counts on the day it was MADE (as Daily trading).
//               VOID REASONS ARE NOT IN THE DATABASE: closed_checks has no column for the
//               reason or the manager (the till keeps them in its own void log), so voids come
//               with a count and a value and `reasons: null`, never a made up reason.
//   items       the top 20 by quantity and the top 20 by pounds (a line's price already holds its paid extras), each
//               with its category, and the categories added up
//   labour      approved and paid timesheets against net sales, with the venue's own target.
//               null when the period has no timesheets, so the screen hides it.
//   mix         8 Oct 2026: item sales by sales group for the scope, each group's share, the
//               comparison span's share and the change in points, and the top three categories
//               inside each group (merged across venues by master id for the group).
// Reads: the period's own days once, with the heavy columns; the comparison span with the sales
// columns AND items (for the mix points, cut at the same time of day as the percent); every
// other day that is needed (this week and last) with the sales columns only; older checks only
// where they carry a refund. Everything pages and nothing is held but running totals.

// What the detail reads for the period's own days, on top of the sales columns.
const DETAIL_CHECK_COLS = `${SALES_CHECK_COLS}, order_type, refunds, items`;
// closed_checks.source also carries payment path stamps (pos_send_to_terminal, pax_table_pay):
// those are ordinary till sales. Only a real customer surface is its own channel, the rule the
// Back Office Order sources report uses.
const CHANNELS = new Set(['kiosk', 'online', 'qr', 'catering', 'mobile']);
const channelOf = (c) => {
  const s = String(c?.source || '').toLowerCase();
  if (s === 'hubrise' || s === 'ezcater') return 'delivery';
  return CHANNELS.has(s) ? s : 'pos';
};
const text = (v) => (typeof v === 'string' ? v.trim() : v && typeof v === 'object' && typeof v.name === 'string' ? v.name.trim() : '');
const bump = (map, key, amount) => {
  let e = map.get(key);
  if (!e) map.set(key, (e = { count: 0, amount: 0 }));
  e.count += 1; e.amount += amount;
};
const topOf = (map, label, n = 5) => [...map.entries()].sort((a, b) => b[1].amount - a[1].amount || b[1].count - a[1].count).slice(0, n)
  .map(([k, v]) => ({ [label]: k, count: v.count, amount: r2(v.amount) }));
// What a voided check was worth. A void tombstone books total 0 on purpose (no report counts it
// as a sale), so its value is its lines: the rule Back Office uses (src/lib/voidRules.js voidedValue).
function voidedValue(check) {
  const booked = Number(check?.total) || 0;
  if (booked > 0) return booked;
  return (Array.isArray(check?.items) ? check.items : []).reduce((s, i) => s + (Number(i?.price) || 0) * (Number(i?.qty) || 0), 0);
}
const emptyExceptions = () => ({ count: 0, amount: 0, reasons: new Map(), by: new Map() });
const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/**
 * Which venues a detail call covers.
 *   target    an ops location id, or 'group'
 *   currency  for the group: which currency's venues (currencies are never added together).
 *             Left out, it is the currency most of the venues use.
 * @returns {{ kind: 'venue'|'group', ids: string[], currency: string, other_currencies: string[] } | null}
 *          null when the venue is not one of this login's
 */
export function detailScope({ target, currency = null, opsIds, meta }) {
  if (target !== 'group') {
    if (!opsIds.includes(target)) return null;
    return { kind: 'venue', ids: [target], currency: meta[target].currency, other_currencies: [] };
  }
  const count = {};
  for (const id of opsIds) count[meta[id].currency] = (count[meta[id].currency] || 0) + 1;
  const all = Object.keys(count).sort((a, b) => count[b] - count[a] || (a < b ? -1 : 1));
  const want = String(currency || '').trim().toUpperCase();
  const cur = all.includes(want) ? want : all[0];
  if (!cur) return null;
  return { kind: 'group', ids: opsIds.filter((id) => meta[id].currency === cur), currency: cur, other_currencies: all.filter((c) => c !== cur) };
}

/**
 * @param {object} a
 * @param {any} a.ops
 * @param {string[]} a.opsIds  the venues this login may see
 * @param {Record<string, { name: string, tz: string, currency: string, dayStart?: string }>} a.meta
 * @param {string} a.target    an ops location id, or 'group'
 * @param {string} [a.currency]
 * @param {Date} [a.now]
 * @param {string} [a.period]
 * @returns {Promise<{ period: string, detail: any } | null>}  null when the venue is not this login's
 */
export async function buildOwnerDetail({ ops, opsIds, meta, target, currency = null, now = new Date(), period: asked, maxReads = MAX_READS }) {
  const period = ownerPeriod(asked);
  const scope = detailScope({ target, currency, opsIds, meta });
  if (!scope) return null;
  const ids = scope.ids, nowMs = now.getTime();
  const plan = {}, hourOf = {};
  for (const id of ids) { plan[id] = venuePlan(meta[id], nowMs, period); hourOf[id] = hourKeyer(plan[id].tz); }

  // Running totals for every venue in the scope together; the comparison alone is per venue
  // (each has its own reason word).
  // 16 Oct 2026, the Net / Gross switch: every sales figure here also runs including VAT
  // (gross beside net, from the same check parts), so the app never works a figure out itself.
  const hours = Array.from({ length: 24 }, () => ({ net: 0, gross: 0, orders: 0, cmp_net: 0, cmp_gross: 0 }));
  const week = Array.from({ length: 7 }, () => ({ net: 0, gross: 0, orders: 0, last_net: 0, last_gross: 0, last_orders: 0 }));
  const sales = emptySales();
  const per = Object.fromEntries(ids.map((id) => [id, { net: 0, cmpNet: 0, gross: 0, cmpGross: 0 }]));
  const payments = new Map(), types = new Map(), channels = new Map(), items = new Map();
  const typesGross = new Map(), channelsGross = new Map();
  const ex = { discounts: emptyExceptions(), voids: emptyExceptions(), refunds: emptyExceptions() };
  const seenRefund = new Set();
  // 8 Oct 2026, Sales mix: the scope's item sales by group, this period and the comparison span.
  const periodMix = newMix(), cmpMix = newMix();

  const gate = limiter(maxReads);
  const opts = { gate };
  const slice = SLICE_DAYS[period];
  // v5.11.99: set when a demo check was left out of these figures (demoHistory.js).
  const demoSeen = { left: false };
  const markDemo = () => { demoSeen.left = true; };
  // Category names for the items (a line carries the category id, and ids differ venue to venue)
  // and, 8 Oct 2026, the rows the Sales mix resolver wants plus each venue's Xero mapping: one
  // resolver per venue (D2), and one family key per venue so a category's copies at several
  // venues roll up as one line in the group's top three.
  const [catRows, cfgRows] = await Promise.all([
    gate(() => pagedRows('menu categories', () => ops.from('menu_categories').select('id, location_id, parent_id, label, accounting_group, master_id').in('location_id', ids).order('id'))),
    gate(() => pagedRows('sales groups', () => ops.from('xero_config').select('location_id, mapping').in('location_id', ids).order('location_id'))),
  ]);
  const catName = new Map(catRows.map((r) => [r.id, text(r.label) || null]));
  const catOf = (id) => catName.get(id) ?? null;
  const resolver = mixResolvers(ids, catRows, cfgRows);
  const famKeyOf = Object.fromEntries(ids.map((id) => [id, catFamilyKey(resolver[id])]));

  // Every check that is not voided, from either read: the hour, the week and the comparison.
  const addSale = (id, c, ms, d) => {
    const p = plan[id], parts = checkSalesParts(c), h = hourOf[id](ms);
    if (inDays(d, p.wkStart, p.today)) { const w = week[dayCount(p.wkStart, d) - 1]; w.net += parts.net; w.gross += parts.gross; w.orders += 1; }
    else if (inDays(d, p.lwStart, addDays(p.wkStart, -1))) { const w = week[dayCount(p.lwStart, d) - 1]; w.last_net += parts.net; w.last_gross += parts.gross; w.last_orders += 1; }
    if (inDays(d, p.range.from, p.range.to)) { hours[h].net += parts.net; hours[h].gross += parts.gross; hours[h].orders += 1; per[id].net += parts.net; per[id].gross += parts.gross; }
    else if (inDays(d, p.range.cmpFrom, p.range.cmpTo)) {
      hours[h].cmp_net += parts.net; hours[h].cmp_gross += parts.gross;
      if (!p.cut || d !== p.cut.day || ms < p.cut.untilMs) { per[id].cmpNet += parts.net; per[id].cmpGross += parts.gross; }
    }
    return parts;
  };
  // A refund entry, on the business day it was made. Each one once, whichever read brought it.
  // 8 Oct 2026 (the VAT audit): the refund comes OFF net sales and VAT on the day and at the hour
  // it was made, exactly as a sale adds on its own (the week, the hours, the comparison and the
  // totals), the rule Daily trading and Xero use. Before this the app's VAT and net sales were
  // gross of refunds and only the exceptions block knew.
  const addRefunds = (id, c) => {
    if (isVoidedCheck(c) || !Array.isArray(c.refunds)) return;
    const p = plan[id];
    c.refunds.forEach((e, i) => {
      const key = `${c.id}|${e?.id ?? i}`;
      if (seenRefund.has(key)) return;
      seenRefund.add(key);
      const r = refundSalesParts(e, c);
      if (r.skipped || r.atMs == null) return;
      const d = p.dayOf(r.atMs), h = hourOf[id](r.atMs);
      if (inDays(d, p.wkStart, p.today)) { const w = week[dayCount(p.wkStart, d) - 1]; w.net -= r.net; w.gross -= r.gross; }
      else if (inDays(d, p.lwStart, addDays(p.wkStart, -1))) { const w = week[dayCount(p.lwStart, d) - 1]; w.last_net -= r.net; w.last_gross -= r.gross; }
      if (inDays(d, p.range.from, p.range.to)) { hours[h].net -= r.net; hours[h].gross -= r.gross; per[id].net -= r.net; per[id].gross -= r.gross; addRefundSales(sales, e, c); }
      else if (inDays(d, p.range.cmpFrom, p.range.cmpTo)) {
        hours[h].cmp_net -= r.net; hours[h].cmp_gross -= r.gross;
        if (!p.cut || d !== p.cut.day || r.atMs < p.cut.untilMs) { per[id].cmpNet -= r.net; per[id].cmpGross -= r.gross; }
      }
      if (!inDays(d, p.range.from, p.range.to)) return;
      const amount = Math.max(0, Number(e?.amount) || 0);
      ex.refunds.count += 1; ex.refunds.amount += amount;
      bump(ex.refunds.reasons, text(e?.reason) || 'Refund', amount);
      const by = text(e?.manager) || text(e?.by);
      if (by) bump(ex.refunds.by, by, amount);
    });
  };
  const addOther = (id, rows) => {
    const dayOf = plan[id].dayOf;
    for (const c of rows) {
      const ms = Date.parse(c.closed_at);
      if (Number.isFinite(ms) && !isVoidedCheck(c)) addSale(id, c, ms, dayOf(ms));
    }
  };
  // The comparison span, read WITH items (8 Oct 2026): the sale as addOther, and its lines into
  // the comparison mix under the same time of day cut as per[id].cmpNet, so "Food +3 pts" sits
  // beside a percent worked out over the same hours.
  const addCmp = (id, rows) => {
    const p = plan[id];
    for (const c of rows) {
      const ms = Date.parse(c.closed_at);
      if (!Number.isFinite(ms) || isVoidedCheck(c)) continue;
      const d = p.dayOf(ms);
      addSale(id, c, ms, d);
      if (inDays(d, p.range.cmpFrom, p.range.cmpTo) && (!p.cut || d !== p.cut.day || ms < p.cut.untilMs)) addCheckToMix(cmpMix, c, resolver[id], famKeyOf[id]);
    }
  };
  const addPeriod = (id, rows, catOf) => {
    const dayOf = plan[id].dayOf;
    for (const c of rows) {
      const ms = Date.parse(c.closed_at);
      if (!Number.isFinite(ms)) continue;
      if (isVoidedCheck(c)) {
        ex.voids.count += 1; ex.voids.amount += voidedValue(c);
        continue;
      }
      const parts = addSale(id, c, ms, dayOf(ms));
      addCheckSales(sales, c);
      const type = String(c.order_type || 'dine-in').toLowerCase();
      bump(types, type, parts.net);
      bump(channels, channelOf(c), parts.net);
      bump(typesGross, type, parts.gross);
      bump(channelsGross, channelOf(c), parts.gross);
      // What each kind of tender took for goods. A check that charged nothing has no takings,
      // whatever its tenders say (a 100% comp once recorded a cash tender for money never taken).
      if (!chargedNothing(c)) {
        const kinds = new Map();
        for (const t of checkTenderParts(c).parts) {
          const kind = MONEY_KINDS.has(t.kind) ? t.kind : (String(t.method || '').includes('promo') ? 'promo' : 'loyalty');
          kinds.set(kind, (kinds.get(kind) || 0) + t.sales / 100);
        }
        for (const [kind, amount] of kinds) bump(payments, kind, amount);
      }
      for (const d of Array.isArray(c.discounts) ? c.discounts : []) {
        const amount = Math.max(0, Number(d?.amount) || 0);
        if (!(amount > 0)) continue;
        ex.discounts.count += 1; ex.discounts.amount += amount;
        bump(ex.discounts.reasons, text(d?.label) || text(d?.name) || text(d?.reason) || 'Discount', amount);
        const by = text(d?.manager) || text(d?.appliedBy) || text(d?.by);
        if (by) bump(ex.discounts.by, by, amount);
      }
      addCheckItems(items, c.items, catOf);
      addCheckToMix(periodMix, c, resolver[id], famKeyOf[id]);
      addRefunds(id, c);
    }
  };

  const periodOf = (id) => Promise.all(windowsOf(plan[id], [{ from: plan[id].range.from, to: plan[id].range.to }], slice).map((w) =>
    pagedEach('closed checks', () => ops.from('closed_checks').select(DETAIL_CHECK_COLS)
      .eq('location_id', id).gte('closed_at', w.from).lt('closed_at', w.to).order('closed_at').order('id'), withoutDemoRows((rows) => addPeriod(id, rows, catOf), markDemo), opts)));
  // The comparison span, with items for the mix points (8 Oct 2026); it never overlaps the period.
  const cmpSpan = (p) => ({ from: p.range.cmpFrom, to: p.range.cmpTo });
  const cmpOf = (id) => Promise.all(windowsOf(plan[id], [cmpSpan(plan[id])], slice).map((w) =>
    pagedEach('closed checks', () => ops.from('closed_checks').select(`${SALES_CHECK_COLS}, items`)
      .eq('location_id', id).gte('closed_at', w.from).lt('closed_at', w.to).order('closed_at').order('id'), withoutDemoRows((rows) => addCmp(id, rows), markDemo), opts)));
  // Every other day that is needed (this week and last), with the sales columns only, plus (29 Oct
  // 2026) the gift cards sold on those days (giftLinesOf), so their net sales leave the gift money out.
  const otherOf = async (id) => {
    const windows = windowsOf(plan[id], subtractDayRange(subtractDayRange(plan[id].salesDays, plan[id].range), cmpSpan(plan[id])), slice);
    const gifts = await giftLinesOf(ops, id, windows, opts);
    return Promise.all(windows.map((w) =>
      pagedEach('closed checks', () => ops.from('closed_checks').select(SALES_CHECK_COLS)
        .eq('location_id', id).gte('closed_at', w.from).lt('closed_at', w.to).order('closed_at').order('id'), withoutDemoRows((rows) => addOther(id, withGiftLines(gifts, rows)), markDemo), opts)));
  };
  // Older checks that carry a refund: the refund may have been made in this period.
  const refundsOf = (id) => pagedEach('refunds', () => ops.from('closed_checks').select(`${SALES_CHECK_COLS}, refunds`)
    .eq('location_id', id).gte('closed_at', new Date(plan[id].startMs - REFUND_LOOKBACK_DAYS * DAY_MS).toISOString()).lt('closed_at', new Date(plan[id].startMs).toISOString()).neq('refunds', '[]')
    .order('closed_at').order('id'), withoutDemoRows((rows) => { for (const c of rows) addRefunds(id, c); }, markDemo), opts);

  const all = ids.map((id) => plan[id]);
  const tsFrom = new Date(Math.min(...all.map((p) => p.startMs)) - DAY_MS).toISOString(), tsTo = new Date(Math.max(...all.map((p) => p.endMs)) + DAY_MS).toISOString();
  const [, , , , firstDays, ts, vs, stockOut] = await Promise.all([
    Promise.all(ids.map(periodOf)),
    Promise.all(ids.map(cmpOf)),
    Promise.all(ids.map(otherOf)),
    Promise.all(ids.map(refundsOf)),
    Promise.all(ids.map((id) => firstSaleDay(ops, id, plan[id], gate))),
    gate(() => pagedRows('timesheets', () => ops.from('wf_timesheets').select('id, location_id, clock_in, clock_out, pay_amount, actual_hours, status').in('location_id', ids).gte('clock_in', tsFrom).lt('clock_in', tsTo).order('clock_in').order('id'))),
    gate(() => pagedRows('labour targets', () => ops.from('wf_venue_settings').select('location_id, labour_target_pct').in('location_id', ids).order('location_id'))),
    // v5.11.92 (multi site stock Drop 4a): the Stock card for ONE venue (the league row and the
    // attention rows from stock_report_dashboard). The group has no stock card: currencies and
    // companies are never added together here.
    scope.kind === 'venue' ? stockDetailOf({ ops, id: ids[0], meta, plan, gate }) : Promise.resolve({ stock: null, stock_reason: null }),
  ]);

  // Labour: approved and paid timesheets on the business day of the shift (as Daily trading).
  const lab = { cost: 0, hours: 0, shifts: 0 };
  for (const t of ts) {
    if (!['approved', 'paid'].includes(t.status)) continue;
    const p = plan[t.location_id], ms = timesheetDayMs(t);
    if (!p || ms == null || !inDays(p.dayOf(ms), p.range.from, p.range.to)) continue;
    lab.cost += Number(t.pay_amount) || 0; lab.hours += Number(t.actual_hours) || 0; lab.shifts += 1;
  }
  // The target is the venue's own (wf_venue_settings.labour_target_pct, a fraction: 0.28 is 28%).
  // A group has no single target.
  const targetRow = scope.kind === 'venue' ? vs.find((v) => v.location_id === ids[0]) : null;
  const targetPct = targetRow && Number(targetRow.labour_target_pct) > 0 ? r2(Number(targetRow.labour_target_pct) * 100) : null;

  const compares = ids.map((id, i) => compareOf({ net: per[id].net, cmpNet: per[id].cmpNet, gross: per[id].gross, cmpGross: per[id].cmpGross, firstSaleDay: firstDays[i], cmpFrom: plan[id].range.cmpFrom }));
  const first = plan[ids[0]];
  const sameDates = ids.every((id) => plan[id].range.from === first.range.from && plan[id].range.to === first.range.to);
  const sameWeek = ids.every((id) => plan[id].wkStart === first.wkStart);
  // The hours in the order the day runs: a 06:30 day starts at 6, a late bar's ends after midnight.
  const startHour = Math.floor(dayStartMinutes(first.dayStart) / 60);
  const hourRows = Array.from({ length: 24 }, (_, i) => (startHour + i) % 24)
    .map((h) => ({ hour: h, net: r2(hours[h].net), orders: hours[h].orders, cmp_net: r2(hours[h].cmp_net), gross: r2(hours[h].gross), cmp_gross: r2(hours[h].cmp_gross) }));
  const used = hourRows.map((h, i) => (h.orders || h.cmp_net ? i : -1)).filter((i) => i >= 0);
  const mixRows = (map, label, grossMap) => [...map.entries()].sort((a, b) => b[1].amount - a[1].amount)
    .map(([k, v]) => ({ [label]: k, net: r2(v.amount), orders: v.count, gross: r2(grossMap.get(k)?.amount || 0) }));
  const exOut = (e, withReasons = true) => ({
    count: e.count, amount: r2(e.amount),
    reasons: withReasons ? topOf(e.reasons, 'reason') : null,
    approved_by: withReasons ? topOf(e.by, 'name') : null,
  });

  return {
    period,
    detail: {
      scope: {
        kind: scope.kind, currency: scope.currency, other_currencies: scope.other_currencies,
        locations: ids.map((id, i) => ({ ops_location_id: id, name: meta[id].name, range: rangeOut(plan[id].range, plan[id].cut), compare: { period, ...compares[i] } })),
      },
      // The dates when every venue in the scope shares them (a UK and a US venue around
      // midnight do not): otherwise each venue's own are in scope.locations.
      range: sameDates ? rangeOut(first.range, first.cut) : null,
      totals: {
        net_sales: r2(sales.net), vat: r2(sales.vat), gross_sales: r2(sales.gross), orders: sales.orders, tips: r2(sales.tips),
        avg_check: sales.orders ? r2(sales.net / sales.orders) : 0,
        avg_check_gross: sales.orders ? r2(sales.gross / sales.orders) : 0,
        // 8 Oct 2026: refunds made in the period (already off the figures above), and sales with no VAT recorded, named.
        refunds: r2(sales.refunds || 0), refund_vat: r2(sales.refund_vat || 0), vat_missing: sales.vat_missing || 0, vat_missing_refs: sales.vat_missing_refs || [],
        // 29 Oct 2026 (Drop C): gift cards sold in the period, money in outside every sales figure above. Sent when any were sold.
        ...(sales.gift_sold ? { gift_cards_sold: r2(sales.gift_sold) } : {}),
      },
      compare: scope.kind === 'venue' ? { period, ...compares[0] } : { period, ...groupCompare(compares) },
      hours: used.length ? hourRows.slice(used[0], used[used.length - 1] + 1) : [],
      week: week.map((w, i) => {
        const date = addDays(first.wkStart, i);
        return {
          dow: DOW[i], date: sameWeek ? date : null, last_date: sameWeek ? addDays(date, -7) : null,
          // A day that has not come yet has no figure, which is not the same as a day of £0.
          net: sameWeek && date > first.today ? null : r2(w.net), orders: sameWeek && date > first.today ? null : w.orders,
          last_net: r2(w.last_net), last_orders: w.last_orders,
          gross: sameWeek && date > first.today ? null : r2(w.gross), last_gross: r2(w.last_gross),
        };
      }),
      payments: [...payments.entries()].sort((a, b) => b[1].amount - a[1].amount)
        .map(([k, v]) => ({ kind: k, amount: r2(v.amount), checks: v.count, money: MONEY_KINDS.has(k) })),
      order_types: mixRows(types, 'type', typesGross),
      channels: mixRows(channels, 'channel', channelsGross),
      exceptions: { discounts: exOut(ex.discounts), voids: exOut(ex.voids, false), refunds: exOut(ex.refunds) },
      items: rankItems(items, TOP_N),
      // 8 Oct 2026, Sales mix (D4a): each group's money, share, comparison share and points, and
      // the top three categories inside it. A key is named by whichever venue in the scope names it.
      mix: mixView(periodMix, cmpMix, resolver[ids[0]], { nameOf: (key) => nameAcross(ids.map((i) => resolver[i]), key) }),
      labour: lab.shifts ? {
        cost: r2(lab.cost), hours: r2(lab.hours), shifts: lab.shifts, net_sales: r2(sales.net),
        pct: sales.net > 0 ? r2(lab.cost / sales.net * 100) : null, target_pct: targetPct,
      } : null,
      // v5.11.92 (multi site stock Drop 4a): the Stock card, or null and why (null with no reason
      // for the group, which has none).
      stock: stockOut.stock,
      stock_reason: stockOut.stock_reason,
      // v5.11.99: true when demo checks were left out of these figures.
      demo_left_out: demoSeen.left,
    },
  };
}

// ── the stock blocks (v5.11.92, multi site stock Drop 4a, contract section 5) ─────────────────
//
// Each venue card carries a Stock line and the venue screen a Stock card, read from the head
// office report functions (stock_report_league for the cards, stock_report_dashboard for one
// venue's card: migration 20261026a) as the service role, once per company and period, over the
// same business days as the sales figures (plan[id].range). The numbers are the database's: stored
// day totals, demo history left out, each venue on its own clock, targets as red, amber, green.
// Nothing is worked out here. index.ts has already fenced the venue list with the owner rule
// (ownerVenueIds), so the service role call is trusted for reach, as the contract says.
//
// A venue gets `stock: null` with `stock_reason` when there is nothing true to show:
//   not_installed   the report function is not there yet (an app ahead of 20261026a)
//   no_stock        the venue holds no stock item row, or sits in no company
//   failed          a read failed (said so, never shown as a zero)
// The snapshot never fails because of stock.

export const STOCK_LEAGUE = 'stock_report_league';
export const STOCK_DASHBOARD = 'stock_report_dashboard';
export const STOCK_REASONS = Object.freeze(['not_installed', 'no_stock', 'failed']);
/** The report functions take 1 to 50 sites a call (stock_report_guard): a bigger company is asked in groups. */
export const STOCK_SITES_PER_CALL = 50;

// The function is missing (PostgREST PGRST202, Postgres 42883, or its words).
function missingFunction(error) {
  if (!error) return false;
  const code = String(error.code || '');
  const msg = String(error.message || '');
  return code === 'PGRST202' || code === '42883' || /could not find the function|function .*does not exist|schema cache/i.test(msg);
}
const numOrNull = (v) => (v === null || v === undefined || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
const intOf = (v) => Math.max(0, Math.floor(Number(v) || 0));

/**
 * The venues an Owner app login sees: officeReachesVenue's rule, as a list. Its user_locations rows
 * UNION every venue of its own company when it is an owner (user_profiles.role 'owner' and org_id
 * equal to the venue's); a super admin reaches everything it is handed. Never the Stock control
 * branch (the Owner app shows sales). An anonymous or missing user sees nothing.
 * 21 Oct 2026: owner-snapshot read user_locations only, so Coffee Boy owners linked to 2 or 5 of
 * their 7 sites saw 2 or 5. Pure: index.ts hands in the rows it read.
 * @param {{ user: any, profile: { role?: string, org_id?: string } | null, linkedIds: string[],
 *           companyVenues: { id: string, org_id?: string | null }[] }} a
 * @returns {string[]}
 */
export function ownerVenueIds({ user = null, profile = null, linkedIds = [], companyVenues = [] } = {}) {
  const linked = new Set((Array.isArray(linkedIds) ? linkedIds : []).filter((id) => typeof id === 'string' && id));
  const out = [];
  const seen = new Set();
  const add = (id, venueOrgId) => {
    if (seen.has(id)) return;
    if (!officeReachesVenue({ user, profile, linked: linked.has(id), venueOrgId }).ok) return;
    seen.add(id);
    out.push(id);
  };
  for (const id of linked) add(id, null);
  for (const v of Array.isArray(companyVenues) ? companyVenues : []) if (v && typeof v.id === 'string' && v.id) add(v.id, v.org_id ?? null);
  return out;
}

/**
 * One league row (stock_report_league rows[], contract 1.6.3) as the app's stock block. Every
 * figure is the database's; a missing one is null, never 0. `rag` is the database's colour per
 * metric ('green' | 'amber' | 'red' | null) from stock_targets or the defaults.
 */
export function stockBlockOf(row, fallbackCurrency = null) {
  if (!row || typeof row !== 'object') return null;
  return {
    value: numOrNull(row.stock_value_now),
    gp_pct_theo: numOrNull(row.gp_pct_theo), gp_pct_actual: numOrNull(row.gp_pct_actual),
    gap_pct: numOrNull(row.gap_pct), waste_pct: numOrNull(row.waste_pct), comps_pct: numOrNull(row.comps_pct),
    days_on_hand: numOrNull(row.days_on_hand),
    last_full_count_day: typeof row.last_full_count_day === 'string' && row.last_full_count_day ? row.last_full_count_day.slice(0, 10) : null,
    last_full_count_words: typeof row.last_full_count_words === 'string' ? row.last_full_count_words : null,
    below_par_count: intOf(row.below_par_count), negative_count: intOf(row.negative_count),
    no_recipe_pct: numOrNull(row.no_recipe_pct), sales_net: numOrNull(row.sales_net),
    purchases: numOrNull(row.purchases), budget: numOrNull(row.budget), kitchen: row.kitchen === true,
    rag: row.rag && typeof row.rag === 'object' && !Array.isArray(row.rag) ? row.rag : {},
    currency: String(row.currency || fallbackCurrency || 'GBP').trim().toUpperCase(),
  };
}

// The venues' companies (locations.org_id), read with the service role. Throws on a failed read.
async function venueOrgs(ops, ids, gate) {
  const rows = await gate(() => pagedRows('venue companies', () => ops.from('locations').select('id, org_id').in('id', ids).order('id')));
  const out = {};
  for (const id of ids) out[id] = null;
  for (const r of rows) if (r?.id && ids.includes(r.id)) out[r.id] = r.org_id || null;
  return out;
}

// True when the venue holds any stock item row (archived ones included): the stock-nightly rule.
async function holdsStock(ops, id, gate) {
  const { data, error } = await gate(() => ops.from('inventory_items').select('id').eq('location_id', id).limit(1));
  if (error) throw new Error(`Could not read stock items: ${error.message}`);
  return (data || []).length > 0;
}

// One report call as the service role: { data }, or { reason } ('not_installed' | 'failed').
async function stockCall(ops, fn, args, gate) {
  if (typeof ops?.rpc !== 'function') return { reason: 'failed', words: 'the client cannot call a function' };
  let res;
  try { res = await gate(() => ops.rpc(fn, args)); } catch (e) { return { reason: 'failed', words: String(e?.message || e) }; }
  if (res?.error) return { reason: missingFunction(res.error) ? 'not_installed' : 'failed', words: String(res.error.message || res.error.code || 'failed') };
  return { data: res?.data ?? null };
}

const reportArgs = (org, ids, range) => ({ p_org: org, p_sites: ids, p_from: range.from, p_to: range.to, p_opts: { between_counts: false } });

/**
 * The stock block per venue for the snapshot's cards: one stock_report_league call per company
 * and period (venues of one company on the same business days share a call).
 * @returns {Promise<Record<string, { stock: object | null, stock_reason: string | null }>>}
 */
export async function stockBlocks({ ops, opsIds, meta, plan, gate }) {
  const out = {};
  const ids = Array.isArray(opsIds) ? opsIds : [];
  const set = (id, stock, reason) => { out[id] = stock ? { stock, stock_reason: null } : { stock: null, stock_reason: reason }; };
  if (!ids.length) return out;
  let orgs;
  try { orgs = await venueOrgs(ops, ids, gate); } catch (e) {
    console.warn(`[owner-snapshot] stock: ${String(e?.message || e)}`);
    for (const id of ids) set(id, null, 'failed');
    return out;
  }
  const holds = await Promise.all(ids.map((id) => holdsStock(ops, id, gate).then((h) => h, () => null)));
  const groups = new Map();
  ids.forEach((id, i) => {
    if (holds[i] === null) { set(id, null, 'failed'); return; }
    if (holds[i] === false || !orgs[id]) { set(id, null, 'no_stock'); return; }
    const range = plan?.[id]?.range;
    if (!range?.from || !range?.to) { set(id, null, 'failed'); return; }
    const base = `${orgs[id]}|${range.from}|${range.to}`;
    let n = 0;
    while (groups.has(`${base}|${n}`) && groups.get(`${base}|${n}`).ids.length >= STOCK_SITES_PER_CALL) n += 1;
    const key = `${base}|${n}`;
    if (!groups.has(key)) groups.set(key, { org: orgs[id], range, ids: [] });
    groups.get(key).ids.push(id);
  });
  await Promise.all([...groups.values()].map(async (g) => {
    const res = await stockCall(ops, STOCK_LEAGUE, reportArgs(g.org, g.ids, g.range), gate);
    if (res.reason) {
      if (res.reason === 'failed') console.warn(`[owner-snapshot] ${STOCK_LEAGUE} ${g.org}: ${res.words}`);
      for (const id of g.ids) set(id, null, res.reason);
      return;
    }
    const rows = Array.isArray(res.data?.rows) ? res.data.rows : [];
    const demo = res.data?.meta?.demo_left_out === true;
    for (const id of g.ids) {
      const row = rows.find((r) => String(r?.location_id) === String(id));
      if (!row) { set(id, null, 'failed'); continue; }
      set(id, { ...stockBlockOf(row, meta?.[id]?.currency), demo_left_out: demo }, null);
    }
  }));
  return out;
}

/**
 * The Stock card for one venue: its league row plus the attention rows and the not posted count,
 * from one stock_report_dashboard call over the period's business days.
 * @returns {Promise<{ stock: object | null, stock_reason: string | null }>}
 */
export async function stockDetailOf({ ops, id, meta, plan, gate }) {
  let orgs;
  let holds;
  try { [orgs, holds] = await Promise.all([venueOrgs(ops, [id], gate), holdsStock(ops, id, gate)]); } catch (e) {
    console.warn(`[owner-snapshot] stock detail ${id}: ${String(e?.message || e)}`);
    return { stock: null, stock_reason: 'failed' };
  }
  if (!holds || !orgs[id]) return { stock: null, stock_reason: 'no_stock' };
  const range = plan?.[id]?.range;
  if (!range?.from || !range?.to) return { stock: null, stock_reason: 'failed' };
  const res = await stockCall(ops, STOCK_DASHBOARD, reportArgs(orgs[id], [id], range), gate);
  if (res.reason) {
    if (res.reason === 'failed') console.warn(`[owner-snapshot] ${STOCK_DASHBOARD} ${id}: ${res.words}`);
    return { stock: null, stock_reason: res.reason };
  }
  const league = Array.isArray(res.data?.rows?.league) ? res.data.rows.league : [];
  const row = league.find((r) => String(r?.location_id) === String(id));
  if (!row) return { stock: null, stock_reason: 'failed' };
  const attention = (Array.isArray(res.data?.rows?.attention) ? res.data.rows.attention : [])
    .filter((a) => a && typeof a === 'object' && (a.location_id == null || String(a.location_id) === String(id)))
    .map((a) => ({ kind: String(a.kind || ''), count: intOf(a.count), words: typeof a.words === 'string' ? a.words : null, ref: a.ref ?? null }));
  const total = (Array.isArray(res.data?.totals) ? res.data.totals : []).find((t) => String(t?.location_id) === String(id)) || null;
  return {
    stock: {
      ...stockBlockOf(row, meta?.[id]?.currency),
      demo_left_out: res.data?.meta?.demo_left_out === true,
      not_posted: total ? { count: intOf(total.not_posted_count), value: numOrNull(total.not_posted_value) } : null,
      attention,
    },
    stock_reason: null,
  };
}
