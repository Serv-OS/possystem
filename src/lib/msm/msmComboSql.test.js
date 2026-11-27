// msmComboSql.test.js: SQL 20261216a (a Combo's steps in the Multi site menu, 5.12.124) against the
// app's own model, and the house rules for a file made from the LIVE function text.
//
// 20261216a is generated from the three functions as live has them (read read only on 27 Nov 2026)
// by ~/.claude/servos-release/combo_stage2/gen_20261216a.py, and rehearsed against that text and
// end to end on the local rig (supabase/tests/multi_site_menu/combo.mjs, the checks named COMBO).
// msmMigration.test.js pins the files as Ops first ran them (they hold the lists of then, without
// `combo`); this file pins what 20261216a adds, so the database and msmModel.js cannot drift apart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { STAGE_FIELDS, KEPT_COLUMNS, VENUE_INSERT, VENUE_UPDATE, PRODUCT_COLUMN } from '../../../supabase/functions/_shared/msmModel.js';

const root = new URL('../../../', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
const MIG = read('supabase/migrations/20261216a_OPS_multi_site_menu_combo_steps.sql');
const RB = read('supabase/migrations/20261216a_OPS_multi_site_menu_combo_steps_ROLLBACK.sql');
const CHECK = read('supabase/tests/multi_site_menu/combo_check_20261216a.sql');
const RIG = read('supabase/tests/multi_site_menu/combo.mjs');
// The swap literals, as the database will read them ('' is one quote; chr(10) joins lines).
const plain = (sql) => sql.replace(/' \|\| chr\(10\) \|\| '/g, '\n').replace(/''/g, "'");
const P = plain(MIG);

const READ = { msm_changes_guard: 'e36061b4ce3b7974741e5e39b8dca496', msm_start_version: '188ea598a5d54f40932f5eae8583aeb0', msm_apply_site: '87be2da005dea0d49a4d068660ac8b8c' };
const AFTER = { msm_changes_guard: 'c71ea4a7fb8e221617b42ef0725aa8f2', msm_start_version: '2abda0780f63ce0ae2080ee49a0021f8', msm_apply_site: 'cded0bbdf09a050156cb9674ab0e815b' };

test('the model: a Combo\'s steps are a field of a group product, a column a site may keep, and a venue column publish writes', () => {
  assert.ok(STAGE_FIELDS.product.includes('combo'));
  assert.equal(PRODUCT_COLUMN.combo, 'combo');
  assert.ok(KEPT_COLUMNS.includes('combo'));
  assert.ok(VENUE_INSERT.items.includes('combo'));
  assert.ok(VENUE_UPDATE.items.includes('combo'));
});

test('20261216a adds `combo` (and only that) to each list the database checks, at the end, as msmModel.js has it', () => {
  // Each old list end, and the new one: the same with ", 'combo'" before the bracket.
  for (const [old, list] of [
    ["'archived', 'sort_order', 'family_base', 'tax_by_type']", STAGE_FIELDS.product],
    ["'parent_id', 'tax_overrides', 'no_price'];", KEPT_COLUMNS],
    ["'tags', 'item_code', 'tax_profile_id'];", VENUE_UPDATE.items],
  ]) {
    const next = old.replace(/\](;?)$/, ", 'combo']$1");
    assert.ok(P.includes(old) && P.includes(next), next);
    assert.equal(list[list.length - 1], 'combo', `msmModel ends the list with combo, as the database does: ${next}`);
  }
  // The new products' list (live holds tax_profile_id there since 20261209a; the model sends it only with a profile).
  assert.ok(P.includes("'tax_overrides', 'tax_profile_id'];") && P.includes("'tax_overrides', 'tax_profile_id', 'combo'];"));
  // The group menu saves the steps (insert and update) and the site's row gets them (insert and update).
  for (const s of [
    'family_base, tax_by_type, combo)', 'r.family_base, r.tax_by_type, r.combo\n', 'family_base, tax_by_type, combo, updated_at) =', 'r.family_base, r.tax_by_type, r.combo, now()',
    'tags, item_code, tax_overrides, tax_profile_id, combo, created_at, updated_at)', 'r.tax_profile_id, r.combo, v_now, v_now',
    'item_code, tax_profile_id, combo, tax_overrides, pricing, updated_at) =', 'r.item_code, r.tax_profile_id, r.combo,\n',
  ]) assert.ok(P.includes(s), s);
  // The checks: every product a step names is the group menu's own (or new in the draft), never the
  // Combo itself; publish refuses a step outside the menu, and a site item that is not that site's.
  assert.match(P, /raise exception 'A step of this Combo names a product that is not in this group menu\.' using errcode = '42501';/);

  assert.match(P, /public\.msm__ref_ok\(v_set\.menu_id, v_set\.id, 'product', v_vid::uuid\)/);
  assert.match(P, /raise exception 'Other changes in this set use this new product \(its sizes, an option, or a step of a Combo\)\. Remove those first\.'/);
  assert.match(P, /where not exists \(select 1 from public\.msm_products x where x\.id::text = e ->> 'itemId' and x\.menu_id = v\.menu_id\)\)\)\)/);
  assert.match(P, /raise exception 'A Combo would name a product that is not at this site\. Nothing was written\.';/);
  assert.match(P, /raise exception 'A new Combo would name a product that is not at this site\. Nothing was written\.';/);
  // The column and its check (the same loose shape as menu_items.combo).
  assert.match(MIG, /alter table public\.msm_products add column if not exists combo jsonb;/);
  assert.match(MIG, /check \(combo is null or \(jsonb_typeof\(combo\) = 'object' and coalesce\(jsonb_typeof\(combo -> 'steps'\), ''\) = 'array'\)\)/);
});

test('20261216a refuses unless the functions are the bodies read on live (or its own result), and needs 20261215a', () => {
  for (const [fn, md5] of Object.entries(READ)) {
    assert.ok(MIG.includes(`(p.proname = '${fn}' and md5(p.prosrc) not in ('${md5}', '${AFTER[fn]}'))`), fn);
    assert.ok(MIG.includes(`(p.proname = '${fn}' and md5(p.prosrc) = '${AFTER[fn]}'`) || MIG.includes(`md5(p.prosrc) = '${AFTER[fn]}' from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = '${fn}'`), `${fn} check row`);
  }
  assert.ok(MIG.indexOf('do $same$') < MIG.indexOf('alter table public.msm_products'), 'refused before anything is changed');
  assert.match(MIG, /raise exception 'Run 20261215a_OPS_menu_item_combo_steps\.sql first \(menu_items\.combo\)\. Nothing was changed\.';/);
  assert.match(MIG, /to_regclass\('public\.user_locations'\) is null or to_regclass\('public\.billing_state'\) is not null/);
  // Each line must be there exactly once, "not done already" makes a second run safe.
  assert.match(MIG, /if v_pairs\[i\] = v_name and position\(v_pairs\[i \+ 2\] in v_def\) = 0 then/);
  assert.match(MIG, /if v_n <> 1 then/);
  // One transaction from the SQL editor: no begin or commit of its own; the API reloads its schema.
  assert.ok(!/^\s*(begin|commit);/m.test(MIG));
  assert.match(MIG, /notify pgrst, 'reload schema';/);
  // The function goes out before the screens that stage steps (review of 27 Nov 2026).
  assert.match(MIG, /ORDER FOR PETER\n-- {3}1\. 20261215a_OPS_menu_item_combo_steps\.sql \(stage 1\), if not run already\.\n-- {3}2\. This file, on Ops \(SQL editor\)\.[^\n]*\n-- {3}3\. Then deploy the edge function msm-publish \(from release 5\.12\.124\)\.\n-- {3}4\. Then launch 5\.12\.124\./);
  // Ids are checked as the lowercase uuids the app makes (an uppercase id would refuse every publish later).
  assert.ok(P.includes("if v_vid !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' or v_vid = new.entity_id::text then"));
});

test('the roll back refuses while steps are anywhere, then puts the live bodies back and drops the column', () => {
  for (const words of ['still holds Combo steps', 'still carries Combo steps', 'still keeps its own Combo steps', 'still running carries Combo steps']) assert.ok(RB.includes(words), words);
  assert.match(RB, /where s\.status in \('draft', 'scheduled', 'running'\) and jsonb_typeof\(x\.after\) = 'object'/);   // a published set's history never blocks it
  assert.match(RB, /or \(jsonb_typeof\(x\.after -> 'kept'\) = 'object' and x\.after -> 'kept' \? 'combo'\)/);   // nor a draft where a site keeps its own steps
  assert.match(RB, /i := array_length\(v_pairs, 1\) - 2;\n\s+while i >= 1 loop/);   // backwards through the same list
  assert.match(RB, /alter table public\.msm_products drop column if exists combo;/);
  for (const [fn, md5] of Object.entries(READ)) assert.ok(RB.includes(`md5(p.prosrc) = '${md5}'`), `${fn} back as live has it`);
  // The site's own menu_items.combo is 20261215a's, and stays.
  assert.ok(!/menu_items drop/.test(RB));
});

test('the read only check, and the rig that rehearsed it all', () => {
  assert.ok(!/\b(insert|update|delete|alter|create|drop)\b/i.test(CHECK.replace(/--[^\n]*/g, '')), 'the check changes nothing');
  for (const md5 of Object.values(AFTER)) assert.ok(CHECK.includes(md5));
  assert.match(RIG, /the rig now runs the three functions exactly as read on live \(md5 of each body\)/);
  assert.match(RIG, /20261216a refuses when a function is not the body read on live/);
  assert.match(RIG, /the bodies it makes are the ones the generator worked out from the live text/);
  assert.match(RIG, /every function is back byte for byte \(md5 of each body as read on live\)/);
  assert.match(read('supabase/tests/multi_site_menu/run.mjs'), /await import\('\.\/combo\.mjs'\)/);
  for (const [fn, md5] of Object.entries(READ)) assert.ok(RIG.includes(`${fn}: '${md5}'`), fn);
  for (const [fn, md5] of Object.entries(AFTER)) assert.ok(RIG.includes(`${fn}: '${md5}'`), fn);
});
