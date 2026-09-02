import test from 'node:test';
import assert from 'node:assert/strict';
import { tipBasis, tipBasisMinor, tipInitialKeyFor, tipAmount } from './tipping.js';

test('tip basis is goods after discounts, nothing else', () => {
  assert.equal(tipBasis({ goods: 50, discounts: 5 }), 45);
  assert.equal(tipBasis({ goods: 50 }), 50);
  assert.equal(tipBasis({ goods: 5, discounts: 9 }), 0);
  assert.equal(tipBasisMinor({ goodsMinor: 5000, discountsMinor: 500 }), 4500);
});

test('the same order tips the same everywhere: £50 meal, £5 off, 12.5% service, £2.70 tax', () => {
  const basis = tipBasis({ goods: 50, discounts: 5 });           // 45, service + tax excluded
  assert.equal(tipAmount(basis, '15', null), 6.75);
});

test('a service charge on the bill means No tip is pre-selected', () => {
  const rule = { on: true, pct: [5, 10, 15], default: 10, custom: true };
  assert.equal(tipInitialKeyFor(rule, { serviceCharge: 4.5 }), '0');
  assert.equal(tipInitialKeyFor(rule, { serviceCharge: 0 }), '10');
});
