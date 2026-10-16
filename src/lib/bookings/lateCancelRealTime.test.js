// lateCancelRealTime.test.js: the late cancel window is measured in REAL hours (17 Oct 2026,
// v5.11.73, PR 295 follow up "late cancel measured in real time across a clock change").
//
// The rule used to subtract two wall clocks, so on a clock change weekend it was an hour out,
// and the card hold could be charged for a cancel made in time. These cases use the real dates:
// UK clocks go back at 02:00 on Sunday 25 Oct 2026 and forward at 01:00 on Sunday 29 Mar 2026;
// New York goes back at 02:00 on Sunday 1 Nov 2026.
//
// The guest's own page closes online changes with guestWindow (bookingGuest.js). The charge must
// agree with it to the minute: a guest the page let cancel online is never charged as late.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lateCancel, chargeDecision, hoursText } from './noShowCharge.js';
import * as shared from '../../../supabase/functions/_shared/noShowCharge.js';
import { guestWindow } from './bookingGuest.js';

const LONDON = 'Europe/London';
const H = 3600000;

test('clocks go back: a Saturday 19:30 cancel of a Sunday 19:00 booking is 24.5 real hours, not late', () => {
  // Sat 24 Oct 19:30 BST = 18:30 UTC. Sun 25 Oct 19:00 GMT = 19:00 UTC. The wall clocks say 23.5.
  const r = lateCancel({ bookingDate: '2026-10-25', startTime: '19:00', cancelledAtMs: Date.parse('2026-10-24T18:30:00Z'), tz: LONDON, windowHours: 24 });
  assert.deepEqual(r, { late: false, hoursBefore: 24.5 });
  // An hour later (20:30 BST) it is 23.5 real hours: late.
  const later = lateCancel({ bookingDate: '2026-10-25', startTime: '19:00', cancelledAtMs: Date.parse('2026-10-24T19:30:00Z'), tz: LONDON, windowHours: 24 });
  assert.deepEqual(later, { late: true, hoursBefore: 23.5 });
  // Exactly 24 real hours (20:00 BST on the Saturday) is in time.
  assert.equal(lateCancel({ bookingDate: '2026-10-25', startTime: '19:00', cancelledAtMs: Date.parse('2026-10-24T19:00:00Z'), tz: LONDON, windowHours: 24 }).late, false);
});

test('clocks go forward: a Saturday 18:30 cancel of a Sunday 19:00 booking is 23.5 real hours, late', () => {
  // Sat 28 Mar 18:30 GMT = 18:30 UTC. Sun 29 Mar 19:00 BST = 18:00 UTC. The wall clocks say 24.5.
  const r = lateCancel({ bookingDate: '2026-03-29', startTime: '19:00', cancelledAtMs: Date.parse('2026-03-28T18:30:00Z'), tz: LONDON, windowHours: 24 });
  assert.deepEqual(r, { late: true, hoursBefore: 23.5 });
});

test('a US venue across its own clock change (New York, 1 Nov 2026)', () => {
  // Sat 31 Oct 19:30 EDT = 23:30 UTC. Sun 1 Nov 19:00 EST = Mon 00:00 UTC. 24.5 real hours.
  const r = lateCancel({ bookingDate: '2026-11-01', startTime: '19:00', cancelledAtMs: Date.parse('2026-10-31T23:30:00Z'), tz: 'America/New_York', windowHours: 24 });
  assert.deepEqual(r, { late: false, hoursBefore: 24.5 });
});

test('the charge itself: no hold is charged for the in time cancel on the clock change weekend', () => {
  const booking = {
    id: 'bk-dst', status: 'cancelled', booking_date: '2026-10-25', start_time: '19:00:00', covers: 2,
    customer_id: 'cus-1', cancelled_at: '2026-10-24T18:30:00Z',
  };
  const hold = { id: 'h', kind: 'hold', status: 'authorised', amount: 0, hold_minor: 4000, stored_payment_method_id: 'TOK', card_last4: '4242' };
  const customer = { id: 'cus-1', shopper_reference: 'cus-1' };
  for (const lib of [{ chargeDecision }, shared]) {
    const d = lib.chargeDecision({ booking, payments: [hold], rules: { cancellation_window_hours: 24 }, customer, tz: LONDON });
    assert.equal(d.ok, false);
    assert.equal(d.reason, 'outside_window');
    assert.match(d.message, /^Cancelled 24 hours before the booking, outside the 24 hour window/);
  }
  const late = chargeDecision({ booking: { ...booking, cancelled_at: '2026-10-24T19:30:00Z' }, payments: [hold], rules: { cancellation_window_hours: 24 }, customer, tz: LONDON });
  assert.equal(late.ok, true);
  assert.equal(late.kind, 'late_cancel');
  assert.equal(late.amountMinor, 4000);
});

test('the page and the charge agree to the minute, both clock change weekends and an ordinary day', () => {
  const cases = [
    { date: '2026-10-25', time: '19:00', tz: LONDON },
    { date: '2026-10-25', time: '01:30', tz: LONDON },   // the hour that happens twice
    { date: '2026-03-29', time: '19:00', tz: LONDON },
    { date: '2026-10-17', time: '12:15', tz: LONDON },
    { date: '2026-11-01', time: '19:00', tz: 'America/New_York' },
  ];
  for (const c of cases) {
    for (const windowHours of [2, 24, 48]) {
      const start = guestWindow({ date: c.date, startTime: c.time, windowHours, tz: c.tz, now: 0 }).minsLeft * 60000;
      // Every half minute across three hours either side of the window's edge.
      for (let s = -3 * 3600; s <= 3 * 3600; s += 30) {
        const at = start - windowHours * H + s * 1000;
        const page = guestWindow({ date: c.date, startTime: c.time, windowHours, tz: c.tz, now: at });
        const charge = lateCancel({ bookingDate: c.date, startTime: c.time, cancelledAtMs: at, tz: c.tz, windowHours });
        assert.equal(charge.late, !page.open, `${c.date} ${c.time} ${c.tz} window ${windowHours}h, ${s}s from the edge`);
      }
    }
  }
});

test('hours before reads down, never up to the window', () => {
  // 23 hours 58 minutes inside a 24 hour window: 23.9, and the words say 23.
  const r = lateCancel({ bookingDate: '2026-10-17', startTime: '19:00', cancelledAtMs: Date.parse('2026-10-16T18:02:00Z'), tz: LONDON, windowHours: 24 });
  assert.deepEqual(r, { late: true, hoursBefore: 23.9 });
  assert.equal(hoursText(r.hoursBefore), '23 hours before');
  // No float drift: 2 hours 18 minutes is 2.3 exactly.
  assert.equal(lateCancel({ bookingDate: '2026-10-17', startTime: '19:00', cancelledAtMs: Date.parse('2026-10-17T15:42:00Z'), tz: LONDON, windowHours: 1 }).hoursBefore, 2.3);
  assert.equal(hoursText(23.5), '23 hours before');
  assert.equal(hoursText(-0.1), 'after the booking time');
});

test('a booking with no date or time still cannot be told', () => {
  assert.deepEqual(lateCancel({ bookingDate: '', startTime: '19:00', cancelledAtMs: 0, tz: LONDON, windowHours: 24 }), { late: null, hoursBefore: null });
  assert.deepEqual(lateCancel({ bookingDate: '2026-10-17', startTime: null, cancelledAtMs: 0, tz: LONDON, windowHours: 24 }), { late: null, hoursBefore: null });
});
