// Multi site menu, 18 Oct 2026 recheck: a migration Ops has already run is never edited in place.
// 20261017c ran on Ops on 18 Oct; the follow up then wrote the category rule into that file, so the
// rule was in the repo and NOT in the database. The file is back exactly as Ops ran it (every msm_
// function body on Ops matched it, read only, 18 Oct) and the rule is its own step, 20261018.
// Each test here failed on the branch at 60fae462 and passes after the fix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { CATEGORY_UPDATE_FIELDS, categoryUpdateWords } from '../../../supabase/functions/_shared/msmModel.js';

const root = new URL('../../../', import.meta.url);
const exists = (p) => fs.existsSync(new URL(p, root));
const read = (p) => fs.readFileSync(new URL(p, root), 'utf8');
const ROUND2 = 'supabase/migrations/20261017c_OPS_multi_site_menu_groups.sql';
const RULE = 'supabase/migrations/20261018_OPS_multi_site_menu_category_fields.sql';
const RULE_RB = 'supabase/migrations/20261018_OPS_multi_site_menu_category_fields_ROLLBACK.sql';
const fnText = (sql, name) => { const i = sql.indexOf(`create or replace function public.${name}(`); return i < 0 ? '' : sql.slice(i, sql.indexOf('$fn$;', i)); };

// The file exactly as Peter ran it on Ops (18 Oct 2026). If this fails, the change belongs in a NEW
// migration: Ops will never see an edit to a file it has already run.
const ROUND2_AS_RUN = '23a546388f7492ea0376b064047c2d436bf61bfb4f37d92b9c0a4316943bfa70';

test('20261017c is byte for byte the file Ops ran on 18 Oct (any later change goes in a new migration)', () => {
  const sha = createHash('sha256').update(fs.readFileSync(new URL(ROUND2, root))).digest('hex');
  assert.equal(sha, ROUND2_AS_RUN, `${ROUND2} has been run on Ops. Put the change in a new migration instead.`);
  // What Ops holds: the round 2 guard has no category rule, and the check row has no column for it.
  assert.ok(!fnText(read(ROUND2), 'msm_changes_guard').includes("route_like_id'])"));
  assert.doesNotMatch(read(ROUND2), /category_fields_ok/);
});

test('20261018 holds the category rule: msmModel.CATEGORY_UPDATE_FIELDS and the same words, only on an existing category', () => {
  assert.ok(exists(RULE) && exists(RULE_RB), 'the category rule is its own migration with a roll back');
  const sql = read(RULE);
  const fn = fnText(sql, 'msm_changes_category_fields');
  assert.ok(fn, 'public.msm_changes_category_fields()');
  const m = /if new\.target = 'category' and new\.op <> 'create' and jsonb_typeof\(new\.after\) = 'object'\s+and exists \(select 1 from jsonb_object_keys\(new\.after\) k where k <> all \(array\[([^\]]+)\]\)\) then/.exec(fn);
  assert.ok(m, 'refuses other fields on a category that is not new');
  assert.deepEqual([...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]), [...CATEGORY_UPDATE_FIELDS]);
  const words = categoryUpdateWords({ target: 'category', op: 'update', after: { label: 'x' } });
  assert.ok(words && fn.includes(`raise exception '${words.replace(/'/g, "''")}' using errcode = '22023'`), 'the database says what the screen says');
  assert.match(fn, /return new;\s*end\s*$/);
  assert.doesNotMatch(fn, /security definer/, 'it reads no table, so it needs no extra rights');
});

test('20261018: its own trigger, after the main guard, additive, safe twice, closed to everyone, rolled back alone', () => {
  const sql = read(RULE);
  const rb = read(RULE_RB);
  // Triggers on one table fire in name order: msm_changes_guard first, then this one.
  const name = 'msm_changes_guard_category';
  assert.ok(['msm_changes_guard', name].sort().join() === `msm_changes_guard,${name}` && 'msm_changes_guard' < name);
  assert.match(sql, new RegExp(`drop trigger if exists ${name} on public\\.msm_changes;\\ncreate trigger ${name} before insert or update on public\\.msm_changes\\n  for each row execute function public\\.msm_changes_category_fields\\(\\);`));
  // Additive: it replaces no function another file made, touches no table, and changes no venue row.
  assert.deepEqual([...sql.matchAll(/create or replace function (public\.\w+)\(/g)].map((x) => x[1]), ['public.msm_changes_category_fields']);
  assert.doesNotMatch(sql, /\b(alter|drop) table\b|\b(insert into|update|delete from) public\.(menu|menus|modifier|config|msm)/i);
  assert.match(sql, /Run 20261017c_OPS_multi_site_menu_groups\.sql first/);
  assert.match(sql, /revoke all on function %s from public, anon, authenticated, service_role/);
  assert.doesNotMatch(sql, /grant execute/);
  assert.doesNotMatch(sql, /^\s*(begin|commit);/im, 'bare statements: the SQL editor runs the paste as one transaction');
  // The check row and what it should say.
  assert.match(sql, /category_fields_ok true, guards_in_order true, anon_function_rights 0,\n--   staged_category_fields 0/);
  assert.match(sql, /\) as category_fields_ok,[\s\S]*\) as guards_in_order,[\s\S]*\) as anon_function_rights,[\s\S]*\) as staged_category_fields,\s*public\.msm_sql_contract\(\) as contract;\s*$/);
  assert.match(rb, /drop trigger if exists msm_changes_guard_category on public\.msm_changes;\ndrop function if exists public\.msm_changes_category_fields\(\);/);
  assert.match(rb, /Run it BEFORE the 20261017c roll back/);
  assert.match(rb, /\) as functions_left;\s*$/);
  for (const [f, s] of [[RULE, sql], [RULE_RB, rb]]) {
    assert.doesNotMatch(s, /[^\t\n\r -~]/, `${f} is pure ASCII (the paste route garbles anything else)`);
  }
});

test('the harness runs 20261018 on top of 20261017c as Ops ran it, and rolls it back first', () => {
  const runner = read('supabase/tests/multi_site_menu/run.mjs');
  const edge = read('supabase/tests/multi_site_menu/edge.mjs');
  const at = (s) => runner.indexOf(s);
  assert.ok(at("'-f', MIG2]") > 0 && at("'-f', MIG3]") > at("'-f', MIG2]"), 'applied after round 2');
  assert.ok(at("'-f', RB3]") > 0 && at("'-f', RB3]") < at("'-f', RB2]"), 'rolled back before round 2');
  assert.match(edge, /'supabase\/migrations\/20261017c_OPS_multi_site_menu_groups\.sql', 'supabase\/migrations\/20261018_OPS_multi_site_menu_category_fields\.sql'\]/);
});
