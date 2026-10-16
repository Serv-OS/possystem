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

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
const oldSum = (items) => items.reduce((s, i) => s + i.price * i.qty, 0);   // the old walk in sum
const minor = (n) => Math.round(n * 100);

// The till's own steps, as plain data: add a line, change its quantity, void a sent line.
const addLine = (order, line) => ({ ...order, items: [...order.items, { status: 'pending', voided: false, mods: [], ...line }] });
const setQty = (order, uid, qty) => ({ ...order, items: order.items.map(i => i.uid === uid && !i.voided ? { ...i, qty } : i) });
const voidLine = (order, uid) => ({ ...order, items: order.items.map(i => i.uid === uid ? { ...i, status: 'voided', voided: true } : i) });

test('a quantity changed from 17 to 5 before payment stores 5 x 2.25', () => {
  let order = { items: [] };
  order = addLine(order, { uid: 'a', name: 'Flapjack', price: 2.25, qty: 17 });
  // updateItemQty on a walk in leaves walkInOrder.subtotal at the 17 figure.
  const staleRunningSubtotal = oldSum(order.items);
  assert.equal(minor(staleRunningSubtotal), 3825);
  order = setQty(order, 'a', 5);
  assert.equal(minor(linesGoods(order.items)), 1125, 'the stored subtotal follows the lines at close');
  assert.notEqual(minor(linesGoods(order.items)), minor(staleRunningSubtotal));
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

test('both till close paths store the subtotal from the lines', () => {
  const src = read('./index.js');
  assert.match(src, /import \{ linesGoods \} from '\.\.\/lib\/taxShare\.js';/);
  // buildCloseRecord (a table): never the session's running figure.
  assert.doesNotMatch(src, /subtotal:\s+session\.subtotal \|\| 0,/);
  assert.match(src, /subtotal:\s+linesGoods\(session\.items\),/);
  // recordWalkInClosed (counter, takeaway, delivery, drive thru, dine in without a table).
  assert.doesNotMatch(src, /const subtotal = walkInOrder\.items\.reduce\(\(s, i\) => s \+ i\.price \* i\.qty, 0\);/);
  assert.match(src, /const subtotal = linesGoods\(walkInOrder\.items\);/);
});
