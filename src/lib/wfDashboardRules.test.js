// src/lib/wfDashboardRules.test.js
//
// 5.12.59: the Workforce Today dashboard rules (lib/wfDashboardRules.js) on made up rows.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LATE_AFTER_MINS, DOC_WARN_DAYS, hhmmToMins, addDaysYmd, daysBetweenYmd, weekOf, shiftHours,
  onShiftNow, rosteredToday, plannedHours, hoursSoFar, clockedInIds, lateOrNoShow, notRostered,
  plannedCost, pendingTimeOff, onboardingOpen, docsDue, openShifts, dashboardFrom,
} from './wfDashboardRules.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '../..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const TODAY = '2026-11-04';
// 10:30 on the venue clock; the instant is 17:30 UTC (Denver, MST).
const NOW_MINS = 10 * 60 + 30;
const NOW_MS = Date.parse('2026-11-04T17:30:00Z');

const shift = (o) => ({ id: o.id || `s-${o.staffId}`, staffId: o.staffId ?? null, roleKey: o.roleKey || 'server', date: o.date || TODAY, start: o.start || '09:00', finish: o.finish || '17:00', breakMins: o.breakMins ?? 30, status: o.status || 'published', computedHours: o.computedHours ?? null });
const ts = (o) => ({ id: o.id || `t-${o.staffId}`, staffId: o.staffId, shiftId: o.shiftId || null, clockIn: o.clockIn, clockOut: o.clockOut ?? null, breakTaken: o.breakTaken || 0, actualHours: o.actualHours || 0, status: o.status || 'pending', day: o.day || TODAY });

test('plain helpers: times, days and the work week', () => {
  assert.equal(hhmmToMins('09:05'), 545);
  assert.equal(hhmmToMins('9:05'), 545);
  assert.equal(hhmmToMins(''), null);
  assert.equal(addDaysYmd('2026-11-04', 6), '2026-11-10');
  assert.equal(addDaysYmd('2026-12-30', 3), '2027-01-02');
  assert.equal(daysBetweenYmd('2026-11-04', '2026-11-01'), -3);
  assert.equal(daysBetweenYmd('bad', '2026-11-01'), null);
  assert.deepEqual(weekOf('2026-11-04', 1), { startIso: '2026-11-02', endIso: '2026-11-08' });   // Wednesday, Monday week
  assert.deepEqual(weekOf('2026-11-04', 0), { startIso: '2026-11-01', endIso: '2026-11-07' });   // Sunday week
  assert.deepEqual(weekOf('', 1), { startIso: '', endIso: '' });
});

test('shift hours: the saved figure, else the span less the break, never negative', () => {
  assert.equal(shiftHours(shift({ staffId: 'a', start: '09:00', finish: '17:00', breakMins: 30 })), 7.5);
  assert.equal(shiftHours(shift({ staffId: 'a', start: '22:00', finish: '02:00', breakMins: 0 })), 4);
  assert.equal(shiftHours(shift({ staffId: 'a', computedHours: 6.25 })), 6.25);
  assert.equal(shiftHours(shift({ staffId: 'a', start: '09:00', finish: '09:10', breakMins: 30 })), 0);
  assert.equal(shiftHours(null), 0);
});

test('on shift now: a clock in with no clock out, whatever day it started', () => {
  const rows = [
    ts({ staffId: 'a', clockIn: '2026-11-04T16:00:00Z' }),
    ts({ staffId: 'b', clockIn: '2026-11-04T15:00:00Z', clockOut: '2026-11-04T17:00:00Z', actualHours: 2 }),
    ts({ staffId: 'c', clockIn: '2026-11-04T05:50:00Z', day: '2026-11-03' }),   // overnight, still in
    { id: 'x', staffId: 'd', clockIn: null },
  ];
  assert.deepEqual(onShiftNow(rows).map((r) => r.staffId), ['a', 'c']);
  assert.deepEqual([...clockedInIds(rows, TODAY)].sort(), ['a', 'b', 'c']);
  assert.deepEqual(onShiftNow([]), []);
});

test('hours so far today: closed rows by actual hours, open rows by the clock less the break', () => {
  const rows = [
    ts({ staffId: 'a', clockIn: '2026-11-04T16:00:00Z', breakTaken: 30 }),                       // 1.5 h in, 30 min break = 1 h
    ts({ staffId: 'b', clockIn: '2026-11-04T15:00:00Z', clockOut: '2026-11-04T17:00:00Z', actualHours: 2 }),
    ts({ staffId: 'c', clockIn: '2026-11-03T15:00:00Z', clockOut: '2026-11-03T20:00:00Z', actualHours: 5, day: '2026-11-03' }),  // yesterday
    ts({ staffId: 'd', clockIn: '2026-11-04T15:00:00Z', clockOut: '2026-11-04T16:00:00Z', actualHours: 1, status: 'no_show' }),
  ];
  assert.equal(hoursSoFar(rows, { todayIso: TODAY, nowMs: NOW_MS }), 3);
  assert.equal(hoursSoFar(rows, { todayIso: '', nowMs: NOW_MS }), 0);
  assert.equal(hoursSoFar([], { todayIso: TODAY, nowMs: NOW_MS }), 0);
});

test('late needs more than 10 minutes past a published start with no clock in', () => {
  assert.equal(LATE_AFTER_MINS, 10);
  const shifts = [
    shift({ staffId: 'a', start: '10:20' }),   // exactly 10 min ago: not late yet
    shift({ staffId: 'b', start: '10:19' }),   // 11 min ago: late
    shift({ staffId: 'c', start: '09:00' }),   // 90 min, clocked in: fine
    shift({ staffId: 'd', start: '09:00', status: 'draft' }),      // a draft is not told to anyone
    shift({ staffId: 'e', start: '09:00', status: 'no_show' }),    // already marked
    shift({ staffId: null, start: '09:00' }),                      // open shift: no one's
    shift({ staffId: 'f', start: '11:00' }),                       // not started
  ];
  const rows = [ts({ staffId: 'c', clockIn: '2026-11-04T16:00:00Z' })];
  const late = lateOrNoShow(shifts, rows, { todayIso: TODAY, nowMins: NOW_MINS, headOfficeIds: new Set() });
  assert.deepEqual(late.map((l) => [l.staffId, l.lateMins]), [['b', 11]]);
  // yesterday's shift is not today's
  assert.deepEqual(lateOrNoShow([shift({ staffId: 'g', date: '2026-11-03', start: '09:00' })], [], { todayIso: TODAY, nowMins: NOW_MINS }), []);
});

test('a head office person is never late and never "not rostered"', () => {
  const ho = new Set(['boss']);
  const shifts = [shift({ staffId: 'boss', start: '08:00' })];
  assert.deepEqual(lateOrNoShow(shifts, [], { todayIso: TODAY, nowMins: NOW_MINS, headOfficeIds: ho }), []);
  const rows = [ts({ staffId: 'boss', clockIn: '2026-11-04T16:00:00Z' })];
  assert.deepEqual(notRostered(rows, [], { todayIso: TODAY, headOfficeIds: ho }), []);
  // the same rows for an ordinary person do count
  assert.equal(lateOrNoShow(shifts, [], { todayIso: TODAY, nowMins: NOW_MINS, headOfficeIds: new Set() }).length, 1);
  assert.equal(notRostered(rows, [], { todayIso: TODAY, headOfficeIds: new Set() }).length, 1);
});

test('a clock in with no shift today is "not rostered"; one with a shift is not', () => {
  const shifts = [shift({ staffId: 'a' }), shift({ staffId: 'b', date: '2026-11-05' })];
  const rows = [
    ts({ staffId: 'a', clockIn: '2026-11-04T16:00:00Z' }),
    ts({ staffId: 'b', clockIn: '2026-11-04T16:00:00Z' }),            // shift is tomorrow, not today
    ts({ id: 't-b2', staffId: 'b', clockIn: '2026-11-04T16:30:00Z' }), // a second open row: one person once
    ts({ staffId: 'c', clockIn: '2026-11-04T15:00:00Z', clockOut: '2026-11-04T16:00:00Z' }),  // gone home
  ];
  assert.deepEqual(notRostered(rows, shifts, { todayIso: TODAY }).map((r) => r.staffId), ['b']);
});

test('rostered today and planned hours leave marked no shows out', () => {
  const shifts = [
    shift({ staffId: 'a', start: '09:00', finish: '17:00', breakMins: 30 }),    // 7.5
    shift({ staffId: 'b', start: '12:00', finish: '16:00', breakMins: 0 }),     // 4
    shift({ staffId: 'c', status: 'no_show' }),
    shift({ staffId: 'd', date: '2026-11-05' }),
  ];
  const today = rosteredToday(shifts, TODAY);
  assert.deepEqual(today.map((s) => s.staffId), ['a', 'b']);
  assert.equal(plannedHours(today), 11.5);
  assert.deepEqual(rosteredToday(shifts, ''), []);
});

test('planned cost: staff override, else the position rate, else salaried; an open shift costs its position', () => {
  const rolesMap = { server: { key: 'server', rate: 12, contractedWeek: 40 }, gm: { key: 'gm', rate: null, salary: 52000, contractedWeek: 40 } };
  const staffById = { a: { id: 'a', role: 'server', rateOverride: 15 }, b: { id: 'b', role: 'server', rateOverride: null }, g: { id: 'g', role: 'gm' } };
  const shifts = [
    shift({ staffId: 'a', start: '09:00', finish: '11:00', breakMins: 0 }),   // 2 h at 15 = 30
    shift({ staffId: 'b', start: '09:00', finish: '11:00', breakMins: 0 }),   // 2 h at 12 = 24
    shift({ staffId: 'g', roleKey: 'gm', start: '09:00', finish: '10:00', breakMins: 0 }),   // 1 h at 52000/52/40 = 25
    shift({ staffId: null, start: '09:00', finish: '10:00', breakMins: 0 }),  // open: 1 h at 12 = 12
    shift({ staffId: 'b', id: 'ns', status: 'no_show' }),
  ];
  assert.equal(plannedCost(shifts, { staffById, rolesMap }), 91);
  // the rates door wins over the row's own figure when it answers
  assert.equal(plannedCost(shifts.slice(0, 1), { staffById, rolesMap, rates: { a: 20 } }), 40);
  assert.equal(plannedCost([], { staffById, rolesMap }), 0);
  assert.equal(plannedCost(shifts.slice(1, 2), { staffById: {}, rolesMap: {} }), 0);   // no rate known: nothing made up
});

test('expired and expiring within 30 days both count, 31 days does not', () => {
  assert.equal(DOC_WARN_DAYS, 30);
  const docs = [
    { id: 'd1', staffId: 'a', type: 'rtw', expiry: '2026-11-03', status: 'approved' },   // yesterday: expired
    { id: 'd2', staffId: 'a', type: 'food', expiry: '2026-11-04', status: 'approved' },  // today: expiring
    { id: 'd3', staffId: 'b', type: 'food', expiry: '2026-12-04', status: 'approved' },  // 30 days: expiring
    { id: 'd4', staffId: 'b', type: 'rtw', expiry: '2026-12-05', status: 'approved' },   // 31 days: fine
    { id: 'd5', staffId: 'c', type: 'rtw', expiry: '2026-11-01', status: 'pending' },    // waiting for review, not an expiry
    { id: 'd6', staffId: 'c', type: 'rtw', expiry: '2026-11-01', status: 'rejected' },
    { id: 'd7', staffId: 'c', type: 'rtw', expiry: null, status: 'approved' },
  ];
  const due = docsDue(docs, TODAY);
  assert.deepEqual(due.expired.map((d) => d.id), ['d1']);
  assert.deepEqual(due.expiring.map((d) => d.id), ['d2', 'd3']);
  assert.equal(due.rows.length, 3);
  assert.equal(due.expired[0].days, -1);
  assert.deepEqual(docsDue(docs, ''), { expired: [], expiring: [], rows: [] });
});

test('waiting for you: pending time off, open onboarding, unclaimed open shifts from today to the week end', () => {
  assert.equal(pendingTimeOff([{ status: 'pending' }, { status: 'approved' }, { status: 'declined' }, null]).length, 1);
  assert.equal(onboardingOpen([{ status: 'inProgress' }, { status: 'complete' }, { status: 'inProgress' }]).length, 2);
  const shifts = [
    shift({ staffId: null, id: 'o1', date: '2026-11-03' }),   // yesterday: moot
    shift({ staffId: null, id: 'o2', date: '2026-11-04' }),
    shift({ staffId: null, id: 'o3', date: '2026-11-08' }),
    shift({ staffId: null, id: 'o4', date: '2026-11-09' }),   // next week
    shift({ staffId: 'a', id: 'o5', date: '2026-11-05' }),    // taken
  ];
  assert.deepEqual(openShifts(shifts, { fromIso: TODAY, toIso: '2026-11-08' }).map((s) => s.id), ['o2', 'o3']);
  assert.deepEqual(openShifts(shifts, { fromIso: '', toIso: '' }), []);
});

test('empty inputs give zeros and "none", never a sample', () => {
  const d = dashboardFrom({ shifts: [], timesheets: [], timeOff: [], onboarding: [], docs: [], staff: [], rolesMap: {}, rates: {}, settings: {}, todayIso: TODAY, nowMins: NOW_MINS, nowMs: NOW_MS, headOfficeIds: new Set(), week: weekOf(TODAY, 1) });
  assert.deepEqual(d.onNow, []);
  assert.deepEqual(d.rostered, []);
  assert.equal(d.plannedHoursToday, 0);
  assert.equal(d.hoursSoFar, 0);
  assert.deepEqual(d.late, []);
  assert.deepEqual(d.unrostered, []);
  assert.equal(d.costToday, 0);
  assert.deepEqual(d.waiting, { timeOff: 0, onboarding: 0, docs: { expired: [], expiring: [], rows: [] }, openShifts: 0 });
  assert.deepEqual(d.week, { startIso: '2026-11-02', endIso: '2026-11-08', hours: 0, cost: 0, shifts: 0 });
  assert.equal(d.staffCount, 0);
  // undefined everywhere is as safe as empty
  const u = dashboardFrom({ todayIso: '', nowMins: NaN, nowMs: NaN });
  assert.equal(u.costToday, 0);
  assert.equal(u.week.hours, 0);
});

test('the whole picture: the week from the venue work week, leavers off the books', () => {
  const rolesMap = { server: { key: 'server', rate: 10, contractedWeek: 40 } };
  const staff = [{ id: 'a', role: 'server', status: 'active' }, { id: 'b', role: 'server', status: 'leaver' }, { id: 'boss', role: 'server', status: 'active', headOffice: true }];
  const shifts = [
    shift({ staffId: 'a', start: '09:00', finish: '13:00', breakMins: 0 }),                       // today 4 h, 40
    shift({ staffId: 'a', id: 's2', date: '2026-11-07', start: '09:00', finish: '13:00', breakMins: 0 }),   // Saturday, same week
    shift({ staffId: 'a', id: 's3', date: '2026-11-09', start: '09:00', finish: '13:00', breakMins: 0 }),   // next week
  ];
  const d = dashboardFrom({ shifts, timesheets: [], timeOff: [], onboarding: [], docs: [], staff, rolesMap, settings: {}, todayIso: TODAY, nowMins: NOW_MINS, nowMs: NOW_MS, headOfficeIds: new Set(['boss']), week: weekOf(TODAY, 1) });
  assert.equal(d.staffCount, 2);
  assert.equal(d.plannedHoursToday, 4);
  assert.equal(d.costToday, 40);
  assert.equal(d.week.hours, 8);
  assert.equal(d.week.cost, 80);
  assert.equal(d.week.shifts, 2);
  assert.deepEqual(d.late.map((l) => l.staffId), ['a']);
});

test('no long dashes in the new files', () => {
  const long = new RegExp(`[${String.fromCharCode(0x2013)}${String.fromCharCode(0x2014)}]`);
  for (const f of ['src/lib/wfDashboardRules.js', 'src/lib/wfDashboardRules.test.js', 'src/backoffice/sections/workforce/WfDashboard.jsx']) {
    assert.doesNotMatch(read(f), long, f);
  }
});

test('the screen keeps to the venue clock: no en-GB words, no forced 24 hour clock, no London fallback', () => {
  const src = read('src/backoffice/sections/workforce/WfDashboard.jsx');
  assert.doesNotMatch(src, /toLocale\w*\(\s*'en-GB'/);
  assert.doesNotMatch(src, /hour12:\s*false/);
  assert.doesNotMatch(src, /Europe\/London/);
  assert.match(src, /venueToday\(/);
  assert.match(src, /timeText\(/);
});
