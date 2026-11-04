// src/lib/headOffice.test.js: head office staff (5.12.56, UK and US).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  headOfficeOn, isHeadOffice, headOfficePay, headOfficeCost, employedDays, salaryOf, PERIODS_PER_YEAR,
} from '../../supabase/functions/_shared/headOffice.js';
import { readFileSync } from 'node:fs';
import { isHeadOfficeStaff, rotaStaffOf, headOfficeSwitchOn, headOfficeLineView } from './headOffice.js';
const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

test('the switch: only a real true turns head office on', () => {
  assert.equal(headOfficeOn({ headOffice: true }), true);
  for (const off of [undefined, null, {}, { headOffice: 'true' }, { headOffice: 1 }, { headOffice: false }]) assert.equal(headOfficeOn(off), false);
});

test('a ticked person is head office only while the site switch is on', () => {
  const ticked = { head_office: true };
  assert.equal(isHeadOffice(ticked, { headOffice: true }), true);
  assert.equal(isHeadOffice(ticked, {}), false, 'switch off: reads exactly as before');
  assert.equal(isHeadOffice({ head_office: false }, { headOffice: true }), false);
  assert.equal(isHeadOffice(null, { headOffice: true }), false);
});

test('a full period pays the salary over the periods in a year, whatever the month length', () => {
  assert.deepEqual(PERIODS_PER_YEAR, { weekly: 52, fortnightly: 26, fourweekly: 13, semimonthly: 24, monthly: 12 });
  const feb = headOfficePay({ salaryAnnual: 36000, from: '2027-02-01', to: '2027-02-28', periodType: 'monthly' });
  const mar = headOfficePay({ salaryAnnual: 36000, from: '2027-03-01', to: '2027-03-31', periodType: 'monthly' });
  assert.equal(feb.pay, 3000); assert.equal(mar.pay, 3000); assert.equal(feb.basis, 'period');
  assert.equal(headOfficePay({ salaryAnnual: 52000, from: '2026-11-02', to: '2026-11-08', periodType: 'weekly' }).pay, 1000);
  assert.equal(headOfficePay({ salaryAnnual: 52000, from: '2026-11-02', to: '2026-11-15', periodType: 'fortnightly' }).pay, 2000);
  assert.equal(headOfficePay({ salaryAnnual: 52000, from: '2026-11-02', to: '2026-11-29', periodType: 'fourweekly' }).pay, 4000);
  assert.equal(headOfficePay({ salaryAnnual: 48000, from: '2026-11-16', to: '2026-11-30', periodType: 'semimonthly' }).pay, 2000);
});

test('a start or a leave inside the period pays the days employed', () => {
  // Started on the 16th of a 30 day month: 15 of 30 days of 3,000.
  const r = headOfficePay({ salaryAnnual: 36000, from: '2026-11-01', to: '2026-11-30', periodType: 'monthly', startDate: '2026-11-16' });
  assert.equal(r.pay, 1500); assert.equal(r.basis, 'part'); assert.equal(r.days, 15); assert.equal(r.periodDays, 30);
  // Left on the 10th: 10 of 30 days.
  assert.equal(headOfficePay({ salaryAnnual: 36000, from: '2026-11-01', to: '2026-11-30', periodType: 'monthly', leaverDate: '2026-11-10' }).pay, 1000);
  // Started after the period, or left before it: nothing.
  assert.equal(headOfficePay({ salaryAnnual: 36000, from: '2026-11-01', to: '2026-11-30', periodType: 'monthly', startDate: '2026-12-01' }).pay, 0);
  assert.equal(headOfficePay({ salaryAnnual: 36000, from: '2026-11-01', to: '2026-11-30', periodType: 'monthly', leaverDate: '2026-10-31' }).pay, 0);
});

test('an unknown period type pays salary times days over 365; no salary pays 0', () => {
  const r = headOfficePay({ salaryAnnual: 36500, from: '2026-11-01', to: '2026-11-10', periodType: 'custom' });
  assert.equal(r.pay, 1000); assert.equal(r.basis, 'days');
  // A two month window on a monthly site is not one period: paid by the day, never one month's 3,000.
  const two = headOfficePay({ salaryAnnual: 36500, from: '2026-11-01', to: '2026-12-31', periodType: 'monthly' });
  assert.equal(two.basis, 'days'); assert.equal(two.pay, 6100);
  for (const s of [null, undefined, 0, -5, 'abc']) assert.equal(headOfficePay({ salaryAnnual: s, from: '2026-11-01', to: '2026-11-30', periodType: 'monthly' }).pay, 0);
  assert.equal(salaryOf({ salary_annual: '42000' }), 42000);
  assert.equal(salaryOf({ salary_annual: 0 }), null);
});

test('employed days count calendar days, both ends included', () => {
  assert.equal(employedDays({ from: '2026-11-01', to: '2026-11-30' }), 30);
  assert.equal(employedDays({ from: '2026-11-01', to: '2026-11-01' }), 1);
  assert.equal(employedDays({ from: '2026-03-01', to: '2026-03-31' }), 31, 'a clock change month is still 31 days');
  assert.equal(employedDays({ from: '2026-11-01', to: '2026-11-30', startDate: '2026-11-30' }), 1);
});

test('the company line: each salary spread over 365 days, leavers and empty salaries left out', () => {
  const staff = [
    { salary_annual: 36500 },                                  // 100 a day
    { salary_annual: 73000, start_date: '2026-11-06' },        // 200 a day from the 6th
    { salary_annual: 36500, leaver_date: '2026-10-31' },       // left before the window
    { salary_annual: null },                                   // no salary set yet
  ];
  const r = headOfficeCost(staff, { from: '2026-11-01', to: '2026-11-07' });
  assert.equal(r.cost, 700 + 400);
  assert.equal(r.people, 2);
  assert.deepEqual(headOfficeCost([], { from: '2026-11-01', to: '2026-11-07' }), { cost: 0, people: 0 });
});

// ── The Back Office side (src/lib/headOffice.js) and the wiring ─────────────

test('Back Office: the switch lives in the settings bag; the rota leaves out head office only while it is on', () => {
  const on = { settings: { headOffice: true } }, off = { settings: {} };
  const staff = [{ id: 'a', headOffice: true }, { id: 'b', headOffice: false }, { id: 'c' }];
  assert.equal(headOfficeSwitchOn(on), true); assert.equal(headOfficeSwitchOn(off), false); assert.equal(headOfficeSwitchOn(null), false);
  assert.equal(isHeadOfficeStaff(staff[0], on), true); assert.equal(isHeadOfficeStaff(staff[0], off), false);
  assert.deepEqual(rotaStaffOf(staff, on).map((s) => s.id), ['b', 'c']);
  assert.deepEqual(rotaStaffOf(staff, off).map((s) => s.id), ['a', 'b', 'c'], 'off: everyone, exactly as before');
});

test('Owner app line words: the day or the period, one person or people, never in labour', () => {
  const ho = { today: 300, period: 700, people: 2, shared: false };
  assert.deepEqual(headOfficeLineView(ho, true), { amount: 300, words: '2 people · not in labour %' });
  assert.deepEqual(headOfficeLineView({ ...ho, people: 1 }, false), { amount: 700, words: '1 person · not in labour %' });
  assert.equal(headOfficeLineView(null, true), null);
  assert.equal(headOfficeLineView(undefined, false), null);
});

test('wiring: settings for UK and US, the form writes only while on, the rota, payroll, clock in, open shifts, Owner app', () => {
  const settingsJsx = read('src/backoffice/sections/workforce/WfSettings.jsx');
  assert.match(settingsJsx, /headOffice: headOffice === true,/, 'saved for every venue, not inside a US only spread');
  assert.doesNotMatch(settingsJsx, /pack\.country === 'US' \? \{ headOffice/);
  const wf = read('src/backoffice/sections/Workforce.jsx');
  assert.match(wf, /<WfRota \{\.\.\.sectionProps\} staff=\{rotaStaffOf\(staff, settings\)\} \/>/);
  assert.match(wf, /if \(headOffice\) \{ payload\.headOffice = ho\.on; payload\.salaryAnnual =/);
  assert.match(wf, /headOffice=\{headOfficeSwitchOn\(settings\)\}/);
  const data = read('src/staff/wfData.js');
  assert.match(data, /if \(member\.headOffice !== undefined\) row\.head_office = member\.headOffice === true;/);
  assert.match(data, /if \(error && \/head_office\|salary_annual\|42703\|PGRST204\/i\.test/, 'a database before 20261119a still lists staff');
  const wfc = read('supabase/functions/workforce-compute/index.ts');
  assert.match(wfc, /if \(headOfficeOn\(policy\)\) \{/);
  assert.match(wfc, /select\('settings, premiums, pay_period_type'\)/);
  assert.match(wfc, /isHeadOffice\(st, \(vsRow\?\.settings as any\) \?\? null\)/, 'time off pays no hourly holiday on top of the salary');
  const wcl = read('supabase/functions/workforce-clock/index.ts');
  assert.match(wcl, /if \(isHeadOffice\(staff, \(hoRow as any\)\?\.settings \?\? null\)\) return json\(\{ error: HEAD_OFFICE_CLOCK_WORDS/);
  const sp = read('supabase/functions/staff-portal/index.ts');
  assert.match(sp, /records: ctx\.clockRecords/);
  assert.doesNotMatch(sp, /pickClockTarget\(\{ now: Date\.now\(\), records: ctx\.records/, 'clock in never targets a head office record');
  assert.match(read('supabase/functions/staff-portal/openShifts.ts'), /return err\(409, HEAD_OFFICE_SHIFT_WORDS, 'head_office'\)/);
  assert.match(read('src/surfaces/TimeClockSurface.jsx'), /s\.state === 'out' && !s\.headOffice && <BigBtn icon="clock" label="Clock in"/);
  assert.match(read('src/surfaces/OwnerSurface.jsx'), /headOfficeLineView\(r\?\.head_office, rv\.period === 'today'\)/);
  // 5.12.57: the staff app shows the words instead of a Clock in button (no location prompt first).
  const card = read('src/staff/ClockCard.jsx');
  assert.match(card, /\{!onShift && !state\?\.head_office && \(/);
  assert.match(card, /state\?\.head_office && !onShift && \(/);
});

test('migration 20261119a: ASCII, Ops only, 3 s lock wait, grants the columns to the API, a visible check; the rollback', () => {
  const m = read('supabase/migrations/20261119a_OPS_wf_head_office.sql');
  const rb = read('supabase/migrations/20261119a_OPS_wf_head_office_ROLLBACK.sql');
  for (const s of [m, rb]) { assert.ok([...s].every((c) => c.charCodeAt(0) < 128)); assert.ok(!s.includes('!'), 'no exclamation mark (zsh pastes)'); }
  assert.match(m, /add column if not exists head_office boolean not null default false/);
  assert.match(m, /add column if not exists salary_annual numeric\(12,2\)/);
  assert.match(m, /to_regclass\('public\.billing_state'\) is not null/);
  assert.match(m, /set local lock_timeout = '3s';/);
  assert.match(m, /select public\.wf_staff_regrant_api\(\) as columns_granted;/);
  assert.match(m, /notify pgrst, 'reload schema';/);
  assert.match(m, /as head_office_ready/);
  assert.match(rb, /drop column if exists head_office;/);
});
