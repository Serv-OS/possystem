// src/lib/ownerBasis.js: the Owner app's Net / Gross switch.
//
// 16 Oct 2026, Peter: "the owner app needs a switch to show net or gross sales".
//
// THE TWO WORDS:
//   gross  what customers paid for the goods, VAT in, after discounts and comps, less refunds
//          made in the period. Tips and service charge are never sales.
//   net    gross less the VAT RECORDED on each sale (closed_checks.tax_amount, refunds less the
//          VAT they gave back). Never a flat 20 percent: a zero rated sandwich is all net.
// Net is Back Office Daily trading's Net sales. Gross is Daily trading's Net sales plus VAT, which
// is its Gross takings LESS its Refunds column: Daily trading's Gross is before refunds (and the
// Sales summary and Z report use Gross for shelf prices before discounts). So on a day with a
// refund the Owner app's Gross is lower than any Back Office figure called Gross, and the line
// under every headline figure says 'after refunds' (salesLabel) so nobody reads it as theirs.
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
//     (Daily trading), so both stay on net. Under Gross the forecast line says 'net' (cardLines);
//     the labour box keeps its one word label (a longer one wraps in the four across group card
//     and makes the card jump on a tap) and the Labour report says 'against net sales'.
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

/** The one line shown when Gross was asked for but the function is older: VAT or tax by the venue's currency. */
export const grossNeedsUpdate = (currency) => `Gross sales need a ServOS update. These figures exclude ${taxWord(currency)}.`;

/** 'Including VAT' or 'Excluding VAT': the tax word alone, for figures that are not after refunds. */
export function basisLabel(basis, currency = 'GBP') {
  return `${ownerBasis(basis) === 'gross' ? 'Including' : 'Excluding'} ${taxWord(currency)}`;
}

/**
 * The small line under a headline sales figure (the cards, the detail headline, sales by hour,
 * week by day): 'Including VAT, after refunds' or 'Excluding VAT, after refunds'. Both are after
 * refunds (a refund comes off the day it was made), and both are the same length, so a tap on
 * the switch never makes a card change height.
 */
export function salesLabel(basis, currency = 'GBP') {
  return `${basisLabel(basis, currency)}, after refunds`;
}

/**
 * The words on one card that change with the switch, from one place so a test can see them:
 *   line            under the big figure, always one short line (salesLabel)
 *   forecastSuffix  after a venue card's forecast money ('of £900 net'): a forecast is typed net
 *   groupForecast   after '% of forecast' on the group card
 */
export function cardLines(basis, currency = 'GBP') {
  const gross = ownerBasis(basis) === 'gross';
  return {
    line: salesLabel(basis, currency),
    forecastSuffix: gross ? ' net' : '',
    groupForecast: gross ? ' on net' : '',
  };
}

/**
 * The words after a venue card's 'Top items' heading. Till prices are VAT inclusive at a pound or
 * euro venue, so they say so (a screenshot under 'Excluding VAT' must not read as ex VAT money);
 * a dollar venue's till prices are before tax, so only 'till prices'.
 */
export function topItemsNote(currency = 'GBP') {
  return taxWord(currency) === 'VAT' ? ' · till prices, including VAT' : ' · till prices';
}

/** 'Net sales' or 'Gross sales'. */
export const salesWord = (basis) => (ownerBasis(basis) === 'gross' ? 'Gross sales' : 'Net sales');

const SWITCH_LEAVES = 'The Net / Gross switch does not change these.';

/**
 * The notes on the detail screen's report cards, from one place so a test can see them.
 *   sales       sales by hour and week by day: follow the switch, after refunds
 *   types       order types and channels: follow the switch, BEFORE refunds (a refund is not
 *               booked against an order type)
 *   payments    what each tender took: money taken, tax in, whatever the switch
 *   exceptions  discounts, voids and refunds: till money, tax in at a VAT venue (till prices
 *               include VAT); at a dollar venue only 'as rung up', since its prices are before tax
 */
export function reportNotes(basis, currency = 'GBP') {
  const tax = taxWord(currency);
  const label = basisLabel(basis, currency);
  return {
    sales: salesLabel(basis, currency),
    types: `${salesWord(basis)}, ${label[0].toLowerCase()}${label.slice(1)}, before refunds.`,
    payments: `What each kind took for goods, including ${tax}, tips out. ${SWITCH_LEAVES}`,
    exceptions: `${tax === 'VAT' ? 'Including VAT' : 'As rung up on the till'}. ${SWITCH_LEAVES}`,
  };
}

/** A card's sales heading for the period: 'Gross sales this week'. */
export function salesHeading(basis, period) {
  const when = period === 'week' ? 'this week' : period === 'month' ? 'this month' : 'today';
  return `${salesWord(basis)} ${when}`;
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
