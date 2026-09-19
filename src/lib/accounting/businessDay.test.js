/**
 * businessDay.test.js — the venue business day that accounting (Xero, then QuickBooks)
 * books money by. Run: `npm test`, or `node --test src/lib/accounting/businessDay.test.js`.
 *
 * Pinned:
 *   1. The bug: xero-sales used 00:00Z to 23:59Z. A UK bar's 00:40 BST sale is Friday's
 *      takings, not Saturday's, and never a UTC day.
 *   2. Every boundary comes from the zone's real offsets: BST and GMT, US zones, the
 *      spring forward gap and the fall back overlap, a zone that skips midnight.
 *   3. Days are contiguous: businessDayOf() and businessDayWindow() agree for every
 *      instant, so nothing belongs to two days or none (checked across DST weeks).
 *   4. The nightly post books the last COMPLETED day, and an open day is never "over".
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  businessDayWindow, businessDayOf, lastCompletedBusinessDay, currentBusinessDay,
  isBusinessDayOver, dayStartMinutes, venueZone, wallTimeToInstant, addDays, isYmd,
  DEFAULT_VENUE_TZ, DEFAULT_DAY_START,
} from '../../../supabase/functions/_shared/businessDay.js';

const iso = (ms) => new Date(ms).toISOString();

test('UK in BST: the day runs 06:00 to 06:00 BST, so after-midnight trade is the night before', () => {
  const w = businessDayWindow('2026-09-18', 'Europe/London', '06:00');
  assert.equal(w.fromIso, '2026-09-18T05:00:00.000Z');
  assert.equal(w.toIso, '2026-09-19T05:00:00.000Z');
  // 00:40 BST on Saturday 19th = 23:40Z Friday: Friday's takings (the old code agreed only by luck)
  assert.equal(businessDayOf('2026-09-18T23:40:00Z', 'Europe/London', '06:00'), '2026-09-18');
  // 01:30 BST Saturday = 00:30Z Saturday: the old UTC day put this on SATURDAY. It is Friday's.
  assert.equal(businessDayOf('2026-09-19T00:30:00Z', 'Europe/London', '06:00'), '2026-09-18');
  // 05:59:59 BST still Friday, 06:00 BST is Saturday
  assert.equal(businessDayOf('2026-09-19T04:59:59Z', 'Europe/London', '06:00'), '2026-09-18');
  assert.equal(businessDayOf('2026-09-19T05:00:00Z', 'Europe/London', '06:00'), '2026-09-19');
});

test('UK with a midnight day start in BST: the first hour of the day is 23:00Z the day before', () => {
  const w = businessDayWindow('2026-07-01', 'Europe/London', '00:00');
  assert.equal(w.fromIso, '2026-06-30T23:00:00.000Z');
  assert.equal(w.toIso, '2026-07-01T23:00:00.000Z');
  // The old 00:00Z..23:59Z window put 00:30 BST on the 30th: it is the 1st.
  assert.equal(businessDayOf('2026-06-30T23:30:00Z', 'Europe/London', '00:00'), '2026-07-01');
});

test('UK in GMT: boundaries at 06:00Z', () => {
  const w = businessDayWindow('2026-12-04', 'Europe/London', '06:00');
  assert.equal(w.fromIso, '2026-12-04T06:00:00.000Z');
  assert.equal(w.toIso, '2026-12-05T06:00:00.000Z');
});

test('US venues: a Denver evening sale is not pushed into tomorrow by UTC', () => {
  const w = businessDayWindow('2026-09-18', 'America/Denver', '06:00');
  assert.equal(w.fromIso, '2026-09-18T12:00:00.000Z');
  assert.equal(w.toIso, '2026-09-19T12:00:00.000Z');
  // 19:30 MDT on the 18th = 01:30Z on the 19th: the UTC day said the 19th.
  assert.equal(businessDayOf('2026-09-19T01:30:00Z', 'America/Denver', '06:00'), '2026-09-18');
  assert.equal(businessDayOf('2026-09-19T01:30:00Z', 'America/New_York', '04:00'), '2026-09-18');
});

test('spring forward: the UK day that loses an hour is 23 hours long', () => {
  const w = businessDayWindow('2026-03-28', 'Europe/London', '06:00');
  assert.equal(w.fromIso, '2026-03-28T06:00:00.000Z');   // GMT
  assert.equal(w.toIso, '2026-03-29T05:00:00.000Z');     // BST
  assert.equal(w.toMs - w.fromMs, 23 * 3600000);
  // A day start inside the gap (01:30 does not exist on 29 Mar) resolves to just after it.
  assert.equal(iso(wallTimeToInstant('2026-03-29', 90, 'Europe/London')), '2026-03-29T01:30:00.000Z');   // 02:30 BST
});

test('fall back: the UK day that gains an hour is 25 hours long; a repeated time is its FIRST showing', () => {
  const w = businessDayWindow('2026-10-24', 'Europe/London', '06:00');
  assert.equal(w.fromIso, '2026-10-24T05:00:00.000Z');   // BST
  assert.equal(w.toIso, '2026-10-25T06:00:00.000Z');     // GMT
  assert.equal(w.toMs - w.fromMs, 25 * 3600000);
  // 01:30 happens twice on 25 Oct: 00:30Z (BST) then 01:30Z (GMT). The day starts at the first.
  assert.equal(iso(wallTimeToInstant('2026-10-25', 90, 'Europe/London')), '2026-10-25T00:30:00.000Z');
  // ...and the second 01:xx (GMT) belongs to the NEW day, never back to the old one.
  assert.equal(businessDayOf('2026-10-25T01:10:00Z', 'Europe/London', '01:30'), '2026-10-25');
  assert.equal(businessDayOf('2026-10-25T00:10:00Z', 'Europe/London', '01:30'), '2026-10-24');
});

test('a zone whose clocks skip midnight (Santiago, first Sunday of September)', () => {
  const w = businessDayWindow('2026-09-06', 'America/Santiago', '00:00');
  assert.equal(w.fromIso, '2026-09-06T04:00:00.000Z');   // 00:00 does not exist; 01:00 -03
  assert.equal(w.toIso, '2026-09-07T03:00:00.000Z');
});

test('days are contiguous and businessDayOf agrees with the windows for every instant', () => {
  const cases = [
    ['Europe/London', '06:00'], ['Europe/London', '00:00'], ['Europe/London', '01:30'], ['Europe/London', '02:00'],
    ['America/Denver', '04:00'], ['America/Los_Angeles', '00:00'], ['Australia/Sydney', '05:00'], ['America/Santiago', '00:00'],
    ['Asia/Kolkata', '03:30'],
  ];
  // The weeks around every DST change of 2026 in these zones, sampled every 20 minutes 7
  // seconds, plus the last millisecond of each day and the first of the next.
  const spans = [['2026-03-06', '2026-03-10'], ['2026-03-26', '2026-04-07'], ['2026-09-03', '2026-09-08'], ['2026-09-24', '2026-09-29'], ['2026-10-22', '2026-11-03']];
  for (const [tz, start] of cases) {
    for (const [a, b] of spans) {
      let day = a;
      while (day < b) {
        const w = businessDayWindow(day, tz, start);
        const next = businessDayWindow(addDays(day, 1), tz, start);
        assert.equal(w.toMs, next.fromMs, `${tz} ${start} ${day} ends where the next begins`);
        assert.ok(w.toMs - w.fromMs >= 22 * 3600000 && w.toMs - w.fromMs <= 26 * 3600000, `${tz} ${day} length`);
        for (let t = w.fromMs; t < w.toMs; t += 1207000) {
          assert.equal(businessDayOf(t, tz, start), day, `${tz} ${start} ${iso(t)}`);
        }
        assert.equal(businessDayOf(w.toMs - 1, tz, start), day);
        assert.equal(businessDayOf(w.toMs, tz, start), addDays(day, 1));
        day = addDays(day, 1);
      }
    }
  }
});

test('the last completed day and the open day', () => {
  // 04:10Z Saturday = 05:10 BST: Friday is still trading (it ends 06:00 BST), so the last
  // COMPLETED day is Thursday. The old cron posted "UTC yesterday", a day that cut Friday
  // night off at 01:00 BST and started with Thursday night's after-midnight trade.
  const now = Date.parse('2026-09-19T04:10:00Z');
  assert.equal(currentBusinessDay(now, 'Europe/London', '06:00'), '2026-09-18');
  assert.equal(lastCompletedBusinessDay(now, 'Europe/London', '06:00'), '2026-09-17');
  assert.equal(isBusinessDayOver('2026-09-18', now, 'Europe/London', '06:00'), false);
  assert.equal(isBusinessDayOver('2026-09-17', now, 'Europe/London', '06:00'), true);
  // An hour later Friday has ended.
  const later = Date.parse('2026-09-19T05:10:00Z');
  assert.equal(lastCompletedBusinessDay(later, 'Europe/London', '06:00'), '2026-09-18');
  assert.equal(isBusinessDayOver('2026-09-18', later, 'Europe/London', '06:00'), true);
  // Denver at the same instant (22:10 MDT on the 18th): the 17th is the last complete day.
  assert.equal(lastCompletedBusinessDay(now, 'America/Denver', '06:00'), '2026-09-17');
});

test('bad settings fall back to the defaults, never to the machine clock', () => {
  assert.equal(venueZone('Not/AZone'), DEFAULT_VENUE_TZ);
  assert.equal(venueZone(''), DEFAULT_VENUE_TZ);
  assert.equal(venueZone(null), DEFAULT_VENUE_TZ);
  assert.equal(venueZone(' America/Denver '), 'America/Denver');
  assert.equal(dayStartMinutes('06:00'), 360);
  assert.equal(dayStartMinutes('6:30'), 390);
  assert.equal(dayStartMinutes('04:00:00'), 240);
  assert.equal(dayStartMinutes('25:00'), dayStartMinutes(DEFAULT_DAY_START));
  assert.equal(dayStartMinutes(null), 360);
  assert.equal(dayStartMinutes('nonsense'), 360);
  // An unknown zone reads as London, so the window is London's.
  assert.deepEqual(businessDayWindow('2026-09-18', 'Nope/Nope', '06:00'), businessDayWindow('2026-09-18', 'Europe/London', '06:00'));
});

test('dates are validated', () => {
  assert.equal(isYmd('2026-09-18'), true);
  assert.equal(isYmd('2026-02-30'), false);
  assert.equal(isYmd('2026-9-18'), false);
  assert.equal(isYmd(undefined), false);
  assert.throws(() => businessDayWindow('2026-13-01', 'Europe/London', '06:00'));
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
});
