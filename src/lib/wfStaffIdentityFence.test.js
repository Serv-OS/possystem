// src/lib/wfStaffIdentityFence.test.js
//
// v5.11.104: the text of 20261104a_OPS_wf_staff_identity_fence.sql and its ROLLBACK (the local Postgres
// proof is supabase/tests/wf_staff_identity_fence/run.mjs), and the wiring that keeps wf_staff's two
// identity columns (portal_user_id, pos_user_id) out of every Back Office write: the app's one till
// link call goes through the door, nothing in src writes the columns directly, every edge function
// that writes them is the service role, and every later migration that adds a wf_staff column calls
// the regrant helper (or the Back Office cannot write the new column).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const MIG = read('supabase/migrations/20261104a_OPS_wf_staff_identity_fence.sql');
const RB = read('supabase/migrations/20261104a_OPS_wf_staff_identity_fence_ROLLBACK.sql');
const DATA = read('src/staff/wfData.js');
const COLS = ['portal_user_id', 'pos_user_id', 'portal_invite_hash', 'portal_invite_expires'];

test('both files: ASCII only, no exclamation mark, Ops only guard, refuse a second run, 3 s lock wait, a visible check', () => {
  for (const [name, s] of [['migration', MIG], ['rollback', RB]]) {
    assert.ok([...s].every((c) => c.charCodeAt(0) < 128), `${name} is ASCII`);
    assert.ok(!s.includes('!'), `${name} has no exclamation mark (zsh pastes)`);
    assert.match(s, /to_regclass\('public\.billing_state'\) is not null/, `${name} refuses the Platform database`);
    assert.match(s, /set local lock_timeout = '3s';/, `${name} waits 3 s for a lock`);
    assert.match(s, /-- VISIBLE CHECK/, `${name} ends with a visible check`);
    assert.match(s, /notify pgrst, 'reload schema';/, `${name} reloads the API schema`);
  }
  assert.match(MIG, /has run already\. Nothing was changed\./);
  assert.match(RB, /is not in\. Nothing was changed\./);
  assert.ok(MIG.indexOf('do $guard$') < MIG.indexOf('create function'), 'the guard runs before any change');
});

test('the column fence: the whole table is revoked from authenticated and every other column granted one by one', () => {
  assert.match(MIG, /revoke insert, update on table public\.wf_staff from authenticated;/);
  assert.match(MIG, /select public\.wf_staff_regrant_api\(\) as columns_granted;/);
  for (const c of COLS) assert.ok(MIG.includes(`'${c}'`), `${c} is named in the regrant exclusion`);
  const helper = /create function public\.wf_staff_regrant_api\(\)[\s\S]*?\$f\$;/.exec(MIG)?.[0] || '';
  assert.match(helper, /column_name not in \('portal_user_id', 'pos_user_id', 'portal_invite_hash', 'portal_invite_expires'\)/);
  assert.match(helper, /grant insert \(%s\), update \(%s\) on table public\.wf_staff to authenticated/);
  assert.match(MIG, /revoke all on function public\.wf_staff_regrant_api\(\) from public, anon, authenticated, service_role;/);
  assert.doesNotMatch(MIG, /grant (insert|update|all)[^(;]*on table public\.wf_staff to (anon|authenticated)/, 'never the whole table back to an API role');
  assert.doesNotMatch(MIG, /revoke[^;]*select[^;]*wf_staff/, 'reading is not touched');
  assert.doesNotMatch(MIG, /create policy|drop policy/, 'no policy changes: the fence is privileges and a trigger');
});

test('the guard and the audit: security definer, fixed search path, not executable from the API, the stack decides the door', () => {
  for (const fn of ['wf_staff_identity_guard', 'wf_staff_identity_audit']) {
    assert.match(MIG, new RegExp(`create function public\\.${fn}\\(\\)\\s*returns trigger\\s*language plpgsql\\s*security definer\\s*set search_path = public, pg_temp as \\$f\\$`), `${fn} shape`);
    assert.match(MIG, new RegExp(`revoke all on function public\\.${fn}\\(\\) from public, anon, authenticated, service_role;`), `${fn} is hidden from the API`);
    assert.match(MIG, /v_ctx ~ 'function \(public\\\.\)\?wf_staff_set_pos_user\\\(uuid,uuid,text\\\)'/, 'the call stack names the door');
  }
  assert.match(MIG, /create trigger wf_staff_identity_guard_trg\s+before insert or update on public\.wf_staff/);
  assert.match(MIG, /create trigger wf_staff_identity_audit_trg\s+after insert or update of portal_user_id, pos_user_id on public\.wf_staff/);
  assert.match(MIG, /drop trigger if exists wf_staff_block_portal_cols_trg on public\.wf_staff;/, 'the 20260806j trigger is replaced');
  assert.match(MIG, /using errcode = '42501'/, 'a refusal is a permission error (HTTP 403 through PostgREST)');
  assert.match(MIG, /insert into public\.wf_audit \(location_id, org_id, actor_id, actor_name, action, entity, entity_id, reason, before, after\)/);
  assert.match(MIG, /'staff\.identity_changed'/);
});

test('the door: owner of the company or the super admin, second step, the till user is the company\'s and nobody else\'s', () => {
  const door = /create function public\.wf_staff_set_pos_user\(p_staff_id uuid, p_pos_user_id uuid, p_reason text default null\)[\s\S]*?\$f\$;/.exec(MIG)?.[0];
  assert.ok(door, 'the door exists with (staff, till user, reason)');
  assert.match(door, /returns jsonb\s*language plpgsql\s*security definer\s*set search_path = public, pg_temp/);
  assert.match(door, /public\.is_anon_session\(\)/);
  assert.match(door, /public\.second_step_ok\(\)/);
  assert.match(door, /public\.is_super_admin\(\)/);
  assert.match(door, /p\.role = 'owner' and p\.org_id is not null and p\.org_id = st\.org_id/);
  assert.match(door, /lower\(coalesce\(ul\.role, ''\)\) in \('owner', 'admin'\) and l\.org_id = st\.org_id/);
  assert.match(door, /for update;/, 'the staff row is locked');
  assert.match(door, /st\.status = 'leaver'/);
  assert.match(door, /belongs to another company/);
  assert.match(door, /already linked to another staff record/);
  assert.match(door, /'Only an owner of this company can link a till user to a staff record' using errcode = '42501'/);
  assert.match(MIG, /revoke all on function public\.wf_staff_set_pos_user\(uuid, uuid, text\) from public, anon;/);
  assert.match(MIG, /grant execute on function public\.wf_staff_set_pos_user\(uuid, uuid, text\) to authenticated, service_role;/);
});

test('the rollback puts the table grants and the 20260806j trigger back, keeps the audit rows', () => {
  assert.match(RB, /revoke insert, update on table public\.wf_staff from authenticated;\s*grant insert, update on table public\.wf_staff to authenticated;/);
  assert.match(RB, /create trigger wf_staff_block_portal_cols_trg\s+before update on public\.wf_staff/);
  const old = read('supabase/migrations/20260806j_portal_columns_locked.sql');
  const body = (s) => /create or replace function public\.wf_staff_block_portal_cols\(\)[\s\S]*?end \$\$;/.exec(s)?.[0].replace(/\s+/g, ' ');
  assert.equal(body(RB), body(old), 'the old guard comes back word for word');
  for (const t of ['wf_staff_identity_guard_trg', 'wf_staff_identity_audit_trg']) assert.match(RB, new RegExp(`drop trigger if exists ${t} on public\\.wf_staff;`));
  for (const f of ['wf_staff_identity_guard()', 'wf_staff_identity_audit()', 'wf_staff_set_pos_user(uuid, uuid, text)', 'wf_staff_regrant_api()']) assert.ok(RB.includes(`drop function if exists public.${f};`), `${f} is dropped`);
  assert.doesNotMatch(RB.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n'), /wf_audit/i, 'the audit rows are not touched');
});

test('the app: the till link goes through the door, with the pre migration fallback, and nothing else in src writes the columns', () => {
  assert.match(DATA, /supabase\.rpc\('wf_staff_set_pos_user', \{ p_staff_id: staffId, p_pos_user_id: posUserId, p_reason: reason \}\)/);
  assert.match(DATA, /error\.code === 'PGRST202' \|\| error\.code === '42883'/, 'only "the door does not exist" falls back to the direct write');
  const writers = [];
  const walk = (dir) => {
    for (const e of readdirSync(new URL(`../../${dir}/`, import.meta.url), { withFileTypes: true })) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory()) { if (e.name !== 'fixtures' && e.name !== 'node_modules') walk(p); continue; }
      if (!/\.(js|jsx|ts)$/.test(e.name) || /\.test\./.test(e.name)) continue;
      const s = read(p);
      // A write names the column as a key in an update, insert or upsert payload (or a quoted column name in a set).
      for (const c of ['portal_user_id', 'pos_user_id']) {
        const re = new RegExp(`(update|insert|upsert)\\((\\{[^)]*?)?\\b${c}\\s*:`, 'g');
        if (re.test(s)) writers.push(`${p}:${c}`);
      }
    }
  };
  walk('src');
  assert.deepEqual(writers.filter((w) => !w.startsWith('src/staff/wfData.js:pos_user_id')), [], 'no other client write of an identity column');
  assert.equal(writers.filter((w) => w === 'src/staff/wfData.js:pos_user_id').length, 1, 'the one direct write left is the fallback in markPosUser');
});

test('edge functions: every write of the columns is the service role client (admin)', () => {
  const dir = 'supabase/functions';
  const hits = [];
  for (const fn of readdirSync(new URL(`../../${dir}/`, import.meta.url), { withFileTypes: true })) {
    if (!fn.isDirectory()) continue;
    for (const f of readdirSync(new URL(`../../${dir}/${fn.name}/`, import.meta.url))) {
      if (!/\.(ts|js)$/.test(f)) continue;
      const s = read(`${dir}/${fn.name}/${f}`);
      const re = /(\w+)\.from\('wf_staff'\)[\s\S]{0,400}?\.(update|insert|upsert)\(\{[^}]*\b(portal_user_id|pos_user_id)\s*:/g;
      let m;
      while ((m = re.exec(s))) hits.push({ file: `${fn.name}/${f}`, client: m[1], col: m[3] });
    }
  }
  assert.ok(hits.length >= 2, `found the known writers (${JSON.stringify(hits)})`);
  for (const h of hits) assert.equal(h.client, 'admin', `${h.file} writes ${h.col} with the service role client`);
});

test('every migration after 20261104a that adds a wf_staff column calls wf_staff_regrant_api()', () => {
  const files = readdirSync(new URL('../../supabase/migrations/', import.meta.url)).filter((f) => f.endsWith('.sql') && f > '20261104a_OPS_wf_staff_identity_fence_ROLLBACK.sql').sort();
  const missing = [];
  for (const f of files) {
    const s = read(`supabase/migrations/${f}`);
    if (/alter table (public\.)?wf_staff\s+add column/i.test(s) && !/wf_staff_regrant_api\(\)/.test(s)) missing.push(f);
  }
  assert.deepEqual(missing, [], 'a later migration adds a wf_staff column without re granting it to the API (Back Office could not write it)');
});
