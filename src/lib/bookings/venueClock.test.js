import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  venueNow, venueToday, isVenueToday, shiftYmd, ymdLabel, daysEnding,
  venueClockText, nextQuarterMin, rolloverTarget,
} from './venueClock.js';

// 16 Oct 2026 23:30 Pacific = 17 Oct 07:30 in London (BST, UTC+1).
const LATE_PACIFIC = new Date('2026-10-17T06:30:00Z');
// 16 Oct 2026 09:22 Pacific = 17:22 in London.
const DEMO = new Date('2026-10-16T16:22:00Z');

test('venueNow: a California device sees the London venue date and time', () => {
  const london = venueNow('Europe/London', LATE_PACIFIC);
  assert.equal(london.ymd, '2026-10-17');
  assert.equal(london.nowMin, 7 * 60 + 30);
  const la = venueNow('America/Los_Angeles', LATE_PACIFIC);
  assert.equal(la.ymd, '2026-10-16');
  assert.equal(la.nowMin, 23 * 60 + 30);
});

test('venueNow: the demo instant reads 17:22 in London, 09:22 in California', () => {
  assert.equal(venueNow('Europe/London', DEMO).nowMin, 17 * 60 + 22);
  assert.equal(venueNow('America/Los_Angeles', DEMO).nowMin, 9 * 60 + 22);
});

test('venueNow: no timezone falls back to London', () => {
  assert.equal(venueToday(null, LATE_PACIFIC), '2026-10-17');
  assert.equal(venueToday('', LATE_PACIFIC), '2026-10-17');
});

test('isVenueToday: compares with the venue day, and no date counts as today', () => {
  assert.equal(isVenueToday('2026-10-17', 'Europe/London', LATE_PACIFIC), true);
  assert.equal(isVenueToday('2026-10-16', 'Europe/London', LATE_PACIFIC), false);
  assert.equal(isVenueToday('2026-10-16', 'America/Los_Angeles', LATE_PACIFIC), true);
  assert.equal(isVenueToday(null, 'Europe/London', LATE_PACIFIC), true);
});

test('shiftYmd: month and year ends, and the clock change weekend', () => {
  assert.equal(shiftYmd('2026-10-31', 1), '2026-11-01');
  assert.equal(shiftYmd('2026-01-01', -1), '2025-12-31');
  assert.equal(shiftYmd('2026-10-25', 1), '2026-10-26');
  assert.equal(shiftYmd('2026-03-29', -1), '2026-03-28');
  assert.equal(shiftYmd('bad', 1), 'bad');
});

test('ymdLabel and daysEnding: labels from the date itself, oldest first', () => {
  assert.equal(ymdLabel('2026-10-16'), 'Fri');
  assert.equal(ymdLabel('2026-10-16', { long: true }), 'Fri 16 Oct');
  const week = daysEnding('2026-10-17', 7);
  assert.equal(week.length, 7);
  assert.equal(week[0].iso, '2026-10-11');
  assert.equal(week[6].iso, '2026-10-17');
  assert.equal(week[6].label, 'Sat');
});

test('venueClockText: the venue wall clock, not the device', () => {
  assert.equal(venueClockText('Europe/London', DEMO), '17:22:00');
  assert.equal(venueClockText('America/Los_Angeles', DEMO, { seconds: false }), '09:22');
});

test('nextQuarterMin: strictly after now', () => {
  assert.equal(nextQuarterMin(19 * 60 + 7), 19 * 60 + 15);
  assert.equal(nextQuarterMin(19 * 60), 19 * 60 + 15);
  assert.equal(nextQuarterMin(19 * 60 + 14), 19 * 60 + 15);
  // after 23:45 it stays on today: 23:59, never '24:00'
  assert.equal(nextQuarterMin(23 * 60 + 50), 1439);
});

test('rolloverTarget: follow midnight only when the diary was on the day that ended', () => {
  assert.equal(rolloverTarget({ viewing: '2026-10-16', previousToday: '2026-10-16', today: '2026-10-17' }), '2026-10-17');
  assert.equal(rolloverTarget({ viewing: '2026-10-20', previousToday: '2026-10-16', today: '2026-10-17' }), null);
  assert.equal(rolloverTarget({ viewing: '2026-10-16', previousToday: '2026-10-16', today: '2026-10-16' }), null);
  assert.equal(rolloverTarget({ viewing: null, previousToday: '2026-10-16', today: '2026-10-17' }), '2026-10-17');
});

test('epochToVenueMin: a tab seated at 17:22 London reads 17:22 on any device', async () => {
  const { epochToVenueMin } = await import('./venueClock.js');
  assert.equal(epochToVenueMin('Europe/London')(DEMO.getTime()), 17 * 60 + 22);
  assert.equal(epochToVenueMin('America/Los_Angeles')(DEMO.getTime()), 9 * 60 + 22);
});
