/**
 * tax.test.js — net (ex-VAT) price extraction used by gross-profit maths.
 * Run: `npm test` (Node's built-in runner — no third-party framework).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { netOf, resolveTaxRate, purchaseNet, calculateOrderTax } from './tax.js';

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

// ── v5.5.857: the "Use default" contract ─────────────────────────────────────
// The item editor has always offered "Use default" (taxRateId null) but the engine
// returned null and booked £0 VAT (live repro: a £36 ribeye on "Use default" booked
// zero). These pin the fix and its two deliberate opt-outs.
const DEFAULTED = [
  { id: 'vat20', rate: 0.20, type: 'inclusive', active: true, isDefault: true },
  { id: 'zero',  rate: 0,    type: 'inclusive', active: true, isDefault: false },
];

test('null taxRateId resolves the venue default rate ("Use default")', () => {
  assert.equal(resolveTaxRate({ taxRateId: null }, DEFAULTED, 'dine-in').id, 'vat20');
});

test('an unmatched rate id resolves NOTHING — never the default (channel unknown-ref opt-out)', () => {
  assert.equal(resolveTaxRate({ taxRateId: '__not_in_menu__' }, DEFAULTED, 'delivery'), null);
});

test('no default configured keeps the old behaviour (null)', () => {
  const noDefault = DEFAULTED.map(r => ({ ...r, isDefault: false }));
  assert.equal(resolveTaxRate({ taxRateId: null }, noDefault, 'dine-in'), null);
});

test('explicit Zero Rate still beats the default (deliberate zero-tax)', () => {
  const item = { taxRateId: null, taxOverrides: { takeaway: 'zero' } };
  assert.equal(resolveTaxRate(item, DEFAULTED, 'takeaway').id, 'zero');
  assert.equal(resolveTaxRate(item, DEFAULTED, 'dine-in').id, 'vat20'); // dine-in falls to default
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

// ── v5.7.31: exclusiveTax — the ADDED-ON share a surface must charge ─────────
// The UK lock: any all-inclusive configuration yields exclusiveTax of EXACTLY 0
// (not a rounding artefact), so UK payables cannot move by a penny.

test('exclusiveTax is exactly 0 for a UK standard-rate check (all VAT20 inclusive)', () => {
  const rates = [
    { id: 'vat20', rate: 0.20, type: 'inclusive', active: true, is_default: true },
  ];
  const items = [
    { price: 36.00, qty: 1, taxRateId: 'vat20' },
    { price: 6.50,  qty: 2, taxRateId: 'vat20' },
  ];
  const r = calculateOrderTax(items, rates, 'dine-in');
  assert.equal(r.exclusiveTax, 0);
  assert.ok(r.totalTax > 0);                        // VAT is still extracted for display/records
});

test('exclusiveTax is exactly 0 for a mixed UK rate card (standard + reduced + zero)', () => {
  const rates = [
    { id: 'vat20', rate: 0.20, type: 'inclusive', active: true, is_default: true },
    { id: 'vat5',  rate: 0.05, type: 'inclusive', active: true, is_default: false },
    { id: 'zero',  rate: 0,    type: 'inclusive', active: true, is_default: false },
  ];
  const items = [
    { price: 12.00, qty: 1, taxRateId: 'vat20' },
    { price: 4.00,  qty: 2, taxRateId: 'vat5' },
    { price: 2.50,  qty: 1, taxRateId: 'zero' },
  ];
  assert.equal(calculateOrderTax(items, rates, 'dine-in').exclusiveTax, 0);
});

test('exclusiveTax is exactly 0 for UK items on "Use default" (null rate id resolves the inclusive default)', () => {
  const rates = [
    { id: 'vat20', rate: 0.20, type: 'inclusive', active: true, is_default: true },
  ];
  const items = [
    { price: 9.95, qty: 3, taxRateId: null },
    { price: 5.00, qty: 1 },                          // no tax fields at all
  ];
  const r = calculateOrderTax(items, rates, 'takeaway');
  assert.equal(r.exclusiveTax, 0);
  assert.ok(r.totalTax > 0);                          // the default rate DID apply
});

test('exclusive 8.875% on 47.20 charges 4.19 on top (half-up cents)', () => {
  const rates = [
    { id: 'us', rate: 0.08875, type: 'exclusive', active: true, is_default: true },
  ];
  const items = [{ price: 47.20, qty: 1, taxRateId: 'us' }];
  const r = calculateOrderTax(items, rates, 'dine-in');
  assert.equal(r.exclusiveTax, 4.19);                 // 4.189 → half-up → 4.19
  assert.ok(r.hasExclusiveTax);
});

test('a mixed inclusive+exclusive check charges ONLY the exclusive share on top', () => {
  const rates = [
    { id: 'vat20', rate: 0.20,    type: 'inclusive', active: true, is_default: false },
    { id: 'us',    rate: 0.08875, type: 'exclusive', active: true, is_default: true },
  ];
  const items = [
    { price: 12.00, qty: 1, taxRateId: 'vat20' },     // VAT already inside the price
    { price: 10.00, qty: 1, taxRateId: 'us' },        // tax added on top
  ];
  const r = calculateOrderTax(items, rates, 'dine-in');
  assert.equal(r.exclusiveTax, 0.89);                 // 0.8875 → half-up → 0.89, NEVER + the £2 VAT
  near(r.totalTax, 2 + 0.8875, 1e-9);                 // records still carry the full tax picture
});
