/**
 * opsStats.test.js: the head office Operations figures worked out from the module's own rows.
 * Run: `node --test src/lib/hq/opsStats.test.js`.
 *
 * Pinned:
 *   1. Due follows the Operations rule (daily chips, weekly only ticked days, monthly day) and the
 *      weekday comes from the date string, never the browser clock.
 *   2. A past day with no complete run is missed; today's is due until the window plus grace passes;
 *      a checklist with no time of day is only missed once the day is over.
 *   3. Opening and closing are the template's area. Temperature failures count by severity.
 *   4. checksPct is done out of (done + missed); null with nothing scheduled.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dueOn, windowState, checklistStats, tempStats, maintenanceStats, checksPct, opsSiteStats, dateRange, checksWords } from './opsStats.js';

// 2026-11-16 is a Monday (1), 2026-11-15 a Sunday (0).
test('dueOn: daily, weekly, monthly, inactive, venue weekday from the string', () => {
  assert.equal(dueOn({ frequency: 'daily', days_of_week: [] }, '2026-11-16'), true);
  assert.equal(dueOn({ frequency: 'daily', days_of_week: [1, 2] }, '2026-11-16'), true);
  assert.equal(dueOn({ frequency: 'daily', days_of_week: [1, 2] }, '2026-11-15'), false);
  assert.equal(dueOn({ frequency: 'weekly', days_of_week: [] }, '2026-11-16'), false);
  assert.equal(dueOn({ frequency: 'weekly', days_of_week: [0] }, '2026-11-15'), true);
  assert.equal(dueOn({ frequency: 'monthly', day_of_month: 16 }, '2026-11-16'), true);
  assert.equal(dueOn({ frequency: 'monthly' }, '2026-11-01'), true);
  assert.equal(dueOn({ frequency: 'monthly' }, '2026-11-16'), false);
  assert.equal(dueOn({ frequency: 'daily', active: false }, '2026-11-16'), false);
  assert.equal(dueOn({ frequency: 'daily', archived_at: '2026-10-01T00:00:00Z' }, '2026-11-16'), false);
});

test('windowState: done, missed, due, upcoming, anytime', () => {
  const t = '2026-11-16';
  assert.equal(windowState({ timeOfDay: '09:00', satisfied: true, ymd: t, today: t, nowMin: 600 }), 'done');
  assert.equal(windowState({ timeOfDay: '09:00', graceMin: 120, satisfied: false, ymd: t, today: t, nowMin: 500 }), 'upcoming');
  assert.equal(windowState({ timeOfDay: '09:00', graceMin: 120, satisfied: false, ymd: t, today: t, nowMin: 600 }), 'due');
  assert.equal(windowState({ timeOfDay: '09:00', graceMin: 120, satisfied: false, ymd: t, today: t, nowMin: 661 }), 'missed');
  assert.equal(windowState({ timeOfDay: '09:00', satisfied: false, ymd: '2026-11-15', today: t, nowMin: 0 }), 'missed');
  assert.equal(windowState({ timeOfDay: null, satisfied: false, ymd: t, today: t, nowMin: 1400 }), 'anytime');
  assert.equal(windowState({ timeOfDay: null, satisfied: false, ymd: '2026-11-15', today: t, nowMin: 0 }), 'missed');
  assert.equal(windowState({ timeOfDay: '09:00', satisfied: false, ymd: '2026-11-17', today: t, nowMin: 1400 }), 'upcoming');
});

const lists = [
  { id: 'open', area: 'opening', frequency: 'daily', days_of_week: [], time_of_day: '09:00', grace_minutes: 60 },
  { id: 'close', area: 'closing', frequency: 'daily', days_of_week: [], time_of_day: '23:00', grace_minutes: 60 },
  { id: 'clean', area: 'cleaning', frequency: 'daily', days_of_week: [], time_of_day: null },
  { id: 'monday', area: 'BOH', frequency: 'weekly', days_of_week: [1], time_of_day: '12:00', grace_minutes: 30 },
];

test('checklistStats: yesterday missed, today due or done, opening and closing split', () => {
  const runs = [
    { checklist_id: 'open', run_date: '2026-11-15', status: 'complete' },
    { checklist_id: 'open', run_date: '2026-11-16', status: 'complete' },
    { checklist_id: 'close', run_date: '2026-11-15', status: 'open' },
  ];
  const y = checklistStats({ checklists: lists, runs, ymd: '2026-11-15', today: '2026-11-16', nowMin: 700 });
  assert.deepEqual(y.all, { due: 3, done: 1, missed: 2, open: 0 });
  assert.deepEqual(y.opening, { due: 1, done: 1, missed: 0, open: 0 });
  assert.deepEqual(y.closing, { due: 1, done: 0, missed: 1, open: 0 });
  const t = checklistStats({ checklists: lists, runs, ymd: '2026-11-16', today: '2026-11-16', nowMin: 700 });
  assert.deepEqual(t.all, { due: 4, done: 1, missed: 0, open: 1 });
  assert.deepEqual(t.closing, { due: 1, done: 0, missed: 0, open: 0 });
  const late = checklistStats({ checklists: lists, runs, ymd: '2026-11-16', today: '2026-11-16', nowMin: 1439 });
  assert.deepEqual(late.all, { due: 4, done: 1, missed: 1, open: 2 }); // Monday 12:00 missed; closing 23:00 still inside its hour of grace; cleaning anytime
});

test('tempStats: windows and failures by severity', () => {
  const schedules = [
    { id: 's1', temp_unit_id: 'u1', frequency: 'daily', days_of_week: [], time_of_day: '09:00', grace_minutes: 60 },
    { id: 's2', temp_unit_id: 'u1', frequency: 'daily', days_of_week: [], time_of_day: '17:00', grace_minutes: 60 },
    { id: 's3', temp_unit_id: 'u2', frequency: 'daily', days_of_week: [], time_of_day: '09:00', grace_minutes: 60 },
  ];
  const readings = [
    { temp_unit_id: 'u1', schedule_id: null, in_range: true, ymd: '2026-11-16', minute: 9 * 60 + 10 },
    { temp_unit_id: 'u2', schedule_id: 's3', in_range: false, severity: 'critical', ymd: '2026-11-16', minute: 9 * 60 + 30 },
    { temp_unit_id: 'u2', schedule_id: null, in_range: false, severity: 'minor', ymd: '2026-11-16', minute: 14 * 60 },
    { temp_unit_id: 'u2', schedule_id: null, in_range: false, severity: 'major', ymd: '2026-11-15', minute: 14 * 60 },
  ];
  const r = tempStats({ schedules, readings, ymd: '2026-11-16', today: '2026-11-16', nowMin: 15 * 60 });
  assert.deepEqual(r.windows, { due: 3, done: 2, missed: 0, open: 0 });
  assert.deepEqual(r.failed, { count: 2, critical: 1, major: 0, minor: 1 });
  const evening = tempStats({ schedules, readings, ymd: '2026-11-16', today: '2026-11-16', nowMin: 19 * 60 });
  assert.deepEqual(evening.windows, { due: 3, done: 2, missed: 1, open: 0 });
  const y = tempStats({ schedules, readings, ymd: '2026-11-15', today: '2026-11-16', nowMin: 0 });
  assert.deepEqual(y.windows, { due: 3, done: 1, missed: 2, open: 0 }); // the 14:00 u2 reading satisfies its 09:00 window, the Operations rule
  assert.equal(y.failed.major, 1);
});

test('maintenanceStats, checksPct, checksWords', () => {
  assert.deepEqual(maintenanceStats([{ status: 'open', priority: 'urgent' }, { status: 'in_progress', priority: 'low' }, { status: 'resolved', priority: 'urgent' }, { status: 'assigned', priority: 'high' }]), { open: 3, urgent: 2 });
  assert.equal(checksPct({ due: 4, done: 3, missed: 1, open: 0 }), 75);
  assert.equal(checksPct({ due: 4, done: 2, missed: 1, open: 1 }, { due: 2, done: 2, missed: 0, open: 0 }), 80);
  assert.equal(checksPct({ due: 3, done: 0, missed: 0, open: 3 }), 100);
  assert.equal(checksPct({ due: 0, done: 0, missed: 0, open: 0 }), null);
  assert.equal(checksPct(null), null);
  assert.equal(checksWords({ checklists: { all: { missed: 2 } }, temps: { windows: { missed: 0 }, failed: { count: 1 } }, maintenance: { urgent: 0 } }), '2 missed, 1 failed temp');
  assert.equal(checksWords({ checklists: { all: { missed: 0, due: 3 } }, temps: { windows: { missed: 0, due: 0 }, failed: { count: 0 } }, maintenance: { urgent: 2 } }), '2 urgent repairs');
  assert.equal(checksWords({ checklists: { all: { missed: 0, due: 3 } }, temps: { windows: { due: 0 }, failed: { count: 0 } }, maintenance: {} }), 'All done');
  assert.equal(checksWords({ checklists: { all: { due: 0 } }, temps: { windows: { due: 0 }, failed: {} }, maintenance: {} }), 'Nothing scheduled');
});

test('opsSiteStats over a week and dateRange', () => {
  const dates = dateRange('2026-11-10', '2026-11-16');
  assert.equal(dates.length, 7);
  assert.equal(dates[0], '2026-11-10');
  assert.deepEqual(dateRange('2026-11-16', '2026-11-10'), []);
  const runs = dates.map((d) => ({ checklist_id: 'open', run_date: d, status: 'complete' }));
  const s = opsSiteStats({ checklists: lists, runs, schedules: [], readings: [], maintenance: [{ status: 'open', priority: 'urgent' }], dates, today: '2026-11-16', nowMin: 600 });
  // 7 opening done; 6 past closings missed and today's closing upcoming; 6 past cleaning missed, today's open; 1 Monday list (today, upcoming).
  assert.equal(s.checklists.opening.done, 7);
  assert.equal(s.checklists.closing.missed, 6);
  assert.equal(s.checklists.all.due, 7 * 3 + 1);
  assert.equal(s.checklists.all.missed, 12);
  assert.equal(s.checklists.all.open, 1);
  assert.equal(s.checksPct, Math.round((7 / 19) * 1000) / 10);
  assert.equal(s.maintenance.urgent, 1);
  assert.equal(s.days, 7);
});
