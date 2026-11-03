// src/lib/acaHours.test.js
//
// 5.12.38: health cover (ACA) hours for US venues, counted at every site a person works at
// (_shared/acaHours.js), and the US payroll screen that shows them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { acaReport, monthsBetween, ACA_FULL_TIME_MONTH } from '../../supabase/functions/_shared/acaHours.js';

test('monthsBetween: calendar months, oldest first, across a year end', () => {
  assert.deepEqual(monthsBetween('2025-11', '2026-02'), ['2025-11', '2025-12', '2026-01', '2026-02']);
  assert.equal(monthsBetween('2025-11', '2026-11').length, 13);
});

test('a person at two sites is full time when their hours together reach 130 in a month', () => {
  const months = ['2026-09', '2026-10', '2026-11'];
  const staff = [
    { id: 'j-provo', person_id: 'jane', location_id: 'provo', name: 'Jane' },
    { id: 'j-day', person_id: 'jane', location_id: 'daybreak', name: 'Jane' },
    { id: 'sam', person_id: null, location_id: 'provo', name: 'Sam' },
  ];
  const rows = [
    { staff_id: 'j-provo', location_id: 'provo', hours: 80, month: '2026-10' },
    { staff_id: 'j-day', location_id: 'daybreak', hours: 55, month: '2026-10' },   // 135 together
    { staff_id: 'j-provo', location_id: 'provo', hours: 129.9, month: '2026-09' },
    { staff_id: 'sam', location_id: 'provo', hours: 140, month: '2026-10' },
    { staff_id: 'sam', location_id: 'provo', hours: 140, month: '2026-11' },     // the month still running
  ];
  const r = acaReport({ rows, staff, here: 'provo', months });
  const jane = r.people.find((p) => p.staffId === 'j-provo');
  assert.deepEqual(jane.months.find((m) => m.month === '2026-10'), { month: '2026-10', hours: 135, here: 80, fullTime: true });
  assert.equal(jane.months.find((m) => m.month === '2026-09').fullTime, false);   // 129.9 is not 130
  assert.equal(jane.fullTimeMonths, 1);
  assert.equal(jane.linked, true);
  // The running month never counts toward full time months.
  assert.equal(r.people.find((p) => p.staffId === 'sam').fullTimeMonths, 1);
  // Daybreak's own record is not on Provo's list.
  assert.ok(!r.people.some((p) => p.staffId === 'j-day'));
  assert.equal(ACA_FULL_TIME_MONTH, 130);
});

test('the company: full time plus equivalents (part time hours capped at 120, over 120), averaged over full months', () => {
  const months = ['2026-09', '2026-10'];
  const staff = Array.from({ length: 60 }, (_, i) => ({ id: `s${i}`, person_id: null, location_id: i % 2 ? 'provo' : 'daybreak', name: `S${i}` }));
  const rows = [];
  // September: 40 full time, 20 part time at 60 h (= 10 equivalents): 50.
  for (let i = 0; i < 60; i++) rows.push({ staff_id: `s${i}`, location_id: 'x', hours: i < 40 ? 150 : 60, month: '2026-09' });
  // October (running): would be 60 full time; it is not in the average.
  for (let i = 0; i < 60; i++) rows.push({ staff_id: `s${i}`, location_id: 'x', hours: 150, month: '2026-10' });
  const r = acaReport({ rows, staff, here: 'provo', months });
  assert.deepEqual(r.company.byMonth['2026-09'], { employees: 60, fullTime: 40, fte: 10, total: 50 });
  assert.equal(r.company.average, 50);
  assert.equal(r.company.large, true);
  // One hour short of 50 on average is not a large employer.
  rows[59].hours = 59;
  assert.equal(acaReport({ rows, staff, here: 'provo', months }).company.large, false);
  // A part timer's hours over 120 are capped.
  const cap = acaReport({ rows: [{ staff_id: 's1', hours: 125, month: '2026-09' }], staff, here: 'provo', months });
  assert.equal(cap.company.byMonth['2026-09'].fte, 1);
});

test('the US payroll screen shows the card and the server reads every site', () => {
  const ui = fs.readFileSync(new URL('../backoffice/sections/workforce/WfPayroll.jsx', import.meta.url), 'utf8');
  assert.match(ui, /\{usExport && <AcaCard ctx=\{ctx\} \/>\}/);
  assert.match(ui, /wf\.invokeCompute\('aca\.hours'/);
  const fn = fs.readFileSync(new URL('../../supabase/functions/workforce-compute/index.ts', import.meta.url), 'utf8');
  assert.match(fn, /if \(action === 'aca\.hours'\) \{/);
  assert.match(fn, /if \(pack\.country !== 'US'\) return json/);
  assert.match(fn, /acaReport\(\{ rows, staff: staffRows \?\? \[\], here: location_id, months \}\)/);
});
