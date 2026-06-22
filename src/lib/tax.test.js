/**
 * tax.test.js — net (ex-VAT) price extraction used by gross-profit maths.
 * Run: `npm test` (Node's built-in runner — no third-party framework).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { netOf, resolveTaxRate, purchaseNet } from './tax.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

const VAT20 = { id: 'r20', rate: 0.2, type: 'inclusive' };
const VAT0 = { id: 'r0', rate: 0, type: 'inclusive' };
const US = { id: 'us', rate: 0.08875, type: 'exclusive' };

test('netOf strips inclusive UK VAT', () => {
  near(netOf(6.0, VAT20), 5.0);          // £6 inc 20% → £5 net
  near(netOf(3.6, VAT20), 3.0);
});

test('netOf leaves zero-rated and exclusive prices unchanged', () => {
  near(netOf(6.0, VAT0), 6.0);           // 0% → price is already net
  near(netOf(6.0, US), 6.0);             // exclusive → shelf price IS the net
  near(netOf(6.0, null), 6.0);           // no rate → unchanged
});

test('netOf is null for a non-numeric price', () => {
  assert.equal(netOf(null, VAT20), null);
  assert.equal(netOf(undefined, VAT20), null);
});

test('resolveTaxRate honours order-type overrides then the item default', () => {
  const rates = [VAT20, VAT0];
  const item = { taxRateId: 'r20', taxOverrides: { takeaway: 'r0' } };
  assert.equal(resolveTaxRate(item, rates, 'dine-in').id, 'r20');
  assert.equal(resolveTaxRate(item, rates, 'takeaway').id, 'r0');   // zero-rated takeaway
});

test('purchaseNet keeps ex-VAT prices and strips inc-VAT prices', () => {
  near(purchaseNet(10, false, 0.2), 10);   // entered ex-VAT → already net
  near(purchaseNet(12, true, 0.2), 10);    // entered inc-VAT → strip 20% → £10 net
  near(purchaseNet(10, true, 0), 10);      // inc-VAT but 0% rate → unchanged
  near(purchaseNet(10, false, 0), 10);
});

test('purchaseNet returns null for a non-numeric price', () => {
  assert.equal(purchaseNet(null, true, 0.2), null);
  assert.equal(purchaseNet('', false, 0.2), null);
});

test('alcohol GP correct end-to-end on net buy and net sell', () => {
  const grossBuy = 12.0, grossSell = 18.0;            // both inc 20% VAT
  const netCost = purchaseNet(grossBuy, true, 0.2);   // £10
  const netSell = netOf(grossSell, VAT20);            // £15
  near(netCost, 10); near(netSell, 15);
  near(((netSell - netCost) / netSell) * 100, 100 / 3); // 33.3% GP on net/net
});

test('GP on a VAT-inclusive price uses the net, not the shelf price', () => {
  const shelf = 6.0, cost = 1.5;
  const net = netOf(shelf, VAT20);                 // £5
  near(((net - cost) / net) * 100, 70);            // 70% GP on net…
  // …vs the wrong answer if you used the gross price:
  near(((shelf - cost) / shelf) * 100, 75);        // 75% — overstated
});
