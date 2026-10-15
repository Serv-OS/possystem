// ownerPeriod.js: the Owner app's quick filters (Today, This week, This month) as dates.
//
// 2 Oct 2026, Peter: "On the owner app I want to be able to have quick filters for today, this
// week, this month." owner-snapshot answered one day only. This file is every date rule the
// three filters need, on a venue's own calendar (the caller passes the venue's "today"):
//
//   today  the day itself, against the same weekday last week (as the app always did)
//   week   Monday to today, against the same span last week (the old "week to date")
//   month  the 1st to today, against the same number of days into last month. When last month
//          is shorter (31 Oct against a 30 day September, 31 Mar against February) the
//          comparison stops on last month's final day: it never borrows days from this month.
//
// It also holds the small sums the snapshot builds as rows stream past (top items, period
// totals), so the function keeps running totals and never a month of rows.
//
// 5 Oct 2026, Peter, on what every percent compares to: "same day last week, then for the week
// the week before and the month view the month before." The dates above already said that. What
// was missing is in this file now:
//   * THE REASON WORD (compareOf). A percent is only sent when there is a fair one. Otherwise
//     the answer says why in one word, so the screen never has to guess:
//       ok            both sides traded; pct is the percent
//       new           the venue had not started trading when the comparison span began (the
//                     day it opened goes with it). It counts once it has a full span.
//       no_sales_now  nothing sold yet this period ("No sales yet today", never a red -100%)
//       no_sales_then the venue was trading by then but sold nothing in the comparison span
//   * THE GROUP IS LIKE FOR LIKE EVERYWHERE (groupCompare): one sum for Today, the week and
//     the month, so the same days can never give two answers again.
//   * Top items by pounds: a line's price already holds its paid extras (lineRevenue).
//
// PURE: no imports; runs under node --test, in Deno and in the browser (the app reads
// OWNER_PERIODS from here so the chips and the function can never disagree on a name).

export const OWNER_PERIODS = ['today', 'week', 'month'];

/** The period asked for, or 'today' for anything else (an older app sends nothing). */
export function ownerPeriod(v) {
  return OWNER_PERIODS.includes(v) ? v : 'today';
}

export const r2 = (n) => Math.round(n * 100) / 100;

const utcYmd = (ms) => new Date(ms).toISOString().slice(0, 10);

function parts(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd ?? ''));
  if (!m) throw new Error(`Not a date: ${ymd}`);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (utcYmd(Date.UTC(y, mo - 1, d)) !== m[0]) throw new Error(`Not a date: ${ymd}`);
  return [y, mo, d];
}

/** 'YYYY-MM-DD' plus n calendar days. */
export function addDays(ymd, n) {
  const [y, m, d] = parts(ymd);
  return utcYmd(Date.UTC(y, m - 1, d + n));
}

/** The Monday of the week `ymd` is in (weeks start on Monday). */
export function weekStartOf(ymd) {
  const [y, m, d] = parts(ymd);
  const dow = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7; // Mon=0
  return addDays(ymd, -dow);
}

/** How many days `from` to `to` covers, both ends counted. 0 when `to` is before `from`. */
export function dayCount(from, to) {
  const [fy, fm, fd] = parts(from);
  const [ty, tm, td] = parts(to);
  return Math.max(0, Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86400000) + 1);
}

/**
 * The dates a quick filter covers, and the dates it is compared against.
 * @param {string} period    'today' | 'week' | 'month' (anything else reads as 'today')
 * @param {string} todayYmd  the venue's own date right now, 'YYYY-MM-DD'
 * @returns {{ period: string, from: string, to: string, cmpFrom: string, cmpTo: string, days: number, cmpDays: number }}
 */
export function periodRange(period, todayYmd) {
  const p = ownerPeriod(period);
  const [y, m, d] = parts(todayYmd);
  const to = todayYmd;
  let from = to, cmpFrom = addDays(to, -7), cmpTo = cmpFrom;
  if (p === 'week') {
    from = weekStartOf(to);
    cmpFrom = addDays(from, -7);
    cmpTo = addDays(to, -7);
  } else if (p === 'month') {
    from = utcYmd(Date.UTC(y, m - 1, 1));
    cmpFrom = utcYmd(Date.UTC(y, m - 2, 1));
    const lastMonthDays = new Date(Date.UTC(y, m - 1, 0)).getUTCDate();
    cmpTo = addDays(cmpFrom, Math.min(d, lastMonthDays) - 1);
  }
  return { period: p, from, to, cmpFrom, cmpTo, days: dayCount(from, to), cmpDays: dayCount(cmpFrom, cmpTo) };
}

/** True when `day` falls in `from`..`to`, both ends counted. */
export const inDays = (day, from, to) => day >= from && day <= to;

/**
 * Date ranges with every overlap and every touching pair joined, in date order. The snapshot
 * reads sales for several ranges at once (this period, its comparison, the week to date); a
 * day that sits in two of them must be read ONCE or its sales count twice.
 * @param {{ from: string, to: string }[]} ranges
 */
export function mergeDayRanges(ranges) {
  const sorted = (ranges || []).filter((r) => r && r.from <= r.to).map((r) => ({ from: r.from, to: r.to }))
    .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
  const out = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.from <= addDays(last.to, 1)) { if (r.to > last.to) last.to = r.to; }
    else out.push(r);
  }
  return out;
}

/** `from`..`to` cut into back to back pieces of at most `maxDays` days: no gap, no day twice. */
export function sliceDayRange(from, to, maxDays) {
  const step = Math.max(1, Math.floor(Number(maxDays)) || 1);
  const out = [];
  for (let a = from; a <= to; a = addDays(a, step)) {
    const b = addDays(a, step - 1);
    out.push({ from: a, to: b < to ? b : to });
  }
  return out;
}

/**
 * What one line took: its price times the quantity. Nothing is added for the extras.
 * 5 Oct 2026: a line's `price` on closed_checks ALREADY holds its paid extras. The same extras
 * are also listed in `mods` with their own price, for the ticket. Checked on live rows: 2,131
 * of 2,133 Coffee Boy checks with a paid extra since 25 Sep have subtotal = the sum of price x
 * qty, none have price plus mods (a Cappuccino is 3.70 plain and 4.20 with a 0.50 extra).
 * Adding the mods on top counted every syrup, milk and extra shot twice. Never add them.
 */
export function lineRevenue(it) {
  const qty = Number(it?.qty) || 1;
  return (Number(it?.price) || 0) * qty;
}

/**
 * Adds one check's items to a running Map of name -> { name, qty, rev, cat }. Voided lines add
 * nothing. `catOf`, when given, turns a line's category id into its name (the detail call).
 */
export function addCheckItems(map, items, catOf = null) {
  if (!Array.isArray(items)) return;
  for (const it of items) {
    if (it?.voided || it?.status === 'voided') continue;
    const name = it?.name || 'Item';
    const qty = Number(it?.qty) || 1;
    let e = map.get(name);
    if (!e) map.set(name, (e = { name, qty: 0, rev: 0, cat: null }));
    e.qty += qty;
    e.rev += lineRevenue(it);
    if (catOf && e.cat == null) e.cat = catOf(it?.cat) ?? null;
  }
}

/** The best sellers of a running items Map, most sold first. */
export function topItems(map, n = 5) {
  return [...(map?.values?.() ?? [])].sort((a, b) => b.qty - a.qty).slice(0, n)
    .map((x) => ({ name: x.name, qty: x.qty, rev: r2(x.rev) }));
}

/**
 * The detail call's item lists: the top `n` by quantity AND the top `n` by pounds (they are
 * different lists: a syrup shot sells often, a sandwich takes more), each with its category,
 * plus the categories added up. A name on equal figures sorts by name so the order is steady.
 */
export function rankItems(map, n = 20) {
  const all = [...(map?.values?.() ?? [])];
  const row = (x) => ({ name: x.name, qty: x.qty, rev: r2(x.rev), category: x.cat ?? null });
  const by = (k) => [...all].sort((a, b) => (b[k] - a[k]) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)).slice(0, n).map(row);
  const cats = new Map();
  for (const x of all) {
    const k = x.cat ?? 'Other';
    let c = cats.get(k);
    if (!c) cats.set(k, (c = { name: k, qty: 0, rev: 0 }));
    c.qty += x.qty; c.rev += x.rev;
  }
  return {
    by_qty: by('qty'), by_rev: by('rev'),
    categories: [...cats.values()].sort((a, b) => b.rev - a.rev).map((c) => ({ name: c.name, qty: c.qty, rev: r2(c.rev) })),
  };
}

/** Whole percent `now` is up or down on `before`; null when there is nothing to compare with. */
export function vsPct(now, before) {
  return before > 0 ? Math.round((now - before) / before * 100) : null;
}

/** The four reason words, in the order the screen is likely to list them. */
export const COMPARE_REASONS = ['ok', 'new', 'no_sales_now', 'no_sales_then'];

/**
 * One venue's comparison, with the reason word.
 * @param {object} a
 * @param {number} a.net        this period's net sales
 * @param {number} a.cmpNet     the comparison span's net sales (cut at the same time of day)
 * @param {string|null} a.firstSaleDay  the venue's first ever trading day, null when it never sold
 * @param {string} a.cmpFrom    the first day of the comparison span
 * @returns {{ reason: string, pct: number|null, net_sales: number, cmp_net_sales: number, first_sale_date: string|null }}
 */
export function compareOf({ net, cmpNet, firstSaleDay = null, cmpFrom }) {
  const now = r2(Number(net) || 0), then = r2(Number(cmpNet) || 0);
  let reason = 'ok';
  // New: it had not started trading when the span began, so the span is not a full one.
  if (!firstSaleDay || firstSaleDay > cmpFrom) reason = 'new';
  else if (now <= 0) reason = 'no_sales_now';
  else if (then <= 0) reason = 'no_sales_then';
  return { reason, pct: reason === 'ok' ? vsPct(now, then) : null, net_sales: now, cmp_net_sales: then, first_sale_date: firstSaleDay || null };
}

/** True when a venue's comparison goes into the group percent: it was trading and it sold then. */
const compared = (c) => c.reason !== 'new' && c.cmp_net_sales > 0;

/**
 * The group's comparison, LIKE FOR LIKE: only the venues with a full comparison count, on
 * both sides. One function for Today, the week and the month.
 *   net_sales          every venue, the headline
 *   like_net_sales     this period at the venues that are compared
 *   cmp_net_sales      the comparison period at those same venues: the pounds the group line shows
 *   venues, venues_compared, venues_new, venues_no_sales_then, venues_no_sales_now
 * @param {{ reason: string, net_sales: number, cmp_net_sales: number }[]} list  compareOf answers
 */
export function groupCompare(list) {
  const g = { reason: 'ok', pct: null, net_sales: 0, like_net_sales: 0, cmp_net_sales: 0, venues: 0, venues_compared: 0, venues_new: 0, venues_no_sales_then: 0, venues_no_sales_now: 0 };
  for (const c of list || []) {
    g.venues += 1;
    g.net_sales = r2(g.net_sales + c.net_sales);
    if (c.reason === 'new') g.venues_new += 1;
    else if (c.reason === 'no_sales_now') g.venues_no_sales_now += 1;
    else if (c.reason === 'no_sales_then') g.venues_no_sales_then += 1;
    if (!compared(c)) continue;
    g.venues_compared += 1;
    g.like_net_sales = r2(g.like_net_sales + c.net_sales);
    g.cmp_net_sales = r2(g.cmp_net_sales + c.cmp_net_sales);
  }
  if (!g.venues_compared) g.reason = g.venues > 0 && g.venues_new === g.venues ? 'new' : g.net_sales <= 0 ? 'no_sales_now' : 'no_sales_then';
  else if (g.like_net_sales <= 0) g.reason = 'no_sales_now';
  if (g.reason === 'ok') g.pct = vsPct(g.like_net_sales, g.cmp_net_sales);
  return g;
}

/**
 * One venue's figures for the chosen period, in the shape the app shows.
 * `reason` (compareOf), when given, decides whether a percent is sent: an app from before the
 * reason word reads vs_cmp_pct alone, and null there means it shows no chip, which is right
 * for a new venue and for "no sales yet" (it was a red -100%).
 * @param {{ net: number, vat: number, gross: number, orders: number, tips: number }} sales
 */
export function periodTotals({ sales, cmpNet = 0, forecast = 0, labour = 0, reason = null }) {
  const net = r2(sales.net), cmp = r2(cmpNet);
  return {
    net_sales: net, vat: r2(sales.vat), gross_sales: r2(sales.gross), orders: sales.orders, tips: r2(sales.tips),
    avg_check: sales.orders ? r2(sales.net / sales.orders) : 0,
    forecast: r2(forecast), forecast_pct: forecast > 0 ? Math.round(sales.net / forecast * 100) : null,
    labour: r2(labour), labour_pct: sales.net > 0 ? r2(labour / sales.net * 100) : null,
    cmp_net_sales: cmp, vs_cmp_pct: reason && reason !== 'ok' ? null : vsPct(net, cmp),
  };
}

/**
 * The group's figures for the period: every venue's period totals added up.
 *
 * THE COMPARISON IS LIKE FOR LIKE. 2 Oct 2026: five Coffee Boy venues closed about 2,570
 * checks this week, and in the same days last week only Leeds traded (1 check). All five
 * against that one check read "+300000%". A venue with nothing in the comparison span has
 * nothing to be compared with (its own card shows no percent either), so the group percent
 * counts only the venues that traded then:
 *   net_sales       every venue, the headline
 *   cmp_net_sales   the comparison sales of the venues that are compared
 *   like_net_sales  this period's sales at those same venues
 *   cmp_locations   how many venues that is, so the app can say "1 of 5 venues"
 *   vs_cmp_pct      like_net_sales against cmp_net_sales
 * 5 Oct 2026: `compares` (one compareOf answer per venue, same order) brings the reason word in.
 * A NEW venue is left out on both sides even when it sold a little in the span (it opened part
 * way through it), and the group percent is null unless the group's own reason is ok. Without
 * `compares` the rule is the 2 Oct one: a venue counts when it sold anything then.
 */
export function rollupTotals(list, compares = null) {
  const t = { net_sales: 0, forecast: 0, orders: 0, tips: 0, labour: 0, cmp_net_sales: 0 };
  let like = 0, cmpLocations = 0;
  (list || []).forEach((p, i) => {
    t.net_sales = r2(t.net_sales + p.net_sales);
    t.forecast = r2(t.forecast + p.forecast);
    t.orders += p.orders;
    t.tips = r2(t.tips + p.tips);
    t.labour = r2(t.labour + p.labour);
    const counts = compares ? compared(compares[i]) : p.cmp_net_sales > 0;
    if (!counts) return;
    t.cmp_net_sales = r2(t.cmp_net_sales + p.cmp_net_sales);
    like = r2(like + p.net_sales); cmpLocations += 1;
  });
  const g = compares ? groupCompare(compares) : null;
  return {
    ...t,
    forecast_pct: t.forecast > 0 ? Math.round(t.net_sales / t.forecast * 100) : null,
    labour_pct: t.net_sales > 0 ? r2(t.labour / t.net_sales * 100) : null,
    like_net_sales: like, cmp_locations: cmpLocations,
    vs_cmp_pct: g ? g.pct : vsPct(like, t.cmp_net_sales),
  };
}

/**
 * `ranges` with the days of `cut` taken out, in date order. The detail call reads the period's
 * own days with the heavy columns and every other day with the sales columns: a day must be in
 * exactly one of the two reads.
 * @param {{ from: string, to: string }[]} ranges
 * @param {{ from: string, to: string }} cut
 */
export function subtractDayRange(ranges, cut) {
  const out = [];
  for (const r of mergeDayRanges(ranges)) {
    if (!cut || cut.to < r.from || cut.from > r.to) { out.push(r); continue; }
    if (r.from < cut.from) out.push({ from: r.from, to: addDays(cut.from, -1) });
    if (r.to > cut.to) out.push({ from: addDays(cut.to, 1), to: r.to });
  }
  return out;
}

/** 'HH:MM' for minutes after midnight. */
export function hhmm(minutes) {
  const m = ((Math.floor(Number(minutes)) || 0) % 1440 + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}
