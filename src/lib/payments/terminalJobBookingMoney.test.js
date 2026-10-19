// terminalJobBookingMoney.test.js: a reader or PAX close of a prepaid table books the check GROSS
// (16 Oct 2026). A £100 bill with a £96 prepay and £4 on the reader must book total 100.00 with
// tenders that add up to it, exactly as the till's own checkout books it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { bookingLegsMinor, giftLegsMinor, closerGrandMinor, closerMethod, closerCardIntents, withBookingIntents } from './terminalJobCloser.js';
import { finishTenders, tender, bookingTenders, giftTenders } from '../accounting/tenders.js';

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

// Review fix (16 Oct, release merge): the card leg is named with the charge, never the gross.
const sumIntents = (list) => (list || []).reduce((n, p) => n + (Number(p.amountMinor) || 0), 0);

test('rich and headless paths: a £4 card leg with a £96 prepay stores 400 on the card, intents add up to the total', () => {
  const grand = closerGrandMinor({ chargeMinor: 400, bookingPayment: prepay });
  // Rich path: termPay.paymentIntents (undefined would fall back to grand on one id).
  const rich = withBookingIntents(closerCardIntents({ legIntents: null, transactionId: 'psp_1', chargeMinor: 400, bookingPayment: prepay }) || undefined, prepay);
  // Headless path: record.paymentIntents (null would fall back to check.total on one id).
  const headless = withBookingIntents(closerCardIntents({ legIntents: null, transactionId: 'psp_1', chargeMinor: 400, bookingPayment: prepay }), prepay);
  for (const list of [rich, headless]) {
    const card = list.filter((p) => p.id);
    assert.deepEqual(card, [{ id: 'psp_1', amountMinor: 400 }]);
    assert.equal(sumIntents(list), grand);
    assert.equal(list.find((p) => !p.id).method, 'booking_prepaid');
  }
});

test('card intents: no booking or gift money stays null (derived as before); a split keeps its legs', () => {
  assert.equal(closerCardIntents({ transactionId: 'psp_1', chargeMinor: 1234 }), null);
  const legs = [{ id: 'psp_2', amountMinor: 500 }, { id: 'psp_1', amountMinor: 700 }];
  assert.equal(closerCardIntents({ legIntents: legs, transactionId: 'psp_2', chargeMinor: 500, bookingPayment: prepay }), legs);
  assert.equal(closerCardIntents({ transactionId: null, chargeMinor: 400, bookingPayment: prepay }), null);
  assert.equal(withBookingIntents(null, null), null);
});

test('a gift card debited before the job counts in the gross and the tenders still add up', () => {
  const gift = { card_id: 'g1', applied: 1500 };
  assert.equal(giftLegsMinor(gift), 1500);
  assert.equal(giftLegsMinor({ legs: [{ applied: 500 }, { applied: 300, commit_error: 'x' }] }), 500);
  assert.equal(giftLegsMinor(null), 0);
  const grand = closerGrandMinor({ chargeMinor: 400, bookingPayment: prepay, giftCard: gift });
  assert.equal(grand, 11500);
  const tenders = finishTenders([...bookingTenders(prepay), ...giftTenders(gift), tender('card', 4, 0)]);
  const sum = tenders.reduce((n, t) => n + Math.round((Number(t.amount) + (Number(t.tip) || 0)) * 100), 0);
  assert.equal(sum, grand);
  const intents = closerCardIntents({ transactionId: 'psp_1', chargeMinor: 400, giftCard: gift });
  assert.deepEqual(intents, [{ id: 'psp_1', amountMinor: 400 }]);
});

test('the store names the card leg on both paths', () => {
  const store = read('../../store/index.js');
  const close = store.slice(store.indexOf('closeApprovedTerminalJob: async (job) => {'), store.indexOf('_reverseTerminalJobGift: async ('));
  assert.match(close, /paymentIntents: cardIntents \|\| undefined,/);
  assert.match(close, /paymentIntents: cardIntents, cardReceipt,/);
  assert.match(close, /withBookingIntents\(record\.paymentIntents, d\.bookingPayment\)/);
  // 19 Oct 2026 (v5.11.78): plus the reward and promo credits the checkout took off.
  assert.match(close, /bookingCreditMinor \+ giftMinor \+ credits\.creditMinor\)\)/);
});
