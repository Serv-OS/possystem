/**
 * salesBreakdown.test.js: the Business summary's sales by the one sales rule.
 * Run: `npm test`, or `node --test src/lib/salesBreakdown.test.js`.
 *
 * 16 Oct 2026: a UK coffee shop's day read Net sales 1,703 in the Owner app and Daily trading but
 * 2,112.10 in the Business summary, whose ladder then said "plus Tax" (UK VAT is inside the prices)
 * and "Total collected" counted free drink rewards as money. The day below has the same shape and
 * the same totals (invented checks, no real names): 2,130.00 of stored subtotals with one stale
 * subtotal 27.00 too high, 17.90 of recorded discounts (one recorded 0.24 short of what was taken
 * off), 347.79 of VAT booked, 10.63 of tips, 40.58 paid with loyalty rewards over 8 checks, and 3
 * voided checks.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  salesBreakdown, breakdownLines, tenderLine, subtotalOffLine, discountOffLine, rewardsVatLine, checkNetSales,
  breakdownFromDaySums, addedTaxShare,
} from './salesBreakdown.js';
import { tradingDays, checkSalesParts } from '../../supabase/functions/_shared/tradingSales.js';
import { emptySales, addCheckSales, addRefundSales } from '../../supabase/functions/_shared/snapshotSales.js';
import { computeSalesStats } from './salesStats.js';
import { applyFilters } from '../backoffice/sections/reports/_filters.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const near = (a, b, d = 0.005) => assert.ok(Math.abs(a - b) < d, `${a} != ${b}`);
const card = (amount, tip = 0) => ({ method: 'card', amount, tip, processor: 'adyen' });
const cash = (amount, tip = 0) => ({ method: 'cash', amount, tip });
const loyalty = (amount, item) => ({ method: 'loyalty', amount, tip: 0, rewards: [{ name: 'Free Drink', item, amount }] });
const line = (price, qty = 1, extra = {}) => ({ name: 'Item', price, qty, ...extra });

const DAY_FROM = Date.parse('2026-10-16T05:30:00Z');   // a 06:30 business day in October (BST)
const DAY_TO = Date.parse('2026-10-17T05:29:59.999Z');
const at = (h) => new Date(DAY_FROM + h * 3600000).toISOString();
let n = 0;
const check = (o) => ({ id: `c${++n}`, ref: `R${1000 + n}`, closed_at: at(1 + n / 10), status: 'paid', service: 0, tip: 0, discounts: [], refunds: [], ...o });

function theDay() {
  n = 0;
  return [
    // A stale subtotal: 5 flapjacks sold and charged (11.25), 17 stored (38.25).
    check({ items: [line(2.25, 5)], subtotal: 38.25, tax_amount: 1.88, tip: 0.56, total: 11.81, tenders: [card(11.25, 0.56)] }),
    // A 10% discount recorded as 0.48, while the card took 6.53 off 7.25 (0.72 taken off).
    check({ items: [line(7.25)], subtotal: 7.25, discounts: [{ type: 'percent', value: 10, amount: 0.48 }], tax_amount: 1.09, tip: 0.32, total: 6.85, tenders: [card(6.53, 0.32)] }),
    // 7 free drinks paid in full with a loyalty reward, and one paid partly.
    ...Array.from({ length: 7 }, () => check({ items: [line(4.8)], subtotal: 4.8, tax_amount: 0.8, total: 4.8, tenders: [loyalty(4.8, 'Latte')] })),
    check({ items: [line(6.98), line(3.02)], subtotal: 10, tax_amount: 1.67, total: 10, tenders: [loyalty(6.98, 'Mocha'), card(3.02)] }),
    // A 20% staff discount.
    check({ items: [line(87.1)], subtotal: 87.1, discounts: [{ type: 'percent', value: 20, amount: 17.42 }], tax_amount: 11.61, total: 69.68, tenders: [card(69.68)] }),
    // The rest of the day's trade, card and cash.
    check({ items: [line(953.8), line(500, 2)], subtotal: 1953.8, tax_amount: 325.94, tip: 9.75, total: 1963.55, tenders: [card(1500, 9.75), cash(453.8)] }),
    // Three voided checks: their lines were voided with them.
    ...[11.4, 11.75, 10.3].map((v) => check({ status: 'voided', items: [line(v, 1, { voided: true })], subtotal: 0, tax_amount: 0, total: 0, tenders: [] })),
  ];
}
const RANGE = { fromMs: DAY_FROM, toMs: DAY_TO };

test('the day: net sales excluding VAT is the Owner app and Daily trading figure, to the penny', () => {
  const rows = theDay();
  const b = salesBreakdown(rows, { range: RANGE, currency: 'GBP' });
  near(b.net, 1703.29, 0.05);                       // the figure the Owner app showed
  // Daily trading (tradingDays) and the Owner app (snapshotSales.addCheckSales) on the same rows.
  const td = tradingDays({ saleRows: rows, dayOf: () => 'D' }).D;
  const owner = emptySales(); for (const r of rows) addCheckSales(owner, r);
  near(b.net, td.net); near(b.net, owner.net);
  near(b.tax, td.vat); near(b.sales, td.gross);
  assert.equal(b.count, 12);
  assert.equal(b.voidCount, 3);
});

test('the day: the ladder adds up, every line from the checks, loyalty rewards are not sales', () => {
  const b = salesBreakdown(theDay(), { range: RANGE, currency: 'GBP' });
  near(b.items, 2103.0 + 33.45);                    // the lines (price x qty), never the 2,130.00 stored
  near(b.voids, 33.45);
  near(b.rewards, 40.58);
  near(b.discounts, 17.42 + 0.72);                  // what was taken off, not the 0.48 recorded
  near(b.recordedDiscounts, 17.90);
  near(b.refunds, 0);
  near(b.items - b.voids + b.deliveryFees - b.discounts - b.rewards - b.refunds, b.sales);
  near(b.sales, 2044.28);
  near(b.sales - b.tax, b.net);
  near(b.tips, 10.63);
  near(b.sales + b.service + b.tips, b.collected);
  near(b.tender_card, 11.81 + 6.85 + 3.02 + 69.68 + 1509.75);
  near(b.tender_cash, 453.8);
  near(b.tender_card + b.tender_cash + b.tender_gift_card, b.collected);   // money collected = card + cash
  near(b.rewardsTax, 7 * 0.8 + 1.17);                // VAT booked on the rewards, outside this VAT figure
});

test('before: the old figures (subtotal less discounts, VAT and rewards inside) said 2,112.10', () => {
  const camel = theDay().map((r) => ({ ...r, taxAmount: r.tax_amount, closedAt: Date.parse(r.closed_at) }));
  const s = computeSalesStats(camel);
  near(s.gross, 2130.0);
  near(s.net, 2112.1);
  near(s.total, 2095.49);   // sum(total): counts the 40.58 of rewards as money
});

test('the lines read truthfully: VAT inside, no "plus Tax", money collected last', () => {
  const b = salesBreakdown(theDay(), { range: RANGE, currency: 'GBP' });
  const lines = breakdownLines(b);
  assert.deepEqual(lines.map((l) => l.label), [
    'Item sales (including VAT)', 'less Voids', 'less Discounts', 'less Loyalty rewards', 'less Refunds',
    'Sales including VAT', 'of which VAT', 'Net sales excluding VAT', 'plus Service', 'plus Tips', 'Money collected',
  ]);
  assert.ok(!lines.some((l) => /plus Tax/.test(l.label)));
  assert.equal(b.taxWord, 'VAT');
  assert.equal(tenderLine(b, (x) => x.toFixed(2)), 'Card 1601.11, Cash 453.80, Gift card 0.00');
  assert.equal(subtotalOffLine(b, (x) => x.toFixed(2)), '1 check has a stored subtotal that disagrees with its items: R1001 (stored 38.25, items 11.25). Item sales use the items.');
  assert.equal(discountOffLine(b, (x) => x.toFixed(2)), '1 check has a recorded discount that differs from what was charged: R1002 (recorded 0.48, taken off 0.72). Discounts show what was taken off.');
  assert.match(rewardsVatLine(b, (x) => x.toFixed(2)), /^VAT on loyalty rewards \(6\.77\) is not in this VAT figure/);
});

test('the Back Office camelCase checks read the same as closed_checks rows', () => {
  const rows = theDay();
  const camel = rows.map((r) => ({
    id: r.id, ref: r.ref, closedAt: Date.parse(r.closed_at), status: r.status, items: r.items, discounts: r.discounts,
    subtotal: r.subtotal, service: r.service, tip: r.tip, total: r.total, taxAmount: r.tax_amount, refunds: r.refunds,
    tenders: r.tenders, method: null, processor: 'adyen', source: 'pos', covers: 1,
  }));
  const a = salesBreakdown(rows, { range: RANGE }), b = salesBreakdown(camel, { range: RANGE });
  for (const k of ['items', 'voids', 'discounts', 'rewards', 'sales', 'tax', 'net', 'tips', 'collected', 'tender_card', 'tender_cash']) near(a[k], b[k]);
});

test('refunds come off on the day they were made, an older sale included, as Daily trading takes them', () => {
  const rows = theDay();
  const old = { id: 'old1', ref: 'R0900', closed_at: new Date(DAY_FROM - 3 * 86400000).toISOString(), status: 'paid', service: 0, tip: 0, discounts: [],
    items: [line(12)], subtotal: 12, tax_amount: 2, total: 12, tenders: [card(12)],
    refunds: [{ id: 'r1', amount: 6, taxAmount: 1, tipAmount: 0, serviceAmount: 0, tenderMethod: 'card', cardStatus: 'accepted', timestamp: DAY_FROM + 3600000, legs: [{ status: 'succeeded', amountMinor: 600 }] }] };
  // A refund on one of today's sales made TOMORROW is tomorrow's.
  rows[5] = { ...rows[5], refunds: [{ id: 'r2', amount: 10, taxAmount: 1.67, tenderMethod: 'card', cardStatus: 'accepted', timestamp: DAY_TO + 3600000, legs: [{ status: 'succeeded', amountMinor: 1000 }] }] };
  const b = salesBreakdown(rows, { range: RANGE, refundRows: [old] });
  near(b.refunds, 6); assert.equal(b.refundCount, 1);
  const td = tradingDays({ saleRows: rows, refundRows: [...rows, old], dayOf: (ms) => (ms >= DAY_FROM && ms <= DAY_TO ? 'D' : 'X') }).D;
  near(b.net, td.net); near(b.tax, td.vat);
  near(b.items - b.voids - b.discounts - b.rewards - b.refunds, b.sales);
  near(b.tender_card + b.tender_cash, b.collected);
  // The Owner app's day: sales of the day, refunds made on the day.
  const owner = emptySales(); for (const r of rows) addCheckSales(owner, r);
  addRefundSales(owner, old.refunds[0], old);
  near(b.net, owner.net);
  // One check's net, after its own refunds inside the range.
  near(checkNetSales(rows[5], RANGE), checkSalesParts(rows[5]).net);
});

test('a 100% comp that recorded a cash tender sold nothing: all of it is discount', () => {
  const comp = check({ items: [line(9)], subtotal: 9, discounts: [{ type: 'percent', value: 100, amount: 9 }], tax_amount: 0, total: 9, tenders: [cash(9)] });
  const b = salesBreakdown([comp]);
  near(b.sales, 0); near(b.discounts, 9); near(b.collected, 0); near(b.tender_cash, 0);
  assert.equal(b.discountOff.length, 0);
});

test('tax added on top (US): item prices are before tax, the tax is a plus line', () => {
  const rec = (tax) => ({ totalTax: tax, exclusiveTax: tax, hasExclusiveTax: true, breakdown: [{ rate: { type: 'exclusive', rate: 0.08875 }, tax }] });
  const a = check({ items: [line(10)], subtotal: 10, tax_amount: 0.89, tax_breakdown: rec(0.89), total: 10.89, tenders: [card(10.89)] });
  const d = check({ items: [line(10)], subtotal: 10, discounts: [{ type: 'percent', value: 10, amount: 1 }], tax_amount: 0.8, tax_breakdown: rec(0.8), tip: 2, total: 11.8, tenders: [card(9.8, 2)] });
  assert.equal(addedTaxShare(a), 1);
  const b = salesBreakdown([a, d], { currency: 'USD' });
  assert.equal(b.addedOn, true);
  assert.equal(b.taxWord, 'tax');
  near(b.items, 20); near(b.discounts, 1); near(b.shelfSales, 19); near(b.addedTax, 1.69);
  near(b.sales, 20.69); near(b.tax, 1.69); near(b.net, 19); near(b.collected, 22.69);
  assert.deepEqual(breakdownLines(b).map((l) => l.label), [
    'Item sales (before tax)', 'less Discounts', 'less Loyalty rewards', 'less Refunds',
    'Net sales (before tax)', 'plus Tax', 'Sales including tax', 'plus Service', 'plus Tips', 'Money collected',
  ]);
  // The same net as the shared rule.
  near(b.net, checkSalesParts(a).net + checkSalesParts(d).net);
});

test('a check with no lines (an old or channel row) reads its subtotal as item sales', () => {
  const r = check({ items: [], subtotal: 12, tax_amount: 2, total: 12, tenders: [card(12)] });
  const b = salesBreakdown([r]);
  near(b.items, 12); near(b.sales, 12); near(b.net, 10);
  assert.equal(b.subtotalOff.length, 0);
});

// The till stores the subtotal as shelf prices BEFORE item discounts (linesGoods; live: every
// check with an item discount in 30 days stores price x qty). That is not a stale subtotal.
test('an item discount stays out of the stored subtotal and is not a stale subtotal', () => {
  const r = check({ items: [line(10, 1, { discount: { type: 'percent', value: 50 } })], subtotal: 10, tax_amount: 0.83, total: 5, tenders: [card(5)] });
  const b = salesBreakdown([r]);
  near(b.items, 10); near(b.discounts, 5); near(b.recordedDiscounts, 5);
  assert.equal(b.subtotalOff.length, 0); assert.equal(b.discountOff.length, 0);
});

test('a subtotal stored AFTER the item discount is not the till rule and is named', () => {
  const r = check({ items: [line(10, 1, { discount: { type: 'percent', value: 50 } })], subtotal: 5, tax_amount: 0.83, total: 5, tenders: [card(5)] });
  const b = salesBreakdown([r]);
  near(b.items, 10); near(b.discounts, 5); near(b.sales, 5);
  assert.equal(b.subtotalOff.length, 1);
  assert.deepEqual([b.subtotalOff[0].stored, b.subtotalOff[0].items], [5, 10]);
});

test('an old check with every line voided (empty items, nothing taken) is not item sales', () => {
  // The till used to keep only live lines: items [], the voided goods left in the subtotal.
  const r = check({ items: [], subtotal: 4, tax_amount: 0, total: 0, tenders: [] });
  const b = salesBreakdown([r]);
  near(b.items, 0); near(b.discounts, 0); near(b.sales, 0); near(b.net, 0);
  assert.equal(b.subtotalOff.length, 1);
  assert.deepEqual([b.subtotalOff[0].stored, b.subtotalOff[0].items], [4, 0]);
});

test('a filtered view takes off only the older refunds that pass its filter', () => {
  const older = (id, server, orderType) => ({ id, ref: id, server, orderType, closed_at: new Date(DAY_FROM - 2 * 86400000).toISOString(), status: 'paid', service: 0, tip: 0, discounts: [],
    items: [line(12)], subtotal: 12, tax_amount: 2, total: 12, tenders: [card(12)],
    refunds: [{ id: `${id}r`, amount: 6, taxAmount: 1, tipAmount: 0, serviceAmount: 0, tenderMethod: 'card', cardStatus: 'accepted', timestamp: DAY_FROM + 3600000, legs: [{ status: 'succeeded', amountMinor: 600 }] }] });
  const lookback = [older('o1', 'Jane', 'takeaway'), older('o2', 'Ben', 'dine-in')];
  const jane = applyFilters(lookback, { server: 'Jane', orderType: 'all', source: 'all' });
  near(salesBreakdown([], { range: RANGE, refundRows: jane }).refunds, 6);
  near(salesBreakdown([], { range: RANGE, refundRows: applyFilters(lookback, { server: 'all', orderType: 'dine-in', source: 'all' }) }).refunds, 6);
  near(salesBreakdown([], { range: RANGE, refundRows: applyFilters(lookback, null) }).refunds, 12);
  // The Business summary filters its older sales (both periods, one site and sites) the same way.
  const src = fs.readFileSync(path.join(here, '../backoffice/sections/reports/SalesSummary.jsx'), 'utf8');
  assert.match(src, /applyFilters\(\(siteId && lookback\.rows\[siteId\]\) \|\| NONE, filters\)/);
  assert.match(src, /applyFilters\(\(siteId && prevLookback\.rows\[siteId\]\) \|\| NONE, filters\)/);
  assert.match(src, /refundRows: applyFilters\(lookback\.rows\[String\(p\.id\)\] \|\| NONE, filters\)/);
  assert.match(src, /refundRows: applyFilters\(prevLookback\.rows\[String\(p\.id\)\] \|\| NONE, filters\)/);
  const bo = fs.readFileSync(path.join(here, '../backoffice/sections/BOReports.jsx'), 'utf8');
  assert.match(bo, /<SalesSummary [^\n]*filters=\{reportFilters\}/);
});

test('day sums (long periods across sites) are the nearest reading, marked estimated', () => {
  const b = breakdownFromDaySums({ gross: 100, discounts: 10, voids: 0, refundsItems: 0, deliveryFees: 0, tax: 15, service: 0, tips: 2, count: 5, covers: 5 }, { card: 80, cash: 2, loyalty: 10 }, { currency: 'GBP' });
  assert.equal(b.estimated, true);
  near(b.sales, 80); near(b.tax, 13.33); near(b.net, 66.67); near(b.collected, 82);
});

test('no long dashes in the Business summary or its rule', () => {
  for (const f of ['./salesBreakdown.js', '../backoffice/sections/reports/SalesSummary.jsx', '../backoffice/sections/reports/_refundLookback.js']) {
    const src = fs.readFileSync(path.join(here, f), 'utf8');
    assert.ok(!/[–—]/.test(src), `${f} has a long dash`);
  }
});
