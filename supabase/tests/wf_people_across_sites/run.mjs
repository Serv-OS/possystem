#!/usr/bin/env node
// run.mjs: proves 20261111a (one person, many sites) on a local, throwaway PostgreSQL, before Peter
// runs it on the Ops database. It never connects to Supabase.
//
//   node supabase/tests/wf_people_across_sites/run.mjs
//
// It starts its own cluster in a temp folder, builds the live shape (schema.sql), applies 20261104a
// (the identity fence, live since 27 Oct 2026) and then 20261111a, and stops at the end. Calls are made
// the way the API makes them: logged in as authenticator, SET ROLE, the claims set. What it proves:
//   1. the migration applies, its check row reads as documented, a second run is refused, no row changed;
//   2. person_id is never written from the API (wf_staff column fence, staff_members guard);
//   3. "Also works at" (wf_staff_add_site): the owner adds Pat at Barnsley; the new record and till user
//      carry the same person, PIN, card and sign in method; role and rate are the site's own; an audit
//      row; a manager of Leeds only, an anonymous session and a login short of its second step cannot;
//      a second row at the same site and another company's site are refused; a PIN already used at
//      the other site is refused with the name;
//   4. sync: a PIN change at Leeds is the PIN at Barnsley; a Leeds only manager cannot change it; a PIN
//      used by someone else at Barnsley is refused; email and mobile follow, role and rate do not;
//   5. wf_staff_link: two records made by hand join, the Barnsley record takes the Leeds details and PIN;
//   6. wf_staff_unlink: the link goes, a PIN change no longer copies;
//   7. the ROLLBACK removes it all, keeps the records, and the migration applies again.
// Exit code 0 only when every check holds.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..');
const FENCE = join(repo, 'supabase/migrations/20261104a_OPS_wf_staff_identity_fence.sql');
const MIGRATION = join(repo, 'supabase/migrations/20261111a_OPS_wf_people_across_sites.sql');
const ROLLBACK = join(repo, 'supabase/migrations/20261111a_OPS_wf_people_across_sites_ROLLBACK.sql');

const bin = (name) => (existsSync(`/opt/homebrew/bin/${name}`) ? `/opt/homebrew/bin/${name}` : name);
const env = { ...process.env, LC_ALL: 'en_US.UTF-8', PGOPTIONS: '-c client_min_messages=warning' };
let failures = 0, passes = 0;
const ok = (cond, msg) => { if (cond) { passes++; console.log(`  ok   ${msg}`); } else { failures++; console.log(`  FAIL ${msg}`); } };

const port = process.env.WFPA_PGPORT || String(55700 + Math.floor(Math.random() * 80));
const dir = mkdtempSync(join(tmpdir(), 'pgp.'));
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
const LEEDS = id('a0000000', 1), BARNSLEY = id('a0000000', 2), YORK = id('a0000000', 3), OTHER = id('c0000000', 1);
const U = {
  owner: id('10000000', 1),     // owner of ORG: every site
  mgrLeeds: id('10000000', 2),  // manager at Leeds only
  mgrBoth: id('10000000', 3),   // manager at Leeds and Barnsley
  superAdmin: id('10000000', 4),
  other: id('10000000', 5),     // owner of ORG2
};
const S = { pat: id('5a000000', 1), cara: id('5a000000', 2), caraB: id('5a000000', 3), xan: id('5a000000', 4) };
const T = { pat: id('7e000000', 1), cara: id('7e000000', 2), caraB: id('7e000000', 3), bea: id('7e000000', 4), dee: id('7e000000', 5) };

function as(role, body, { sub = null, anonymous = false, pre = '' } = {}) {
  const lines = ['\\set VERBOSITY verbose', 'begin;'];
  const claims = role === 'service_role' ? { role } : { role, sub, aud: 'authenticated', is_anonymous: anonymous };
  lines.push(`select set_config('request.jwt.claims', ${lit(JSON.stringify(claims))}, true) \\g /dev/null`);
  if (pre) lines.push(pre);
  lines.push(`set local role ${role};`);
  lines.push(body.trim().replace(/;?$/, ';'), 'commit;');
  const r = psql({ login: 'authenticator', input: lines.join('\n') + '\n', allowFail: true });
  const m = /ERROR:\s+([0-9A-Z]{5}):\s*(.*)/.exec(r.stderr || '');
  return { status: r.status, sqlstate: m ? m[1] : null, message: m ? m[2] : (r.stderr || '').trim(), out: r.stdout.trim() };
}
const bo = (sub, body, opts = {}) => as('authenticated', body, { sub, ...opts });
const jsonOut = (r) => { try { return JSON.parse(r.out.split('\n').pop() || 'null'); } catch { return null; } };
const one = (q) => sql(q);

try {
  console.log('schema');
  psql({ args: ['-1', '-f', join(here, 'schema.sql')] });
  sql(`insert into public.locations (id, org_id, name) values (${lit(LEEDS)}, ${lit(ORG)}, 'Leeds'), (${lit(BARNSLEY)}, ${lit(ORG)}, 'Barnsley'),
         (${lit(YORK)}, ${lit(ORG)}, 'York'), (${lit(OTHER)}, ${lit(ORG2)}, 'Elsewhere');
       insert into public.user_profiles (id, org_id, location_id, full_name, email, role) values
         (${lit(U.owner)}, ${lit(ORG)}, ${lit(LEEDS)}, 'Olive Owner', 'olive@example.test', 'owner'),
         (${lit(U.mgrLeeds)}, ${lit(ORG)}, ${lit(LEEDS)}, 'Mo Leeds', 'mo@example.test', 'manager'),
         (${lit(U.mgrBoth)}, ${lit(ORG)}, ${lit(LEEDS)}, 'Bea Both', 'bea@example.test', 'manager'),
         (${lit(U.superAdmin)}, null, null, 'Peter', 'peter@example.test', 'super_admin'),
         (${lit(U.other)}, ${lit(ORG2)}, ${lit(OTHER)}, 'Otto Other', 'otto@example.test', 'owner');
       insert into public.user_locations (user_id, location_id, role) values
         (${lit(U.owner)}, ${lit(LEEDS)}, 'owner'), (${lit(U.mgrLeeds)}, ${lit(LEEDS)}, 'manager'),
         (${lit(U.mgrBoth)}, ${lit(LEEDS)}, 'manager'), (${lit(U.mgrBoth)}, ${lit(BARNSLEY)}, 'manager'), (${lit(U.other)}, ${lit(OTHER)}, 'owner');
       insert into public.staff_members (id, location_id, org_id, name, role, pin, color, initials, nfc_card_id, auth_method, permissions) values
         (${lit(T.pat)}, ${lit(LEEDS)}, ${lit(ORG)}, 'Pat P', 'staff', '1234', '#ff0000', 'PP', 'CARD-PAT', 'pin', '["refund"]'),
         (${lit(T.cara)}, ${lit(LEEDS)}, ${lit(ORG)}, 'Cara C', 'manager', '5555', '#00ff00', 'CC', null, 'pin', '[]'),
         (${lit(T.caraB)}, ${lit(BARNSLEY)}, ${lit(ORG)}, 'Cara Cee', 'staff', '6666', '#0000ff', 'CE', null, 'pin', '[]'),
         (${lit(T.bea)}, ${lit(BARNSLEY)}, ${lit(ORG)}, 'Bea B', 'manager', '9999', '#000000', 'BB', null, 'pin', '[]'),
         (${lit(T.dee)}, ${lit(BARNSLEY)}, ${lit(ORG)}, 'Dee D', 'staff', '1234', '#111111', 'DD', null, 'pin', '[]');
       insert into public.wf_staff (id, org_id, location_id, name, role_key, rate_override, email, mobile, status, pos_user_id) values
         (${lit(S.pat)}, ${lit(ORG)}, ${lit(LEEDS)}, 'Pat P', 'floor', 15.00, 'pat@example.test', '801 555 0001', 'active', ${lit(T.pat)}),
         (${lit(S.cara)}, ${lit(ORG)}, ${lit(LEEDS)}, 'Cara C', 'mgmt', 18.00, 'cara@example.test', '801 555 0002', 'active', ${lit(T.cara)}),
         (${lit(S.caraB)}, ${lit(ORG)}, ${lit(BARNSLEY)}, 'Cara Cee', 'bar', 16.00, 'old@example.test', '801 555 9999', 'active', ${lit(T.caraB)}),
         (${lit(S.xan)}, ${lit(ORG2)}, ${lit(OTHER)}, 'Xan X', 'floor', 12.00, null, null, 'active', null);`);

  console.log('0. the identity fence (live since 27 Oct)');
  psql({ args: ['-1', '-f', FENCE] });

  console.log('1. the migration');
  const before = sql(`select count(*) from public.wf_staff where updated_at > now() - interval '1 hour'`);
  const check = psql({ args: ['-1', '-f', MIGRATION] }).stdout.trim().split('\n').pop();
  ok(check === '2|f|t|3|f|5|0|0', `check row reads 2|f|t|3|f|5|0|0 (got ${check})`);
  const again = psql({ args: ['-1', '-f', MIGRATION], allowFail: true });
  ok(again.status !== 0 && /has run/.test(again.stderr), 'a second run is refused');
  ok(sql(`select count(*) from public.wf_staff where person_id is not null`) === '0', 'no record is linked by the migration');
  ok(sql(`select count(*) from public.wf_staff where updated_at > now() - interval '1 hour'`) === before, 'no record changed');

  console.log('2. person_id is never written from the API');
  let r = bo(U.owner, `update public.wf_staff set person_id = gen_random_uuid() where id = ${lit(S.pat)}`);
  ok(r.sqlstate === '42501', `wf_staff.person_id PATCH refused 42501 (${r.sqlstate})`);
  r = bo(U.owner, `update public.staff_members set person_id = gen_random_uuid() where id = ${lit(T.pat)}`);
  ok(r.sqlstate === '42501', `staff_members.person_id PATCH refused 42501 (${r.sqlstate})`);
  r = bo(U.owner, `insert into public.staff_members (location_id, org_id, name, pin, person_id) values (${lit(LEEDS)}, ${lit(ORG)}, 'Sneaky', '0000', gen_random_uuid())`);
  ok(r.sqlstate === '42501', `a till user inserted with a person_id is refused (${r.sqlstate})`);
  r = bo(U.owner, `update public.wf_staff set notes = 'still works' where id = ${lit(S.pat)}`);
  ok(r.status === 0, 'every other Workforce write still works');

  console.log('3. Also works at (wf_staff_add_site)');
  r = bo(U.mgrLeeds, `select public.wf_staff_add_site(${lit(S.pat)}, ${lit(BARNSLEY)}, 'bar', 17.00)`);
  ok(r.sqlstate === '42501' && /every site/.test(r.message), `a Leeds only manager cannot add Barnsley (${r.message})`);
  r = bo(U.owner, `select public.wf_staff_add_site(${lit(S.pat)}, ${lit(BARNSLEY)}, 'bar', 17.00)`, { anonymous: true });
  ok(r.sqlstate === '42501', 'an anonymous session cannot');
  r = bo(U.owner, `select public.wf_staff_add_site(${lit(S.pat)}, ${lit(BARNSLEY)}, 'bar', 17.00)`, { pre: `select set_config('test.second_step', 'fail', true) \\g /dev/null` });
  ok(r.sqlstate === '42501' && /second/.test(r.message), 'a login short of its second step cannot');
  r = bo(U.other, `select public.wf_staff_add_site(${lit(S.pat)}, ${lit(BARNSLEY)}, 'bar', 17.00)`);
  ok(r.sqlstate === '42501', 'another company cannot');
  r = bo(U.owner, `select public.wf_staff_add_site(${lit(S.pat)}, ${lit(OTHER)}, 'bar', 17.00)`);
  ok(r.sqlstate === '22023', 'another company site is refused');
  // Pat's PIN 1234 is Dee's at Barnsley.
  r = bo(U.owner, `select public.wf_staff_add_site(${lit(S.pat)}, ${lit(BARNSLEY)}, 'bar', 17.00)`);
  ok(r.sqlstate === '23505' && /Dee D at Barnsley/.test(r.message), `a PIN used at the other site is refused with the name (${r.message})`);
  ok(sql(`select count(*) from public.wf_staff where location_id = ${lit(BARNSLEY)}`) === '1', 'and nothing was made');
  sql(`update public.staff_members set pin = '4321' where id = ${lit(T.dee)}`);
  r = bo(U.mgrBoth, `select public.wf_staff_add_site(${lit(S.pat)}, ${lit(BARNSLEY)}, 'bar', 17.00)`);
  const added = jsonOut(r);
  ok(r.status === 0 && added?.ok, `a manager of both sites adds Pat at Barnsley (${r.message || 'ok'})`);
  const patB = added?.staff_id, patBTill = added?.pos_user_id;
  const rowB = JSON.parse(sql(`select row_to_json(w) from public.wf_staff w where id = ${lit(patB)}`));
  const rowA = JSON.parse(sql(`select row_to_json(w) from public.wf_staff w where id = ${lit(S.pat)}`));
  ok(rowB.person_id && rowB.person_id === rowA.person_id && rowB.person_id !== S.pat, 'both records carry one new person id (never a row id)');
  ok(rowB.role_key === 'bar' && Number(rowB.rate_override) === 17 && rowB.location_id === BARNSLEY, 'role and rate are the site’s own');
  ok(rowB.name === 'Pat P' && rowB.email === 'pat@example.test' && rowB.mobile === '801 555 0001', 'personal details came across');
  ok(rowB.pos_user_id === patBTill, 'the new record is linked to its new till user');
  const tillB = JSON.parse(sql(`select row_to_json(s) from public.staff_members s where id = ${lit(patBTill)}`));
  ok(tillB.location_id === BARNSLEY && tillB.pin === '1234' && tillB.nfc_card_id === 'CARD-PAT' && tillB.auth_method === 'pin' && tillB.role === 'staff',
    'the Barnsley till user has the same PIN, card and sign in method');
  ok(tillB.person_id === rowA.person_id && sql(`select person_id from public.staff_members where id = ${lit(T.pat)}`) === rowA.person_id, 'both till users carry the person');
  ok(sql(`select count(*) from public.wf_audit where action = 'staff.site_added' and entity_id = ${lit(patB)}`) === '1', 'one audit row for the site added');
  r = bo(U.owner, `select public.wf_staff_add_site(${lit(S.pat)}, ${lit(BARNSLEY)}, 'bar', 17.00)`);
  ok(r.sqlstate === '23505', 'a second record at the same site is refused');

  console.log('4. sync');
  r = bo(U.owner, `update public.staff_members set pin = '2468' where id = ${lit(T.pat)}`);
  ok(r.status === 0 && sql(`select pin from public.staff_members where id = ${lit(patBTill)}`) === '2468', 'a PIN changed at Leeds is the PIN at Barnsley');
  r = bo(U.mgrLeeds, `update public.staff_members set pin = '1357' where id = ${lit(T.pat)}`);
  ok(r.sqlstate === '42501' && sql(`select pin from public.staff_members where id = ${lit(T.pat)}`) === '2468', `a Leeds only manager cannot change a PIN that signs in at Barnsley (${r.sqlstate})`);
  r = bo(U.owner, `update public.staff_members set pin = '9999' where id = ${lit(T.pat)}`);
  ok(r.sqlstate === '23505' && /Bea B at Barnsley/.test(r.message), `a PIN used by Bea at Barnsley is refused with her name (${r.message})`);
  ok(sql(`select pin from public.staff_members where id = ${lit(patBTill)}`) === '2468', 'and neither PIN moved');
  r = bo(U.owner, `update public.staff_members set nfc_card_id = 'CARD-NEW', role = 'manager' where id = ${lit(T.pat)}`);
  ok(sql(`select nfc_card_id || '|' || role from public.staff_members where id = ${lit(patBTill)}`) === 'CARD-NEW|staff', 'the card follows, the till role stays per site');
  r = bo(U.owner, `update public.wf_staff set email = 'pat.new@example.test', mobile = '801 555 7777', rate_override = 20, role_key = 'mgmt' where id = ${lit(S.pat)}`);
  const synced = sql(`select email || '|' || mobile || '|' || rate_override || '|' || role_key from public.wf_staff where id = ${lit(patB)}`);
  ok(synced === 'pat.new@example.test|801 555 7777|17.00|bar', `email and mobile follow; rate and role stay per site (${synced})`);

  console.log('5. wf_staff_link (two records made by hand)');
  r = bo(U.mgrLeeds, `select public.wf_staff_link(${lit(S.cara)}, ${lit(S.caraB)})`);
  ok(r.sqlstate === '42501', 'a Leeds only manager cannot link a Barnsley record');
  r = bo(U.owner, `select public.wf_staff_link(${lit(S.cara)}, ${lit(S.caraB)})`);
  ok(r.status === 0 && jsonOut(r)?.ok, `the owner links Cara at Leeds and Barnsley (${r.message || 'ok'})`);
  const caraB = JSON.parse(sql(`select row_to_json(w) from public.wf_staff w where id = ${lit(S.caraB)}`));
  ok(caraB.name === 'Cara C' && caraB.email === 'cara@example.test' && caraB.mobile === '801 555 0002', 'the Barnsley record takes the Leeds details');
  ok(caraB.role_key === 'bar' && Number(caraB.rate_override) === 16, 'and keeps its own role and rate');
  const caraTillB = JSON.parse(sql(`select row_to_json(s) from public.staff_members s where id = ${lit(T.caraB)}`));
  ok(caraTillB.pin === '5555' && caraTillB.name === 'Cara C' && caraTillB.role === 'staff', 'the Barnsley till user takes the Leeds PIN and name, keeps its role');
  ok(sql(`select count(distinct person_id) from public.wf_staff where id in (${lit(S.cara)}, ${lit(S.caraB)})`) === '1', 'one person');
  ok(sql(`select count(*) from public.wf_audit where action = 'staff.person_linked'`) === '1', 'one audit row for the link');

  console.log('6. wf_staff_unlink');
  r = bo(U.owner, `select public.wf_staff_unlink(${lit(S.caraB)})`);
  ok(r.status === 0 && sql(`select coalesce(person_id::text, '-') from public.wf_staff where id = ${lit(S.caraB)}`) === '-', 'the link goes');
  bo(U.owner, `update public.staff_members set pin = '5151' where id = ${lit(T.cara)}`);
  ok(sql(`select pin from public.staff_members where id = ${lit(T.caraB)}`) === '5555', 'a PIN change no longer copies');

  console.log('7. rollback');
  const rb = psql({ args: ['-1', '-f', ROLLBACK] }).stdout.trim().split('\n').pop();
  ok(rb === '0|0|0|t', `rollback check row reads 0|0|0|t (got ${rb})`);
  ok(sql(`select count(*) from public.wf_staff where id = ${lit(patB)}`) === '1', 'the record made at Barnsley stays');
  r = bo(U.owner, `update public.wf_staff set notes = 'after rollback' where id = ${lit(S.pat)}`);
  ok(r.status === 0, 'Workforce writes still work');
  r = bo(U.owner, `update public.wf_staff set pos_user_id = null where id = ${lit(S.pat)}`);
  ok(r.sqlstate === '42501', 'the identity fence still holds');
  const reapply = psql({ args: ['-1', '-f', MIGRATION] }).stdout.trim().split('\n').pop();
  ok(reapply === '2|f|t|3|f|5|0|0', `the migration applies again (got ${reapply})`);
} finally {
  stop();
}
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
