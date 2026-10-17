// Multi site menu: source pins. The migration's allowlists are the SAME lists as msmModel.js (one
// side changed alone is the drift class that bites), every table is under row level security and
// the second step fence, every function is closed to the public key, and the new files keep the
// house rules (no long dashes, no unpaged read over 1,000 rows, no 'loc-demo' default).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { STAGE_FIELDS, KEPT_COLUMNS, CHANNELS, VENUE_INSERT, VENUE_UPDATE, PRICING_KEYS } from '../../../supabase/functions/_shared/msmModel.js';

const root = new URL('../../../', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
const SQL = read('supabase/migrations/20261017_OPS_multi_site_menu.sql');
const RB = read('supabase/migrations/20261017_OPS_multi_site_menu_ROLLBACK.sql');
const arr = (text) => [...text.matchAll(/'([^']+)'/g)].map((m) => m[1]);
const between = (s, a, b) => { const i = s.indexOf(a); assert.ok(i >= 0, `missing: ${a}`); const j = s.indexOf(b, i + a.length); return s.slice(i + a.length, j); };

const TABLES = ['msm_company', 'msm_members', 'msm_menus', 'msm_menu_sites', 'msm_site_groups', 'msm_categories', 'msm_category_sites',
  'msm_modifier_groups', 'msm_modifier_group_sites', 'msm_products', 'msm_product_sites', 'msm_change_sets', 'msm_changes', 'msm_versions', 'msm_version_sites'];

test('the staging allowlist in the database is msmModel.STAGE_FIELDS, target by target', () => {
  const guard = between(SQL, 'v_allowed := case new.target', 'end;');
  for (const [target, fields] of Object.entries(STAGE_FIELDS)) {
    const m = new RegExp(`when '${target}' then array\\[([^\\]]+)\\]`).exec(guard);
    assert.ok(m, `no list for ${target}`);
    assert.deepEqual(arr(m[1]), fields, target);
  }
});

test('kept columns and channels are the same lists on both sides', () => {
  assert.deepEqual(arr(between(SQL, 'v_kept     constant text[] := array[', ']')), [...KEPT_COLUMNS]);
  assert.deepEqual(arr(between(SQL, 'v_channels constant text[] := array[', ']')), [...CHANNELS]);
  const imp = between(SQL, 'create or replace function public.msm_import_commit', '$fn$;');
  assert.deepEqual(arr(between(imp, 'where k <> all (array[', ']')), [...KEPT_COLUMNS], 'the import checks the same kept list');
});

test('the venue columns publish may write are msmModel.VENUE_INSERT / VENUE_UPDATE / PRICING_KEYS', () => {
  const apply = between(SQL, 'create or replace function public.msm_apply_site', '$fn$;');
  const list = (name) => arr(between(apply, `${name} constant text[] := array[`, ']'));
  assert.deepEqual(list('v_ins_menus '), VENUE_INSERT.menus);
  assert.deepEqual(list('v_ins_cats  '), VENUE_INSERT.categories);
  assert.deepEqual(list('v_ins_items '), VENUE_INSERT.items);
  assert.deepEqual(list('v_ins_groups'), VENUE_INSERT.groups);
  assert.deepEqual(list('v_upd_menus '), VENUE_UPDATE.menus);
  assert.deepEqual(list('v_upd_cats  '), VENUE_UPDATE.categories);
  assert.deepEqual(list('v_upd_items '), VENUE_UPDATE.items);
  assert.deepEqual(list('v_pricing   '), [...PRICING_KEYS]);
  for (const owned of ['centre_id', 'tax_overrides', 'tax_profile_id', 'option_group_order', 'lock_pricing', 'locked_fields', 'master_id']) {
    assert.ok(!VENUE_UPDATE.items.includes(owned), `${owned} is venue owned`);
  }
});

test('every msm_ table: row level security on, public and anon revoked by name, the second step fence, dropped by the roll back', () => {
  const created = [...SQL.matchAll(/create table if not exists public\.(msm_\w+)/g)].map((m) => m[1]).sort();
  assert.deepEqual(created, [...TABLES].sort());
  const rlsLoop = between(SQL, 'do $rls$', '$rls$;');
  const fence = between(SQL, 'do $second_step$', '$second_step$;');
  for (const t of TABLES) {
    assert.ok(rlsLoop.includes(`'${t}'`), `${t} in the row level security loop`);
    assert.ok(fence.includes(`'${t}'`), `${t} fenced`);
    assert.match(RB, new RegExp(`drop table if exists public\\.${t};`), `${t} rolled back`);
  }
  assert.match(rlsLoop, /revoke all on table public\.%I from public, anon, authenticated/);
});

test('every function is closed to everyone first, by name, then opened to exactly who needs it', () => {
  const defs = [...SQL.matchAll(/create or replace function (public\.msm\w*)\(/g)].map((m) => m[1]);
  const grants = between(SQL, 'do $grants$', '$grants$;');
  const revoked = between(grants, 'foreach f in array array[', '] loop');
  for (const f of new Set(defs)) assert.ok(revoked.includes(`'${f}(`), `${f} is revoked from public, anon, authenticated, service_role`);
  assert.match(grants, /revoke all on function %s from public, anon, authenticated, service_role/);
  assert.ok(!/grant execute on function %s to anon/.test(grants), 'nothing for anon');
  for (const f of new Set(defs)) assert.match(RB, new RegExp(`drop function if exists ${f.replace('.', '\\.')}\\(`), `${f} rolled back`);
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
