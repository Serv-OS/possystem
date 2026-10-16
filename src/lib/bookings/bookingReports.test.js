// bookingReports.test.js: the Back Office booking report and booking payments sums (16 Oct 2026).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  serviceFor, bookingsReport, moneyByBooking, paymentLines, paymentTotals, filterLines, owedBackMinor,
  isMoneyTaken, payStatusName, sourceName,
} from './bookingReports.js';
import { bookingSites, siteDayOf, isoBounds } from '../../backoffice/sections/reports/_bookingSites.js';

const bk = (id, over = {}) => ({ id, date: '2026-10-16', startTime: '19:00', covers: 2, status: 'departed', source: 'host', customer: { name: `Guest ${id}` }, tables: ['t1'], ...over });

test('serviceFor: the venue service periods first, then breakfast, lunch, dinner', () => {
  const shifts = [{ name: 'Brunch', start: '09:00', end: '14:00' }, { name: 'Late bar', start: '22:00', end: '02:00' }];
  assert.equal(serviceFor('10:30', shifts), 'Brunch');
  assert.equal(serviceFor('23:15', shifts), 'Late bar');
  assert.equal(serviceFor('01:00', shifts), 'Late bar');
  assert.equal(serviceFor('18:00', shifts), 'Dinner');
  assert.equal(serviceFor('08:00'), 'Breakfast');
  assert.equal(serviceFor('12:30'), 'Lunch');
  assert.equal(serviceFor('16:00'), 'Dinner');
  assert.equal(serviceFor(''), 'No time');
});

test('rates leave out bookings that never were (expired unpaid, still paying)', () => {
  const rows = [
    bk('a'), bk('b', { status: 'no_show', covers: 4 }), bk('c', { status: 'cancelled' }), bk('d', { status: 'confirmed' }),
    bk('e', { status: 'expired' }), bk('f', { status: 'pending_payment' }),
  ];
  const r = bookingsReport({ bookings: rows, payments: [] });
  assert.equal(r.kpis.bookings, 4);
  assert.equal(r.kpis.noShows, 1);
  assert.equal(r.kpis.noShowRate, 25);
  assert.equal(r.kpis.cancelRate, 25);
  assert.equal(r.kpis.covers, 8);           // a, b, d (cancelled and never-were left out)
  assert.equal(r.kpis.seatedCovers, 2);
  assert.equal(r.kpis.noShowCovers, 4);
  assert.equal(r.kpis.unpaidExpired, 1);
  assert.equal(r.kpis.awaitingPayment, 1);
  assert.equal(r.byStatus.find((s) => s.id === 'expired').n, 1);
});

test('covers by service, in service order', () => {
  const rows = [bk('a', { startTime: '12:00' }), bk('b', { startTime: '19:30', covers: 5 }), bk('c', { startTime: '13:00', status: 'no_show' })];
  const r = bookingsReport({ bookings: rows, payments: [] });
  assert.deepEqual(r.byService.map((s) => [s.service, s.bookings, s.covers, s.noShows]), [['Lunch', 2, 4, 1], ['Dinner', 1, 5, 0]]);
});

test('money is what was TAKEN: holds never count, refunds and owed back never count, per currency', () => {
  const payments = [
    { booking_id: 'a', kind: 'prepay', status: 'captured', amount: 120, currency: 'gbp' },
    { booking_id: 'b', kind: 'deposit', status: 'captured', amount: 20, currency: 'gbp' },
    { booking_id: 'b', kind: 'hold', status: 'authorised', amount: 40, currency: 'gbp' },
    { booking_id: 'c', kind: 'no_show_charge', status: 'captured', amount: 40, currency: 'gbp' },
    { booking_id: 'd', kind: 'prepay', status: 'needs_refund', amount: 60, currency: 'gbp' },
    { booking_id: 'd', kind: 'prepay', status: 'refunded', amount: 60, currency: 'gbp' },
    { booking_id: 'x', kind: 'prepay', status: 'captured', amount: 99, currency: 'usd' },
  ];
  const m = moneyByBooking(payments);
  assert.deepEqual(m.a, { GBP: { prepay: 12000, deposit: 0, noShow: 0 } });
  assert.equal(m.d, undefined);
  const rows = [bk('a'), bk('b', { source: 'widget' }), bk('c', { status: 'no_show', source: 'widget' }), bk('d')];
  const r = bookingsReport({ bookings: rows, payments });
  assert.deepEqual(r.money, { GBP: { prepay: 12000, deposit: 2000, noShow: 4000, total: 18000 } });
  assert.equal(r.cardsSaved, 1);
  const online = r.bySource.find((s) => s.source === 'widget');
  assert.equal(online.name, 'Online');
  assert.equal(online.noShowRate, 50);
  assert.equal(online.money.GBP.total, 6000);
  // A ledger that could not be read is not zero.
  assert.equal(bookingsReport({ bookings: rows, payments: null }).moneyKnown, false);
});

test('payment lines: guest, table, booking, card, on a check, owed back; a hold is never an amount', () => {
  const bookingsById = new Map([['a', bk('a', { tables: ['t1', 't2'], date: '2026-10-18', startTime: '20:00' })]]);
  const lines = paymentLines({
    payments: [
      { id: 1, booking_id: 'a', kind: 'prepay', status: 'captured', amount: 120, currency: 'gbp', card_last4: '4242', applied_to_check: true, applied_check_id: 'chk-1', applied_minor: 9000, refund_due_minor: 3000, created_at: '2026-10-10T12:00:00Z', captured_at: '2026-10-10T12:00:05Z' },
      { id: 2, booking_id: 'a', kind: 'hold', status: 'authorised', amount: 40, currency: 'gbp', created_at: '2026-10-10T11:00:00Z' },
      { id: 3, booking_id: 'zz', kind: 'deposit', status: 'captured', amount: 20, currency: 'gbp', refusal_reason: 'NEEDS REFUND: the booking was cancelled', created_at: '2026-10-11T11:00:00Z' },
      { id: 4, booking_id: 'a', kind: 'no_show_charge', status: 'failed', amount: 40, currency: 'gbp', refusal_reason: 'Not enough balance', created_at: '2026-10-18T22:00:00Z' },
    ],
    bookingsById,
    tableLabel: (id) => ({ t1: 'T1', t2: 'T2' })[id] || id,
  });
  assert.equal(lines[0].guest, 'Guest a');
  assert.equal(lines[0].table, 'T1 + T2');
  assert.equal(lines[0].bookingDate, '2026-10-18');
  assert.equal(lines[0].cardEnding, '4242');
  assert.equal(lines[0].amountMinor, 12000);
  assert.equal(lines[0].owedBackMinor, 3000);
  assert.equal(lines[0].appliedToCheck, true);
  assert.equal(lines[0].statusName, 'Taken');
  assert.equal(lines[1].amountMinor, 0);
  assert.equal(lines[1].holdMinor, 4000);
  assert.equal(lines[1].statusName, 'Card saved');
  assert.equal(lines[2].statusName, 'Owed back');
  assert.equal(lines[2].owedBackMinor, 2000);
  assert.equal(lines[2].taken, false);
  assert.equal(lines[2].guest, '');           // a booking that could not be read: blank, never a guess
  assert.equal(lines[3].note, 'Not enough balance');
  const t = paymentTotals(lines).GBP;
  assert.equal(t.taken, 12000);
  assert.equal(t.owedBack, 5000);
  assert.equal(t.cardsSaved, 1);
  assert.equal(t.failed, 1);
  assert.equal(t.notOnCheck, 0);
  assert.equal(filterLines(lines, { status: 'owed' }).length, 2);
  assert.equal(filterLines(lines, { kind: 'hold' }).length, 1);
  assert.equal(filterLines(lines, { status: 'failed' }).length, 1);
  assert.equal(filterLines(lines, { status: 'taken' }).length, 1);
});

test('small rules: owed back, money taken, status names, source names', () => {
  assert.equal(owedBackMinor({ kind: 'hold', status: 'needs_refund', amount: 40 }), 0);
  assert.equal(isMoneyTaken({ kind: 'no_show_charge', status: 'authorised', amount: 40 }), true);
  assert.equal(isMoneyTaken({ kind: 'hold', status: 'authorised', amount: 40 }), false);
  assert.equal(payStatusName({ kind: 'hold', status: 'needs_refund' }), 'Card saved late');
  assert.equal(sourceName('walk_in'), 'Walk in');
  assert.equal(sourceName(undefined), 'Host stand');
});

test('booking sites: the shell sites, else the signed in site over the shell range', () => {
  const range = { from: new Date('2026-10-16T05:00:00Z'), to: new Date('2026-10-17T04:59:59Z'), fromDay: '2026-10-16', toDay: '2026-10-16', timeZone: 'Europe/London', dayStart: '06:00' };
  assert.deepEqual(bookingSites({ sites: [], homeId: 'loc-1', range }).map((s) => s.id), ['loc-1']);
  assert.deepEqual(bookingSites({ sites: [], homeId: null, range }), []);
  const sites = [{ id: 'a', name: 'A', range }, { id: 'b', name: 'B', range }];
  assert.deepEqual(bookingSites({ sites, homeId: 'loc-1', range }), sites);
  assert.deepEqual(isoBounds(sites[0]), { from: '2026-10-16T05:00:00.000Z', to: '2026-10-17T04:59:59.000Z' });
  // 01:30 London on the 17th belongs to the 16th's business day with a 06:00 start.
  assert.equal(siteDayOf({ timezone: 'Europe/London', businessDayStart: '06:00' })('2026-10-17T00:30:00Z'), '2026-10-16');
});
