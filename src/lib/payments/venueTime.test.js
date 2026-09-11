/**
 * venueTime.test.js: payment dates read on the venue clock, never the device.
 * Run: `node --test src/lib/payments/venueTime.test.js`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatVenueWhen, formatVenueDate, formatVenueLongDate, formatVenueCsvWhen,
  formatCalendarDate, formatMonthLabel, venueMonthNow, venueZoneLabel, recentMonths,
} from './venueTime.js';

// The owner's report: a live payment at 14:29 UTC on 10 Sep 2026 showed 07:29
// because the page used the viewer's California clock.
const PAID = '2026-09-10T14:29:00Z';

test('a London venue reads 15:29 wherever the viewer is', () => {
  const s = formatVenueWhen(PAID, 'Europe/London');
  assert.match(s, /^10 Sept?, 15:29$/);
  assert.doesNotMatch(s, /07:29/);
});

test('the zone decides the time, so a Los Angeles venue reads 07:29', () => {
  assert.match(formatVenueWhen(PAID, 'America/Los_Angeles'), /07:29$/);
});

test('the day can change with the zone', () => {
  // 23:30 UTC on 10 Sep is 00:30 on 11 Sep in London (BST).
  assert.match(formatVenueWhen('2026-09-10T23:30:00Z', 'Europe/London'), /^11 Sept?, 00:30$/);
  assert.equal(formatVenueCsvWhen('2026-09-10T23:30:00Z', 'Europe/London'), '2026-09-11 00:30');
});

test('CSV time is sortable and on the venue clock', () => {
  assert.equal(formatVenueCsvWhen(PAID, 'Europe/London'), '2026-09-10 15:29');
  assert.equal(formatVenueCsvWhen(PAID, 'America/New_York'), '2026-09-10 10:29');
  assert.equal(formatVenueCsvWhen('2026-12-01T00:05:00Z', 'Europe/London'), '2026-12-01 00:05');
  assert.equal(formatVenueCsvWhen(null, 'Europe/London'), '');
});

test('dates on the venue clock', () => {
  assert.match(formatVenueDate('2026-09-10T23:30:00Z', 'Europe/London'), /^11 Sept? 2026$/);
  assert.equal(formatVenueLongDate('2026-09-10T23:30:00Z', 'Europe/London'), '11 September 2026');
});

test('no value or a bad zone never throws', () => {
  assert.equal(formatVenueWhen(null, 'Europe/London'), '—');
  assert.equal(formatVenueWhen('not a date', 'Europe/London'), '—');
  // A bad zone falls back to London, not the device clock.
  assert.match(formatVenueWhen(PAID, 'Not/AZone'), /15:29$/);
  assert.match(formatVenueWhen(PAID, undefined), /15:29$/);
});

test('a payout date is a calendar day and never shifts', () => {
  assert.match(formatCalendarDate('2026-09-10'), /^10 Sept? 2026$/);
  assert.equal(formatCalendarDate(null), '—');
  assert.equal(formatMonthLabel('2026-09'), 'September 2026');
});

test('a zone reads as plain words on screen', () => {
  assert.equal(`Times are ${venueZoneLabel('Europe/London')} time`, 'Times are London time');
  assert.equal(venueZoneLabel('America/Los_Angeles'), 'Los Angeles');
  assert.equal(venueZoneLabel('America/Argentina/Buenos_Aires'), 'Buenos Aires');
  assert.equal(venueZoneLabel(''), 'London');
  assert.equal(venueZoneLabel(null), 'London');
});

test('the month picker counts back from the venue month', () => {
  const months = recentMonths('2026-02', 24);
  assert.equal(months.length, 24);
  assert.deepEqual(months.slice(0, 4), ['2026-02', '2026-01', '2025-12', '2025-11']);
  assert.equal(months[23], '2024-03');
  assert.deepEqual(recentMonths('September 2026', 24), []);
  assert.deepEqual(recentMonths('', 24), []);
});

test('the current month is the venue month', () => {
  // 23:30 UTC on 30 Sep is already October in London, still September in New York.
  const now = new Date('2026-09-30T23:30:00Z');
  assert.equal(venueMonthNow('Europe/London', now), '2026-10');
  assert.equal(venueMonthNow('America/New_York', now), '2026-09');
});
