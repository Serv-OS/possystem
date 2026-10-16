// noShowCharge.test.js: the no show and late cancel charge rules (16 Oct 2026).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chargeDecision, noShowFee, lateCancel, chargeQuestion, chargeReference, kindOfReference, attemptOf, nextAttempt,
  refusalWords, chargeCheckIds, chargeCheckRow, feeRate, feeTax, withoutNoShowCharges, takenCharge, moneyText,
  NO_SHOW_KIND, isMissingFunctionReply, everCharged, hoursText, STALE_IN_FLIGHT_MS,
  CHARGE_SOURCE, CHARGE_SOURCE_FALLBACK, isSourceCheckRefusal,
} from './noShowCharge.js';

const booking = (over = {}) => ({
  id: 'bk-1', location_id: 'loc-1', booking_date: '2026-10-16', start_time: '19:30:00', covers: 2,
  status: 'no_show', customer_id: 'cus-1', customer: { name: 'Sam Guest', phone: '+447700900000' },
  cancelled_at: null, ...over,
});
const hold = (over = {}) => ({
  id: 'p-hold', kind: 'hold', status: 'authorised', amount: 40, currency: 'gbp',
  card_last4: '4242', card_brand: 'visa', stored_payment_method_id: 'TOKEN1', created_at: '2026-10-10T10:00:00Z', ...over,
});
const rules = { hold_per_cover: 20, cancellation_window_hours: 24 };
const customer = { id: 'cus-1', stored_payment_method_id: 'TOKEN_CUST', shopper_reference: 'cus-1' };

test('a no show with a saved card is chargeable for the hold the guest agreed to', () => {
  const d = chargeDecision({ booking: booking(), payments: [hold()], rules, customer });
  assert.equal(d.ok, true);
  assert.equal(d.kind, 'no_show');
  assert.equal(d.amountMinor, 4000);
  assert.equal(d.perCoverMinor, 2000);
  assert.equal(d.last4, '4242');
  assert.equal(d.storedId, 'TOKEN1');
  assert.equal(d.shopperReference, 'cus-1');
  assert.equal(chargeQuestion(d), 'Charge £40.00 to the card ending 4242?');
});

test('the token falls back to the guest record only when this booking saved a card', () => {
  const d = chargeDecision({ booking: booking(), payments: [hold({ stored_payment_method_id: null })], rules, customer });
  assert.equal(d.ok, true);
  assert.equal(d.storedId, 'TOKEN_CUST');
  const none = chargeDecision({ booking: booking(), payments: [], rules, customer });
  assert.equal(none.ok, false);
  assert.equal(none.reason, 'no_card');
  const noToken = chargeDecision({ booking: booking(), payments: [hold({ stored_payment_method_id: null })], rules, customer: null });
  assert.equal(noToken.reason, 'no_token');
});

test('one charge per booking: taken, or waiting for the bank, refuses another', () => {
  const taken = { id: 'p2', kind: NO_SHOW_KIND, status: 'captured', amount: 40, currency: 'gbp', card_last4: '4242' };
  const d = chargeDecision({ booking: booking(), payments: [hold(), taken], rules, customer });
  assert.equal(d.ok, false);
  assert.equal(d.reason, 'already_charged');
  assert.match(d.message, /£40\.00 was charged to the card ending 4242/);
  const pending = { id: 'p3', kind: NO_SHOW_KIND, status: 'pending', amount: 40, created_at: '2026-10-16T19:40:00Z' };
  const p = chargeDecision({ booking: booking(), payments: [hold(), pending], rules, customer });
  assert.equal(p.reason, 'charge_in_flight');
  // A declined attempt does not block a second, deliberate try.
  const failed = { id: 'p4', kind: NO_SHOW_KIND, status: 'failed', amount: 40 };
  assert.equal(chargeDecision({ booking: booking(), payments: [hold(), failed], rules, customer }).ok, true);
  // A refund, partial or full, marks the row refunded: the booking was still charged once.
  const refunded = { id: 'p5', kind: NO_SHOW_KIND, status: 'refunded', amount: 40, merchant_reference: 'bkpay-bk-1-noshow-a1' };
  const r = chargeDecision({ booking: booking(), payments: [hold(), refunded], rules, customer });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'already_charged');
  assert.match(r.message, /then refunded/);
  // Authorised then released (cancelled) took nothing: it may be charged.
  const released = { id: 'p6', kind: NO_SHOW_KIND, status: 'cancelled', amount: 40, authorised_at: '2026-10-16T20:00:00Z' };
  assert.equal(chargeDecision({ booking: booking(), payments: [hold(), released], rules, customer }).ok, true);
  assert.equal(everCharged([{ kind: NO_SHOW_KIND, status: 'failed' }]), null);
  assert.equal(everCharged([{ kind: NO_SHOW_KIND, status: 'cancelled', captured_at: '2026-10-16T20:00:00Z' }]).status, 'cancelled');
});

test('a charge stuck waiting with no Adyen reference can be asked for again, the same request', () => {
  const created = '2026-10-16T19:40:00Z';
  const pending = { id: 'p3', kind: NO_SHOW_KIND, status: 'pending', amount: 40, currency: 'gbp', card_last4: '4242', created_at: created, merchant_reference: 'bkpay-bk-1-noshow-a1' };
  const t0 = Date.parse(created);
  const fresh = chargeDecision({ booking: booking(), payments: [hold(), pending], rules, customer, nowMs: t0 + 60_000 });
  assert.equal(fresh.reason, 'charge_in_flight');
  const stale = chargeDecision({ booking: booking(), payments: [hold(), pending], rules, customer, nowMs: t0 + STALE_IN_FLIGHT_MS + 1 });
  assert.equal(stale.ok, false);
  assert.equal(stale.reason, 'stale_in_flight');
  assert.equal(stale.retry.id, 'p3');
  assert.equal(stale.amountMinor, 4000);
  assert.equal(stale.kind, 'no_show');
  // Adyen answered (Received): a webhook will come, so it stays in flight.
  const answered = chargeDecision({ booking: booking(), payments: [hold(), { ...pending, psp_reference: 'PSP1' }], rules, customer, nowMs: t0 + 3_600_000 });
  assert.equal(answered.reason, 'charge_in_flight');
  // No clock handed in: never stale.
  assert.equal(chargeDecision({ booking: booking(), payments: [hold(), pending], rules, customer }).reason, 'charge_in_flight');
  // Undone since: not re-sent.
  assert.equal(chargeDecision({ booking: booking({ status: 'confirmed' }), payments: [hold(), pending], rules, customer, nowMs: t0 + 3_600_000 }).reason, 'charge_in_flight');
});

test('a token from the guest record never shows the hold row card', () => {
  const d = chargeDecision({ booking: booking(), payments: [hold({ stored_payment_method_id: null })], rules, customer });
  assert.equal(d.ok, true);
  assert.equal(d.last4, null);
  assert.equal(chargeQuestion(d), 'Charge £40.00 to the saved card?');
});

test('hours read right: one hour, many hours, after the booking', () => {
  assert.equal(hoursText(1), '1 hour before');
  assert.equal(hoursText(48), '48 hours before');
  assert.equal(hoursText(-0.5), 'after the booking time');
});

test('money already paid with the booking is kept or refunded, never charged again', () => {
  const dep = { id: 'd1', kind: 'deposit', status: 'captured', amount: 30, currency: 'gbp' };
  const d = chargeDecision({ booking: booking(), payments: [hold(), dep], rules, customer });
  assert.equal(d.reason, 'money_on_file');
  assert.match(d.message, /£30\.00 was already deposit paid/);
});

test('only a no show or a late cancel can be charged', () => {
  for (const status of ['confirmed', 'dining', 'departed', 'pending_payment', 'expired']) {
    assert.equal(chargeDecision({ booking: booking({ status }), payments: [hold()], rules, customer }).reason, 'not_chargeable');
  }
});

test('late cancel: inside the window on the VENUE clock is chargeable, outside is not', () => {
  // 19:30 London (BST, UTC+1) on 16 Oct. Cancelled 18:30 UTC the day before = 19:30 London, 24 hours.
  const at = (iso) => booking({ status: 'cancelled', cancelled_at: iso });
  const inside = chargeDecision({ booking: at('2026-10-16T10:00:00Z'), payments: [hold()], rules, customer, tz: 'Europe/London' });
  assert.equal(inside.ok, true);
  assert.equal(inside.kind, 'late_cancel');
  assert.equal(inside.hoursBefore, 8.5);
  const outside = chargeDecision({ booking: at('2026-10-14T18:30:00Z'), payments: [hold()], rules, customer, tz: 'Europe/London' });
  assert.equal(outside.ok, false);
  assert.equal(outside.reason, 'outside_window');
  assert.match(outside.message, /48 hours before the booking, outside the 24 hour window/);
  const unknown = chargeDecision({ booking: at(null), payments: [hold()], rules, customer });
  assert.equal(unknown.reason, 'cancel_time_unknown');
  const noWindow = chargeDecision({ booking: at('2026-10-16T10:00:00Z'), payments: [hold()], rules: { ...rules, cancellation_window_hours: 0 }, customer });
  assert.equal(noWindow.reason, 'no_window');
});

test('lateCancel reads the venue wall clock, not the device or UTC', () => {
  // 08:00 Los Angeles on 16 Oct = 16:00 London. A 19:30 London booking is 3.5 hours away.
  const r = lateCancel({ bookingDate: '2026-10-16', startTime: '19:30', cancelledAtMs: Date.parse('2026-10-16T15:00:00Z'), tz: 'Europe/London', windowHours: 24 });
  assert.deepEqual(r, { late: true, hoursBefore: 3.5 });
  const after = lateCancel({ bookingDate: '2026-10-16', startTime: '19:30', cancelledAtMs: Date.parse('2026-10-16T19:00:00Z'), tz: 'Europe/London', windowHours: 2 });
  assert.equal(after.late, true);   // cancelled after the booking time
  assert.equal(after.hoursBefore, -0.5);
});

test('the fee: stored due first, then the hold row, then the rules', () => {
  assert.equal(noShowFee({ booking: booking({ payment_kind: 'hold', payment_due_minor: 6000 }), holdRow: hold(), rules }).amountMinor, 6000);
  assert.equal(noShowFee({ booking: booking(), holdRow: hold({ amount: 50 }), rules }).source, 'hold');
  assert.equal(noShowFee({ booking: booking({ covers: 3 }), holdRow: hold({ amount: 0 }), rules }).amountMinor, 6000);
  assert.equal(noShowFee({ booking: booking(), holdRow: null, rules: { hold_per_cover: 0 } }).amountMinor, 0);
  const d = chargeDecision({ booking: booking(), payments: [hold({ amount: 0 })], rules: { hold_per_cover: 0 }, customer });
  assert.equal(d.reason, 'no_fee');
});

test('references carry the kind and the attempt', () => {
  assert.equal(chargeReference('bk-1', 1), 'bkpay-bk-1-noshow-a1');
  assert.equal(chargeReference('bk-1', 2, 'late_cancel'), 'bkpay-bk-1-latecancel-a2');
  assert.equal(kindOfReference('bkpay-bk-1-latecancel-a2'), 'late_cancel');
  assert.equal(kindOfReference('bkpay-bk-1-noshow-a1'), 'no_show');
  assert.equal(attemptOf('bkpay-bk-1-latecancel-a3'), 3);
  assert.equal(nextAttempt([hold(), { kind: NO_SHOW_KIND, status: 'failed' }]), 2);
  // Never the hold or deposit pattern adyen-webhook promotes on.
  assert.doesNotMatch(chargeReference('bk-1', 1), /-(hold|deposit|prepay)(-a\d+)?$/);
});

test('refusals are plain words and always say nothing was taken', () => {
  assert.equal(refusalWords('Refused', 'Not enough balance'), 'The card was declined: there is not enough money on the card. Nothing was taken.');
  assert.match(refusalWords('Refused', 'Expired Card'), /expired/);
  assert.match(refusalWords('Refused', 'Authentication required'), /approve this charge themselves/);
  assert.match(refusalWords('Error', 'Acquirer Error'), /Nothing was taken\.$/);
  assert.match(refusalWords('Cancelled', ''), /cancelled\. Nothing was taken/);
});

test('the check: one line, card tender with the psp, no covers, no VAT (outside the scope)', () => {
  const rate = feeRate([
    { id: 'r5', rate: 0.05, type: 'inclusive', active: true },
    { id: 'r20', rate: 0.2, type: 'inclusive', active: true, is_default: true, name: 'VAT', code: 'VAT20' },
  ]);
  assert.equal(rate.id, 'r20');
  const row = chargeCheckRow({
    booking: booking(), kind: 'no_show', rate, staffName: 'Alex', closedAt: '2026-10-16T21:00:00Z',
    charge: { pspReference: 'PSP123', amountMinor: 4000, currency: 'GBP', last4: '4242', brand: 'visa', reference: 'bkpay-bk-1-noshow-a1' },
  });
  assert.equal(row.id, 'bkns-bk-1-a1');
  assert.match(row.ref, /^NS-[0-9A-Z]{5}$/);
  assert.equal(row.ref, chargeCheckIds('bk-1', 1).ref);
  assert.equal(row.total, 40);
  assert.equal(row.covers, 0);
  assert.equal(row.source, 'booking');
  assert.equal(row.items.length, 1);
  assert.equal(row.items[0].name, 'No show charge');
  assert.equal(row.items[0].taxRateId, null);
  assert.equal(row.items[0].notes, 'Booking 2026-10-16 19:30, 2 covers');
  // Outside the scope of VAT until Peter decides: no VAT taken out, recorded as booked.
  assert.equal(row.tax_amount, 0);
  assert.equal(row.tax_breakdown.totalTax, 0);
  assert.equal(row.tax_breakdown.share, 0);
  assert.equal(row.tax_breakdown.breakdown[0].net, 40);
  assert.match(row.tax_breakdown.breakdown[0].rate.name, /Outside the scope of VAT/);
  assert.equal(row.customer.charge_source, 'booking');
  assert.equal(chargeCheckRow({ booking: booking({ covers: 1 }), kind: 'no_show', closedAt: 'x', charge: { amountMinor: 100 } }).items[0].notes, 'Booking 2026-10-16 19:30, 1 cover');
  assert.deepEqual(row.tenders, [{ method: 'card', amount: 40, tip: 0, psp_ref: 'PSP123', processor: 'adyen' }]);
  assert.equal(row.payment_intents[0].id, 'PSP123');
  assert.equal(row.payment_intents[0].amountMinor, 4000);
  assert.equal(row.customer.name, 'Sam Guest');
  // A second attempt is a different check, so a charge after a refund is posted too.
  assert.notEqual(chargeCheckIds('bk-1', 2).id, row.id);
});

test('an exclusive rate (US sales tax) is never added on top of the fee', () => {
  const t = feeTax(4000, { id: 'st', rate: 0.0725, type: 'exclusive', active: true });
  assert.equal(t.taxAmount, 0);
  assert.match(t.record.note, /No sales tax/);
  assert.deepEqual(feeTax(4000, null), { taxAmount: null, record: null });
});

test('ledger screens leave no show charges out; null stays null', () => {
  const rows = [hold(), { kind: NO_SHOW_KIND, status: 'captured', amount: 40 }];
  assert.deepEqual(withoutNoShowCharges(rows), [rows[0]]);
  assert.equal(withoutNoShowCharges(null), null);
  assert.equal(takenCharge(rows).amount, 40);
  assert.equal(moneyText(1234, 'USD'), '$12.34');
});

// The LIVE closed_checks_source_check list (read 16 Oct 2026, last set by 20260919a1) plus what
// 20261016f adds. The fallback must be in today's list, the charge source in the new one.
const LIVE_SOURCES = ['pos', 'kiosk', 'online', 'mobile', 'catering', 'hubrise', 'pax_table_pay', 'pos_send_to_terminal', 'adyen_pay_at_table', 'ezcater', 'qr'];
test('the check source: booking after 20261016f, online before it', async () => {
  const fs = await import('node:fs');
  const sql = fs.readFileSync(new URL('../../../supabase/migrations/20261016f_OPS_booking_noshow_reports.sql', import.meta.url), 'utf8');
  // 16 Oct 2026 release review: the new list is built FROM the live constraint (every source it
  // allows is kept) plus the charge source, and the file stops if the constraint is not there.
  assert.match(sql, /select pg_get_constraintdef\(c\.oid\) into v_def from pg_constraint c/);
  assert.match(sql, /closed_checks_source_check not found, nothing changed/);
  assert.match(sql, /regexp_matches\(v_def, /);
  assert.ok(sql.includes(`v_list := v_list || '${CHARGE_SOURCE}'::text;`), 'the charge source is added to the live list');
  assert.match(sql, /add constraint closed_checks_source_check check \(source = any \(array\['/);
  assert.match(sql, /\]\)\) not valid'/);
  assert.ok(!/array\['pos', 'kiosk'/.test(sql), 'no typed list that could drop a live source');
  assert.equal(LIVE_SOURCES.includes(CHARGE_SOURCE), false);
  assert.equal(LIVE_SOURCES.includes(CHARGE_SOURCE_FALLBACK), true);
  assert.equal(isSourceCheckRefusal({ code: '23514', message: 'new row for relation "closed_checks" violates check constraint "closed_checks_source_check"' }), true);
  assert.equal(isSourceCheckRefusal({ code: '23514', message: 'violates check constraint "closed_checks_total_check"' }), false);
  assert.equal(isSourceCheckRefusal({ code: '23505', message: 'closed_checks_source_check' }), false);
});

test('a missing function is told apart from a missing booking', () => {
  assert.equal(isMissingFunctionReply({ status: 404, message: 'Requested function was not found' }), true);
  assert.equal(isMissingFunctionReply({ status: 404, message: 'unknown_booking This booking could not be found.' }), false);
  assert.equal(isMissingFunctionReply({ status: 500, message: 'boom' }), false);
});
