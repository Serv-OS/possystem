/**
 * leaveDays.test.js — the annual-leave vs normal-day-off split proposal.
 * Run: `npm test`.
 *
 * The scenario that motivated it (Peter, 10 Aug): a full-time Mon–Fri person
 * requests 7 days — that is 5 days of annual leave and 2 ordinary days off,
 * and only the 5 should deduct from the holiday balance.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { eachDay, proposeLeaveDays, workedWeekdayShare } from './leaveDays.js';

// 2026-08-03 is a Monday; 03..09 is Mon→Sun.
const MON = '2026-08-03', SUN = '2026-08-09';

test('eachDay expands an inclusive range and caps at 62', () => {
  assert.deepEqual(eachDay(MON, '2026-08-05'), ['2026-08-03', '2026-08-04', '2026-08-05']);
  assert.equal(eachDay('2026-01-01', '2026-12-31').length, 62);
});

test('THE SCENARIO: full-time, 7 days requested = 5 annual leave + 2 days off', () => {
  const days = proposeLeaveDays({ from: MON, to: SUN, staffId: 'w', contractType: 'fullTime' });
  assert.equal(days.length, 7);
  assert.equal(days.filter(d => d.leave).length, 5);
  assert.equal(days[5].leave, false);   // Saturday
  assert.equal(days[6].leave, false);   // Sunday
  assert.ok(days.every(d => d.reason === 'contract'));
});

test('a rostered shift makes that day annual leave, even a weekend', () => {
  const days = proposeLeaveDays({
    from: MON, to: SUN, staffId: 'w', contractType: 'fullTime',
    shifts: [{ staffId: 'w', date: '2026-08-08' }],   // Saturday shift
  });
  const sat = days.find(d => d.date === '2026-08-08');
  assert.equal(sat.leave, true);
  assert.equal(sat.reason, 'rota');
  assert.equal(days.filter(d => d.leave).length, 6);
});

test('an unavailable weekday is a normal day off, not leave', () => {
  // Their weekly pattern says Mondays unavailable (dayIdx: Mon=0).
  const days = proposeLeaveDays({
    from: MON, to: SUN, staffId: 'w', contractType: 'fullTime',
    availability: [{ staffId: 'w', perDay: [{ day: 0, state: 'unavailable' }] }],
  });
  const mon = days.find(d => d.date === MON);
  assert.equal(mon.leave, false);
  assert.equal(mon.reason, 'availability');
  assert.equal(days.filter(d => d.leave).length, 4);
});

test('history drives part-timers: works Fri/Sat/Sun → only those deduct', () => {
  // 6 weeks of Fri+Sat+Sun timesheets.
  const ts = [];
  for (let w = 0; w < 6; w++) {
    ['2026-06-05', '2026-06-06', '2026-06-07'].forEach(base => {
      const d = new Date(base + 'T12:00:00'); d.setDate(d.getDate() + w * 7);
      ts.push({ staffId: 'p', clockIn: d.toISOString(), actualHours: 6 });
    });
  }
  const days = proposeLeaveDays({ from: MON, to: SUN, staffId: 'p', contractType: 'partTime', timesheets: ts });
  const byDate = Object.fromEntries(days.map(d => [d.date, d]));
  assert.equal(byDate['2026-08-07'].leave, true);    // Friday — they work Fridays
  assert.equal(byDate['2026-08-08'].leave, true);    // Saturday
  assert.equal(byDate['2026-08-09'].leave, true);    // Sunday
  assert.equal(byDate['2026-08-03'].leave, false);   // Monday — never works
  assert.equal(days.filter(d => d.leave).length, 3);
});

test('another person’s shifts and timesheets are ignored', () => {
  const days = proposeLeaveDays({
    from: MON, to: '2026-08-04', staffId: 'w', contractType: 'fullTime',
    shifts: [{ staffId: 'SOMEONE_ELSE', date: MON }],
    timesheets: [{ staffId: 'SOMEONE_ELSE', clockIn: '2026-06-07T12:00:00Z', actualHours: 8 }],
  });
  assert.ok(days.every(d => d.reason === 'contract'));
});

test('no data at all: weekdays on, weekend off, marked as the default guess', () => {
  const days = proposeLeaveDays({ from: MON, to: SUN, staffId: 'x', contractType: 'zeroHours' });
  assert.equal(days.filter(d => d.leave).length, 5);
  assert.ok(days.every(d => d.reason === 'default'));
});

test('workedWeekdayShare counts weeks, not shifts', () => {
  // Two Friday shifts in ONE week must not double-count that week.
  const { weeks, share } = workedWeekdayShare([
    { staffId: 'p', clockIn: '2026-06-05T10:00:00Z', actualHours: 4 },
    { staffId: 'p', clockIn: '2026-06-05T18:00:00Z', actualHours: 4 },
    { staffId: 'p', clockIn: '2026-06-12T10:00:00Z', actualHours: 8 },
  ], 'p');
  assert.equal(weeks, 2);
  assert.equal(share[5], 1);   // Friday worked in 2 of 2 weeks
});
