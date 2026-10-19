#!/usr/bin/env node
// 20261019 (central stock the default for every venue, and every new venue): the set up is copied from run.mjs; the checks are at the end.
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
const SIG_LEG = 'public.post_stock_transfer_leg(uuid,text,text)';
const REVIEW_ONLY = process.argv.includes('--review-only');
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


// ---- 20261019 central stock default: new venues and every venue ------------------------------
const MIG_D = join(repo, 'supabase/migrations/20261019_OPS_central_stock_default.sql');
const MIG_D_RB = join(repo, 'supabase/migrations/20261019_OPS_central_stock_default_ROLLBACK.sql');
freshDb('central_default');
{ const r = sqlText1(readFileSync(MIG_C, 'utf8'), { allowFail: true }); ok(r.status === 0, `20261018c applies (${(r.stderr || '').trim().split('\n')[0] || 'ok'})`); }
seed();
// V3 is switched to browser on purpose by an operator before the default: it must stay browser.
sql(`select public.stock_central_switch('${V3}', 'browser', 'operator')`);
const before = sql(`select count(*) from locations`);
const r1 = sqlText1(readFileSync(MIG_D, 'utf8'), { allowFail: true });
ok(r1.status === 0, `20261019 applies (${(r1.stderr || '').trim().split('\n')[0] || 'ok'})`);
const row1 = r1.stdout.trim().split('\n').pop();
note(`check row after first run: ${row1}`);
ok(sql(`select count(*) from stock_depletion_mode m where m.mode = 'central' and m.central_since is not null and m.location_id in ('${V1}','${V2}','${V4}')`) === '3', 'every venue without a row is central now, with central_since set (V1, V2, V4)');
ok(sql(`select mode from stock_depletion_mode where location_id = '${V3}'`) === 'browser', 'a venue an operator set to browser is left alone');
ok(sql(`select mode from stock_depletion_default`) === 'browser', 'the default stays browser (20261018c self test)');
// a new venue as the database (admin tools) and as the service role through the API login
const NEWV = id('0b000000', 77), NEWV2 = id('0b000000', 78), NEWV3 = id('0b000000', 79);
sql(`insert into locations (id, org_id, name) values ('${NEWV}', '${ORG}', 'brand new venue')`);
ok(sql(`select mode || '|' || (central_since is not null)::text || '|' || changed_by from stock_depletion_mode where location_id = '${NEWV}'`) === 'central|true|new venue', 'a new venue is central from the moment it is created');
const svc = psql({ login: 'postgres', input: `begin; grant insert, select on public.locations to service_role; set local role service_role; insert into public.locations (id, org_id, name) values ('${NEWV2}', '${ORG}', 'made by the service role'); commit;`, allowFail: true });
ok(svc.status === 0 && sql(`select mode from stock_depletion_mode where location_id = '${NEWV2}'`) === 'central', `a venue made by the service role is central too (${(svc.stderr || '').trim().split('\n')[0] || 'ok'})`);
// the switch failing never blocks a venue being created
const fail = psql({ login: 'postgres', input: `begin; alter function public.stock_central_switch(uuid,text,text) rename to stock_central_switch_gone; insert into public.locations (id, org_id, name) values ('${NEWV3}', '${ORG}', 'switch missing'); select count(*) from public.locations where id = '${NEWV3}'; rollback;`, allowFail: true });
ok(fail.status === 0 && fail.stdout.trim().endsWith('1') && /not switched on for new venue/.test(fail.stderr || ''), 'if the switch fails, the venue is still created and a warning names it');
// a sale at a new venue with no recipes enqueues nothing
const obBefore = sql(`select count(*) from stock_outbox`);
sql(`insert into closed_checks (id, location_id, items, total, closed_at, status) values ('chk-newvenue-1', '${NEWV}', '[{"itemId":"x","qty":1,"price":3}]'::jsonb, 3, now(), 'paid')`);
ok(sql(`select count(*) from stock_outbox`) === obBefore, 'a sale at a new venue with no recipes books nothing');
// twice, then 20261018c again (its self test), then the rollback, then again
const r2 = sqlText1(readFileSync(MIG_D, 'utf8'), { allowFail: true });
ok(r2.status === 0, 'a second run passes');
const row2 = r2.stdout.trim().split('\n').pop();
note(`check row after second run: ${row2}`);
const n = Number(sql(`select count(*) from locations`));
ok(row2 === `${n}|${n - 1}|1|1|0|browser`, `the check row reads venues ${n}, central ${n - 1} (V3 left on browser by an operator), 1 not central, trigger 1, open to API 0, default browser`);
ok(sql(`select count(*) from pg_trigger where tgrelid = 'public.locations'::regclass and tgname = 'locations_central_stock_on_create'`) === '1', 'one trigger after two runs');
{ const r = sqlText1(readFileSync(MIG_C, 'utf8'), { allowFail: true }); ok(r.status === 0, `20261018c runs again after it, its self test passes (${(r.stderr || '').trim().split('\n')[0] || 'ok'})`); }
{ const r = sqlText1(readFileSync(MIG_D_RB, 'utf8'), { allowFail: true }); ok(r.status === 0 && r.stdout.trim().split('\n').pop() === '0|0', `the rollback removes the trigger and function (${r.stdout.trim().split('\n').pop()})`); }
ok(sql(`select count(*) from stock_depletion_mode where location_id = '${NEWV}' and mode = 'central'`) === '1', 'after the rollback venues keep their mode');
{ const r = sqlText1(readFileSync(MIG_D, 'utf8'), { allowFail: true }); ok(r.status === 0, 'and it applies again'); }
// ASCII only, no begin or commit of its own
const txt = readFileSync(MIG_D, 'utf8');
ok(!/[^\x09\x0a\x0d\x20-\x7e]/.test(txt), 'the file is ASCII only');
ok(!/^\s*(begin|commit)\s*;/im.test(txt), 'no begin or commit of its own');
stop();
console.log(failures ? `\n${failures} FAILED` : '\nall checks hold');
process.exit(failures ? 1 : 0);
