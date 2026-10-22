// drop2.mjs: proves Drop 2 of multi site stock (supabase/migrations/20261025a_OPS_stock_native_2.sql and its
// rollback) on the throwaway Ops shaped database run.mjs built (section 1), after 0a, its revalue file, 0b,
// Drop 1 (20261024a) and the drainer release (20261023a), in Peter's order. run.mjs --drop2 calls
// drop2Sections(). It never connects to Supabase.
//
//   30  the paste: refused without Drop 1, without the drainer, on a second run, with a changed body, off
//       Ops; the check row; no site row, login or menu row changes; the data step (allergens onto the
//       supplier items as a union, the roll up unchanged, facts_source 'item'); the first facts build
//   31  what it made: every new table (RLS, grants, read rule, the anon read of facts only, the fence, no
//       write policy), the columns, the triggers, the one msm index and no other msm change, every new
//       function (definer, search path, exact grants, the anon key refused but the recipe card's device
//       branch)
//   32  stock_recipe_cost is costing.js computeRecipe on random recipes (nested made items, usable %,
//       wastage, order types, a cycle); stock_co__allergen_ids and stock_co__norm_name equal their JS twins
//   33  the recipe screens' saves with real roles (every Stock control level allowed or refused exactly as
//       the guard says), set recipe sites, link products, batch how, option rules, swap, sizes, prep ticks
//   34  facts: per site from the supplier item each site uses, the union never drops an allergen, Checked,
//       a changed supplier item after a check, the anon read, the HubRise fingerprint, a kcal example
//   35  the Multi site menu queue: a publish adds a product, the recipe is on and linked within one runner
//       call; a product already selling waits under Recipe missing (never linked by itself); the scan
//       never writes an msm table; a failing scan never stops the queue
//   36  recipe cards and devices; prep list; Recipe missing; batch how
//   37  scale: 3,000 company recipes, 50 sites (10 with --quick): keyset pages under 1 s, cost at 50 sites,
//       the facts rebuild and the nightly under 8 s
//   38  nothing moved an on hand, cost or ledger number; the rollback (15 bodies back by md5, the facts
//       table gone, numbers unchanged); then Drop 2 again
//
// Ids and neutral words only (the repo is public).

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { here, lit, jlit, rng, venueFigures, figureDiff } from './base.mjs';
import { ORG_T, PROVO, LOC2, ORG_S, SOLO, U, I, R, M, CALLERS, id } from './fixtures.mjs';
import { BASKET_SETUP } from './channels.mjs';
import { computeRecipe, componentUnitCost } from '../../../src/lib/stock/costing.js';
import { normaliseAllergenId, UK_ALLERGENS } from '../../functions/_shared/allergenIds.js';
import { normName } from '../../functions/_shared/msmModel.js';

// The 15 bodies Drop 2 rebuilds and the 26 it only checks, with the normalised md5 (contract 1.1).
export const D2_REPLACED = [
  ['public.stock_co__allowed(text)', '551ef9810f8f5d40112eb6995db3757d'],
  ['public.stock_co__clean(text,jsonb)', '503a049bb411a9f8be3c8c057bb51a3b'],
  ['public.stock_save_recipe(jsonb,jsonb,integer,text)', '6edac3d07dbef3bca9efbf9f9d1996bc'],
  ['public.stock_archive_recipe(uuid,integer,boolean,text)', 'aaa6f1df489ec3ba9f89d3bf47f1d7b6'],
  ['public.stock_link_menu_item(uuid,text,uuid,numeric,text)', '82912cf90532d46b9c777f9ab0b9679f'],
  ['public.stock_save_supplier_item(jsonb,integer,text)', '4216382a95e15945cd00ea12548c0131'],
  ['public.stock_save_item(jsonb,jsonb,integer,text)', '92f7cb59e261422d8540441b261f7756'],
  ['public.stock_item_detail(uuid)', '3c651bd7668b19e1f21fc2dcf343cbb8'],
  ['public.stock_make_company_record(text,uuid,integer,text)', '54a721d04be5b45edb5de0194b3e16b0'],
  ['public.stock_co__run_job(bigint)', 'c05acf44319f338f23ac992700053383'],
  ['public.stock_save_queue_run(integer)', '69963d8c329feb65136f4f010a1e09c8'],
  ['public.stock_co__copy_site_step(uuid,uuid,jsonb,integer)', 'e4fea542cb89a94868b5efc65843a917'],
  ['public.stock_co__import_check_row(uuid,text,jsonb)', '5dafb0125a57e802aa3caf96a825784a'],
  ['public.stock_co__import_apply(uuid,integer)', 'ef093dc6b21c7a1a9d8116638ca5804b'],
  ['public.hubrise_menu_fingerprint(text)', '8d6218c9a3bcd982d022857911325d08'],
];
export const D2_TABLES = {
  menu_item_stock_facts: { grants: ['anon', 'authenticated', 'service_role'], policy: 'menu_item_stock_facts_anon_read' },
  stock_msm_recipe_jobs: { grants: ['authenticated', 'service_role'], policy: 'stock_msm_recipe_jobs_read' },
  stock_msm_recipe_cursor: { grants: ['service_role'], policy: null },
  recipe_cost_daily: { grants: ['authenticated', 'service_role'], policy: 'recipe_cost_daily_read' },
  stock_prep_ticks: { grants: ['authenticated', 'service_role'], policy: 'stock_prep_ticks_read' },
};
const SERVICE_ONLY = ['stock_facts_rebuild', 'stock_msm_recipe_scan', 'stock_msm_recipe_run', 'stock_nightly_recipes'];
const ZERO = '00000000-0000-0000-0000-000000000000';

// What the harness database lacks of the live Ops shape that Drop 2 reads (msm_version_sites, the
// claimed_at of ops_devices, the msm product columns), made the way live has them.
export const D2_SHAPE = `
create table if not exists public.msm_versions (id uuid primary key default gen_random_uuid(), menu_id uuid, org_id uuid, created_at timestamptz default now());
create table if not exists public.msm_version_sites (
  version_id uuid not null, location_id text not null, org_id uuid, status text not null default 'scheduled', due_at timestamptz,
  started_at timestamptz, finished_at timestamptz, push_id uuid, counts jsonb, writes jsonb, error text,
  primary key (version_id, location_id));
create index if not exists msm_version_sites_due on public.msm_version_sites (status, due_at) where status in ('scheduled', 'running');
alter table public.ops_devices add column if not exists claimed_at timestamptz;
alter table public.msm_products add column if not exists allergens text[];
alter table public.msm_products add column if not exists parent_product_id uuid;
alter table public.menu_items add column if not exists master_id text;
alter table public.menu_items add column if not exists parent_id text;
alter table public.menu_items add column if not exists tax_rate_id uuid;
alter table public.menu_items add column if not exists tax_profile_id uuid;
alter table public.menu_items add column if not exists archived boolean default false;
alter table public.menu_items add column if not exists allergens text[];
`;

export async function drop2Sections(ctx) {
  const { c, ok, section, guarded, FILES, QUICK } = ctx;
  const sql = (q, o) => c.sql(q, o);
  const num = (q, o) => c.num(q, o);
  const short = (x, n = 160) => String(typeof x === 'string' ? x : JSON.stringify(x)).slice(0, n);
  const pj = (t) => { try { return JSON.parse(t); } catch { return null; } };
  const tf = (v) => v === 't' || v === 'true' || v === true;
  const D2 = process.env.STOCKN_D2 || FILES.d2;
  const D2RB = process.env.STOCKN_D2_ROLLBACK || FILES.d2Rb;

  // -- callers, as run.mjs makes them (authenticator, SET ROLE, claims, the live limits) ---------------------
  function callerLines(cl) {
    const lines = ['\\set VERBOSITY verbose', 'begin;'];
    if (cl.claims) lines.push(`select set_config('request.jwt.claims', ${lit(JSON.stringify(cl.claims))}, true) \\g /dev/null`);
    if (cl.role) {
      lines.push(`set local role ${cl.role};`);
      if (cl.role === 'authenticated' || cl.role === 'service_role') lines.push(`set local statement_timeout = '8s';`);
      if (cl.role === 'anon') lines.push(`set local statement_timeout = '3s';`);
      lines.push(`set local lock_timeout = '8s';`);
    }
    return lines;
  }
  function asCaller(key, body, { commit = true } = {}) {
    const cl = typeof key === 'string' ? CALLERS[key] : key;
    if (!cl) throw new Error(`no caller ${key}`);
    const lines = callerLines(cl);
    lines.push(body.trim().replace(/;?$/, ';'));
    lines.push(commit ? 'commit;' : 'rollback;');
    const t0 = Date.now();
    const r = c.psql({ login: cl.login, input: lines.join('\n') + '\n', allowFail: true });
    const m = /ERROR:\s+([0-9A-Z]{5}):\s*(.*)/.exec(r.stderr || '');
    return { status: r.status, sqlstate: m ? m[1] : (r.status ? 'error' : null), message: m ? m[2] : (r.stderr || '').trim(), out: (r.stdout || '').trim(), ms: Date.now() - t0 };
  }
  const lastJson = (r) => { try { return JSON.parse(r.out.split('\n').filter(Boolean).pop()); } catch { return null; } };
  const callJ = (key, body) => { const r = asCaller(key, body); return { ...r, j: lastJson(r) }; };
  const outcome = (r) => (r.sqlstate ? r.sqlstate : r.status !== 0 ? `fail:${short(r.message, 80)}` : 'ok');
  const md5Of = (sig) => sql(`select md5(btrim(regexp_replace(p.prosrc, '\\s+', ' ', 'g'))) from pg_proc p where p.oid = to_regprocedure('${sig}')`);
  const canExec = (role, sig) => sql(`select has_function_privilege('${role}', to_regprocedure('${sig}'), 'execute')`) === 't';
  const FNS = () => Object.fromEntries(sql(`select p.oid::regprocedure::text || '=' || md5(p.prosrc) from pg_proc p where p.pronamespace = 'public'::regnamespace order by 1`)
    .split('\n').filter(Boolean).map((l) => { const k = l.lastIndexOf('='); return [l.slice(0, k), l.slice(k + 1)]; }));
  const numbers = (loc) => sql(`select json_build_object(
      'items', (select json_agg(json_build_object('id', id, 'on_hand', on_hand, 'cost', current_cost) order by id) from inventory_items where location_id = '${loc}'),
      'ledger', (select json_build_object('n', count(*), 'q', sum(qty_base), 'v', sum(value_delta)) from stock_movements where location_id = '${loc}'),
      'counts', (select count(*) from stock_counts where location_id = '${loc}'))`);
  const allNumbers = () => [PROVO, LOC2, SOLO].map(numbers).join('|');
  // the same numbers, allowing new site items a save ticked on (they hold nothing): every existing item's on
  // hand and cost, the ledger and the counts unchanged
  const numbersHeld = (beforeTxt) => {
    const a = beforeTxt.split('|').map(pj); const b = allNumbers().split('|').map(pj);
    return a.every((x, k) => {
      const y = b[k]; const yi = new Map((y.items || []).map((i) => [i.id, i]));
      const moved = (x.items || []).filter((i) => !(yi.has(i.id) && yi.get(i.id).on_hand === i.on_hand && yi.get(i.id).cost === i.cost));
      const good = JSON.stringify(x.ledger) === JSON.stringify(y.ledger) && x.counts === y.counts && moved.length === 0
        && (y.items || []).filter((i) => !(x.items || []).some((j) => j.id === i.id)).every((i) => Number(i.on_hand) === 0);
      if (!good) console.log(`     moved: ${short({ ledger: [x.ledger, y.ledger], items: moved.map((i) => [i, yi.get(i.id)]) }, 600)}`);
      return good;
    });
  };
  const menuMd5 = () => sql(`select md5(coalesce(string_agg(t::text, '|' order by t.id), '')) from menu_items t`);
  const msmMd5 = () => sql(`select md5(coalesce(string_agg(x, '|' order by x), '')) from (
      select 'v:' || t::text x from msm_version_sites t union all select 'p:' || t::text from msm_products t
      union all select 's:' || t::text from msm_product_sites t union all select 'm:' || t::text from msm_menus t) z`);

  // ==========================================================================================================
  section(30, '30. Drop 2 as the SQL editor runs it, after 0a, revalue, 0b, Drop 1 and the drainer');
  let applied = false;
  const MAIN = 'n_d2_pre';
  await guarded('drop 2 paste', () => {
    c.createFrom('n_d2_a', 'n_base');
    c.use('n_d2_a');
    for (const [f, name] of [[FILES.a, '0a'], [FILES.rv, 'its revalue file']]) {
      const r = c.paste(f);
      ok(r.status === 0, `${name} applies (${r.status ? short(r.stderr, 300) : `${r.ms} ms`})`);
    }
    c.sqlFile(join(here, 'live_discounts.sql'));
    c.psql({ input: BASKET_SETUP });
    for (const [f, name] of [[FILES.b, '0b'], [FILES.d1, 'Drop 1 (20261024a)']]) {
      const r = c.paste(f);
      ok(r.status === 0, `${name} applies (${r.status ? short(r.stderr, 300) : `${r.ms} ms`})`);
    }
    c.psql({ input: D2_SHAPE });
    c.createFrom('n_d2_nodrain', 'n_d2_a');
    const rd = c.paste(FILES.d);
    ok(rd.status === 0, `the drainer (20261023a) applies on Drop 1 (${rd.status ? short(rd.stderr, 400) : `${rd.ms} ms`})`);
    const last = rd.sets[rd.sets.length - 1] || { rows: [] };
    ok(last.rows.length > 0 && last.rows.every((w) => Number(w.bodies_replaced) === 7 && !tf(w.internals_open_to_api)),
      `the drainer's check row: 7 bodies, internals closed (${last.rows.length} rows)`);
    c.createFrom(MAIN, 'n_d2_a');
  });

  await guarded('refusals', () => {
    for (const [db, prep, want, label] of [
      ['n_d2_r1', 'n_d2_nodrain', /Run 20261023a_OPS_stock_drainer_v2\.sql first\. Nothing was changed\./, 'without the drainer'],
      ['n_d2_r2', MAIN, /A stock function changed since this file was written/, 'with a changed body'],
      ['n_d2_r3', MAIN, /This is not the Ops database/, 'off Ops'],
      ['n_d2_r4', MAIN, /Run 20261024a_OPS_stock_native_1\.sql first\. Nothing was changed\./, 'without Drop 1'],
    ]) {
      c.createFrom(db, prep);
      c.use(db);
      if (label === 'with a changed body') sql(`create or replace function public.stock_co__today(p_loc uuid) returns date language sql stable as $$ select current_date $$`);
      if (label === 'off Ops') sql(`create table public.billing_state (id int)`);
      if (label === 'without Drop 1') sql(`delete from stock_native_backup where left(name, 3) = 'd1:' and name <> (select min(name) from stock_native_backup where left(name, 3) = 'd1:')`);
      const fnB = FNS();
      const r = c.paste(D2);
      ok(r.status !== 0 && want.test(r.stderr) && JSON.stringify(FNS()) === JSON.stringify(fnB) && sql(`select to_regclass('public.menu_item_stock_facts') is null`) === 't',
        `${label}: refused in words and nothing changed (${short(r.error, 120)})`);
    }
  });

  let checkRow = [];
  let before = {};
  await guarded('the paste', () => {
    c.use(MAIN);
    before = { numbers: allNumbers(), menu: menuMd5(), msm: msmMd5(), fns: FNS(),
      logins: sql(`select md5(coalesce(string_agg(t::text, '|' order by t.id), '')) from user_profiles t`) + sql(`select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) from user_locations t`),
      itemAllergens: sql(`select json_agg(json_build_object('id', id, 'a', allergens) order by id) from stock_co_items`),
      links: num(`select count(*) from menu_item_recipes m join recipes t on t.id = m.recipe_id and t.archived_at is null and t.company_ref is not null`) };
    const r = c.paste(D2);
    ok(r.status === 0, `Drop 2 applies as one paste (${r.status ? short(r.stderr, 900) : `${r.ms} ms`})`);
    if (r.status !== 0) return;
    applied = true;
    const last = r.sets[r.sets.length - 1] || { cols: [], rows: [] };
    checkRow = last.rows;
    const want = ['org_id', 'multi', 'items_allergens_moved', 'supplier_items_with_allergens', 'items_keeping_own_allergens', 'rollup_unchanged', 'facts_rows',
      'facts_needs_check', 'facts_checked', 'recipe_cost_rows', 'msm_cursor_set', 'msm_jobs', 'replaced_functions', 'new_functions', 'new_tables', 'msm_index',
      'internals_open_to_api', 'anon_can_save', 'anon_reads_facts', 'anon_reads_cost', 'site_rows_changed', 'menu_rows_changed', 'logins_changed'];
    ok(JSON.stringify(last.cols) === JSON.stringify(want), `the check row has contract 1.11's columns in order (${last.cols.join(',')})`);
    for (const row of last.rows) console.log(`     ${short(row, 900)}`);
    ok(last.rows.length >= 2 && last.rows.some((w) => w.org_id === ORG_T && tf(w.multi)) && last.rows.some((w) => w.org_id === ORG_S && !tf(w.multi)),
      'one row per company that holds stock: the two site company multi, the one site company not');
    ok(last.rows.every((w) => Number(w.replaced_functions) === 15 && Number(w.new_functions) === 24 && Number(w.new_tables) === 5 && tf(w.msm_index)
      && !tf(w.internals_open_to_api) && !tf(w.anon_can_save) && tf(w.anon_reads_facts) && !tf(w.anon_reads_cost) && Number(w.site_rows_changed) === 0
      && !tf(w.menu_rows_changed) && !tf(w.logins_changed) && Number(w.facts_needs_check) === 0 && Number(w.facts_checked) === 0 && tf(w.msm_cursor_set)
      && Number(w.msm_jobs) === 0 && tf(w.rollup_unchanged)), 'every row: 15 replaced, 24 new, 5 tables, the msm index, internals closed, anon cannot save, anon reads facts and never cost, nothing changed, nothing to check');
    ok(Number(last.rows.reduce((s, w) => s + Number(w.facts_rows), 0)) === before.links, `the first facts build made one row per live company till link (${before.links})`);
    ok(allNumbers() === before.numbers, 'no on hand, cost, ledger or count number moved');
    ok(menuMd5() === before.menu && msmMd5() === before.msm, 'no menu row and no msm row was written');
    ok(sql(`select md5(coalesce(string_agg(t::text, '|' order by t.id), '')) from user_profiles t`) + sql(`select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) from user_locations t`) === before.logins,
      'no login row was written');
    ok(sql(`select json_agg(json_build_object('id', id, 'a', allergens) order by id) from stock_co_items`) === before.itemAllergens, 'every company item keeps its own allergens exactly');
    const fnA = FNS();
    const changed = Object.keys(before.fns).filter((k) => fnA[k] !== before.fns[k]).map((k) => k.slice(0, k.indexOf('(')));
    const named = D2_REPLACED.map(([s]) => s.slice(7, s.indexOf('(')));
    ok(changed.every((k) => named.includes(k)) && named.every((k) => changed.includes(k)), `only the 15 named bodies changed among functions earlier files made (${changed.filter((k) => !named.includes(k)).join(', ') || 'none other'})`);
    ok(num(`select count(*) from stock_native_backup where left(name, 3) = 'd2:'`) === 15, 'the 15 bodies are backed up as d2: rows');
    const again = c.paste(D2);
    ok(again.status !== 0 && /Drop 2 has run already\. Nothing was changed\./.test(again.stderr), `a second paste refuses (${short(again.error, 80)})`);
  });
  if (!applied) return;
  const T0 = 'n_d2_after';
  c.createFrom(T0, MAIN);
  const rid = (name, loc = null) => sql(`select r.id from stock_co_recipes r where r.name = ${lit(name)} and r.archived_at is null
      ${loc ? `and exists (select 1 from stock_co_recipe_sites s where s.recipe_id = r.id and s.location_id = '${loc}' and s.on_here)` : ''} order by r.id limit 1`);
  const rv = (r) => num(`select row_version from stock_co_recipes where id = '${r}'`);
  const coItem = (name) => sql(`select id from stock_co_items where name = ${lit(name)} and archived_at is null order by id limit 1`);
  const SAVES_NEW = [];

  // ==========================================================================================================
  section(31, '31. What Drop 2 made: tables, read rules, fences, columns, triggers, the msm index, functions and grants');
  await guarded('what it made', () => {
    c.use(T0);
    for (const [t, w] of Object.entries(D2_TABLES)) {
      const g = sql(`select coalesce(string_agg(distinct grantee, ',' order by grantee), '') from information_schema.role_table_grants
                      where table_schema = 'public' and table_name = '${t}' and grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC')`);
      const priv = sql(`select coalesce(string_agg(distinct privilege_type, ',' order by privilege_type), '') from information_schema.role_table_grants
                         where table_schema = 'public' and table_name = '${t}' and grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC')`);
      const pol = sql(`select coalesce(string_agg(policyname || ':' || permissive || ':' || cmd, ',' order by policyname), '') from pg_policies where schemaname = 'public' and tablename = '${t}'`);
      const rls = sql(`select relrowsecurity from pg_class where oid = 'public.${t}'::regclass`) === 't';
      ok(rls && g === w.grants.join(',') && priv === 'SELECT', `${t}: row level security on, SELECT only, to ${g}`);
      ok(/second_step_fence:RESTRICTIVE:ALL/.test(pol) && (w.policy ? pol.includes(`${w.policy}:PERMISSIVE:SELECT`) : !/PERMISSIVE/.test(pol))
         && !/PERMISSIVE:(INSERT|UPDATE|DELETE|ALL)/.test(pol), `${t}: the read rule, the second step fence and no write policy (${pol})`);
    }
    ok(num(`select count(*) from information_schema.columns where table_schema = 'public' and (
        (table_name = 'stock_co_recipes' and column_name = 'updated_by') or (table_name = 'stock_co_recipe_sites' and column_name in ('why_on', 'linked_at'))
        or (table_name = 'stock_co_supplier_items' and column_name = 'facts_checked_by_name') or (table_name = 'stock_co_items' and column_name = 'facts_source'))`) === 5,
      'the five new columns');
    ok(num(`select count(*) from pg_trigger where tgname = 'stock_co_d2_org_guard' and not tgisinternal`) === 3, 'the company guard trigger on the three tables');
    ok(sql(`select pg_get_indexdef('public.msm_version_sites_finished'::regclass)`).includes('(finished_at) WHERE (status = ANY'), 'the one msm index, on finished_at for done and nothing');
    ok(num(`select count(*) from pg_trigger g join pg_class t on t.oid = g.tgrelid where not g.tgisinternal and t.relname like 'msm%'`) === 0, 'no trigger on any msm table');
    const fns = sql(`select string_agg(p.oid::regprocedure::text, '|' order by 1) from pg_proc p where p.pronamespace = 'public'::regnamespace
                      and p.proname in (${['stock_recipes_page', 'stock_recipe_detail', 'stock_recipe_cost', 'stock_plate_costs', 'stock_recipe_missing', 'stock_recipe_facts',
                        'stock_recipe_card', 'stock_prep_list', 'stock_batch_how', 'stock_recipe_menu_products', 'stock_set_recipe_sites', 'stock_recipe_link_products',
                        'stock_batch_set_how', 'stock_save_option_rule', 'stock_archive_option_rule', 'stock_swap_ingredient', 'stock_make_sizes', 'stock_prep_tick',
                        'stock_prep_untick', 'stock_facts_signoff', 'stock_facts_rebuild', 'stock_msm_recipe_scan', 'stock_msm_recipe_run', 'stock_nightly_recipes'].map(lit).join(',')})`).split('|');
    ok(fns.length === 24, `24 new public functions (${fns.length})`);
    for (const sig of fns) {
      const name = sig.slice(0, sig.indexOf('('));
      const def = pj(sql(`select json_build_object('definer', prosecdef, 'path', array_to_string(proconfig, ',')) from pg_proc where oid = to_regprocedure('public.${sig}')`));
      const want = name === 'stock_recipe_card' ? ['anon', 'authenticated', 'service_role'] : SERVICE_ONLY.includes(name) ? ['service_role'] : ['authenticated'];
      const got = ['anon', 'authenticated', 'service_role'].filter((r) => canExec(r, `public.${sig}`));
      ok(def.definer && /search_path=public, pg_temp/.test(def.path) && JSON.stringify(got) === JSON.stringify(want) && !canExec('public', `public.${sig}`),
        `${name}: definer, search path public, pg_temp, EXECUTE to ${got.join(', ')}`);
    }
    const open = sql(`select coalesce(string_agg(p.proname, ',' order by p.proname), '') from pg_proc p where p.pronamespace = 'public'::regnamespace
        and p.proname like 'stock\\_co\\_\\_%' and p.proname not in ('stock_co__writer_ok', 'stock_co__site_lock', 'stock_co__site_price_lock', 'stock_co__ledger_lock')
        and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('service_role', p.oid, 'execute'))`);
    ok(open === '', `every stock_co__ helper is closed to the API (${open || 'none open'})`);
    const latte = rid('Latte');
    for (const [label, body] of [
      ['the recipe list', `select public.stock_recipes_page('${ORG_T}', null)`], ['recipe detail', `select public.stock_recipe_detail('${latte}')`],
      ['set recipe sites', `select public.stock_set_recipe_sites('${latte}', '[{"location_id":"${LOC2}","on":false}]', null)`],
      ['facts rebuild', `select public.stock_facts_rebuild('${PROVO}')`], ['the msm run', `select public.stock_msm_recipe_run(5)`]]) {
      const r = asCaller('anonKey', body, { commit: false });
      ok(r.sqlstate === '42501', `the bare anon key is refused: ${label} (${outcome(r)})`);
    }
    ok(asCaller('anonKey', `select count(*) from menu_item_stock_facts`, { commit: false }).status === 0
       && asCaller('anonKey', `select count(*) from recipe_cost_daily`, { commit: false }).sqlstate === '42501',
      'the anon key reads the facts table (like menu_items) and never recipe_cost_daily');
    ok(num(`select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'menu_item_stock_facts' and column_name ~ 'cost|price|method|supplier'`) === 0,
      'the facts table holds no cost, price, method or supplier column');
  });

  // ==========================================================================================================
  section(32, '32. stock_recipe_cost is costing.js computeRecipe; the allergen and name twins');
  await guarded('cost twin', () => {
    c.use(T0);
    const r = rng(ctx.SEED || 1);
    const pick = (a) => a[Math.floor(r() * a.length)];
    // allergen ids and names: SQL against JS on 200 random values each
    const WORDS = ['Milk', ' dairy ', 'Lactose', 'egg', 'Eggs', 'soya', 'Soybeans', 'shellfish', 'Crustacean', 'tree nuts', 'Tree-Nut', 'treenuts', 'nut', 'peanut',
      'Sesame Seeds', 'sulphur dioxide', 'SULFITES', 'sulfite', 'mollusk', 'Molluscs', 'lupine', 'celery', 'mustard', 'Cereals containing gluten', 'wheat', 'fish',
      'kiwi', 'pine_nut', '  ', 'Gluten', 'LUPIN', 'sulphites'];
    let badA = 0;
    const lists = Array.from({ length: 200 }, () => Array.from({ length: 1 + Math.floor(r() * 6) }, () => pick(WORDS)));
    const sqlA = sql(lists.map((l) => `select coalesce(array_to_string(public.stock_co__allergen_ids(array[${l.map(lit).join(',')}]::text[]), ','), '')`).join(' union all ') || 'select 1').split('\n');
    lists.forEach((l, k) => {
      const ids = [...new Set(l.map(normaliseAllergenId).filter(Boolean))];
      const js = [...ids.filter((x) => UK_ALLERGENS.includes(x)).sort((a, b) => UK_ALLERGENS.indexOf(a) - UK_ALLERGENS.indexOf(b)), ...ids.filter((x) => !UK_ALLERGENS.includes(x)).sort()];
      if ((sqlA[k] || '') !== js.join(',')) { badA++; if (badA < 3) console.log(`     allergens ${JSON.stringify(l)}: sql ${sqlA[k]} js ${js}`); }
    });
    ok(badA === 0, `stock_co__allergen_ids equals normaliseAllergenId (src/lib/kioskAllergens.js) on 200 random lists (${badA} differ)`);
    const NAMES = ['Fish & Chips', 'Fish and Chips', 'Café Latte!', '  Flat   White ', 'Burger (Large)', 'B.L.T.', "Chef's Special", 'Soup-of-the-day', 'Oat_Milk', 'Mac & Cheese 2'];
    const names = Array.from({ length: 200 }, () => `${pick(NAMES)}${r() < 0.3 ? ' ' + pick(NAMES) : ''}`);
    const sqlN = sql(names.map((n) => `select public.stock_co__norm_name(${lit(n)})`).join(' union all ')).split('\n');
    const badN = names.filter((n, k) => (sqlN[k] || '') !== normName(n));
    ok(badN.length === 0, `stock_co__norm_name equals msmModel.js normName on 200 random names (${badN.length} differ${badN.length ? `: ${badN[0]} sql ${sqlN[names.indexOf(badN[0])]} js ${normName(badN[0])}` : ''})`);

    // random recipes at three depths, built through the real saves as the owner
    c.createFrom('n_d2_cost', T0);
    c.use('n_d2_cost');
    const N_ITEMS = QUICK ? 30 : 40;
    const N_RECIPES = QUICK ? 120 : 200;
    const units = { g: ['g', 'kg'], ml: ['ml', 'l'], each: ['each'] };
    const bases = ['g', 'ml', 'each'];
    const sites = `[{"location_id":"${PROVO}","on":true}]`;
    const mk = [];
    for (let k = 0; k < N_ITEMS; k++) mk.push(`select public.stock_save_item(${jlit({ name: `Twin item ${k}`, base_unit: bases[k % 3], type: 'food' })}, '${sites}')`);
    const itemsOut = asCaller('ownerT', mk.join(';\n')).out.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));
    const items = itemsOut.map((j, k) => ({ id: j.id, base: bases[k % 3] })).filter((x) => x.id);
    ok(items.length === N_ITEMS, `${items.length} company items made through stock_save_item`);
    sql(`update inventory_items i set current_cost = round((0.001 + (abs(hashtext(i.id::text)) % 1000) / 1000.0 * case i.base_unit when 'each' then 2 else 0.02 end)::numeric, 5)
          from stock_co_item_sites s where s.site_item_id = i.id and s.location_id = '${PROVO}' and s.item_id in (${items.map((x) => lit(x.id)).join(',')})`);
    const line = (it, k) => {
      const ot = r() < 0.25 ? [pick(['takeaway', 'dine-in', 'delivery'])] : null;
      return { component_item_id: it.id, qty: Math.max(0.0001, Math.round((0.5 + r() * 400) * 10000 / (it.base === 'each' ? 100 : 1)) / 10000), unit: pick(units[it.base]),
        usable_pct: r() < 0.4 ? Math.round(50 + r() * 50) : null, order_types: ot, sort_order: k };
    };
    const made = [];       // { recipe, item, base }
    const recipes = [];
    const saveRecipe = (rec, lines) => {
      const res = callJ('ownerT', `select public.stock_save_recipe(${jlit({ ...rec, sites: [{ location_id: PROVO, on: true }] })}, ${jlit(lines)})`);
      return res.j && res.j.id ? res.j.id : (console.log(`     save: ${short(res.message, 300)}`), null);
    };
    // depth 1 and 2 batches (each makes its own item), then dishes using anything
    for (let depth = 1; depth <= 2; depth++) {
      for (let k = 0; k < (QUICK ? 6 : 10); k++) {
        const base = pick(bases);
        const out = callJ('ownerT', `select public.stock_save_item(${jlit({ name: `Twin made ${depth}.${k}`, base_unit: base, type: 'food' })}, '${sites}')`).j;
        const pool = depth === 1 ? items : [...items, ...made.map((m) => ({ id: m.item, base: m.base }))];
        const lines = Array.from({ length: 1 + Math.floor(r() * 4) }, (_, n) => line(pick(pool), n));
        const yq = base === 'each' ? 1 + Math.floor(r() * 20) : Math.round((100 + r() * 4000));
        const id_ = saveRecipe({ name: `Twin batch ${depth}.${k}`, recipe_type: 'BATCH', output_item_id: out.id, yield_qty: yq, yield_unit: base === 'each' ? 'each' : pick(units[base]),
          wastage_pct: Math.round(r() * 15) }, lines);
        if (!id_) continue;
        const how = callJ('ownerT', `select public.stock_batch_set_how('${id_}', '${PROVO}', 'batches', ${rv(id_)})`);
        if (!how.j || !how.j.ok) console.log(`     how: ${short(how.message, 200)}`);
        made.push({ recipe: id_, item: out.id, base });
        recipes.push(id_);
      }
    }
    const pool = [...items, ...made.map((m) => ({ id: m.item, base: m.base }))];
    while (recipes.length < N_RECIPES) {
      const lines = Array.from({ length: 1 + Math.floor(r() * 5) }, (_, n) => line(pick(pool), n));
      const id_ = saveRecipe({ name: `Twin dish ${recipes.length}`, recipe_type: 'MENU', yield_qty: 1, yield_unit: 'each', wastage_pct: r() < 0.5 ? 0 : Math.round(r() * 10) }, lines);
      if (id_) recipes.push(id_); else break;
    }
    ok(recipes.length >= N_RECIPES, `${recipes.length} random recipes saved (${made.length} batches at depths 1 and 2, the rest dishes using them: depth 3)`);
    // a cycle: two batches that use each other's made item (put in by hand: the save path is not the subject here)
    const cy = made.slice(0, 2);
    if (cy.length === 2) {
      sql(`insert into stock_co_recipe_lines (org_id, recipe_id, component_item_id, qty, unit, sort_order)
           values ('${ORG_T}', '${cy[0].recipe}', '${cy[1].item}', 1, ${lit(units[cy[1].base][0])}, 99), ('${ORG_T}', '${cy[1].recipe}', '${cy[0].item}', 1, ${lit(units[cy[0].base][0])}, 99);
           select public.stock_co__sync_recipes('${PROVO}', array['${cy[0].recipe}', '${cy[1].recipe}']::uuid[], true, false);`);
    }
    // the JS side, from the very rows the site holds
    const ctxRows = pj(sql(`select json_build_object(
        'items', (select json_object_agg(i.id, json_build_object('baseUnit', i.base_unit, 'kind', i.kind, 'currentCost', i.current_cost,
                   'formats', coalesce((select json_agg(json_build_object('id', f.id, 'qtyInBase', f.qty_in_base)) from item_packaging_formats f where f.inventory_item_id = i.id), '[]'),
                   'itemConversions', coalesce((select json_agg(json_build_object('fromQty', v.from_qty, 'fromUnit', v.from_unit, 'toQty', v.to_qty, 'toUnit', v.to_unit))
                                                from inventory_item_conversions v where v.inventory_item_id = i.id and v.archived_at is null), '[]'))) from inventory_items i where i.location_id = '${PROVO}'),
        'recipes', (select json_agg(json_build_object('id', t.id, 'company', t.company_ref, 'type', t.recipe_type, 'out', t.output_item_id, 'yieldQty', t.yield_qty,
                   'yieldUnit', t.yield_unit, 'wastagePct', t.wastage_pct,
                   'lines', coalesce((select json_agg(json_build_object('componentItemId', l.component_item_id, 'qty', l.qty, 'unit', l.unit, 'usablePct', l.usable_pct,
                                      'orderTypes', l.order_types) order by l.sort_order, l.id) from recipe_lines l where l.recipe_id = t.id), '[]'))
                   order by (t.recipe_type in ('BATCH', 'PREP')) desc, t.updated_at desc, t.id)
                     from recipes t where t.location_id = '${PROVO}' and t.archived_at is null))`));
    const byOut = {};
    for (const t of ctxRows.recipes) if (t.out && !byOut[t.out]) byOut[t.out] = t;
    const all = [...recipes, ...sql(`select string_agg(r.id::text, ',') from stock_co_recipes r join stock_co_recipe_sites s on s.recipe_id = r.id and s.location_id = '${PROVO}' and s.on_here
                                     where r.archived_at is null and r.name not like 'Twin %'`).split(',').filter(Boolean)];
    const OTS = [null, 'takeaway', 'dine-in', 'delivery'];
    const pairs = all.flatMap((x) => OTS.map((o) => [x, o]));
    const sqlRows = sql(pairs.map(([x, o]) => `select '${x}|${o || ''}|' || coalesce((select t.total::text from public.stock_co__recipe_total('${x}', '${PROVO}', ${lit(o)}) t), 'null')`).join(' union all ')).split('\n');
    let bad = 0; let thrown = 0; let compared = 0;
    for (const rowTxt of sqlRows) {
      const [x, o, tot] = rowTxt.split('|');
      const site = ctxRows.recipes.find((t) => t.company === x);
      let js = null;
      try {
        const cx = { itemsById: ctxRows.items, recipesByOutputItem: byOut, memo: new Map() };
        js = computeRecipe({ ...site, yieldQty: site.yieldQty, lines: site.lines.map((l) => ({ ...l, qty: Number(l.qty), usablePct: l.usablePct == null ? null : Number(l.usablePct) })) },
          site.out ? ctxRows.items[site.out] : { baseUnit: site.yieldUnit || 'each', itemConversions: [] }, cx, new Set(site.out ? [site.out] : []), o || null).totalCost;
      } catch { js = null; thrown++; }
      compared++;
      const s = tot === 'null' ? null : Number(tot);
      const same = (s == null && js == null) || (s != null && js != null && Math.abs(s - js) <= 1e-9 * Math.max(1, Math.abs(js)));
      if (!same) {
        bad++;
        if (bad < 4) console.log(`     ${x} ${o || 'none'}: sql ${tot} js ${js}`);
        if (bad === 1 && process.env.STOCKN_DEBUG) {
          console.log(sql(`select string_agg(c.site_item_id || ' q' || c.qty_base || ' u' || coalesce(c.usable_pct::text, '-') || ' c' || coalesce(c.unit_cost::text, '-') || ' ' || coalesce(c.missing, ''), E'\n') from public.stock_co__recipe_cost_at('${x}', '${PROVO}', ${lit(o || null)}) c`));
          for (const l of site.lines) { let uc; try { uc = componentUnitCost(l.componentItemId, { itemsById: ctxRows.items, recipesByOutputItem: byOut, memo: new Map() }); } catch (e) { uc = e.message; } console.log(`     js ${l.componentItemId} ${l.qty} ${l.unit} u${l.usablePct} c${uc} kind ${ctxRows.items[l.componentItemId].kind}`); }
        }
      }
    }
    ok(bad === 0 && compared === pairs.length, `stock_co__recipe_total equals computeRecipe on ${all.length} recipes x 4 order types (${compared} pairs, ${thrown} not costable in JS and null in SQL, ${bad} differ)`);
    const cyc = cy.length === 2 ? sql(`select coalesce((select t.total::text from public.stock_co__recipe_total('${cy[0].recipe}', '${PROVO}', null) t), 'null')`) : 'null';
    ok(cyc === 'null', `a recipe in a cycle has no total (the cycle guard), as computeRecipe throws (${cyc})`);
    // the public read answers the same figure, and the plate costs equal plateCosts
    const one = all.find((x) => !cy.some((m) => m.recipe === x));
    const pub = callJ('ownerT', `select public.stock_recipe_cost('${one}', array['${PROVO}']::uuid[], 'takeaway')`).j;
    const direct = sql(`select coalesce((select t.total::text from public.stock_co__recipe_total('${one}', '${PROVO}', 'takeaway') t), 'null')`);
    ok(pub && pub.rows && pub.rows.length === 1 && ((pub.rows[0].total == null && direct === 'null') || Math.abs(Number(pub.rows[0].total) - Number(direct)) < 1e-9), `stock_recipe_cost answers the twin's figure (${short(pub && pub.rows && pub.rows[0] && pub.rows[0].total)} = ${direct})`);
    const pc = callJ('ownerT', `select public.stock_plate_costs('${PROVO}')`).j;
    const links = pj(sql(`select json_agg(json_build_object('menu_item_id', m.menu_item_id, 'recipe_id', m.recipe_id, 'portion', m.portion)) from menu_item_recipes m where m.location_id = '${PROVO}'`)) || [];
    let pcBad = 0;
    for (const l of links) {
      const site = ctxRows.recipes.find((t) => t.id === l.recipe_id);
      const row = (pc && pc.rows || []).find((x) => x.menu_item_id === l.menu_item_id);
      let js = null;
      try { js = computeRecipe({ ...site, lines: site.lines.map((q) => ({ ...q, qty: Number(q.qty) })) }, site.out ? ctxRows.items[site.out] : { baseUnit: site.yieldUnit || 'each' }, { itemsById: ctxRows.items, recipesByOutputItem: byOut, memo: new Map() }, new Set(), null).totalCost * Number(l.portion || 1); } catch { js = null; }
      const s = row && row.cost != null ? Number(row.cost) : null;
      if (!((s == null && js == null) || (s != null && js != null && Math.abs(s - js) < 1e-9))) pcBad++;
    }
    ok(links.length > 0 && pcBad === 0, `stock_plate_costs equals plateCosts (computeRecipe times the portion) for every till link at Provo (${links.length} links, ${pcBad} differ)`);
    c.use(T0);
  });

  // ==========================================================================================================
  section(33, '33. The recipe saves with real roles: every Stock control level allowed or refused as the guard says');
  await guarded('levels and saves', () => {
    c.createFrom('n_d2_saves', T0);
    c.use('n_d2_saves');
    sql(`update user_profiles set stock_control = 'sites_full' where id = '${U.mgrFull}'; update user_profiles set stock_control = 'all' where id in ('${U.mgrAll}', '${U.mgrAllPurch}');`);
    const before = allNumbers();
    const latte = rid('Latte');
    const burger = rid('Brioche Burger', PROVO);
    const soupP = rid('Soup of the Day (10L)', PROVO);
    const milk = coItem('Whole Milk 2L');
    const oat = sql(`select id from stock_co_items where name ilike '%oat%' order by id limit 1`);
    const T = (who, label, body, want) => {
      const r = asCaller(who, body, { commit: false });
      const got = outcome(r);
      ok(got === want || (want === 'ok' && got === 'ok'), `${CALLERS[who].what}: ${label} -> ${got}${got !== want ? ` (wanted ${want}: ${short(r.message, 120)})` : ''}`);
      return r;
    };
    // company needs: owner, Stock control all and ServOS staff may; a site manager, a franchisee and a login of another company may not
    const companySaves = [
      ['set recipe sites', `select public.stock_set_recipe_sites('${burger}', '[{"location_id":"${LOC2}","on":true}]', ${rv(burger)})`],
      ['an option rule', `select public.stock_save_option_rule(${jlit({ recipe_id: latte, kind: 'replace', option_name: 'Oat milk', option_company_item_id: oat, replaces_item_id: milk })})`],
      ['make sizes', `select public.stock_make_sizes('${latte}', '[{"name":"Large","factor":1.5}]', ${rv(latte)})`],
      ['swap an ingredient (preview)', `select public.stock_swap_ingredient(${jlit({ mode: 'amount', from_item_id: milk, factor: 2 })}, true)`],
      ['batch how', `select public.stock_batch_set_how('${soupP}', '${PROVO}', 'batches', ${rv(soupP)})`],
      ['link products', `select public.stock_recipe_link_products('[{"location_id":"${PROVO}","menu_item_id":"m-latte","recipe_id":"${latte}"}]')`],
    ];
    for (const [label, body] of companySaves) {
      T('ownerT', label, body, 'ok');
      T('mgrAll', label + ' (Stock control all)', body, 'ok');
      T('superAdmin', label, body, 'ok');
      T('mgrProvo', label, body, '42501');
      T('mgrFull', label, body, '42501');
      T('ownerX', label, body, '42501');
      T('noStep', label, body, '42501');
      T('tillProvo', label, body, '42501');
    }
    // site_facts needs: a manager at their own site may tick prep and check facts; not at a site they do not reach
    T('mgrProvo', 'a prep tick at Provo', `select public.stock_prep_tick('${PROVO}', '${soupP}', 2)`, 'ok');
    T('mgrLoc2', 'a prep tick at Provo', `select public.stock_prep_tick('${PROVO}', '${soupP}', 2)`, '42501');
    T('mgrProvo', 'Checked at Provo', `select public.stock_facts_signoff('${PROVO}', 'm-latte')`, 'ok');
    T('mgrLoc2', 'Checked at Provo', `select public.stock_facts_signoff('${PROVO}', 'm-latte')`, '42501');
    T('tillProvo', 'Checked at Provo', `select public.stock_facts_signoff('${PROVO}', 'm-latte')`, '42501');
    // the one site company keeps today's rights (reach is enough)
    const water = rid('Water');
    T('soloMgr', 'one site company: an option rule on its own dish', `select public.stock_save_option_rule(${jlit({ recipe_id: water, kind: 'remove', option_name: 'No ice', removes_item_id: coItem('Bottled Water') })})`, 'ok');
    T('soloMgr', 'one site company: a recipe save through the old path', `select public.stock_save_recipe(${jlit({ site_recipe_id: R.sWater, location_id: SOLO, name: 'Water' })}, null, ${num(`select row_version from recipes where id = '${R.sWater}'`)})`, 'ok');
    // reads: a sites manager sees recipes on at their sites only
    const pg = callJ('mgrLoc2', `select public.stock_recipes_page('${ORG_T}', null)`).j;
    ok(pg && pg.rows.length > 0 && JSON.stringify(pg.sites) === JSON.stringify([LOC2]) && pg.rows.every((x) => x.sites.every((s) => s.location_id === LOC2)),
      `a manager of Location 2 reads only Location 2 (${pg && pg.rows.length} recipes)`);
    ok(asCaller('mgrLoc2', `select public.stock_recipe_cost('${latte}', array['${PROVO}']::uuid[])`, { commit: false }).sqlstate === '42501', 'and is refused the cost at a site out of reach');

    // the saves themselves, committed as the owner
    const sr = callJ('ownerT', `select public.stock_set_recipe_sites('${latte}', '[{"location_id":"${LOC2}","on":false}]', ${rv(latte)})`).j;
    ok(sr && sr.ok && num(`select count(*) from menu_item_recipes where location_id = '${LOC2}' and menu_item_id = 'm-latte_949f370e'`) === 0
       && sql(`select on_here from stock_co_recipe_sites where recipe_id = '${latte}' and location_id = '${LOC2}'`) === 'f'
       && sql(`select archived_at is not null from recipes t join stock_co_recipe_sites s on s.site_recipe_id = t.id where s.recipe_id = '${latte}' and s.location_id = '${LOC2}'`) === 't'
       && num(`select count(*) from stock_co_item_sites where location_id = '${LOC2}' and on_here and item_id in (select component_item_id from stock_co_recipe_lines where recipe_id = '${latte}')`) > 0,
      `off at a site: the till link removed, the site recipe archived, its items stay on (${short(sr, 160)})`);
    const facts = sql(`select needs_check || ':' || coalesce(check_words, '') from menu_item_stock_facts where location_id = '${LOC2}' and menu_item_id = 'm-latte_949f370e'`);
    ok(/^(t|true):Check again: this product is no longer linked to a recipe/.test(facts), `and the facts row there stays, asking for a check (${facts})`);
    const on = callJ('ownerT', `select public.stock_set_recipe_sites('${latte}', '[{"location_id":"${LOC2}","on":true,"menu_item_id":"m-latte_949f370e"}]', ${rv(latte)})`).j;
    ok(on && on.ok && on.sites.length === 1 && on.sites[0].menu_item_id === 'm-latte_949f370e'
       && sql(`select why_on from stock_co_recipe_sites where recipe_id = '${latte}' and location_id = '${LOC2}'`).length > 0,
      `on again with the till product: linked (${short(on, 200)})`);
    const bad = callJ('ownerT', `select public.stock_set_recipe_sites('${burger}', '[{"location_id":"${LOC2}","on":true,"menu_item_id":"m-nothing"}]', ${rv(burger)})`).j;
    ok(bad && bad.refused.length === 1 && /That till product is not on this venue's menu\./.test(bad.refused[0].error), `a till product not on that menu is refused in words (${short(bad && bad.refused)})`);
    const tooMany = asCaller('ownerT', `select public.stock_set_recipe_sites('${burger}', ${jlit(Array.from({ length: 51 }, () => ({ location_id: LOC2, on: true })))}, null)`, { commit: false });
    ok(/Pick 50 sites or fewer\./.test(tooMany.message), 'more than 50 sites: Pick 50 sites or fewer.');
    // batch how: made to order is refused while the site holds the item
    const hold = asCaller('ownerT', `select public.stock_batch_set_how('${soupP}', '${PROVO}', 'to_order', ${rv(soupP)})`, { commit: false });
    ok(hold.sqlstate === '55000' && /still holds .* Use it up or count it to zero first, then switch to Made to order\./.test(hold.message), `made to order while holding: refused (${short(hold.message, 140)})`);
    // option rules
    const orule = callJ('ownerT', `select public.stock_save_option_rule(${jlit({ recipe_id: latte, kind: 'replace', option_name: 'Oat milk', option_company_item_id: oat, replaces_item_id: milk })})`).j;
    ok(orule && orule.ok && num(`select count(*) from stock_co_option_rule_sites where rule_id = '${orule.id}'`) >= 1, `an option rule saved with a row per site the dish is on (${short(orule, 200)})`);
    const notUsed = asCaller('ownerT', `select public.stock_save_option_rule(${jlit({ recipe_id: latte, kind: 'remove', option_name: 'No eggs', removes_item_id: coItem('Free Range Eggs') })})`, { commit: false });
    ok(/The recipe does not use Free Range Eggs\./.test(notUsed.message), `a rule on an item the recipe does not use is refused (${short(notUsed.message, 100)})`);
    const arch = callJ('ownerT', `select public.stock_archive_option_rule('${orule.id}', ${orule.row_version})`).j;
    ok(arch && arch.ok && sql(`select archived_at is not null from stock_co_option_rules where id = '${orule.id}'`) === 't', 'an option rule is archived, never deleted');
    // sizes, swap, prep
    const sz = callJ('ownerT', `select public.stock_make_sizes('${latte}', '[{"name":"Large","factor":2}]', ${rv(latte)})`).j;
    const large = sz && sz.recipes && sz.recipes[0] && sz.recipes[0].id;
    ok(large && num(`select count(*) from stock_co_recipe_lines a join stock_co_recipe_lines b on b.component_item_id = a.component_item_id and b.recipe_id = '${large}'
                      where a.recipe_id = '${latte}' and abs(b.qty - a.qty * 2) < 1e-9`) === num(`select count(*) from stock_co_recipe_lines where recipe_id = '${latte}'`)
       && num(`select count(*) from stock_co_recipe_sites where recipe_id = '${large}' and on_here and site_menu_item_id is null`) === num(`select count(*) from stock_co_recipe_sites where recipe_id = '${latte}' and on_here`),
      'make sizes: every line scaled, the same sites, no till link');
    ok(/Make up to 10 sizes at a time\./.test(asCaller('ownerT', `select public.stock_make_sizes('${latte}', ${jlit(Array.from({ length: 11 }, (_, k) => ({ name: `S${k}`, factor: 1 })))}, ${rv(latte)})`, { commit: false }).message), 'more than 10 sizes refused');
    ok(numbersHeld(before), 'no on hand, cost, ledger or count number moved through the site ticks, links, option rules, sizes and prep ticks (new site items hold nothing)');
    const sw = callJ('ownerT', `select public.stock_swap_ingredient(${jlit({ mode: 'swap', from_item_id: milk, to_item_id: oat })}, true)`).j;
    ok(sw && sw.preview && sw.total > 0 && /recipes change at \d+ sites/.test(sw.words), `swap preview: ${short(sw && sw.words)}`);
    const swa = callJ('ownerT', `select public.stock_swap_ingredient(${jlit({ mode: 'swap', from_item_id: milk, to_item_id: oat })}, false)`).j;
    ok(swa && swa.changed + (swa.rows || []).length === sw.total && num(`select count(*) from stock_co_recipe_lines l join stock_co_recipes r on r.id = l.recipe_id where r.archived_at is null and l.component_item_id = '${milk}'`) === (swa.rows || []).length,
      `swap applied: ${swa && swa.changed} recipes changed, ${(swa && swa.rows || []).length} skipped with a problem`);
    const tk = callJ('ownerT', `select public.stock_prep_tick('${PROVO}', '${soupP}', 3)`).j;
    ok(tk && tk.ok && tk.business_day === sql(`select public.stock_co__today('${PROVO}')::text`), `a prep tick lands on the venue day (${short(tk)})`);
    sql(`update stock_prep_ticks set business_day = business_day - 1 where id = '${tk.id}'`);
    ok(/That tick is from an earlier day\./.test(asCaller('ownerT', `select public.stock_prep_untick('${tk.id}')`, { commit: false }).message), 'untick of an earlier day refused');
    // make company record takes a recipe; the swap above changed recipes on purpose, so only the cost step of
    // Drop 0 re costs the made items whose recipe it changed (a REVALUE row each), never an on hand
    ok(callJ('ownerT', `select public.stock_make_company_record('recipe', '${latte}', ${rv(latte)})`).j.ok === true, 'make company record takes a recipe');
    const bx = before.split('|').map(pj); const ax = allNumbers().split('|').map(pj);
    ok(bx.every((x, k) => (x.items || []).every((i) => { const y = (ax[k].items || []).find((z) => z.id === i.id); return y && y.on_hand === i.on_hand; })),
      'after the swap: every on hand as before (only made item costs were re costed by the cost step)');
    c.use(T0);
  });

  // ==========================================================================================================
  section(34, '34. Facts: from the supplier item each site uses, the union never drops an allergen, Checked');
  await guarded('facts', () => {
    c.createFrom('n_d2_facts', T0);
    c.use('n_d2_facts');
    const before = allNumbers();
    const milkSi = sql(`select si.id from stock_co_supplier_items si join stock_co_items i on i.id = si.item_id where i.name = 'Whole Milk 2L' and si.archived_at is null order by si.id limit 1`);
    const siRv = num(`select row_version from stock_co_supplier_items where id = '${milkSi}'`);
    const fp0 = sql(`select public.hubrise_menu_fingerprint('${PROVO}')`);
    const s1 = callJ('ownerT', `select public.stock_save_supplier_item(${jlit({ id: milkSi, allergens: ['Milk', 'soya'], may_contain: ['nut'], nutrition: { kcal: 64 } })}, ${siRv})`);
    ok(s1.status === 0, `a supplier item facts save (${outcome(s1)} ${short(s1.message, 120)})`);
    const rowsMilk = sql(`select string_agg(location_id || ' ' || menu_item_id || ' ' || array_to_string(allergens, ','), '; ' order by 1) from menu_item_stock_facts where 'soy' = any(allergens)`);
    ok(/m-latte/.test(rowsMilk) && /m-flat/.test(rowsMilk), `every product using it is rebuilt with soy (${short(rowsMilk, 200)})`);
    ok(sql(`select public.hubrise_menu_fingerprint('${PROVO}')`) !== fp0, 'the HubRise fingerprint moves when a facts row changes');
    const fp1 = sql(`select public.hubrise_menu_fingerprint('${PROVO}')`);
    sql(`select public.stock_co__facts_rebuild_site('${PROVO}', null)`);
    ok(sql(`select public.hubrise_menu_fingerprint('${PROVO}')`) === fp1, 'and stays when a rebuild changes nothing');
    // Checked, then take soy off: the shown set keeps soy and asks for a check
    ok(callJ('mgrProvo', `select public.stock_facts_signoff('${PROVO}', 'm-latte')`).j.ok === true, 'Checked by the Provo manager');
    ok(sql(`select checked_by_name is not null and not needs_check from menu_item_stock_facts where location_id = '${PROVO}' and menu_item_id = 'm-latte'`) === 't', 'it stamps who and clears the warning');
    const siRv2 = num(`select row_version from stock_co_supplier_items where id = '${milkSi}'`);
    callJ('ownerT', `select public.stock_save_supplier_item(${jlit({ id: milkSi, allergens: ['milk'] })}, ${siRv2})`);
    const f = pj(sql(`select row_to_json(x) from menu_item_stock_facts x where location_id = '${PROVO}' and menu_item_id = 'm-latte'`));
    ok(f && f.allergens.includes('soy') && f.allergens.includes('milk') && !f.recipe_allergens.includes('soy') && f.needs_check && /Check again/.test(f.check_words),
      `an allergen taken off the supplier item stays shown and asks for a check (${f && f.allergens}; ${f && f.check_words})`);
    ok(callJ('mgrProvo', `select public.stock_facts_signoff('${PROVO}', 'm-latte')`).j.allergens.join(',') === 'milk', 'Checked again: now the shown set follows the recipe');
    // a typed allergen on the menu item is never dropped by a rebuild
    sql(`update menu_items set allergens = array['Sesame'] where id = 'm-flat' and location_id = '${PROVO}'`);
    ok(sql(`select 'sesame' = any(allergens) from menu_item_stock_facts where location_id = '${PROVO}' and menu_item_id = 'm-flat'`) !== 't', 'a direct menu edit does not touch a facts row by itself');
    sql(`select public.stock_co__facts_rebuild_site('${PROVO}', array['m-flat'])`);
    ok(sql(`select 'sesame' = any(allergens) and 'milk' = any(allergens) from menu_item_stock_facts where location_id = '${PROVO}' and menu_item_id = 'm-flat'`) === 't', 'the rebuild shows typed union recipe');
    sql(`update menu_items set allergens = '{}' where id = 'm-flat' and location_id = '${PROVO}'`);
    sql(`select public.stock_co__facts_rebuild_site('${PROVO}', array['m-flat'])`);
    ok(sql(`select 'sesame' = any(allergens) and needs_check from menu_item_stock_facts where location_id = '${PROVO}' and menu_item_id = 'm-flat'`) === 't', 'a typed allergen removed from the menu stays shown with a warning');
    // per site: each site's facts come from the supplier item that site buys from
    const perSite = sql(`select string_agg(x.location_id || ':' || array_to_string(f.allergens, ','), ' ' order by x.location_id)
       from (select distinct location_id::uuid as location_id from menu_item_stock_facts where menu_item_id like 'm-latte%') x
       cross join lateral public.stock_co__facts_of_item((select id from stock_co_items where name = 'Whole Milk 2L'), x.location_id) f`);
    ok(perSite.split(' ').length === 2, `the milk facts are read per site (${perSite})`);
    // a union of 200 random rebuilds never drops a shown allergen
    const r = rng((ctx.SEED || 1) + 7);
    const ALL = ['milk', 'eggs', 'gluten', 'soy', 'nuts', 'sesame'];
    let dropped = 0;
    for (let k = 0; k < (QUICK ? 40 : 200); k++) {
      const pickN = () => ALL.filter(() => r() < 0.3);
      const shown0 = sql(`select array_to_string(allergens, ',') from menu_item_stock_facts where location_id = '${PROVO}' and menu_item_id = 'm-board'`).split(',').filter(Boolean);
      sql(`update stock_co_supplier_items set allergens = ${lit(`{${pickN().join(',')}}`)}::text[] where id = (select si.id from stock_co_supplier_items si join stock_co_items i on i.id = si.item_id where i.name = 'Salted Butter 250g' order by si.id limit 1);
           update menu_items set allergens = ${lit(`{${pickN().join(',')}}`)}::text[] where id = 'm-board';
           select public.stock_co__facts_rebuild_site('${PROVO}', array['m-board']);`);
      const shown1 = sql(`select array_to_string(allergens, ',') from menu_item_stock_facts where location_id = '${PROVO}' and menu_item_id = 'm-board'`).split(',').filter(Boolean);
      if (shown0.some((a) => !shown1.includes(a))) dropped++;
    }
    ok(dropped === 0, `${QUICK ? 40 : 200} random supplier and menu changes: a rebuild never dropped a shown allergen (${dropped})`);
    // kcal worked example: 200 g at 150 kcal per 100 g, 80% cooking yield, 160 g portion = 300 kcal over 1 portion
    const beans = coItem('Coffee Beans');
    sql(`update stock_co_supplier_items set nutrition = '{"kcal":150}' where item_id = '${beans}'`);
    const kr = callJ('ownerT', `select public.stock_save_recipe(${jlit({ name: 'Kcal example', recipe_type: 'MENU', yield_qty: 1, yield_unit: 'each', cooking_yield_pct: 80, portion_weight_g: 160,
      sites: [{ location_id: PROVO, on: true }] })}, ${jlit([{ component_item_id: beans, qty: 200, unit: 'g', sort_order: 0 }])})`).j;
    const k = pj(sql(`select row_to_json(f) from public.stock_co__facts_of_recipe('${kr && kr.id}', '${PROVO}', '{}') f`));
    ok(k && Math.abs(Number(k.kcal) - 300) < 1e-6 && k.kcal_complete, `kcal: 200 g at 150 kcal per 100 g, 80% cooking yield, 160 g portion = 300 per portion (${k && k.kcal}, complete ${k && k.kcal_complete})`);
    ok(numbersHeld(before), 'no on hand, cost, ledger or count number moved');
    c.use(T0);
  });

  // ==========================================================================================================
  section(35, '35. The Multi site menu queue: a publish adds a product, the recipe is on there within one runner call');
  await guarded('msm queue', () => {
    c.createFrom('n_d2_msm', T0);
    c.use('n_d2_msm');
    const flat = rid('Flat White', PROVO);
    sql(`update stock_co_recipes set msm_product_id = '66000000-0000-4000-8000-0000000000f2' where id = '${flat}';
         insert into menu_items (id, location_id, name, menu_name, pricing, allergens) values ('m-flat-new_949f370e', '${LOC2}', 'Flat White', 'Flat White', '{"base": 3.2}', '{}'),
           ('m-flat-sold_949f370e', '${LOC2}', 'Flat White 2', 'Flat White 2', '{"base": 3.2}', '{}');
         delete from msm_product_sites where product_id = '66000000-0000-4000-8000-0000000000f2' and location_id = '${LOC2}';
         insert into msm_product_sites (product_id, location_id, venue_item_id, active) values ('66000000-0000-4000-8000-0000000000f2', '${LOC2}', 'm-flat-new_949f370e', true);`);
    // the recipe is off at Location 2 for this proof
    sql(`select public.stock_co__recipe_off_at('${flat}', '${LOC2}', 'harness')`);
    const msm0 = msmMd5();
    sql(`insert into msm_version_sites (version_id, location_id, org_id, status, finished_at, writes)
         values ('${id('67000000', 'a1')}', '${LOC2}', '${ORG_T}', 'done', now(), '[{"table":"items","id":"m-flat-new_949f370e","before":null,"after":{"name":"Flat White"}}]')`);
    const t0 = Date.now();
    sql(`call public.stock_save_queue_run(5);`);
    const ms = Date.now() - t0;
    ok(sql(`select status from stock_msm_recipe_jobs where menu_item_id = 'm-flat-new_949f370e'`) === 'done'
       && num(`select count(*) from menu_item_recipes m join stock_co_recipe_sites s on s.site_recipe_id = m.recipe_id where s.recipe_id = '${flat}' and m.location_id = '${LOC2}' and m.menu_item_id = 'm-flat-new_949f370e'`) === 1,
      `one runner call after the publish: the company recipe is on at Location 2 with the new till product linked (${ms} ms)`);
    ok(sql(`select why_on from stock_co_recipe_sites where recipe_id = '${flat}' and location_id = '${LOC2}'`).length > 0, 'with why it is on');
    ok(msmMd5().length > 0 && msmMd5() === sql(`select md5(coalesce(string_agg(x, '|' order by x), '')) from (select 'v:' || t::text x from msm_version_sites t union all select 'p:' || t::text from msm_products t
      union all select 's:' || t::text from msm_product_sites t union all select 'm:' || t::text from msm_menus t) z`) && num(`select count(*) from msm_version_sites`) >= 1,
      'the scan wrote no msm row (only the harness insert)');
    // a product that already sold with no recipe: skipped with words, shown under Recipe missing, never linked
    sql(`update msm_product_sites set venue_item_id = 'm-flat-sold_949f370e' where product_id = '66000000-0000-4000-8000-0000000000f2' and location_id = '${LOC2}';
         insert into sales_day_sums (location_id, business_day, menu_item_id, order_type, qty, gross, net)
         values ('${LOC2}', public.stock_co__today('${LOC2}'), 'm-flat-sold_949f370e', 'dine-in', 4, 12.8, 10.67);
         insert into msm_version_sites (version_id, location_id, org_id, status, finished_at, writes)
         values ('${id('67000000', 'a2')}', '${LOC2}', '${ORG_T}', 'done', now(), '[{"table":"items","id":"m-flat-sold_949f370e","before":null,"after":{}}]')`);
    sql(`call public.stock_save_queue_run(5);`);
    ok(sql(`select status || ':' || reason from stock_msm_recipe_jobs where menu_item_id = 'm-flat-sold_949f370e'`) === 'skipped:Already selling here with no recipe. Link it under Recipe missing.',
      'a product already selling is skipped with the words');
    ok(num(`select count(*) from menu_item_recipes where location_id = '${LOC2}' and menu_item_id = 'm-flat-sold_949f370e'`) === 0, 'and is never linked by itself');
    const miss = callJ('ownerT', `select public.stock_recipe_missing('${ORG_T}', array['${LOC2}']::uuid[])`).j;
    const row = miss && miss.rows.find((x) => x.menu_item_id === 'm-flat-sold_949f370e');
    ok(row && Number(row.sold_7d) === 4 && row.suggested && row.suggested.recipe_id === flat, `it shows under Recipe missing with the suggestion (${short(row, 220)})`);
    ok(num(`select count(*) from menu_item_recipes where location_id = '${LOC2}' and menu_item_id = 'm-flat-sold_949f370e'`) === 0, 'reading Recipe missing links nothing');
    const lk = callJ('ownerT', `select public.stock_recipe_link_products('[{"location_id":"${LOC2}","menu_item_id":"m-flat-sold_949f370e","recipe_id":"${flat}"}]')`).j;
    ok(lk && lk.linked === 1 && /Linked under Recipe missing by/.test(sql(`select why_on from stock_co_recipe_sites where recipe_id = '${flat}' and location_id = '${LOC2}'`)), 'one click links it, with the words');
    // a failing scan never stops the queue
    sql(`alter table stock_msm_recipe_cursor rename to stock_msm_recipe_cursor_x`);
    const q0 = num(`select count(*) from stock_save_queue where kind = 'msm_recipe' and status = 'failed'`);
    const r2 = c.psql({ input: 'call public.stock_save_queue_run(5);\n', allowFail: true });
    sql(`alter table stock_msm_recipe_cursor_x rename to stock_msm_recipe_cursor`);
    ok(r2.status === 0 && num(`select count(*) from stock_save_queue where kind = 'msm_recipe' and status = 'failed'`) === q0 + 1, 'a failing scan is one failed bookkeeping row and the runner carries on');
    c.use(T0);
  });

  // ==========================================================================================================
  section(36, '36. Recipe cards and devices; the prep list; batch how');
  await guarded('cards', () => {
    c.createFrom('n_d2_cards', T0);
    c.use('n_d2_cards');
    sql(`insert into devices (location_id, name, type, status, device_uid) values ('${PROVO}', 'KDS', 'kds', 'paired', '${id('20000000', 'ca1')}'),
           ('${PROVO}', 'Till', 'pos', 'paired', '${id('20000000', 'a1')}'), ('${PROVO}', 'Kiosk', 'kiosk', 'paired', '${id('20000000', 'ba1')}')
         on conflict do nothing`);
    const dev = (sub) => ({ login: 'authenticator', role: 'authenticated', claims: { sub, role: 'authenticated', is_anonymous: true, aud: 'authenticated' } });
    const card = (who, loc) => asCaller(who, `select public.stock_recipe_card('${loc}', 'm-latte')`, { commit: false });
    const kds = card(dev(id('20000000', 'ca1')), PROVO);
    ok(kds.status === 0 && /"build"/.test(kds.out) && !/cost|price/i.test(kds.out), `a bound KDS reads the card at its own venue, with no cost or price (${outcome(kds)})`);
    ok(card(dev(id('20000000', 'a1')), PROVO).status === 0, 'a bound till reads it');
    ok(card(dev(id('20000000', 'ca1')), LOC2).sqlstate === '42501', 'the KDS is refused at another venue');
    ok(card(dev(id('20000000', 'ba1')), PROVO).sqlstate === '42501', 'a kiosk is refused');
    ok(card('customer', PROVO).sqlstate === '42501' && card('anonKey', PROVO).sqlstate === '42501', 'a customer and the bare anon key are refused');
    ok(card('mgrProvo', PROVO).status === 0 && card('mgrLoc2', PROVO).sqlstate === '42501', 'a signed in login needs the venue in reach');
    sql(`update stock_co_recipes set restricted = true, method = 'Step one' where name = 'Latte'`);
    ok(/"method": \[\]/.test(card('mgrProvo', PROVO).out), 'a restricted recipe hides its method');
    const pl = callJ('mgrProvo', `select public.stock_prep_list('${PROVO}')`).j;
    ok(pl && pl.business_day && Array.isArray(pl.rows), `the prep list of the venue day (${pl && pl.rows.length} rows)`);
    const bh = callJ('ownerT', `select public.stock_batch_how('${ORG_T}', null)`).j;
    ok(bh && bh.rows.length >= 1 && bh.rows.every((x) => x.sites.length === 2), `batch how lists every batch recipe with each site (${bh && bh.rows.length})`);
    c.use(T0);
  });

  // ==========================================================================================================
  section(37, `37. Scale: ${QUICK ? '600' : '3,000'} company recipes at ${QUICK ? 10 : 50} sites`);
  await guarded('scale', () => {
    c.createFrom('n_d2_scale', T0);
    c.use('n_d2_scale');
    const NS = QUICK ? 10 : 50;
    const NR = QUICK ? 600 : 3000;
    const t0 = Date.now();
    sql(`set statement_timeout = 0;
      insert into locations (id, org_id, name, status) select ('7c000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, '${ORG_T}', 'Scale site ' || g, 'active' from generate_series(1, ${NS}) g on conflict do nothing;
      insert into stock_co_recipes (org_id, kind, name, yield_qty, yield_unit, wastage_pct, gp_target_pct)
        select '${ORG_T}', 'dish', 'Scale dish ' || (g % 400) || ' ' || g, 1, 'each', 0, 70 from generate_series(1, ${NR}) g;
      insert into stock_co_recipe_lines (org_id, recipe_id, component_item_id, qty, unit, sort_order)
        select '${ORG_T}', r.id, (select id from stock_co_items where name = 'Whole Milk 2L'), 0.1 * k, 'l', k from stock_co_recipes r cross join generate_series(1, 10) k where r.name like 'Scale dish %';
      insert into recipes (id, location_id, name, recipe_type, company_ref)
        select gen_random_uuid(), l.id, r.name, 'MENU', r.id from stock_co_recipes r cross join locations l where r.name like 'Scale dish %' and l.name like 'Scale site %';
      insert into stock_co_recipe_sites (recipe_id, org_id, location_id, on_here, site_recipe_id)
        select t.company_ref, '${ORG_T}', t.location_id, true, t.id from recipes t join locations l on l.id = t.location_id where l.name like 'Scale site %';
      insert into recipe_cost_daily (location_id, recipe_id, day, cost, sale_price, gp_pct)
        select s.location_id, s.recipe_id, current_date, 1.0, 4.0, 70 from stock_co_recipe_sites s join locations l on l.id = s.location_id where l.name like 'Scale site %';
      insert into menu_items (id, location_id, name, menu_name, pricing, allergens)
        select 'scale-' || g, '7c000000-0000-4000-8000-000000000001', 'Scale dish ' || g, 'Scale dish ' || g, '{"base": 4}', '{}' from generate_series(1, 1000) g;
      insert into menu_item_recipes (location_id, menu_item_id, recipe_id, portion)
        select '7c000000-0000-4000-8000-000000000001', 'scale-' || row_number() over (order by t.id), t.id, 1
          from recipes t where t.location_id = '7c000000-0000-4000-8000-000000000001' order by t.id limit 1000;
      analyze;`);
    console.log(`     built ${NR} recipes x ${NS} sites, ${NR * 10} lines, 1,000 till links at one site, in ${Date.now() - t0} ms`);
    let after = null; let pages = 0; let worst = 0; let total = 0;
    do {
      const r = callJ('ownerT', `select public.stock_recipes_page('${ORG_T}', null, null, null, ${after ? jlit(after) : 'null'}, 100)`);
      worst = Math.max(worst, r.ms);
      if (!r.j) { ok(false, `a page failed: ${short(r.message, 200)}`); break; }
      total += r.j.rows.length; after = r.j.next; pages++;
    } while (after && pages < (QUICK ? 7 : 31));
    ok(worst < 1500, `keyset pages of 100 over ${NR} recipes at ${NS} sites: ${pages} pages, slowest ${worst} ms (under 1 s plus the psql start)`);
    const one = sql(`select id from stock_co_recipes where name like 'Scale dish %' order by id limit 1`);
    const rc = callJ('ownerT', `select public.stock_recipe_cost('${one}')`);
    ok(rc.status === 0 && rc.j.rows.length === NS && rc.ms < 1500, `one recipe's cost at ${NS} sites: ${rc.ms} ms`);
    const site = '7c000000-0000-4000-8000-000000000001';
    const nr = callJ('service', `select public.stock_nightly_recipes('${site}')`);
    ok(nr.status === 0 && nr.ms < 8000, `the nightly recipes of one site with ${NR} recipes: ${nr.ms} ms (${short(nr.j, 200)})`);
    const fr = callJ('service', `select public.stock_facts_rebuild('${site}')`);
    ok(fr.status === 0 && fr.ms < 8000 && fr.j && Number(fr.j.rows) === Math.min(1000, NR), `the facts rebuild of a site with ${Math.min(1000, NR)} linked products: ${fr.ms} ms (${short(fr.j, 120)})`);
    // set recipe sites at every scale site: the answer comes back fast, the rest is queued and the runner finishes it
    const latte = rid('Latte');
    const scaleSites = sql(`select string_agg(id::text, ',' order by id) from locations where name like 'Scale site %'`).split(',');
    const ss = callJ('ownerT', `select public.stock_set_recipe_sites('${latte}', ${jlit(scaleSites.map((x) => ({ location_id: x, on: true })))}, ${rv(latte)})`);
    ok(ss.status === 0 && ss.ms < 3000 && ss.j && ss.j.sites.length + ss.j.queued.length + ss.j.refused.length === NS,
      `set recipe sites at ${NS} sites answers in ${ss.ms} ms (${ss.j && ss.j.sites.length} now, ${ss.j && ss.j.queued.length} queued, ${ss.j && ss.j.refused.length} refused)`);
    let worstStep = 0;
    for (let k = 0; k < 20 && num(`select count(*) from stock_save_queue where kind = 'set_recipe_sites' and status = 'waiting'`) > 0; k++) {
      const t1 = Date.now(); sql(`update stock_save_queue set due_at = now() where status = 'waiting'; call public.stock_save_queue_run(20);`); worstStep = Math.max(worstStep, Date.now() - t1);
    }
    ok(num(`select count(*) from stock_co_recipe_sites s join locations l on l.id = s.location_id where s.recipe_id = '${latte}' and s.on_here and l.name like 'Scale site %'`) === NS
       && num(`select count(*) from stock_save_queue where kind = 'set_recipe_sites' and status <> 'done'`) === 0,
      `the runner finished it: the recipe is on at all ${NS} sites (slowest runner call ${worstStep} ms)`);
    c.use(T0);
  });

  // ==========================================================================================================
  section(38, '38. Nothing moved a number; the rollback restores; then Drop 2 again');
  await guarded('rollback', () => {
    c.use(T0);
    ok(allNumbers() === before.numbers, 'after Drop 2 and its first builds: every on hand, cost, ledger and count number as before');
    c.createFrom('n_d2_rb', T0);
    c.use('n_d2_rb');
    const r = c.paste(D2RB);
    ok(r.status === 0, `the rollback applies (${r.status ? short(r.stderr, 600) : `${r.ms} ms`})`);
    if (r.status !== 0) return;
    const last = (r.sets[r.sets.length - 1] || { rows: [] }).rows[0] || {};
    ok(Number(last.bodies_restored) === 15 && Number(last.site_rows_changed) === 0 && !tf(last.menu_rows_changed), `its check row: ${short(last, 300)}`);
    ok(D2_REPLACED.every(([sig, m]) => md5Of(sig) === m), 'the 15 bodies are back by md5');
    ok(sql(`select to_regclass('public.menu_item_stock_facts') is null and to_regclass('public.recipe_cost_daily') is null and to_regclass('public.msm_version_sites_finished') is null`) === 't',
      'the facts table, the new tables and the msm index are gone');
    ok(JSON.stringify(FNS()) === JSON.stringify(before.fns), 'every function is exactly as before Drop 2');
    ok(allNumbers() === before.numbers && menuMd5() === before.menu, 'numbers and menu rows unchanged');
    ok(num(`select count(*) from stock_native_backup where left(name, 3) = 'd2:'`) === 0, 'the d2: backup rows are gone');
    const again = c.paste(D2);
    ok(again.status === 0, `Drop 2 applies again after its rollback (${again.status ? short(again.stderr, 400) : `${again.ms} ms`})`);
  });
}
