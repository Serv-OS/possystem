// terminalJobBookingMoney.test.js: a reader or PAX close of a prepaid table books the check GROSS
// (16 Oct 2026). A £100 bill with a £96 prepay and £4 on the reader must book total 100.00 with
// tenders that add up to it, exactly as the till's own checkout books it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { bookingLegsMinor, closerGrandMinor, closerMethod } from './terminalJobCloser.js';
import { finishTenders, tender, bookingTenders } from '../accounting/tenders.js';

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
const prepay = { legs: [{ method: 'booking_prepaid', amountMinor: 9600 }] };

test('booking legs add up; no legs is 0', () => {
  assert.equal(bookingLegsMinor(prepay), 9600);
  assert.equal(bookingLegsMinor({ legs: [{ amountMinor: 500 }, { amountMinor: '250' }, {}] }), 750);
  assert.equal(bookingLegsMinor(null), 0);
  assert.equal(bookingLegsMinor({}), 0);
});

test('a £96 prepay with £4 on the reader books 100.00 and the tenders add up to it', () => {
  const grand = closerGrandMinor({ chargeMinor: 400, priorChargeMinor: 0, bookingPayment: prepay });
  assert.equal(grand, 10000);
  const tenders = finishTenders([...bookingTenders(prepay), tender('card', 4, 0)]);
  const sum = tenders.reduce((n, t) => n + Math.round((Number(t.amount) + (Number(t.tip) || 0)) * 100), 0);
  assert.equal(sum, grand);
});

test('no booking: the grand is the card legs, as before', () => {
  assert.equal(closerGrandMinor({ chargeMinor: 1234, priorChargeMinor: 500 }), 1734);
  assert.equal(closerMethod({ split: false }), 'card');
  assert.equal(closerMethod({ split: true }), 'split');
  assert.equal(closerMethod({ split: false, bookingPayment: prepay }), 'booking+card');
  assert.equal(closerMethod({ split: true, bookingPayment: prepay }), 'booking+split');
});

test('the store books the same gross on the rich and the headless path', () => {
  const store = read('../../store/index.js');
  const close = store.slice(store.indexOf('closeApprovedTerminalJob: async (job) => {'), store.indexOf('_reverseTerminalJobGift: async ('));
  assert.match(close, /const closeGrandMinor = closerGrandMinor\(/);
  assert.match(close, /grand: closeGrandMinor \/ 100/);
  assert.match(close, /total: closeGrandMinor \/ 100/);
  assert.doesNotMatch(close, /\(\(job\.charge_minor \?\? 0\) \+ priorChargeMinor\) \/ 100/);
});
