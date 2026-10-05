/* global process */
/**
 * _filters.test.js — Back Office report periods are built on the VENUE's clock.
 * Run: `npm test`, or `node --test src/backoffice/sections/reports/_filters.test.js`.
 *
 * Pinned:
 *   1. The bug (v5.9.99 and before): getPeriodRange used the browser's clock. Peter in
 *      California viewing Coffee Boy Leeds (Europe/London, day starts 06:30) got
 *      "Yesterday" = 06:30 to 06:29 PACIFIC, i.e. 14:30 to 14:29 London.
 *   2. Every answer is the same whatever zone the browser is in (each test runs the
 *      call with the process clock in Los Angeles, London, Tokyo and UTC).
 *   3. DST nights: a 25 hour and a 23 hour business day, a day start inside the spring
 *      forward gap, a US venue's own change, and a service that runs across one.
 *   4. The prev period is the one percent rule (v5.11.29, src/lib/reportCompare.js): the
 *      same weekday last week, the same days of the week or month before, or the whole
 *      period before. Its own cases are in src/lib/reportCompare.test.js.
 *   5. fromDay/toDay are the venue business days, so Daily Trading and Bookings ask the
 *      server for London's dates, never the browser's.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { getPeriodRange, periodLabel, buildPeriods } from './_filters.js';

const LEEDS = {
  timezone: 'Europe/London',
  businessDayStart: '06:30',
  shifts: [
    { id: 'lunch', name: 'Lunch', start: '11:00', end: '15:00' },
    { id: 'late', name: 'Late bar', start: '22:00', end: '02:00' },
  ],
};
const PROVO = { timezone: 'America/Denver', businessDayStart: '06:00', shifts: [] };

const BROWSERS = ['America/Los_Angeles', 'Europe/London', 'Asia/Tokyo', 'UTC'];

function inZone(tz, fn) {
  const prev = process.env.TZ;
  process.env.TZ = tz;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env.TZ; else process.env.TZ = prev;
  }
}

const plain = (r) => (typeof r === 'string' || r == null ? r : {
  ...r,
  from: r.from.toISOString(), to: r.to.toISOString(),
  prevFrom: r.prevFrom.toISOString(), prevTo: r.prevTo.toISOString(),
});

// Runs fn with the browser's clock in every zone; all of them must give the same answer.
function everyBrowser(fn) {
  const out = BROWSERS.map((z) => inZone(z, () => plain(fn())));
  out.forEach((r, i) => assert.deepEqual(r, out[0], `a browser in ${BROWSERS[i]} got a different answer`));
  return out[0];
}

const at = (iso) => Date.parse(iso);

test('the harness really moves the browser clock', () => {
  inZone('America/Los_Angeles', () => assert.equal(new Date('2026-09-28T16:00:00Z').getHours(), 9));
  inZone('Europe/London', () => assert.equal(new Date('2026-09-28T16:00:00Z').getHours(), 17));
});

test('Peter in California, Leeds: Yesterday is 06:30 to 06:29 LONDON (was 14:30 to 14:29)', () => {
  // Monday 28 Sep, 09:00 in California, 17:00 in Leeds.
  const r = everyBrowser(() => getPeriodRange('yesterday', null, LEEDS, at('2026-09-28T16:00:00Z')));
  assert.equal(r.from, '2026-09-27T05:30:00.000Z');   // 06:30 BST Sunday
  assert.equal(r.to, '2026-09-28T05:29:59.999Z');     // 06:29:59.999 BST Monday
  assert.notEqual(r.from, '2026-09-27T13:30:00.000Z', 'the old answer: 06:30 Pacific');
  assert.equal(r.fromDay, '2026-09-27');
  assert.equal(r.toDay, '2026-09-27');
  assert.equal(r.timeZone, 'Europe/London');
  // prev = the same weekday the week before, the whole day (was: Saturday, the day before)
  assert.equal(r.prevFrom, '2026-09-20T05:30:00.000Z');
  assert.equal(r.prevTo, '2026-09-21T05:29:59.999Z');
  assert.equal(r.compare.label, 'vs the Sunday before');
});

test('after 16:00 in California the venue day is London\'s, not the browser\'s', () => {
  // 16:30 PDT Monday 28 Sep = 00:30 BST Tuesday 29 Sep.
  const now = at('2026-09-28T23:30:00Z');
  // Leeds' day starts 06:30, so 00:30 on the 29th is still Monday's trading.
  const leeds = everyBrowser(() => getPeriodRange('today', null, LEEDS, now));
  assert.equal(leeds.fromDay, '2026-09-28');
  assert.equal(leeds.from, '2026-09-28T05:30:00.000Z');
  // A venue whose day starts at midnight is already on Tuesday in London.
  const midnight = everyBrowser(() => getPeriodRange('today', null, { timezone: 'Europe/London' }, now));
  assert.equal(midnight.fromDay, '2026-09-29');
  assert.equal(midnight.toDay, '2026-09-29');
  assert.equal(midnight.from, '2026-09-28T23:00:00.000Z');
  assert.equal(midnight.to, '2026-09-29T22:59:59.999Z');
});

test('every period for Leeds on Monday 28 Sep (BST, 06:30 start)', () => {
  const now = at('2026-09-28T16:00:00Z');
  const expect = {
    // [fromDay, toDay, compared from, compared to, where the comparison stops]
    // A period still trading stops at the same time of day (17:00 BST = 16:00Z); a
    // finished one runs to the end of its last business day.
    'today':      ['2026-09-28', '2026-09-28', '2026-09-21', '2026-09-21', '2026-09-21T16:00:00.000Z'],
    'yesterday':  ['2026-09-27', '2026-09-27', '2026-09-20', '2026-09-20', '2026-09-21T05:29:59.999Z'],
    'this-week':  ['2026-09-28', '2026-09-28', '2026-09-21', '2026-09-21', '2026-09-21T16:00:00.000Z'],   // 28 Sep 2026 is a Monday
    'last-week':  ['2026-09-21', '2026-09-27', '2026-09-14', '2026-09-20', '2026-09-21T05:29:59.999Z'],
    'this-month': ['2026-09-01', '2026-09-28', '2026-08-01', '2026-08-28', '2026-08-28T16:00:00.000Z'],
    'last-month': ['2026-08-01', '2026-08-31', '2026-07-01', '2026-07-31', '2026-08-01T05:29:59.999Z'],
    'last-7':     ['2026-09-22', '2026-09-28', '2026-09-15', '2026-09-21', '2026-09-21T16:00:00.000Z'],
    'last-30':    ['2026-08-30', '2026-09-28', '2026-07-31', '2026-08-29', '2026-08-29T16:00:00.000Z'],
  };
  const nextDay = (ymd) => new Date(Date.parse(`${ymd}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
  for (const [id, [fromDay, toDay, cFrom, cTo, cStop]] of Object.entries(expect)) {
    const r = everyBrowser(() => getPeriodRange(id, null, LEEDS, now));
    assert.equal(r.fromDay, fromDay, id);
    assert.equal(r.toDay, toDay, id);
    assert.equal(r.from, `${fromDay}T05:30:00.000Z`, id);
    assert.equal(r.to, `${nextDay(toDay)}T05:29:59.999Z`, id);
    // prev = the one percent rule, and prevFrom/prevTo are the compare range's instants
    assert.equal(r.compare.fromDay, cFrom, id);
    assert.equal(r.compare.toDay, cTo, id);
    assert.equal(r.prevFrom, `${cFrom}T05:30:00.000Z`, id);
    assert.equal(r.prevTo, cStop, id);
    assert.equal(r.compare.from.toISOString(), r.prevFrom, id);
    assert.equal(r.compare.to.toISOString(), r.prevTo, id);
  }
});

test('the business day turns over at 06:30 London, not at the browser\'s midnight', () => {
  // 00:40 BST Sunday 27 Sep is Saturday's trading.
  assert.equal(everyBrowser(() => getPeriodRange('today', null, LEEDS, at('2026-09-26T23:40:00Z'))).fromDay, '2026-09-26');
  // 06:29 BST: still Saturday. 06:30 BST: Sunday.
  assert.equal(everyBrowser(() => getPeriodRange('today', null, LEEDS, at('2026-09-27T05:29:59.999Z'))).fromDay, '2026-09-26');
  assert.equal(everyBrowser(() => getPeriodRange('today', null, LEEDS, at('2026-09-27T05:30:00.000Z'))).fromDay, '2026-09-27');
});

test('UK clocks go back (Sun 25 Oct 2026): Saturday\'s business day is 25 hours', () => {
  // Noon Sunday. California is still on PDT (US changes 1 Nov), so the gap is 7 hours this week.
  const now = at('2026-10-25T12:00:00Z');
  const y = everyBrowser(() => getPeriodRange('yesterday', null, LEEDS, now));
  assert.equal(y.fromDay, '2026-10-24');
  assert.equal(y.from, '2026-10-24T05:30:00.000Z');   // 06:30 BST
  assert.equal(y.to, '2026-10-25T06:29:59.999Z');     // 06:29:59.999 GMT
  assert.equal(Date.parse(y.to) + 1 - Date.parse(y.from), 25 * 3600000);
  // prev = the Saturday before, an ordinary 24 hour day (all BST), not a 25 hour window
  assert.equal(y.prevFrom, '2026-10-17T05:30:00.000Z');
  assert.equal(y.prevTo, '2026-10-18T05:29:59.999Z');
  // Today (Sunday, all GMT) starts exactly where Yesterday ended.
  const t = everyBrowser(() => getPeriodRange('today', null, LEEDS, now));
  assert.equal(t.from, '2026-10-25T06:30:00.000Z');
  assert.equal(Date.parse(t.from), Date.parse(y.to) + 1);
  assert.equal(t.to, '2026-10-26T06:29:59.999Z');
});

test('UK clocks go forward (Sun 29 Mar 2026): a 23 hour day, and a day start inside the gap', () => {
  const y = everyBrowser(() => getPeriodRange('yesterday', null, LEEDS, at('2026-03-29T12:00:00Z')));
  assert.equal(y.from, '2026-03-28T06:30:00.000Z');   // 06:30 GMT
  assert.equal(y.to, '2026-03-29T05:29:59.999Z');     // 06:29:59.999 BST
  assert.equal(Date.parse(y.to) + 1 - Date.parse(y.from), 23 * 3600000);
  // 01:30 never happens on 29 Mar in London: the day starts at 02:30 BST, the first moment after the gap.
  const early = { timezone: 'Europe/London', businessDayStart: '01:30' };
  const t = everyBrowser(() => getPeriodRange('today', null, early, at('2026-03-29T12:00:00Z')));
  assert.equal(t.fromDay, '2026-03-29');
  assert.equal(t.from, '2026-03-29T01:30:00.000Z');
  assert.equal(t.to, '2026-03-30T00:29:59.999Z');     // 01:29:59.999 BST on the 30th
  const ty = everyBrowser(() => getPeriodRange('yesterday', null, early, at('2026-03-29T12:00:00Z')));
  assert.equal(ty.from, '2026-03-28T01:30:00.000Z');
  assert.equal(Date.parse(ty.to) + 1, Date.parse(t.from), 'no gap and no overlap between the days');
});

test('a US venue viewed from the UK uses its own zone and its own DST change', () => {
  // 21:00 MDT Sunday 27 Sep = 04:00 BST Monday in the viewer's browser.
  const t = everyBrowser(() => getPeriodRange('today', null, PROVO, at('2026-09-28T03:00:00Z')));
  assert.equal(t.fromDay, '2026-09-27');
  assert.equal(t.from, '2026-09-27T12:00:00.000Z');   // 06:00 MDT
  assert.equal(t.to, '2026-09-28T11:59:59.999Z');
  // US clocks go back Sun 1 Nov 2026: Saturday 31 Oct runs 06:00 MDT to 06:00 MST, 25 hours.
  const y = everyBrowser(() => getPeriodRange('yesterday', null, PROVO, at('2026-11-01T20:00:00Z')));
  assert.equal(y.from, '2026-10-31T12:00:00.000Z');
  assert.equal(y.to, '2026-11-01T12:59:59.999Z');
});

test('This month on the 1st before the day starts is still last month (the old code gave from after to)', () => {
  // 02:00 BST on Thursday 1 Oct: Leeds is still trading Wednesday 30 Sep.
  const now = at('2026-10-01T01:00:00Z');
  const m = everyBrowser(() => getPeriodRange('this-month', null, LEEDS, now));
  assert.equal(m.fromDay, '2026-09-01');
  assert.equal(m.toDay, '2026-09-30');
  assert.ok(Date.parse(m.from) < Date.parse(m.to));
  const lm = everyBrowser(() => getPeriodRange('last-month', null, LEEDS, now));
  assert.equal(lm.fromDay, '2026-08-01');
  assert.equal(lm.toDay, '2026-08-31');
});

test('custom dates are venue business days, whatever the browser (27 Sep matches Yesterday on the 28th)', () => {
  const now = at('2026-09-28T16:00:00Z');
  const c = everyBrowser(() => getPeriodRange('custom', { from: '2026-09-27', to: '2026-09-27' }, LEEDS, now));
  const y = everyBrowser(() => getPeriodRange('yesterday', null, LEEDS, now));
  assert.equal(c.from, y.from);
  assert.equal(c.to, y.to);
  // A missing end falls back to today, as before.
  const open = everyBrowser(() => getPeriodRange('custom', { from: '2026-09-21', to: null }, LEEDS, now));
  assert.equal(open.fromDay, '2026-09-21');
  assert.equal(open.toDay, '2026-09-28');
  // The label shows the dates picked (the old one showed 26/09 in California).
  const label = everyBrowser(() => periodLabel('custom', { from: '2026-09-27', to: '2026-09-28' },
    getPeriodRange('custom', { from: '2026-09-27', to: '2026-09-28' }, LEEDS, now)));
  assert.equal(label, '27/09/2026 → 28/09/2026');
});

test('service periods: today\'s Lunch and Late bar on London\'s wall clock', () => {
  // 14:00 BST (06:00 PDT) Monday 28 Sep.
  const now = at('2026-09-28T13:00:00Z');
  const lunch = everyBrowser(() => getPeriodRange('service:today:lunch', null, LEEDS, now));
  assert.equal(lunch.from, '2026-09-28T10:00:00.000Z');   // 11:00 BST
  assert.equal(lunch.to, '2026-09-28T14:00:59.999Z');     // the 15:00 minute is included, as before
  assert.equal(lunch.kind, 'service');
  assert.equal(lunch.shiftName, 'Lunch');
  assert.equal(lunch.fromDay, '2026-09-28');
  // prev = last Monday's Lunch, up to the same time of day (14:00 BST) as it is still running
  assert.equal(lunch.prevFrom, '2026-09-21T10:00:00.000Z');
  assert.equal(lunch.prevTo, '2026-09-21T13:00:00.000Z');
  assert.equal(lunch.compare.label, "vs last Monday's Lunch by 2pm");
  // The late bar has not started today, so today's instance is last night's, across midnight.
  const late = everyBrowser(() => getPeriodRange('service:today:late', null, LEEDS, now));
  assert.equal(late.from, '2026-09-27T21:00:00.000Z');    // 22:00 BST Sunday
  assert.equal(late.to, '2026-09-28T01:00:59.999Z');      // 02:00 BST Monday
  assert.equal(late.fromDay, '2026-09-27');
  // The pill label reads London's times, not California's 03:00 to 07:00.
  const label = everyBrowser(() => periodLabel('service:today:lunch', null, getPeriodRange('service:today:lunch', null, LEEDS, now)));
  assert.match(label, /^Mon 28 Sept? · 11:00–15:00$/);
  // A service is found by id or by name, and the pills are built from config.shifts.
  assert.equal(everyBrowser(() => getPeriodRange('service:today:Lunch', null, LEEDS, now)).from, lunch.from);
  assert.deepEqual(buildPeriods(LEEDS).slice(0, 2).map((p) => p.id), ['service:today:lunch', 'service:today:late']);
});

test('service periods across the UK clocks going back', () => {
  // 01:30 GMT Sunday 25 Oct (the second 01:30 of the night): Saturday's late bar is on.
  const now = at('2026-10-25T01:30:00Z');
  const late = everyBrowser(() => getPeriodRange('service:today:late', null, LEEDS, now));
  assert.equal(late.from, '2026-10-24T21:00:00.000Z');    // 22:00 BST
  assert.equal(late.to, '2026-10-25T02:00:59.999Z');      // 02:00 GMT: five hours of bar
  assert.equal(late.fromDay, '2026-10-24');
});

test('a service with a broken time falls back to the day, never an Invalid Date', () => {
  const cfg = { ...LEEDS, shifts: [{ id: 'x', name: 'X', start: 'noon', end: '15:00' }] };
  const r = everyBrowser(() => getPeriodRange('service:today:x', null, cfg, at('2026-09-28T13:00:00Z')));
  assert.equal(r.kind, undefined);
  assert.equal(r.from, '2026-09-28T05:30:00.000Z');
});

test('no config: the venue default zone (London) at midnight, never the browser\'s zone', () => {
  const now = at('2026-09-28T16:00:00Z');
  for (const cfg of [undefined, null, {}, { timezone: 'Not/AZone' }]) {
    const r = everyBrowser(() => getPeriodRange('today', null, cfg, now));
    assert.equal(r.from, '2026-09-27T23:00:00.000Z', JSON.stringify(cfg));
    assert.equal(r.to, '2026-09-28T22:59:59.999Z');
    assert.equal(r.timeZone, 'Europe/London');
  }
  // A business day start read from the database as HH:MM:SS works the same as HH:MM.
  const secs = everyBrowser(() => getPeriodRange('today', null, { ...LEEDS, businessDayStart: '06:30:00' }, now));
  assert.equal(secs.from, '2026-09-28T05:30:00.000Z');
});

test('labels are the venue\'s business days: one day reads as one day', () => {
  const now = at('2026-09-28T16:00:00Z');
  // The old label for Today at a 06:30 venue was "28 Sept → 29 Sept", even in London.
  const today = everyBrowser(() => periodLabel('today', null, getPeriodRange('today', null, LEEDS, now)));
  assert.match(today, /^Mon 28 Sept?$/);
  const week = everyBrowser(() => periodLabel('last-7', null, getPeriodRange('last-7', null, LEEDS, now)));
  assert.match(week, /^22 Sept? → 28 Sept?$/);
});

// ── Wiring: the reports that ask the server for DATES use the venue's business days ──

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

test('Daily Trading and Bookings get fromDay/toDay, never the range instants read on the browser clock', () => {
  const bo = read('../BOReports.jsx');
  assert.match(bo, /<DailyTrading fromDay=\{range\.fromDay\} toDay=\{range\.toDay\}/);
  assert.match(bo, /<BookingsReport fromDay=\{range\.fromDay\} toDay=\{range\.toDay\}/);
  const dt = read('./DailyTrading.jsx');
  assert.match(dt, /export default function DailyTrading\(\{ fromDay, toDay, fmt \}\)/);
  assert.doesNotMatch(dt, /toYmd|rangeFrom|rangeTo/);
  const bk = read('./BookingsReport.jsx');
  assert.match(bk, /export default function BookingsReport\(\{ fromDay, toDay,/);
  assert.doesNotMatch(bk, /fmtDayKey\(new Date\(range/);
});

test('the reports hub fetches only once the venue config is in, and again when the range changes', () => {
  const bo = read('../BOReports.jsx');
  assert.match(bo, /if \(!locationConfig\) return;/);
  assert.match(bo, /\}, \[period, customRange\.from, customRange\.to, locationConfig, range\]\);/);
  // builtAt (v5.11.29): the range notes when it was worked out, so its comparison can move on.
  assert.match(bo, /getPeriodRange\(period, customRange, locationConfig, builtAt\)/);
  // The comparison moves with the clock without rebuilding the range (no reload each tick).
  assert.match(bo, /compareRange\(period, range, nowMs\)/);
  assert.match(bo, /\}, \[period, customRange, locationConfig\]\);/);
});

test('Tables Ready insights use the venue zone too', () => {
  const wi = read('../WaitlistInsights.jsx');
  assert.match(wi, /import \{ getLocationConfig \} from '\.\.\/\.\.\/lib\/locationTime';/);
  assert.match(wi, /getPeriodRange\(periodId, custom, \{ timezone: venueTz \}\)/);
  assert.match(wi, /if \(venueTz === undefined\) return;/);
});
