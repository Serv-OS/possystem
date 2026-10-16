/**
 * closeSubtotal.test.js: the subtotal a closed check stores is the goods on its own lines.
 * Run: `node --test src/store/closeSubtotal.test.js`.
 *
 * 16 Oct 2026: a counter sale stored a subtotal of 38.25 while its only line was
 * 5 x Flapjack at 2.25 (11.25), and its total, VAT and card payment were right for 11.25.
 * The order had an 18 x 1.50 line voided before payment (27.00), and recordWalkInClosed
 * summed every line, voided ones too. The table close (buildCloseRecord) stored the
 * session's running subtotal, which goes stale the same way. Both now store
 * linesGoods(lines): non voided price x qty (a line's price already carries its options),
 * before discounts, the same sum the VAT share is taken from. What is charged is unchanged.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { linesGoods } from '../lib/taxShare.js';
import { closeMoney } from '../lib/closeMoney.js';
import { computeCheckTotals } from '../lib/payments/checkTotals.js';
import { creditDiscountsFromPayment } from '../lib/taxBasis.js';
import { roundVat } from '../lib/taxRule.js';
import { toStoreRate } from '../lib/venueTaxRates.js';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
const oldSum = (items) => items.reduce((s, i) => s + i.price * i.qty, 0);   // the old walk in sum
const minor = (n) => Math.round(n * 100);
const UK = { taxRates: [toStoreRate({ id: 'std', name: 'Standard Rate', code: 'VAT20', rate: 0.2, type: 'inclusive', is_default: true, active: true, location_id: 'v1' })] };

// The till's own steps, as plain data: add a line, void a sent line.
const addLine = (order, line) => ({ ...order, items: [...order.items, { status: 'pending', voided: false, mods: [], ...line }] });
const voidLine = (order, uid) => ({ ...order, items: order.items.map(i => i.uid === uid ? { ...i, status: 'voided', voided: true } : i) });

// The real table case. updateItemQty left the session's running subtotal at 38.25 and an
// addItem after a void summed the voided 18 x 1.50 line back in. The close used to store that
// running figure. Through the record's own money helper (lib/closeMoney.js, which both close
// paths call): the subtotal is the live lines, and what was charged, the payment and the VAT
// are exactly as before.
test('a table session with a stale 38.25 subtotal and a voided 18 x 1.50 line books 11.25 everywhere', () => {
  const session = {
    items: [
      { uid: 'p', name: 'Crisps', price: 1.5, qty: 18, status: 'voided', voided: true, taxRateId: 'std' },
      { uid: 'f', name: 'Flapjack', price: 2.25, qty: 5, status: 'sent', voided: false, taxRateId: 'std' },
    ],
    subtotal: 38.25,   // the stale running figure
    total: 11.25,
    discounts: [],
  };
  const paymentInfo = { method: 'card', grand: 11.25 };
  const m = closeMoney(session.items, paymentInfo, session.total);
  assert.equal(minor(m.subtotal), 1125, 'the subtotal is the live lines, never session.subtotal');
  assert.equal(minor(m.total), 1125, 'what was charged is unchanged');
  assert.equal(m.tenders.length, 1);
  assert.equal(m.tenders[0].method, 'card');
  assert.equal(minor(m.tenders.reduce((s, t) => s + t.amount + (t.tip || 0), 0)), 1125, 'the payment is unchanged');
  // The VAT the close books is computeCheckTotals over the live lines, as on main: 20% inside 11.25.
  const live = session.items.filter(i => !i.voided);
  const tax = computeCheckTotals({ items: live, checkDiscounts: [], covers: 1, orderType: 'dine-in', taxRates: UK.taxRates, taxCtx: UK, creditDiscounts: creditDiscountsFromPayment(paymentInfo) }).tax;
  assert.equal(roundVat(tax.totalTax), 1.88);
  // A 100% comp charges 0 and books 0 (`??`, never `||`); no grand falls back as before.
  assert.equal(closeMoney(session.items, { method: 'cash', grand: 0 }, session.total).total, 0);
  assert.equal(closeMoney(session.items, { method: 'card' }, session.total).total, 11.25);
  assert.equal(closeMoney(session.items, { method: 'card' }, undefined).total, 0);
});

test('a voided line is not a sale: 5 x 2.25 with 18 x 1.50 voided stores 11.25, not 38.25', () => {
  let order = { items: [] };
  order = addLine(order, { uid: 'p', name: 'Crisps', price: 1.5, qty: 18 });
  order = addLine(order, { uid: 'f', name: 'Flapjack', price: 2.25, qty: 5 });
  order = { ...order, items: order.items.map(i => ({ ...i, status: 'sent', fired: true })) };
  order = voidLine(order, 'p');
  assert.equal(minor(oldSum(order.items)), 3825, 'the old sum counted the voided line (the live bug)');
  assert.equal(minor(linesGoods(order.items)), 1125);
  // The record books only the non voided lines, so its subtotal now equals its own items.
  const recordItems = order.items.filter(i => !i.voided);
  assert.equal(minor(linesGoods(recordItems)), minor(linesGoods(order.items)));
});

test('a walk in with every line voided stores 0, not the voided goods', () => {
  let order = { items: [] };
  order = addLine(order, { uid: 'x', name: 'Latte', price: 4, qty: 1 });
  order = voidLine(order, 'x');
  assert.equal(minor(oldSum(order.items)), 400);
  assert.equal(linesGoods(order.items), 0);
});

test('options ride in the line price and item discounts stay out (shelf goods before discounts)', () => {
  const items = [
    { uid: 'm', price: 4.1, qty: 1, mods: [{ name: 'Lemonade', price: 0.5 }] },        // 3.60 + 0.50 option
    { uid: 'd', price: 2.55, qty: 2, discount: { type: 'percent', value: 50 } },
  ];
  assert.equal(minor(linesGoods(items)), 920);
});

test('both till close paths take subtotal, total and tenders from closeMoney, never a running subtotal', () => {
  const src = read('./index.js');
  assert.match(src, /import \{ closeMoney \} from '\.\.\/lib\/closeMoney\.js';/);
  // buildCloseRecord (a table).
  assert.match(src, /const closeFigures = closeMoney\(session\.items, paymentInfo, session\.total\);/);
  assert.match(src, /subtotal:\s+closeFigures\.subtotal,/);
  assert.match(src, /total:\s+closeFigures\.total,/);
  assert.match(src, /tenders:\s+closeFigures\.tenders,/);
  // recordWalkInClosed (counter, takeaway, delivery, drive thru, dine in without a table).
  assert.match(src, /const closeFigures = closeMoney\(walkInOrder\.items, paymentInfo, linesGoods\(walkInOrder\.items\)\);/);
  // No close path stores a running subtotal under any name.
  assert.doesNotMatch(src, /subtotal:\s+session\.subtotal/);
  assert.doesNotMatch(src, /subtotal:\s+walkInOrder\.subtotal/);
  assert.equal((src.match(/closeFigures\.tenders/g) || []).length, 2);
  assert.equal((src.match(/total:\s+closeFigures\.total/g) || []).length, 2);
});
