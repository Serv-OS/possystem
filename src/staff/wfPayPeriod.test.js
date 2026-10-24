/**
 * wfPayPeriod.test.js — pay period + pay date resolution, including the
 * England & Wales working-day shift. Run: `npm test` (Node's built-in runner).
 *
 * The regression these lock down: until v5.5.989 the monthly pay date was
 * resolved in the month the period STARTS. That is indistinguishable from
 * correct for a 1st–31st period (start month == end month) and wrong for every
 * late-start period — a 23 Jul–22 Aug period asking for "the last day" got
 * 31 JULY, nine days before the period closed. The "no regression" block below
 * is the reason the fix has to be end-month rather than "always after the end".
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { payPeriod, prevWorkingDay, ymd } from './wfWeek.js';

const monthly = (startDay, extra = {}) => ({ payPeriodType: 'monthly', payPeriodStartDay: startDay, ...extra });

test('late-start period pays in the month it ENDS, not the month it starts', () => {
  const p = payPeriod(monthly(23, { payDay: 0 }), new Date(2026, 7, 1));
  assert.equal(p.startIso, '2026-07-23');
  assert.equal(p.endIso, '2026-08-22');
  assert.equal(p.payDateIso, '2026-08-31');            // was 2026-07-31
});

test('late-start period, fixed day-of-month', () => {
  const p = payPeriod(monthly(23, { payDay: 28 }), new Date(2026, 7, 1));
  assert.equal(p.payDateIso, '2026-08-28');            // was 2026-07-28
});

test('no regression: the classic 1st–31st paid on the 28th is unchanged', () => {
  const p = payPeriod(monthly(1, { payDay: 28 }), new Date(2026, 6, 15));
  assert.equal(p.startIso, '2026-07-01');
  assert.equal(p.endIso, '2026-07-31');
  assert.equal(p.payDateIso, '2026-07-28');            // mid-period on purpose — a real UK pattern
  assert.equal(payPeriod(monthly(1, { payDay: 0 }), new Date(2026, 6, 15)).payDateIso, '2026-07-31');
});

test('pay date never lands before the period opens', () => {
  // Start day 28, pay on the 15th: the 15th of the end month is inside the
  // period, but it must never precede the start.
  const p = payPeriod(monthly(28, { payDay: 15 }), new Date(2026, 7, 1));
  assert.equal(p.startIso, '2026-07-28');
  assert.ok(p.payDateIso >= p.startIso);
});

test('whole-month offset pushes the pay run on, across a year boundary', () => {
  assert.equal(payPeriod(monthly(23, { payDay: 0 }), new Date(2026, 11, 1)).payDateIso, '2026-12-31');
  assert.equal(payPeriod(monthly(23, { payDay: 0, payDayMonthOffset: 1 }), new Date(2026, 11, 1)).payDateIso, '2027-01-31');
});

test('short months resolve to their own last day', () => {
  assert.equal(payPeriod(monthly(23, { payDay: 0 }), new Date(2027, 1, 1)).payDateIso, '2027-02-28');
});

test('last WORKING day skips weekends', () => {
  // 31 Jan 2027 is a Sunday
  const p = payPeriod(monthly(1, { payDay: 0, payDayShift: 'prevWorkingDay' }), new Date(2027, 0, 15));
  assert.equal(p.payDateIso, '2027-01-29');            // Friday
});

test('last WORKING day skips bank holidays too', () => {
  // 31 May 2026 is a Sunday and Mon 25 May is the spring bank holiday
  const p = payPeriod(monthly(1, { payDay: 0, payDayShift: 'prevWorkingDay' }), new Date(2026, 4, 15));
  assert.equal(p.payDateIso, '2026-05-29');            // Friday
});

test('prevWorkingDay: England & Wales bank holidays', () => {
  assert.equal(ymd(prevWorkingDay(new Date(2026, 11, 25))), '2026-12-24'); // Christmas Day (Fri)
  assert.equal(ymd(prevWorkingDay(new Date(2026, 11, 28))), '2026-12-24'); // Boxing Day substitute (Mon)
  assert.equal(ymd(prevWorkingDay(new Date(2026, 3, 3))), '2026-04-02');   // Good Friday
  assert.equal(ymd(prevWorkingDay(new Date(2026, 3, 6))), '2026-04-02');   // Easter Monday
  assert.equal(ymd(prevWorkingDay(new Date(2026, 0, 1))), '2025-12-31');   // New Year's Day
});

test('prevWorkingDay leaves an ordinary weekday alone', () => {
  assert.equal(ymd(prevWorkingDay(new Date(2026, 7, 12))), '2026-08-12');  // a Wednesday
});

test('fixed-length periods honour the working-day shift', () => {
  const p = payPeriod(
    { payPeriodType: 'fortnightly', payPeriodAnchor: '2026-06-12', payDay: 3, payDayShift: 'prevWorkingDay' },
    new Date(2026, 5, 20),
  );
  assert.equal(p.startIso, '2026-06-12');
  assert.equal(p.endIso, '2026-06-25');
  assert.equal(p.payDateIso, '2026-06-26');            // +3d = Sun 28 → Fri 26
});

// v5.11.101: semi-monthly (US): the 1st to the 15th, the 16th to the last day of the month.
test('semi-monthly: halves of the month, stepping both ways across months and years', async () => {
  const { payPeriod: pp, shiftPayPeriod: sp } = await import('./wfWeek.js');
  const cfg = { payPeriodType: 'semimonthly', payDay: 5 };
  let p = pp(cfg, new Date(2026, 1, 10));
  assert.equal(p.startIso, '2026-02-01'); assert.equal(p.endIso, '2026-02-15'); assert.equal(p.payDateIso, '2026-02-20');
  p = pp(cfg, new Date(2026, 1, 16));
  assert.equal(p.startIso, '2026-02-16'); assert.equal(p.endIso, '2026-02-28');
  p = pp(cfg, new Date(2028, 1, 29));
  assert.equal(p.endIso, '2028-02-29');
  assert.equal(sp(cfg, '2026-02-16', 1).startIso, '2026-03-01');
  assert.equal(sp(cfg, '2026-03-01', -1).startIso, '2026-02-16');
  assert.equal(sp(cfg, '2026-01-01', -1).startIso, '2025-12-16');
  assert.equal(sp(cfg, '2025-12-16', 1).startIso, '2026-01-01');
  assert.equal(sp(cfg, '2026-01-01', 4).startIso, '2026-03-01');
  // Pay on the working day before when it lands on a weekend: 15 Aug 2026 + 0 days is a Saturday.
  assert.equal(pp({ payPeriodType: 'semimonthly', payDay: 0, payDayShift: 'prevWorkingDay' }, new Date(2026, 7, 3)).payDateIso, '2026-08-14');
});
