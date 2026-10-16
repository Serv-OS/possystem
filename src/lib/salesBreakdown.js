// src/lib/salesBreakdown.js: the Business summary's sales, read by THE ONE SALES RULE.
//
// 16 Oct 2026 (Peter: "owner app net sales 1703, business summary net sales 2112 ... the
// breakdown says net sales plus tax but should be including tax, I can't get them to add up").
// Until today the Business summary (src/lib/salesStats.js computeSalesStats) called the stored
// subtotal less discounts "Net sales". At a UK venue that figure still has the VAT inside it and
// counts loyalty rewards as sales, its ladder then said "plus Tax" (VAT is inside UK prices, not
// on top) and "Total collected" was sum(total), which counts a free drink reward as money. One
// check with a stale subtotal (17 flapjacks stored, 5 sold) inflated it by another 27.00.
//
// The Owner app, the Manager app, Daily trading and Xero all read a check by ONE rule
// (supabase/functions/_shared/tradingSales.js checkSalesParts, refundSalesParts): the money
// tenders' sales, VAT apportioned per tender, loyalty and promo parts are discounts, a check
// whose own discounts cover its subtotal sold nothing, and a refund comes off on the day it was
// MADE. This file reads the same parts, so the Business summary's "Net sales" is the same
// figure to the penny, and lays them out as a ladder where every line is what it says:
//
//   Item sales           price x qty of the lines on each check (never the stored subtotal)
//   less Voids           the lines of voided checks (they count for nothing)
//   plus Delivery        delivery charges the customer paid
//   less Discounts       what was taken off the item prices (item and check discounts),
//                        worked out from what was charged, so the ladder always adds up; a
//                        check whose RECORDED discount disagrees is named
//   less Loyalty rewards loyalty and promo tenders (free drinks): never takings
//   less Refunds         goods money that went back, on the day of the refund
//   = Sales including VAT    (the money tenders' sales, Daily trading's gross after refunds)
//     of which VAT
//     Net sales excluding VAT  (Daily trading, the Owner app, Xero)
//   plus Service, plus Tips
//   = Money collected    card + cash + gift card (+ deposits, channels) less money refunded
//
// Where tax is ADDED ON TOP of prices (US tax profiles: tax_breakdown.hasExclusiveTax), item
// prices exclude that tax, so the lines above Sales are "before tax" and the tax is a plus line.
// Every figure is summed in minor units (pence, cents) so the ladder adds up exactly.
//
// Accepts the Back Office's camelCase checks or closed_checks rows (saleVat.toAccountingRow).
// PURE: imports only the shared rule files; runs under node --test.

import { checkTenderParts, refundParts, isVoidedCheck, MONEY_KINDS, toMinor, checkTaxRecorded } from '../../supabase/functions/_shared/accountingDay.js';
import { chargedNothing, recordedDiscountMinor } from '../../supabase/functions/_shared/tradingSales.js';
import { toAccountingRow } from '../../supabase/functions/_shared/saleVat.js';
import { lineAfterItemDiscount } from './taxBasis.js';

// The money kinds the reconciliation line names, in the order it names them.
export const TENDER_ORDER = ['card', 'cash', 'gift_card', 'deposit', 'other', 'unallocated'];
export const TENDER_WORDS = {
  card: 'Card', cash: 'Cash', gift_card: 'Gift card', deposit: 'Booking deposits', other: 'Other', unallocated: 'Not split (old split bills)',
};
// Named in the reconciliation line even at 0, as Peter reads it: "Card, Cash, Gift card".
const ALWAYS_NAMED = new Set(['card', 'cash', 'gift_card']);

// The numeric fields of a breakdown (major units unless a count), for adding sites together.
export const BREAKDOWN_FIELDS = [
  'items', 'voids', 'deliveryFees', 'discounts', 'recordedDiscounts', 'rewards', 'rewardsTax', 'refunds', 'shelfSales',
  'addedTax', 'sales', 'tax', 'net', 'service', 'tips', 'collected', 'count', 'covers', 'voidCount', 'refundCount',
  ...TENDER_ORDER.map((k) => `tender_${k}`),
];

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const toNum = (v) => (v == null ? null : typeof v === 'number' ? v : v instanceof Date ? v.getTime() : Number.isFinite(Date.parse(v)) ? Date.parse(v) : null);
const isUsableRecord = (r) => !!r && typeof r === 'object' && !Array.isArray(r) && r.totalTax != null && Number.isFinite(Number(r.totalTax));

/** The share (0..1) of a check's tax that was ADDED ON TOP of its prices (US), from its tax record. */
export function addedTaxShare(row) {
  const rec = row?.tax_breakdown;
  if (!isUsableRecord(rec) || !rec.hasExclusiveTax) return 0;
  const total = num(rec.totalTax);
  if (total <= 0) return 0;
  return Math.max(0, Math.min(1, num(rec.exclusiveTax) / total));
}

/** The live lines of a check: { listed (price x qty), after (after item discounts), lines }. Minor units. */
function itemsOf(row, withVoidedLines = false) {
  const list = Array.isArray(row?.items) ? row.items.filter((i) => i && (withVoidedLines || !i.voided)) : [];
  let listed = 0, after = 0;
  for (const i of list) {
    listed += toMinor(num(i.price) * (Number(i.qty) || 1));
    after += toMinor(lineAfterItemDiscount(i));
  }
  return { listed, after, lines: list.length };
}

function deliveryMinor(c, row) {
  const fee = c?.customer?.delivery_fee ?? c?.deliveryFee ?? row?.customer?.delivery_fee;
  return Math.max(0, toMinor(fee));
}

/**
 * One check's sale side, minor units. `money*` are the money tenders (card, cash, gift card,
 * deposit, channel, unallocated); `rewards*` the loyalty and promo tenders. `shelf` figures take
 * out tax added on top of prices, so they compare with item prices.
 */
export function checkPieces(check) {
  const row = toAccountingRow(check);
  const voided = isVoidedCheck(row);
  // A voided check's lines are voided with it: their value is what the Voids line takes off.
  const items = itemsOf(row, voided);
  // No lines: an old or channel row, read by its stored subtotal. But an empty items list on a
  // check that took nothing is an old till row whose every line was voided (the till then kept
  // only live lines): its subtotal is the voided goods, never a sale, so it reads 0 and is named.
  const storedSub = Math.max(0, toMinor(row?.subtotal));
  const emptyVoidedRow = !items.lines && Array.isArray(row?.items) && toMinor(row?.total) <= 0 && storedSub > 0;
  const goods = items.lines ? items.listed : emptyVoidedRow ? 0 : storedSub;
  const delivery = deliveryMinor(check, row);
  const out = {
    row, voided, goods, itemsFromSubtotal: !items.lines && !emptyVoidedRow, delivery,
    moneySales: 0, moneyTax: 0, moneyAdded: 0, rewardsShelf: 0, rewardsTax: 0,
    service: 0, tips: 0, byTender: {}, tipsByTender: {}, recordedDiscount: 0, itemDiscount: 0, subtotalOff: null,
  };
  // A stored subtotal that is not its own lines (price x qty, BEFORE item discounts, as the till
  // stores it: tradingSales.js and the till's linesGoods): named so it can be fixed.
  if (items.lines && !voided) {
    const sub = toMinor(row?.subtotal);
    if (Math.abs(sub - items.listed) > 1) out.subtotalOff = { stored: sub / 100, items: items.listed / 100 };
    out.itemDiscount = Math.max(0, items.listed - items.after);
  } else if (emptyVoidedRow && !voided) {
    out.subtotalOff = { stored: storedSub / 100, items: 0 };
  }
  out.recordedDiscount = recordedDiscountMinor(row) + out.itemDiscount;
  if (out.voided || chargedNothing(row)) return out;
  const share = addedTaxShare(row);
  for (const p of checkTenderParts(row).parts) {
    const added = Math.round(p.tax * share);
    if (MONEY_KINDS.has(p.kind)) {
      out.moneySales += p.sales; out.moneyTax += p.tax; out.moneyAdded += added;
      out.service += p.service; out.tips += p.tip;
      out.byTender[p.kind] = (out.byTender[p.kind] || 0) + p.gross;
      out.tipsByTender[p.kind] = (out.tipsByTender[p.kind] || 0) + p.tip;
    } else {
      out.rewardsShelf += p.sales - added;
      out.rewardsTax += p.tax;
    }
  }
  return out;
}

/** What was taken off one check's item prices (item and check discounts), worked out from what was charged. Minor units. */
function discountTaken(p) {
  if (p.voided) return 0;
  return p.goods + p.delivery - p.rewardsShelf - (p.moneySales - p.moneyAdded);
}

/**
 * One refund entry as the shared rule takes it off (tradingSales.refundSalesParts): the money
 * parts only, minor units, with the instant it was made. null when no money went back.
 */
export function refundPieces(entry, check) {
  const row = toAccountingRow(check);
  if (isVoidedCheck(row) || chargedNothing(row)) return null;
  const r = refundParts(entry, row);
  if (r.skipped) return null;
  const closed = Date.parse(row?.closed_at);
  const atMs = r.atMs ?? (Number.isFinite(closed) ? closed : null);
  const share = addedTaxShare(row);
  const out = { atMs, sales: 0, tax: 0, added: 0, service: 0, tips: 0, byTender: {}, tipsByTender: {} };
  for (const p of r.parts) {
    if (!MONEY_KINDS.has(p.kind)) continue;   // loyalty or promo credit put back: never takings
    out.sales += p.sales; out.tax += p.tax; out.added += Math.round(p.tax * share);
    out.service += p.service; out.tips += p.tip;
    out.byTender[p.kind] = (out.byTender[p.kind] || 0) + p.gross;
    out.tipsByTender[p.kind] = (out.tipsByTender[p.kind] || 0) + p.tip;
  }
  return out;
}

const inRange = (ms, range) => {
  if (!range) return true;
  const from = toNum(range.fromMs ?? range.from), to = toNum(range.toMs ?? range.to);
  if (ms == null) return false;
  return (from == null || ms >= from) && (to == null || ms <= to);
};

/**
 * The refunds a report takes off: every refunds[] entry of `checks` and `refundRows` (checks
 * closed before the range that carry a refund) made inside `range`; without a range, every
 * refund on `checks`. A check read twice counts once. Calls fn(pieces, check) for each.
 */
function eachRefund(checks, refundRows, range, fn) {
  const seen = new Set();
  const scan = (list, mustBeInRange) => {
    for (const c of list || []) {
      if (!c) continue;
      const id = c.id ?? null;
      if (id != null && seen.has(id)) continue;
      if (id != null) seen.add(id);
      const refunds = Array.isArray(c.refunds) ? c.refunds : [];
      for (const entry of refunds) {
        if (!entry || typeof entry !== 'object') continue;
        const r = refundPieces(entry, c);
        if (!r) continue;
        if ((range || mustBeInRange) && !inRange(r.atMs, range)) continue;
        fn(r, c);
      }
    }
  };
  scan(checks, false);
  scan(refundRows, true);
}

/**
 * The Business summary's figures for a set of checks, by the one sales rule.
 *   checks      the checks that CLOSED in the range (camelCase or closed_checks rows)
 *   range       { fromMs, toMs } (or { from, to } Dates): refunds count on the day they were made
 *   refundRows  checks closed before the range that carry a refund (lib/db fetchRefundChecksBefore)
 *   currency    the venue's currency ('USD' words the tax "tax" and reads prices as before tax)
 * Returns major units (counts as counts), plus the named checks the figures had to work round.
 */
export function salesBreakdown(checks, { range = null, refundRows = null, currency = null } = {}) {
  let items = 0, voids = 0, delivery = 0, discounts = 0, recorded = 0, rewards = 0, rewardsTax = 0;
  let moneySales = 0, moneyTax = 0, moneyAdded = 0, service = 0, tips = 0;
  let count = 0, covers = 0, voidCount = 0, anyAdded = false;
  const tender = {}, tenderTips = {}, tenderChecks = {};
  const subtotalOff = [], discountOff = [], vatMissing = [];
  for (const c of checks || []) {
    if (!c) continue;
    const p = checkPieces(c);
    items += p.goods;
    if (p.voided) { voids += p.goods; voidCount += 1; continue; }
    count += 1;
    covers += Number(c.covers) || 1;
    delivery += p.delivery;
    const taken = discountTaken(p);
    discounts += taken;
    recorded += p.recordedDiscount;
    rewards += p.rewardsShelf; rewardsTax += p.rewardsTax;
    moneySales += p.moneySales; moneyTax += p.moneyTax; moneyAdded += p.moneyAdded;
    service += p.service; tips += p.tips;
    if (p.moneyAdded > 0 || addedTaxShare(p.row) > 0) anyAdded = true;
    for (const [k, v] of Object.entries(p.byTender)) {
      tender[k] = (tender[k] || 0) + v;
      if (v > 0) tenderChecks[k] = (tenderChecks[k] || 0) + 1;
    }
    for (const [k, v] of Object.entries(p.tipsByTender)) tenderTips[k] = (tenderTips[k] || 0) + v;
    const ref = c.ref || c.id;
    if (p.subtotalOff) subtotalOff.push({ id: c.id, ref, ...p.subtotalOff });
    if (!p.itemsFromSubtotal && Math.abs(taken - p.recordedDiscount) > 1 && !chargedNothing(p.row)) {
      discountOff.push({ id: c.id, ref, recorded: p.recordedDiscount / 100, taken: taken / 100 });
    }
    if (p.moneySales > 0 && !checkTaxRecorded(p.row)) vatMissing.push({ id: c.id, ref });
  }
  let refSales = 0, refTax = 0, refAdded = 0, refCount = 0;
  eachRefund(checks, refundRows, range, (r) => {
    refSales += r.sales; refTax += r.tax; refAdded += r.added; refCount += 1;
    service -= r.service; tips -= r.tips;
    for (const [k, v] of Object.entries(r.byTender)) tender[k] = (tender[k] || 0) - v;
    for (const [k, v] of Object.entries(r.tipsByTender)) tenderTips[k] = (tenderTips[k] || 0) - v;
  });
  const refunds = refSales - refAdded;                       // on the item price basis
  const shelfSales = items - voids + delivery - discounts - rewards - refunds;
  const addedTax = moneyAdded - refAdded;
  const sales = moneySales - refSales;                       // == shelfSales + addedTax
  const tax = moneyTax - refTax;
  const net = sales - tax;
  const collected = sales + service + tips;
  const addedOn = anyAdded || (String(currency || '').toUpperCase() === 'USD' && tax - addedTax === 0);
  const m = (x) => x / 100;
  const out = {
    items: m(items), voids: m(voids), deliveryFees: m(delivery), discounts: m(discounts), recordedDiscounts: m(recorded),
    rewards: m(rewards), rewardsTax: m(rewardsTax), refunds: m(refunds), shelfSales: m(shelfSales), addedTax: m(addedTax),
    sales: m(sales), tax: m(tax), net: m(net), service: m(service), tips: m(tips), collected: m(collected),
    count, covers, voidCount, refundCount: refCount,
    addedOn, taxWord: addedOn || String(currency || '').toUpperCase() === 'USD' ? 'tax' : 'VAT',
    subtotalOff, discountOff, vatMissing, estimated: false,
  };
  for (const k of TENDER_ORDER) out[`tender_${k}`] = m(tender[k] || 0);
  // 16 Oct 2026 (the Z report): per money kind, how many checks it paid and the tips inside its
  // amount (tender_* above already holds them). Counts, not added across sites.
  out.tenderChecks = Object.fromEntries(TENDER_ORDER.map((k) => [k, tenderChecks[k] || 0]));
  out.tenderTips = Object.fromEntries(TENDER_ORDER.map((k) => [k, m(tenderTips[k] || 0)]));
  return out;
}

/** One check's net sales (excluding VAT) after its own refunds made inside `range`. Major units. */
export function checkNetSales(check, range = null) {
  const p = checkPieces(check);
  if (p.voided) return 0;
  let net = p.moneySales - p.moneyTax;
  eachRefund([check], null, range, (r) => { net -= r.sales - r.tax; });
  return net / 100;
}

/**
 * A breakdown from the server day sums (src/lib/reportDaySums.js: a long period across several
 * sites). The database adds the stored subtotals and does not split a check by tender, so this
 * is the nearest reading: item sales are stored subtotals, loyalty rewards are the loyalty
 * tenders, their VAT is taken out pro rata, refunds are on the day of the sale. Marked estimated.
 */
export function breakdownFromDaySums(stats, byTender = {}, { currency = null } = {}) {
  const s = stats || {};
  const r2 = (x) => Math.round(x * 100) / 100;
  const items = num(s.gross), voids = num(s.voids), delivery = num(s.deliveryFees), discounts = num(s.discounts);
  const rewards = Math.max(0, num(byTender.loyalty));
  const refunds = num(s.refundsItems);
  const sales = r2(items - voids + delivery - discounts - rewards - refunds);
  const before = sales + rewards;
  const tax = r2(before > 0 ? num(s.tax) * (sales / before) : num(s.tax));
  const usd = String(currency || '').toUpperCase() === 'USD';
  const out = {
    items, voids, deliveryFees: delivery, discounts, recordedDiscounts: discounts, rewards, rewardsTax: r2(num(s.tax) - tax),
    refunds, shelfSales: sales, addedTax: 0, sales, tax, net: r2(sales - tax), service: num(s.service), tips: num(s.tips),
    collected: r2(sales + num(s.service) + num(s.tips)), count: num(s.count), covers: num(s.covers), voidCount: 0, refundCount: 0,
    addedOn: false, taxWord: usd ? 'tax' : 'VAT', subtotalOff: [], discountOff: [], vatMissing: [], estimated: true,
  };
  for (const k of TENDER_ORDER) out[`tender_${k}`] = num(byTender[k]);
  return out;
}

/**
 * The ladder, top to bottom: [{ key, label, value, kind }] where kind is 'head' (the first and
 * last lines), 'less' / 'plus' (indented), 'sub' (a running total), 'of' (a breakdown of the line
 * above it, not added) or 'total'. Lines that are 0 and optional are left out.
 */
export function breakdownLines(b, { keepZero = false } = {}) {
  const w = b.taxWord === 'tax' ? 'tax' : 'VAT';
  const W = w === 'tax' ? 'Tax' : 'VAT';
  const lines = [];
  const add = (key, label, value, kind, optional = false) => { if (!optional || keepZero || Math.abs(value) >= 0.005) lines.push({ key, label, value, kind }); };
  add('items', b.addedOn ? 'Item sales (before tax)' : `Item sales (including ${w})`, b.items, 'head');
  add('voids', 'less Voids', -b.voids, 'less', true);
  add('delivery', 'plus Delivery charges', b.deliveryFees, 'plus', true);
  add('discounts', 'less Discounts', -b.discounts, 'less');
  add('rewards', 'less Loyalty rewards', -b.rewards, 'less');
  add('refunds', 'less Refunds', -b.refunds, 'less');
  if (b.addedOn) {
    const inclusive = Math.abs(b.tax - b.addedTax) >= 0.005;
    add('shelf', inclusive ? 'Sales before added tax' : 'Net sales (before tax)', b.shelfSales, 'sub');
    add('added', 'plus Tax', b.addedTax, 'plus');
    add('sales', 'Sales including tax', b.sales, 'sub');
    if (inclusive) {
      add('tax', 'of which tax', b.tax, 'of');
      add('net', 'Net sales excluding tax', b.net, 'of');
    }
  } else {
    add('sales', `Sales including ${w}`, b.sales, 'sub');
    add('tax', `of which ${W}`, b.tax, 'of');
    add('net', `Net sales excluding ${w}`, b.net, 'of');
  }
  add('service', 'plus Service', b.service, 'plus');
  add('tips', 'plus Tips', b.tips, 'plus');
  add('collected', 'Money collected', b.collected, 'total');
  return lines;
}

/** "Card £x, Cash £y, Gift card £z" (and any other money kind that took money): adds up to Money collected. */
export function tenderLine(b, fmt) {
  const f = fmt || ((n) => n.toFixed(2));
  return TENDER_ORDER
    .filter((k) => ALWAYS_NAMED.has(k) || Math.abs(num(b[`tender_${k}`])) >= 0.005)
    .map((k) => `${TENDER_WORDS[k]} ${f(num(b[`tender_${k}`]))}`)
    .join(', ');
}

const refsOf = (list, max = 8) => {
  const refs = list.slice(0, max).map((x) => x.ref || x.id).filter(Boolean);
  return refs.join(', ') + (list.length > refs.length ? ` and ${list.length - refs.length} more` : '');
};

/** The checks whose stored subtotal is not their own lines, named so they can be fixed ('' when none). */
export function subtotalOffLine(b, fmt) {
  const list = b?.subtotalOff || [];
  if (!list.length) return '';
  const f = fmt || ((n) => n.toFixed(2));
  const one = list.length === 1 ? ` (stored ${f(list[0].stored)}, items ${f(list[0].items)})` : '';
  return `${list.length === 1 ? '1 check has a stored subtotal' : `${list.length} checks have a stored subtotal`} that disagrees with its items: ${refsOf(list)}${one}. Item sales use the items.`;
}

/** The checks whose recorded discount is not what was taken off, named ('' when none). */
export function discountOffLine(b, fmt) {
  const list = b?.discountOff || [];
  if (!list.length) return '';
  const f = fmt || ((n) => n.toFixed(2));
  const one = list.length === 1 ? ` (recorded ${f(list[0].recorded)}, taken off ${f(list[0].taken)})` : '';
  return `${list.length === 1 ? '1 check has a recorded discount' : `${list.length} checks have a recorded discount`} that differs from what was charged: ${refsOf(list)}${one}. Discounts show what was taken off.`;
}

/** The VAT on goods paid with loyalty rewards: not in this VAT figure, as in Daily trading and Xero ('' when none). */
export function rewardsVatLine(b, fmt) {
  if (!b || !(b.rewardsTax >= 0.005)) return '';
  const f = fmt || ((n) => n.toFixed(2));
  const w = b.taxWord === 'tax' ? 'Tax' : 'VAT';
  return `${w} on loyalty rewards (${f(b.rewardsTax)}) is not in this ${w} figure, as in Daily trading, the Owner app and Xero. The Tax summary includes it.`;
}
