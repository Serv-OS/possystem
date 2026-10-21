import { test } from 'node:test';
import assert from 'node:assert/strict';
import { displayLinesFor, readerLinesFor, lineChargedTotal } from './displayLines.js';

// Money maths in floats: 2.2 * 2 - 1 is 3.4000000000000004, and the till shows it as 3.40. Compare
// to a tenth of a penny, as the screens round.
const near = (a, b) => assert.ok(Math.abs(a - b) < 0.0005, `${a} is not ${b}`);

// A till line's price already includes its paid options (store.addItem, tillLineUnitPrice).
const latte = { uid: 'a', name: 'Latte, Small', price: 2.2, qty: 1, mods: [{ label: 'Skinny', price: 0.7 }, { label: 'HOT', price: 0 }], notes: '' };

// The till's own subtotal rule (lib/payments/checkTotals.js computeCheckTotals), repeated here so
// a change to either side fails this test.
const tillSubtotal = (items) => items.filter((i) => !i.voided).reduce((s, i) => {
  const base = i.price * i.qty;
  if (!i.discount) return s + base;
  return s + (i.discount.type === 'percent' ? base * (1 - i.discount.value / 100) : Math.max(0, base - i.discount.value));
}, 0);

test('customer display: a line with a paid option shows the price the till charges, not the option added again', () => {
  const [line] = displayLinesFor([latte]);
  assert.equal(line.lineTotal, 2.2);
  assert.deepEqual(line.mods, [{ label: 'Skinny', price: 0.7 }, { label: 'HOT', price: 0 }]);
  assert.equal(line.qty, 1);
  assert.equal(line.name, 'Latte, Small');
});

test('customer display: the line total is unit times quantity, and the lines add up to the till subtotal', () => {
  const items = [{ ...latte, qty: 2 }, { uid: 'b', name: 'Flat white', price: 3.1, qty: 1, mods: [] }];
  const lines = displayLinesFor(items);
  assert.equal(lines[0].lineTotal, 4.4);
  assert.equal(lines[1].lineTotal, 3.1);
  near(lines.reduce((s, l) => s + l.lineTotal, 0), tillSubtotal(items));
});

test('customer display: an item discount comes off the line the way the till charges it (percent and amount)', () => {
  const half = { ...latte, discount: { type: 'percent', value: 50 } };
  const pound = { ...latte, uid: 'c', qty: 2, discount: { type: 'amount', value: 1 } };
  const tooBig = { ...latte, uid: 'd', discount: { type: 'amount', value: 5 } };
  near(lineChargedTotal(half), 1.1);
  near(lineChargedTotal(pound), 3.4);
  assert.equal(lineChargedTotal(tooBig), 0);
  const lines = displayLinesFor([half, pound, tooBig]);
  near(lines[0].lineTotal, 1.1); near(lines[1].lineTotal, 3.4); assert.equal(lines[2].lineTotal, 0);
  assert.equal(lines.reduce((s, l) => s + l.lineTotal, 0), tillSubtotal([half, pound, tooBig]));
});

test('customer display: voided lines are left out', () => {
  const lines = displayLinesFor([latte, { ...latte, uid: 'v', voided: true }]);
  assert.equal(lines.length, 1);
});

test('reader screen: unit amount in pence is the charged unit price, options not added again, discounts off', () => {
  const [plain] = readerLinesFor([{ ...latte, qty: 3 }]);
  assert.deepEqual(plain, { description: 'Latte, Small', amount: 220, quantity: 3 });
  const [half] = readerLinesFor([{ ...latte, qty: 2, discount: { type: 'percent', value: 50 } }]);
  assert.deepEqual(half, { description: 'Latte, Small', amount: 110, quantity: 2 });
});

test('both screens: a line with no price, no qty and no mods still renders', () => {
  const [d] = displayLinesFor([{ uid: 'x', name: 'Water' }]);
  assert.deepEqual(d, { uid: 'x', name: 'Water', qty: 1, lineTotal: 0, mods: [], notes: '' });
  const [r] = readerLinesFor([{ uid: 'x', name: 'Water' }]);
  assert.deepEqual(r, { description: 'Water', amount: 0, quantity: 1 });
});
