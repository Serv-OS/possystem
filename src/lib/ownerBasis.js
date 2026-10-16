// src/lib/ownerBasis.js: the Owner app's Net / Gross switch.
//
// 16 Oct 2026, Peter: "the owner app needs a switch to show net or gross sales".
//
// THE TWO WORDS, the same as Back Office Daily trading:
//   gross  what customers paid for the goods, VAT in, after discounts and comps, less refunds
//          made in the period. Tips and service charge are never sales.
//   net    gross less the VAT RECORDED on each sale (closed_checks.tax_amount, refunds less the
//          VAT they gave back). Never a flat 20 percent: a zero rated sandwich is all net.
// Both come from the function (owner-snapshot), worked out from the same check parts, so the
// screen never works a figure out itself. This file only picks which one to draw.
//
// THE DEFAULT IS NET, which is what every figure in the app showed before the switch ("Net sales
// today"), so nobody's screen changes until they tap Gross.
//
// THE ONE RULE (as the period chips): a label always describes the numbers under it. A function
// from before the switch sends no gross figures and no 'gross' in `features`. Then Gross shows
// the net figures under net words, with one line saying Gross needs a ServOS update; the phone
// keeps the choice, so Gross appears by itself once the function is deployed.
//
// WHAT FOLLOWS THE SWITCH: every sales figure, chart, comparison and average (the cards' big
// figure, average check, the comparison line and its percent, the week to date, the detail
// headline, sales by hour, week by day, order types and channels).
// WHAT DOES NOT, and says so on screen:
//   * forecast % and labour %: a forecast is typed net and labour is a share of net sales
//     (Daily trading), so both stay on net and the label says it.
//   * payment mix: money taken, VAT in, whatever the switch.
//   * top items and the sales mix money: till price times quantity before check discounts, as
//     Product mix. The VAT of one line is not recorded, only the sale's, so a net figure per
//     item would be a guess.
//
// PURE: node:test loads it.

import { hasFeature } from './ownerCompare.js';

export const OWNER_BASIS_KEY = 'servos-owner-basis';
export const OWNER_BASES = ['net', 'gross'];
export const DEFAULT_BASIS = 'net';

export const BASIS_CHIPS = [
  { id: 'net', label: 'Net' },
  { id: 'gross', label: 'Gross' },
];

export const GROSS_NEEDS_UPDATE = 'Gross sales need a ServOS update. These figures exclude VAT.';

/** The basis asked for, or the default for anything else. */
export function ownerBasis(v) {
  return OWNER_BASES.includes(v) ? v : DEFAULT_BASIS;
}

/** The switch this phone last chose. The default when nothing is stored or storage is closed to us. */
export function readStoredBasis(storage) {
  try { return ownerBasis(storage?.getItem(OWNER_BASIS_KEY)); } catch { return DEFAULT_BASIS; }
}

/** Remembers the switch on this phone. A phone that will not store it starts on the default. */
export function storeBasis(storage, basis) {
  if (!storage) return false;
  try { storage.setItem(OWNER_BASIS_KEY, ownerBasis(basis)); return true; } catch { return false; }
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const r2 = (n) => Math.round(n * 100) / 100;

/** Net from gross and the VAT recorded in it, to the penny. */
export function netFromGross(gross, vat) {
  return r2(num(gross) - num(vat));
}

/** Gross from net and the VAT recorded beside it, to the penny. */
export function grossFromNet(net, vat) {
  return r2(num(net) + num(vat));
}

/** True when the function sends the figures including VAT. */
export const canGross = (snapshot) => hasFeature(snapshot, 'gross');

/**
 * What the figures on screen are: Gross only when it was asked for AND the function sends it.
 * @returns {{ basis: 'net'|'gross', needsUpdate: boolean }}
 */
export function shownBasis(snapshot, asked) {
  const want = ownerBasis(asked);
  if (want === 'gross' && snapshot && !canGross(snapshot)) return { basis: 'net', needsUpdate: true };
  return { basis: want, needsUpdate: false };
}

/** The tax word: VAT at a pound or euro venue, tax at a dollar one. */
export const taxWord = (currency) => (String(currency || '').toUpperCase() === 'USD' ? 'tax' : 'VAT');

/** The small line under a figure, so a screenshot is never ambiguous: 'Including VAT' or 'Excluding VAT'. */
export function basisLabel(basis, currency = 'GBP') {
  return `${ownerBasis(basis) === 'gross' ? 'Including' : 'Excluding'} ${taxWord(currency)}`;
}

/**
 * The line under a card's figure. Under Gross it also says that the forecast and labour
 * percents beside it are on net sales.
 */
export function basisNote(basis, currency = 'GBP', { forecast = false, labour = false } = {}) {
  const head = basisLabel(basis, currency);
  if (ownerBasis(basis) !== 'gross' || !(forecast || labour)) return head;
  const what = forecast && labour ? 'Forecast and labour use' : forecast ? 'Forecast uses' : 'Labour uses';
  return `${head}. ${what} net sales.`;
}

/** 'Net sales' or 'Gross sales'. */
export const salesWord = (basis) => (ownerBasis(basis) === 'gross' ? 'Gross sales' : 'Net sales');

/** A card's sales heading for the period: 'Gross sales this week'. */
export function salesHeading(basis, period) {
  const when = period === 'week' ? 'this week' : period === 'month' ? 'this month' : 'today';
  return `${salesWord(basis)} ${when}`;
}

/** One figure of a holder: the gross key under Gross, the net key otherwise. */
export function pick(holder, basis, netKey, grossKey) {
  return ownerBasis(basis) === 'gross' ? holder?.[grossKey] : holder?.[netKey];
}

/**
 * A comparison block (venue or group) with the chosen basis in the fields the words read (pct,
 * net_sales, cmp_net_sales, like_net_sales), so compareLine and groupLine draw it unchanged.
 * Under Gross a block with no gross figures answers null: no line is better than a net percent
 * under gross words.
 */
export function basisCompare(compare, basis) {
  if (!compare || ownerBasis(basis) !== 'gross') return compare || null;
  if (!('pct_gross' in compare) || compare.gross_sales == null) return null;
  return {
    ...compare,
    pct: compare.pct_gross, net_sales: compare.gross_sales, cmp_net_sales: compare.cmp_gross_sales,
    ...(compare.like_gross_sales != null ? { like_net_sales: compare.like_gross_sales } : {}),
  };
}

/** Sales by hour in the basis, in the shape hourChart reads (net, cmp_net). */
export function basisHours(hours, basis) {
  const list = Array.isArray(hours) ? hours : [];
  if (ownerBasis(basis) !== 'gross') return list;
  return list.map((h) => ({ ...h, net: num(h?.gross), cmp_net: num(h?.cmp_gross) }));
}

/** Week by day in the basis, in the shape weekChart reads (net, last_net). A day to come stays null. */
export function basisWeek(week, basis) {
  const list = Array.isArray(week) ? week : [];
  if (ownerBasis(basis) !== 'gross') return list;
  return list.map((w) => ({ ...w, net: w?.gross == null ? null : num(w.gross), last_net: num(w?.last_gross) }));
}

/** Order types or channels in the basis, in the shape shareRows reads (net), biggest first. */
export function basisRows(rows, basis) {
  const list = Array.isArray(rows) ? rows : [];
  if (ownerBasis(basis) !== 'gross') return list;
  return list.map((r) => ({ ...r, net: num(r?.gross) })).sort((a, b) => b.net - a.net);
}

/**
 * The detail screen's basis, from the answer itself: Gross only when the totals carry the gross
 * average (a function from before the switch sends none), so a report is never drawn with net
 * figures under gross words.
 */
export function detailBasis(detail, asked) {
  return ownerBasis(asked) === 'gross' && detail?.totals?.avg_check_gross != null ? 'gross' : 'net';
}

/** The detail headline in the basis: the figure and the average check. */
export function detailTotals(totals, basis) {
  const t = totals || {};
  const gross = ownerBasis(basis) === 'gross';
  return { sales: gross ? t.gross_sales : t.net_sales, avg: gross ? t.avg_check_gross : t.avg_check, orders: t.orders, tips: t.tips };
}

/**
 * One venue card's sales figures in the basis. `view` is ownerPeriod.venueView's answer (it
 * says which period the numbers are for); the forecast, labour and orders stay as it gives them.
 * @returns {{ sales: number, avg: number, vs_pct: number|null }}
 */
export function venueSales(l, view, basis) {
  if (ownerBasis(basis) !== 'gross') return { sales: view?.net_sales, avg: view?.avg_check, vs_pct: view?.vs_pct ?? null };
  if (view?.period === 'today' || !l?.period_totals) {
    const t = l?.today || {};
    return { sales: t.gross_sales, avg: t.avg_check_gross, vs_pct: l?.wtd?.vs_last_week_pct_gross ?? null };
  }
  const p = l.period_totals;
  return { sales: p.gross_sales, avg: p.avg_check_gross, vs_pct: p.vs_cmp_pct_gross ?? null };
}

/**
 * The group card's sales figures in the basis. `view` is ownerPeriod.rollupView's answer.
 * `before` is the figure on the old comparison line: the week to date under Today, the
 * comparison span's sales under a week or a month.
 * @returns {{ sales: number, before: number, vs_pct: number|null }}
 */
export function rollupSales(r, view, basis) {
  if (ownerBasis(basis) !== 'gross') return { sales: view?.net_sales, before: view?.before, vs_pct: view?.vs_pct ?? null };
  if (view?.period === 'today' || !r?.period_totals) {
    return { sales: r?.gross_sales, before: r?.wtd_gross, vs_pct: r?.wtd_vs_last_week_pct_gross ?? null };
  }
  const p = r.period_totals;
  return { sales: p.gross_sales, before: p.cmp_gross_sales, vs_pct: p.vs_cmp_pct_gross ?? null };
}
