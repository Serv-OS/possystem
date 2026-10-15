// Kiosk card sales on a card machine are booked so the till can refund them to the card
// (lib/kioskCardLink.js). 30 Sep 2026, Coffee Boy Barnsley R3127 / R3128.
import test from 'node:test';
import assert from 'node:assert/strict';
import { kioskReaderPayment, isKioskReaderPayment, kioskPaymentIsThisBasket, kioskHeldPaymentFits, kioskCheckPaymentFields } from './kioskCardLink.js';
import { tendersTotalMinor } from './accounting/tenders.js';
import { cardLegsOf } from './payments/refundMath.js';

// R3128 as the reader approved it (terminal-job-status columns).
const R3128_JOB = {
  id: '6dbd3dc7-0ebf-4e50-8c02-b8611421e26d',
  status: 'approved',
  processor: 'adyen',
  transaction_id: '52DY001790768087001.FKCSQLSKC3VKBVQ9',
  due_minor: 480,
  charge_minor: 480,
  tip_minor: 0,
  card: { brand: 'mc', last4: '3840' },
  auth_code: '123456',
  closed_check_id: '6b8ad05a-723a-4f5f-8327-6764ae4ba1c2',
  check_draft: { source: 'kiosk_send_to_terminal' },
};

test('an approved Adyen job becomes the kiosk card payment, tied to the sale id the job carries', () => {
  const r = kioskReaderPayment(R3128_JOB, 'ignored-when-the-job-names-one');
  assert.deepEqual(r, {
    kind: 'terminal_job',
    jobId: R3128_JOB.id,
    processor: 'adyen',
    transactionId: R3128_JOB.transaction_id,
    chargeMinor: 480,
    tipMinor: 0,
    card: { brand: 'mc', last4: '3840' },
    authCode: '123456',
    closedCheckId: '6b8ad05a-723a-4f5f-8327-6764ae4ba1c2',
  });
  assert.equal(isKioskReaderPayment(r), true);
  // No closed_check_id on the row: the id ScreenPay sent is used.
  assert.equal(kioskReaderPayment({ ...R3128_JOB, closed_check_id: null }, 'basket-id').closedCheckId, 'basket-id');
});

test('only an approved job with a real charge is ever a card payment', () => {
  for (const status of ['declined', 'cancelled', 'expired', 'unknown', 'charging', 'reconciled', 'pending']) {
    assert.equal(kioskReaderPayment({ ...R3128_JOB, status }), null, status);
  }
  assert.equal(kioskReaderPayment({ ...R3128_JOB, charge_minor: 0 }), null);
  assert.equal(kioskReaderPayment({ ...R3128_JOB, charge_minor: null }), null);
  assert.equal(kioskReaderPayment({ ...R3128_JOB, charge_minor: -100 }), null);
  assert.equal(kioskReaderPayment(null), null);
  assert.equal(kioskReaderPayment('approved'), null);
  // An approved settle with no reference is still the card payment (booked on its processor).
  const noRef = kioskReaderPayment({ ...R3128_JOB, transaction_id: null });
  assert.equal(noRef.transactionId, null);
  assert.equal(noRef.processor, 'adyen');
});

test('a click event or nothing is never read as a card payment (the Place order buttons)', () => {
  const clickEvent = { type: 'click', target: {}, currentTarget: {}, preventDefault() {}, nativeEvent: {} };
  assert.equal(isKioskReaderPayment(clickEvent), false);
  assert.equal(isKioskReaderPayment(undefined), false);
  assert.equal(isKioskReaderPayment(null), false);
  assert.equal(isKioskReaderPayment({ kind: 'terminal_job', chargeMinor: 0 }), false);
  assert.equal(isKioskReaderPayment({ kind: 'terminal_job', chargeMinor: '480' }), false);
  assert.deepEqual(kioskCheckPaymentFields({ reader: clickEvent, tip: 0 }), {});
});

test('single card leg: processor, the refund reference and one card tender', () => {
  const reader = kioskReaderPayment(R3128_JOB);
  const f = kioskCheckPaymentFields({ reader, tip: 0 });
  assert.deepEqual(f, {
    processor: 'adyen',
    stripe_payment_intent_id: '52DY001790768087001.FKCSQLSKC3VKBVQ9',
    tenders: [{ method: 'card', amount: 4.8, tip: 0, psp_ref: '52DY001790768087001.FKCSQLSKC3VKBVQ9', processor: 'adyen' }],
  });
  // The row the kiosk now writes has exactly one card leg, on Adyen, for the whole charge.
  const legs = cardLegsOf({ total: 4.8, ...f });
  assert.equal(legs.length, 1);
  assert.equal(legs[0].id, '52DY001790768087001.FKCSQLSKC3VKBVQ9');
  assert.equal(legs[0].processor, 'adyen');
  assert.equal(legs[0].amountMinor, 480);
});

test('the old kiosk row (no processor, no reference, no tenders) had no card leg and routed to stripe', () => {
  assert.deepEqual(cardLegsOf({ total: 4.8, processor: 'stripe', tenders: null, stripe_payment_intent_id: null }), []);
});

test('the kiosk tip rides inside the charge and is booked as the card tip', () => {
  // Basket 10.00 + kiosk tip 1.50 = 11.50 charged, the reader took no tip of its own.
  const reader = kioskReaderPayment({ ...R3128_JOB, due_minor: 1150, charge_minor: 1150 });
  const f = kioskCheckPaymentFields({ reader, tip: 1.5 });
  assert.deepEqual(f.tenders, [{ method: 'card', amount: 10, tip: 1.5, psp_ref: R3128_JOB.transaction_id, processor: 'adyen' }]);
  assert.equal(tendersTotalMinor(f.tenders), 1150);
});

test('a tip the reader added itself is left for the reader tip heal, like the till', () => {
  const reader = kioskReaderPayment({ ...R3128_JOB, due_minor: 480, tip_minor: 50, charge_minor: 530 });
  const f = kioskCheckPaymentFields({ reader, tip: 0 });
  assert.deepEqual(f.tenders, [{ method: 'card', amount: 4.8, tip: 0, psp_ref: R3128_JOB.transaction_id, processor: 'adyen' }]);
});

test('gift card plus card: tenders sum to the card, the gift card and every credit', () => {
  // Bill 12.00 incl. 1.00 kiosk tip; gift card gave 5.00, a loyalty reward 2.00, a promo 1.00;
  // the card took the rest, 4.00.
  const reader = kioskReaderPayment({ ...R3128_JOB, due_minor: 400, charge_minor: 400 });
  const giftRecord = { card_id: 'gc-1', applied: 500, idempotency_key: 'k' };
  const f = kioskCheckPaymentFields({ reader, tip: 1, giftRecord, loyaltyCredit: 2, promoCredit: 1 });
  assert.deepEqual(f.tenders, [
    { method: 'gift_card', amount: 5, tip: 0, gift_card_id: 'gc-1' },
    { method: 'loyalty', amount: 2, tip: 0 },
    { method: 'promo', amount: 1, tip: 0 },
    { method: 'card', amount: 3, tip: 1, psp_ref: R3128_JOB.transaction_id, processor: 'adyen' },
  ]);
  assert.equal(tendersTotalMinor(f.tenders), 400 + 500 + 200 + 100);
  // The refund leg is the card's own money: the kiosk total is net of the credits.
  const legs = cardLegsOf({ total: 4, ...f });
  assert.equal(legs.length, 1);
  assert.equal(legs[0].amountMinor, 400);
});

test('a gift card whose debit failed is not a tender', () => {
  const reader = kioskReaderPayment({ ...R3128_JOB, due_minor: 400, charge_minor: 400 });
  const giftRecord = { card_id: 'gc-1', applied: 500, idempotency_key: null, commit_error: 'Insufficient balance' };
  const f = kioskCheckPaymentFields({ reader, tip: 0, giftRecord });
  assert.deepEqual(f.tenders.map(t => t.method), ['card']);
});

test('a Ryft job books on Ryft', () => {
  const reader = kioskReaderPayment({ ...R3128_JOB, processor: 'RYFT', transaction_id: 'ps_123' });
  const f = kioskCheckPaymentFields({ reader, tip: 0 });
  assert.equal(f.processor, 'ryft');
  assert.equal(f.stripe_payment_intent_id, 'ps_123');
  assert.equal(f.tenders[0].processor, 'ryft');
});

test('an approved job with no reference: the processor and the card tender, no refund reference', () => {
  const reader = kioskReaderPayment({ ...R3128_JOB, transaction_id: null });
  const f = kioskCheckPaymentFields({ reader, tip: 0 });
  assert.equal(f.processor, 'adyen');
  assert.equal('stripe_payment_intent_id' in f, false);
  assert.deepEqual(f.tenders, [{ method: 'card', amount: 4.8, tip: 0, processor: 'adyen' }]);
});

test('no card machine payment: the row is written exactly as before (no new columns)', () => {
  assert.deepEqual(kioskCheckPaymentFields({ reader: null, tip: 0 }), {});
  // Fully covered by a gift card, or the Stripe reader branch that still passes nothing.
  assert.deepEqual(kioskCheckPaymentFields({ reader: null, tip: 1, giftRecord: { card_id: 'g', applied: 1200 }, loyaltyCredit: 2 }), {});
  assert.deepEqual(kioskCheckPaymentFields(), {});
});

test('a payment belongs to the basket only while it carries the basket check id (a reset never passes it on)', () => {
  const basket = '6b8ad05a-723a-4f5f-8327-6764ae4ba1c2';
  const p = kioskReaderPayment(R3128_JOB, basket);
  assert.equal(kioskPaymentIsThisBasket(p, basket), true);
  // After a reset the basket has no id yet: the late approval is not this basket's.
  assert.equal(kioskPaymentIsThisBasket(p, null), false);
  assert.equal(kioskPaymentIsThisBasket(p, ''), false);
  // The next customer's basket has minted its own id: still not theirs.
  assert.equal(kioskPaymentIsThisBasket(p, 'a-new-basket-id'), false);
  // A payment with no check id at all is never any basket's.
  assert.equal(kioskPaymentIsThisBasket({ ...p, closedCheckId: null }, basket), false);
  // Not a payment (a click event, nothing): never.
  assert.equal(kioskPaymentIsThisBasket({ type: 'click' }, basket), false);
  assert.equal(kioskPaymentIsThisBasket(undefined, basket), false);
});

test('a held payment books only while it still pays the basket exactly', () => {
  const p = kioskReaderPayment(R3128_JOB, 'basket');
  assert.equal(kioskHeldPaymentFits(p, 480), true);
  // The basket changed after the card took the money (a gift card added, an item removed or added).
  assert.equal(kioskHeldPaymentFits(p, 0), false);
  assert.equal(kioskHeldPaymentFits(p, 380), false);
  assert.equal(kioskHeldPaymentFits(p, 580), false);
  // A tip the reader added itself is not part of what the basket asks the card for.
  const tipped = kioskReaderPayment({ ...R3128_JOB, charge_minor: 530, tip_minor: 50 }, 'basket');
  assert.equal(kioskHeldPaymentFits(tipped, 480), true);
  assert.equal(kioskHeldPaymentFits(tipped, 530), false);
  // No payment, or no amount to compare: never fits.
  assert.equal(kioskHeldPaymentFits(null, 480), false);
  assert.equal(kioskHeldPaymentFits(p, NaN), false);
  assert.equal(kioskHeldPaymentFits(p, undefined), false);
});
