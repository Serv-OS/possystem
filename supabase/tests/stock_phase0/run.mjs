#!/usr/bin/env node
// run.mjs: proves 20261019b (stock Phase 0, the safety pass) on a local, throwaway PostgreSQL 17
// before Peter runs it on the Ops database. It never connects to Supabase.
//
//   node supabase/tests/stock_phase0/run.mjs              the whole proof
//   node supabase/tests/stock_phase0/run.mjs --quick      fewer random sequences (a quick look)
//   node supabase/tests/stock_phase0/run.mjs --print-md5  the guard constants, then stop
//   node supabase/tests/stock_phase0/run.mjs --seed=1234  replay the random runs of that seed
//
// The database is built the way Ops is: the live table shapes and row level security
// (schema.sql, policies.sql, central_schema.sql), the 20261016 / 5 Aug function texts
// (../stock_function_fences/live), then the REAL 20261018a file (v5.11.76) and the REAL 20261018c
// file (v5.11.77, central stock depletion), as Peter ran them (section 21 also the REAL 20261019,
// v5.11.78, every venue central, as live is), then 20261019b as the SQL editor runs a paste (one
// transaction, stop on the first error). Every call is made the way the API makes it: logged in as authenticator, SET
// ROLE to anon, authenticated or service_role, the request claims set, and the live timeouts
// (authenticated and service role 8 s, anon 3 s, lock 8 s). Exit code 0 only when every check holds.

import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..');
const FENCES = join(repo, 'supabase/migrations/20261018a_OPS_stock_function_fences.sql');
const CENTRAL = join(repo, 'supabase/migrations/20261018c_OPS_central_stock_depletion.sql');
const CENTRAL_DEFAULT = join(repo, 'supabase/migrations/20261019_OPS_central_stock_default.sql');
// PHASE0_MIGRATION / PHASE0_ROLLBACK: run the same proof against another copy of the file (to show
// that a new check fails on the file before a fix). Normally unset.
const MIGRATION = process.env.PHASE0_MIGRATION || join(repo, 'supabase/migrations/20261019b_OPS_stock_phase0.sql');
const ROLLBACK = process.env.PHASE0_ROLLBACK || join(repo, 'supabase/migrations/20261019b_OPS_stock_phase0_ROLLBACK.sql');
const FLIVE = join(repo, 'supabase/tests/stock_function_fences/live');
const PRINT_MD5 = process.argv.includes('--print-md5');
const QUICK = process.argv.includes('--quick');
const SEED = Number((process.argv.find((a) => a.startsWith('--seed=')) || '').slice(7)) || (Date.now() % 1000000);

const bin = (name) => (existsSync(`/opt/homebrew/bin/${name}`) ? `/opt/homebrew/bin/${name}` : name);
const env = { ...process.env, LC_ALL: 'en_US.UTF-8', PGOPTIONS: '-c client_min_messages=warning' };

let failures = 0;
let checks = 0;
const ok = (cond, msg) => { checks++; if (cond) console.log(`  ok   ${msg}`); else { failures++; console.log(`  FAIL ${msg}`); } };
const near = (a, b, eps = 1e-4) => Math.abs(Number(a) - Number(b)) <= eps;

// -- a seeded random source (mulberry32), so a failing run can be replayed --------------------------
function rng(seed) {
  let t = seed >>> 0;
  return () => { t += 0x6D2B79F5; let r = Math.imul(t ^ (t >>> 15), 1 | t); r ^= r + Math.imul(r ^ (r >>> 7), 61 | r); return ((r ^ (r >>> 14)) >>> 0) / 4294967296; };
}

// -- the cluster -------------------------------------------------------------------------------------
const port = process.env.PHASE0_PGPORT || String(55500 + Math.floor(Math.random() * 80));
const dir = mkdtempSync(join(tmpdir(), 'pg0.'));
const data = join(dir, 'data');
{
  let r = spawnSync(bin('initdb'), ['-D', data, '-U', 'postgres', '--auth=trust', '-E', 'UTF8'], { env, encoding: 'utf8' });
  if (r.status !== 0) { console.error(r.stderr || r.stdout); process.exit(2); }
  r = spawnSync(bin('pg_ctl'), ['-D', data, '-l', join(dir, 'pg.log'), '-w', '-o', `-p ${port} -c listen_addresses='' -k ${dir} -c max_connections=60 -c fsync=off -c synchronous_commit=off`, 'start'], { env, encoding: 'utf8' });
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
    { env, input, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0 && !allowFail) {
    console.error('psql failed:', args.join(' '), '\n', (r.stderr || r.stdout || '').slice(0, 4000));
    stop(); process.exit(2);
  }
  return r;
}
const sql = (q, opts = {}) => psql({ ...opts, input: q }).stdout.trim();
const sqlFile = (path, opts = {}) => psql({ ...opts, args: ['-1', '-f', path] });
const sqlText1 = (text, opts = {}) => psql({ ...opts, args: ['-1', '-f', '-'], input: text });
const lit = (v) => (v == null ? 'null' : `'${String(v).replace(/'/g, "''")}'`);
const jlit = (o) => `${lit(JSON.stringify(o))}::jsonb`;
const num = (q) => Number(sql(q));
const md5Of = (sig) => sql(`select md5(btrim(regexp_replace(p.prosrc, '\\s+', ' ', 'g'))) from pg_proc p where p.oid = to_regprocedure('${sig}')`);
const SIG = {
  core: 'public._post_stock_movement(uuid,uuid,numeric,text,numeric,text,text,text,timestamptz,uuid,text,uuid)',
  leg: 'public.post_stock_transfer_leg(uuid,text,text)',
  rehome: 'public.inventory_item_areas_rehome()',
  weekday2: 'public.stock_usage_by_weekday(uuid,integer)',
  psm: 'public.post_stock_movement(uuid,uuid,numeric,text,numeric,text,text,text,timestamptz,uuid,text,uuid)',
  counted: 'public._stock_counted_after(uuid,uuid,timestamptz)',
  sweep: 'public.stock_outbox_sweep()',
  sw: 'public.stock_central_switch(uuid,text,text)',
  modeOf: 'public._stock_mode_of(uuid)',
  enq: 'public._stock_outbox_on_insert()',
};

// -- fixtures ----------------------------------------------------------------------------------------
const id = (prefix, tail) => `${prefix}-0000-4000-8000-${String(tail).padStart(12, '0')}`;
const ORG_A = id('0a000000', 'a'), ORG_B = id('0b000000', 'b'), ORG_BIG = id('0c000000', 'c');
const A1 = id('a1000000', 'a1'), A2 = id('a2000000', 'a2'), B1 = id('b1000000', 'b1'), BIG = id('c1000000', 'c1');
const U = { boA1: id('10000000', 'a1'), ownerA: id('10000000', 'a'), superAdmin: id('10000000', 'ff'), boB1: id('10000000', 'b1'), editorA: id('10000000', 'ed') };
const DEV = { tillA1: id('20000000', 'a1'), kioskA1: id('20000000', '1a1'), opsA2: id('20000000', 'a2'), tillB1: id('20000000', 'b1') };
const STRANGER = id('30000000', '1');
const I = {
  milk: id('40000000', 'a11'), beans: id('40000000', 'a12'), cups: id('40000000', 'a13'), syrup: id('40000000', 'a14'),
  free: id('40000000', 'a15'), lastc: id('40000000', 'a16'), packed: id('40000000', 'a17'),
  milk2: id('40000000', 'a21'), beans2: id('40000000', 'a22'), cups2: id('40000000', 'a23'), b1: id('40000000', 'b11'),
};
const AR = { bar: id('50000000', 'a11'), cellar: id('50000000', 'a12'), recv: id('50000000', 'a13'), bar2: id('50000000', 'a21'), b1: id('50000000', 'b11') };
const SUP = { a1: id('60000000', 'a1'), a1b: id('60000000', 'a1b'), b1: id('60000000', 'b1') };
const SP = { milk: id('61000000', 'a11'), beans: id('61000000', 'a12') };
const PACK = { milkCase: id('62000000', 'a11'), beansBag: id('62000000', 'a12') };

const anonSession = (sub) => ({ sub, role: 'authenticated', is_anonymous: true, aud: 'authenticated' });
const login = (sub) => ({ sub, role: 'authenticated', is_anonymous: false, aud: 'authenticated' });
const CALLERS = {
  tillA1: { login: 'authenticator', role: 'authenticated', claims: anonSession(DEV.tillA1), what: 'till bound to A1' },
  kioskA1: { login: 'authenticator', role: 'authenticated', claims: anonSession(DEV.kioskA1), what: 'kiosk bound to A1' },
  opsA2: { login: 'authenticator', role: 'authenticated', claims: anonSession(DEV.opsA2), what: 'ops tablet of A2' },
  tillB1: { login: 'authenticator', role: 'authenticated', claims: anonSession(DEV.tillB1), what: 'till bound to B1 (other company)' },
  boA1: { login: 'authenticator', role: 'authenticated', claims: login(U.boA1), what: 'Back Office login of A1' },
  boB1: { login: 'authenticator', role: 'authenticated', claims: login(U.boB1), what: 'Back Office login of B1 (other company)' },
  ownerA: { login: 'authenticator', role: 'authenticated', claims: login(U.ownerA), what: 'owner of company A (no link rows)' },
  editorA: { login: 'authenticator', role: 'authenticated', claims: login(U.editorA), what: 'Multi site menu editor of company A' },
  superAdmin: { login: 'authenticator', role: 'authenticated', claims: login(U.superAdmin), what: 'super admin' },
  service: { login: 'authenticator', role: 'service_role', claims: { role: 'service_role' }, what: 'service role (edge function)' },
  sqlEditor: { login: 'postgres', what: 'SQL editor' },
  stranger: { login: 'authenticator', role: 'authenticated', claims: anonSession(STRANGER), what: 'stranger (anonymous, bound to nothing)' },
  anonKey: { login: 'authenticator', role: 'anon', claims: { role: 'anon' }, what: 'bare anon key' },
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
  const r = psql({ login: c.login, input: lines.join('\n') + '\n', allowFail: true });
  const m = /ERROR:\s+([0-9A-Z]{5}):\s*(.*)/.exec(r.stderr || '');
  return { status: r.status, sqlstate: m ? m[1] : null, message: m ? m[2] : (r.stderr || '').trim(), out: r.stdout.trim() };
}
const lastJson = (r) => { try { return JSON.parse(r.out.split('\n').filter(Boolean).pop()); } catch { return null; } };
const callJ = (callerKey, body) => { const r = asCaller(callerKey, body); return { ...r, j: lastJson(r) }; };

// -- live sessions, for interleavings: a caller's transaction kept open between statements ----------
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
let marks = 0;
function session(callerKey) {
  const c = CALLERS[callerKey];
  const p = spawn(bin('psql'), ['-h', dir, '-p', port, '-U', c.login, '-d', DB, '-X', '-q', '-At'], { env });
  const s = { out: '', err: '' };
  p.stdout.on('data', (d) => { s.out += d; }); p.stderr.on('data', (d) => { s.err += d; });
  const send = (t) => p.stdin.write(t + '\n');
  callerLines(c).forEach(send);
  s.run = (stmt) => { const m = `MK${++marks}`; send(stmt.trim().replace(/;?$/, ';')); send(`\\echo ${m}`); return m; };
  s.done = (m) => s.out.includes(m);
  s.wait = async (m, ms = 12000) => { const t = Date.now(); while (!s.done(m) && Date.now() - t < ms) await sleep(20); return s.done(m); };
  s.end = async (word = 'commit') => { const m = s.run(word); await s.wait(m); p.stdin.end(); await new Promise((res) => p.on('close', res)); };
  s.code = () => { const m = /ERROR:\s+([0-9A-Z]{5})/.exec(s.err); return m ? m[1] : null; };
  return s;
}
// One API call in its own transaction, as PostgREST makes it; resolves { code, err, out }.
function oneShot(callerKey, body) {
  const c = CALLERS[callerKey];
  const lines = callerLines(c);
  lines.push(body.trim().replace(/;?$/, ';'), 'commit;');
  return new Promise((res) => {
    const p = spawn(bin('psql'), ['-h', dir, '-p', port, '-U', c.login, '-d', DB, '-v', 'ON_ERROR_STOP=1', '-X', '-q', '-At'], { env });
    let err = ''; let out = '';
    p.stderr.on('data', (d) => { err += d; }); p.stdout.on('data', (d) => { out += d; });
    p.on('close', (code) => { const m = /ERROR:\s+([0-9A-Z]{5})/.exec(err); res({ code, err, out: out.trim(), sqlstate: m ? m[1] : null }); });
    p.stdin.end(lines.join('\n') + '\n');
  });
}
const freshItem = (name, { loc = A1, unit = 'each', cost: c = 1 } = {}) => {
  const iid = randomUUID();
  sql(`insert into inventory_items (id, location_id, name, base_unit, current_cost, on_hand) values ('${iid}', '${loc}', ${lit(name)}, '${unit}', ${c == null ? 'null' : c}, 0)`);
  return iid;
};

const post = (loc, item, qty, type, { key = null, at = null, area = null, cost = null, src = 'closed_check', srcId = null } = {}) =>
  `select public.post_stock_movement(p_location_id => '${loc}', p_inventory_item_id => '${item}', p_qty_base => ${qty}, ` +
  `p_movement_type => '${type}', p_unit_cost => ${cost == null ? 'null' : cost}, p_source_type => ${lit(src)}, p_source_id => ${lit(srcId)}, ` +
  `p_idempotency_key => ${lit(key)}, p_occurred_at => ${at == null ? 'null' : `(${at})::timestamptz`}, p_created_by => null, p_notes => null` +
  (area ? `, p_area_id => '${area}'` : '') + ')';
const onHand = (item) => num(`select on_hand from inventory_items where id = '${item}'`);
const cost = (item) => num(`select current_cost from inventory_items where id = '${item}'`);
const ledger = (item) => num(`select coalesce(sum(qty_base), 0) from stock_movements where inventory_item_id = '${item}'`);
const areaHold = (item, area) => num(`select coalesce((select on_hand from inventory_item_area_stock where inventory_item_id = '${item}' and area_id = '${area}'), 0)`);
const areaLedger = (item, area) => num(`select coalesce(sum(qty_base), 0) from stock_movements where inventory_item_id = '${item}' and area_id = '${area}'`);

// -- one database ------------------------------------------------------------------------------------
function baseDb(name, { central = true, centralDefault = false } = {}) {
  DB = 'postgres';
  sql(`drop database if exists ${name}`);
  sql(`create database ${name}`);
  DB = name;
  sqlFile(join(here, 'schema.sql'));
  sqlFile(join(FLIVE, 'helpers.sql'));
  sql(`revoke all on function public.user_accessible_locations() from public;
       grant execute on function public.user_accessible_locations() to anon, authenticated, service_role;
       grant execute on function public.is_anon_session() to anon, authenticated, service_role;
       grant execute on function public.is_super_admin() to anon, authenticated, service_role;
       revoke all on function public.accessible_location_ids() from public;
       revoke all on function public.accessible_location_uuids() from public;
       grant execute on function public.accessible_location_ids() to anon, authenticated, service_role;
       grant execute on function public.accessible_location_uuids() to anon, authenticated, service_role;`);
  sqlFile(join(here, 'policies.sql'));
  sqlFile(join(here, 'central_schema.sql'));
  sqlFile(join(FLIVE, 'post_stock_movement_20261016.sql'));
  sqlFile(join(FLIVE, 'set_inventory_on_hand_20260805.sql'));
  sqlFile(join(FLIVE, 'post_stock_transfer_leg_20261016.sql'));
  sqlFile(join(here, 'live/rehome_20261016.sql'));
  sqlFile(join(here, 'live/stock_usage_by_weekday_live.sql'));
  sqlFile(join(here, 'live/stock_usage_rates_live.sql'));
  sql(`grant execute on function ${SIG.psm} to authenticated, anon, service_role;
       grant execute on function public.set_inventory_on_hand(uuid,uuid,numeric,uuid,text) to public, anon, authenticated, service_role;
       revoke all on function ${SIG.leg} from public, anon;
       grant execute on function ${SIG.leg} to authenticated, service_role;
       revoke all on function public.stock_usage_rates(uuid, integer) from public, anon;
       grant execute on function public.stock_usage_rates(uuid, integer) to authenticated, service_role;`);
  seed();
  // v5.11.76 then v5.11.77, exactly as Peter ran them on 19 Oct 2026. v5.11.78's 20261019 (every
  // venue central, every new venue central when created) only where asked: section 21 proves this
  // file on top of it as live is; the other sections keep the venues on the till path so a till's
  // own posts reach the core (the drainer calls the same core).
  sqlFile(FENCES);
  if (central) sqlFile(CENTRAL);
  if (central && centralDefault) sqlFile(CENTRAL_DEFAULT);
}

function seed() {
  sql(`
    insert into organisations (id, name) values ('${ORG_A}', 'Company A'), ('${ORG_B}', 'Company B'), ('${ORG_BIG}', 'Big group');
    insert into locations (id, org_id, name, timezone, created_at) values
      ('${A1}', '${ORG_A}', 'Provo', 'America/Denver', now() - interval '3 days'),
      ('${A2}', '${ORG_A}', 'Location 2', 'Europe/London', now() - interval '2 days'),
      ('${B1}', '${ORG_B}', 'Other company', 'Europe/London', now() - interval '1 day');
    insert into user_locations (user_id, location_id) values ('${U.boA1}', '${A1}'), ('${U.boB1}', '${B1}');
    insert into user_profiles (id, org_id, role) values
      ('${U.boA1}', null, 'manager'), ('${U.boB1}', null, 'manager'), ('${U.ownerA}', '${ORG_A}', 'owner'),
      ('${U.superAdmin}', null, 'super_admin'), ('${U.editorA}', null, 'manager');
    insert into devices (location_id, name, type, status, device_uid, bound_via, last_seen) values
      ('${A1}', 'POS 1', 'pos', 'online', '${DEV.tillA1}', 'claim_device_v2', now()),
      ('${A1}', 'Kiosk 1', 'kiosk', 'active', '${DEV.kioskA1}', 'claim_kiosk', now()),
      ('${B1}', 'POS B', 'pos', 'online', '${DEV.tillB1}', 'claim_device_v2', now());
    insert into ops_devices (location_id, org_id, device_uid, name, active) values ('${A2}', '${ORG_A}', '${DEV.opsA2}', 'Ops tablet', true);
    insert into storage_areas (id, location_id, name, kind, is_receiving) values
      ('${AR.bar}', '${A1}', 'Bar', 'bar', false), ('${AR.cellar}', '${A1}', 'Cellar', 'cellar', false),
      ('${AR.recv}', '${A1}', 'Goods in', 'other', false), ('${AR.bar2}', '${A2}', 'Bar', 'bar', false),
      ('${AR.b1}', '${B1}', 'Bar', 'bar', false);
    insert into inventory_items (id, location_id, org_id, name, base_unit, current_cost, on_hand, sku, cost_method) values
      ('${I.milk}', '${A1}', '${ORG_A}', 'Milk', 'ml', 0.00114, 0, 'MILK', 'MOVING_AVG'),
      ('${I.beans}', '${A1}', '${ORG_A}', 'Coffee beans', 'kg', 18.0, 0, 'BEANS', 'MOVING_AVG'),
      ('${I.cups}', '${A1}', '${ORG_A}', 'Cups', 'each', 0.05, 0, 'CUP', 'MOVING_AVG'),
      ('${I.syrup}', '${A1}', '${ORG_A}', 'Syrup', 'ml', null, 0, 'SYR', 'MOVING_AVG'),
      ('${I.free}', '${A1}', '${ORG_A}', 'Unused item', 'each', null, 0, null, 'MOVING_AVG'),
      ('${I.lastc}', '${A1}', '${ORG_A}', 'Lemons', 'each', 0.30, 0, 'LEM', 'LAST_COST'),
      ('${I.packed}', '${A1}', '${ORG_A}', 'Bottled water', 'each', 0.40, 0, 'WAT', 'MOVING_AVG'),
      ('${I.milk2}', '${A2}', '${ORG_A}', 'Milk', 'l', 1.10, 0, 'MILK', 'MOVING_AVG'),
      ('${I.beans2}', '${A2}', '${ORG_A}', 'Coffee beans', 'g', 0.02, 0, 'BEANS', 'MOVING_AVG'),
      ('${I.cups2}', '${A2}', '${ORG_A}', 'Cups', 'each', 0.05, 0, 'CUP', 'MOVING_AVG'),
      ('${I.b1}', '${B1}', '${ORG_B}', 'Milk', 'ml', 0.001, 0, 'MILK', 'MOVING_AVG');
    insert into inventory_item_areas (location_id, inventory_item_id, area_id, is_primary) values
      ('${A1}', '${I.milk}', '${AR.bar}', true), ('${A1}', '${I.beans}', '${AR.cellar}', true), ('${A1}', '${I.cups}', '${AR.bar}', true),
      ('${A2}', '${I.milk2}', '${AR.bar2}', true), ('${A2}', '${I.beans2}', '${AR.bar2}', true), ('${B1}', '${I.b1}', '${AR.b1}', true);
    insert into item_packaging_formats (id, location_id, inventory_item_id, name, qty_in_base) values
      ('${PACK.milkCase}', '${A1}', '${I.milk}', 'Case of 6', 6000), ('${PACK.beansBag}', '${A1}', '${I.beans}', 'Bag', 1);
    insert into suppliers (id, location_id, name, email) values
      ('${SUP.a1}', '${A1}', 'Dairy Co', 'orders@dairy.test'), ('${SUP.a1b}', '${A1}', 'Bean Co', 'orders@beans.test'), ('${SUP.b1}', '${B1}', 'Dairy B', null);
    insert into supplier_products (id, location_id, inventory_item_id, supplier_id, supplier_sku, pack_description, pack_qty, inner_qty, inner_unit, pack_price, is_preferred) values
      ('${SP.milk}', '${A1}', '${I.milk}', '${SUP.a1}', 'D-MILK6', 'Case 6 x 1 l', 6, 1, 'l', 6.60, true),
      ('${SP.beans}', '${A1}', '${I.beans}', '${SUP.a1b}', 'B-1KG', 'Bag 1 kg', 1, 1, 'kg', 18.00, true);
    insert into inventory_item_conversions (location_id, inventory_item_id, from_qty, from_unit, to_qty, to_unit) values
      ('${A2}', '${I.cups2}', 1, 'each', 12, 'g');
  `);
}

const migText = readFileSync(MIGRATION, 'utf8');
const rbText = readFileSync(ROLLBACK, 'utf8');
const unguarded = (text) => text.replace(/do \$guard\$[\s\S]*?\$guard\$;/, '');

// ===================================================================================================
console.log(`\nStock Phase 0 proof (seed ${SEED}${QUICK ? ', quick' : ''})`);

// -- 1. guard constants ------------------------------------------------------------------------------
console.log('\n1. Guard constants');
baseDb('p0_md5');
const md5 = { core18a: md5Of(SIG.core), leg18c: md5Of(SIG.leg), counted18c: md5Of(SIG.counted), rehome16: md5Of(SIG.rehome), weekday: md5Of(SIG.weekday2),
  rates: md5Of('public.stock_usage_rates(uuid,integer)'),
  psm18c: md5Of(SIG.psm), sweep18c: md5Of(SIG.sweep), sw18c: md5Of(SIG.sw), modeOf18c: md5Of(SIG.modeOf), enq18c: md5Of(SIG.enq) };
sqlText1(unguarded(migText.replace(/MD5_[A-Z0-9]+/g, '00000000000000000000000000000000')));
md5.core19b = md5Of(SIG.core); md5.leg19b = md5Of(SIG.leg); md5.rehome19b = md5Of(SIG.rehome); md5.counted19b = md5Of(SIG.counted);
if (PRINT_MD5) { console.log(JSON.stringify(md5, null, 2)); stop(); process.exit(0); }
for (const k of ['core18a', 'leg18c', 'counted18c', 'rehome16', 'core19b', 'leg19b', 'rehome19b', 'counted19b']) ok(migText.includes(`'${md5[k]}'`), `the migration guard carries ${k} (${md5[k]})`);
ok(md5Of(SIG.weekday2) === md5.weekday && md5Of('public.stock_usage_rates(uuid,integer)') === md5.rates, 'the live stock_usage_by_weekday and stock_usage_rates are left exactly as they are (md5)');
ok(md5.leg18c === '541ac92297e3784706a2f7a958d5c396' && md5.core18a === 'e9865d7cad62f582db4e904bf41ad512', 'the base is the live text: 20261018c leg 541ac922..., 20261018a core e9865d7c... (read on Ops 19 Oct)');
ok(rbText.includes(`'${md5.core18a}'`) && rbText.includes(`'${md5.leg18c}'`) && rbText.includes(`'${md5.counted18c}'`), 'the rollback check names the 20261018a and 20261018c md5s it puts back');
ok(md5.psm18c === md5Of(SIG.psm) && md5Of(SIG.sweep) === md5.sweep18c && md5Of(SIG.sw) === md5.sw18c && md5Of(SIG.modeOf) === md5.modeOf18c && md5Of(SIG.enq) === md5.enq18c,
  'the central door, the sweep, the switch, the mode lookup and the enqueue trigger are 20261018c\'s text after 20261019b (md5)');

// -- 2. BEFORE: what is wrong today (on 20261018a) ---------------------------------------------------
console.log('\n2. BEFORE 20261019b (20261018a only): the faults are there');
baseDb('p0_before');
{
  // a refund of a sale that never took stock off returns stock all the same
  const r = callJ('tillA1', post(A1, I.cups, 3, 'RETURN', { key: `return:chk-never:ref-1:${I.cups}`, src: 'closed_check_refund', srcId: 'chk-never' }));
  ok(r.status === 0 && onHand(I.cups) === 3, `before: a refund of a sale that never took stock off puts 3 cups on the shelf (${onHand(I.cups)})`);
  // the receiver's cost is dragged by stock below zero, and stock short on a transfer vanishes
  const TB = id('70000000', 'b1');
  sql(`update inventory_items set on_hand = -8, current_cost = 1 where id = '${I.cups2}';
       update inventory_items set current_cost = 2 where id = '${I.cups}';
       insert into stock_transfers (id, location_id, to_location_id, status, reference) values ('${TB}', '${A1}', '${A2}', 'DRAFT', 'TB1');
       insert into stock_transfer_lines (transfer_id, location_id, to_location_id, inventory_item_id, base_unit, qty_base, name_snapshot, sku_snapshot) values
         ('${TB}', '${A1}', '${A2}', '${I.cups}', 'each', 10, 'Cups', 'CUP'),
         ('${TB}', '${A1}', '${A2}', '${I.milk}', 'ml', 6000, 'Milk', 'MILK');`);
  callJ('boA1', `select public.post_stock_transfer_leg('${TB}', 'out', 'T')`);
  sql(`update stock_transfer_lines set to_inventory_item_id = '${I.cups2}', qty_received_base = 10 where transfer_id = '${TB}' and inventory_item_id = '${I.cups}';
       update stock_transfer_lines set to_inventory_item_id = '${I.milk2}', qty_received_base = 4000 where transfer_id = '${TB}' and inventory_item_id = '${I.milk}';`);
  const milkSent = onHand(I.milk);
  callJ('ownerA', `select public.post_stock_transfer_leg('${TB}', 'in', 'T')`);
  ok(near(cost(I.cups2), 6), `before: on hand -8 at 1.00 plus 10 at 2.00 makes the receiver's cost 6.00 (${cost(I.cups2)})`);
  const shortWaste = num(`select count(*) from stock_movements where location_id = '${A1}' and movement_type = 'WASTE'`);
  ok(onHand(I.milk) === milkSent && shortWaste === 0, 'before: 2,000 of 6,000 ml sent never arrived and nothing books them anywhere');
  ok(near(onHand(I.milk2), 4000), 'before: and 4,000 "l" landed: no unit conversion (ml sent into a litre item)');
  // a delete wipes the ledger
  sql(`insert into stock_movements (location_id, inventory_item_id, qty_base, movement_type) values ('${A1}', '${I.free}', 1, 'MANUAL_ADJ');
       delete from inventory_items where id = '${I.free}';`);
  ok(num(`select count(*) from stock_movements where inventory_item_id = '${I.free}'`) === 0, 'before: deleting an item deletes its whole ledger');
  // a pack used by a recipe can be deleted
  sql(`insert into recipes (id, location_id, name) values ('${id('80000000', 'b1')}', '${A1}', 'Latte');
       insert into recipe_lines (location_id, recipe_id, component_item_id, qty, unit) values ('${A1}', '${id('80000000', 'b1')}', '${I.milk}', 1, '@${PACK.milkCase}');`);
  const del = asCaller('boA1', `delete from item_packaging_formats where id = '${PACK.milkCase}'`);
  ok(del.status === 0 && num(`select count(*) from item_packaging_formats where id = '${PACK.milkCase}'`) === 0, 'before: a pack a recipe uses can be deleted (the recipe line then silently takes nothing off)');
  // a transfer head to another company passes the table rule
  const ins = asCaller('boA1', `insert into stock_transfers (location_id, to_location_id, status) values ('${A1}', '${B1}', 'DRAFT')`);
  ok(ins.status === 0, 'before: the table rule lets a transfer name a venue of another company');
}

// -- 3. the migration --------------------------------------------------------------------------------
console.log('\n3. 20261019b, as the SQL editor runs it');
baseDb('p0_main');
const applied = psql({ args: ['-1', '-f', MIGRATION] });
const checkRow = applied.stdout.trim().split('\n').pop().split('|');
ok(applied.status === 0, 'the file applies in one transaction');
const [fnCount, coreLocked, coreOpen, trig, cols, cost8, oh16, idx, settings, trIns, oldUsage] = checkRow.map((x) => x);
ok(fnCount === '11' && coreLocked === '1' && coreOpen === '0' && trig === '4' && cols === '12', `visible check: functions ${fnCount}, core ${coreLocked}, internals open to the API ${coreOpen}, triggers ${trig}, columns ${cols}`);
ok(cost8 === '1' && oh16 === '1' && idx === '10' && settings === '0' && trIns === '2' && oldUsage === '2', `visible check: cost 8dp ${cost8}, on hand 16,4 ${oh16}, indexes ${idx}, settings rows ${settings}, transfer insert rule ${trIns}, old usage reads kept ${oldUsage}`);
ok(checkRow.length === 12 && /"on_hand"/.test(checkRow[11] || ''), `visible check: 12 columns, the per venue stock sums last (${checkRow.slice(0, 11).join('|')}|...)`);
ok(sql(`select count(*) from stock_depletion_mode`) === '0', '20261019b writes no central stock mode row');
ok(sql(`select current_setting('role')`) === 'none', 'the session role is left as it was');

// -- 4. the doors are as 20261018a left them ---------------------------------------------------------
console.log('\n4. The caller rule is unchanged (20261018a)');
{
  const cases = [
    ['tillA1', post(A1, I.cups, -1, 'SALE_DEPLETION', { key: `sale:chk-d1:${I.cups}`, srcId: 'chk-d1' }), 'ok'],
    ['kioskA1', post(A1, I.cups, -1, 'SALE_DEPLETION', { key: `sale:chk-d2:${I.cups}` }), 'ok'],
    ['boA1', post(A1, I.cups, -1, 'WASTE', { key: 'w-d3' }), 'ok'],
    ['service', post(B1, I.b1, -1, 'SALE_DEPLETION', { key: `sale:chk-d4:${I.b1}` }), 'ok'],
    ['stranger', post(A1, I.cups, -1, 'SALE_DEPLETION', { key: 'x1' }), '42501'],
    ['anonKey', post(A1, I.cups, -1, 'SALE_DEPLETION', { key: 'x2' }), '42501'],
    ['tillA1', post(B1, I.b1, -1, 'SALE_DEPLETION', { key: 'x3' }), '42501'],
    ['boA1', post(A1, I.b1, -1, 'SALE_DEPLETION', { key: 'x4' }), '22023'],
    ['boA1', post(A1, I.cups, -1, 'SALE_DEPLETION', { key: 'x5', area: AR.b1 }), '22023'],
  ];
  for (const [who, call, want] of cases) {
    const r = asCaller(who, call);
    const got = r.sqlstate || (r.status === 0 ? 'ok' : `fail:${r.message}`);
    ok(got === want, `${CALLERS[who].what}: ${want === 'ok' ? 'posts' : 'refused'} (${got})`);
  }
  const r = asCaller('authenticated' in CALLERS ? 'boA1' : 'boA1', `select public._post_stock_movement('${A1}', '${I.cups}', 1, 'MANUAL_ADJ')`);
  ok(r.sqlstate === '42501', `the posting core still cannot be run through the API (${r.sqlstate})`);
  ok(onHand(I.cups) === ledger(I.cups), 'on hand still equals the ledger');
}

// -- 5. precision and the item lock --------------------------------------------------------------------
console.log('\n5. Precision');
{
  sql(`update inventory_items set current_cost = 0.00114286 where id = '${I.milk}'`);
  ok(cost(I.milk) === 0.00114286, `a unit cost keeps 8 decimals (${cost(I.milk)})`);
  const r = callJ('boA1', post(A1, I.milk, 100.123456, 'MANUAL_ADJ', { key: 'prec-1' }));
  ok(r.j && near(r.j.on_hand, 100.1235, 1e-9) && near(areaHold(I.milk, AR.bar), 100.1235, 1e-9), `the quantity is rounded once, to 4 places, on items and areas alike (${r.j?.on_hand}, ${areaHold(I.milk, AR.bar)})`);
  ok(num(`select qty_base from stock_movements where idempotency_key = 'prec-1'`) === 100.1235, 'the ledger row holds the same rounded quantity');
  ok(sql(`select format_type(atttypid, atttypmod) from pg_attribute where attrelid = 'public.inventory_item_area_stock'::regclass and attname = 'on_hand'`)
     === sql(`select format_type(atttypid, atttypmod) from pg_attribute where attrelid = 'public.inventory_items'::regclass and attname = 'on_hand'`), 'on hand has one scale on items and on areas');
}

// -- 6. return cap -----------------------------------------------------------------------------------
console.log('\n6. Return cap');
{
  const c0 = onHand(I.cups);
  callJ('tillA1', post(A1, I.cups, -2, 'SALE_DEPLETION', { key: `sale:chk-rc:${I.cups}`, srcId: 'chk-rc', cost: 0.07 }));
  let r = callJ('tillA1', post(A1, I.cups, 3, 'RETURN', { key: `return:chk-rc:ref-1:${I.cups}`, src: 'closed_check_refund', srcId: 'chk-rc' }));
  ok(r.j?.capped === true && near(r.j?.qty, 2) && near(onHand(I.cups), c0), `a refund of 3 returns only the 2 the sale took (${r.j?.qty})`);
  ok(near(num(`select unit_cost from stock_movements where idempotency_key = 'return:chk-rc:ref-1:${I.cups}'`), 0.07), 'valued at the sale\'s own unit cost');
  r = callJ('tillA1', post(A1, I.cups, 1, 'RETURN', { key: `return:chk-rc:ref-2:${I.cups}`, src: 'closed_check_refund', srcId: 'chk-rc' }));
  ok(r.j?.capped === true && r.j?.qty === 0 && r.j?.id === null && near(onHand(I.cups), c0), 'a second refund of the same check returns nothing more');
  r = callJ('service', post(A1, I.cups, 1, 'RETURN', { key: `return:chk-rc:${I.cups}`, src: 'online_refund', srcId: 'chk-rc' }));
  ok(r.j?.capped === true && r.j?.qty === 0, 'the server key shape (return:<check>:<item>) is capped by the same sale');
  r = callJ('tillA1', post(A1, I.cups, 2, 'RETURN', { key: `return:chk-kiosk-never:ref-1:${I.cups}`, src: 'closed_check_refund' }));
  ok(r.j?.capped === true && r.j?.qty === 0 && near(onHand(I.cups), c0), 'a refund of a sale that never took stock off (a kiosk sale before Phase 0) returns nothing');
  callJ('tillA1', post(A1, I.cups, -4, 'SALE_DEPLETION', { key: `sale:chk-rp:${I.cups}`, srcId: 'chk-rp' }));
  r = callJ('tillA1', post(A1, I.cups, 1, 'RETURN', { key: `return:chk-rp:ref-1:${I.cups}` }));
  const r2 = callJ('tillA1', post(A1, I.cups, 1, 'RETURN', { key: `return:chk-rp:ref-2:${I.cups}` }));
  ok(!r.j?.capped && !r2.j?.capped && near(onHand(I.cups), c0 - 2), 'two part refunds within the sale both come back (a second part refund is never lost)');
  const r3 = callJ('tillA1', post(A1, I.cups, 1, 'RETURN', { key: `return:chk-rp:ref-1:${I.cups}` }));
  ok(r3.j?.duplicate === true && near(onHand(I.cups), c0 - 2), 'a repeat of a refund is a duplicate');
  const other = callJ('boA1', post(A1, I.cups, 2, 'RETURN', { key: 'manual-return-1' }));
  ok(!other.j?.capped && near(onHand(I.cups), c0), 'a RETURN that is not a check refund is not capped');
  ok(onHand(I.cups) === ledger(I.cups), 'on hand equals the ledger');
}

// -- 7. counting while trading, opening count, late sale ----------------------------------------------
console.log('\n7. Counts: counting while trading, opening stock, late sales');
const newCount = (loc, lines, name = 'Count') => {
  const cid = randomUUID();
  sql(`insert into stock_counts (id, location_id, name, count_type, status) values ('${cid}', '${loc}', ${lit(name)}, 'FULL', 'DRAFT');` +
    lines.map((l, i) => `insert into stock_count_lines (id, location_id, count_id, inventory_item_id, area_id, expected_qty, sort_order) values ('${l.id || randomUUID()}', '${loc}', '${cid}', '${l.item}', ${l.area ? `'${l.area}'` : 'null'}, 0, ${i});`).join('\n'));
  return cid;
};
const setCounted = (cid, item, qty, who = 'boA1', area = null) => asCaller(who, `update stock_count_lines set counted_qty = ${qty} where count_id = '${cid}' and inventory_item_id = '${item}'${area ? ` and area_id = '${area}'` : ''}`);
const approve = (who, cid, extra = '') => callJ(who, `select public.approve_stock_count('${cid}', 'Manager', null${extra})`);
{
  // Opening count: syrup has never been counted and has no cost.
  sql(`select public._post_stock_movement('${A1}', '${I.syrup}', 500, 'PURCHASE_RECEIPT', 0, 'purchase_order', 'po-x', 'po:x:1')`);
  const c1 = newCount(A1, [{ item: I.syrup }, { item: I.beans, area: AR.cellar }]);
  setCounted(c1, I.syrup, 700); setCounted(c1, I.beans, 4, 'boA1', AR.cellar);
  ok(num(`select count(*) from stock_count_lines where count_id = '${c1}' and counted_at is not null`) === 2, 'each counted line records when it was counted (database clock)');
  let r = approve('boA1', c1);
  ok(r.j?.ok === false && r.j?.code === 'needs_cost' && JSON.stringify(r.j?.needs_cost).includes(I.syrup), 'an opening line with no cost stops the approval and names the item');
  ok(num(`select count(*) from stock_movements where source_id = '${c1}'`) === 0 && sql(`select status from stock_counts where id = '${c1}'`) === 'DRAFT', 'nothing was written');
  const pv = approve('boA1', c1, `, '{"${I.syrup}": 0.002}'::jsonb, true`);
  ok(pv.j?.preview === true && pv.j?.opening === 2 && near(pv.j?.opening_value, 200 * 0.002 + 4 * 18), `the preview shows 2 opening lines and their value (${pv.j?.opening_value}) and writes nothing`);
  r = approve('boA1', c1, `, '{"${I.syrup}": 0.002}'::jsonb`);
  ok(r.j?.ok === true && r.j?.opening === 2, 'with a cost given, the opening count approves');
  ok(num(`select count(*) from stock_movements where source_id = '${c1}' and movement_type = 'OPENING_BALANCE'`) === 2
     && num(`select count(*) from stock_movements where source_id = '${c1}' and movement_type = 'STOCK_COUNT_ADJ'`) === 0, 'a first count posts OPENING_BALANCE, never a count gain');
  ok(near(cost(I.syrup), 0.002) && near(num(`select unit_cost from stock_movements where source_id = '${c1}' and inventory_item_id = '${I.syrup}'`), 0.002), 'valued at the given cost, never 0, and the item takes that cost');
  ok(near(cost(I.beans), 18), 'an item that had a cost keeps it');
  ok(num(`select variance_value from stock_counts where id = '${c1}'`) === 0 && near(num(`select opening_value from stock_counts where id = '${c1}'`), 200 * 0.002 + 4 * 18, 0.01), 'opening stock is out of the variance and held apart as opening value');
  ok(num(`select count(*) from stock_count_lines where count_id = '${c1}' and is_opening`) === 2, 'the lines say they were opening stock');
  r = asCaller('boA1', `update stock_count_lines set counted_qty = 1 where count_id = '${c1}'`);
  ok(r.sqlstate === '55000', `an approved count's figures cannot change (${r.sqlstate})`);
  r = approve('boA1', c1);
  ok(r.j?.duplicate === true, 'approving twice is a harmless repeat');

  // Counting while trading.
  const s0 = onHand(I.syrup);   // 700
  callJ('tillA1', post(A1, I.syrup, -10, 'SALE_DEPLETION', { key: `sale:chk-t1:${I.syrup}` }));   // before the count
  const c2 = newCount(A1, [{ item: I.syrup }]);
  setCounted(c2, I.syrup, 650);                                                                     // counted now: shelf 650
  callJ('tillA1', post(A1, I.syrup, -20, 'SALE_DEPLETION', { key: `sale:chk-t2:${I.syrup}` }));   // during the count
  r = approve('boA1', c2);
  ok(r.j?.ok === true && r.j?.opening === 0, 'a second count is not opening stock');
  ok(near(onHand(I.syrup), 650 - 20), `the sale made during the count is NOT added back: on hand ${onHand(I.syrup)} = counted 650 less the 20 sold after (old rule: 650)`);
  ok(near(num(`select expected_qty from stock_count_lines where count_id = '${c2}'`), s0 - 10) && near(num(`select variance_qty from stock_count_lines where count_id = '${c2}'`), 650 - (s0 - 10)),
    'expected and variance are worked out from the moment the line was counted');
  ok(num(`select count(*) from stock_movements where source_id = '${c2}' and occurred_at = (select counted_at from stock_count_lines where count_id = '${c2}')`) === 1, 'the adjustment is dated at the moment the line was counted');

  // Late sale: an offline till sends a sale made BEFORE the count, after approval.
  const before = onHand(I.syrup);
  // the till cannot read count lines (row level security), so the time it sends is a plain value
  const c2At = sql(`select (counted_at - interval '3 minutes')::text from stock_count_lines where count_id = '${c2}'`);
  r = callJ('tillA1', post(A1, I.syrup, -5, 'SALE_DEPLETION', { key: `sale:chk-late:${I.syrup}`, at: lit(c2At) }));
  ok(r.j?.late_adjustment_id && near(onHand(I.syrup), before), `a late sale from before the count is matched by "Late sale before count": on hand stays ${onHand(I.syrup)}`);
  ok(near(num(`select coalesce(sum(qty_base), 0) from stock_movements where inventory_item_id = '${I.syrup}' and occurred_at <= (select counted_at from stock_count_lines where count_id = '${c2}')`), 650), 'the ledger at the count still adds up to what was counted');
  ok(num(`select count(*) from stock_movements where inventory_item_id = '${I.syrup}' and movement_type = 'SALE_DEPLETION' and idempotency_key = 'sale:chk-late:${I.syrup}'`) === 1, 'the sale still shows in usage');
  r = callJ('tillA1', post(A1, I.syrup, -5, 'SALE_DEPLETION', { key: `sale:chk-late:${I.syrup}`, at: `now() - interval '1 day'` }));
  ok(r.j?.duplicate === true && near(onHand(I.syrup), before), 'a repeat of the late sale changes nothing');
  r = callJ('tillA1', post(A1, I.syrup, -3, 'SALE_DEPLETION', { key: `sale:chk-after:${I.syrup}` }));
  ok(!r.j?.late_adjustment_id && near(onHand(I.syrup), before - 3), 'a sale after the count comes off as normal');

  // An area line: a late sale in another area is not matched against this area's count.
  const c3 = newCount(A1, [{ item: I.beans, area: AR.cellar }]);
  setCounted(c3, I.beans, 5, 'boA1', AR.cellar);
  approve('boA1', c3);
  const bb = onHand(I.beans);
  r = callJ('tillA1', post(A1, I.beans, -1, 'SALE_DEPLETION', { key: `sale:chk-late2:${I.beans}`, area: AR.bar, at: `now() - interval '1 hour'` }));
  ok(!r.j?.late_adjustment_id && near(onHand(I.beans), bb - 1), 'a late sale in an area the count did not cover is not matched');

  // Who may approve.
  const c4 = newCount(A1, [{ item: I.cups }]);
  setCounted(c4, I.cups, 10);
  for (const [who, want] of [['tillA1', '42501'], ['stranger', '42501'], ['boB1', '42501'], ['anonKey', '42501']]) {
    const rr = asCaller(who, `select public.approve_stock_count('${c4}')`);
    ok(rr.sqlstate === want, `${CALLERS[who].what} cannot approve a count (${rr.sqlstate})`);
  }
  r = approve('ownerA', c4);
  ok(r.j?.ok === true, 'the owner (no link row) approves a count of their company');
  ok(onHand(I.cups) === ledger(I.cups) && onHand(I.syrup) === ledger(I.syrup) && onHand(I.beans) === ledger(I.beans), 'on hand equals the ledger for every item touched');
  ok(near(areaHold(I.beans, AR.cellar), areaLedger(I.beans, AR.cellar)) && near(areaHold(I.beans, AR.bar), areaLedger(I.beans, AR.bar)), 'area holdings equal their movements');
}

// -- 7b. overlapping counts, counted_at and approved counts locked ---------------------------------
console.log('\n7b. An older count approved after a newer one; counted_at and an approved count are locked');
{
  const atSet = (cid, ago) => sql(`update stock_count_lines set counted_at = now() - interval '${ago}' where count_id = '${cid}'`);
  // An older sheet (90 counted 60 minutes ago) approved AFTER a newer one (80, 30 minutes ago).
  const e1 = freshItem('E1 water');
  sql(`select public._post_stock_movement('${A1}', '${e1}', 100, 'PURCHASE_RECEIPT', 1, 'purchase_order', 'po-e1', 'po:e1:${e1}', now() - interval '2 hours')`);
  const cOld = newCount(A1, [{ item: e1 }]); const cNew = newCount(A1, [{ item: e1 }]);
  setCounted(cOld, e1, 90); atSet(cOld, '60 minutes');
  callJ('tillA1', post(A1, e1, -5, 'SALE_DEPLETION', { key: `sale:e1a:${e1}`, srcId: 'e1a', at: `now() - interval '45 minutes'` }));
  setCounted(cNew, e1, 80); atSet(cNew, '30 minutes');
  let r = approve('boA1', cNew);
  ok(r.j?.ok === true && near(onHand(e1), 80), `the newer count (80) approves: on hand ${onHand(e1)}`);
  const pv = approve('boA1', cOld, ', null, true');
  ok(pv.j?.superseded === 1 && pv.j?.lines?.[0]?.superseded === true && pv.j?.lines?.[0]?.delta === 0, `the preview of the older sheet says its line is superseded, delta 0 (${JSON.stringify(pv.j?.lines?.[0] || null)})`);
  r = approve('boA1', cOld);
  const tNew = `(select counted_at from stock_count_lines where count_id = '${cNew}')`;
  ok(r.j?.ok === true && r.j?.superseded === 1 && r.j?.posted === 0 && near(onHand(e1), 80), `the older count approved after it posts nothing: on hand stays 80 (${onHand(e1)}; was 70 before this fix)`);
  ok(near(num(`select coalesce(sum(qty_base), 0) from stock_movements where inventory_item_id = '${e1}' and occurred_at <= ${tNew}`), 80), 'the ledger at the newer count\'s moment is 80 (I6 for the newest count)');
  ok(num(`select variance_qty from stock_count_lines where count_id = '${cOld}'`) === 0, 'the superseded line stores variance 0, matching the ledger');
  // the control: oldest first still lands on the newest figure
  const e1b = freshItem('E1 control');
  sql(`select public._post_stock_movement('${A1}', '${e1b}', 100, 'PURCHASE_RECEIPT', 1, 'purchase_order', 'po-e1b', 'po:e1b:${e1b}', now() - interval '2 hours')`);
  const dOld = newCount(A1, [{ item: e1b }]); const dNew = newCount(A1, [{ item: e1b }]);
  setCounted(dOld, e1b, 90); atSet(dOld, '60 minutes');
  callJ('tillA1', post(A1, e1b, -5, 'SALE_DEPLETION', { key: `sale:e1b:${e1b}`, srcId: 'e1b', at: `now() - interval '45 minutes'` }));
  setCounted(dNew, e1b, 80); atSet(dNew, '30 minutes');
  approve('boA1', dOld); approve('boA1', dNew);
  ok(near(onHand(e1b), 80) && onHand(e1b) === ledger(e1b), `oldest first: on hand 80 as before (${onHand(e1b)})`);

  // counted_at belongs to the database
  const e2 = freshItem('E2 lemons', { cost: 0.3 });
  sql(`select public._post_stock_movement('${A1}', '${e2}', 50, 'PURCHASE_RECEIPT', 0.3, 'purchase_order', 'po-e2', 'po:e2:${e2}', now() - interval '1 hour')`);
  const cd = newCount(A1, [{ item: e2 }]);
  setCounted(cd, e2, 40);
  const t0 = sql(`select counted_at::text from stock_count_lines where count_id = '${cd}'`);
  r = asCaller('boA1', `update stock_count_lines set counted_at = now() + interval '7 days' where count_id = '${cd}'`);
  ok(r.status === 0 && sql(`select counted_at::text from stock_count_lines where count_id = '${cd}'`) === t0, 'a Back Office login cannot move counted_at on a draft line: the database keeps its own time');
  r = asCaller('boA1', `insert into stock_count_lines (location_id, count_id, inventory_item_id, counted_qty, counted_at) values ('${A1}', '${cd}', '${e2}', 5, now() + interval '7 days')`);
  ok(r.status === 0 && num(`select count(*) from stock_count_lines where count_id = '${cd}' and counted_at > now() + interval '1 minute'`) === 0, 'a line inserted with a future counted_at is stamped with the database clock instead');
  r = asCaller('boA1', `update stock_count_lines set counted_qty = 41 where count_id = '${cd}' and counted_qty = 40`);
  ok(sql(`select counted_at::text > '${t0}' from stock_count_lines where count_id = '${cd}' and counted_qty = 41`) === 't', 'changing the figure stamps a new time');
  sql(`delete from stock_count_lines where count_id = '${cd}' and counted_qty = 5`);
  atSet(cd, '10 minutes');
  r = approve('boA1', cd);
  ok(r.j?.ok === true, 'the sheet approves');
  r = asCaller('boA1', `update stock_count_lines set counted_at = now() + interval '7 days' where count_id = '${cd}'`);
  ok(r.sqlstate === '55000', `an approved line cannot be changed, counted_at included (${r.sqlstate})`);
  r = asCaller('boA1', `insert into stock_count_lines (location_id, count_id, inventory_item_id, counted_qty, expected_qty) values ('${A1}', '${cd}', '${e2}', 999, 0)`);
  ok(r.sqlstate === '55000', `a line cannot be added to an approved count (${r.sqlstate})`);
  r = asCaller('boA1', `delete from stock_count_lines where count_id = '${cd}'`);
  ok(r.sqlstate === '55000', `a line of an approved count cannot be removed (${r.sqlstate})`);
  const bx = onHand(e2);
  callJ('tillA1', post(A1, e2, -3, 'SALE_DEPLETION', { key: `sale:e2:${e2}`, srcId: 'e2', at: `now() - interval '1 minute'` }));
  ok(near(onHand(e2), bx - 3), `a till sale made after the count still comes off (${bx} to ${onHand(e2)})`);

  // an approved count cannot be reopened, re figured or deleted through the API
  r = asCaller('boA1', `update stock_counts set status = 'DRAFT' where id = '${cd}'`);
  ok(r.sqlstate === '55000' && sql(`select status from stock_counts where id = '${cd}'`) === 'APPROVED', `a Back Office login cannot set an approved count back to DRAFT (${r.sqlstate})`);
  r = asCaller('ownerA', `update stock_counts set variance_value = 0, opening_value = 0 where id = '${cd}'`);
  ok(r.sqlstate === '55000', `nor change its stored figures, the owner included (${r.sqlstate})`);
  r = asCaller('boA1', `delete from stock_counts where id = '${cd}'`);
  ok(r.sqlstate === '55000' && num(`select count(*) from stock_counts where id = '${cd}'`) === 1, `nor delete it (${r.sqlstate})`);
  r = asCaller('boA1', `update stock_counts set name = 'Monday count' where id = '${cd}'`);
  ok(r.status === 0 && sql(`select name from stock_counts where id = '${cd}'`) === 'Monday count', 'its name can still change');
  r = asCaller('service', `update stock_counts set status = 'DRAFT' where id = '${cd}'`, { commit: false });
  ok(r.status === 0, 'the service role may (an edge function; rolled back here)');
  const draft = newCount(A1, [{ item: e2 }]);
  r = asCaller('boA1', `delete from stock_counts where id = '${draft}'`);
  ok(r.status === 0, 'a draft count can still be deleted');

  // the caller is checked before anything is locked or said
  const cb = newCount(B1, [{ item: I.b1 }]);
  const r1 = asCaller('stranger', `select public.approve_stock_count('${cb}')`);
  const r2 = asCaller('stranger', `select public.approve_stock_count('${randomUUID()}')`);
  ok(r1.sqlstate === '42501' && r2.sqlstate === '42501' && r1.message === r2.message, `a stranger gets the same answer for another venue's count and for a made up id (${r1.sqlstate} ${r2.sqlstate})`);
  const holder = session('sqlEditor');
  const hm = holder.run(`select 1 from stock_counts where id = '${cb}' for update`);
  await holder.wait(hm);
  const tq = Date.now();
  const r3 = await oneShot('stranger', `select public.approve_stock_count('${cb}')`);
  ok(r3.sqlstate === '42501' && Date.now() - tq < 3000, `while another session holds that count, the stranger is refused at once, without waiting on its lock (${Date.now() - tq} ms)`);
  await holder.end('rollback');
}

// -- 8. receiving ------------------------------------------------------------------------------------
console.log('\n8. Receiving in one database step');
const recv = (who, loc, srcType, srcId, lines, area = null) => callJ(who, `select public.stock_receive('${loc}', '${srcType}', ${lit(srcId)}, ${jlit(lines)}, ${area ? `'${area}'` : 'null'})`);
{
  // below zero takes the delivery price
  sql(`update inventory_items set on_hand = 0, current_cost = 1 where id = '${I.packed}'`);
  callJ('tillA1', post(A1, I.packed, -8, 'SALE_DEPLETION', { key: `sale:chk-bz:${I.packed}` }));
  let r = recv('boA1', A1, 'purchase_order', 'po-bz', [{ key: 'po:bz:1', item_id: I.packed, qty_base: 10, unit_cost: 2, supplier_product_id: null, pack_price: 24, pack_label: 'Case 12' }]);
  ok(r.j?.ok === true && near(cost(I.packed), 2), `stock below zero (-8 at 1.00) plus 10 at 2.00 costs 2.00, not 6.00 (${cost(I.packed)})`);
  // moving average from a positive holding
  r = recv('boA1', A1, 'purchase_order', 'po-ma', [{ key: 'po:ma:1', item_id: I.packed, qty_base: 2, unit_cost: 5 }]);
  ok(near(cost(I.packed), (2 * 2 + 2 * 5) / 4), `the moving average from a positive holding (${cost(I.packed)})`);
  // unknown cost takes the price; two lines of one item average in order
  sql(`update inventory_items set current_cost = null, on_hand = 0 where id = '${I.free}'`);
  r = recv('opsA2', A2, 'purchase_order', 'po-x', [{ key: 'po:x:9', item_id: I.milk2, qty_base: 1, unit_cost: 1 }]);
  ok(r.j?.ok === true, 'the ops tablet receives at its own venue');
  r = recv('boA1', A1, 'purchase_order', 'po-unk', [
    { key: 'po:unk:1', item_id: I.free, qty_base: 5, unit_cost: 3 },
    { key: 'po:unk:2', item_id: I.free, qty_base: 5, unit_cost: 5 }]);
  ok(near(cost(I.free), 4) && near(onHand(I.free), 10), `an unknown cost takes the price, then the second line averages (${cost(I.free)})`);
  // unpriced line moves stock at the known cost and leaves the cost alone
  r = recv('boA1', A1, 'purchase_order', 'po-np', [{ key: 'po:np:1', item_id: I.free, qty_base: 10, unit_cost: 0 }]);
  ok(near(cost(I.free), 4) && near(onHand(I.free), 20) && near(num(`select unit_cost from stock_movements where idempotency_key = 'po:np:1'`), 4), 'an unpriced line moves the stock in at the known cost and leaves the cost alone');
  // LAST_COST
  r = recv('boA1', A1, 'purchase_order', 'po-lc', [{ key: 'po:lc:1', item_id: I.lastc, qty_base: 10, unit_cost: 0.5 }]);
  ok(near(cost(I.lastc), 0.5), 'LAST_COST takes the price');
  // duplicate key: no stock, no re cost
  const oh = onHand(I.free);
  r = recv('boA1', A1, 'purchase_order', 'po-unk', [{ key: 'po:unk:1', item_id: I.free, qty_base: 5, unit_cost: 99 }]);
  ok(r.j?.duplicates === 1 && near(onHand(I.free), oh) && near(cost(I.free), 4), 'a repeated receipt posts nothing and costs nothing');
  // cost history keeps the pack
  r = recv('boA1', A1, 'purchase_order', 'po-pk', [{ key: 'po:pk:1', item_id: I.milk, qty_base: 6000, unit_cost: 0.0011, supplier_product_id: SP.milk, pack_price: 6.6, pack_label: 'Case 6 x 1 l' }]);
  const h = sql(`select supplier_product_id || '|' || pack_price || '|' || pack_label || '|' || source from item_cost_history where inventory_item_id = '${I.milk}' and effective_to is null`);
  ok(h === `${SP.milk}|6.6000|Case 6 x 1 l|PO_RECEIPT`, `cost history keeps the supplier pack and the pack price (${h})`);
  // fences
  for (const [who, loc, want] of [['stranger', A1, '42501'], ['tillB1', A1, '42501'], ['boA1', B1, '42501']]) {
    const rr = asCaller(who, `select public.stock_receive('${loc}', 'purchase_order', 'po-f', ${jlit([{ key: 'po:f:1', item_id: I.packed, qty_base: 1, unit_cost: 1 }])})`);
    ok(rr.sqlstate === want, `${CALLERS[who].what} cannot receive at ${loc === A1 ? 'A1' : 'B1'} (${rr.sqlstate})`);
  }
  const rr = asCaller('boA1', `select public.stock_receive('${A1}', 'purchase_order', 'po-f', ${jlit([{ key: 'po:f:2', item_id: I.b1, qty_base: 1, unit_cost: 1 }])})`);
  ok(rr.sqlstate === '22023', `another venue's item is refused before anything posts (${rr.sqlstate})`);
  // A receive sets the item's cost: Back Office work or the venue's Ops tablet, never a till or kiosk.
  const lc0 = cost(I.lastc), hist0 = num(`select count(*) from item_cost_history where inventory_item_id = '${I.lastc}'`), oh0 = onHand(I.lastc);
  for (const [who, loc, want] of [['tillA1', A1, '42501'], ['kioskA1', A1, '42501'], ['opsA2', A1, '42501']]) {
    const x = asCaller(who, `select public.stock_receive('${loc}', 'purchase_order', 'po-dev', ${jlit([{ key: `po:dev:${who}`, item_id: I.lastc, qty_base: 1000, unit_cost: 0.0001 }])})`);
    ok(x.sqlstate === want, `${CALLERS[who].what} cannot receive at A1, so it cannot set a cost (${x.sqlstate})`);
  }
  ok(cost(I.lastc) === lc0 && onHand(I.lastc) === oh0 && num(`select count(*) from item_cost_history where inventory_item_id = '${I.lastc}'`) === hist0, 'the item\'s cost, stock and cost history are untouched');
  r = recv('service', A1, 'purchase_order', 'po-svc', [{ key: 'po:svc:1', item_id: I.lastc, qty_base: 1, unit_cost: 0.5 }]);
  ok(r.j?.ok === true, 'the Manager app (service role) receives');
  r = recv('ownerA', A1, 'purchase_order', 'po-own', [{ key: 'po:own:1', item_id: I.lastc, qty_base: 1, unit_cost: 0.5 }]);
  ok(r.j?.ok === true, 'the owner (no link row) receives');
  ok([I.packed, I.free, I.lastc, I.milk].every((it) => onHand(it) === ledger(it)), 'on hand equals the ledger');
}

// -- 9. invoices -------------------------------------------------------------------------------------
console.log('\n9. Invoices in one step');
const postInv = (who, inv, lines, receipts) => callJ(who, `select public.stock_post_invoice('${A1}', ${jlit(inv)}, ${jlit(lines)}, ${jlit(receipts)})`);
{
  const oh = onHand(I.beans);
  let r = postInv('boA1', { supplier_id: SUP.a1b, invoice_number: 'INV-100', total: 36 },
    [{ matched_item_id: I.beans, description: 'Beans 1kg', qty: 2, unit: 'kg', unit_price: 18, line_total: 36, supplier_product_id: SP.beans }],
    [{ line_index: 0, item_id: I.beans, qty_base: 2, unit_cost: 18, supplier_product_id: SP.beans, pack_price: 18, pack_label: 'Bag 1 kg' }]);
  ok(r.j?.ok === true && r.j?.stock === true && near(onHand(I.beans), oh + 2), 'an invoice posts its header, lines and stock in one call');
  ok(num(`select count(*) from supplier_invoice_lines where invoice_id = '${r.j?.invoice_id}' and supplier_product_id = '${SP.beans}'`) === 1, 'the invoice line keeps the supplier pack');
  ok(num(`select count(*) from stock_movements where idempotency_key = 'inv:${r.j?.invoice_id}:${I.beans}:0'`) === 1, 'the receipt key is the one the screen always used (inv:<invoice>:<item>:<line>)');
  r = postInv('boA1', { supplier_id: SUP.a1b, invoice_number: ' inv-100 ', total: 36 }, [], [{ line_index: 0, item_id: I.beans, qty_base: 2, unit_cost: 18 }]);
  ok(r.j?.ok === false && r.j?.code === 'duplicate_number' && near(onHand(I.beans), oh + 2), 'the same invoice number from the same supplier is refused, in words, and nothing posts twice');
  r = postInv('boA1', { supplier_id: SUP.a1, invoice_number: 'INV-100', total: 1 }, [], []);
  ok(r.j?.ok === true, 'the same number from another supplier is a different invoice');
  // an order received already: the invoice is paperwork
  const po = randomUUID();
  sql(`insert into purchase_orders (id, location_id, supplier_id, status) values ('${po}', '${A1}', '${SUP.a1b}', 'RECEIVED')`);
  r = postInv('boA1', { supplier_id: SUP.a1b, invoice_number: 'INV-101', po_id: po }, [{ matched_item_id: I.beans, qty: 2, unit: 'kg', unit_price: 18 }], [{ line_index: 0, item_id: I.beans, qty_base: 2, unit_cost: 18 }]);
  ok(r.j?.ok === true && r.j?.stock === false && near(onHand(I.beans), oh + 2), 'an invoice for an order received already is kept as paperwork: no stock counted twice');
  const po2 = randomUUID();
  sql(`insert into purchase_orders (id, location_id, supplier_id, status) values ('${po2}', '${A1}', '${SUP.a1b}', 'SENT')`);
  r = postInv('boA1', { supplier_id: SUP.a1b, invoice_number: 'INV-102', po_id: po2 }, [], []);
  ok(r.j?.ok === false && r.j?.code === 'po_not_received', 'linking an invoice to an order not yet received is refused in words');
  const inv2 = r.j;
  // stock_receive with a linked invoice whose order was received: refused
  sql(`insert into supplier_invoices (id, location_id, po_id, status) values ('${id('90000000', '1')}', '${A1}', '${po}', 'POSTED')`);
  r = recv('boA1', A1, 'supplier_invoice', id('90000000', '1'), [{ key: 'inv:x:1', item_id: I.beans, qty_base: 1, unit_cost: 1 }]);
  ok(r.j?.ok === false && r.j?.code === 'po_received', 'a receipt for an invoice of a received order is refused (no double count)');
  for (const who of ['tillA1', 'stranger', 'boB1']) {
    const rr = asCaller(who, `select public.stock_post_invoice('${A1}', ${jlit({ invoice_number: 'X-' + who })}, '[]'::jsonb, '[]'::jsonb)`);
    ok(rr.sqlstate === '42501', `${CALLERS[who].what} cannot post an invoice (${rr.sqlstate})`);
  }
  void inv2;
  // A retry of an invoice with no number (the answer was lost): the screen's own id, sent again.
  const cid = randomUUID();
  const ohb = onHand(I.beans);
  const once = () => postInv('boA1', { client_id: cid, supplier_id: SUP.a1b, invoice_number: null, total: 36 },
    [{ matched_item_id: I.beans, qty: 2, unit: 'kg', unit_price: 18 }], [{ line_index: 0, item_id: I.beans, qty_base: 2, unit_cost: 18 }]);
  const a = once(); const b = once();
  ok(a.j?.ok === true && a.j?.invoice_id === cid && b.j?.ok === true && b.j?.duplicate === true && near(onHand(I.beans), ohb + 2),
    `the same invoice with no number sent twice adds 2 kg once (gain ${onHand(I.beans) - ohb}; was 4 before this fix)`);
  ok(num(`select count(*) from supplier_invoices where id = '${cid}'`) === 1 && num(`select count(*) from supplier_invoice_lines where invoice_id = '${cid}'`) === 1, 'one invoice, one line');
  // two retries at the same moment
  const cid2 = randomUUID();
  const ohc = onHand(I.beans);
  const body2 = `select public.stock_post_invoice('${A1}', ${jlit({ client_id: cid2, supplier_id: SUP.a1b, invoice_number: null })}, ${jlit([{ matched_item_id: I.beans, qty: 1, unit: 'kg', unit_price: 18 }])}, ${jlit([{ line_index: 0, item_id: I.beans, qty_base: 1, unit_cost: 18 }])})`;
  const both = await Promise.all([oneShot('boA1', body2), oneShot('boA1', body2)]);
  const answers = both.map((x) => { try { return JSON.parse(x.out.split('\n').filter(Boolean).pop()); } catch { return null; } });
  ok(both.every((x) => x.code === 0) && answers.filter((x) => x?.duplicate === true).length === 1 && near(onHand(I.beans), ohc + 1),
    `two retries at once: one posts, the other is answered duplicate, 1 kg in once (${JSON.stringify(answers.map((x) => x && (x.duplicate ? 'duplicate' : x.ok)))}, gain ${onHand(I.beans) - ohc})`);
  // a client id that is another venue's invoice is refused
  const bInv = randomUUID();
  sql(`insert into supplier_invoices (id, location_id, status) values ('${bInv}', '${B1}', 'POSTED')`);
  const x = postInv('boA1', { client_id: bInv, invoice_number: 'X-1' }, [], []);
  ok(x.sqlstate === '22023', `a client id that names another venue's invoice is refused (${x.sqlstate})`);
}

// -- 10. waste -----------------------------------------------------------------------------------------
console.log('\n10. Waste: never refused, tagged, one call');
const waste = (who, loc, ev, lines) => callJ(who, `select public.stock_record_waste('${loc}', ${jlit(ev)}, ${jlit(lines)})`);
{
  const wid = randomUUID();
  let r = waste('tillA1', A1, { id: wid, kind: 'menu', menu_item_id: 'mi-burger', item_name: 'Burger', qty: 1, unit: 'item', qty_base: 1, reason: 'Dropped', sale_value: 9.5, source: 'pos' }, []);
  ok(r.j?.ok === true && r.j?.no_recipe === true && r.j?.cost_value === null, 'a product with no recipe is recorded, never refused, tagged no recipe, with no made up cost');
  ok(sql(`select menu_item_id || '|' || no_recipe || '|' || sale_value from waste_events where id = '${wid}'`) === 'mi-burger|true|9.50', 'the waste row carries the product id and the lost sale');
  const c0 = onHand(I.cups), m0 = onHand(I.milk);
  const wid2 = randomUUID();
  r = waste('tillA1', A1, { id: wid2, kind: 'menu', menu_item_id: 'mi-latte', item_name: 'Latte', qty: 2, unit: 'item', qty_base: 2, reason: 'Spilled', sale_value: 7, source: 'pos' },
    [{ item_id: I.milk, qty_base: 400 }, { item_id: I.cups, qty_base: 2 }]);
  ok(r.j?.ok === true && r.j?.posted === 2 && r.j?.no_recipe === false && near(onHand(I.cups), c0 - 2) && near(onHand(I.milk), m0 - 400), 'a product with a recipe takes its stock off in the same call');
  ok(near(r.j?.cost_value, Math.round((400 * cost(I.milk) + 2 * cost(I.cups)) * 100) / 100, 0.011), `the cost is worked out at each item's cost (${r.j?.cost_value})`);
  r = waste('tillA1', A1, { id: wid2, kind: 'menu', item_name: 'Latte', qty: 2 }, [{ item_id: I.milk, qty_base: 400 }]);
  ok(r.j?.duplicate === true && near(onHand(I.milk), m0 - 400), 'a retry of the same waste writes nothing twice');
  const wid3 = randomUUID();
  r = waste('boA1', A1, { id: wid3, kind: 'item', inventory_item_id: I.beans, item_name: 'Coffee beans', qty: 1, unit: 'kg', qty_base: 1, reason: 'Spoilage' }, [{ item_id: I.beans, qty_base: 1 }]);
  ok(r.j?.ok === true && num(`select count(*) from stock_movements where idempotency_key = 'waste:${wid3}'`) === 1, 'a stock item waste keeps its old key (waste:<event>)');
  for (const [who, loc, want] of [['stranger', A1, '42501'], ['tillB1', A1, '42501'], ['anonKey', A1, '42501']]) {
    const rr = asCaller(who, `select public.stock_record_waste('${loc}', ${jlit({ kind: 'menu', item_name: 'x' })}, '[]'::jsonb)`);
    ok(rr.sqlstate === want, `${CALLERS[who].what} cannot record waste at A1 (${rr.sqlstate})`);
  }
  const rr = asCaller('tillA1', `select public.stock_record_waste('${A1}', ${jlit({ kind: 'menu', item_name: 'x' })}, ${jlit([{ item_id: I.b1, qty_base: 1 }])})`);
  ok(rr.sqlstate === '22023' && num(`select count(*) from waste_events where item_name = 'x'`) === 0, 'another venue\'s item is refused and no waste row is left behind');
  // A stock item waste sent with no lines takes its own quantity off (it used to record and take nothing).
  for (const [label, linesSql] of [['no lines (SQL null)', 'null'], ['a JSON null', `'null'::jsonb`], ['an empty list', `'[]'::jsonb`]]) {
    const ohc = onHand(I.cups); const wid4 = randomUUID();
    const r4 = callJ('boA1', `select public.stock_record_waste('${A1}', ${jlit({ id: wid4, kind: 'item', inventory_item_id: I.cups, item_name: 'Cups', qty: 2, unit: 'each', qty_base: 2, reason: 'Breakage' })}, ${linesSql})`);
    ok(r4.j?.ok === true && r4.j?.posted === 1 && near(onHand(I.cups), ohc - 2) && near(r4.j?.cost_value, Math.round(2 * cost(I.cups) * 100) / 100, 0.011),
      `an item waste of 2 cups with ${label} takes 2 off and is costed (${ohc} to ${onHand(I.cups)}, cost ${r4.j?.cost_value})`);
  }
  const r5 = asCaller('boA1', `select public.stock_record_waste('${A1}', ${jlit({ kind: 'item', inventory_item_id: I.cups, item_name: 'No qty' })}, null)`);
  ok(r5.sqlstate === '22023' && num(`select count(*) from waste_events where item_name = 'No qty'`) === 0, `an item waste with no lines and no quantity is refused, nothing written (${r5.sqlstate})`);
}

// -- 11. deletes keep ledgers --------------------------------------------------------------------------
console.log('\n11. Deletes keep ledgers');
{
  let r = asCaller('boA1', `delete from inventory_items where id = '${I.cups}'`);
  ok(r.sqlstate === '23503' && /Archive it instead/.test(r.message) && num(`select count(*) from stock_movements where inventory_item_id = '${I.cups}'`) > 0, 'an item with stock history cannot be deleted (archive it): the ledger stays');
  sql(`insert into inventory_items (id, location_id, name, base_unit) values ('${id('40000000', 'dd')}', '${A1}', 'Typo item', 'each')`);
  r = asCaller('boA1', `delete from inventory_items where id = '${id('40000000', 'dd')}'`);
  ok(r.status === 0 && num(`select count(*) from inventory_items where id = '${id('40000000', 'dd')}'`) === 0, 'an item with no history can still be deleted');
  sql(`insert into recipes (id, location_id, name) values ('${id('80000000', '1')}', '${A1}', 'Latte');
       insert into recipe_lines (location_id, recipe_id, component_item_id, qty, unit) values ('${A1}', '${id('80000000', '1')}', '${I.milk}', 1, '@${PACK.milkCase}');`);
  r = asCaller('boA1', `delete from item_packaging_formats where id = '${PACK.milkCase}'`);
  ok(r.sqlstate === '23503' && /used in a recipe/.test(r.message), 'a pack a recipe line uses cannot be deleted');
  r = asCaller('boA1', `delete from item_packaging_formats where id = '${PACK.beansBag}'`);
  ok(r.status === 0, 'an unused pack can be deleted');
}

// -- 12. transfers -------------------------------------------------------------------------------------
console.log('\n12. Transfers: units, Short on transfer, one company');
const leg = (who, t, l) => callJ(who, `select public.post_stock_transfer_leg('${t}', '${l}', 'Tester')`);
const mkTransfer = (from, to, lines, { fromArea = null } = {}) => {
  const t = randomUUID();
  sql(`insert into stock_transfers (id, location_id, to_location_id, from_area_id, status, reference) values ('${t}', '${from}', ${to ? `'${to}'` : 'null'}, ${fromArea ? `'${fromArea}'` : 'null'}, 'DRAFT', 'TR-${t.slice(0, 4)}');` +
    lines.map((l, i) => `insert into stock_transfer_lines (id, transfer_id, location_id, to_location_id, inventory_item_id, base_unit, qty_base, name_snapshot, sku_snapshot, sort_order) values ('${l.id}', '${t}', '${from}', ${to ? `'${to}'` : 'null'}, '${l.item}', ${lit(l.unit)}, ${l.qty}, ${lit(l.name || 'Item')}, ${lit(l.sku || null)}, ${i});`).join('\n'));
  return t;
};
{
  // receive stock to send
  recv('boA1', A1, 'purchase_order', 'po-tr', [{ key: 'po:tr:1', item_id: I.milk, qty_base: 12000, unit_cost: 0.0011 }, { key: 'po:tr:2', item_id: I.beans, qty_base: 10, unit_cost: 18 }]);
  const sMilk = onHand(I.milk), sBeans = onHand(I.beans), rMilk = onHand(I.milk2), rBeans = onHand(I.beans2);
  const L = { milk: randomUUID(), beans: randomUUID(), cups: randomUUID() };
  const t = mkTransfer(A1, A2, [{ id: L.milk, item: I.milk, unit: 'ml', qty: 6000, name: 'Milk', sku: 'MILK' }, { id: L.beans, item: I.beans, unit: 'kg', qty: 3, name: 'Coffee beans', sku: 'BEANS' }, { id: L.cups, item: I.cups, unit: 'each', qty: 5, name: 'Cups', sku: 'CUP' }], { fromArea: AR.bar });
  let r = leg('boA1', t, 'out');
  ok(r.j?.ok === true && r.j?.status === 'SENT' && near(onHand(I.milk), sMilk - 6000), 'send: the sender loses what it sends');
  const milkCost = num(`select unit_cost from stock_transfer_lines where id = '${L.milk}'`);
  // receiver: milk in litres (6000 ml = 6 l), 5 l arrived; beans in grams (3 kg = 3000 g), all arrived; cups dropped
  sql(`update stock_transfer_lines set to_inventory_item_id = '${I.milk2}', qty_received_base = 5 where id = '${L.milk}';
       update stock_transfer_lines set to_inventory_item_id = '${I.beans2}', qty_received_base = null where id = '${L.beans}';
       update stock_transfer_lines set dropped = true where id = '${L.cups}';`);
  const cups0 = onHand(I.cups);
  r = leg('ownerA', t, 'in');
  ok(r.j?.ok === true && r.j?.short_lines === 2, `part receive: received with 2 short lines (${JSON.stringify(r.j)})`);
  ok(near(onHand(I.milk2), rMilk + 5) && near(onHand(I.beans2), rBeans + 3000), `units convert: 5 l of milk and 3,000 g of beans landed (${onHand(I.milk2) - rMilk}, ${onHand(I.beans2) - rBeans})`);
  ok(near(num(`select to_unit_cost from stock_transfer_lines where id = '${L.milk}'`), milkCost * 1000, 1e-6), 'the cost comes per receiving unit (per litre = 1,000 x per ml)');
  ok(near(onHand(I.milk), sMilk - 6000) && near(onHand(I.cups), cups0), 'the sender\'s on hand does not move again at receive');
  const shortMilk = num(`select short_qty_base from stock_transfer_lines where id = '${L.milk}'`);
  ok(near(shortMilk, 1000), `Short on transfer: 1 l of milk (1,000 ml) did not arrive (${shortMilk})`);
  ok(num(`select count(*) from stock_movements where location_id = '${A1}' and movement_type = 'WASTE' and idempotency_key = 'transfer:${t}:${L.milk}:short'`) === 1
     && num(`select count(*) from stock_movements where location_id = '${A1}' and movement_type = 'TRANSFER_OUT' and qty_base > 0 and reversal_of is not null and idempotency_key = 'transfer:${t}:${L.milk}:short-back'`) === 1,
    'booked at the sender: a reversal of the shortfall, then WASTE');
  ok(num(`select count(*) from waste_events where location_id = '${A1}' and reason = 'Short on transfer'`) === 2, 'the sender sees it in its waste (2 lines: the short milk and the dropped cups)');
  ok(near(num(`select short_qty_base from stock_transfer_lines where id = '${L.cups}'`), 5), 'a dropped line is short in full');
  // I5: sent = received (in sender units) + short, for every line
  const i5 = sql(`select bool_and(abs(l.qty_base - (coalesce(l.qty_received_base, 0) / coalesce(public.stock_convert_qty(1, l.base_unit, coalesce(l.to_base_unit, l.base_unit), array[l.to_inventory_item_id, l.inventory_item_id]), 1)) * (case when l.dropped then 0 else 1 end) - coalesce(l.short_qty_base, 0)) < 0.0001) from stock_transfer_lines l where l.transfer_id = '${t}'`);
  ok(i5 === 't', 'nothing is created or lost: sent = received + short on every line');
  r = leg('ownerA', t, 'in');
  ok(r.j?.duplicate === true, 'receiving twice is a harmless repeat');

  // units that cannot convert
  const L2 = randomUUID();
  const t2 = mkTransfer(A1, A2, [{ id: L2, item: I.beans, unit: 'kg', qty: 1, name: 'Coffee beans' }], { fromArea: AR.cellar });
  leg('boA1', t2, 'out');
  sql(`update stock_transfer_lines set to_inventory_item_id = '${I.cups2}' where id = '${L2}'`);   // cups2 is 'each' with a bridge to g
  r = leg('ownerA', t2, 'in');
  ok(r.j?.ok === true, 'kg to each converts through the receiving item\'s own bridge (1 each = 12 g)');
  ok(near(num(`select qty_received_base from stock_transfer_lines where id = '${L2}'`), 1000 / 12, 1e-3), 'and lands as 83.333 each');
  const L3 = randomUUID();
  const t3 = mkTransfer(A1, A2, [{ id: L3, item: I.milk, unit: 'ml', qty: 100, name: 'Milk' }], { fromArea: AR.bar });
  leg('boA1', t3, 'out');
  sql(`update stock_transfer_lines set to_inventory_item_id = '${I.beans2}' where id = '${L3}'`);
  const before3 = onHand(I.beans2);
  r = leg('ownerA', t3, 'in');
  ok(r.j?.ok === false && /cannot be converted/.test(r.j?.error || '') && near(onHand(I.beans2), before3), `ml to g with no bridge is refused in words, nothing received (${r.j?.error})`);
  r = leg('boA1', t3, 'cancel');
  ok(r.j?.ok === true && r.j?.status === 'CANCELLED', 'cancel: the sender takes a sent transfer back');

  // receiver cost: below zero takes the transfer cost
  sql(`update inventory_items set current_cost = 1 where id = '${I.cups2}';
       select public._post_stock_movement('${A2}', '${I.cups2}', -8 - on_hand, 'SALE_DEPLETION', null, 'closed_check', 'bz', 'sale:bz:${I.cups2}') from inventory_items where id = '${I.cups2}';`);
  ok(near(onHand(I.cups2), -8), 'the receiving item is 8 below zero');
  const L4 = randomUUID();
  const t4 = mkTransfer(A1, A2, [{ id: L4, item: I.cups, unit: 'each', qty: 3, name: 'Cups' }], { fromArea: AR.bar });
  sql(`update inventory_items set current_cost = 2 where id = '${I.cups}'`);
  leg('boA1', t4, 'out');
  sql(`update stock_transfer_lines set to_inventory_item_id = '${I.cups2}' where id = '${L4}'`);
  leg('ownerA', t4, 'in');
  ok(near(cost(I.cups2), 2), `the receiver below zero takes the transfer cost (${cost(I.cups2)})`);

  // one company, in the table rule too
  r = asCaller('boA1', `insert into stock_transfers (location_id, to_location_id, status) values ('${A1}', '${B1}', 'DRAFT')`);
  ok(r.sqlstate === '42501', `a transfer naming a venue of another company is refused by the table rule (${r.sqlstate})`);
  r = asCaller('boA1', `insert into stock_transfers (location_id, to_location_id, status) values ('${A1}', '${A2}', 'DRAFT')`);
  ok(r.status === 0, 'a transfer to a sister venue is allowed');
  ok([I.milk, I.beans, I.cups, I.milk2, I.beans2, I.cups2].every((it) => near(onHand(it), ledger(it))), 'on hand equals the ledger at both venues');

  // Rounding into a coarser unit (I5): received in full, 11.6438 ml into a litre item.
  const fullIn = (sent) => {
    const T = randomUUID(); const LN = randomUUID();
    sql(`insert into stock_transfers (id, location_id, to_location_id, status, reference) values ('${T}', '${A1}', '${A2}', 'DRAFT', 'E12');
         insert into stock_transfer_lines (id, transfer_id, location_id, to_location_id, inventory_item_id, base_unit, qty_base, name_snapshot) values ('${LN}', '${T}', '${A1}', '${A2}', '${I.milk}', 'ml', ${sent}, 'Milk');`);
    leg('boA1', T, 'out');
    sql(`update stock_transfer_lines set to_inventory_item_id = '${I.milk2}', qty_received_base = null where id = '${LN}'`);
    const m2 = onHand(I.milk2);
    const rr = leg('ownerA', T, 'in');
    return { rr, got: Math.round((onHand(I.milk2) - m2) * 1e4) / 1e4, short: sql(`select coalesce(short_qty_base::text, '') from stock_transfer_lines where id = '${LN}'`) };
  };
  let e = fullIn(11.6438);
  ok(e.rr.j?.ok === true && e.got === 0.0116 && e.short === '' && e.rr.j?.short_lines === 0, `11.6438 ml received in full lands as 0.0116 l with no Short on transfer (got ${e.got} l, short '${e.short}')`);
  e = fullIn(11.6958);
  ok(e.got === 0.0116 && Number(e.short) === 0.0958, `11.6958 ml lands as 0.0116 l, never 0.0117 (more than was sent); the 0.0958 ml left is booked short (got ${e.got}, short ${e.short})`);
  e = fullIn(6000);
  ok(e.got === 6 && e.short === '', 'a round 6,000 ml lands as 6 l, nothing short');

  // Property run: random quantities across unit pairs, full and part receives, both directions.
  const flourG = freshItem('Flour', { unit: 'g', cost: 0.002 }), flourKg = freshItem('Flour', { loc: A2, unit: 'kg', cost: 2 });
  const pairs = [
    { from: A1, to: A2, si: I.milk, ri: I.milk2, su: 'ml' }, { from: A2, to: A1, si: I.milk2, ri: I.milk, su: 'l' },
    { from: A1, to: A2, si: flourG, ri: flourKg, su: 'g' }, { from: A2, to: A1, si: flourKg, ri: flourG, su: 'kg' },
    { from: A1, to: A2, si: I.cups, ri: I.cups2, su: 'each' }, { from: A1, to: A2, si: I.beans, ri: I.cups2, su: 'kg' },
  ];
  const rand = rng(SEED + 7);
  const tids = [];
  const stmts = [];
  for (let k = 0; k < (QUICK ? 120 : 400); k++) {
    const pr = pairs[Math.floor(rand() * pairs.length)];
    const T = randomUUID(); const LN = randomUUID();
    const sent = Math.max(0.0001, Math.round(rand() * (rand() < 0.5 ? 50 : 50000)) / 10000);
    const f = sql(`select public.stock_convert_qty(1, '${pr.su}', (select base_unit from inventory_items where id = '${pr.ri}'), array['${pr.ri}', '${pr.si}']::uuid[])`);
    const typed = rand() < 0.5 ? 'null' : String(Math.floor(rand() * sent * Number(f) * 10000) / 10000);
    tids.push(T);
    stmts.push(`insert into stock_transfers (id, location_id, to_location_id, status, reference) values ('${T}', '${pr.from}', '${pr.to}', 'DRAFT', 'P5');
insert into stock_transfer_lines (id, transfer_id, location_id, to_location_id, inventory_item_id, base_unit, qty_base, name_snapshot) values ('${LN}', '${T}', '${pr.from}', '${pr.to}', '${pr.si}', '${pr.su}', ${sent}, 'P');
select public.post_stock_transfer_leg('${T}', 'out', 'P');
update stock_transfer_lines set to_inventory_item_id = '${pr.ri}', qty_received_base = ${typed} where id = '${LN}';
select public.post_stock_transfer_leg('${T}', 'in', 'P')`);
  }
  const pr5 = psql({ input: stmts.join(';\n') + ';\n', allowFail: true });
  ok(pr5.status === 0, `${tids.length} random transfers sent and received with no error${pr5.status ? `: ${(pr5.stderr || '').slice(0, 300)}` : ''}`);
  const tl = `array[${tids.map((t) => `'${t}'`).join(',')}]::uuid[]`;
  const facts = `select l.id, l.qty_base as sent, coalesce(l.qty_received_base, 0) as got, coalesce(l.short_qty_base, 0) as short,
      public.stock_convert_qty(1, l.base_unit, l.to_base_unit, array[l.to_inventory_item_id, l.inventory_item_id]) as f
    from stock_transfer_lines l where l.transfer_id = any(${tl})`;
  ok(sql(`select count(*) from stock_transfers where id = any(${tl}) and status = 'RECEIVED'`) === String(tids.length), 'every one received');
  const created = sql(`select count(*) from (${facts}) x where x.got / x.f > x.sent + 0.0000000001`);
  ok(created === '0', `nothing is created: what arrived is never more than was sent, in the sender's unit (${created} lines over)`);
  const drift = sql(`select coalesce(max(abs(x.sent - x.got / x.f - x.short) / (0.00005 * greatest(1, 1 / x.f))), 0) from (${facts}) x`);
  ok(Number(drift) < 1.000001, `nothing is lost beyond half a 4th decimal step of the coarser unit: sent = received + short within that (worst ${Number(drift).toFixed(4)} of a half step)`);
  const tiny = sql(`select count(*) from (${facts}) x where x.short > 0 and x.short < 0.00005 * greatest(1, 1 / x.f)`);
  ok(tiny === '0', 'no Short on transfer below half a step (rounding is never booked as a loss)');
  const wasteRows = num(`select count(*) from waste_events w where w.reason = 'Short on transfer' and w.note like 'Transfer P5%'`);
  const shortLines = num(`select count(*) from stock_transfer_lines where transfer_id = any(${tl}) and coalesce(short_qty_base, 0) > 0`);
  ok(wasteRows === shortLines, `one waste row per short line (${wasteRows} and ${shortLines})`);
  ok(sql(`select count(*) from inventory_items i where i.location_id in ('${A1}', '${A2}') and abs(coalesce(i.on_hand, 0) - coalesce((select sum(m.qty_base) from stock_movements m where m.inventory_item_id = i.id), 0)) > 0.0001`) === '0', 'I1: on hand equals the ledger at both venues after the run');
}

// -- 13. weekday on the venue clock, one row per item, paged ----------------------------------------
console.log('\n13. The order pad weekday is the venue\'s, not UTC; one row per item, 1,000 items a page');
{
  // Monday 19 Oct 2026 00:30 in London (BST) is Sunday 23:30 UTC. One item with that one sale.
  const wd = freshItem('Weekday cups', { loc: A2 });
  sql(`select public._post_stock_movement('${A2}', '${wd}', -1, 'SALE_DEPLETION', null, 'closed_check', 'wd', 'sale:wd:${wd}', '2026-10-18 23:30:00+00')`);
  const dowOf = (args) => {
    const r = asCaller('ownerA', `select array_to_string(by_dow, ',') from public.stock_usage_weekday_page(${args}) where inventory_item_id = '${wd}'`);
    return { status: r.status, v: (r.out || '').split(',').map(Number) };
  };
  // only rows within p_weeks count; 520 weeks reaches 18 Oct in any calendar this runs in
  let d = dowOf(`'${A2}', 520, null, null, '00:00'`);
  ok(d.v.length === 7 && near(d.v[1], 1 / 520, 1e-9) && d.v.filter((x) => x !== 0).length === 1, `with the venue clock (London, midnight), a sale at 00:30 Monday is Monday (${d.v.map((x) => +x.toFixed(4)).join(' ')})`);
  d = dowOf(`'${A2}', 520, null, null, '06:00'`);
  ok(near(d.v[0], 1 / 520, 1e-9) && d.v.filter((x) => x !== 0).length === 1, 'with a 06:00 business day start it belongs to Sunday');
  d = dowOf(`'${A2}', 520, null, 'Not/AZone', null`);
  ok(d.status === 0 && d.v.length === 7, 'an unknown zone falls back to London, never an error');
  const rows = asCaller('ownerA', `select count(*) || '|' || count(*) filter (where array_length(by_dow, 1) = 7) from public.stock_usage_weekday_page('${A2}', 8)`).out;
  const items2 = sql(`select count(*) from inventory_items where location_id = '${A2}'`);
  ok(rows === `${items2}|${items2}`, `one row per stock item of the venue, each with 7 values (${rows}, items ${items2})`);
  const rates = asCaller('ownerA', `select count(*) from public.stock_usage_rates_page('${A2}', 28)`).out;
  ok(rates === items2, `the usage rate too: one row per item (${rates})`);
}

// -- 14. the Multi site menu warning --------------------------------------------------------------------
console.log('\n14. Multi site menu: recipes at one site and not another');
{
  const menu = randomUUID();
  sql(`insert into msm_company (org_id, enabled) values ('${ORG_A}', true);
       insert into msm_members (org_id, user_id, role) values ('${ORG_A}', '${U.editorA}', 'editor');
       insert into msm_menus (id, org_id, name) values ('${menu}', '${ORG_A}', 'Group');`);
  const prods = Array.from({ length: 5 }, () => randomUUID());
  for (const [i, p] of prods.entries()) {
    sql(`insert into msm_products (id, menu_id, name) values ('${p}', '${menu}', 'P${i}');
         insert into msm_product_sites (product_id, location_id, venue_item_id) values ('${p}', '${A1}', 'a1-${i}'), ('${p}', '${A2}', 'a2-${i}');`);
  }
  // Provo has recipes for P0..P3; Location 2 only for P0
  for (let i = 0; i < 4; i++) sql(`insert into recipes (id, location_id, name) values ('${id('81000000', String(i))}', '${A1}', 'R${i}'); insert into menu_item_recipes (location_id, menu_item_id, recipe_id) values ('${A1}', 'a1-${i}', '${id('81000000', String(i))}');`);
  sql(`insert into recipes (id, location_id, name) values ('${id('82000000', '0')}', '${A2}', 'R0b'); insert into menu_item_recipes (location_id, menu_item_id, recipe_id) values ('${A2}', 'a2-0', '${id('82000000', '0')}');`);
  const r = asCaller('editorA', `select location_id || '|' || site_name || '|' || missing || '|' || from_site_name || '|' || from_count from public.msm_stock_recipe_gaps('${menu}')`);
  ok(r.out === `${A2}|Location 2|3|Provo|3`, `"3 products have a recipe at Provo but none at Location 2" (${r.out})`);
  const r2 = asCaller('boB1', `select count(*) from public.msm_stock_recipe_gaps('${menu}')`);
  ok(r2.sqlstate === '42501', 'a login that cannot see the group menu is refused');
  const r3 = asCaller('tillA1', `select count(*) from public.msm_stock_recipe_gaps('${menu}')`);
  ok(r3.sqlstate === '42501', 'a till is refused');
}

// -- 14b. the cost rule setting and who may call what ----------------------------------------------------
console.log('\n14b. The cost rule per venue, and who may call the new functions');
{
  let r = asCaller('boA1', `insert into stock_site_settings (location_id, cost_rule, updated_by_name) values ('${A1}', 'deliveries', 'Manager')`);
  ok(r.status === 0 && callJ('tillA1', `select public.stock_cost_rule('${A1}')`).out === 'deliveries', 'a Back Office login sets its venue to cost from deliveries; a till reads it');
  ok(callJ('boA1', `select public.stock_cost_rule('${A2}')`).out === 'price_list', 'a venue that never chose costs from the price list (today\'s rule)');
  r = asCaller('tillA1', `update stock_site_settings set cost_rule = 'price_list' where location_id = '${A1}'`);
  ok(sql(`select cost_rule from stock_site_settings where location_id = '${A1}'`) === 'deliveries', 'a till cannot change it');
  r = asCaller('boB1', `insert into stock_site_settings (location_id, cost_rule) values ('${A2}', 'deliveries')`);
  ok(r.sqlstate === '42501', `another company cannot set it (${r.sqlstate})`);
  r = asCaller('boA1', `insert into stock_site_settings (location_id, cost_rule) values ('${A2}', 'cheapest')`);
  ok(r.sqlstate === '23514' || r.sqlstate === '42501', `only price_list or deliveries (${r.sqlstate})`);
  for (const fn of [`public.stock_convert_qty(1, 'kg', 'g')`, `public._stock_receive_lines('${A1}', 'purchase_order', 'x', '[]'::jsonb)`]) {
    for (const who of ['boA1', 'service', 'anonKey']) {
      const rr = asCaller(who, `select ${fn}`);
      ok(rr.sqlstate === '42501', `${fn.split('(')[0]} cannot be run through the API by the ${CALLERS[who].what} (${rr.sqlstate})`);
    }
  }
  for (const fn of [`public.stock_usage_weekday_page('${A1}')`, `public.stock_usage_rates_page('${A1}')`]) {
    const w = asCaller('anonKey', `select count(*) from ${fn}`);
    ok(w.sqlstate === '42501', `the bare anon key cannot read ${fn.split('(')[0]} (${w.sqlstate})`);
  }
  ok(asCaller('boA1', `select count(*) from public.stock_usage_weekday_page('${A1}', 8, null, 'America/Denver', '06:00')`).status === 0, 'the Back Office reads usage on its venue clock');
  ok(asCaller('boB1', `select count(*) from public.stock_usage_weekday_page('${A1}', 520)`).out === '0', 'another company\'s login reads nothing of A1 (row level security)');
  // The cost rule and the same company answer only to callers that reach the venue.
  ok(callJ('stranger', `select public.stock_cost_rule('${A1}')`).out === 'price_list' && callJ('boB1', `select public.stock_cost_rule('${A1}')`).out === 'price_list',
    'a stranger, or another company, is told the default, never A1\'s own rule');
  ok(callJ('stranger', `select public.stock_same_company('${A1}', '${A2}')`).out === 'f' && callJ('boB1', `select public.stock_same_company('${A1}', '${A2}')`).out === 'f',
    'a stranger, or another company, cannot learn that A1 and A2 belong together');
  ok(callJ('boA1', `select public.stock_same_company('${A1}', '${A2}')`).out === 't' && callJ('boA1', `select public.stock_same_company('${A1}', '${B1}')`).out === 'f',
    'A1\'s own login is told A2 is a sister venue and B1 is not');
  sql(`insert into stock_counts (id, location_id, status) values ('${id('91000000', '1')}', '${A1}', 'DRAFT');
       insert into stock_count_lines (location_id, count_id, inventory_item_id, counted_qty) values ('${A1}', '${id('91000000', '1')}', '${I.cups}', 3);`);
  ok(sql(`select counted_at is not null from stock_count_lines where count_id = '${id('91000000', '1')}'`) === 't', 'a line saved with a figure is stamped with its counted time');
  sql(`update stock_count_lines set counted_qty = null where count_id = '${id('91000000', '1')}'`);
  ok(sql(`select counted_at is null from stock_count_lines where count_id = '${id('91000000', '1')}'`) === 't', 'clearing the figure clears the time');
}

// -- 15. property runs ----------------------------------------------------------------------------------
console.log(`\n15. Random sequences (seed ${SEED})`);
{
  const rand = rng(SEED);
  const pick = (a) => a[Math.floor(rand() * a.length)];
  const items = [I.milk, I.beans, I.packed, I.lastc, I.syrup];
  const areas = [AR.bar, AR.cellar, AR.recv, null];
  const nSeq = QUICK ? 1500 : 10000;
  const stmts = [];
  const replays = [];
  const counts = [];
  let chk = 0;
  for (let s = 0; s < nSeq; s++) {
    const ops = 1 + Math.floor(rand() * 5);
    for (let o = 0; o < ops; o++) {
      const kind = rand();
      const it = pick(items);
      let st;
      if (kind < 0.35) {
        chk++;
        const q = 1 + Math.floor(rand() * 5);
        st = `select public._post_stock_movement('${A1}', '${it}', -${q}, 'SALE_DEPLETION', null, 'closed_check', 'p${chk}', 'sale:p${chk}:${it}', ${rand() < 0.2 ? `now() - interval '${Math.floor(rand() * 600)} seconds'` : 'null'})`;
        if (rand() < 0.3) {
          const rq = 1 + Math.floor(rand() * 6);
          st += `;\nselect public._post_stock_movement('${A1}', '${it}', ${rq}, 'RETURN', null, 'closed_check_refund', 'p${chk}', 'return:p${chk}:r${o}:${it}')`;
        }
      } else if (kind < 0.50) {
        const key = `po:prop:${s}:${o}`;
        st = `select public._stock_receive_lines('${A1}', 'purchase_order', 'prop', ${jlit([{ key, item_id: it, qty_base: 1 + Math.floor(rand() * 20), unit_cost: rand() < 0.15 ? 0 : Math.round(rand() * 500) / 100 }])}, ${rand() < 0.5 ? `'${AR.recv}'` : 'null'})`;
      } else if (kind < 0.55) {
        // an invoice, half of them with no number, posted with the screen's own id (replayed below)
        const q = 1 + Math.floor(rand() * 10);
        st = `select public.stock_post_invoice('${A1}', ${jlit({ client_id: randomUUID(), supplier_id: SUP.a1b, invoice_number: rand() < 0.5 ? null : `PROP-${s}-${o}` })}, ` +
          `${jlit([{ matched_item_id: it, qty: q, unit: 'each', unit_price: 1 }])}, ${jlit([{ line_index: 0, item_id: it, qty_base: q, unit_cost: Math.round(rand() * 300) / 100 }])})`;
        replays.push(st);
      } else if (kind < 0.65) {
        const wid = randomUUID();
        st = `select public.stock_record_waste('${A1}', ${jlit({ id: wid, kind: 'menu', item_name: 'W', qty: 1 })}, ${jlit([{ item_id: it, qty_base: 1 }])})`;
      } else if (kind < 0.75) {
        const t = randomUUID(); const ln = randomUUID();
        const fa = pick([AR.bar, AR.cellar]); const ta = fa === AR.bar ? AR.cellar : AR.bar;
        st = `insert into stock_transfers (id, location_id, from_area_id, to_area_id, status) values ('${t}', '${A1}', '${fa}', '${ta}', 'DRAFT');
insert into stock_transfer_lines (id, transfer_id, location_id, inventory_item_id, base_unit, qty_base) values ('${ln}', '${t}', '${A1}', '${it}', null, ${1 + Math.floor(rand() * 3)});
select public.post_stock_transfer_leg('${t}', 'both', 'P')`;
        replays.push(`select public.post_stock_transfer_leg('${t}', 'both', 'P')`);
      } else if (kind < 0.82) {
        const cid = randomUUID(); const lid = randomUUID();
        const area = pick(areas);
        st = `insert into stock_counts (id, location_id, status) values ('${cid}', '${A1}', 'DRAFT');
insert into stock_count_lines (id, location_id, count_id, inventory_item_id, area_id) values ('${lid}', '${A1}', '${cid}', '${it}', ${area ? `'${area}'` : 'null'});
update stock_count_lines set counted_qty = ${Math.floor(rand() * 40)} where id = '${lid}';
select public.approve_stock_count('${cid}', 'P', null, '{"${it}": 1.5}'::jsonb)`;
        counts.push(cid);
        replays.push(`select public.approve_stock_count('${cid}', 'P')`);
      } else if (kind < 0.87) {
        const a = pick([AR.bar, AR.cellar, AR.recv]);
        st = `insert into inventory_item_areas (location_id, inventory_item_id, area_id, is_primary) values ('${A1}', '${it}', '${a}', true)
  on conflict (inventory_item_id) where is_primary do update set area_id = excluded.area_id`;
      } else {
        // a crash: the op runs and its transaction is lost
        chk++;
        st = `begin;
select public._post_stock_movement('${A1}', '${it}', -1, 'SALE_DEPLETION', null, 'closed_check', 'c${chk}', 'sale:c${chk}:${it}');
rollback`;
      }
      stmts.push(st);
      if (rand() < 0.05 && st.startsWith('select public._post_stock_movement')) replays.push(st.split(';\n')[0]);
    }
  }
  const t0 = Date.now();
  const r = psql({ input: stmts.join(';\n') + ';\n', allowFail: true });
  ok(r.status === 0, `${nSeq} random sequences (${stmts.length} steps: sales, refunds, receipts, invoices with and without a number, waste, area moves, transfers, counts, crashes) ran with no error in ${Math.round((Date.now() - t0) / 1000)} s${r.status ? `: ${(r.stderr || '').slice(0, 300)}` : ''}`);
  const snap = () => sql(`select count(*) || '|' || coalesce(sum(qty_base), 0) || '|' || coalesce(sum(value_delta), 0) || '|' || (select count(*) from supplier_invoices where location_id = '${A1}') || '|' || (select count(*) from waste_events where location_id = '${A1}') from stock_movements where location_id = '${A1}'`);
  const before = snap();
  const rp = psql({ input: replays.join(';\n') + ';\n', allowFail: true });
  ok(rp.status === 0 && snap() === before, `I3: replaying ${replays.length} of those steps changes nothing (${before})`);
  ok(sql(`select count(*) from inventory_items i where i.location_id = '${A1}' and abs(i.on_hand - coalesce((select sum(m.qty_base) from stock_movements m where m.inventory_item_id = i.id), 0)) > 0.0001`) === '0', 'I1: every item\'s on hand equals the sum of its movements');
  ok(sql(`select count(*) from inventory_item_area_stock s where s.location_id = '${A1}' and abs(s.on_hand - coalesce((select sum(m.qty_base) from stock_movements m where m.inventory_item_id = s.inventory_item_id and m.area_id = s.area_id), 0)) > 0.0001`) === '0', 'I2: every area holding equals its movements');
  ok(sql(`select count(*) from inventory_items i where i.location_id = '${A1}' and exists (select 1 from inventory_item_areas ia where ia.inventory_item_id = i.id and ia.is_primary)
          and abs(i.on_hand - coalesce((select sum(s.on_hand) from inventory_item_area_stock s where s.inventory_item_id = i.id), 0)) > 0.0001`) === '0', 'I2: an item with a use area has its areas adding up to its on hand');
  const i7 = sql(`select s.idempotency_key || ' sold ' || -s.qty_base || ' returned ' || coalesce((select sum(r.qty_base) from stock_movements r where r.location_id = s.location_id and r.inventory_item_id = s.inventory_item_id
                         and r.movement_type = 'RETURN' and r.idempotency_key like 'return:' || s.source_id || ':%'), 0)
          from stock_movements s where s.location_id = '${A1}' and s.idempotency_key like 'sale:p%' and s.movement_type = 'SALE_DEPLETION'
          and coalesce((select sum(r.qty_base) from stock_movements r where r.location_id = s.location_id and r.inventory_item_id = s.inventory_item_id
                         and r.movement_type = 'RETURN' and r.idempotency_key like 'return:' || s.source_id || ':%'), 0) > -s.qty_base + 0.0001 limit 3`);
  ok(i7 === '', `I7: no check item ever returned more than its sale took${i7 ? ` (${i7.replace(/\n/g, '; ')})` : ''}`);
  ok(sql(`select count(*) from stock_count_lines l join stock_counts c on c.id = l.count_id where c.id = any(array[${counts.map((c) => `'${c}'`).join(',') || 'null'}]::uuid[]) and c.status <> 'APPROVED'`) === '0', 'every count approved');
}

// -- 16. count truth with sales arriving in any order (I6) ---------------------------------------------
console.log('\n16. Count truth (I6): sales before, during and after a count, in any order');
{
  const rand = rng(SEED + 1);
  const runs = QUICK ? 40 : 200;
  let bad = 0;
  const failures6 = [];
  for (let k = 0; k < runs; k++) {
    const item = randomUUID();
    sql(`insert into inventory_items (id, location_id, name, base_unit, current_cost) values ('${item}', '${A1}', 'I6 ${k}', 'each', 1);
         select public._post_stock_movement('${A1}', '${item}', 100, 'OPENING_BALANCE', 1, 'demo', null, 'open:${item}', now() - interval '3 days');`);
    const cid = randomUUID(); const lid = randomUUID();
    sql(`insert into stock_counts (id, location_id, status) values ('${cid}', '${A1}', 'DRAFT');
         insert into stock_count_lines (id, location_id, count_id, inventory_item_id) values ('${lid}', '${A1}', '${cid}', '${item}');`);
    // the count moment C = now() - 1 day; events at C +/- up to 6 hours, posted before or after approval
    const counted = 50 + Math.floor(rand() * 30);
    sql(`update stock_count_lines set counted_qty = ${counted} where id = '${lid}'; update stock_count_lines set counted_at = date_trunc('second', now()) - interval '1 day' where id = '${lid}';`);
    const events = Array.from({ length: 4 + Math.floor(rand() * 8) }, (_, i) => ({ i, offset: Math.floor((rand() - 0.5) * 43200), qty: 1 + Math.floor(rand() * 4), after: rand() < 0.5 }));
    const postOne = (e) => `select public._post_stock_movement('${A1}', '${item}', -${e.qty}, 'SALE_DEPLETION', null, 'closed_check', 'i6-${k}-${e.i}', 'sale:i6-${k}-${e.i}:${item}', (select counted_at from stock_count_lines where id = '${lid}') + interval '${e.offset} seconds')`;
    sql(events.filter((e) => !e.after).map(postOne).join(';\n') + ';\nselect 1;');
    sql(`select public.approve_stock_count('${cid}', 'I6')`);
    const late = events.filter((e) => e.after);
    for (let i = late.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [late[i], late[j]] = [late[j], late[i]]; }
    sql(late.map(postOne).join(';\n') + ';\nselect 1;');
    const atCount = num(`select coalesce(sum(qty_base), 0) from stock_movements where inventory_item_id = '${item}' and occurred_at <= (select counted_at from stock_count_lines where id = '${lid}')`);
    const after = events.filter((e) => e.offset > 0).reduce((s, e) => s + e.qty, 0);
    const oh = onHand(item);
    if (!near(atCount, counted) || !near(oh, counted - after)) { bad++; failures6.push({ k, counted, atCount, oh, want: counted - after }); }
  }
  ok(bad === 0, `I6 held in ${runs} runs: on hand = counted + movements after the count, the ledger at the count = counted${bad ? ` (${JSON.stringify(failures6.slice(0, 3))})` : ''}`);

  // Two or three counts of one item open at once, approved in ANY order (newest first too), with
  // sales posted before, between and after the approvals: the newest count is the truth.
  const rand2 = rng(SEED + 11);
  const runs2 = QUICK ? 30 : 120;
  let bad2 = 0; let superseded = 0;
  const fails2 = [];
  for (let k = 0; k < runs2; k++) {
    const item = randomUUID();
    sql(`insert into inventory_items (id, location_id, name, base_unit, current_cost) values ('${item}', '${A1}', 'I6b ${k}', 'each', 1);
         select public._post_stock_movement('${A1}', '${item}', 100, 'OPENING_BALANCE', 1, 'demo', null, 'open:${item}', now() - interval '3 days');`);
    const nC = 2 + Math.floor(rand2() * 2);
    const cs = Array.from({ length: nC }, (_, j) => ({ cid: randomUUID(), lid: randomUUID(), off: j * 7200 + Math.floor(rand2() * 3000), qty: 40 + Math.floor(rand2() * 50) }));
    const evs = Array.from({ length: 6 + Math.floor(rand2() * 7) }, (_, i) => ({ i, off: Math.floor(rand2() * (nC * 7200 + 21600)) - 10800, qty: 1 + Math.floor(rand2() * 4), slot: Math.floor(rand2() * (nC + 2)) }));
    const postE = (e) => `select public._post_stock_movement('${A1}', '${item}', -${e.qty}, 'SALE_DEPLETION', null, 'closed_check', 'i6b-${k}-${e.i}', 'sale:i6b-${k}-${e.i}:${item}', date_trunc('second', now()) - interval '1 day' + interval '${e.off} seconds')`;
    const batch = (list) => { if (list.length) sql(list.map(postE).join(';\n') + ';\nselect 1;'); };
    batch(evs.filter((e) => e.slot === 0));
    for (const c of cs) {
      sql(`insert into stock_counts (id, location_id, status) values ('${c.cid}', '${A1}', 'DRAFT');
           insert into stock_count_lines (id, location_id, count_id, inventory_item_id) values ('${c.lid}', '${A1}', '${c.cid}', '${item}');
           update stock_count_lines set counted_qty = ${c.qty} where id = '${c.lid}';
           update stock_count_lines set counted_at = date_trunc('second', now()) - interval '1 day' + interval '${c.off} seconds' where id = '${c.lid}';`);
    }
    const order = [...cs];
    for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rand2() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
    order.forEach((c, n) => {
      const res = JSON.parse(sql(`select public.approve_stock_count('${c.cid}', 'I6b')`));
      superseded += res.superseded || 0;
      batch(evs.filter((e) => e.slot === n + 1));
    });
    batch(evs.filter((e) => e.slot > nC));
    const newest = cs[cs.length - 1];
    const at = `(select counted_at from stock_count_lines where id = '${newest.lid}')`;
    const atNewest = num(`select coalesce(sum(qty_base), 0) from stock_movements where inventory_item_id = '${item}' and occurred_at <= ${at}`);
    const after = evs.filter((e) => e.off > newest.off).reduce((t, e) => t + e.qty, 0);
    const oh = onHand(item);
    if (!near(atNewest, newest.qty) || !near(oh, newest.qty - after) || oh !== ledger(item)) { bad2++; fails2.push({ k, order: order.map((c) => cs.indexOf(c)), counted: newest.qty, atNewest, oh, want: newest.qty - after }); }
  }
  ok(bad2 === 0, `I6 with counts approved in any order held in ${runs2} runs (${superseded} older lines superseded): the newest count is the truth${bad2 ? ` (${JSON.stringify(fails2.slice(0, 3))})` : ''}`);
}

// -- 17. the moving average equals a replay (I9) --------------------------------------------------------
console.log('\n17. Cost (I9): the moving average equals a replay, below zero and unknown cost never drag it');
{
  const rand = rng(SEED + 2);
  const runs = QUICK ? 60 : 300;
  const plan = [];
  const model = {};
  const stmts = [];
  for (let k = 0; k < runs; k++) {
    const item = randomUUID();
    const lastCost = rand() < 0.2;
    const start = rand() < 0.3 ? null : Math.round(rand() * 300) / 100;
    stmts.push(`insert into inventory_items (id, location_id, name, base_unit, current_cost, cost_method) values ('${item}', '${A1}', 'I9 ${k}', 'each', ${start == null ? 'null' : start}, '${lastCost ? 'LAST_COST' : 'MOVING_AVG'}')`);
    let oh = 0; let c = start;
    for (let s = 0; s < 8; s++) {
      if (rand() < 0.45) {
        const q = 1 + Math.floor(rand() * 15);
        stmts.push(`select public._post_stock_movement('${A1}', '${item}', -${q}, 'SALE_DEPLETION', null, 'closed_check', null, 'sale:i9-${k}-${s}:${item}')`);
        oh -= q;
      } else {
        const q = 1 + Math.floor(rand() * 20);
        const price = rand() < 0.15 ? 0 : Math.round(rand() * 500) / 100;
        stmts.push(`select public._stock_receive_lines('${A1}', 'purchase_order', 'i9', ${jlit([{ key: `po:i9:${k}:${s}`, item_id: item, qty_base: q, unit_cost: price }])})`);
        if (price > 0) {
          if (lastCost || oh <= 0 || c == null || c <= 0) c = price;
          else c = Math.round(((oh * c + q * price) / (oh + q)) * 1e8) / 1e8;
        }
        oh += q;
      }
    }
    model[item] = c; plan.push(item);
  }
  psql({ input: stmts.join(';\n') + ';\n' });
  const rows = sql(`select id || '|' || coalesce(current_cost::text, '') from inventory_items where id = any(array[${plan.map((p) => `'${p}'`).join(',')}]::uuid[])`).split('\n');
  let bad = 0; const ex = [];
  for (const row of rows) { const [iid, cc] = row.split('|'); const want = model[iid]; const got = cc === '' ? null : Number(cc); if (!((want == null && got == null) || (want != null && got != null && near(want, got, 1e-6)))) { bad++; ex.push({ want, got }); } }
  ok(bad === 0, `I9 held for ${runs} items: the cost equals the reference replay${bad ? ` ${JSON.stringify(ex.slice(0, 3))}` : ''}`);
}

// -- 18. scale: a 2,250 line count approval and the recipe warning at 50 sites ---------------------------
console.log('\n18. Scale: 5,000 items, a big ledger, a 2,250 line count, 50 sites');
{
  sql(`insert into locations (id, org_id, name) values ('${BIG}', '${ORG_BIG}', 'Big site');
       insert into user_locations (user_id, location_id) values ('${U.boA1}', '${BIG}');
       insert into storage_areas (id, location_id, name) select ('d0000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, '${BIG}', 'Area ' || g from generate_series(1, 6) g;
       insert into inventory_items (id, location_id, name, base_unit, current_cost, on_hand)
         select ('e0000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, '${BIG}', 'Item ' || g, 'each', 1 + (g % 7), 0 from generate_series(1, 5000) g;
       insert into inventory_item_areas (location_id, inventory_item_id, area_id)
         select '${BIG}', ('e0000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, ('d0000000-0000-4000-8000-' || lpad(((g % 6) + 1)::text, 12, '0'))::uuid from generate_series(1, 5000) g;
       insert into stock_movements (location_id, inventory_item_id, qty_base, unit_cost, value_delta, movement_type, occurred_at, idempotency_key, area_id)
         select '${BIG}', ('e0000000-0000-4000-8000-' || lpad(((g % 5000) + 1)::text, 12, '0'))::uuid, case when g <= 5000 then 500 else -1 end, 1, 0,
                case when g <= 5000 then 'OPENING_BALANCE' else 'SALE_DEPLETION' end, now() - make_interval(secs => (300000 - g)),
                'big:' || g, ('d0000000-0000-4000-8000-' || lpad((((g % 5000) + 1) % 6 + 1)::text, 12, '0'))::uuid
           from generate_series(1, 300000) g;
       update inventory_items i set on_hand = s.q from (select inventory_item_id, sum(qty_base) q from stock_movements where location_id = '${BIG}' group by 1) s where s.inventory_item_id = i.id;
       insert into inventory_item_area_stock (location_id, inventory_item_id, area_id, on_hand)
         select '${BIG}', inventory_item_id, area_id, sum(qty_base) from stock_movements where location_id = '${BIG}' group by 2, 3
         on conflict (inventory_item_id, area_id) do update set on_hand = excluded.on_hand;
       analyze;`);
  const cid = randomUUID();
  sql(`insert into stock_counts (id, location_id, status) values ('${cid}', '${BIG}', 'DRAFT');
       insert into stock_count_lines (location_id, count_id, inventory_item_id, area_id, counted_qty)
         select '${BIG}', '${cid}', ('e0000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, ('d0000000-0000-4000-8000-' || lpad((((g) % 6) + 1)::text, 12, '0'))::uuid, 400 + (g % 50)
           from generate_series(1, 2250) g;`);
  const t0 = Date.now();
  const r = callJ('boA1', `select public.approve_stock_count('${cid}', 'Scale')`);
  const ms = Date.now() - t0;
  ok(r.j?.ok === true && r.j?.total > 2000, `a 2,250 line count approves in one call as the Back Office login, inside the live 8 s limit (${ms} ms, ${r.j?.total} adjustments)${r.status ? ` ${r.message}` : ''}`);
  ok(sql(`select count(*) from inventory_items i where i.location_id = '${BIG}' and abs(i.on_hand - (select coalesce(sum(qty_base), 0) from stock_movements m where m.location_id = i.location_id and m.inventory_item_id = i.id)) > 0.0001`) === '0', 'I1 holds at the big site');
  // the recipe warning: 50 sites x 2,000 products
  const menu = randomUUID();
  sql(`insert into msm_company (org_id, enabled) values ('${ORG_BIG}', true) on conflict do nothing;
       insert into msm_menus (id, org_id, name) values ('${menu}', '${ORG_BIG}', 'Big menu');
       insert into locations (id, org_id, name) select ('f0000000-0000-4000-8000-' || lpad(s::text, 12, '0'))::uuid, '${ORG_BIG}', 'Site ' || s from generate_series(1, 50) s;
       insert into msm_products (id, menu_id, name) select ('f1000000-0000-4000-8000-' || lpad(p::text, 12, '0'))::uuid, '${menu}', 'P' || p from generate_series(1, 2000) p;
       insert into msm_product_sites (product_id, location_id, venue_item_id)
         select ('f1000000-0000-4000-8000-' || lpad(p::text, 12, '0'))::uuid, ('f0000000-0000-4000-8000-' || lpad(s::text, 12, '0')), 'vi-' || s || '-' || p
           from generate_series(1, 2000) p, generate_series(1, 50) s;
       insert into recipes (id, location_id, name) select ('f2000000-0000-4000-8000-' || lpad(s::text, 12, '0'))::uuid, ('f0000000-0000-4000-8000-' || lpad(s::text, 12, '0'))::uuid, 'R' from generate_series(1, 50) s;
       insert into menu_item_recipes (location_id, menu_item_id, recipe_id)
         select ('f0000000-0000-4000-8000-' || lpad(s::text, 12, '0'))::uuid, 'vi-' || s || '-' || p, ('f2000000-0000-4000-8000-' || lpad(s::text, 12, '0'))::uuid
           from generate_series(1, 2000) p, generate_series(1, 50) s where (p + s) % 3 <> 0;
       analyze;`);
  const t1 = Date.now();
  const g = asCaller('superAdmin', `select count(*) || '|' || max(missing) from public.msm_stock_recipe_gaps('${menu}')`);
  ok(g.status === 0 && g.out.startsWith('50|'), `the recipe warning at 50 sites x 2,000 products: one row per site, inside 8 s (${Date.now() - t1} ms, ${g.out})${g.status ? ` ${g.message}` : ''}`);

  // The order pad's usage reads at 5,000 items, page by page as the screen reads them (the API cuts
  // any one answer at 1,000 rows): every item, all 7 days, the same totals as an uncapped sum.
  const readPages = (fn) => {
    const pages = []; let after = null; let tmax = 0; let failed = null;
    for (let n = 0; n < 20; n++) {
      const t = Date.now();
      const r = asCaller('boA1', `select inventory_item_id || '|' || ${fn === 'w' ? `array_to_string(by_dow, ',')` : 'avg_daily_base'} from public.${fn === 'w' ? 'stock_usage_weekday_page' : 'stock_usage_rates_page'}('${BIG}', ${fn === 'w' ? 8 : 28}, ${after ? `'${after}'` : 'null'})`);
      tmax = Math.max(tmax, Date.now() - t);
      if (r.status !== 0) { failed = r.message; break; }
      const rows = r.out ? r.out.split('\n') : [];
      pages.push(rows);
      if (rows.length < 1000) break;
      after = rows[rows.length - 1].split('|')[0];
    }
    return { pages, all: pages.flat(), tmax, failed };
  };
  const direct = (days) => num(`select coalesce(sum(-qty_base), 0) from stock_movements where location_id = '${BIG}' and movement_type in ('SALE_DEPLETION', 'PRODUCTION_CONSUME') and qty_base < 0 and occurred_at >= now() - interval '${days} days'`);
  const wk = readPages('w');
  const wTotal = wk.all.reduce((t, row) => t + row.split('|')[1].split(',').reduce((a, v) => a + Number(v), 0), 0) * 8;
  ok(!wk.failed && wk.pages.every((pg) => pg.length <= 1000) && wk.all.length === 5000 && new Set(wk.all.map((x) => x.split('|')[0])).size === 5000
     && wk.all.every((x) => x.split('|')[1].split(',').length === 7),
    `weekday usage: ${wk.pages.length} pages of at most 1,000, all 5,000 items once, 7 days each, slowest page ${wk.tmax} ms${wk.failed ? ` ${wk.failed}` : ''}`);
  ok(near(wTotal, direct(56), 0.01), `and the same total as an uncapped sum (${Math.round(wTotal)} and ${direct(56)})`);
  const rt = readPages('r');
  const rTotal = rt.all.reduce((t, row) => t + Number(row.split('|')[1]), 0) * 28;
  ok(!rt.failed && rt.pages.every((pg) => pg.length <= 1000) && rt.all.length === 5000 && near(rTotal, direct(28), 0.01),
    `usage rates: ${rt.pages.length} pages, all 5,000 items, the same total (${Math.round(rTotal)} and ${direct(28)}), slowest page ${rt.tmax} ms`);
  ok(num(`select count(*) from public.stock_usage_by_weekday('${BIG}', 8)`) > 1000, 'the old one row per item and day read answers more than 1,000 rows here (why the screens moved off it)');
}

// -- 19. concurrency ------------------------------------------------------------------------------------
console.log('\n19. Concurrency: 8 tills sell while a 2,250 line count approves, a delivery lands and areas move');
{
  const cid = randomUUID();
  sql(`insert into stock_counts (id, location_id, status) values ('${cid}', '${BIG}', 'DRAFT');
       insert into stock_count_lines (location_id, count_id, inventory_item_id, area_id, counted_qty)
         select '${BIG}', '${cid}', ('e0000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, ('d0000000-0000-4000-8000-' || lpad((((g) % 6) + 1)::text, 12, '0'))::uuid, 300
           from generate_series(1, 2250) g;
       insert into devices (location_id, name, status, device_uid, bound_via, last_seen)
         select '${BIG}', 'Till ' || t, 'online', ('21000000-0000-4000-8000-' || lpad(t::text, 12, '0'))::uuid, 'claim_device_v2', now() from generate_series(1, 8) t;`);
  const job = (loginName, claims, role, body) => new Promise((resolve) => {
    const lines = ['begin;'];
    if (claims) lines.push(`select set_config('request.jwt.claims', ${lit(JSON.stringify(claims))}, true) \\g /dev/null`);
    if (role) lines.push(`set local role ${role};`, `set local statement_timeout = '8s';`, `set local lock_timeout = '8s';`);
    lines.push(body, 'commit;');
    const p = spawn(bin('psql'), ['-h', dir, '-p', port, '-U', loginName, '-d', DB, '-v', 'ON_ERROR_STOP=1', '-X', '-q', '-At'], { env });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.stdin.end(lines.join('\n') + '\n');
    p.on('close', (code) => resolve({ code, err }));
  });
  const sales = (t) => {
    const out = [];
    for (let n = 0; n < 60; n++) {
      const g = 1 + ((t * 97 + n * 31) % 2400);
      out.push(`select public.post_stock_movement('${BIG}', ('e0000000-0000-4000-8000-' || lpad('${g}', 12, '0'))::uuid, -1, 'SALE_DEPLETION', null, 'closed_check', 'cc-${t}-${n}', 'sale:cc-${t}-${n}:' || ('e0000000-0000-4000-8000-' || lpad('${g}', 12, '0')));`);
      out.push('commit; begin;', `select set_config('request.jwt.claims', ${lit(JSON.stringify(anonSession(`21000000-0000-4000-8000-${String(t).padStart(12, '0')}`)))}, true) \\g /dev/null`, `set local role authenticated; set local statement_timeout = '8s'; set local lock_timeout = '8s';`);
    }
    return out.join('\n');
  };
  const recLines = Array.from({ length: 50 }, (_, i) => ({ key: `po:conc:${i}`, item_id: `e0000000-0000-4000-8000-${String(2400 - i * 40).padStart(12, '0')}`, qty_base: 10, unit_cost: 2 }));
  const t0 = Date.now();
  const res = await Promise.all([
    ...Array.from({ length: 8 }, (_, t) => job('authenticator', anonSession(`21000000-0000-4000-8000-${String(t + 1).padStart(12, '0')}`), 'authenticated', sales(t + 1))),
    job('authenticator', login(U.boA1), 'authenticated', `select public.approve_stock_count('${cid}', 'Concurrent');`),
    job('authenticator', login(U.boA1), 'authenticated', `select public.stock_receive('${BIG}', 'purchase_order', 'conc', ${jlit(recLines)});`),
    job('postgres', null, null, Array.from({ length: 40 }, (_, i) => `update inventory_item_areas set area_id = ('d0000000-0000-4000-8000-' || lpad('${(i % 6) + 1}', 12, '0'))::uuid where inventory_item_id = ('e0000000-0000-4000-8000-' || lpad('${1 + i * 50}', 12, '0'))::uuid;`).join('\ncommit; begin;\n')),
  ]);
  const ms = Date.now() - t0;
  const errs = res.filter((x) => x.code !== 0).map((x) => x.err.trim().split('\n')[0]);
  ok(errs.length === 0, `no deadlock, no lock or statement timeout, every session finished (${ms} ms)${errs.length ? `: ${errs.slice(0, 3).join(' / ')}` : ''}`);
  ok(sql(`select count(*) from inventory_items i where i.location_id = '${BIG}' and abs(i.on_hand - (select coalesce(sum(qty_base), 0) from stock_movements m where m.location_id = i.location_id and m.inventory_item_id = i.id)) > 0.0001`) === '0', 'I1 still holds');
  ok(sql(`select count(*) from inventory_item_area_stock s where s.location_id = '${BIG}' and abs(s.on_hand - (select coalesce(sum(m.qty_base), 0) from stock_movements m where m.location_id = s.location_id and m.inventory_item_id = s.inventory_item_id and m.area_id = s.area_id)) > 0.0001`) === '0', 'I2 still holds');
  ok(sql(`select status from stock_counts where id = '${cid}'`) === 'APPROVED', 'the count approved');
}

// -- 19b. saves that point at stock items, racing the writers ---------------------------------------
console.log('\n19b. Count sheet, order and invoice saves racing receipts, approvals and sales: no deadlock');
{
  const NAME_ORDER = [I.packed, I.beans, I.cups, I.lastc, I.milk];   // Bottled water, Coffee beans, Cups, Lemons, Milk
  const recvSql = (src, items) => `select public.stock_receive('${A1}', 'purchase_order', '${src}', ${jlit(items.map((it, j) => ({ key: `po:${src}:${j}`, item_id: it, qty_base: 2, unit_cost: 1.5 })))}, null)`;
  const invSql = (no, items) => `select public.stock_post_invoice('${A1}', ${jlit({ supplier_id: SUP.a1, invoice_number: no })}, ` +
    `${jlit(items.map((it) => ({ matched_item_id: it, description: 'x', qty: 1, unit: 'each', unit_price: 1 })))}, ` +
    `${jlit(items.map((it, j) => ({ item_id: it, qty_base: 1, unit_cost: 1, line_index: j })))}, null)`;
  const sheetSql = (cid, items) => 'insert into stock_count_lines (location_id, count_id, inventory_item_id, sort_order) values ' +
    items.map((it, j) => `('${A1}', '${cid}', '${it}', ${j})`).join(', ');
  const headCount = () => { const cid = randomUUID(); sql(`insert into stock_counts (id, location_id, status) values ('${cid}', '${A1}', 'DRAFT')`); return cid; };

  // D1: a till sale holds Milk; a receipt of Milk and Beans waits on it; a count sheet saved in one
  // statement in name order (Beans, Cups, Milk) arrives. Before the fix the receipt held Beans FOR
  // UPDATE while the save held its key share on Beans and waited for Milk: a deadlock.
  {
    const cid = headCount();
    const T = session('tillA1');
    const t1 = T.run(post(A1, I.milk, -1, 'SALE_DEPLETION', { key: 'sale:d1x', srcId: 'd1x' }));
    await T.wait(t1);
    const R = session('boA1'); const r1 = R.run(recvSql('d1x', [I.milk, I.beans]));
    await sleep(300);
    const S = session('boA1'); const s1 = S.run(sheetSql(cid, [I.beans, I.cups, I.milk]));
    await sleep(300);
    await T.end('commit');
    await Promise.all([(async () => { await R.wait(r1); await R.end(R.code() ? 'rollback' : 'commit'); })(),
                       (async () => { await S.wait(s1); await S.end(S.code() ? 'rollback' : 'commit'); })()]);
    ok(!R.code() && !S.code(), `D1: the receipt and the count sheet save both finish (receipt ${R.code() || 'ok'}, save ${S.code() || 'ok'})`);
  }
  // D2: two invoices with the same items while a Back Office item edit holds Milk.
  {
    const E = session('boA1'); const e1 = E.run(`update inventory_items set name = name where id = '${I.milk}'`);
    await E.wait(e1);
    const X = session('boA1'); const x1 = X.run(invSql('D2-X', [I.milk, I.beans]));
    await sleep(300);
    const Y = session('boA1'); const y1 = Y.run(invSql('D2-Y', [I.milk, I.beans]));
    await sleep(300);
    await E.end('commit');
    await Promise.all([(async () => { await X.wait(x1); await X.end(X.code() ? 'rollback' : 'commit'); })(),
                       (async () => { await Y.wait(y1); await Y.end(Y.code() ? 'rollback' : 'commit'); })()]);
    ok(!X.code() && !Y.code(), `D2: both invoices post (${X.code() || 'ok'}, ${Y.code() || 'ok'})`);
  }
  // N2: two invoices fired together, same 3 items in opposite orders, 30 rounds (an invoice inserts
  // its lines, a key share in line order, then locks the items in id order).
  {
    const errs = {};
    for (let k = 0; k < 30; k++) {
      const items = [I.milk, I.beans, I.cups];
      const res = await Promise.all([oneShot('boA1', invSql(`N2-${k}-a`, items)), oneShot('boA1', invSql(`N2-${k}-b`, [...items].reverse()))]);
      for (const x of res) if (x.code !== 0) errs[x.sqlstate || 'other'] = (errs[x.sqlstate || 'other'] || 0) + 1;
    }
    ok(Object.keys(errs).length === 0, `N2: 60 invoices in pairs, no deadlock, no timeout (${JSON.stringify(errs)})`);
  }
  // N: the natural mix, 8 sessions: one statement count sheet saves (name order), order line saves,
  // receipts and invoices (items shuffled), item waste, till sales, count approvals.
  {
    const WORKERS = 8; const ITER = QUICK ? 20 : 40;
    const cids = Array.from({ length: WORKERS * ITER }, () => headCount());
    const pos = Array.from({ length: WORKERS * ITER }, () => { const pid = randomUUID(); sql(`insert into purchase_orders (id, location_id, supplier_id, status) values ('${pid}', '${A1}', '${SUP.a1}', 'DRAFT')`); return pid; });
    const errs = {}; const byKind = {}; let calls = 0;
    const worker = async (w) => {
      const R = rng(SEED + 4242 + w);
      for (let k = 0; k < ITER; k++) {
        const roll = R(); let kind; let who = 'boA1'; let body;
        const shuffled = [...NAME_ORDER].sort(() => R() - 0.5);
        if (roll < 0.25) { kind = 'sale'; who = 'tillA1'; body = 'select 1;' + shuffled.slice(0, 3).sort().map((it, j) => post(A1, it, -1, 'SALE_DEPLETION', { key: `s19b:${w}:${k}:${j}`, srcId: `n${w}_${k}` })).join(';'); }
        else if (roll < 0.43) { kind = 'countSave'; body = sheetSql(cids[w * ITER + k], NAME_ORDER); }
        else if (roll < 0.50) { kind = 'approve'; const c = cids[(w * ITER + k + 7) % cids.length]; body = `update stock_count_lines set counted_qty = 1 where count_id = '${c}'; select public.approve_stock_count('${c}', 'N')`; }
        else if (roll < 0.58) { kind = 'poSave'; body = 'insert into po_lines (location_id, po_id, inventory_item_id, qty_packs, sort_order) values ' + NAME_ORDER.map((it, j) => `('${A1}', '${pos[w * ITER + k]}', '${it}', 1, ${j})`).join(', '); }
        else if (roll < 0.72) { kind = 'receive'; body = recvSql(`n19b${w}_${k}`, shuffled); }
        else if (roll < 0.86) { kind = 'invoice'; body = invSql(`N19b-${w}-${k}`, shuffled.slice(0, 3)); }
        else { kind = 'waste'; const it = shuffled[0]; body = `select public.stock_record_waste('${A1}', ${jlit({ id: randomUUID(), kind: 'item', inventory_item_id: it, qty: 1, qty_base: 1 })}, ${jlit([{ item_id: it, qty_base: 1 }])})`; }
        calls++;
        const x = await oneShot(who, body);
        if (x.code !== 0) {
          const code = x.sqlstate || 'other';
          // an approval of a sheet another worker has not saved yet answers "nothing counted": not a fault
          if (!(kind === 'approve' && !x.sqlstate)) { errs[code] = (errs[code] || 0) + 1; byKind[kind] = (byKind[kind] || 0) + 1; }
        }
      }
    };
    const t0 = Date.now();
    await Promise.all(Array.from({ length: WORKERS }, (_, w) => worker(w)));
    ok(Object.keys(errs).length === 0, `N: ${calls} calls from ${WORKERS} sessions in ${Math.round((Date.now() - t0) / 1000)} s: no deadlock (40P01), no timeout (57014, 55P03) (${JSON.stringify(errs)} ${JSON.stringify(byKind)})`);
    ok(sql(`select count(*) from inventory_items i where i.location_id = '${A1}' and abs(coalesce(i.on_hand, 0) - coalesce((select sum(m.qty_base) from stock_movements m where m.inventory_item_id = i.id), 0)) > 0.0001`) === '0', 'N: on hand equals the ledger after the run');
  }
}

// -- 20. second run, rollback, guard ---------------------------------------------------------------------
console.log('\n20. A second run, the rollback, the guard');
{
  let r = psql({ args: ['-1', '-f', MIGRATION], allowFail: true });
  ok(r.status === 0, 'a second run passes its own guard and changes nothing it should not');
  ok(md5Of(SIG.core) === md5.core19b, 'the core is still 20261019b after a second run');
  const sums = sql(`select count(*) || '|' || sum(qty_base) from stock_movements`);
  const centralBefore = sql(`select count(*) from stock_depletion_mode where mode in ('central', 'paused')`);
  r = psql({ args: ['-1', '-f', ROLLBACK], allowFail: true });
  const rb = r.stdout.trim().split('\n').pop();
  ok(r.status === 0 && rb === `0|0|0|0|1|1|1|1|1|${centralBefore}`, `the rollback applies and its check reads 0|0|0|0|1|1|1|1|1|${centralBefore}: every venue keeps its central mode (${rb})${r.status ? ` ${(r.stderr || '').slice(0, 300)}` : ''}`);
  ok(md5Of(SIG.core) === md5.core18a && md5Of(SIG.leg) === md5.leg18c && md5Of(SIG.counted) === md5.counted18c && md5Of(SIG.rehome) === md5.rehome16 && md5Of(SIG.weekday2) === md5.weekday, 'every function text is back exactly (md5)');
  ok(md5Of(SIG.psm) === md5.psm18c && md5Of(SIG.sweep) === md5.sweep18c && md5Of(SIG.sw) === md5.sw18c, 'and 20261018c is untouched (door, sweep, switch)');
  ok(sql(`select count(*) || '|' || sum(qty_base) from stock_movements`) === sums, 'the ledger is untouched by the rollback');
  const t = asCaller('tillA1', post(A1, I.milk, -1, 'SALE_DEPLETION', { key: `sale:chk-rb:${I.milk}` }));
  ok(t.status === 0, 'a till still posts after the rollback');
  r = psql({ args: ['-1', '-f', MIGRATION], allowFail: true });
  ok(r.status === 0 && md5Of(SIG.core) === md5.core19b, 'the migration applies again after the rollback');
  // the guard refuses a changed function, with nothing changed
  baseDb('p0_guard');
  sql(`create or replace function public.inventory_item_areas_rehome() returns trigger language plpgsql as $$ begin return new; end $$;`);
  r = psql({ args: ['-1', '-f', MIGRATION], allowFail: true });
  ok(r.status !== 0 && /Send this line to Claude/.test(r.stderr) && /inventory_item_areas_rehome/.test(r.stderr), 'the guard stops the file and names the function that differs');
  ok(sql(`select count(*) from pg_proc where proname = 'approve_stock_count'`) === '0', 'and nothing was changed');
  baseDb('p0_no18a');
  sql(`drop function public._post_stock_movement(uuid,uuid,numeric,text,numeric,text,text,text,timestamptz,uuid,text,uuid) cascade`);
  r = psql({ args: ['-1', '-f', MIGRATION], allowFail: true });
  ok(r.status !== 0 && /Run 20261018a/.test(r.stderr), 'without 20261018a the file stops and says to run it first');
}

// -- 21. on top of central stock for every venue (20261019) ----------------------------------------
console.log('\n21. On top of 20261019 (every venue central): modes untouched, a back out, a second paste of 20261018c, till waste, late sales');
{
  baseDb('p0_auto', { centralDefault: true });
  const A3 = id('a3000000', 'a3');
  const R = { flat: id('83000000', '1'), flat2: id('83000000', '2'), b1: id('83000000', '3'), empty: id('83000000', '4') };
  const cc = (who, loc, cid, items, { at = 'now()', ot = 'dine-in' } = {}) =>
    asCaller(who, `insert into closed_checks (id, location_id, items, order_type, closed_at, ref) values ('${cid}', '${loc}', ${jlit(items)}, '${ot}', ${at}, '${cid}')`);
  const drain = () => psql({ input: 'call public.stock_outbox_drain(5, 50, 0.05, true);\n' });
  const modeRow = (loc) => sql(`select coalesce((select mode || '|' || coalesce(changed_by, '') from stock_depletion_mode where location_id = '${loc}'), 'none')`);
  const outbox = (loc) => num(`select count(*) from stock_outbox where location_id = '${loc}'`);
  const modes = () => sql(`select string_agg(location_id || ':' || mode || ':' || coalesce(central_since::text, '') || ':' || coalesce(changed_by, ''), ',' order by location_id) from stock_depletion_mode`);
  // As live on 19 Oct: 20261019 switched every venue to central; B1 (another company) is backed out.
  sql(`insert into recipes (id, location_id, name, wastage_pct) values ('${R.flat}', '${A1}', 'Flat white', 50), ('${R.flat2}', '${A2}', 'Flat white', 0), ('${R.b1}', '${B1}', 'Milk', 0), ('${R.empty}', '${A1}', 'Takeaway only', 0);
       insert into recipe_lines (location_id, recipe_id, component_item_id, qty, unit) values
         ('${A1}', '${R.flat}', '${I.milk}', 200, 'ml'), ('${A1}', '${R.flat}', '${I.beans}', 18, 'g'),
         ('${A2}', '${R.flat2}', '${I.milk2}', 0.2, 'l'), ('${B1}', '${R.b1}', '${I.b1}', 100, 'ml');
       insert into recipe_lines (location_id, recipe_id, component_item_id, qty, unit, order_types) values ('${A1}', '${R.empty}', '${I.cups}', 1, 'each', '["takeaway"]');
       insert into menu_item_recipes (location_id, menu_item_id, recipe_id) values
         ('${A1}', 'mi-flat', '${R.flat}'), ('${A1}', 'mi-empty', '${R.empty}'), ('${A2}', 'mi-flat2', '${R.flat2}'), ('${B1}', 'mi-b1', '${R.b1}');
       select public.stock_central_switch('${B1}', 'browser', 'peter');`);
  ok(modeRow(A1) === 'central|default 20261019' && modeRow(A2) === 'central|default 20261019' && modeRow(B1) === 'browser|peter', 'before: every venue central by 20261019, B1 backed out by hand');
  const before = modes();
  const applied = psql({ args: ['-1', '-f', MIGRATION], allowFail: true });
  ok(applied.status === 0, `20261019b applies on top of 20261018c and 20261019${applied.status ? ` ${(applied.stderr || '').slice(0, 400)}` : ''}`);
  ok(modes() === before, '20261019b changes no venue\'s mode, central_since or who changed it (the backed out venue stays backed out)');
  ok(outbox(A1) === 0 && outbox(A2) === 0, 'and queues nothing');

  // trading at Location 2: the database books the sale; the till's own post is answered skipped
  cc('service', A2, 'chk-d1', [{ itemId: 'mi-flat2', qty: 2 }]);
  ok(num(`select count(*) from stock_outbox where location_id = '${A2}' and check_id = 'chk-d1'`) === 1, 'a new check at Location 2 is queued by the trigger');
  let r = callJ('service', post(A2, I.milk2, -0.4, 'SALE_DEPLETION', { key: `sale:chk-d1:${I.milk2}`, srcId: 'chk-d1' }));
  ok(r.j?.skipped === 'central', `the till path is answered skipped central (${JSON.stringify(r.j)})`);
  drain();
  ok(near(onHand(I.milk2), -0.4) && onHand(I.milk2) === ledger(I.milk2), `the drainer took it off once (on hand ${onHand(I.milk2)})`);

  // a new venue is central from the moment it is created (20261019's trigger); a first recipe link
  // changes nothing (20261019b adds no trigger of its own)
  sql(`insert into locations (id, org_id, name, timezone, created_at) values ('${A3}', '${ORG_A}', 'New site', 'Europe/London', now())`);
  const a3 = modeRow(A3);
  sql(`insert into recipes (id, location_id, name) values ('${id('83000000', '31')}', '${A3}', 'Oat latte');
       insert into menu_item_recipes (location_id, menu_item_id, recipe_id) values ('${A3}', 'mi-new', '${id('83000000', '31')}');`);
  ok(a3 === 'central|new venue' && modeRow(A3) === a3 && num(`select count(*) from pg_trigger where tgrelid = 'public.menu_item_recipes'::regclass and not tgisinternal and tgname like '%central%'`) === 0,
    `a new venue is central when created (${a3}); its first recipe link leaves the row alone`);

  // the back out: a venue on the till path stays there and the till posts as before
  const nb = outbox(B1);
  cc('service', B1, 'chk-b1', [{ itemId: 'mi-b1', qty: 1 }]);
  r = callJ('service', post(B1, I.b1, -100, 'SALE_DEPLETION', { key: `sale:chk-b1:${I.b1}`, srcId: 'chk-b1' }));
  ok(outbox(B1) === nb && r.j?.id && near(onHand(I.b1), -100), 'a venue backed out to the till path: nothing queued, the till posts as before');

  // A second paste of 20261019b changes no mode
  const m2 = modes();
  const again = psql({ args: ['-1', '-f', MIGRATION], allowFail: true });
  ok(again.status === 0 && modes() === m2, 'a second paste of 20261019b changes no venue\'s mode');
  // A second paste of 20261018c stops with nothing changed: 20261019b's rules stay
  const fnBefore = [md5Of(SIG.core), md5Of(SIG.leg), md5Of(SIG.counted), md5Of(SIG.psm), md5Of(SIG.sweep)].join(',');
  const modesBefore = modes();
  const c2 = psql({ args: ['-1', '-f', CENTRAL], allowFail: true });
  ok(c2.status !== 0 && /Nothing was changed/.test(c2.stderr) && /post_stock_transfer_leg/.test(c2.stderr), `a second paste of 20261018c stops at its guard with "Nothing was changed" (${(c2.stderr || '').split('\n').find((x) => /ERROR/.test(x)) || ''})`);
  ok([md5Of(SIG.core), md5Of(SIG.leg), md5Of(SIG.counted), md5Of(SIG.psm), md5Of(SIG.sweep)].join(',') === fnBefore && modes() === modesBefore,
    'and it changed nothing: functions and modes as they were');
  ok(sql(`select mode from stock_depletion_default`) === 'browser', '20261018c\'s own self test rule still holds (the default stays browser)');

  // Waste on the till: the database explodes the one product (no recipe book read), never refused
  const w1 = randomUUID();
  const m0 = onHand(I.milk), b0 = onHand(I.beans);
  r = callJ('tillA1', `select public.stock_record_waste('${A1}', ${jlit({ id: w1, kind: 'menu', menu_item_id: 'mi-flat', item_name: 'Flat white', qty: 2, reason: 'Dropped', sale_value: 7, source: 'pos' })}, null)`);
  ok(r.j?.ok === true && r.j?.posted === 2 && r.j?.tag === null && near(onHand(I.milk), m0 - 400) && near(onHand(I.beans), b0 - 0.036),
    `the till sends the product only; the database takes off 2 x the recipe, wastage % 50 NOT applied to quantity (milk ${m0 - onHand(I.milk)} ml, beans ${Math.round((b0 - onHand(I.beans)) * 1000) / 1000} kg)`);
  ok(sql(`select menu_item_id || '|' || no_recipe from waste_events where id = '${w1}'`) === 'mi-flat|false', 'the waste row carries the product id');
  const wBefore = num(`select count(*) from waste_events`), mBefore = num(`select count(*) from stock_movements`);
  r = callJ('tillA1', `select public.stock_record_waste('${A1}', ${jlit({ kind: 'menu', menu_item_id: 'mi-flat', qty: 1, preview: true })}, null)`);
  ok(r.j?.preview === true && r.j?.lines?.length === 2 && near(r.j.lines.find((l) => l.item_id === I.milk)?.qty_base, 200) && r.j?.linked === true
     && num(`select count(*) from waste_events`) === wBefore && num(`select count(*) from stock_movements`) === mBefore,
    `the till's preview of one product: its lines and cost from the database, nothing written (${JSON.stringify(r.j?.lines?.map((l) => [l.name, l.qty_base]))})`);
  r = callJ('stranger', `select public.stock_record_waste('${A1}', ${jlit({ kind: 'menu', menu_item_id: 'mi-flat', qty: 1, preview: true })}, null)`);
  ok(r.sqlstate === '42501', `a stranger cannot read a venue's recipe through the preview (${r.sqlstate})`);
  r = callJ('tillA1', `select public.stock_record_waste('${A1}', ${jlit({ kind: 'menu', menu_item_id: 'mi-none', item_name: 'Toast', qty: 1, source: 'pos' })}, null)`);
  ok(r.j?.ok === true && r.j?.posted === 0 && r.j?.tag === 'no_recipe' && r.j?.no_recipe === true, 'a product with no recipe: recorded, tagged "No recipe: stock not taken off", never refused');
  r = callJ('tillA1', `select public.stock_record_waste('${A1}', ${jlit({ kind: 'menu', menu_item_id: 'mi-empty', item_name: 'Cup only', qty: 1, source: 'pos' })}, null)`);
  ok(r.j?.ok === true && r.j?.posted === 0 && r.j?.tag === 'nothing_to_deduct', 'a recipe that takes nothing off for this order type: recorded, tagged nothing to deduct');

  // Late sales through the drainer: booked once, from the time the line was counted
  const cnt = randomUUID(), lid = randomUUID();
  const ohNow = onHand(I.milk2);
  sql(`insert into stock_counts (id, location_id, status) values ('${cnt}', '${A2}', 'DRAFT');
       insert into stock_count_lines (id, location_id, count_id, inventory_item_id) values ('${lid}', '${A2}', '${cnt}', '${I.milk2}');`);
  asCaller('ownerA', `update stock_count_lines set counted_qty = 10 where id = '${lid}'`);
  sql(`update stock_count_lines set counted_at = now() - interval '10 minutes' where id = '${lid}'`);
  const afterCount = () => num(`select coalesce(sum(qty_base), 0) from stock_movements where inventory_item_id = '${I.milk2}' and occurred_at > (select counted_at from stock_count_lines where id = '${lid}')`);
  r = callJ('ownerA', `select public.approve_stock_count('${cnt}', 'Owner')`);
  ok(r.j?.ok === true && near(onHand(I.milk2), 10 + afterCount()), `the count approves: on hand ${onHand(I.milk2)} = counted 10 plus what moved after the count (was ${ohNow})`);
  const oh1 = onHand(I.milk2);
  cc('service', A2, 'chk-l1', [{ itemId: 'mi-flat2', qty: 1 }], { at: `now() - interval '15 minutes'` });
  cc('service', A2, 'chk-l2', [{ itemId: 'mi-flat2', qty: 1 }], { at: `now() - interval '5 minutes'` });
  drain();
  ok(num(`select count(*) from stock_movements where idempotency_key = 'late:sale:chk-l1:${I.milk2}' and source_type = 'late_sale'`) === 1, 'a sale closed before the line was counted, drained after the approval: one "Late sale before count", booked once');
  ok(num(`select count(*) from stock_movements where idempotency_key = 'late:sale:chk-l2:${I.milk2}'`) === 0, 'a sale closed after the line was counted (before the approval) stands: no late adjustment (20261018c alone would have cancelled it)');
  ok(near(onHand(I.milk2), oh1 - 0.2) && near(onHand(I.milk2), 10 + afterCount()) && onHand(I.milk2) === ledger(I.milk2), `on hand = counted 10 plus every movement after the count, the late one netted (${onHand(I.milk2)})`);
  ok(near(num(`select coalesce(sum(qty_base), 0) from stock_movements where inventory_item_id = '${I.milk2}' and occurred_at <= (select counted_at from stock_count_lines where id = '${lid}')`), 10), 'the ledger at the counted moment is what was counted (I6)');
}

// -- 22. the guard needs 20261018c -----------------------------------------------------------------------
console.log('\n22. Without 20261018c the file stops');
{
  baseDb('p0_no18c', { central: false });
  const r = psql({ args: ['-1', '-f', MIGRATION], allowFail: true });
  ok(r.status !== 0 && /Run 20261018c/.test(r.stderr) && sql(`select count(*) from pg_proc where proname = 'approve_stock_count'`) === '0', 'without 20261018c the file stops, says to run it first, and changes nothing');
}

stop();
console.log(`\n${checks - failures} of ${checks} checks hold${failures ? `, ${failures} FAILED` : ''}.`);
process.exit(failures ? 1 : 0);
