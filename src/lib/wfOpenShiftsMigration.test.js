// src/lib/wfOpenShiftsMigration.test.js
//
// v5.11.101: the text of 20261031a_OPS_wf_open_shifts.sql and its ROLLBACK (the local Postgres proof is
// supabase/tests/wf_open_shifts/run.mjs), and the wiring that keeps the phone from ever being trusted:
// the staff app's identity comes from its login, the judge runs only as the service role, and a
// manager's decision goes through manager-approve's PIN or Back Office proof.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const MIG = read('supabase/migrations/20261031a_OPS_wf_open_shifts.sql');
const RB = read('supabase/migrations/20261031a_OPS_wf_open_shifts_ROLLBACK.sql');
const JUDGE = ['_wf_shift_hours', '_wf_onboarding_open', '_wf_claim_problem', '_wf_assign', '_wf_shift_snapshot', 'wf_shift_claim', 'wf_shift_drop', 'wf_swap_cancel', 'wf_swap_decline', 'wf_swap_decide'];

test('both files: ASCII only, no exclamation mark, Ops only guard, refuse a second run, 3 s lock wait', () => {
  for (const [name, s] of [['migration', MIG], ['rollback', RB]]) {
    assert.ok([...s].every((c) => c.charCodeAt(0) < 128), `${name} is ASCII`);
    assert.ok(!s.includes('!'), `${name} has no exclamation mark (zsh pastes)`);
    assert.match(s, /to_regclass\('public\.billing_state'\) is not null/, `${name} refuses the Platform database`);
    assert.match(s, /set local lock_timeout = '3s';/, `${name} waits 3 s for a lock`);
  }
  assert.match(MIG, /has run already\. Nothing was changed\./);
  assert.ok(MIG.indexOf('do $guard$') < MIG.indexOf('alter table'), 'the guard runs before any change');
  assert.match(MIG, /-- VISIBLE CHECK/);
  assert.match(RB, /-- VISIBLE CHECK/);
});

test('every judge function is SECURITY DEFINER where it touches rows, with a fixed search path, and only the service role may run it', () => {
  for (const fn of JUDGE) {
    const m = new RegExp(`create function public\\.${fn}\\([^)]*\\)\\s*returns[^$]*?set search_path = public, pg_temp as \\$f\\$`).exec(MIG);
    assert.ok(m, `${fn} sets its search path`);
    assert.ok(MIG.includes(`'public.${fn}(`), `${fn} is in the grants loop`);
  }
  for (const fn of ['_wf_onboarding_open', '_wf_claim_problem', '_wf_assign', 'wf_shift_claim', 'wf_shift_drop', 'wf_swap_cancel', 'wf_swap_decline', 'wf_swap_decide']) {
    assert.match(MIG, new RegExp(`create function public\\.${fn}\\([^)]*\\)\\s*returns \\w+ language plpgsql (stable )?security definer`), `${fn} is security definer`);
  }
  assert.match(MIG, /revoke all on function %s from public, anon, authenticated/);
  assert.match(MIG, /grant execute on function %s to service_role/);
  assert.doesNotMatch(MIG, /grant execute[^;]*to (anon|authenticated)/);
});

test('wf_swap_requests: direct writes go, no new policy is added, Back Office keeps reading', () => {
  for (const p of ['insert', 'update', 'delete']) assert.match(MIG, new RegExp(`drop policy if exists wf_swap_requests_rls_${p} on public\\.wf_swap_requests;`));
  assert.doesNotMatch(MIG, /create policy/, 'no new policy (none can call a function a role cannot execute)');
  assert.match(MIG, /revoke select, insert, update, delete on public\.wf_swap_requests from anon;/);
  assert.match(MIG, /revoke insert, update, delete on public\.wf_swap_requests from authenticated;/);
  assert.match(MIG, /grant select on public\.wf_swap_requests to authenticated;/);
  assert.match(MIG, /create unique index wf_swap_requests_one_live on public\.wf_swap_requests \(shift_id\)\s+where status in \('open', 'pending'\) and shift_id is not null;/);
});

test('the race: the claim locks the shift, then the request, then the person; the decision takes them in the same order', () => {
  const claim = MIG.slice(MIG.indexOf('create function public.wf_shift_claim'), MIG.indexOf('create function public.wf_shift_drop'));
  const iShift = claim.indexOf('from public.wf_shifts where id = p_shift_id for update');
  const iReq = claim.indexOf("status in ('open', 'pending') order by created_at desc limit 1 for update");
  const iStaff = claim.indexOf('from public.wf_staff where id = p_staff_id for update');
  assert.ok(iShift > 0 && iShift < iReq && iReq < iStaff, 'shift, request, person');
  const decide = MIG.slice(MIG.indexOf('create function public.wf_swap_decide'));
  const dShift = decide.indexOf('from public.wf_shifts where id = v_shift for update');
  const dReq = decide.indexOf('from public.wf_swap_requests where id = p_request_id for update');
  const dStaff = decide.indexOf('from public.wf_staff where id = rq.to_staff_id for update');
  assert.ok(dShift > 0 && dShift < dReq && dReq < dStaff, 'shift, request, person');
});

test('the rollback undoes everything the migration adds, and refuses while open shifts exist', () => {
  for (const fn of JUDGE) assert.match(RB, new RegExp(`drop function if exists public\\.${fn}\\(`), fn);
  for (const col of ['kind', 'note', 'claimed_at', 'decided_at', 'decided_by_id', 'decided_by_name', 'decided_how', 'shift_snapshot']) {
    assert.match(RB, new RegExp(`alter table public\\.wf_swap_requests drop column if exists ${col};`), col);
  }
  assert.match(RB, /alter table public\.wf_shifts alter column staff_id set not null;/);
  assert.match(RB, /alter table public\.wf_swap_requests alter column from_staff_id set not null;/);
  assert.match(RB, /grant select, insert, update, delete on public\.wf_swap_requests to anon, authenticated;/);
  assert.match(RB, /open shift\(s\) with nobody on them/);
  for (const p of ['insert', 'update', 'delete']) assert.match(RB, new RegExp(`create policy wf_swap_requests_rls_${p} on public\\.wf_swap_requests`));
});

test('the staff app never chooses who it is: the swap actions run after the login is resolved, with that staff row', () => {
  const sp = read('supabase/functions/staff-portal/index.ts');
  const iWho = sp.indexOf("const staff = await staffFromJwt(req);");
  const iSwap = sp.indexOf('const swapAnswer = await handleSwapAction(admin, staff, action, body);');
  assert.ok(iWho > 0 && iSwap > iWho, 'identity first');
  const os = read('supabase/functions/staff-portal/openShifts.ts');
  assert.doesNotMatch(os, /body\.staff_id|body\.location_id|body\.from_staff/, 'no staff or venue id from the phone');
  for (const rpc of ['wf_shift_claim', 'wf_shift_drop', 'wf_swap_cancel', 'wf_swap_decline']) {
    assert.match(os, new RegExp(`admin\\.rpc\\('${rpc}', \\{ p_staff_id: staff\\.id`), `${rpc} runs as the logged in staff member`);
  }
});

test('a manager decision: manager-approve, a manager PIN or a Back Office login, the database decides, audited', () => {
  const ma = read('supabase/functions/manager-approve/index.ts');
  const block = ma.slice(ma.indexOf("if (action === 'swap.decide')"), ma.indexOf('// ── po.raise'));
  assert.match(block, /sb\.rpc\('wf_swap_decide', \{ p_location_id: loc, p_request_id: target_id/);
  assert.match(block, /const auditErr = await audit\(loc, /);
  assert.match(block, /if \(auditErr\) return auditFailed\(/);
  // Not a staff PIN action: the default rule (canApprove) applies.
  assert.doesNotMatch(ma, /STAFF_PIN_ACTIONS = new Set\(\[[^\]]*swap/);
  assert.ok(!ma.includes("isStockAction = (action: string) => action === 'swap"), 'not a stock action');
});

test('the region follows the venue on the server too: Location settings copies a currency change to the Ops row', () => {
  const la = read('supabase/functions/location-admin/index.ts');
  assert.match(la, /if \('currency' in row && row\.currency\) \{\s+try \{\s+const \{ error: curErr \} = await opsAdmin\.from\('locations'\)\.update\(\{ currency: row\.currency \}\)\.eq\('id', ops\);/);
  // The server reads the venue's region from that row (never a client value).
  for (const fn of ['supabase/functions/staff-portal/openShifts.ts', 'supabase/functions/workforce-compute/index.ts']) {
    assert.match(read(fn), /from\('locations'\)\.select\('[^']*currency[^']*'\)/, fn);
  }
});

test('the reviewers\' rules: onboarding blocks a claim, a manager never decides their own swap, a declined claim on a dropped shift goes back up', () => {
  assert.match(MIG, /if public\._wf_onboarding_open\(st\.id,[\s\S]{0,200}?<> 'USD'\) then\s+return 'onboarding';/);
  const decide = MIG.slice(MIG.indexOf('create function public.wf_swap_decide'));
  assert.match(decide, /if rq\.kind = 'drop' then\s+update public\.wf_swap_requests set status = 'open', to_staff_id = null, claimed_at = null/);
  const ma = read('supabase/functions/manager-approve/index.ts');
  const block = ma.slice(ma.indexOf("if (action === 'swap.decide')"), ma.indexOf('// ── po.raise'));
  assert.ok(block.indexOf("code: 'self'") > 0 && block.indexOf("code: 'self'") < block.indexOf("sb.rpc('wf_swap_decide'"), 'refused before the database is asked');
  assert.match(block, /pos_user_id && tillIds\.has/);
  assert.match(block, /portal_user_id && loginIds\.has/);
  assert.match(block, /r\.outcome === 'reopened'/);
  const os = read('supabase/functions/staff-portal/openShifts.ts');
  assert.match(os, /onboardingOpen: openOnboardingSteps\(onbOf\[p\.id\] \?\? null, p, bankDetails\)/, 'the open shift text skips unfinished onboarding');
  const rota = read('src/backoffice/sections/workforce/WfRota.jsx');
  assert.match(rota, /onboardingOpen: onboardingBlock\(p\.id\) \? 1 : 0/);
  assert.match(rota, /timeZone: venueTz/, 'the venue clock decides what has started');
});
