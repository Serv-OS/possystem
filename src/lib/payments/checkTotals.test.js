/**
 * checkTotals.test.js — the v5.7.31 UK lock on computeCheckTotals.
 *
 * v5.7.31 added the exclusive (added-on) sales-tax term to `total`. The
 * contract is ZERO movement for UK venues: the golden test below pins a UK
 * inclusive check (items + service + discounts) to the LITERAL totals the
 * v5.7.30 engine produced — with the venue's tax rates passed in and without.
 *
 * Run: `npm test` (Node's built-in runner — no third-party framework).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeCheckTotals } from './checkTotals.js';

const UK_RATES = [
  { id: 'vat20', rate: 0.20, type: 'inclusive', active: true, is_default: true },
  { id: 'vat5',  rate: 0.05, type: 'inclusive', active: true, is_default: false },
  { id: 'zero',  rate: 0,    type: 'inclusive', active: true, is_default: false },
];

// A realistic UK dine-in check: item discount, voided line, check-level
// discount, 12.5% service from the device profile.
const UK_CTX = {
  items: [
    { price: 36.00, qty: 1, taxRateId: 'vat20' },                                    // ribeye
    { price: 6.50,  qty: 2, taxRateId: 'vat20' },                                    // 2 pints
    { price: 12.00, qty: 1, taxRateId: 'vat5', discount: { type: 'percent', value: 50 } }, // half-price special
    { price: 9.99,  qty: 1, taxRateId: 'vat20', voided: true },                      // voided — excluded
  ],
  checkDiscounts: [{ id: 'd1', type: 'amount', value: 5 }],
  covers: 2,
  serviceChargeWaived: false,
  orderType: 'dine-in',
  deviceConfig: { serviceCharge: { enabled: true, rate: 12.5, applyTo: 'all', minCovers: 8 } },
  discountRules: [],
  timezone: 'Europe/London',
  deliveryQuote: null,
};

// v5.7.30 literals for UK_CTX: subtotal 55 (36 + 13 + 6), −5 check discount
// → 50, + 12.5% service 6.25 → total 56.25.
const GOLDEN = { subtotal: 55, discountedSub: 50, service: 6.25, total: 56.25 };

test('GOLDEN: UK inclusive check totals are byte-identical with tax rates passed', () => {
  const t = computeCheckTotals({ ...UK_CTX, taxRates: UK_RATES });
  assert.equal(t.subtotal, GOLDEN.subtotal);
  assert.equal(t.discountedSub, GOLDEN.discountedSub);
  assert.equal(t.service, GOLDEN.service);
  assert.equal(t.total, GOLDEN.total);
  assert.equal(t.exclusiveTax, 0);   // exactly 0 — not a rounding artefact
});

test('GOLDEN: UK inclusive check totals are byte-identical with NO tax rates (pre-v5.7.31 callers)', () => {
  const t = computeCheckTotals(UK_CTX);   // no taxRates in ctx at all
  assert.equal(t.subtotal, GOLDEN.subtotal);
  assert.equal(t.discountedSub, GOLDEN.discountedSub);
  assert.equal(t.service, GOLDEN.service);
  assert.equal(t.total, GOLDEN.total);
  assert.equal(t.exclusiveTax, 0);
});

test('US exclusive check: total now carries the added-on tax the screen shows', () => {
  const US_RATES = [
    { id: 'us', rate: 0.08875, type: 'exclusive', active: true, is_default: true },
  ];
  const t = computeCheckTotals({
    items: [{ price: 47.20, qty: 1, taxRateId: 'us' }],
    checkDiscounts: [],
    covers: 1,
    serviceChargeWaived: false,
    orderType: 'takeaway',          // no service on takeaway
    deviceConfig: {},
    discountRules: [],
    taxRates: US_RATES,
  });
  assert.equal(t.exclusiveTax, 4.19);        // 47.20 × 8.875% = 4.189 → half-up cents
  assert.equal(t.total, 47.20 + 4.19);       // subtotal + tax, nothing else
});

test('tax BASIS unchanged: exclusive tax is on pre-discount goods, ignoring check discounts and service', () => {
  const US_RATES = [
    { id: 'us', rate: 0.10, type: 'exclusive', active: true, is_default: true },
  ];
  const t = computeCheckTotals({
    items: [{ price: 20.00, qty: 1, taxRateId: 'us', discount: { type: 'percent', value: 50 } }],
    checkDiscounts: [{ id: 'd1', type: 'amount', value: 2 }],
    covers: 1,
    serviceChargeWaived: false,
    orderType: 'takeaway',
    deviceConfig: {},
    discountRules: [],
    taxRates: US_RATES,
  });
  // Engine basis today: 10% of the FULL £20 (2.00) — not of the discounted £8.
  assert.equal(t.exclusiveTax, 2);
  assert.equal(t.discountedSub, 8);          // 20 → item −50% → 10 → check −2 → 8
  assert.equal(t.total, 10);                 // 8 + 2.00 tax
});
