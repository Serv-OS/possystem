#!/usr/bin/env node
// rehearse.mjs: 20261019c on a LOCAL copy of real stock rows (multi site stock plan, Phase 1:
// "rehearsal on a copy of real data"; 6.4 the promises). It never writes to Supabase.
//
//   zsh supabase/tests/stock_company/fetch_demo.sh /tmp/x/demo.json <demo org id> <third company org id>
//   STOCK1_DEMO=/tmp/x/demo.json node supabase/tests/stock_company/rehearse.mjs
//
// The copy is loaded as it is (triggers off while loading, so nothing is recomputed), then the real
// migrations run (20261018a, 20261018c, 20261019, 20261019b, 20261019c), and:
//   1. Start from the first site of the demo company (Provo): its rows become the company list;
//      no quantity, cost or name changes; every check row identical (row counts included); a publish
//      there plans zero writes.
//   2. Location 2: its own rows that match are linked (the single matches only, as an editor ticking
//      them), every company item switched on there, published now through the runner. No quantity,
//      cost or ledger row changes at either site; the third company is untouched.
//   3. A re publish plans zero writes at both sites.
//   4. Undo of the Location 2 publish: Location 2 back EXACTLY (every row of the five tables and its
//      areas); Undo of Start from a site: Provo back exactly; both re plans zero.
// Exit code 0 only when every check holds.

import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..');
const P0 = join(repo, 'supabase/tests/stock_phase0');
const FLIVE = join(repo, 'supabase/tests/stock_function_fences/live');
const MIG = (f) => join(repo, 'supabase/migrations', f);
const DEMO = process.env.STOCK1_DEMO;
if (!DEMO || !existsSync(DEMO)) { console.error('Set STOCK1_DEMO to the JSON made by fetch_demo.sh'); process.exit(2); }
const demo = JSON.parse(readFileSync(DEMO, 'utf8'));
const bin = (name) => (existsSync(`/opt/homebrew/bin/${name}`) ? `/opt/homebrew/bin/${name}` : name);
const env = { ...process.env, LC_ALL: 'en_US.UTF-8', PGOPTIONS: '-c client_min_messages=warning' };
let failures = 0; let checks = 0;
const ok = (cond, msg) => { checks++; if (cond) console.log(`  ok   ${msg}`); else { failures++; console.log(`  FAIL ${msg}`); } };

const port = String(55700 + Math.floor(Math.random() * 80));
const dir = mkdtempSync(join(tmpdir(), 'pgr.'));
const data = join(dir, 'data');
spawnSync(bin('initdb'), ['-D', data, '-U', 'postgres', '--auth=trust', '-E', 'UTF8'], { env });
spawnSync(bin('pg_ctl'), ['-D', data, '-l', join(dir, 'pg.log'), '-w', '-o', `-p ${port} -c listen_addresses='' -k ${dir} -c fsync=off`, 'start'], { env });
const stop = () => { spawnSync(bin('pg_ctl'), ['-D', data, '-m', 'fast', '-w', 'stop'], { env }); rmSync(dir, { recursive: true, force: true }); };
const psql = (args, input, allowFail = false) => {
  const r = spawnSync(bin('psql'), ['-h', dir, '-p', port, '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-X', '-q', '-At', ...args], { env, input, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0 && !allowFail) { console.error((r.stderr || '').slice(0, 3000)); stop(); process.exit(2); }
  return r;
};
const sql = (q) => psql([], q).stdout.trim();
const file = (p) => psql(['-1', '-f', p]);
const lit = (v) => (v == null ? 'null' : `'${String(v).replace(/'/g, "''")}'`);
const asEditor = (body) => {
  const claims = JSON.stringify({ sub: EDITOR, role: 'authenticated', is_anonymous: false });
  const r = spawnSync(bin('psql'), ['-h', dir, '-p', port, '-U', 'authenticator', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-X', '-q', '-At'],
    { env, encoding: 'utf8', input: `begin;\nselect set_config('request.jwt.claims', ${lit(claims)}, true) \\g /dev/null\nset local role authenticated;\nset local statement_timeout = '8s';\n${body};\ncommit;\n` });
  const m = /ERROR:\s*(.*)/.exec(r.stderr || '');
  let j = null; try { j = JSON.parse(r.stdout.trim().split('\n').pop()); } catch { /* not json */ }
  return { status: r.status, error: m ? m[1] : null, j };
};
const EDITOR = '10000000-0000-4000-8000-0000000000ed';

// -- the database, as Ops (the shapes of ../stock_phase0 and this folder) ---------------------------
file(join(P0, 'schema.sql'));
file(join(FLIVE, 'helpers.sql'));
sql(`grant execute on function public.user_accessible_locations() to anon, authenticated, service_role;
     grant execute on function public.is_anon_session() to anon, authenticated, service_role;
     grant execute on function public.is_super_admin() to anon, authenticated, service_role;
     grant execute on function public.accessible_location_ids() to anon, authenticated, service_role;
     grant execute on function public.accessible_location_uuids() to anon, authenticated, service_role;`);
file(join(P0, 'policies.sql'));
file(join(P0, 'central_schema.sql'));
file(join(here, 'extra_schema.sql'));
file(join(FLIVE, 'post_stock_movement_20261016.sql'));
file(join(FLIVE, 'set_inventory_on_hand_20260805.sql'));
file(join(FLIVE, 'post_stock_transfer_leg_20261016.sql'));
file(join(P0, 'live/rehome_20261016.sql'));
file(join(P0, 'live/stock_usage_by_weekday_live.sql'));
file(join(P0, 'live/stock_usage_rates_live.sql'));
{
  const text = readFileSync(MIG('20261017_OPS_multi_site_menu.sql'), 'utf8');
  for (const name of ['msm__second_step_ok', 'msm__require_servos', 'msm_viewable_org_ids', 'msm_editable_org_ids', 'msm_can_edit']) {
    psql([], new RegExp(`create or replace function public\\.${name}\\([\\s\\S]*?\\n\\$fn\\$;`).exec(text)[0]);
  }
}
// returns_to_shelf arrives with 20261018c; the copy has it, so add it first to load the rows as they are
sql(`alter table public.inventory_items add column if not exists returns_to_shelf boolean not null default false;`);

// -- the copy, loaded as it is (no trigger runs while loading) ---------------------------------------
const load = (table, rows) => {
  if (!rows || !rows.length) return;
  // only the columns both the copy and this database have (a column the copy lacks keeps its default)
  const have = new Set(sql(`select string_agg(column_name, ',') from information_schema.columns where table_schema = 'public' and table_name = '${table}'`).split(','));
  const cols = Object.keys(rows[0]).filter((c) => have.has(c)).map((c) => `"${c}"`).join(', ');
  psql([], `set session_replication_role = replica;
    insert into public.${table} (${cols}) select ${cols} from json_populate_recordset(null::public.${table}, ${lit(JSON.stringify(rows))}::json);`);
};
load('organisations', demo.organisations);
load('locations', demo.locations);
for (const t of ['tax_rates', 'storage_areas', 'inventory_items', 'item_packaging_formats', 'inventory_item_conversions', 'suppliers', 'supplier_products',
  'inventory_item_areas', 'inventory_item_area_stock', 'par_levels', 'stock_movements']) load(t, demo[t]);
const loaded = Object.fromEntries(['inventory_items', 'stock_movements', 'supplier_products', 'item_packaging_formats'].map((t) => [t, Number(sql(`select count(*) from public.${t}`))]));
ok(loaded.inventory_items === demo.inventory_items.length && loaded.stock_movements === demo.stock_movements.length,
  `the copy is loaded: ${loaded.inventory_items} items, ${loaded.stock_movements} movements, ${loaded.item_packaging_formats} packs, ${loaded.supplier_products} supplier prices`);

for (const f of ['20261018a_OPS_stock_function_fences.sql', '20261018c_OPS_central_stock_depletion.sql', '20261019_OPS_central_stock_default.sql',
  '20261019b_OPS_stock_phase0.sql', '20261019c_OPS_stock_company.sql']) {
  const r = psql(['-1', '-f', MIG(f)], undefined, true);
  ok(r.status === 0, `${f} applies${r.status ? `: ${(r.stderr || '').slice(0, 300)}` : ''}`);
}

// the demo company: the org with two sites; the first by creation is the start site
const orgCounts = {};
for (const l of demo.locations) orgCounts[l.org_id] = (orgCounts[l.org_id] || 0) + 1;
const ORG = Object.keys(orgCounts).sort((a, b) => orgCounts[b] - orgCounts[a])[0];
const sites = demo.locations.filter((l) => l.org_id === ORG).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
const [START, OTHER] = [sites[0].id, sites[1].id];
const others = demo.locations.filter((l) => l.org_id !== ORG).map((l) => l.id);
sql(`insert into public.user_profiles (id, role, email, full_name) values ('${EDITOR}', 'manager', 'rehearsal@test', 'Rehearsal Editor');
     insert into public.msm_company (org_id, enabled) values ('${ORG}', true);
     insert into public.stock_company (org_id, enabled) values ('${ORG}', true);
     insert into public.msm_stock_members (org_id, user_id, role) values ('${ORG}', '${EDITOR}', 'editor');`);

const SUMS = (loc) => sql(`select json_build_object(
  'items', (select count(*) from inventory_items where location_id = '${loc}'),
  'packs', (select count(*) from item_packaging_formats where location_id = '${loc}'),
  'bridges', (select count(*) from inventory_item_conversions where location_id = '${loc}'),
  'suppliers', (select count(*) from suppliers where location_id = '${loc}'),
  'prices', (select count(*) from supplier_products where location_id = '${loc}'),
  'on_hand', (select coalesce(sum(on_hand), 0) from inventory_items where location_id = '${loc}'),
  'cost', (select coalesce(sum(current_cost), 0) from inventory_items where location_id = '${loc}'),
  'movements', (select count(*) from stock_movements where location_id = '${loc}'),
  'qty', (select coalesce(sum(qty_base), 0) from stock_movements where location_id = '${loc}'),
  'value', (select coalesce(sum(value_delta), 0) from stock_movements where location_id = '${loc}'),
  'area_stock', (select coalesce(sum(on_hand), 0) from inventory_item_area_stock where location_id = '${loc}'),
  'pars', (select coalesce(sum(par_level), 0) from par_levels where location_id = '${loc}'))`);
// quantities, the ledger, area stock and pars (cost on its own: since round 1 a publish runs the
// site's own cost rule for the items whose supplier price it adds or changes, plan 4.5)
const QTY = (loc) => { const j = JSON.parse(SUMS(loc)); for (const k of ['items', 'packs', 'bridges', 'suppliers', 'prices', 'cost']) delete j[k]; return JSON.stringify(j); };
const COSTS = (loc) => JSON.parse(sql(`select coalesce(json_object_agg(id, current_cost), '{}') from inventory_items where location_id = '${loc}'`));
const SNAP = (loc) => sql(`select md5(json_build_object(
  'items', (select coalesce(json_agg(t order by t.id), '[]') from inventory_items t where t.location_id = '${loc}'),
  'packs', (select coalesce(json_agg(t order by t.id), '[]') from item_packaging_formats t where t.location_id = '${loc}'),
  'bridges', (select coalesce(json_agg(t order by t.id), '[]') from inventory_item_conversions t where t.location_id = '${loc}'),
  'suppliers', (select coalesce(json_agg(t order by t.id), '[]') from suppliers t where t.location_id = '${loc}'),
  'prices', (select coalesce(json_agg(t order by t.id), '[]') from supplier_products t where t.location_id = '${loc}'),
  'areas', (select coalesce(json_agg(t order by t.id), '[]') from inventory_item_areas t where t.location_id = '${loc}'))::text)`);
const plan = (loc) => JSON.parse(sql(`select public.msm_stock__sync_site('${ORG}', '${loc}', null, false, true)`));
const runDue = () => sql('call public.msm_stock_run_due(30);');

const before = { start: SUMS(START), other: SUMS(OTHER), others: others.map(SUMS), snapStart: SNAP(START), snapOther: SNAP(OTHER), qtyOther: QTY(OTHER), costsOther: COSTS(OTHER) };
console.log('\n1. Start from the first site');
const st = asEditor(`select public.msm_stock_start_from_site('${ORG}', '${START}')`);
ok(st.j?.ok === true && st.j.self_check_writes === 0, `Start from a site: ${st.j ? `${st.j.items} items, ${st.j.packs} packs, ${st.j.bridges} bridges, ${st.j.suppliers} suppliers, ${st.j.prices} prices` : st.error}`);
ok(SUMS(START) === before.start, 'every check row at the start site is identical (row counts, on hand, cost, ledger, areas, pars)');
ok(plan(START).writes === 0, 'a publish to the start site plans zero writes');

console.log('\n2. Link the second site\'s own rows, switch every item on there, publish now');
const cand = asEditor(`select public.msm_stock_link_candidates('${ORG}', '${OTHER}')`);
ok(cand.j != null, `suggestions: ${cand.j?.items_total} items, ${cand.j?.suppliers?.length} suppliers, ${cand.j?.prices_total} prices, ${cand.j?.packs?.length} packs, ${cand.j?.bridges?.length} bridges`);
const links = asEditor(`select public.msm_stock_stage_links('${ORG}', '${OTHER}')`);
ok(links.status === 0, `ticked the single matches: ${links.j?.staged ?? links.error}`);
const on = asEditor(`select public.msm_stock_stage_sites('${ORG}', null, array['${OTHER}']::uuid[], true, true)`);
ok(on.status === 0, `every company item and its suppliers on at the second site (${on.j?.staged ?? on.error})`);
const pv = asEditor(`select public.msm_stock_preview('${ORG}', array['${OTHER}']::uuid[])`);
const p2 = pv.j?.sites?.[0];
ok(pv.j?.ok === true && (p2?.health?.block || []).length === 0, `preview: ${p2 ? JSON.stringify(p2.plan) : pv.error} ${JSON.stringify(p2?.health?.warn?.map((w) => w.code))}`);
const pub = asEditor(`select public.msm_stock_publish('${ORG}', 'now', 'rehearsal')`);
ok(pub.j?.ok === true, `published (${pub.error || `version ${pub.j?.version_no}`})`);
runDue();
const state = sql(`select string_agg(status, ',') from msm_stock_version_sites where version_id = ${lit(pub.j?.version_id)}`);
ok(/done/.test(state) && !/failed|waiting/.test(state), `the runner wrote it (${state})`);
ok(QTY(OTHER) === before.qtyOther, 'second site: no quantity, ledger, area stock or par changed');
{
  const set = JSON.parse(sql(`select coalesce(json_object_agg(row_id, after ->> 'current_cost'), '{}') from msm_stock_version_rows where location_id = '${OTHER}' and tbl = 'item_cost'`));
  const now = COSTS(OTHER);
  const moved = Object.keys(now).filter((k) => String(now[k]) !== String(before.costsOther[k] ?? null));
  const linked = moved.filter((k) => k in before.costsOther);
  ok(moved.every((k) => k in set && Number(set[k]) === Number(now[k])) && linked.every((k) => Number(now[k]) > 0),
    `second site: a cost moved only where the site's own price list rule set it, each with its Undo row (${moved.length - linked.length} new items costed from their price, ${linked.length} linked items whose price is new there)`);
}
ok(SUMS(START) === before.start, 'start site: every check row still identical');
ok(others.every((l, i) => SUMS(l) === before.others[i]), 'the other company: identical');
const after = JSON.parse(SUMS(OTHER));
console.log(`     second site rows: ${JSON.stringify(after)} (before ${before.other})`);

console.log('\n3. Re publish');
ok(plan(OTHER).writes === 0 && plan(START).writes === 0, 'a re publish plans zero writes at both sites');

console.log('\n4. Undo');
let u = asEditor(`select public.msm_stock_undo('${ORG}', ${lit(pub.j?.version_id)})`);
ok(u.j?.ok === true, `Undo of the second site publish (${u.error || 'ok'})`);
runDue();
ok(SNAP(OTHER) === before.snapOther && SUMS(OTHER) === before.other, 'the second site is back EXACTLY: every row of the five tables and its areas');
u = asEditor(`select public.msm_stock_undo('${ORG}', ${lit(st.j?.version_id)})`);
ok(u.j?.ok === true, `Undo of Start from a site (${u.error || 'ok'})`);
runDue();
ok(SNAP(START) === before.snapStart && SUMS(START) === before.start, 'the start site is back EXACTLY (company_ref empty again)');
ok(sql(`select count(*) from msm_stock_items where org_id = '${ORG}'`) === '0', 'the company list is empty again');
ok(plan(START).writes === 0 && plan(OTHER).writes === 0, 're plans after Undo: zero writes');

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}: ${checks - failures}/${checks} checks`);
stop();
process.exit(failures === 0 ? 0 : 1);
