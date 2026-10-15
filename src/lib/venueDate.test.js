/** venueDate.test.js: the venue calendar helper every stock screen formats with. Run: npm test */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  partsInZone, ymdInZone, addDaysYmd, daysAgoYmd, fmtYmd, fmtVenueDate, fmtVenueDateTime, fmtVenueTime,
  countName, localToUtcMs, venueRangeIso,
} from './venueDate.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
const here = dirname(fileURLToPath(import.meta.url));

// 15 Oct 2026 21:05 UTC is 22:05 in London (BST) and 14:05 in Los Angeles.
const T = '2026-10-15T21:05:00Z';

test('fmtYmd: a plain date in words, never shifted by any clock', () => {
  assert.equal(fmtYmd('2026-10-16'), '16 Oct 2026');
  assert.equal(fmtYmd('2026-10-16', { weekday: true }), 'Fri 16 Oct 2026');
  assert.equal(fmtYmd('2026-10-16', { weekday: true, year: false }), 'Fri 16 Oct');
  assert.equal(fmtYmd('2026-03-01'), '1 Mar 2026');
  // not a date: handed back as it was, never blanked
  assert.equal(fmtYmd('due later'), 'due later');
  assert.equal(fmtYmd(null), '');
  assert.equal(fmtYmd(''), '');
});

test('ymdInZone and partsInZone follow the venue, not the device', () => {
  assert.equal(ymdInZone(T, 'Europe/London'), '2026-10-15');
  assert.equal(ymdInZone('2026-10-15T23:30:00Z', 'Europe/London'), '2026-10-16');   // BST rolls the day
  assert.equal(ymdInZone('2026-10-15T23:30:00Z', 'America/Los_Angeles'), '2026-10-15');
  const p = partsInZone(T, 'Europe/London');
  assert.deepEqual([p.y, p.m, p.d, p.hh, p.mm, p.dow], [2026, 10, 15, 22, 5, 4]);
  assert.equal(ymdInZone('nonsense', 'Europe/London'), null);
});

test('fmtVenueDate and fmtVenueDateTime: en-GB wording on the venue clock', () => {
  assert.equal(fmtVenueDateTime(T, 'Europe/London'), '15 Oct 2026 22:05');
  assert.equal(fmtVenueDateTime(T, 'America/Los_Angeles'), '15 Oct 2026 14:05');
  assert.equal(fmtVenueDate('2026-10-15T23:30:00Z', 'Europe/London'), '16 Oct 2026');
  assert.equal(fmtVenueDate('2026-10-15T23:30:00Z', 'Europe/London', { weekday: true }), 'Fri 16 Oct 2026');
  assert.equal(fmtVenueTime(T, 'Europe/London'), '22:05');
  assert.equal(fmtVenueDateTime(null, 'Europe/London'), '');
  assert.equal(fmtVenueDate('', 'Europe/London'), '');
});

test('countName: the venue day in words, with the kind of count', () => {
  assert.equal(countName(T, 'Europe/London'), 'Count 15 Oct 2026 · Full');
  assert.equal(countName(T, 'Europe/London', 'SPOT'), 'Count 15 Oct 2026 · Spot check');
  assert.equal(countName(T, 'Europe/London', 'SPOT', 'Walk in fridge'), 'Count 15 Oct 2026 · Walk in fridge');
  // never "Count 10/15/2026"
  assert.doesNotMatch(countName(T, 'America/Los_Angeles'), /\//);
});

test('addDaysYmd and daysAgoYmd walk the venue calendar', () => {
  assert.equal(addDaysYmd('2026-10-31', 1), '2026-11-01');
  assert.equal(addDaysYmd('2026-03-01', -1), '2026-02-28');
  assert.equal(addDaysYmd('bad', 1), null);
  assert.equal(daysAgoYmd(30, 'Europe/London', new Date(T)), '2026-09-15');
  assert.equal(daysAgoYmd(0, 'Europe/London', new Date('2026-10-15T23:30:00Z')), '2026-10-16');
});

test('localToUtcMs: a venue wall clock time as an instant, DST correct', () => {
  // 10:00 London on 15 Oct 2026 (BST, UTC+1) is 09:00 UTC
  assert.equal(new Date(localToUtcMs('2026-10-15', '10:00', 'Europe/London')).toISOString(), '2026-10-15T09:00:00.000Z');
  // after the clocks go back (GMT)
  assert.equal(new Date(localToUtcMs('2026-11-02', '10:00', 'Europe/London')).toISOString(), '2026-11-02T10:00:00.000Z');
  // a US venue
  assert.equal(new Date(localToUtcMs('2026-10-15', '09:30', 'America/Los_Angeles')).toISOString(), '2026-10-15T16:30:00.000Z');
  // midnight and the last minute of the day
  assert.equal(new Date(localToUtcMs('2026-10-15', '00:00', 'Europe/London')).toISOString(), '2026-10-14T23:00:00.000Z');
  assert.equal(new Date(localToUtcMs('2026-10-15', '23:59', 'Europe/London')).toISOString(), '2026-10-15T22:59:00.000Z');
  assert.equal(localToUtcMs('2026-10-15', '', 'Europe/London'), null);
  assert.equal(localToUtcMs('', '10:00', 'Europe/London'), null);
  assert.equal(localToUtcMs('2026-10-15', '25:00', 'Europe/London'), null);
});

test('venueRangeIso: a report day runs from business day start to the next business day start', () => {
  const r = venueRangeIso('2026-10-09', '2026-10-09', 'Europe/London', '06:00');
  assert.equal(r.fromIso, '2026-10-09T05:00:00.000Z');   // 06:00 BST
  assert.equal(r.toIso, '2026-10-10T05:00:00.000Z');
  // a count approved at 09:05 UK on 9 Oct lands inside 9 Oct, and 08:00 UK on the 9th is not the 8th
  assert.ok('2026-10-09T08:05:00.000Z' > r.fromIso && '2026-10-09T08:05:00.000Z' < r.toIso);
  const eighth = venueRangeIso('2026-10-08', '2026-10-08', 'Europe/London', '06:00');
  assert.ok('2026-10-09T07:00:00.000Z' > eighth.toIso, '08:00 UK on the 9th is not part of the 8th');
  // no business day start given: midnight to midnight
  const m = venueRangeIso('2026-10-09', '2026-10-10', 'Europe/London', null);
  assert.equal(m.fromIso, '2026-10-08T23:00:00.000Z');
  assert.equal(m.toIso, '2026-10-10T23:00:00.000Z');
  assert.equal(venueRangeIso('bad', '2026-10-10', 'Europe/London'), null);
});

test('one copy: src re-exports _shared, and po-send imports the same file', () => {
  const read = (p) => readFileSync(resolve(here, p), 'utf8');
  assert.match(read('./venueDate.js'), /export \* from '\.\.\/\.\.\/supabase\/functions\/_shared\/venueDate\.js';/);
  assert.match(read('../../supabase/functions/po-send/index.ts'), /from '\.\.\/_shared\/venueDate\.js';/);
  assert.doesNotMatch(read('../../supabase/functions/_shared/venueDate.js'), /^import /m, 'pure: no imports');
});
