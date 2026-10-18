// Multi site menu: source pins. The migration's allowlists are the SAME lists as msmModel.js (one
// side changed alone is the drift class that bites), every table is under row level security and
// the second step fence, every function is closed to the public key, and the new files keep the
// house rules (no long dashes, no unpaged read over 1,000 rows, no 'loc-demo' default).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import {
  STAGE_FIELDS, KEPT_COLUMNS, CHANNELS, VENUE_INSERT, VENUE_UPDATE, PRICING_KEYS, TARGETS, ORDER_TYPE_TAX_KEYS, GROUP_KEPT_COLUMNS,
  OPTION_KEPT_KEYS, SELECTION_TYPES, WRITE_KEYS, MAP_KEYS, OPTION_ENTRY_KEYS, OPTION_PATCH_KEYS, SQL_CONTRACT, ORDER_TYPES,
} from '../../../supabase/functions/_shared/msmModel.js';

const root = new URL('../../../', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
const SQL1 = read('supabase/migrations/20261017_OPS_multi_site_menu.sql');
const SQL2 = read('supabase/migrations/20261017c_OPS_multi_site_menu_groups.sql');
const RB = read('supabase/migrations/20261017_OPS_multi_site_menu_ROLLBACK.sql');
const RB2 = read('supabase/migrations/20261017c_OPS_multi_site_menu_groups_ROLLBACK.sql');
const arr = (text) => [...text.matchAll(/'([^']+)'/g)].map((m) => m[1]);
const between = (s, a, b) => { const i = s.indexOf(a); assert.ok(i >= 0, `missing: ${a}`); const j = s.indexOf(b, i + a.length); return s.slice(i + a.length, j); };
// The NEWEST definition of a function: round 2 (20261017c) replaces some of round 1's whole.
const fnText = (sql, name) => { const i = sql.indexOf(`create or replace function public.${name}(`); if (i < 0) return null; return sql.slice(i, sql.indexOf('$fn$;', i)); };
const newest = (name) => fnText(SQL2, name) || fnText(SQL1, name);
// SQL is "the database as it stands after both files": the newest function bodies.
const SQL = SQL1 + '\n' + SQL2;

const TABLES = ['msm_company', 'msm_members', 'msm_menus', 'msm_menu_sites', 'msm_site_groups', 'msm_categories', 'msm_category_sites',
  'msm_modifier_groups', 'msm_modifier_group_sites', 'msm_products', 'msm_product_sites', 'msm_change_sets', 'msm_changes', 'msm_versions', 'msm_version_sites'];

test('the staging allowlist in the database is msmModel.STAGE_FIELDS, target by target (the newest guard)', () => {
  const guard = between(newest('msm_changes_guard'), 'v_allowed := case new.target', 'end;');
  for (const [target, fields] of Object.entries(STAGE_FIELDS)) {
    const m = new RegExp(`when '${target}' then array\\[([^\\]]+)\\]`).exec(guard);
    assert.ok(m, `no list for ${target}`);
    assert.deepEqual(arr(m[1]), fields, target);
  }
});

test('kept columns, channels, order type VAT keys, group and option kept keys, choice kinds: the same lists on both sides', () => {
  const guard = newest('msm_changes_guard');
  assert.deepEqual(arr(between(guard, 'v_kept     constant text[] := array[', ']')), [...KEPT_COLUMNS]);
  assert.deepEqual(arr(between(guard, 'v_channels constant text[] := array[', ']')), [...CHANNELS]);
  assert.deepEqual(arr(between(guard, 'v_tax_keys constant text[] := array[', ']')), [...ORDER_TYPE_TAX_KEYS]);
  assert.deepEqual(arr(between(guard, 'v_group_kept  constant text[] := array[', ']')), [...GROUP_KEPT_COLUMNS]);
  assert.deepEqual(arr(between(guard, 'v_option_kept constant text[] := array[', ']')), [...OPTION_KEPT_KEYS]);
  assert.deepEqual(arr(between(guard, 'v_selection   constant text[] := array[', ']')), [...SELECTION_TYPES]);
  const imp = newest('msm_import_commit');
  assert.deepEqual(arr(between(imp, "where k <> all (array['cat'", ']')).length + 1, KEPT_COLUMNS.length, 'the import checks the same kept list');
  assert.deepEqual(['cat', ...arr(between(imp, "where k <> all (array['cat'", ']'))], [...KEPT_COLUMNS]);
  assert.deepEqual(arr(between(imp, "where k <> all (array['name', 'min'", ']')).length + 2, GROUP_KEPT_COLUMNS.length);
  assert.deepEqual(arr(between(newest('msm__import_options'), 'where k <> all (array[', ']')), [...OPTION_KEPT_KEYS]);
});

test('the order types a menu can show: msmModel.ORDER_TYPES is msm_set_order_types\'s list', () => {
  assert.deepEqual(arr(between(newest('msm_set_order_types'), 'where t <> all (array[', ']')), [...ORDER_TYPES]);
});

test('the nine change targets: msmModel.TARGETS is the database constraint', () => {
  const c = between(SQL2, 'add constraint msm_changes_target_ok check (target in (', '));');
  assert.deepEqual(arr(c), [...TARGETS]);
});

test('the contract: msm_sql_contract() is msmModel.SQL_CONTRACT; apply_site knows exactly WRITE_KEYS and MAP_KEYS; msm-publish refuses below it', () => {
  assert.match(newest('msm_sql_contract'), new RegExp(`select ${SQL_CONTRACT};`));
  const apply = newest('msm_apply_site');
  assert.deepEqual(arr(between(apply, 'v_write_keys constant text[] := array[', ']')), [...WRITE_KEYS]);
  assert.deepEqual(arr(between(apply, 'v_map_keys   constant text[] := array[', ']')), [...MAP_KEYS]);
  assert.deepEqual(arr(between(apply, 'v_opt_keys   constant text[] := array[', ']')), [...OPTION_ENTRY_KEYS]);
  assert.deepEqual(arr(between(apply, 'v_opt_patch  constant text[] := array[', ']')), [...OPTION_PATCH_KEYS]);
  assert.deepEqual(arr(between(apply, 'v_upd_groups constant text[] := array[', ']')), [...VENUE_UPDATE.groups]);
  assert.deepEqual(arr(between(apply, 'v_tax_keys   constant text[] := array[', ']')), [...ORDER_TYPE_TAX_KEYS]);
  // 17 Oct verification: only an OLDER runner reaches this check, so the words say to redeploy it.
  assert.match(apply, /The publish runner is older than the database: redeploy msm-publish, then press Retry\. Nothing was written\./);
  const fn = read('supabase/functions/msm-publish/index.ts');
  assert.match(fn, /if \(\(await sqlContract\(\)\) < SQL_CONTRACT\) return await fail\(CONTRACT_WORDS, 5\);/);
  assert.match(fn, /Run 20261017c first/);
});

test('round 2 apply: every named row locked BEFORE the fingerprint; the follow block gone; group pushes rebuilt from the row', () => {
  const apply = newest('msm_apply_site');
  const lock = apply.indexOf('from public.menu_items i\n   where i.location_id = p_location and i.id in');
  const fp = apply.indexOf('if p_fingerprint is distinct from public.msm_venue_fingerprint(p_location)');
  assert.ok(lock > 0 && fp > lock, 'locks first, then the fingerprint');
  assert.ok(apply.includes('order by g.id for update'), 'option groups locked too');
  assert.ok(!apply.includes("p_writes -> 'options'"), 'no follow block');
  assert.ok(apply.includes("v_snap := jsonb_set(v_snap, '{modifierGroupDefs}'"), 'the push entries of written groups are rebuilt');
  // Items inserted before groups (an option may point at a sub item this publish adds).
  assert.ok(apply.indexOf("p_writes #> '{items,insert}'") < apply.indexOf("p_writes #> '{groups,insert}'"));
  // tax_profile_id: only the two allowed writes, both through the mirror check (the clear accepts a
  // copy of the rate after the write, or before it when the same write changes the rate: 17 Oct
  // verification, so the mirror check is named three times).
  assert.equal((apply.match(/msm__is_legacy_mirror\(/g) || []).length, 3);
  assert.match(apply, /or public\.msm__is_legacy_mirror\(v_prof_old::uuid, nullif\(v_old ->> 'tax_rate_id', ''\)::uuid\)\) then\n\s*raise exception 'Publish may only clear an old copy/);
});

test('the venue columns publish may write are msmModel.VENUE_INSERT / VENUE_UPDATE / PRICING_KEYS', () => {
  const apply = newest('msm_apply_site');
  const list = (name) => arr(between(apply, `${name} constant text[] := array[`, ']'));
  assert.deepEqual(list('v_ins_menus '), VENUE_INSERT.menus);
  assert.deepEqual(list('v_ins_cats  '), VENUE_INSERT.categories);
  assert.deepEqual(list('v_ins_items '), VENUE_INSERT.items);
  assert.deepEqual(list('v_ins_groups'), VENUE_INSERT.groups);
  assert.deepEqual(list('v_upd_menus '), VENUE_UPDATE.menus);
  assert.deepEqual(list('v_upd_cats  '), VENUE_UPDATE.categories);
  assert.deepEqual(list('v_upd_items '), VENUE_UPDATE.items);
  assert.deepEqual(list('v_pricing   '), [...PRICING_KEYS]);
  for (const owned of ['centre_id', 'tax_overrides', 'option_group_order', 'lock_pricing', 'locked_fields', 'master_id']) {
    assert.ok(!VENUE_UPDATE.items.includes(owned), `${owned} is venue owned (tax_overrides is only ever a four key patch)`);
  }
});

const TABLES2 = ['msm_modifier_options', 'msm_modifier_option_sites'];

test('every msm_ table: row level security on, public and anon revoked by name, the second step fence, dropped by the roll back', () => {
  for (const [sql, rb, tables] of [[SQL1, RB, TABLES], [SQL2, RB2, TABLES2]]) {
    const created = [...sql.matchAll(/create table if not exists public\.(msm_\w+)/g)].map((m) => m[1]).sort();
    assert.deepEqual(created, [...tables].sort());
    const rlsLoop = between(sql, 'do $rls$', '$rls$;');
    const fence = between(sql, 'do $second_step$', '$second_step$;');
    for (const t of tables) {
      assert.ok(rlsLoop.includes(`'${t}'`), `${t} in the row level security loop`);
      assert.ok(fence.includes(`'${t}'`), `${t} fenced`);
      assert.match(rb, new RegExp(`drop table if exists public\\.${t};`), `${t} rolled back`);
    }
    assert.match(rlsLoop, /revoke all on table public\.%I from public, anon, authenticated/);
  }
  // The round 2 tables have a read rule and NO write rule (written only by the functions).
  for (const t of TABLES2) {
    assert.match(SQL2, new RegExp(`create policy ${t}_read on public\\.${t} as permissive for select to authenticated`));
    assert.ok(!new RegExp(`create policy ${t}_(insert|update|delete)`).test(SQL2));
  }
});

test('every function is closed to everyone first, by name, then opened to exactly who needs it (each file its own)', () => {
  for (const [sql, rb, rollsBackTo] of [[SQL1, RB, null], [SQL2, RB2, SQL1]]) {
    const defs = [...sql.matchAll(/create or replace function (public\.msm\w*)\(/g)].map((m) => m[1]);
    const grants = between(sql, 'do $grants$', '$grants$;');
    const revoked = between(grants, 'foreach f in array array[', '] loop');
    for (const f of new Set(defs)) assert.ok(revoked.includes(`'${f}(`), `${f} is revoked from public, anon, authenticated, service_role`);
    assert.match(grants, /revoke all on function %s from public, anon, authenticated, service_role/);
    assert.ok(!/to anon/.test(grants), 'nothing for anon');
    for (const f of new Set(defs)) {
      // Round 2's roll back drops what it added and puts round 1's own back (create or replace).
      const ownedByRound1 = rollsBackTo && new RegExp(`create or replace function ${f.replace('.', '\\.')}\\(`).test(rollsBackTo);
      if (ownedByRound1) assert.match(rb, new RegExp(`create or replace function ${f.replace('.', '\\.')}\\(`), `${f} restored by the roll back`);
      else assert.match(rb, new RegExp(`drop function if exists ${f.replace('.', '\\.')}\\(`), `${f} rolled back`);
    }
  }
});

test('the round 2 roll back restores round 1\'s functions VERBATIM', () => {
  // 17 Oct verification: the category icon is written as chr(127869) (pure ASCII survives the
  // clipboard), the same character round 1 wrote as a literal; and the scheduler functions 20261017c
  // caps are put back too.
  const same = (t) => t.replace(/chr\(127869\)/g, "'\u{1F37D}'");
  for (const name of ['msm_site_org_guard', 'msm__ref_ok', 'msm_changes_guard', 'msm__sites_reached', 'msm_start_version', 'msm_import_commit', 'msm_apply_site',
    'msm_claim_due', 'msm_mark_missed', 'msm_run_due', 'msm_retry_site']) {
    assert.equal(same(fnText(RB2, name)), fnText(SQL1, name), name);
  }
  assert.doesNotMatch(readFileSync(new URL('../../../supabase/migrations/20261017c_OPS_multi_site_menu_groups.sql', import.meta.url), 'utf8'), /[^\t\n\r -~]/, 'the round 2 file is pure ASCII (the paste route garbles anything else)');
  assert.doesNotMatch(readFileSync(new URL('../../../supabase/migrations/20261017c_OPS_multi_site_menu_groups_ROLLBACK.sql', import.meta.url), 'utf8'), /[^\t\n\r -~]/, 'and its roll back');
});

test('location ids: text NOT NULL with NO default (never \'loc-demo\')', () => {
  assert.ok(!/loc-demo/.test(SQL));
  for (const block of SQL.split('create table if not exists public.').slice(1)) {
    const name = block.slice(0, block.indexOf(' '));
    const body = block.slice(0, block.indexOf(');'));
    for (const m of body.matchAll(/^\s+location_id\s+text(.*)$/gm)) {
      if (name === 'msm_changes') { assert.ok(!/default/.test(m[1])); continue; }   // null for a change to every site
      assert.ok(/not null/.test(m[1]) && !/default/.test(m[1]), `${name}: ${m[0]}`);
    }
  }
});

test('the scheduler: key made in the vault, never in the job; only the job runs msm_run_due', () => {
  assert.match(SQL, /vault\.create_secret\(\s*replace\(gen_random_uuid\(\)::text \|\| gen_random_uuid\(\)::text, '-', ''\),\s*'msm_cron_key'/);
  assert.match(SQL, /cron\.schedule\('msm-run-due', '\* \* \* \* \*', 'select public\.msm_run_due\(\);'\)/);
  assert.match(SQL, /url := 'https:\/\/tbetcegmszzotrwdtqhi\.supabase\.co\/functions\/v1\/msm-publish'/);
  const fn = read('supabase/functions/msm-publish/index.ts');
  assert.match(fn, /db\.rpc\('msm_cron_ok', \{ p_key: key \}\)/, 'the function asks the database, it holds no copy');
  assert.ok(!/sbp_|eyJhbGci/.test(fn + SQL), 'no key in any file');
});

const NEW_FILES = () => [
  ...readdirSync(new URL('supabase/functions/_shared/', root)).filter((f) => /^msm\w*\.js$/.test(f) || f === 'venueMenuCore.js').map((f) => `supabase/functions/_shared/${f}`),
  ...readdirSync(new URL('src/lib/msm/', root)).map((f) => `src/lib/msm/${f}`),
  'supabase/functions/msm-publish/index.ts',
  'supabase/migrations/20261017_OPS_multi_site_menu.sql', 'supabase/migrations/20261017_OPS_multi_site_menu_ROLLBACK.sql',
  'supabase/migrations/20261017c_OPS_multi_site_menu_groups.sql', 'supabase/migrations/20261017c_OPS_multi_site_menu_groups_ROLLBACK.sql',
  'supabase/tests/multi_site_menu/run.mjs', 'supabase/tests/multi_site_menu/baseline.sql', 'supabase/tests/multi_site_menu/README.md',
  'src/admin/sections/AdminMultiSiteMenu.jsx',
];

test('house rules in every new file: no long dashes, no unpaged read over 1,000 rows', () => {
  for (const f of NEW_FILES()) {
    const s = read(f);
    assert.ok(!/[\u2013\u2014]/.test(s), `${f} has a long dash`);
    for (const m of s.matchAll(/\.limit\((\d+)\)/g)) assert.ok(Number(m[1]) <= 1000, `${f} reads ${m[1]} rows in one request`);
  }
});

test('every write in the data layer reports to saveHealth', () => {
  const s = read('src/lib/msm/msmData.js');
  const writes = [...s.matchAll(/\.(insert|update|delete)\(/g)].length;
  const reported = [...s.matchAll(/write\('multi site menu/g)].length + [...s.matchAll(/report\(entity, null\)/g)].length;
  assert.ok(writes >= 8);
  assert.ok(reported >= 7, `${reported} reported writes`);
  assert.match(s, /const write = \(entity, res\) => \{ report\(entity, res\?\.error \|\| null\); return res; \};/);
});

test('the sharing engine and the store skip what head office manages (design review blocker 1, design 1.10)', () => {
  const db = read('src/lib/db.js');
  const share = between(db, 'const shareModifierGroupsToLocation = async', '\n};\n');
  assert.match(share, /const gate = gateFor\(gateRead \|\| await readManagedAt\(supabase, \[peerLocId\]\), peerLocId\);/, 'a fresh read at the TARGET before any write');
  assert.ok(share.indexOf('if (gate.blocked)') < share.indexOf("from('modifier_groups').upsert"), 'fail closed before writing');
  assert.match(share, /if \(gate\.groups\.has\(peerGid\)\)/);
  assert.match(share, /if \(gate\.items\.has\(peerItemId\)\)/);
  const scope = between(db, 'export const setMenuItemScope = async', '\n};\n');
  assert.match(scope, /const managedRead = await readManagedAt\(supabase, otherLocationIds\);/);
  assert.match(scope, /if \(gate\.items\.has\(peerId\)\)/);
  assert.match(scope, /if \(gate\.items\.has\(peerVariantId\)\)/);
  assert.match(scope, /shareModifierGroupsToLocation\(allGroupIds, sourceLocId, peerLocId, org_id, newScope, 'resend', managedRead\)/);
  const edit = between(db, 'export const propagateScopedEdit = async', '\n};\n');
  assert.match(edit, /if \(gate\.items\.has\(sib\.id\)\)/);
  const store = read('src/store/index.js');
  const prop = between(store, 'function scheduleGroupPropagation(group) {', '\n}\n');
  assert.match(prop, /if \(isMsmManagedGroup\(group\.id\)\) return;/);
  assert.match(store, /if \(isMsmManagedGroup\(g\.id\)\) return g;/, 'the sub item rename cascade never renames options in a managed group');
});

test('the managed lists leave out groups and options removed from the group menu (design review, the Menu Manager lock)', () => {
  const groups = newest('msm_managed_groups');
  assert.match(groups, /join public\.msm_modifier_groups g on g\.id = gs\.group_id and not g\.archived/);
  assert.match(groups, /join public\.msm_modifier_options o on o\.id = os\.option_id and not o\.archived/);
  assert.match(newest('msm_managed_at'), /not g\.archived/);
});
