/* global process */
/**
 * venueHoursAndDays.test.js: the rest of the reports count sales on the venue's clock.
 * Run: `npm test`, or `node --test src/backoffice/sections/reports/venueHoursAndDays.test.js`.
 *
 * The rule (Peter, 28 Sep 2026): the business day, service or hour a sale is COUNTED in
 * is business time (venue zone + business_day_start), never the device clock. Only the
 * TEXT of a time is display. venueBuckets.test.js (PR 180, shipped in v5.11.0) pins Sales summary, Daypart,
 * Shifts, the trends and Location compare; this pins the ones left on the device clock:
 *   1. Order types / Order sources: the chart's days and hours (mixSeries, mixLabel).
 *   2. Product mix: the part of the day an item sold in (daySlot).
 *   3. Servers / Tips: hours worked per business day (workedTime).
 *   4. Tips by hour, KDS bump time by hour (sumByVenueHour), and "now" on those charts.
 *   5. Bookings: the chart's "today" and its days.
 * Every case runs with the process clock in Los Angeles, London, Tokyo and UTC, and all
 * of them must give the same answer.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

import {
  reportClock, dayOfCheck, rangeDays, dayText,
  mixSeries, mixLabel, daySlot, workedTime, sumByVenueHour,
} from './_filters.js';

const LEEDS = { timezone: 'Europe/London', businessDayStart: '06:30' };
const PROVO = { timezone: 'America/Denver', businessDayStart: '06:00' };
const LEEDS_CLOCK = reportClock(LEEDS);

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
const H = 3600000;
const M = 60000;

// The readings these reports used until now, to show what they got wrong.
const oldDayKey = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };
const oldHour = (ts) => new Date(ts).getHours();

test('the harness really moves the browser clock', () => {
  inZone('America/Los_Angeles', () => assert.equal(oldHour(at('2026-09-28T11:30:00Z')), 4));
  inZone('Asia/Tokyo', () => assert.equal(oldHour(at('2026-09-28T11:30:00Z')), 20));
});

// ── 1. Order types / Order sources ───────────────────────────────────────────

test('mixSeries: over several days, one bar per Leeds business day (06:30 to 06:30)', () => {
  const checks = [
    check('2026-09-25T11:30:00Z', { orderType: 'dine-in', total: 10 }),  // Fri 12:30 BST
    check('2026-09-26T00:30:00Z', { orderType: 'takeaway', total: 5 }),  // Sat 01:30 BST: Friday's night
    check('2026-09-26T05:15:00Z', { orderType: 'dine-in', total: 7 }),   // Sat 06:15 BST: still Friday
    check('2026-09-26T17:00:00Z', { orderType: 'delivery', total: 20 }), // Sat 18:00 BST
    check('2026-09-26T12:00:00Z', { orderType: 'dine-in', status: 'voided', total: 99 }),
    { id: 'no-close', orderType: 'dine-in', total: 50 },
  ];
  const s = everyBrowser(() => mixSeries(checks, (c) => c.orderType, LEEDS_CLOCK));
  assert.equal(s.isHourly, false);
  assert.deepEqual(s.xKeys, ['2026-09-25', '2026-09-26']);
  assert.deepEqual(s.series['2026-09-25'], { key: '2026-09-25', total: 22, 'dine-in': 17, takeaway: 5 });
  assert.deepEqual(s.series['2026-09-26'], { key: '2026-09-26', total: 20, delivery: 20 });
  assert.deepEqual(s.types, ['dine-in', 'takeaway', 'delivery']);
  // The old reading: London put Friday's late trade on Saturday, Tokyo put Saturday
  // evening on Sunday.
  inZone('Europe/London', () => assert.equal(oldDayKey(checks[1].closedAt), '2026-09-26'));
  inZone('Asia/Tokyo', () => assert.equal(oldDayKey(checks[3].closedAt), '2026-09-27'));
});

test('mixSeries: one business day is by the venue\'s hour, in the order the day runs', () => {
  const checks = [
    check('2026-09-27T00:30:00Z', { orderType: 'bar' }),      // Sun 01:30 BST, Saturday's late bar
    check('2026-09-26T06:00:00Z', { orderType: 'dine-in' }),  // Sat 07:00 BST
    check('2026-09-26T11:30:00Z', { orderType: 'dine-in' }),  // Sat 12:30 BST
    check('2026-09-26T22:10:00Z', { orderType: 'bar' }),      // Sat 23:10 BST
  ];
  const s = everyBrowser(() => mixSeries(checks, (c) => c.orderType, LEEDS_CLOCK));
  assert.equal(s.isHourly, true);
  assert.deepEqual(s.xKeys, ['7', '12', '23', '1']);   // from the 06:30 start, so 01:30 comes last
  assert.equal(s.series['12']['dine-in'], 10);
  assert.equal(s.series['1'].bar, 10);
  assert.deepEqual(s.xKeys.map((k) => mixLabel(k, true)), ['7:00', '12:00', '23:00', '1:00']);
  // The old reading from California: 23:00, 04:00, 15:00 and 17:00.
  inZone('America/Los_Angeles', () => assert.deepEqual(checks.map((c) => oldHour(c.closedAt)), [17, 23, 4, 15]));
});

test('mixSeries: a US venue reads its own zone; no day start runs 0:00 to 23:00', () => {
  const provo = everyBrowser(() => mixSeries([check('2026-09-26T18:30:00Z')], () => 'pos', reportClock(PROVO)));
  assert.deepEqual(provo.xKeys, ['12']);                    // 12:30 MDT
  const midnight = everyBrowser(() => mixSeries(
    [check('2026-09-26T12:00:00Z'), check('2026-09-25T23:30:00Z')],  // 13:00 and 00:30 BST on the 26th
    () => 'pos', reportClock({ timezone: 'Europe/London' })));
  assert.deepEqual(midnight.xKeys, ['0', '13']);
  assert.deepEqual(everyBrowser(() => mixSeries([], () => 'pos', LEEDS_CLOCK)), { series: {}, xKeys: [], isHourly: false, types: [] });
});

test('mixLabel: a day key reads as that date in every browser (was a day behind in the Americas)', () => {
  const label = everyBrowser(() => mixLabel('2026-09-27', false));
  assert.equal(label, dayText('2026-09-27', { day: 'numeric', month: 'short' }));
  assert.match(label, /^27 /);
  inZone('America/Los_Angeles', () => assert.match(
    new Date('2026-09-27').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }), /^26 /));
});

// ── 2. Product mix ────────────────────────────────────────────────────────────

test('daySlot: the part of the day is the venue\'s hour', () => {
  const slot = (iso, tz = 'Europe/London') => everyBrowser(() => daySlot(at(iso), tz));
  assert.equal(slot('2026-09-28T09:59:00Z'), 'morning');    // 10:59 BST
  assert.equal(slot('2026-09-28T11:30:00Z'), 'lunch');      // 12:30 BST
  assert.equal(slot('2026-09-28T15:00:00Z'), 'afternoon');  // 16:00 BST
  assert.equal(slot('2026-09-28T17:30:00Z'), 'dinner');     // 18:30 BST
  assert.equal(slot('2026-09-28T21:30:00Z'), 'late');       // 22:30 BST
  assert.equal(slot('2026-09-28T18:30:00Z', 'America/Denver'), 'lunch');  // 12:30 MDT
  // Dates, ISO strings and numbers alike; no close time is 12:00, as before.
  assert.equal(everyBrowser(() => daySlot('2026-09-28T11:30:00Z', 'Europe/London')), 'lunch');
  assert.equal(everyBrowser(() => daySlot(new Date('2026-09-28T11:30:00Z'), 'Europe/London')), 'lunch');
  assert.equal(everyBrowser(() => daySlot(null, 'Europe/London')), 'lunch');
  // The old reading: London lunch and dinner were both "morning" from California.
  inZone('America/Los_Angeles', () => {
    assert.equal(oldHour(at('2026-09-28T11:30:00Z')), 4);
    assert.equal(oldHour(at('2026-09-28T17:30:00Z')), 10);
  });
});

// ── 3. Servers / Tips: hours worked ─────────────────────────────────────────

test('workedTime: a shift past midnight is ONE business day (the calendar split it)', () => {
  const closes = [
    at('2026-09-26T16:00:00Z'),   // Sat 17:00 BST
    at('2026-09-26T22:50:00Z'),   // Sat 23:50 BST
    at('2026-09-26T23:40:00Z'),   // Sun 00:40 BST, still Saturday's business day
  ];
  assert.deepEqual(everyBrowser(() => workedTime(closes, LEEDS_CLOCK)), { ms: 7 * H + 40 * M, days: 1 });
  // The old reading in London: two calendar days, 6h 50m, the 50 minutes over midnight lost.
  inZone('Europe/London', () => assert.deepEqual(closes.map(oldDayKey), ['2026-09-26', '2026-09-26', '2026-09-27']));
});

test('workedTime: one span per business day, summed; bad entries are skipped', () => {
  const closes = [
    at('2026-09-26T16:00:00Z'), at('2026-09-26T23:40:00Z'),  // Saturday: 7h 40m
    at('2026-09-27T10:00:00Z'), at('2026-09-27T14:00:00Z'),  // Sunday 11:00 to 15:00 BST: 4h
    '2026-09-27T12:00:00Z', null, 'nope', undefined,
  ];
  assert.deepEqual(everyBrowser(() => workedTime(closes, LEEDS_CLOCK)), { ms: 11 * H + 40 * M, days: 2 });
  // 06:10 BST on Sunday is before the 06:30 start: it stretches Saturday, not Sunday.
  const early = [at('2026-09-26T16:00:00Z'), at('2026-09-27T05:10:00Z')];
  assert.deepEqual(everyBrowser(() => workedTime(early, LEEDS_CLOCK)), { ms: 13 * H + 10 * M, days: 1 });
  assert.deepEqual(everyBrowser(() => workedTime([], LEEDS_CLOCK)), { ms: 0, days: 0 });
});

// ── 4. Tips by hour, KDS bump time by hour ──────────────────────────────────

test('sumByVenueHour: tips by the venue\'s hour (was 04:00 and 11:00 from California)', () => {
  const checks = [
    check('2026-09-28T11:30:00Z', { tip: 2 }),   // 12:30 BST
    check('2026-09-28T11:45:00Z', { tip: 1 }),   // 12:45 BST
    check('2026-09-28T18:00:00Z', { tip: 3 }),   // 19:00 BST
    { id: 'no-close', tip: 5 },
  ];
  const byHour = everyBrowser(() => sumByVenueHour(checks, (c) => c.closedAt, (c) => c.tip || 0, 'Europe/London'));
  assert.equal(byHour.length, 24);
  assert.equal(byHour[12], 3);
  assert.equal(byHour[19], 3);
  assert.equal(byHour.reduce((a, b) => a + b, 0), 6);
  inZone('America/Los_Angeles', () => assert.deepEqual(checks.slice(0, 3).map((c) => oldHour(c.closedAt)), [4, 4, 11]));
});

test('sumByVenueHour: KDS tickets by the venue hour they were sent', () => {
  const t = (iso, bumpMin) => ({ sentAt: at(iso), bumpedAt: at(iso) + bumpMin * M });
  const tickets = [t('2026-09-28T11:05:00Z', 5), t('2026-09-28T11:40:00Z', 15), t('2026-09-28T17:00:00Z', 10)];
  const { count, sum } = everyBrowser(() => ({
    count: sumByVenueHour(tickets, (x) => x.sentAt, () => 1, 'Europe/London'),
    sum: sumByVenueHour(tickets, (x) => x.sentAt, (x) => x.bumpedAt - x.sentAt, 'Europe/London'),
  }));
  assert.equal(count[12], 2);
  assert.equal(count[18], 1);
  assert.equal(sum[12] / count[12], 10 * M);
  // A US kitchen reads its own hour; ISO strings work too.
  const denver = everyBrowser(() => sumByVenueHour([{ sentAt: '2026-09-28T18:30:00Z' }], (x) => x.sentAt, () => 1, 'America/Denver'));
  assert.equal(denver[12], 1);
});

// ── 5. Bookings ──────────────────────────────────────────────────────────────

test('Bookings "today" is the venue business day now, the day the Today period shows', () => {
  const now = at('2026-09-28T03:00:00Z');   // 04:00 BST: still the 27th's business day at Leeds
  assert.equal(everyBrowser(() => dayOfCheck(now, reportClock(LEEDS))), '2026-09-27');
  // The old reading: the browser's date, the 28th in London and Tokyo.
  inZone('Europe/London', () => assert.equal(oldDayKey(now), '2026-09-28'));
  inZone('Asia/Tokyo', () => assert.equal(oldDayKey(now), '2026-09-28'));
  // Its days are the range's business days, across the clocks going back too.
  assert.deepEqual(everyBrowser(() => rangeDays({ fromDay: '2026-10-24', toDay: '2026-10-26' })),
    ['2026-10-24', '2026-10-25', '2026-10-26']);
});

// ── Wiring: these reports take the venue's clock and read no device clock ────────

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const DEVICE_CLOCK = /\.(getHours|getDay|getDate|getMonth|getFullYear|setHours|setDate)\(/;

test('Back Office passes the venue config to every one of these reports', () => {
  const bo = read('../BOReports.jsx');
  for (const r of ['ProductMix', 'Servers', 'Tips', 'OrderTypes', 'OrderSources', 'BookingsReport', 'KDSPerformance']) {
    assert.match(bo, new RegExp(`<${r} [^>]*locationConfig=\\{locationConfig\\}`), r);
  }
});

test('the reports use the venue clock helpers', () => {
  assert.match(read('./OrderTypes.jsx'), /mixSeries\(checks, typeKey, clock\)/);
  assert.match(read('./OrderTypes.jsx'), /xKeys\.map\(k => mixLabel\(k, isHourly\)\)/);
  assert.match(read('./OrderSources.jsx'), /mixSeries\(checks, srcKey, clock\)/);
  assert.match(read('./OrderSources.jsx'), /xKeys\.map\(k => mixLabel\(k, isHourly\)\)/);
  assert.match(read('./ProductMix.jsx'), /const slot = daySlot\(c\.closedAt, timeZone\);/);
  assert.match(read('./Servers.jsx'), /workedTime\(r\.closes, clock\)/);
  const tips = read('./Tips.jsx');
  assert.match(tips, /workedTime\(r\.closes, clock\)\.ms/);
  assert.match(tips, /sumByVenueHour\(checks\.filter\(c => c\.status !== 'voided'\), c => c\.closedAt, c => c\.tip \|\| 0, clock\.timeZone\)/);
  assert.match(tips, /venueHour\(new Date\(\), clock\.timeZone\)/);
  const kds = read('./KDSPerformance.jsx');
  assert.match(kds, /sumByVenueHour\(bumped, t => t\.sentAt, \(\) => 1, clock\.timeZone\)/);
  assert.match(kds, /venueHour\(new Date\(\), clock\.timeZone\)/);
  const bk = read('./BookingsReport.jsx');
  assert.match(bk, /todayKey=\{dayOfCheck\(Date\.now\(\), reportClock\(locationConfig\)\)\}/);
  assert.match(bk, /rangeDays\(\{ fromDay: fromISO, toDay: toISO \}\)/);
});

test('no report reads the device clock for a day or an hour', () => {
  const reports = readdirSync(new URL('./', import.meta.url)).filter((f) => /\.jsx?$/.test(f) && !f.endsWith('.test.js'));
  const files = ['../BOReports.jsx', ...reports.map((f) => `./${f}`)];
  assert.ok(files.length > 30, `found ${files.length} report files`);
  for (const f of files) assert.doesNotMatch(read(f), DEVICE_CLOCK, f);
});
