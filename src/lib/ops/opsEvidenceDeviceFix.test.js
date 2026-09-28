// src/lib/ops/opsEvidenceDeviceFix.test.js
//
// Migration 20260928d: the storage rules on the private 'ops-evidence' bucket.
//
// Live on 28 Sep 2026 the tablet branch of all 3 rules read
//   exists (select 1 from public.ops_devices d where ... and (storage.foldername(name))[1] = d.location_id::text)
// and Postgres bound the unqualified `name` to ops_devices.name, the TABLET'S name, so a paired
// Operations tablet could never upload or open a checklist photo. These tests pin the fix: every
// rule names objects.name in full, in the 20260927a set form, with nothing looked up per row.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const MIG = '../../../supabase/migrations/';
const read = (f) => readFileSync(new URL(MIG + f, import.meta.url), 'utf8');
const FIX = read('20260928d_OPS_ops_evidence_device_fix.sql');
const ROLLBACK = read('20260928d_OPS_ops_evidence_device_fix_ROLLBACK.sql');
const SET_FORM = read('20260927a_OPS_rls_set_form.sql');
const CHECKLISTS = readFileSync(new URL('./checklists.js', import.meta.url), 'utf8');

// The header quotes the broken rule on purpose, so every check reads the SQL with comments removed.
const code = (sql) => sql.replace(/--[^\n]*/g, '');

const RULES = {
  ops_evidence_device_insert: 'insert',
  ops_evidence_device_update: 'update',
  ops_evidence_read: 'select',
};

const policies = (sql) =>
  [...code(sql).matchAll(/create policy\s+(\w+)\s+on\s+storage\.objects\s+for\s+(\w+)\s+to\s+(\w+)([^;]*);/gi)]
    .map(([whole, name, cmd, role, body]) => ({ whole, name, cmd: cmd.toLowerCase(), role, body }));

// the text inside the brackets that follow `using` or `with check`, brackets balanced
const clause = (body, keyword) => {
  const at = body.search(new RegExp(`\\b${keyword}\\s*\\(`, 'i'));
  if (at < 0) return null;
  const open = body.indexOf('(', at);
  let depth = 0;
  for (let i = open; i < body.length; i++) {
    if (body[i] === '(') depth++;
    if (body[i] === ')' && --depth === 0) return body.slice(open + 1, i);
  }
  throw new Error(`unbalanced brackets after ${keyword}`);
};

test('20260928d recreates exactly the 3 ops-evidence rules, same names, commands and role', () => {
  const got = policies(FIX);
  assert.deepEqual(got.map((p) => p.name).sort(), Object.keys(RULES).sort());
  for (const p of got) {
    assert.equal(p.cmd, RULES[p.name], `${p.name} keeps its command`);
    assert.equal(p.role, 'public', `${p.name} keeps role public`);
    assert.doesNotMatch(p.whole, /as\s+restrictive/i, `${p.name} stays permissive`);
    // re-runnable: dropped first, by the same name
    const drop = code(FIX).indexOf(`drop policy if exists ${p.name} on storage.objects;`);
    assert.ok(drop >= 0 && drop < code(FIX).indexOf(p.whole), `${p.name} is dropped before it is created`);
  }
});

test('no ops-evidence rule uses an unqualified foldername(name)', () => {
  const got = policies(FIX);
  assert.equal(got.length, 3);
  for (const p of got) {
    assert.doesNotMatch(p.body, /foldername\s*\(\s*name\s*\)/i, `${p.name}: foldername(name) can bind to another table's name`);
    const args = [...p.body.matchAll(/foldername\s*\(\s*([^)]*?)\s*\)/gi)].map((m) => m[1]);
    assert.ok(args.length > 0, `${p.name} checks the folder`);
    for (const a of args) assert.equal(a, 'objects.name', `${p.name}: every foldername() reads the photo's own path`);
  }
});

test('each rule is the 20260927a set form: the venue folder in ops_writable_location_uuids(), nothing per row', () => {
  const SET = '(storage.foldername(objects.name))[1] in (select l::text from public.ops_writable_location_uuids() as l)';
  const norm = (s) => s.replace(/\s+/g, ' ').trim();
  for (const p of policies(FIX)) {
    const using = clause(p.body, 'using');
    const check = clause(p.body, 'with check');
    if (p.cmd === 'insert') assert.equal(using, null, 'insert has no using');
    if (p.cmd === 'select') assert.equal(check, null, 'select has no with check');
    const parts = [using, check].filter(Boolean);
    assert.equal(parts.length, p.cmd === 'update' ? 2 : 1, `${p.name} has the clauses its command needs`);
    for (const part of parts) {
      assert.equal(norm(part), `objects.bucket_id = 'ops-evidence' and ${SET}`, `${p.name}: bucket plus venue folder, nothing else`);
    }
    // the old shape looked ops_devices up as the caller, per row; ops_devices_rls hides a tablet's own row there
    assert.doesNotMatch(p.body, /ops_devices|exists\s*\(|ops_can_write\s*\(|pos_can_access\s*\(/i, `${p.name} never looks devices up itself`);
  }
});

test('the guard stops the file before anything changes when 20260927a has not run', () => {
  const sql = code(FIX);
  const guard = sql.indexOf('do $guard$');
  assert.ok(guard >= 0, 'there is a guard');
  assert.ok(guard < sql.indexOf('drop policy'), 'the guard runs before the first drop');
  const body = sql.slice(guard, sql.indexOf('$guard$;', guard));
  assert.match(body, /to_regprocedure\('public\.ops_writable_location_uuids\(\)'\)/);
  assert.match(body, /raise exception '20260928d stopped, NOTHING changed: run 20260927a first/);
  assert.doesNotMatch(sql, /^\s*(begin|commit)\s*;/im, 'bare statements: the SQL editor runs the paste as one transaction');
});

test('the end check undoes everything if a rule came out wrong', () => {
  const sql = code(FIX);
  const check = sql.indexOf('do $check$');
  const lastCreate = Math.max(...policies(FIX).map((p) => sql.indexOf(p.whole)));
  assert.ok(check > lastCreate, 'the check runs after the last rule is created');
  const body = sql.slice(check, sql.indexOf('$check$;', check));
  for (const name of Object.keys(RULES)) assert.ok(body.includes(`'${name}'`), `the check covers ${name}`);
  assert.match(body, /!~ 'ops_writable_location_uuids'/);
  assert.match(body, /~ 'ops_devices'/);
  assert.match(body, /raise exception '20260928d stopped, NOTHING changed/);
});

test('the helper the rules lean on is Back Office plus the caller\'s active tablets, read as its owner', () => {
  const start = SET_FORM.indexOf('create or replace function public.ops_writable_location_uuids()');
  assert.ok(start >= 0, '20260927a defines the helper');
  const fn = SET_FORM.slice(start, SET_FORM.indexOf('$$;', SET_FORM.indexOf('as $$', start)));
  assert.match(fn, /returns setof uuid/);
  assert.match(fn, /security definer/, 'reads ops_devices past its Back Office only rule');
  assert.match(fn, /from public\.user_accessible_locations\(\) as k/, 'the Back Office branch');
  assert.match(fn, /union/);
  assert.match(fn, /from public\.ops_devices o\s+where o\.device_uid = auth\.uid\(\)\s+and o\.active\s+and o\.location_id is not null/, 'the tablet branch');
});

test('the rollback puts back the same 3 rules and needs nothing from 20260927a', () => {
  const got = policies(ROLLBACK);
  assert.deepEqual(got.map((p) => p.name).sort(), Object.keys(RULES).sort());
  for (const p of got) {
    assert.equal(p.cmd, RULES[p.name]);
    assert.equal(p.role, 'public');
    // exactly what was live: the tablet branch compared the tablet's own name
    assert.match(p.body, /\(storage\.foldername\(d\.name\)\)\[1\] = d\.location_id::text/);
    assert.match(p.body, /\(storage\.foldername\(objects\.name\)\)\[1\] in \(select public\.user_accessible_locations\(\)\)/);
  }
  assert.doesNotMatch(code(ROLLBACK), /ops_writable_location_uuids/);
  assert.ok(code(ROLLBACK).indexOf('do $guard$') < code(ROLLBACK).indexOf('drop policy'));
});

test('the app still writes each photo under its venue id, the folder the rules check', () => {
  assert.match(CHECKLISTS, /const EVIDENCE_BUCKET = 'ops-evidence';/);
  assert.match(CHECKLISTS, /const path = `\$\{locationId\}\/\$\{runId\}\/\$\{taskId\}\.\$\{safeExt\}`;/);
  assert.match(CHECKLISTS, /\.from\(EVIDENCE_BUCKET\)\.upload\(path, file, \{\s*upsert: true/);
});

test('no em or en dashes in either SQL file', () => {
  for (const [name, sql] of [['fix', FIX], ['rollback', ROLLBACK]]) {
    assert.doesNotMatch(sql, /[\u2013\u2014]/, `${name} file`);
  }
});
