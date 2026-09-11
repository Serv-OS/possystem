/**
 * bookingPayment.test.js — the booking payment gate rules (10 Sep 2026).
 * Peter: "payment must be paid before booking confirms on the system".
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  packagePaymentNeed, paymentDue, packageSellableOnline, statusAtBooking, promotedStatusFor,
  storedDue, amountCovers, paymentSatisfiesDue, tablesStillFree, promotionDecision,
  bookingOwesPayment, undoNoShowStatus, bookingUnpaid, timeToMin,
  dueForCharge, coveringBookingPayment, liveTabOnTables, stuckPaymentReason, isNeedsRefundRow, isPaidRow,
} from './bookingPayment.js';

// The live Provo package and rules from the incident.
const PROVO_PREORDER = { id: 'pk-1786580494031-hd32', name: 'Pre Order Dinner', payment_model: 'prepay', price: 120, price_unit: 'per_cover', requires_preorder: true };
const PROVO_RULES = { card_capture_enabled: true, hold_per_cover: 20, card_capture_min_covers: 2 };

test('packagePaymentNeed: prepay and deposit above zero need payment, at zero they are misconfigured', () => {
  assert.deepEqual(packagePaymentNeed(PROVO_PREORDER), { kind: 'prepay', needsPayment: true, misconfigured: false });
  assert.deepEqual(packagePaymentNeed({ payment_model: 'prepay', price: 0 }), { kind: 'prepay', needsPayment: false, misconfigured: true });
  assert.deepEqual(packagePaymentNeed({ paymentModel: 'deposit', depositPerCover: 10 }), { kind: 'deposit', needsPayment: true, misconfigured: false });
  assert.deepEqual(packagePaymentNeed({ paymentModel: 'deposit', depositPerCover: 0 }), { kind: 'deposit', needsPayment: false, misconfigured: true });
  assert.deepEqual(packagePaymentNeed({ payment_model: 'hold', price: 50 }), { kind: null, needsPayment: false, misconfigured: false });
  assert.deepEqual(packagePaymentNeed(null), { kind: null, needsPayment: false, misconfigured: false });
  assert.equal(packagePaymentNeed({ payment_model: 'prepay', price: -5 }).misconfigured, true);
});

test('paymentDue: prepay per cover and per booking, deposit per cover', () => {
  assert.deepEqual(paymentDue({ covers: 2, pkg: PROVO_PREORDER, rules: PROVO_RULES }), { kind: 'prepay', amountMinor: 24000 });
  assert.deepEqual(paymentDue({ covers: 4, pkg: { payment_model: 'prepay', price: 99.5, price_unit: 'per_booking' } }), { kind: 'prepay', amountMinor: 9950 });
  assert.deepEqual(paymentDue({ covers: 3, pkg: { paymentModel: 'deposit', depositPerCover: 12.5 } }), { kind: 'deposit', amountMinor: 3750 });
});

test('paymentDue: prepay and deposit are due even with capture off (the caller refuses to sell them)', () => {
  assert.deepEqual(paymentDue({ covers: 2, pkg: PROVO_PREORDER, rules: { card_capture_enabled: false } }), { kind: 'prepay', amountMinor: 24000 });
});

test('paymentDue: hold only with capture on, from the covers threshold, above zero', () => {
  assert.deepEqual(paymentDue({ covers: 2, rules: PROVO_RULES }), { kind: 'hold', amountMinor: 4000 });
  assert.equal(paymentDue({ covers: 1, rules: PROVO_RULES }), null);
  assert.equal(paymentDue({ covers: 6, rules: { ...PROVO_RULES, card_capture_enabled: false } }), null);
  assert.equal(paymentDue({ covers: 6, rules: { ...PROVO_RULES, hold_per_cover: 0 } }), null);
  assert.deepEqual(paymentDue({ covers: 1, rules: { cardCaptureEnabled: true, holdPerCover: 5, cardCaptureMinCovers: 0 } }), { kind: 'hold', amountMinor: 500 });
  assert.equal(paymentDue({ covers: 2 }), null);
});

test('paymentDue: a misconfigured package falls to the venue hold rule, never to a £0 charge', () => {
  assert.deepEqual(paymentDue({ covers: 2, pkg: { payment_model: 'deposit', deposit_per_cover: 0 }, rules: PROVO_RULES }), { kind: 'hold', amountMinor: 4000 });
  assert.equal(paymentDue({ covers: 2, pkg: { payment_model: 'prepay', price: 0 } }), null);
});

test('packageSellableOnline: never sells a payment package without capture and a usable Adyen', () => {
  assert.deepEqual(packageSellableOnline(PROVO_PREORDER, { captureOn: true, adyenUsable: true }), { ok: true, reason: null });
  assert.deepEqual(packageSellableOnline(PROVO_PREORDER, { captureOn: false, adyenUsable: true }), { ok: false, reason: 'capture_off' });
  assert.deepEqual(packageSellableOnline(PROVO_PREORDER, { captureOn: true, adyenUsable: false }), { ok: false, reason: 'adyen_unusable' });
  assert.deepEqual(packageSellableOnline({ payment_model: 'deposit', deposit_per_cover: 0 }, { captureOn: true, adyenUsable: true }), { ok: false, reason: 'package_misconfigured' });
  assert.deepEqual(packageSellableOnline({ payment_model: 'hold' }, {}), { ok: true, reason: null });
});

test('statusAtBooking never writes prepaid; promotedStatusFor maps kinds', () => {
  assert.equal(statusAtBooking({ kind: 'prepay', amountMinor: 24000 }), 'pending_payment');
  assert.equal(statusAtBooking(null), 'confirmed');
  assert.equal(promotedStatusFor('prepay'), 'prepaid');
  assert.equal(promotedStatusFor('deposit'), 'confirmed');
  assert.equal(promotedStatusFor('hold'), 'confirmed');
});

test('storedDue reads the book-time columns in either shape, null when absent', () => {
  assert.deepEqual(storedDue({ payment_kind: 'prepay', payment_due_minor: 24000, payment_currency: 'gbp' }), { kind: 'prepay', amountMinor: 24000, currency: 'GBP' });
  assert.deepEqual(storedDue({ paymentKind: 'hold', paymentDueMinor: '4000' }), { kind: 'hold', amountMinor: 4000, currency: null });
  assert.equal(storedDue({ payment_kind: null, payment_due_minor: null }), null);
  assert.equal(storedDue({ status: 'pending_payment' }), null);
  assert.equal(storedDue({ payment_kind: 'refund', payment_due_minor: 100 }), null);
  assert.equal(storedDue(null), null);
});

test('amountCovers: full amount, same currency, holds excepted', () => {
  assert.equal(amountCovers({ kind: 'prepay', dueMinor: 24000, paidMinor: 24000, dueCurrency: 'GBP', paidCurrency: 'gbp' }), true);
  assert.equal(amountCovers({ kind: 'prepay', dueMinor: 24000, paidMinor: 23999, dueCurrency: 'GBP', paidCurrency: 'GBP' }), false);
  assert.equal(amountCovers({ kind: 'deposit', dueMinor: 2000, paidMinor: 2000, dueCurrency: 'GBP', paidCurrency: 'USD' }), false);
  assert.equal(amountCovers({ kind: 'deposit', dueMinor: 2000, paidMinor: 2000, dueCurrency: 'GBP', paidCurrency: '' }), false);
  assert.equal(amountCovers({ kind: 'prepay', dueMinor: 0, paidMinor: 0, dueCurrency: 'GBP', paidCurrency: 'GBP' }), false);
  assert.equal(amountCovers({ kind: 'hold', dueMinor: 4000, paidMinor: 0 }), true);
  assert.equal(amountCovers({ kind: 'refund', dueMinor: 1, paidMinor: 5, dueCurrency: 'GBP', paidCurrency: 'GBP' }), false);
});

test('paymentSatisfiesDue: a saved card never pays a prepay; a changed package cannot hide an earlier payment', () => {
  const prepayDue = { kind: 'prepay', amountMinor: 24000, currency: 'GBP' };
  assert.equal(paymentSatisfiesDue(prepayDue, { kind: 'hold', amountMinor: 4000, currency: 'GBP' }), false);
  assert.equal(paymentSatisfiesDue(prepayDue, { kind: 'prepay', amountMinor: 24000, currency: 'GBP' }), true);
  assert.equal(paymentSatisfiesDue(prepayDue, { kind: 'deposit', amountMinor: 24000, currency: 'GBP' }), true);
  assert.equal(paymentSatisfiesDue({ kind: 'hold', amountMinor: 4000, currency: 'GBP' }, { kind: 'prepay', amountMinor: 1, currency: 'GBP' }), true);
  assert.equal(paymentSatisfiesDue(null, { kind: 'prepay' }), false);
});

test('tablesStillFree: same half-open overlap as create_booking, non-blocking statuses ignored', () => {
  const mine = { id: 'bk-1', startTime: '19:00', turnMinutes: 120, tables: ['T5'] };
  assert.equal(tablesStillFree(mine, []), true);
  assert.equal(tablesStillFree(mine, [{ id: 'bk-2', status: 'confirmed', startTime: '20:30', turnMinutes: 90, tables: ['T5'] }]), false);
  assert.equal(tablesStillFree(mine, [{ id: 'bk-2', status: 'confirmed', startTime: '21:00', turnMinutes: 90, tables: ['T5'] }]), true, 'touching at the end is free');
  assert.equal(tablesStillFree(mine, [{ id: 'bk-2', status: 'confirmed', start_time: '17:00:00', turn_minutes: 120, primary_table_id: 'T5' }]), true, 'ends as mine starts');
  assert.equal(tablesStillFree(mine, [{ id: 'bk-2', status: 'expired', startTime: '19:00', turnMinutes: 90, tables: ['T5'] }]), true);
  assert.equal(tablesStillFree(mine, [{ id: 'bk-2', status: 'dining', startTime: '18:30', turnMinutes: 90, tables: ['T7', 'T5'] }]), false);
  assert.equal(tablesStillFree(mine, [{ id: 'bk-2', status: 'confirmed', startTime: '19:00', turnMinutes: 90, tables: ['T6'] }]), true);
  assert.equal(tablesStillFree(mine, [{ id: 'bk-1', status: 'confirmed', startTime: '19:00', turnMinutes: 90, tables: ['T5'] }]), true, 'itself never blocks');
  assert.equal(tablesStillFree({ id: 'x', startTime: '19:00', turnMinutes: 90, tables: [] }, []), false, 'no tables is never free');
  assert.equal(timeToMin('19:30:00'), 1170);
});

test('promotionDecision: never promotes cancelled, no_show, departed or dining', () => {
  assert.equal(promotionDecision({ status: 'pending_payment', nextStatus: 'prepaid' }), 'promote');
  assert.equal(promotionDecision({ status: 'prepaid', nextStatus: 'prepaid' }), 'already');
  assert.equal(promotionDecision({ status: 'expired', nextStatus: 'confirmed' }), 'check_tables');
  assert.equal(promotionDecision({ status: 'expired', nextStatus: 'confirmed', tablesFree: true }), 'promote');
  assert.equal(promotionDecision({ status: 'expired', nextStatus: 'confirmed', tablesFree: false }), 'needs_refund');
  for (const status of ['cancelled', 'no_show', 'departed', 'dining', 'confirmed']) {
    assert.equal(promotionDecision({ status, nextStatus: 'prepaid' }), 'refuse', status);
  }
});

test('undoNoShowStatus: expired only for a gated booking whose READ ledger shows no payment', () => {
  const pkg = { paymentModel: 'prepay', price: 120, priceUnit: 'per_cover' };
  const gated = { status: 'no_show', paymentKind: 'prepay', paymentDueMinor: 24000 };
  assert.equal(undoNoShowStatus({ booking: { seatedAt: 1 }, pkg }), 'dining');
  assert.equal(undoNoShowStatus({ booking: { status: 'no_show' }, pkg: null, payments: [] }), 'confirmed');
  // An older booking (no stored due) goes back to confirmed as before, whatever its package.
  assert.equal(undoNoShowStatus({ booking: { status: 'no_show' }, pkg, payments: [] }), 'confirmed');
  assert.equal(undoNoShowStatus({ booking: { status: 'no_show', source: 'widget' }, pkg, payments: null }), 'confirmed');
  // The review case: a PAID prepay booking whose ledger has not loaded (or failed) is never expired.
  assert.equal(undoNoShowStatus({ booking: gated, pkg, payments: null }), null);
  assert.equal(undoNoShowStatus({ booking: gated, pkg }), null);
  assert.equal(undoNoShowStatus({ booking: gated, payments: [{ kind: 'prepay', status: 'captured' }] }), 'confirmed');
  assert.equal(undoNoShowStatus({ booking: gated, payments: [] }), 'expired');
  assert.equal(undoNoShowStatus({ booking: { status: 'no_show', paymentKind: 'hold', paymentDueMinor: 4000 }, payments: [{ kind: 'hold', status: 'authorised' }] }), 'confirmed');
  assert.equal(undoNoShowStatus({ booking: { status: 'no_show', paymentKind: 'hold', paymentDueMinor: 4000 }, payments: [{ kind: 'hold', status: 'failed' }] }), 'expired');
  assert.equal(undoNoShowStatus({ booking: gated, payments: [{ kind: 'refund', status: 'captured' }] }), 'expired');
  // Money flagged to go back never counts as paid.
  assert.equal(undoNoShowStatus({ booking: gated, payments: [{ kind: 'prepay', status: 'captured', refusal_reason: 'NEEDS REFUND: late' }] }), 'expired');
  assert.equal(undoNoShowStatus({ booking: gated, payments: [{ kind: 'prepay', status: 'needs_refund' }] }), 'expired');
});

test('dueForCharge: a stored card hold of 0 on a prepay package is REFUSED (the 1p / £0 rewrite)', () => {
  const recomputed = [paymentDue({ covers: 2, pkg: PROVO_PREORDER, rules: PROVO_RULES })];
  assert.deepEqual(dueForCharge({ stored: { kind: 'hold', amountMinor: 0, currency: 'GBP' }, recomputed }), { ok: false, due: null, reason: 'due_mismatch' });
});

test('dueForCharge: the largest money figure wins, never a smaller one written anywhere', () => {
  const prepay = paymentDue({ covers: 2, pkg: PROVO_PREORDER, rules: PROVO_RULES });
  // Stored prepay 1p, package says £240: charge £240.
  assert.deepEqual(dueForCharge({ stored: { kind: 'prepay', amountMinor: 1, currency: 'GBP' }, recomputed: [prepay] }),
    { ok: true, due: { kind: 'prepay', amountMinor: 24000, currency: 'GBP' } });
  // Before the migration: package_id nulled on the booking (hold recompute) but the audit row still names the prepay package.
  const holdFromNull = paymentDue({ covers: 2, pkg: null, rules: PROVO_RULES });
  assert.deepEqual(dueForCharge({ stored: null, recomputed: [holdFromNull, prepay] }),
    { ok: true, due: { kind: 'prepay', amountMinor: 24000, currency: null } });
  // Holds only: a hold.
  assert.equal(dueForCharge({ stored: null, recomputed: [holdFromNull] }).due.kind, 'hold');
  // Nothing anywhere: nothing due.
  assert.deepEqual(dueForCharge({ stored: null, recomputed: [null, null] }), { ok: true, due: null });
  // A stored prepay beats a hold recompute (package switched to hold later).
  assert.equal(dueForCharge({ stored: { kind: 'prepay', amountMinor: 24000, currency: 'gbp' }, recomputed: [holdFromNull] }).due.amountMinor, 24000);
});

test('coveringBookingPayment: the webhook promotes only on a row that covers the event AND the booking', () => {
  const row = { id: 'p1', booking_id: 'bk-1', kind: 'prepay', amount: 240, currency: 'gbp' };
  const due = { kind: 'prepay', amountMinor: 24000, currency: 'GBP' };
  const ev = { value: 24000, currency: 'GBP' };
  assert.deepEqual(coveringBookingPayment({ rows: [], bookingId: 'bk-1', event: ev, due }), { row: null, reason: 'no_row' });
  assert.deepEqual(coveringBookingPayment({ rows: [{ ...row, booking_id: 'bk-2' }], bookingId: 'bk-1', event: ev, due }), { row: null, reason: 'no_row' });
  assert.equal(coveringBookingPayment({ rows: [row], bookingId: 'bk-1', event: ev, due }).row, row);
  assert.equal(coveringBookingPayment({ rows: [row], bookingId: 'bk-1', event: { value: 100, currency: 'GBP' }, due }).reason, 'amount_short');
  assert.equal(coveringBookingPayment({ rows: [row], bookingId: 'bk-1', event: { value: 24000, currency: 'USD' }, due }).reason, 'amount_short');
  // A 1p row on a £240 booking: the event covers the row, the row does not cover the booking.
  assert.equal(coveringBookingPayment({ rows: [{ ...row, amount: 0.01 }], bookingId: 'bk-1', event: { value: 1, currency: 'GBP' }, due }).reason, 'due_not_covered');
  // A saved card row never pays a prepay booking.
  const hold = { id: 'h1', booking_id: 'bk-1', kind: 'hold', amount: 40, currency: 'gbp', stored_payment_method_id: 'tok' };
  assert.equal(coveringBookingPayment({ rows: [hold], bookingId: 'bk-1', event: { value: 0, currency: 'GBP' }, due }).reason, 'due_not_covered');
  // A hold booking: a hold row promotes with or without a saved card token.
  const holdDue = { kind: 'hold', amountMinor: 4000, currency: 'GBP' };
  assert.equal(coveringBookingPayment({ rows: [hold], bookingId: 'bk-1', event: { value: 0, currency: 'GBP' }, due: holdDue }).row, hold);
  const bare = { ...hold, stored_payment_method_id: null };
  assert.equal(coveringBookingPayment({ rows: [bare], bookingId: 'bk-1', event: { value: 0, currency: 'GBP' }, due: holdDue }).row, bare);
  assert.equal(coveringBookingPayment({ rows: [bare], bookingId: 'bk-1', event: { value: 0, currency: 'GBP', storedCard: true }, due: holdDue }).row, bare);
  // Nothing owed: the row is judged against its own amount.
  assert.equal(coveringBookingPayment({ rows: [row], bookingId: 'bk-1', event: ev, due: null }).row, row);
  // A row flagged for refund is never used.
  assert.equal(coveringBookingPayment({ rows: [{ ...row, refusal_reason: 'NEEDS REFUND: late' }], bookingId: 'bk-1', event: ev, due }).reason, 'no_row');
});

test('liveTabOnTables: an open till tab today blocks a late promote; other days and other tables do not', () => {
  const sessions = [{ table_id: 'T5', session: { seatedAt: 1, items: [] } }, { table_id: 'T6', session: null }];
  assert.equal(liveTabOnTables({ bookingDate: '2026-09-10', today: '2026-09-10', tableIds: ['T5'], sessions }), true);
  assert.equal(liveTabOnTables({ bookingDate: '2026-09-11', today: '2026-09-10', tableIds: ['T5'], sessions }), false);
  assert.equal(liveTabOnTables({ bookingDate: '2026-09-10', today: '2026-09-10', tableIds: ['T6'], sessions }), false);
  assert.equal(liveTabOnTables({ bookingDate: '2026-09-10', today: '2026-09-10', tableIds: ['T7'], sessions }), false);
  assert.equal(liveTabOnTables({ bookingDate: '2026-09-10', today: '2026-09-10', tableIds: [], sessions }), false);
});

test('stuckPaymentReason: every stranded payment gets a plain reason, transient failures do not', () => {
  assert.equal(stuckPaymentReason({ ok: true, promoted: true }), null);
  assert.equal(stuckPaymentReason({ ok: true, promoted: false, status: 'prepaid' }), null);
  assert.equal(stuckPaymentReason({ ok: false, error: 'lookup_failed' }), null);
  assert.equal(stuckPaymentReason({ ok: false, error: 'promote_failed' }), null);
  assert.match(stuckPaymentReason({ ok: false, error: 'not_promotable', status: 'dining' }), /seated/);
  assert.match(stuckPaymentReason({ ok: false, error: 'not_promotable', status: 'cancelled' }), /cancelled/);
  assert.match(stuckPaymentReason({ ok: false, error: 'table_taken', status: 'expired' }), /table was booked again/);
  assert.match(stuckPaymentReason({ ok: false, error: 'unknown_booking' }), /no longer exists/);
  assert.match(stuckPaymentReason({ error: 'due_mismatch' }), /did not match/);
  for (const s of ['dining', 'cancelled', 'no_show', 'departed', 'expired']) {
    const why = stuckPaymentReason({ ok: false, error: 'not_promotable', status: s });
    assert.ok(why && why.length < 120 && !/[—–]/.test(why), s);
  }
});

test('isNeedsRefundRow and isPaidRow: before and after the migration', () => {
  assert.equal(isNeedsRefundRow({ status: 'needs_refund' }), true);
  assert.equal(isNeedsRefundRow({ status: 'captured', refusal_reason: 'NEEDS REFUND: late' }), true);
  assert.equal(isNeedsRefundRow({ status: 'captured', refusal_reason: 'needs refund: late' }), true);
  assert.equal(isNeedsRefundRow({ status: 'captured', refusal_reason: null }), false);
  assert.equal(isPaidRow({ status: 'captured', kind: 'prepay' }), true);
  assert.equal(isPaidRow({ status: 'captured', kind: 'prepay', refusal_reason: 'NEEDS REFUND: x' }), false);
  assert.equal(isPaidRow({ status: 'authorised', kind: 'hold' }), true);
  assert.equal(isPaidRow({ status: 'pending', kind: 'hold' }), false);
  assert.equal(bookingUnpaid({ booking: { status: 'confirmed', paymentKind: 'prepay', paymentDueMinor: 24000 }, payments: [{ kind: 'prepay', status: 'captured', refusal_reason: 'NEEDS REFUND: x' }] }), true);
});

test('bookingOwesPayment and bookingUnpaid', () => {
  const pkg = { paymentModel: 'deposit', depositPerCover: 10 };
  assert.equal(bookingOwesPayment({ paymentKind: 'deposit', paymentDueMinor: 2000 }, null), true);
  assert.equal(bookingOwesPayment({}, pkg), true);
  assert.equal(bookingOwesPayment({}, { paymentModel: 'hold' }), false);
  assert.equal(bookingUnpaid({ booking: { status: 'pending_payment' } }), true);
  assert.equal(bookingUnpaid({ booking: { status: 'confirmed' }, pkg, payments: null }), false, 'ledger not read yet');
  assert.equal(bookingUnpaid({ booking: { status: 'confirmed' }, pkg, payments: [] }), true);
  assert.equal(bookingUnpaid({ booking: { status: 'confirmed' }, pkg, payments: [{ kind: 'deposit', status: 'captured' }] }), false);
  assert.equal(bookingUnpaid({ booking: { status: 'confirmed', source: 'host' }, pkg: null, payments: [] }), false);
  assert.equal(bookingUnpaid({ booking: null }), false);
});
