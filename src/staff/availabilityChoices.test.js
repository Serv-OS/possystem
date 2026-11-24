// src/staff/availabilityChoices.test.js (5.12.91): Part of the day, and availability for future weeks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DAY_STATE_KEYS, DEFAULT_PART_DAY, cleanOptions, partDayOptions, cleanPerDay, dayWords, weekOf, allAvailable, weekChoices, weekProblem, upcomingPatterns, MAX_WEEKS_AHEAD } from '../../supabase/functions/_shared/availabilityChoices.js';
import { availabilityInEffect } from '../../supabase/functions/_shared/availabilityWhen.js';

test('a site with no options of its own gets the four defaults', () => {
  assert.deepEqual(partDayOptions(null), ['AM shift', 'PM shift', 'From 12pm', 'From 5pm']);
  assert.deepEqual(partDayOptions({ availabilityOptions: [] }), DEFAULT_PART_DAY);
  assert.deepEqual(partDayOptions({ availabilityOptions: ['  Lunch only ', 'lunch only', '', 'After   3pm'] }), ['Lunch only', 'After 3pm']);
  const many = cleanOptions(Array.from({ length: 20 }, (_, i) => `Option ${i}`));
  assert.equal(many.length, 12);
  assert.equal(cleanOptions(['x'.repeat(50)])[0].length, 30);
  assert.deepEqual(cleanOptions('nope'), []);
});

test('a change is checked: real days, real choices, and Part of the day needs one of the site options', () => {
  const ok = cleanPerDay([{ day: 2, state: 'partial', note: 'am SHIFT' }, { day: 0, state: 'unavailable' }, { day: 1, state: 'preferred', note: 'ignored' }]);
  assert.deepEqual(ok.perDay, [{ day: 0, state: 'unavailable' }, { day: 1, state: 'preferred' }, { day: 2, state: 'partial', note: 'AM shift' }]);
  assert.match(cleanPerDay([{ day: 2, state: 'partial' }]).error, /which part of the day you can work on Wednesday/);
  assert.match(cleanPerDay([{ day: 2, state: 'partial', note: 'Whenever' }]).error, /Wednesday/);
  assert.equal(cleanPerDay([{ day: 2, state: 'partial', note: 'Whenever' }], ['Whenever']).perDay[0].note, 'Whenever');
  for (const bad of [null, [], [{ day: 7, state: 'available' }], [{ day: 1, state: 'maybe' }], [{ day: 1, state: 'available' }, { day: 1, state: 'unavailable' }], [{ day: 1.5, state: 'available' }]]) {
    assert.equal(cleanPerDay(bad).error, 'Pick a choice for each day');
  }
  assert.deepEqual(DAY_STATE_KEYS, ['available', 'preferred', 'partial', 'unavailable']);
});

test('a day in words, and a pattern as seven days', () => {
  assert.equal(dayWords({ state: 'partial', note: 'From 5pm' }), 'Part of the day: From 5pm');
  assert.equal(dayWords({ state: 'partial' }), 'Part of the day');
  assert.equal(dayWords({ state: 'preferred' }), 'Preferred');
  assert.equal(dayWords({ state: 'nonsense' }), 'Available');
  assert.equal(dayWords(null), 'Available');
  const w = weekOf([{ day: 2, state: 'partial', note: 'AM shift' }, { day: 6, state: 'unavailable' }]);
  assert.equal(w.length, 7);
  assert.deepEqual(w[2], { day: 2, state: 'partial', note: 'AM shift' });
  assert.deepEqual(w[0], { day: 0, state: 'available' });
  assert.equal(allAvailable([]), true);
  assert.equal(allAvailable([{ day: 3, state: 'preferred' }]), false);
});

test('weeks that can be picked: the first open week and up to 26 after it', () => {
  const weeks = weekChoices('2026-11-30');
  assert.equal(weeks.length, MAX_WEEKS_AHEAD + 1);
  assert.deepEqual(weeks.slice(0, 3), ['2026-11-30', '2026-12-07', '2026-12-14']);
  assert.equal(weeks.at(-1), '2027-05-31');
  assert.deepEqual(weekChoices('2026-11-30', 4), ['2026-11-30', '2026-12-07', '2026-12-14', '2026-12-21']);
  assert.deepEqual(weekChoices(''), []);
  assert.equal(weekProblem('2026-12-07', '2026-11-30'), null);
  assert.equal(weekProblem('2026-11-30', '2026-11-30'), null);
  assert.match(weekProblem('2026-11-23', '2026-11-30'), /already on the rota/);
  assert.match(weekProblem('2026-12-09', '2026-11-30'), /Pick the week/);          // a Wednesday is not a week start
  assert.match(weekProblem('2027-06-07', '2026-11-30'), /up to 26 weeks ahead/);
  assert.match(weekProblem('', '2026-11-30'), /Pick the week/);
});

test('the student case: off this Wednesday, back the Wednesday after, each from its own week', () => {
  const rows = [
    { week_start: null, per_day: [] },
    { week_start: '2026-11-30', per_day: [{ day: 2, state: 'unavailable' }] },
    { week_start: '2026-12-07', per_day: [{ day: 2, state: 'available' }] },
    { week_start: '2027-01-11', per_day: [{ day: 2, state: 'partial', note: 'From 5pm' }] },
  ];
  const stateOn = (date) => (availabilityInEffect(rows, date)?.perDay || []).find((d) => d.day === 2)?.state || 'available';
  assert.equal(stateOn('2026-11-25'), 'available');     // before anything filed
  assert.equal(stateOn('2026-12-02'), 'unavailable');   // Wed in the week of 30 Nov
  assert.equal(stateOn('2026-12-09'), 'available');     // the Wednesday after
  assert.equal(stateOn('2026-12-30'), 'available');     // carries on until the next week that has one
  assert.equal(stateOn('2027-01-13'), 'partial');
  const up = upcomingPatterns(rows, '2026-11-24', '2026-12-07');
  assert.deepEqual(up.map((u) => [u.from, u.locked]), [['2026-11-30', true], ['2026-12-07', false], ['2027-01-11', false]]);
  assert.deepEqual(up[2].perDay[2], { day: 2, state: 'partial', note: 'From 5pm' });
  assert.deepEqual(upcomingPatterns(null, '2026-11-24', '2026-12-07'), []);
});
