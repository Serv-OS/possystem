import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  seatRefusal, OTHER_DAY_SEAT_TEXT, moneyOnFileLine, undoCancelStatus,
  venuePinLength, pinPadState, channelPill, offPlanBookings,
} from './standRules.js';

test('seatRefusal: only the venue today may be seated', () => {
  assert.equal(seatRefusal({ booking: { date: '2026-10-17' }, today: '2026-10-16' }), 'This booking is for Sat 17 Oct. Seat it on the day.');
  assert.equal(seatRefusal({ booking: { date: '2026-10-15', startTime: '19:00', turnMinutes: 90 }, today: '2026-10-16', nowMin: 600 }), 'This booking was for Thu 15 Oct.');
  assert.ok(OTHER_DAY_SEAT_TEXT);
  assert.equal(seatRefusal({ booking: { date: '2026-10-16' }, today: '2026-10-16' }), null);
  assert.ok(seatRefusal({ booking: null, today: '2026-10-16' }));
});

test('moneyOnFileLine: captured money is named, holds and nothing say so', () => {
  const fmt = (v) => `£${v.toFixed(2)}`;
  assert.equal(moneyOnFileLine(null).heldMinor, null);
  const paid = moneyOnFileLine([{ status: 'captured', kind: 'prepay', amount: 76 }], fmt);
  assert.equal(paid.heldMinor, 7600);
  assert.equal(paid.line, '£76.00 was paid on this booking and is not refunded automatically');
  const refundDue = moneyOnFileLine([{ status: 'captured', kind: 'prepay', amount: 76, refusal_reason: 'NEEDS REFUND: late' }], fmt);
  assert.equal(refundDue.heldMinor, 0);
  assert.match(moneyOnFileLine([{ status: 'authorised', kind: 'hold', amount: 40 }], fmt).line, /card is saved/);
  assert.equal(moneyOnFileLine([], fmt).line, null);
});

test('undoCancelStatus: back to confirmed when nothing was owed or it was paid', () => {
  assert.equal(undoCancelStatus({ before: 'confirmed', booking: {} }), 'confirmed');
  assert.equal(undoCancelStatus({ before: 'prepaid', booking: { paymentKind: 'prepay', paymentDueMinor: 7600 }, payments: [{ status: 'captured', kind: 'prepay', amount: 76 }] }), 'confirmed');
  assert.equal(undoCancelStatus({ before: 'confirmed', booking: { paymentKind: 'deposit', paymentDueMinor: 2000 }, payments: [] }), null);
  assert.equal(undoCancelStatus({ before: 'confirmed', booking: { paymentKind: 'deposit', paymentDueMinor: 2000 }, payments: null }), null);
  assert.equal(undoCancelStatus({ before: 'pending_payment', booking: {} }), 'pending_payment');
  assert.equal(undoCancelStatus({ before: 'dining', booking: {} }), null);
});

test('PIN pad: learnt venue length, OK from 4 to 8', () => {
  assert.equal(venuePinLength(null), null);
  assert.equal(venuePinLength('6'), 6);
  assert.equal(venuePinLength(12), null);
  // Nothing learnt yet (fresh stand): never auto submit, so a 6 digit PIN can be finished with OK.
  assert.deepEqual(pinPadState('1234', null), { auto: false, ok: true });
  assert.deepEqual(pinPadState('1234'), { auto: false, ok: true });
  assert.deepEqual(pinPadState('1234', '4'), { auto: true, ok: true });
  assert.deepEqual(pinPadState('1234', 4), { auto: true, ok: true });
  assert.deepEqual(pinPadState('1234', 6), { auto: false, ok: true });
  assert.deepEqual(pinPadState('123456', 6), { auto: true, ok: true });
  assert.deepEqual(pinPadState('123', 4), { auto: false, ok: false });
});

test('channelPill: the real channel state', () => {
  assert.equal(channelPill('SUBSCRIBED').tone, 'green');
  assert.equal(channelPill(null).label, 'Connecting');
  assert.equal(channelPill('CHANNEL_ERROR').label, 'Offline');
  assert.equal(channelPill('TIMED_OUT').tone, 'red');
  assert.equal(channelPill('SUBSCRIBED', { online: false }).label, 'Offline');
});

test('offPlanBookings: bookings on no floor plan table', () => {
  const out = offPlanBookings([
    { id: 'a', tables: ['t-old'], status: 'confirmed' },
    { id: 'b', tables: ['T1'], status: 'confirmed' },
    { id: 'c', tables: ['t-old', 'T2'], status: 'confirmed' },
    { id: 'd', tables: ['t-old'], status: 'cancelled' },
    { id: 'e', tables: [], primaryTableId: 't-gone', status: 'prepaid' },
  ], ['T1', 'T2']);
  assert.deepEqual(out.map((b) => b.id), ['a', 'e']);
});

test('seatRefusal: a 23:30 booking whose party walks in at 00:10 can still be seated', () => {
  const late = { date: '2026-10-15', startTime: '23:30', turnMinutes: 90 };
  assert.equal(seatRefusal({ booking: late, today: '2026-10-16', nowMin: 10 }), null);
  // its time has run out by 01:30
  assert.equal(seatRefusal({ booking: late, today: '2026-10-16', nowMin: 90 }), 'This booking was for Thu 15 Oct.');
  // no clock given: refused, as before
  assert.ok(seatRefusal({ booking: late, today: '2026-10-16' }));
});
