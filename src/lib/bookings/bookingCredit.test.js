import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bookingCreditFor, bookingCreditLabel } from './bookingCredit.js';

const brunch = { booking: { bookingId: 'bk-1', packageName: 'Bottomless Brunch', prepaidMinor: 7600, depositMinor: 0 } };

test('prepaid package: a payment line and the balance only', () => {
  const c = bookingCreditFor(brunch, 85.5);
  assert.equal(c.hasCredit, true);
  assert.equal(c.label, 'Bottomless Brunch prepaid');
  assert.equal(c.creditMinor, 7600);
  assert.equal(c.appliedMinor, 7600);
  assert.equal(c.balanceMinor, 950);
  assert.equal(c.surplusMinor, 0);
});

test('credit larger than the bill: nothing to pay, the rest stays on the booking', () => {
  const c = bookingCreditFor(brunch, 60);
  assert.equal(c.appliedMinor, 6000);
  assert.equal(c.balanceMinor, 0);
  assert.equal(c.surplusMinor, 1600);
});

test('deposit only, and both kinds together', () => {
  assert.equal(bookingCreditLabel({ depositMinor: 2000 }), 'Booking deposit');
  assert.equal(bookingCreditLabel({ prepaidMinor: 100, depositMinor: 2000 }), 'Booking payments');
  assert.equal(bookingCreditLabel({ prepaidMinor: 100 }), 'Package prepaid');
  const c = bookingCreditFor({ booking: { prepaidMinor: 1000, depositMinor: 2000 } }, 50);
  assert.equal(c.creditMinor, 3000);
  assert.equal(c.balanceMinor, 2000);
});

test('no booking, no money, or junk values: no credit line', () => {
  assert.equal(bookingCreditFor(null, 10).hasCredit, false);
  assert.equal(bookingCreditFor({}, 10).balanceMinor, 1000);
  assert.equal(bookingCreditFor({ booking: { prepaidMinor: -5, depositMinor: 'x' } }, 10).creditMinor, 0);
  assert.equal(bookingCreditLabel(null), null);
});

test('without a total only the credit is known', () => {
  const c = bookingCreditFor(brunch);
  assert.equal(c.creditMinor, 7600);
  assert.equal(c.balanceMinor, null);
});

test('float noise in the bill rounds to the penny', () => {
  const c = bookingCreditFor({ booking: { prepaidMinor: 1000 } }, 0.1 + 0.2 + 10);
  assert.equal(c.totalMinor, 1030);
  assert.equal(c.balanceMinor, 30);
});
