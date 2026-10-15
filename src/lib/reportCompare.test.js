/* global process */
/**
 * reportCompare.test.js — the one percent rule: what every Back Office percent compares to.
 * Run: `npm test`, or `node --test src/lib/reportCompare.test.js`.
 *
 * Peter, 5 Oct 2026: "same day last week, then for the week the week before and the month
 * view the month before."
 *
 * Pinned:
 *   1. Today = the same weekday last week, cut at the same time of day (Monday morning is
 *      no longer set against all of Sunday).
 *   2. This week / This month = the same days of the week / month before, cut the same way
 *      (Sunday night, the 1st of a month, 31 March against February).
 *   3. A finished period = the whole period before it; Yesterday = the same weekday the
 *      week before.
 *   4. The VENUE's clock and business day: 02:00 at a 06:30 venue is still yesterday's
 *      trading, a Pacific venue is cut on Pacific time, and a daylight saving change in
 *      between keeps the same WALL CLOCK time.
 *   5. The chip: no comparison sales at all = no percent ("New"), nothing so far is grey,
 *      never a red minus 100%.
 *   6. The same answer whatever zone the browser is in.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { compareRange, compareChip, clockWords, pctWords, compareMoves, prevTopUp, notLoaded } from './reportCompare.js';
import { getPeriodRange } from '../backoffice/sections/reports/_filters.js';

const LEEDS    = { timezone: 'Europe/London', businessDayStart: '06:30', shifts: [{ id: 'lunch', name: 'Lunch', start: '11:00', end: '15:00' }] };
const STATION  = { timezone: 'Europe/London', businessDayStart: '00:00' };   // Barnsley Train Station
const PACIFIC  = { timezone: 'America/Los_Angeles', businessDayStart: '06:00' };

const BROWSERS = ['America/Los_Angeles', 'Europe/London', 'Asia/Tokyo', 'UTC'];
const at = (iso) => Date.parse(iso);

function inZone(tz, fn) {
  const prev = process.env.TZ;
  process.env.TZ = tz;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env.TZ; else process.env.TZ = prev;
  }
}

// The compare for a period at a venue at an instant, as plain text, and identical from
// every browser zone.
function cmp(periodId, config, nowIso, custom = null) {
  const out = BROWSERS.map((z) => inZone(z, () => {
    const now = at(nowIso);
    const c = compareRange(periodId, getPeriodRange(periodId, custom, config, now), now);
    return c && { ...c, from: c.from.toISOString(), to: c.to.toISOString() };
  }));
  out.forEach((r, i) => assert.deepEqual(r, out[0], `a browser in ${BROWSERS[i]} got a different answer`));
  return out[0];
}

test('Monday morning: Today is last Monday up to the same time, not all of Sunday', () => {
  // Mon 5 Oct 2026, 09:15 in Leeds (BST).
  const now = '2026-10-05T08:15:00Z';
  const today = cmp('today', LEEDS, now);
  assert.equal(today.fromDay, '2026-09-28');
  assert.equal(today.toDay, '2026-09-28');
  assert.equal(today.from, '2026-09-28T05:30:00.000Z');   // 06:30 BST, last Monday's day start
  assert.equal(today.to, '2026-09-28T08:15:00.000Z');     // 09:15 BST last Monday
  assert.equal(today.label, 'vs last Monday by 9:15am');
  assert.equal(today.detail, 'Mon 28 Sep, up to 9:15am');
  assert.equal(today.yet, 'today');
  assert.equal(today.cut, true);

  // This week on a Monday is one day so far: the same Monday, the same cut.
  const week = cmp('this-week', LEEDS, now);
  assert.equal(week.from, today.from);
  assert.equal(week.to, today.to);
  assert.equal(week.label, 'vs same days last week');
  assert.equal(week.yet, 'this week');

  // Yesterday (Sunday, finished) is the Sunday before, the whole business day.
  const yesterday = cmp('yesterday', LEEDS, now);
  assert.equal(yesterday.fromDay, '2026-09-27');
  assert.equal(yesterday.from, '2026-09-27T05:30:00.000Z');
  assert.equal(yesterday.to, '2026-09-28T05:29:59.999Z');
  assert.equal(yesterday.label, 'vs the Sunday before');
  assert.equal(yesterday.yet, null);
  assert.equal(yesterday.cut, false);

  // Last week (finished) is the whole week before it.
  const lastWeek = cmp('last-week', LEEDS, now);
  assert.equal(lastWeek.fromDay, '2026-09-21');
  assert.equal(lastWeek.toDay, '2026-09-27');
  assert.equal(lastWeek.from, '2026-09-21T05:30:00.000Z');
  assert.equal(lastWeek.to, '2026-09-28T05:29:59.999Z');
  assert.equal(lastWeek.label, 'vs the week before');
  assert.equal(lastWeek.detail, 'Mon 21 Sep to Sun 27 Sep');
  assert.equal(lastWeek.cut, false);
});

test('Sunday night: This week is Monday to Sunday of the week before, cut at the same time', () => {
  // Sun 4 Oct 2026, 23:30 in Leeds (BST).
  const now = '2026-10-04T22:30:00Z';
  const week = cmp('this-week', LEEDS, now);
  assert.equal(week.fromDay, '2026-09-21');
  assert.equal(week.toDay, '2026-09-27');
  assert.equal(week.from, '2026-09-21T05:30:00.000Z');
  assert.equal(week.to, '2026-09-27T22:30:00.000Z');      // 23:30 BST on the Sunday before
  assert.equal(week.label, 'vs same days last week');
  assert.equal(week.detail, 'Mon 21 Sep to Sun 27 Sep, up to 11:30pm');
  assert.equal(cmp('today', LEEDS, now).label, 'vs last Sunday by 11:30pm');
});

test('the 1st of a month: This month is the 1st of the month before, cut at the same time', () => {
  // Thu 1 Oct 2026, 12:00 in Leeds (BST).
  const now = '2026-10-01T11:00:00Z';
  const month = cmp('this-month', LEEDS, now);
  assert.equal(month.fromDay, '2026-09-01');
  assert.equal(month.toDay, '2026-09-01');
  assert.equal(month.from, '2026-09-01T05:30:00.000Z');
  assert.equal(month.to, '2026-09-01T11:00:00.000Z');
  assert.equal(month.label, 'vs same days last month');
  assert.equal(month.yet, 'this month');

  // Last month (September, finished) is the whole of August: the calendar month before.
  const last = cmp('last-month', LEEDS, now);
  assert.equal(last.fromDay, '2026-08-01');
  assert.equal(last.toDay, '2026-08-31');
  assert.equal(last.to, '2026-09-01T05:29:59.999Z');
  assert.equal(last.label, 'vs the month before');
  assert.equal(last.cut, false);

  // January looks back across the year end.
  const jan = cmp('this-month', LEEDS, '2027-01-15T12:00:00Z');
  assert.equal(jan.fromDay, '2026-12-01');
  assert.equal(jan.toDay, '2026-12-15');
  assert.equal(jan.to, '2026-12-15T12:00:00.000Z');
});

test('31 March against February: the shorter month stops on its last day, whole', () => {
  // Tue 31 Mar 2026, 10:00 in Leeds (BST since the 29th).
  const month = cmp('this-month', LEEDS, '2026-03-31T09:00:00Z');
  assert.equal(month.fromDay, '2026-02-01');
  assert.equal(month.toDay, '2026-02-28');
  assert.equal(month.from, '2026-02-01T06:30:00.000Z');   // 06:30 GMT
  assert.equal(month.to, '2026-03-01T06:29:59.999Z');     // all of 28 Feb, no cut
  assert.equal(month.cut, false);
  assert.equal(month.label, 'vs same days last month');
  // 29 and 30 March have no February day either: still all of February.
  assert.equal(cmp('this-month', LEEDS, '2026-03-30T09:00:00Z').to, '2026-03-01T06:29:59.999Z');
  // 28 March does: 1 to 28 February, cut at the same time of day (10:00 GMT).
  const d28 = cmp('this-month', LEEDS, '2026-03-28T10:00:00Z');
  assert.equal(d28.toDay, '2026-02-28');
  assert.equal(d28.to, '2026-02-28T10:00:00.000Z');
  assert.equal(d28.cut, true);
  // A leap year February has a 29th.
  assert.equal(cmp('this-month', LEEDS, '2028-03-31T09:00:00Z').toDay, '2028-02-29');
});

test('a 06:30 venue at 02:00 in the morning is still on yesterday\'s business day', () => {
  // 02:00 BST on the calendar Tuesday 6 Oct 2026 is Monday's trading in Leeds.
  const now = '2026-10-06T01:00:00Z';
  const today = cmp('today', LEEDS, now);
  assert.equal(today.fromDay, '2026-09-28');              // last MONDAY, not last Tuesday
  assert.equal(today.from, '2026-09-28T05:30:00.000Z');
  assert.equal(today.to, '2026-09-29T01:00:00.000Z');     // 02:00 BST the next calendar morning
  assert.equal(today.label, 'vs last Monday by 2am');
  // The week is Monday only so far, with the same cut.
  const week = cmp('this-week', LEEDS, now);
  assert.equal(week.fromDay, '2026-09-28');
  assert.equal(week.toDay, '2026-09-28');
  assert.equal(week.to, '2026-09-29T01:00:00.000Z');
  // A venue whose day starts at midnight is already on Tuesday at that instant.
  const station = cmp('today', STATION, now);
  assert.equal(station.fromDay, '2026-09-29');
  assert.equal(station.from, '2026-09-28T23:00:00.000Z');
  assert.equal(station.to, '2026-09-29T01:00:00.000Z');
  assert.equal(station.label, 'vs last Tuesday by 2am');
});

test('a US venue on Pacific time is cut on its own clock', () => {
  // Mon 5 Oct 2026, 14:00 in Los Angeles (PDT) = 22:00 in Leeds.
  const now = '2026-10-05T21:00:00Z';
  const us = cmp('today', PACIFIC, now);
  assert.equal(us.fromDay, '2026-09-28');
  assert.equal(us.from, '2026-09-28T13:00:00.000Z');      // 06:00 PDT
  assert.equal(us.to, '2026-09-28T21:00:00.000Z');        // 14:00 PDT
  assert.equal(us.label, 'vs last Monday by 2pm');
  // The same instant read for Leeds says 10pm: each venue on its own clock.
  assert.equal(cmp('today', LEEDS, now).label, 'vs last Monday by 10pm');
  // 22:00 PDT Sunday is already Monday in London; the Pacific venue is still on Sunday.
  const late = cmp('today', PACIFIC, '2026-10-05T05:00:00Z');
  assert.equal(late.fromDay, '2026-09-27');
  assert.equal(late.label, 'vs last Sunday by 10pm');
});

test('daylight saving change weeks: the cut is the same WALL CLOCK time', () => {
  // UK clocks went back Sun 25 Oct 2026. Mon 26 Oct 14:00 GMT is set against Mon 19 Oct
  // up to 14:00 BST (13:00Z), not 14:00Z.
  const uk = cmp('today', LEEDS, '2026-10-26T14:00:00Z');
  assert.equal(uk.from, '2026-10-19T05:30:00.000Z');
  assert.equal(uk.to, '2026-10-19T13:00:00.000Z');
  assert.equal(uk.label, 'vs last Monday by 2pm');
  // Wed that week: Mon to Wed of the BST week before, cut at 14:00 BST on its Wednesday.
  const week = cmp('this-week', LEEDS, '2026-10-28T14:00:00Z');
  assert.equal(week.from, '2026-10-19T05:30:00.000Z');
  assert.equal(week.to, '2026-10-21T13:00:00.000Z');
  // Last week (26 Oct to 1 Nov) against the week holding the change: 7 days and 1 hour.
  const lastWeek = cmp('last-week', LEEDS, '2026-11-02T12:00:00Z');
  assert.equal(lastWeek.from, '2026-10-19T05:30:00.000Z');
  assert.equal(lastWeek.to, '2026-10-26T06:29:59.999Z');
  assert.equal(Date.parse(lastWeek.to) + 1 - Date.parse(lastWeek.from), (7 * 24 + 1) * 3600000);

  // UK clocks went forward Sun 29 Mar 2026. Mon 30 Mar 09:00 BST against Mon 23 Mar 09:00 GMT.
  const spring = cmp('today', LEEDS, '2026-03-30T08:00:00Z');
  assert.equal(spring.from, '2026-03-23T06:30:00.000Z');
  assert.equal(spring.to, '2026-03-23T09:00:00.000Z');
  // 01:30 a week after the change does not exist on the change night: it lands just
  // after the gap (02:30 BST = 01:30Z, the accounting layer's rule for a skipped time).
  const gap = cmp('today', STATION, '2026-04-05T00:30:00Z');
  assert.equal(gap.from, '2026-03-29T00:00:00.000Z');
  assert.equal(gap.to, '2026-03-29T01:30:00.000Z');

  // US clocks went back Sun 1 Nov 2026. Mon 2 Nov 14:00 PST against Mon 26 Oct 14:00 PDT.
  const us = cmp('today', PACIFIC, '2026-11-02T22:00:00Z');
  assert.equal(us.from, '2026-10-26T13:00:00.000Z');
  assert.equal(us.to, '2026-10-26T21:00:00.000Z');
  // And forward Sun 8 Mar 2026: Mon 9 Mar 14:00 PDT against Mon 2 Mar 14:00 PST.
  assert.equal(cmp('today', PACIFIC, '2026-03-09T21:00:00Z').to, '2026-03-02T22:00:00.000Z');
});

test('rolling and custom ranges: the same number of days before', () => {
  const now = '2026-10-05T08:15:00Z';   // Mon 5 Oct, 09:15 BST
  const seven = cmp('last-7', LEEDS, now);
  assert.equal(seven.fromDay, '2026-09-22');
  assert.equal(seven.toDay, '2026-09-28');
  assert.equal(seven.to, '2026-09-28T08:15:00.000Z');     // ends today, so cut at 09:15
  assert.equal(seven.label, 'vs the 7 days before');
  assert.equal(seven.yet, 'so far');
  const thirty = cmp('last-30', LEEDS, now);
  assert.equal(thirty.fromDay, '2026-08-07');
  assert.equal(thirty.toDay, '2026-09-05');
  assert.equal(thirty.label, 'vs the 30 days before');

  // A finished custom range: the whole range before it.
  const three = cmp('custom', LEEDS, now, { from: '2026-09-29', to: '2026-10-01' });
  assert.equal(three.fromDay, '2026-09-26');
  assert.equal(three.toDay, '2026-09-28');
  assert.equal(three.to, '2026-09-29T05:29:59.999Z');
  assert.equal(three.label, 'vs the 3 days before');
  assert.equal(three.yet, null);
  // A custom Monday to Sunday is a week.
  assert.equal(cmp('custom', LEEDS, now, { from: '2026-09-21', to: '2026-09-27' }).label, 'vs the week before');
  // One custom day is treated like Yesterday: the same weekday the week before.
  const one = cmp('custom', LEEDS, now, { from: '2026-10-02', to: '2026-10-02' });
  assert.equal(one.fromDay, '2026-09-25');
  assert.equal(one.label, 'vs the Friday before');
  assert.equal(one.cut, false);
  // A custom range ending today is cut like any period still trading.
  const live = cmp('custom', LEEDS, now, { from: '2026-10-03', to: '2026-10-05' });
  assert.equal(live.fromDay, '2026-09-30');
  assert.equal(live.to, '2026-10-02T08:15:00.000Z');
  assert.equal(live.yet, 'so far');
});

test('a service: the same service last week, cut only while it is running', () => {
  // 14:00 BST Mon 5 Oct: Lunch (11:00 to 15:00) is running.
  const running = cmp('service:today:lunch', LEEDS, '2026-10-05T13:00:00Z');
  assert.equal(running.from, '2026-09-28T10:00:00.000Z');
  assert.equal(running.to, '2026-09-28T13:00:00.000Z');
  assert.equal(running.label, "vs last Monday's Lunch by 2pm");
  assert.equal(running.yet, 'today');
  // 17:00 BST: Lunch is over, so all of last Monday's Lunch.
  const over = cmp('service:today:lunch', LEEDS, '2026-10-05T16:00:00Z');
  assert.equal(over.to, '2026-09-28T14:00:59.999Z');
  assert.equal(over.label, "vs last Monday's Lunch");
  assert.equal(over.yet, null);
});

test('no usable range gives no compare, and getPeriodRange still hands back a window', () => {
  assert.equal(compareRange('today', null), null);
  assert.equal(compareRange('custom', { fromDay: '2026-10-05', toDay: '2026-10-01', timeZone: 'Europe/London' }), null);
  const backwards = getPeriodRange('custom', { from: '2026-10-05', to: '2026-10-01' }, LEEDS, at('2026-10-05T08:15:00Z'));
  assert.equal(backwards.compare, null);
  assert.ok(backwards.prevFrom instanceof Date && backwards.prevTo instanceof Date);
  // No timezone on the config = Europe/London, never the browser's zone.
  const c = inZone('Asia/Tokyo', () => compareRange('today',
    getPeriodRange('today', null, { businessDayStart: '06:30' }, at('2026-10-05T08:15:00Z')), at('2026-10-05T08:15:00Z')));
  assert.equal(c.to.toISOString(), '2026-09-28T08:15:00.000Z');
});

test('the chip: no comparison sales at all = no percent', () => {
  const today = cmp('today', LEEDS, '2026-10-05T13:00:00Z');
  // Sales on both sides: a percent, and the words.
  const up = compareChip(102, 100, today);
  assert.equal(up.kind, 'pct');
  assert.equal(up.text, '+2.0%');
  assert.equal(up.words, 'vs last Monday by 2pm');
  assert.equal(up.title, 'Compared to Mon 28 Sep, up to 2pm');
  assert.equal(compareChip(50, 100, today).text, '-50.0%');
  assert.equal(compareChip(100, 100, today).text, '0.0%');

  // Sales now, none to compare with: "New", never a percent (Huddersfield's +22,000%).
  for (const none of [0, null, undefined, NaN, -5, '']) {
    const fresh = compareChip(881, none, today);
    assert.equal(fresh.kind, 'new', String(none));
    assert.equal(fresh.text, 'New');
    assert.equal(fresh.pct, null);
    assert.equal(fresh.title, 'Nothing last Monday by 2pm to compare with (Mon 28 Sep, up to 2pm)');
  }

  // Nothing yet, but there was last time: grey words, never a red minus 100%.
  const quiet = compareChip(0, 400, today);
  assert.equal(quiet.kind, 'quiet');
  assert.equal(quiet.pct, null);
  assert.equal(quiet.text, 'No sales yet today');
  assert.equal(quiet.words, 'vs last Monday by 2pm');
  assert.equal(compareChip(0, 400, cmp('this-week', LEEDS, '2026-10-05T13:00:00Z')).text, 'No sales yet this week');
  assert.equal(compareChip(0, 400, cmp('this-month', LEEDS, '2026-10-05T13:00:00Z')).text, 'No sales yet this month');
  assert.equal(compareChip(0, 400, cmp('last-7', LEEDS, '2026-10-05T13:00:00Z')).text, 'No sales so far');
  assert.equal(compareChip(0, 400, cmp('yesterday', LEEDS, '2026-10-05T13:00:00Z')).text, 'No sales in this period');
  assert.equal(compareChip(0, 12, today, 'tips').text, 'No tips yet today');

  // Nothing on either side.
  const empty = compareChip(0, 0, today, 'covers');
  assert.equal(empty.kind, 'quiet');
  assert.equal(empty.text, 'No covers in either period');

  // Without a compare (a caller that has none) the rule still holds, just without words.
  assert.deepEqual(compareChip(110, 100, null), { kind: 'pct', pct: 10, text: '+10.0%', words: '', title: '' });
  assert.equal(compareChip(5, 0, null).text, 'New');
});

test('the words: clock times and percents', () => {
  assert.equal(clockWords(0), '12am');
  assert.equal(clockWords(5), '12:05am');
  assert.equal(clockWords(9 * 60 + 15), '9:15am');
  assert.equal(clockWords(12 * 60), '12pm');
  assert.equal(clockWords(14 * 60), '2pm');
  assert.equal(clockWords(23 * 60 + 59), '11:59pm');
  assert.equal(pctWords(2), '+2.0%');
  assert.equal(pctWords(-12.54), '-12.5%');
  assert.equal(pctWords(0), '0.0%');
  assert.equal(pctWords(0.04), '0.0%');
  assert.equal(pctWords(-0.04), '0.0%');
  assert.equal(pctWords(22000), '+22000.0%');
});

// ── Review fixes, 5 Oct 2026 ─────────────────────────────────────────────────────────

test('an open report: the comparison moves with the clock, it is not frozen at opening time', () => {
  // Leeds, Mon 5 Oct. Opened at 09:00 BST, still open at 14:00 BST.
  const nine = at('2026-10-05T08:00:00Z'), two = at('2026-10-05T13:00:00Z');
  const opened = getPeriodRange('today', null, LEEDS, nine);
  const later  = getPeriodRange('today', null, LEEDS, two);
  assert.equal(opened.compare.to.toISOString(), '2026-09-28T08:00:00.000Z');
  assert.equal(later.compare.to.toISOString(),  '2026-09-28T13:00:00.000Z');
  assert.equal(opened.compare.label, 'vs last Monday by 9am');
  assert.equal(later.compare.label,  'vs last Monday by 2pm');
  // What Back Office does: the range built at 09:00 is kept, and its comparison is rebuilt
  // for the time it is now. That must be the same answer as a report opened at 14:00.
  assert.deepEqual(compareRange('today', opened, two), later.compare);
  for (const id of ['this-week', 'this-month', 'last-7', 'last-30', 'service:today:lunch']) {
    const a = getPeriodRange(id, null, LEEDS, at('2026-10-05T10:30:00Z'));   // 11:30, Lunch running
    const b = getPeriodRange(id, null, LEEDS, two);
    assert.deepEqual(compareRange(id, a, two), b.compare, id);
    assert.notEqual(a.compare.to.getTime(), b.compare.to.getTime(), id);
  }
  // Left open past the end of the business day: the day on screen is finished, so it is
  // set against the whole of last Monday and the words stop saying "by".
  const nextDay = compareRange('today', opened, at('2026-10-06T08:00:00Z'));
  assert.equal(nextDay.to.toISOString(), '2026-09-29T05:29:59.999Z');
  assert.equal(nextDay.label, 'vs the Monday before');
  assert.equal(nextDay.yet, null);

  // Which comparisons move, and what has to be fetched when one does.
  assert.equal(compareMoves(opened.compare), true);
  assert.equal(compareMoves(getPeriodRange('yesterday', null, LEEDS, nine).compare), false);
  assert.equal(compareMoves(getPeriodRange('last-month', null, LEEDS, nine).compare), false);
  assert.equal(compareMoves(null), false);
  const held = { from: opened.compare.from.getTime(), to: opened.compare.to.getTime() };
  assert.equal(prevTopUp(held, opened.compare), null);                       // nothing new
  assert.deepEqual(prevTopUp(held, later.compare),                           // only the extra hours
    { from: held.to + 1, to: later.compare.to.getTime(), append: true });
  assert.deepEqual(prevTopUp(null, later.compare),                           // nothing held: all of it
    { from: later.compare.from.getTime(), to: later.compare.to.getTime(), append: false });
  const other = getPeriodRange('this-week', null, LEEDS, two).compare;       // a different window: all of it
  assert.equal(prevTopUp(held, { ...other, from: new Date(other.from.getTime() - 86400000) }).append, false);
  assert.equal(prevTopUp(held, null), null);
});

test('a comparison that did not load is never "New"', () => {
  const today = cmp('today', LEEDS, '2026-10-05T13:00:00Z');
  const lost = notLoaded(today);
  for (const [cur, prev] of [[371.23, 0], [371.23, undefined], [0, 0], [371.23, 316.34]]) {
    const chip = compareChip(cur, prev, lost);
    assert.equal(chip.kind, 'unknown');
    assert.equal(chip.pct, null);
    assert.equal(chip.text, 'Comparison did not load');
    assert.equal(chip.short, 'Not loaded');
  }
  // The days are kept (the trend chart's axis still needs them), and a loaded one is untouched.
  assert.equal(lost.fromDay, today.fromDay);
  assert.equal(compareChip(371.23, 0, today).kind, 'new');
  assert.equal(compareChip(1, 0, notLoaded(null)).kind, 'unknown');
});

test('a service seen before it starts is yesterday\'s, and the words name the right day', () => {
  // Tue 6 Oct 09:00 BST: Lunch has not started, so the Lunch on screen is Monday's.
  const c = cmp('service:today:lunch', LEEDS, '2026-10-06T08:00:00Z');
  assert.equal(c.fromDay, '2026-09-28');
  assert.equal(c.from, '2026-09-28T10:00:00.000Z');
  assert.equal(c.to, '2026-09-28T14:00:59.999Z');
  assert.equal(c.label, 'vs Lunch the Monday before');   // not "last Monday", which is the day on screen
  assert.equal(c.cut, false);
  assert.equal(c.yet, null);
});

test('a custom range that runs past today counts only its days so far', () => {
  const now = '2026-10-05T08:15:00Z';   // Mon 5 Oct, 09:15 BST
  // 1 to 8 Oct seen on the 5th = 1 to 5 Oct: the 5 days before, cut at 09:15.
  const past = cmp('custom', LEEDS, now, { from: '2026-10-01', to: '2026-10-08' });
  assert.deepEqual(past, cmp('custom', LEEDS, now, { from: '2026-10-01', to: '2026-10-05' }));
  assert.equal(past.fromDay, '2026-09-26');
  assert.equal(past.toDay, '2026-09-30');
  assert.equal(past.to, '2026-09-30T08:15:00.000Z');
  assert.equal(past.label, 'vs the 5 days before');
  assert.equal(past.cut, true);
  assert.equal(past.yet, 'so far');
  // Today to Friday is just today so far: last Monday by 9:15am.
  const fromToday = cmp('custom', LEEDS, now, { from: '2026-10-05', to: '2026-10-09' });
  assert.equal(fromToday.label, 'vs last Monday by 9:15am');
  assert.equal(fromToday.to, '2026-09-28T08:15:00.000Z');
  // Wholly in the future: nothing has traded, and it must not read as a finished period.
  const future = cmp('custom', LEEDS, now, { from: '2026-10-07', to: '2026-10-09' });
  assert.equal(future.cut, false);
  assert.equal(future.yet, 'so far');
  assert.equal(compareChip(0, 500, future).text, 'No sales so far');
});
