/**
 * servicePeriods.test.js: service periods and booking rules (16 Oct 2026, bookings audit
 * section 3 item 6). Lunch and dinner per weekday, closed days, date blocks, service past
 * midnight, last seating, minimum notice and days ahead, all pure in optimiser.js.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isoWeekday, addDaysISO, sayDay, normalisePeriod, servicePeriodsOf, hasServiceRules,
  serviceWindows, serviceSlots, bookingTimeRefusal, diaryRange, closedRanges, dayNotice,
  describeWindows, checkPeriod, checkBlock, wholeDayBlock,
} from './optimiser.js';

const ALL = [1, 2, 3, 4, 5, 6, 7];
const LUNCH = { id: 'l', name: 'Lunch', days: ALL, start: '12:00', end: '15:00', lastSeating: '13:30' };
const DINNER = { id: 'd', name: 'Dinner', days: ALL, start: '17:00', end: '22:30', lastSeating: '21:00' };
const DEMO = { servicePeriods: [LUNCH, DINNER], slotMinutes: 15 };
// 2026-10-19 is a Monday, 2026-10-16 a Friday, 2026-10-17 a Saturday.
const MON = '2026-10-19', FRI = '2026-10-16', SAT = '2026-10-17';

test('weekdays and dates are calendar dates, Monday 1 to Sunday 7', () => {
  assert.equal(isoWeekday(MON), 1);
  assert.equal(isoWeekday('2026-10-18'), 7);
  assert.equal(addDaysISO('2026-12-31', 1), '2027-01-01');
  assert.equal(addDaysISO('2026-03-01', -1), '2026-02-28');
  assert.equal(sayDay('2026-12-25'), 'Fri 25 Dec');
});

test('no periods: the old single window every day, exactly as before', () => {
  const legacy = { serviceStart: '17:00', serviceEnd: '23:00', slotMinutes: 15 };
  const { custom, periods } = servicePeriodsOf(legacy);
  assert.equal(custom, false);
  assert.equal(periods.length, 1);
  const slots = serviceSlots(legacy, MON);
  assert.equal(slots[0], '17:00');
  assert.equal(slots[slots.length - 1], '22:45');
  assert.equal(slots.length, 24);
  assert.equal(hasServiceRules(legacy), false);
  assert.deepEqual(diaryRange(legacy, MON), { startMin: 17 * 60, endMin: 23 * 60 });
  assert.deepEqual(closedRanges(legacy, MON, 17 * 60, 23 * 60), []);
});

test('lunch and dinner: slots run from each start to its last seating', () => {
  const slots = serviceSlots(DEMO, MON);
  assert.equal(slots[0], '12:00');
  assert.ok(slots.includes('13:30'));
  assert.ok(!slots.includes('13:45'), 'nothing after lunch last seating');
  assert.ok(!slots.includes('15:00') && !slots.includes('16:45'));
  assert.ok(slots.includes('17:00') && slots.includes('21:00'));
  assert.ok(!slots.includes('21:15'), 'nothing after dinner last seating');
  assert.equal(slots.length, 7 + 17);
});

test('slot interval comes from the rules, and can be overridden', () => {
  assert.deepEqual(serviceSlots({ servicePeriods: [LUNCH], slotMinutes: 30 }, MON), ['12:00', '12:30', '13:00', '13:30']);
  assert.deepEqual(serviceSlots({ servicePeriods: [LUNCH] }, MON, { slotMinutes: 45 }), ['12:00', '12:45', '13:30']);
});

test('no last seating: the last slot is the one before the end', () => {
  const r = { servicePeriods: [{ days: ALL, start: '12:00', end: '13:00' }], slotMinutes: 15 };
  assert.deepEqual(serviceSlots(r, MON), ['12:00', '12:15', '12:30', '12:45']);
});

test('periods only on their own weekdays', () => {
  const r = { servicePeriods: [LUNCH, { ...DINNER, days: [5, 6] }] };
  assert.ok(!serviceSlots(r, MON).includes('19:00'));
  assert.ok(serviceSlots(r, FRI).includes('19:00'));
  assert.equal(bookingTimeRefusal(r, MON, '19:00').code, 'outside_service');
});

test('closed weekday: no slots and a closed refusal in words', () => {
  const r = { ...DEMO, closedWeekdays: [1] };
  assert.deepEqual(serviceSlots(r, MON), []);
  const why = bookingTimeRefusal(r, MON, '12:00');
  assert.equal(why.code, 'closed_day');
  assert.match(why.message, /closed on Mondays/);
  assert.equal(serviceWindows(r, MON).closed, 'closed_day');
  assert.match(dayNotice(r, MON), /Closed on Mondays/);
  // a closed day applies to the old single window too
  assert.equal(bookingTimeRefusal({ closedWeekdays: [1] }, MON, '18:00', { legacyWindow: false }).code, 'closed_day');
});

test('a weekday no period covers reads as no service', () => {
  const r = { servicePeriods: [{ ...LUNCH, days: [2, 3, 4, 5, 6, 7] }] };
  assert.equal(bookingTimeRefusal(r, MON, '12:00').code, 'closed_day');
  assert.match(bookingTimeRefusal(r, MON, '12:00').message, /no service on Mondays/);
});

test('date range block closes every day in the range for everyone', () => {
  const r = { ...DEMO, dateBlocks: [{ id: 'x', from: '2026-12-24', to: '2026-12-26', label: 'Christmas' }] };
  for (const d of ['2026-12-24', '2026-12-25', '2026-12-26']) {
    assert.deepEqual(serviceSlots(r, d), [], d);
    const why = bookingTimeRefusal(r, d, '12:00');
    assert.equal(why.code, 'blocked');
    assert.match(why.message, /Christmas/);
  }
  assert.ok(serviceSlots(r, '2026-12-27').length > 0);
  assert.match(dayNotice(r, '2026-12-25'), /Christmas/);
});

test('timed block takes out only its times (an evening private hire)', () => {
  const r = { ...DEMO, dateBlocks: [{ id: 'p', from: SAT, label: 'Private hire', start: '18:00', end: '21:00' }] };
  const slots = serviceSlots(r, SAT);
  assert.ok(slots.includes('17:45') && slots.includes('12:00'));
  assert.ok(!slots.includes('18:00') && !slots.includes('20:45'));
  assert.ok(slots.includes('21:00'));
  const why = bookingTimeRefusal(r, SAT, '19:00');
  assert.equal(why.code, 'blocked');
  assert.match(why.message, /Private hire/);
  assert.deepEqual(closedRanges(r, SAT, 12 * 60, 22 * 60 + 30).filter((c) => c.label === 'Private hire'),
    [{ startMin: 18 * 60, endMin: 21 * 60, label: 'Private hire' }]);
});

test('online only block stops the widget, never the host stand', () => {
  const r = { ...DEMO, dateBlocks: [{ id: 'o', from: SAT, to: SAT, label: 'Walk ins only', onlineOnly: true }] };
  assert.equal(bookingTimeRefusal(r, SAT, '12:00'), null);
  assert.equal(bookingTimeRefusal(r, SAT, '12:00', { online: true }).code, 'blocked');
  assert.deepEqual(serviceSlots(r, SAT, { online: true }), []);
  assert.ok(serviceSlots(r, SAT).length > 0);
  // the older single blocked dates are online only too
  assert.ok(wholeDayBlock({ blockedDates: [SAT] }, SAT, { online: true }));
  assert.equal(wholeDayBlock({ blockedDates: [SAT] }, SAT), null);
});

test('service past midnight: the late seats belong to the next calendar date', () => {
  const r = { servicePeriods: [{ id: 'n', name: 'Late', days: [5], start: '20:00', end: '02:00', lastSeating: '00:30' }], slotMinutes: 30 };
  const fri = serviceSlots(r, FRI);
  assert.equal(fri[0], '20:00');
  assert.equal(fri[fri.length - 1], '23:30');
  assert.deepEqual(serviceSlots(r, SAT), ['00:00', '00:30']);
  assert.equal(bookingTimeRefusal(r, SAT, '00:30'), null);
  assert.equal(bookingTimeRefusal(r, SAT, '01:00').code, 'closed_day');
  assert.equal(bookingTimeRefusal(r, FRI, '23:30'), null);
  // the late tail of Friday reads as open on the Saturday grid
  assert.deepEqual(closedRanges(r, SAT, 0, 180), [{ startMin: 120, endMin: 180, label: 'Closed' }]);
  // the Friday grid draws to midnight
  assert.deepEqual(diaryRange(r, FRI), { startMin: 20 * 60, endMin: 24 * 60 });
  assert.match(describeWindows(serviceWindows(r, FRI).windows), /20:00 to 02:00 \(last seating 00:30\)/);
});

test('a closed or blocked Friday also closes its past midnight tail', () => {
  const p = { id: 'n', days: [5], start: '20:00', end: '02:00' };
  assert.deepEqual(serviceSlots({ servicePeriods: [p], closedWeekdays: [5] }, SAT), []);
  assert.deepEqual(serviceSlots({ servicePeriods: [p], dateBlocks: [{ from: FRI, to: FRI }] }, SAT), []);
});

test('outside service: words name the open times', () => {
  const why = bookingTimeRefusal(DEMO, MON, '16:00');
  assert.equal(why.code, 'outside_service');
  assert.equal(why.message, '16:00 is outside service hours. Open 12:00 to 15:00 (last seating 13:30) and 17:00 to 22:30 (last seating 21:00). Pick another time.');
  assert.equal(bookingTimeRefusal(DEMO, MON, '13:45').code, 'outside_service');
  assert.equal(bookingTimeRefusal(DEMO, MON, '13:30'), null);
  assert.equal(bookingTimeRefusal(DEMO, MON, '13:07'), null, 'off grid is still inside the window for the stand');
});

test('legacy window is enforced on the stand edit, but not where the database does not', () => {
  const legacy = { serviceStart: '17:00', serviceEnd: '23:00' };
  assert.equal(bookingTimeRefusal(legacy, MON, '11:00').code, 'outside_service');
  assert.equal(bookingTimeRefusal(legacy, MON, '11:00', { legacyWindow: false }), null);
});

test('online: minimum notice, past times and days ahead on the venue clock', () => {
  const r = { ...DEMO, minNoticeMinutes: 120, widgetMaxDaysAhead: 30 };
  const now = { ymd: MON, nowMinutes: 11 * 60 };
  assert.equal(bookingTimeRefusal(r, MON, '12:00', { online: true, now }).code, 'too_soon');
  assert.match(bookingTimeRefusal(r, MON, '12:00', { online: true, now }).message, /2 hours notice/);
  assert.equal(bookingTimeRefusal(r, MON, '13:00', { online: true, now }), null);
  assert.equal(bookingTimeRefusal(r, MON, '12:00', { online: true, now: { ymd: MON, nowMinutes: 12 * 60 + 5 } }).code, 'past');
  assert.equal(bookingTimeRefusal(r, addDaysISO(MON, 31), '12:00', { online: true, now }).code, 'too_far_ahead');
  assert.equal(bookingTimeRefusal(r, addDaysISO(MON, 30), '12:00', { online: true, now }), null);
  // the host stand is never held to notice or days ahead
  assert.equal(bookingTimeRefusal(r, MON, '12:00', { now }), null);
  // notice crosses midnight: 23:00 now, 120 minutes, tomorrow 00:30 is too soon
  const late = { servicePeriods: [{ days: ALL, start: '00:00', end: '23:59' }], minNoticeMinutes: 120 };
  assert.equal(bookingTimeRefusal(late, addDaysISO(MON, 1), '00:30', { online: true, now: { ymd: MON, nowMinutes: 23 * 60 } }).code, 'too_soon');
  assert.match(bookingTimeRefusal({ ...DEMO, minNoticeMinutes: 90 }, MON, '12:00', { online: true, now }).message, /90 minutes notice/);
});

test('diary range covers the day and widens for a booking outside it', () => {
  assert.deepEqual(diaryRange(DEMO, MON), { startMin: 12 * 60, endMin: 22 * 60 + 30 });
  assert.deepEqual(diaryRange(DEMO, MON, { bookings: [{ startTime: '11:10', turnMinutes: 60 }] }), { startMin: 11 * 60, endMin: 22 * 60 + 30 });
  assert.deepEqual(diaryRange(DEMO, MON, { bookings: [{ startTime: '22:00', turnMinutes: 90 }] }), { startMin: 12 * 60, endMin: 23 * 60 + 30 });
  // a closed day still draws the widest span of the week
  assert.deepEqual(diaryRange({ ...DEMO, closedWeekdays: [1] }, MON), { startMin: 12 * 60, endMin: 22 * 60 + 30 });
});

test('closed ranges grey the gap between lunch and dinner, and a whole closed day', () => {
  assert.deepEqual(closedRanges(DEMO, MON, 12 * 60, 22 * 60 + 30), [{ startMin: 15 * 60, endMin: 17 * 60, label: 'Closed' }]);
  assert.deepEqual(closedRanges({ ...DEMO, closedWeekdays: [1] }, MON, 12 * 60, 22 * 60 + 30), [{ startMin: 12 * 60, endMin: 22 * 60 + 30, label: 'Closed' }]);
  const xmas = { ...DEMO, dateBlocks: [{ from: '2026-12-25', to: '2026-12-25', label: 'Christmas' }] };
  assert.deepEqual(closedRanges(xmas, '2026-12-25', 720, 1350), [{ startMin: 720, endMin: 1350, label: 'Christmas' }]);
});

test('dayNotice is quiet on an ordinary day and on a venue with no rules', () => {
  assert.equal(dayNotice(DEMO, MON), null);
  assert.equal(dayNotice({}, MON), null);
});

test('bad periods are ignored, and the editor checks say why', () => {
  assert.equal(normalisePeriod({ days: [], start: '12:00', end: '15:00' }), null);
  assert.equal(normalisePeriod({ days: [1], start: 'x', end: '15:00' }), null);
  assert.equal(servicePeriodsOf({ servicePeriods: [{ days: [], start: '12:00', end: '15:00' }] }).custom, false);
  assert.equal(checkPeriod({ days: [1], start: '12:00', end: '15:00' }), null);
  assert.match(checkPeriod({ days: [], start: '12:00', end: '15:00' }), /at least one day/);
  assert.match(checkPeriod({ days: [1], start: '12:00', end: '12:00' }), /same time/);
  assert.match(checkPeriod({ days: [1], start: '12:00', end: '15:00', lastSeating: '15:30' }), /before the end/);
  assert.equal(checkPeriod({ days: [5], start: '20:00', end: '02:00', lastSeating: '01:00' }), null);
  assert.equal(checkBlock({ from: SAT, to: SAT }), null);
  assert.match(checkBlock({ from: SAT, to: FRI }), /before the first/);
  assert.match(checkBlock({ from: SAT, start: '18:00' }), /both times/);
  assert.match(checkBlock({ from: SAT, start: '21:00', end: '18:00' }), /after the start/);
  // last seating later than the end is pulled back inside the period
  assert.equal(normalisePeriod({ days: [1], start: '12:00', end: '15:00', lastSeating: '16:00' }).lastAbs, 15 * 60 - 1);
});
