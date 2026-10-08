/* global process */
/**
 * venueBuckets.test.js — the day, service and hour a sale is COUNTED in are the venue's.
 * Run: `npm test`, or `node --test src/backoffice/sections/reports/venueBuckets.test.js`.
 *
 * The rule (Peter, 28 Sep 2026): which business day or service a sale belongs to is
 * business time (venue zone + business_day_start), never the browser's clock. Only the
 * TEXT of a time is display. v5.10.2 moved the report PERIODS onto the venue clock; this
 * pins the buckets inside them:
 *   1. classifyShift (Sales summary, Daypart, Shifts): the service of a check, on the
 *      venue's wall clock. Peter in California saw a London 12:30 lunch check at 04:30,
 *      outside every service.
 *   2. Daily trend / Item trend: one bucket per venue business day, the axis from
 *      range.fromDay..toDay (was the browser's midnights, which also doubled a day and
 *      dropped another across a DST change).
 *   3. Daypart grid: venue hour, business day weekday.
 *   4. Shifts: days and services grouped on the venue's clock.
 *   5. Location compare: the same business days read on EACH venue's clock.
 * Every case runs with the process clock in Los Angeles, London, Tokyo and UTC, and all
 * of them must give the same answer.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  getPeriodRange, classifyShift, reportClock, dayOfCheck, venueHour, weekdayOf,
  rangeDays, prevRangeDays, daypartGrid, groupChecksByDay, groupChecksByService, venueRange,
} from './_filters.js';

const LUNCH = { id: 'lunch', name: 'Lunch', start: '11:00', end: '15:00' };
const LATE = { id: 'late', name: 'Late bar', start: '22:00', end: '02:00' };
const LEEDS = { timezone: 'Europe/London', businessDayStart: '06:30', shifts: [LUNCH, LATE] };
const PROVO = { timezone: 'America/Denver', businessDayStart: '06:00', shifts: [LUNCH] };

const BROWSERS = ['America/Los_Angeles', 'Europe/London', 'Asia/Tokyo', 'UTC'];

function inZone(tz, fn) {
  const prev = process.env.TZ;
  process.env.TZ = tz;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env.TZ; else process.env.TZ = prev;
  }
}

// Dates become ISO strings so answers from different browsers compare as plain data.
const plain = (v) => JSON.parse(JSON.stringify(v ?? null));

// Runs fn with the browser's clock in every zone; all of them must give the same answer.
function everyBrowser(fn) {
  const out = BROWSERS.map((z) => inZone(z, () => plain(fn())));
  out.forEach((r, i) => assert.deepEqual(r, out[0], `a browser in ${BROWSERS[i]} got a different answer`));
  return out[0];
}

const at = (iso) => Date.parse(iso);
const check = (iso, extra = {}) => ({ id: iso, closedAt: at(iso), total: 10, ...extra });
const name = (s) => s?.name ?? null;

test('the harness really moves the browser clock', () => {
  inZone('America/Los_Angeles', () => assert.equal(new Date('2026-09-28T11:30:00Z').getHours(), 4));
  inZone('Asia/Tokyo', () => assert.equal(new Date('2026-09-28T11:30:00Z').getHours(), 20));
});

// ── 1. classifyShift ──────────────────────────────────────────────────────────

test('classifyShift: a London 12:30 lunch check is Lunch in every browser (was 04:30 in California)', () => {
  const ts = at('2026-09-28T11:30:00Z'); // 12:30 BST
  assert.equal(everyBrowser(() => name(classifyShift(ts, LEEDS.shifts, LEEDS.timezone))), 'Lunch');
  // The old reading, the browser's getHours(), put it outside every service in California.
  inZone('America/Los_Angeles', () => {
    const d = new Date(ts);
    assert.equal(d.getHours() * 60 + d.getMinutes(), 4 * 60 + 30);
  });
});

test('classifyShift: the edges are the venue\'s wall clock (start in, end out)', () => {
  const s = (iso) => everyBrowser(() => name(classifyShift(at(iso), LEEDS.shifts, 'Europe/London')));
  assert.equal(s('2026-09-28T09:59:59Z'), null);        // 10:59:59 BST
  assert.equal(s('2026-09-28T10:00:00Z'), 'Lunch');     // 11:00 BST
  assert.equal(s('2026-09-28T13:59:00Z'), 'Lunch');     // 14:59 BST
  assert.equal(s('2026-09-28T14:00:00Z'), null);        // 15:00 BST
});

test('classifyShift: a late bar across midnight, and across the UK clocks going back', () => {
  const s = (iso) => everyBrowser(() => name(classifyShift(at(iso), LEEDS.shifts, 'Europe/London')));
  assert.equal(s('2026-09-27T22:30:00Z'), 'Late bar');  // 23:30 BST Sunday
  assert.equal(s('2026-09-28T00:30:00Z'), 'Late bar');  // 01:30 BST Monday
  assert.equal(s('2026-09-28T01:00:00Z'), null);        // 02:00 BST: the bar has shut
  assert.equal(s('2026-10-25T00:30:00Z'), 'Late bar');  // 01:30 BST, the first 01:30
  assert.equal(s('2026-10-25T01:30:00Z'), 'Late bar');  // 01:30 GMT, the second 01:30
  assert.equal(s('2026-10-25T02:00:00Z'), null);        // 02:00 GMT
});

test('classifyShift: a US venue uses its own zone; no zone is London, never the browser', () => {
  // 12:30 MDT in Provo is 18:30 in London: lunch there, not here.
  const ts = at('2026-09-28T18:30:00Z');
  assert.equal(everyBrowser(() => name(classifyShift(ts, PROVO.shifts, PROVO.timezone))), 'Lunch');
  assert.equal(everyBrowser(() => name(classifyShift(ts, PROVO.shifts, 'Europe/London'))), null);
  const london = at('2026-09-28T11:30:00Z');
  for (const tz of [undefined, null, '', 'Not/AZone']) {
    assert.equal(everyBrowser(() => name(classifyShift(london, LEEDS.shifts, tz))), 'Lunch', String(tz));
  }
});

test('classifyShift: dates, ISO strings and numbers alike; bad input is null, a bad service is skipped', () => {
  const iso = '2026-09-28T11:30:00Z';
  for (const ts of [iso, at(iso), new Date(iso)]) {
    assert.equal(everyBrowser(() => name(classifyShift(ts, LEEDS.shifts, 'Europe/London'))), 'Lunch');
  }
  assert.equal(classifyShift(null, LEEDS.shifts, 'Europe/London'), null);
  assert.equal(classifyShift('not a date', LEEDS.shifts, 'Europe/London'), null);
  assert.equal(classifyShift(at(iso), [], 'Europe/London'), null);
  const broken = [{ id: 'x', name: 'Broken', start: 'noon', end: '15:00' }, LUNCH];
  assert.equal(everyBrowser(() => name(classifyShift(at(iso), broken, 'Europe/London'))), 'Lunch');
});

// ── 2. business days: the check's day, the axis, the compare axis ────────────────

test('dayOfCheck: the venue business day, turning over at 06:30 London', () => {
  const clock = reportClock(LEEDS);
  const d = (iso) => everyBrowser(() => dayOfCheck(at(iso), clock));
  assert.equal(d('2026-09-27T23:40:00Z'), '2026-09-27');   // 00:40 BST Monday: Sunday's trading
  assert.equal(d('2026-09-28T05:29:59Z'), '2026-09-27');   // 06:29:59 BST
  assert.equal(d('2026-09-28T05:30:00Z'), '2026-09-28');   // 06:30 BST
  // 17:00 BST Sunday is 01:00 Monday in Tokyo: the browser's date was the wrong day there.
  assert.equal(d('2026-09-27T16:00:00Z'), '2026-09-27');
  inZone('Asia/Tokyo', () => assert.equal(new Date(at('2026-09-27T16:00:00Z')).getDate(), 28));
  // A range carries the same clock (timeZone + dayStart) it was built on.
  const range = getPeriodRange('today', null, LEEDS, at('2026-09-28T16:00:00Z'));
  assert.equal(range.dayStart, '06:30');
  assert.equal(everyBrowser(() => dayOfCheck(at('2026-09-28T05:29:59Z'), range)), '2026-09-27');
  assert.equal(dayOfCheck(null, range), null);
  assert.equal(dayOfCheck('nope', range), null);
});

test('rangeDays / prevRangeDays: the axis is the business days fromDay..toDay', () => {
  const now = at('2026-09-28T16:00:00Z');
  const r = everyBrowser(() => {
    const range = getPeriodRange('last-7', null, LEEDS, now);
    return { days: rangeDays(range), prev: prevRangeDays(range) };
  });
  assert.deepEqual(r.days, ['2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-26', '2026-09-27', '2026-09-28']);
  assert.deepEqual(r.prev, ['2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18', '2026-09-19', '2026-09-20', '2026-09-21']);
  // One day, a month, and nothing for no range.
  assert.deepEqual(everyBrowser(() => rangeDays(getPeriodRange('yesterday', null, LEEDS, now))), ['2026-09-27']);
  assert.equal(everyBrowser(() => rangeDays(getPeriodRange('last-month', null, LEEDS, now))).length, 31);
  assert.deepEqual(rangeDays(null), []);
  assert.deepEqual(prevRangeDays(undefined), []);
});

test('rangeDays across the UK clocks going back: no day twice, none missing', () => {
  // The old axis stepped 24 h from the browser's midnight. In a London browser the 25 hour
  // Sunday made it read 25 Oct twice: 8 columns for a 7 day range.
  const now = at('2026-10-28T12:00:00Z');
  const days = everyBrowser(() => rangeDays(getPeriodRange('last-7', null, LEEDS, now)));
  assert.deepEqual(days, ['2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25', '2026-10-26', '2026-10-27', '2026-10-28']);
  const oldAxis = inZone('Europe/London', () => {
    const range = getPeriodRange('last-7', null, LEEDS, now);
    const start = new Date(range.from); start.setHours(0, 0, 0, 0);
    const end = new Date(range.to); end.setHours(0, 0, 0, 0);
    const out = [];
    for (let t = start.getTime(); t <= end.getTime(); t += 86400000) {
      const d = new Date(t);
      out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
    }
    return out;
  });
  assert.notDeepEqual(oldAxis, days, 'the old axis really was wrong here');
});

test('a week of Leeds checks lands on the same business days in every browser (Daily trend / Item trend)', () => {
  const now = at('2026-09-28T16:00:00Z');
  const checks = [
    check('2026-09-22T05:30:00Z'),   // 06:30 BST Tue: Tuesday's first minute
    check('2026-09-23T05:29:00Z'),   // 06:29 BST Wed: still Tuesday
    check('2026-09-26T23:40:00Z'),   // 00:40 BST Sun: Saturday
    check('2026-09-27T16:00:00Z'),   // 17:00 BST Sun (01:00 Mon in Tokyo)
    check('2026-09-27T21:00:00Z'),   // 22:00 BST Sun (14:00 Sun in California)
    check('2026-09-28T07:00:00Z'),   // 08:00 BST Mon (00:00 Mon in California)
    check('2026-09-21T05:29:00Z'),   // 06:29 BST Mon 21: before the range, not on the axis
  ];
  const got = everyBrowser(() => {
    const range = getPeriodRange('last-7', null, LEEDS, now);
    const out = Object.fromEntries(rangeDays(range).map((d) => [d, 0]));
    for (const c of checks) {
      const k = dayOfCheck(c.closedAt, range);
      if (k in out) out[k] += 1;
    }
    return out;
  });
  assert.deepEqual(got, {
    '2026-09-22': 2, '2026-09-23': 0, '2026-09-24': 0, '2026-09-25': 0,
    '2026-09-26': 1, '2026-09-27': 2, '2026-09-28': 1,
  });
});

// ── 3. Daypart grid ────────────────────────────────────────────────────────────

test('daypartGrid: the venue\'s hour, and the business day\'s weekday', () => {
  const clock = reportClock(LEEDS);
  const g = everyBrowser(() => daypartGrid([
    check('2026-09-25T11:30:00Z', { total: 12 }),                     // Fri 12:30 BST
    check('2026-09-25T23:40:00Z', { total: 5 }),                      // Sat 00:40 BST: Friday night
    check('2026-09-27T16:00:00Z', { total: 3 }),                      // Sun 17:00 BST
    check('2026-09-25T11:45:00Z', { total: 99, status: 'voided' }),   // voided: not counted
    { id: 'open', total: 50 },                                        // no closedAt: not counted
  ], clock));
  // Mon = 0 … Sun = 6
  assert.equal(g.grid[4][12], 12);
  assert.equal(g.grid[4][0], 5);
  assert.equal(g.grid[6][17], 3);
  assert.equal(g.byHour[12], 12);
  assert.deepEqual(g.byDow, [0, 0, 0, 0, 17, 0, 3]);
  assert.equal(g.byHour.reduce((a, b) => a + b, 0), 20);
  // The old grid, from California: Friday lunch at 04:00.
  inZone('America/Los_Angeles', () => assert.equal(new Date(at('2026-09-25T11:30:00Z')).getHours(), 4));
});

test('venueHour and weekdayOf read the venue, never the browser', () => {
  assert.equal(everyBrowser(() => venueHour(at('2026-09-28T11:30:00Z'), 'Europe/London')), 12);
  assert.equal(everyBrowser(() => venueHour(at('2026-09-28T11:30:00Z'), 'America/Denver')), 5);
  assert.equal(everyBrowser(() => venueHour(at('2026-10-25T01:30:00Z'), 'Europe/London')), 1); // 01:30 GMT
  assert.equal(venueHour('nope', 'Europe/London'), null);
  assert.equal(everyBrowser(() => weekdayOf('2026-09-27')), 0);   // Sunday
  assert.equal(everyBrowser(() => weekdayOf('2026-09-28')), 1);   // Monday
});

// ── 4. Shifts ──────────────────────────────────────────────────────────────────

test('groupChecksByDay: business days, newest first (Shifts, no services configured)', () => {
  const clock = reportClock(LEEDS);
  const got = everyBrowser(() => groupChecksByDay([
    check('2026-09-27T08:00:00Z'),   // 09:00 BST Sun
    check('2026-09-27T23:40:00Z'),   // 00:40 BST Mon: Sunday
    check('2026-09-28T05:30:00Z'),   // 06:30 BST Mon
    { id: 'no-time' },
  ], clock).map((d) => [d.key, d.checks.length]));
  assert.deepEqual(got, [['2026-09-28', 1], ['2026-09-27', 2]]);
});

test('groupChecksByService: a 01:30 late bar check is the previous business day\'s late bar', () => {
  const clock = reportClock(LEEDS);
  const got = everyBrowser(() => groupChecksByService([
    check('2026-09-26T11:30:00Z'),   // Sat 12:30 BST lunch
    check('2026-09-26T22:00:00Z'),   // Sat 23:00 BST late bar
    check('2026-09-27T00:30:00Z'),   // Sun 01:30 BST: Saturday's late bar
    check('2026-09-27T11:00:00Z'),   // Sun 12:00 BST lunch
    check('2026-09-27T08:00:00Z'),   // Sun 09:00 BST: outside every service, left out
  ], LEEDS.shifts, clock).map((g) => [g.dayKey, g.shift.name, g.checks.length]));
  assert.deepEqual(got, [
    ['2026-09-27', 'Lunch', 1],
    ['2026-09-26', 'Lunch', 1],
    ['2026-09-26', 'Late bar', 2],
  ]);
});

// ── 5. Location compare ────────────────────────────────────────────────────────

test('venueRange: the same business days on another venue\'s clock (Location compare)', () => {
  const now = at('2026-09-28T16:00:00Z');
  const got = everyBrowser(() => {
    const range = getPeriodRange('yesterday', null, LEEDS, now);   // Leeds' 27 Sep
    return { leeds: venueRange(range, LEEDS), provo: venueRange(range, PROVO), range };
  });
  // Leeds on its own clock is exactly the range the other reports read.
  assert.equal(got.leeds.from, got.range.from);
  assert.equal(got.leeds.to, got.range.to);
  // Provo's 27 Sep: 06:00 MDT to 05:59:59.999 MDT on the 28th (it was London's window).
  assert.equal(got.provo.from, '2026-09-27T12:00:00.000Z');
  assert.equal(got.provo.to, '2026-09-28T11:59:59.999Z');
  assert.equal(got.provo.fromDay, '2026-09-27');
  assert.equal(got.provo.timeZone, 'America/Denver');
  assert.equal(got.provo.dayStart, '06:00');
  // No clock at all = London at midnight, like getPeriodRange with no config.
  const bare = everyBrowser(() => venueRange(getPeriodRange('yesterday', null, LEEDS, now), null));
  assert.equal(bare.from, '2026-09-26T23:00:00.000Z');
  assert.equal(venueRange(null, PROVO), null);
});

test('venueRange: a service is the same wall clock times on the same day at each venue', () => {
  const now = at('2026-09-28T13:00:00Z');   // 14:00 BST, Lunch is on in Leeds
  const got = everyBrowser(() => {
    const range = getPeriodRange('service:today:lunch', null, LEEDS, now);
    return { leeds: venueRange(range, LEEDS), provo: venueRange(range, PROVO), range };
  });
  assert.equal(got.range.serviceStart, 11 * 60);
  assert.equal(got.range.serviceEnd, 15 * 60);
  assert.equal(got.leeds.from, got.range.from);
  assert.equal(got.leeds.to, got.range.to);
  assert.equal(got.provo.from, '2026-09-28T17:00:00.000Z');   // 11:00 MDT
  assert.equal(got.provo.to, '2026-09-28T21:00:59.999Z');     // 15:00 MDT, end minute included
  // A late bar keeps running past midnight at the other venue too.
  const late = everyBrowser(() => venueRange(getPeriodRange('service:today:late', null, LEEDS, now), PROVO));
  assert.equal(late.from, '2026-09-28T04:00:00.000Z');        // 22:00 MDT 27 Sep
  assert.equal(late.to, '2026-09-28T08:00:59.999Z');          // 02:00 MDT 28 Sep
});

// ── Wiring: every report puts checks on the venue's clock ──────────────────────

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const DEVICE_CLOCK = /\.(getHours|getDay|getDate|getMonth|getFullYear|setHours|setDate)\(/;

test('Sales summary, Daypart and Shifts pass the venue zone to classifyShift', () => {
  assert.match(read('./SalesSummary.jsx'), /const tz {5}= locationConfig\?\.timezone;[\s\S]*classifyShift\(c\.closedAt, shifts, tz\)/);
  assert.match(read('./Daypart.jsx'), /classifyShift\(c\.closedAt, shifts, clock\.timeZone\)/);
  assert.match(read('./Shifts.jsx'), /classifyShift\(c\.closedAt, shifts, timeZone\)/);
  assert.match(read('./Shifts.jsx'), /unclassifiedCheckCount\(checks, shifts, clock\.timeZone\)/);
  for (const f of ['./SalesSummary.jsx', './Daypart.jsx', './Shifts.jsx']) {
    assert.doesNotMatch(read(f), /classifyShift\([^)]*bds\)/, f);
  }
});

test('Daypart, Shifts, Daily trend and Item trend read no browser clock', () => {
  for (const f of ['./Daypart.jsx', './Shifts.jsx', './DailyTrend.jsx', './ItemTrend.jsx']) {
    assert.doesNotMatch(read(f), DEVICE_CLOCK, f);
  }
  assert.match(read('./Daypart.jsx'), /daypartGrid\(checks, clock\)/);
  assert.match(read('./Daypart.jsx'), /venueHour\(new Date\(\), clock\.timeZone\)/);
  assert.match(read('./Shifts.jsx'), /groupChecksByDay\(checks, clock\)/);
  assert.match(read('./Shifts.jsx'), /groupChecksByService\(checks, shifts, clock\)/);
});

test('Daily trend and Item trend build their days from the range and bucket on the venue clock', () => {
  const bo = read('../BOReports.jsx');
  // 5 Oct 2026: every report also gets the optional multi site props ({...siteProps}).
  assert.match(bo, /<ItemTrend {4}checks=\{filtered\} fmt=\{fmt\} fmtN=\{fmtN\} range=\{range\} \{\.\.\.siteProps\}\/>/);
  assert.match(bo, /<DailyTrend {3}checks=\{filtered\} prevChecks=\{filteredPrev\} fmt=\{fmt\} fmtN=\{fmtN\} range=\{trendRange\} \{\.\.\.siteProps\}\/>/);
  // trendRange (v5.11.29) is the same range with the comparison as it stands now (it moves with the clock).
  assert.match(bo, /const trendRange\s+= useMemo\(\(\) => \(\{ \.\.\.range, compare: shownCompare \}\), \[range, shownCompare\]\);/);
  const dt = read('./DailyTrend.jsx');
  assert.match(dt, /rangeDays\(range\)/);
  assert.match(dt, /prevRangeDays\(range\)/);
  assert.match(dt, /const k = dayOfCheck\(c\.closedAt, clock\);/);
  assert.match(dt, /buildDayBuckets\(prevChecks, prevDays, range\)/);
  const it = read('./ItemTrend.jsx');
  assert.match(it, /rangeDays\(range\)\.filter\(d => dowFilter === 'all' \|\| Number\(dowFilter\) === weekdayOf\(d\)\)/);
  assert.match(it, /const dayKey = dayOfCheck\(c\.closedAt, range\);/);
});

test('the Z report prints From, To and Printed in the venue zone', () => {
  assert.match(read('../BOReports.jsx'), /<ZReport [^>]*timeZone=\{range\.timeZone\}/);
  const z = read('./ZReport.jsx');
  assert.match(z, /formatDate\(rangeFrom, tz\)\} \{formatTime\(rangeFrom, tz\)\}/);
  assert.match(z, /formatDate\(rangeTo, tz\)\} \{formatTime\(rangeTo, tz\)\}/);
  assert.match(z, /formatDate\(printedAt, tz\)\} \{formatTime\(printedAt, tz\)\}/);
  assert.match(z, /toLocaleTimeString\('en-GB', \{ hour:'2-digit', minute:'2-digit', timeZone \}\)/);
});

test('Location compare reads each venue on its own clock, without touching the active venue', () => {
  assert.match(read('../BOReports.jsx'), /<LocationCompare range=\{range\}/);
  const lc = read('./LocationCompare.jsx');
  assert.match(lc, /venueRange\(range, await getVenueClock\(l\.id\)\)/);
  // 5 Oct 2026: no row cap any more, each venue's window is read in full (lib/pagedRead.js).
  assert.match(lc, /fetchClosedChecksMultiRange\(windows, \{/);
  assert.doesNotMatch(lc, /getLocationConfig|rangeFrom|rangeTo/);
  // getLocationConfig sets the Back Office currency from the row it reads: reading every
  // venue through it would switch £ to $ when a US venue came last.
  const lt = read('../../../lib/locationTime.js');
  const fn = lt.slice(lt.indexOf('export async function getVenueClock'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.ok(body.length > 100, 'getVenueClock found');
  assert.doesNotMatch(body, /setActiveCurrency|_locationConfigCache\.set/);
  assert.match(read('../../../lib/db.js'), /export const fetchClosedChecksMultiRange = async \(windows = \[\], opts = \{\}\)/);
});
