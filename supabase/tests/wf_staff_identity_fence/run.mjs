#!/usr/bin/env node
// run.mjs: proves 20261104a (the wf_staff identity fence) on a local, throwaway PostgreSQL 17, before
// Peter runs it on the Ops database. It never connects to Supabase.
//
//   node supabase/tests/wf_staff_identity_fence/run.mjs
//
// It starts its own cluster in a temp folder (initdb and pg_ctl from PATH or /opt/homebrew/bin),
// builds the live shape (schema.sql) and stops it at the end. Calls are made the way the API makes
// them: logged in as authenticator, SET ROLE anon, authenticated or service_role, the claims set.
// What it proves, in order:
//   1. BEFORE: a manager's Back Office login moves a colleague's pos_user_id (the gap); the 20260806j
//      trigger already refuses portal_user_id;
//   2. the migration applies in one transaction and its check row reads as documented; a second run
//      is refused and changes nothing; no staff row changed;
//   3. the column fence, by role (staff, manager, super admin, anonymous): every PATCH or POST that
//      names an identity column is refused with 42501, every other Workforce write still works
//      (details, bank, rate, sections, the saveStaff upsert shape, archive as a leaver);
//   4. the door, wf_staff_set_pos_user: a company owner (profile owner, or a venue link with role
//      owner or admin) and the super admin may link, unlink and relink; a manager, a staff login, an
//      anonymous session, another company's owner, a login short of its second step may not; a
//      leaver, a till user of another company, a till user already linked and unknown ids are refused;
//      every change writes one wf_audit row with who, what and why, and no change writes none;
//   5. the trusted paths: the service role (staff-portal accept_invite, workforce-clock's auto
//      created record) and the database itself still write the columns, and each change is audited;
//      the invite columns are not audited; the chat sync trigger still fires;
//   6. the audit rows cannot be edited from the API; the helper functions are not callable from it;
//   7. a column added later is not writable until wf_staff_regrant_api() runs, then it is, and the
//      identity columns stay closed; the guard costs under a millisecond a row;
//   8. the ROLLBACK puts everything back (table grants, the 20260806j trigger), keeps the audit rows,
//      refuses a second run, and the migration applies again after it.
// Exit code 0 only when every check holds.

import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..');
const MIGRATION = process.env.WFIF_MIGRATION || join(repo, 'supabase/migrations/20261104a_OPS_wf_staff_identity_fence.sql');
const ROLLBACK = process.env.WFIF_ROLLBACK || join(repo, 'supabase/migrations/20261104a_OPS_wf_staff_identity_fence_ROLLBACK.sql');

const bin = (name) => (existsSync(`/opt/homebrew/bin/${name}`) ? `/opt/homebrew/bin/${name}` : name);
const env = { ...process.env, LC_ALL: 'en_US.UTF-8', PGOPTIONS: '-c client_min_messages=warning' };
let failures = 0, passes = 0;
const ok = (cond, msg) => { if (cond) { passes++; console.log(`  ok   ${msg}`); } else { failures++; console.log(`  FAIL ${msg}`); } };

const port = process.env.WFIF_PGPORT || String(55600 + Math.floor(Math.random() * 80));
const dir = mkdtempSync(join(tmpdir(), 'pgi.'));
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
// Logins.
const U = {
  owner: id('10000000', 1),   // user_profiles owner of ORG (the usual owner: signed up, handle_new_user gives owner)
  linkOwner: id('10000000', 2), // profile role manager, but a venue link at A with role owner
  admin: id('10000000', 3),   // a venue link at B with role admin
  mgr: id('10000000', 4),     // a manager at A (create-user gives profile role manager, link role manager)
  staff: id('10000000', 5),   // a venue link at A with role staff
  superAdmin: id('10000000', 6),
  other: id('10000000', 7),   // owner of ORG2
  anon: id('10000000', 8),    // an anonymous session (a kiosk or till)
};
// Staff records.
const S = { cara: id('5a000000', 1), pat: id('5a000000', 2), lee: id('5a000000', 3), xan: id('5a000000', 4), bo: id('5a000000', 5) };
// Till users.
const T = { one: id('7e000000', 1), two: id('7e000000', 2), patsTill: id('7e000000', 3), other: id('7e000000', 4), orgOnly: id('7e000000', 5) };

// The way the API calls: authenticator, SET ROLE, the request claims.
function as(role, body, { sub = null, anonymous = false, allowFail = true } = {}) {
  const lines = ['\\set VERBOSITY verbose', 'begin;'];
  if (role !== 'postgres') {
    const claims = role === 'service_role' ? { role } : { role, sub, aud: 'authenticated', is_anonymous: anonymous };
    lines.push(`select set_config('request.jwt.claims', ${lit(JSON.stringify(claims))}, true) \\g /dev/null`);
    lines.push(`set local role ${role};`);
  }
  lines.push(body.trim().replace(/;?$/, ';'), 'commit;');
  const r = psql({ login: role === 'postgres' ? 'postgres' : 'authenticator', input: lines.join('\n') + '\n', allowFail });
  const m = /ERROR:\s+([0-9A-Z]{5}):\s*(.*)/.exec(r.stderr || '');
  return { status: r.status, sqlstate: m ? m[1] : null, message: m ? m[2] : (r.stderr || '').trim(), out: r.stdout.trim() };
}
const bo = (sub, body, opts = {}) => as('authenticated', body, { sub, ...opts });
const door = (sub, staff, till, reason = null, opts = {}) => {
  const r = bo(sub, `${opts.pre || ''}select public.wf_staff_set_pos_user(${lit(staff)}, ${lit(till)}, ${lit(reason)})`, opts);
  let json = null;
  try { json = JSON.parse(r.out.split('\n').pop() || 'null'); } catch { json = null; }
  return { ...r, json };
};
const posOf = (staff) => sql(`select coalesce(pos_user_id::text, '-') from public.wf_staff where id = ${lit(staff)}`);
const portalOf = (staff) => sql(`select coalesce(portal_user_id::text, '-') from public.wf_staff where id = ${lit(staff)}`);
const auditCount = () => Number(sql(`select count(*) from public.wf_audit where action = 'staff.identity_changed'`));
const lastAudit = () => JSON.parse(sql(`select row_to_json(a) from (select actor_id, actor_name, action, entity, entity_id, reason, before, after, location_id, org_id from public.wf_audit where action = 'staff.identity_changed' order by at desc, id desc limit 1) a`) || 'null');

try {
  console.log('schema');
  psql({ args: ['-1', '-f', join(here, 'schema.sql')] });
  sql(`insert into public.locations values (${lit(A)}, ${lit(ORG)}, 'Leeds'), (${lit(B)}, ${lit(ORG)}, 'Barnsley'), (${lit(C)}, ${lit(ORG2)}, 'Elsewhere');
       insert into public.user_profiles (id, org_id, location_id, full_name, email, role) values
         (${lit(U.owner)}, ${lit(ORG)}, ${lit(A)}, 'Olive Owner', 'olive@example.test', 'owner'),
         (${lit(U.linkOwner)}, ${lit(ORG)}, ${lit(A)}, null, 'link@example.test', 'manager'),
         (${lit(U.admin)}, ${lit(ORG)}, ${lit(B)}, 'Ada Admin', 'ada@example.test', 'manager'),
         (${lit(U.mgr)}, ${lit(ORG)}, ${lit(A)}, 'Mo Manager', 'mo@example.test', 'manager'),
         (${lit(U.staff)}, ${lit(ORG)}, ${lit(A)}, 'Sam Staff', 'sam@example.test', 'staff'),
         (${lit(U.superAdmin)}, null, null, 'Peter', 'peter@example.test', 'super_admin'),
         (${lit(U.other)}, ${lit(ORG2)}, ${lit(C)}, 'Otto Other', 'otto@example.test', 'owner');
       insert into public.user_locations (user_id, location_id, role) values
         (${lit(U.owner)}, ${lit(A)}, 'owner'), (${lit(U.linkOwner)}, ${lit(A)}, 'owner'), (${lit(U.admin)}, ${lit(B)}, 'admin'),
         (${lit(U.mgr)}, ${lit(A)}, 'manager'), (${lit(U.staff)}, ${lit(A)}, 'staff'), (${lit(U.other)}, ${lit(C)}, 'owner');
       insert into public.staff_members (id, location_id, org_id, name, pin) values
         (${lit(T.one)}, ${lit(A)}, ${lit(ORG)}, 'Till One', '1111'), (${lit(T.two)}, ${lit(A)}, ${lit(ORG)}, 'Till Two', '2222'),
         (${lit(T.patsTill)}, ${lit(A)}, ${lit(ORG)}, 'Pat P', '3333'), (${lit(T.other)}, ${lit(C)}, ${lit(ORG2)}, 'Till Other', '4444'),
         (${lit(T.orgOnly)}, null, ${lit(ORG)}, 'Till Org Only', '5555');
       insert into public.wf_staff (id, org_id, location_id, name, status, pos_user_id, portal_user_id) values
         (${lit(S.cara)}, ${lit(ORG)}, ${lit(A)}, 'Cara C', 'active', null, null),
         (${lit(S.pat)}, ${lit(ORG)}, ${lit(A)}, 'Pat P', 'active', ${lit(T.patsTill)}, ${lit(id('99000000', 2))}),
         (${lit(S.lee)}, ${lit(ORG)}, ${lit(A)}, 'Lee L', 'leaver', null, null),
         (${lit(S.xan)}, ${lit(ORG2)}, ${lit(C)}, 'Xan X', 'active', null, null),
         (${lit(S.bo)}, ${lit(ORG)}, ${lit(B)}, 'Bo B', 'active', null, null);`);

  console.log('1. before');
  {
    const r = bo(U.mgr, `update public.wf_staff set pos_user_id = ${lit(T.one)} where id = ${lit(S.cara)} returning 1`);
    ok(r.status === 0 && posOf(S.cara) === T.one, 'THE GAP: a manager moves a colleague pos_user_id with a plain PATCH');
    sql(`update public.wf_staff set pos_user_id = null where id = ${lit(S.cara)}`);
    const p = bo(U.mgr, `update public.wf_staff set portal_user_id = ${lit(U.mgr)} where id = ${lit(S.cara)}`);
    ok(p.sqlstate === 'P0001' && /staff-portal service/.test(p.message), 'portal_user_id is already refused by the 20260806j trigger');
  }
  const stamp = sql(`select max(updated_at)::text || '|' || count(*) from public.wf_staff`);

  console.log('2. the migration');
  {
    const mig = psql({ args: ['-1', '-f', MIGRATION] });
    const lines = mig.stdout.trim().split('\n');
    const check = lines.pop();
    ok(check === 'f|f|f|t|t|t|t|t|t|t|t|f|t|0', `check row as documented (${check})`);
    const granted = Number(lines.pop());
    const total = Number(sql(`select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'wf_staff'`));
    ok(granted === total - 4, `every column but the four is granted one by one (${granted} of ${total})`);
    const again = psql({ args: ['-1', '-f', MIGRATION], allowFail: true });
    ok(again.status !== 0 && /has run already/.test(again.stderr), 'a second run is refused');
    ok(sql(`select count(*) from pg_proc where proname = 'wf_staff_set_pos_user'`) === '1', 'a second run changed nothing');
    ok(sql(`select max(updated_at)::text || '|' || count(*) from public.wf_staff`) === stamp && auditCount() === 0, 'no staff row and no audit row changed');
    const raw = readFileSync(MIGRATION, 'utf8') + readFileSync(ROLLBACK, 'utf8');
    ok([...raw].every((c) => c.charCodeAt(0) < 128) && !raw.includes('!'), 'both files are ASCII and carry no exclamation mark');
    ok(sql(`select has_column_privilege('authenticated', 'public.wf_staff', 'ssn_last4', 'update')`) === 't', 'a column added by 20261031a (ssn_last4) is still writable');
  }

  console.log('3. the column fence, by role');
  for (const [who, sub, extra] of [['a manager', U.mgr, {}], ['a staff login', U.staff, {}], ['the super admin', U.superAdmin, {}], ['the owner, directly', U.owner, {}]]) {
    const u1 = bo(sub, `update public.wf_staff set pos_user_id = ${lit(T.one)} where id = ${lit(S.cara)}`, extra);
    ok(u1.sqlstate === '42501' && posOf(S.cara) === '-', `${who}: PATCH pos_user_id is refused (${u1.sqlstate})`);
    const u2 = bo(sub, `update public.wf_staff set portal_user_id = ${lit(sub)} where id = ${lit(S.cara)}`, extra);
    ok(u2.sqlstate === '42501' && portalOf(S.cara) === '-', `${who}: PATCH portal_user_id is refused`);
    const u3 = bo(sub, `update public.wf_staff set portal_invite_hash = 'x', portal_invite_expires = now() where id = ${lit(S.cara)}`, extra);
    ok(u3.sqlstate === '42501', `${who}: PATCH the invite columns is refused`);
    const i1 = bo(sub, `insert into public.wf_staff (org_id, location_id, name, pos_user_id) values (${lit(ORG)}, ${lit(A)}, 'Fake', ${lit(T.one)})`, extra);
    ok(i1.sqlstate === '42501', `${who}: POST a record with pos_user_id is refused`);
    const i2 = bo(sub, `insert into public.wf_staff (org_id, location_id, name, portal_user_id) values (${lit(ORG)}, ${lit(A)}, 'Fake', ${lit(sub)})`, extra);
    ok(i2.sqlstate === '42501', `${who}: POST a record with portal_user_id is refused`);
  }
  {
    const a = as('authenticated', `update public.wf_staff set pos_user_id = ${lit(T.one)} where id = ${lit(S.cara)}`, { sub: U.anon, anonymous: true });
    ok(a.sqlstate === '42501', `an anonymous session: PATCH pos_user_id is refused (${a.sqlstate})`);
    const n = as('anon', `update public.wf_staff set pos_user_id = ${lit(T.one)} where id = ${lit(S.cara)} returning 1`);
    ok(n.status === 0 && n.out === '' && posOf(S.cara) === '-', 'the anon role (no session) still reaches no row');
  }
  {
    // What Workforce writes today, as a manager: details, the saveStaff upsert, bank, rate, sections, archive.
    const d = bo(U.mgr, `update public.wf_staff set name = 'Cara Cole', mobile = '07700 900000', email = 'cara@example.test', rate_override = 14.5, section_ids = '{}', ni_number = 'QQ123456C', payroll_employee_id = 'E1', ssn_last4 = '1234' where id = ${lit(S.cara)} returning 1`);
    ok(d.status === 0 && d.out === '1', 'a manager still edits details, rate and the US payroll fields');
    const b = bo(U.mgr, `update public.wf_staff set bank_sort_code = '12-34-56', bank_account = '12345678', bank_account_masked = '****5678', bank_account_name = 'C Cole' where id = ${lit(S.cara)} returning 1`);
    ok(b.status === 0 && b.out === '1', 'a manager still saves bank details');
    const up = bo(U.mgr, `insert into public.wf_staff (id, location_id, org_id, name, role_key, contract_type, mobile, email, dob, start_date, address, emergency_contact, primary_venue_id, venue_ids, status)
      values (${lit(S.cara)}, ${lit(A)}, ${lit(ORG)}, 'Cara Cole', 'bar', 'partTime', '07700 900000', 'cara@example.test', null, null, null, null, ${lit(A)}, array[${lit(A)}]::uuid[], 'active')
      on conflict (id) do update set location_id = excluded.location_id, org_id = excluded.org_id, name = excluded.name, role_key = excluded.role_key, contract_type = excluded.contract_type,
        mobile = excluded.mobile, email = excluded.email, dob = excluded.dob, start_date = excluded.start_date, address = excluded.address, emergency_contact = excluded.emergency_contact,
        primary_venue_id = excluded.primary_venue_id, venue_ids = excluded.venue_ids, status = excluded.status returning id`);
    ok(up.status === 0 && up.out === S.cara, 'the saveStaff upsert (insert on conflict do update) still works');
    const ins = bo(U.mgr, `insert into public.wf_staff (location_id, org_id, name, role_key, contract_type, primary_venue_id, venue_ids, status) values (${lit(A)}, ${lit(ORG)}, 'New N', 'bar', 'partTime', ${lit(A)}, array[${lit(A)}]::uuid[], 'active') returning id`);
    ok(ins.status === 0 && /^[0-9a-f-]{36}$/.test(ins.out), 'a manager still adds a new staff record');
    const lv = bo(U.mgr, `update public.wf_staff set status = 'leaver', leaver_date = current_date where id = ${lit(ins.out)} returning id`);
    ok(lv.status === 0 && lv.out === ins.out, 'a manager still archives someone as a leaver');
    const rd = bo(U.mgr, `select count(*) from public.wf_staff where org_id = ${lit(ORG)}`);
    ok(rd.status === 0 && Number(rd.out) >= 4, `a manager still reads the company staff list (${rd.out})`);
    const o = bo(U.other, `update public.wf_staff set name = 'x' where id = ${lit(S.cara)} returning 1`);
    ok(o.status === 0 && o.out === '', 'another company owner still reaches no row of this company');
    ok(auditCount() === 0, 'none of that wrote an identity audit row');
  }

  console.log('4. the door');
  {
    let r = door(U.mgr, S.cara, T.one, 'onboarding');
    ok(r.sqlstate === '42501' && /owner of this company/.test(r.message) && posOf(S.cara) === '-', `a manager is refused by the door (${r.message})`);
    r = door(U.staff, S.cara, T.one);
    ok(r.sqlstate === '42501' && posOf(S.cara) === '-', 'a staff login is refused by the door');
    r = door(U.anon, S.cara, T.one, null, { anonymous: true });
    ok(r.sqlstate === '42501' && /Sign in/.test(r.message), `an anonymous session is refused (${r.message})`);
    r = as('anon', `select public.wf_staff_set_pos_user(${lit(S.cara)}, ${lit(T.one)}, null)`);
    ok(r.sqlstate === '42501', 'the anon role cannot even execute the door');
    r = door(U.other, S.cara, T.one);
    ok(r.sqlstate === '42501' && posOf(S.cara) === '-', 'another company owner is refused');
    r = door(U.owner, S.cara, T.one, 'x', { pre: `select set_config('test.second_step', 'fail', true) \\g /dev/null\n` });
    ok(r.sqlstate === '42501' && /second sign in step/.test(r.message), `an owner short of the second step is refused (${r.message})`);
    ok(auditCount() === 0 && posOf(S.cara) === '-', 'nothing changed and nothing was audited by the refusals');

    r = door(U.owner, S.cara, T.one, 'set up on the POS');
    ok(r.status === 0 && r.json?.ok === true && r.json.changed === true && r.json.previous === null && posOf(S.cara) === T.one, 'the company owner links Cara to Till One');
    let a = lastAudit();
    ok(auditCount() === 1 && a.actor_id === U.owner && a.actor_name === 'Olive Owner' && a.entity === 'wf_staff' && a.entity_id === S.cara
      && a.reason === 'wf_staff_set_pos_user: set up on the POS' && a.before.pos_user_id === null && a.after.pos_user_id === T.one && a.after.via === 'wf_staff_set_pos_user' && a.after.op === 'update'
      && a.location_id === A && a.org_id === ORG, `one audit row: who, what, why (${JSON.stringify(a)})`);
    r = door(U.owner, S.cara, T.one);
    ok(r.status === 0 && r.json?.changed === false && auditCount() === 1, 'the same link again changes nothing and writes no audit row');
    r = door(U.linkOwner, S.cara, T.two, null);
    ok(r.status === 0 && r.json?.changed === true && r.json.previous === T.one && posOf(S.cara) === T.two, 'a venue link with role owner relinks her to Till Two');
    a = lastAudit();
    ok(auditCount() === 2 && a.actor_id === U.linkOwner && a.actor_name === 'link@example.test' && a.before.pos_user_id === T.one && a.after.pos_user_id === T.two && a.reason === 'wf_staff_set_pos_user', 'audited with the login email when the profile has no name');
    r = door(U.admin, S.bo, T.orgOnly, null);
    ok(r.status === 0 && r.json?.changed === true && posOf(S.bo) === T.orgOnly, 'a venue link with role admin at another venue of the company links, and a till user with only org_id matches');
    r = door(U.superAdmin, S.cara, null, 'leaving the till');
    ok(r.status === 0 && r.json?.changed === true && r.json.previous === T.two && posOf(S.cara) === '-', 'the super admin unlinks');
    a = lastAudit();
    ok(auditCount() === 4 && a.actor_name === 'Peter' && a.before.pos_user_id === T.two && a.after.pos_user_id === null, 'the unlink is audited');

    r = door(U.owner, S.cara, T.other);
    ok(r.sqlstate === '22023' && /another company/.test(r.message) && posOf(S.cara) === '-', 'a till user of another company is refused');
    r = door(U.owner, S.cara, T.patsTill);
    ok(r.sqlstate === '23505' && /already linked/.test(r.message) && posOf(S.cara) === '-', 'a till user already linked to Pat is refused');
    r = door(U.owner, S.lee, T.one);
    ok(r.sqlstate === '22023' && /leaver/.test(r.message), 'a leaver is refused');
    r = door(U.owner, id('5a000000', 99), T.one);
    ok(r.sqlstate === 'P0002', 'an unknown staff record is refused');
    r = door(U.owner, S.cara, id('7e000000', 99));
    ok(r.sqlstate === '22023' && /No till user/.test(r.message), 'an unknown till user is refused');
    r = door(U.owner, null, T.one);
    ok(r.sqlstate === '22023', 'no staff id is refused');
    r = door(U.owner, S.xan, T.other);
    ok(r.sqlstate === '42501', 'the owner of this company cannot link a record of another company');
    ok(auditCount() === 4, 'the refusals wrote nothing');
    // Pat's till can be linked to Cara once Pat is a leaver.
    sql(`update public.wf_staff set status = 'leaver' where id = ${lit(S.pat)}`);
    r = door(U.owner, S.cara, T.patsTill);
    ok(r.status === 0 && r.json?.changed === true && auditCount() === 5, 'once Pat is a leaver his till user can be linked to Cara');
    sql(`update public.wf_staff set status = 'active' where id = ${lit(S.pat)}; update public.wf_staff set pos_user_id = null where id = ${lit(S.cara)};`);
    ok(auditCount() === 6, 'the database itself clearing it is audited too');
  }

  console.log('5. the trusted paths');
  {
    const before = auditCount();
    const chat = Number(sql(`select count(*) from public.chat_sync_log`));
    let r = as('service_role', `update public.wf_staff set portal_user_id = ${lit(id('99000000', 1))}, portal_invite_hash = null, portal_invite_expires = null where id = ${lit(S.cara)} returning 1`);
    ok(r.status === 0 && portalOf(S.cara) === id('99000000', 1), 'the service role (accept_invite) links a staff app login');
    let a = lastAudit();
    ok(auditCount() === before + 1 && a.actor_id === null && a.actor_name === 'service role' && a.reason === 'service role' && a.before.portal_user_id === null && a.after.portal_user_id === id('99000000', 1) && a.after.pos_user_id === undefined, `audited as the service role (${JSON.stringify(a)})`);
    ok(Number(sql(`select count(*) from public.chat_sync_log`)) === chat + 1, 'the chat sync trigger still fires on a portal_user_id change');
    r = as('service_role', `update public.wf_staff set portal_invite_hash = 'abc', portal_invite_expires = now() + interval '7 days' where id = ${lit(S.cara)} returning 1`);
    ok(r.status === 0 && auditCount() === before + 1, 'the service role stamps an invite (issueInvite): allowed, not an identity change, not audited');
    r = as('service_role', `insert into public.wf_staff (location_id, org_id, name, role_key, contract_type, primary_venue_id, venue_ids, status, pos_user_id) values (${lit(A)}, ${lit(ORG)}, 'Till One', null, 'partTime', ${lit(A)}, array[${lit(A)}]::uuid[], 'active', ${lit(T.one)}) returning id`);
    ok(r.status === 0 && /^[0-9a-f-]{36}$/.test(r.out), 'the service role (workforce-clock) creates a record for a till user that has none');
    a = lastAudit();
    ok(auditCount() === before + 2 && a.entity_id === r.out && a.after.pos_user_id === T.one && a.after.op === 'insert' && a.before.pos_user_id === undefined, 'the auto created record is audited as an insert');
    sql(`delete from public.wf_staff where id = ${lit(r.out)}`);
    r = as('service_role', `update public.wf_staff set status = 'leaver', leaver_date = current_date where id = ${lit(S.cara)} returning 1`);
    ok(r.status === 0 && auditCount() === before + 2, 'offboarding (status only) is not an identity change');
    sql(`update public.wf_staff set status = 'active', leaver_date = null where id = ${lit(S.cara)}`);
    const n = auditCount();
    sql(`update public.wf_staff set pos_user_id = ${lit(T.one)} where id = ${lit(S.cara)}`);
    a = lastAudit();
    ok(posOf(S.cara) === T.one && auditCount() === n + 1 && a.actor_name === 'database' && a.reason === 'database (postgres)', 'the SQL editor (the database itself) may write it, and is audited');
    sql(`update public.wf_staff set pos_user_id = null where id = ${lit(S.cara)}`);
  }

  console.log('6. the audit rows and the helpers are out of the API reach');
  {
    const n = auditCount();
    let r = bo(U.owner, `update public.wf_audit set reason = 'edited' where action = 'staff.identity_changed'`);
    ok(r.sqlstate === '42501', 'an owner cannot edit an identity audit row');
    r = bo(U.owner, `delete from public.wf_audit where action = 'staff.identity_changed'`);
    ok(r.sqlstate === '42501' && auditCount() === n, 'an owner cannot delete one');
    r = bo(U.owner, `select count(*) from public.wf_audit where action = 'staff.identity_changed' and location_id = ${lit(A)}`);
    ok(r.status === 0 && Number(r.out) > 0, `an owner reads them for their venue (${r.out})`);
    r = bo(U.owner, `select public.wf_staff_regrant_api()`);
    ok(r.sqlstate === '42501', 'the regrant helper is not callable from the API');
    const priv = sql(`select bool_or(has_function_privilege(r, p.oid, 'execute')) from pg_proc p, unnest(array['anon', 'authenticated', 'service_role']) r
      where p.pronamespace = 'public'::regnamespace and p.proname in ('wf_staff_identity_guard', 'wf_staff_identity_audit', 'wf_staff_regrant_api')`);
    ok(priv === 'f', 'the guard, the audit writer and the regrant helper are executable by no API role');
    r = bo(U.owner, `select set_config('wf.identity_reason', 'forged', true)`);
    ok(r.status === 0 && auditCount() === n, 'setting the reason setting by hand changes nothing (the stack decides the path, not a setting)');
  }

  console.log('7. a column added later, and the cost');
  {
    sql(`alter table public.wf_staff add column nickname text`);
    let r = bo(U.mgr, `update public.wf_staff set nickname = 'CC' where id = ${lit(S.cara)}`);
    ok(r.sqlstate === '42501', 'a new column is not writable from the API until the regrant runs (the trap every later migration must mind)');
    const n = Number(sql(`select public.wf_staff_regrant_api()`));
    const total = Number(sql(`select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'wf_staff'`));
    ok(n === total - 4, `wf_staff_regrant_api() grants ${n} of ${total} columns`);
    r = bo(U.mgr, `update public.wf_staff set nickname = 'CC' where id = ${lit(S.cara)} returning 1`);
    ok(r.status === 0 && r.out === '1', 'then it is writable');
    r = bo(U.mgr, `update public.wf_staff set pos_user_id = ${lit(T.one)} where id = ${lit(S.cara)}`);
    ok(r.sqlstate === '42501', 'and the identity columns stay closed');
    sql(`alter table public.wf_staff drop column nickname`);
    const t0 = Date.now();
    const many = bo(U.mgr, `update public.wf_staff set notes = 'n' where org_id = ${lit(ORG)} returning 1`);
    const rows = many.out.split('\n').filter(Boolean).length;
    r = as('postgres', `explain (analyze, format json) update public.wf_staff set notes = 'm' where org_id = ${lit(ORG)}`);
    const plan = JSON.parse(r.out.replace(/\n/g, '') || '[]');
    const trig = (plan[0]?.Triggers || []).find((t) => t['Trigger Name'] === 'wf_staff_identity_guard_trg');
    const perRow = trig ? trig.Time / Math.max(1, trig.Calls) : null;
    ok(perRow != null && perRow < 1, `the guard costs ${perRow == null ? '?' : perRow.toFixed(3)} ms a row (${rows} rows, ${Date.now() - t0} ms end to end)`);
  }

  console.log('8. the rollback');
  {
    const kept = auditCount();
    const rb = psql({ args: ['-1', '-f', ROLLBACK] });
    const check = rb.stdout.trim().split('\n').pop();
    ok(check === 't|t|t|0|0|f|0|t', `rollback check row (${check})`);
    ok(auditCount() === kept, 'the audit rows are kept');
    let r = bo(U.mgr, `update public.wf_staff set pos_user_id = ${lit(T.one)} where id = ${lit(S.cara)} returning 1`);
    ok(r.status === 0 && posOf(S.cara) === T.one, 'after the rollback a manager can PATCH pos_user_id again, as before');
    sql(`update public.wf_staff set pos_user_id = null where id = ${lit(S.cara)}`);
    r = bo(U.mgr, `update public.wf_staff set portal_user_id = ${lit(U.mgr)} where id = ${lit(S.cara)}`);
    ok(r.sqlstate === 'P0001', 'and portal_user_id is refused by the 20260806j trigger again');
    r = bo(U.mgr, `select public.wf_staff_set_pos_user(${lit(S.cara)}, ${lit(T.one)}, null)`);
    ok(r.sqlstate === '42883', 'the door is gone (the app falls back to the direct write)');
    const rb2 = psql({ args: ['-1', '-f', ROLLBACK], allowFail: true });
    ok(rb2.status !== 0 && /is not in/.test(rb2.stderr), 'a second rollback is refused');
    const reapply = psql({ args: ['-1', '-f', MIGRATION], allowFail: true });
    ok(reapply.status === 0 && reapply.stdout.trim().split('\n').pop() === 'f|f|f|t|t|t|t|t|t|t|t|f|t|0', 'the migration applies again after the rollback');
    r = bo(U.mgr, `update public.wf_staff set pos_user_id = ${lit(T.one)} where id = ${lit(S.cara)}`);
    ok(r.sqlstate === '42501', 'and the fence is back');
  }
} finally {
  stop();
}
console.log(`\n${passes} checks passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
