// comboReports.test.js: the X and Z reports and a Combo's 0.00 pick lines (5.12.123, stage 1).
//
// A Combo on a closed check is one line with the set price and one line per pick, most of them at
// 0.00. The till's X and Z reports, the Back Office Business summary and the Owner app all read a
// check by THE ONE SALES RULE (lib/salesBreakdown.js over _shared/tradingSales.js) and by
// lib/salesStats.js. This pins that a check holding a Combo reads, to the penny, exactly as the
// same money rung up on ordinary lines: a 0.00 line adds nothing, breaks nothing, divides nothing.
//
// What stage 1 does NOT do (said in the hand over, it is the reports stage): the Combo's set price
// is reported against the Combo product and its category; a pick is reported as its own product at
// what it added (often 0.00). Product mix and GP by product therefore show the money on the Combo
// and the cost on the picks. The totals are right; the split per product comes with the reports stage.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summariseShift, buildShiftReportDoc } from './shiftReport.js';
import { computeSalesStats } from './salesStats.js';
import { salesBreakdown } from './salesBreakdown.js';

const DAY_FROM = Date.parse('2026-11-27T06:30:00Z');
const RANGE = { fromMs: DAY_FROM, toMs: DAY_FROM + 24 * 3600 * 1000 - 1 };
const C = 'cmb-a';
const pick = (uid, name, price = 0) => ({ uid, name, price, qty: 1, comboId: C, comboRole: 'pick' });
const COMBO_LINES = [
  { uid: 'p0', name: 'Build Your Own Package', price: 149, qty: 1, comboId: C, comboRole: 'parent', noKitchen: true },
  pick('k1', 'Margherita', 1.5), pick('k2', 'Margherita'), pick('k3', 'Pepperoni'), pick('k4', 'Pepperoni'), pick('k5', 'BBQ chicken pizza'),
  pick('k6', 'Garlic bread'), pick('k7', 'Cheese bread'), pick('k8', 'Caesar Salad Catering Size', 8), pick('k9', 'Soda Six Pack', 20),
];
const PLAIN_LINES = [
  { uid: 'a', name: 'Package', price: 149, qty: 1 }, { uid: 'b', name: 'Extra cheese', price: 1.5, qty: 1 },
  { uid: 'c', name: 'Chicken', price: 8, qty: 1 }, { uid: 'd', name: 'Soda Six Pack', price: 20, qty: 1 },
];
// A US style sale: 178.50 of goods, 8.45% tax added on top (15.08), paid by card.
const sale = (items, extra = {}) => ({
  id: 'c1', ref: 'R101', closedAt: DAY_FROM + 3600000, status: 'paid', service: 0, tip: 0, covers: 1, discounts: [], refunds: [], method: 'card',
  items, subtotal: 178.5, taxAmount: 15.08, total: 193.58, tenders: [{ method: 'card', amount: 193.58, tip: 0, processor: 'adyen' }],
  taxBreakdown: { hasExclusiveTax: true, subtotal: 178.5, breakdown: [{ name: 'Prepared food', rate: 0.0845, tax: 15.08 }] }, ...extra,
});

test('a check holding a Combo reads the same as the same money on ordinary lines', () => {
  const combo = [sale(COMBO_LINES)];
  const plain = [sale(PLAIN_LINES)];
  // The headline statistics (Back Office Sales summary, the Z report screen).
  const a = computeSalesStats(combo), b = computeSalesStats(plain);
  assert.deepEqual(a, b);
  assert.ok(Object.values(a).every((v) => typeof v !== 'number' || Number.isFinite(v)), 'no figure is NaN or infinite');
  // The one sales rule (Business summary, Daily trading, the Owner app).
  assert.deepEqual(salesBreakdown(combo, RANGE), salesBreakdown(plain, RANGE));
  // The slip the till prints: every line of it.
  const slip = (checks) => JSON.stringify(buildShiftReportDoc({ ...summariseShift(checks, { range: RANGE, currency: 'USD' }), title: 'X REPORT', venue: 'Mozz', printedAt: DAY_FROM }, { cols: 42 }));
  assert.equal(slip(combo), slip(plain));
});

test('a refunded and a voided Combo read the same as the plain sale too', () => {
  const refund = { id: 'r1', at: DAY_FROM + 7200000, amount: 193.58, isFullRefund: true, items: COMBO_LINES.map((l) => ({ uid: l.uid, name: l.name, price: l.price, qty: 1, refundQty: 1 })), tenderMethod: 'card' };
  const plainRefund = { ...refund, items: PLAIN_LINES.map((l) => ({ uid: l.uid, name: l.name, price: l.price, qty: 1, refundQty: 1 })) };
  const a = [sale(COMBO_LINES, { status: 'refunded', refunds: [refund] })];
  const b = [sale(PLAIN_LINES, { status: 'refunded', refunds: [plainRefund] })];
  assert.deepEqual(computeSalesStats(a), computeSalesStats(b));
  assert.deepEqual(salesBreakdown(a, RANGE), salesBreakdown(b, RANGE));
  // A voided Combo (every line voided, as the POS voids it) is no sale at all.
  const voided = [sale(COMBO_LINES.map((l) => ({ ...l, voided: true })), { voided: true, status: 'voided', subtotal: 0, taxAmount: 0, total: 0, tenders: [] })];
  const none = [sale(PLAIN_LINES.map((l) => ({ ...l, voided: true })), { voided: true, status: 'voided', subtotal: 0, taxAmount: 0, total: 0, tenders: [] })];
  assert.deepEqual(computeSalesStats(voided), computeSalesStats(none));
  assert.deepEqual(salesBreakdown(voided, RANGE), salesBreakdown(none, RANGE));
});
