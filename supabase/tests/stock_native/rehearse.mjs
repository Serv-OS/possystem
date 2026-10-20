#!/usr/bin/env node
// rehearse.mjs: Drop 0 on a LOCAL copy of the real stock rows (map 7.9: "link of a copy of Provo and
// Location 2 with the check row identical"). It never writes to Supabase.
//
//   zsh supabase/tests/stock_native/fetch_demo.sh /some/scratch/demo.json a59a6d97-ffaa-470e-8bb7-04cba789f335 fcbddcfd-a025-407b-9727-9e9139250767
//   STOCKN_DEMO=/some/scratch/demo.json node supabase/tests/stock_native/rehearse.mjs              0a, the revalue file, 0b
//   STOCKN_DEMO=/some/scratch/demo.json node supabase/tests/stock_native/rehearse.mjs --base-only  load the copy only
//
// The base database is built exactly as run.mjs builds it (base.mjs: every real migration Peter ran,
// the live policies), EMPTY; then the copy is loaded as it is (triggers off while loading, so nothing is
// recomputed and every live column keeps its live value); then 0a runs as the SQL editor runs it.
// Checked: the check row (only Location 2's packs and bridges move, and by exactly what was filled),
// every count, sum, item on hand, cost, ledger line, area holding, par and recipe base quantity
// identical per venue, the Brioche Bun twins at Provo stay two, the archived keg still holding stock is
// linked, negative stock untouched, nested packs at Location 2 point at Location 2's own parents, the
// writer plans zero writes at every venue; the live figures of contract section 0 and 5.3 (26 shared
// items, 4 suppliers, 25 supplier items, recipe pairs 1 / 5 / 2, 55 packs, 7 bridges); then the
// revalue file (Provo about 94.37, Location 2 about 30.48; ledger value = books to the penny) and 0b
// with its dry run as a manager linked to Provo. Exit code 0 only when every check holds.

import { readFileSync, existsSync } from 'node:fs';
import {
  startCluster, baseSchema, applyMigration, liveTail, BASE_MIGRATIONS, FENCE_FILE, FENCE_TRIGGER, MIG,
  venueFigures, figureDiff, lit,
} from './base.mjs';

const BASE_ONLY = process.argv.includes('--base-only');
const DEMO = process.env.STOCKN_DEMO;
if (!DEMO || !existsSync(DEMO)) { console.error('Set STOCKN_DEMO to the JSON made by fetch_demo.sh (outside the repo).'); process.exit(2); }
const FILES = {
  a: process.env.STOCKN_MIGRATION || MIG('20261021a_OPS_stock_native_0a.sql'),
  rv: process.env.STOCKN_REVALUE || MIG('20261021a_OPS_stock_native_0a_revalue.sql'),
  b: process.env.STOCKN_0B || MIG('20261022a_OPS_stock_native_0b.sql'),
};
if (!BASE_ONLY && !existsSync(FILES.a)) { console.error(`0a is not there yet: ${FILES.a} (run with --base-only, or set STOCKN_MIGRATION)`); process.exit(2); }
const demo = JSON.parse(readFileSync(DEMO, 'utf8'));
const PROVO = '7218c716-eeb4-4f96-b284-f3500823595c';
const LOC2 = 'c3ebfa7f-61b3-4fbc-a192-e7e3949f370e';
const ORG_T = 'a59a6d97-ffaa-470e-8bb7-04cba789f335';

let failures = 0; let checks = 0;
const ok = (cond, msg) => { checks++; if (cond) console.log(`  ok   ${msg}`); else { failures++; console.log(`  FAIL ${msg}`); } };
const info = (msg) => console.log(`  info ${msg}`);
const near = (a, b, eps) => a != null && Math.abs(Number(a) - Number(b)) <= eps;
const short = (x, n = 300) => String(typeof x === 'string' ? x : JSON.stringify(x)).slice(0, n);
const pj = (t) => { try { return JSON.parse(t); } catch { return null; } };

const c = startCluster({ portBase: 55700 });
process.on('uncaughtException', (e) => { console.error(e); c.stop(); process.exit(2); });
const sql = (q) => c.sql(q);
const num = (q) => c.num(q);
const done = () => { console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}: ${checks - failures}/${checks} checks`); if (process.env.STOCKN_KEEP) { console.log(`kept: psql -h ${c.dir} -p ${c.port} -U postgres -d ${c.DB}`); } else c.stop(); process.exit(failures === 0 ? 0 : 1); };

console.log('\n1. The base database (as run.mjs builds it), empty');
c.sql('create database n_demo');
c.use('n_demo');
baseSchema(c);
{
  let r = applyMigration(c, FENCE_FILE);
  ok(r.status === 0, `${FENCE_FILE} applies`);
  c.sql(FENCE_TRIGGER);
  for (const f of BASE_MIGRATIONS) { r = applyMigration(c, f); ok(r.status === 0, `${f} applies${r.status ? `: ${short(r.stderr)}` : ''}`); }
  liveTail(c);
}

console.log('\n2. The copy of the live rows, loaded as it is (triggers off while loading)');
const ORDER = ['organisations', 'locations', 'tax_rates', 'storage_areas', 'inventory_items', 'item_packaging_formats', 'inventory_item_conversions', 'suppliers',
  'supplier_products', 'inventory_item_areas', 'inventory_item_area_stock', 'par_levels', 'stock_movements', 'recipes', 'recipe_lines', 'menu_items',
  'menu_item_recipes', 'msm_company', 'msm_menus', 'msm_products', 'msm_product_sites', 'item_cost_history', 'purchase_orders', 'po_lines', 'supplier_invoices',
  'supplier_invoice_lines', 'stock_counts', 'stock_count_lines', 'stock_count_areas', 'stock_transfers', 'stock_transfer_lines', 'production_batches',
  'prep_schedule', 'deliveries', 'stock_site_settings', 'stock_depletion_mode', 'waste_events'];
const notLoaded = [];
for (const t of ORDER) {
  const rows = demo[t];
  if (!rows || !rows.length) continue;
  const have = new Set(sql(`select string_agg(column_name, ',') from information_schema.columns where table_schema = 'public' and table_name = '${t}'`).split(','));
  const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const absent = keys.filter((k) => !have.has(k));
  if (absent.length) notLoaded.push(`${t}: ${absent.join(', ')}`);
  const cols = keys.filter((k) => have.has(k)).map((k) => `"${k}"`).join(', ');
  const r = c.psql({ input: `set session_replication_role = replica;
    insert into public.${t} (${cols}) select ${cols} from json_populate_recordset(null::public.${t}, ${lit(JSON.stringify(rows))}::json);`, allowFail: true });
  ok(r.status === 0 && num(`select count(*) from public.${t}`) === rows.length, `${t}: ${rows.length} rows loaded${r.status ? `: ${short(r.stderr)}` : ''}`);
}
ok(notLoaded.length === 0, `every live column of the copy exists here with a type it loads into (${notLoaded.join('; ') || 'all'})`);
const venues = demo.locations.filter((l) => (demo.inventory_items || []).some((i) => i.location_id === l.id) || (demo.suppliers || []).some((s) => s.location_id === l.id)).map((l) => l.id);
const vname = Object.fromEntries(demo.locations.map((l) => [l.id, l.name]));
const before = Object.fromEntries(venues.map((v) => [v, venueFigures(c, v)]));
for (const v of venues) {
  const f = before[v];
  info(`${vname[v]}: items ${f['n:inventory_items']}, suppliers ${f['n:suppliers']}, supplier products ${f['n:supplier_products']}, packs ${f['n:item_packaging_formats']}, bridges ${f['n:inventory_item_conversions']}, recipes ${f['n:recipes']}, lines ${f['n:recipe_lines']}, links ${f['n:menu_item_recipes']}; ledger ${Number(f['s:mv_value']).toFixed(2)} against books ${Number(f['s:books']).toFixed(2)}`);
}
ok(venues.includes(PROVO) && venues.includes(LOC2), 'the copy holds Provo and Location 2');
if (BASE_ONLY) done();

console.log('\n3. 0a as the SQL editor runs it');
const paste = c.paste(FILES.a);
ok(paste.status === 0, `0a applies (${paste.status ? short(paste.stderr, 800) : `${paste.ms} ms`})`);
const rows = (paste.sets[paste.sets.length - 1] || { rows: [] }).rows;
for (const r of rows) console.log(`     ${r.venue}: ${short(Object.fromEntries(Object.entries(r).filter(([k]) => k !== 'figures')), 700)}`);
const row = (v) => rows.find((r) => r.location_id === v) || {};
ok(rows.length === venues.length, `one check row per venue that holds stock (${rows.length})`);
for (const v of venues) {
  const after = venueFigures(c, v);
  const diff = figureDiff(before[v], after);
  const d = pj(row(v).delta) || {};
  if (v === LOC2) {
    ok(JSON.stringify(diff.sort()) === JSON.stringify(['n:inventory_item_conversions', 'n:item_packaging_formats']), `Location 2: only packs and bridges differ (${diff.join(', ')})`);
    ok(Number(d['n:item_packaging_formats']) === Number(row(v).packs_filled) && Number(d['n:inventory_item_conversions']) === Number(row(v).bridges_filled)
       && Number(row(v).packs_filled) === after['n:item_packaging_formats'] - before[v]['n:item_packaging_formats'],
      `the delta is exactly what was filled (packs ${row(v).packs_filled}, bridges ${row(v).bridges_filled})`);
    ok(Number(row(v).packs_filled) === 55 && Number(row(v).bridges_filled) === 7, `the live figures: 55 packs and 7 bridges (${row(v).packs_filled}, ${row(v).bridges_filled})`);
  } else {
    ok(diff.length === 0 && Object.keys(d).length === 0, `${vname[v]}: every count, sum, on hand, cost, ledger line, area holding, par and recipe base quantity identical (${diff.join(', ') || 'none differ'})`);
  }
  ok(Number(row(v).site_rows_without_company_ref) === 0 && Number(row(v).company_rows_without_sites) === 0 && Number(row(v).sync_planned_writes) === 0 && Number(row(v).recipe_planned_writes) === 0,
    `${vname[v]}: every site row has its company record, no company row without a site, zero planned writes`);
}
{
  const p = row(PROVO);
  const rp = pj(p.recipe_pairs) || {};
  ok(Number(p.items_shared) === 26 && Number(p.suppliers_shared) === 4 && Number(p.supplier_items_shared) === 25,
    `shared: ${p.items_shared} items, ${p.suppliers_shared} suppliers, ${p.supplier_items_shared} supplier items (live 20 Oct: 26, 4, 25)`);
  ok(rp.merged === 1 && rp.differ === 5 && rp.link_only === 2, `recipe pairs ${short(rp)} (live 20 Oct: 1, 5, 2)`);
  // every name and base unit that Provo holds twice (live: the two Brioche Buns) stays that many company items
  const twins = pj(sql(`select coalesce(json_agg(json_build_object('name', name, 'n', n, 'refs', refs)), '[]') from (
      select name, base_unit, count(*) as n, count(distinct company_ref) as refs from inventory_items
       where location_id = '${PROVO}' and archived_at is null group by name, base_unit having count(*) > 1) z`)) || [];
  ok(twins.length > 0 && twins.every((x) => x.n === x.refs), `Provo's twins (same name and unit) stay apart, one company item each (${short(twins)})`);
  const keg = sql(`select coalesce(string_agg((c.archived_at is not null)::text || ':' || i.on_hand, ','), '') from inventory_items i join stock_co_items c on c.id = i.company_ref where i.location_id = '${PROVO}' and i.archived_at is not null and i.on_hand <> 0`);
  ok(keg !== '' && keg.split(',').every((x) => x.startsWith('true:')), `archived items still holding stock are archived company items, linked (${keg})`);
  const neg = JSON.stringify(before[PROVO]['v:items'].filter((x) => Number(x.on_hand) < 0)) === JSON.stringify(venueFigures(c, PROVO)['v:items'].filter((x) => Number(x.on_hand) < 0));
  ok(neg, 'negative stock untouched');
  const nested = num(`select count(*) from item_packaging_formats p join item_packaging_formats q on q.id = p.parent_format_id where p.location_id = '${LOC2}' and q.location_id <> '${LOC2}'`);
  const nestedHere = num(`select count(*) from item_packaging_formats p where p.location_id = '${LOC2}' and p.parent_format_id is not null`);
  ok(nested === 0 && nestedHere > 0, `the ${nestedHere} nested packs at Location 2 point at Location 2's own parents`);
  for (const v of venues) {
    const ps = pj(sql(`select public.stock_co__sync_site('${v}', null, null, false, true)`)); const pr = pj(sql(`select public.stock_co__sync_recipes('${v}', null, false, true)`));
    ok(ps?.writes === 0 && pr?.writes === 0, `${vname[v]}: the writer re plans zero writes (${ps?.writes}, ${pr?.writes})`);
  }
}

console.log('\n4. The revalue file');
if (existsSync(FILES.rv)) {
  const r = c.paste(FILES.rv);
  ok(r.status === 0, `it applies (${r.status ? short(r.stderr, 600) : `${r.ms} ms`})`);
  const rr = (r.sets[r.sets.length - 1] || { rows: [] }).rows;
  for (const x of rr) console.log(`     ${short(x, 500)}`);
  const by = (v) => rr.find((x) => x.location_id === v) || {};
  ok(near(by(PROVO).revalue_value, 94.37, 2) && near(by(LOC2).revalue_value, 30.48, 2), `Provo about 94.37 (${by(PROVO).revalue_value}), Location 2 about 30.48 (${by(LOC2).revalue_value})`);
  ok(rr.every((x) => Number(x.items_off_after) === 0), 'items_off_after 0 at every venue');
  const gap = num(`select coalesce(max(abs(coalesce((select sum(m.value_delta) from stock_movements m where m.inventory_item_id = i.id), 0) - i.on_hand * coalesce(i.current_cost, 0))), 0) from inventory_items i`);
  ok(gap < 0.01, `every item's ledger value equals on hand times cost, to the penny (largest gap ${gap})`);
} else ok(false, 'the revalue file is there');

console.log('\n5. 0b (its dry run as a manager linked to Provo)');
if (existsSync(FILES.b)) {
  const mgr = '10000000-0000-4000-8000-0000000000a1';
  sql(`insert into user_profiles (id, org_id, location_id, role, full_name) values ('${mgr}', '${ORG_T}', '${PROVO}', 'manager', 'Rehearsal Manager');
       insert into user_locations (user_id, location_id, role) values ('${mgr}', '${PROVO}', 'manager');`);
  const r = c.paste(FILES.b);
  ok(r.status === 0, `0b applies (${r.status ? short(r.stderr, 600) : `${r.ms} ms`})`);
  const x = ((r.sets[r.sets.length - 1] || { rows: [] }).rows[0]) || {};
  console.log(`     ${short(x, 500)}`);
  ok(x.approve_open_to_logins === 'f' && x.dry_run_name_refused === 't' && x.dry_run_on_hand_refused === 't', 'approval closed to logins; the dry run refused a rename and an on hand change');
} else ok(false, 'the 0b file is there');
done();
