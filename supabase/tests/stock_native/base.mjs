// base.mjs: the throwaway PostgreSQL 17 cluster and the Ops shaped base database that run.mjs and
// rehearse.mjs share. It never connects to Supabase.
//
// The base database is built the way Ops is today (20 Oct 2026): the live table shapes and row level
// security of the stock tables (../stock_phase0/schema.sql, policies.sql, central_schema.sql, then
// extra_schema.sql here), the 20261016 / 5 Aug function texts (../stock_function_fences/live), the
// live helper texts no repo file has in their live form (live/helpers_20oct.sql), the Multi site
// menu helpers copied word for word from the REAL 20261017 file, then every real migration Peter
// already ran, in the order he ran them: 20260921u, 20261005b (report_day_sums, which the 0a sales
// day check compares with), 20261018a, 20261018c, 20261019, 20261019b, 20261019a, 20261020a. Last, the row level
// security of the 27 stock tables exactly as live (live_policies.sql: 51 + 14 + 27 second step).
//
// Every API call is made the way PostgREST makes it: logged in as authenticator (with the
// pg-safeupdate stand in preloaded, as Ops preloads pg-safeupdate), SET ROLE anon, authenticated or
// service_role, the request claims set, and the live limits (authenticated and service role 8 s,
// anon 3 s, lock 8 s). pg_cron and the SQL editor log in as postgres.

import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const here = dirname(fileURLToPath(import.meta.url));
export const repo = join(here, '..', '..', '..');
export const P0 = join(repo, 'supabase/tests/stock_phase0');
export const FLIVE = join(repo, 'supabase/tests/stock_function_fences/live');
export const MIG = (f) => join(repo, 'supabase/migrations', f);

// The real migrations Peter ran, in his order (20261019a and 20261020a ran live AFTER 20261019b).
export const BASE_MIGRATIONS = [
  '20261005b_OPS_report_day_sums.sql',
  '20261018a_OPS_stock_function_fences.sql',
  '20261018c_OPS_central_stock_depletion.sql',
  '20261019_OPS_central_stock_default.sql',
  '20261019b_OPS_stock_phase0.sql',
  '20261019a_OPS_channel_parity.sql',
  '20261020a_OPS_channel_parity_2.sql',
];
export const FENCE_FILE = '20260921u_OPS_owner_holds_own_company.sql';

const bin = (name) => (existsSync(`/opt/homebrew/bin/${name}`) ? `/opt/homebrew/bin/${name}` : name);
const env = { ...process.env, LC_ALL: 'en_US.UTF-8', PGOPTIONS: '-c client_min_messages=warning' };

// -- the cluster ---------------------------------------------------------------------------------------
export function startCluster({ portBase = 55800, guard = !process.env.STOCKN_NO_GUARD } = {}) {
  const port = process.env.STOCKN_PGPORT || String(portBase + Math.floor(Math.random() * 90));
  const dir = mkdtempSync(join(tmpdir(), 'pgn.'));
  const data = join(dir, 'data');
  let r = spawnSync(bin('initdb'), ['-D', data, '-U', 'postgres', '--auth=trust', '-E', 'UTF8'], { env, encoding: 'utf8' });
  if (r.status !== 0) { console.error(r.stderr || r.stdout); process.exit(2); }
  r = spawnSync(bin('pg_ctl'), ['-D', data, '-l', join(dir, 'pg.log'), '-w', '-o',
    `-p ${port} -c listen_addresses='' -k ${dir} -c max_connections=100 -c fsync=off -c synchronous_commit=off -c full_page_writes=off -c shared_buffers=256MB -c work_mem=32MB -c max_locks_per_transaction=256`, 'start'], { env, encoding: 'utf8' });
  if (r.status !== 0) { console.error(r.stderr || r.stdout); process.exit(2); }

  const c = { port, dir, data, DB: 'postgres', guardOn: false, guardLib: null, throwing: false };
  c.stop = () => {
    spawnSync(bin('pg_ctl'), ['-D', data, '-m', 'fast', '-w', 'stop'], { env, encoding: 'utf8' });
    rmSync(dir, { recursive: true, force: true });
  };
  // Ops preloads pg-safeupdate for the API login (authenticator): an UPDATE or DELETE with no WHERE is
  // refused there, inside plpgsql too. safeupdate_guard.c is a small stand in, built with this
  // cluster's pg_config and preloaded for authenticator only (STOCKN_NO_GUARD=1 skips it, and says so).
  if (guard) {
    const lib = join(dir, process.platform === 'darwin' ? 'safeupdate_guard.dylib' : 'safeupdate_guard.so');
    const cfg = (a) => spawnSync(bin('pg_config'), [a], { env, encoding: 'utf8' }).stdout.trim();
    const flags = process.platform === 'darwin' ? ['-bundle', '-undefined', 'dynamic_lookup'] : ['-shared', '-fPIC'];
    const cpp = cfg('--cppflags').split(/\s+/).filter(Boolean);
    const cc = spawnSync('cc', [...flags, ...cpp, `-I${cfg('--includedir-server')}`, '-o', lib, join(here, 'safeupdate_guard.c')], { env, encoding: 'utf8' });
    if (cc.status !== 0) { console.error('could not build the safeupdate stand in (set STOCKN_NO_GUARD=1 to run without it):\n', cc.stderr); c.stop(); process.exit(2); }
    c.guardOn = true;
    c.guardLib = lib;
  }

  c.psql = ({ login = 'postgres', db = c.DB, input, args = [], allowFail = false }) => {
    const res = spawnSync(bin('psql'), ['-h', dir, '-p', port, '-U', login, '-d', db, '-v', 'ON_ERROR_STOP=1', '-X', '-q', '-At', ...args],
      { env, input, encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024 });
    if (res.status !== 0 && !allowFail) {
      // inside a guarded section an unexpected SQL error is one failed check, never the end of the run
      if (c.throwing) throw new Error(`SQL error: ${(res.stderr || res.stdout || '').slice(0, 600)}\n  in: ${String(input || args.join(' ')).slice(0, 300)}`);
      console.error('psql failed:', args.join(' '), '\n', (res.stderr || res.stdout || '').slice(0, 4000));
      c.stop(); process.exit(2);
    }
    return res;
  };
  c.sql = (q, opts = {}) => c.psql({ ...opts, input: q }).stdout.trim();
  c.sqlFile = (path, opts = {}) => c.psql({ ...opts, args: ['-1', '-f', path] });
  c.num = (q, opts) => Number(c.sql(q, opts));
  // async psql (concurrent sessions)
  c.psqlAsync = ({ login = 'postgres', db = c.DB, input }) => new Promise((res) => {
    const t0 = Date.now();
    const p = spawn(bin('psql'), ['-h', dir, '-p', port, '-U', login, '-d', db, '-v', 'ON_ERROR_STOP=1', '-X', '-q', '-At'], { env });
    let err = ''; let out = '';
    p.stderr.on('data', (d) => { err += d; }); p.stdout.on('data', (d) => { out += d; });
    p.on('close', (code) => { const m = /ERROR:\s+([0-9A-Z]{5})/.exec(err); res({ code, err, out: out.trim(), sqlstate: m ? m[1] : null, ms: Date.now() - t0 }); });
    p.stdin.end(input);
  });
  // A paste as the SQL editor runs it: one transaction, stop on the first error, every result set
  // kept (unaligned, unit separator between fields, the "(n rows)" footer closing each set).
  c.paste = (path, { db = c.DB, input = null, after = '' } = {}) => {
    const text = input != null ? input : readFileSync(path, 'utf8');
    const t0 = Date.now();
    const res = spawnSync(bin('psql'), ['-h', dir, '-p', port, '-U', 'postgres', '-d', db, '-v', 'ON_ERROR_STOP=1', '-X', '-q', '-1',
      '-A', '-F', '\x1f', '-P', 'footer=on', '-f', '-'], { env, input: text + (after ? `\n${after}\n` : ''), encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    const m = /ERROR:\s+(?:([0-9A-Z]{5}):\s*)?(.*)/.exec(res.stderr || '');
    return { status: res.status, stderr: res.stderr || '', error: m ? m[2] : null, sets: resultSets(res.stdout || ''), ms: Date.now() - t0 };
  };
  c.createFrom = (name, template) => {
    c.psql({ db: 'postgres', input: `drop database if exists ${name} with (force); create database ${name} template ${template};` });
  };
  c.use = (name) => { c.DB = name; };
  return c;
}

// psql unaligned output (-A -F \x1f -P footer=on) to result sets: a header line, rows, "(n rows)".
export function resultSets(out) {
  const lines = out.split('\n');
  const sets = [];
  let i = 0;
  while (i < lines.length) {
    if (!lines[i].trim()) { i++; continue; }
    const cols = lines[i].split('\x1f');
    i++;
    const rows = [];
    while (i < lines.length && !/^\(\d+ rows?\)$/.test(lines[i])) { rows.push(lines[i].split('\x1f')); i++; }
    i++;
    sets.push({ cols, rows: rows.map((r) => Object.fromEntries(cols.map((col, k) => [col, r[k]]))) });
  }
  return sets;
}

export const lit = (v) => (v == null ? 'null' : `'${String(v).replace(/'/g, "''")}'`);
export const jlit = (o) => `${lit(JSON.stringify(o))}::jsonb`;
export const arr = (ids) => (ids == null ? 'null' : `array[${ids.map((x) => `'${x}'`).join(',')}]::uuid[]`);
export function rng(seed) {
  let t = seed >>> 0;
  return () => { t += 0x6D2B79F5; let r = Math.imul(t ^ (t >>> 15), 1 | t); r ^= r + Math.imul(r ^ (r >>> 7), 61 | r); return ((r ^ (r >>> 14)) >>> 0) / 4294967296; };
}

// The Multi site menu helpers the stock files need, word for word from the REAL 20261017 file.
export function msmHelpers() {
  const text = readFileSync(MIG('20261017_OPS_multi_site_menu.sql'), 'utf8');
  const take = (name) => {
    const m = new RegExp(`create or replace function public\\.${name}\\([\\s\\S]*?\\n\\$fn\\$;`).exec(text);
    if (!m) throw new Error(`20261017 has no ${name}`);
    return m[0];
  };
  return ['msm__second_step_ok', 'msm__require_servos', 'msm_viewable_org_ids', 'msm_editable_org_ids', 'msm_can_edit']
    .map(take).join('\n\n') + `
revoke all on function public.msm__second_step_ok() from public, anon, authenticated, service_role;
`;
}

// The schema part of the base database: everything before the fixtures and the migrations.
export function baseSchema(c, { log = () => {} } = {}) {
  c.sqlFile(join(P0, 'schema.sql'));
  c.sqlFile(join(here, 'live_indexes.sql'));
  if (c.guardOn) c.sql(`alter role authenticator set session_preload_libraries = '${c.guardLib}'`);
  c.sqlFile(join(FLIVE, 'helpers.sql'));
  c.sql(`revoke all on function public.user_accessible_locations() from public;
         grant execute on function public.user_accessible_locations() to anon, authenticated, service_role;
         grant execute on function public.is_anon_session() to public, anon, authenticated, service_role;
         grant execute on function public.is_super_admin() to public, anon, authenticated, service_role;
         revoke all on function public.accessible_location_ids() from public;
         revoke all on function public.accessible_location_uuids() from public;
         grant execute on function public.accessible_location_ids() to anon, authenticated, service_role;
         grant execute on function public.accessible_location_uuids() to anon, authenticated, service_role;`);
  c.sqlFile(join(P0, 'policies.sql'));
  c.sqlFile(join(P0, 'central_schema.sql'));
  c.sqlFile(join(here, 'extra_schema.sql'));
  c.sqlFile(join(here, 'live', 'helpers_20oct.sql'));
  c.sqlFile(join(FLIVE, 'post_stock_movement_20261016.sql'));
  c.sqlFile(join(FLIVE, 'set_inventory_on_hand_20260805.sql'));
  c.sqlFile(join(FLIVE, 'post_stock_transfer_leg_20261016.sql'));
  c.sqlFile(join(P0, 'live/rehome_20261016.sql'));
  c.sqlFile(join(P0, 'live/stock_usage_by_weekday_live.sql'));
  c.sqlFile(join(P0, 'live/stock_usage_rates_live.sql'));
  c.sql(`grant execute on function public.post_stock_movement(uuid,uuid,numeric,text,numeric,text,text,text,timestamptz,uuid,text,uuid) to authenticated, anon, service_role;
         grant execute on function public.set_inventory_on_hand(uuid,uuid,numeric,uuid,text) to public, anon, authenticated, service_role;
         revoke all on function public.post_stock_transfer_leg(uuid,text,text) from public, anon;
         grant execute on function public.post_stock_transfer_leg(uuid,text,text) to authenticated, service_role;`);
  c.psql({ input: c.msm || msmHelpers() });
  log('schema');
}

// Apply one real migration as Peter ran it (one paste, one transaction). Returns the psql result.
// A file that opens its own transaction (begin; ... commit;, as 20261019a and 20261020a do) is run
// as it is; every other file in one transaction (-1), as the SQL editor runs a paste.
export function applyMigration(c, file) {
  const own = /^\s*begin\s*;/im.test(readFileSync(MIG(file), 'utf8'));
  return c.psql({ args: own ? ['-f', MIG(file)] : ['-1', '-f', MIG(file)], allowFail: true });
}

// After the real migrations: the live row level security of the 27 stock tables and the live
// constraints and indexes the migrations do not make here.
export function liveTail(c) {
  c.sqlFile(join(here, 'live_shape.sql'));
  c.sqlFile(join(here, 'live_policies.sql'));
}

// After the fence file: the trigger 20260919a1 made on user_profiles (live: BEFORE UPDATE).
export const FENCE_TRIGGER = `create trigger user_profiles_fence_guard before update on public.user_profiles
  for each row execute function public.user_profiles_fence_guard();`;

// The 27 stock tables whose policies 0a step 8 swaps (live, 20 Oct 2026).
export const STOCK27 = ['inventory_item_area_stock', 'inventory_item_areas', 'inventory_item_conversions', 'inventory_items', 'item_cost_history',
  'item_packaging_formats', 'menu_item_recipes', 'par_levels', 'po_lines', 'prep_schedule', 'production_batches', 'purchase_orders', 'recipe_lines',
  'recipes', 'stock_count_areas', 'stock_count_lines', 'stock_counts', 'stock_movements', 'stock_site_settings', 'stock_transfer_lines',
  'stock_transfers', 'storage_areas', 'supplier_invoice_lines', 'supplier_invoices', 'supplier_products', 'suppliers', 'waste_events'];

// The 26 per venue tables of the 0a snapshot (contract 5.2), and its sums.
export const SNAP_TABLES = ['inventory_items', 'suppliers', 'supplier_products', 'item_packaging_formats', 'inventory_item_conversions', 'recipes',
  'recipe_lines', 'menu_item_recipes', 'par_levels', 'storage_areas', 'inventory_item_areas', 'inventory_item_area_stock', 'stock_movements',
  'purchase_orders', 'po_lines', 'supplier_invoices', 'supplier_invoice_lines', 'waste_events', 'item_cost_history', 'stock_counts',
  'stock_count_lines', 'stock_count_areas', 'production_batches', 'prep_schedule', 'stock_transfers', 'stock_transfer_lines'];

// Every number that must not move on link, per venue: the 33 snapshot metrics plus the per row
// vectors (each item's on hand, cost and ledger; each area holding; each recipe line's base quantity).
export function venueFigures(c, loc) {
  const counts = SNAP_TABLES.map((t) => `'n:${t}', (select count(*) from public.${t} where location_id = '${loc}')`).join(',\n    ');
  return JSON.parse(c.sql(`select json_build_object(
    ${counts},
    's:on_hand', (select coalesce(sum(on_hand), 0) from inventory_items where location_id = '${loc}'),
    's:current_cost', (select coalesce(sum(current_cost), 0) from inventory_items where location_id = '${loc}'),
    's:books', (select coalesce(sum(on_hand * current_cost), 0) from inventory_items where location_id = '${loc}'),
    's:mv_qty', (select coalesce(sum(qty_base), 0) from stock_movements where location_id = '${loc}'),
    's:mv_value', (select coalesce(sum(value_delta), 0) from stock_movements where location_id = '${loc}'),
    's:area_on_hand', (select coalesce(sum(on_hand), 0) from inventory_item_area_stock where location_id = '${loc}'),
    's:recipe_base_qty', (select coalesce(sum(public.stock_qty_to_base(rl.qty, rl.unit, rl.component_item_id)), 0) from recipe_lines rl where rl.location_id = '${loc}'),
    'v:items', (select coalesce(json_agg(json_build_object('id', i.id, 'on_hand', i.on_hand, 'cost', i.current_cost,
                   'mq', (select coalesce(sum(m.qty_base), 0) from stock_movements m where m.inventory_item_id = i.id),
                   'mv', (select coalesce(sum(m.value_delta), 0) from stock_movements m where m.inventory_item_id = i.id)) order by i.id), '[]')
                  from inventory_items i where i.location_id = '${loc}'),
    'v:area', (select coalesce(json_agg(json_build_object('i', a.inventory_item_id, 'a', a.area_id, 'q', a.on_hand) order by a.inventory_item_id, a.area_id), '[]')
                 from inventory_item_area_stock a where a.location_id = '${loc}'),
    'v:lines', (select coalesce(json_agg(json_build_object('id', rl.id, 'b', public.stock_qty_to_base(rl.qty, rl.unit, rl.component_item_id)) order by rl.id), '[]')
                  from recipe_lines rl where rl.location_id = '${loc}'),
    'v:pars', (select coalesce(json_agg(json_build_object('i', p.inventory_item_id, 'p', p.par_level, 'r', p.reorder_point, 'm', p.min_level) order by p.inventory_item_id), '[]')
                 from par_levels p where p.location_id = '${loc}'))`));
}
// The differences between two venueFigures (metric names; vectors compared whole).
export function figureDiff(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
}
