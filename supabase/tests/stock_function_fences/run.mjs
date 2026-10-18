#!/usr/bin/env node
// run.mjs: proves 20261018a (stock function fences) on a local, throwaway PostgreSQL 17, with the
// texts of the three stock functions as 20261016 and the 5 Aug catalog left them, before Peter runs
// it on the Ops database.
//
//   node supabase/tests/stock_function_fences/run.mjs              the whole proof
//   node supabase/tests/stock_function_fences/run.mjs --print-md5  the guard constants, then stop
//
// It never connects to Supabase. It starts its own cluster in a temp folder (initdb and pg_ctl from
// PATH or /opt/homebrew/bin) and stops it at the end. Every call is made the way the API makes it:
// logged in as authenticator, SET ROLE anon, authenticated or service_role, the request claims set,
// and the live statement timeouts (authenticated 8 s, anon 3 s). "SQL editor" calls log in as
// postgres with no claims. What it proves, in order:
//   1. the guard constants in the migration are the md5s of these function texts;
//   2. BEFORE: the doors are open (a stranger, the bare anon key, an unbound till, a till of another
//      venue and a login of another company can all post stock or set on hand), so every refusal
//      case below fails on the old functions;
//   3. the migration applies as the SQL editor runs a paste (one transaction, stop on error), its
//      self test included, the visible check answers as documented, and it leaves the role alone;
//   4. AFTER: the bound till, kiosk and ops tablet, the Back Office login, the owner, the super
//      admin, the service role and the SQL editor still post; every stranger is refused (42501);
//      a foreign item or area is refused (22023); the till's own call shape books the ledger,
//      on hand and the area holding, and a repeat is a duplicate;
//   5. transfers: the same rule, one company only between venues, the sender's own lines and areas;
//   6. scale: 2,000 venues, 5,000 devices, 20,000 venue links: the cost of the check per call;
//   7. a second run passes its own guard; the ROLLBACK puts all three texts back (md5) and the
//      doors open again; the migration applies again after it;
//   8. the guard refuses a changed function, and the self test stops the file when the reach rule
//      is too wide (a stranger allowed) or too narrow (user_accessible_locations only: the tills
//      would lose their stock), with nothing changed.
// Exit code 0 only when everything above holds.

import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..');
const MIGRATION = join(repo, 'supabase/migrations/20261018a_OPS_stock_function_fences.sql');
const ROLLBACK = join(repo, 'supabase/migrations/20261018a_OPS_stock_function_fences_ROLLBACK.sql');
const LIVE = {
  psm: join(here, 'live/post_stock_movement_20261016.sql'),
  leg: join(here, 'live/post_stock_transfer_leg_20261016.sql'),
  sioh: join(here, 'live/set_inventory_on_hand_20260805.sql'),
  helpers: join(here, 'live/helpers.sql'),
};
const PRINT_MD5 = process.argv.includes('--print-md5');

const bin = (name) => (existsSync(`/opt/homebrew/bin/${name}`) ? `/opt/homebrew/bin/${name}` : name);
const env = { ...process.env, LC_ALL: 'en_US.UTF-8', PGOPTIONS: '-c client_min_messages=notice' };

let failures = 0;
const ok = (cond, msg) => { if (cond) console.log(`  ok   ${msg}`); else { failures++; console.log(`  FAIL ${msg}`); } };

// -- the cluster -------------------------------------------------------------
const port = process.env.FENCE_PGPORT || String(55400 + Math.floor(Math.random() * 80));
const dir = mkdtempSync(join(tmpdir(), 'pgf.'));   // short path: the socket lives here
const data = join(dir, 'data');
{
  let r = spawnSync(bin('initdb'), ['-D', data, '-U', 'postgres', '--auth=trust', '-E', 'UTF8'], { env, encoding: 'utf8' });
  if (r.status !== 0) { console.error(r.stderr || r.stdout); process.exit(2); }
  r = spawnSync(bin('pg_ctl'), ['-D', data, '-l', join(dir, 'pg.log'), '-w', '-o', `-p ${port} -c listen_addresses='' -k ${dir}`, 'start'], { env, encoding: 'utf8' });
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
    { env, input, encoding: 'utf8' });
  if (r.status !== 0 && !allowFail) {
    console.error('psql failed:', args.join(' '), '\n', r.stderr || r.stdout);
    stop(); process.exit(2);
  }
  return r;
}
const sql = (q, opts = {}) => psql({ ...opts, input: q }).stdout.trim();
const sqlFile = (path, opts = {}) => psql({ ...opts, args: ['-1', '-f', path] });
const sqlText1 = (text, opts = {}) => psql({ ...opts, args: ['-1', '-f', '-'], input: text });
const lit = (v) => (v == null ? 'null' : `'${String(v).replace(/'/g, "''")}'`);
const md5Of = (sig) => sql(`select md5(btrim(regexp_replace(p.prosrc, '\\s+', ' ', 'g'))) from pg_proc p where p.oid = to_regprocedure('${sig}')`);
const SIG = {
  psm: 'public.post_stock_movement(uuid,uuid,numeric,text,numeric,text,text,text,timestamptz,uuid,text,uuid)',
  sioh: 'public.set_inventory_on_hand(uuid,uuid,numeric,uuid,text)',
  leg: 'public.post_stock_transfer_leg(uuid,text,text)',
};

// -- fixtures ----------------------------------------------------------------
const id = (prefix, tail) => `${prefix}-0000-4000-8000-${tail.padStart(12, '0')}`;
const ORG_A = id('0a000000', 'a'), ORG_B = id('0b000000', 'b'), ORG_BIG = id('0c000000', 'c');
const A1 = id('a1000000', 'a1'), A2 = id('a2000000', 'a2'), B1 = id('b1000000', 'b1'), N1 = id('c1000000', 'c1');
const U = { boA1: id('10000000', 'a1'), ownerA: id('10000000', 'a'), superAdmin: id('10000000', 'ff'), boB1: id('10000000', 'b1'), ownerBig: id('10000000', 'c') };
const DEV = { tillA1: id('20000000', 'a1'), kioskA1: id('20000000', '1a1'), unboundA1: id('20000000', '2a1'), offlineA1: id('20000000', '3a1'), opsA2: id('20000000', 'a2') };
const STRANGER = id('30000000', '1');
const I = { a1: id('40000000', 'a1'), a1x: id('40000000', '1a1'), a2: id('40000000', 'a2'), b1: id('40000000', 'b1') };
const AR = { a1: id('50000000', 'a1'), a1b: id('50000000', '1a1'), a2: id('50000000', 'a2'), b1: id('50000000', 'b1') };
const T = {
  withinA1: id('60000000', '1'), a1a2: id('60000000', '2'), a1b1: id('60000000', '3'), foreignLine: id('60000000', '4'),
  foreignArea: id('60000000', '5'), sentA1A2: id('60000000', '6'), sentA1B1: id('60000000', '7'), draftForeign: id('60000000', '8'),
};

const anonSession = (sub) => ({ sub, role: 'authenticated', is_anonymous: true, aud: 'authenticated' });
const login = (sub) => ({ sub, role: 'authenticated', is_anonymous: false, aud: 'authenticated' });
const CALLERS = {
  tillA1:      { login: 'authenticator', role: 'authenticated', claims: anonSession(DEV.tillA1), what: 'till bound to A1' },
  kioskA1:     { login: 'authenticator', role: 'authenticated', claims: anonSession(DEV.kioskA1), what: 'kiosk bound to A1' },
  opsA2:       { login: 'authenticator', role: 'authenticated', claims: anonSession(DEV.opsA2), what: 'ops tablet of A2' },
  boA1:        { login: 'authenticator', role: 'authenticated', claims: login(U.boA1), what: 'Back Office login of A1' },
  boB1:        { login: 'authenticator', role: 'authenticated', claims: login(U.boB1), what: 'Back Office login of B1 (other company)' },
  ownerA:      { login: 'authenticator', role: 'authenticated', claims: login(U.ownerA), what: 'owner of company A' },
  superAdmin:  { login: 'authenticator', role: 'authenticated', claims: login(U.superAdmin), what: 'super admin' },
  service:     { login: 'authenticator', role: 'service_role', claims: { role: 'service_role' }, what: 'service role (edge function)' },
  sqlEditor:   { login: 'postgres', what: 'SQL editor (postgres, no claims)' },
  stranger:    { login: 'authenticator', role: 'authenticated', claims: anonSession(STRANGER), what: 'stranger (anonymous session bound to nothing)' },
  anonKey:     { login: 'authenticator', role: 'anon', claims: { role: 'anon' }, what: 'bare anon key' },
  unboundA1:   { login: 'authenticator', role: 'authenticated', claims: anonSession(DEV.unboundA1), what: 'till at A1 that no claim bound' },
  offlineA1:   { login: 'authenticator', role: 'authenticated', claims: anonSession(DEV.offlineA1), what: 'bound till at A1 marked retired' },
  apiNoClaims: { login: 'authenticator', role: 'authenticated', claims: null, what: 'API login with no claims' },
};

function asCaller(callerKey, body, { commit = false } = {}) {
  const c = CALLERS[callerKey];
  const lines = ['\\set VERBOSITY verbose', 'begin;'];
  if (c.claims) lines.push(`select set_config('request.jwt.claims', ${lit(JSON.stringify(c.claims))}, true) \\g /dev/null`);
  if (c.role) {
    lines.push(`set local role ${c.role};`);
    if (c.role === 'authenticated') lines.push(`set local statement_timeout = '8s';`);
    if (c.role === 'anon') lines.push(`set local statement_timeout = '3s';`);
  }
  lines.push(body.trim().replace(/;?$/, ';'));
  lines.push(commit ? 'commit;' : 'rollback;');
  const r = psql({ login: c.login, input: lines.join('\n') + '\n', allowFail: true });
  const m = /ERROR:\s+([0-9A-Z]{5}):\s*(.*)/.exec(r.stderr || '');
  return { status: r.status, sqlstate: m ? m[1] : null, message: m ? m[2] : (r.stderr || '').trim(), out: r.stdout.trim(), notices: r.stderr || '' };
}

const psmCall = (loc, item, n, { area = null, qty = -1, type = 'SALE_DEPLETION' } = {}) =>
  `select public.post_stock_movement(p_location_id => '${loc}', p_inventory_item_id => '${item}', p_qty_base => ${qty}, ` +
  `p_movement_type => '${type}', p_unit_cost => null, p_source_type => 'closed_check', p_source_id => 'chk-${n}', ` +
  `p_idempotency_key => 'sale:chk-${n}:${item}', p_occurred_at => null, p_created_by => null, p_notes => null` +
  (area ? `, p_area_id => '${area}'` : '') + ')';
const siohCall = (loc, item) => `select public.set_inventory_on_hand(p_location_id => '${loc}', p_inventory_item_id => '${item}', p_counted_qty => 5, p_created_by => null, p_notes => 'count')`;
const legCall = (t, leg) => `select public.post_stock_transfer_leg(p_transfer_id => '${t}', p_leg => '${leg}', p_by_name => 'Test')`;

// What a call answered: 'ok', a SQLSTATE, or 'words:<error>' (a jsonb ok false).
function outcome(r) {
  if (r.sqlstate) return r.sqlstate;
  if (r.status !== 0) return `fail:${r.message}`;
  try {
    const j = JSON.parse(r.out.split('\n').pop());
    if (j && j.ok === false) return `words:${j.error}`;
    if (j && j.error) return `words:${j.error}`;
    return 'ok';
  } catch { return `unparsed:${r.out}`; }
}
const matches = (got, want) => (want.startsWith('words:') ? got.startsWith('words:') && got.toLowerCase().includes(want.slice(6).toLowerCase()) : got === want);

// -- one database ------------------------------------------------------------
function freshDb(name) {
  DB = 'postgres';
  sql(`drop database if exists ${name}`);
  sql(`create database ${name}`);
  DB = name;
  sqlFile(join(here, 'schema.sql'));
  sqlFile(LIVE.helpers);
  sql(`revoke all on function public.user_accessible_locations() from public;
       grant execute on function public.user_accessible_locations() to anon, authenticated, service_role;
       grant execute on function public.is_anon_session() to anon, authenticated, service_role;
       revoke all on function public.accessible_location_ids() from public;
       revoke all on function public.accessible_location_uuids() from public;
       grant execute on function public.accessible_location_ids() to anon, authenticated, service_role;
       grant execute on function public.accessible_location_uuids() to anon, authenticated, service_role;`);
  // The three functions as they are live, with their live grants (20261016 and the 5 Aug catalog).
  sqlFile(LIVE.psm);
  sqlFile(LIVE.sioh);
  sqlFile(LIVE.leg);
  sql(`grant execute on function ${SIG.psm} to authenticated, anon, service_role;
       grant execute on function ${SIG.sioh} to public, anon, authenticated, service_role;
       revoke all on function ${SIG.leg} from public, anon;
       grant execute on function ${SIG.leg} to authenticated, service_role;`);
  seed();
}

function seed() {
  sql(`
    insert into locations (id, org_id, name, created_at) values
      ('${A1}', '${ORG_A}', 'A1', now() - interval '3 days'), ('${A2}', '${ORG_A}', 'A2', now() - interval '2 days'),
      ('${B1}', '${ORG_B}', 'B1', now() - interval '1 day'), ('${N1}', null, 'N1', now());
    insert into user_locations (user_id, location_id) values ('${U.boA1}', '${A1}'), ('${U.boB1}', '${B1}');
    insert into user_profiles (id, org_id, role) values
      ('${U.boA1}', null, 'manager'), ('${U.boB1}', null, 'manager'),
      ('${U.ownerA}', '${ORG_A}', 'owner'), ('${U.superAdmin}', null, 'super_admin');
    insert into devices (location_id, name, type, status, device_uid, bound_via, last_seen) values
      ('${A1}', 'POS 1', 'pos', 'online', '${DEV.tillA1}', 'claim_device_v2', now()),
      ('${A1}', 'Kiosk 1', 'kiosk', 'active', '${DEV.kioskA1}', 'claim_kiosk', now()),
      ('${A1}', 'Old till', 'pos', 'online', '${DEV.unboundA1}', null, now() - interval '30 days'),
      ('${A1}', 'Retired till', 'pos', 'retired', '${DEV.offlineA1}', 'claim_device_v2', now() - interval '30 days');
    insert into ops_devices (location_id, org_id, device_uid, name, active) values ('${A2}', '${ORG_A}', '${DEV.opsA2}', 'Ops tablet', true);
    insert into storage_areas (id, location_id, name, kind) values
      ('${AR.a1}', '${A1}', 'Bar', 'bar'), ('${AR.a1b}', '${A1}', 'Cellar', 'cellar'),
      ('${AR.a2}', '${A2}', 'Bar', 'bar'), ('${AR.b1}', '${B1}', 'Bar', 'bar');
    insert into inventory_items (id, location_id, org_id, name, current_cost, on_hand) values
      ('${I.a1}', '${A1}', '${ORG_A}', 'Milk A1', 1.0, 100), ('${I.a1x}', '${A1}', '${ORG_A}', 'Oat milk A1', 1.0, 100),
      ('${I.a2}', '${A2}', '${ORG_A}', 'Milk A2', 1.0, 100), ('${I.b1}', '${B1}', '${ORG_B}', 'Milk B1', 1.0, 100);
    insert into inventory_item_areas (location_id, inventory_item_id, area_id, is_primary) values
      ('${A1}', '${I.a1}', '${AR.a1}', true), ('${A2}', '${I.a2}', '${AR.a2}', true), ('${B1}', '${I.b1}', '${AR.b1}', true),
      -- bad data on purpose: an A1 item whose use area row points at a B1 area
      ('${A1}', '${I.a1x}', '${AR.b1}', true);
    insert into inventory_item_area_stock (location_id, inventory_item_id, area_id, on_hand) values
      ('${A1}', '${I.a1}', '${AR.a1}', 100), ('${A2}', '${I.a2}', '${AR.a2}', 100), ('${B1}', '${I.b1}', '${AR.b1}', 100);
    insert into stock_transfers (id, location_id, to_location_id, from_area_id, to_area_id, status, reference) values
      ('${T.withinA1}', '${A1}', null, '${AR.a1b}', '${AR.a1}', 'DRAFT', 'T1'),
      ('${T.a1a2}', '${A1}', '${A2}', '${AR.a1}', null, 'DRAFT', 'T2'),
      ('${T.a1b1}', '${A1}', '${B1}', '${AR.a1}', null, 'DRAFT', 'T3'),
      ('${T.foreignLine}', '${A1}', null, null, null, 'DRAFT', 'T4'),
      ('${T.foreignArea}', '${A1}', null, '${AR.b1}', '${AR.a1}', 'DRAFT', 'T5'),
      ('${T.sentA1A2}', '${A1}', '${A2}', '${AR.a1}', null, 'SENT', 'T6'),
      ('${T.sentA1B1}', '${A1}', '${B1}', '${AR.a1}', null, 'SENT', 'T7'),
      ('${T.draftForeign}', '${A1}', null, null, null, 'DRAFT', 'T8');
    insert into stock_transfer_lines (transfer_id, location_id, to_location_id, inventory_item_id, to_inventory_item_id, qty_base, unit_cost) values
      ('${T.withinA1}', '${A1}', null, '${I.a1}', null, 2, null),
      ('${T.a1a2}', '${A1}', '${A2}', '${I.a1}', null, 2, null),
      ('${T.a1b1}', '${A1}', '${B1}', '${I.a1}', null, 2, null),
      ('${T.foreignLine}', '${A1}', null, '${I.b1}', null, 2, null),
      ('${T.foreignArea}', '${A1}', null, '${I.a1}', null, 2, null),
      ('${T.sentA1A2}', '${A1}', '${A2}', '${I.a1}', '${I.a2}', 2, 1.0),
      ('${T.sentA1B1}', '${A1}', '${B1}', '${I.a1}', '${I.b1}', 2, 1.0),
      ('${T.draftForeign}', '${A1}', null, '${I.b1}', null, 2, null);
  `);
}

// -- the access matrix: [caller, call, before, after, what] ------------------
const PSM_CASES = [
  ['tillA1', psmCall(A1, I.a1, 1), 'ok', 'ok', 'till posts SALE_DEPLETION at its own venue'],
  ['kioskA1', psmCall(A1, I.a1, 2), 'ok', 'ok', 'kiosk posts at its own venue'],
  ['opsA2', psmCall(A2, I.a2, 3), 'ok', 'ok', 'ops tablet posts at its own venue'],
  ['boA1', psmCall(A1, I.a1, 4), 'ok', 'ok', 'Back Office login posts at its venue'],
  ['ownerA', psmCall(A2, I.a2, 5), 'ok', 'ok', 'owner posts at a venue of their company (no link row)'],
  ['superAdmin', psmCall(B1, I.b1, 6), 'ok', 'ok', 'super admin posts anywhere'],
  ['service', psmCall(B1, I.b1, 7), 'ok', 'ok', 'service role posts anywhere'],
  ['sqlEditor', psmCall(B1, I.b1, 8), 'ok', 'ok', 'SQL editor posts anywhere (demo files)'],
  ['stranger', psmCall(A1, I.a1, 9), 'ok', '42501', 'stranger anonymous session'],
  ['anonKey', psmCall(A1, I.a1, 10), 'ok', '42501', 'bare anon key'],
  ['unboundA1', psmCall(A1, I.a1, 11), 'ok', '42501', 'till that no claim bound'],
  ['offlineA1', psmCall(A1, I.a1, 12), 'ok', '42501', 'bound till that is retired'],
  ['tillA1', psmCall(A2, I.a2, 13), 'ok', '42501', 'till of A1 posting at A2'],
  ['boA1', psmCall(B1, I.b1, 14), 'ok', '42501', 'Back Office login of A1 posting at another company'],
  ['boB1', psmCall(A1, I.a1, 15), 'ok', '42501', 'Back Office login of B1 posting at A1'],
  ['apiNoClaims', psmCall(A1, I.a1, 16), 'ok', '42501', 'API login with no claims is not the database'],
  ['ownerA', psmCall(A1, I.b1, 17), 'ok', '22023', 'item of another venue (B1) posted at A1'],
  ['boA1', psmCall(A1, I.a1, 18, { area: AR.b1 }), 'ok', '22023', 'area of another venue (B1) posted at A1'],
];
const SIOH_CASES = [
  ['tillA1', siohCall(A1, I.a1), 'ok', 'ok', 'till sets a count at its venue'],
  ['boA1', siohCall(A1, I.a1), 'ok', 'ok', 'Back Office login sets a count at its venue'],
  ['service', siohCall(B1, I.b1), 'ok', 'ok', 'service role sets a count'],
  ['stranger', siohCall(A1, I.a1), 'ok', '42501', 'stranger sets a count'],
  ['anonKey', siohCall(A1, I.a1), 'ok', '42501', 'bare anon key sets a count'],
  ['boA1', siohCall(B1, I.b1), 'ok', '42501', 'Back Office login of A1 sets a count at B1'],
  ['tillA1', siohCall(A2, I.a2), 'ok', '42501', 'till of A1 sets a count at A2'],
];
const LEG_CASES = [
  ['boA1', legCall(T.withinA1, 'both'), 'ok', 'ok', 'Back Office moves stock between two areas of its venue'],
  ['service', legCall(T.withinA1, 'both'), 'ok', 'ok', 'service role moves stock between areas'],
  ['tillA1', legCall(T.withinA1, 'both'), 'words:cannot open', 'ok', 'bound till moves stock at its venue (was refused: anonymous sessions)'],
  ['stranger', legCall(T.withinA1, 'both'), 'words:cannot open', 'words:cannot open', 'stranger moves stock'],
  ['anonKey', legCall(T.withinA1, 'both'), '42501', '42501', 'bare anon key moves stock'],
  ['boA1', legCall(T.a1a2, 'out'), 'ok', 'ok', 'send to a venue of the same company'],
  ['boA1', legCall(T.a1b1, 'out'), 'ok', 'words:same company', 'send to a venue of another company'],
  ['boA1', legCall(T.foreignLine, 'both'), 'ok', 'words:not at the sending venue', 'a line naming another venue\'s item'],
  ['boA1', legCall(T.foreignArea, 'both'), 'ok', 'words:leaves from', 'leaving from another venue\'s area'],
  ['boA1', legCall(T.draftForeign, 'cancel'), 'ok', 'ok', 'a draft with a bad line can still be cancelled'],
  ['ownerA', legCall(T.sentA1A2, 'in'), 'ok', 'ok', 'receive at a venue of the same company'],
  ['boA1', legCall(T.sentA1A2, 'in'), 'words:cannot open', 'words:cannot open', 'receive at a venue the login cannot open'],
  ['boB1', legCall(T.sentA1B1, 'in'), 'ok', 'words:same company', 'receive from another company'],
  ['boA1', legCall(T.sentA1B1, 'cancel'), 'ok', 'ok', 'the sender can always take a sent transfer back'],
];

function runMatrix(phase) {
  const idx = phase === 'before' ? 2 : 3;
  for (const [label, cases] of [['post_stock_movement', PSM_CASES], ['set_inventory_on_hand', SIOH_CASES], ['post_stock_transfer_leg', LEG_CASES]]) {
    for (const c of cases) {
      const got = outcome(asCaller(c[0], c[1]));
      ok(matches(got, c[idx]), `${phase}: ${label}: ${c[4]} [${CALLERS[c[0]].what}] -> ${got} (want ${c[idx]})`);
    }
  }
}

function ledgerRow(key) {
  return sql(`select coalesce(json_agg(json_build_object('type', movement_type, 'qty', qty_base, 'area', area_id, 'loc', location_id)), '[]') from stock_movements where idempotency_key = ${lit(key)}`);
}

// -- 1. guard constants -------------------------------------------------------
console.log('\n1. Guard constants');
freshDb('fence_md5');
const before = { psm: md5Of(SIG.psm), sioh: md5Of(SIG.sioh), leg: md5Of(SIG.leg) };
const migText = readFileSync(MIGRATION, 'utf8');
if (PRINT_MD5) {
  // The fenced bodies: the migration with its guard block taken out, on this scratch database.
  const unguarded = migText.replace(/do \$guard\$[\s\S]*?\$guard\$;/, '');
  sqlText1(unguarded);
  const after = { psm: md5Of(SIG.psm), sioh: md5Of(SIG.sioh), leg: md5Of(SIG.leg) };
  console.log(JSON.stringify({ before, after }, null, 2));
  stop();
  process.exit(0);
}
for (const k of ['psm', 'sioh', 'leg']) {
  ok(migText.includes(`'${before[k]}'`), `the migration guard carries the md5 of the live ${k} text (${before[k]})`);
}

// -- 2. BEFORE ------------------------------------------------------------------
console.log('\n2. BEFORE the migration: the doors are open');
freshDb('fence_main');
runMatrix('before');
{
  // The use area lookup crosses venues on bad data before the fence.
  const r = asCaller('boA1', psmCall(A1, I.a1x, 'x1', { qty: -1 }));
  const j = JSON.parse(r.out || '{}');
  ok(j.area_id === AR.b1, `before: an A1 item whose area row points at B1 lands in B1's area (${j.area_id})`);
}

// -- 3. the migration -----------------------------------------------------------
console.log('\n3. The migration, as the SQL editor runs it');
{
  const r = sqlText1(migText + `\nselect 'ran_as=' || current_user || ' claims=' || coalesce(nullif(current_setting('request.jwt.claims', true), ''), 'none');\n`);
  const rows = r.stdout.trim().split('\n');
  const check = rows[rows.length - 2].split('|');
  ok(rows[rows.length - 1] === 'ran_as=postgres claims=none', `the self test leaves the role and claims as they were (${rows[rows.length - 1]})`);
  // reach_rule, fenced_functions, anon_can_call, public_can_call, signed_in_can_call, service_role_can_call,
  // bound_devices, unbound_recent_devices, venues_without_company
  ok(check.join('|') === '1|3|0|0|3|3|2|0|1', `visible check reads 1|3|0|0|3|3|2|0|1 (${check.join('|')})`);
}

// -- 4. AFTER -------------------------------------------------------------------
console.log('\n4. AFTER the migration');
runMatrix('after');
{
  const r = asCaller('boA1', psmCall(A1, I.a1x, 'x2', { qty: -1 }));
  const j = JSON.parse(r.out || '{}');
  ok(r.status === 0 && j.area_id === null, `after: the use area lookup reads only this venue (area ${j.area_id})`);
  const s = asCaller('stranger', `select public.stock_caller_reaches('${A1}')`);
  ok(s.out === 'f', `after: a stranger asking stock_caller_reaches gets false (${s.out})`);
  const t = asCaller('tillA1', `select public.stock_caller_reaches('${A1}')`);
  ok(t.out === 't', `after: the bound till asking stock_caller_reaches gets true (${t.out})`);
  const k = asCaller('anonKey', `select public.stock_caller_reaches('${A1}')`);
  ok(k.out === 'f', `after: the bare anon key asking stock_caller_reaches gets false (${k.out})`);
}

console.log('\n4b. The till, exactly as deplete.js calls it, committed');
{
  const key = `sale:chk-till:${I.a1}`;
  const onHand0 = Number(sql(`select on_hand from inventory_items where id = '${I.a1}'`));
  const area0 = Number(sql(`select on_hand from inventory_item_area_stock where inventory_item_id = '${I.a1}' and area_id = '${AR.a1}'`));
  const r1 = asCaller('tillA1', psmCall(A1, I.a1, 'till', { qty: -2 }), { commit: true });
  const j1 = JSON.parse(r1.out || '{}');
  ok(r1.status === 0 && j1.duplicate === false, 'the sale posts');
  const rows = JSON.parse(ledgerRow(key));
  ok(rows.length === 1 && rows[0].type === 'SALE_DEPLETION' && Number(rows[0].qty) === -2 && rows[0].area === AR.a1 && rows[0].loc === A1,
    `one SALE_DEPLETION row, -2, in A1's Bar (${JSON.stringify(rows)})`);
  ok(Number(sql(`select on_hand from inventory_items where id = '${I.a1}'`)) === onHand0 - 2, 'on hand moved by -2');
  ok(Number(sql(`select on_hand from inventory_item_area_stock where inventory_item_id = '${I.a1}' and area_id = '${AR.a1}'`)) === area0 - 2, 'the Bar holding moved by -2');
  const r2 = asCaller('tillA1', psmCall(A1, I.a1, 'till', { qty: -2 }), { commit: true });
  const j2 = JSON.parse(r2.out || '{}');
  ok(r2.status === 0 && j2.duplicate === true && Number(j2.on_hand) === onHand0 - 2, 'a repeat of the same sale is a duplicate, nothing moves twice');
  const r3 = asCaller('tillA1', `select public.post_stock_movement(p_location_id => '${A1}', p_inventory_item_id => '${I.a1}', p_qty_base => 2, ` +
    `p_movement_type => 'RETURN', p_unit_cost => null, p_source_type => 'closed_check_refund', p_source_id => 'chk-till', ` +
    `p_idempotency_key => 'return:chk-till:r1:${I.a1}', p_occurred_at => null, p_created_by => null, p_notes => null)`, { commit: true });
  ok(r3.status === 0 && Number(sql(`select on_hand from inventory_items where id = '${I.a1}'`)) === onHand0, 'the refund (RETURN) puts it back');
  const ledgerVsOnHand = sql(`select count(*) from inventory_items i where i.on_hand <> 100 + coalesce((select sum(qty_base) from stock_movements m where m.inventory_item_id = i.id), 0)`);
  ok(ledgerVsOnHand === '0', `on hand equals the opening 100 plus the ledger for every item (${ledgerVsOnHand} off)`);
}

// -- 5. scale ---------------------------------------------------------------------
console.log('\n5. Scale: 2,000 venues, 5,000 devices, 20,000 venue links');
{
  sql(`
    insert into locations (id, org_id, name)
      select gen_random_uuid(), case when g <= 50 then '${ORG_BIG}'::uuid else ('0d000000-0000-4000-8000-' || lpad(to_hex(g % 200), 12, '0'))::uuid end, 'Venue ' || g
        from generate_series(1, 2000) g;
    with locs as (select array_agg(id order by id) as a from locations)
    insert into devices (location_id, name, status, device_uid, bound_via, last_seen)
      select locs.a[1 + g % array_length(locs.a, 1)], 'Till ' || g, 'online', gen_random_uuid(), 'claim_device_v2', now()
        from locs, generate_series(1, 5000) g;
    insert into user_profiles (id, org_id, role) values ('${U.ownerBig}', '${ORG_BIG}', 'owner');
    with users as (select gen_random_uuid() as u, n from generate_series(1, 5000) n),
         locs as (select array_agg(id order by id) as a from locations)
    insert into user_locations (user_id, location_id)
      select users.u, locs.a[1 + (users.n * 7 + k * 131) % array_length(locs.a, 1)] from users, locs, generate_series(1, 4) k;
    analyze;
  `);
  const bigVenue = sql(`select id from locations where org_id = '${ORG_BIG}' order by id limit 1`);
  sql(`insert into inventory_items (id, location_id, name, on_hand) values ('${id('40000000', 'c')}', '${bigVenue}', 'Big item', 0)`);
  const timeIt = (caller, loc, item) => {
    const body = `do $t$ declare t0 timestamptz := clock_timestamp(); i int; begin
      for i in 1..200 loop
        perform public.post_stock_movement('${loc}', '${item}', -1, 'SALE_DEPLETION', null, 'closed_check', 'scale', 'scale:' || i || ':${item}');
      end loop;
      raise notice 'MS_PER_CALL=%', round((extract(epoch from clock_timestamp() - t0) * 1000 / 200)::numeric, 3);
    end $t$`;
    const r = asCaller(caller, body);
    const m = /MS_PER_CALL=([0-9.]+)/.exec(r.notices);
    return { ms: m ? Number(m[1]) : null, err: r.sqlstate ? `${r.sqlstate} ${r.message}` : null };
  };
  for (const [caller, loc, item] of [['tillA1', A1, I.a1], ['boA1', A1, I.a1], ['superAdmin', A1, I.a1], ['service', A1, I.a1]]) {
    const t = timeIt(caller, loc, item);
    ok(t.err === null && t.ms !== null && t.ms < 20, `${CALLERS[caller].what}: ${t.ms} ms a call under the live timeout (${t.err || 'no error'})`);
  }
  CALLERS.ownerBig = { login: 'authenticator', role: 'authenticated', claims: login(U.ownerBig), what: 'owner of a 50 venue company' };
  const t = timeIt('ownerBig', bigVenue, id('40000000', 'c'));
  ok(t.err === null && t.ms !== null && t.ms < 20, `${CALLERS.ownerBig.what}: ${t.ms} ms a call (${t.err || 'no error'})`);
  const s = asCaller('stranger', psmCall(A1, I.a1, 'scale-stranger'));
  ok(s.sqlstate === '42501', `the stranger is still refused at this size (${s.sqlstate})`);
}

// -- 6. second run, rollback, run again ---------------------------------------------
console.log('\n6. A second run, the ROLLBACK, and a run after it');
{
  const r = sqlText1(migText, { allowFail: true });
  ok(r.status === 0, `a second run passes its own guard (${(r.stderr || '').trim().split('\n')[0] || 'ok'})`);
  const after = { psm: md5Of(SIG.psm), sioh: md5Of(SIG.sioh), leg: md5Of(SIG.leg) };
  for (const k of ['psm', 'sioh', 'leg']) ok(migText.includes(`'${after[k]}'`), `the guard also accepts the fenced ${k} text (${after[k]})`);
  const rb = sqlFile(ROLLBACK, { allowFail: true });
  const rbRow = rb.stdout.trim().split('\n').pop();
  ok(rb.status === 0 && rbRow === '0|0|2|2', `the ROLLBACK applies, visible check 0|0|2|2 (${rbRow})`);
  for (const k of ['psm', 'sioh', 'leg']) ok(md5Of(SIG[k]) === before[k], `the ROLLBACK puts ${k} back exactly (md5 ${md5Of(SIG[k])})`);
  ok(outcome(asCaller('stranger', psmCall(A1, I.a1, 'rb'))) === 'ok', 'after the ROLLBACK the stranger can post again (the old behaviour, as documented)');
  const again = sqlText1(migText, { allowFail: true });
  ok(again.status === 0, 'the migration applies again after the ROLLBACK');
  ok(outcome(asCaller('stranger', psmCall(A1, I.a1, 'rb2'))) === '42501', 'and the stranger is refused again');
}

// -- 7. the file refuses to run on the wrong database state ------------------------------
console.log('\n7. The file stops, changing nothing, when it should');
{
  freshDb('fence_guard');
  sql(`create or replace function public.set_inventory_on_hand(p_location_id uuid, p_inventory_item_id uuid, p_counted_qty numeric, p_created_by uuid default null, p_notes text default null)
       returns jsonb language plpgsql security definer set search_path to 'public' as $f$ begin return '{}'::jsonb; end $f$;`);
  const r = sqlText1(migText, { allowFail: true });
  ok(r.status !== 0 && /not the version this file was written for/.test(r.stderr) && /set_inventory_on_hand=/.test(r.stderr),
    `a changed function stops the file and names it (${(/ERROR:.*$/m.exec(r.stderr) || [''])[0].slice(0, 160)})`);
  ok(sql(`select count(*) from pg_proc where proname = 'stock_caller_reaches'`) === '0', 'and nothing was changed');
}
{
  freshDb('fence_wide');
  // A reach rule that lets everybody in (what a wrong helper would do).
  sql(`create or replace function public.accessible_location_uuids() returns setof uuid language sql stable security definer set search_path = public as $f$ select id from public.locations $f$;`);
  const r = sqlText1(migText, { allowFail: true });
  ok(r.status !== 0 && /a stranger was not refused/.test(r.stderr), `a rule that lets a stranger in stops the file (${(/ERROR:.*$/m.exec(r.stderr) || [''])[0].slice(0, 160)})`);
  ok(sql(`select count(*) from pg_proc where proname = 'stock_caller_reaches'`) === '0' && md5Of(SIG.psm) === before.psm, 'and nothing was changed');
}
{
  freshDb('fence_narrow');
  // The plan's warning: a rule on user_accessible_locations alone leaves every till out.
  sql(`create or replace function public.accessible_location_uuids() returns setof uuid language sql stable security definer set search_path = public as $f$ select k::uuid from public.user_accessible_locations() k $f$;`);
  const r = sqlText1(migText, { allowFail: true });
  ok(r.status !== 0 && /bound device\(s\) could not reach/.test(r.stderr), `a rule that leaves the tills out stops the file (${(/ERROR:.*$/m.exec(r.stderr) || [''])[0].slice(0, 160)})`);
  ok(sql(`select count(*) from pg_proc where proname = 'stock_caller_reaches'`) === '0' && md5Of(SIG.psm) === before.psm, 'and nothing was changed');
}

stop();
console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks hold');
process.exit(failures ? 1 : 0);
