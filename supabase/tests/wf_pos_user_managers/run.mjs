#!/usr/bin/env node
// run.mjs: proves 20261206a (a manager of the person's own site may make the FIRST till link) on a
// local, throwaway PostgreSQL, before Peter runs it on the Ops database. It never connects to Supabase.
//
//   node supabase/tests/wf_pos_user_managers/run.mjs
//
// It builds the same live shape the identity fence harness uses (../wf_staff_identity_fence/schema.sql),
// applies 20261104a (the fence and the owner only door), then 20261206a, and checks:
//   1. before: a manager is refused by the door;
//   2. the migration applies, its check row reads as documented, and a second run changes nothing;
//   3. a manager of the person's own site gives someone with no till user their first link, and it
//      is audited with the manager's name;
//   4. a manager cannot change or remove a link that exists, cannot link a till user of another
//      site or of no site, cannot act at a site they do not manage, cannot link a till user that is
//      somebody else's, cannot link a leaver, and gets the other company refusal as an owner would;
//   5. a staff login and an anonymous session are still refused; an owner and the super admin still
//      link, relink and unlink;
//   6. the two holes a review found in the first draft are closed: a manager cannot move a record to
//      their own site to link it (the site move guard), and cannot free a till user by marking its
//      holder a leaver; the guard lets through an owner, a manager of both sites, a save that sends
//      the same site, the service role and the database;
//   7. the ROLLBACK puts the owner only door back and removes the guard, and the migration applies
//      again after it.
// Exit code 0 only when every check holds.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..');
const SCHEMA = join(here, '..', 'wf_staff_identity_fence', 'schema.sql');
const FENCE = join(repo, 'supabase/migrations/20261104a_OPS_wf_staff_identity_fence.sql');
const MIGRATION = join(repo, 'supabase/migrations/20261206a_OPS_wf_pos_user_managers.sql');
const ROLLBACK = join(repo, 'supabase/migrations/20261206a_OPS_wf_pos_user_managers_ROLLBACK.sql');

const bin = (name) => (existsSync(`/opt/homebrew/bin/${name}`) ? `/opt/homebrew/bin/${name}` : name);
const env = { ...process.env, LC_ALL: 'en_US.UTF-8', PGOPTIONS: '-c client_min_messages=warning' };
let failures = 0, passes = 0;
const ok = (cond, msg) => { if (cond) { passes++; console.log(`  ok   ${msg}`); } else { failures++; console.log(`  FAIL ${msg}`); } };

const port = process.env.WFPM_PGPORT || String(55700 + Math.floor(Math.random() * 80));
const dir = mkdtempSync(join(tmpdir(), 'pgm.'));
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

const ORG = id('0a000000', 1), ORG2 = id('0a000000', 2);
const A = id('a0000000', 1), B = id('a0000000', 2), C = id('c0000000', 1);
const U = { owner: id('10000000', 1), mgr: id('10000000', 4), staff: id('10000000', 5), superAdmin: id('10000000', 6), other: id('10000000', 7), anon: id('10000000', 8),
  both: id('10000000', 9),      // a manager at A and at B
  halfBoth: id('10000000', 10), // a manager at A, only staff at B
};
const S = { cara: id('5a000000', 1), pat: id('5a000000', 2), lee: id('5a000000', 3), bo: id('5a000000', 5), dee: id('5a000000', 6) };
const T = { one: id('7e000000', 1), two: id('7e000000', 2), patsTill: id('7e000000', 3), other: id('7e000000', 4), orgOnly: id('7e000000', 5), atB: id('7e000000', 6) };

function as(role, body, { sub = null, anonymous = false } = {}) {
  const lines = ['\\set VERBOSITY verbose', 'begin;'];
  if (role !== 'postgres') {
    const claims = role === 'service_role' ? { role } : { role, sub, aud: 'authenticated', is_anonymous: anonymous };
    lines.push(`select set_config('request.jwt.claims', ${lit(JSON.stringify(claims))}, true) \\g /dev/null`);
    lines.push(`set local role ${role};`);
  }
  lines.push(body.trim().replace(/;?$/, ';'), 'commit;');
  const r = psql({ login: role === 'postgres' ? 'postgres' : 'authenticator', input: lines.join('\n') + '\n', allowFail: true });
  const m = /ERROR:\s+([0-9A-Z]{5}):\s*(.*)/.exec(r.stderr || '');
  return { status: r.status, sqlstate: m ? m[1] : null, message: m ? m[2] : (r.stderr || '').trim(), out: r.stdout.trim() };
}
const door = (sub, staff, till, opts = {}) => as(opts.role || 'authenticated', `select public.wf_staff_set_pos_user(${lit(staff)}, ${lit(till)}, 'harness')`, { sub, ...opts });
const posOf = (staff) => sql(`select coalesce(pos_user_id::text, '-') from public.wf_staff where id = ${lit(staff)}`);
const auditCount = () => Number(sql(`select count(*) from public.wf_audit where action = 'staff.identity_changed'`));
const lastAudit = () => JSON.parse(sql(`select row_to_json(a) from (select actor_id, actor_name, before, after from public.wf_audit where action = 'staff.identity_changed' order by at desc, id desc limit 1) a`) || 'null');
const refused = (r, state, words) => r.status !== 0 && r.sqlstate === state && words.test(r.message);

try {
  console.log('schema, seed and 20261104a');
  psql({ args: ['-1', '-f', SCHEMA] });
  sql(`insert into public.locations values (${lit(A)}, ${lit(ORG)}, 'Leeds'), (${lit(B)}, ${lit(ORG)}, 'Barnsley'), (${lit(C)}, ${lit(ORG2)}, 'Elsewhere');
       insert into public.user_profiles (id, org_id, location_id, full_name, email, role) values
         (${lit(U.owner)}, ${lit(ORG)}, ${lit(A)}, 'Olive Owner', 'olive@example.test', 'owner'),
         (${lit(U.mgr)}, ${lit(ORG)}, ${lit(A)}, 'Mo Manager', 'mo@example.test', 'manager'),
         (${lit(U.staff)}, ${lit(ORG)}, ${lit(A)}, 'Sam Staff', 'sam@example.test', 'staff'),
         (${lit(U.superAdmin)}, null, null, 'Peter', 'peter@example.test', 'super_admin'),
         (${lit(U.other)}, ${lit(ORG2)}, ${lit(C)}, 'Otto Other', 'otto@example.test', 'owner'),
         (${lit(U.both)}, ${lit(ORG)}, ${lit(A)}, 'Bea Both', 'bea@example.test', 'manager'),
         (${lit(U.halfBoth)}, ${lit(ORG)}, ${lit(A)}, 'Hal Half', 'hal@example.test', 'manager');
       insert into public.user_locations (user_id, location_id, role) values
         (${lit(U.owner)}, ${lit(A)}, 'owner'), (${lit(U.mgr)}, ${lit(A)}, 'manager'), (${lit(U.staff)}, ${lit(A)}, 'staff'), (${lit(U.other)}, ${lit(C)}, 'owner'),
         (${lit(U.both)}, ${lit(A)}, 'manager'), (${lit(U.both)}, ${lit(B)}, 'manager'), (${lit(U.halfBoth)}, ${lit(A)}, 'manager'), (${lit(U.halfBoth)}, ${lit(B)}, 'staff');
       insert into public.staff_members (id, location_id, org_id, name, pin) values
         (${lit(T.one)}, ${lit(A)}, ${lit(ORG)}, 'Till One', '1111'), (${lit(T.two)}, ${lit(A)}, ${lit(ORG)}, 'Till Two', '2222'),
         (${lit(T.patsTill)}, ${lit(A)}, ${lit(ORG)}, 'Pat P', '3333'), (${lit(T.other)}, ${lit(C)}, ${lit(ORG2)}, 'Till Other', '4444'),
         (${lit(T.orgOnly)}, null, ${lit(ORG)}, 'Till Org Only', '5555'), (${lit(T.atB)}, ${lit(B)}, ${lit(ORG)}, 'Till At B', '6666');
       insert into public.wf_staff (id, org_id, location_id, name, status, pos_user_id, portal_user_id) values
         (${lit(S.cara)}, ${lit(ORG)}, ${lit(A)}, 'Cara C', 'active', null, null),
         (${lit(S.dee)}, ${lit(ORG)}, ${lit(A)}, 'Dee D', 'active', null, null),
         (${lit(S.pat)}, ${lit(ORG)}, ${lit(A)}, 'Pat P', 'active', ${lit(T.patsTill)}, null),
         (${lit(S.lee)}, ${lit(ORG)}, ${lit(A)}, 'Lee L', 'leaver', null, null),
         (${lit(S.bo)}, ${lit(ORG)}, ${lit(B)}, 'Bo B', 'active', null, null);`);
  psql({ args: ['-1', '-f', FENCE] });

  console.log('1. before 20261206a');
  {
    const r = door(U.mgr, S.cara, T.one);
    ok(refused(r, '42501', /Only an owner of this company can link/) && posOf(S.cara) === '-', 'a manager is refused by the owner only door');
  }

  console.log('2. the migration');
  {
    const mig = psql({ args: ['-1', '-f', MIGRATION] });
    ok(mig.stdout.trim().split('\n').pop() === 'wf_staff_set_pos_user|t|t|f|t', `check row as documented (${mig.stdout.trim().split('\n').pop()})`);
    const again = psql({ args: ['-1', '-f', MIGRATION] });
    ok(again.status === 0 && sql(`select count(*) from pg_proc where proname = 'wf_staff_set_pos_user'`) === '1', 'a second run is harmless: still one function');
    ok(sql(`select has_function_privilege('anon', 'public.wf_staff_set_pos_user(uuid,uuid,text)', 'EXECUTE')::text`) === 'false', 'an anonymous session still may not call it');
  }

  console.log('3. a manager makes the first link at their own site');
  {
    const before = auditCount();
    const r = door(U.mgr, S.cara, T.one);
    ok(r.status === 0 && posOf(S.cara) === T.one, 'Cara (no till user) is linked to a till user of the same site');
    const a = lastAudit();
    ok(auditCount() === before + 1 && a.actor_id === U.mgr && a.before.pos_user_id === null && a.after.pos_user_id === T.one, 'one audit row, with the manager as the actor');
  }

  console.log('4. what a manager still cannot do');
  {
    const n = auditCount();
    ok(refused(door(U.mgr, S.cara, T.two), '42501', /already have a till user/) && posOf(S.cara) === T.one, 'change a link that exists');
    ok(refused(door(U.mgr, S.cara, null), '42501', /already have a till user/) && posOf(S.cara) === T.one, 'remove a link that exists');
    ok(refused(door(U.mgr, S.pat, T.two), '42501', /already have a till user/) && posOf(S.pat) === T.patsTill, 'point a colleague who has a till user at another one');
    ok(refused(door(U.mgr, S.dee, null), '22023', /No till user given/), 'call it with no till user');
    ok(refused(door(U.mgr, S.dee, T.atB), '42501', /only link a till user of this site/) && posOf(S.dee) === '-', 'link a till user of another site');
    ok(refused(door(U.mgr, S.dee, T.orgOnly), '42501', /only link a till user of this site/) && posOf(S.dee) === '-', 'link a till user that belongs to no site');
    ok(refused(door(U.mgr, S.dee, T.other), '22023', /another company/) && posOf(S.dee) === '-', 'link a till user of another company');
    ok(refused(door(U.mgr, S.dee, T.patsTill), '23505', /already linked to another staff record/) && posOf(S.dee) === '-', 'link a till user that is already somebody else\'s');
    ok(refused(door(U.mgr, S.bo, T.atB), '42501', /or a manager of this site/) && posOf(S.bo) === '-', 'act at a site they do not manage');
    ok(refused(door(U.mgr, S.lee, T.two), '22023', /leaver/), 'link a leaver');
    ok(auditCount() === n, 'none of the refusals wrote an audit row');
  }

  console.log('5. everyone else is as before');
  {
    ok(refused(door(U.staff, S.dee, T.two), '42501', /or a manager of this site/) && posOf(S.dee) === '-', 'a staff login is refused');
    const an = door(U.anon, S.dee, T.two, { role: 'anon', anonymous: true });
    ok(an.status !== 0 && an.sqlstate === '42501' && posOf(S.dee) === '-', 'an anonymous session is refused');
    ok(refused(door(U.other, S.dee, T.two), '42501', /or a manager of this site/), 'another company\'s owner is refused');
    ok(door(U.owner, S.cara, T.two).status === 0 && posOf(S.cara) === T.two, 'an owner changes a link');
    ok(door(U.owner, S.cara, null).status === 0 && posOf(S.cara) === '-', 'an owner removes a link');
    ok(door(U.superAdmin, S.bo, T.atB).status === 0 && posOf(S.bo) === T.atB, 'the super admin links at any site');
    ok(door(U.mgr, S.cara, T.one).status === 0 && posOf(S.cara) === T.one, 'after an owner removed it, a manager can make the first link again');
  }

  console.log('6. the two holes the review found');
  {
    const locOf = (staff) => sql(`select location_id::text from public.wf_staff where id = ${lit(staff)}`);
    const move = (sub, staff, to, role = 'authenticated') => as(role, `update public.wf_staff set location_id = ${lit(to)} where id = ${lit(staff)}`, { sub });
    sql(`update public.wf_staff set pos_user_id = null where id = ${lit(S.bo)}`);   // Bo at B, no till user
    // Hole 1: move Bo to my site, link, move back.
    const m1 = move(U.mgr, S.bo, A);
    ok(refused(m1, '42501', /manager of both sites/) && locOf(S.bo) === B, 'a manager of A cannot move a site B record to A');
    ok(refused(door(U.mgr, S.bo, T.two), '42501', /or a manager of this site/) && posOf(S.bo) === '-', 'so Bo at B cannot be linked by a manager of A');
    ok(refused(move(U.halfBoth, S.bo, A), '42501', /manager of both sites/) && locOf(S.bo) === B, 'manager at A but only staff at B: still refused');
    ok(refused(move(U.staff, S.dee, B), '42501', /manager of both sites/) && locOf(S.dee) === A, 'a staff login cannot move a record');
    const same = as('authenticated', `update public.wf_staff set name = 'Dee D', location_id = ${lit(A)} where id = ${lit(S.dee)}`, { sub: U.mgr });
    ok(same.status === 0, 'a save that sends the SAME site is not a move and is never refused (the staff form does this)');
    const other = as('authenticated', `update public.wf_staff set name = 'Dee D' where id = ${lit(S.dee)}`, { sub: U.mgr });
    ok(other.status === 0, 'a save that does not touch the site is untouched by the guard');
    ok(move(U.both, S.bo, A).status === 0 && locOf(S.bo) === A, 'a manager of BOTH sites may move a record');
    ok(move(U.both, S.bo, B).status === 0 && locOf(S.bo) === B, 'and move it back');
    ok(move(U.owner, S.bo, A).status === 0 && move(U.owner, S.bo, B).status === 0, 'an owner of the company may move a record');
    ok(move(U.superAdmin, S.bo, A).status === 0 && move(U.superAdmin, S.bo, B).status === 0, 'the super admin may move a record');
    ok(refused(move(U.other, S.bo, C), '42501', /./) || locOf(S.bo) === B, 'another company\'s owner cannot take a record');
    const svc = as('service_role', `update public.wf_staff set location_id = ${lit(A)} where id = ${lit(S.bo)}`);
    ok(svc.status === 0 && locOf(S.bo) === A, 'the service role (the edge functions) may move a record');
    sql(`update public.wf_staff set location_id = ${lit(B)} where id = ${lit(S.bo)}`);
    ok(locOf(S.bo) === B, 'the database itself may move a record');
    // Hole 2: mark the holder a leaver, link their till user to someone else, mark them active again.
    ok(posOf(S.pat) === T.patsTill, 'Pat holds a till user');
    ok(as('authenticated', `update public.wf_staff set status = 'leaver' where id = ${lit(S.pat)}`, { sub: U.mgr }).status === 0, 'a manager can mark Pat a leaver (status is theirs to write)');
    sql(`update public.wf_staff set pos_user_id = null where id = ${lit(S.dee)}`);
    ok(refused(door(U.mgr, S.dee, T.patsTill), '23505', /already linked to another staff record/) && posOf(S.dee) === '-', 'but still cannot link Pat\'s till user to Dee');
    sql(`update public.wf_staff set status = 'active' where id = ${lit(S.pat)}`);
    ok(sql(`select count(*) from public.wf_staff where pos_user_id = ${lit(T.patsTill)}`) === '1', 'one record holds that till user, as before');
    // An owner keeps the old rule (a leaver's till user can be given to someone else).
    sql(`update public.wf_staff set status = 'leaver' where id = ${lit(S.pat)}`);
    ok(door(U.owner, S.dee, T.patsTill).status === 0 && posOf(S.dee) === T.patsTill, 'an owner may still hand a leaver\'s till user to someone else, as before');
    sql(`update public.wf_staff set pos_user_id = null where id = ${lit(S.dee)}; update public.wf_staff set status = 'active' where id = ${lit(S.pat)};`);
  }

  console.log('7. rollback');
  {
    const rb = psql({ args: ['-1', '-f', ROLLBACK] });
    ok(rb.stdout.trim().split('\n').pop() === 'wf_staff_set_pos_user|f|f', `rollback check row (${rb.stdout.trim().split('\n').pop()})`);
    ok(as('authenticated', `update public.wf_staff set location_id = ${lit(A)} where id = ${lit(S.bo)}`, { sub: U.mgr }).status === 0, 'the site move guard is gone with it (as before 20261206a)');
    sql(`update public.wf_staff set location_id = ${lit(B)} where id = ${lit(S.bo)}`);
    ok(refused(door(U.mgr, S.dee, T.two), '42501', /Only an owner of this company can link/) && posOf(S.dee) === '-', 'a manager is refused again');
    ok(posOf(S.cara) === T.one, 'the link the manager made stays');
    ok(door(U.owner, S.dee, T.two).status === 0 && posOf(S.dee) === T.two, 'an owner still links');
    const mig = psql({ args: ['-1', '-f', MIGRATION] });
    ok(mig.stdout.trim().split('\n').pop() === 'wf_staff_set_pos_user|t|t|f|t', 'the migration applies again after the rollback');
  }
} finally {
  stop();
}
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
