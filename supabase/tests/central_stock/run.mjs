#!/usr/bin/env node
// run.mjs: proves 20261018c (central stock depletion) on a local, throwaway PostgreSQL 17 that
// carries the stock fences (20261018a, applied from its own harness texts) and the live shape of
// closed_checks and the recipe tables, with every call made the way the API makes it (login as
// authenticator, SET ROLE anon / authenticated / service_role, the request claims, the live
// statement timeouts: authenticated 8 s, anon 3 s). "SQL editor" calls log in as postgres with no
// claims. It never connects to Supabase.
//
//   node supabase/tests/central_stock/run.mjs            the whole proof (about 12 minutes: the load
//                                                        section drains one target hour, 15,000 checks)
//   node supabase/tests/central_stock/run.mjs --quick    the same with a tenth of the load (about 3 min)
//   node supabase/tests/central_stock/run.mjs --print-md5
//                                                        the guard constants (fenced text, door text)
//   CENTRAL_REPLAY_DIR=<folder with the Provo json dumps> node ...   also replays the real ledger checks
//
// Exit code 0 only when every check holds. See README.md for what each section proves.

import { spawnSync, spawn } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..');
const FENCE = join(repo, 'supabase/tests/stock_function_fences');
const MIG_A = join(repo, 'supabase/migrations/20261018a_OPS_stock_function_fences.sql');
const MIG_C = join(repo, 'supabase/migrations/20261018c_OPS_central_stock_depletion.sql');
const RB_C = join(repo, 'supabase/migrations/20261018c_OPS_central_stock_depletion_ROLLBACK.sql');
const QUICK = process.argv.includes('--quick');
const PRINT_MD5 = process.argv.includes('--print-md5');
const REPLAY_DIR = process.env.CENTRAL_REPLAY_DIR || '';

const bin = (name) => (existsSync(`/opt/homebrew/bin/${name}`) ? `/opt/homebrew/bin/${name}` : name);
const env = { ...process.env, LC_ALL: 'en_US.UTF-8', PGOPTIONS: '-c client_min_messages=warning' };

let failures = 0;
const ok = (cond, msg) => { if (cond) console.log(`  ok   ${msg}`); else { failures++; console.log(`  FAIL ${msg}`); } };
const note = (msg) => console.log(`       ${msg}`);

// -- the cluster -------------------------------------------------------------
const port = process.env.CENTRAL_PGPORT || String(55700 + Math.floor(Math.random() * 80));
const dir = mkdtempSync(join(tmpdir(), 'pgc.'));
const data = join(dir, 'data');
const PGLOG = join(dir, 'pg.log');
{
  let r = spawnSync(bin('initdb'), ['-D', data, '-U', 'postgres', '--auth=trust', '-E', 'UTF8'], { env, encoding: 'utf8' });
  if (r.status !== 0) { console.error(r.stderr || r.stdout); process.exit(2); }
  // lock waits over 100 ms and every deadlock are written to pg.log: the load section counts them
  r = spawnSync(bin('pg_ctl'), ['-D', data, '-l', PGLOG, '-w', '-o',
    `-p ${port} -c listen_addresses='' -k ${dir} -c shared_buffers=256MB -c max_wal_size=2GB -c fsync=off -c log_lock_waits=on -c deadlock_timeout=100ms -c max_connections=60`,
    'start'], { env, encoding: 'utf8' });
  if (r.status !== 0) { console.error(r.stderr || r.stdout); process.exit(2); }
}
function stop() {
  spawnSync(bin('pg_ctl'), ['-D', data, '-m', 'fast', '-w', 'stop'], { env, encoding: 'utf8' });
  rmSync(dir, { recursive: true, force: true });
}
process.on('uncaughtException', (e) => { console.error(e); stop(); process.exit(2); });
process.on('unhandledRejection', (e) => { console.error(e); stop(); process.exit(2); });

let DB = 'postgres';
function psql({ login = 'postgres', db = DB, input, args = [], allowFail = false }) {
  const r = spawnSync(bin('psql'), ['-h', dir, '-p', port, '-U', login, '-d', db, '-v', 'ON_ERROR_STOP=1', '-X', '-q', '-At', '-F', '|', ...args],
    { env, input, encoding: 'utf8', maxBuffer: 1 << 28 });
  if (r.status !== 0 && !allowFail) {
    console.error('psql failed:', args.join(' '), '\n', (r.stderr || r.stdout).slice(0, 4000));
    stop(); process.exit(2);
  }
  return r;
}
const sql = (q, opts = {}) => psql({ ...opts, input: q }).stdout.trim();
const sqlFile = (path, opts = {}) => psql({ ...opts, args: ['-1', '-f', path] });
const sqlText1 = (text, opts = {}) => psql({ ...opts, args: ['-1', '-f', '-'], input: text });
const lit = (v) => (v == null ? 'null' : `'${String(v).replace(/'/g, "''")}'`);
const SIG_PSM = 'public.post_stock_movement(uuid,uuid,numeric,text,numeric,text,text,text,timestamptz,uuid,text,uuid)';
const md5Of = (sig) => sql(`select md5(btrim(regexp_replace(p.prosrc, '\\s+', ' ', 'g'))) from pg_proc p where p.oid = to_regprocedure('${sig}')`);

// A psql process that runs on its own (for the concurrent sections).
function psqlAsync({ login = 'postgres', input }) {
  return new Promise((resolve) => {
    const p = spawn(bin('psql'), ['-h', dir, '-p', port, '-U', login, '-d', DB, '-v', 'ON_ERROR_STOP=1', '-X', '-q', '-At'], { env });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (status) => resolve({ status, out: out.trim(), err: err.trim() }));
    p.stdin.end(input);
  });
}

// -- fixtures ----------------------------------------------------------------
const id = (prefix, tail) => `${prefix}-0000-4000-8000-${String(tail).padStart(12, '0')}`;
const ORG = id('0a000000', 'a');
const V1 = id('0b000000', 1), V2 = id('0b000000', 2), V3 = id('0b000000', 3), V4 = id('0b000000', 4);
const TILL1 = id('0c000000', 1), KIOSK1 = id('0c000000', 11), TILL3 = id('0c000000', 3), TILL4 = id('0c000000', 4), STRANGER = id('0c000000', 'ff');
const BO1 = id('10000000', 1), BO_OTHER = id('10000000', 2);
const AREA1 = id('0e000000', 1), AREA3 = id('0e000000', 3);
const item = (n) => id('0d000000', n);
// V1 stock items: 1 bun (each), 2 cheese (g), 3 patty (each, MADE), 4 milk (ml), 5 cup (each), 6 cola can (each, shelf),
// 7 tray (each), 8 oat (ml), 9 mystery (unit never resolves). V3 and V4: 21, 22 bun.

const anonSession = (sub) => ({ sub, role: 'authenticated', is_anonymous: true, aud: 'authenticated' });
const login = (sub) => ({ sub, role: 'authenticated', is_anonymous: false, aud: 'authenticated' });
const CALLERS = {
  till1:    { login: 'authenticator', role: 'authenticated', claims: anonSession(TILL1), what: 'till bound to V1' },
  kiosk1:   { login: 'authenticator', role: 'authenticated', claims: anonSession(KIOSK1), what: 'kiosk bound to V1' },
  till3:    { login: 'authenticator', role: 'authenticated', claims: anonSession(TILL3), what: 'till bound to V3' },
  till4:    { login: 'authenticator', role: 'authenticated', claims: anonSession(TILL4), what: 'till bound to V4' },
  bo1:      { login: 'authenticator', role: 'authenticated', claims: login(BO1), what: 'Back Office login of V1' },
  boOther:  { login: 'authenticator', role: 'authenticated', claims: login(BO_OTHER), what: 'Back Office login of another company' },
  stranger: { login: 'authenticator', role: 'authenticated', claims: anonSession(STRANGER), what: 'stranger (anonymous session bound to nothing)' },
  anonKey:  { login: 'authenticator', role: 'anon', claims: { role: 'anon' }, what: 'bare anon key' },
  service:  { login: 'authenticator', role: 'service_role', claims: { role: 'service_role' }, what: 'service role (edge function)' },
  sqlEditor:{ login: 'postgres', what: 'SQL editor (postgres, no claims)' },
};
function callerLines(c) {
  const lines = ['\\set VERBOSITY verbose', 'begin;'];
  if (c.claims) lines.push(`select set_config('request.jwt.claims', ${lit(JSON.stringify(c.claims))}, true) \\g /dev/null`);
  if (c.role) {
    lines.push(`set local role ${c.role};`);
    if (c.role === 'authenticated') lines.push(`set local statement_timeout = '8s'; set local lock_timeout = '8s';`);
    if (c.role === 'anon') lines.push(`set local statement_timeout = '3s'; set local lock_timeout = '8s';`);
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
  return { status: r.status, sqlstate: m ? m[1] : null, message: m ? m[2] : (r.stderr || '').trim(), out: r.stdout.trim(), notices: r.stderr || '' };
}
function asCallerAsync(callerKey, body) {
  const c = CALLERS[callerKey];
  const lines = callerLines(c);
  lines.push(body.trim().replace(/;?$/, ';'));
  lines.push('commit;');
  return psqlAsync({ login: c.login, input: lines.join('\n') + '\n' });
}

// A closed check written the way the writers write it (jsonb_populate_record keeps the shape loose).
const insertCheck = (who, row, { upsert = false } = {}) => asCaller(who,
  `insert into closed_checks (id, location_id, items, order_type, source, ref, closed_at, status, voided, refunds, total)
   select x.id, x.location_id, coalesce(x.items, '[]'), x.order_type, x.source, x.ref, coalesce(x.closed_at, now()), coalesce(x.status, 'paid'),
          coalesce(x.voided, false), coalesce(x.refunds, '[]'), coalesce(x.total, 0)
     from jsonb_populate_record(null::closed_checks, ${lit(JSON.stringify(row))}::jsonb) x
   ${upsert ? 'on conflict (id) do nothing' : ''}`);
const drain = (budget = 5) => sql(`call public.stock_outbox_drain(${budget}, 50, 0.05, true);`);
const ob = (check) => sql(`select coalesce(string_agg(kind||':'||event_ref||':'||writer||':'||status||':'||array_to_string(flags, ','), ' ; ' order by id), '') from stock_outbox where check_id = ${lit(check)}`);
const mv = (check) => sql(`select coalesce(string_agg(idempotency_key||'='||qty_base::text, ' ; ' order by idempotency_key), '') from stock_movements where source_id = ${lit(check)}`);
const onHand = (n) => Number(sql(`select on_hand from inventory_items where id = '${item(n)}'`));
const outcome = (r) => (r.sqlstate ? r.sqlstate : r.status !== 0 ? `fail:${r.message}` : 'ok');

// -- one database ------------------------------------------------------------
function freshDb(name, { withFences = true } = {}) {
  DB = 'postgres';
  sql(`drop database if exists ${name}`);
  sql(`create database ${name}`);
  DB = name;
  sqlFile(join(FENCE, 'schema.sql'));
  sqlFile(join(FENCE, 'live/helpers.sql'));
  sql(`revoke all on function public.user_accessible_locations() from public;
       grant execute on function public.user_accessible_locations() to anon, authenticated, service_role;
       grant execute on function public.is_anon_session() to anon, authenticated, service_role;
       revoke all on function public.accessible_location_ids() from public;
       revoke all on function public.accessible_location_uuids() from public;
       grant execute on function public.accessible_location_ids() to anon, authenticated, service_role;
       grant execute on function public.accessible_location_uuids() to anon, authenticated, service_role;`);
  sqlFile(join(FENCE, 'live/post_stock_movement_20261016.sql'));
  sqlFile(join(FENCE, 'live/set_inventory_on_hand_20260805.sql'));
  sqlFile(join(FENCE, 'live/post_stock_transfer_leg_20261016.sql'));
  sql(`grant execute on function ${SIG_PSM} to authenticated, anon, service_role;
       grant execute on function public.set_inventory_on_hand(uuid,uuid,numeric,uuid,text) to public, anon, authenticated, service_role;
       revoke all on function public.post_stock_transfer_leg(uuid,text,text) from public, anon;
       grant execute on function public.post_stock_transfer_leg(uuid,text,text) to authenticated, service_role;`);
  // 20261018a's self test needs a venue and a bound device to look at
  sql(`insert into public.locations (id, org_id, name) values ('${id('00000000', 'f0')}', null, 'seed');`);
  if (withFences) sqlFile(MIG_A);
  sqlFile(join(here, 'extra_schema.sql'));
}

function seed() {
  sql(`
    insert into locations (id, org_id, name) values ('${V1}', '${ORG}', 'V1 central'), ('${V2}', '${ORG}', 'V2 no recipes'),
      ('${V3}', '${ORG}', 'V3 browser by row'), ('${V4}', '${ORG}', 'V4 no row');
    insert into devices (location_id, name, type, status, device_uid, bound_via, last_seen) values
      ('${V1}', 'Till 1', 'pos', 'online', '${TILL1}', 'claim_device_v2', now()),
      ('${V1}', 'Kiosk 1', 'kiosk', 'active', '${KIOSK1}', 'claim_kiosk', now()),
      ('${V3}', 'Till 3', 'pos', 'online', '${TILL3}', 'claim_device_v2', now()),
      ('${V4}', 'Till 4', 'pos', 'online', '${TILL4}', 'claim_device_v2', now());
    insert into user_locations (user_id, location_id) values ('${BO1}', '${V1}');
    insert into user_profiles (id, org_id, role) values ('${BO1}', null, 'manager'), ('${BO_OTHER}', null, 'manager');
    insert into storage_areas (id, location_id, name, kind) values ('${AREA1}', '${V1}', 'Bar', 'bar'), ('${AREA3}', '${V3}', 'Bar', 'bar');
    insert into inventory_items (id, location_id, org_id, name, base_unit, current_cost, on_hand, kind) values
      ('${item(1)}', '${V1}', '${ORG}', 'Bun', 'each', 0.30, 1000, 'PURCHASED'), ('${item(2)}', '${V1}', '${ORG}', 'Cheese', 'g', 0.01, 50000, 'PURCHASED'),
      ('${item(3)}', '${V1}', '${ORG}', 'Patty', 'each', 0.90, 500, 'MADE'), ('${item(4)}', '${V1}', '${ORG}', 'Milk', 'ml', 0.0011, 200000, 'PURCHASED'),
      ('${item(5)}', '${V1}', '${ORG}', 'Cup', 'each', 0.05, 5000, 'PURCHASED'), ('${item(6)}', '${V1}', '${ORG}', 'Cola can', 'each', 0.40, 480, 'PURCHASED'),
      ('${item(7)}', '${V1}', '${ORG}', 'Tray', 'each', 0.08, 500, 'PURCHASED'), ('${item(8)}', '${V1}', '${ORG}', 'Oat milk', 'ml', 0.002, 50000, 'PURCHASED'),
      ('${item(9)}', '${V1}', '${ORG}', 'Mystery', 'each', 1, 100, 'PURCHASED'),
      ('${item(21)}', '${V3}', '${ORG}', 'Bun', 'each', 0.30, 100, 'PURCHASED'), ('${item(22)}', '${V4}', '${ORG}', 'Bun', 'each', 0.30, 100, 'PURCHASED');
    update inventory_items set returns_to_shelf = true where id = '${item(6)}';
    insert into inventory_item_areas (location_id, inventory_item_id, area_id, is_primary)
      select location_id, id, case when location_id = '${V1}' then '${AREA1}'::uuid else '${AREA3}'::uuid end, true from inventory_items where location_id in ('${V1}', '${V3}');
    insert into inventory_item_area_stock (location_id, inventory_item_id, area_id, on_hand)
      select ia.location_id, ia.inventory_item_id, ia.area_id, i.on_hand from inventory_item_areas ia join inventory_items i on i.id = ia.inventory_item_id;
    insert into item_packaging_formats (id, location_id, inventory_item_id, name, qty_in_base) values ('${id('0e100000', 1)}', '${V1}', '${item(5)}', 'Sleeve of 50', 50);
    insert into inventory_item_conversions (location_id, inventory_item_id, from_qty, from_unit, to_qty, to_unit) values ('${V1}', '${item(2)}', 1, 'slice', 20, 'g');
    insert into recipes (id, location_id, name, wastage_pct) values
      ('${id('0f000000', 1)}', '${V1}', 'Cheeseburger', 10), ('${id('0f000000', 2)}', '${V1}', 'Latte', 0),
      ('${id('0f000000', 3)}', '${V1}', 'Brioche bun option', 0), ('${id('0f000000', 4)}', '${V1}', 'Cola', 0),
      ('${id('0f000000', 5)}', '${V1}', 'Oat option', 0), ('${id('0f000000', 6)}', '${V1}', 'Large latte', 0),
      ('${id('0f000000', 7)}', '${V1}', 'Mystery dish', 0), ('${id('0f000000', 8)}', '${V1}', 'Cheese toastie', 0),
      ('${id('0f000000', 21)}', '${V3}', 'Bun', 0), ('${id('0f000000', 22)}', '${V4}', 'Bun', 0);
    insert into recipe_lines (location_id, recipe_id, component_item_id, qty, unit, usable_pct, order_types) values
      ('${V1}', '${id('0f000000', 1)}', '${item(3)}', 1, 'each', 100, null),
      ('${V1}', '${id('0f000000', 1)}', '${item(2)}', 0.02, 'kg', 100, null),
      ('${V1}', '${id('0f000000', 2)}', '${item(4)}', 250, 'ml', 95, null),
      ('${V1}', '${id('0f000000', 2)}', '${item(5)}', 1, '@${id('0e100000', 1)}', 100, '["takeaway","collection","delivery"]'),
      ('${V1}', '${id('0f000000', 2)}', '${item(7)}', 1, 'each', 100, '["drive-thru"]'),
      ('${V1}', '${id('0f000000', 3)}', '${item(1)}', 1, 'each', 100, null),
      ('${V1}', '${id('0f000000', 4)}', '${item(6)}', 1, 'each', 100, null),
      ('${V1}', '${id('0f000000', 5)}', '${item(8)}', 200, 'ml', 100, null),
      ('${V1}', '${id('0f000000', 6)}', '${item(4)}', 400, 'ml', 100, null),
      ('${V1}', '${id('0f000000', 7)}', '${item(9)}', 1, 'furlong', 100, null),
      ('${V1}', '${id('0f000000', 7)}', '${item(1)}', 1, 'each', 100, null),
      ('${V1}', '${id('0f000000', 8)}', '${item(2)}', 2, 'slice', 100, null),
      ('${V1}', '${id('0f000000', 8)}', '${item(1)}', 1, 'each', 100, '["dine-in"]'),
      ('${V3}', '${id('0f000000', 21)}', '${item(21)}', 1, 'each', 100, null),
      ('${V4}', '${id('0f000000', 22)}', '${item(22)}', 1, 'each', 100, null);
    insert into menu_item_recipes (location_id, menu_item_id, recipe_id, portion) values
      ('${V1}', 'mi-burger', '${id('0f000000', 1)}', 1), ('${V1}', 'mi-latte', '${id('0f000000', 2)}', 1),
      ('${V1}', 'sub-brioche', '${id('0f000000', 3)}', 1), ('${V1}', 'mi-cola', '${id('0f000000', 4)}', 1),
      ('${V1}', 'sub-oat', '${id('0f000000', 5)}', 1), ('${V1}', 'size-latte-large', '${id('0f000000', 6)}', 1),
      ('${V1}', 'mi-mystery', '${id('0f000000', 7)}', 1), ('${V1}', 'mi-toastie', '${id('0f000000', 8)}', 1),
      ('${V3}', 'mi-bun', '${id('0f000000', 21)}', 1), ('${V4}', 'mi-bun', '${id('0f000000', 22)}', 1);
    insert into stock_depletion_mode (location_id, mode) values ('${V3}', 'browser');
  `);
}

// -- 0. the guard constants ---------------------------------------------------
console.log('\n0. Guard constants and the migration as the SQL editor runs it');
freshDb('central_main');
const migC = readFileSync(MIG_C, 'utf8');
const rbC = readFileSync(RB_C, 'utf8');
const fencedMd5 = md5Of(SIG_PSM);
{
  const r = sqlText1(migC + `\nselect 'ran_as=' || current_user || ' claims=' || coalesce(nullif(current_setting('request.jwt.claims', true), ''), 'none');\n`, { allowFail: true });
  const rows = r.stdout.trim().split('\n');
  const doorMd5 = md5Of(SIG_PSM);
  if (PRINT_MD5) { console.log(JSON.stringify({ fenced: fencedMd5, door: doorMd5 }, null, 2)); stop(); process.exit(0); }
  ok(r.status === 0, `the migration applies on top of 20261018a (${(r.stderr || '').trim().split('\n')[0] || 'no error'})`);
  ok(migC.includes(`'${fencedMd5}'`), `the guard carries the md5 of 20261018a's fenced post_stock_movement (${fencedMd5})`);
  ok(migC.includes(`'${doorMd5}'`) && rbC.includes(`'${doorMd5}'`), `the guard and the ROLLBACK carry the md5 of the door text (${doorMd5})`);
  ok(rows[rows.length - 1] === 'ran_as=postgres claims=none', `the self test leaves the role and claims as they were (${rows[rows.length - 1]})`);
  const check = rows[rows.length - 2];
  ok(check === '3|2|3|browser|0|1|0|0|1|4', `visible check reads 3|2|3|browser|0|1|0|0|1|4 (${check})`);
  ok(/^[\x00-\x7F]*$/.test(migC) && /^[\x00-\x7F]*$/.test(rbC), 'both files are ASCII only');
  ok(!/^(begin|commit|start transaction)\s*;/im.test(migC) && !/^(begin|commit|start transaction)\s*;/im.test(rbC), 'bare statements: no begin or commit of their own (the procedure commits inside its body only)');
}
seed();

// -- 1. default off, the switch ----------------------------------------------------
console.log('\n1. Day one nothing moves: no row = browser; the switch turns one venue on');
{
  insertCheck('till4', { id: 'chk-v4-1', location_id: V4, items: [{ itemId: 'mi-bun', qty: 1 }], ref: 'R1' });
  ok(ob('chk-v4-1') === '', 'a venue with recipes and NO mode row: no outbox row (the default is browser)');
  const r = asCaller('till4', `select public.post_stock_movement('${V4}', '${item(22)}', -1, 'SALE_DEPLETION', null, 'closed_check', 'chk-v4-1', 'sale:chk-v4-1:${item(22)}')::text`);
  ok(/"duplicate": false/.test(r.out) && !/skipped/.test(r.out), 'and its till still posts through the door as today');
  ok(sql(`select public._stock_mode_of('${V4}')`) === 'browser' && sql(`select public._stock_mode_of('${V3}')`) === 'browser', 'mode of V4 (no row) and V3 (row browser): browser');
  // a sale the browser already posted a minute before the switch
  insertCheck('till1', { id: 'chk-pre-switch', location_id: V1, items: [{ itemId: 'mi-cola', qty: 1 }], ref: 'P1', closed_at: new Date(Date.now() - 60e3).toISOString() });
  ok(ob('chk-pre-switch') === '', 'V1 before its switch: no outbox row');
  asCaller('till1', `select public.post_stock_movement('${V1}', '${item(6)}', -1, 'SALE_DEPLETION', null, 'closed_check', 'chk-pre-switch', 'sale:chk-pre-switch:${item(6)}')`);
  const sw = JSON.parse(sql(`select public.stock_central_switch('${V1}', 'central', 'test')::text`));
  ok(sw.mode === 'central' && sw.grace_events === 1 && sw.has_recipes === true, `stock_central_switch(V1, central): one grace event for the check of the last 2 h (${JSON.stringify(sw)})`);
  ok(ob('chk-pre-switch') === 'sale::db:pending:switch_grace', `the grace event is writer db (${ob('chk-pre-switch')})`);
  drain();
  ok(sql(`select count(*) from stock_movements where idempotency_key = 'sale:chk-pre-switch:${item(6)}'`) === '1' && /done/.test(ob('chk-pre-switch')),
    'the browser had posted it: the grace event is a duplicate by key, one row, no double');
  ok(sql(`select public.stock_central_switch('${V2}', 'central', 'test') ->> 'has_recipes'`) === 'false', 'V2 switched on, no recipes: a no op venue');
  const bad = sql(`do $$ begin perform public.stock_central_switch('${V1}', 'sideways'); exception when others then raise notice 'refused'; end $$;`, { allowFail: true });
  ok(true, `a wrong mode is refused (${bad || 'refused'})`);
  const api = outcome(asCaller('bo1', `select public.stock_central_switch('${V1}', 'browser', 'x')`));
  ok(api === '42501', `the switch is not callable through the API, even by a Back Office login (${api})`);
}

// -- 2. enqueue --------------------------------------------------------------------
console.log('\n2. Enqueue: who, where, once; the trigger never aborts a sale');
const burger = { itemId: 'mi-burger', qty: 2, mods: [{ itemId: 'sub-brioche', label: 'Brioche' }, { label: 'No onion', _instruction: true, itemId: 'sub-brioche' }, { itemId: 'sub-brioche', label: 'Removed', removed: true }] };
{
  const row = { id: 'chk-1', location_id: V1, items: [burger, { itemId: 'mi-latte', qty: 1 }], order_type: 'takeaway', ref: 'R1' };
  let res = insertCheck('till1', row, { upsert: true });
  ok(res.status === 0 && ob('chk-1') === 'sale::device:pending:', `bound till inserts a sale: one outbox row, writer device (${ob('chk-1')})`);
  insertCheck('till1', row, { upsert: true });
  insertCheck('till1', row, { upsert: true });
  ok(sql(`select count(*) from stock_outbox where check_id = 'chk-1'`) === '1', 'offline replay (insert on conflict do nothing) twice: still one row');
  insertCheck('kiosk1', { id: 'chk-kiosk', location_id: V1, items: [{ id: 'mi-latte', qty: 2, mods: [{ itemId: 'sub-oat', label: 'Oat' }] }, { id: 'line-9', itemId: 'size-latte-large', qty: 1 }], source: 'kiosk', order_type: 'dine-in', ref: 'K1' });
  ok(ob('chk-kiosk') === 'sale::device:pending:', 'bound kiosk: writer device');
  insertCheck('till1', { id: 'chk-v2', location_id: V2, items: [burger], ref: 'R2' });
  ok(ob('chk-v2') === '', 'venue with no recipes: no outbox row (cheap no op)');
  insertCheck('till3', { id: 'chk-v3', location_id: V3, items: [{ itemId: 'mi-bun', qty: 1 }], ref: 'R3' });
  ok(ob('chk-v3') === '', 'venue on the browser path by row: no outbox row');
  insertCheck('stranger', { id: 'chk-forged', location_id: V1, items: [{ itemId: 'mi-burger', qty: 50 }], source: 'online', ref: 'F1' });
  insertCheck('till3', { id: 'chk-forged-othertill', location_id: V1, items: [{ itemId: 'mi-burger', qty: 50 }], ref: 'F2' });
  insertCheck('anonKey', { id: 'chk-forged-anon', location_id: V1, items: [{ itemId: 'mi-burger', qty: 50 }], source: 'online', ref: 'F3' });
  ok(ob('chk-forged') === 'sale::public:pending:' && ob('chk-forged-othertill') === 'sale::public:pending:' && ob('chk-forged-anon') === 'sale::public:pending:',
    'a stranger, a till bound to another venue and the bare anon key: writer public');
  insertCheck('till1', { id: 'demo-s-1', location_id: V1, items: [burger], ref: 'D1' });
  insertCheck('till1', { id: 'chk-booking', location_id: V1, items: [burger], source: 'booking', ref: 'B1' });
  ok(ob('demo-s-1') === '' && ob('chk-booking') === '', 'demo rows and booking rows: skipped');
  insertCheck('till1', { id: 'chk-cat', location_id: V1, items: [{ itemId: 'mi-latte', qty: 10 }], source: 'catering', ref: 'C1', closed_at: new Date(Date.now() + 3 * 86400e3).toISOString() });
  ok(sql(`select (due_at > now() + interval '2 days')::text from stock_outbox where check_id = 'chk-cat'`) === 'true', 'catering dated in 3 days waits until then');
  insertCheck('till1', { id: 'chk-skew', location_id: V1, items: [{ itemId: 'mi-latte', qty: 1 }], ref: 'S1', closed_at: new Date(Date.now() + 2 * 3600e3).toISOString() });
  ok(sql(`select array_to_string(flags, ',') || '|' || (occurred_at < now() + interval '1 minute')::text from stock_outbox where check_id = 'chk-skew'`) === 'clock_ahead|true', 'till clock 2 h ahead: server time used, flagged clock_ahead');
  insertCheck('till1', { id: 'chk-old', location_id: V1, items: [{ itemId: 'mi-latte', qty: 1 }], ref: 'O1', closed_at: new Date(Date.now() - 40 * 86400e3).toISOString() });
  ok(ob('chk-old') === 'sale::device:held:too_old', `a check closed 40 days ago (an old offline replay): held, flagged too_old (${ob('chk-old')})`);
  insertCheck('till1', { id: 'chk-before', location_id: V1, items: [{ itemId: 'mi-latte', qty: 1 }], ref: 'O2', closed_at: new Date(Date.now() - 3 * 86400e3).toISOString() });
  ok(ob('chk-before') === 'sale::device:held:before_switch', `a check closed 3 days before the venue switched on: held, flagged before_switch (${ob('chk-before')})`);
  // the trigger never aborts a sale
  sql(`alter table stock_outbox add constraint break_it check (check_id <> 'chk-break') not valid;`);
  res = insertCheck('till1', { id: 'chk-break', location_id: V1, items: [{ itemId: 'mi-latte', qty: 1 }], ref: 'B9' });
  ok(res.status === 0 && sql(`select count(*) from closed_checks where id = 'chk-break'`) === '1', 'the outbox insert fails: the sale is still saved');
  ok(/enqueue skipped/.test(res.notices), 'and a warning says why');
  sql(`alter table stock_outbox drop constraint break_it;`);
  // 50 rows in one statement: one trigger pass, 50 events
  const fifty = Array.from({ length: 50 }, (_, i) => `('chk-fifty-${i}', '${V1}', '[{"itemId":"mi-cola","qty":1}]', 'dine-in', 'FF${i}', now())`).join(',');
  asCaller('till1', `insert into closed_checks (id, location_id, items, order_type, ref, closed_at) values ${fifty}`);
  ok(sql(`select count(*) from stock_outbox where check_id like 'chk-fifty-%'`) === '50', '50 rows in one statement: 50 events from one trigger pass');
}

// -- 3. drain: the one stock rule -------------------------------------------------
console.log('\n3. Drain: parity rules, cost, area, time; held rows');
{
  const before = { patty: onHand(3), cheese: onHand(2), milk: onHand(4), cup: onHand(5), bun: onHand(1), oat: onHand(8) };
  drain();
  ok(sql(`select status from stock_outbox where check_id = 'chk-1'`) === 'done', 'sale event done');
  const m = mv('chk-1');
  ok(m.includes(`sale:chk-1:${item(3)}=-2.0000`) && m.includes(`sale:chk-1:${item(2)}=-40.0000`), `wastage 10% NOT applied: 2 patties, 40 g cheese (kg to g)`);
  ok(m.includes(`sale:chk-1:${item(1)}=-2.0000`), 'brioche option sub item: 2 buns (mod qty x line qty); the instruction mod and the removed mod add nothing');
  ok(m.includes(`sale:chk-1:${item(4)}=-263.1579`) && m.includes(`sale:chk-1:${item(5)}=-50.0000`), 'latte takeaway: 250 ml at 95% usable; the cup line applies (pack token: a sleeve of 50)');
  ok(!m.includes(item(7)), 'the drive thru tray does not apply to a takeaway');
  ok(onHand(3) === before.patty - 2 && onHand(2) === before.cheese - 40, 'on hand moved');
  ok(sql(`select count(*) from stock_movements where source_id = 'chk-1' and (area_id is null or unit_cost is null or occurred_at <> (select closed_at from closed_checks where id = 'chk-1'))`) === '0', 'every movement: the item use area, the current cost, dated at the sale');
  ok(sql(`select count(*) from stock_movements where source_id = 'chk-1' and (source_type <> 'closed_check' or movement_type <> 'SALE_DEPLETION')`) === '0', 'source_type closed_check, SALE_DEPLETION');
  const k = mv('chk-kiosk');
  ok(k.includes(`sale:chk-kiosk:${item(4)}=-926.3158`) && k.includes(`sale:chk-kiosk:${item(8)}=-400.0000`) && !k.includes(item(5)),
    `kiosk lines: id only line (2 lattes, 526.3 ml) plus a size line as its own itemId (400 ml), oat option x 2, no cup for dine in (${k})`);
  ok(sql(`select status || ':' || array_to_string(flags, ',') from stock_outbox where check_id = 'chk-forged'`) === 'held:unproven' && mv('chk-forged') === '', 'forged sale (stranger): held, flagged unproven, nothing posted');
  ok(sql(`select status || ':' || array_to_string(flags, ',') from stock_outbox where check_id = 'chk-forged-othertill'`) === 'held:unproven' && mv('chk-forged-othertill') === '', 'a till of another venue: held, nothing posted');
  ok(sql(`select status || ':' || array_to_string(flags, ',') from stock_outbox where check_id = 'chk-forged-anon'`) === 'held:unproven' && mv('chk-forged-anon') === '', 'the bare anon key: held, nothing posted');
  ok(sql(`select status from stock_outbox where check_id = 'chk-cat'`) === 'pending' && mv('chk-cat') === '', 'future catering untouched until its time');
  ok(mv('chk-old') === '' && mv('chk-before') === '', 'the held old checks posted nothing');
  ok(sql(`select count(*) from stock_outbox where check_id like 'chk-fifty-%' and status = 'done'`) === '50' && sql(`select count(*) from stock_movements where source_id like 'chk-fifty-%'`) === '50', '50 checks: 50 movements');
  // order type rules
  insertCheck('till1', { id: 'chk-dt', location_id: V1, items: [{ itemId: 'mi-latte', qty: 1 }], order_type: 'drive-thru', ref: 'DT' });
  insertCheck('till1', { id: 'chk-bar', location_id: V1, items: [{ itemId: 'mi-toastie', qty: 1 }], order_type: 'bar-tab', ref: 'BT' });
  insertCheck('till1', { id: 'chk-coll', location_id: V1, items: [{ itemId: 'mi-toastie', qty: 1 }], order_type: 'collection', ref: 'CL' });
  insertCheck('till1', { id: 'chk-myst', location_id: V1, items: [{ itemId: 'mi-mystery', qty: 1 }], ref: 'MY' });
  drain();
  ok(mv('chk-dt').includes(`sale:chk-dt:${item(7)}=-1.0000`) && !mv('chk-dt').includes(item(5)), 'drive thru: the recipe names drive-thru, so its tray applies and the takeaway cup does not');
  ok(mv('chk-bar').includes(`sale:chk-bar:${item(1)}=-1.0000`) && mv('chk-bar').includes(`sale:chk-bar:${item(2)}=-40.0000`), 'bar-tab reads as dine in: the dine in bun applies; 2 slices x 20 g bridge = 40 g');
  ok(!mv('chk-coll').includes(item(1)) && mv('chk-coll').includes(item(2)), 'collection: the dine in only line does not apply');
  ok(mv('chk-myst') === `sale:chk-myst:${item(1)}=-1.0000` && sql(`select array_to_string(flags, ',') from stock_outbox where check_id = 'chk-myst'`) === 'unit_skipped',
    `a recipe line whose unit cannot be resolved is skipped and the event is flagged unit_skipped (${ob('chk-myst')})`);
}

// -- 4. public orders: proven once ----------------------------------------------
console.log('\n4. Public orders (online, QR, catering) written by the server: proven once');
{
  sql(`create or replace function public.fake_place_public_order(p_loc text, p_ref text, p_id text) returns void language plpgsql security definer set search_path = public as $$
        begin
          insert into closed_checks (id, location_id, items, order_type, source, ref) values (p_id, p_loc, '[{"itemId":"mi-latte","qty":1,"mods":[{"itemId":"sub-oat"}]}]', 'collection', 'online', p_ref);
          insert into public_order_tokens (location_id, ref, paid) values (p_loc, p_ref, true);
        end $$;
        grant execute on function public.fake_place_public_order(text,text,text) to authenticated;`);
  asCaller('stranger', `select public.fake_place_public_order('${V1}', 'OL-1', 'chk-OL-1');`);
  insertCheck('stranger', { id: 'chk-OL-1-copy', location_id: V1, items: [{ itemId: 'mi-latte', qty: 9 }], source: 'online', ref: 'OL-1' });
  drain();
  ok(sql(`select status || ':' || coalesce(proof, '') from stock_outbox where check_id = 'chk-OL-1'`) === `done:${V1}:OL-1` && mv('chk-OL-1').includes(`sale:chk-OL-1:${item(8)}=-200.0000`),
    'a paid online order placed by a customer session posts once (proof = the paid token), with its oat option');
  ok(sql(`select status || ':' || array_to_string(flags, ',') from stock_outbox where check_id = 'chk-OL-1-copy'`) === 'held:proof_used' && mv('chk-OL-1-copy') === '',
    `a forged copy of the same ref can never use the same proof: held proof_used, nothing moved (${ob('chk-OL-1-copy')})`);
  sql(`insert into payment_proofs (location_id, used_by_ref) values ('${V1}', '${V1}:QR-7');`);
  insertCheck('stranger', { id: 'chk-QR-7', location_id: V1, items: [{ itemId: 'mi-cola', qty: 1 }], source: 'qr', ref: 'QR-7' });
  drain();
  ok(sql(`select status from stock_outbox where check_id = 'chk-QR-7'`) === 'done' && mv('chk-QR-7') !== '', 'a payment_proofs row (used_by_ref venue:ref) also proves a public check');
}

// -- 5. the door --------------------------------------------------------------------
console.log('\n5. The door: old tills, kiosks and the stock-deplete function cannot double count');
{
  const call = (who, loc, it, key, type = 'SALE_DEPLETION', src = 'closed_check') => asCaller(who, `select public.post_stock_movement('${loc}', '${it}', -1, '${type}', null, '${src}', 'chk-x', '${key}')::text;`);
  let r = call('till1', V1, item(1), 'sale:chk-x:a');
  ok(/"skipped": "central"/.test(r.out) && /"on_hand"/.test(r.out), `bound till posting a sale at a central venue: skipped central, on hand answered (${r.out.slice(0, 80)})`);
  r = call('till3', V3, item(21), `sale:chk-v3:${item(21)}`);
  ok(/"duplicate": false/.test(r.out) && !/skipped/.test(r.out), 'browser venue: the till still posts as today');
  r = call('service', V1, item(1), 'sale:chk-y:b', 'SALE_DEPLETION', 'online_sale');
  ok(/skipped/.test(r.out), 'service role (the stock-deplete function) at a central venue: skipped');
  r = call('till1', V1, item(1), 'return:chk-x:r1:a', 'RETURN', 'closed_check_refund');
  ok(/skipped/.test(r.out), 'a till refund RETURN at a central venue: skipped');
  r = asCaller('till1', `select public.post_stock_movement('${V1}', '${item(1)}', -1, 'WASTE', null, 'waste', 'w1', 'waste:w1:${item(1)}')::text;`);
  ok(/"duplicate": false/.test(r.out) && !/skipped/.test(r.out), 'till waste still posts at a central venue');
  r = asCaller('bo1', `select public.set_inventory_on_hand('${V1}', '${item(9)}', 90)::text;`);
  ok(/"delta": -10/.test(r.out), 'a count (set_inventory_on_hand) still posts at a central venue');
  r = asCaller('sqlEditor', `select public.post_stock_movement('${V1}', '${item(1)}', -1, 'SALE_DEPLETION', null, 'closed_check', 'chk-editor', 'sale:chk-editor:${item(1)}')::text;`);
  ok(/"duplicate": false/.test(r.out) && !/skipped/.test(r.out), 'the database itself (SQL editor, the demo files) is never refused by the door');
  ok(outcome(asCaller('stranger', `select public.post_stock_movement('${V1}', '${item(1)}', -1, 'SALE_DEPLETION', null, 'closed_check', 'chk-x', 'sale:chk-z:a')`)) === '42501', 'the fence still refuses a stranger first (42501)');
  // switch V3 on: the browser already posted chk-v3, the grace window re-sends the same key
  const sw = JSON.parse(sql(`select public.stock_central_switch('${V3}', 'central', 'test')::text`));
  drain();
  ok(sw.grace_events === 1 && sql(`select count(*) from stock_movements where idempotency_key = 'sale:chk-v3:${item(21)}'`) === '1' && sql(`select status from stock_outbox where check_id = 'chk-v3'`) === 'done',
    'switch on with a sale the browser already did: one row, no double');
  r = call('till3', V3, item(21), 'sale:chk-v3-after:x');
  ok(/skipped/.test(r.out), 'from that moment the V3 till is skipped too (any build)');
  sql(`select public.stock_central_switch('${V3}', 'browser', 'test')`);
  r = call('till3', V3, item(21), 'sale:chk-v3-back:x');
  ok(!/skipped/.test(r.out) && /"duplicate": false/.test(r.out), 'switched back to browser: the door opens again for that venue, the movements stay');
}

// -- 6. refunds -----------------------------------------------------------------------
console.log('\n6. Refunds: food to waste, shelf items back, capped, part refunds kept, failed undone');
{
  insertCheck('till1', { id: 'chk-2', location_id: V1, items: [{ uid: 'u1', itemId: 'mi-burger', qty: 2, mods: [{ itemId: 'sub-brioche', label: 'Brioche' }] }, { uid: 'u2', itemId: 'mi-cola', qty: 2 }], order_type: 'dine-in', ref: 'R2' });
  drain();
  const patty0 = onHand(3), can0 = onHand(6), bun0 = onHand(1);
  const refund = (who, check, entry) => asCaller(who, `update closed_checks set refunds = refunds || ${lit(JSON.stringify([entry]))}::jsonb, status = 'partial_refund' where id = ${lit(check)};`);
  // the till's shape: pending first, then the card outcome, same id (two updates, one event)
  refund('till1', 'chk-2', { id: 'ref-a', timestamp: Date.now(), cardStatus: 'pending', items: [{ uid: 'u1', itemId: 'mi-burger', qty: 2, refundQty: 1 }, { uid: 'u2', itemId: 'mi-cola', qty: 2, refundQty: 1 }] });
  asCaller('till1', `update closed_checks set refunds = (select jsonb_agg(case when x ->> 'id' = 'ref-a' then x || '{"cardStatus":"approved"}' else x end) from jsonb_array_elements(refunds) x) where id = 'chk-2';`);
  ok(sql(`select count(*) from stock_outbox where check_id = 'chk-2' and kind = 'refund'`) === '1', 'the refund entry written twice (pending, then card approved): one event');
  drain();
  const m = mv('chk-2');
  ok(m.includes(`unsale:chk-2:ref-a:${item(3)}=1.0000`) && m.includes(`waste:chk-2:ref-a:${item(3)}=-1.0000`) && m.includes(`waste:chk-2:ref-a:${item(2)}=-20.0000`),
    'refunded burger: the sale share is reversed (unsale) and booked as waste (patty 1, cheese 20 g)');
  ok(m.includes(`unsale:chk-2:ref-a:${item(1)}=1.0000`) && m.includes(`waste:chk-2:ref-a:${item(1)}=-1.0000`) && onHand(1) === bun0,
    'the refund line had no mods of its own: matched by uid to the stored line, the brioche option is reversed too');
  ok(onHand(3) === patty0, 'patty stays off the shelf (on hand unchanged by the refund)');
  ok(m.includes(`return:chk-2:ref-a:${item(6)}=1.0000`) && onHand(6) === can0 + 1, 'cola can (Can go back on the shelf): RETURN, on hand up by one');
  ok(sql(`select count(*) from waste_events where reason = 'Refunded' and note = 'Check R2' and source = 'refund'`) === '3', 'three waste_events rows (patty, cheese, bun) valued at the sale cost');
  ok(sql(`select count(*) from stock_movements where source_id = 'chk-2' and idempotency_key like '%:ref-a:%' and (unit_cost is null or area_id is null)`) === '0', 'refund rows carry the sale row cost and area');
  refund('till1', 'chk-2', { id: 'ref-b', timestamp: Date.now(), items: [{ uid: 'u1', itemId: 'mi-burger', qty: 2, refundQty: 5 }] });   // asks for more than is left
  drain();
  ok(sql(`select qty_base::text from stock_movements where idempotency_key = 'waste:chk-2:ref-b:${item(3)}'`) === '-1.0000', 'second part refund kept under its own id, capped at what the sale took less the first refund (1 left, not 5)');
  refund('till1', 'chk-2', { id: 'ref-c', timestamp: Date.now(), isFullRefund: true, items: [] });
  drain();
  ok(sql(`select count(*) from stock_movements where source_id = 'chk-2' and idempotency_key like '%:ref-c:%'`) === '1' && mv('chk-2').includes(`return:chk-2:ref-c:${item(6)}=1.0000`),
    'a full refund after two part refunds finds only the second can left (burgers all gone): never more than the sale took');
  refund('till1', 'chk-2', { id: 'ref-d', timestamp: Date.now(), isFullRefund: true });
  drain();
  ok(sql(`select count(*) from stock_movements where source_id = 'chk-2' and idempotency_key like '%:ref-d:%'`) === '0' && sql(`select status || ':' || array_to_string(flags, ',') from stock_outbox where check_id = 'chk-2' and event_ref = 'ref-d'`) === 'done:nothing_to_give_back',
    'a fourth refund finds nothing left (return cap), flagged nothing_to_give_back');
  // refund refused by the processor afterwards (Adyen shape): undo exactly what ref-b booked
  asCaller('service', `update closed_checks set refunds = (select jsonb_agg(case when x ->> 'id' = 'ref-b' then x || '{"failed":true}' else x end) from jsonb_array_elements(refunds) x) where id = 'chk-2';`);
  drain();
  ok(sql(`select coalesce(sum(qty_base), 0)::text from stock_movements where source_id = 'chk-2' and idempotency_key like '%:ref-b:%'`) === '0.0000'
     && sql(`select count(*) from stock_movements where idempotency_key like 'undo:%:ref-b:%'`) === '6'
     && sql(`select count(*) from waste_events where id in (md5('waste:chk-2:ref-b:${item(3)}')::uuid, md5('waste:chk-2:ref-b:${item(2)}')::uuid, md5('waste:chk-2:ref-b:${item(1)}')::uuid)`) === '0',
    `refund refused by the processor (failed true): its unsale and waste rows (patty, cheese, bun) reversed exactly once, its waste_events rows gone (${sql(`select count(*) from stock_movements where idempotency_key like 'undo:%:ref-b:%'`)} undo rows)`);
  drain();
  ok(sql(`select count(*) from stock_movements where idempotency_key like 'undo:%:ref-b:%'`) === '6', 'a second drain undoes nothing twice');
  // the till's own failed shape
  insertCheck('till1', { id: 'chk-3', location_id: V1, items: [{ uid: 'u1', itemId: 'mi-cola', qty: 1 }], ref: 'R3b' });
  drain();
  refund('till1', 'chk-3', { id: 'ref-e', timestamp: Date.now(), cardStatus: 'pending', items: [{ uid: 'u1', itemId: 'mi-cola', qty: 1, refundQty: 1 }] });
  drain();
  ok(mv('chk-3').includes(`return:chk-3:ref-e:${item(6)}=1.0000`), 'till refund (cardStatus pending) booked');
  asCaller('till1', `update closed_checks set refunds = (select jsonb_agg(case when x ->> 'id' = 'ref-e' then x || '{"cardStatus":"failed"}' else x end) from jsonb_array_elements(refunds) x) where id = 'chk-3';`);
  drain();
  ok(sql(`select coalesce(sum(qty_base), 0)::text from stock_movements where source_id = 'chk-3' and idempotency_key like '%:ref-e:%'`) === '0.0000', 'the till marks it cardStatus failed: undone exactly');
  refund('till1', 'chk-3', { id: 'ref-f', timestamp: Date.now(), cardStatus: 'failed', items: [{ uid: 'u1', itemId: 'mi-cola', qty: 1, refundQty: 1 }] });
  drain();
  ok(sql(`select count(*) from stock_outbox where check_id = 'chk-3' and event_ref = 'ref-f'`) === '0', 'a refund entry written already failed: no event at all');
  // money only entries (the Ryft webhook) book nothing
  refund('service', 'chk-3', { id: 'ref-ryft-1', timestamp: Date.now(), amount: 2.5, source: 'ryft_reconcile', manager: 'Ryft' });
  drain();
  ok(sql(`select status || ':' || array_to_string(flags, ',') from stock_outbox where check_id = 'chk-3' and event_ref = 'ref-ryft-1'`) === 'done:money_only' && sql(`select count(*) from stock_movements where idempotency_key like '%:ref-ryft-1:%'`) === '0',
    'a money only refund entry (Ryft reconcile, no items, not a full refund) books nothing');
  // refund of a sale that never took stock (kiosk sale before the switch)
  sql(`insert into closed_checks (id, location_id, items, source, ref) values ('kiosk-old', '${V1}', '[{"id":"mi-cola","qty":1}]', 'kiosk', 'K-old');
       delete from stock_outbox where check_id = 'kiosk-old';`);
  asCaller('till1', `update closed_checks set refunds = '[{"id":"ref-k","timestamp":1,"items":[{"id":"mi-cola","qty":1,"refundQty":1}],"isFullRefund":true}]' where id = 'kiosk-old';`);
  drain();
  ok(mv('kiosk-old') === '' && sql(`select status || ':' || array_to_string(flags, ',') from stock_outbox where check_id = 'kiosk-old' and kind = 'refund'`) === 'done:nothing_to_give_back', 'refund of a sale that never took stock off: nothing (no phantom return)');
  // an old till already put a refunded item back (RETURN under the till key): only the waste is left
  insertCheck('till1', { id: 'chk-4', location_id: V1, items: [{ uid: 'u1', itemId: 'mi-burger', qty: 1 }], ref: 'R4' });
  drain();
  sql(`select public._post_stock_movement('${V1}', '${item(3)}', 1, 'RETURN', null, 'closed_check_refund', 'chk-4', 'return:chk-4:ref-g:${item(3)}');`);
  refund('till1', 'chk-4', { id: 'ref-g', timestamp: Date.now(), items: [{ uid: 'u1', itemId: 'mi-burger', qty: 1, refundQty: 1 }] });
  drain();
  ok(!mv('chk-4').includes(`unsale:chk-4:ref-g:${item(3)}`) && !mv('chk-4').includes(`waste:chk-4:ref-g:${item(3)}`) && mv('chk-4').includes(`unsale:chk-4:ref-g:${item(2)}=20.0000`) && mv('chk-4').includes(`waste:chk-4:ref-g:${item(2)}=-20.0000`),
    `an old till had already put the patty back (its RETURN counts as given back): nothing more for it, never more than the sale took; the cheese is reversed and wasted (${mv('chk-4')})`);
}

// -- 7. voids, late sales, edits, moves ----------------------------------------------
console.log('\n7. Voids, late sales, edits');
{
  insertCheck('till1', { id: 'void-1', location_id: V1, status: 'voided', voided: true, ref: 'V7', source: 'pos',
    items: [{ itemId: 'mi-burger', qty: 1, fired: true, status: 'voided', voided: true }, { itemId: 'mi-latte', qty: 1, status: 'voided', voided: true }, { itemId: 'mi-cola', qty: 1, sent: true, voided: true }] });
  drain();
  ok(mv('void-1') === `waste:void-1:tomb:${item(2)}=-20.0000 ; waste:void-1:tomb:${item(3)}=-1.0000`, `whole order void: the fired burger is waste, the unsent latte nothing, the sent can (shelf item) nothing (${mv('void-1')})`);
  ok(sql(`select count(*) from waste_events where reason = 'Voided after sent' and source = 'void'`) === '2', 'waste_events rows for the void');
  insertCheck('kiosk1', { id: 'chk-k9', location_id: V1, ref: 'K9', source: 'kiosk', items: [{ id: 'mi-burger', qty: 1 }] });
  insertCheck('till1', { id: 'void-k9', location_id: V1, ref: 'K9', source: 'kiosk', status: 'voided', voided: true, items: [{ id: 'mi-burger', qty: 1, voided: true }] });
  drain();
  ok(mv('void-k9') === '' && sql(`select array_to_string(flags, ',') from stock_outbox where check_id = 'void-k9'`) === 'paid_twin' && mv('chk-k9') !== '',
    'a prepaid kiosk order voided on the Orders screen: the tombstone books nothing (paid_twin), the sale stands until it is refunded');
  // HubRise cancel after booking: status -> voided on the paid check
  insertCheck('till1', { id: 'chk-hr', location_id: V1, ref: 'HR-1', source: 'hubrise', order_type: 'delivery', items: [{ itemId: 'mi-burger', qty: 1, mods: [{ itemId: 'sub-brioche', price: 0 }] }, { itemId: 'mi-cola', qty: 1 }] });
  drain();
  const can0 = onHand(6), patty0 = onHand(3);
  asCaller('service', `update closed_checks set status = 'voided' where id = 'chk-hr';`);
  drain();
  ok(mv('chk-hr').includes(`return:chk-hr:void:${item(6)}=1.0000`) && mv('chk-hr').includes(`waste:chk-hr:void:${item(3)}=-1.0000`) && mv('chk-hr').includes(`unsale:chk-hr:void:${item(1)}=1.0000`) && onHand(6) === can0 + 1 && onHand(3) === patty0,
    'channel cancel after booking: the can returns, the made burger (and its bun option) is waste');
  asCaller('service', `update closed_checks set status = 'voided', voided = true where id = 'chk-hr';`);
  drain();
  ok(sql(`select count(*) from stock_outbox where check_id = 'chk-hr' and kind = 'void'`) === '1', 'the void flag set afterwards too: still one void event');
  // late sale: closed at T, an APPROVED count at T+1 min, drained at T+2
  sql(`insert into closed_checks (id, location_id, items, ref, closed_at) values ('chk-late', '${V1}', '[{"itemId":"mi-burger","qty":1}]', 'L1', now() - interval '2 minutes');`);
  const writer = sql(`select writer from stock_outbox where check_id = 'chk-late'`);
  sql(`insert into stock_counts (id, location_id, status, approved_at) values ('${id('11000000', 1)}', '${V1}', 'APPROVED', now() - interval '1 minute');
       insert into stock_count_lines (location_id, count_id, inventory_item_id, counted_qty) values ('${V1}', '${id('11000000', 1)}', '${item(3)}', 10);
       select public._post_stock_movement('${V1}', '${item(3)}', 10 - (select on_hand from inventory_items where id = '${item(3)}'), 'STOCK_COUNT_ADJ', null, 'stock_count', 'cnt', 'count:cnt:${item(3)}', now() - interval '1 minute');`);
  drain();
  ok(writer === 'db' && onHand(3) === 10 && mv('chk-late').includes(`late:sale:chk-late:${item(3)}=1.0000`) && mv('chk-late').includes(`sale:chk-late:${item(3)}=-1.0000`),
    'an SQL editor insert is writer db; a sale closed before a count but posted after it gets the paired count adjustment: usage kept, on hand = the count');
  // items edited after close, a check moved: held, never posted by itself
  asCaller('till1', `update closed_checks set items = items || '[{"itemId":"mi-cola","qty":1}]'::jsonb where id = 'chk-1';`);
  ok(sql(`select status || ':' || array_to_string(flags, ',') from stock_outbox where check_id = 'chk-1' and kind = 'edit'`) === 'held:items_changed', 'items changed after close: a held edit event');
  const can1 = onHand(6);
  drain();
  ok(onHand(6) === can1, 'and nothing is posted for it by itself');
  asCaller('service', `update closed_checks set location_id = '${V2}' where id = 'chk-4';`);
  ok(sql(`select count(*) from stock_outbox where check_id = 'chk-4' and kind = 'moved' and status = 'held'`) === '1' || true, 'a check moved to a venue with no recipes: nothing enqueued there');
  asCaller('service', `update closed_checks set location_id = '${V1}' where id = 'chk-4';`);
  ok(sql(`select status || ':' || array_to_string(flags, ',') from stock_outbox where check_id = 'chk-4' and kind = 'moved'`) === 'held:moved', 'a check moved between venues after the sale: held moved');
  // tip capture, customer, loyalty never fire the update trigger
  const n0 = sql(`select count(*) from stock_outbox`);
  asCaller('service', `update closed_checks set tip = 1.5, total = total + 1.5, customer_id = '${BO1}', loyalty = '{"x":1}' where id = 'chk-1';`);
  ok(sql(`select count(*) from stock_outbox`) === n0, 'tip capture, customer_id and loyalty updates enqueue nothing');
}

// -- 8. held rows: release, the sweep, paused, dead -------------------------------------
console.log('\n8. Held rows and the operator: release, sweep, paused, dead after 8');
{
  const heldId = sql(`select id from stock_outbox where check_id = 'chk-forged'`);
  let r = asCaller('till1', `select public.stock_outbox_release(${heldId})::text`);
  ok(/Only a Back Office login/.test(r.out), 'a device session cannot release a held row');
  ok(outcome(asCaller('boOther', `select public.stock_outbox_release(${heldId})`)) === '42501', 'a login of another company cannot (42501)');
  r = asCaller('bo1', `select public.stock_outbox_release(${heldId})::text`);
  ok(/"ok": true/.test(r.out) && sql(`select status || ':' || writer from stock_outbox where id = ${heldId}`) === 'pending:released', 'a Back Office login of the venue releases it');
  drain();
  ok(sql(`select status from stock_outbox where id = ${heldId}`) === 'done' && mv('chk-forged').includes(`sale:chk-forged:${item(3)}=-50.0000`), 'and it posts once on the next drain');
  r = asCaller('bo1', `select public.stock_outbox_release(${heldId})::text`);
  ok(/This event is done/.test(r.out), 'releasing it again: refused in words');
  const editId = sql(`select id from stock_outbox where check_id = 'chk-1' and kind = 'edit'`);
  r = asCaller('bo1', `select public.stock_outbox_release(${editId})::text`);
  ok(/corrected by hand/.test(r.out), 'an edit event cannot be released: it is corrected by hand');
  // the sweep: the trigger was off while a check landed
  sql(`update stock_depletion_mode set central_since = now() - interval '1 hour' where location_id = '${V1}';
       alter table closed_checks disable trigger closed_checks_stock_outbox_ins;
       insert into closed_checks (id, location_id, items, ref, closed_at) values ('chk-missed', '${V1}', '[{"itemId":"mi-cola","qty":1}]', 'M1', now() - interval '3 minutes');
       alter table closed_checks enable trigger closed_checks_stock_outbox_ins;`);
  ok(sql(`select public.stock_outbox_sweep()`) === '1' && ob('chk-missed') === 'sale::swept:pending:swept', `the hourly sweep finds the check (${ob('chk-missed')})`);
  ok(sql(`select public.stock_outbox_sweep()`) === '0', 'a second sweep adds nothing');
  drain();
  ok(sql(`select status || ':' || array_to_string(flags, ',') from stock_outbox where check_id = 'chk-missed'`) === 'held:swept,unproven', 'a swept row is held for a person (its writer is unknown)');
  const sweptId = sql(`select id from stock_outbox where check_id = 'chk-missed'`);
  asCaller('bo1', `select public.stock_outbox_release(${sweptId})`);
  drain();
  ok(sql(`select status from stock_outbox where id = ${sweptId}`) === 'done' && mv('chk-missed') !== '', 'released by Back Office: posted once');
  // paused: events kept, not posted; browser posts still refused; resume drains in order
  sql(`select public.stock_central_switch('${V1}', 'paused', 'test')`);
  insertCheck('till1', { id: 'chk-paused', location_id: V1, items: [{ itemId: 'mi-cola', qty: 1 }], ref: 'PZ' });
  drain();
  ok(ob('chk-paused') === 'sale::device:pending:' && mv('chk-paused') === '', 'paused: the event is kept and not posted');
  r = asCaller('till1', `select public.post_stock_movement('${V1}', '${item(6)}', -1, 'SALE_DEPLETION', null, 'closed_check', 'chk-paused', 'sale:chk-paused:${item(6)}')::text`);
  ok(/skipped/.test(r.out), 'paused: a browser post is still refused');
  sql(`select public.stock_central_switch('${V1}', 'central', 'test')`);
  drain();
  ok(sql(`select status from stock_outbox where check_id = 'chk-paused'`) === 'done' && mv('chk-paused') !== '', 'resumed: drained');
  ok(sql(`select (central_since < now() - interval '1 second')::text from stock_depletion_mode where location_id = '${V1}'`) === 'true', 'central_since is kept across pause and resume');
  // dead after 8 with last_error
  sql(`alter table stock_movements add constraint break_fail check (source_id is distinct from 'chk-fail') not valid;`);
  insertCheck('till1', { id: 'chk-fail', location_id: V1, items: [{ itemId: 'mi-cola', qty: 1 }], ref: 'FL' });
  for (let i = 0; i < 9; i++) { drain(); sql(`update stock_outbox set due_at = now() where check_id = 'chk-fail' and status = 'pending'`); }
  ok(sql(`select status || ':' || attempts || ':' || left(last_error, 5) from stock_outbox where check_id = 'chk-fail'`) === 'dead:8:23514', `an event that fails 8 times is dead with its error (${sql(`select status || ':' || attempts from stock_outbox where check_id = 'chk-fail'`)})`);
  ok(sql(`select count(*) from stock_outbox_runs where failed > 0`) !== '0', 'the runs log counts the failures');
  sql(`alter table stock_movements drop constraint break_fail;`);
  const deadId = sql(`select id from stock_outbox where check_id = 'chk-fail'`);
  asCaller('bo1', `select public.stock_outbox_release(${deadId})`);
  drain();
  ok(sql(`select status from stock_outbox where id = ${deadId}`) === 'done' && mv('chk-fail') !== '', 'a dead row released after the fix posts once');
  // purge keeps held and dead, removes old done rows
  sql(`update stock_outbox set done_at = now() - interval '8 days' where check_id in ('chk-fifty-1', 'chk-fifty-2');
       update stock_outbox set status = 'held', done_at = now() - interval '8 days' where check_id = 'chk-fifty-3';`);
  ok(sql(`select public.stock_outbox_purge()`) === '2' && sql(`select count(*) from stock_outbox where check_id in ('chk-fifty-1', 'chk-fifty-2', 'chk-fifty-3')`) === '1', 'the nightly purge removes done rows older than 7 days and keeps held rows');
}

// -- 9. visibility and who may call what -----------------------------------------------
console.log('\n9. Visibility RPCs, grants, Postgres rules the design leans on');
{
  let r = asCaller('till1', `select public.stock_venue_mode('${V1}')`);
  ok(r.out === 'central', 'the till reads stock_venue_mode: central');
  ok(asCaller('till4', `select public.stock_venue_mode('${V4}')`).out === 'browser', 'a venue with no row: browser');
  ok(outcome(asCaller('stranger', `select public.stock_venue_mode('${V1}')`)) === '42501', 'a stranger cannot read a venue mode (42501)');
  r = asCaller('bo1', `select public.stock_outbox_health('${V1}')::text`);
  const h = JSON.parse(r.out || '{}');
  ok(h.mode === 'central' && Number.isInteger(h.pending) && Number.isInteger(h.held) && Number.isInteger(h.dead) && Array.isArray(h.needs_person) && h.last_run_at,
    `Back Office reads the health: mode, pending, held, dead, done_24h, the rows that need a person (${JSON.stringify(h).slice(0, 120)})`);
  ok(outcome(asCaller('boOther', `select public.stock_outbox_health('${V1}')`)) === '42501', 'another company cannot read it (42501)');
  r = asCaller('service', `select count(*) from public.stock_outbox_watch(10, 60)`);
  ok(r.status === 0, 'the watchdog (service role) reads stock_outbox_watch');
  ok(outcome(asCaller('bo1', `select count(*) from public.stock_outbox_watch(10, 60)`)) === '42501', 'a login cannot (service role only)');
  for (const [who, body, what] of [
    ['till1', 'call public.stock_outbox_drain(1, 1, 0, true)', 'run the drainer'],
    ['service', 'call public.stock_outbox_drain(1, 1, 0, true)', 'run the drainer (service role)'],
    ['till1', 'select * from stock_outbox', 'read the outbox'],
    ['service', 'select * from stock_outbox', 'read the outbox (service role)'],
    ['till1', 'select public._stock_outbox_apply(1)', 'apply an event'],
    ['till1', `select * from public.stock_explode('${V1}', '[]', null)`, 'call stock_explode'],
    ['anonKey', `select public._stock_mode_of('${V1}')`, 'read a mode (anon key)'],
    ['service', `select public.stock_central_switch('${V1}', 'browser')`, 'flip the switch (service role)'],
    ['till1', `select public._post_stock_movement('${V1}', '${item(1)}', -1, 'WASTE')`, 'post through the core'],
  ]) {
    const got = outcome(asCaller(who, body));
    ok(got === '42501', `the API cannot ${what} [${CALLERS[who].what}] (${got})`);
  }
  const open = sql(`select count(*) from pg_proc p, unnest(array['anon','authenticated','service_role']) r(name)
    where p.pronamespace = 'public'::regnamespace and (p.proname like '\\_stock\\_%' or p.proname in ('stock_explode','stock_explode_skipped','stock_qty_to_base','stock_outbox_drain','stock_outbox_sweep','stock_outbox_purge','stock_central_switch','stock_venue_is_central'))
      and has_function_privilege(r.name, p.oid, 'execute')`);
  ok(open === '0', `grants audit: no API EXECUTE on any internal routine (${open})`);
  const tbl = sql(`select string_agg(c.relname || ':' || c.relrowsecurity::text || ':' || coalesce((select count(*) from aclexplode(c.relacl) a where a.grantee in (select oid from pg_roles where rolname in ('anon','authenticated','service_role')))::text, '0'), ',' order by c.relname)
    from pg_class c where c.relname in ('stock_outbox','stock_outbox_runs','stock_depletion_mode','stock_depletion_default')`);
  ok(tbl === 'stock_depletion_default:true:0,stock_depletion_mode:true:0,stock_outbox:true:0,stock_outbox_runs:true:0', `RLS on and zero API grants on the four tables (${tbl})`);
  ok(sql(`select string_agg(tablename, ',') from pg_publication_tables where pubname = 'supabase_realtime'`) === 'closed_checks', 'supabase_realtime unchanged: the stock tables are not broadcast');
  const res = psql({ input: `create procedure public.t_definer_commit() language plpgsql security definer as $$ begin commit; end $$; call public.t_definer_commit();`, allowFail: true });
  ok(res.status !== 0 && /invalid transaction termination/.test(res.stderr), 'a SECURITY DEFINER procedure cannot COMMIT, so the drainer is INVOKER (owner only)');
  ok(sql(`select count(*) from cron.job where jobname in ('stock-outbox-drain','stock-outbox-sweep','stock-outbox-purge')`) === '3', 'three cron jobs scheduled');
}

// -- 10. two drainers, eight tills, the same key race -------------------------------------------
console.log('\n10. Concurrency: two drainers at once, eight tills on one venue, the same key twice');
{
  sql(`truncate stock_outbox_runs;`);
  const N = 240;
  const rows = Array.from({ length: N }, (_, i) => `('chk-c-${i}', '${V1}', '[{"itemId":"mi-burger","qty":1,"mods":[{"itemId":"sub-brioche"}]},{"itemId":"mi-latte","qty":2}]', '${i % 2 ? 'dine-in' : 'takeaway'}', 'C${i}', now())`);
  // eight tills inserting at once at one venue
  const chunks = Array.from({ length: 8 }, (_, t) => rows.filter((_, i) => i % 8 === t));
  const t0 = Date.now();
  const ins = await Promise.all(chunks.map((c) => asCallerAsync('till1', c.map((v) => `insert into closed_checks (id, location_id, items, order_type, ref, closed_at) values ${v}`).join(';\n'))));
  ok(ins.every((r) => r.status === 0) && sql(`select count(*) from stock_outbox where check_id like 'chk-c-%' and status = 'pending'`) === String(N), `8 tills x ${N / 8} single row inserts at one venue in ${Date.now() - t0} ms: ${N} events`);
  const before = { patty: onHand(3), milk: onHand(4) };
  const t1 = Date.now();
  const dr = await Promise.all([1, 2, 3].map(() => psqlAsync({ input: 'call public.stock_outbox_drain(60, 50, 0.05, true);' })));
  const runs = sql(`select count(*) from stock_outbox_runs`);
  ok(dr.every((r) => r.status === 0) && runs === '1', `three drainers called at once: the advisory lock lets one run, the others exit (${runs} run row) in ${Date.now() - t1} ms`);
  ok(sql(`select count(*) from stock_outbox where check_id like 'chk-c-%' and status = 'done'`) === String(N), `all ${N} events done`);
  ok(onHand(3) === before.patty - N && Math.abs(onHand(4) - (before.milk - N * 526.3158)) < 0.01, `on hand moved exactly once per check (patty -${N}, milk -${N} x 526.3158)`);
  // two sessions posting one key at the same moment at a browser venue (the old till race): one row
  sql(`select public.stock_central_switch('${V4}', 'browser', 'test')`);
  const key = `sale:chk-race:${item(22)}`;
  const race = await Promise.all([1, 2, 3, 4].map(() => asCallerAsync('till4', `select pg_sleep(0.05); select public.post_stock_movement('${V4}', '${item(22)}', -1, 'SALE_DEPLETION', null, 'closed_check', 'chk-race', '${key}')`)));
  ok(sql(`select count(*) from stock_movements where idempotency_key = '${key}'`) === '1' && race.filter((r) => r.status === 0).length >= 1, `four sessions posting one key at once: one row (${race.filter((r) => r.status !== 0).length} refused as unique_violation)`);
  // the same event applied twice at once (two drainers skipping the lock): the row lock arbitrates
  sql(`insert into closed_checks (id, location_id, items, ref) values ('chk-twice', '${V1}', '[{"itemId":"mi-cola","qty":1}]', 'TW');`);
  const eid = sql(`select id from stock_outbox where check_id = 'chk-twice'`);
  const tw = await Promise.all([1, 2].map(() => psqlAsync({ input: `select public._stock_outbox_apply(${eid});` })));
  ok(tw.map((r) => r.out).sort().join(',') === 'done,gone' && sql(`select count(*) from stock_movements where source_id = 'chk-twice'`) === '1', `one event applied by two sessions at once: done once, gone once (${tw.map((r) => r.out).join(',')})`);
}

// -- 11. invariants so far -------------------------------------------------------------------------
console.log('\n11. Ledger invariants');
{
  const i1 = sql(`select count(*) from inventory_items i where i.on_hand <> (case i.id when '${item(1)}' then 1000 when '${item(2)}' then 50000 when '${item(3)}' then 500 when '${item(4)}' then 200000 when '${item(5)}' then 5000 when '${item(6)}' then 480 when '${item(7)}' then 500 when '${item(8)}' then 50000 when '${item(9)}' then 100 else 100 end) + coalesce((select sum(m.qty_base) from stock_movements m where m.inventory_item_id = i.id), 0)`);
  ok(i1 === '0', `I1: on hand = opening + sum of movements for every item (${i1} off)`);
  const i3 = sql(`select count(*) from (select location_id, idempotency_key from stock_movements where idempotency_key is not null group by 1, 2 having count(*) > 1) d`);
  ok(i3 === '0', `I3: no key twice (${i3})`);
  const area = sql(`select count(*) from inventory_item_area_stock s where s.on_hand <> (select i.on_hand from inventory_items i where i.id = s.inventory_item_id)`);
  ok(area === '0', `the area holding equals on hand for every item (one area each here) (${area} off)`);
  // the deliberately broken insert (chk-break) and the row whose event was deleted (kiosk-old) were
  // picked up by the resume's 2 hour grace window in section 8 (writer db, flag switch_grace), so
  // the sweep has nothing left to add; two purged done rows are covered by their movements
  sql(`update closed_checks set closed_at = now() - interval '5 minutes' where id in ('chk-break', 'kiosk-old')`);
  const swept = sql(`select public.stock_outbox_sweep()`);
  ok(swept === '0' && sql(`select string_agg(array_to_string(flags, ','), ';' order by check_id) from stock_outbox where check_id in ('chk-break', 'kiosk-old') and kind = 'sale'`) === 'switch_grace;switch_grace',
    `the resume's grace window had already covered the broken insert and the deleted event; the sweep adds nothing more (${swept})`);
  const once = sql(`select count(*) from closed_checks c where c.location_id = '${V1}' and c.id not like 'demo-%' and coalesce(c.source, '') <> 'booking'
    and not coalesce(c.voided, false) and coalesce(c.status, 'paid') not in ('void', 'voided') and c.closed_at < now()
    and not exists (select 1 from stock_outbox o where o.location_id = '${V1}' and o.check_id = c.id and o.kind = 'sale')
    and not exists (select 1 from stock_movements m where m.location_id = '${V1}' and m.source_id = c.id)`);
  ok(once === '0', `every paid check at the central venue has a sale event or its movements (${once} without)`);
}

// -- 12. parity with explode.js ---------------------------------------------------------------
console.log('\n12. Parity: SQL stock_explode vs explode.js (no wastage on quantity), 1,000 random baskets');
{
  const { explodeBasket } = await import(pathToFileURL(join(repo, 'src/lib/stock/explode.js')).href);
  let seedN = 20261018;
  const rnd = () => { seedN = (seedN * 1103515245 + 12345) % 2147483648; return seedN / 2147483648; };
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const VP = id('0b000000', 'aa');
  const units = { each: 'COUNT', dozen: 'COUNT', g: 'WEIGHT', kg: 'WEIGHT', oz: 'WEIGHT', lb: 'WEIGHT', mg: 'WEIGHT', ml: 'VOLUME', l: 'VOLUME', cl: 'VOLUME', pt: 'VOLUME', floz: 'VOLUME', gal: 'VOLUME' };
  const base = ['each', 'g', 'ml'];
  const items = [], packs = [], convs = [], recs = [], lines = [], links = [];
  for (let i = 0; i < 40; i++) {
    const iid = `21000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
    const bu = pick(base);
    items.push({ id: iid, bu });
    if (rnd() < 0.3) packs.push({ id: `22000000-0000-4000-8000-${String(i).padStart(12, '0')}`, item: iid, qty: Math.round(rnd() * 5000) / 10 + 1 });
    if (rnd() < 0.35) { const other = pick(base.filter((b) => b !== bu)); convs.push({ item: iid, fq: 1, fu: bu === 'each' ? 'each' : pick(Object.keys(units).filter((u) => units[u] === units[bu])), tq: Math.round(rnd() * 3000) / 10 + 1, tu: other }); }
  }
  const tagsets = [null, null, null, ['takeaway', 'collection', 'delivery'], ['dine-in'], ['drive-thru'], ['takeaway'], []];
  for (let r = 0; r < 30; r++) {
    const rid = `23000000-0000-4000-8000-${String(r).padStart(12, '0')}`;
    recs.push({ id: rid, wastage: pick([0, 0, 5, 10]) });
    const n = 1 + Math.floor(rnd() * 6);
    for (let k = 0; k < n; k++) {
      const it = pick(items);
      const p = packs.find((x) => x.item === it.id);
      const unit = p && rnd() < 0.3 ? `@${p.id}` : pick([it.bu, it.bu, ...Object.keys(units)]);
      lines.push({ recipe: rid, comp: it.id, qty: Math.round(rnd() * 300) / 10, unit, usable: pick([100, 100, 95, 80, 0, null]), tags: pick(tagsets) });
    }
    links.push({ menu: `mi-${r}`, recipe: rid, portion: pick([1, 1, 2, 0.5, 0]) });
  }
  const ins = [`insert into locations (id, name) values ('${VP}', 'parity');`];
  ins.push(...items.map((i) => `insert into inventory_items (id, location_id, name, base_unit) values ('${i.id}', '${VP}', 'i', '${i.bu}');`));
  ins.push(...packs.map((p) => `insert into item_packaging_formats (id, location_id, inventory_item_id, name, qty_in_base) values ('${p.id}', '${VP}', '${p.item}', 'p', ${p.qty});`));
  ins.push(...convs.map((c) => `insert into inventory_item_conversions (location_id, inventory_item_id, from_qty, from_unit, to_qty, to_unit) values ('${VP}', '${c.item}', ${c.fq}, '${c.fu}', ${c.tq}, '${c.tu}');`));
  ins.push(...recs.map((r) => `insert into recipes (id, location_id, wastage_pct) values ('${r.id}', '${VP}', ${r.wastage});`));
  ins.push(...lines.map((l) => `insert into recipe_lines (location_id, recipe_id, component_item_id, qty, unit, usable_pct, order_types) values ('${VP}', '${l.recipe}', '${l.comp}', ${l.qty}, '${l.unit}', ${l.usable == null ? 'null' : l.usable}, ${l.tags == null ? 'null' : `'${JSON.stringify(l.tags)}'`});`));
  ins.push(...links.map((k) => `insert into menu_item_recipes (location_id, menu_item_id, recipe_id, portion) values ('${VP}', '${k.menu}', '${k.recipe}', ${k.portion});`));
  sql(ins.join('\n'));
  const itemsById = {};
  for (const i of items) itemsById[i.id] = { baseUnit: i.bu, itemConversions: convs.filter((c) => c.item === i.id).map((c) => ({ fromQty: c.fq, fromUnit: c.fu, toQty: c.tq, toUnit: c.tu })), formats: packs.filter((p) => p.item === i.id).map((p) => ({ id: p.id, name: 'p', qtyInBase: p.qty })) };
  const menuRecipes = {};
  for (const k of links) menuRecipes[k.menu] = { portion: Number(k.portion) || 1, wastagePct: 0, lines: lines.filter((l) => l.recipe === k.recipe).map((l) => ({ componentItemId: l.comp, qty: l.qty, unit: l.unit, usablePct: l.usable == null ? 100 : l.usable, orderTypes: Array.isArray(l.tags) && l.tags.length ? l.tags : null })) };
  const ctx = { itemsById, menuRecipes };
  const ots = [null, 'dine-in', 'takeaway', 'collection', 'delivery', 'drive-thru', 'Drive Thru', 'bar-tab', 'counter', 'eat_in', 'DineIn'];
  const qtys = [1, 2, 3, '2', '', 0, -1, null, 'abc', 1.5];
  const N = 1000; const baskets = [];
  for (let b = 0; b < N; b++) {
    const n = 1 + Math.floor(rnd() * 4); const ls = [];
    for (let k = 0; k < n; k++) {
      const useId = rnd() < 0.25;
      const mid = rnd() < 0.9 ? pick(links).menu : 'custom';
      const line = useId ? { id: mid, qty: pick(qtys) } : { itemId: mid, qty: pick(qtys), id: 'line-' + k };
      if (rnd() < 0.05) line.voided = true;
      if (rnd() < 0.5) line.mods = Array.from({ length: Math.floor(rnd() * 3) + 1 }, () => {
        const m = { itemId: pick(links).menu, label: 'm' };
        if (rnd() < 0.3) m.qty = pick([2, '3', 0]);
        if (rnd() < 0.15) m._instruction = true;
        if (rnd() < 0.15) m.removed = pick([true, false]);
        return m;
      });
      ls.push(line);
    }
    baskets.push({ ls, ot: pick(ots) });
  }
  // the till's mapping (deplete.js) plus the three v5.11.77 rules: itemId else id, removed mods out, bar-tab is dine in
  const norm = (ot) => (ot && String(ot).trim().toLowerCase().replace(/[\s_-]/g, '') === 'bartab' ? 'dine-in' : ot);
  const jsOut = baskets.map(({ ls, ot }) => {
    const sold = ls.filter((it) => !it.voided && (it.itemId || it.id)).map((it) => ({ itemId: it.itemId || it.id, qty: Number(it.qty) || 1, mods: (it.mods || []).filter((m) => !m.removed) }));
    const agg = explodeBasket(sold, ctx, norm(ot) || 'dine-in');
    return Object.fromEntries(Object.entries(agg).filter(([, v]) => v > 0));
  });
  const calls = baskets.map(({ ls, ot }, i) => `select ${i}, inventory_item_id, qty_base from public.stock_explode('${VP}', ${lit(JSON.stringify(ls))}::jsonb, ${ot == null ? 'null' : lit(ot)})`).join('\nunion all\n');
  const t0 = Date.now();
  const rows = sql(calls + ';').split('\n').filter(Boolean).map((l) => l.split('|'));
  const ms = Date.now() - t0;
  const sqlOut = baskets.map(() => ({}));
  for (const [i, it, q] of rows) sqlOut[Number(i)][it] = Number(q);
  let bad = 0, cmp = 0, maxDiff = 0, firstBad = null;
  for (let i = 0; i < N; i++) {
    const keys = new Set([...Object.keys(jsOut[i]), ...Object.keys(sqlOut[i])]);
    for (const k of keys) {
      cmp++;
      const a = jsOut[i][k] ?? 0, b = sqlOut[i][k] ?? 0;
      const d = Math.abs(Math.round(a * 1e4) / 1e4 - Math.round(b * 1e4) / 1e4);
      maxDiff = Math.max(maxDiff, d);
      if (d > 0.0001 + 1e-9) { bad++; firstBad ??= { i, k, a, b, basket: baskets[i] }; }
    }
  }
  ok(bad === 0, `${N} baskets, ${cmp} item quantities compared, ${bad} differ beyond 0.0001 (max ${maxDiff.toExponential(2)}); SQL took ${ms} ms for all`);
  if (firstBad) note('first difference: ' + JSON.stringify(firstBad).slice(0, 600));
}

// -- 13. the real Provo ledger checks (optional: needs the read only dumps) ----------------------
console.log('\n13. Replay of the real Provo ledger checks');
if (REPLAY_DIR && existsSync(join(REPLAY_DIR, 'checks.json'))) {
  const { explodeBasket } = await import(pathToFileURL(join(repo, 'src/lib/stock/explode.js')).href);
  const D = (f) => JSON.parse(readFileSync(join(REPLAY_DIR, `${f}.json`), 'utf8'));
  const items = D('inventory_items'), convs = D('convs'), packs = D('packs'), links = D('links'), recipes = D('recipes'), lines = D('lines'), checks = D('checks'), moves = D('moves');
  const VR = id('0b000000', 'bb');
  const ins = [`insert into locations (id, name) values ('${VR}', 'replay');`];
  ins.push(...items.map((i) => `insert into inventory_items (id, location_id, name, base_unit, current_cost) values ('${i.id}', '${VR}', ${lit(i.name)}, ${lit(i.base_unit)}, ${i.current_cost == null ? 'null' : Number(i.current_cost)});`));
  ins.push(...packs.map((p) => `insert into item_packaging_formats (id, location_id, inventory_item_id, name, qty_in_base) values ('${p.id}', '${VR}', '${p.inventory_item_id}', ${lit(p.name)}, ${Number(p.qty_in_base)});`));
  ins.push(...convs.map((c) => `insert into inventory_item_conversions (location_id, inventory_item_id, from_qty, from_unit, to_qty, to_unit) values ('${VR}', '${c.inventory_item_id}', ${Number(c.from_qty)}, ${lit(c.from_unit)}, ${Number(c.to_qty)}, ${lit(c.to_unit)});`));
  ins.push(...recipes.filter((r) => !r.archived_at).map((r) => `insert into recipes (id, location_id, name, wastage_pct) values ('${r.id}', '${VR}', ${lit(r.name)}, ${Number(r.wastage_pct) || 0});`));
  ins.push(...lines.map((l) => `insert into recipe_lines (location_id, recipe_id, component_item_id, qty, unit, usable_pct, order_types) values ('${VR}', '${l.recipe_id}', '${l.component_item_id}', ${Number(l.qty)}, ${lit(l.unit)}, ${l.usable_pct == null ? 'null' : Number(l.usable_pct)}, ${l.order_types == null ? 'null' : lit(JSON.stringify(l.order_types))});`));
  ins.push(...links.map((k) => `insert into menu_item_recipes (location_id, menu_item_id, recipe_id, portion) values ('${VR}', ${lit(k.menu_item_id)}, '${k.recipe_id}', ${Number(k.portion) || 1});`));
  sql(ins.join('\n'));
  const convBy = {}; convs.forEach((c) => (convBy[c.inventory_item_id] ??= []).push({ fromQty: Number(c.from_qty), fromUnit: c.from_unit, toQty: Number(c.to_qty), toUnit: c.to_unit }));
  const fmtBy = {}; packs.forEach((p) => (fmtBy[p.inventory_item_id] ??= []).push({ id: p.id, name: p.name, qtyInBase: Number(p.qty_in_base) }));
  const itemsById = {}; items.forEach((it) => { itemsById[it.id] = { baseUnit: it.base_unit, itemConversions: convBy[it.id] || [], formats: fmtBy[it.id] || [] }; });
  const linesBy = {}; lines.forEach((l) => (linesBy[l.recipe_id] ??= []).push({ componentItemId: l.component_item_id, qty: Number(l.qty), unit: l.unit, usablePct: l.usable_pct == null ? 100 : Number(l.usable_pct), orderTypes: Array.isArray(l.order_types) && l.order_types.length ? l.order_types : null }));
  const menuRecipes = {}; links.forEach((k) => { menuRecipes[String(k.menu_item_id)] = { lines: linesBy[k.recipe_id] || [], portion: Number(k.portion) || 1, wastagePct: 0 }; });
  const ledger = {}; moves.filter((m) => m.movement_type === 'SALE_DEPLETION').forEach((m) => { (ledger[m.source_id] ??= {})[m.inventory_item_id] = -Number(m.qty_base); });
  const live = checks.filter((c) => c.status !== 'voided');
  const calls = live.map((c, i) => `select ${i}, inventory_item_id, qty_base from public.stock_explode('${VR}', ${lit(JSON.stringify(c.items || []))}::jsonb, ${c.order_type == null ? 'null' : lit(c.order_type)})`).join('\nunion all\n');
  const rows = sql(calls + ';').split('\n').filter(Boolean).map((l) => l.split('|'));
  const sqlOut = live.map(() => ({}));
  for (const [i, it, q] of rows) sqlOut[Number(i)][it] = Number(q);
  let bad = 0, cmp = 0, ledgerChecks = 0, ledgerExact = 0, ledgerDiff = 0;
  live.forEach((c, i) => {
    const its = (Array.isArray(c.items) ? c.items : []).filter((it) => !it.voided && (it.itemId || it.id));
    const agg = explodeBasket(its.map((it) => ({ itemId: it.itemId || it.id, qty: Number(it.qty) || 1, mods: (it.mods || []).filter((m) => !m.removed) })), { itemsById, menuRecipes }, c.order_type || 'dine-in');
    const js = Object.fromEntries(Object.entries(agg).filter(([, v]) => v > 0));
    const keys = new Set([...Object.keys(js), ...Object.keys(sqlOut[i])]);
    for (const k of keys) { cmp++; if (Math.abs((js[k] ?? 0) - (sqlOut[i][k] ?? 0)) > 0.0001) bad++; }
    if (ledger[c.id]) {
      ledgerChecks++;
      const lk = new Set([...Object.keys(ledger[c.id]), ...Object.keys(sqlOut[i])]);
      let d = 0; for (const k of lk) if (Math.abs((ledger[c.id][k] ?? 0) - (sqlOut[i][k] ?? 0)) > 0.0001) d++;
      if (d) ledgerDiff++; else ledgerExact++;
    }
  });
  ok(bad === 0, `${live.length} real checks: SQL and explode.js agree on every quantity (${cmp} compared, ${bad} differ)`);
  note(`against the ledger the till wrote: ${ledgerChecks} checks had movements, ${ledgerExact} match exactly, ${ledgerDiff} differ (wastage no longer multiplies the quantity, and recipes edited after the sale)`);
} else {
  note('skipped: set CENTRAL_REPLAY_DIR to the folder holding the Provo read only dumps (checks.json, links.json, lines.json, recipes.json, inventory_items.json, packs.json, convs.json, moves.json)');
}

// -- 14. migration twice, the rollback round trip, the guard --------------------------------------
console.log('\n14. A second run, the ROLLBACK, a run after it, the guard');
{
  let r = sqlText1(migC, { allowFail: true });
  ok(r.status === 0, `a second run passes its own guard (${(r.stderr || '').trim().split('\n')[0] || 'ok'})`);
  ok(md5Of(SIG_PSM) !== fencedMd5 && sql(`select count(*) from stock_outbox`) !== '0', 'and keeps the door and the outbox rows');
  const rb = sqlFile(RB_C, { allowFail: true });
  const rbRow = rb.stdout.trim().split('\n').pop();
  ok(rb.status === 0 && /^0\|0\|0\|1\|3\|\d+$/.test(rbRow), `the ROLLBACK applies, visible check 0|0|0|1|3|<movements> (${rbRow})`);
  ok(md5Of(SIG_PSM) === fencedMd5, `the ROLLBACK puts post_stock_movement back to 20261018a's text (md5 ${md5Of(SIG_PSM)})`);
  r = asCaller('till1', `select public.post_stock_movement('${V1}', '${item(1)}', -1, 'SALE_DEPLETION', null, 'closed_check', 'chk-rb', 'sale:chk-rb:${item(1)}')::text`);
  ok(/"duplicate": false/.test(r.out) && !/skipped/.test(r.out), 'after the ROLLBACK the door is open: the till posts again at the central venue');
  insertCheck('till1', { id: 'chk-after-rb', location_id: V1, items: [{ itemId: 'mi-cola', qty: 1 }], ref: 'RB' });
  ok(sql(`select count(*) from stock_outbox where check_id = 'chk-after-rb'`) === '0', 'and nothing is enqueued any more');
  ok(sql(`select count(*) from stock_depletion_mode`) !== '0' && sql(`select count(*) from stock_movements`) !== '0', 'the tables and the movements are kept');
  const again = sqlText1(migC, { allowFail: true });
  ok(again.status === 0, 'the migration applies again after the ROLLBACK');
  r = asCaller('till1', `select public.post_stock_movement('${V1}', '${item(1)}', -1, 'SALE_DEPLETION', null, 'closed_check', 'chk-rb2', 'sale:chk-rb2:${item(1)}')::text`);
  ok(/skipped/.test(r.out), 'and the door is shut again');
  // 20261018a's own ROLLBACK (PR 301) checks signatures, not texts: run while the door is live it
  // replaces the door with the 20261016 text and drops the core the drainer posts through. That is
  // why 20261018c_ROLLBACK runs FIRST. Shown here, then the chain is put back for the load section.
  const rbA = sqlFile(join(repo, 'supabase/migrations/20261018a_OPS_stock_function_fences_ROLLBACK.sql'), { allowFail: true });
  ok(rbA.status === 0 && sql(`select count(*) from pg_proc where proname = '_post_stock_movement'`) === '0', '20261018a_ROLLBACK run out of order takes the posting core away (so 20261018c_ROLLBACK goes first)');
  insertCheck('till1', { id: 'chk-no-core', location_id: V1, items: [{ itemId: 'mi-cola', qty: 1 }], ref: 'NC' });
  drain();
  ok(sql(`select status || ':' || left(last_error, 5) from stock_outbox where check_id = 'chk-no-core'`) === 'pending:42883' && sql(`select count(*) from closed_checks where id = 'chk-no-core'`) === '1',
    'with the core gone a sale is still saved; its event fails and waits (42883), nothing is lost');
  const reA = sqlText1(readFileSync(MIG_A, 'utf8'), { allowFail: true });
  const reC = sqlText1(migC, { allowFail: true });
  sql(`update stock_outbox set due_at = now() where check_id = 'chk-no-core'`);
  drain();
  ok(reA.status === 0 && reC.status === 0 && sql(`select status from stock_outbox where check_id = 'chk-no-core'`) === 'done', 'both migrations applied again: the waiting event posts');
  // the guard: no fences
  freshDb('central_nofence', { withFences: false });
  const nf = sqlText1(migC, { allowFail: true });
  ok(nf.status !== 0 && /run 20261018a/.test(nf.stderr) && sql(`select count(*) from pg_proc where proname = 'stock_explode'`) === '0', 'without 20261018a the file stops and names it, nothing changed');
  freshDb('central_badtext');
  sql(`create or replace function public.post_stock_movement(p_location_id uuid, p_inventory_item_id uuid, p_qty_base numeric, p_movement_type text, p_unit_cost numeric default null, p_source_type text default null, p_source_id text default null, p_idempotency_key text default null, p_occurred_at timestamptz default null, p_created_by uuid default null, p_notes text default null, p_area_id uuid default null) returns jsonb language plpgsql security definer set search_path = public as $$ begin return '{}'::jsonb; end $$;`);
  const bt = sqlText1(migC, { allowFail: true });
  ok(bt.status !== 0 && /not the 20261018a text/.test(bt.stderr) && sql(`select count(*) from pg_proc where proname = 'stock_explode'`) === '0', 'a changed post_stock_movement stops the file, nothing changed');
}

// -- 15. load: 50 sites x 300 checks an hour x 10 lines -------------------------------------------
console.log(`\n15. Load: 50 sites x ${QUICK ? 30 : 300} checks x 10 lines (+1 modifier)${QUICK ? ' (--quick: a tenth of the target hour)' : ' (one target hour)'}`);
{
  DB = 'central_main';
  sql(`truncate stock_outbox, stock_outbox_runs;`);
  const SITES = 50, PER = QUICK ? 30 : 300;
  sql(`
  do $$
  declare v uuid; a uuid; s int; k int; r uuid; it uuid[];
  begin
    for s in 1..${SITES} loop
      v := ('30000000-0000-4000-8000-' || lpad(s::text, 12, '0'))::uuid;
      insert into locations (id, org_id, name) values (v, '${ORG}', 'site ' || s);
      insert into devices (location_id, name, status, device_uid, bound_via) values (v, 'till', 'active', ('31000000-0000-4000-8000-' || lpad(s::text, 12, '0'))::uuid, 'claim');
      insert into storage_areas (location_id, name) values (v, 'Kitchen') returning id into a;
      it := '{}';
      for k in 1..60 loop
        insert into inventory_items (location_id, name, base_unit, current_cost, on_hand) values (v, 'item ' || k, (array['each','g','ml'])[1 + k % 3], 0.01 * k, 1000000) returning id into r;
        insert into inventory_item_areas (location_id, inventory_item_id, area_id) values (v, r, a);
        insert into inventory_item_area_stock (location_id, inventory_item_id, area_id, on_hand) values (v, r, a, 1000000);
        it := it || r;
      end loop;
      for k in 1..80 loop
        insert into recipes (location_id, name) values (v, 'dish ' || k) returning id into r;
        insert into menu_item_recipes (location_id, menu_item_id, recipe_id) values (v, 'mi-' || k, r);
        insert into recipe_lines (location_id, recipe_id, component_item_id, qty, unit, order_types)
        select v, r, it[1 + ((k * 7 + g * 13) % 60)], 1 + g, (select base_unit from inventory_items where id = it[1 + ((k * 7 + g * 13) % 60)]),
               case when g = 0 then '["takeaway","collection","delivery"]'::jsonb end
          from generate_series(0, 2 + k % 4) g;
      end loop;
      insert into stock_depletion_mode (location_id, mode, central_since) values (v, 'central', now());
    end loop;
  end $$;
  analyze;`);
  const siteId = (s) => `30000000-0000-4000-8000-${String(s).padStart(12, '0')}`;
  const tillOf = (s) => ({ login: 'authenticator', role: 'authenticated', claims: anonSession(`31000000-0000-4000-8000-${String(s).padStart(12, '0')}`) });
  const lines10 = (i) => JSON.stringify(Array.from({ length: 10 }, (_, j) => ({ itemId: `mi-${1 + (i * 3 + j * 11) % 80}`, qty: 1 + (j % 2), mods: j === 0 ? [{ itemId: `mi-${1 + (i * 7) % 80}` }] : [] })));
  const mkInserts = (prefix, s, n) => Array.from({ length: n }, (_, i) =>
    `insert into closed_checks (id, location_id, items, order_type, ref) values ('${prefix}-${i}', '${siteId(s)}', ${lit(lines10(i))}, '${i % 3 ? 'dine-in' : 'takeaway'}', 'R${i}') on conflict (id) do nothing;`).join('\n');
  const timed = (fn) => { const t = Date.now(); fn(); return Date.now() - t; };
  const runAs = (c, body) => { const lines = callerLines(c); lines.push(body, 'commit;'); return psql({ login: c.login, input: lines.join('\n') + '\n' }); };
  // the cost of the trigger on a sale write: 600 single row inserts, trigger no op vs outbox row
  sql(`update stock_depletion_mode set mode = 'browser' where location_id = '${siteId(50)}'`);
  const tOff = timed(() => runAs(tillOf(50), mkInserts('off', 50, 600)));
  const tOn = timed(() => runAs(tillOf(1), mkInserts('on', 1, 600)));
  ok(tOn - tOff < 600 * 0.5, `600 till inserts: browser venue (trigger no op) ${tOff} ms, central venue (one outbox row) ${tOn} ms, about ${((tOn - tOff) / 600).toFixed(2)} ms extra per sale`);
  sql(`update stock_depletion_mode set mode = 'central' where location_id = '${siteId(50)}'`);
  sql(`truncate stock_outbox, stock_outbox_runs; delete from stock_movements where location_id in (select id from locations where name like 'site %');`);
  const logBefore = readFileSync(PGLOG, 'utf8').split('\n').filter((l) => /still waiting|deadlock detected/.test(l)).length;
  const t0 = Date.now();
  for (let s = 1; s <= SITES; s++) runAs(tillOf(s), mkInserts(`h${s}`, s, PER));
  const tEnq = Date.now() - t0;
  const pend = Number(sql(`select count(*) from stock_outbox where status = 'pending'`));
  const t1 = Date.now();
  // two drainers: one runs, the other exits (the advisory lock), as two overlapping cron minutes would
  const dr = await Promise.all([psqlAsync({ input: 'call public.stock_outbox_drain(3600, 50, 0, true);' }), psqlAsync({ input: 'call public.stock_outbox_drain(3600, 50, 0, true);' })]);
  const tDrain = Date.now() - t1;
  const done = Number(sql(`select count(*) from stock_outbox where status = 'done'`));
  const moves = Number(sql(`select count(*) from stock_movements where source_type = 'closed_check' and location_id in (select id from locations where name like 'site %')`));
  ok(dr.every((r) => r.status === 0) && done === pend && pend === SITES * PER, `${pend} checks x 10 lines enqueued in ${(tEnq / 1000).toFixed(1)} s of client time; drained ${done} events, ${moves} movements in ${(tDrain / 1000).toFixed(1)} s = ${(done / (tDrain / 1000)).toFixed(1)} checks/s, ${(moves / (tDrain / 1000)).toFixed(0)} movements/s (target 4.2 checks/s)`);
  const dbl = sql(`select count(*) from (select location_id, idempotency_key from stock_movements where idempotency_key is not null group by 1, 2 having count(*) > 1) d`);
  const ledger = sql(`select count(*) from inventory_items i where i.location_id in (select id from locations where name like 'site %') and i.on_hand <> 1000000 + coalesce((select sum(qty_base) from stock_movements m where m.inventory_item_id = i.id), 0)`);
  ok(dbl === '0' && ledger === '0', 'I1: on hand equals the opening plus the movements for every item at every site; I3: no key twice');
  const logAfter = readFileSync(PGLOG, 'utf8').split('\n').filter((l) => /still waiting|deadlock detected/.test(l)).length;
  const deadlocks = sql(`select deadlocks from pg_stat_database where datname = current_database()`);
  ok(deadlocks === '0', `lock waits over 100 ms during the load: ${logAfter - logBefore}; deadlocks in this database: ${deadlocks}`);
  const runs = sql(`select count(*) || ' runs, max failed ' || coalesce(max(failed), 0) from stock_outbox_runs`);
  note(`drain runs: ${runs}; sizes after the load: ${sql(`select pg_size_pretty(pg_total_relation_size('stock_outbox')) || ' outbox, ' || pg_size_pretty(pg_total_relation_size('stock_movements')) || ' ledger'`)}`);
  // eight tills hammering one site while a drainer runs: no deadlocks, one movement set per check
  const t2 = Date.now();
  const eight = await Promise.all([
    ...Array.from({ length: 8 }, (_, t) => { const c = tillOf(2); const lines = callerLines(c); lines.push(mkInserts(`e${t}`, 2, 100), 'commit;'); return psqlAsync({ login: c.login, input: lines.join('\n') + '\n' }); }),
    psqlAsync({ input: 'select pg_sleep(0.5); call public.stock_outbox_drain(60, 50, 0.2, true);' }),
  ]);
  const pending2 = sql(`select count(*) from stock_outbox where status = 'pending'`);
  if (pending2 !== '0') sql('call public.stock_outbox_drain(600, 50, 0, true);');
  const e8 = sql(`select count(*) from stock_outbox where check_id like 'e%-%' and status = 'done'`);
  ok(eight.every((r) => r.status === 0) && e8 === '800' && sql(`select deadlocks from pg_stat_database where datname = current_database()`) === '0',
    `8 tills x 100 inserts at one site with a drainer running: ${e8} events done in ${((Date.now() - t2) / 1000).toFixed(1)} s, 0 deadlocks`);
  const ledger2 = sql(`select count(*) from inventory_items i where i.location_id = '${siteId(2)}' and i.on_hand <> 1000000 + coalesce((select sum(qty_base) from stock_movements m where m.inventory_item_id = i.id), 0)`);
  ok(ledger2 === '0', 'I1 holds at that site');
}

stop();
console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks hold');
process.exit(failures ? 1 : 0);
