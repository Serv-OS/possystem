#!/usr/bin/env node
// rehearse.mjs: Drop 0 and then Drop 1 on a LOCAL copy of the real stock rows (map 7.9: "link of a copy of
// Provo and Location 2 with the check row identical"). It never writes to Supabase.
//
//   zsh supabase/tests/stock_native/fetch_demo.sh /some/scratch/demo.json a59a6d97-ffaa-470e-8bb7-04cba789f335 fcbddcfd-a025-407b-9727-9e9139250767
//   STOCKN_DEMO=/some/scratch/demo.json node supabase/tests/stock_native/rehearse.mjs              0a, the revalue file, 0b, Drop 1, then the drainer release
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
// with its dry run as a manager linked to Provo; then Drop 1 (20261024a) and its check row against contract
// 1.11 (a59a6d97: multi, 12 categories, 51 items with one and 4 without, 47 order rules, 10 with no order
// by, 5 suppliers with no cut off; fcbddcfd: one site, 1, 1, 0, 0, 0, 1), its levels dry run as that
// manager, nothing at the sites moving, then its rollback and Drop 1 again. Exit code 0 only when every
// check holds.
//
// The drainer release (20261023a, step 7) then runs on a copy of the live state as it is now (0a, its
// revalue file, 0b and Drop 1 in; Drop 1 ran live on 21 Oct 2026): the check row (v2 gives v1's answer on
// every live check, refund and recipe line), the sales rule (_sales_check_parts against the JS
// checkSalesParts) on every check of STOCKN_CHECKS, the day totals the paste queued (stock_day_sums_check
// and sales_day_sums_check ok), stock_drainer_health, a replay of those checks as new sales before and
// after the release (identical movements, waste and outbox events, part refunds with no uid aside: D4),
// and its rollback (the seven live bodies back).
//
//   zsh supabase/tests/stock_native/fetch_checks.sh /some/scratch/checks.json a59a6d97-ffaa-470e-8bb7-04cba789f335
//   STOCKN_DEMO=... STOCKN_CHECKS=/some/scratch/checks.json node supabase/tests/stock_native/rehearse.mjs --drainer
//
// --drainer fails when the drainer file is missing (without it the step is skipped then). STOCKN_DRAINER
// and STOCKN_DRAINER_ROLLBACK point at other copies of the two files.
//
// Drop 4a (20261026a, the head office reports, step 8) then runs on that drainer copy once its queue is
// drained (as live on the night 4a runs): the check row of contract 1.8 (a59a6d97 multi, dashboard_ms
// under 5000, demo_left_out true when the copy holds demo history; a one site company 'skipped'; every
// row 3 tables, 26 functions, internals closed, the anon key reading nothing, bucket, policy, cron job and
// vault key there, no site row or login changed), the league of the test company as the Owner app asks,
// then its rollback and 4a again.
//
//   STOCKN_DEMO=... STOCKN_CHECKS=... node supabase/tests/stock_native/rehearse.mjs --drainer --drop4a
//
// --drop4a fails when the 4a files are missing. STOCKN_D4A and STOCKN_D4A_ROLLBACK point at other copies.
// The step also checks the dashboard on Provo and Location 2 says "Demo history left out" and that each
// site's GP is the sum of its product GP. Drop 2 (20261025a) ran live on 21 Oct 2026: with a copy taken
// since, its five columns are left out of the load and step 8 also runs 4a in the live order (the
// drainer, Drop 2, then 4a); STOCKN_D2 points at a copy of 20261025a until it is on main.
//
// A copy taken AFTER 0a ran live (20 Oct 2026: its site rows carry company_ref, and fetch_demo.sh then
// also copies the company records and the venue clock) is loaded onto a base with 0a already in, as Ops
// is. Step 3 then proves what 0a left on the real rows instead of linking them again: every site row has
// its company record, no company row without a site, the writer re plans zero writes, the twins, the
// archived keg and Location 2's nested packs; step 4 proves a second revalue paste refuses and changes
// nothing, and the ledger value still equals the books to the penny. Steps 5, 6 and 7 are the same.
// A copy taken after Drop 1 ran live (21 Oct 2026) also carries Drop 1's four columns on 0a's tables
// (stock_co_items.category_id, stock_co_item_sites.paused_from and paused_until,
// stock_co_site_groups.row_version): the loader leaves those out (the base has 0a only, as before
// Drop 1) and step 6 makes them again as the SQL editor did.

import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
  startCluster, baseSchema, applyMigration, liveTail, BASE_MIGRATIONS, FENCE_FILE, FENCE_TRIGGER, MIG,
  venueFigures, figureDiff, lit, here,
} from './base.mjs';
import { jsParts, REPLACED } from './drainer.mjs';
import { insertRow, basketBookedSql } from './channels.mjs';
import { venueDay } from './drop4a.mjs';

const BASE_ONLY = process.argv.includes('--base-only');
const DEMO = process.env.STOCKN_DEMO;
if (!DEMO || !existsSync(DEMO)) { console.error('Set STOCKN_DEMO to the JSON made by fetch_demo.sh (outside the repo).'); process.exit(2); }
const FILES = {
  a: process.env.STOCKN_MIGRATION || MIG('20261021a_OPS_stock_native_0a.sql'),
  rv: process.env.STOCKN_REVALUE || MIG('20261021a_OPS_stock_native_0a_revalue.sql'),
  b: process.env.STOCKN_0B || MIG('20261022a_OPS_stock_native_0b.sql'),
  d1: process.env.STOCKN_D1 || MIG('20261024a_OPS_stock_native_1.sql'),
  d1Rb: process.env.STOCKN_D1_ROLLBACK || MIG('20261024a_OPS_stock_native_1_ROLLBACK.sql'),
  d: process.env.STOCKN_DRAINER || MIG('20261023a_OPS_stock_drainer_v2.sql'),
  dRb: process.env.STOCKN_DRAINER_ROLLBACK || MIG('20261023a_OPS_stock_drainer_v2_ROLLBACK.sql'),
  d4: process.env.STOCKN_D4A || MIG('20261026a_OPS_stock_native_4a.sql'),
  d4Rb: process.env.STOCKN_D4A_ROLLBACK || MIG('20261026a_OPS_stock_native_4a_ROLLBACK.sql'),
  // Drop 2 (20261025a): only for a copy taken after it ran live, so step 8 can run 4a in the live order too
  d2: process.env.STOCKN_D2 || MIG('20261025a_OPS_stock_native_2.sql'),
};
const DRAINER = process.argv.includes('--drainer');
const DROP4A = process.argv.includes('--drop4a');
const CHECKS = process.env.STOCKN_CHECKS || null;
if (!BASE_ONLY && !existsSync(FILES.a)) { console.error(`0a is not there yet: ${FILES.a} (run with --base-only, or set STOCKN_MIGRATION)`); process.exit(2); }
const demo = JSON.parse(readFileSync(DEMO, 'utf8'));
// the copy was taken after 0a ran live: its site rows carry company_ref
const LINKED = (demo.inventory_items || []).some((r) => r && Object.prototype.hasOwnProperty.call(r, 'company_ref'));
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
  if (LINKED) {
    // the copy was taken after 0a ran live: 0a goes in first on the empty base, as on Ops
    info('the copy was taken after 0a ran live (its site rows carry company_ref): 0a goes in on the empty base first, as on Ops');
    const p0 = c.paste(FILES.a);
    ok(p0.status === 0, `0a applies on the empty base (${p0.status ? short(p0.stderr, 800) : `${p0.ms} ms`})`);
    ok(num('select count(*) from stock_native_backup') === 7 && num('select count(*) from stock_co_items') === 0 && num('select count(*) from venue_clock') === 0,
      '0a left its 7 backup rows and no company row or clock row of its own (the copy brings them)');
  }
}

console.log('\n2. The copy of the live rows, loaded as it is (triggers off while loading)');
const ORDER = ['organisations', 'locations', 'tax_rates', 'storage_areas', 'inventory_items', 'item_packaging_formats', 'inventory_item_conversions', 'suppliers',
  'supplier_products', 'inventory_item_areas', 'inventory_item_area_stock', 'par_levels', 'stock_movements', 'recipes', 'recipe_lines', 'menu_items',
  'menu_item_recipes', 'msm_company', 'msm_menus', 'msm_products', 'msm_product_sites', 'item_cost_history', 'purchase_orders', 'po_lines', 'supplier_invoices',
  'supplier_invoice_lines', 'stock_counts', 'stock_count_lines', 'stock_count_areas', 'stock_transfers', 'stock_transfer_lines', 'production_batches',
  'prep_schedule', 'deliveries', 'stock_site_settings', 'stock_depletion_mode', 'waste_events',
  // 0a's own tables (only in a copy taken after 0a ran live)
  'stock_co_settings', 'stock_co_site_settings', 'stock_co_site_groups', 'stock_co_items', 'stock_co_item_sites', 'stock_co_packs', 'stock_co_pack_sites',
  'stock_co_bridges', 'stock_co_bridge_sites', 'stock_co_suppliers', 'stock_co_supplier_sites', 'stock_co_supplier_items', 'stock_co_supplier_item_sites',
  'stock_co_recipes', 'stock_co_recipe_lines', 'stock_co_recipe_sites', 'venue_clock', 'stock_periods', 'stock_period_snapshots'];
const CO_TABLES = ORDER.slice(ORDER.indexOf('stock_co_settings'));
// Drop 1 ran live on 21 Oct 2026: a copy taken since carries its four columns on 0a's tables. The base
// has 0a only (as before Drop 1), so they are left out here and step 6 makes them again as the SQL
// editor did; any other missing column is a failure, as before.
const D1_COLS = { stock_co_items: ['category_id'], stock_co_item_sites: ['paused_from', 'paused_until'], stock_co_site_groups: ['row_version'] };
const D1_LIVE = (demo.stock_co_items || []).some((r) => r && Object.prototype.hasOwnProperty.call(r, 'category_id'));
if (D1_LIVE) info('the copy was taken after Drop 1 ran live (its company items carry category_id): Drop 1\'s four columns are left out of the load and made again by step 6');
// Drop 2 (20261025a) ran live on 21 Oct 2026 too: a copy taken since carries its five columns on 0a's
// tables. 4a reads none of them; they are left out of the load exactly like Drop 1's (step 8 makes them
// again when it runs Drop 2 in the live order); any other missing column is still a failure.
const D2_COLS = { stock_co_items: ['facts_source'], stock_co_supplier_items: ['facts_checked_by_name'], stock_co_recipes: ['updated_by'], stock_co_recipe_sites: ['why_on', 'linked_at'] };
const D2_LIVE = (demo.stock_co_items || []).some((r) => r && Object.prototype.hasOwnProperty.call(r, 'facts_source'));
if (D2_LIVE) info('the copy was taken after Drop 2 ran live (its company items carry facts_source): Drop 2\'s five columns are left out of the load');
const notLoaded = [];
const d1Left = [];
const d2Left = [];
for (const t of ORDER) {
  const rows = demo[t];
  if (!rows || !rows.length) continue;
  const have = new Set(sql(`select string_agg(column_name, ',') from information_schema.columns where table_schema = 'public' and table_name = '${t}'`).split(','));
  const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const absent = keys.filter((k) => !have.has(k) && !(D1_COLS[t] || []).includes(k) && !(D2_COLS[t] || []).includes(k));
  if (absent.length) notLoaded.push(`${t}: ${absent.join(', ')}`);
  for (const k of keys.filter((kk) => !have.has(kk) && (D1_COLS[t] || []).includes(kk))) d1Left.push(`${t}.${k}`);
  for (const k of keys.filter((kk) => !have.has(kk) && (D2_COLS[t] || []).includes(kk))) d2Left.push(`${t}.${k}`);
  const cols = keys.filter((k) => have.has(k)).map((k) => `"${k}"`).join(', ');
  const r = c.psql({ input: `set session_replication_role = replica;
    insert into public.${t} (${cols}) select ${cols} from json_populate_recordset(null::public.${t}, ${lit(JSON.stringify(rows))}::json);`, allowFail: true });
  ok(r.status === 0 && num(`select count(*) from public.${t}`) === rows.length, `${t}: ${rows.length} rows loaded${r.status ? `: ${short(r.stderr)}` : ''}`);
}
ok(notLoaded.length === 0, `every live column of the copy exists here with a type it loads into (${notLoaded.join('; ') || 'all'}${d1Left.length ? `; Drop 1's ${d1Left.join(', ')} left for step 6` : ''}${d2Left.length ? `; Drop 2's ${d2Left.join(', ')} left out (4a reads none)` : ''})`);
ok(D1_LIVE === (d1Left.length > 0), `Drop 1's columns are in the copy exactly when it was taken after Drop 1 ran live (${d1Left.length} columns)`);
ok(D2_LIVE === (d2Left.length > 0) && (!D2_LIVE || d2Left.length === 5), `Drop 2's columns are in the copy exactly when it was taken after Drop 2 ran live (${d2Left.length} columns)`);
const unknown = Object.keys(demo).filter((t) => !ORDER.includes(t) && !['organisations', 'locations'].includes(t) && (demo[t] || []).length);
ok(unknown.length === 0, `every table of the copy is loaded (${unknown.join(', ') || 'all'})`);
if (LINKED) {
  ok(['stock_co_settings', 'stock_co_items', 'stock_co_item_sites', 'stock_co_recipes', 'stock_co_recipe_sites', 'venue_clock'].every((t) => (demo[t] || []).length > 0),
    `the copy taken after 0a holds 0a's company records and the venue clock (${CO_TABLES.map((t) => `${t} ${(demo[t] || []).length}`).join(', ')})`);
} else {
  ok(CO_TABLES.every((t) => !(demo[t] || []).length), 'a copy taken before 0a holds no company record');
}
const venues = demo.locations.filter((l) => (demo.inventory_items || []).some((i) => i.location_id === l.id) || (demo.suppliers || []).some((s) => s.location_id === l.id)).map((l) => l.id);
const vname = Object.fromEntries(demo.locations.map((l) => [l.id, l.name]));
const before = Object.fromEntries(venues.map((v) => [v, venueFigures(c, v)]));
for (const v of venues) {
  const f = before[v];
  info(`${vname[v]}: items ${f['n:inventory_items']}, suppliers ${f['n:suppliers']}, supplier products ${f['n:supplier_products']}, packs ${f['n:item_packaging_formats']}, bridges ${f['n:inventory_item_conversions']}, recipes ${f['n:recipes']}, lines ${f['n:recipe_lines']}, links ${f['n:menu_item_recipes']}; ledger ${Number(f['s:mv_value']).toFixed(2)} against books ${Number(f['s:books']).toFixed(2)}`);
}
ok(venues.includes(PROVO) && venues.includes(LOC2), 'the copy holds Provo and Location 2');
if (BASE_ONLY) done();

if (LINKED) linkedSteps(); else { linkSteps(); revalueStep(); }

// Steps 3 and 4 on a copy taken BEFORE 0a: 0a links the copy, then the revalue file.
function linkSteps() {
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

}

function revalueStep() {
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
}

// Steps 3 and 4 on a copy taken AFTER 0a ran live: what 0a and the revalue left on the real rows.
function linkedSteps() {
  console.log('\n3. 0a is in on the copy (it ran live): what it left on the real rows');
  for (const v of venues) {
    const x = pj(sql(`select json_build_object(
      'site_rows_without_company_ref',
        (select count(*) from inventory_items t where t.location_id = '${v}' and t.company_ref is null)
        + (select count(*) from suppliers t where t.location_id = '${v}' and t.company_ref is null)
        + (select count(*) from supplier_products t where t.location_id = '${v}' and t.company_ref is null)
        + (select count(*) from item_packaging_formats t where t.location_id = '${v}' and t.company_ref is null)
        + (select count(*) from inventory_item_conversions t where t.location_id = '${v}' and t.company_ref is null)
        + (select count(*) from recipes t where t.location_id = '${v}' and t.company_ref is null),
      'company_rows_without_sites',
        (select count(*) from stock_co_items c where c.org_id = l.org_id and not exists (select 1 from stock_co_item_sites s where s.item_id = c.id))
        + (select count(*) from stock_co_suppliers c where c.org_id = l.org_id and not exists (select 1 from stock_co_supplier_sites s where s.supplier_id = c.id))
        + (select count(*) from stock_co_supplier_items c where c.org_id = l.org_id and not exists (select 1 from stock_co_supplier_item_sites s where s.supplier_item_id = c.id))
        + (select count(*) from stock_co_packs c where c.org_id = l.org_id and not exists (select 1 from stock_co_pack_sites s where s.pack_id = c.id))
        + (select count(*) from stock_co_bridges c where c.org_id = l.org_id and not exists (select 1 from stock_co_bridge_sites s where s.bridge_id = c.id))
        + (select count(*) from stock_co_recipes c where c.org_id = l.org_id and not exists (select 1 from stock_co_recipe_sites s where s.recipe_id = c.id)),
      'clock', (select count(*) from venue_clock k where k.location_id = l.id),
      'settings', (select count(*) from stock_co_settings s where s.org_id = l.org_id)) from locations l where l.id = '${v}'`)) || {};
    ok(Number(x.site_rows_without_company_ref) === 0 && Number(x.company_rows_without_sites) === 0,
      `${vname[v]}: every site row has its company record, no company row without a site (${x.site_rows_without_company_ref}, ${x.company_rows_without_sites})`);
    ok(Number(x.clock) === 1 && Number(x.settings) === 1, `${vname[v]}: its venue clock row and its company settings row are there (${x.clock}, ${x.settings})`);
    const ps = pj(sql(`select public.stock_co__sync_site('${v}', null, null, false, true)`)); const pr = pj(sql(`select public.stock_co__sync_recipes('${v}', null, false, true)`));
    ok(ps?.writes === 0 && pr?.writes === 0, `${vname[v]}: the writer re plans zero writes on the live rows (${ps?.writes}, ${pr?.writes})`);
  }
  const sh = pj(sql(`select json_build_object(
      'items', (select count(*) from stock_co_items c where c.org_id = '${ORG_T}' and (select count(*) from stock_co_item_sites s where s.item_id = c.id) >= 2),
      'suppliers', (select count(*) from stock_co_suppliers c where c.org_id = '${ORG_T}' and (select count(*) from stock_co_supplier_sites s where s.supplier_id = c.id) >= 2),
      'supplier_items', (select count(*) from stock_co_supplier_items c where c.org_id = '${ORG_T}' and (select count(*) from stock_co_supplier_item_sites s where s.supplier_item_id = c.id) >= 2),
      'loc2_packs', (select count(*) from item_packaging_formats where location_id = '${LOC2}'),
      'loc2_bridges', (select count(*) from inventory_item_conversions where location_id = '${LOC2}'))`)) || {};
  info(`shared now: ${sh.items} items, ${sh.suppliers} suppliers, ${sh.supplier_items} supplier items (0a on 20 Oct: 26, 4, 25); Location 2 holds ${sh.loc2_packs} packs and ${sh.loc2_bridges} bridges (0a filled 55 and 7)`);
  const twins = pj(sql(`select coalesce(json_agg(json_build_object('name', name, 'n', n, 'refs', refs)), '[]') from (
      select name, base_unit, count(*) as n, count(distinct company_ref) as refs from inventory_items
       where location_id = '${PROVO}' and archived_at is null group by name, base_unit having count(*) > 1) z`)) || [];
  ok(twins.length > 0 && twins.every((x) => x.n === x.refs), `Provo's twins (same name and unit) stay apart, one company item each (${short(twins)})`);
  const keg = sql(`select coalesce(string_agg((c.archived_at is not null)::text || ':' || i.on_hand, ','), '') from inventory_items i join stock_co_items c on c.id = i.company_ref where i.location_id = '${PROVO}' and i.archived_at is not null and i.on_hand <> 0`);
  ok(keg !== '' && keg.split(',').every((x) => x.startsWith('true:')), `archived items still holding stock are archived company items, linked (${keg})`);
  const nested = num(`select count(*) from item_packaging_formats p join item_packaging_formats q on q.id = p.parent_format_id where p.location_id = '${LOC2}' and q.location_id <> '${LOC2}'`);
  const nestedHere = num(`select count(*) from item_packaging_formats p where p.location_id = '${LOC2}' and p.parent_format_id is not null`);
  ok(nested === 0 && nestedHere > 0, `the ${nestedHere} nested packs at Location 2 point at Location 2's own parents`);
  for (const v of venues) ok(num(`select count(*) from inventory_items i where i.location_id = '${v}' and i.on_hand <> coalesce((select sum(m.qty_base) from stock_movements m where m.inventory_item_id = i.id), 0)`) === 0,
    `${vname[v]}: every item's on hand equals its ledger`);

  console.log('\n4. The revalue file (it ran live): a second paste refuses');
  if (existsSync(FILES.rv)) {
    ok(num(`select count(*) from stock_movements where source_type = 'opening_revalue'`) > 0, 'the copy holds the opening revalue rows the live paste wrote');
    const r = c.paste(FILES.rv);
    ok(r.status !== 0 && /has run already/.test(r.stderr), `a second paste refuses (${short(r.error || r.stderr, 200)})`);
    const diff = venues.flatMap((v) => figureDiff(before[v], venueFigures(c, v)).map((k) => `${vname[v]} ${k}`));
    ok(diff.length === 0, `and changes nothing (${diff.join(', ') || 'every figure identical'})`);
    const gap = num(`select coalesce(max(abs(coalesce((select sum(m.value_delta) from stock_movements m where m.inventory_item_id = i.id), 0) - i.on_hand * coalesce(i.current_cost, 0))), 0) from inventory_items i`);
    ok(gap < 0.01, `every item's ledger value equals on hand times cost, to the penny (largest gap ${gap})`);
  } else ok(false, 'the revalue file is there');
}

// Step 7 (run after Drop 1, below): the drainer release on a copy of the live state.
function drainerStep() {
  const tf = (v) => v === 't' || v === true;
  const md5Of = (sig) => sql(`select md5(btrim(regexp_replace(p.prosrc, '\\s+', ' ', 'g'))) from pg_proc p where p.oid = to_regprocedure('${sig}')`);
  let checks = [];
  if (CHECKS) {
    ok(existsSync(CHECKS), `the copy of the checks is there (STOCKN_CHECKS ${CHECKS})`);
    if (existsSync(CHECKS)) checks = (JSON.parse(readFileSync(CHECKS, 'utf8')).closed_checks || []).filter((r) => venues.includes(r.location_id));
  } else info('no STOCKN_CHECKS (fetch_checks.sh): the in migration proof has recipe lines only, no live baskets; no sales rule parity, no replay');
  c.sql('select 1');
  c.createFrom('n_dr', 'n_demo');
  c.use('n_dr');
  c.sqlFile(join(here, 'live_discounts.sql'));
  const loadChecks = (rows) => {
    if (!rows.length) return 0;
    const have = new Set(sql(`select string_agg(column_name, ',') from information_schema.columns where table_schema = 'public' and table_name = 'closed_checks'`).split(','));
    const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))].filter((k) => have.has(k)).map((k) => `"${k}"`).join(', ');
    const r = c.psql({ input: `set session_replication_role = replica;
      insert into public.closed_checks (${cols}) select ${cols} from json_populate_recordset(null::public.closed_checks, ${lit(JSON.stringify(rows))}::json);`, allowFail: true });
    if (r.status) info(short(r.stderr, 400));
    return num(`select count(*) from public.closed_checks`);
  };
  if (checks.length) ok(loadChecks(checks) === checks.length, `${checks.length} closed checks of the copy loaded as they are (no outbox events: live the outbox is empty)`);
  // what the in migration proof must count
  const exp = Object.fromEntries(venues.map((v) => [v, pj(sql(`select json_build_object(
      'live', (select count(*) from closed_checks c where c.location_id = '${v}' and c.closed_at > now() - interval '7 days' and not (coalesce(c.voided, false) or coalesce(c.status, '') in ('void', 'voided'))),
      'all', (select count(*) from closed_checks c where c.location_id = '${v}' and c.closed_at > now() - interval '7 days'),
      'refunds', (select count(*) from closed_checks c, jsonb_array_elements(case when jsonb_typeof(c.refunds) = 'array' then c.refunds else '[]'::jsonb end) x
                   where c.location_id = '${v}' and c.closed_at > now() - interval '7 days' and public.stock_js_key(x -> 'id') is not null),
      'lines', (select count(*) from recipe_lines where location_id = '${v}'))`))]));
  // every venue day of the real ledger, on the venue clock in force (the paste must queue each one)
  const ledgerDays = (v) => sql(`select coalesce(string_agg(distinct d.business_day::text, ','), '') from stock_movements m
     cross join lateral public.stock_co__venue_day(m.location_id, m.occurred_at) d where m.location_id = '${v}'`).split(',').filter(Boolean).sort();
  const had = Object.fromEntries(venues.map((v) => [v, ledgerDays(v)]));
  const paste = c.paste(FILES.d);
  ok(paste.status === 0, `the release applies (${paste.status ? short(paste.stderr, 800) : `${paste.ms} ms`})`);
  if (paste.status) return;
  const rows = (paste.sets[paste.sets.length - 1] || { rows: [] }).rows;
  for (const r of rows) console.log(`     ${r.venue}: ${short(r, 900)}`);
  ok(rows.length === venues.length, `one check row per venue that holds stock (${rows.length})`);
  for (const r of rows) {
    const e = exp[r.location_id] || {};
    const n = (k) => Number(r[k]);
    ok(n('explode_differences') === 0 && n('skipped_flag_differences') === 0 && n('refund_differences') === 0 && n('base_qty_differences') === 0,
      `${vname[r.location_id]}: v2 gives v1's answer on every live check, refund and recipe line (differences ${n('explode_differences')}, ${n('skipped_flag_differences')}, ${n('refund_differences')}, ${n('base_qty_differences')})`);
    ok(n('checks_compared') >= e.live && n('checks_compared') <= e.all && n('refunds_compared') === e.refunds && n('recipe_lines_compared') === e.lines,
      `${vname[r.location_id]}: compared checks ${r.checks_compared} (${e.live} sold, ${e.all} in all), refunds ${r.refunds_compared} (${e.refunds}), recipe lines ${r.recipe_lines_compared} (${e.lines})`);
    ok(n('bodies_replaced') === 7 && n('bodies_backed_up') === 7 && n('new_tables') === 3 && tf(r.discounts_kind) && n('day_sums_triggers') === 3 && n('sales_enqueue_triggers') === 2
       && n('clock_triggers') === 2 && n('option_guard_triggers') === 2 && tf(r.drain_job) && !tf(r.internals_open_to_api) && n('takes_rows') === 0,
      `${vname[r.location_id]}: bodies 7 and 7, tables 3, discounts.kind, triggers 3, 2, 2, 2, drain job, internals closed, no takes yet`);
  }
  // the one sales rule on every real row: the SQL port gives the JS integers
  if (checks.length) {
    const got = pj(sql(`select coalesce(json_object_agg(c.id, to_jsonb(p)), '{}') from closed_checks c cross join lateral public._sales_check_parts(c) p`)) || {};
    const all = pj(sql(`select coalesce(json_agg(to_jsonb(c)), '[]') from closed_checks c`)) || [];
    const off = all.filter((row) => {
      const w = jsParts(row); const g = got[row.id] || {};
      return ['gross_minor', 'tax_minor', 'net_minor', 'reward_minor', 'reward_tax_minor'].some((k) => Number(g[k]) !== w[k]) || g.charged_nothing !== w.charged_nothing || g.legacy !== w.legacy;
    });
    ok(off.length === 0 && all.length === checks.length, `_sales_check_parts gives the JS checkSalesParts integers on all ${all.length} real checks (${off.slice(0, 3).map((x) => `${x.id} ${short(got[x.id])} want ${short(jsParts(x))}`).join('; ') || 'all equal'})`);
  }
  // the day totals the paste queued, rebuilt by the drain
  const queued = pj(sql(`select json_build_object('s', (select coalesce(json_agg(json_build_object('l', location_id, 'd', business_day)), '[]') from stock_day_sums_repair),
                                                  'q', (select coalesce(json_agg(json_build_object('l', location_id, 'd', business_day)), '[]') from sales_day_sums_queue))`));
  info(`the paste queued ${queued.s.length} stock days and ${queued.q.length} sales days`);
  const missed = venues.flatMap((v) => had[v].filter((d) => !queued.s.some((x) => x.l === v && x.d === d)).map((d) => `${vname[v]} ${d}`));
  ok(missed.length === 0, `the paste queued every venue day that holds a movement, the whole real ledger (${venues.map((v) => `${vname[v]} ${had[v].length}`).join(', ')}${missed.length ? `; missing ${missed.slice(0, 5).join(', ')}` : ''})`);
  for (let k = 0; k < 20 && num(`select (select count(*) from stock_day_sums_repair where due_at <= now()) + (select count(*) from sales_day_sums_queue where due_at <= now())`) > 0; k++) sql('call public.stock_day_sums_drain(30, 50);');
  ok(num(`select (select count(*) from stock_day_sums_repair) + (select count(*) from sales_day_sums_queue)`) === 0, 'the drain rebuilds every queued day (both queues empty, none in backoff)');
  const sBad = queued.s.map((x) => ({ ...x, r: pj(sql(`select public.stock_day_sums_check('${x.l}', '${x.d}')`)) })).filter((x) => !x.r?.ok);
  ok(queued.s.length > 0 && sBad.length === 0, `stock_day_sums_check ok on every queued venue day (${sBad.length ? short(sBad, 400) : `${queued.s.length} days`})`);
  const qBad = queued.q.map((x) => ({ ...x, r: pj(sql(`select public.sales_day_sums_check('${x.l}', '${x.d}')`)) }))
    .filter((x) => !x.r?.ok || x.r.net_checked !== true || Math.abs(Number(x.r.net?.sums) - Number(x.r.net?.rule)) > 0.001);
  ok(qBad.length === 0, `sales_day_sums_check ok on every queued venue day: gross, discounts, voids and tax against report_day_sums, net by the one sales rule (${qBad.length ? short(qBad, 400) : `${queued.q.length} days`})`);
  const h = pj(sql('select public.stock_drainer_health()')) || {};
  for (const z of h.venues || []) console.log(`     health ${vname[z.location_id] || z.location_id}: ${short(z, 600)}`);
  const hv = (h.venues || []).filter((z) => venues.includes(z.location_id));
  ok(hv.length > 0 && hv.every((z) => Number(z.dead) === 0 && Number(z.lines_on_archived) === 0 && Number(z.foreign_pack_lines) === 0 && Number(z.to_order_loops) === 0
     && Number(z.repair_failing) === 0 && Number(z.sales_queue_failing) === 0),
    `stock_drainer_health on the live copy: no dead event, no recipe line on an archived row, no foreign pack line, no made to order loop, no failing day (health ok ${h.ok})`);
  // a late row on the real ledger: a figure dated back onto the oldest venue day queues that day
  // (late) and the drain rebuilds it whole from the ledger
  const lv = venues.find((v) => had[v].length > 0 && had[v][0] < sql(`select (d.business_day - 1)::text from public.stock_co__venue_day('${v}', now()) d`));
  if (lv) {
    const d0 = had[lv][0];
    const item = sql(`select id from inventory_items where location_id = '${lv}' and archived_at is null order by id limit 1`);
    sql(`select public._post_stock_movement('${lv}', '${item}', -1, 'MANUAL_ADJ', 0.01, 'rehearsal_late', null, 'rh-late:1',
      (select public.stock_co__day_start_at('${d0}'::date, k.day_start, k.timezone) from public.stock_co__clock_of('${lv}') k) + interval '2 hours', null, null, null)`);
    // what the post booked: the row, and 0a's late count adjustment (dated at the count) when an
    // approved count of that item came after it; each of their days before yesterday must be queued
    const booked = pj(sql(`select coalesce(json_agg(json_build_object('key', m.idempotency_key, 'd', d.business_day, 'old',
        d.business_day < (select t.business_day - 1 from public.stock_co__venue_day('${lv}', now()) t)) order by d.business_day), '[]')
      from stock_movements m cross join lateral public.stock_co__venue_day(m.location_id, m.occurred_at) d
     where m.location_id = '${lv}' and m.idempotency_key in ('rh-late:1', 'late:rh-late:1')`)) || [];
    const want = [...new Set(booked.filter((x) => x.old).map((x) => `${x.d} late`))].sort().join(', ');
    const lq = sql(`select coalesce(string_agg(business_day::text || ' ' || reason, ', ' order by business_day), '') from stock_day_sums_repair`);
    for (let k = 0; k < 20 && num(`select count(*) from stock_day_sums_repair where due_at <= now()`) > 0; k++) sql('call public.stock_day_sums_drain(30, 50);');
    const lk = [...new Set(booked.map((x) => x.d))].map((d) => ({ d, r: pj(sql(`select public.stock_day_sums_check('${lv}', '${d}')`)) }));
    ok(booked.some((x) => x.key === 'rh-late:1' && x.d === d0) && lq === want && lk.every((x) => x.r?.ok === true) && num(`select count(*) from stock_day_sums_repair`) === 0,
      `a late row on the real ledger (${vname[lv]}, ${d0}, its oldest day; ${booked.length} movements booked, ${booked.map((x) => x.key).join(' and ')}): every day it moved is queued (${lq || 'none'}) and rebuilt whole by the drain (${short(lk, 300)})`);
  } else info('no venue of the copy has a movement before yesterday: the late row step is skipped');
  if (checks.length) replay(checks);
  // its rollback on the copy: the seven live bodies back
  if (existsSync(FILES.dRb)) {
    c.use('n_dr');
    const rb = c.paste(FILES.dRb);
    ok(rb.status === 0, `the drainer rollback applies on the copy (${rb.status ? short(rb.stderr, 500) : `${rb.ms} ms`})`);
    const rr = ((rb.sets[rb.sets.length - 1] || { rows: [] }).rows[0]) || {};
    console.log(`     ${short(rr, 400)}`);
    ok(REPLACED.every(([sig, m5]) => md5Of(sig) === m5), 'the seven bodies have their live md5 again');
  } else ok(!DRAINER, `the drainer rollback file is there (${FILES.dRb})`);
  c.use('n_demo');
}

// The copy's checks booked again as NEW sales (ids rh-<n>, so the demo id gate books them; closed in the
// last hour; refunds sent afterwards as the till sends them), on a copy without the release and on a copy
// with it: every movement, waste row and outbox event identical, except the part refunds whose lines
// carry no uid (contract D4: the sale's own average per unit, which differs from today's only when one
// menu item was sold with different options in one check).
function replay(rows) {
  const t0 = Date.now() - 60 * 60000;
  const ids = new Map(rows.map((r, k) => [r.id, `rh-${k + 1}`]));
  const sales = rows.map((r, k) => {
    const x = { ...r, id: ids.get(r.id), ref: `RH${k + 1}`, closed_at: new Date(t0 + k * 1000).toISOString(), refunds: [], status: r.voided ? r.status : 'paid', refunded: false };
    delete x.tax_breakdown;
    return x;
  });
  const refunds = rows.flatMap((r) => (Array.isArray(r.refunds) ? r.refunds : []).filter((e) => e && typeof e === 'object' && e.id != null)
    .map((e, j) => ({ id: ids.get(r.id), status: r.status, e: { ...e, timestamp: t0 + 50 * 60000 + j * 1000 } })));
  // part refunds (not isFullRefund) with a line that carries no uid: D4 may give back another figure
  const noUid = new Set(refunds.filter((x) => !(x.e.isFullRefund === true || x.e.isFullRefund === 'true')
    && (Array.isArray(x.e.items) ? x.e.items : []).some((l) => l && typeof l === 'object' && (l.uid == null || l.uid === ''))).map((x) => String(x.e.id)));
  const drainAll = () => { for (let k = 0; k < 30 && num(`select count(*) from stock_outbox where status = 'pending' and due_at <= now()`) > 0; k++) sql('call public.stock_outbox_drain(10, 200, 0.05, true);'); };
  const out = {};
  for (const [label, withRelease] of [['v1', false], ['v2', true]]) {
    c.use('n_demo');
    c.createFrom(`n_rh_${label}`, 'n_demo');
    c.use(`n_rh_${label}`);
    if (withRelease) {
      c.sqlFile(join(here, 'live_discounts.sql'));
      const r = c.paste(FILES.d);
      ok(r.status === 0, `replay ${label}: the release applies`);
    } else c.sqlFile(join(here, 'live_discounts.sql'));
    let bad = 0;
    for (let k = 0; k < sales.length; k += 100) {
      const chunk = sales.slice(k, k + 100).map((x) => `${insertRow(x)};`).join('\n');
      if (c.psql({ input: chunk, allowFail: true }).status) bad++;
    }
    drainAll();
    for (const x of refunds) {
      const r = c.psql({ input: `update closed_checks set refunds = coalesce(refunds, '[]'::jsonb) || ${lit(JSON.stringify([x.e]))}::jsonb, status = ${lit(x.status === 'refunded' ? 'refunded' : 'partial_refund')} where id = ${lit(x.id)}`, allowFail: true });
      if (r.status) bad++;
    }
    drainAll();
    ok(bad === 0, `replay ${label}: ${sales.length} checks and ${refunds.length} refunds written`);
    out[label] = pj(sql(basketBookedSql('rh', t0)));
    const st = pj(sql(`select json_object_agg(status, n) from (select status, count(*) n from stock_outbox where left(check_id, 3) = 'rh-' group by status) z`)) || {};
    info(`replay ${label}: ${out[label].movements.length} movements, ${out[label].waste.length} waste rows, outbox ${short(st)}`);
  }
  const keyRef = (m) => String(m.key).split(':')[2];
  // a waste row belongs to the refund whose WASTE movement made it (waste_events.id = md5(key)::uuid)
  const md5uuid = (t) => { const h = createHash('md5').update(t).digest('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`; };
  const wasteRef = (set) => new Map((set.movements || []).filter((m) => m.type === 'WASTE').map((m) => [md5uuid(m.key), keyRef(m)]));
  const aside = { movements: (r) => noUid.has(keyRef(r)), outbox: (r) => r.kind === 'refund' && noUid.has(String(r.ref)) };
  for (const part of ['movements', 'waste', 'outbox']) {
    const pick = (set) => {
      const wr = wasteRef(set);
      const out2 = part === 'waste' ? (set[part] || []).filter((r) => !noUid.has(wr.get(r.id))) : (set[part] || []).filter((r) => !aside[part](r));
      return out2.map((r) => JSON.stringify(r));
    };
    const a = pick(out.v1); const b = pick(out.v2);
    const sa = new Set(a); const sb = new Set(b);
    const onlyA = a.filter((r) => !sb.has(r)); const onlyB = b.filter((r) => !sa.has(r));
    ok(onlyA.length === 0 && onlyB.length === 0, `replay: identical ${part} before and after the release (${a.length} rows${noUid.size ? `; the ${noUid.size} part refunds with no uid aside (D4)` : ''}; only before ${short(onlyA.slice(0, 2), 500)}; only after ${short(onlyB.slice(0, 2), 500)})`);
  }
  // D4 (part refunds with no uid): what came back, before and after; never more than the sale took
  if (noUid.size) {
    const back = (set, ref) => (set.movements || []).filter((m) => keyRef(m) === ref && (m.type === 'RETURN' || (m.type === 'SALE_DEPLETION' && Number(m.qty) > 0)))
      .reduce((o, m) => ({ ...o, [m.item]: (o[m.item] || 0) + Number(m.qty) }), {});
    const took = (set, check) => (set.movements || []).filter((m) => m.check === check && m.key.startsWith(`sale:${check}:`))
      .reduce((o, m) => ({ ...o, [m.item]: (o[m.item] || 0) - Number(m.qty) }), {});
    const over = [];
    const lines = [];
    for (const x of refunds.filter((y) => noUid.has(String(y.e.id)))) {
      const b1 = back(out.v1, String(x.e.id)); const b2 = back(out.v2, String(x.e.id)); const t = took(out.v2, x.id);
      for (const [it, q] of Object.entries(b2)) if (q > (t[it] || 0) + 1e-4) over.push(`${x.e.id} ${it.slice(0, 8)} ${q} > ${t[it] || 0}`);
      lines.push(`${x.e.id}: ${Object.keys(b1).length} items ${Object.values(b1).reduce((s2, q) => s2 + q, 0).toFixed(4)} / ${Object.keys(b2).length} items ${Object.values(b2).reduce((s2, q) => s2 + q, 0).toFixed(4)}`);
    }
    info(`part refunds with no uid (D4: the sale's own average per unit), given back before / after: ${lines.slice(0, 8).join('; ')}`);
    ok(over.length === 0, `D4 on the replay: no part refund gives back more of an item than its sale took (${over.slice(0, 3).join('; ') || 'none'})`);
  }
  // the day totals kept live on real menus: equal to the ledger once the drain has run
  c.use('n_rh_v2');
  for (let k = 0; k < 20 && num(`select (select count(*) from stock_day_sums_repair where due_at <= now()) + (select count(*) from sales_day_sums_queue where due_at <= now())`) > 0; k++) sql('call public.stock_day_sums_drain(30, 50);');
  const days = pj(sql(`select coalesce(json_agg(distinct jsonb_build_object('l', m.location_id, 'd', d.business_day)), '[]') from stock_movements m
                         cross join lateral public.stock_co__venue_day(m.location_id, m.occurred_at) d where left(m.source_id, 3) = 'rh-'`)) || [];
  const dBad = days.map((x) => ({ ...x, r: pj(sql(`select public.stock_day_sums_check('${x.l}', '${x.d}')`)) })).filter((x) => !x.r?.ok);
  ok(days.length > 0 && dBad.length === 0, `replay v2: stock_day_sums equals the ledger on every venue day the replay touched (${dBad.length ? short(dBad, 400) : `${days.length} days`})`);
  const takes = num(`select count(*) from stock_sale_takes where left(check_id, 3) = 'rh-'`);
  const saleEvents = num(`select count(*) from stock_outbox where left(check_id, 3) = 'rh-' and kind = 'sale' and status = 'done' and not ('cancelled_before_made' = any (coalesce(flags, '{}')))`);
  ok(takes === saleEvents, `replay v2: one stock_sale_takes row per sale event booked (${takes} of ${saleEvents})`);
  c.use('n_demo');
}

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

console.log('\n6. Drop 1 (20261024a) after 0b, as the SQL editor runs it, then its rollback and Drop 1 again');
if (existsSync(FILES.d1) && existsSync(FILES.d1Rb)) {
  const ORG_B = 'fcbddcfd-a025-407b-9727-9e9139250767';
  const pre = Object.fromEntries(venues.map((v) => [v, venueFigures(c, v)]));
  const r = c.paste(FILES.d1);
  ok(r.status === 0, `Drop 1 applies (${r.status ? short(r.stderr, 800) : `${r.ms} ms`})`);
  const rr = (r.sets[r.sets.length - 1] || { rows: [] }).rows;
  for (const x of rr) console.log(`     ${short(x, 900)}`);
  const by = (o) => rr.find((x) => x.org_id === o) || {};
  const nums = (x, cols) => cols.map((k) => x[k]).join(',');
  const COLS = ['multi', 'categories_seeded', 'items_with_category', 'items_without_category', 'order_rules_seeded', 'order_rules_without_order_by',
    'suppliers_without_cutoff', 'bad_delivery_day_values', 'order_rules_round_trip_bad'];
  ok(nums(by(ORG_T), COLS) === 't,12,51,4,47,10,5,0,0', `a59a6d97: ${nums(by(ORG_T), COLS)} (contract 1.11: t,12,51,4,47,10,5,0,0)`);
  if (demo.locations.some((l) => l.org_id === ORG_B)) ok(nums(by(ORG_B), COLS) === 'f,1,1,0,0,0,1,0,0', `fcbddcfd: ${nums(by(ORG_B), COLS)} (contract 1.11: f,1,1,0,0,0,1,0,0)`);
  ok(rr.every((x) => x.replaced_functions === '24' && x.new_functions === '29' && x.internals_open_to_api === 'f' && x.anon_can_save === 'f'
     && x.site_rows_changed === '0' && x.logins_changed === 'f'), 'every row: 24 replaced, 29 new, internals closed, the anon key saves nothing, no site row or login changed');
  ok(by(ORG_T).levels_on === 'refused, par ok', `the levels dry run as the Provo manager: ${by(ORG_T).levels_on}`);
  for (const v of venues) {
    const d = figureDiff(pre[v], venueFigures(c, v));
    ok(d.length === 0, `${vname[v]}: every count, sum, on hand, cost, ledger line, area holding, par and recipe base quantity identical (${d.join(', ') || 'none differ'})`);
  }
  const trip = num(`select count(*) from suppliers s cross join lateral public.stock_co__derive_days(s.id) d where s.company_ref is not null
                      and ((select coalesce(array_agg(x order by x), '{}') from jsonb_array_elements_text(s.delivery_days) x)
                           is distinct from (select coalesce(array_agg(x order by x), '{}') from jsonb_array_elements_text(d.delivery_days) x)
                           or nullif(s.cutoff_time, '') is distinct from d.cutoff_time)`);
  ok(trip === 0, `every live site supplier row reads back its exact delivery day codes (as a set) and cut off from its order rules (${trip} differ)`);
  for (const v of venues) {
    const ps = pj(sql(`select public.stock_co__sync_site('${v}', null, null, false, true)`)); const pr = pj(sql(`select public.stock_co__sync_recipes('${v}', null, false, true)`));
    ok(ps?.writes === 0 && pr?.writes === 0, `${vname[v]}: the writer still plans zero writes (${ps?.writes}, ${pr?.writes})`);
  }
  const rb = c.paste(FILES.d1Rb);
  const x = ((rb.sets[rb.sets.length - 1] || { rows: [] }).rows[0]) || {};
  console.log(`     rollback: ${short(x, 400)}`);
  ok(rb.status === 0 && x.bodies_restored === '24' && x.drop1_left === '0' && x.site_rows_changed === '0', 'the rollback: the 24 Drop 0 bodies back, nothing of Drop 1 left, no site row changed');
  const again = c.paste(FILES.d1);
  ok(again.status === 0, `Drop 1 applies again after its rollback (${again.status ? short(again.stderr, 400) : 'ok'})`);
} else ok(false, 'the Drop 1 files are there');

console.log('\n7. The drainer release (20261023a) on a copy of the live state: 0a, its revalue file, 0b and Drop 1 in');
if (!existsSync(FILES.d)) {
  if (DRAINER) ok(false, `the drainer file is there (${FILES.d})`);
  else info(`the drainer file is not there yet (${FILES.d}): step skipped (--drainer makes this a failure)`);
} else {
  ok(num('select count(*) from stock_native_backup') === 31 && num(`select count(*) from stock_native_backup where left(name, 3) = 'd1:'`) === 24
     && num(`select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'stock_co_items' and column_name = 'category_id'`) === 1,
    'the copy is at the live state: 0a\'s seven and Drop 1\'s 24 backup rows, Drop 1\'s columns in');
  drainerStep();
}

console.log('\n8. Drop 4a (20261026a) on the drainer copy, its queue drained: the check row, the league, the rollback, 4a again');
if (!DROP4A) info('--drop4a not given: step skipped');
else if (!existsSync(FILES.d4) || !existsSync(FILES.d4Rb)) ok(false, `the 4a files are there (${FILES.d4}, ${FILES.d4Rb})`);
else drop4aStep();
done();

function drop4aStep() {
  const tf = (v) => v === 't' || v === true;
  // the live state on the night 4a runs: the copy, the drainer release in, the copy's checks as they are
  c.use('n_demo');
  c.createFrom('n_d4', 'n_demo');
  c.use('n_d4');
  c.sqlFile(join(here, 'live_discounts.sql'));
  const dr = c.paste(FILES.d);
  ok(dr.status === 0, `the drainer release applies on the copy (${dr.status ? short(dr.stderr, 400) : `${dr.ms} ms`})`);
  if (dr.status) return;
  if (CHECKS && existsSync(CHECKS)) {
    const rows = (JSON.parse(readFileSync(CHECKS, 'utf8')).closed_checks || []).filter((r) => venues.includes(r.location_id));
    const have = new Set(sql(`select string_agg(column_name, ',') from information_schema.columns where table_schema = 'public' and table_name = 'closed_checks'`).split(','));
    const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))].filter((k) => have.has(k)).map((k) => `"${k}"`).join(', ');
    if (rows.length) {
      const r = c.psql({ input: `set session_replication_role = replica;
        insert into public.closed_checks (${cols}) select ${cols} from json_populate_recordset(null::public.closed_checks, ${lit(JSON.stringify(rows))}::json);`, allowFail: true });
      ok(r.status === 0, `${rows.length} closed checks of the copy loaded as they are (no day totals yet: the backfill's work)${r.status ? `: ${short(r.stderr, 300)}` : ''}`);
    }
  } else info('no STOCKN_CHECKS: the backfill has no checks to queue');
  let runs = 0;
  for (; runs < 400 && num(`select (select count(*) from stock_day_sums_repair where due_at <= now()) + (select count(*) from sales_day_sums_queue where due_at <= now())`) > 0; runs++) {
    sql('call public.stock_day_sums_drain(40, 50);');
  }
  ok(num(`select (select count(*) from stock_day_sums_repair) + (select count(*) from sales_day_sums_queue where due_at <= now())`) === 0, `the drainer's queue drained first, as live (${runs} runs)`);
  const demoOrgs = new Set(sql(`select coalesce(string_agg(distinct l.org_id::text, ','), '') from stock_day_sums s join locations l on l.id = s.location_id where s.demo`).split(',').filter(Boolean));
  const r = c.paste(FILES.d4);
  ok(r.status === 0, `4a applies (${r.status ? short(r.stderr, 800) : `${r.ms} ms`})`);
  if (r.status) return;
  const rows = (r.sets[r.sets.length - 1] || { rows: [] }).rows;
  for (const x of rows) console.log(`     ${short(x, 900)}`);
  const orgs = sql(`select coalesce(string_agg(distinct l.org_id::text, ',' order by l.org_id::text), '') from locations l where exists (select 1 from inventory_items i where i.location_id = l.id)`).split(',').filter(Boolean);
  ok(rows.length === orgs.length, `one check row per company that holds stock (${rows.length} of ${orgs.length})`);
  for (const x of rows) {
    const multi = tf(x.multi);
    ok(x.new_tables === '3' && x.new_functions === '26' && x.internals_open_to_api === 'f' && x.anon_can_read_reports === 'f' && x.bucket_ok === 't' && x.policy_ok === 't'
       && x.cron_job === 't' && x.vault_key === 't' && x.site_rows_changed === '0' && x.logins_changed === 'f',
      `${x.org_id.slice(0, 8)}: 3 tables, 26 functions, internals closed, the anon key reads nothing, bucket, policy, cron job, vault key; no site row or login changed`);
    ok(multi ? Number(x.dashboard_ms) < 5000 && tf(x.demo_left_out) === demoOrgs.has(x.org_id) : x.dashboard_ms === 'skipped',
      `${x.org_id.slice(0, 8)}: multi ${x.multi}, dashboard_ms ${x.dashboard_ms}${multi ? ` (under 5000), demo_left_out ${x.demo_left_out}` : ' (one site company)'}`);
    info(`${x.org_id.slice(0, 8)}: backfill ${x.backfill_days_queued} venue days queued, about ${x.backfill_minutes} minutes`);
  }
  if (rows.some((x) => x.org_id === ORG_T)) ok(tf(rows.find((x) => x.org_id === ORG_T).multi), 'a59a6d97 is multi site (contract 1.8)');
  // the backfill drained (time moved on), as the drainer's drain does it a minute at a time live
  sql(`update sales_day_sums_queue set due_at = now() - interval '1 second' where reason = 'drop4a_backfill'`);
  let bruns = 0;
  for (; bruns < 400 && num(`select count(*) from sales_day_sums_queue where due_at <= now()`) > 0; bruns++) sql('call public.stock_day_sums_drain(40, 50);');
  ok(num(`select count(*) from sales_day_sums_queue where reason = 'drop4a_backfill'`) === 0, `the backfill drains (${bruns} runs)`);
  const sites = sql(`select string_agg(id::text, ',' order by name) from locations where org_id = '${ORG_T}' and coalesce(status, 'active') = 'active'`).split(',').filter(Boolean);
  if (sites.length) {
    const lg = c.psql({ input: `begin; select set_config('request.jwt.claims', '{"role":"service_role"}', true) \\g /dev/null
      set local role service_role; set local statement_timeout = '8s';
      select public.stock_report_league('${ORG_T}', array[${sites.map((x) => `'${x}'`).join(',')}]::uuid[], current_date - 30, current_date, null, null, 1000); commit;`, allowFail: true });
    const j = pj((lg.stdout || '').trim().split('\n').filter(Boolean).pop());
    ok(lg.status === 0 && j && j.rows.length === sites.length && j.meta.demo_left_out === demoOrgs.has(ORG_T),
      `the league of the test company as the Owner app asks it (service role, the 8 s limit): ${j ? j.rows.length : 0} sites${j ? `, ${j.rows.map((x) => `${x.site} sales ${x.sales_net} gap ${x.gap_pct}%`).join('; ')}` : `: ${short(lg.stderr, 300)}`}`);
    // each site's sales against the one sales rule (JS) over the copy's real checks, each on its venue day
    if (j && CHECKS && existsSync(CHECKS)) {
      const clk = Object.fromEntries((pj(sql(`select json_agg(json_build_object('loc', l.id, 'tz', coalesce(c.timezone, nullif(l.timezone, ''), 'Europe/London'), 'start', to_char(coalesce(c.day_start, '06:00'), 'HH24:MI')))
                                               from locations l left join venue_clock c on c.location_id = l.id where l.org_id = '${ORG_T}'`)) || []).map((x) => [x.loc, x]));
      const win = pj(sql(`select json_build_object('from', (current_date - 30)::text, 'to', current_date::text)`));
      const real = (JSON.parse(readFileSync(CHECKS, 'utf8')).closed_checks || []).filter((r) => sites.includes(r.location_id));
      const bad = []; const left = [];
      for (const site of j.rows) {
        const k = clk[site.location_id];
        const inWin = real.filter((r) => r.location_id === site.location_id && !(r.voided === true || ['void', 'voided'].includes(r.status || '')))
          .filter((r) => { const d = venueDay(Date.parse(r.closed_at) / 1000, k.tz, k.start); return d >= win.from && d <= win.to; });
        // a check the demo files wrote (id demo-) in the days: the site's sales cannot be told from it
        // (sales_day_sums keeps no demo flag), so the league leaves them out and says so (null)
        const demoHere = inWin.some((r) => String(r.id).startsWith('demo-'));
        const flagged = (j.meta.windows || []).find((w) => w.location_id === site.location_id)?.demo_sales === true;
        if (demoHere !== flagged) bad.push(`${site.site}: ${inWin.filter((r) => String(r.id).startsWith('demo-')).length} demo checks in the days, demo_sales ${flagged}`);
        else if (demoHere) { if (site.sales_net != null || site.gp_pct_theo != null) bad.push(`${site.site}: demo sales in the days but sales ${site.sales_net}`); else left.push(site.site); }
        else {
          const want = inWin.reduce((t, r) => t + jsParts(r).net_minor, 0) / 100;
          if (Math.abs(Number(site.sales_net) - want) > 0.011) bad.push(`${site.site} ${site.sales_net} want ${want.toFixed(2)}`);
        }
      }
      ok(bad.length === 0, `each site's sales in the league = the one sales rule over the copy's real checks, on each venue's own business day; a site with demo checks in the days has its sales left out (${bad.join('; ') || `${j.rows.map((x) => `${x.site} ${x.sales_net}`).join(', ')}${left.length ? `; demo sales left out at ${left.join(', ')}` : ''}`})`);
    }
  }
  // the dashboard on Provo and Location 2 as the head office opens it: "Demo history left out"; each
  // site's sales are the sum of its products' sales (the same spread rule as report_day_sums); the
  // product GP site row is the sum of its products' GP; and from each site's takes_from day (the first
  // day the drainer wrote what each sale took off) the dashboard's site GP is the sum of product GP.
  // Before takes_from a product's plate cost is not known (never a 100% GP), so with known = true the
  // window must start on or after takes_from. The copy holds no logins, so the guard is passed with the
  // service role claim and the call runs as the database owner (product_gp is granted to authenticated
  // only; who may call what is section 32 of run.mjs).
  const dashGp = (label, from, to, known) => {
    const both = [PROVO, LOC2];
    const svcJ = (q) => {
      const r = c.psql({ input: `begin; select set_config('request.jwt.claims', '{"role":"service_role"}', true) \\g /dev/null
        set local statement_timeout = '8s';
        select ${q}; commit;`, allowFail: true });
      return { status: r.status, stderr: r.stderr, j: pj((r.stdout || '').trim().split('\n').filter(Boolean).pop()) };
    };
    const call = (name, opts, after) => svcJ(`public.stock_report_${name}('${ORG_T}', array['${PROVO}', '${LOC2}']::uuid[], ${from}, ${to}, ${opts ? `'${JSON.stringify(opts)}'::jsonb` : 'null'}, ${after ? `${lit(JSON.stringify(after))}::jsonb` : 'null'}, 1000)`);
    const dash = call('dashboard', null, null);
    ok(dash.status === 0 && dash.j && dash.j.meta && dash.j.meta.demo_left_out === true,
      `${label}the dashboard on Provo and Location 2 says "Demo history left out" (meta.demo_left_out ${dash.j ? dash.j.meta?.demo_left_out : short(dash.stderr, 300)})`);
    const prows = []; let after = null; let pages = 0; let perr = null; let pg = null;
    for (;;) {
      const r = call('product_gp', { level: 'site_product' }, after);
      if (r.status !== 0 || !r.j) { perr = short(r.stderr, 300); break; }
      pages++; if (!pg) pg = r.j; prows.push(...(r.j.rows || []));
      if (!r.j.next || pages >= 400) break;
      after = r.j.next;
    }
    const tot = (ans, loc) => ((ans && ans.totals) || []).find((t) => t.location_id === loc) || {};
    const win = pj(sql(`select json_build_object('from', (${from})::text, 'to', (${to})::text)`));
    const bad = []; const said = [];
    for (const loc of both) {
      const name = loc === PROVO ? 'Provo' : 'Location 2';
      const mine = prows.filter((r) => r.location_id === loc);
      const kn = mine.filter((r) => r.theo_cost != null);
      const pNet = mine.reduce((t, r) => t + Number(r.sales_net || 0), 0);
      // product GP is over the sales with a plate cost (known_net: from takes_from on)
      const pGp = kn.reduce((t, r) => t + Number(r.known_net ?? r.sales_net ?? 0) - Number(r.theo_cost), 0);
      const d = tot(dash.j, loc); const ps = tot(pg, loc);
      const takes = ps.known_from || null;
      // demo checks in the days (the copy's are): sales and GP left out, no product rows, words
      if ((dash.j?.meta?.windows || []).find((w) => w.location_id === loc)?.demo_sales === true) {
        if (known) bad.push(`${name}: demo sales in a window that must have none`);
        else if (d.sales_net !== null || d.gp_pct_theo !== null || d.demo_sales !== true || ps.gp !== null || ps.demo_sales !== true || mine.length
                 || !(dash.j.meta.notes || []).includes(`Demo sales on these days at ${name}: its sales and GP are not shown`)) {
          bad.push(`${name}: demo sales in the days, but sales ${d.sales_net}, GP ${ps.gp}, ${mine.length} product rows`);
        } else said.push(`${name}: demo sales in the days, so its sales and GP are not shown (no product row, "Demo sales on these days at ${name}")`);
        continue;
      }
      const dGp = Number(d.sales_net || 0) - Number(d.theo_cost || 0);
      if (Math.abs(Number(d.sales_net || 0) - pNet) > 0.011 || Math.abs(Number(ps.sales_net || 0) - pNet) > 0.011) bad.push(`${name}: sales dashboard ${d.sales_net}, product site row ${ps.sales_net}, sum of ${mine.length} products ${pNet.toFixed(2)}`);
      if (kn.length ? Math.abs(Number(ps.gp) - pGp) > 0.011 : ps.gp != null) bad.push(`${name}: product GP site row ${ps.gp}, sum of ${kn.length} known products ${pGp.toFixed(2)}`);
      if (takes && takes <= win.from) {
        if (Math.abs(dGp - pGp) > 0.011 || kn.length !== mine.length) bad.push(`${name}: dashboard GP ${dGp.toFixed(2)}, sum of product GP ${pGp.toFixed(2)} (${kn.length} of ${mine.length} products with a plate cost)`);
        else said.push(`${name} GP ${dGp.toFixed(2)} = ${mine.length} products`);
      } else if (known) bad.push(`${name}: plate costs known from ${takes || 'never'}, the window starts ${win.from}`);
      else said.push(`${name} sales ${pNet.toFixed(2)} = ${mine.length} products; plate cost not known before ${takes || 'the first sale the drainer takes off'} (GP ${ps.gp == null ? 'not shown' : ps.gp})`);
    }
    ok(!perr && dash.status === 0 && bad.length === 0, `${label}the dashboard's site figures = the sum of product figures at Provo and Location 2, ${win.from} to ${win.to} (${perr || bad.join('; ') || `${said.join('; ')}; ${pages} page(s)`})`);
  };
  dashGp('', 'current_date - 30', 'current_date', false);
  // the days after the last demo check of the copy: the real checks only, every figure shown
  if (CHECKS && existsSync(CHECKS)) {
    const last = (JSON.parse(readFileSync(CHECKS, 'utf8')).closed_checks || []).filter((r) => [PROVO, LOC2].includes(r.location_id) && String(r.id).startsWith('demo-'))
      .map((r) => r.closed_at).sort().pop();
    if (last) {
      const after = sql(`select (greatest((public.stock_co__venue_day('${PROVO}', '${last}'::timestamptz)).business_day, (public.stock_co__venue_day('${LOC2}', '${last}'::timestamptz)).business_day) + 1)::text`);
      if (after <= sql('select current_date::text')) dashGp(`after the last demo check (${after} on): `, `'${after}'::date`, 'current_date', false);
      else info(`the copy's last demo check is today: no day after it to rehearse`);
    }
  }
  const rb = c.paste(FILES.d4Rb);
  const x = ((rb.sets[rb.sets.length - 1] || { rows: [] }).rows[0]) || {};
  console.log(`     rollback: ${short(x, 400)}`);
  ok(rb.status === 0 && x.functions_left === '0' && x.tables_left === '0' && x.bucket_left === 'f' && x.cron_left === 'f', 'the rollback: nothing of 4a left (functions, tables, bucket, cron job)');
  const again = c.paste(FILES.d4);
  ok(again.status === 0, `4a applies again after its rollback (${again.status ? short(again.stderr, 400) : 'ok'})`);

  // the live order since 21 Oct 2026: the drainer release AND Drop 2 are live before 4a. 4a needs no
  // Drop 2 table (the steps above prove that); here it runs on top of Drop 2 as Peter will run it.
  if (!D2_LIVE) { info('the copy was taken before Drop 2 ran live: 4a on top of Drop 2 not rehearsed'); return; }
  if (!existsSync(FILES.d2)) { ok(false, `the copy was taken after Drop 2 ran live, so 4a is rehearsed on top of it: set STOCKN_D2 to 20261025a_OPS_stock_native_2.sql (${FILES.d2} is not there)`); return; }
  c.use('n_demo');
  c.createFrom('n_d4live', 'n_demo');
  c.use('n_d4live');
  c.sqlFile(join(here, 'live_discounts.sql'));
  const dl = c.paste(FILES.d);
  ok(dl.status === 0, `live order: the drainer release applies (${dl.status ? short(dl.stderr, 400) : `${dl.ms} ms`})`);
  if (dl.status) return;
  // what the harness database lacks of the live Ops shape that Drop 2 reads, made the way live has it
  // (the same lines as D2_SHAPE in drop2.mjs of the Drop 2 release)
  c.psql({ input: `
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
` });
  const d2 = c.paste(FILES.d2);
  ok(d2.status === 0, `live order: Drop 2 (20261025a) applies after the drainer (${d2.status ? short(d2.stderr, 400) : `${d2.ms} ms`})`);
  if (d2.status) return;
  if (CHECKS && existsSync(CHECKS)) {
    const rows = (JSON.parse(readFileSync(CHECKS, 'utf8')).closed_checks || []).filter((r) => venues.includes(r.location_id));
    const have = new Set(sql(`select string_agg(column_name, ',') from information_schema.columns where table_schema = 'public' and table_name = 'closed_checks'`).split(','));
    const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))].filter((k) => have.has(k)).map((k) => `"${k}"`).join(', ');
    if (rows.length) {
      const r2 = c.psql({ input: `set session_replication_role = replica;
        insert into public.closed_checks (${cols}) select ${cols} from json_populate_recordset(null::public.closed_checks, ${lit(JSON.stringify(rows))}::json);`, allowFail: true });
      ok(r2.status === 0, `live order: ${rows.length} closed checks of the copy loaded${r2.status ? `: ${short(r2.stderr, 300)}` : ''}`);
    }
  }
  for (let k = 0; k < 400 && num(`select (select count(*) from stock_day_sums_repair where due_at <= now()) + (select count(*) from sales_day_sums_queue where due_at <= now())`) > 0; k++) sql('call public.stock_day_sums_drain(40, 50);');
  const d4l = c.paste(FILES.d4);
  ok(d4l.status === 0, `live order: 4a applies on top of the drainer and Drop 2 (${d4l.status ? short(d4l.stderr, 800) : `${d4l.ms} ms`})`);
  if (d4l.status) return;
  const lrows = (d4l.sets[d4l.sets.length - 1] || { rows: [] }).rows;
  const lt = lrows.find((y) => y.org_id === ORG_T) || {};
  ok(lrows.length === orgs.length && lrows.every((y) => y.new_tables === '3' && y.new_functions === '26' && y.internals_open_to_api === 'f' && y.anon_can_read_reports === 'f'
       && y.site_rows_changed === '0' && y.logins_changed === 'f') && tf(lt.multi) && Number(lt.dashboard_ms) < 5000 && tf(lt.demo_left_out),
    `live order: the check row as before (a59a6d97 multi ${lt.multi}, dashboard_ms ${lt.dashboard_ms}, demo_left_out ${lt.demo_left_out}; no site row or login changed)`);
  sql(`update sales_day_sums_queue set due_at = now() - interval '1 second' where reason = 'drop4a_backfill'`);
  for (let k = 0; k < 400 && num(`select count(*) from sales_day_sums_queue where due_at <= now()`) > 0; k++) sql('call public.stock_day_sums_drain(40, 50);');
  dashGp('live order: ', 'current_date - 30', 'current_date', false);
  // the copy's checks sold again through the drainer as NEW sales (ids d4-<n>, closed in the last hour, as
  // the drainer takes a sale), then moved whole (movements, takes, checks) to a quiet venue day ten days
  // before the first movement or check of either site and that day's totals rebuilt: a day on which every
  // sale has its takes, so the site GP from the ledger and the sum of product GP from the takes must
  // agree to the penny, and takes_from is that day. Today keeps the old rule's sales only.
  if (CHECKS && existsSync(CHECKS)) {
    const quiet = sql(`select (least((select min(occurred_at) from stock_movements where location_id in ('${PROVO}', '${LOC2}')),
                                      (select min(closed_at) from closed_checks where location_id in ('${PROVO}', '${LOC2}')))::date - 10)::text`);
    const t1 = Date.now() - 60 * 60000;
    const real = (JSON.parse(readFileSync(CHECKS, 'utf8')).closed_checks || []).filter((r) => [PROVO, LOC2].includes(r.location_id));
    const sales = real.map((r, k) => {
      const y = { ...r, id: `d4-${k + 1}`, ref: `D4${k + 1}`, closed_at: new Date(t1 + k * 1000).toISOString(), refunds: [], status: r.voided ? r.status : 'paid', refunded: false };
      delete y.tax_breakdown;
      return y;
    });
    let bad = 0;
    for (let k = 0; k < sales.length; k += 100) {
      if (c.psql({ input: sales.slice(k, k + 100).map((y) => `${insertRow(y)};`).join('\n'), allowFail: true }).status) bad++;
    }
    for (let k = 0; k < 30 && num(`select count(*) from stock_outbox where status = 'pending' and due_at <= now()`) > 0; k++) sql('call public.stock_outbox_drain(10, 200, 0.05, true);');
    const takes = num(`select count(*) from stock_sale_takes where check_id like 'd4-%'`);
    const shift = `(now() - timestamptz '${quiet} 11:00:00+00')`;
    const mv = c.psql({ input: `set session_replication_role = replica;
      update stock_movements set occurred_at = occurred_at - ${shift} where location_id in ('${PROVO}', '${LOC2}') and source_id like 'd4-%';
      update stock_sale_takes set occurred_at = occurred_at - ${shift} where location_id in ('${PROVO}', '${LOC2}') and check_id like 'd4-%';
      update closed_checks set closed_at = closed_at - ${shift} where id like 'd4-%';
      set session_replication_role = origin;
      select public.stock_day_sums_rebuild(l, '${quiet}'::date, current_date + 1), public.sales_day_sums_rebuild(l, '${quiet}'::date, current_date + 1)
        from unnest(array['${PROVO}', '${LOC2}']::uuid[]) l;`, allowFail: true });
    const onDay = num(`select count(*) from stock_movements m cross join lateral public.stock_co__venue_day(m.location_id, m.occurred_at) d
                        where m.source_id like 'd4-%' and m.movement_type = 'SALE_DEPLETION' and d.business_day = '${quiet}'`);
    ok(bad === 0 && takes > 0 && mv.status === 0 && onDay > 0,
      `live order: ${sales.length} of the copy's checks sold again through the drainer (${takes} with takes) and moved to ${quiet} (${onDay} take off movements on that day)${mv.status ? `: ${short(mv.stderr, 300)}` : ''}`);
    const tfs = [PROVO, LOC2].map((l) => sql(`select coalesce(public.stock_rp__takes_from('${l}')::text, 'none')`));
    ok(tfs.every((d) => d === quiet), `live order: takes_from is ${quiet} at both sites (${tfs.join(', ')})`);
    dashGp('live order, every sale with its takes: ', `'${quiet}'::date`, `'${quiet}'::date`, true);
    // and a sale taken off by the old rule earlier on the first take day moves takes_from to the next day
    // (the night the release goes live), so no window claims a plate cost it does not have
    const early = c.psql({ input: `set session_replication_role = replica;
      insert into stock_movements (location_id, inventory_item_id, qty_base, unit_cost, value_delta, movement_type, source_type, source_id, occurred_at, idempotency_key)
      select m.location_id, m.inventory_item_id, -1, m.unit_cost, -coalesce(m.unit_cost, 0), 'SALE_DEPLETION', 'sale', 'd4old-1', timestamptz '${quiet} 07:00:00+00', 'd4old-1:1'
        from stock_movements m where m.location_id = '${PROVO}' and m.source_id like 'd4-%' and m.movement_type = 'SALE_DEPLETION' limit 1;`, allowFail: true });
    const nextDay = sql(`select ('${quiet}'::date + 1)::text`);
    const tfp = sql(`select coalesce(public.stock_rp__takes_from('${PROVO}')::text, 'none')`);
    ok(early.status === 0 && tfp === nextDay && sql(`select public.stock_rp__takes_from('${LOC2}')::text`) === quiet,
      `live order: an old rule sale earlier on ${quiet} at Provo moves its takes_from to ${nextDay} (${tfp}); Location 2 keeps ${quiet}${early.status ? `: ${short(early.stderr, 300)}` : ''}`);
  } else info('no STOCKN_CHECKS: the site GP against product GP from the takes is not rehearsed on real baskets');
}
