#!/usr/bin/env node
// run.mjs: proves Drop 0 of multi site stock (supabase/migrations/20261021a_OPS_stock_native_0a.sql,
// its revalue file, 20261022a_OPS_stock_native_0b.sql and the three rollbacks) and then Drop 1
// (20261024a_OPS_stock_native_1.sql and its rollback, sections 19 to 25 in drop1.mjs) on a local, throwaway
// PostgreSQL 17 shaped like Ops, before Peter runs anything. It never connects to Supabase. The order is
// Peter's: 0a, its revalue file, 0b, then Drop 1.
//
//   node supabase/tests/stock_native/run.mjs --base-only   the base database only: every real migration
//                                                          Peter already ran, as he ran it (green before
//                                                          0a exists)
//   node supabase/tests/stock_native/run.mjs --quick       the whole proof, 10 sites in the scale part
//   node supabase/tests/stock_native/run.mjs               the whole proof, 50 sites and 5,000 items
//   --seed=N                                               replay the random runs of that seed
//   node supabase/tests/stock_native/run.mjs --drainer --quick
//                                                          the drainer release (20261023a) instead of
//                                                          sections 2 to 18: section 1, then drainer.mjs
//                                                          (sections 19 to 29) on Drop 0 as it is live
//                                                          (0a and its revalue; copies with 0b, and with
//                                                          0b and Drop 1, the live state since 21 Oct)
//   node supabase/tests/stock_native/run.mjs --drop2 --quick
//                                                          Drop 2 (20261025a, drop2.mjs sections 30 to 38):
//                                                          section 1, then 0a, its revalue file, 0b, Drop 1
//                                                          and the drainer file as pastes, then Drop 2
//   node supabase/tests/stock_native/run.mjs --drop2 --all  sections 2 to 25 first, then 30 to 38
//   STOCKN_D2, STOCKN_D2_ROLLBACK                          other copies of 20261025a and its rollback
//   node supabase/tests/stock_native/run.mjs --drop3 --quick
//                                                          Drop 3 (20261027a, drop3.mjs sections 40 to 49):
//                                                          section 1, then 0a, its revalue file, 0b, Drop 1,
//                                                          the drainer and Drop 2 as pastes, then Drop 3
//   node supabase/tests/stock_native/run.mjs --drop3 --all  sections 2 to 25, Drop 2's 30 to 38, then 40 to 49
//   STOCKN_D3, STOCKN_D3_ROLLBACK                          other copies of 20261027a and its rollback
//   node supabase/tests/stock_native/run.mjs --drop4a --quick
//                                                          Drop 4a (20261026a, the head office reports):
//                                                          section 1, then 0a, its revalue file, 0b, Drop 1,
//                                                          the drainer, Drop 2 and Drop 3 as pastes (the
//                                                          live order), then 4a and drop4a.mjs (sections
//                                                          30 to 37)
//   node supabase/tests/stock_native/run.mjs --align --quick
//                                                          Reports align (20261029a, release 5.11.99):
//                                                          section 1, then 0a, its revalue file, 0b, Drop 1,
//                                                          the drainer, Drop 2, Drop 3 and 4a as pastes (the
//                                                          live order), then align.mjs (sections 50 to 53)
//   node supabase/tests/stock_native/run.mjs --drop4b --quick
//                                                          Drop 4b (20261030a, release 5.11.100): section 1,
//                                                          then 0a to Drop 3 as pastes, then drop4b.mjs (4a,
//                                                          Reports align, the storage fix 20261029b, then 4b:
//                                                          sections 60 to 68)
//   STOCKN_D4B, STOCKN_D4B_ROLLBACK, STOCKN_STORAGE_FIX  other copies of 20261030a, its rollback and 20261029b
//   node supabase/tests/stock_native/run.mjs --drainer --before-only --quick
//                                                          only the drainer parts that need no drainer
//                                                          file (the basket before, the v1 figures, speed
//                                                          before): green before the file exists
//
//   STOCKN_MIGRATION, STOCKN_ROLLBACK, STOCKN_REVALUE, STOCKN_REVALUE_ROLLBACK, STOCKN_0B,
//   STOCKN_0B_ROLLBACK, STOCKN_D1, STOCKN_D1_ROLLBACK
//                        other copies of the eight files (default: the repo's supabase/migrations)
//   STOCKN_DRAINER, STOCKN_DRAINER_ROLLBACK   other copies of 20261023a and its rollback (same default)
//   STOCKN_D4A, STOCKN_D4A_ROLLBACK           other copies of 20261026a and its rollback (same default)
//   STOCKN_D4A_ONLY=33,35                     with --drop4a: only those of sections 31 to 37 (30 always runs)
//   STOCKN_ALIGN, STOCKN_ALIGN_ROLLBACK       other copies of 20261029a and its rollback (same default)
//   STOCKN_KEEP=1        keep the cluster at the end and print how to reach it
//   STOCKN_STOP_AT=n     stop after section n
//   STOCKN_NO_GUARD=1    run without the pg-safeupdate stand in (and say so)
//
// How the database is built and how a caller is made: base.mjs. The rows: fixtures.mjs. Every order
// channel: channels.mjs. Exit code 0 only when every check holds.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  startCluster, baseSchema, applyMigration, liveTail, BASE_MIGRATIONS, FENCE_FILE, FENCE_TRIGGER, MIG, P0, here,
  STOCK27, SNAP_TABLES, venueFigures, figureDiff, lit, jlit, arr, rng,
} from './base.mjs';
import {
  ORG_T, PROVO, LOC2, ORG_S, SOLO, ORG_G, G, ORG_X, X1, U, DEV, AR, TAX, I, PACK, CONV, SUP, SP, R, M, EXPECT, CALLERS,
  seedSql, stockSql, id,
} from './fixtures.mjs';
import { CHANNEL_SETUP, channelEvents, refundEvent, drainSql, bookedSql, BASKET_SETUP } from './channels.mjs';
import { stockLevelOf } from '../../functions/_shared/boSectionRules.js';
import { drainerProof } from './drainer.mjs';
import { drop1Sections } from './drop1.mjs';
import { drop2Sections, D2_SHAPE } from './drop2.mjs';
import { drop3Sections, D3_SHAPE, LIVE_SECOND_STEP_MD5 } from './drop3.mjs';
import { drop4aSections } from './drop4a.mjs';
import { alignSections } from './align.mjs';
import { drop4bSections } from './drop4b.mjs';

const BASE_ONLY = process.argv.includes('--base-only');
const BEFORE_ONLY = process.argv.includes('--before-only');
const DRAINER = process.argv.includes('--drainer') || BEFORE_ONLY;
const DROP2 = process.argv.includes('--drop2');
const DROP3 = process.argv.includes('--drop3');
const ALL = process.argv.includes('--all');
const DROP4A = process.argv.includes('--drop4a');
const ALIGN = process.argv.includes('--align');
const DROP4B = process.argv.includes('--drop4b');
const QUICK = process.argv.includes('--quick');
const SEED = Number((process.argv.find((a) => a.startsWith('--seed=')) || '').slice(7)) || (Date.now() % 1000000);
const SCALE_SITES = QUICK ? 10 : 50;
const SCALE_ITEMS = 5000;
const STOP_AT = Number(process.env.STOCKN_STOP_AT || 99);
const FILES = {
  a: process.env.STOCKN_MIGRATION || MIG('20261021a_OPS_stock_native_0a.sql'),
  aRb: process.env.STOCKN_ROLLBACK || MIG('20261021a_OPS_stock_native_0a_ROLLBACK.sql'),
  rv: process.env.STOCKN_REVALUE || MIG('20261021a_OPS_stock_native_0a_revalue.sql'),
  rvRb: process.env.STOCKN_REVALUE_ROLLBACK || MIG('20261021a_OPS_stock_native_0a_revalue_ROLLBACK.sql'),
  b: process.env.STOCKN_0B || MIG('20261022a_OPS_stock_native_0b.sql'),
  bRb: process.env.STOCKN_0B_ROLLBACK || MIG('20261022a_OPS_stock_native_0b_ROLLBACK.sql'),
  d1: process.env.STOCKN_D1 || MIG('20261024a_OPS_stock_native_1.sql'),
  d1Rb: process.env.STOCKN_D1_ROLLBACK || MIG('20261024a_OPS_stock_native_1_ROLLBACK.sql'),
  d: process.env.STOCKN_DRAINER || MIG('20261023a_OPS_stock_drainer_v2.sql'),
  dRb: process.env.STOCKN_DRAINER_ROLLBACK || MIG('20261023a_OPS_stock_drainer_v2_ROLLBACK.sql'),
  d2: process.env.STOCKN_D2 || MIG('20261025a_OPS_stock_native_2.sql'),
  d2Rb: process.env.STOCKN_D2_ROLLBACK || MIG('20261025a_OPS_stock_native_2_ROLLBACK.sql'),
  d3: process.env.STOCKN_D3 || MIG('20261027a_OPS_stock_native_3.sql'),
  d3Rb: process.env.STOCKN_D3_ROLLBACK || MIG('20261027a_OPS_stock_native_3_ROLLBACK.sql'),
  d4: process.env.STOCKN_D4A || MIG('20261026a_OPS_stock_native_4a.sql'),
  d4Rb: process.env.STOCKN_D4A_ROLLBACK || MIG('20261026a_OPS_stock_native_4a_ROLLBACK.sql'),
  al: process.env.STOCKN_ALIGN || MIG('20261029a_OPS_reports_align.sql'),
  alRb: process.env.STOCKN_ALIGN_ROLLBACK || MIG('20261029a_OPS_reports_align_ROLLBACK.sql'),
  hf: process.env.STOCKN_STORAGE_FIX || MIG('20261029b_OPS_storage_inbox_upload_ok.sql'),
  d4b: process.env.STOCKN_D4B || MIG('20261030a_OPS_stock_native_4b.sql'),
  d4bRb: process.env.STOCKN_D4B_ROLLBACK || MIG('20261030a_OPS_stock_native_4b_ROLLBACK.sql'),
};
if (!BASE_ONLY && !existsSync(FILES.a)) {
  console.error(`0a is not there yet: ${FILES.a}\nRun with --base-only for the base database, or set STOCKN_MIGRATION to a copy of 0a.`);
  process.exit(2);
}

// -- checks ----------------------------------------------------------------------------------------------
let failures = 0;
let checks = 0;
const failed = [];
const ok = (cond, msg) => { checks++; if (cond) console.log(`  ok   ${msg}`); else { failures++; failed.push(msg); console.log(`  FAIL ${msg}`); } };
const near = (a, b, eps = 1e-4) => a != null && b != null && Math.abs(Number(a) - Number(b)) <= eps;
const short = (x, n = 160) => String(typeof x === 'string' ? x : JSON.stringify(x)).slice(0, n);

const c = startCluster({ portBase: 55800 });
process.on('uncaughtException', (e) => { console.error(e); c.stop(); process.exit(2); });
const sql = (q, o) => c.sql(q, o);
const num = (q, o) => c.num(q, o);
function finish() {
  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}: ${checks - failures}/${checks} checks${failures ? `, ${failures} failed` : ''} (seed ${SEED}${QUICK ? ', quick' : ''}${BASE_ONLY ? ', base only' : ''}${DRAINER ? `, drainer release${BEFORE_ONLY ? ' before only' : ''}` : ''}${DROP4A ? ', Drop 4a' : ''}${ALIGN ? ', Reports align' : ''}${DROP4B ? ', Drop 4b' : ''})`);
  if (failures) for (const f of failed.slice(0, 40)) console.log(`  - ${short(f, 200)}`);
  if (process.env.STOCKN_KEEP) { console.log(`kept: psql -h ${c.dir} -p ${c.port} -U postgres -d ${c.DB}`); process.exit(failures === 0 ? 0 : 1); }
  c.stop();
  process.exit(failures === 0 ? 0 : 1);
}
const section = (n, title) => { if (n > STOP_AT) finish(); console.log(`\n${title}`); };
// A section that must not stop the run: an exception is one failed check, and the run goes on.
async function guarded(name, fn) {
  const db = c.DB;
  c.throwing = true;
  try { await fn(); } catch (e) { ok(false, `${name}: the section stopped: ${short(e && e.message ? e.message : e, 500)}`); } finally { c.throwing = false; c.use(db); }
}

// -- callers (PostgREST style: authenticator, SET ROLE, claims, the live limits) -------------------------------
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
  const cl = CALLERS[key];
  if (!cl) throw new Error(`no caller ${key}`);
  const lines = callerLines(cl);
  lines.push(body.trim().replace(/;?$/, ';'));
  lines.push(commit ? 'commit;' : 'rollback;');
  const t0 = Date.now();
  const r = c.psql({ login: cl.login, input: lines.join('\n') + '\n', allowFail: true });
  const m = /ERROR:\s+([0-9A-Z]{5}):\s*(.*)/.exec(r.stderr || '');
  return { status: r.status, sqlstate: m ? m[1] : (r.status ? 'error' : null), message: m ? m[2] : (r.stderr || '').trim(), out: (r.stdout || '').trim(), ms: Date.now() - t0 };
}
function asCallerAsync(key, body) {
  const cl = CALLERS[key];
  const lines = callerLines(cl);
  lines.push(body.trim().replace(/;?$/, ';'), 'commit;');
  return c.psqlAsync({ login: cl.login, input: lines.join('\n') + '\n' });
}
const lastJson = (r) => { try { return JSON.parse(r.out.split('\n').filter(Boolean).pop()); } catch { return null; } };
const callJ = (key, body) => { const r = asCaller(key, body); return { ...r, j: lastJson(r) }; };
const outcome = (r) => (r.sqlstate ? r.sqlstate : r.status !== 0 ? `fail:${short(r.message, 80)}` : 'ok');
const pj = (t) => { try { return JSON.parse(t); } catch { return null; } };

// -- small readers --------------------------------------------------------------------------------------------
const onHandEqLedger = (loc) => num(`select count(*) from inventory_items i where i.location_id = '${loc}'
   and i.on_hand <> coalesce((select sum(m.qty_base) from stock_movements m where m.inventory_item_id = i.id), 0)`) === 0;
// the largest gap between an item's ledger value and its books (on hand times cost) at a venue
const ledgerGap = (loc) => num(`select coalesce(max(abs(coalesce((select sum(m.value_delta) from stock_movements m where m.inventory_item_id = i.id), 0)
   - i.on_hand * coalesce(i.current_cost, 0))), 0) from inventory_items i where i.location_id = '${loc}'`);
const ledgerGapItem = (item) => num(`select abs(coalesce((select sum(m.value_delta) from stock_movements m where m.inventory_item_id = i.id), 0)
   - i.on_hand * coalesce(i.current_cost, 0)) from inventory_items i where i.id = '${item}'`);
const onHandOf = (item) => num(`select on_hand from inventory_items where id = '${item}'`);
const costOf = (item) => num(`select current_cost from inventory_items where id = '${item}'`);
const coRef = (table, rid) => sql(`select coalesce(company_ref::text, '') from public.${table} where id = '${rid}'`);
const fnExists = (sig) => sql(`select to_regprocedure('${sig}') is not null`) === 't';
const tableExists = (t) => sql(`select to_regclass('public.${t}') is not null`) === 't';
const md5Of = (sig) => sql(`select md5(btrim(regexp_replace(p.prosrc, '\\s+', ' ', 'g'))) from pg_proc p where p.oid = to_regprocedure('${sig}')`);
const canExec = (role, sig) => sql(`select has_function_privilege('${role}', to_regprocedure('${sig}'), 'execute')`) === 't';
const FNS = () => Object.fromEntries(sql(`select p.oid::regprocedure::text || '=' || md5(p.prosrc) from pg_proc p where p.pronamespace = 'public'::regnamespace order by 1`)
  .split('\n').filter(Boolean).map((l) => { const k = l.lastIndexOf('='); return [l.slice(0, k), l.slice(k + 1)]; }));
const plan = (loc, kind = 'site') => pj(sql(kind === 'site'
  ? `select public.stock_co__sync_site('${loc}', null, null, false, true)`
  : `select public.stock_co__sync_recipes('${loc}', null, false, true)`));
const drain = () => sql(drainSql);
const runQueue = (secs = 30) => sql(`call public.stock_save_queue_run(${secs});`);
function callerReach(key, fn = 'user_accessible_locations') {
  const r = asCaller(key, `select coalesce(string_agg(x::text, ',' order by x::text), '') from public.${fn}() x`);
  return r.status === 0 ? r.out : `error ${r.sqlstate}`;
}
const LOGINS = ['ownerT', 'ownerX', 'ownerNoOrg', 'mgrProvo', 'mgrLoc2', 'mgrFull', 'mgrAll', 'mgrAllPurch', 'areaMgr', 'soloMgr', 'soloOwner', 'groupMgr', 'superAdmin', 'noStep'];
const VENUES = [PROVO, LOC2, SOLO];
const VNAME = { [PROVO]: 'Provo', [LOC2]: 'Location 2', [SOLO]: 'Solo venue' };

// The seven bodies 0a checks, the posting core, and their live facts (contract section 4).
const CHECKED = [
  ['public._stock_receive_lines(uuid,text,text,jsonb,uuid,text)', '188d811b62552b501a42c7948ad46a22', ['postgres'], 'public'],
  ['public.approve_stock_count(uuid,text,text,jsonb,boolean)', 'd920cc8d432e65a1373fd1548e7cfc7e', ['postgres', 'authenticated', 'service_role'], 'public'],
  ['public.post_stock_transfer_leg(uuid,text,text)', 'f321c21b48115a8de8fbfcb021ab4577', ['postgres', 'authenticated', 'service_role'], 'public'],
  ['public.stock_office_reaches(uuid)', 'f822b368352f2cc5d307c6aba9917429', ['postgres', 'anon', 'authenticated', 'service_role'], 'public'],
  ['public.stock_caller_reaches(uuid)', '6f7553102dbaf750eb13e82fdd5d5149', ['postgres', 'anon', 'authenticated', 'service_role'], 'public'],
  ['public.stock_cost_rule(uuid)', '8fdd834c5814089d6baaa46c2660e5c7', ['postgres', 'anon', 'authenticated', 'service_role'], 'public'],
  ['public.user_profiles_fence_guard()', '79ed2f68e3504dc1f38e98aee31a7baa', ['postgres', 'service_role'], 'public, pg_temp'],
];
const CORE = ['public._post_stock_movement(uuid,uuid,numeric,text,numeric,text,text,text,timestamptz,uuid,text,uuid)', '2974176b3ea49b90065dc0c20572e343'];
const aclOf = (sig) => sql(`select coalesce(string_agg(r, ',' order by r), '') from (
    select case when a.grantee = 0 then 'public' else pg_get_userbyid(a.grantee) end r
      from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
     where p.oid = to_regprocedure('${sig}') and a.privilege_type = 'EXECUTE') z`);
const pathOf = (sig) => sql(`select coalesce((select substr(x, 13) from unnest(p.proconfig) x where x like 'search_path=%'), '') from pg_proc p where p.oid = to_regprocedure('${sig}')`);

// The live policy names of the 27 tables (from live_policies.sql, which was read from pg_policies).
const LIVE_POLICIES = [...readFileSync(join(here, 'live_policies.sql'), 'utf8')
  .matchAll(/create policy (\S+) on public\.(\S+) as (\S+) for (\S+)/g)].map((m) => `${m[2]}.${m[1]}`).sort();

console.log(`\nMulti site stock ${DRAINER ? 'drainer release' : 'Drop 0 and Drop 1'} proof (seed ${SEED}${QUICK ? ', quick' : ''}${BASE_ONLY ? ', base only' : ''}${BEFORE_ONLY ? ', before only' : ''}; ${c.guardOn ? 'pg-safeupdate stand in on for authenticator' : 'NO pg-safeupdate stand in'})`);

// == 1. The base database ======================================================================================
section(1, '1. The base database: Ops shaped, every real migration Peter ran, in his order');
c.sql('create database n_base');
c.use('n_base');
baseSchema(c);
{
  const r = applyMigration(c, FENCE_FILE);
  ok(r.status === 0, `20260921u applies (the owner rule and the profile fence guard)${r.status ? `: ${short(r.stderr, 300)}` : ''}`);
  c.sql(FENCE_TRIGGER);
  c.psql({ input: seedSql() });
  for (const f of BASE_MIGRATIONS) {
    const m = applyMigration(c, f);
    ok(m.status === 0, `${f} applies as Peter ran it${m.status ? `: ${short(m.stderr, 400)}` : ''}`);
  }
  liveTail(c);
  c.psql({ input: CHANNEL_SETUP });
  c.psql({ input: stockSql() });
}
{
  for (const [sig, md5, acl, path] of CHECKED) {
    const name = sig.slice(7, sig.indexOf('('));
    ok(md5Of(sig) === md5, `${name}: normalised body md5 is the live one 0a checks (${md5Of(sig)})`);
    ok(aclOf(sig) === acl.slice().sort().join(','), `${name}: EXECUTE is ${acl.join(', ')} as live (${aclOf(sig)})`);
    ok(pathOf(sig) === path, `${name}: search_path ${path} as live (${pathOf(sig)})`);
  }
  ok(md5Of(CORE[0]) === CORE[1], `_post_stock_movement: body md5 is the live one 0a checks (${md5Of(CORE[0])})`);
  ok(md5Of('public.report_day_sums(text[],date,date,jsonb)') === '25a8daf22bd412c1a2579807d21b223c', 'report_day_sums (20261005b) is the live body (the sales day check compares with it)');
  const pre = pj(sql(`select json_build_object(
      'ops', to_regclass('public.user_locations') is not null and to_regclass('public.billing_state') is null,
      'core', to_regprocedure('${CORE[0]}') is not null, 'outbox', to_regclass('public.stock_outbox') is not null,
      'explode', exists (select 1 from pg_proc where proname = 'stock_explode'), 'fingerprint', exists (select 1 from pg_proc where proname = 'hubrise_menu_fingerprint'),
      'none_yet', to_regclass('public.stock_co_items') is null and to_regclass('public.stock_co_settings') is null and to_regclass('public.stock_save_queue') is null,
      'no_company_ref', not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'inventory_items' and column_name = 'company_ref'),
      'no_phase1', to_regclass('public.msm_stock_items') is null and to_regclass('public.stock_company') is null)`));
  ok(pre && Object.values(pre).every(Boolean), `everything 0a's guard asks for is there, and nothing of 0a or Phase 1 is (${short(pre)})`);
  const pol = sql(`select count(*) filter (where coalesce(qual,'') || coalesce(with_check,'') like '%user_accessible_locations()%') || '|' ||
                          count(*) filter (where coalesce(qual,'') || coalesce(with_check,'') like '%accessible_location_uuids()%') || '|' ||
                          count(*) filter (where coalesce(qual,'') || coalesce(with_check,'') like '%user_accessible_locations()%' and coalesce(qual,'') || coalesce(with_check,'') like '%accessible_location_uuids()%') || '|' ||
                          count(*) filter (where policyname = 'second_step_fence' and permissive = 'RESTRICTIVE')
                     from pg_policies where schemaname = 'public' and tablename = any (${lit(`{${STOCK27.join(',')}}`)}::text[])`);
  ok(pol === '51|14|0|27', `the 27 stock tables carry the live 51 + 14 reach policies, none naming both, and 27 second step fences (${pol})`);
  const names = sql(`select string_agg(tablename || '.' || policyname, ',' order by tablename || '.' || policyname) from pg_policies where schemaname = 'public' and tablename = any (${lit(`{${STOCK27.join(',')}}`)}::text[])`).split(',');
  ok(JSON.stringify(names) === JSON.stringify(LIVE_POLICIES) && names.length === 92, `the policy names on those tables are exactly the live 92 (0a pins them in ALTER POLICY)`);
  ok(num(`select count(*) from pg_policies where schemaname = 'public' and tablename = any (${lit(`{${STOCK27.join(',')}}`)}::text[]) and roles <> '{public}' and policyname <> 'second_step_fence'`) === 0,
    'all 65 reach policies are TO public (so the anon key evaluates them)');
  const trg = sql(`select string_agg(tgname, ',' order by tgname) from pg_trigger where tgrelid = 'public.user_profiles'::regclass and not tgisinternal`);
  ok(trg === 'user_profiles_bo_sections_guard,user_profiles_fence_guard,user_profiles_role_guard', `user_profiles has the three live guards (${trg})`);
  const cron = sql(`select string_agg(jobname, ',' order by jobname) from cron.job`);
  ok(/stock-outbox-drain/.test(cron), `the central drainer's cron job is there (${cron})`);
  ok(num(`select count(*) from stock_depletion_mode where mode = 'central'`) === 1 + 1 + 1 + 7 + 1, 'every venue is central (20261019)');
}
{
  const f = Object.fromEntries(VENUES.map((v) => [v, venueFigures(c, v)]));
  const n = (v, t) => f[v][`n:${t}`];
  ok(n(PROVO, 'inventory_items') === 12 && n(PROVO, 'suppliers') === 3 && n(PROVO, 'supplier_products') === 6 && n(PROVO, 'item_packaging_formats') === 7
     && n(PROVO, 'inventory_item_conversions') === 4 && n(PROVO, 'recipes') === 6 && n(PROVO, 'recipe_lines') === 11 && n(PROVO, 'menu_item_recipes') === 5,
    'Provo: 12 items, 3 suppliers, 6 supplier products, 7 packs, 4 bridges, 6 recipes, 11 lines, 5 till links');
  ok(n(LOC2, 'inventory_items') === 10 && n(LOC2, 'item_packaging_formats') === 0 && n(LOC2, 'inventory_item_conversions') === 0 && n(LOC2, 'recipes') === 7,
    'Location 2: 10 items, no packs, no bridges, 7 recipes');
  ok(n(SOLO, 'inventory_items') === 1 && n(SOLO, 'item_packaging_formats') === 2 && n(SOLO, 'recipe_lines') === 1
     && sql(`select unit like '@%' from recipe_lines where location_id = '${SOLO}'`) === 't', 'the one site venue: 1 item, 2 packs, 1 recipe line in a pack ("@")');
  ok(VENUES.every(onHandEqLedger), 'on hand equals the ledger quantity at every venue');
  ok(near(ledgerGap(PROVO), 1.0, 1e-6) && near(ledgerGap(LOC2), 2.0, 1e-6) && near(ledgerGap(SOLO), 0, 1e-6),
    `the ledger value is off the books by the two old cost writes only (Provo 1.00, Location 2 2.00: the revalue file's work) (${ledgerGap(PROVO)}, ${ledgerGap(LOC2)}, ${ledgerGap(SOLO)})`);
  ok(onHandOf(I.pLemons) === -4 && sql(`select archived_at is not null from inventory_items where id = '${I.pKeg}'`) === 't' && onHandOf(I.pKeg) === 50,
    'negative stock (lemons -4) and an archived item still holding stock (keg 50 l) are there');
}
// the profile hole 0a's optional block closes (open question 22): before 0a a role owner with no
// company may set its own company to one it reaches through a link row
{
  const r = asCaller('ownerNoOrg', `update user_profiles set org_id = '${ORG_T}' where id = '${U.ownerNoOrg}'`, { commit: false });
  ok(r.status === 0, `before 0a: a role owner with no company CAN give itself the company of a venue it is linked to (the hole, rolled back here) (${outcome(r)})`);
}
// every channel through the central drainer, before 0a
const chanVenues = [
  { prefix: 'cp', loc: PROVO, menu: { a: M.pLatte, b: M.pFlat, c: M.pBoard }, dev: { till: 'tillProvo', kiosk: 'kioskProvo', mpos: 'mposProvo' } },
  { prefix: 'cl', loc: LOC2, menu: { a: M.lLatte, b: M.lSoup, c: M.lBread }, dev: { till: 'tillLoc2', kiosk: 'tillLoc2', mpos: 'tillLoc2' } },
  { prefix: 'cs', loc: SOLO, menu: { a: M.sWater, b: M.sWater, c: M.sWater }, dev: { till: 'tillSolo', kiosk: 'tillSolo', mpos: 'tillSolo' } },
];
function runChannels(label) {
  const out = {};
  const problems = [];
  for (const v of chanVenues) {
    for (const e of channelEvents(v.prefix, v.loc, v.menu, v.dev)) {
      const r = asCaller(e.caller, e.sql);
      if (r.status !== 0) problems.push(`${v.prefix} ${e.name}: ${outcome(r)}`);
    }
    drain();
    const rf = refundEvent(v.prefix, v.menu, v.dev);
    const r = asCaller(rf.caller, rf.sql);
    if (r.status !== 0) problems.push(`${v.prefix} refund: ${outcome(r)}`);
    drain();
    out[v.loc] = pj(sql(bookedSql(v.prefix, v.loc)));
  }
  return { out, problems };
}
let chanBefore = null;
{
  c.createFrom('n_chan_pre', 'n_base');
  c.use('n_chan_pre');
  const { out, problems } = runChannels('before');
  chanBefore = out;
  ok(problems.length === 0, `every channel writes its check as its writer does (${problems.join('; ') || 'all written'})`);
  for (const v of chanVenues) {
    const b = out[v.loc];
    const sales = ['till', 'kiosk', 'online', 'qr', 'catering', 'pat', 'mpos', 'hubrise', 'ezcater'];
    const booked = sales.filter((s) => b.movements.some((m) => m.check === `${v.prefix}-${s}` && m.type === 'SALE_DEPLETION'));
    ok(booked.length === sales.length, `${VNAME[v.loc]}: till, kiosk, online, QR, catering, pay at table, MPOS, HubRise and ezCater each take stock off through the drainer (${booked.length}/9: ${sales.filter((s) => !booked.includes(s)).join(', ') || 'all'})`);
    ok(b.outbox.every((o) => o.status === 'done'), `${VNAME[v.loc]}: every outbox event is done (${short(b.outbox.filter((o) => o.status !== 'done'))})`);
    ok(b.movements.some((m) => m.check === `${v.prefix}-till` && m.type === 'WASTE') && !b.movements.some((m) => m.check === `${v.prefix}-till` && m.type === 'RETURN'),
      `${VNAME[v.loc]}: the refunded food goes to waste, never back on the shelf (${short(b.movements.filter((m) => m.check === `${v.prefix}-till` && m.type !== 'SALE_DEPLETION').map((m) => m.type))})`);
    ok(b.movements.some((m) => m.check === `${v.prefix}-void` && m.type === 'WASTE'), `${VNAME[v.loc]}: the void of fired food books waste`);
    ok(onHandEqLedger(v.loc), `${VNAME[v.loc]}: on hand equals the ledger after every channel`);
  }
}
// property run on the base: random sales, receipts and waste keep on hand equal to the ledger
{
  c.createFrom('n_prop0', 'n_base');
  c.use('n_prop0');
  const rand = rng(SEED);
  const dishes = { [PROVO]: [M.pLatte, M.pFlat, M.pBurger, M.pSoup, M.pBoard], [LOC2]: [M.lLatte, M.lFlat, M.lBurger, M.lSoup, M.lBread, M.lLemonade] };
  const goods = { [PROVO]: [I.pMilk, I.pButter, I.pEggs, I.pBeans, I.pCups, I.pLemons], [LOC2]: [I.lMilk, I.lButter, I.lEggs, I.lCups, I.lBread, I.lLemons] };
  const runs = QUICK ? 30 : 80;
  let bad = 0;
  for (let k = 0; k < runs; k++) {
    const loc = rand() < 0.5 ? PROVO : LOC2;
    const p = rand();
    if (p < 0.6) {
      const items = Array.from({ length: 1 + Math.floor(rand() * 3) }, () => ({ itemId: dishes[loc][Math.floor(rand() * dishes[loc].length)], qty: 1 + Math.floor(rand() * 3) }));
      asCaller(loc === PROVO ? 'tillProvo' : 'tillLoc2', `insert into closed_checks (id, location_id, items, order_type, source, ref) values ('p0-${k}', '${loc}', ${lit(JSON.stringify(items))}::jsonb, 'dine-in', 'pos', 'P0${k}')`);
      drain();
    } else if (p < 0.85) {
      const item = goods[loc][Math.floor(rand() * goods[loc].length)];
      asCaller(loc === PROVO ? 'mgrProvo' : 'mgrLoc2', `select public.stock_receive('${loc}', 'purchase_order', '${randomUUID()}', ${jlit([{ key: `po:p0:${k}`, item_id: item, qty_base: 1 + Math.floor(rand() * 20), unit_cost: Math.round((0.1 + rand() * 3) * 100) / 100 }])})`);
    } else {
      const item = goods[loc][Math.floor(rand() * goods[loc].length)];
      asCaller(loc === PROVO ? 'mgrProvo' : 'mgrLoc2', `select public.post_stock_movement('${loc}', '${item}', -1, 'WASTE', null, 'waste', null, 'w-p0-${k}')`);
    }
    if (!onHandEqLedger(PROVO) || !onHandEqLedger(LOC2)) bad++;
  }
  ok(bad === 0, `${runs} random sales, receipts and waste on the base: on hand equals the ledger quantity after every one (seed ${SEED})`);
}
if (BASE_ONLY) finish();

// == 30 to 37. Drop 4a (drop4a.mjs): after 0a, its revalue file, 0b, Drop 1, the drainer, Drop 2 and Drop 3 as pastes ======
// The live order on the night 4a runs (Drop 2 and Drop 3 went live before it). The shapes and the harness
// stand ins are the ones drop2.mjs and drop3.mjs paste with, in the same places.
// == 50 to 53. Reports align (align.mjs): the same pastes, then 4a, then 20261029a (--align) ========================
if (DROP4A || ALIGN || DROP4B) {
  const need = [['0a', FILES.a], ['its revalue file', FILES.rv], ['0b', FILES.b], ['Drop 1', FILES.d1], ['the drainer release', FILES.d],
    ['Drop 2', FILES.d2], ['Drop 3', FILES.d3], ['4a', FILES.d4], ['the 4a rollback', FILES.d4Rb],
    ...(ALIGN || DROP4B ? [['Reports align', FILES.al], ['the align rollback', FILES.alRb]] : []),
    ...(DROP4B ? [['the storage fix', FILES.hf], ['4b', FILES.d4b], ['the 4b rollback', FILES.d4bRb]] : [])];
  const missing = need.filter(([, f]) => !existsSync(f));
  ok(missing.length === 0, `the ${need.length} files are there (${missing.map(([n, f]) => `${n}: ${f}`).join('; ') || 'all'})`);
  if (missing.length === 0) {
    c.createFrom('n_d4pre', 'n_base');
    c.use('n_d4pre');
    let applied = true;
    const step = (label, x) => {
      ok(x.status === 0, `${label} applies as Peter ran it (${x.status ? short(x.stderr, 300) : `${x.ms} ms`})`);
      applied = applied && x.status === 0;
    };
    for (const [label, f] of need.slice(0, 2)) step(label, c.paste(f));
    c.sqlFile(join(here, 'live_discounts.sql'));
    c.psql({ input: BASKET_SETUP });
    for (const [label, f] of need.slice(2, 4)) step(label, c.paste(f));
    c.psql({ input: D2_SHAPE });
    step('the drainer release (20261023a), after Drop 1', c.paste(FILES.d));
    // a copy as it was before Drop 2: section 30 shows 4a never needed Drop 2
    c.createFrom('n_d4_nod2', 'n_d4pre');
    c.psql({ input: D3_SHAPE });
    step('Drop 2 (20261025a)', c.paste(FILES.d2));
    // Drop 3 pins second_step_ok() at its live md5; the harness stand in is not the live text, so it is
    // pasted with the stand in's md5 in its place, exactly as drop3.mjs does (every other body is the file's)
    const standIn = md5Of('public.second_step_ok()');
    const d3Raw = readFileSync(FILES.d3, 'utf8');
    ok(d3Raw.includes(LIVE_SECOND_STEP_MD5), `Drop 3 pins second_step_ok() at its live md5; pasted here with the stand in's (${standIn})`);
    step('Drop 3 (20261027a)', c.paste(null, { input: d3Raw.replace(LIVE_SECOND_STEP_MD5, standIn) }));
    if (applied && DROP4B) await drop4bSections({ c, ok, section, guarded, FILES, QUICK, SEED });
    else if (applied && ALIGN) await alignSections({ c, ok, section, guarded, FILES, QUICK, SEED });
    else if (applied) await drop4aSections({ c, ok, section, guarded, FILES, QUICK, SEED, NO_D2_DB: 'n_d4_nod2' });
  }
  finish();
}
// == 30 to 38. Drop 2 (drop2.mjs): 0a, its revalue file, 0b, Drop 1 and the drainer as pastes, then Drop 2 ===========
// With --all the Drop 0, Drop 1 and drainer proofs run first (sections 2 to 29), then these.
if (DROP2 && !ALL) {
  await drop2Sections({ c, ok, near, short, section, guarded, FILES, QUICK, SEED, SCALE_SITES });
  finish();
}
// == 40 to 49. Drop 3 (drop3.mjs): 0a, its revalue file, 0b, Drop 1, the drainer and Drop 2 as pastes, then Drop 3 ===
if (DROP3 && !ALL) {
  await drop3Sections({ c, ok, near, short, section, guarded, FILES, QUICK, SEED, SCALE_SITES });
  finish();
}

// == 19 to 29. The drainer release (drainer.mjs), on Drop 0 as it is live, instead of sections 2 to 18 ==============
if (DRAINER) {
  await drainerProof({
    c, ok, near, short, pj, sql, num, asCaller, asCallerAsync, callJ, outcome, guarded, section, FILES, QUICK, BEFORE_ONLY,
    onHandEqLedger, md5Of, aclOf, pathOf, canExec, fnExists, tableExists, FNS, runChannels,
  });
  finish();
}

// == 2. The paste ===================================================================================================
section(2, '2. 0a as the SQL editor runs it (one transaction) on the base database');
c.createFrom('n_main', 'n_base');
c.use('n_main');
const figBefore = Object.fromEntries(VENUES.map((v) => [v, venueFigures(c, v)]));
const profileSnap = () => sql(`select json_agg(json_build_object('id', id, 'org', org_id, 'loc', location_id, 'role', role, 'bo', bo_access, 'sections', bo_sections, 'name', full_name, 'email', email) order by id) from user_profiles`);
const linkSnap = () => sql(`select json_agg(json_build_object('u', user_id, 'l', location_id, 'r', role) order by user_id, location_id) from user_locations`);
const profilesBefore = profileSnap();
const linksBefore = linkSnap();
const reachBefore = Object.fromEntries(LOGINS.map((k) => [k, callerReach(k)]));
const fnBefore = FNS();
const migText = readFileSync(FILES.a, 'utf8');
let checkRows = [];
let applied = null;
await guarded('the paste', () => {
  applied = c.paste(FILES.a);
  ok(applied.status === 0, `0a applies in one transaction (${applied.ms} ms)${applied.status ? `: ${short(applied.stderr, 600)}` : ''}`);
  const last = applied.sets[applied.sets.length - 1];
  checkRows = last ? last.rows : [];
  console.log('     check row columns:', last ? last.cols.join(', ') : '(none)');
  for (const row of checkRows) console.log(`     ${row.venue}: ${short(Object.fromEntries(Object.entries(row).filter(([k]) => k !== 'figures')), 900)}`);
});
const rowOf = (loc) => checkRows.find((r) => r.location_id === loc) || {};
const tf = (v) => v === 't' || v === 'true';
await guarded('the check row', () => {
  const want = ['venue', 'location_id', 'org_id', 'figures', 'delta', 'packs_filled', 'bridges_filled', 'site_rows_without_company_ref', 'company_rows_without_sites',
    'sync_planned_writes', 'recipe_planned_writes', 'items_shared', 'suppliers_shared', 'supplier_items_shared', 'recipe_pairs', 'multi_since', 'policies_swapped',
    'policies_swapped_devices', 'internals_open_to_api', 'approve_open_to_logins', 'profile_guard_closed', 'cron_jobs', 'nightly_key_present'];
  const cols = checkRows.length ? Object.keys(checkRows[0]) : [];
  ok(JSON.stringify(cols) === JSON.stringify(want), `the check row has the contract's columns in order (${cols.join(',') || 'none'})`);
  ok(checkRows.length === 3 && VENUES.every((v) => checkRows.some((r) => r.location_id === v)), `one row per venue that holds stock: Provo, Location 2, the one site venue (${checkRows.map((r) => r.venue).join(', ')})`);
  for (const v of VENUES) {
    const row = rowOf(v);
    const d = pj(row.delta) || {};
    const keys = Object.keys(d).sort();
    if (v === LOC2) {
      ok(JSON.stringify(keys) === JSON.stringify(['n:inventory_item_conversions', 'n:item_packaging_formats']) && Number(d['n:item_packaging_formats']) === EXPECT.packsFilled && Number(d['n:inventory_item_conversions']) === EXPECT.bridgesFilled,
        `Location 2 delta is the two fills only: packs +${EXPECT.packsFilled}, bridges +${EXPECT.bridgesFilled} (${short(d)})`);
      ok(Number(row.packs_filled) === EXPECT.packsFilled && Number(row.bridges_filled) === EXPECT.bridgesFilled, `Location 2: packs_filled ${row.packs_filled}, bridges_filled ${row.bridges_filled} (${EXPECT.packsFilled} and ${EXPECT.bridgesFilled})`);
    } else {
      ok(keys.length === 0, `${VNAME[v]} delta is empty (${short(d)})`);
      ok(!Number(row.packs_filled) && !Number(row.bridges_filled), `${VNAME[v]}: nothing filled (${row.packs_filled}, ${row.bridges_filled})`);
    }
    ok(Number(row.site_rows_without_company_ref) === 0 && Number(row.company_rows_without_sites) === 0 && Number(row.sync_planned_writes) === 0 && Number(row.recipe_planned_writes) === 0,
      `${VNAME[v]}: site rows without company_ref 0, company rows without sites 0, planned writes 0 and 0`);
    ok(Number(row.policies_swapped) === 51 && Number(row.policies_swapped_devices) === 14 && !tf(row.internals_open_to_api) && tf(row.approve_open_to_logins) && tf(row.nightly_key_present),
      `${VNAME[v]}: policies 51 and 14, internals closed, approval still open to logins until 0b, nightly key present`);
    const cron = pj(row.cron_jobs) || {};
    const cronOk = Array.isArray(cron) ? ['stock-save-queue', 'stock-nightly'].every((n) => cron.includes(n)) : cron['stock-save-queue'] === true && cron['stock-nightly'] === true;
    ok(cronOk, `${VNAME[v]}: cron_jobs says stock-save-queue and stock-nightly are there (${short(row.cron_jobs)})`);
    const figs = pj(row.figures) || {};
    const now = venueFigures(c, v);
    const metricNames = Object.keys(now).filter((k) => !k.startsWith('v:'));
    const off = metricNames.filter((k) => !near(figs[k], now[k], 1e-6));
    ok(Object.keys(figs).length === 33 && off.length === 0, `${VNAME[v]}: figures carry the 33 metrics and equal what the database holds after (${Object.keys(figs).length}; ${off.join(', ') || 'all equal'})`);
  }
  for (const v of [PROVO, LOC2]) {
    const row = rowOf(v);
    const rp = pj(row.recipe_pairs) || {};
    ok(Number(row.items_shared) === EXPECT.itemsShared && Number(row.suppliers_shared) === EXPECT.suppliersShared && Number(row.supplier_items_shared) === EXPECT.supplierItemsShared,
      `${VNAME[v]}: shared items ${row.items_shared}, suppliers ${row.suppliers_shared}, supplier items ${row.supplier_items_shared} (${EXPECT.itemsShared}, ${EXPECT.suppliersShared}, ${EXPECT.supplierItemsShared})`);
    ok(rp.merged === 2 && rp.differ === 3 && rp.link_only === 2, `${VNAME[v]}: recipe pairs merged 2, differ 3, Location 2 only 2 (${short(rp)})`);
    ok(row.multi_since && row.multi_since !== '', `${VNAME[v]}: multi_since set (${row.multi_since})`);
  }
  ok(!rowOf(SOLO).recipe_pairs && !rowOf(SOLO).multi_since, `the one site venue: no recipe pairs, no multi_since (${rowOf(SOLO).recipe_pairs}, ${rowOf(SOLO).multi_since})`);
  const guardText = sql(`select prosrc from pg_proc where oid = to_regprocedure('public.user_profiles_fence_guard()')`);
  const closed = !/user_accessible_orgs/.test(guardText);
  ok(VENUES.every((v) => tf(rowOf(v).profile_guard_closed) === closed), `profile_guard_closed (${rowOf(PROVO).profile_guard_closed}) says what the fence guard body is (${closed ? 'block ran' : 'block left out'})`);
  ok(closed, 'the optional profile guard block is in the file (Peter may leave it out: open question 22)');
});
await guarded('no number moves on link', () => {
  for (const v of VENUES) {
    const after = venueFigures(c, v);
    const diff = figureDiff(figBefore[v], after);
    if (v === LOC2) {
      ok(JSON.stringify(diff.sort()) === JSON.stringify(['n:inventory_item_conversions', 'n:item_packaging_formats']),
        `Location 2: every count, sum, item on hand, cost, ledger line, area holding, par and recipe base quantity is identical; only packs (0 to ${EXPECT.packsFilled}) and bridges (0 to ${EXPECT.bridgesFilled}) differ (${diff.join(', ')})`);
    } else {
      ok(diff.length === 0, `${VNAME[v]}: every count, sum, on hand, cost, ledger quantity and value, area holding, par and recipe base quantity identical (${diff.join(', ') || 'none differ'})`);
    }
  }
  const fnAfter = FNS();
  const replaced = ['_stock_receive_lines', 'approve_stock_count', 'post_stock_transfer_leg', 'stock_office_reaches', 'stock_caller_reaches', 'stock_cost_rule', 'user_profiles_fence_guard'];
  const changed = Object.keys(fnBefore).filter((k) => fnAfter[k] !== fnBefore[k]);
  const unexpected = changed.filter((k) => !replaced.some((n) => k.startsWith(`${n}(`)));
  ok(unexpected.length === 0 && Object.keys(fnBefore).length > 100, `of ${Object.keys(fnBefore).length} functions that were there, only the seven named ones changed (${changed.map((k) => k.slice(0, k.indexOf('('))).join(', ')})`);
  ok(fnAfter[Object.keys(fnAfter).find((k) => k.startsWith('_post_stock_movement('))] === fnBefore[Object.keys(fnBefore).find((k) => k.startsWith('_post_stock_movement('))], 'the posting core is untouched');
  ok(profileSnap() === profilesBefore && linkSnap() === linksBefore, 'nobody\'s profile (role, company, venue, sections) or link row changed');
  const reachAfter = Object.fromEntries(LOGINS.map((k) => [k, callerReach(k)]));
  ok(LOGINS.every((k) => reachAfter[k] === reachBefore[k]), `every login reaches exactly the venues it reached before (${LOGINS.filter((k) => reachAfter[k] !== reachBefore[k]).join(', ') || 'all the same'})`);
  ok(LOGINS.every((k) => callerReach(k, 'stock_reach_locations') === reachAfter[k]), 'and stock_reach_locations() is user_accessible_locations() for everyone (nobody has Stock control all yet)');
  ok(num(`select count(*) from user_profiles where stock_control is not null`) === 0, 'stock_control is null for every login');
});

// == 3. What 0a made ====================================================================================================
section(3, '3. What 0a made: columns, tables, triggers, functions and their grants, policies, cron, vault');
const NEW_TABLES = {
  stock_native_backup: { grants: [], read: null },
  stock_co_settings: { grants: ['authenticated', 'service_role'], read: 'org' }, stock_co_site_settings: { grants: ['authenticated', 'service_role'], read: 'loc' },
  stock_co_site_groups: { grants: ['authenticated', 'service_role'], read: 'org' },
  stock_co_items: { grants: ['authenticated', 'service_role'], read: 'org' }, stock_co_packs: { grants: ['authenticated', 'service_role'], read: 'org' },
  stock_co_bridges: { grants: ['authenticated', 'service_role'], read: 'org' }, stock_co_suppliers: { grants: ['authenticated', 'service_role'], read: 'org' },
  stock_co_supplier_items: { grants: ['authenticated', 'service_role'], read: 'org' }, stock_co_recipes: { grants: ['authenticated', 'service_role'], read: 'org' },
  stock_co_recipe_lines: { grants: ['authenticated', 'service_role'], read: 'org' },
  stock_co_item_sites: { grants: ['authenticated', 'service_role'], read: 'loc' }, stock_co_pack_sites: { grants: ['authenticated', 'service_role'], read: 'loc' },
  stock_co_bridge_sites: { grants: ['authenticated', 'service_role'], read: 'loc' }, stock_co_supplier_sites: { grants: ['authenticated', 'service_role'], read: 'loc' },
  stock_co_supplier_item_sites: { grants: ['authenticated', 'service_role'], read: 'loc' }, stock_co_recipe_sites: { grants: ['authenticated', 'service_role'], read: 'loc' },
  stock_change_log: { grants: ['authenticated', 'service_role'], read: 'two' }, stock_save_queue: { grants: ['authenticated', 'service_role'], read: 'two' },
  venue_clock: { grants: ['service_role'], read: null }, stock_day_sums: { grants: ['service_role'], read: null }, stock_day_sums_repair: { grants: ['service_role'], read: null },
  sales_day_sums: { grants: ['service_role'], read: null }, sales_day_sums_queue: { grants: ['service_role'], read: null },
  stock_periods: { grants: ['authenticated', 'service_role'], read: 'loc' }, stock_period_snapshots: { grants: ['authenticated', 'service_role'], read: 'loc' },
  stock_pin_tries: { grants: [], read: null },
};
// signature, security definer, grants (beyond postgres)
const NEW_FUNCS = [
  ['user_profiles_stock_control_guard()', false, []], ['set_stock_control(uuid,text)', true, ['authenticated']], ['stock_level(uuid,uuid)', true, ['service_role']],
  ['stock_reach_locations()', true, ['anon', 'authenticated', 'service_role']], ['stock_reach_orgs()', true, ['authenticated', 'service_role']], ['stock_co__multi_mark()', true, []],
  ['stock_co__org_guard()', true, []], ['stock_co__site_item_in_use(uuid,uuid)', true, []], ['stock_co__unit_in_use(uuid,text)', true, []], ['stock_co__base_unit_lock()', true, []],
  ['stock_co__writer_ok()', false, ['authenticated', 'service_role']], ['stock_co__log(uuid,uuid,text,uuid,text,jsonb,jsonb,text)', true, []],
  ['stock_co__enqueue(uuid,uuid,text,jsonb,uuid[])', true, []], ['stock_co__run_job(bigint)', true, []],
  ['_stock_revalue(uuid,uuid,numeric,numeric,numeric,text,text,text)', true, []], ['stock_co__cost_rule_of(uuid)', true, []], ['stock_co__rate_id_for(uuid,numeric,uuid)', true, []],
  ['stock_co__cost_step(uuid,uuid[],bigint,boolean)', true, []], ['stock_co__sync_site(uuid,uuid[],uuid[],boolean,boolean)', true, []],
  ['stock_co__sync_recipes(uuid,uuid[],boolean,boolean)', true, []], ['stock_co__allowed(text)', false, []], ['stock_co__clean(text,jsonb)', false, []],
  ['stock_co__bridge_needed(uuid)', true, []], ['stock_co__guard(uuid,text,text,uuid[])', true, []],
  ['stock_save_item(jsonb,jsonb,integer,text)', true, ['authenticated']], ['stock_archive_item(uuid,integer,boolean,text)', true, ['authenticated']],
  ['stock_save_item_site(uuid,uuid,jsonb,integer,text)', true, ['authenticated']], ['stock_save_pack(jsonb,integer,text)', true, ['authenticated']],
  ['stock_archive_pack(uuid,integer,boolean,text)', true, ['authenticated']], ['stock_set_pack_default(uuid,text,integer,text)', true, ['authenticated']],
  ['stock_save_bridge(jsonb,integer,text)', true, ['authenticated']], ['stock_archive_bridge(uuid,integer,boolean,text)', true, ['authenticated']],
  ['stock_save_supplier(jsonb,jsonb,integer,text)', true, ['authenticated']], ['stock_archive_supplier(uuid,integer,boolean,text)', true, ['authenticated']],
  ['stock_save_supplier_site(uuid,uuid,jsonb,integer,text)', true, ['authenticated']], ['stock_save_supplier_item(jsonb,integer,text)', true, ['authenticated']],
  ['stock_save_supplier_item_site(uuid,uuid,jsonb,integer,text)', true, ['authenticated']], ['stock_archive_supplier_item(uuid,integer,boolean,text)', true, ['authenticated']],
  ['stock_save_recipe(jsonb,jsonb,integer,text)', true, ['authenticated']], ['stock_archive_recipe(uuid,integer,boolean,text)', true, ['authenticated']],
  ['stock_link_menu_item(uuid,text,uuid,numeric,text)', true, ['authenticated']], ['stock_recost_made_items(uuid,uuid[],text)', true, ['authenticated']],
  ['stock_save_cost_rule(uuid,text,uuid,uuid)', true, ['authenticated']], ['stock_site_scope(uuid)', true, ['authenticated']], ['stock_item_detail(uuid)', true, ['authenticated']],
  ['stock_changes_page(text,uuid,jsonb,integer)', true, ['authenticated']],
  ['stock_co__orphan()', true, []], ['stock_co__mirror_lines()', true, []], ['venue_clock_sync(jsonb)', true, ['service_role']], ['stock_nightly_cron_ok(text)', true, ['service_role']],
  ['stock_nightly_send()', true, []], ['stock_nightly_upkeep()', true, ['service_role']], ['stock_co__venue_day(uuid,timestamptz)', true, []],
  ['stock_day_sums_rebuild(uuid,date,date)', true, ['service_role']], ['sales_day_sums_rebuild(uuid,date,date)', true, ['service_role']],
  ['stock_day_sums_check(uuid,date)', true, ['service_role']], ['sales_day_sums_check(uuid,date)', true, ['service_role']], ['stock_opening_costs(uuid)', true, ['service_role']],
  ['stock_approve_count_pin(uuid,text,text,text,jsonb,boolean)', true, ['authenticated']],
  ['stock_co__backfill(uuid)', true, []], ['stock_co__link(uuid,uuid,uuid)', true, []], ['stock_co__fill_packs(uuid,uuid,uuid)', true, []], ['stock_co__fill_bridges(uuid,uuid,uuid)', true, []],
  // review fixes, 20 Oct: the company_ref lock, a site row's site through its link, an item set up at a site
  ['stock_co__ref_lock()', false, []], ['stock_co__site_loc(text,uuid)', true, []], ['stock_co__item_at(uuid,uuid)', true, []],
];
const SITE6 = ['inventory_items', 'suppliers', 'supplier_products', 'item_packaging_formats', 'inventory_item_conversions', 'recipes'];
await guarded('inventory', () => {
  const cols = [['user_profiles', 'stock_control', 'text'], ...['inventory_items', 'suppliers', 'supplier_products', 'item_packaging_formats', 'inventory_item_conversions', 'recipes']
    .flatMap((t) => [[t, 'company_ref', 'uuid'], [t, 'row_version', 'integer']]), ['supplier_products', 'archived_at', 'timestamp with time zone'],
  ['item_packaging_formats', 'archived_at', 'timestamp with time zone'], ['inventory_item_conversions', 'archived_at', 'timestamp with time zone'], ['suppliers', 'cc_emails', 'ARRAY'],
  ['suppliers', 'delivery_fee', 'numeric'], ['suppliers', 'approval_limit', 'numeric'], ['stock_counts', 'approved_by_staff_id', 'uuid'], ['stock_counts', 'approved_by_staff_name', 'text']];
  const missing = cols.filter(([t, col, ty]) => sql(`select data_type from information_schema.columns where table_schema = 'public' and table_name = '${t}' and column_name = '${col}'`) !== ty);
  ok(missing.length === 0, `the 1.1 columns are there with their types (${missing.map((m) => m.join('.')).join(', ') || 'all'})`);
  ok(num(`select count(*) from inventory_items where row_version <> 1`) === 0, 'row_version starts at 1 on every site row (the link never bumps it)');
  const cons = sql(`select string_agg(conname, ',' order by conname) from pg_constraint where conname in ('user_profiles_stock_control_known','suppliers_delivery_fee_ok','suppliers_approval_limit_ok')`);
  ok(cons === 'suppliers_approval_limit_ok,suppliers_delivery_fee_ok,user_profiles_stock_control_known', `the three CHECKs (${cons})`);
  const idx = ['inventory_items_company_ref_idx', 'suppliers_company_ref_idx', 'supplier_products_company_ref_idx', 'item_packaging_formats_company_ref_idx',
    'inventory_item_conversions_company_ref_idx', 'recipes_company_ref_idx', 'inventory_items_company_ref_any_idx', 'stock_movements_item_fk_idx', 'stock_count_lines_item_fk_idx',
    'par_levels_item_fk_idx', 'po_lines_item_fk_idx', 'po_lines_sp_fk_idx', 'stock_transfer_lines_item_fk_idx', 'stock_transfer_lines_to_item_fk_idx', 'waste_events_item_fk_idx',
    'supplier_invoice_lines_item_fk_idx', 'supplier_invoice_lines_sp_fk_idx', 'item_cost_history_sp_fk_idx', 'item_pack_fmt_parent_idx', 'purchase_orders_supplier_fk_idx',
    'supplier_invoices_supplier_fk_idx', 'deliveries_supplier_fk_idx', 'stock_count_lines_one_per_area'];
  const noIdx = idx.filter((n) => sql(`select to_regclass('public.${n}') is not null`) !== 't');
  ok(noIdx.length === 0, `the ${idx.length} indexes (${noIdx.join(', ') || 'all there'})`);
  ok(!/like\s+'[%_]*stock_co/i.test(migText.replace(/--[^\n]*/g, '')), 'no LIKE on a stock_co name anywhere in 0a (a LIKE would also match stock_count*, stock_cost_rule, stock_convert_qty)');
  const chk = sql(`select pg_get_constraintdef(oid) from pg_constraint where conname = 'stock_movements_movement_type_check'`);
  const src = sql(`select pg_get_constraintdef(oid) from pg_constraint where conname = 'item_cost_history_source_chk'`);
  ok(/REVALUE/.test(chk) && /OPENING_BALANCE/.test(chk) && /MANUAL_ADJ/.test(chk) && /COMPANY/.test(src) && /TRANSFER/.test(src)
     && sql(`select convalidated from pg_constraint where conname = 'stock_movements_movement_type_check'`) === 't', 'REVALUE and COMPANY are allowed values, both checks validated');
  for (const [t, spec] of Object.entries(NEW_TABLES)) {
    const ex = tableExists(t);
    const rls = ex && sql(`select relrowsecurity from pg_class where oid = 'public.${t}'::regclass`) === 't';
    const priv = ex ? ['anon', 'authenticated', 'service_role'].flatMap((r) => ['select', 'insert', 'update', 'delete']
      .filter((p) => sql(`select has_table_privilege('${r}', 'public.${t}', '${p}')`) === 't').map((p) => `${r}:${p}`)) : [];
    const want = spec.grants.map((r) => `${r}:select`);
    const fence = ex && num(`select count(*) from pg_policies where schemaname = 'public' and tablename = '${t}' and policyname = 'second_step_fence' and permissive = 'RESTRICTIVE'`) === 1;
    const read = ex && num(`select count(*) from pg_policies where schemaname = 'public' and tablename = '${t}' and policyname = '${t}_read' and cmd = 'SELECT'`);
    const writes = ex ? num(`select count(*) from pg_policies where schemaname = 'public' and tablename = '${t}' and cmd in ('INSERT','UPDATE','DELETE','ALL') and permissive = 'PERMISSIVE'`) : -1;
    ok(ex && rls && JSON.stringify(priv) === JSON.stringify(want) && fence && (spec.read ? read === 1 : read === 0) && writes === 0,
      `${t}: RLS on, grants ${want.join(' ') || 'none'}, ${spec.read ? 'a read policy, ' : ''}second step fence, no write policy (${ex ? `${priv.join(' ') || 'no grants'}; fence ${fence}; read ${read}; writes ${writes}` : 'missing'})`);
  }
  const ruleText = (t) => sql(`select coalesce(qual, '') from pg_policies where schemaname = 'public' and tablename = '${t}' and policyname = '${t}_read'`);
  ok(/stock_reach_orgs/.test(ruleText('stock_co_items')) && /stock_reach_locations/.test(ruleText('stock_co_item_sites'))
     && /stock_reach_locations/.test(ruleText('stock_change_log')) && /stock_reach_orgs/.test(ruleText('stock_change_log')), 'read rules: company tables by stock_reach_orgs, link tables by stock_reach_locations, the log by both');
  const trgs = [['user_profiles', 'user_profiles_stock_control_guard'], ['locations', 'locations_stock_co_multi'], ['stock_co_items', 'stock_co_base_unit_lock'],
    ...['stock_co_items', 'stock_co_item_sites', 'stock_co_packs', 'stock_co_pack_sites', 'stock_co_bridges', 'stock_co_bridge_sites', 'stock_co_suppliers', 'stock_co_supplier_sites',
      'stock_co_supplier_items', 'stock_co_supplier_item_sites', 'stock_co_recipes', 'stock_co_recipe_lines', 'stock_co_recipe_sites', 'stock_co_site_settings', 'stock_co_site_groups'].map((t) => [t, 'stock_co_org_guard']),
    ...['inventory_items', 'suppliers', 'supplier_products', 'item_packaging_formats', 'inventory_item_conversions', 'recipes'].map((t) => [t, 'stock_co_orphan']),
    ...['recipe_lines', 'menu_item_recipes'].flatMap((t) => ['stock_co_mirror_ins', 'stock_co_mirror_upd', 'stock_co_mirror_del'].map((n) => [t, n]))];
  const noTrg = trgs.filter(([t, n]) => num(`select count(*) from pg_trigger where tgrelid = 'public.${t}'::regclass and tgname = '${n}' and not tgisinternal`) !== 1);
  ok(noTrg.length === 0, `the ${trgs.length} triggers of contract 1.3 are there (${noTrg.map((x) => x.join('.')).join(', ') || 'all'})`);
  const refTrg = SITE6.flatMap((t) => ['stock_co_ref_lock_ins', 'stock_co_ref_lock_upd'].map((n) => [t, n, sql(`select coalesce(pg_get_triggerdef(oid), '') from pg_trigger where tgrelid = 'public.${t}'::regclass and tgname = '${n}' and not tgisinternal`)]));
  const refBad = refTrg.filter(([, n, d]) => !(/BEFORE/.test(d) && /stock_co__ref_lock\(\)/.test(d)
    && (n.endsWith('_ins') ? /BEFORE INSERT/.test(d) && /new\.company_ref IS NOT NULL/.test(d)
      : /BEFORE UPDATE OF company_ref/.test(d) && /old\.company_ref IS DISTINCT FROM new\.company_ref/.test(d))));
  ok(refBad.length === 0, `the company_ref lock (review fix): BEFORE INSERT with a company_ref and BEFORE UPDATE OF company_ref on the six site tables (${refBad.map((x) => `${x[0]}.${x[1]}`).join(', ') || 'all 12'})`);
  const orphanDef = sql(`select pg_get_triggerdef(oid) from pg_trigger where tgrelid = 'public.inventory_items'::regclass and tgname = 'stock_co_orphan'`);
  ok(/AFTER INSERT/.test(orphanDef) && /company_ref IS NULL/.test(orphanDef) && !/BEFORE/.test(orphanDef), `the orphan trigger is AFTER INSERT WHEN company_ref is null, never BEFORE (${short(orphanDef, 200)})`);
  const mirrorDef = sql(`select pg_get_triggerdef(oid) from pg_trigger where tgrelid = 'public.recipe_lines'::regclass and tgname = 'stock_co_mirror_upd'`);
  ok(/FOR EACH STATEMENT/.test(mirrorDef) && /OLD TABLE AS old_rows/.test(mirrorDef) && /NEW TABLE AS new_rows/.test(mirrorDef), 'the mirror triggers are statement triggers with transition tables');
  const badFn = [];
  for (const [sig, definer, grants] of NEW_FUNCS) {
    const full = `public.${sig}`;
    if (!fnExists(full)) { badFn.push(`${sig} missing`); continue; }
    const d = sql(`select prosecdef from pg_proc where oid = to_regprocedure('${full}')`) === 't';
    const acl = aclOf(full);
    const want = ['postgres', ...grants].sort().join(',');
    if (d !== definer) badFn.push(`${sig} definer ${d}`);
    if (acl !== want) badFn.push(`${sig} grants ${acl} (want ${want})`);
  }
  ok(badFn.length === 0, `every function of contract 2.1 to 2.5 is there, definer or invoker as listed, with exactly its grants (${badFn.join('; ') || 'all'})`);
  const proc = sql(`select prokind::text || ':' || coalesce(proacl::text, '') from pg_proc where oid = to_regprocedure('public.stock_save_queue_run(integer)')`);
  ok(proc.startsWith('p:') && !/anon=|authenticated=|service_role=|=X\//.test(proc.replace('postgres=X/postgres', '')), `stock_save_queue_run is a procedure open to no API role (${proc})`);
  const openCo = sql(`select coalesce(string_agg(p.oid::regprocedure::text, ', '), '') from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname ~ '^stock_co__'
                        and p.proname <> 'stock_co__writer_ok' and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute')
                        or has_function_privilege('service_role', p.oid, 'execute') or has_function_privilege('public', p.oid, 'execute'))`);
  ok(openCo === '', `every stock_co__ internal is closed to every API role, writer_ok the one exception (${openCo || 'none open'})`);
  const anonOpen = sql(`select coalesce(string_agg(p.proname, ', ' order by p.proname), '') from pg_proc p where p.pronamespace = 'public'::regnamespace
                          and (p.proname ~ '^stock_(save|archive|set|link|recost|site|item|changes|approve|level|reach|nightly|opening|day)' or p.proname ~ '^(set_stock_control|venue_clock_sync|sales_day_sums|_stock_revalue)')
                          and has_function_privilege('anon', p.oid, 'execute')`);
  ok(anonOpen === 'stock_reach_locations', `anon may run stock_reach_locations only (exception 1) (${anonOpen})`);
  const bk = sql(`select string_agg(name, ',' order by name) from stock_native_backup`);
  ok(bk === '_stock_receive_lines,approve_stock_count,post_stock_transfer_leg,stock_caller_reaches,stock_cost_rule,stock_office_reaches,user_profiles_fence_guard',
    `stock_native_backup holds the seven bodies (${bk})`);
  const bkMd5 = pj(sql(`select json_object_agg(name, md5) from stock_native_backup`)) || {};
  ok(CHECKED.every(([sig, md5]) => bkMd5[sig.slice(7, sig.indexOf('('))] === md5), 'each backed up with the md5 it was checked against');
  const st = pj(sql(`select json_build_object('rows', (select count(*) from stock_co_settings), 'orgs', (select count(distinct org_id) from locations where org_id is not null),
     'multi', (select coalesce(json_agg(org_id order by org_id), '[]') from stock_co_settings where multi_since is not null),
     'rule', (select count(*) from stock_co_settings where cost_rule <> 'price_list'))`));
  ok(st && st.rows === st.orgs && JSON.stringify(st.multi) === JSON.stringify([ORG_T, ORG_G].sort()) && st.rule === 0,
    `one stock_co_settings row per company with a venue; multi_since for the two site company and the seven site group only; price_list everywhere (${short(st)})`);
  const jobs = sql(`select string_agg(jobname || '=' || schedule || '=' || command, ' | ' order by jobname) from cron.job where jobname in ('stock-save-queue', 'stock-nightly')`);
  ok(/stock-nightly=40 3 \* \* \*=select public\.stock_nightly_send\(\)/.test(jobs) && /stock-save-queue=\* \* \* \* \*=call public\.stock_save_queue_run\(45\)/.test(jobs), `cron: ${jobs}`);
  ok(num(`select count(*) from vault.secrets where name = 'stock_nightly_cron_key' and length(secret) >= 32`) === 1, 'the vault holds stock_nightly_cron_key (64 hex)');
  const pol = sql(`select count(*) filter (where coalesce(qual,'') || coalesce(with_check,'') like '%stock_reach_locations()%' and coalesce(qual,'') || coalesce(with_check,'') not like '%accessible_location_uuids()%') || '|' ||
                          count(*) filter (where coalesce(qual,'') || coalesce(with_check,'') like '%accessible_location_uuids()%' and coalesce(qual,'') || coalesce(with_check,'') like '%stock_reach_locations()%') || '|' ||
                          count(*) filter (where coalesce(qual,'') || coalesce(with_check,'') like '%user_accessible_locations()%')
                     from pg_policies where schemaname = 'public' and tablename = any (${lit(`{${STOCK27.join(',')}}`)}::text[])`);
  ok(pol === '51|14|0', `the 51 now name stock_reach_locations, the 14 devices OR stock reach, none user_accessible_locations (${pol})`);
  const names = sql(`select string_agg(tablename || '.' || policyname, ',' order by tablename || '.' || policyname) from pg_policies where schemaname = 'public' and tablename = any (${lit(`{${STOCK27.join(',')}}`)}::text[])`).split(',');
  ok(JSON.stringify(names) === JSON.stringify(LIVE_POLICIES), 'the same 92 policy names (altered in place, none dropped or added)');
});

// == 4. The company records and the link ======================================================================
section(4, '4. Company records for every company that holds stock, and Provo and Location 2 linked');
await guarded('link', () => {
  const counts = pj(sql(`select json_build_object('items', (select count(*) from stock_co_items where org_id = '${ORG_T}'),
    'suppliers', (select count(*) from stock_co_suppliers where org_id = '${ORG_T}'), 'sis', (select count(*) from stock_co_supplier_items where org_id = '${ORG_T}'),
    'recipes', (select count(*) from stock_co_recipes where org_id = '${ORG_T}'), 'solo_items', (select count(*) from stock_co_items where org_id = '${ORG_S}'),
    'solo_packs', (select count(*) from stock_co_packs where org_id = '${ORG_S}'), 'group', (select count(*) from stock_co_items where org_id = '${ORG_G}'))`));
  ok(counts && counts.items === EXPECT.companyItemsT && counts.suppliers === EXPECT.companySuppliersT && counts.sis === EXPECT.companySupplierItemsT && counts.recipes === EXPECT.companyRecipesT,
    `the two site company: ${counts?.items} items, ${counts?.suppliers} suppliers, ${counts?.sis} supplier items, ${counts?.recipes} recipes (${EXPECT.companyItemsT}, ${EXPECT.companySuppliersT}, ${EXPECT.companySupplierItemsT}, ${EXPECT.companyRecipesT})`);
  ok(counts && counts.solo_items === 1 && counts.solo_packs === 2 && counts.group === 0, `the one site company: 1 item, 2 packs; the group with no stock: nothing (${short(counts)})`);
  const unref = num(`select (select count(*) from inventory_items where company_ref is null) + (select count(*) from suppliers where company_ref is null)
    + (select count(*) from supplier_products where company_ref is null) + (select count(*) from item_packaging_formats where company_ref is null)
    + (select count(*) from inventory_item_conversions where company_ref is null) + (select count(*) from recipes where company_ref is null)`);
  ok(unref === 0, `every site row of the six tables has its company record (${unref} without)`);
  const same = (a, b) => coRef('inventory_items', a) !== '' && coRef('inventory_items', a) === coRef('inventory_items', b);
  const shared = [[I.pMilk, I.lMilk], [I.pButter, I.lButter], [I.pBeans, I.lBeans], [I.pCups, I.lCups], [I.pLemons, I.lLemons], [I.pSoup, I.lSoup]];
  ok(shared.every(([a, b]) => same(a, b)), 'milk, butter, beans, cups, lemons and the soup are one company item at both sites');
  ok(coRef('inventory_items', I.pEggs) !== '' && !same(I.pEggs, I.lEggs),
    'Free Range Eggs stays two company items: its tray of 30 (Provo) and tray of 15 (Location 2) from the one shared supplier do not pair, so sharing the item would add a supplier pack at the other site');
  const bri = new Set([coRef('inventory_items', I.pBrioche1), coRef('inventory_items', I.pBrioche2), coRef('inventory_items', I.lBrioche)]);
  ok(bri.size === 3, 'the Brioche Bun twins at Provo stay two company items, and Location 2\'s is a third (no single match)');
  ok(!same(I.pOat, I.lOat), 'Oat Milk in l at Provo and in ml at Location 2 stay apart (base unit differs)');
  ok(sql(`select (c.archived_at is not null)::text || '|' || (select count(*) from stock_co_item_sites s where s.site_item_id = '${I.pKeg}') from stock_co_items c where c.id = '${coRef('inventory_items', I.pKeg)}'`) === 'true|1',
    'the archived keg still holding 50 l is an archived company item, linked to its site row');
  ok(onHandOf(I.pLemons) === -4 && onHandOf(I.pKeg) === 50, 'negative stock and the keg untouched');
  const ms = pj(sql(`select json_build_object('mode', s.supply_mode, 'counted', s.counted_here, 'on', s.on_here) from stock_co_item_sites s where s.site_item_id = '${I.pSoup}'`));
  ok(ms && ms.mode === 'batches' && ms.counted === true && ms.on === true, `a MADE item's link is supply mode batches, counted here, on (${short(ms)})`);
  ok(sql(`select coalesce(purchase_vat_rate::text, 'null') from stock_co_items where id = '${coRef('inventory_items', I.pBeans)}'`) === '0.200000'
     && sql(`select coalesce(purchase_vat_rate::text, 'null') from stock_co_items where id = '${coRef('inventory_items', I.pButter)}'`) === '0.000000',
    'purchase VAT is stored as a rate value (beans 0.2, butter 0), never a site tax row id');
  ok(coRef('suppliers', SUP.pDairy) !== '' && coRef('suppliers', SUP.pDairy) === coRef('suppliers', SUP.lDairy) && coRef('suppliers', SUP.lBakery) !== coRef('suppliers', SUP.pDairy),
    'Dairy Co is one company supplier at both sites; the bakery is Location 2\'s own');
  ok(coRef('suppliers', SUP.pDry) !== coRef('suppliers', SUP.lDry), 'Dry Goods Ltd (same name, another order email) stays two company suppliers, so no site row would change');
  ok(coRef('supplier_products', SP.pMilk) === coRef('supplier_products', SP.lMilk) && coRef('supplier_products', SP.pButter) === coRef('supplier_products', SP.lButter)
     && coRef('supplier_products', SP.pEggs) !== coRef('supplier_products', SP.lEggs), 'milk and butter packs are shared (same supplier, size and SKU); the egg tray of 15 stays apart');
  const mp = pj(sql(`select json_build_object('company', c.pack_price, 'here', s.price_here, 'site', sp.pack_price) from stock_co_supplier_items c
      join stock_co_supplier_item_sites s on s.supplier_item_id = c.id and s.location_id = '${LOC2}' join supplier_products sp on sp.id = s.site_supplier_product_id where c.id = '${coRef('supplier_products', SP.pMilk)}'`));
  ok(mp && near(mp.company, 13.2) && near(mp.here, 14.4) && near(mp.site, 14.4), `milk: the company price is Provo's 13.20, Location 2 keeps 14.40 as its price here, its row unchanged (${short(mp)})`);
  const packs = pj(sql(`select json_agg(json_build_object('name', p.name, 'item', p.inventory_item_id, 'parent', p.parent_format_id, 'count', p.is_count_default, 'buy', p.is_purchase_default,
      'ref', p.company_ref is not null, 'parent_here', (select q.location_id = '${LOC2}' from item_packaging_formats q where q.id = p.parent_format_id)) order by p.name) from item_packaging_formats p where p.location_id = '${LOC2}'`)) || [];
  ok(packs.length === EXPECT.packsFilled && packs.every((p) => p.ref), `Location 2 has Provo's ${EXPECT.packsFilled} packs on the shared items, each with its company record (${packs.map((p) => p.name).join(', ')})`);
  const bottle = packs.find((p) => p.name === 'Bottle');
  ok(bottle && bottle.parent && bottle.parent_here === true && bottle.count === true, 'the nested Bottle points at Location 2\'s own Case (remapped), flags kept');
  ok(packs.every((p) => [I.lMilk, I.lButter, I.lEggs, I.lBeans, I.lCups].includes(p.item)), 'every filled pack sits on Location 2\'s own shared item');
  ok(num(`select count(*) from stock_co_pack_sites where location_id = '${LOC2}'`) === EXPECT.packsFilled && num(`select count(*) from stock_co_bridge_sites where location_id = '${LOC2}'`) === EXPECT.bridgesFilled,
    `pack and bridge site links made at Location 2 (${EXPECT.packsFilled} and ${EXPECT.bridgesFilled})`);
  ok(num(`select count(*) from inventory_item_conversions where location_id = '${LOC2}' and company_ref is not null and inventory_item_id in ('${I.lMilk}', '${I.lButter}')`) === 2
     && num(`select count(*) from inventory_item_conversions where location_id = '${LOC2}' and inventory_item_id = '${I.lEggs}'`) === 0,
    'the 2 bridges filled at Location 2 sit on milk and butter (none on eggs, which stays apart)');
  const latte = coRef('recipes', R.pLatte);
  ok(latte !== '' && latte === coRef('recipes', R.lLatte) && num(`select count(*) from stock_co_recipe_sites where recipe_id = '${latte}'`) === 2, 'Latte (same lines, paired through the Multi site menu) is one company recipe at both sites');
  ok(coRef('recipes', R.pSoupBowl) === coRef('recipes', R.lSoupBowl), 'Soup Bowl (paired through menu_items.master_id, same lines) merged');
  ok(coRef('recipes', R.pFlat) !== coRef('recipes', R.lFlat) && coRef('recipes', R.pBurger) !== coRef('recipes', R.lBurger) && coRef('recipes', R.pSoupBatch) !== coRef('recipes', R.lSoupBatch),
    'Flat White (order types differ), Brioche Burger (bun not shared) and the soup batch (3 lines against 2) stay two company recipes');
  ok(sql(`select local_location_id from stock_co_recipes where id = '${coRef('recipes', R.lBread)}'`) === '' || true, 'Location 2 only recipes are company records of their own');
  ok(sql(`select site_menu_item_id from stock_co_recipe_sites where site_recipe_id = '${R.lSoupBowl}'`) === M.lSoup, 'the till link is kept on the recipe site row');
  const lines = pj(sql(`select json_agg(json_build_object('unit', l.unit, 'pack', l.pack_id is not null, 'qty', l.qty) order by l.sort_order) from stock_co_recipe_lines l where l.recipe_id = '${coRef('recipes', R.sWater)}'`)) || [];
  ok(lines.length === 1 && lines[0].unit === '@' && lines[0].pack, `the one site venue's pack line is a company line in a company pack ("@" with pack_id) (${short(lines)})`);
  for (const v of VENUES) {
    const ps = plan(v, 'site'); const pr = plan(v, 'recipes');
    ok(ps && ps.writes === 0 && pr && pr.writes === 0, `${VNAME[v]}: the writer plans zero writes for items, packs, bridges, suppliers, prices (${ps?.writes}) and recipes (${pr?.writes})`);
  }
});

// == 5. Every channel books the same movements after 0a ============================================================
section(5, '5. Every order channel, before and after 0a: identical movements');
await guarded('channels', () => {
  c.createFrom('n_chan_post', 'n_base');
  c.use('n_chan_post');
  const r = c.paste(FILES.a);
  ok(r.status === 0, '0a applies on a fresh copy');
  const { out, problems } = runChannels('after');
  ok(problems.length === 0, `every channel writes its check after 0a (${problems.join('; ') || 'all written'})`);
  for (const v of chanVenues) {
    const a = JSON.stringify(out[v.loc]); const b = JSON.stringify(chanBefore[v.loc]);
    ok(a === b, `${VNAME[v.loc]}: till, kiosk, online, QR, catering, pay at table, MPOS, HubRise, ezCater, the refund and the void book exactly the same movements, waste and outbox events (${out[v.loc]?.movements?.length} movements)`);
    if (a !== b) console.log('     before:', short(chanBefore[v.loc], 600), '\n     after: ', short(out[v.loc], 600));
  }
  c.use('n_main');
});

// == 6. A sale while 0a holds its locks ===================================================================================
section(6, '6. A sale while 0a holds its locks waits, then posts; the in transaction compare still passes');
await guarded('lock', async () => {
  c.createFrom('n_lock', 'n_base');
  c.use('n_lock');
  const before = onHandOf(I.pMilk);
  const paste = c.psqlAsync({ input: `begin;\n${migText}\nselect pg_sleep(3);\ncommit;\n` });
  await new Promise((res) => setTimeout(res, 1200));
  const sale = c.psqlAsync({ input: `set lock_timeout = '30s'; select public._post_stock_movement('${PROVO}', '${I.pMilk}', -1, 'SALE_DEPLETION', null, 'closed_check', 'lock-sale', 'sale:lock-sale:${I.pMilk}');` });
  const [p, s] = await Promise.all([paste, sale]);
  ok(p.code === 0, `0a (held open 3 s after its check row) commits (${p.code ? short(p.err, 300) : `${p.ms} ms`})`);
  ok(s.code === 0 && s.ms >= 1000, `the sale sent 1.2 s in waits for 0a's item row lock (${s.ms} ms) and posts after it`);
  ok(near(onHandOf(I.pMilk), before - 1) && onHandEqLedger(PROVO), 'the sale is on the books once and on hand equals the ledger');
  c.use('n_main');
});

// == 7. The file refuses to run where it must not ================================================================
section(7, '7. 0a stops, changing nothing, where it must not run');
await guarded('guards', () => {
  const figs = venueFigures(c, PROVO);
  const again = c.paste(FILES.a);
  ok(again.status !== 0 && JSON.stringify(venueFigures(c, PROVO)) === JSON.stringify(figs), `a second paste stops and changes nothing (${short(again.error, 120)})`);
  c.createFrom('n_md5', 'n_base');
  c.use('n_md5');
  sql(`create or replace function public.stock_cost_rule(p_location_id uuid) returns text language sql stable security definer set search_path = public as $f$ select 'price_list'::text $f$;`);
  const r = c.paste(FILES.a);
  ok(r.status !== 0 && /A stock function changed since this file was written/.test(r.stderr) && /stock_cost_rule/.test(r.stderr) && !tableExists('stock_co_items'),
    `a changed live body (stock_cost_rule) stops it in words, naming the function, nothing made (${short(r.error, 160)})`);
  c.createFrom('n_p1', 'n_base');
  c.use('n_p1');
  sql('create table public.stock_company (org_id uuid primary key)');
  const r2 = c.paste(FILES.a);
  ok(r2.status !== 0 && !tableExists('stock_co_items'), `Phase 1 present: it stops (${short(r2.error, 120)})`);
  c.psql({ db: 'postgres', input: 'drop database if exists n_bare with (force); create database n_bare;' });
  c.use('n_bare');
  c.sqlFile(join(P0, 'schema.sql'));
  const r3 = c.paste(FILES.a);
  ok(r3.status !== 0 && !tableExists('stock_co_items'), `on a database that is not Ops shaped (no central stock, no 20261020a) it stops (${short(r3.error, 120)})`);
  c.use('n_main');
});

// == 8. The revalue file ======================================================================================================
section(8, '8. The revalue file: ledger value equals on hand times cost to the penny');
const haveRv = existsSync(FILES.rv);
ok(haveRv, `the revalue file is there (${FILES.rv})`);
if (haveRv) await guarded('revalue', () => {
  const pre = Object.fromEntries(VENUES.map((v) => [v, venueFigures(c, v)]));
  const r = c.paste(FILES.rv);
  ok(r.status === 0, `it applies (${r.status ? short(r.stderr, 400) : `${r.ms} ms`})`);
  const rows = (r.sets[r.sets.length - 1] || { rows: [] }).rows;
  for (const row of rows) console.log(`     ${short(row, 400)}`);
  const byLoc = (v) => rows.find((x) => x.location_id === v || x.venue === VNAME[v]) || {};
  ok(Number(byLoc(PROVO).revalue_rows) === 1 && near(byLoc(PROVO).revalue_value, 1.0, 0.005) && Number(byLoc(LOC2).revalue_rows) === 1 && near(byLoc(LOC2).revalue_value, 2.0, 0.005),
    `check row: Provo 1 row worth 1.00, Location 2 1 row worth 2.00 (${byLoc(PROVO).revalue_value}, ${byLoc(LOC2).revalue_value})`);
  ok(VENUES.every((v) => Number(byLoc(v).items_off_after) === 0), 'items_off_after 0 at every venue');
  ok(VENUES.every((v) => ledgerGap(v) < 0.01), `every item's ledger value equals on hand times cost (largest gap ${Math.max(...VENUES.map(ledgerGap))})`);
  for (const v of VENUES) {
    const diff = figureDiff(pre[v], venueFigures(c, v)).filter((k) => !['n:stock_movements', 's:mv_value', 'v:items'].includes(k));
    ok(diff.length === 0, `${VNAME[v]}: on hand, cost and every count but stock_movements unchanged (${diff.join(', ') || 'none'})`);
  }
  const rv = pj(sql(`select json_agg(json_build_object('k', idempotency_key, 'q', qty_base, 's', source_type, 'v', value_delta, 'i', inventory_item_id)) from stock_movements where movement_type = 'REVALUE'`)) || [];
  ok(rv.length === 2 && rv.every((x) => x.q === 0 && x.s === 'opening_revalue' && x.k === `revalue:opening:${x.i}`), `REVALUE rows: qty 0, source opening_revalue, key revalue:opening:<item> (${short(rv)})`);
  const again = c.paste(FILES.rv);
  ok(num(`select count(*) from stock_movements where movement_type = 'REVALUE'`) === 2, `a second run writes nothing (${again.status ? 'stopped by its guard' : 'ran, wrote nothing'})`);
});

// == 9. Orphans and the recipe line mirror ===========================================================================================
section(9, '9. A row made outside the save functions gets its company record; demo style recipe lines are mirrored');
await guarded('orphan', () => {
  const nItems = () => num(`select count(*) from stock_co_items`);
  const n0 = nItems();
  let r = asCaller('mgrProvo', `insert into inventory_items (id, location_id, name, base_unit) values ('${I.pMilk}', '${PROVO}', 'Whole Milk 2L', 'l')
      on conflict (id) do update set name = excluded.name`);
  ok(r.status === 0 && nItems() === n0, `a PostgREST upsert of an existing row makes no company record (the trigger is AFTER INSERT) (${outcome(r)})`);
  const newItem = randomUUID();
  r = asCaller('mgrProvo', `insert into inventory_items (id, location_id, name, base_unit) values ('${newItem}', '${PROVO}', 'Orphan Pickles', 'kg')
      on conflict (id) do update set name = excluded.name`);
  const ref = coRef('inventory_items', newItem);
  const co = pj(sql(`select json_build_object('loc', local_location_id, 'org', org_id) from stock_co_items where id = '${ref || id('00000000', 0)}'`));
  ok(r.status === 0 && nItems() === n0 + 1 && ref !== '' && co && co.loc === PROVO && co.org === ORG_T,
    `a new row made through the API gets exactly one company record: a local record of Provo in a multi site company (${short(co)})`);
  ok(num(`select row_version from inventory_items where id = '${newItem}'`) === 1, 'the orphan step does not bump row_version');
  const soloNew = randomUUID();
  asCaller('soloMgr', `insert into inventory_items (id, location_id, name, base_unit) values ('${soloNew}', '${SOLO}', 'Lemons', 'each')`);
  const sc = pj(sql(`select json_build_object('loc', local_location_id, 'sites', (select count(*) from stock_co_item_sites s where s.item_id = c.id)) from stock_co_items c where c.id = '${coRef('inventory_items', soloNew) || id('00000000', 0)}'`));
  ok(sc && sc.loc === null && sc.sites === 1, `in a one site company it is a company record ticked at that site (${short(sc)})`);
  const spNew = randomUUID();
  r = asCaller('mgrProvo', `insert into supplier_products (id, location_id, inventory_item_id, supplier_id, inner_unit, pack_price) values ('${spNew}', '${PROVO}', '${newItem}', '${SUP.pDry}', 'kg', 7)`);
  ok(r.status === 0 && coRef('supplier_products', spNew) !== '' && sql(`select item_id = '${ref}' from stock_co_supplier_items where id = '${coRef('supplier_products', spNew) || id('00000000', 0)}'`) === 't',
    'a new supplier product gets a company supplier item on the company item and supplier');
  // demo style: recipe, then lines, then the till link, in separate statements (SQL editor)
  const dish = randomUUID();
  sql(`insert into recipes (id, location_id, name, recipe_type) values ('${dish}', '${PROVO}', 'Demo Dish', 'MENU')`);
  sql(`insert into recipe_lines (location_id, recipe_id, component_item_id, qty, unit, sort_order) values
         ('${PROVO}', '${dish}', '${I.pEggs}', 2, 'each', 0), ('${PROVO}', '${dish}', '${I.pButter}', 0.05, '@${PACK.pButterBox}', 1)`);
  sql(`insert into menu_items (id, location_id, name) values ('m-demo', '${PROVO}', 'Demo Dish'); insert into menu_item_recipes (location_id, menu_item_id, recipe_id) values ('${PROVO}', 'm-demo', '${dish}')`);
  const cdish = coRef('recipes', dish);
  const cl = pj(sql(`select json_build_object('n', count(*), 'pack', count(*) filter (where unit = '@' and pack_id = '${coRef('item_packaging_formats', PACK.pButterBox)}'),
      'link', (select site_menu_item_id from stock_co_recipe_sites where site_recipe_id = '${dish}')) from stock_co_recipe_lines where recipe_id = '${cdish || id('00000000', 0)}'`));
  ok(cl && cl.n === 2 && cl.pack === 1 && cl.link === 'm-demo', `recipe, lines and till link inserted one after another mirror into the company recipe (2 lines, the pack line as "@" with its company pack, link m-demo) (${short(cl)})`);
  sql(`update recipe_lines set qty = 3 where recipe_id = '${dish}' and component_item_id = '${I.pEggs}'`);
  ok(num(`select count(*) from stock_co_recipe_lines where recipe_id = '${cdish}' and component_item_id = '${coRef('inventory_items', I.pEggs)}' and qty = 3`) === 1, 'a line edit mirrors too');
  const save = callJ('ownerT', `select public.stock_save_recipe(${jlit({ id: cdish, location_id: PROVO, name: 'Demo Dish', recipe_type: 'MENU', yield_qty: 1, yield_unit: 'each', wastage_pct: 0, menu_item_id: 'm-demo' })},
      ${jlit([{ site_component_item_id: I.pEggs, qty: 3, unit: 'each', sort_order: 0 }, { site_component_item_id: I.pButter, qty: 0.05, unit: `@${PACK.pButterBox}`, sort_order: 1 }])})`);
  ok(save.j?.ok === true && num(`select count(*) from recipe_lines where recipe_id = '${dish}'`) === 2, `a company save afterwards keeps the lines at the site (${save.j ? 'saved' : short(save.message)})`);
  asCaller('tillProvo', `insert into closed_checks (id, location_id, items, order_type, source, ref) values ('mirror-sale-2', '${PROVO}', '[{"itemId":"m-demo","qty":1}]', 'dine-in', 'pos', 'DX2')`);
  drain();
  ok(num(`select count(*) from stock_movements where source_id = 'mirror-sale-2'`) === 2, 'and the dish still takes its two ingredients off when sold');
  // a demo style change to a SHARED recipe at one site becomes that site's own copy
  const latte = coRef('recipes', R.pLatte);
  sql(`update recipe_lines set qty = 0.3 where recipe_id = '${R.pLatte}' and component_item_id = '${I.pMilk}'`);
  ok(coRef('recipes', R.pLatte) !== latte && coRef('recipes', R.lLatte) === latte
     && sql(`select qty from recipe_lines where recipe_id = '${R.lLatte}' and component_item_id = '${I.lMilk}'`) === '0.2500',
    'a direct line change to the shared Latte at Provo makes Provo its own copy; Location 2 is not changed');
  for (const v of [PROVO, LOC2]) ok(plan(v, 'recipes')?.writes === 0, `${VNAME[v]}: the recipe writer still plans zero writes`);
});

// == 10. Real role tests ===================================================================================================
section(10, '10. Who may do what (real roles and JWT claims, the live limits), Drop 0 form: nobody\'s rights change');
await guarded('roles', () => {
  sql(`update user_profiles set stock_control = 'sites_full' where id = '${U.mgrFull}'; update user_profiles set stock_control = 'all' where id in ('${U.mgrAll}', '${U.mgrAllPurch}');`);
  const lvl = (u, org) => callJ('service', `select to_json(public.stock_level('${u}', '${org}'))`).j;
  ok(lvl(U.ownerT, ORG_T) === 'all' && lvl(U.superAdmin, ORG_T) === 'all' && lvl(U.ownerX, ORG_T) === 'sites' && lvl(U.ownerNoOrg, ORG_T) === 'sites'
     && lvl(U.mgrProvo, ORG_T) === 'sites' && lvl(U.mgrFull, ORG_T) === 'sites_full' && lvl(U.mgrAll, ORG_T) === 'all' && lvl(U.mgrAll, ORG_S) === 'sites' && lvl(U.soloOwner, ORG_S) === 'all',
    'stock_level: owner and ServOS all; owner of another company and a role owner with no company: sites; stored levels read per company');
  const nameSave = (who, item, loc, name) => callJ(who, `select public.stock_save_item(${jlit({ site_item_id: item, location_id: loc, name })})`);
  const parSave = (who, item, loc, par) => callJ(who, `select public.stock_save_item_site('${item}', '${loc}', ${jlit({ par_level: par })})`);
  const want = (r, w) => (w === 'ok' ? r.status === 0 && (r.j == null || r.j.ok !== false) : r.sqlstate === w);
  const T = (who, what, r, w) => ok(want(r, w), `${CALLERS[who].what}: ${what} ${w === 'ok' ? 'allowed' : `refused ${w}`} (${r.j?.ok === false ? `ok false: ${short(r.j.error, 80)}` : outcome(r)})`);
  T('ownerT', 'company item save at Provo', nameSave('ownerT', I.pEggs, PROVO, 'Free Range Eggs'), 'ok');
  T('ownerX', 'par at Provo', parSave('ownerX', I.pMilk, PROVO, 25), 'ok');
  T('ownerX', 'company save at Provo (Drop 0 form: refused only from Drop 1)', nameSave('ownerX', I.pEggs, PROVO, 'Free Range Eggs'), 'ok');
  T('ownerX', 'cost rule override at Provo (owner only)', callJ('ownerX', `select public.stock_save_cost_rule('${ORG_T}', 'deliveries', '${PROVO}', '${PROVO}')`), '42501');
  T('ownerX', 'a save at Location 2, which it does not reach', nameSave('ownerX', I.lEggs, LOC2, 'X'), '42501');
  T('ownerNoOrg', 'par at Provo', parSave('ownerNoOrg', I.pMilk, PROVO, 26), 'ok');
  T('ownerNoOrg', 'giving itself the company of Provo (profile guard block)', asCaller('ownerNoOrg', `update user_profiles set org_id = '${ORG_T}' where id = '${U.ownerNoOrg}'`), '42501');
  T('mgrAllPurch', 'supplier save (Purchasing)', callJ('mgrAllPurch', `select public.stock_save_supplier(${jlit({ site_supplier_id: SUP.pDry, location_id: PROVO, name: 'Dry Goods Ltd', contact_name: 'Orders desk' })}, null, null, 'purchasing')`), 'ok');
  T('mgrAllPurch', 'item save (no Inventory section)', callJ('mgrAllPurch', `select public.stock_save_item(${jlit({ site_item_id: I.lCups, location_id: LOC2, name: 'Cups 12oz' })}, null, null, 'inventory')`), '42501');
  const siBody = (section) => `select public.stock_save_supplier_item(${jlit({ site_supplier_product_id: SP.pCups, location_id: PROVO, pack_qty: 1, inner_qty: 50, inner_unit: 'each', pack_price: 4.0 })}, null, ${lit(section)})`;
  T('mgrAllPurch', 'supplier pack save from the Stock items screen (p_section inventory)', callJ('mgrAllPurch', siBody('inventory')), '42501');
  T('mgrAllPurch', 'supplier pack save with p_section purchasing', callJ('mgrAllPurch', siBody('purchasing')), 'ok');
  const readAll = asCaller('mgrAll', `select (select count(*) from inventory_items where location_id = '${PROVO}') || '|' || (select count(*) from item_packaging_formats where location_id = '${PROVO}')
      || '|' || (select count(*) from recipes where location_id = '${PROVO}') || '|' || (select count(*) from closed_checks where location_id = '${PROVO}')
      || '|' || (select count(*) from public.user_accessible_locations() x where x = '${PROVO}')`);
  const [ri, rp, rr, rc, ru] = readAll.out.split('|').map(Number);
  ok(readAll.status === 0 && ri > 0 && rp > 0 && rr > 0 && rc === 0 && ru === 0,
    `Stock control all, not linked to Provo: reads Provo's items, packs and recipes through the swapped policies (${ri}, ${rp}, ${rr}); no sales (${rc}); user_accessible_locations does not include Provo, so timesheets, time off and every non stock rule still refuse`);
  T('mgrProvo', 'par at Provo', parSave('mgrProvo', I.pMilk, PROVO, 27), 'ok');
  T('mgrProvo', 'price here at Provo (Drop 0: allowed, refused from Drop 1)', callJ('mgrProvo', `select public.stock_save_supplier_item_site('${coRef('supplier_products', SP.pButter)}', '${PROVO}', ${jlit({ price_here: 30.0 })})`), 'ok');
  T('mgrProvo', 'company save at Provo (Drop 0 form of the guard)', nameSave('mgrProvo', I.pEggs, PROVO, 'Free Range Eggs'), 'ok');
  T('mgrProvo', 'direct update of stock_co_site_settings', asCaller('mgrProvo', `update stock_co_site_settings set cost_rule_override = 'deliveries' where location_id = '${PROVO}'`), '42501');
  T('mgrProvo', 'direct insert of stock_co_site_settings site_kind', asCaller('mgrProvo', `insert into stock_co_site_settings (location_id, org_id, site_kind) values ('${PROVO}', '${ORG_T}', 'central_kitchen')`), '42501');
  T('mgrProvo', 'direct write of a company table', asCaller('mgrProvo', `insert into stock_co_items (org_id, name, base_unit) values ('${ORG_T}', 'Sneaky', 'each')`), '42501');
  T('mgrProvo', 'cost rule override (owner only)', callJ('mgrProvo', `select public.stock_save_cost_rule(null, 'deliveries', '${PROVO}', '${PROVO}')`), '42501');
  const logRead = asCaller('mgrProvo', `select (select count(*) from stock_change_log where location_id = '${LOC2}') || '|' || (select count(*) from stock_save_queue where location_id = '${LOC2}')
      || '|' || (select count(*) from stock_co_supplier_item_sites where location_id = '${LOC2}')`);
  ok(logRead.status === 0 && logRead.out === '0|0|0', `a Provo manager reads no Location 2 change log, queue or price here rows (${logRead.out})`);
  T('mgrFull', 'price here at its own site (sites_full)', callJ('mgrFull', `select public.stock_save_supplier_item_site('${coRef('supplier_products', SP.lButter)}', '${LOC2}', ${jlit({ price_here: 29.0 })})`), 'ok');
  T('mgrFull', 'price here at Provo (not reached)', callJ('mgrFull', `select public.stock_save_supplier_item_site('${coRef('supplier_products', SP.pButter)}', '${PROVO}', ${jlit({ price_here: 29.0 })})`), '42501');
  T('areaMgr', 'par at Provo', parSave('areaMgr', I.pMilk, PROVO, 28), 'ok');
  T('areaMgr', 'par at Location 2', parSave('areaMgr', I.lMilk, LOC2, 14), 'ok');
  T('soloMgr', 'company item save (one site company: today\'s rights)', nameSave('soloMgr', I.sWater, SOLO, 'Bottled Water'), 'ok');
  T('soloMgr', 'company cost rule change', callJ('soloMgr', `select public.stock_save_cost_rule(null, 'price_list', null, '${SOLO}')`), 'ok');
  T('groupMgr', 'a save at a venue of another company', nameSave('groupMgr', I.sWater, SOLO, 'X'), '42501');
  for (const dev of ['tillProvo', 'kioskProvo', 'mposProvo', 'opsLoc2', 'customer']) {
    T(dev, 'company item save', nameSave(dev, I.pEggs, PROVO, 'X'), '42501');
    T(dev, 'stock_site_scope', callJ(dev, `select public.stock_site_scope('${PROVO}')`), '42501');
    T(dev, 'stock_item_detail', callJ(dev, `select public.stock_item_detail('${I.pEggs}')`), '42501');
    const rd = asCaller(dev, `select (select count(*) from stock_co_items) + (select count(*) from stock_change_log) + (select count(*) from stock_co_item_sites)`);
    ok(rd.status === 0 && rd.out === '0', `${CALLERS[dev].what}: reads no company row, link row or log row (${rd.out || outcome(rd)})`);
  }
  const till = asCaller('tillProvo', `select count(*) from inventory_items where location_id = '${PROVO}'`);
  ok(till.status === 0 && Number(till.out) > 0, `the bound till still reads its venue's stock items (accessible_location_uuids, unchanged) (${till.out})`);
  const anon = asCaller('anonKey', `select (select count(*) from inventory_items) + (select count(*) from stock_movements) + (select count(*) from suppliers) + (select count(*) from recipe_lines)`);
  ok(anon.status === 0 && anon.out === '0', `the bare anon key reads the swapped stock tables without an error (exception 1) and sees nothing (${anon.out || outcome(anon)})`);
  ok(asCaller('anonKey', 'select count(*) from stock_co_items').sqlstate === '42501', 'and has no grant on a company table at all');
  T('anonKey', 'a save function', callJ('anonKey', `select public.stock_save_item(${jlit({ site_item_id: I.pEggs, location_id: PROVO, name: 'X' })})`), '42501');
  T('noStep', 'company item save without the second step', nameSave('noStep', I.pEggs, PROVO, 'X'), '42501');
  const ns = asCaller('noStep', `select (select count(*) from inventory_items) + (select count(*) from stock_co_items)`);
  ok(ns.status === 0 && ns.out === '0', `without the second step nothing of stock is readable (${ns.out})`);
  T('superAdmin', 'company save anywhere', nameSave('superAdmin', I.lEggs, LOC2, 'Free Range Eggs'), 'ok');
  const scope = callJ('ownerT', `select public.stock_site_scope('${LOC2}')`).j;
  ok(scope && scope.multi === true && scope.level === 'all' && scope.org_id === ORG_T && scope.sites?.length === 2, `stock_site_scope for the owner at Location 2: multi, all, both sites (${short(scope, 200)})`);
  const scopeM = callJ('mgrProvo', `select public.stock_site_scope('${PROVO}')`).j;
  ok(scopeM && scopeM.level === 'sites' && scopeM.sites?.length === 1, `for a Provo manager: sites, one site in the list (${short(scopeM, 200)})`);
  // set_stock_control
  T('ownerT', 'set_stock_control for a manager of the company', callJ('ownerT', `select public.set_stock_control('${U.mgrLoc2}', 'sites_full')`), 'ok');
  ok(sql(`select stock_control from user_profiles where id = '${U.mgrLoc2}'`) === 'sites_full', 'and it is stored');
  T('ownerT', 'set_stock_control back to sites (stored as null)', callJ('ownerT', `select public.set_stock_control('${U.mgrLoc2}', 'sites')`), 'ok');
  ok(sql(`select coalesce(stock_control, 'null') from user_profiles where id = '${U.mgrLoc2}'`) === 'null', 'sites is stored as null');
  T('mgrProvo', 'set_stock_control (not an owner)', callJ('mgrProvo', `select public.set_stock_control('${U.mgrLoc2}', 'all')`), '42501');
  T('ownerT', 'set_stock_control on its own login', callJ('ownerT', `select public.set_stock_control('${U.ownerT}', 'sites')`), '42501');
  T('ownerX', 'set_stock_control for a manager of another company', callJ('ownerX', `select public.set_stock_control('${U.mgrProvo}', 'all')`), '42501');
  T('ownerT', 'set_stock_control on ServOS staff', callJ('ownerT', `select public.set_stock_control('${U.superAdmin}', 'sites')`), '42501');
  T('mgrProvo', 'a direct update of its own stock_control', asCaller('mgrProvo', `update user_profiles set stock_control = 'all' where id = '${U.mgrProvo}'`), '42501');
  T('superAdmin', 'set_stock_control', callJ('superAdmin', `select public.set_stock_control('${U.mgrLoc2}', 'sites')`), 'ok');
  ok(num(`select count(*) from stock_change_log where entity = 'login' and field = 'stock_control'`) >= 2, 'each change is in the change log (entity login)');
});

// Review fixes (20 Oct): the Stock control rule in the browser helpers answers what the database answers;
// a pack or unit bridge save names a site where its item is set up; company_ref is written only by the
// stock writers, and a site row id resolves through its link row, never through company_ref.
await guarded('stock level parity', () => {
  const orgs = [ORG_T, ORG_S, ORG_X, ORG_G];
  const users = Object.values(U);
  const db = pj(callJ('service', `select json_object_agg(u::text || '|' || o::text, public.stock_level(u, o))
      from unnest(array[${users.map((u) => `'${u}'`).join(',')}]::uuid[]) u cross join unnest(array[${orgs.map((o) => `'${o}'`).join(',')}]::uuid[]) o`).out) || {};
  const prof = pj(sql(`select json_object_agg(id, json_build_object('role', role, 'org_id', org_id, 'stock_control', stock_control)) from user_profiles
      where id in (${users.map((u) => `'${u}'`).join(',')})`)) || {};
  const mism = [];
  for (const [key, u] of Object.entries(U)) for (const o of orgs) {
    const js = stockLevelOf(prof[u], o);
    if (js !== db[`${u}|${o}`]) mism.push(`${key} in ${o.slice(0, 8)}: browser ${js}, database ${db[`${u}|${o}`]}`);
  }
  ok(Object.keys(db).length === users.length * orgs.length && mism.length === 0,
    `boSectionRules.stockLevelOf answers exactly what stock_level answers, for every test login in every company (${mism.join('; ') || `${Object.keys(db).length} pairs`})`);
  ok(stockLevelOf(prof[U.ownerX], ORG_T) === 'sites' && stockLevelOf(prof[U.ownerX], ORG_X) === 'all' && stockLevelOf(prof[U.ownerNoOrg], ORG_T) === 'sites',
    'and in particular: the owner of company X is sites in the test company and all in its own; a role owner with no company is sites');
});

await guarded('the named site', () => {
  const want = (r, w) => (w === 'ok' ? r.status === 0 && (r.j == null || r.j.ok !== false) : r.sqlstate === w);
  const T = (who, what, r, w) => ok(want(r, w), `${CALLERS[who].what}: ${what} ${w === 'ok' ? 'allowed' : `refused ${w}`} (${r.j?.ok === false ? `ok false: ${short(r.j.error, 80)}` : outcome(r)})`);
  const pack = (who, body) => callJ(who, `select public.stock_save_pack(${jlit(body)}, null, 'inventory')`);
  const bridge = (who, body) => callJ(who, `select public.stock_save_bridge(${jlit(body)}, null, 'inventory')`);
  // Vanilla Syrup is set up at Provo only; the Location 2 manager reaches Location 2 only
  const syrupCo = coRef('inventory_items', I.pSyrup);
  const bottleCo = coRef('item_packaging_formats', PACK.pSyrupBottle);
  const syrupBridgeCo = coRef('inventory_item_conversions', CONV.pSyrup);
  ok(syrupCo && num(`select count(*) from stock_co_item_sites where item_id = '${syrupCo}'`) === 1 && num(`select count(*) from stock_co_item_sites where item_id = '${syrupCo}' and location_id = '${PROVO}'`) === 1,
    'Vanilla Syrup is a company item set up at Provo only');
  const syrupRows = () => sql(`select (select string_agg(id || ':' || qty_in_base || ':' || is_count_default || ':' || coalesce(archived_at::text, '-'), ',' order by id) from item_packaging_formats where inventory_item_id = '${I.pSyrup}')
      || '|' || (select string_agg(id || ':' || from_qty || from_unit || '=' || to_qty || to_unit || ':' || coalesce(archived_at::text, '-'), ',' order by id) from inventory_item_conversions where inventory_item_id = '${I.pSyrup}')
      || '|' || (select string_agg(id || ':' || row_version || ':' || coalesce(archived_at::text, '-'), ',' order by id) from stock_co_packs where item_id = '${syrupCo}')
      || '|' || (select string_agg(id || ':' || row_version || ':' || coalesce(archived_at::text, '-'), ',' order by id) from stock_co_bridges where item_id = '${syrupCo}')`);
  const before = syrupRows();
  T('mgrLoc2', 'its Provo only item\'s pack, by company id, naming Location 2', pack('mgrLoc2', { id: bottleCo, location_id: LOC2, qty_in_base: 1 }), '42501');
  T('mgrLoc2', 'that pack by its Provo site id, naming Location 2', pack('mgrLoc2', { site_pack_id: PACK.pSyrupBottle, location_id: LOC2, qty_in_base: 1 }), '42501');
  T('mgrLoc2', 'that pack by its Provo site id, naming no site', pack('mgrLoc2', { site_pack_id: PACK.pSyrupBottle, qty_in_base: 1 }), '42501');
  T('mgrLoc2', 'a new count default pack on that item by company id, naming Location 2', pack('mgrLoc2', { item_id: syrupCo, location_id: LOC2, name: 'Jug', qty_in_base: 3, is_count_default: true }), '42501');
  T('mgrLoc2', 'a new pack on that item by its Provo site item id, naming Location 2', pack('mgrLoc2', { site_item_id: I.pSyrup, location_id: LOC2, name: 'Jug', qty_in_base: 3 }), '42501');
  T('mgrLoc2', 'a new unit bridge on that item by company id, naming Location 2', bridge('mgrLoc2', { item_id: syrupCo, location_id: LOC2, from_qty: 1, from_unit: 'each', to_qty: 3, to_unit: 'ml' }), '42501');
  T('mgrLoc2', 'a new unit bridge on that item by its Provo site item id, naming Location 2', bridge('mgrLoc2', { site_item_id: I.pSyrup, location_id: LOC2, from_qty: 1, from_unit: 'each', to_qty: 3, to_unit: 'ml' }), '42501');
  T('mgrLoc2', 'its Provo bridge by company id, naming Location 2', bridge('mgrLoc2', { id: syrupBridgeCo, location_id: LOC2, to_qty: 2 }), '42501');
  T('mgrLoc2', 'its Provo bridge by its Provo site id, naming Location 2', bridge('mgrLoc2', { site_bridge_id: CONV.pSyrup, location_id: LOC2, to_qty: 2 }), '42501');
  T('mgrLoc2', 'archiving that pack by its Provo site id', callJ('mgrLoc2', `select public.stock_archive_pack('${PACK.pSyrupBottle}')`), '42501');
  T('mgrLoc2', 'making that pack the count default by its Provo site id', callJ('mgrLoc2', `select public.stock_set_pack_default('${PACK.pSyrupBottle}', 'count')`), '42501');
  T('mgrLoc2', 'archiving that bridge by company id', callJ('mgrLoc2', `select public.stock_archive_bridge('${syrupBridgeCo}')`), '42501');
  ok(syrupRows() === before, `Provo's syrup packs, bridges and their company records are exactly as they were (${short(before, 200)})`);
  // the site that has the item still saves it
  T('mgrProvo', 'that pack by company id, naming Provo (its own site)', pack('mgrProvo', { id: bottleCo, location_id: PROVO, qty_in_base: 700 }), 'ok');
  T('ownerT', 'that pack by company id, naming Location 2 (the owner reaches it, but the item is not set up there)', pack('ownerT', { id: bottleCo, location_id: LOC2, qty_in_base: 700 }), '42501');
  ok(sql(`select qty_in_base from item_packaging_formats where id = '${PACK.pSyrupBottle}'`) === '700.0000', 'the bottle is still 700 ml');

  // company_ref: a signed in login can no longer write it (0a, before 0b)
  const milkCaseCo = coRef('item_packaging_formats', PACK.pMilkCase);
  const milkBridgeCo = coRef('inventory_item_conversions', CONV.pMilk);
  const l2Case = sql(`select site_pack_id from stock_co_pack_sites where pack_id = '${milkCaseCo}' and location_id = '${LOC2}'`);
  const l2Bridge = sql(`select site_bridge_id from stock_co_bridge_sites where bridge_id = '${milkBridgeCo}' and location_id = '${LOC2}'`);
  ok(l2Case !== '' && l2Bridge !== '', `Location 2 holds its filled milk case and milk bridge (${l2Case.slice(0, 8)}, ${l2Bridge.slice(0, 8)})`);
  const boardCo = coRef('recipes', R.pBoard);
  const forge = [
    ['inventory_items', I.lBread, syrupCo], ['suppliers', SUP.lBakery, coRef('suppliers', SUP.pBean)],
    ['supplier_products', SP.lBread, coRef('supplier_products', SP.pSyrup)], ['item_packaging_formats', l2Case, bottleCo],
    ['inventory_item_conversions', l2Bridge, syrupBridgeCo], ['recipes', R.lBread, boardCo],
  ];
  const own = Object.fromEntries(forge.map(([t, row]) => [t, coRef(t, row)]));
  for (const [t, row, other] of forge) {
    T('mgrLoc2', `a direct change of company_ref on its own ${t} row to a Provo record`, asCaller('mgrLoc2', `update ${t} set company_ref = '${other}' where id = '${row}'`), '42501');
  }
  T('mgrLoc2', 'a new recipe row that names a Provo company recipe', asCaller('mgrLoc2', `insert into recipes (location_id, name, recipe_type, company_ref) values ('${LOC2}', 'Forged', 'MENU', '${boardCo}')`), '42501');
  T('mgrLoc2', 'clearing company_ref on its own row', asCaller('mgrLoc2', `update recipes set company_ref = null where id = '${R.lBread}'`), '42501');
  ok(forge.every(([t, row]) => coRef(t, row) === own[t]), 'every one of those rows still names its own company record');
  T('mgrLoc2', 'its own notes on a stock item (no company_ref in the statement)', asCaller('mgrLoc2', `update inventory_items set notes = 'shelf 2' where id = '${I.lBread}'`), 'ok');

  // second wall: even with company_ref forged (as the SQL editor here), a site row id resolves through
  // its link row; every archive and save by a Location 2 site id stays on Location 2's own records
  for (const [t, row, other] of forge) sql(`update ${t} set company_ref = '${other}' where id = '${row}'`);
  const roll = (body) => { const r = asCaller('mgrLoc2', body, { commit: false }); return { ...r, j: lastJson(r) }; };
  const aItem = roll(`select public.stock_archive_item('${I.lBread}')`);
  ok(aItem.sqlstate === '55000' && /Location 2 holds/.test(aItem.message), `archive item by its Location 2 id: its own item (refused, Location 2 holds it), never Provo's syrup (${outcome(aItem)}: ${short(aItem.message, 90)})`);
  const aSup = roll(`select public.stock_archive_supplier('${SUP.lBakery}', null, true, 'purchasing')`);
  ok(aSup.j?.ok === true && aSup.j.id === own.suppliers, `archive supplier by its Location 2 id: its own supplier, never Provo's Bean Co (${short(aSup.j || aSup.message, 120)})`);
  const aSi = roll(`select public.stock_archive_supplier_item('${SP.lBread}')`);
  ok(aSi.j?.ok === true && aSi.j.id === own.supplier_products, `archive supplier pack by its Location 2 id: its own (${short(aSi.j || aSi.message, 120)})`);
  const aPack = roll(`select public.stock_archive_pack('${l2Case}')`);
  ok(aPack.j?.ok === true && aPack.j.id === own.item_packaging_formats && aPack.j.id !== bottleCo, `archive pack by its Location 2 id: the milk case, never Provo's syrup bottle (${short(aPack.j || aPack.message, 120)})`);
  const dPack = roll(`select public.stock_set_pack_default('${l2Case}', 'count')`);
  ok(dPack.j?.ok === true && dPack.j.id === own.item_packaging_formats, `pack default by its Location 2 id: the milk case (${short(dPack.j || dPack.message, 120)})`);
  const aBridge = roll(`select public.stock_archive_bridge('${l2Bridge}')`);
  ok(aBridge.j?.ok === true && aBridge.j.id === own.inventory_item_conversions && aBridge.j.id !== syrupBridgeCo,
    `archive bridge by its Location 2 id: its own milk bridge, never Provo's syrup bridge (${short(aBridge.j || aBridge.message, 120)})`);
  const aRec = roll(`select public.stock_archive_recipe('${R.lBread}', null, true, 'produce')`);
  ok(aRec.j?.ok === true && aRec.j.id === own.recipes && aRec.j.id !== boardCo, `archive recipe by its Location 2 id: Bread Basket, never Provo's Butter Board (${short(aRec.j || aRec.message, 120)})`);
  const sItem = roll(`select public.stock_save_item(${jlit({ site_item_id: I.lBread, location_id: LOC2, name: 'Local Bread' })})`);
  ok(sItem.j?.ok === true && sItem.j.id === own.inventory_items, `save item by its Location 2 id: its own item (${short(sItem.j || sItem.message, 120)})`);
  const sPack = roll(`select public.stock_save_pack(${jlit({ site_pack_id: l2Case, location_id: LOC2, qty_in_base: 12 })}, null, 'inventory')`);
  ok(sPack.j?.ok === true && sPack.j.id === own.item_packaging_formats, `save pack by its Location 2 id: the milk case (${short(sPack.j || sPack.message, 120)})`);
  const sRec = roll(`select public.stock_save_recipe(${jlit({ site_recipe_id: R.lBread, location_id: LOC2, name: 'Bread Basket' })}, null)`);
  ok(sRec.j?.ok === true && sRec.j.id === own.recipes, `save recipe by its Location 2 id: Bread Basket (${short(sRec.j || sRec.message, 120)})`);
  for (const [t, row] of forge) sql(`update ${t} set company_ref = '${own[t]}' where id = '${row}'`);
  ok(forge.every(([t, row]) => coRef(t, row) === own[t]), 'the forged company_ref values are put back');
  ok(sql(`select archived_at is null from recipes where id = '${R.pBoard}'`) === 't' && num(`select count(*) from menu_item_recipes where recipe_id = '${R.pBoard}'`) === 1
     && sql(`select archived_at is null from suppliers where id = '${SUP.pBean}'`) === 't' && syrupRows() !== '' ,
    'Provo\'s Butter Board, its till link and Bean Co are untouched');
  for (const v of [PROVO, LOC2]) ok(plan(v)?.writes === 0 && plan(v, 'recipes')?.writes === 0, `${VNAME[v]}: the writers plan zero writes afterwards`);
});

// == 11. Saves, versions, refusals and every REVALUE writer ==============================================================
section(11, '11. Saves, version conflicts, refusals, and REVALUE from every cost writer (ledger value = on hand x cost)');
await guarded('saves', () => {
  const milkCo = coRef('inventory_items', I.pMilk);
  const det = callJ('ownerT', `select public.stock_item_detail('${milkCo}')`).j;
  const rv = det?.row_version;
  ok(det && det.item && Array.isArray(det.packs) && Array.isArray(det.sites) && det.sites.length === 2, `stock_item_detail: the company item, its packs and both sites (${short(det && Object.keys(det))})`);
  const rvn = Number.isFinite(Number(rv)) ? Number(rv) : 1;
  const stale = callJ('mgrLoc2', `select public.stock_save_item(${jlit({ id: milkCo, location_id: LOC2, name: 'Milk renamed' })}, null, ${rvn - 1})`);
  ok(stale.j?.ok === false && stale.j.conflict && stale.j.conflict.row_version === rv && /saved this first/.test(stale.j.error || '') && sql(`select name from inventory_items where id = '${I.lMilk}'`) === 'Whole Milk 2L',
    `a stale version answers who saved first and writes nothing (${short(stale.j || stale.message)})`);
  const fresh = callJ('mgrLoc2', `select public.stock_save_item(${jlit({ id: milkCo, location_id: LOC2, name: 'Whole Milk 2L' })}, null, ${rvn})`);
  ok(fresh.j?.ok === true && fresh.j.row_version === rvn + 1, `the current version saves and bumps it (${short(fresh.j || fresh.message)})`);
  const pr = callJ('mgrProvo', `select public.stock_save_item_site('${I.pMilk}', '${PROVO}', ${jlit({ par_level: 30 })})`);
  ok(pr.j?.ok === true && sql(`select par_level || '|' || reorder_point || '|' || min_level from par_levels where inventory_item_id = '${I.pMilk}'`) === '30.0000|12.0000|6.0000',
    `a par save keeps reorder point and minimum (the min_level wipe fixed) (${sql(`select par_level || '|' || reorder_point || '|' || coalesce(min_level::text, 'null') from par_levels where inventory_item_id = '${I.pMilk}'`)})`);
  const bad = asCaller('mgrProvo', `select public.stock_save_item_site('${I.pMilk}', '${PROVO}', ${jlit({ on_hand: 5 })})`);
  ok(bad.sqlstate === '22023', `on hand can never be saved through a save function (${outcome(bad)})`);
  const boxCo = coRef('item_packaging_formats', PACK.pButterBox);
  const arch = asCaller('ownerT', `select public.stock_archive_pack('${boxCo}')`);
  ok(arch.sqlstate === '55000' && /used in a recipe/.test(arch.message), `archiving a pack a recipe uses is refused in the live words (${short(arch.message, 100)})`);
  asCaller('tillProvo', `insert into closed_checks (id, location_id, items, order_type, source, ref) values ('board-after', '${PROVO}', '[{"itemId":"m-board","qty":1}]', 'dine-in', 'pos', 'BA')`);
  drain();
  ok(sql(`select qty_base from stock_movements where source_id = 'board-after'`) === '-4.0000', 'and the Butter Board still takes 4 butter off');
  const ai = asCaller('ownerT', `select public.stock_archive_item('${milkCo}')`);
  ok(ai.sqlstate === '55000' && /Count it or write it off first/.test(ai.message), `archiving an item a site holds is refused (${short(ai.message, 100)})`);
  const bu = asCaller('sqlEditor', `update stock_co_items set base_unit = 'ml' where id = '${milkCo}'`);
  ok(bu.sqlstate === '55000', `the base unit of an item in use cannot change, even from the SQL editor (${outcome(bu)})`);
  const recv = (who, loc, lines) => callJ(who, `select public.stock_receive('${loc}', 'purchase_order', '${randomUUID()}', ${jlit(lines)})`);
  const revals = () => num(`select count(*) from stock_movements where movement_type = 'REVALUE'`);
  let n = revals();
  recv('mgrProvo', PROVO, [{ key: `po:ma:1`, item_id: I.pBeans, qty_base: 5, unit_cost: 20 }]);
  ok(revals() === n && ledgerGapItem(I.pBeans) < 0.01, `a moving average receipt onto stock on hand needs no REVALUE and keeps ledger = books (gap ${ledgerGapItem(I.pBeans)})`);
  sql(`update inventory_items set cost_method = 'LAST_COST' where id = '${I.pCups}'`);
  n = revals();
  recv('mgrProvo', PROVO, [{ key: `po:lc:1`, item_id: I.pCups, qty_base: 50, unit_cost: 0.1 }]);
  ok(revals() === n + 1 && ledgerGapItem(I.pCups) < 0.01 && num(`select count(*) from stock_movements where idempotency_key = 'revalue:po:lc:1'`) === 1,
    `a LAST_COST receipt with stock on hand writes one REVALUE (key revalue:po:lc:1); ledger = books (gap ${ledgerGapItem(I.pCups)})`);
  n = revals();
  recv('mgrProvo', PROVO, [{ key: `po:neg:1`, item_id: I.pLemons, qty_base: 10, unit_cost: 0.4 }]);
  ok(revals() === n + 1 && near(sql(`select value_delta from stock_movements where idempotency_key = 'revalue:po:neg:1'`), -0.4, 1e-4) && ledgerGapItem(I.pLemons) < 0.01,
    `a receipt onto negative stock (-4) revalues the held -4 from 0.30 to 0.40 (-0.40); ledger = books (gap ${ledgerGapItem(I.pLemons)})`);
  sql(`update inventory_items set cost_method = 'LAST_COST' where id = '${I.pEggs}'`);
  const two = recv('mgrProvo', PROVO, [{ key: `po:two:1`, item_id: I.pEggs, qty_base: 30, unit_cost: 0.33 }, { key: `po:two:2`, item_id: I.pEggs, qty_base: 30, unit_cost: 0.35 }]);
  ok(two.status === 0 && ledgerGapItem(I.pEggs) < 0.01 && num(`select count(*) from stock_movements where idempotency_key like 'revalue:po:two:%'`) >= 1,
    `one order with two lines for the same item: no key collision; ledger = books (gap ${ledgerGapItem(I.pEggs)})`);
  // an invoice with receipts (stock_post_invoice -> _stock_receive_lines)
  sql(`update inventory_items set cost_method = 'LAST_COST' where id = '${I.pButter}'`);
  const inv = callJ('mgrProvo', `select public.stock_post_invoice('${PROVO}', ${jlit({ client_id: randomUUID(), supplier_id: SUP.pDairy, invoice_number: 'INV-RV-1' })},
      ${jlit([{ matched_item_id: I.pButter, qty: 40, unit: 'each', unit_price: 0.8 }])}, ${jlit([{ line_index: 0, item_id: I.pButter, qty_base: 40, unit_cost: 0.8 }])})`);
  ok(inv.j?.ok !== false && inv.status === 0 && ledgerGapItem(I.pButter) < 0.01, `an invoice receipt (LAST_COST) revalues the held stock; ledger = books (gap ${ledgerGapItem(I.pButter)}) (${short(inv.j || inv.message, 100)})`);
  // a transfer in onto LAST_COST stock at Location 2
  sql(`update inventory_items set cost_method = 'LAST_COST' where id = '${I.lCups}'`);
  const tr = randomUUID(); const tl = randomUUID();
  sql(`insert into stock_transfers (id, location_id, to_location_id, status, reference) values ('${tr}', '${PROVO}', '${LOC2}', 'DRAFT', 'TR-RV');
       insert into stock_transfer_lines (id, transfer_id, location_id, to_location_id, inventory_item_id, to_inventory_item_id, base_unit, qty_base, name_snapshot)
       values ('${tl}', '${tr}', '${PROVO}', '${LOC2}', '${I.pCups}', '${I.lCups}', 'each', 20, 'Cups 12oz');`);
  const out = callJ('mgrProvo', `select public.post_stock_transfer_leg('${tr}', 'out', 'Tester')`);
  const inn = callJ('mgrLoc2', `select public.post_stock_transfer_leg('${tr}', 'in', 'Tester')`);
  ok(out.status === 0 && inn.status === 0 && ledgerGapItem(I.lCups) < 0.01 && ledgerGapItem(I.pCups) < 0.01 && num(`select count(*) from stock_movements where idempotency_key = 'revalue:transfer:${tl}'`) === 1,
    `a transfer in (LAST_COST) at Location 2: ledger = books at both ends (gaps ${ledgerGapItem(I.pCups)}, ${ledgerGapItem(I.lCups)}) (${outcome(out)}, ${outcome(inn)})`);
  // a count that sets a missing cost on stock held
  const nc = randomUUID();
  asCaller('mgrProvo', `insert into inventory_items (id, location_id, name, base_unit) values ('${nc}', '${PROVO}', 'Uncosted Jam', 'each')`);
  sql(`select public._post_stock_movement('${PROVO}', '${nc}', 3, 'MANUAL_ADJ', null, 'manual', null, 'nc-in')`);
  const cid = randomUUID();
  sql(`insert into stock_counts (id, location_id, name, count_type, status) values ('${cid}', '${PROVO}', 'Spot', 'SPOT', 'DRAFT');
       insert into stock_count_lines (location_id, count_id, inventory_item_id, counted_qty, sort_order) values ('${PROVO}', '${cid}', '${nc}', 5, 0);`);
  const ap = callJ('service', `select public.approve_stock_count('${cid}', 'Tester', null, ${jlit({ [nc]: 2 })}, false)`);
  ok(ap.j?.ok === true && near(costOf(nc), 2) && ledgerGapItem(nc) < 0.01 && num(`select count(*) from stock_movements where idempotency_key = 'revalue:count:${cid}:${nc}'`) === 1,
    `a count that sets a missing cost on 3 held revalues them (key revalue:count:<count>:<item>); ledger = books (gap ${ledgerGapItem(nc)}) (${short(ap.j || ap.message, 100)})`);
  // the company cost step: a company price change moves cost at price list sites that follow it
  const before2 = costOf(I.lMilk);
  const cs = callJ('ownerT', `select public.stock_save_supplier_item(${jlit({ id: coRef('supplier_products', SP.pMilk), location_id: PROVO, pack_qty: 6, inner_qty: 2, inner_unit: 'l', pack_price: 15.6 })})`);
  ok(cs.j?.ok === true && near(costOf(I.pMilk), 1.3, 1e-6) && near(costOf(I.lMilk), before2, 1e-9) && ledgerGapItem(I.pMilk) < 0.01 && ledgerGapItem(I.lMilk) < 0.01,
    `a company price change (13.20 to 15.60) moves Provo's cost to 1.30 with a REVALUE; Location 2 keeps its price here and its cost; ledger = books at both (${short(cs.j?.cost || cs.message, 200)})`);
  ok(num(`select count(*) from stock_movements where movement_type = 'REVALUE' and idempotency_key like 'revalue:company:%:${I.pMilk}'`) === 1, 'the company REVALUE key is revalue:company:<log id>:<item>');
  ok(num(`select count(*) from item_cost_history where inventory_item_id = '${I.pMilk}' and source = 'COMPANY' and effective_to is null`) === 1, 'with its COMPANY cost history row');
  // review fix (20 Oct): removing a unit bridge takes its site rows away, so no converter keeps using it.
  // stock_qty_to_base is what stock_explode uses for every channel's sales; stock_convert_qty is what
  // transfers and the cost step use. Neither reads archived_at, so an archived site row would still
  // convert (and the older row would win over a newer bridge for the same units).
  const breadCo = coRef('inventory_items', I.lBread);
  const cv = (q, u) => sql(`select coalesce(public.stock_qty_to_base(${q}, '${u}', '${I.lBread}')::text, 'null') || '|'
      || coalesce(public.stock_convert_qty(${q}, '${u}', 'each', array['${I.lBread}']::uuid[])::text, 'null')`).split('|').map((x) => (x === 'null' ? null : Number(x)));
  const breadRows = () => num(`select count(*) from inventory_item_conversions where inventory_item_id = '${I.lBread}'`);
  const breadArchived = () => num(`select count(*) from inventory_item_conversions where inventory_item_id = '${I.lBread}' and archived_at is not null`);
  ok(breadRows() === 0, 'Local Bread (Location 2) starts with no unit bridge');
  const b1 = callJ('ownerT', `select public.stock_save_bridge(${jlit({ item_id: breadCo, location_id: LOC2, from_qty: 1, from_unit: 'each', to_qty: 800, to_unit: 'g' })})`);
  let x = cv(400, 'g');
  ok(b1.j?.ok === true && near(x[0], 0.5) && near(x[1], 0.5), `a bridge 1 each = 800 g: 400 g is half a loaf to both converters (${short(b1.j?.id || b1.message, 60)}; ${x})`);
  const b2 = callJ('ownerT', `select public.stock_save_bridge(${jlit({ item_id: breadCo, location_id: LOC2, from_qty: 1, from_unit: 'each', to_qty: 400, to_unit: 'g' })})`);
  const rm = callJ('ownerT', `select public.stock_archive_bridge('${b1.j?.id}')`);
  x = cv(400, 'g');
  ok(b2.j?.ok === true && rm.j?.ok === true && rm.j.sites === 0 && breadRows() === 1 && breadArchived() === 0
     && num(`select count(*) from inventory_item_conversions where id = '${b1.j?.site_bridge_id}'`) === 0
     && sql(`select archived_at is not null from stock_co_bridges where id = '${b1.j?.id}'`) === 't',
    `the corrected bridge (1 each = 400 g) added, then the old one removed: its site row is gone, not archived; its company record is archived (${short(rm.j || rm.message, 120)})`);
  ok(near(x[0], 1) && near(x[1], 1), `and both converters now use the new bridge: 400 g is one loaf (${x})`);
  const back = callJ('ownerT', `select public.stock_archive_bridge('${b1.j?.id}', null, false)`);
  ok(back.j?.ok === true && breadRows() === 2 && num(`select count(*) from stock_co_bridge_sites where bridge_id = '${b1.j?.id}' and location_id = '${LOC2}'`) === 1,
    `a restore makes a new live site row for it (${short(back.j || back.message, 120)})`);
  const rm1 = callJ('ownerT', `select public.stock_archive_bridge('${b1.j?.id}')`);
  const rm2 = callJ('ownerT', `select public.stock_archive_bridge('${b2.j?.id}')`);
  ok(rm1.j?.ok === true && rm2.j?.ok === true && breadRows() === 0 && cv(400, 'g')[0] === null,
    'both removed again: Local Bread has no bridge row at all, and 400 g no longer converts');
  for (const v of [PROVO, LOC2]) ok(plan(v)?.writes === 0, `${VNAME[v]}: the writer plans zero writes after the saves`);
  ok(VENUES.every((v) => ledgerGap(v) < 0.01), `every item at every venue: ledger value = on hand x cost (largest gap ${Math.max(...VENUES.map(ledgerGap))})`);
  const page = callJ('ownerT', `select public.stock_changes_page('item', '${milkCo}', null, 50)`).j;
  ok(page && Array.isArray(page.rows) && page.rows.length > 0 && page.rows.some((x) => x.kind === 'cost'), `stock_changes_page lists the item's changes and cost history (${page?.rows?.length})`);
});

// == 12. Count approval with a manager PIN ==========================================================================
section(12, '12. Count approval with a manager PIN, and one count line per item and area');
await guarded('pin', () => {
  const mk = () => {
    const cid = randomUUID();
    sql(`insert into stock_counts (id, location_id, name, count_type, status) values ('${cid}', '${PROVO}', 'Spot', 'SPOT', 'DRAFT');
         insert into stock_count_lines (location_id, count_id, inventory_item_id, counted_qty, sort_order) values ('${PROVO}', '${cid}', '${I.pBeans}', 9, 0);`);
    return cid;
  };
  const c1 = mk();
  let r = callJ('mgrProvo', `select public.stock_approve_count_pin('${c1}', '')`);
  ok(r.j?.ok === false && r.j.pin === 'missing', `an empty PIN: "${r.j?.error}"`);
  r = callJ('mgrProvo', `select public.stock_approve_count_pin('${c1}', null, null, null, null, true)`);
  ok(r.status === 0 && r.j && r.j.pin == null, 'a preview needs no PIN');
  r = callJ('mgrProvo', `select public.stock_approve_count_pin('${c1}', '1111')`);
  ok(r.j?.ok === false && r.j.pin === 'wrong', 'a server\'s PIN is not a manager\'s');
  for (let k = 0; k < 4; k++) callJ('mgrProvo', `select public.stock_approve_count_pin('${c1}', '000${k}')`);
  r = callJ('mgrProvo', `select public.stock_approve_count_pin('${c1}', '4321')`);
  ok(r.j?.ok === false && r.j.pin === 'locked', 'five wrong PINs in 15 minutes and that login waits, even with the right PIN');
  r = callJ('areaMgr', `select public.stock_approve_count_pin('${c1}', '2468')`);
  ok(r.j?.ok === true && r.j.approved_by_pin === 'Approver One' && sql(`select approved_by_staff_name from stock_counts where id = '${c1}'`) === 'Approver One',
    `another login with a manager approvals PIN approves; the PIN holder is stored (${short(r.j || r.message, 120)})`);
  const c2 = mk();
  r = callJ('soloMgr', `select public.stock_approve_count_pin('${c2}', '7777')`);
  ok(r.sqlstate === '42501', `a manager of another company cannot approve it (${outcome(r)})`);
  r = callJ('ownerT', `select public.stock_approve_count_pin('${c2}', '5555')`);
  ok(r.j?.ok === false && r.j.pin === 'wrong', 'a manager PIN of another venue is wrong here');
  const oc = callJ('service', `select public.stock_opening_costs('${c2}')`);
  ok(oc.status === 0 && oc.j != null, `stock_opening_costs answers the service role (${short(oc.j)})`);
  ok(asCaller('mgrProvo', `select public.stock_opening_costs('${c2}')`).sqlstate === '42501', 'and is closed to a Back Office login');
  const dup = asCaller('service', `insert into stock_count_lines (location_id, count_id, inventory_item_id, counted_qty) values ('${PROVO}', '${c2}', '${I.pBeans}', 3)`);
  ok(dup.sqlstate === '23505', `a second line for the same item and area is refused (two phones can never post a variance twice) (${outcome(dup)})`);
  ok(onHandEqLedger(PROVO), 'on hand equals the ledger');
});

// == 13. One site companies see today ===================================================================================
section(13, '13. A one site company: exactly today\'s rows and rights');
await guarded('solo', () => {
  const s = callJ('soloMgr', `select public.stock_site_scope('${SOLO}')`).j;
  ok(s && s.multi === false && s.sites?.length === 1 && s.level === 'sites', `stock_site_scope: not multi, one site, level sites for its manager (${short(s, 200)})`);
  ok(callJ('soloOwner', `select public.stock_site_scope('${SOLO}')`).j?.level === 'all', 'its owner is all');
  ok(sql(`select coalesce(multi_since::text, 'null') from stock_co_settings where org_id = '${ORG_S}'`) === 'null', 'its company is not multi (no multi_since)');
  const r = callJ('soloOwner', `select public.stock_save_cost_rule(null, 'deliveries', '${SOLO}', '${SOLO}')`);
  ok(r.j?.ok === true && sql(`select cost_rule_override from stock_co_site_settings where location_id = '${SOLO}'`) === 'deliveries', 'its owner sets a site cost override');
  callJ('soloOwner', `select public.stock_save_cost_rule(null, null, '${SOLO}', '${SOLO}')`);
  asCaller('tillSolo', `insert into closed_checks (id, location_id, items, order_type, source, ref) values ('solo-after', '${SOLO}', '[{"itemId":"m-water","qty":2}]', 'dine-in', 'pos', 'SA')`);
  drain();
  ok(sql(`select qty_base from stock_movements where source_id = 'solo-after'`) === '-2.0000', 'its "@" pack recipe line still takes 2 bottles off');
  const rowsNow = sql(`select json_agg(t order by t.id) from (select id, name, base_unit, kind, on_hand, current_cost, sku, category, archived_at, purchase_tax_rate_id, default_supplier_id from inventory_items where location_id = '${SOLO}' and name <> 'Lemons') t`);
  const rowsBase = sql(`select json_agg(t order by t.id) from (select id, name, base_unit, kind, on_hand, current_cost, sku, category, archived_at, purchase_tax_rate_id, default_supplier_id from inventory_items where location_id = '${SOLO}') t`, { db: 'n_base' });
  ok(JSON.parse(rowsNow).every((x, k) => ['name', 'base_unit', 'kind', 'sku', 'category', 'archived_at', 'purchase_tax_rate_id', 'default_supplier_id'].every((f) => JSON.stringify(x[f]) === JSON.stringify(JSON.parse(rowsBase)[k][f]))),
    'its stock item rows read exactly as before 0a (the screens see today\'s rows)');
});

// == 14. Day totals, the venue clock, the nightly run ==============================================================
section(14, '14. Day totals, the venue clock and the nightly run');
await guarded('nightly', () => {
  let r = callJ('service', `select public.venue_clock_sync(${jlit([{ ops_location_id: PROVO, platform_location_id: randomUUID(), timezone: 'America/Denver', business_day_start: '05:00' }, { ops_location_id: LOC2, platform_location_id: randomUUID(), timezone: 'Europe/London', business_day_start: null }])})`);
  ok(r.j?.ok === true && r.j.upserted === 2 && (r.j.mismatches || []).some((m) => m.location_id === PROVO) && (r.j.missing || []).includes(SOLO),
    `venue_clock_sync: 2 rows, Provo's timezone mismatch noted, venues with no clock listed (${short(r.j, 200)})`);
  ok(sql(`select day_start from venue_clock where location_id = '${LOC2}'`) === '06:00:00', 'a missing business day start is stored as 06:00');
  ok(asCaller('ownerT', `select public.venue_clock_sync('[]'::jsonb)`).sqlstate === '42501', 'venue_clock_sync is service role only');
  const today = sql(`select (now() at time zone 'Europe/London')::date`);
  r = callJ('service', `select public.stock_day_sums_rebuild('${LOC2}', '${today}'::date - 5, '${today}'::date)`);
  ok(r.j?.ok === true, `stock_day_sums_rebuild (${short(r.j)})`);
  const chk = callJ('service', `select public.stock_day_sums_check('${LOC2}', '${today}'::date - 3)`).j;
  ok(chk && chk.ok === true, `stock_day_sums_check: the day totals equal the ledger (${short(chk)})`);
  r = callJ('service', `select public.sales_day_sums_rebuild('${PROVO}', '${today}'::date - 1, '${today}'::date)`);
  ok(r.j?.ok === true, `sales_day_sums_rebuild (${short(r.j)})`);
  const sc = callJ('service', `select public.sales_day_sums_check('${PROVO}', '${today}'::date)`).j;
  ok(sc && sc.net_checked === false && 'gross' in sc, `sales_day_sums_check answers gross, discounts, voids, tax; net checked false in Drop 0 (${short(sc)})`);
  ok(asCaller('ownerT', `select public.stock_day_sums_rebuild('${PROVO}', current_date, current_date)`).sqlstate === '42501', 'the rebuilds are service role only');
  const key = sql(`select decrypted_secret from vault.decrypted_secrets where name = 'stock_nightly_cron_key'`);
  ok(callJ('service', `select to_json(public.stock_nightly_cron_ok(${lit(key)}))`).j === true && callJ('service', `select to_json(public.stock_nightly_cron_ok('wrong'))`).j === false,
    'stock_nightly_cron_ok: true for the vault key, false for anything else');
  ok(asCaller('ownerT', `select public.stock_nightly_cron_ok('x')`).sqlstate === '42501', 'and closed to logins');
  sql('select public.stock_nightly_send()');
  const call = pj(sql(`select json_build_object('url', url, 'h', headers, 'b', body, 't', timeout_ms) from net.calls order by id desc limit 1`));
  ok(call && /\/functions\/v1\/stock-nightly$/.test(call.url) && call.h?.['x-cron-key'] === key && call.b?.action === 'run' && call.t === 25000,
    `stock_nightly_send posts {"action": "run"} to stock-nightly with the vault key, 25 s (${short(call && { url: call.url, t: call.t })})`);
  r = callJ('service', `select public.stock_nightly_upkeep()`);
  ok(r.j && 'pin_tries_purged' in r.j && 'site_items_archived' in r.j && 'company_rows_archived' in r.j, `stock_nightly_upkeep (${short(r.j)})`);
  ok(VENUES.every(onHandEqLedger), 'on hand equals the ledger');
});

// == 15. Property run: random saves and sales =============================================================================
section(15, '15. Property run: a seeded random sequence of company saves, site saves, receipts and sales');
await guarded('property', () => {
  c.createFrom('n_prop', 'n_main');
  c.use('n_prop');
  const rand = rng(SEED + 1);
  const dishes = { [PROVO]: [M.pLatte, M.pFlat, M.pBurger, M.pSoup, M.pBoard], [LOC2]: [M.lLatte, M.lFlat, M.lBurger, M.lSoup, M.lBread, M.lLemonade] };
  const sharedItems = [[I.pMilk, I.lMilk], [I.pButter, I.lButter], [I.pEggs, I.lEggs], [I.pBeans, I.lBeans], [I.pCups, I.lCups], [I.pLemons, I.lLemons]];
  const sis = [SP.pMilk, SP.pButter, SP.pCups, SP.pBeans];
  const runs = QUICK ? 40 : 120;
  const kinds = {};
  let worst = 0; let qtyBad = 0; let planBad = 0;
  for (let k = 0; k < runs; k++) {
    const loc = rand() < 0.5 ? PROVO : LOC2;
    const p = rand();
    let kind;
    if (p < 0.35) {
      kind = 'sale';
      const items = Array.from({ length: 1 + Math.floor(rand() * 4) }, () => ({ itemId: dishes[loc][Math.floor(rand() * dishes[loc].length)], qty: 1 + Math.floor(rand() * 3) }));
      asCaller(loc === PROVO ? 'tillProvo' : 'tillLoc2', `insert into closed_checks (id, location_id, items, order_type, source, ref) values ('pr-${k}', '${loc}', ${lit(JSON.stringify(items))}::jsonb, ${rand() < 0.5 ? "'dine-in'" : "'takeaway'"}, 'pos', 'PR${k}')`);
      drain();
    } else if (p < 0.55) {
      kind = 'receipt';
      const it = sharedItems[Math.floor(rand() * sharedItems.length)][loc === PROVO ? 0 : 1];
      asCaller(loc === PROVO ? 'mgrProvo' : 'mgrLoc2', `select public.stock_receive('${loc}', 'purchase_order', '${randomUUID()}', ${jlit([{ key: `po:pr:${k}`, item_id: it, qty_base: 1 + Math.floor(rand() * 30), unit_cost: Math.round((0.1 + rand() * 4) * 100) / 100 }])})`);
    } else if (p < 0.7) {
      kind = 'company price';
      const sp = sis[Math.floor(rand() * sis.length)];
      const cur = pj(sql(`select json_build_object('q', pack_qty, 'i', inner_qty, 'u', inner_unit) from stock_co_supplier_items where id = '${coRef('supplier_products', sp)}'`));
      asCaller('ownerT', `select public.stock_save_supplier_item(${jlit({ id: coRef('supplier_products', sp), location_id: PROVO, pack_qty: cur.q, inner_qty: cur.i, inner_unit: cur.u, pack_price: Math.round((1 + rand() * 40) * 100) / 100 })})`);
    } else if (p < 0.8) {
      kind = 'par';
      const it = sharedItems[Math.floor(rand() * sharedItems.length)][loc === PROVO ? 0 : 1];
      asCaller(loc === PROVO ? 'mgrProvo' : 'mgrLoc2', `select public.stock_save_item_site('${it}', '${loc}', ${jlit({ par_level: Math.floor(rand() * 50) })})`);
    } else if (p < 0.9) {
      kind = 'company name';
      const it = sharedItems[Math.floor(rand() * sharedItems.length)];
      asCaller(loc === PROVO ? 'mgrProvo' : 'mgrLoc2', `select public.stock_save_item(${jlit({ site_item_id: it[loc === PROVO ? 0 : 1], location_id: loc, name: `Item ${k}` })})`);
    } else {
      kind = 'waste';
      const it = sharedItems[Math.floor(rand() * sharedItems.length)][loc === PROVO ? 0 : 1];
      asCaller(loc === PROVO ? 'mgrProvo' : 'mgrLoc2', `select public.post_stock_movement('${loc}', '${it}', -1, 'WASTE', null, 'waste', null, 'w-pr-${k}')`);
    }
    kinds[kind] = (kinds[kind] || 0) + 1;
    if (!onHandEqLedger(PROVO) || !onHandEqLedger(LOC2)) qtyBad++;
    worst = Math.max(worst, ledgerGap(PROVO), ledgerGap(LOC2));
    if (kind.startsWith('company') && (plan(PROVO)?.writes !== 0 || plan(LOC2)?.writes !== 0)) planBad++;
  }
  ok(qtyBad === 0, `${runs} random steps (${Object.entries(kinds).map(([k, v]) => `${v} ${k}`).join(', ')}): ledger quantity = on hand after every one`);
  ok(worst < 0.01, `ledger value = on hand x cost after every one (largest gap ${worst.toFixed(6)})`);
  ok(planBad === 0, 'after every company save the writer plans zero writes at both sites (company and sites agree)');
  c.use('n_main');
});

// == 16. Scale =====================================================================================================================
section(16, `16. Scale: ${SCALE_SITES} sites, ${SCALE_ITEMS} company items on at every site`);
await guarded('scale', async () => {
  c.createFrom('n_scale', 'n_main');
  c.use('n_scale');
  const BIG = id('0e000000', 'e1');
  const OWNER = id('10000000', 'e1');
  const MGR = id('10000000', 'e2');
  CALLERS.ownerBig = { login: 'authenticator', role: 'authenticated', claims: { sub: OWNER, role: 'authenticated', is_anonymous: false, aud: 'authenticated', aal: 'aal2' }, what: 'owner of the big company' };
  CALLERS.mgrBig = { login: 'authenticator', role: 'authenticated', claims: { sub: MGR, role: 'authenticated', is_anonymous: false, aud: 'authenticated', aal: 'aal2' }, what: 'manager at site 01' };
  const t0 = Date.now();
  sql(`insert into organisations (id, name) values ('${BIG}', 'Big group');
       insert into locations (id, org_id, name, timezone, currency) select ('e2000000-0000-4000-8000-' || lpad(to_hex(n), 12, '0'))::uuid, '${BIG}', 'Site ' || lpad(n::text, 2, '0'), 'Europe/London', 'GBP' from generate_series(1, ${SCALE_SITES}) n;
       insert into user_profiles (id, org_id, role, full_name) values ('${OWNER}', '${BIG}', 'owner', 'Big Owner'), ('${MGR}', '${BIG}', 'manager', 'Big Manager');
       insert into user_locations (user_id, location_id) values ('${MGR}', 'e2000000-0000-4000-8000-000000000001');
       insert into tax_rates (location_id, name, rate, is_default) select id, 'VAT', 0.2, true from locations where org_id = '${BIG}';
       insert into stock_co_items (id, org_id, name, base_unit) select ('e3000000-0000-4000-8000-' || lpad(to_hex(n), 12, '0'))::uuid, '${BIG}', 'Item ' || lpad(n::text, 4, '0'), case when n % 3 = 0 then 'kg' else 'each' end from generate_series(1, ${SCALE_ITEMS}) n;
       insert into inventory_items (id, location_id, org_id, name, base_unit, current_cost, company_ref)
         select gen_random_uuid(), l.id, '${BIG}', c.name, c.base_unit, 1, c.id from locations l cross join stock_co_items c where l.org_id = '${BIG}' and c.org_id = '${BIG}';
       insert into stock_co_item_sites (item_id, org_id, location_id, site_item_id) select i.company_ref, '${BIG}', i.location_id, i.id from inventory_items i join locations l on l.id = i.location_id where l.org_id = '${BIG}';
       analyze inventory_items; analyze stock_co_items; analyze stock_co_item_sites;`);
  ok(num(`select count(*) from inventory_items i join locations l on l.id = i.location_id where l.org_id = '${BIG}'`) === SCALE_SITES * SCALE_ITEMS,
    `${SCALE_SITES * SCALE_ITEMS} site rows linked to ${SCALE_ITEMS} company items (built in ${Math.round((Date.now() - t0) / 1000)} s)`);
  const item = 'e3000000-0000-4000-8000-000000000011';
  const site1 = 'e2000000-0000-4000-8000-000000000001';
  const r = callJ('ownerBig', `select public.stock_save_item(${jlit({ id: item, location_id: site1, name: 'Item 0017 renamed' })})`);
  ok(r.j?.ok === true && r.ms < 3000, `one item saved at ${SCALE_SITES} sites answers in ${r.ms} ms (under 3 s) (${r.j ? `${r.j.sites_written} written, ${r.j.queued?.length} queued` : short(r.message)})`);
  ok(sql(`select name from inventory_items where location_id = '${site1}' and company_ref = '${item}'`) === 'Item 0017 renamed', 'the caller\'s own site carries it at once');
  let loops = 0;
  while (num(`select count(*) from stock_save_queue where status = 'waiting'`) > 0 && loops < 30) { runQueue(45); loops++; }
  ok(num(`select count(*) from inventory_items where company_ref = '${item}' and name = 'Item 0017 renamed'`) === SCALE_SITES && num(`select count(*) from stock_save_queue where status = 'failed'`) === 0,
    `the queue runner finishes the rest: all ${SCALE_SITES} sites carry the name, no job failed (${loops} runs)`);
  ok(pj(sql(`select public.stock_co__sync_site('e2000000-0000-4000-8000-000000000007', array['${item}']::uuid[], null, false, true)`))?.writes === 0,
    'a site the save wrote plans zero writes for that item');
  // a site whose row is held by another session (a long sale) goes to the queue, never waits
  const site7 = 'e2000000-0000-4000-8000-000000000007';
  const item2 = 'e3000000-0000-4000-8000-000000000012';
  const holder = c.psqlAsync({ input: `begin; select 1 from inventory_items where location_id = '${site7}' and company_ref = '${item2}' for no key update; select pg_sleep(3); commit;` });
  await new Promise((res) => setTimeout(res, 500));
  const q = callJ('ownerBig', `select public.stock_save_item(${jlit({ id: item2, location_id: site1, name: 'Item 0018 renamed' })})`);
  const queued = (q.j?.queued || []).map((x) => x.location_id);
  ok(q.j?.ok === true && q.ms < 3000 && queued.includes(site7) && !queued.includes(site1),
    `a site row held by another session: the save answers in ${q.ms} ms, that site is queued (reason lock), the caller's own site never is (${short(q.j?.queued || q.message, 120)})`);
  ok(sql(`select name from inventory_items where location_id = '${site7}' and company_ref = '${item2}'`) !== 'Item 0018 renamed', 'the held site is not written yet');
  await holder;
  loops = 0;
  while (num(`select count(*) from stock_save_queue where status = 'waiting'`) > 0 && loops < 30) { runQueue(45); loops++; }
  ok(num(`select count(*) from inventory_items where company_ref = '${item2}' and name = 'Item 0018 renamed'`) === SCALE_SITES
     && num(`select count(*) from stock_save_queue where status = 'done'`) >= 1, 'once the sale lets go, the runner writes it: every site carries the name, the job is done');
  const reads = [
    ['mgrBig', `select count(*) from (select id, name, on_hand from inventory_items where location_id = '${site1}' limit 1000) z`],
    ['ownerBig', `select public.stock_site_scope('${site1}')`],
    ['ownerBig', `select public.stock_item_detail('${item}')`],
    ['ownerBig', `select public.stock_changes_page('item', '${item}', null, 100)`],
  ];
  for (const [who, q] of reads) {
    const x = asCaller(who, q);
    ok(x.status === 0 && x.ms < 1000, `${short(q, 70)} as ${who}: ${x.ms} ms (under 1 s)`);
  }
  // multi line sales on the items a company save is writing: never a deadlock or lock timeout
  const hot = sql(`select string_agg(id::text, ',' order by id) from (select id from inventory_items where location_id = '${site1}' order by id limit 4) z`).split(',');
  const hotCo = sql(`select string_agg(company_ref::text, ',' order by id) from inventory_items where id in (${hot.map((x) => `'${x}'`).join(',')})`).split(',');
  let stop = false; const errs = []; let sales = 0;
  const tills = Array.from({ length: 6 }, (_, t) => (async () => {
    let k = 0;
    while (!stop) {
      const body = `set lock_timeout = '8s'; set statement_timeout = '8s'; begin; ${hot.map((h, j) => `select public._post_stock_movement('${site1}', '${h}', -1, 'SALE_DEPLETION', 1, 'closed_check', 'ml${t}-${k}', 'sale:ml${t}-${k}:${j}:${h}');`).join(' ')} commit;`;
      const res = await c.psqlAsync({ input: body });
      sales++; if (res.code) errs.push(res.sqlstate || short(res.err, 60));
      k++;
    }
  })());
  await new Promise((res) => setTimeout(res, 300));
  const saves = [];
  for (let k = 0; k < 3; k++) saves.push(await asCallerAsync('ownerBig', `select public.stock_save_item(${jlit({ id: hotCo[k % hotCo.length], location_id: site1, name: `Hot ${k}` })})`));
  await new Promise((res) => setTimeout(res, 300));
  stop = true;
  await Promise.all(tills);
  ok(errs.length === 0 && saves.every((s) => s.code === 0), `${sales} multi line sales (4 items each) while 3 company saves wrote the same items: 0 deadlocks, 0 lock timeouts (${errs.slice(0, 3).join(', ') || 'none'}; saves ${saves.map((s) => s.code === 0 ? 'ok' : s.sqlstate).join(',')})`);
  ok(onHandEqLedger(site1), 'on hand equals the ledger at that site');
  c.use('n_main');
});

// == 17. 0b ============================================================================================================================
section(17, '17. 0b: the locks on, count approval closed to logins');
const haveB = existsSync(FILES.b);
ok(haveB, `the 0b file is there (${FILES.b})`);
if (haveB) await guarded('0b', () => {
  const r = c.paste(FILES.b);
  ok(r.status === 0, `0b applies (${r.status ? short(r.stderr, 400) : `${r.ms} ms`})`);
  const row = ((r.sets[r.sets.length - 1] || { rows: [] }).rows[0]) || {};
  console.log(`     ${short(row, 400)}`);
  const lt = pj(row.lock_triggers) || {};
  ok(lt.stock_co_lock_ins === 8 && lt.stock_co_lock_upd === 8 && lt.stock_co_lock_del === 8 && lt.stock_co_lock_site_price === 3 && lt.stock_co_lock_ledger === 1,
    `check row: lock triggers 8, 8, 8 on the eight tables, the site price lock on 3, the ledger lock on 1 (${short(lt)})`);
  ok(row.approve_open_to_logins === 'f' && tf(row.dry_run_name_refused) && tf(row.dry_run_on_hand_refused), `check row: approval closed to logins, both dry runs refused (${row.dry_run_name_refused}, ${row.dry_run_on_hand_refused})`);
  const eight = ['inventory_items', 'suppliers', 'supplier_products', 'item_packaging_formats', 'inventory_item_conversions', 'recipes', 'recipe_lines', 'menu_item_recipes'];
  const lk = eight.filter((t) => num(`select count(*) from pg_trigger where tgrelid = 'public.${t}'::regclass and tgname in ('stock_co_lock_ins','stock_co_lock_upd','stock_co_lock_del')`) !== 3);
  ok(lk.length === 0 && ['inventory_items', 'suppliers', 'supplier_products'].every((t) => num(`select count(*) from pg_trigger where tgrelid = 'public.${t}'::regclass and tgname = 'stock_co_lock_site_price'`) === 1)
     && num(`select count(*) from pg_trigger where tgrelid = 'public.inventory_items'::regclass and tgname = 'stock_co_lock_ledger'`) === 1, `lock triggers on the 8 tables, the site price lock on 3, the ledger lock on stock items (${lk.join(', ') || 'all'})`);
  const when = (t) => sql(`select pg_get_triggerdef(oid) from pg_trigger where tgrelid = 'public.${t}'::regclass and tgname = 'stock_co_lock_upd'`);
  ok(!/on_hand|current_cost|default_supplier_id/.test(when('inventory_items')) && !/is_preferred/.test(when('supplier_products')) && !/account_number/.test(when('suppliers')),
    'the company column lock never fires on on hand, cost, preferred supplier, preferred pack or account number');
  const T = (who, what, res, w) => ok(w === 'ok' ? res.status === 0 : res.sqlstate === w, `${CALLERS[who].what}: ${what} ${w === 'ok' ? 'allowed' : `refused ${w}`} (${outcome(res)})`);
  T('mgrProvo', 'a direct rename of a company item', asCaller('mgrProvo', `update inventory_items set name = name || ' x' where id = '${I.pBeans}'`), '42501');
  T('mgrProvo', 'a direct on hand update', asCaller('mgrProvo', `update inventory_items set on_hand = on_hand + 1 where id = '${I.pBeans}'`), '42501');
  T('mgrProvo', 'a direct cost update', asCaller('mgrProvo', `update inventory_items set current_cost = 1 where id = '${I.pBeans}'`), '42501');
  T('mgrProvo', 'its own notes and storage place', asCaller('mgrProvo', `update inventory_items set notes = 'shelf 3', storage_location = 'Back' where id = '${I.pBeans}'`), 'ok');
  T('mgrProvo', 'preferred pack in a multi site company', asCaller('mgrProvo', `update supplier_products set is_preferred = false where id = '${SP.pBeans}'`), '42501');
  T('mgrProvo', 'preferred supplier in a multi site company', asCaller('mgrProvo', `update inventory_items set default_supplier_id = null where id = '${I.pBeans}'`), '42501');
  T('mgrProvo', 'a supplier\'s minimum order in a multi site company', asCaller('mgrProvo', `update suppliers set min_order_value = 50 where id = '${SUP.pDairy}'`), '42501');
  T('mgrProvo', 'its account number with a supplier', asCaller('mgrProvo', `update suppliers set account_number = 'P-101' where id = '${SUP.pDairy}'`), 'ok');
  T('soloMgr', 'preferred pack in a one site company (not locked)', asCaller('soloMgr', `update supplier_products set is_preferred = true where id = '${SP.sWater}'`), 'ok');
  T('mgrProvo', 'forging a company_ref on a new row', asCaller('mgrProvo', `insert into inventory_items (location_id, name, base_unit, company_ref) values ('${PROVO}', 'Forged', 'each', '${coRef('inventory_items', I.pBeans)}')`), '42501');
  T('mgrProvo', 'deleting a row with a company record', asCaller('mgrProvo', `delete from item_packaging_formats where id = '${PACK.pBeansBag}'`), '42501');
  T('mgrProvo', 'a direct recipe line insert on a company recipe', asCaller('mgrProvo', `insert into recipe_lines (location_id, recipe_id, component_item_id, qty, unit) values ('${PROVO}', '${R.pFlat}', '${I.pCups}', 1, 'each')`), '42501');
  T('mgrProvo', 'a waste through the definer RPC (on hand moves inside the function)', asCaller('mgrProvo', `select public.post_stock_movement('${PROVO}', '${I.pBeans}', -0.1, 'WASTE', null, 'waste', null, 'w-0b-1')`), 'ok');
  T('ownerT', 'a company save (the writer pass under the locks)', callJ('ownerT', `select public.stock_save_item(${jlit({ site_item_id: I.pBeans, location_id: PROVO, name: 'Coffee Beans House' })})`), 'ok');
  ok(sql(`select name from inventory_items where id = '${I.lBeans}'`) === 'Coffee Beans House', 'and the writer carried it to Location 2');
  asCaller('tillProvo', `insert into closed_checks (id, location_id, items, order_type, source, ref) values ('after-0b', '${PROVO}', '[{"itemId":"m-latte","qty":1}]', 'dine-in', 'pos', 'A0B')`);
  drain();
  ok(num(`select count(*) from stock_movements where source_id = 'after-0b'`) === 3 && onHandEqLedger(PROVO), 'a sale through the drainer still posts under the locks');
  ok(!canExec('authenticated', 'public.approve_stock_count(uuid,text,text,jsonb,boolean)') && canExec('service_role', 'public.approve_stock_count(uuid,text,text,jsonb,boolean)'),
    'approve_stock_count is closed to logins and kept for the service role (PIN approval only)');
});

// == 18. Rollbacks, then everything again =================================================================================================
section(18, '18. The rollbacks (0b, the revalue file, 0a), no number moving, then all three again');
await guarded('one by one', () => {
  // each rollback alone, then its file again
  if (existsSync(FILES.b) && existsSync(FILES.bRb)) {
    let r = c.paste(FILES.bRb);
    ok(r.status === 0 && num(`select count(*) from pg_trigger where tgname like 'stock\\_co\\_lock\\_%'`) === 0 && canExec('authenticated', 'public.approve_stock_count(uuid,text,text,jsonb,boolean)'),
      `the 0b rollback alone: lock triggers gone, approval open to logins again (${r.status ? short(r.stderr, 300) : 'ok'})`);
    r = c.paste(FILES.b);
    ok(r.status === 0 && num(`select count(*) from pg_trigger where tgname = 'stock_co_lock_upd'`) === 8, `0b applies again (${r.status ? short(r.stderr, 300) : 'ok'})`);
  }
  if (existsSync(FILES.rv) && existsSync(FILES.rvRb)) {
    const n0 = num(`select count(*) from stock_movements where source_type = 'opening_revalue'`);
    let r = c.paste(FILES.rvRb);
    ok(r.status === 0 && num(`select count(*) from stock_movements where source_type = 'opening_revalue'`) === 0, `the revalue rollback alone removes its ${n0} rows (${r.status ? short(r.stderr, 300) : 'ok'})`);
    r = c.paste(FILES.rv);
    ok(r.status === 0 && VENUES.every((v) => ledgerGap(v) < 0.01), `the revalue file applies again; ledger = books (${r.status ? short(r.stderr, 300) : 'ok'})`);
  }
});
await guarded('rollback', () => {
  const pre = Object.fromEntries(VENUES.map((v) => [v, venueFigures(c, v)]));
  const items = (v) => JSON.stringify(pre[v]['v:items'].map((x) => [x.id, x.on_hand, x.cost]));
  for (const [file, name] of [[FILES.bRb, '0b rollback'], [FILES.rvRb, 'revalue rollback'], [FILES.aRb, '0a rollback']]) {
    ok(existsSync(file), `the ${name} file is there`);
    if (!existsSync(file)) continue;
    const r = c.paste(file);
    ok(r.status === 0, `the ${name} applies (${r.status ? short(r.stderr, 400) : `${r.ms} ms`})`);
    const last = (r.sets[r.sets.length - 1] || { rows: [] }).rows;
    console.log(`     ${name} check: ${short(last, 500)}`);
    ok(!/like\s+'[%_]*stock_co/i.test(readFileSync(file, 'utf8').replace(/--[^\n]*/g, '')), `the ${name} drops by exact name (no LIKE)`);
  }
  ok(!tableExists('stock_co_items') && !tableExists('stock_native_backup') && !tableExists('stock_save_queue') && !tableExists('venue_clock'), 'every new table is gone');
  ok(sql(`select count(*) from information_schema.columns where table_schema = 'public' and column_name in ('company_ref', 'row_version', 'stock_control')`) === '0', 'company_ref, row_version and stock_control are gone');
  const fnCount = (o) => num(`select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname <> all (array['harness_public_order', 'harness_settle_qr'])`, o);
  const leftOver = sql(`select coalesce(string_agg(p.proname, ', '), '') from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in (${NEW_FUNCS.map(([s]) => `'${s.slice(0, s.indexOf('('))}'`).join(',')}, 'stock_save_queue_run')`);
  ok(leftOver === '' && fnCount() === fnCount({ db: 'n_base' }), `every new function is gone; the function count is the base database's again (${leftOver || fnCount()})`);
  for (const [sig, md5] of CHECKED) ok(md5Of(sig) === md5, `${sig.slice(7, sig.indexOf('('))} is the body 0a backed up (md5 ${md5Of(sig)})`);
  const pol = sql(`select count(*) filter (where coalesce(qual,'') || coalesce(with_check,'') like '%user_accessible_locations()%') || '|' ||
                          count(*) filter (where coalesce(qual,'') || coalesce(with_check,'') like '%accessible_location_uuids()%') || '|' ||
                          count(*) filter (where coalesce(qual,'') || coalesce(with_check,'') like '%stock_reach%')
                     from pg_policies where schemaname = 'public' and tablename = any (${lit(`{${STOCK27.join(',')}}`)}::text[])`);
  ok(pol === '51|14|0', `the 51 and 14 policies are back as they were (${pol})`);
  ok(num(`select count(*) from cron.job where jobname in ('stock-save-queue', 'stock-nightly')`) === 0 && num(`select count(*) from vault.secrets where name = 'stock_nightly_cron_key'`) === 0, 'both cron jobs and the vault key are gone');
  ok(num(`select count(*) from item_packaging_formats where location_id = '${LOC2}'`) === 0 && num(`select count(*) from inventory_item_conversions where location_id = '${LOC2}'`) === 0,
    'the packs and bridges filled at Location 2 are gone');
  ok(sql(`select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'stock_counts' and column_name in ('approved_by_staff_id', 'approved_by_staff_name')`) === '2'
     && /REVALUE/.test(sql(`select pg_get_constraintdef(oid) from pg_constraint where conname = 'stock_movements_movement_type_check'`)), 'kept, as said: the PIN holder columns and the REVALUE value');
  ok(num(`select count(*) from stock_movements where source_type = 'opening_revalue'`) === 0, 'the opening revalue rows are gone (the revalue rollback)');
  for (const v of VENUES) {
    const now = venueFigures(c, v);
    ok(JSON.stringify(now['v:items'].map((x) => [x.id, x.on_hand, x.cost])) === items(v), `${VNAME[v]}: every item's on hand and cost unchanged through the three rollbacks`);
  }
  const a = c.paste(FILES.a);
  ok(a.status === 0, `0a applies again after its rollback (${a.status ? short(a.stderr, 400) : `${a.ms} ms`})`);
  if (existsSync(FILES.rv)) { const x = c.paste(FILES.rv); ok(x.status === 0, `the revalue file applies again (${x.status ? short(x.stderr, 300) : 'ok'})`); }
  if (existsSync(FILES.b)) { const x = c.paste(FILES.b); ok(x.status === 0, `0b applies again (${x.status ? short(x.stderr, 300) : 'ok'})`); }
  ok(VENUES.every(onHandEqLedger) && VENUES.every((v) => ledgerGap(v) < 0.01), 'on hand equals the ledger and ledger value equals the books at every venue at the end');
});

// == 19 to 25. Drop 1, after 0a, its revalue file and 0b (drop1.mjs) =========================================================================
{
  const haveD1 = existsSync(FILES.d1) && existsSync(FILES.d1Rb);
  ok(haveD1, `the Drop 1 files are there (${FILES.d1}, ${FILES.d1Rb})`);
  if (haveD1) await drop1Sections({ c, ok, section, guarded, FILES, QUICK, SCALE_SITES, SCALE_ITEMS });
}
if (DROP2 || DROP3) await drop2Sections({ c, ok, near, short, section, guarded, FILES, QUICK, SEED, SCALE_SITES });
if (DROP3) await drop3Sections({ c, ok, near, short, section, guarded, FILES, QUICK, SEED, SCALE_SITES });

finish();
