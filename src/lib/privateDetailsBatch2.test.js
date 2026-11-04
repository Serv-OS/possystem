// src/lib/privateDetailsBatch2.test.js (5.12.57, US basics batch 2, Peter 3 Nov 2026): staff ID numbers and
// bank details are for owners, admins and logins with Can see payroll details, enforced in the database
// (20261120a; proven on a local Postgres by supabase/tests/private_details/run.sh). These pin the app side.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { privateAnswer } from '../staff/privateDetailsRules.js';
import { liveLabourFromSnapshot } from './manager/team.js';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const PRIVATE = ['ni_number', 'ssn_last4', 'tax_ref', 'bank_sort_code', 'bank_account', 'bank_account_name'];

test('the door answer: rows become details by id; nothing back for people asked = hidden', () => {
  const a = privateAnswer(['s1', 's2'], [{ staff_id: 's1', ni_number: 'QQ123456C', bank_account: '12345678', ssn_last4: null }]);
  assert.equal(a.hidden, false);
  assert.equal(a.byId.s1.niNumber, 'QQ123456C');
  assert.equal(a.byId.s1.bankAccount, '12345678');
  assert.equal(a.byId.s2, undefined);
  assert.deepEqual(privateAnswer(['s1'], []), { byId: {}, hidden: true });
  assert.deepEqual(privateAnswer([], []), { byId: {}, hidden: false });
});

test('the Back Office staff reads never name a private column; saves read back named columns only', () => {
  const wf = read('src/staff/wfData.js');
  const cols = /const STAFF_COLS = '([^']+)';/.exec(wf)?.[1] || '';
  assert.ok(cols.length > 50, 'STAFF_COLS found');
  for (const c of PRIVATE) assert.ok(!cols.split(',').includes(c), `${c} is not in the staff list read`);
  const load = wf.slice(wf.indexOf('export async function loadStaff'), wf.indexOf('export async function saveStaff'));
  for (const c of PRIVATE) assert.ok(!load.includes(c), `loadStaff never asks for ${c}`);
  const save = wf.slice(wf.indexOf('export async function saveStaff'), wf.indexOf('export async function softDeleteStaff'));
  assert.doesNotMatch(save, /\.select\(\)\.single\(\)/, 'no select of every column after a staff save');
  const door = read('src/staff/privateDetails.js');
  assert.match(door, /supabase\.rpc\('wf_staff_private_details', \{ p_staff_ids: want \}\)/);
});

test('Workforce shows Hidden and never sends a hidden value back', () => {
  const w = read('src/backoffice/sections/Workforce.jsx');
  assert.match(w, /loadPrivateDetails\(ids\)/);
  assert.match(w, /privateOk \? \(s\.niNumber \|\| '—'\) : HIDDEN_WORDS/);
  assert.match(w, /if \(isEdit && !privateOk\) \{ if \(!String\(f\.niNumber \|\| ''\)\.trim\(\)\) delete payload\.niNumber;/);
  assert.match(w, /ctx, staff: staffView, privateHidden: !privateOk,/);
  assert.match(read('src/backoffice/sections/workforce/WfPayroll.jsx'), /privateHidden && \(/);
});

test('Team: the tick is changed only through the owner door', () => {
  const t = read('src/backoffice/sections/StaffManager.jsx');
  assert.match(t, /supabase\.rpc\('set_payroll_details', \{ p_user: link\.authUserId, p_on: on \}\)/);
  assert.doesNotMatch(t, /\.update\(\{[^}]*payroll_details/, 'never a direct write of the tick');
});

test('Manager app: live labour is a total; no one\'s hourly rate leaves the server', () => {
  const ms = read('supabase/functions/manager-snapshot/index.ts');
  assert.match(ms, /team: full \? \{ punches, shifts: teamShifts, labourLive,/);
  assert.doesNotMatch(ms, /teamShifts, ratesMinor/);
  // 10.00 so far, 24.00 an hour burning, 30 minutes on: 22.00.
  assert.equal(liveLabourFromSnapshot({ soFarMinor: 1000, burnMinorPerHour: 2400, atMs: 0 }, 30 * 60000), 2200);
  assert.equal(liveLabourFromSnapshot(null), 0);
});

test('migration 20261120a: ASCII, Ops only, the six columns closed, the door and the tick, a visible check', () => {
  const m = read('supabase/migrations/20261120a_OPS_wf_staff_private_details.sql');
  const rb = read('supabase/migrations/20261120a_OPS_wf_staff_private_details_ROLLBACK.sql');
  for (const s of [m, rb]) { assert.ok([...s].every((c) => c.charCodeAt(0) < 128)); assert.ok(!s.includes('!')); }
  assert.match(m, /to_regclass\('public\.billing_state'\) is not null/);
  assert.match(m, /set local lock_timeout = '3s';/);
  for (const c of PRIVATE) assert.ok(m.includes(`'${c}'`), `${c} is closed`);
  assert.match(m, /create or replace function public\.wf_staff_private_details\(p_staff_ids uuid\[\]\)/);
  assert.match(m, /create or replace function public\.set_payroll_details\(p_user uuid, p_on boolean\)/);
  assert.match(m, /coalesce\(public\.is_super_admin\(\), false\)/, 'a null never skips the owner check');
  assert.match(m, /perform public\.wf_staff_regrant_select\(\);/, 'the regrant helper keeps the reads in step');
  assert.match(m, /-- VISIBLE CHECK/);
  assert.match(rb, /grant select on table public\.wf_staff to anon, authenticated;/);
});
