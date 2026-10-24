#!/usr/bin/env node
// run.mjs: proves 20261031a (open shifts and swaps) on a local, throwaway PostgreSQL 17, before Peter
// runs it on the Ops database. It never connects to Supabase.
//
//   node supabase/tests/wf_open_shifts/run.mjs
//
// It starts its own cluster in a temp folder (initdb and pg_ctl from PATH or /opt/homebrew/bin),
// builds the live shape (schema.sql) and stops it at the end. Calls are made the way the API makes
// them: logged in as authenticator, SET ROLE anon, authenticated or service_role, the claims set.
// What it proves, in order:
//   1. BEFORE: a shift with nobody on it is refused (staff_id is required);
//   2. the migration applies in one transaction and its check row reads as documented; a second run
//      is refused and changes nothing;
//   3. every case in cases.json gets the same answer from the database as from the JavaScript rules
//      (src/lib/openShiftRules.test.js runs the same list);
//   4. the fence: Back Office logins read their own venue's requests only and cannot write them;
//      anon cannot read them; nobody but the service role can run the judge; a Back Office login can
//      still put an open shift on its own venue's rota and not on another's;
//   5. the race: two, then eight people claiming one open shift at the same moment, one winner
//      (straight away mode), one waiting request (manager mode); one person claiming two overlapping
//      open shifts at the same moment, one of them refused;
//   6. the flows: drop, offer, decline, cancel, claim, approve (the claimer's own rate snapshotted),
//      decline by a manager, a request at another venue, a deleted shift;
//   7. the ROLLBACK refuses while open shifts exist, then puts everything back (policies, grants,
//      required columns), and the migration applies again after it.
// Exit code 0 only when every check holds.

import { spawnSync, spawn } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..');
const MIGRATION = process.env.WFOS_MIGRATION || join(repo, 'supabase/migrations/20261031a_OPS_wf_open_shifts.sql');
const ROLLBACK = process.env.WFOS_ROLLBACK || join(repo, 'supabase/migrations/20261031a_OPS_wf_open_shifts_ROLLBACK.sql');
const { cases } = JSON.parse(readFileSync(join(here, 'cases.json'), 'utf8'));

const bin = (name) => (existsSync(`/opt/homebrew/bin/${name}`) ? `/opt/homebrew/bin/${name}` : name);
const env = { ...process.env, LC_ALL: 'en_US.UTF-8', PGOPTIONS: '-c client_min_messages=warning' };
let failures = 0, passes = 0;
const ok = (cond, msg) => { if (cond) { passes++; console.log(`  ok   ${msg}`); } else { failures++; console.log(`  FAIL ${msg}`); } };

const port = process.env.WFOS_PGPORT || String(55500 + Math.floor(Math.random() * 80));
const dir = mkdtempSync(join(tmpdir(), 'pgw.'));
const data = join(dir, 'data');
{
  let r = spawnSync(bin('initdb'), ['-D', data, '-U', 'postgres', '--auth=trust', '-E', 'UTF8'], { env, encoding: 'utf8' });
  if (r.status !== 0) { console.error(r.stderr || r.stdout); process.exit(2); }
  r = spawnSync(bin('pg_ctl'), ['-D', data, '-l', join(dir, 'pg.log'), '-w', '-o', `-p ${port} -c listen_addresses='' -k ${dir} -c timezone=UTC`, 'start'], { env, encoding: 'utf8' });
  if (r.status !== 0) { console.error(r.stderr || r.stdout); process.exit(2); }
}
function stop() { spawnSync(bin('pg_ctl'), ['-D', data, '-m', 'fast', '-w', 'stop'], { env, encoding: 'utf8' }); rmSync(dir, { recursive: true, force: true }); }
process.on('uncaughtException', (e) => { console.error(e); stop(); process.exit(2); });

const psqlArgs = (login, extra = []) => ['-h', dir, '-p', port, '-U', login, '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-X', '-q', '-At', ...extra];
function psql({ login = 'postgres', input, args = [], allowFail = false }) {
  const r = spawnSync(bin('psql'), psqlArgs(login, args), { env, input, encoding: 'utf8' });
  if (r.status !== 0 && !allowFail) { console.error('psql failed:\n', input?.slice(0, 400), '\n', r.stderr || r.stdout); stop(); process.exit(2); }
  return r;
}
const sql = (q) => psql({ input: q }).stdout.trim();
const lit = (v) => (v == null ? 'null' : `'${String(v).replace(/'/g, "''")}'`);

const id = (p, n) => `${p}-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ORG = id('0a000000', 1), A = id('a0000000', 1), B = id('b0000000', 1);
const S = { C: id('c0000000', 1), Q: id('c0000000', 2), P: id('c0000000', 3), D: id('c0000000', 4), L: id('c0000000', 5), X: id('c0000000', 6) };
const EXTRA = Array.from({ length: 6 }, (_, i) => id('c0000000', 10 + i));
const U = { a: id('10000000', 1), b: id('10000000', 2) };

// The way the API calls: authenticator, SET ROLE, the request claims.
function as(role, body, { sub = null, allowFail = true } = {}) {
  const lines = ['\\set VERBOSITY verbose', 'begin;'];
  if (role !== 'postgres') {
    const claims = role === 'service_role' ? { role } : { role, sub, aud: 'authenticated' };
    lines.push(`select set_config('request.jwt.claims', ${lit(JSON.stringify(claims))}, true) \\g /dev/null`);
    lines.push(`set local role ${role};`);
  }
  lines.push(body.trim().replace(/;?$/, ';'), 'commit;');
  const r = psql({ login: role === 'postgres' ? 'postgres' : 'authenticator', input: lines.join('\n') + '\n', allowFail });
  const m = /ERROR:\s+([0-9A-Z]{5}):\s*(.*)/.exec(r.stderr || '');
  return { status: r.status, sqlstate: m ? m[1] : null, message: m ? m[2] : (r.stderr || '').trim(), out: r.stdout.trim() };
}
const svc = (q) => { const r = as('service_role', q); if (r.status !== 0) { console.error(r.message); } return r.out; };
const json = (q) => JSON.parse(svc(q) || 'null');

// Concurrent sessions (each its own psql process), resolved with their output.
function concurrent(role, body) {
  return new Promise((resolve) => {
    const claims = role === 'service_role' ? { role } : { role };
    const input = ['begin;', `select set_config('request.jwt.claims', ${lit(JSON.stringify(claims))}, true) \\g /dev/null`, `set local role ${role};`, body.trim().replace(/;?$/, ';'), 'commit;'].join('\n') + '\n';
    const p = spawn(bin('psql'), psqlArgs('authenticator'), { env });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => resolve({ code, out: out.trim(), err }));
    p.stdin.end(input);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  console.log('schema');
  psql({ args: ['-1', '-f', join(here, 'schema.sql')] });
  const TODAY = sql(`select (now() at time zone 'Europe/London')::date`);
  const plus = (n) => sql(`select (date ${lit(TODAY)} + ${Number(n)})::text`);
  sql(`insert into public.locations values (${lit(A)}, ${lit(ORG)}, 'Leeds', 'Europe/London', 'GBP'), (${lit(B)}, ${lit(ORG)}, 'San Mateo', 'America/Los_Angeles', 'USD');
       insert into public.user_locations values (${lit(U.a)}, ${lit(A)}, 'manager'), (${lit(U.b)}, ${lit(B)}, 'manager');
       insert into public.wf_roles (location_id, org_id, key, label, base_rate) values (${lit(A)}, ${lit(ORG)}, 'bar', 'Bartender', 12), (${lit(A)}, ${lit(ORG)}, 'kitchen', 'Chef', 13);
       insert into public.wf_staff (id, org_id, location_id, name, role_key, status, rate_override) values
         (${lit(S.C)}, ${lit(ORG)}, ${lit(A)}, 'Cara C', 'bar', 'active', null),
         (${lit(S.Q)}, ${lit(ORG)}, ${lit(A)}, 'Quinn Q', 'bar', 'active', 14.5),
         (${lit(S.P)}, ${lit(ORG)}, ${lit(A)}, 'Pat P', 'bar', 'active', null),
         (${lit(S.D)}, ${lit(ORG)}, ${lit(A)}, 'Dev D', 'kitchen', 'active', null),
         (${lit(S.L)}, ${lit(ORG)}, ${lit(A)}, 'Lee L', 'bar', 'leaver', null),
         (${lit(S.X)}, ${lit(ORG)}, ${lit(B)}, 'Xan X', 'bar', 'active', null)
         ${EXTRA.map((e, i) => `, (${lit(e)}, ${lit(ORG)}, ${lit(A)}, 'Extra ${i}', 'bar', 'active', null)`).join('')};`);

  console.log('1. before');
  const before = as('postgres', `insert into public.wf_shifts (location_id, org_id, staff_id, shift_date, start_time, finish_time, status) values (${lit(A)}, ${lit(ORG)}, null, date ${lit(TODAY)} + 2, '17:00', '22:00', 'published')`);
  ok(before.sqlstate === '23502', 'an open shift is refused before the migration (staff_id required)');

  console.log('2. the migration');
  // The one test row live has (Provo): a request on a shift that is in the past.
  sql(`insert into public.wf_shifts (id, location_id, org_id, staff_id, role_key, shift_date, start_time, finish_time, status) values (${lit(id('5a000000', 99))}, ${lit(A)}, ${lit(ORG)}, ${lit(S.P)}, 'bar', date ${lit(TODAY)} - 1, '10:00', '14:00', 'published');
       insert into public.wf_swap_requests (location_id, org_id, shift_id, from_staff_id, status) values (${lit(A)}, ${lit(ORG)}, ${lit(id('5a000000', 99))}, ${lit(S.P)}, 'open');`);
  const mig = psql({ args: ['-1', '-f', MIGRATION] });
  const check = mig.stdout.trim().split('\n').pop();
  ok(check === 't|8|2|10|f|0|f|f|t|1', `check row as documented (${check})`);
  const again = psql({ args: ['-1', '-f', MIGRATION], allowFail: true });
  ok(again.status !== 0 && /has run already/.test(again.stderr), 'a second run is refused');
  ok(sql(`select count(*) from pg_proc where proname = 'wf_shift_claim'`) === '1', 'a second run changed nothing');
  const raw = readFileSync(MIGRATION, 'utf8') + readFileSync(ROLLBACK, 'utf8');
  ok([...raw].every((c) => c.charCodeAt(0) < 128) && !raw.includes('!'), 'both files are ASCII and carry no exclamation mark');

  console.log('3. the cases (database vs cases.json)');
  const dow = (iso) => Number(sql(`select extract(isodow from date ${lit(iso)})::int - 1`));
  for (const k of cases) {
    sql(`delete from public.wf_swap_requests where shift_id is distinct from ${lit(id('5a000000', 99))}; delete from public.wf_shifts where id <> ${lit(id('5a000000', 99))};
         delete from public.wf_time_off; delete from public.wf_availability; delete from public.wf_venue_settings; delete from public.wf_onboarding;`);
    const date = plus(k.shift.day);
    if (k.onboarding) sql(`insert into public.wf_onboarding (location_id, org_id, staff_id, meta, steps) values (${lit(A)}, ${lit(ORG)}, ${lit(S[k.claimer])}, ${lit(JSON.stringify(k.onboarding.meta))}, ${lit(JSON.stringify(k.onboarding.steps))})`);
    const shiftId = sql(`insert into public.wf_shifts (location_id, org_id, staff_id, role_key, shift_date, start_time, finish_time, status) values (${lit(A)}, ${lit(ORG)}, ${k.shift.owner ? lit(S[k.shift.owner]) : 'null'}, 'bar', ${lit(date)}, ${lit(k.shift.start)}, ${lit(k.shift.finish)}, ${lit(k.shift.status || 'published')}) returning id`);
    let reqId = null;
    if (k.request) {
      reqId = sql(`insert into public.wf_swap_requests (location_id, org_id, shift_id, from_staff_id, to_staff_id, kind, status) values (${lit(A)}, ${lit(ORG)}, ${lit(shiftId)}, ${k.request.from ? lit(S[k.request.from]) : 'null'}, ${k.request.to ? lit(S[k.request.to]) : 'null'}, ${lit(k.request.kind)}, ${lit(k.request.status)}) returning id`);
    }
    for (const o of k.others || []) {
      sql(`insert into public.wf_shifts (location_id, org_id, staff_id, role_key, shift_date, start_time, finish_time, status) values (${lit(A)}, ${lit(ORG)}, ${lit(S[k.claimer])}, 'bar', ${lit(plus(o.day))}, ${lit(o.start)}, ${lit(o.finish)}, ${lit(o.status || 'published')})`);
    }
    for (const l of k.leave || []) {
      sql(`insert into public.wf_time_off (location_id, org_id, staff_id, start_date, end_date, status) values (${lit(A)}, ${lit(ORG)}, ${lit(S[k.claimer])}, ${lit(plus(l.fromDay))}, ${lit(plus(l.toDay))}, ${lit(l.status)})`);
    }
    if (k.unavailable) sql(`insert into public.wf_availability (location_id, org_id, staff_id, per_day) values (${lit(A)}, ${lit(ORG)}, ${lit(S[k.claimer])}, ${lit(JSON.stringify([{ day: dow(date), state: 'unavailable' }]))})`);
    if (k.cap) sql(`insert into public.wf_venue_settings values (${lit(A)}, ${lit(ORG)}, ${lit(JSON.stringify({ shiftSwaps: { maxWeeklyHours: k.cap } }))})`);
    const got = svc(`select coalesce(public._wf_claim_problem(${lit(shiftId)}, ${lit(S[k.claimer])}, ${reqId ? lit(reqId) : 'null'}, false), 'null')`);
    ok(got === String(k.expect), `case "${k.name}": ${got}`);
    if (k.expect === null) {
      const r = json(`select public.wf_shift_claim(${lit(S[k.claimer])}, ${lit(shiftId)})`);
      ok(r?.ok === true && r.outcome === 'pending', `  claiming it (manager mode, the default) waits for a manager`);
    } else {
      const r = json(`select public.wf_shift_claim(${lit(S[k.claimer])}, ${lit(shiftId)})`);
      ok(r?.ok === false && r.code === k.expect, `  claiming it is refused with the same code`);
    }
  }

  console.log('4. the fence');
  sql(`delete from public.wf_swap_requests where shift_id is distinct from ${lit(id('5a000000', 99))}; delete from public.wf_shifts where id <> ${lit(id('5a000000', 99))}; delete from public.wf_venue_settings;
       insert into public.wf_shifts (id, location_id, org_id, staff_id, role_key, shift_date, start_time, finish_time, status) values
         (${lit(id('5b000000', 1))}, ${lit(B)}, ${lit(ORG)}, ${lit(S.X)}, 'bar', date ${lit(TODAY)} + 3, '10:00', '14:00', 'published');
       insert into public.wf_swap_requests (location_id, org_id, shift_id, from_staff_id, kind, status) values (${lit(B)}, ${lit(ORG)}, ${lit(id('5b000000', 1))}, ${lit(S.X)}, 'drop', 'open');`);
  const boRead = as('authenticated', `select count(*) from public.wf_swap_requests`, { sub: U.a });
  ok(boRead.out === '1', `a Back Office login of Leeds reads Leeds requests only (${boRead.out})`);
  const boIns = as('authenticated', `insert into public.wf_swap_requests (location_id, org_id, from_staff_id, status) values (${lit(A)}, ${lit(ORG)}, ${lit(S.C)}, 'open')`, { sub: U.a });
  ok(boIns.sqlstate === '42501', `it cannot insert one (${boIns.sqlstate})`);
  const boUpd = as('authenticated', `update public.wf_swap_requests set status = 'approved'`, { sub: U.a });
  ok(boUpd.sqlstate === '42501', `it cannot update one (${boUpd.sqlstate})`);
  const boDel = as('authenticated', `delete from public.wf_swap_requests`, { sub: U.a });
  ok(boDel.sqlstate === '42501', `it cannot delete one (${boDel.sqlstate})`);
  const anonRead = as('anon', `select count(*) from public.wf_swap_requests`);
  ok(anonRead.sqlstate === '42501', `anon cannot read them (${anonRead.sqlstate})`);
  for (const [who, role, sub] of [['a Back Office login', 'authenticated', U.a], ['anon', 'anon', null]]) {
    for (const call of [`public.wf_shift_claim(${lit(S.C)}, ${lit(id('5b000000', 1))})`, `public.wf_swap_decide(${lit(A)}, ${lit(id('5b000000', 1))}, 'approved', '{}')`,
      `public.wf_shift_drop(${lit(S.X)}, ${lit(id('5b000000', 1))}, null, null)`, `public._wf_claim_problem(${lit(id('5b000000', 1))}, ${lit(S.C)}, null, false)`]) {
      const r = as(role, `select ${call}`, { sub });
      ok(r.sqlstate === '42501', `${who} cannot run ${call.split('(')[0]} (${r.sqlstate})`);
    }
  }
  const openA = as('authenticated', `insert into public.wf_shifts (location_id, org_id, staff_id, role_key, shift_date, start_time, finish_time, status) values (${lit(A)}, ${lit(ORG)}, null, 'bar', date ${lit(TODAY)} + 2, '17:00', '22:00', 'published') returning 1`, { sub: U.a });
  ok(openA.status === 0 && openA.out === '1', 'a Back Office login puts an open shift on its own venue\'s rota');
  const openB = as('authenticated', `insert into public.wf_shifts (location_id, org_id, staff_id, role_key, shift_date, start_time, finish_time, status) values (${lit(B)}, ${lit(ORG)}, null, 'bar', date ${lit(TODAY)} + 2, '17:00', '22:00', 'published')`, { sub: U.a });
  ok(openB.sqlstate === '42501', `and not on another venue's (${openB.sqlstate})`);
  const pol = sql(`select string_agg(policyname, ',' order by policyname) from pg_policies where tablename = 'wf_swap_requests'`);
  ok(pol === 'second_step_fence,wf_swap_requests_rls_select,wf_swap_requests_super_admin_all', `policies left: ${pol}`);
  const polFns = sql(`select count(*) from pg_policies p where p.tablename = 'wf_swap_requests' and (coalesce(p.qual, '') || coalesce(p.with_check, '')) ~ '(user_accessible_locations|is_super_admin|second_step_ok)'`);
  ok(polFns === '3' && sql(`select bool_and(has_function_privilege('authenticated', f, 'execute')) from unnest(array['public.user_accessible_locations()', 'public.is_super_admin()', 'public.second_step_ok()']) f`) === 't',
    'every policy left calls only functions authenticated can execute');

  console.log('5. the race');
  const openShift = (start = '17:00', finish = '22:00', day = 2) => sql(`insert into public.wf_shifts (location_id, org_id, staff_id, role_key, shift_date, start_time, finish_time, status, computed_hours) values (${lit(A)}, ${lit(ORG)}, null, 'bar', date ${lit(TODAY)} + ${day}, ${lit(start)}, ${lit(finish)}, 'published', null) returning id`);
  const setMode = (m) => sql(`insert into public.wf_venue_settings values (${lit(A)}, ${lit(ORG)}, ${lit(JSON.stringify({ shiftSwaps: { approval: m } }))}) on conflict (location_id) do update set settings = excluded.settings`);
  setMode('instant');
  {
    const sh = openShift();
    const p1 = concurrent('service_role', `select public.wf_shift_claim(${lit(S.C)}, ${lit(sh)}); select pg_sleep(1.2)`);
    await sleep(300);
    const p2 = concurrent('service_role', `select public.wf_shift_claim(${lit(S.Q)}, ${lit(sh)})`);
    const [r1, r2] = await Promise.all([p1, p2]);
    const a1 = JSON.parse(r1.out.split('\n')[0]), a2 = JSON.parse(r2.out.split('\n')[0]);
    ok(a1.outcome === 'assigned' && a2.ok === false && a2.code === 'not_offered', `straight away: two at once, the first wins, the second is told it is gone (${a2.code})`);
    ok(sql(`select staff_id from public.wf_shifts where id = ${lit(sh)}`) === S.C, 'the shift is the first claimer\'s');
  }
  {
    const sh = openShift('09:00', '13:00', 4);
    const people = [S.C, S.Q, S.P, ...EXTRA];
    const res = await Promise.all(people.map((p) => concurrent('service_role', `select public.wf_shift_claim(${lit(p)}, ${lit(sh)})`)));
    const outs = res.map((r) => JSON.parse(r.out));
    ok(outs.filter((o) => o.outcome === 'assigned').length === 1 && outs.filter((o) => o.ok === false).length === people.length - 1, `straight away: ${people.length} at once, exactly one winner`);
    ok(sql(`select count(*) from public.wf_swap_requests where shift_id = ${lit(sh)}`) === '1', 'and exactly one request row for it');
  }
  setMode('manager');
  {
    const sh = openShift('10:00', '16:00', 5);
    const people = [S.C, S.Q, S.P, ...EXTRA];
    const res = await Promise.all(people.map((p) => concurrent('service_role', `select public.wf_shift_claim(${lit(p)}, ${lit(sh)})`)));
    const outs = res.map((r) => JSON.parse(r.out));
    ok(outs.filter((o) => o.outcome === 'pending').length === 1 && outs.filter((o) => o.code === 'taken').length === people.length - 1, `manager mode: ${people.length} at once, one waiting request, the rest told someone asked first`);
    ok(sql(`select count(*) from public.wf_swap_requests where shift_id = ${lit(sh)} and status = 'pending'`) === '1' && sql(`select staff_id is null from public.wf_shifts where id = ${lit(sh)}`) === 't', 'the shift stays open until a manager decides');
  }
  setMode('instant');
  {
    const s1 = openShift('12:00', '18:00', 6), s2 = openShift('15:00', '20:00', 6);
    const p1 = concurrent('service_role', `select public.wf_shift_claim(${lit(S.D === S.C ? S.Q : S.C)}, ${lit(s1)}); select pg_sleep(1.2)`);
    await sleep(300);
    const p2 = concurrent('service_role', `select public.wf_shift_claim(${lit(S.C)}, ${lit(s2)})`);
    const [r1, r2] = await Promise.all([p1, p2]);
    const a1 = JSON.parse(r1.out.split('\n')[0]), a2 = JSON.parse(r2.out.split('\n')[0]);
    ok(a1.outcome === 'assigned' && a2.code === 'overlap', `one person, two overlapping shifts at once: the second is refused for the overlap (${a2.code})`);
  }

  console.log('6. the flows');
  sql(`delete from public.wf_swap_requests where shift_id is distinct from ${lit(id('5a000000', 99))}; delete from public.wf_shifts where id <> ${lit(id('5a000000', 99))};`);
  setMode('manager');
  const owned = (who, day = 2) => sql(`insert into public.wf_shifts (location_id, org_id, staff_id, role_key, shift_date, start_time, finish_time, break_mins, status, effective_rate, rate_source, computed_hours, computed_cost) values (${lit(A)}, ${lit(ORG)}, ${lit(who)}, 'bar', date ${lit(TODAY)} + ${day}, '17:00', '22:00', 30, 'published', 12, 'base', 4.5, 54) returning id`);
  {
    const sh = owned(S.P);
    const notMine = json(`select public.wf_shift_drop(${lit(S.C)}, ${lit(sh)}, null, null)`);
    ok(notMine.code === 'not_yours', 'only the owner can put a shift up');
    const badCo = json(`select public.wf_shift_drop(${lit(S.P)}, ${lit(sh)}, ${lit(S.D)}, null)`);
    ok(badCo.code === 'colleague', 'it cannot be offered to someone in another position');
    const drop = json(`select public.wf_shift_drop(${lit(S.P)}, ${lit(sh)}, null, 'Dentist')`);
    ok(drop.ok && drop.kind === 'drop', 'Pat drops it to everyone');
    const twice = json(`select public.wf_shift_drop(${lit(S.P)}, ${lit(sh)}, null, null)`);
    ok(twice.code === 'already_up', 'and cannot drop it twice');
    const claim = json(`select public.wf_shift_claim(${lit(S.Q)}, ${lit(sh)})`);
    ok(claim.outcome === 'pending' && claim.request_id === drop.request_id, 'Quinn claims it; it waits for a manager on the same request');
    const wrongVenue = json(`select public.wf_swap_decide(${lit(B)}, ${lit(drop.request_id)}, 'approved', '{"id":"m1","name":"Mo"}')`);
    ok(wrongVenue.code === 'not_found', 'a manager at another venue cannot decide it');
    const dec = json(`select public.wf_swap_decide(${lit(A)}, ${lit(drop.request_id)}, 'approved', '{"id":"m1","name":"Mo Manager"}')`);
    ok(dec.outcome === 'assigned' && dec.from_staff_id === S.P && dec.to_staff_id === S.Q, 'the manager approves: Quinn has it, Pat is told');
    const row = sql(`select staff_id || '|' || effective_rate::numeric(10,2) || '|' || rate_source || '|' || computed_cost from public.wf_shifts where id = ${lit(sh)}`);
    ok(row === `${S.Q}|14.50|override|65.25`, `Quinn's own rate is snapshotted (${row})`);
    const rq = sql(`select status || '|' || decided_how || '|' || decided_by_name || '|' || (decided_at is not null) || '|' || (shift_snapshot ->> 'start') from public.wf_swap_requests where id = ${lit(drop.request_id)}`);
    ok(rq === 'approved|manager|Mo Manager|true|17:00', `the request records who decided, how and when (${rq})`);
    const again = json(`select public.wf_swap_decide(${lit(A)}, ${lit(drop.request_id)}, 'approved', '{}')`);
    ok(again.code === 'not_pending', 'it cannot be decided twice');
  }
  {
    const sh = owned(S.P, 3);
    const offer = json(`select public.wf_shift_drop(${lit(S.P)}, ${lit(sh)}, ${lit(S.Q)}, null)`);
    ok(offer.kind === 'offer', 'Pat offers a shift to Quinn');
    ok(json(`select public.wf_shift_claim(${lit(S.C)}, ${lit(sh)})`).code === 'offered_elsewhere', 'Cara cannot take it');
    ok(json(`select public.wf_swap_decline(${lit(S.C)}, ${lit(offer.request_id)})`).code === 'not_yours', 'Cara cannot decline it either');
    ok(json(`select public.wf_swap_decline(${lit(S.Q)}, ${lit(offer.request_id)})`).outcome === 'declined', 'Quinn declines');
    ok(sql(`select staff_id from public.wf_shifts where id = ${lit(sh)}`) === S.P, 'Pat still has it');
    const drop2 = json(`select public.wf_shift_drop(${lit(S.P)}, ${lit(sh)}, null, null)`);
    ok(drop2.ok, 'Pat can put it up again after a decline');
    ok(json(`select public.wf_shift_claim(${lit(S.C)}, ${lit(sh)})`).outcome === 'pending', 'Cara claims it');
    ok(json(`select public.wf_swap_cancel(${lit(S.C)}, ${lit(drop2.request_id)})`).outcome === 'reopened', 'Cara withdraws: it goes back to waiting');
    ok(sql(`select status || '|' || coalesce(to_staff_id::text, '-') from public.wf_swap_requests where id = ${lit(drop2.request_id)}`) === 'open|-', 'open again with nobody on it');
    ok(json(`select public.wf_shift_claim(${lit(S.C)}, ${lit(sh)})`).outcome === 'pending', 'Cara claims it again');
    ok(json(`select public.wf_swap_decide(${lit(A)}, ${lit(drop2.request_id)}, 'declined', '{"name":"Mo"}')`).outcome === 'reopened', 'the manager declines Cara on a dropped shift: it goes back up');
    ok(sql(`select staff_id from public.wf_shifts where id = ${lit(sh)}`) === S.P, 'Pat still has it after the decline');
    ok(sql(`select status || '|' || coalesce(to_staff_id::text, '-') from public.wf_swap_requests where id = ${lit(drop2.request_id)}`) === 'open|-', 'the request is open again with nobody on it');
    ok(json(`select public.wf_shift_claim(${lit(S.Q)}, ${lit(sh)})`).outcome === 'pending', 'Quinn can claim it now');
    ok(json(`select public.wf_swap_cancel(${lit(S.P)}, ${lit(drop2.request_id)})`).outcome === 'cancelled', 'Pat takes it back');
    // A direct swap (an offer) declined by a manager closes.
    const offer2 = json(`select public.wf_shift_drop(${lit(S.P)}, ${lit(sh)}, ${lit(S.Q)}, null)`);
    ok(json(`select public.wf_shift_claim(${lit(S.Q)}, ${lit(sh)})`).outcome === 'pending', 'Quinn accepts an offer');
    ok(json(`select public.wf_swap_decide(${lit(A)}, ${lit(offer2.request_id)}, 'declined', '{"name":"Mo"}')`).outcome === 'declined'
      && sql(`select status from public.wf_swap_requests where id = ${lit(offer2.request_id)}`) === 'declined', 'a manager declining a direct swap closes it');
  }
  {
    const sh = openShift('11:00', '15:00', 3);
    const c = json(`select public.wf_shift_claim(${lit(S.C)}, ${lit(sh)})`);
    sql(`delete from public.wf_shifts where id = ${lit(sh)}`);
    const d = json(`select public.wf_swap_decide(${lit(A)}, ${lit(c.request_id)}, 'approved', '{}')`);
    ok(d.code === 'shift_gone' && sql(`select status from public.wf_swap_requests where id = ${lit(c.request_id)}`) === 'cancelled', 'a request on a deleted shift closes when a manager opens it');
  }
  {
    // Approving re-checks every rule: Cara claims, then a manager puts her on an overlapping shift, then approves.
    const sh = openShift('17:00', '22:00', 7);
    const c = json(`select public.wf_shift_claim(${lit(S.C)}, ${lit(sh)})`);
    sql(`insert into public.wf_shifts (location_id, org_id, staff_id, role_key, shift_date, start_time, finish_time, status) values (${lit(A)}, ${lit(ORG)}, ${lit(S.C)}, 'bar', date ${lit(TODAY)} + 7, '20:00', '23:00', 'published')`);
    const d = json(`select public.wf_swap_decide(${lit(A)}, ${lit(c.request_id)}, 'approved', '{}')`);
    ok(d.code === 'overlap' && sql(`select staff_id is null from public.wf_shifts where id = ${lit(sh)}`) === 't', 'approving checks again: an overlap since the claim is refused, nothing changes');
  }

  console.log('7. the rollback');
  const rb1 = psql({ args: ['-1', '-f', ROLLBACK], allowFail: true });
  ok(rb1.status !== 0 && /open shift/.test(rb1.stderr), 'the rollback refuses while open shifts exist');
  sql(`delete from public.wf_shifts where staff_id is null; delete from public.wf_swap_requests where from_staff_id is null;`);
  const rb2 = psql({ args: ['-1', '-f', ROLLBACK] });
  const rbCheck = rb2.stdout.trim().split('\n').pop();
  ok(rbCheck === 't|t|0|0|0|3|t', `rollback check row (${rbCheck})`);
  ok(sql(`select count(*) from public.wf_swap_requests where id is not null`) !== '0', 'the request rows themselves are kept');
  const boIns2 = as('authenticated', `insert into public.wf_swap_requests (location_id, org_id, from_staff_id, status) values (${lit(A)}, ${lit(ORG)}, ${lit(S.C)}, 'open') returning 1`, { sub: U.a });
  ok(boIns2.status === 0, 'after the rollback a Back Office login can write requests again, as before');
  sql(`delete from public.wf_swap_requests where location_id = ${lit(A)} and shift_id is null`);
  const reapply = psql({ args: ['-1', '-f', MIGRATION], allowFail: true });
  ok(reapply.status === 0, 'the migration applies again after the rollback');
} finally {
  stop();
}
console.log(`\n${passes} checks passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
