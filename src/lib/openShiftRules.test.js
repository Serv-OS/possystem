// src/lib/openShiftRules.test.js
//
// v5.11.101: the open shift and swap rules in JavaScript (_shared/openShiftRules.js), over the SAME
// list of cases the database judge runs in supabase/tests/wf_open_shifts/run.mjs, so the staff app's
// "why not" and the database's answer cannot drift apart.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { claimProblem, swapMode, claimHoursCap, spanMins, weekMonday, shiftWords, eligibleStaff, problemText,
  textOpenShift, textOffered, textTaken, textYours, textAsked, textDeclined, textOfferDeclined, PROBLEM_WORDS, MANAGER_WORDS } from '../../supabase/functions/_shared/openShiftRules.js';

const { cases } = JSON.parse(readFileSync(new URL('../../supabase/tests/wf_open_shifts/cases.json', import.meta.url), 'utf8'));
const TODAY = '2026-11-04';   // a Wednesday
const plus = (n) => new Date(Date.parse(`${TODAY}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const VENUE = 'loc-a', OTHER = 'loc-b';
const PEOPLE = {
  C: { id: 'C', locationId: VENUE, status: 'active', roleKey: 'bar' },
  Q: { id: 'Q', locationId: VENUE, status: 'active', roleKey: 'bar' },
  P: { id: 'P', locationId: VENUE, status: 'active', roleKey: 'bar' },
  D: { id: 'D', locationId: VENUE, status: 'active', roleKey: 'kitchen' },
  L: { id: 'L', locationId: VENUE, status: 'leaver', roleKey: 'bar' },
  X: { id: 'X', locationId: OTHER, status: 'active', roleKey: 'bar' },
};
const dayIdx = (iso) => (new Date(`${iso}T00:00:00Z`).getUTCDay() + 6) % 7;

/** One case from cases.json as claimProblem's input. Exported shape mirrors run.mjs's seeding. */
function inputOf(k) {
  const shift = { id: 'S', locationId: VENUE, staffId: k.shift.owner || null, roleKey: 'bar', date: plus(k.shift.day),
    start: k.shift.start, finish: k.shift.finish, breakMins: 0, status: k.shift.status || 'published' };
  const claimer = PEOPLE[k.claimer];
  const request = k.request ? { id: 'R', kind: k.request.kind, status: k.request.status, fromStaffId: k.request.from || null, toStaffId: k.request.to || null } : null;
  const theirShifts = (k.others || []).map((o, i) => ({ id: `O${i}`, staffId: claimer.id, date: plus(o.day), start: o.start, finish: o.finish, breakMins: 0, status: o.status || 'published' }));
  const leave = (k.leave || []).map(l => ({ status: l.status, startDate: plus(l.fromDay), endDate: plus(l.toDay) }));
  const availability = k.unavailable ? { perDay: [{ day: dayIdx(shift.date), state: 'unavailable' }] } : null;
  const settings = k.cap ? { shiftSwaps: { maxWeeklyHours: k.cap } } : {};
  return { shift, claimer, request, theirShifts, leave, availability, settings, todayIso: TODAY, nowMin: 600 };
}

for (const k of cases) {
  test(`claim case: ${k.name}`, () => {
    const got = claimProblem(inputOf(k));
    assert.equal(got ? got.code : null, k.expect, got ? got.text : 'no problem');
  });
}

test('every code claimProblem can answer has words for the database answer too', () => {
  for (const k of cases) if (k.expect) assert.ok(PROBLEM_WORDS[k.expect], k.expect);
  assert.equal(problemText('nope'), 'That could not be done. Refresh and try again.');
  // A manager reads about the person who asked; the Manager app's PIN pad words never appear.
  assert.equal(problemText('overlap', 'manager'), 'They now have another shift that overlaps it.');
  assert.equal(problemText('taken', 'manager'), PROBLEM_WORDS.taken);
  for (const t of [...Object.values(PROBLEM_WORDS), ...Object.values(MANAGER_WORDS)]) assert.doesNotMatch(t, /pin|not allowed|approve/i, t);
});

test('a shift starting this minute has started; one a minute later has not', () => {
  const base = { shift: { id: 'S', locationId: VENUE, staffId: null, roleKey: 'bar', date: TODAY, start: '10:00', finish: '14:00', status: 'published' }, claimer: PEOPLE.C, todayIso: TODAY, settings: {} };
  assert.equal(claimProblem({ ...base, nowMin: 600 })?.code, 'past');
  assert.equal(claimProblem({ ...base, nowMin: 599 }), null);
});

test('the setting: a manager approves unless the venue says straight away', () => {
  assert.equal(swapMode({}), 'manager');
  assert.equal(swapMode(null), 'manager');
  assert.equal(swapMode({ shiftSwaps: { approval: 'instant' } }), 'instant');
  assert.equal(swapMode({ shiftSwaps: { approval: 'anything' } }), 'manager');
  assert.equal(claimHoursCap({}), null);
  assert.equal(claimHoursCap({ shiftSwaps: { maxWeeklyHours: '40' } }), 40);
  assert.equal(claimHoursCap({ shiftSwaps: { maxWeeklyHours: 0 } }), null);
  assert.equal(claimHoursCap({ shiftSwaps: { maxWeeklyHours: 500 } }), 168);
});

test('spans, weeks and words', () => {
  const [a, b] = spanMins('2026-11-04', '22:00', '03:00');
  assert.equal(b - a, 300);
  assert.equal(weekMonday('2026-11-04'), '2026-11-02');
  assert.equal(weekMonday('2026-11-02'), '2026-11-02');
  assert.equal(weekMonday('2026-11-08'), '2026-11-02');
  assert.equal(shiftWords({ date: '2026-10-28', start: '17:00', finish: '23:00' }), 'Wed 28 Oct, 17:00 to 23:00');
  assert.equal(shiftWords({ date: '2026-10-28', start: '17:00', finish: '09:30' }, 'US'), 'Wed Oct 28, 5:00pm to 9:30am');
  assert.equal(shiftWords({ date: '2026-10-28', start: '00:15', finish: '12:00' }, 'US'), 'Wed Oct 28, 12:15am to 12:00pm');
});

test('who hears about an open shift: active, this venue, this position, not the owner', () => {
  const shift = { locationId: VENUE, roleKey: 'bar' };
  const ids = eligibleStaff(shift, Object.values(PEOPLE), 'P').map(s => s.id).sort();
  assert.deepEqual(ids, ['C', 'Q']);
  assert.deepEqual(eligibleStaff({ locationId: VENUE, roleKey: null }, Object.values(PEOPLE)).map(s => s.id).sort(), ['C', 'D', 'P', 'Q']);
});

test('texts: plain words, no dashes, no exclamation marks, the venue named', () => {
  const sh = { date: '2026-10-28', start: '17:00', finish: '23:00' };
  const all = [textOpenShift('Leeds', sh), textOffered('Leeds', 'Jane Lee', sh), textTaken('Leeds', 'Sam Ray', sh), textYours('Leeds', sh), textAsked('Leeds', sh), textDeclined('Leeds', sh), textOfferDeclined('Leeds', 'Jo', sh), ...Object.values(PROBLEM_WORDS), ...Object.values(MANAGER_WORDS)];
  for (const t of all) {
    assert.ok(!/[–—!]/.test(t), t);
  }
  assert.equal(textOpenShift('Leeds', sh), 'Leeds: an open shift is up for grabs, Wed 28 Oct, 17:00 to 23:00. Open the staff app to claim it.');
  assert.match(textOffered('', 'Jane Lee', sh), /^your venue: Jane has offered you/);
});
