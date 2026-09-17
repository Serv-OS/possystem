// The rota rules engine: every rule that stops a bad AI rota (7 days in a row, outside opening
// hours, on leave…) is pinned here, plus the cover filler and the learned forecast.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkProposed, fillCoverage, suggestForecast, snapToTemplate, openWindowsOn, whyNot, DEFAULT_RULES } from './rotaRules.js';

const week = ['2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-26', '2026-09-27']; // Mon..Sun
const hours = { weekly: { mon: [{ open: '09:00', close: '22:00' }], tue: [{ open: '09:00', close: '22:00' }], wed: [{ open: '09:00', close: '22:00' }], thu: [{ open: '09:00', close: '22:00' }], fri: [{ open: '09:00', close: '23:00' }], sat: [{ open: '09:00', close: '23:00' }], sun: [] }, closedDates: [] };
const staff = [{ staffId: 'a', section: 'Floor', maxWeeklyHours: 40 }, { staffId: 'b', section: 'Floor', maxWeeklyHours: null }, { staffId: 'k', section: 'Kitchen', maxWeeklyHours: null }];
const ctx = { dates: week, staff, openingHours: hours, templates: [], availability: [], timeOff: [], rules: {} };
const sh = (staffId, date, start = '10:00', finish = '18:00', extra = {}) => ({ staffId, date, start, finish, breakMins: 30, section: 'Floor', ...extra });

test('never more than the max days in a row (the seven days straight bug)', () => {
  const proposed = week.slice(0, 6).map(d => sh('a', d, '10:00', '16:00'));   // Mon..Sat, six days
  const r = checkProposed({ ...ctx, proposed });
  assert.equal(r.accepted.length, DEFAULT_RULES.maxDaysInRow);
  assert.match(r.rejected[0].reason, /days in a row/);
  // a venue that allows 6 gets 6
  assert.equal(checkProposed({ ...ctx, rules: { maxDaysInRow: 6 }, proposed }).accepted.length, 6);
  // existing shifts count towards the run
  const r2 = checkProposed({ ...ctx, existing: week.slice(0, 5).map(d => sh('a', d, '10:00', '15:00')), proposed: [sh('a', week[5], '10:00', '15:00')] });
  assert.equal(r2.accepted.length, 0);
});

test('opening hours: closed days and out of hours shifts are rejected, a setup hour is allowed', () => {
  assert.equal(whyNot(sh('b', week[6]), [], ctx), 'venue closed that day');
  assert.equal(whyNot(sh('b', week[0], '05:00', '12:00'), [], ctx), 'outside opening hours');
  assert.equal(whyNot(sh('b', week[0], '08:00', '16:00'), [], ctx), null, 'one hour before opening is setup');
  assert.equal(whyNot(sh('b', week[0], '16:00', '23:00'), [], ctx), null, 'one hour after close is close down');
  assert.equal(openWindowsOn({ weekly: {} }, week[0]), null, 'no hours set up = unknown, nothing rejected');
  assert.equal(whyNot(sh('b', week[6], '05:00', '12:00'), [], { ...ctx, openingHours: null }), null);
  assert.deepEqual(openWindowsOn({ ...hours, closedDates: [week[0]] }, week[0]), []);
});

test('approved leave and unavailable days are hard blocks; pending leave is not', () => {
  const timeOff = [{ staffId: 'a', status: 'approved', startDate: week[1], endDate: week[2] }, { staffId: 'b', status: 'pending', startDate: week[1], endDate: week[1] }];
  const availability = [{ staffId: 'b', perDay: [{ day: 3, state: 'unavailable' }] }];
  const c = { ...ctx, timeOff, availability };
  assert.equal(whyNot(sh('a', week[1]), [], c), 'on approved leave');
  assert.equal(whyNot(sh('b', week[1]), [], c), null);
  assert.equal(whyNot(sh('b', week[3]), [], c), 'marked unavailable that day');
});

test('no overlap, and at least the minimum rest between working days (split shifts are fine)', () => {
  const placed = [sh('a', week[0], '15:00', '23:00')];
  assert.equal(whyNot(sh('a', week[0], '18:00', '22:00'), placed, ctx), 'overlaps another shift');
  assert.match(whyNot(sh('a', week[1], '08:00', '14:00'), placed, ctx), /rest between shifts/);
  assert.equal(whyNot(sh('a', week[1], '10:00', '16:00'), placed, ctx), null, '11 hours exactly is allowed');
  assert.equal(whyNot(sh('a', week[0], '09:00', '14:00'), placed, ctx), null, 'a split shift the same day is allowed');
});

test('weekly hours cap', () => {
  const placed = week.slice(0, 4).map(d => sh('a', d, '10:00', '20:00', { breakMins: 0 }));   // 40h
  assert.match(whyNot(sh('a', week[4], '10:00', '14:00'), placed, ctx), /weekly hours/);
  assert.equal(whyNot(sh('b', week[4], '10:00', '14:00'), week.slice(0, 4).map(d => sh('b', d, '10:00', '20:00')), ctx), null, 'no cap set = no limit');
});

test('proposed shifts snap to the venue standard shifts', () => {
  const templates = [{ name: 'Morning', start: '09:00', finish: '15:00', breakMins: 20 }, { name: 'Evening', start: '16:00', finish: '22:00', breakMins: 30 }];
  const p = snapToTemplate(sh('a', week[0], '15:30', '21:00'), templates);
  assert.deepEqual([p.start, p.finish, p.breakMins, p.template], ['16:00', '22:00', 30, 'Evening']);
  assert.equal(snapToTemplate(sh('a', week[0]), []).start, '10:00', 'no standard shifts = left as proposed');
  const r = checkProposed({ ...ctx, templates, proposed: [sh('a', week[0], '08:40', '14:45')] });
  assert.equal(r.accepted[0].template, 'Morning');
});

test('unknown people, dates outside the week and junk rows are rejected, never inserted', () => {
  const r = checkProposed({ ...ctx, proposed: [sh('zz', week[0]), sh('a', '2026-10-01'), null, { staffId: 'a', date: week[0] }] });
  assert.equal(r.accepted.length, 0);
  assert.deepEqual(r.rejected.map(x => x.reason), ['unknown person', 'date outside the week', 'no times']);
});

test('fillCoverage tops each section up to its minimum from that section, fewest hours first, and reports gaps', () => {
  const templates = [{ name: 'Day', start: '10:00', finish: '18:00', breakMins: 30 }];
  const sections = [{ name: 'Floor', minCoverage: 2 }, { name: 'Kitchen', minCoverage: 2 }, { name: 'Bar', minCoverage: 0 }];
  const r = fillCoverage({ ...ctx, templates, sections, existing: [], accepted: [] });
  const mon = r.added.filter(x => x.date === week[0]);
  assert.deepEqual(mon.filter(x => x.section === 'Floor').map(x => x.staffId).sort(), ['a', 'b']);
  assert.deepEqual(mon.filter(x => x.section === 'Kitchen').map(x => x.staffId), ['k']);
  assert.ok(r.gaps.some(g => g.date === week[0] && g.section === 'Kitchen' && g.short === 1), 'one chef short is reported, not invented');
  assert.ok(!r.added.some(x => x.date === week[6]), 'nothing on the closed day');
  for (const id of ['a', 'b', 'k']) assert.ok(r.added.filter(x => x.staffId === id).length <= DEFAULT_RULES.maxDaysInRow, 'the filler obeys the same rules');
  // already covered = nothing added
  const covered = fillCoverage({ ...ctx, templates, sections: [{ name: 'Floor', minCoverage: 1 }], existing: week.slice(0, 6).map(d => sh('b', d)), accepted: [] });
  assert.equal(covered.added.length, 0, 'a section that already has its minimum gets nobody extra');
});

test('suggestForecast learns the weekday pattern, weights recent weeks, ignores closed days and follows the trend', () => {
  const history = {};
  const d = new Date('2026-07-27T00:00:00');   // a Monday, 8 weeks before the target week
  for (let w = 0; w < 8; w++) for (let i = 0; i < 7; i++) {
    const dt = new Date(d); dt.setDate(d.getDate() + w * 7 + i);
    const iso = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
    history[iso] = i === 6 ? 0 : (i === 5 ? 3000 : 1000) + w * 20;   // Sundays closed, Saturdays big, gentle growth
  }
  const f = suggestForecast(history, week);
  assert.ok(f[week[5]].amount > 2.5 * f[week[0]].amount, 'Saturday is forecast about three times a Monday');
  assert.equal(f[week[6]], undefined, 'no suggestion for a day that never trades');
  assert.ok(f[week[0]].amount >= 1100 && f[week[0]].amount <= 1300, `recent weeks weigh more and the trend lifts it (got ${f[week[0]].amount})`);
  assert.equal(f[week[0]].amount % 10, 0);
  assert.equal(f[week[0]].samples, 8);
  assert.deepEqual(suggestForecast({}, week), {});
});
