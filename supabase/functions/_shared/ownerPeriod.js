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

/** Adds one check's items to a running Map of name -> { name, qty, rev }. Voided lines add nothing. */
export function addCheckItems(map, items) {
  if (!Array.isArray(items)) return;
  for (const it of items) {
    if (it?.voided) continue;
    const name = it?.name || 'Item';
    const qty = Number(it?.qty) || 1;
    let e = map.get(name);
    if (!e) map.set(name, (e = { name, qty: 0, rev: 0 }));
    e.qty += qty;
    e.rev += (Number(it?.price) || 0) * qty;
  }
}

/** The best sellers of a running items Map, most sold first. */
export function topItems(map, n = 5) {
  return [...(map?.values?.() ?? [])].sort((a, b) => b.qty - a.qty).slice(0, n)
    .map((x) => ({ name: x.name, qty: x.qty, rev: r2(x.rev) }));
}

/** Whole percent `now` is up or down on `before`; null when there is nothing to compare with. */
export function vsPct(now, before) {
  return before > 0 ? Math.round((now - before) / before * 100) : null;
}

/**
 * One venue's figures for the chosen period, in the shape the app shows.
 * @param {{ net: number, vat: number, gross: number, orders: number, tips: number }} sales
 */
export function periodTotals({ sales, cmpNet = 0, forecast = 0, labour = 0 }) {
  const net = r2(sales.net), cmp = r2(cmpNet);
  return {
    net_sales: net, vat: r2(sales.vat), gross_sales: r2(sales.gross), orders: sales.orders, tips: r2(sales.tips),
    avg_check: sales.orders ? r2(sales.net / sales.orders) : 0,
    forecast: r2(forecast), forecast_pct: forecast > 0 ? Math.round(sales.net / forecast * 100) : null,
    labour: r2(labour), labour_pct: sales.net > 0 ? r2(labour / sales.net * 100) : null,
    cmp_net_sales: cmp, vs_cmp_pct: vsPct(net, cmp),
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
 *   cmp_net_sales   every venue's comparison sales (the ones with none add nothing)
 *   like_net_sales  this period's sales at the venues that traded in the comparison span
 *   cmp_locations   how many venues that is, so the app can say "1 of 5 venues"
 *   vs_cmp_pct      like_net_sales against cmp_net_sales
 */
export function rollupTotals(list) {
  const t = { net_sales: 0, forecast: 0, orders: 0, tips: 0, labour: 0, cmp_net_sales: 0 };
  let like = 0, cmpLocations = 0;
  for (const p of list || []) {
    t.net_sales = r2(t.net_sales + p.net_sales);
    t.forecast = r2(t.forecast + p.forecast);
    t.orders += p.orders;
    t.tips = r2(t.tips + p.tips);
    t.labour = r2(t.labour + p.labour);
    t.cmp_net_sales = r2(t.cmp_net_sales + p.cmp_net_sales);
    if (p.cmp_net_sales > 0) { like = r2(like + p.net_sales); cmpLocations += 1; }
  }
  return {
    ...t,
    forecast_pct: t.forecast > 0 ? Math.round(t.net_sales / t.forecast * 100) : null,
    labour_pct: t.net_sales > 0 ? r2(t.labour / t.net_sales * 100) : null,
    like_net_sales: like, cmp_locations: cmpLocations,
    vs_cmp_pct: vsPct(like, t.cmp_net_sales),
  };
}
