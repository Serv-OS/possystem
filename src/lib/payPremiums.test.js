// src/lib/payPremiums.test.js
//
// v5.11.101: pay premiums (_shared/payPremiums.js), saved since the Workforce build and never applied
// until now, the US overtime split, and the public holiday calendars.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { premiumFor, plannedPremium, cleanPremiums, anyPremium, overtimeSplit } from '../../supabase/functions/_shared/payPremiums.js';
import { ukBankHolidays, usFederalHolidays, isPublicHoliday } from '../../supabase/functions/_shared/publicHolidays.js';

const iso = (s) => new Date(s).toISOString();

test('no premiums set (every venue today): nothing, whatever the shift', () => {
  for (const p of [{}, null, undefined, { weekend: 0, night: '' }, { weekend: -5 }, { weekend: 'abc' }]) {
    assert.equal(anyPremium(p), false);
    const r = premiumFor({ startMs: iso('2026-10-24T20:00:00Z'), endMs: iso('2026-10-25T04:00:00Z'), rate: 12, premiums: p, tz: 'Europe/London' });
    assert.deepEqual(r, { hours: 0, pay: 0, byKind: { weekend: 0, bankHoliday: 0, night: 0 } });
  }
});

test('weekend: 10% on Saturday hours only (a Friday night shift running into Saturday)', () => {
  // Fri 23 Oct 2026 20:00 to Sat 02:00 London (BST, UTC+1): 2 Saturday hours.
  const r = premiumFor({ startMs: iso('2026-10-23T19:00:00Z'), endMs: iso('2026-10-24T01:00:00Z'), rate: 12, premiums: { weekend: 10 }, tz: 'Europe/London' });
  assert.equal(r.hours, 2);
  assert.equal(r.pay, 2.4);   // 2h x 12 x 10%
  assert.equal(r.byKind.weekend, 2);
});

test('night window wraps midnight; the higher premium wins, never both', () => {
  // Sat 24 Oct 2026 22:00 to Sun 25 Oct 02:00 London. Weekend 10%, night 25% from 23:00 to 06:00.
  // 22:00-23:00 weekend only (10%), 23:00-02:00 night beats weekend (25%).
  // The UK clocks go back at 02:00 BST on 25 Oct 2026: 01:00 to 02:00 happens twice. 22:00 BST = 21:00Z.
  const r = premiumFor({ startMs: iso('2026-10-24T21:00:00Z'), endMs: iso('2026-10-25T02:00:00Z'), rate: 10, premiums: { weekend: 10, night: 25, nightFrom: '23:00', nightTo: '06:00' }, tz: 'Europe/London' });
  // 21:00Z-22:00Z = 22-23 BST weekend; 22:00Z-02:00Z = 23:00 BST to 02:00 GMT = 4 real hours of night.
  assert.equal(r.byKind.weekend, 1);
  assert.equal(r.byKind.night, 4);
  assert.equal(r.hours, 5);
  assert.equal(r.pay, 11);     // 10 x (1 x 10% + 4 x 25%) = 1 + 10
});

test('unpaid break scales the premium; premium hours never exceed paid hours', () => {
  const r = premiumFor({ startMs: iso('2026-10-24T10:00:00Z'), endMs: iso('2026-10-24T18:00:00Z'), workedHours: 7.5, rate: 12, premiums: { weekend: 20 }, tz: 'UTC' });
  assert.equal(r.hours, 7.5);
  assert.equal(r.pay, 18);     // 7.5 x 12 x 20%
});

test('not eligible or salaried: no premium', () => {
  const a = { startMs: iso('2026-10-24T10:00:00Z'), endMs: iso('2026-10-24T18:00:00Z'), rate: 12, premiums: { weekend: 20 }, tz: 'UTC' };
  assert.equal(premiumFor({ ...a, eligible: false }).pay, 0);
  assert.equal(premiumFor({ ...a, hourly: false }).pay, 0);
  assert.equal(premiumFor({ ...a, rate: 0 }).pay, 0);
});

test('bank holiday by the venue country: UK 25 Dec, US 4 Jul and Thanksgiving', () => {
  const uk = premiumFor({ startMs: iso('2026-12-25T10:00:00Z'), endMs: iso('2026-12-25T14:00:00Z'), rate: 10, premiums: { bankHoliday: 50 }, tz: 'Europe/London', country: 'UK' });
  assert.equal(uk.byKind.bankHoliday, 4);
  assert.equal(uk.pay, 20);
  const usOnUkCal = premiumFor({ startMs: iso('2026-11-26T15:00:00Z'), endMs: iso('2026-11-26T19:00:00Z'), rate: 10, premiums: { bankHoliday: 50 }, tz: 'America/New_York', country: 'UK' });
  assert.equal(usOnUkCal.pay, 0);
  const us = premiumFor({ startMs: iso('2026-11-26T15:00:00Z'), endMs: iso('2026-11-26T19:00:00Z'), rate: 10, premiums: { bankHoliday: 50 }, tz: 'America/New_York', country: 'US' });
  assert.equal(us.pay, 20);
  assert.ok(isPublicHoliday('US', '2026-07-03'));   // 4 Jul 2026 is a Saturday: kept on Friday 3 Jul
  assert.ok(!isPublicHoliday('US', '2026-07-04'));
  assert.ok(usFederalHolidays(2026).has('2026-11-26'));
  assert.equal(usFederalHolidays(2026).size, 11);
});

test('the England and Wales calendar is unchanged (it moved out of wfWeek)', () => {
  assert.deepEqual([...ukBankHolidays(2026)].sort(), ['2026-01-01', '2026-04-03', '2026-04-06', '2026-05-04', '2026-05-25', '2026-08-31', '2026-12-25', '2026-12-28']);
  assert.ok(ukBankHolidays(2027).has('2027-12-27') && ukBankHolidays(2027).has('2027-12-28'));
});

test('planned premium for the rota: wall clock times, overnight finish', () => {
  const r = plannedPremium({ date: '2026-10-24', start: '20:00', finish: '02:00', breakMins: 0 }, 10, { night: 20, nightFrom: '23:00', nightTo: '06:00' });
  assert.equal(r.hours, 3);
  assert.equal(r.pay, 6);
  assert.equal(plannedPremium({ date: '2026-10-24', start: '20:00', finish: '02:00' }, 10, {}).pay, 0);
});

test('cleanPremiums: caps silly numbers, defaults the night window', () => {
  assert.deepEqual(cleanPremiums({ weekend: 9999, night: 10, nightFrom: '25:00' }), { weekend: 500, bankHoliday: 0, night: 10, nightFrom: 1380, nightTo: 360 });
});

test('US overtime: hours over 40 in a Monday to Sunday week, per person', () => {
  const sheets = [];
  // Week of Mon 19 Oct: 5 x 9h = 45h. Week of Mon 26 Oct: 2 x 8h = 16h.
  for (const d of ['19', '20', '21', '22', '23']) sheets.push({ staff_id: 'a', actual_hours: 9, clock_in: `2026-10-${d}T13:00:00Z` });
  sheets.push({ staff_id: 'a', actual_hours: 8, clock_in: '2026-10-26T13:00:00Z' }, { staff_id: 'a', actual_hours: 8, clock_in: '2026-10-27T13:00:00Z' });
  sheets.push({ staff_id: 'b', actual_hours: 30, clock_in: '2026-10-21T13:00:00Z' });
  const r = overtimeSplit(sheets, 40, 'America/Los_Angeles');
  assert.deepEqual(r.a, { regular: 56, overtime: 5 });
  assert.deepEqual(r.b, { regular: 30, overtime: 0 });
  // A Sunday night clock in belongs to its own (venue) day: Sun 25 Oct 23:00 LA is Mon 26 Oct UTC.
  const s2 = overtimeSplit([{ staff_id: 'c', actual_hours: 41, clock_in: '2026-10-26T06:00:00Z' }, { staff_id: 'c', actual_hours: 1, clock_in: '2026-10-27T15:00:00Z' }], 40, 'America/Los_Angeles');
  assert.deepEqual(s2.c, { regular: 41, overtime: 1 });
  // No weekly rule (the UK): everything regular.
  assert.deepEqual(overtimeSplit(sheets, null).a, { regular: 61, overtime: 0 });
});
