// src/lib/caOvertime.test.js: California daily overtime and meal break premium (5.12.53).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { caOvertimeAcrossSites, caRules } from '../../supabase/functions/_shared/caOvertime.js';

// A San Mateo cook on $20. 2 Nov 2026 is a Monday; work week Monday to Sunday.
const sh = (id, day, hours, brk = 30, extra = {}) => ({ id, staff_id: 's1', location_id: 'L1', actual_hours: hours, effective_rate: 20, paid_break_mins: 0,
  break_taken: brk, clock_in: `${day}T16:00:00Z`, tz: 'America/Los_Angeles', ...extra });
const run = (sheets, rules) => caOvertimeAcrossSites(sheets, { tz: 'America/Los_Angeles', from: '2026-11-01', to: '2026-11-15', here: 'L1', rules })?.s1;

test('only a California venue gets the rules, both on unless switched off', () => {
  assert.equal(caRules({}), null);
  assert.equal(caRules({ usBreaks: { state: 'UT' } }), null);
  assert.deepEqual(caRules({ usBreaks: { state: 'CA' } }), { dailyOvertime: true, mealPremium: true });
  assert.deepEqual(caRules({ usBreaks: { state: 'CA' }, caDailyOvertime: false, caMealPremium: false }), { dailyOvertime: false, mealPremium: false });
});

test('over 8 hours in a day is time and a half, over 12 is double time', () => {
  const r = run([sh('a', '2026-11-03', 13)]);
  assert.equal(r.regular, 8); assert.equal(r.overtime, 4); assert.equal(r.doubleTime, 1);
  // premium: 4 x 20 x 0.5 = 40, plus 1 x 20 = 20
  assert.equal(r.overtimePremium, 60);
});

test('weekly 40 counts only regular hours, never paying an hour twice', () => {
  // Five 10 hour days: 2 daily overtime hours each (10), 40 regular, so no weekly overtime.
  const five = ['03', '04', '05', '06', '07'].map((d, i) => sh(`d${i}`, `2026-11-${d}`, 10));
  const r = run(five);
  assert.equal(r.regular, 40); assert.equal(r.overtime, 10); assert.equal(r.doubleTime, 0);
  // Six 8 hour days: no daily overtime, 48 regular: 8 weekly overtime hours.
  const six = ['02', '03', '04', '05', '06', '07'].map((d, i) => sh(`e${i}`, `2026-11-${d}`, 8));
  const r6 = run(six);
  assert.equal(r6.regular, 40); assert.equal(r6.overtime, 8);
});

test('a short or missed meal break owes one hour at the regular rate that day', () => {
  assert.equal(run([sh('a', '2026-11-03', 6, 30)]).mealPremium, 0, 'a full 30 minutes');
  const short = run([sh('a', '2026-11-03', 6, 15)]);
  assert.equal(short.mealPremium, 20); assert.equal(short.mealPremiumDays, 1);
  assert.equal(run([sh('a', '2026-11-03', 4.5, 0)]).mealPremium, 0, '4.5 h worked + no break is under 5 h on shift');
  // Past 10 hours a second 30 minutes is due: 11 h worked with 30 minutes is short.
  assert.equal(run([sh('a', '2026-11-03', 11, 30)]).mealPremium, 20);
});

test('switching the rules off: weekly overtime only, no meal premium', () => {
  const r = run([sh('a', '2026-11-03', 13, 0)], { dailyOvertime: false, mealPremium: false });
  assert.equal(r.overtime, 0); assert.equal(r.doubleTime, 0); assert.equal(r.mealPremium, 0); assert.equal(r.regular, 13);
});

test('exempt positions earn nothing here either', () => {
  assert.equal(run([sh('a', '2026-11-03', 13, 0, { exempt: true })]), undefined);
});
