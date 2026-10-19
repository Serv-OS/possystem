#!/usr/bin/env node
// run.mjs: proves 20261019c (multi site stock, Phase 1 and 1b, v5.11.80) on a local, throwaway
// PostgreSQL 17 before Peter runs it on the Ops database. It never connects to Supabase.
//
//   node supabase/tests/stock_company/run.mjs            the whole proof (50 sites in the scale part)
//   node supabase/tests/stock_company/run.mjs --quick    10 sites in the scale part
//   node supabase/tests/stock_company/run.mjs --seed=7   replay the random runs of that seed
//
// The database is built the way Ops is: the live table shapes and row level security of the stock
// tables (../stock_phase0/schema.sql, policies.sql, central_schema.sql, extra_schema.sql here), the
// 20261016 / 5 Aug function texts, then the REAL 20261018a, 20261018c, 20261019 (every venue central)
// and 20261019b files as Peter ran them, the Multi site menu helpers copied from the REAL 20261017,
// then 20261019c as the SQL editor runs a paste (one transaction). Every API call is made the way
// PostgREST makes it: logged in as authenticator, SET ROLE anon, authenticated or service_role, the
// request claims set, and the live limits (authenticated and service role 8 s, anon 3 s, lock 8 s).
// The runner (pg_cron) and the SQL editor log in as postgres. Exit code 0 only when every check holds.

import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..');
const P0 = join(repo, 'supabase/tests/stock_phase0');
const FLIVE = join(repo, 'supabase/tests/stock_function_fences/live');
const MIG = (f) => join(repo, 'supabase/migrations', f);
const FENCES = MIG('20261018a_OPS_stock_function_fences.sql');
const CENTRAL = MIG('20261018c_OPS_central_stock_depletion.sql');
const CENTRAL_DEFAULT = MIG('20261019_OPS_central_stock_default.sql');
const PHASE0 = MIG('20261019b_OPS_stock_phase0.sql');
const MSM = MIG('20261017_OPS_multi_site_menu.sql');
const MIGRATION = process.env.STOCK1_MIGRATION || MIG('20261019c_OPS_stock_company.sql');
const ROLLBACK = process.env.STOCK1_ROLLBACK || MIG('20261019c_OPS_stock_company_ROLLBACK.sql');
const QUICK = process.argv.includes('--quick');
const SEED = Number((process.argv.find((a) => a.startsWith('--seed=')) || '').slice(7)) || (Date.now() % 1000000);
const SCALE_SITES = QUICK ? 10 : 50;
const SCALE_ITEMS = 5000;

const bin = (name) => (existsSync(`/opt/homebrew/bin/${name}`) ? `/opt/homebrew/bin/${name}` : name);
const env = { ...process.env, LC_ALL: 'en_US.UTF-8', PGOPTIONS: '-c client_min_messages=warning' };

let failures = 0;
let checks = 0;
const ok = (cond, msg) => { checks++; if (cond) console.log(`  ok   ${msg}`); else { failures++; console.log(`  FAIL ${msg}`); } };
const near = (a, b, eps = 1e-4) => Math.abs(Number(a) - Number(b)) <= eps;
function rng(seed) {
  let t = seed >>> 0;
  return () => { t += 0x6D2B79F5; let r = Math.imul(t ^ (t >>> 15), 1 | t); r ^= r + Math.imul(r ^ (r >>> 7), 61 | r); return ((r ^ (r >>> 14)) >>> 0) / 4294967296; };
}

// -- the cluster -------------------------------------------------------------------------------------
const port = process.env.STOCK1_PGPORT || String(55600 + Math.floor(Math.random() * 80));
const dir = mkdtempSync(join(tmpdir(), 'pg1.'));
const data = join(dir, 'data');
{
  let r = spawnSync(bin('initdb'), ['-D', data, '-U', 'postgres', '--auth=trust', '-E', 'UTF8'], { env, encoding: 'utf8' });
  if (r.status !== 0) { console.error(r.stderr || r.stdout); process.exit(2); }
  r = spawnSync(bin('pg_ctl'), ['-D', data, '-l', join(dir, 'pg.log'), '-w', '-o',
    `-p ${port} -c listen_addresses='' -k ${dir} -c max_connections=80 -c fsync=off -c synchronous_commit=off -c shared_buffers=256MB -c work_mem=32MB`, 'start'], { env, encoding: 'utf8' });
  if (r.status !== 0) { console.error(r.stderr || r.stdout); process.exit(2); }
}
function stop() {
  spawnSync(bin('pg_ctl'), ['-D', data, '-m', 'fast', '-w', 'stop'], { env, encoding: 'utf8' });
  rmSync(dir, { recursive: true, force: true });
}
process.on('uncaughtException', (e) => { console.error(e); stop(); process.exit(2); });

let DB = 'postgres';
function psql({ login = 'postgres', db = DB, input, args = [], allowFail = false }) {
  const r = spawnSync(bin('psql'), ['-h', dir, '-p', port, '-U', login, '-d', db, '-v', 'ON_ERROR_STOP=1', '-X', '-q', '-At', ...args],
    { env, input, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
  if (r.status !== 0 && !allowFail) {
    console.error('psql failed:', args.join(' '), '\n', (r.stderr || r.stdout || '').slice(0, 4000));
    stop(); process.exit(2);
  }
  return r;
}
const sql = (q, opts = {}) => psql({ ...opts, input: q }).stdout.trim();
const sqlFile = (path, opts = {}) => psql({ ...opts, args: ['-1', '-f', path] });
const lit = (v) => (v == null ? 'null' : `'${String(v).replace(/'/g, "''")}'`);
const jlit = (o) => `${lit(JSON.stringify(o))}::jsonb`;
const num = (q) => Number(sql(q));
const arr = (ids) => (ids == null ? 'null' : `array[${ids.map((x) => `'${x}'`).join(',')}]::uuid[]`);

// -- fixtures ----------------------------------------------------------------------------------------
const id = (prefix, tail) => `${prefix}-0000-4000-8000-${String(tail).padStart(12, '0')}`;
const ORG_A = id('0a000000', 'a'), ORG_B = id('0b000000', 'b'), ORG_BIG = id('0c000000', 'c');
const A1 = id('a1000000', 'a1'), A2 = id('a2000000', 'a2'), A3 = id('a3000000', 'a3'), B1 = id('b1000000', 'b1'), B2 = id('b2000000', 'b2');
const U = {
  superAdmin: id('10000000', 'ff'), editorA: id('10000000', 'ed'), viewerA: id('10000000', 'ee'), menuOnlyA: id('10000000', 'ef'),
  boA1: id('10000000', 'a1'), boA2: id('10000000', 'a2'), ownerA: id('10000000', 'a'), boB1: id('10000000', 'b1'), editorBig: id('10000000', 'cc'),
};
const DEV = { tillA1: id('20000000', 'a1') };
const STRANGER = id('30000000', '1');
const I = {
  milk: id('40000000', 'a11'), beans: id('40000000', 'a12'), cups: id('40000000', 'a13'), syrup: id('40000000', 'a14'),
  lemons: id('40000000', 'a15'), old: id('40000000', 'a16'),
  beans2: id('40000000', 'a22'), cups2: id('40000000', 'a23'), milk2: id('40000000', 'a21'), own2: id('40000000', 'a24'), b1: id('40000000', 'b11'),
};
const AR = { bar: id('50000000', 'a11'), cellar: id('50000000', 'a12'), bar2: id('50000000', 'a21'), b1: id('50000000', 'b11') };
const SUP = { dairy: id('60000000', 'a1'), beanco: id('60000000', 'a1b'), dairy2: id('60000000', 'a2'), b1: id('60000000', 'b1') };
const SP = { milk: id('61000000', 'a11'), beans: id('61000000', 'a12'), cups: id('61000000', 'a13'), cups2: id('61000000', 'a23') };
const PACK = { milkCase: id('62000000', 'a11'), milkBottle: id('62000000', 'a12'), beansBag: id('62000000', 'a13') };
const TAX = { a1std: id('63000000', 'a11'), a1red: id('63000000', 'a12'), a2std: id('63000000', 'a21'), a2red: id('63000000', 'a22') };

const anonSession = (sub) => ({ sub, role: 'authenticated', is_anonymous: true, aud: 'authenticated' });
const login = (sub) => ({ sub, role: 'authenticated', is_anonymous: false, aud: 'authenticated' });
const CALLERS = {
  superAdmin: { login: 'authenticator', role: 'authenticated', claims: login(U.superAdmin), what: 'super admin (second step)' },
  editorA: { login: 'authenticator', role: 'authenticated', claims: login(U.editorA), what: 'stock Editor of company A' },
  viewerA: { login: 'authenticator', role: 'authenticated', claims: login(U.viewerA), what: 'stock Viewer of company A' },
  menuOnlyA: { login: 'authenticator', role: 'authenticated', claims: login(U.menuOnlyA), what: 'menu editor of A, not a stock person' },
  boA1: { login: 'authenticator', role: 'authenticated', claims: login(U.boA1), what: 'site manager of A1' },
  boA2: { login: 'authenticator', role: 'authenticated', claims: login(U.boA2), what: 'site manager of A2' },
  ownerA: { login: 'authenticator', role: 'authenticated', claims: login(U.ownerA), what: 'owner of company A (not a stock person)' },
  boB1: { login: 'authenticator', role: 'authenticated', claims: login(U.boB1), what: 'manager of another company' },
  editorBig: { login: 'authenticator', role: 'authenticated', claims: login(U.editorBig), what: 'stock Editor of the 50 site company' },
  tillA1: { login: 'authenticator', role: 'authenticated', claims: anonSession(DEV.tillA1), what: 'till bound to A1' },
  service: { login: 'authenticator', role: 'service_role', claims: { role: 'service_role' }, what: 'service role' },
  stranger: { login: 'authenticator', role: 'authenticated', claims: anonSession(STRANGER), what: 'stranger (anonymous)' },
  anonKey: { login: 'authenticator', role: 'anon', claims: { role: 'anon' }, what: 'bare anon key' },
  sqlEditor: { login: 'postgres', what: 'SQL editor / pg_cron' },
};
function callerLines(c) {
  const lines = ['\\set VERBOSITY verbose', 'begin;'];
  if (c.claims) lines.push(`select set_config('request.jwt.claims', ${lit(JSON.stringify(c.claims))}, true) \\g /dev/null`);
  if (c.role) {
    lines.push(`set local role ${c.role};`);
    if (c.role === 'authenticated' || c.role === 'service_role') lines.push(`set local statement_timeout = '8s';`);
    if (c.role === 'anon') lines.push(`set local statement_timeout = '3s';`);
    lines.push(`set local lock_timeout = '8s';`);
  }
  return lines;
}
function asCaller(callerKey, body, { commit = true } = {}) {
  const c = CALLERS[callerKey];
  const lines = callerLines(c);
  lines.push(body.trim().replace(/;?$/, ';'));
  lines.push(commit ? 'commit;' : 'rollback;');
  const t0 = Date.now();
  const r = psql({ login: c.login, input: lines.join('\n') + '\n', allowFail: true });
  const m = /ERROR:\s+([0-9A-Z]{5}):\s*(.*)/.exec(r.stderr || '');
  return { status: r.status, sqlstate: m ? m[1] : null, message: m ? m[2] : (r.stderr || '').trim(), out: r.stdout.trim(), ms: Date.now() - t0 };
}
const lastJson = (r) => { try { return JSON.parse(r.out.split('\n').filter(Boolean).pop()); } catch { return null; } };
const callJ = (callerKey, body) => { const r = asCaller(callerKey, body); return { ...r, j: lastJson(r) }; };
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
function oneShot(login, body) {
  return new Promise((res) => {
    const t0 = Date.now();
    const p = spawn(bin('psql'), ['-h', dir, '-p', port, '-U', login, '-d', DB, '-v', 'ON_ERROR_STOP=1', '-X', '-q', '-At'], { env });
    let err = ''; let out = '';
    p.stderr.on('data', (d) => { err += d; }); p.stdout.on('data', (d) => { out += d; });
    p.on('close', (code) => { const m = /ERROR:\s+([0-9A-Z]{5})/.exec(err); res({ code, err, out: out.trim(), sqlstate: m ? m[1] : null, ms: Date.now() - t0 }); });
    p.stdin.end(body);
  });
}
const runDue = (secs = 30) => sql(`call public.msm_stock_run_due(${secs});`);

// The Multi site menu helpers 20261019c needs, word for word from the REAL 20261017 file.
function msmHelpers() {
  const text = readFileSync(MSM, 'utf8');
  const take = (name) => {
    const m = new RegExp(`create or replace function public\\.${name}\\([\\s\\S]*?\\n\\$fn\\$;`).exec(text);
    if (!m) throw new Error(`20261017 has no ${name}`);
    return m[0];
  };
  return ['msm__second_step_ok', 'msm__require_servos', 'msm_viewable_org_ids', 'msm_editable_org_ids', 'msm_can_edit']
    .map(take).join('\n\n');
}

// Per venue sums (the plan's check rows: 6.4).
const SUMS = (loc) => sql(`select json_build_object(
  'items', (select count(*) from inventory_items where location_id = '${loc}'),
  'on_hand', (select coalesce(sum(on_hand), 0) from inventory_items where location_id = '${loc}'),
  'cost', (select coalesce(sum(current_cost), 0) from inventory_items where location_id = '${loc}'),
  'costs', (select coalesce(json_agg(current_cost order by id), '[]') from inventory_items where location_id = '${loc}'),
  'movements', (select count(*) from stock_movements where location_id = '${loc}'),
  'qty', (select coalesce(sum(qty_base), 0) from stock_movements where location_id = '${loc}'),
  'value', (select coalesce(sum(value_delta), 0) from stock_movements where location_id = '${loc}'),
  'pars', (select coalesce(json_agg(json_build_object('i', inventory_item_id, 'p', par_level) order by inventory_item_id), '[]') from par_levels where location_id = '${loc}'),
  'areas', (select count(*) from storage_areas where location_id = '${loc}'),
  'area_stock', (select coalesce(sum(on_hand), 0) from inventory_item_area_stock where location_id = '${loc}'),
  'counts', (select count(*) from stock_counts where location_id = '${loc}'),
  'preferred', (select coalesce(json_agg(json_build_object('i', id, 's', default_supplier_id) order by id), '[]') from inventory_items where location_id = '${loc}' and default_supplier_id is not null))`);
const QTY_SUMS = (loc) => { const j = JSON.parse(SUMS(loc)); delete j.items; delete j.preferred; delete j.costs; return JSON.stringify(j); };
// Every site row of the five tables at a venue, whole rows (Undo restores exactly).
const SNAP = (loc) => sql(`select json_build_object(
  'items', (select coalesce(json_agg(t order by t.id), '[]') from inventory_items t where t.location_id = '${loc}'),
  'packs', (select coalesce(json_agg(t order by t.id), '[]') from item_packaging_formats t where t.location_id = '${loc}'),
  'bridges', (select coalesce(json_agg(t order by t.id), '[]') from inventory_item_conversions t where t.location_id = '${loc}'),
  'suppliers', (select coalesce(json_agg(t order by t.id), '[]') from suppliers t where t.location_id = '${loc}'),
  'prices', (select coalesce(json_agg(t order by t.id), '[]') from supplier_products t where t.location_id = '${loc}'),
  'areas', (select coalesce(json_agg(t order by t.id), '[]') from inventory_item_areas t where t.location_id = '${loc}'))`);
const planOf = (org, loc) => JSON.parse(sql(`select public.msm_stock__sync_site('${org}', '${loc}', null, false, false)`));
const onHandEqLedger = (loc) => num(`select count(*) from inventory_items i where i.location_id = '${loc}'
   and i.on_hand <> coalesce((select sum(m.qty_base) from stock_movements m where m.inventory_item_id = i.id), 0)`) === 0;

function baseDb(name) {
  DB = 'postgres';
  sql(`drop database if exists ${name}`);
  sql(`create database ${name}`);
  DB = name;
  sqlFile(join(P0, 'schema.sql'));
  sqlFile(join(FLIVE, 'helpers.sql'));
  sql(`revoke all on function public.user_accessible_locations() from public;
       grant execute on function public.user_accessible_locations() to anon, authenticated, service_role;
       grant execute on function public.is_anon_session() to anon, authenticated, service_role;
       grant execute on function public.is_super_admin() to anon, authenticated, service_role;
       revoke all on function public.accessible_location_ids() from public;
       revoke all on function public.accessible_location_uuids() from public;
       grant execute on function public.accessible_location_ids() to anon, authenticated, service_role;
       grant execute on function public.accessible_location_uuids() to anon, authenticated, service_role;`);
  sqlFile(join(P0, 'policies.sql'));
  sqlFile(join(P0, 'central_schema.sql'));
  sqlFile(join(here, 'extra_schema.sql'));
  sqlFile(join(FLIVE, 'post_stock_movement_20261016.sql'));
  sqlFile(join(FLIVE, 'set_inventory_on_hand_20260805.sql'));
  sqlFile(join(FLIVE, 'post_stock_transfer_leg_20261016.sql'));
  sqlFile(join(P0, 'live/rehome_20261016.sql'));
  sqlFile(join(P0, 'live/stock_usage_by_weekday_live.sql'));
  sqlFile(join(P0, 'live/stock_usage_rates_live.sql'));
  sql(`grant execute on function public.post_stock_movement(uuid,uuid,numeric,text,numeric,text,text,text,timestamptz,uuid,text,uuid) to authenticated, anon, service_role;
       grant execute on function public.set_inventory_on_hand(uuid,uuid,numeric,uuid,text) to public, anon, authenticated, service_role;
       revoke all on function public.post_stock_transfer_leg(uuid,text,text) from public, anon;
       grant execute on function public.post_stock_transfer_leg(uuid,text,text) to authenticated, service_role;`);
  psql({ input: msmHelpers() });
  seed();
  sqlFile(FENCES);
  sqlFile(CENTRAL);
  sqlFile(CENTRAL_DEFAULT);
  sqlFile(PHASE0);
}

function seed() {
  sql(`
    insert into organisations (id, name) values ('${ORG_A}', 'Company A'), ('${ORG_B}', 'Company B'), ('${ORG_BIG}', 'Big group');
    insert into locations (id, org_id, name, timezone, created_at) values
      ('${A1}', '${ORG_A}', 'Provo', 'America/Denver', now() - interval '3 days'),
      ('${A2}', '${ORG_A}', 'Location 2', 'Europe/London', now() - interval '2 days'),
      ('${A3}', '${ORG_A}', 'New shop', 'Europe/London', now() - interval '1 day'),
      ('${B1}', '${ORG_B}', 'Other company', 'Europe/London', now() - interval '1 day'),
      ('${B2}', '${ORG_B}', 'Other company 2', 'Europe/London', now() - interval '1 day');
    insert into user_locations (user_id, location_id) values ('${U.boA1}', '${A1}'), ('${U.boA2}', '${A2}'), ('${U.boB1}', '${B1}');
    insert into user_profiles (id, org_id, role, email, full_name) values
      ('${U.boA1}', null, 'manager', 'a1@test', 'Site Manager One'), ('${U.boA2}', null, 'manager', 'a2@test', 'Site Manager Two'),
      ('${U.boB1}', null, 'manager', 'b1@test', 'Other Manager'), ('${U.ownerA}', '${ORG_A}', 'owner', 'owner@test', 'Owner A'),
      ('${U.superAdmin}', null, 'super_admin', 'servos@test', 'ServOS Staff'), ('${U.editorA}', null, 'manager', 'editor@test', 'Hannah Head Office'),
      ('${U.viewerA}', null, 'manager', 'viewer@test', 'Victor Viewer'), ('${U.menuOnlyA}', null, 'manager', 'menu@test', 'Menu Person'),
      ('${U.editorBig}', null, 'manager', 'big@test', 'Big Editor');
    insert into devices (location_id, name, type, status, device_uid, bound_via, last_seen) values
      ('${A1}', 'POS 1', 'pos', 'online', '${DEV.tillA1}', 'claim_device_v2', now());
    insert into msm_company (org_id, enabled) values ('${ORG_A}', true), ('${ORG_BIG}', true), ('${ORG_B}', false);
    insert into msm_members (org_id, user_id, role) values ('${ORG_A}', '${U.menuOnlyA}', 'editor'), ('${ORG_A}', '${U.editorA}', 'editor');
    insert into tax_rates (id, location_id, name, rate, is_default) values
      ('${TAX.a1std}', '${A1}', 'VAT', 0.2, true), ('${TAX.a1red}', '${A1}', 'Reduced Rate', 0.05, false), (gen_random_uuid(), '${A1}', 'Zero Rate', 0, false),
      ('${TAX.a2std}', '${A2}', 'Standard Rate', 0.2, true), ('${TAX.a2red}', '${A2}', 'Reduced Rate', 0.05, false), (gen_random_uuid(), '${A2}', 'Zero Rate', 0, false);
    insert into staff_members (location_id, org_id, name, role, pin, permissions) values
      ('${A1}', '${ORG_A}', 'Mia Manager', 'Manager', '4321', '[]'), ('${A1}', '${ORG_A}', 'Sam Server', 'Server', '1111', '[]'),
      ('${A1}', '${ORG_A}', 'Pat Approver', 'Server', '2468', '["manager_approvals"]');
    insert into storage_areas (id, location_id, name, kind) values
      ('${AR.bar}', '${A1}', 'Bar', 'bar'), ('${AR.cellar}', '${A1}', 'Cellar', 'cellar'), ('${AR.bar2}', '${A2}', 'Bar', 'bar'), ('${AR.b1}', '${B1}', 'Bar', 'bar');
    insert into inventory_items (id, location_id, org_id, name, base_unit, current_cost, on_hand, sku, category, accounting_group, purchase_tax_rate_id, allergens, archived_at) values
      ('${I.milk}', '${A1}', '${ORG_A}', 'Whole milk', 'ml', 0.00110000, 0, 'MILK', 'Dairy', 'Food', null, '["milk"]', null),
      ('${I.beans}', '${A1}', '${ORG_A}', 'Coffee beans', 'kg', 18.0, 0, 'BEANS', 'Coffee', 'Food', '${TAX.a1std}', '[]', null),
      ('${I.cups}', '${A1}', '${ORG_A}', 'Cups', 'each', 0.05, 0, null, 'Packaging', 'Packaging', '${TAX.a1std}', '[]', null),
      ('${I.syrup}', '${A1}', '${ORG_A}', 'Vanilla syrup', 'ml', null, 0, 'SYR', 'Syrups', 'Food', '${TAX.a1red}', '[]', null),
      ('${I.lemons}', '${A1}', '${ORG_A}', 'Lemons', 'each', 0.30, 0, 'LEM', 'Fruit', 'Food', null, '[]', null),
      ('${I.old}', '${A1}', '${ORG_A}', 'Old item', 'each', 1, 0, 'OLD', null, null, null, '[]', now()),
      ('${I.beans2}', '${A2}', '${ORG_A}', 'Espresso beans', 'kg', 17.5, 0, 'beans', 'Coffee', 'Food', '${TAX.a2std}', '[]', null),
      ('${I.cups2}', '${A2}', '${ORG_A}', 'cups', 'each', 0.06, 0, null, null, null, null, '[]', null),
      ('${I.milk2}', '${A2}', '${ORG_A}', 'Whole milk', 'l', 1.10, 0, 'MILK-L', 'Dairy', 'Food', null, '[]', null),
      ('${I.own2}', '${A2}', '${ORG_A}', 'Local bread', 'each', 1.20, 0, 'BREAD', 'Bakery', 'Food', null, '[]', null),
      ('${I.b1}', '${B1}', '${ORG_B}', 'Milk', 'ml', 0.001, 0, 'MILK', null, null, null, '[]', null);
    insert into inventory_item_areas (location_id, inventory_item_id, area_id, is_primary) values
      ('${A1}', '${I.milk}', '${AR.bar}', true), ('${A1}', '${I.beans}', '${AR.cellar}', true), ('${A2}', '${I.beans2}', '${AR.bar2}', true);
    insert into item_packaging_formats (id, location_id, inventory_item_id, name, qty_in_base, is_purchase_default, is_count_default) values
      ('${PACK.milkCase}', '${A1}', '${I.milk}', 'Case of 6', 6000, true, false), ('${PACK.beansBag}', '${A1}', '${I.beans}', 'Bag', 1, true, true);
    insert into item_packaging_formats (id, location_id, inventory_item_id, name, qty_in_base, parent_format_id, is_count_default) values
      ('${PACK.milkBottle}', '${A1}', '${I.milk}', 'Bottle', 1000, '${PACK.milkCase}', true);
    insert into inventory_item_conversions (location_id, inventory_item_id, from_qty, from_unit, to_qty, to_unit) values
      ('${A1}', '${I.cups}', 1, 'each', 12, 'g');
    insert into suppliers (id, location_id, name, email, account_number, delivery_days, cutoff_time) values
      ('${SUP.dairy}', '${A1}', 'Dairy Co', 'orders@dairy.test', 'PROVO-1', '["Mon","Thu"]', '14:00'), ('${SUP.beanco}', '${A1}', 'Bean Co', 'orders@beans.test', 'P-77', '[]', null),
      ('${SUP.dairy2}', '${A2}', 'dairy co', 'l2@dairy.test', 'L2-9', '["Tue"]', null), ('${SUP.b1}', '${B1}', 'Dairy B', null, null, '[]', null);
    insert into supplier_products (id, location_id, inventory_item_id, supplier_id, supplier_sku, pack_description, pack_qty, inner_qty, inner_unit, pack_price, is_preferred, purchase_tax_rate_id) values
      ('${SP.milk}', '${A1}', '${I.milk}', '${SUP.dairy}', 'D-MILK6', 'Case 6 x 1 l', 6, 1, 'l', 6.60, true, null),
      ('${SP.beans}', '${A1}', '${I.beans}', '${SUP.beanco}', 'B-1KG', 'Bag 1 kg', 1, 1, 'kg', 18.00, true, '${TAX.a1std}'),
      ('${SP.cups}', '${A1}', '${I.cups}', '${SUP.dairy}', 'D-CUP100', 'Box of 100', 1, 100, 'each', 5.00, true, '${TAX.a1std}'),
      ('${SP.cups2}', '${A2}', '${I.cups2}', '${SUP.dairy2}', 'D-CUP100', 'Box of 100', 1, 100, 'each', 5.40, true, null);
    update inventory_items set default_supplier_id = '${SUP.dairy}' where id in ('${I.milk}', '${I.cups}');
    update inventory_items set default_supplier_id = '${SUP.beanco}' where id = '${I.beans}';
    update inventory_items set default_supplier_id = '${SUP.dairy2}' where id = '${I.cups2}';
    insert into par_levels (location_id, inventory_item_id, par_level, reorder_point) values ('${A1}', '${I.milk}', 12000, 6000), ('${A2}', '${I.beans2}', 5, 2);
  `);
}

function stockOnHand() {
  // some stock on the shelves and a ledger, through the posting core (as the database itself)
  for (const [loc, item, qty, cost, key] of [[A1, I.milk, 18000, 0.0011, 'r1'], [A1, I.beans, 6, 18, 'r2'], [A1, I.cups, 400, 0.05, 'r3'],
    [A2, I.beans2, 3, 17.5, 'r4'], [A2, I.cups2, 150, 0.06, 'r5'], [B1, I.b1, 1000, 0.001, 'r6']]) {
    sql(`select public._post_stock_movement('${loc}', '${item}', ${qty}, 'PURCHASE_RECEIPT', ${cost}, 'purchase_order', 'seed', 'seed:${key}')`);
  }
}

const STOP_AT = Number(process.env.STOCK1_STOP_AT || 99);
function finish() {
  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}: ${checks - failures}/${checks} checks${failures ? `, ${failures} failed` : ''} (seed ${SEED})`);
  if (process.env.STOCK1_KEEP) { console.log(`kept: psql -h ${dir} -p ${port} -U postgres -d ${DB}`); process.exit(failures === 0 ? 0 : 1); }
  stop();
  process.exit(failures === 0 ? 0 : 1);
}
const section = (n, title) => { if (n > STOP_AT) finish(); console.log(`\n${title}`); };
const migText = readFileSync(MIGRATION, 'utf8');
const rbText = readFileSync(ROLLBACK, 'utf8');
console.log(`\nMulti site stock Phase 1 proof (seed ${SEED}${QUICK ? ', quick' : ''})`);

// == 0. The file itself ===============================================================================
section(0, '0. The file');
ok(!/[^\x00-\x7F]/.test(migText) && !/[^\x00-\x7F]/.test(rbText), 'migration and rollback are ASCII only');
{
  // outside function and procedure bodies ($fn$ ... $fn$, $proc$ ... $proc$, do blocks)
  const top = (t) => t.replace(/\$([a-z_0-9]*)\$[\s\S]*?\$\1\$/g, '');
  ok(!/^\s*(begin|commit|rollback)\s*;/im.test(top(migText)) && !/^\s*(begin|commit|rollback)\s*;/im.test(top(rbText)), 'bare statements: no begin or commit of their own');
}
{
  const menuFns = new Set();
  for (const f of ['20261017_OPS_multi_site_menu.sql', '20261017c_OPS_multi_site_menu_groups.sql', '20261018_OPS_multi_site_menu_category_fields.sql']) {
    const t = readFileSync(MIG(f), 'utf8');
    for (const m of t.matchAll(/create or replace function public\.([a-z0-9_]+)\(/g)) menuFns.add(m[1]);
  }
  const mine = [...migText.matchAll(/create or replace (?:function|procedure) public\.([a-z0-9_]+)\(/g)].map((m) => m[1]);
  const clash = mine.filter((n) => menuFns.has(n));
  ok(clash.length === 0, `no menu function (msm change sets, runner, guard) is created or replaced here (${clash.join(', ') || 'none'})`);
  ok(!/alter table public\.msm_(menus|products|product_sites|change_sets|changes|versions|version_sites|company|members)\b/.test(migText)
     && !/on public\.msm_(changes|change_sets|versions|version_sites|products|product_sites)\b/.test(migText),
    'no menu table is altered and no trigger is put on one');
}

// == 1. The paste ========================================================================================
section(1, '1. The paste (SQL editor, one transaction) on a database like Ops');
baseDb('s1_main');
stockOnHand();
const FNS = () => Object.fromEntries(sql(`select p.oid::regprocedure::text || '=' || md5(p.prosrc) from pg_proc p where p.pronamespace = 'public'::regnamespace order by 1`)
  .split('\n').filter(Boolean).map((l) => { const k = l.lastIndexOf('='); return [l.slice(0, k), l.slice(k + 1)]; }));
const fnBefore = FNS();
const sumsBefore = { A1: SUMS(A1), A2: SUMS(A2), B1: SUMS(B1) };
const applied = psql({ args: ['-1', '-f', MIGRATION], allowFail: true });
ok(applied.status === 0, `the file applies in one transaction${applied.status ? `: ${applied.stderr.slice(0, 400)}` : ''}`);
const row = applied.stdout.trim().split('\n').pop().split('|');
ok(row[0] === '20' && row[2] === '15' && row[3] === '1' && row[4] === '0' && row[5] === '0' && row[6] === '0' && row[7] === '0',
  `visible check: tables ${row[0]}, functions ${row[1]}, lock triggers ${row[2]}, cron ${row[3]}, internals open ${row[4]}, approve open to logins ${row[5]}, companies on ${row[6]}, company rows ${row[7]}`);
const EXPECT_FUNCS = row[1];
ok(migText.includes(`functions ${EXPECT_FUNCS} |`), `the comment above the check names the same function count (${EXPECT_FUNCS})`);
{
  const fnAfter = FNS();
  const changed = Object.keys(fnBefore).filter((k) => fnAfter[k] !== fnBefore[k]);
  ok(changed.length === 0 && Object.keys(fnBefore).length > 50, `every function that was there before (menu helpers, Phase 0, central stock: ${Object.keys(fnBefore).length}) has exactly the same body after (${changed.join(', ') || 'none changed'})`);
}
ok(SUMS(A1) === sumsBefore.A1 && SUMS(A2) === sumsBefore.A2 && SUMS(B1) === sumsBefore.B1, 'the paste moves no stock, no cost, no ledger row at any venue');
ok(num(`select count(*) from inventory_items where company_ref is not null`) === 0, 'no site row is touched (company_ref empty everywhere)');
{
  const again = psql({ args: ['-1', '-f', MIGRATION], allowFail: true });
  ok(again.status === 0 && again.stdout.trim().split('\n').pop().split('|').slice(0, 8).join('|') === row.slice(0, 8).join('|'), 'a second paste applies and the check reads the same');
}
{
  const trig = sql(`select pg_get_triggerdef(t.oid) from pg_trigger t where t.tgrelid = 'public.inventory_items'::regclass and t.tgname = 'msm_stock_lock_upd'`);
  ok(/WHEN/.test(trig) && !/on_hand/.test(trig) && !/current_cost/.test(trig), 'the lock trigger on stock items has a WHEN clause on company columns only (not on hand, not cost)');
}
{
  const r = asCaller('boA1', `select public.approve_stock_count('${randomUUID()}')`);
  ok(r.sqlstate === '42501', `a Back Office login can no longer approve a count without the PIN call (${r.sqlstate})`);
  const r2 = asCaller('boA1', `select public.msm_stock__sync_site('${ORG_A}', '${A1}', null, false, false)`);
  ok(r2.sqlstate === '42501', `the planner and writer cannot be run through the API (${r2.sqlstate})`);
  const r3 = asCaller('service', `call public.msm_stock_run_due(1)`);
  ok(r3.sqlstate === '42501', `the runner cannot be run through the API, even by the service role (${r3.sqlstate})`);
}

// == 2. The switch, the people, central stock at every site ===============================================
section(2, '2. Admin: Shared stock, the people, central stock everywhere');
{
  let r = asCaller('editorA', `select public.stock_admin_set_enabled('${ORG_A}', true)`);
  ok(r.sqlstate === '42501', `only ServOS staff can switch Shared stock on (${r.sqlstate})`);
  r = asCaller('superAdmin', `select public.stock_admin_set_enabled('${ORG_B}', true)`);
  ok(r.sqlstate === '55000' && /Multi site menu/.test(r.message), `a company not on the Multi site menu is refused, in words (${r.message.slice(0, 80)})`);
  // a site backed out to the till path by hand: Shared stock puts it central
  sql(`select public.stock_central_switch('${A2}', 'browser', 'test back out')`);
  ok(sql(`select mode from stock_depletion_mode where location_id = '${A2}'`) === 'browser', 'Location 2 starts on the till path (backed out by hand)');
  const t0 = sql(`select now()`);
  r = callJ('superAdmin', `select public.stock_admin_set_enabled('${ORG_A}', true)`);
  ok(r.j?.enabled === true && r.j?.switched_central === 1, `Shared stock on for company A; ${r.j?.switched_central} site switched to central`);
  ok(num(`select count(*) from locations l join stock_depletion_mode d on d.location_id = l.id where l.org_id = '${ORG_A}' and d.mode = 'central'`) === 3,
    'every site of the company is central now (Peter: if a site is multi site stock, multi site should be on)');
  ok(sql(`select central_since >= '${t0}'::timestamptz from stock_depletion_mode where location_id = '${A2}'`) === 't', 'central_since is set at the switch');
  // a site created later in the company, and one moved into it, are central from that moment
  const A4 = randomUUID();
  sql(`delete from stock_depletion_mode where location_id = '${B2}'; insert into stock_depletion_mode (location_id, mode) values ('${B2}', 'browser');`);
  sql(`insert into locations (id, org_id, name, timezone) values ('${A4}', '${ORG_A}', 'Joined later', 'Europe/London')`);
  ok(sql(`select mode from stock_depletion_mode where location_id = '${A4}'`) === 'central', 'a site created later in the company is central from the moment it exists');
  sql(`update locations set org_id = '${ORG_A}' where id = '${B2}'`);
  ok(sql(`select mode from stock_depletion_mode where location_id = '${B2}'`) === 'central', 'a site that moves into the company is central from the moment it joins');
  sql(`update locations set org_id = '${ORG_B}' where id = '${B2}'; delete from locations where id = '${A4}'; delete from stock_depletion_mode where location_id = '${A4}';`);
  // people
  r = callJ('superAdmin', `select public.stock_admin_set_member('${ORG_A}', '${U.editorA}', 'editor')`);
  callJ('superAdmin', `select public.stock_admin_set_member('${ORG_A}', '${U.viewerA}', 'viewer')`);
  ok(r.j?.members?.length === 1, 'ServOS adds a stock Editor by name');
  r = callJ('editorA', `select public.stock_my_access()`);
  ok(r.j?.companies?.[0]?.role === 'editor' && r.j.companies[0].enabled && r.j.companies[0].menu_enabled, 'the Editor sees their access (role editor, both switches on)');
  r = callJ('menuOnlyA', `select public.stock_my_access()`);
  ok(r.j?.companies?.length === 0, 'a menu editor is NOT a stock person (a separate list)');
  r = callJ('ownerA', `select public.stock_my_access()`);
  ok(r.j?.companies?.length === 0, 'the owner is not added automatically');
}

// == 3. Who can see and change company stock =================================================================
section(3, '3. Fences: who can see and change company stock');
{
  const cases = [
    ['editorA', `select public.msm_stock_items_page('${ORG_A}')`, 'ok'],
    ['viewerA', `select public.msm_stock_items_page('${ORG_A}')`, 'ok'],
    ['superAdmin', `select public.msm_stock_items_page('${ORG_A}')`, 'ok'],
    ['menuOnlyA', `select public.msm_stock_items_page('${ORG_A}')`, '42501'],
    ['ownerA', `select public.msm_stock_items_page('${ORG_A}')`, '42501'],
    ['boA1', `select public.msm_stock_items_page('${ORG_A}')`, '42501'],
    ['boB1', `select public.msm_stock_items_page('${ORG_A}')`, '42501'],
    ['tillA1', `select public.msm_stock_items_page('${ORG_A}')`, '42501'],
    ['stranger', `select public.msm_stock_items_page('${ORG_A}')`, '42501'],
    ['anonKey', `select public.msm_stock_items_page('${ORG_A}')`, '42501'],
    ['viewerA', `select public.msm_stock_stage('${ORG_A}', '[]'::jsonb)`, '42501'],
    ['boA1', `select public.msm_stock_start_from_site('${ORG_A}', '${A1}')`, '42501'],
    ['viewerA', `select public.msm_stock_publish('${ORG_A}', 'now')`, '42501'],
    ['editorA', `select public.msm_stock_items_page('${ORG_B}')`, '42501'],
  ];
  for (const [who, call, want] of cases) {
    const r = asCaller(who, call);
    const got = r.sqlstate || (r.status === 0 ? 'ok' : `fail:${r.message}`);
    ok(got === want, `${CALLERS[who].what}: ${want === 'ok' ? 'allowed' : 'refused'} (${got})`);
  }
  const r = asCaller('boA1', `select count(*) from msm_stock_items`);
  ok(r.status === 0 && r.out === '0', 'a site manager reads no company rows from the tables either (row level security)');
  const w = asCaller('editorA', `insert into msm_stock_items (org_id, name, base_unit) values ('${ORG_A}', 'Sneaky', 'each')`);
  ok(w.sqlstate === '42501', `nobody writes the company tables directly, an Editor neither (${w.sqlstate})`);
}

// == 4. Start from a site ===============================================================================
section(4, '4. Start from a site (Provo): the site\'s rows become the company list');
const a1Before = SUMS(A1);
const a1SnapBefore = SNAP(A1);
let startVersion;
{
  const r = callJ('editorA', `select public.msm_stock_start_from_site('${ORG_A}', '${A1}')`);
  ok(r.j?.ok === true && r.j.items === 5 && r.j.packs === 3 && r.j.bridges === 1 && r.j.suppliers === 2 && r.j.prices === 3 && r.j.self_check_writes === 0,
    `5 items, 3 packs, 1 unit bridge, 2 suppliers, 3 prices; the self check plans 0 writes (${r.j ? JSON.stringify(r.j).slice(0, 160) : r.message})`);
  startVersion = r.j?.version_id;
  ok(SUMS(A1) === a1Before, 'no quantity, cost, ledger, par, area or count changed at Provo');
  ok(num(`select count(*) from inventory_items where location_id = '${A1}' and company_ref is not null`) === 5
     && num(`select count(*) from inventory_items where id = '${I.old}' and company_ref is null`) === 1, 'the 5 live items are linked; the archived one is left as it is');
  ok(planOf(ORG_A, A1).writes === 0, 'a publish to Provo now plans zero writes');
  ok(sql(`select parent_pack_id is not null from msm_stock_packs where name = 'Bottle'`) === 't', 'the pack inside a pack keeps its parent');
  ok(near(num(`select purchase_tax_rate from msm_stock_items where name = 'Coffee beans'`), 0.2), 'purchase VAT becomes a rate (20%), mapped back to each site\'s own rate row');
  ok(sql(`select default_area_kind from msm_stock_items where name = 'Whole milk'`) === 'bar', 'the usual area kind comes from Provo\'s area');
  const again = asCaller('editorA', `select public.msm_stock_start_from_site('${ORG_A}', '${A1}')`);
  ok(again.sqlstate === '55000', `Start from a site runs once, on an empty list (${again.sqlstate})`);
}

// == 5. The lock on company rows at the sites ===============================================================
section(5, '5. The database lock on company rows at the site');
{
  let r = asCaller('boA1', `update inventory_items set name = 'Milk (mine)' where id = '${I.milk}'`);
  ok(r.sqlstate === '42501' && /Managed by head office/.test(r.message) && /Hannah Head Office/.test(r.message),
    `a site manager cannot rename a company item; the words name the stock Editor (${r.message.slice(0, 90)})`);
  r = asCaller('boA1', `update inventory_items set base_unit = 'l' where id = '${I.milk}'`);
  ok(r.sqlstate === '42501', 'nor change its base unit');
  r = asCaller('boA1', `update inventory_items set archived_at = now() where id = '${I.milk}'`);
  ok(r.sqlstate === '42501', 'nor archive it');
  r = asCaller('boA1', `delete from item_packaging_formats where id = '${PACK.beansBag}'`);
  ok(r.sqlstate === '42501', 'nor delete a company pack');
  r = asCaller('boA1', `update supplier_products set pack_price = 1 where id = '${SP.milk}'`);
  ok(r.sqlstate === '42501', 'nor change a company price');
  r = asCaller('boA1', `insert into inventory_items (location_id, name, base_unit, company_ref) values ('${A1}', 'Forged', 'each', '${randomUUID()}')`);
  ok(r.sqlstate === '42501', 'nor forge a company row');
  r = asCaller('boA1', `update inventory_items set company_ref = null where id = '${I.milk}'`);
  ok(r.sqlstate === '42501', 'nor unlink one');
  r = asCaller('boA1', `select set_config('servos.stock_publish', txid_current()::text, true); update inventory_items set name = 'X' where id = '${I.milk}'`);
  ok(r.sqlstate === '42501', `the bypass a client could set is refused (publish passes through its owner role, not a setting) (${r.sqlstate})`);
  r = asCaller('boA1', `update inventory_items set notes = 'shelf 3', kind = 'MADE', default_supplier_id = '${SUP.beanco}', is_tracked = true where id = '${I.milk}'`);
  ok(r.status === 0, 'the site still saves its own fields: notes, made here, preferred supplier, tracking');
  r = asCaller('boA1', `update supplier_products set is_preferred = false where id = '${SP.cups}'; update suppliers set account_number = 'NEW-1', email = 'new@dairy.test', delivery_days = '["Fri"]' where id = '${SUP.dairy}'`);
  ok(r.status === 0, 'and its own supplier values: account number, order email, delivery days, preferred pack');
  r = asCaller('boA1', `update par_levels set par_level = 14000 where inventory_item_id = '${I.milk}'; insert into par_levels (location_id, inventory_item_id, par_level) values ('${A1}', '${I.beans}', 8)`);
  ok(r.status === 0, 'and its pars');
  r = asCaller('boA1', `insert into item_packaging_formats (location_id, inventory_item_id, name, qty_in_base) values ('${A1}', '${I.milk}', 'Our jug', 2000)`);
  ok(r.status === 0, 'and its own extra pack on a company item');
  r = asCaller('boA1', `select public.post_stock_movement('${A1}', '${I.milk}', -100, 'WASTE', null, 'waste', null, 'w-lock-1')`);
  ok(r.status === 0, 'waste on a company item posts (the on hand update never fires the lock)');
  sql(`select public._post_stock_movement('${A1}', '${I.milk}', -250, 'SALE_DEPLETION', null, 'closed_check', 'chk-1', 'sale:chk-1:${I.milk}')`);
  ok(onHandEqLedger(A1), 'a sale through the posting core on a company item posts; on hand equals the ledger');
  r = asCaller('editorA', `update msm_stock_items set base_unit = 'l' where name = 'Whole milk'`);
  ok(r.sqlstate === '42501', 'an Editor cannot write the company table directly either');
  r = asCaller('sqlEditor', `update msm_stock_items set base_unit = 'l' where name = 'Whole milk'`);
  ok(r.sqlstate === '55000' && /base unit/.test(r.message), `the base unit of an item with movements cannot change, even from the SQL editor (${r.message.slice(0, 70)})`);
  ok(planOf(ORG_A, A1).writes === 0, 'after the site\'s own edits, a publish to Provo still plans zero writes (they are site fields)');
}

// == 6. Link Location 2, switch items on there, preview, publish now ===========================================
section(6, '6. Location 2: link its own rows, switch items on, preview, publish now');
const a2Before = SUMS(A2);
const a2SnapBefore = SNAP(A2);
const a2QtyBefore = QTY_SUMS(A2);
const a1QtyAt6 = QTY_SUMS(A1);
let pubVersion;
{
  const c = callJ('viewerA', `select public.msm_stock_link_candidates('${ORG_A}', '${A2}')`);
  const items = c.j?.items || [];
  ok(items.length === 2 && items.some((x) => x.venue_id === I.beans2 && /SKU/.test(x.why)) && items.some((x) => x.venue_id === I.cups2 && /name/.test(x.why)),
    `suggested links: beans by SKU, cups by name (${items.map((x) => `${x.venue_name}:${x.why}`).join('; ')})`);
  ok(!items.some((x) => x.venue_id === I.milk2), 'Location 2\'s milk in litres is NOT suggested (a different base unit stays the site\'s own)');
  ok((c.j?.suppliers || []).some((x) => x.venue_id === SUP.dairy2) && (c.j?.prices || []).some((x) => x.venue_id === SP.cups2), 'its own supplier and the matching supplier pack are suggested too');
  ok(SNAP(A2) === a2SnapBefore, 'suggesting writes nothing');
  let r = callJ('editorA', `select public.msm_stock_stage_links('${ORG_A}', '${A2}')`);
  ok(r.j?.staged === 4, `the 4 suggestions with one choice each are ticked in the draft (${r.j?.staged})`);
  r = callJ('editorA', `select public.msm_stock_stage_sites('${ORG_A}', null, array['${A2}']::uuid[], true, true)`);
  ok(r.j?.staged > 0, 'every company item is switched on at Location 2, with its suppliers');
  ok(SNAP(A2) === a2SnapBefore, 'staging writes nothing at the site');
  const pv = callJ('viewerA', `select public.msm_stock_preview('${ORG_A}', array['${A2}', '${A3}']::uuid[])`);
  const p2 = pv.j?.sites?.find((s) => s.location_id === A2)?.plan;
  ok(pv.j?.ok === true && p2?.items_new === 3 && p2?.items_changed === 2 && p2?.suppliers_new === 1 && p2?.suppliers_changed === 1,
    `preview for Location 2: 3 new items, 2 linked; 1 new supplier, 1 linked (${JSON.stringify(p2)?.slice(0, 200)})`);
  ok(num(`select count(*) from msm_stock_item_sites where location_id = '${A2}'`) === 0 && SNAP(A2) === a2SnapBefore, 'the preview is rolled back: nothing kept anywhere');
  const h3 = pv.j?.sites?.find((s) => s.location_id === A3)?.health;
  ok(Array.isArray(h3?.block) && h3.block.length === 0, 'New shop is not reached by this draft, so nothing blocks there');
  r = callJ('editorA', `select public.msm_stock_publish('${ORG_A}', 'now', 'Location 2 joins')`);
  ok(r.j?.ok === true, `published now (${r.message || r.j?.version_no})`);
  pubVersion = r.j?.version_id;
  ok(SNAP(A2) === a2SnapBefore, 'publish itself writes nothing at the sites: the runner does, one site per transaction');
  runDue(20);
  const st = sql(`select string_agg(l.name || ':' || s.status, ',' order by l.name) from msm_stock_version_sites s join locations l on l.id = s.location_id where s.version_id = '${pubVersion}'`);
  ok(/Location 2:done/.test(st) && /Provo:nothing/.test(st) && /New shop:nothing/.test(st), `the runner wrote Location 2 and found nothing to do at the others (${st})`);
  ok(QTY_SUMS(A2) === a2QtyBefore, 'Location 2: no quantity, cost, ledger, par, area or count changed');
  ok(JSON.parse(SUMS(A2)).items === JSON.parse(a2Before).items + 3, 'Location 2 has 3 new stock items (new rows, on hand 0, no cost)');
  ok(num(`select count(*) from inventory_items where location_id = '${A2}' and company_ref is not null and on_hand = 0 and current_cost is null and id not in ('${I.beans2}', '${I.cups2}')`) === 3,
    'the new rows start at 0 on hand and no cost (the opening count sets those)');
  ok(sql(`select name from inventory_items where id = '${I.beans2}'`) === 'Coffee beans' && near(cost(I.beans2), 17.5) && near(onHandOf(I.beans2), 3),
    'the linked beans take the company name and keep their own on hand and cost');
  ok(sql(`select default_supplier_id from inventory_items where id = '${I.cups2}'`) === SUP.dairy2, 'a linked item keeps its own preferred supplier');
  ok(num(`select count(*) from inventory_items t where t.location_id = '${A2}' and t.company_ref is not null and t.default_supplier_id is not null and t.id not in ('${I.beans2}', '${I.cups2}')`) >= 1,
    'a new item gets a preferred supplier once, when it first arrives');
  ok(sql(`select purchase_tax_rate_id from inventory_items where id = '${I.beans2}'`) === TAX.a2std, 'VAT 20% is Location 2\'s own 20% rate row');
  ok(sql(`select email || '|' || account_number from suppliers where id = '${SUP.dairy2}'`) === 'l2@dairy.test|L2-9', 'the linked supplier keeps its own order email and account number');
  ok(num(`select pack_price from supplier_products where id = '${SP.cups2}'`) === 5.0, 'the linked supplier pack takes the company price (5.40 to 5.00): a price, never a cost');
  ok(num(`select count(*) from inventory_item_areas a join inventory_items t on t.id = a.inventory_item_id where t.location_id = '${A2}' and t.name = 'Whole milk' and t.company_ref is not null`) === 1,
    'a new item lands in the site\'s one area of its usual kind (Bar)');
  ok(planOf(ORG_A, A2).writes === 0 && planOf(ORG_A, A1).writes === 0, 'I8: a re publish plans zero writes at both sites');
  ok(QTY_SUMS(A1) === a1QtyAt6, 'Provo: no quantity, cost or ledger change');
  ok(SUMS(B1) === sumsBefore.B1, 'the other company is untouched');
}
function onHandOf(item) { return num(`select on_hand from inventory_items where id = '${item}'`); }
function cost(item) { return num(`select current_cost from inventory_items where id = '${item}'`); }

// == 7. A rename, scheduled for 05:00 at each site, then run now ================================================
section(7, '7. A change scheduled outside trading, then Publish now');
let renameVersion;
{
  const milkC = sql(`select id from msm_stock_items where name = 'Whole milk'`);
  let r = callJ('editorA', `select public.msm_stock_stage('${ORG_A}', ${jlit([{ target: 'item', entity_id: milkC, data: { name: 'Whole milk 4%', category: 'Dairy and eggs' } }])})`);
  ok(r.j?.staged === 1, 'one change staged');
  r = callJ('editorA', `select public.msm_stock_publish('${ORG_A}', 'night')`);
  renameVersion = r.j?.version_id;
  const due = sql(`select string_agg(l.name || '=' || to_char(s.due_at at time zone l.timezone, 'HH24:MI'), ',' order by l.name) from msm_stock_version_sites s join locations l on l.id = s.location_id where s.version_id = '${renameVersion}'`);
  ok(/Provo=05:00/.test(due) && /Location 2=05:00/.test(due), `scheduled for 05:00 on each site's own clock (${due})`);
  runDue(5);
  ok(sql(`select name from inventory_items where id = '${I.milk}'`) === 'Whole milk', 'nothing runs before its time');
  r = asCaller('editorA', `select public.msm_stock_publish('${ORG_A}', 'now')`);
  ok(r.sqlstate === '22023' || r.sqlstate === '55000', `while a version waits, another publish is refused in words (${r.message.slice(0, 80)})`);
  r = callJ('editorA', `select public.msm_stock_run_now('${ORG_A}', '${renameVersion}')`);
  runDue(20);
  ok(sql(`select name from inventory_items where id = '${I.milk}'`) === 'Whole milk 4%' && sql(`select name from inventory_items where location_id = '${A2}' and company_ref = '${milkC}'`) === 'Whole milk 4%',
    'Publish now: both sites carry the new name');
  ok(QTY_SUMS(A2) === a2QtyBefore, 'still no quantity, cost or ledger change at Location 2');
  ok(num(`select count(*) from msm_stock_version_rows where version_id = '${renameVersion}' and op = 'update'`) === 2, 'one before and after row per changed row (2)');
  ok(planOf(ORG_A, A1).writes === 0 && planOf(ORG_A, A2).writes === 0, 'a re publish plans zero writes');
}

// == 8. Undo ===============================================================================================
section(8, '8. Undo restores exactly');
{
  const a1Snap = SNAP(A1); const a2Snap = SNAP(A2);
  let r = callJ('editorA', `select public.msm_stock_undo('${ORG_A}', '${pubVersion}')`);
  ok(r.sqlstate === '55000', `only the newest version can be undone (${r.message.slice(0, 60)})`);
  r = callJ('editorA', `select public.msm_stock_undo('${ORG_A}', '${renameVersion}')`);
  ok(r.j?.ok === true, 'Undo of the rename');
  ok(sql(`select name from msm_stock_items where id = (select company_ref from inventory_items where id = '${I.milk}')`) === 'Whole milk', 'the company row is back at once');
  runDue(20);
  ok(sql(`select name from inventory_items where id = '${I.milk}'`) === 'Whole milk', 'the sites are back');
  const strip = (s) => JSON.stringify(JSON.parse(s), (k, v) => (k === 'updated_at' ? undefined : v));
  ok(planOf(ORG_A, A1).writes === 0 && planOf(ORG_A, A2).writes === 0, 'a re publish after Undo plans zero writes');
  ok(strip(SNAP(A1)) !== strip(a1Snap), 'the rename really was undone at Provo');
  r = callJ('editorA', `select public.msm_stock_undo('${ORG_A}', '${pubVersion}')`);
  ok(r.j?.ok === true, 'then Undo of the Location 2 publish (the newest live one now)');
  runDue(20);
  ok(SNAP(A2) === a2SnapBefore, 'Location 2 is back EXACTLY as before the publish (every row of the five tables and its areas, byte for byte)');
  ok(SUMS(A2) === a2Before, 'and its check rows match');
  ok(planOf(ORG_A, A2).writes === 0, 'a re publish after Undo plans zero writes at Location 2');
  ok(planOf(ORG_A, A1).writes === 0, 'and at Provo');
}

// == 9. The health check stops a publish, in words ===============================================================
section(9, '9. Health check');
{
  const nid = randomUUID(), sid = randomUUID(), spid = randomUUID();
  let r = callJ('editorA', `select public.msm_stock_stage('${ORG_A}', ${jlit([
    { target: 'item', entity_id: nid, data: { _new: true, name: 'Oat milk', base_unit: 'l', purchase_tax_rate: 0.125, all_sites: true } },
    { target: 'supplier', entity_id: sid, data: { _new: true, name: 'Oat Co', all_sites: true } },
    { target: 'sp', entity_id: spid, data: { _new: true, item_id: nid, supplier_id: sid, inner_unit: 'kg', pack_price: 9, inner_qty: 6 } },
  ])})`);
  ok(r.j?.staged === 3, 'a new item, supplier and price staged');
  r = asCaller('editorA', `select public.msm_stock_publish('${ORG_A}', 'now')`);
  ok(r.sqlstate === '22023' && /no 12\.5% VAT rate/.test(r.message) && /bought in kg but counted in l/.test(r.message),
    `refused, in words: missing VAT rate and a unit with no bridge (${r.message.slice(0, 160)})`);
  ok(num(`select count(*) from msm_stock_items where id = '${nid}'`) === 0, 'nothing was kept');
  r = callJ('editorA', `select public.msm_stock_unstage('${ORG_A}')`);
  ok(r.j?.removed === 3, 'the draft is thrown away');
  r = asCaller('editorA', `select public.msm_stock_stage('${ORG_A}', ${jlit([{ target: 'item', entity_id: nid, data: { _new: true, name: 'X', base_unit: 'stone' } }])})`);
  ok(r.sqlstate === '22023' && /not a unit/.test(r.message), `an unknown unit is refused when staged (${r.message.slice(0, 60)})`);
  r = asCaller('editorA', `select public.msm_stock_stage('${ORG_A}', ${jlit([{ target: 'item', entity_id: nid, data: { _new: true, name: 'X', base_unit: 'each', on_hand: 5 } }])})`);
  ok(r.sqlstate === '22023' && /on_hand/.test(r.message), 'on hand can never be staged from head office');
  r = asCaller('editorA', `select public.msm_stock_stage('${ORG_A}', ${jlit([{ target: 'item_site', entity_id: nid, location_id: B1, data: { active: true } }])})`);
  ok(r.sqlstate === '22023', 'a site of another company is refused');
}

// == 10. Keep the site's ========================================================================================
section(10, '10. Keep the site\'s');
{
  const lemC = sql(`select id from msm_stock_items where name = 'Lemons'`);
  const r = callJ('editorA', `select public.msm_stock_keep_site('${ORG_A}', '${A1}', 'item', '${lemC}')`);
  ok(r.j?.ok === true && sql(`select company_ref is null from inventory_items where id = '${I.lemons}'`) === 't', 'Provo\'s lemons become Provo\'s own again');
  const r2 = asCaller('boA1', `update inventory_items set name = 'Lemons (unwaxed)' where id = '${I.lemons}'`);
  ok(r2.status === 0, 'and the site can rename them now');
  ok(planOf(ORG_A, A1).writes === 0, 'a publish to Provo leaves them alone');
  const u = callJ('editorA', `select public.msm_stock_undo('${ORG_A}', '${r.j?.version_id}')`);
  runDue(10);
  ok(u.j?.ok === true && sql(`select company_ref from inventory_items where id = '${I.lemons}'`) === lemC, 'Undo links them again');
  ok(planOf(ORG_A, A1).writes === 1, 'and the next publish would put the company name back (1 write: the site renamed them meanwhile)');
}

// == 11. Change prices and CSV import ================================================================================
section(11, '11. Change prices and CSV import');
{
  let r = callJ('viewerA', `select public.msm_stock_change_prices('${ORG_A}', null, null, 10, null, null, true)`);
  ok(r.j?.total === 3 && r.j.rows.some((x) => near(x.old_price, 18) && near(x.new_price, 19.8)) && r.j.staged === 0, 'preview: +10% on 3 company prices, nothing staged');
  r = callJ('editorA', `select public.msm_stock_change_prices('${ORG_A}', null, null, null, 0.25, array['${A1}']::uuid[], false)`);
  ok(r.j?.staged === 3 && num(`select count(*) from msm_stock_changes c join msm_stock_drafts d on d.id = c.draft_id and d.status = 'open' where c.target = 'sp_site' and c.location_id = '${A1}' and (c.data ->> 'pack_price')::numeric > 0`) === 3, 'a site price +0.25 at Provo only, staged as Provo\'s own price');
  callJ('editorA', `select public.msm_stock_unstage('${ORG_A}')`);
  // CSV: 5,000 item rows in chunks of 2,000, one bad row
  const imp = randomUUID();
  const rows = Array.from({ length: 5000 }, (_, i) => ({ name: `Import item ${i}`, sku: `IMP-${i}`, base_unit: i === 4321 ? 'stone' : 'each', category: 'Imported', purchase_vat: '20' }));
  let t0 = Date.now();
  for (let i = 0; i < rows.length; i += 2000) {
    r = asCaller('editorA', `select public.msm_stock_import_stage('${ORG_A}', '${imp}', 'items', ${i + 1}, ${jlit(rows.slice(i, i + 2000))})`);
    if (r.status) break;
  }
  ok(r.status === 0, `5,000 rows staged in 3 calls (${Date.now() - t0} ms)`);
  r = callJ('editorA', `select public.msm_stock_import_commit('${ORG_A}', '${imp}', true)`);
  ok(r.j?.error_count === 1 && r.j.errors[0].row === 4322 && /not a unit/.test(r.j.errors[0].error) && r.ms < 8000, `the check finds the one bad row, in words, in ${r.ms} ms`);
  asCaller('editorA', `select public.msm_stock_import_stage('${ORG_A}', '${imp}', 'items', 4322, ${jlit([{ ...rows[4321], base_unit: 'each' }])})`);
  t0 = Date.now();
  r = callJ('editorA', `select public.msm_stock_import_commit('${ORG_A}', '${imp}', false)`);
  ok(r.j?.staged === 5000 && r.ms < 8000, `5,000 items go into the draft in one call (${r.ms} ms)`);
  ok(num(`select count(*) from msm_stock_import_rows where import_id = '${imp}'`) === 0, 'the staging rows are cleared');
  callJ('editorA', `select public.msm_stock_unstage('${ORG_A}')`);
}

// == 12. Usual six areas, site status ==================================================================================
section(12, '12. Areas from head office, the site\'s own status card');
{
  let r = callJ('editorA', `select public.msm_stock_add_areas('${ORG_A}', array['${A3}']::uuid[])`);
  ok(r.j?.added === 6, 'the usual six areas at New shop');
  r = callJ('editorA', `select public.msm_stock_add_areas('${ORG_A}', array['${A3}']::uuid[])`);
  ok(r.j?.added === 0, 'a second time adds nothing');
  r = callJ('boA1', `select public.msm_stock_site_status('${A1}')`);
  ok(r.j?.shared === true && /Hannah Head Office/.test(r.j.editors) && r.j.managed_items >= 4, `a site manager sees: shared, the Editors, ${r.j?.managed_items} items managed`);
  r = callJ('stranger', `select public.msm_stock_site_status('${A1}')`);
  ok(r.j?.shared === false && !r.j.editors, 'a stranger learns nothing');
}

// == 13. Count approval with a manager PIN (Back Office) =================================================================
section(13, '13. Count approval needs a manager PIN');
{
  const cid = randomUUID();
  sql(`insert into stock_counts (id, location_id, name, count_type, status) values ('${cid}', '${A1}', 'Spot', 'SPOT', 'DRAFT');
       insert into stock_count_lines (location_id, count_id, inventory_item_id, sort_order) values ('${A1}', '${cid}', '${I.beans}', 0);`);
  asCaller('boA1', `update stock_count_lines set counted_qty = 5 where count_id = '${cid}'`);
  let r = callJ('boA1', `select public.stock_approve_count_pin('${cid}', '1111')`);
  ok(r.j?.ok === false && r.j.pin === 'wrong', 'a server\'s PIN is not a manager\'s');
  r = callJ('boA1', `select public.stock_approve_count_pin('${cid}', '2468')`);
  ok(r.j?.ok === true && r.j.approved_by_pin === 'Pat Approver', 'a PIN with manager approvals approves, and the approver is named');
  const cid2 = randomUUID();
  sql(`insert into stock_counts (id, location_id, name, count_type, status) values ('${cid2}', '${A1}', 'Spot 2', 'SPOT', 'DRAFT');
       insert into stock_count_lines (location_id, count_id, inventory_item_id, sort_order) values ('${A1}', '${cid2}', '${I.beans}', 0);`);
  asCaller('boA1', `update stock_count_lines set counted_qty = 4 where count_id = '${cid2}'`);
  for (let i = 0; i < 5; i++) asCaller('boA1', `select public.stock_approve_count_pin('${cid2}', '000${i}')`);
  r = callJ('boA1', `select public.stock_approve_count_pin('${cid2}', '4321')`);
  ok(r.j?.ok === false && r.j.pin === 'locked', 'five wrong PINs and the login waits 15 minutes (even with the right one)');
  r = callJ('boB1', `select public.stock_approve_count_pin('${cid2}', '4321')`);
  ok(r.sqlstate === '42501', 'another company cannot approve it');
  r = callJ('service', `select public.approve_stock_count('${cid2}', 'Mia Manager')`);
  ok(r.j?.ok === true, 'the Manager app (service role, it checks the PIN itself) approves in one call');
  ok(onHandEqLedger(A1), 'on hand equals the ledger');
}

// == 14. Sales during a publish (hot rows) ===================================================================================
section(14, '14. Sales while a publish writes the same items');
await (async () => {
  // 2,000 company items on at Location 2, then one change to every one of them while 8 tills sell
  const N = 2000;
  const ids = Array.from({ length: N }, () => randomUUID());
  sql(`insert into msm_stock_items (id, org_id, name, base_unit, all_sites) select x, '${ORG_A}', 'Bulk ' || n, 'each', false
         from unnest(array[${ids.map((x) => `'${x}'`).join(',')}]::uuid[]) with ordinality t(x, n);
       insert into msm_stock_item_sites (item_id, org_id, location_id, active) select x, '${ORG_A}', '${A2}', true
         from unnest(array[${ids.map((x) => `'${x}'`).join(',')}]::uuid[]) x;`);
  let r = callJ('editorA', `select public.msm_stock_stage('${ORG_A}', ${jlit([{ target: 'item', entity_id: ids[0], data: { category: 'Bulk' } }])})`);
  r = callJ('editorA', `select public.msm_stock_publish('${ORG_A}', 'now')`);
  runDue(30);
  const venue = sql(`select string_agg(venue_item_id::text, ',' order by item_id) from msm_stock_item_sites where location_id = '${A2}' and item_id = any(array[${ids.slice(0, 40).map((x) => `'${x}'`).join(',')}]::uuid[])`).split(',');
  ok(venue.length === 40 && num(`select count(*) from inventory_items where location_id = '${A2}' and name like 'Bulk %'`) === N, `${N} items are at Location 2`);
  // the change: every bulk item renamed
  sql(`update msm_stock_items set name = name || ' v2', updated_at = now() where name like 'Bulk %'`);
  const v = callJ('editorA', `select public.msm_stock_stage('${ORG_A}', ${jlit([{ target: 'item', entity_id: ids[1], data: { category: 'Bulk 2' } }])})`);
  r = callJ('editorA', `select public.msm_stock_publish('${ORG_A}', 'now')`);
  const lat = [];
  const errs = [];
  let stop = false;
  const tills = Array.from({ length: 8 }, (_, t) => (async () => {
    let k = 0;
    while (!stop) {
      const item = venue[(t * 5 + k) % venue.length];
      const res = await oneShot('postgres', `set lock_timeout = '8s'; set statement_timeout = '8s'; select public._post_stock_movement('${A2}', '${item}', -1, 'SALE_DEPLETION', 0.1, 'closed_check', 'c${t}-${k}', 'sale:c${t}-${k}:${item}');`);
      lat.push(res.ms); if (res.code) errs.push(res.sqlstate || res.err.slice(0, 80));
      k++;
    }
  })());
  await sleep(300);
  const t0 = Date.now();
  const pub = await oneShot('postgres', 'call public.msm_stock_run_due(30);');
  const pubMs = Date.now() - t0;
  await sleep(300);
  stop = true;
  await Promise.all(tills);
  lat.sort((a, b) => a - b);
  const p95 = lat[Math.floor(lat.length * 0.95)];
  ok(pub.code === 0 && num(`select count(*) from inventory_items where location_id = '${A2}' and name like 'Bulk % v2'`) === N, `the publish of ${N} changed items ran in ${pubMs} ms while tills sold`);
  ok(errs.length === 0, `0 lock timeouts and 0 deadlocks over ${lat.length} sales (${errs.slice(0, 3).join(', ')})`);
  ok(p95 < 300, `sale writes p95 ${p95} ms (under 300 ms, including starting psql each time)`);
  ok(onHandEqLedger(A2), 'I1: on hand equals the ledger at Location 2');
})();

// == 15. Random drafts: only intended rows change; re publish zero; Undo exact =================================================
section(15, '15. Random drafts (property run)');
{
  const rand = rng(SEED);
  const comp = sql(`select string_agg(id::text, ',') from msm_stock_items where org_id = '${ORG_A}' and name not like 'Bulk %'`).split(',');
  let good = 0;
  const runs = QUICK ? 6 : 15;
  for (let k = 0; k < runs; k++) {
    const before = { a1: SNAP(A1), a2: SNAP(A2), q1: QTY_SUMS(A1), q2: QTY_SUMS(A2), pending: planOf(ORG_A, A1).writes + planOf(ORG_A, A2).writes };
    const changes = [];
    for (let j = 0; j < 4; j++) {
      const it = comp[Math.floor(rand() * comp.length)];
      const pick = rand();
      if (pick < 0.3) changes.push({ target: 'item', entity_id: it, data: { name: `R${k}-${j}-${Math.floor(rand() * 1000)}` } });
      else if (pick < 0.5) changes.push({ target: 'item', entity_id: it, data: { category: rand() < 0.5 ? null : `C${k}` } });
      else if (pick < 0.7) changes.push({ target: 'item_site', entity_id: it, location_id: rand() < 0.5 ? A1 : A2, data: { active: rand() < 0.6 } });
      else if (pick < 0.85) changes.push({ target: 'item', entity_id: it, data: { shelf_life_days: Math.floor(rand() * 9) } });
      else changes.push({ target: 'item', entity_id: it, data: { allergens: rand() < 0.5 ? [] : ['milk'] } });
    }
    let r = callJ('editorA', `select public.msm_stock_stage('${ORG_A}', ${jlit(changes)})`);
    r = callJ('editorA', `select public.msm_stock_publish('${ORG_A}', 'now')`);
    if (!r.j?.ok) { console.log('   publish refused:', r.message.slice(0, 120)); continue; }
    runDue(20);
    const z = planOf(ORG_A, A1).writes + planOf(ORG_A, A2).writes;
    const q = QTY_SUMS(A1) === before.q1 && QTY_SUMS(A2) === before.q2;
    r = callJ('editorA', `select public.msm_stock_undo('${ORG_A}', '${r.j.version_id}')`);
    runDue(20);
    const back = SNAP(A1) === before.a1 && SNAP(A2) === before.a2;
    const z2 = planOf(ORG_A, A1).writes + planOf(ORG_A, A2).writes;
    if (z === 0 && q && back && z2 === before.pending) good++;
    else console.log(`   run ${k}: replan ${z}, quantities ${q}, undo exact ${back}, replan after undo ${z2} (before ${before.pending})`);
  }
  ok(good === runs, `${good}/${runs} random drafts: publish moves no quantity, cost or ledger; re publish plans 0 writes; Undo is exact; after Undo the plan is what it was before`);
}

// == 16. Scale: a company of SCALE_SITES sites and 5,000 items ========================================================================
section(16, `16. Scale: ${SCALE_SITES} sites, ${SCALE_ITEMS} company items (each with a pack and a supplier price)`);
await (async () => {
  sql(`insert into stock_company (org_id, enabled) values ('${ORG_BIG}', true);
       insert into msm_stock_members (org_id, user_id, role) values ('${ORG_BIG}', '${U.editorBig}', 'editor');
       insert into locations (id, org_id, name, timezone) select gen_random_uuid(), '${ORG_BIG}', 'Site ' || lpad(n::text, 2, '0'), 'Europe/London' from generate_series(1, ${SCALE_SITES}) n;
       insert into tax_rates (location_id, name, rate, is_default) select l.id, 'VAT', 0.2, true from locations l where l.org_id = '${ORG_BIG}';
       insert into storage_areas (location_id, name, kind) select l.id, k.n, k.k from locations l cross join (values ('Bar', 'bar'), ('Kitchen', 'kitchen')) k(n, k) where l.org_id = '${ORG_BIG}';`);
  // the company list, staged through the API as an Editor would (2,000 a call)
  const items = Array.from({ length: SCALE_ITEMS }, (_, i) => ({ id: randomUUID(), pack: randomUUID(), sp: randomUUID(), i }));
  const sups = [randomUUID(), randomUUID()];
  const changes = [
    { target: 'supplier', entity_id: sups[0], data: { _new: true, name: 'Big Dairy' } },
    { target: 'supplier', entity_id: sups[1], data: { _new: true, name: 'Big Dry Goods' } },
    ...items.flatMap((x) => [
      { target: 'item', entity_id: x.id, data: { _new: true, name: `Item ${String(x.i).padStart(4, '0')}`, base_unit: x.i % 3 ? 'each' : 'kg', sku: `BIG-${x.i}`, purchase_tax_rate: 0.2, default_area_kind: x.i % 2 ? 'bar' : 'kitchen' } },
      { target: 'pack', entity_id: x.pack, data: { _new: true, item_id: x.id, name: 'Case', qty_in_base: 12 } },
      { target: 'sp', entity_id: x.sp, data: { _new: true, item_id: x.id, supplier_id: sups[x.i % 2], inner_unit: x.i % 3 ? 'each' : 'kg', inner_qty: 12, pack_price: 10 + (x.i % 7), purchase_tax_rate: 0.2 } },
    ]),
  ];
  let worst = 0; let failed = null;
  for (let i = 0; i < changes.length; i += 2000) {
    const r = asCaller('editorBig', `select public.msm_stock_stage('${ORG_BIG}', ${jlit(changes.slice(i, i + 2000))})`);
    worst = Math.max(worst, r.ms); if (r.status) { failed = r.message; break; }
  }
  ok(!failed, `${changes.length} changes staged in calls of 2,000 as the Editor, slowest ${worst} ms (${failed || 'ok'})`);
  let r = callJ('editorBig', `select public.msm_stock_stage_sites('${ORG_BIG}', null, null, true, true)`);
  ok(r.status === 0 && r.ms < 8000, `"every site" for 5,000 items is one change per item, not one per site (${r.j?.staged} rows, ${r.ms} ms)`);
  const pv = callJ('editorBig', `select public.msm_stock_preview('${ORG_BIG}', (select array_agg(id) from (select id from locations where org_id = '${ORG_BIG}' order by name limit 5) z))`);
  ok(pv.j?.ok === true && pv.ms < 8000 && pv.j.sites[0].plan.items_new === SCALE_ITEMS, `preview of 5 sites in one call: ${pv.ms} ms (under the 8 s limit), ${pv.j?.sites?.[0]?.plan?.items_new} new items each`);
  r = callJ('editorBig', `select public.msm_stock_publish('${ORG_BIG}', 'now')`);
  ok(r.j?.ok === true && r.ms < 8000, `publish (freeze ${changes.length} changes, health at ${SCALE_SITES} sites) in ${r.ms} ms, under the 8 s limit`);
  const bigV = r.j?.version_id;
  const t0 = Date.now();
  let loops = 0;
  while (num(`select count(*) from msm_stock_version_sites where version_id = '${bigV}' and status = 'waiting'`) > 0 && loops < 200) { runDue(45); loops++; }
  const total = (Date.now() - t0) / 1000;
  const per = sql(`select max(extract(epoch from done_at - started_at))::numeric(10,1) || '|' || avg(extract(epoch from done_at - started_at))::numeric(10,1) from msm_stock_version_sites where version_id = '${bigV}'`).split('|');
  ok(Number(per[0]) < 30, `first publish per site: slowest ${per[0]} s, average ${per[1]} s (under 30 s); all ${SCALE_SITES} sites in ${total.toFixed(0)} s`);
  ok(num(`select count(*) from inventory_items t join locations l on l.id = t.location_id where l.org_id = '${ORG_BIG}'`) === SCALE_SITES * SCALE_ITEMS
     && num(`select count(*) from supplier_products t join locations l on l.id = t.location_id where l.org_id = '${ORG_BIG}'`) === SCALE_SITES * SCALE_ITEMS,
    `${SCALE_SITES * SCALE_ITEMS} site items and as many supplier prices written`);
  // one change to every site
  const one = items[17];
  callJ('editorBig', `select public.msm_stock_stage('${ORG_BIG}', ${jlit([{ target: 'sp', entity_id: one.sp, data: { pack_price: 99.5 } }])})`);
  r = callJ('editorBig', `select public.msm_stock_publish('${ORG_BIG}', 'now')`);
  const v2 = r.j?.version_id;
  const t1 = Date.now();
  loops = 0;
  while (num(`select count(*) from msm_stock_version_sites where version_id = '${v2}' and status = 'waiting'`) > 0 && loops < 50) { runDue(45); loops++; }
  const oneTotal = (Date.now() - t1) / 1000;
  ok(oneTotal < 600 && num(`select count(*) from supplier_products t join locations l on l.id = t.location_id where l.org_id = '${ORG_BIG}' and t.pack_price = 99.5`) === SCALE_SITES,
    `one price change reaches all ${SCALE_SITES} sites in ${oneTotal.toFixed(1)} s (under 10 minutes)`);
  // the screens, as each login, under 1 s, never more than 1,000 rows
  for (const [who, call] of [['editorBig', `select public.msm_stock_items_page('${ORG_BIG}', null, null, 0, 100)`],
    ['editorBig', `select public.msm_stock_items_page('${ORG_BIG}', 'item 49', null, 0, 100)`],
    ['editorBig', `select public.msm_stock_prices_page('${ORG_BIG}', null, null, 4900, 100)`],
    ['editorBig', `select public.msm_stock_suppliers_page('${ORG_BIG}')`],
    ['editorBig', `select public.msm_stock_site_cards('${ORG_BIG}')`],
    ['editorBig', `select public.msm_stock_history('${ORG_BIG}')`],
    ['superAdmin', `select public.msm_stock_items_page('${ORG_BIG}', null, 'not_everywhere', 0, 100)`]]) {
    const q = asCaller(who, call);
    const rows = q.out.split('\n').filter(Boolean).length;
    ok(q.status === 0 && q.ms < 1000 && rows === 1, `${call.slice(14, 60)}... as ${who}: ${q.ms} ms, ${rows} row`);
  }
  const page = callJ('editorBig', `select public.msm_stock_items_page('${ORG_BIG}', null, null, 0, 100)`);
  ok(page.j?.total === SCALE_ITEMS && page.j.rows.length === 100 && Object.keys(page.j.rows[0].sites).length === SCALE_SITES,
    `a page is 100 items with each item's ${SCALE_SITES} sites packed into one value; total ${page.j?.total}`);
  const cards = callJ('editorBig', `select public.msm_stock_site_cards('${ORG_BIG}')`);
  ok(cards.j?.length === SCALE_SITES && cards.j.every((c) => !c.waiting && c.central === 'central'), 'every site card says in step, and every site is central');
  const z = planOf(ORG_BIG, sql(`select id from locations where org_id = '${ORG_BIG}' order by name limit 1`));
  ok(z.writes === 0, 'I8 at scale: a re publish plans zero writes');
})();

// == 17. Rollback, and the paste again =====================================================================================
section(17, '17. Rollback');
{
  const before = { A1: QTY_SUMS(A1), A2: QTY_SUMS(A2), B1: SUMS(B1) };
  const rb = psql({ args: ['-1', '-f', ROLLBACK], allowFail: true });
  const rr = rb.stdout.trim().split('\n').pop().split('|');
  ok(rb.status === 0 && rr.slice(0, 6).join('|') === '0|0|0|0|0|1', `the rollback applies; check ${rr.join('|')}`);
  ok(QTY_SUMS(A1) === before.A1 && QTY_SUMS(A2) === before.A2 && SUMS(B1) === before.B1, 'no quantity, cost or ledger row changed');
  ok(num(`select count(*) from stock_depletion_mode where mode = 'central'`) >= 3, 'every venue keeps its central mode');
  ok(sql(`select has_function_privilege('authenticated', 'public.approve_stock_count(uuid,text,text,jsonb,boolean)'::regprocedure, 'execute')`) === 't',
    'count approval is open to Back Office logins again (as 20261019b)');
  const again = psql({ args: ['-1', '-f', MIGRATION], allowFail: true });
  ok(again.status === 0, 'the file applies again after the rollback');
}

// == 18. Guards ============================================================================================================
section(18, '18. The file stops, changing nothing, without what it needs');
{
  DB = 'postgres';
  sql(`drop database if exists s1_bare`); sql(`create database s1_bare`); DB = 's1_bare';
  sqlFile(join(P0, 'schema.sql'));
  const r = psql({ args: ['-1', '-f', MIGRATION], allowFail: true });
  ok(r.status !== 0 && /Run 20261017|not the Ops/.test(r.stderr) && sql(`select count(*) from pg_class where relname = 'stock_company'`) === '0',
    `without the Multi site menu and Phase 0 it stops in words (${(/ERROR:\s*(.*)/.exec(r.stderr) || [])[1]?.slice(0, 80)})`);
}

finish();
