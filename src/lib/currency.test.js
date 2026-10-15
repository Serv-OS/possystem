/** currency.test.js — money strings. Run: npm test */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { money, signedMoney } from './currency.js';

test('signedMoney puts the sign before the symbol; money() is unchanged for the till', () => {
  assert.equal(signedMoney(-19.63), '-£19.63');
  assert.equal(signedMoney(19.63), '£19.63');
  assert.equal(signedMoney(0), '£0.00');
  assert.equal(signedMoney(-0.004), '-£0.00');
  assert.equal(signedMoney('abc'), '£0.00');
  assert.equal(signedMoney(-5, 'USD'), '-$5.00');
  // the till and receipts keep the string they have always printed
  assert.equal(money(-19.63), '£-19.63');
  assert.equal(money(19.63), '£19.63');
});
