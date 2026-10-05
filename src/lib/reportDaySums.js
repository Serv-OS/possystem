// src/lib/reportDaySums.js
//
// SERVER DAY SUMS for the Back Office reports: money totals per site per BUSINESS day, added
// up in the database by public.report_day_sums (Ops, supabase/migrations/20261005b).
//
// WHY (Peter, 5 Oct 2026, multi site reports, decision 4: "Long periods for All sites: fast
// money totals from the server now (one SQL function Peter runs)"): 90 days across the 6
// Coffee Boy sites is about 99,000 checks. The database hands the browser 1,000 rows a
// request, so reading them is 100 requests on the database the tills are using. The function
// answers 540 small rows instead.
//
// THE RULES THIS FILE KEEPS
//   1. BEFORE Peter runs the SQL the function is not there. This file then answers
//      { available: false, reason: 'not_installed' } and the caller falls back to the browser
//      read it uses today. It never answers zeros for "could not ask".
//   2. ALL OR NOTHING. A long range is asked in several calls. If any one fails, the whole
//      answer is "not available": never part of a period under the full period's label.
//   3. EVERY SITE ON ITS OWN CLOCK. The caller passes each site's time zone and business day
//      start (Platform locations, by ops_location_id: src/lib/locationTime.js getVenueClock,
//      the read the reports already make). A site with no clock is refused here, before
//      anything is asked. No day is ever cut on a guessed clock.
//   4. CURRENCIES ARE NEVER ADDED TOGETHER. Totals come back per currency. There is one
//      combined total only when every site shares one currency.
//   5. SITE IDS ARE OPS IDS (closed_checks.location_id). 9 of 13 venues have a different id
//      on Platform; nothing here takes a Platform id.
//   6. ONE SOURCE PER SCREEN. Never show a figure from here beside a browser figure for the
//      same day, and never swap a day from one to the other while the user watches. The
//      database adds exactly; the browser adds in floating point. A discount is stored
//      unrounded (10% off 4.75 is 0.475), so where a day's true total ends on a half penny the
//      two agree to a millionth of a penny but PRINT a penny apart (5 Oct 2026, Coffee Boy
//      Huddersfield 29 Sep net: browser 1885.34, here 1885.35). Neither sum is wrong. Rounding
//      each check's discount to pence in BOTH places (here and salesStats.js) would end it;
//      that is a shared file, so it is the Sites lane's or Peter's call, not made here.
//
// WHAT THE FIGURES ARE
//   stats        the Business summary's own figures, in the shape of computeSalesStats
//                (src/lib/salesStats.js), so that report can draw from them unchanged. A refund
//                is taken off the day of the SALE, as that report does.
//   refundsMade  refunds on the day they were MADE (the accounting day rule, what Daily
//                trading and Xero use). A different question, so a different figure.
//   byTender     card, cash, gift_card, loyalty, other (what paid, the accounting layer's reading)
//   byMethod     the Payments report's rows; byOrderType, bySource the Order types and Order
//                sources reports' rows.
//
// No import of the Supabase client on purpose: the caller hands it in, so this file is pure
// enough to test in Node and the Sites lane decides which session asks.

import { isYmd, addDays } from '../../supabase/functions/_shared/businessDay.js';

export const DAY_SUMS_RPC = 'report_day_sums';
// The database answers at most 1,000 rows a request (max_rows on both projects), an RPC
// included. One row per site per day, so each call is sized to stay under it.
export const DAY_SUMS_MAX_ROWS = 1000;
// The function's own limits (20261005b): 100 sites and 401 days a call.
export const DAY_SUMS_MAX_SITES = 100;
export const DAY_SUMS_MAX_DAYS = 400;

export const TENDER_KEYS = ['card', 'cash', 'gift_card', 'loyalty', 'other'];

const STAT_KEYS = ['gross', 'discounts', 'voids', 'refunds', 'refundsItems', 'refundsTip', 'refundsService', 'refundsTax',
  'service', 'tips', 'deliveryFees', 'tax', 'total', 'covers', 'count', 'net'];

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

// ── the clock each site is read on ───────────────────────────────────────────

const ZONE_RE = /^(UTC|[A-Za-z_]+(\/[A-Za-z0-9_+-]+)+)$/;
const START_RE = /^\s*(\d{1,2}):(\d{2})(?::\d{2})?\s*$/;

/** 'H:MM' or 'HH:MM[:SS]' to 'HH:MM', or null when it is not a time of day. */
export function normaliseDayStart(v) {
  const m = START_RE.exec(String(v ?? ''));
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;
}

function usableZone(tz) {
  if (typeof tz !== 'string' || !ZONE_RE.test(tz)) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(0); return true; } catch { return false; }
}

/**
 * The p_clocks argument from the caller's sites: { [opsLocationId]: { tz, day_start } }.
 * A site with no id, no usable zone or no usable day start is a PROBLEM, never a default.
 * @param {Array<{ id: string, timezone?: string, businessDayStart?: string }>} sites
 * @returns {{ ids: string[], clocks: Record<string, { tz: string, day_start: string }>, problems: string[] }}
 */
export function daySumsClocks(sites) {
  const ids = [], clocks = {}, problems = [];
  for (const s of Array.isArray(sites) ? sites : []) {
    const id = typeof s?.id === 'string' ? s.id.trim() : '';
    if (!id || id === 'loc-demo') { problems.push('A site has no id.'); continue; }
    if (clocks[id]) continue;   // listed twice: asked once
    const start = normaliseDayStart(s.businessDayStart ?? s.dayStart);
    if (!usableZone(s.timezone ?? s.timeZone)) { problems.push(`No time zone for site ${s.name || id}.`); continue; }
    if (!start) { problems.push(`No business day start for site ${s.name || id}.`); continue; }
    clocks[id] = { tz: s.timezone ?? s.timeZone, day_start: start };
    ids.push(id);
  }
  return { ids, clocks, problems };
}

// ── how a range is split into calls ──────────────────────────────────────────

const daysBetween = (fromDay, toDay) => Math.round((Date.parse(`${toDay}T00:00:00Z`) - Date.parse(`${fromDay}T00:00:00Z`)) / 86400000) + 1;

/**
 * The calls a range needs: [{ ids, from, to }], each at most DAY_SUMS_MAX_SITES sites,
 * DAY_SUMS_MAX_DAYS + 1 days and (one row per site per day) under DAY_SUMS_MAX_ROWS rows.
 * 6 sites for 90 days is one call (540 rows). 13 sites for 90 days is two.
 */
export function planDaySumCalls(ids, fromDay, toDay) {
  const out = [];
  if (!Array.isArray(ids) || !ids.length || !isYmd(fromDay) || !isYmd(toDay) || toDay < fromDay) return out;
  for (let i = 0; i < ids.length; i += DAY_SUMS_MAX_SITES) {
    const group = ids.slice(i, i + DAY_SUMS_MAX_SITES);
    // Strictly under the cap, so a full page can only mean rows were cut.
    const span = Math.max(1, Math.min(DAY_SUMS_MAX_DAYS + 1, Math.floor((DAY_SUMS_MAX_ROWS - 1) / group.length)));
    for (let d = fromDay; d <= toDay; d = addDays(d, span)) {
      const end = addDays(d, span - 1);
      out.push({ ids: group, from: d, to: end < toDay ? end : toDay });
    }
  }
  return out;
}

// ── asking ───────────────────────────────────────────────────────────────────

/**
 * Why a call failed, in the words the caller branches on:
 *   not_installed  the function is not in the database yet (Peter has not run 20261005b),
 *                  or the rollback was run. FALL BACK to the browser read.
 *   refused        this session may not run it (a paired till, or signed out).
 *   bad_request    the database turned the arguments down (a clock it does not know).
 *   error          anything else (network, timeout). Not a zero.
 */
export function daySumsFailure(error, status) {
  const code = String(error?.code || '');
  const text = `${error?.message || ''} ${error?.details || ''} ${error?.hint || ''}`;
  if (code === 'PGRST202' || code === '42883' || /could not find the function|function .* does not exist/i.test(text)
      || (status === 404 && !code)) return 'not_installed';
  if (code === '42501' || status === 401 || status === 403) return 'refused';
  if (code === '22023' || code === 'PGRST203' || code === '22007' || code === '22008') return 'bad_request';
  return 'error';
}

const unavailable = (reason, message, extra = {}) => ({ available: false, reason, message: message || null, rows: [], ...extra });

/**
 * Ask the database for day sums. Never throws.
 *
 * @param {object} args
 * @param {{ rpc: Function }} args.client   the Ops Supabase client of a signed in Back Office user
 * @param {Array<{ id: string, timezone: string, businessDayStart: string, currency?: string, name?: string }>} args.sites
 *        OPS location ids, each with its own clock (and currency, when the caller knows it)
 * @param {string} args.fromDay  first BUSINESS day, 'YYYY-MM-DD'
 * @param {string} args.toDay    last BUSINESS day, 'YYYY-MM-DD'
 * @param {number} [args.concurrency]  calls in flight at once (default 2: it shares the database with the tills)
 * @returns {Promise<{ available: true, rows: object[], calls: number } | { available: false, reason: string, message: string|null, rows: [] }>}
 */
export async function fetchReportDaySums({ client, sites, fromDay, toDay, concurrency = 2 } = {}) {
  if (!client || typeof client.rpc !== 'function') return unavailable('no_client', 'No database connection.');
  if (!isYmd(fromDay) || !isYmd(toDay) || toDay < fromDay) return unavailable('bad_request', 'Pick a start and an end date.');
  const { ids, clocks, problems } = daySumsClocks(sites);
  if (problems.length) return unavailable('bad_request', problems[0], { problems });
  if (!ids.length) return { available: true, rows: [], calls: 0 };

  const calls = planDaySumCalls(ids, fromDay, toDay);
  const results = new Array(calls.length);
  let next = 0, failed = null;
  const worker = async () => {
    while (!failed && next < calls.length) {
      const i = next++;
      const c = calls[i];
      const p_clocks = Object.fromEntries(c.ids.map((id) => [id, clocks[id]]));
      try {
        const { data, error, status } = await client.rpc(DAY_SUMS_RPC, { p_location_ids: c.ids, p_from: c.from, p_to: c.to, p_clocks });
        if (error) { failed = failed || unavailable(daySumsFailure(error, status), error.message); return; }
        if (!Array.isArray(data)) { failed = failed || unavailable('error', 'The database answered something that is not a list.'); return; }
        // A full page means the database may have cut rows. Never show a cut total.
        if (data.length >= DAY_SUMS_MAX_ROWS) { failed = failed || unavailable('capped', 'The database cut the answer short.'); return; }
        results[i] = data;
      } catch (e) {
        failed = failed || unavailable('error', e?.message || 'Could not reach the database.');
        return;
      }
    }
  };
  const lanes = Math.max(1, Math.min(Number(concurrency) || 1, calls.length));
  await Promise.all(Array.from({ length: lanes }, worker));
  if (failed) return failed;
  return { available: true, rows: results.flat().map(daySumRow), calls: calls.length };
}

// ── one row ──────────────────────────────────────────────────────────────────

const blankStats = () => Object.fromEntries(STAT_KEYS.map((k) => [k, 0]));
const blankTender = () => Object.fromEntries(TENDER_KEYS.map((k) => [k, 0]));
const blankRefundsMade = () => ({ amount: 0, tip: 0, service: 0, tax: 0, count: 0 });

function keyed(map, fields) {
  const out = {};
  if (!isObj(map)) return out;
  for (const [k, v] of Object.entries(map)) out[k] = Object.fromEntries(fields.map((f) => [f, num(v?.[f])]));
  return out;
}

/**
 * One row of the function as the reports read it. `stats` has the keys of computeSalesStats
 * (count is the function's `checks`, net its `net_sales`).
 */
export function daySumRow(r) {
  const tender = blankTender();
  if (isObj(r?.by_tender)) for (const k of TENDER_KEYS) tender[k] = num(r.by_tender[k]);
  return {
    locationId: String(r?.location_id ?? ''),
    day: String(r?.business_day ?? '').slice(0, 10),
    currency: r?.currency ? String(r.currency).toUpperCase() : null,
    timezone: r?.timezone || null,
    dayStart: r?.day_start || null,
    storedTimezone: r?.stored_timezone || null,
    voidedChecks: num(r?.voided_checks),
    stats: {
      gross: num(r?.gross), discounts: num(r?.discounts), voids: num(r?.voids),
      refunds: num(r?.refunds), refundsItems: num(r?.refunds_items), refundsTip: num(r?.refunds_tip),
      refundsService: num(r?.refunds_service), refundsTax: num(r?.refunds_tax),
      service: num(r?.service), tips: num(r?.tips), deliveryFees: num(r?.delivery_fees),
      tax: num(r?.tax), total: num(r?.total), covers: num(r?.covers), count: num(r?.checks), net: num(r?.net_sales),
    },
    byTender: tender,
    byMethod: keyed(r?.by_method, ['checks', 'revenue', 'tips']),
    byOrderType: keyed(r?.by_order_type, ['checks', 'revenue']),
    bySource: keyed(r?.by_source, ['checks', 'revenue']),
    refundsMade: {
      amount: num(r?.refunds_made), tip: num(r?.refunds_made_tip), service: num(r?.refunds_made_service),
      tax: num(r?.refunds_made_tax), count: num(r?.refunds_made_count),
    },
  };
}

// ── adding rows up ───────────────────────────────────────────────────────────

const blankSums = () => ({
  stats: blankStats(), voidedChecks: 0, byTender: blankTender(), byMethod: {}, byOrderType: {}, bySource: {},
  refundsMade: blankRefundsMade(),
});

function addKeyed(into, from) {
  for (const [k, v] of Object.entries(from || {})) {
    const t = (into[k] ??= {});
    for (const [f, n] of Object.entries(v)) t[f] = (t[f] || 0) + n;
  }
}

/** Add one row (or one set of sums) into another, in place. Returns `into`. */
export function addDaySums(into, row) {
  for (const k of STAT_KEYS) into.stats[k] += num(row?.stats?.[k]);
  into.voidedChecks += num(row?.voidedChecks);
  for (const k of TENDER_KEYS) into.byTender[k] += num(row?.byTender?.[k]);
  addKeyed(into.byMethod, row?.byMethod);
  addKeyed(into.byOrderType, row?.byOrderType);
  addKeyed(into.bySource, row?.bySource);
  for (const k of Object.keys(into.refundsMade)) into.refundsMade[k] += num(row?.refundsMade?.[k]);
  return into;
}

/** Every day of a range, fromDay..toDay inclusive. Empty for a range that is not one. */
export function daySumDays(fromDay, toDay) {
  const out = [];
  if (!isYmd(fromDay) || !isYmd(toDay) || toDay < fromDay || daysBetween(fromDay, toDay) > 4000) return out;
  for (let d = fromDay; d <= toDay; d = addDays(d, 1)) out.push(d);
  return out;
}

/**
 * The rows in the shape a report needs.
 *
 *   sites       one entry per site asked for, in the caller's order, each with `totals` and a
 *               `days` list covering EVERY day of the range (a day with no sale is zeros, so a
 *               trend has its whole axis). A site the database answered nothing for (no sales,
 *               or one this login may not read) is there with zeros and `hasRows: false`.
 *   currencies  one entry per currency: its sites, `totals`, and `days` added across them.
 *               A site whose currency nobody knows is a group of its own, never added to another
 *               (unless it sold nothing: then there is no money to keep apart and it is in no group).
 *   total       the one combined total, ONLY when every site shares one currency. Else null.
 *   warnings    plain sentences: the two databases disagree on a site's time zone or currency.
 *
 * @param {object[]} rows   from fetchReportDaySums (daySumRow shape)
 * @param {Array<{ id: string, name?: string, currency?: string }>} sites
 * @param {{ fromDay: string, toDay: string }} range
 */
export function shapeDaySums(rows, sites, { fromDay, toDay } = {}) {
  const days = daySumDays(fromDay, toDay);
  const warnings = [];
  const bySite = new Map();
  const order = [];
  for (const s of Array.isArray(sites) ? sites : []) {
    const id = typeof s?.id === 'string' ? s.id.trim() : '';
    if (!id || bySite.has(id)) continue;
    bySite.set(id, {
      locationId: id, name: s.name || null,
      currency: s.currency ? String(s.currency).toUpperCase() : null,
      timezone: s.timezone ?? s.timeZone ?? null, dayStart: normaliseDayStart(s.businessDayStart ?? s.dayStart),
      hasRows: false, totals: blankSums(), dayMap: new Map(),
    });
    order.push(id);
  }
  for (const r of Array.isArray(rows) ? rows : []) {
    const site = bySite.get(r?.locationId);
    if (!site || !isYmd(r.day)) continue;   // never count a row nobody asked for
    site.hasRows = true;
    if (r.currency) {
      if (site.currency && site.currency !== r.currency && !site.currencyWarned) {
        site.currencyWarned = true;
        warnings.push(`${site.name || site.locationId}: the two databases disagree on the currency (${site.currency} and ${r.currency}).`);
      }
      if (!site.currency) site.currency = r.currency;
    }
    if (r.storedTimezone && r.timezone && r.storedTimezone !== r.timezone && !site.zoneWarned) {
      site.zoneWarned = true;
      warnings.push(`${site.name || site.locationId}: the two databases disagree on the time zone (${r.timezone} and ${r.storedTimezone}).`);
    }
    addDaySums(site.totals, r);
    addDaySums(site.dayMap.get(r.day) || site.dayMap.set(r.day, blankSums()).get(r.day), r);
  }

  const siteList = order.map((id) => {
    const s = bySite.get(id);
    return {
      locationId: s.locationId, name: s.name, currency: s.currency, timezone: s.timezone, dayStart: s.dayStart,
      hasRows: s.hasRows, totals: s.totals,
      days: days.map((day) => ({ day, ...(s.dayMap.get(day) || blankSums()) })),
    };
  });

  // Per currency. Money in two currencies is never one number.
  const groups = new Map();
  for (const s of siteList) {
    // Nothing sold and no currency known: there is no money to keep apart, so it blocks no total.
    if (!s.currency && !s.hasRows) continue;
    const key = s.currency || `unknown:${s.locationId}`;
    let g = groups.get(key);
    if (!g) {
      g = { currency: s.currency, siteIds: [], totals: blankSums(), dayMap: new Map() };
      groups.set(key, g);
    }
    g.siteIds.push(s.locationId);
    addDaySums(g.totals, s.totals);
    for (const d of s.days) addDaySums(g.dayMap.get(d.day) || g.dayMap.set(d.day, blankSums()).get(d.day), d);
  }
  const currencies = [...groups.values()].map((g) => ({
    currency: g.currency, siteIds: g.siteIds, totals: g.totals,
    days: days.map((day) => ({ day, ...(g.dayMap.get(day) || blankSums()) })),
  }));
  for (const g of currencies) {
    if (!g.currency) warnings.push(`${bySite.get(g.siteIds[0])?.name || g.siteIds[0]}: no currency on record, so it is shown on its own.`);
  }
  const single = currencies.length === 1 && currencies[0].currency ? currencies[0] : null;
  return {
    fromDay: fromDay || null, toDay: toDay || null, days,
    sites: siteList, currencies,
    singleCurrency: single ? single.currency : null,
    total: single ? { currency: single.currency, totals: single.totals, days: single.days } : null,
    warnings,
  };
}

/**
 * Ask and shape in one go. { available: false, reason } when the function is not there or
 * the read failed: the caller falls back to the capped browser read.
 */
export async function loadReportDaySums({ client, sites, fromDay, toDay, concurrency } = {}) {
  const res = await fetchReportDaySums({ client, sites, fromDay, toDay, concurrency });
  if (!res.available) return res;
  return { available: true, calls: res.calls, rows: res.rows, ...shapeDaySums(res.rows, sites, { fromDay, toDay }) };
}
