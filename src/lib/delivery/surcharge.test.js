/**
 * surcharge.test.js — delivery surcharge policy maths (pennies-correct).
 * Run: `node --test`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeSurcharge, DEFAULT_SURCHARGE_POLICY } from './surcharge.js';

test('pass-through (default): customer pays exactly the Uber cost, zero margin', () => {
  const r = computeSurcharge({ uberFeeMinor: 480 });
  assert.equal(r.customerFeeMinor, 480);
  assert.equal(r.trueCostMinor, 480);
  assert.equal(r.marginMinor, 0);
  assert.equal(r.policyApplied, 'pass_through');
  assert.equal(r.freeDelivery, false);
});

test('markup: +% and +fixed, rounded to pennies, positive margin', () => {
  // 480 * 1.10 = 528, + 50p fixed = 578
  const r = computeSurcharge({ uberFeeMinor: 480, policy: { mode: 'markup', markupPct: 10, markupFixedMinor: 50 } });
  assert.equal(r.customerFeeMinor, 578);
  assert.equal(r.trueCostMinor, 480);
  assert.equal(r.marginMinor, 98);
  assert.equal(r.policyApplied, 'markup');
});

test('subsidise: merchant absorbs fixed + %, negative margin, never below zero', () => {
  // 480 - 100 - (480*10%)=48 => 332
  const r = computeSurcharge({ uberFeeMinor: 480, policy: { mode: 'subsidise', subsidiseMinor: 100, subsidisePct: 10 } });
  assert.equal(r.customerFeeMinor, 332);
  assert.equal(r.marginMinor, 332 - 480);
  // Heavy subsidy clamps at 0 (never negative customer fee)
  const r2 = computeSurcharge({ uberFeeMinor: 480, policy: { mode: 'subsidise', subsidiseMinor: 1000 } });
  assert.equal(r2.customerFeeMinor, 0);
  assert.equal(r2.marginMinor, -480);
});

test('flat: fixed customer fee regardless of Uber cost', () => {
  const r = computeSurcharge({ uberFeeMinor: 735, policy: { mode: 'flat', flatMinor: 299 } });
  assert.equal(r.customerFeeMinor, 299);
  assert.equal(r.marginMinor, 299 - 735);
  assert.equal(r.policyApplied, 'flat');
});

test('cap: customer fee never exceeds capMinor; policyApplied notes the cap', () => {
  const r = computeSurcharge({ uberFeeMinor: 900, policy: { mode: 'pass_through', capMinor: 500 } });
  assert.equal(r.customerFeeMinor, 500);
  assert.equal(r.trueCostMinor, 900);
  assert.equal(r.marginMinor, -400);
  assert.equal(r.policyApplied, 'pass_through+cap');
});

test('free over threshold: customer fee 0, merchant eats the whole Uber cost', () => {
  const r = computeSurcharge({ uberFeeMinor: 480, orderSubtotalMinor: 5000, policy: { freeOverMinor: 4000 } });
  assert.equal(r.customerFeeMinor, 0);
  assert.equal(r.freeDelivery, true);
  assert.equal(r.policyApplied, 'free_over');
  assert.equal(r.marginMinor, -480);
  // Just below the threshold → normal pass-through
  const r2 = computeSurcharge({ uberFeeMinor: 480, orderSubtotalMinor: 3999, policy: { freeOverMinor: 4000 } });
  assert.equal(r2.customerFeeMinor, 480);
  assert.equal(r2.freeDelivery, false);
});

test('minimum order value is flagged but does not itself change the fee', () => {
  const r = computeSurcharge({ uberFeeMinor: 480, orderSubtotalMinor: 1200, policy: { minOrderMinor: 1500 } });
  assert.equal(r.belowMinimum, true);
  assert.equal(r.customerFeeMinor, 480);
  const r2 = computeSurcharge({ uberFeeMinor: 480, orderSubtotalMinor: 1500, policy: { minOrderMinor: 1500 } });
  assert.equal(r2.belowMinimum, false);
});

test('garbage / missing inputs degrade safely to zero, never NaN', () => {
  const r = computeSurcharge({ uberFeeMinor: undefined });
  assert.equal(r.customerFeeMinor, 0);
  assert.equal(r.trueCostMinor, 0);
  assert.equal(Number.isFinite(r.marginMinor), true);
});

test('DEFAULT_SURCHARGE_POLICY is pass-through', () => {
  assert.equal(DEFAULT_SURCHARGE_POLICY.mode, 'pass_through');
});
