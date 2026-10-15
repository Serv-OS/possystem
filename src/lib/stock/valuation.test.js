/** valuation.test.js — negative stock is worth nothing, and is shown. Run: npm test */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lineValue, negativeValue, totalStockValue, negativeStock } from './valuation.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `expected ${a} ≈ ${b}`);

test('lineValue floors a negative on hand at zero', () => {
  near(lineValue(10, 1.5), 15);
  near(lineValue(-19.4, 15.88), 0);
  near(lineValue(0, 15.88), 0);
  near(lineValue(5, null), 0);
  near(lineValue('abc', 2), 0);
});

test('negativeValue is what the hole would have taken off', () => {
  near(negativeValue(-19.4, 15.88), -308.072);
  near(negativeValue(-5.04, 2.85), -14.364);
  near(negativeValue(12, 2.85), 0);
});

test('totalStockValue: the Provo picture, the hole no longer subtracts', () => {
  const items = [
    { id: 'a', name: 'Beans', onHand: 12.55, currentCost: 17.28 },
    { id: 'b', name: 'Minced Beef 1kg', onHand: -19.4, currentCost: 15.88 },
    { id: 'c', name: '1 Litre Whole Milk', onHand: -5.04, currentCost: 2.85 },
  ];
  near(totalStockValue(items), 12.55 * 17.28);
  const neg = negativeStock(items);
  assert.deepEqual(neg.map((n) => n.id), ['b', 'c']);     // worst first
  near(neg[0].value, -308.072);
  near(neg[0].value + neg[1].value, -322.436);
  assert.deepEqual(negativeStock([]), []);
  assert.deepEqual(negativeStock(null), []);
  near(totalStockValue(null), 0);
});
