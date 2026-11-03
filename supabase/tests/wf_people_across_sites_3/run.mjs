#!/usr/bin/env node
// run.mjs: proves 20261113a (till users across sites, Back Office Team) on a local, throwaway
// PostgreSQL, before Peter runs it on the Ops database. It never connects to Supabase.
//
//   node supabase/tests/wf_people_across_sites_3/run.mjs
//
// Live chain 20261031a, 20261104a, 20261111a, 20261112a, then 20261113a. Proves:
//   1. it applies, its check row reads as documented, a second run is refused;
//   2. a till user with no Workforce record: Also works at makes a till user at the other site with
//      the same PIN, card, sign in method, till role and permissions; a PIN change copies; a PIN used
//      at the other site is refused; a manager of one site cannot; another company's site is refused;
//   3. a till user WITH a Workforce record: the same press makes both records (Workforce's door);
//   4. the clock's first clock in at the new site (a Workforce record made by the service role with
//      pos_user_id) joins the person, so the two sites' hours are one person's;
//   5. Link joins two till users made by hand (the other takes this one's PIN), and joins the one
//      Workforce record either has; Unlink;
//   6. person_id is still never written from the API; the ROLLBACK keeps links and applies again.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..');
const M = (f) => join(repo, 'supabase/migrations', f);
const CHAIN = ['20261031a_OPS_wf_open_shifts.sql', '20261104a_OPS_wf_staff_identity_fence.sql', '20261111a_OPS_wf_people_across_sites.sql', '20261112a_OPS_wf_people_across_sites_2.sql'].map(M);
const MIGRATION = M('20261113a_OPS_till_users_across_sites.sql');
const ROLLBACK = M('20261113a_OPS_till_users_across_sites_ROLLBACK.sql');

const bin = (name) => (existsSync(`/opt/homebrew/bin/${name}`) ? `/opt/homebrew/bin/${name}` : name);
const env = { ...process.env, LC_ALL: 'en_US.UTF-8', PGOPTIONS: '-c client_min_messages=warning' };
let failures = 0, passes = 0;
const ok = (cond, msg) => { if (cond) { passes++; console.log(`  ok   ${msg}`); } else { failures++; console.log(`  FAIL ${msg}`); } };
const port = process.env.WFPC_PGPORT || String(55900 + Math.floor(Math.random() * 80));
const dir = mkdtempSync(join(tmpdir(), 'pgr.'));
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
  if (r.status !== 0 && !allowFail) { console.error('psql failed:\n', input?.slice(0, 600), '\n', r.stderr || r.stdout); stop(); process.exit(2); }
  return r;
}
const sql = (q) => psql({ input: q }).stdout.trim();
const lit = (v) => (v == null ? 'null' : `'${String(v).replace(/'/g, "''")}'`);
const id = (p, n) => `${p}-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ORG = id('0a000000', 1), ORG2 = id('0a000000', 2);
const PROVO = id('a0000000', 1), DAY = id('a0000000', 2), OTHER = id('a0000000', 9);
const U = { owner: id('10000000', 1), mgrProvo: id('10000000', 2), both: id('10000000', 3) };
const T = { ann: id('7e000000', 1), bo: id('7e000000', 2), boDay: id('7e000000', 3), dee: id('7e000000', 4), cy: id('7e000000', 5), cyDay: id('7e000000', 6) };
const W = { bo: id('5a000000', 1) };

function as(role, body, { sub = null, anonymous = false } = {}) {
  const claims = role === 'service_role' ? { role } : { role, sub, aud: 'authenticated', is_anonymous: anonymous };
  const input = ['\\set VERBOSITY verbose', 'begin;', `select set_config('request.jwt.claims', ${lit(JSON.stringify(claims))}, true) \\g /dev/null`,
    `set local role ${role};`, body.trim().replace(/;?$/, ';'), 'commit;'].join('\n') + '\n';
  const r = psql({ login: 'authenticator', input, allowFail: true });
  const m = /ERROR:\s+([0-9A-Z]{5}):\s*(.*)/.exec(r.stderr || '');
  return { status: r.status, sqlstate: m ? m[1] : null, message: m ? m[2] : (r.stderr || '').trim(), out: r.stdout.trim() };
}
const bo = (sub, body, opts) => as('authenticated', body, { sub, ...opts });
const json = (r) => { try { return JSON.parse(r.out.split('\n').pop() || 'null'); } catch { return null; } };
const till = (where) => JSON.parse(sql(`select coalesce(json_agg(s), '[]') from public.staff_members s where ${where}`));

try {
  console.log('schema and the live chain');
  psql({ args: ['-1', '-f', join(here, 'schema.sql')] });
  sql(`insert into public.locations (id, org_id, name, timezone, currency) values
         (${lit(PROVO)}, ${lit(ORG)}, 'Provo', 'America/Denver', 'USD'), (${lit(DAY)}, ${lit(ORG)}, 'Daybreak', 'America/Denver', 'USD'),
         (${lit(OTHER)}, ${lit(ORG2)}, 'Elsewhere', 'America/Denver', 'USD');
       insert into public.user_profiles (id, org_id, location_id, full_name, email, role) values
         (${lit(U.owner)}, ${lit(ORG)}, ${lit(PROVO)}, 'Olive', 'o@example.test', 'owner'),
         (${lit(U.mgrProvo)}, ${lit(ORG)}, ${lit(PROVO)}, 'Mo', 'm@example.test', 'manager'),
         (${lit(U.both)}, ${lit(ORG)}, ${lit(PROVO)}, 'Bea', 'b@example.test', 'manager');
       insert into public.user_locations (user_id, location_id, role) values
         (${lit(U.owner)}, ${lit(PROVO)}, 'owner'), (${lit(U.mgrProvo)}, ${lit(PROVO)}, 'manager'),
         (${lit(U.both)}, ${lit(PROVO)}, 'manager'), (${lit(U.both)}, ${lit(DAY)}, 'manager');`);
  for (const f of CHAIN) psql({ args: ['-1', '-f', f] });
  sql(`insert into public.staff_members (id, location_id, org_id, name, role, pin, color, initials, nfc_card_id, auth_method, permissions) values
         (${lit(T.ann)}, ${lit(PROVO)}, ${lit(ORG)}, 'Ann A', 'Server', '1111', '#f00', 'AA', 'CARD-ANN', 'card', '["refund","void"]'),
         (${lit(T.bo)}, ${lit(PROVO)}, ${lit(ORG)}, 'Bo B', 'Bartender', '2222', '#0f0', 'BB', null, 'pin', '[]'),
         (${lit(T.dee)}, ${lit(DAY)}, ${lit(ORG)}, 'Dee D', 'Server', '3333', '#00f', 'DD', null, 'pin', '[]'),
         (${lit(T.cy)}, ${lit(PROVO)}, ${lit(ORG)}, 'Cy C', 'Server', '4444', '#111', 'CC', null, 'pin', '[]'),
         (${lit(T.cyDay)}, ${lit(DAY)}, ${lit(ORG)}, 'Cy Cee', 'Kitchen', '5555', '#222', 'CE', null, 'pin', '[]');
       insert into public.wf_staff (id, org_id, location_id, name, role_key, status, pos_user_id) values
         (${lit(W.bo)}, ${lit(ORG)}, ${lit(PROVO)}, 'Bo B', 'bar', 'active', ${lit(T.bo)});`);

  console.log('1. the migration');
  const check = psql({ args: ['-1', '-f', MIGRATION] }).stdout.trim().split('\n').pop();
  ok(check === '3|f|t|t', `check row reads 3|f|t|t (got ${check})`);
  const again = psql({ args: ['-1', '-f', MIGRATION], allowFail: true });
  ok(again.status !== 0 && /has run already/.test(again.stderr), 'a second run is refused');

  console.log('2. a till user with no Workforce record');
  let r = bo(U.mgrProvo, `select public.wf_till_add_site(${lit(T.ann)}, ${lit(DAY)})`);
  ok(r.sqlstate === '42501', `a manager of Provo only cannot add Daybreak (${r.message})`);
  r = bo(U.owner, `select public.wf_till_add_site(${lit(T.ann)}, ${lit(OTHER)})`);
  ok(r.sqlstate === '22023', 'another company site is refused');
  r = bo(U.owner, `select public.wf_till_add_site(${lit(T.ann)}, ${lit(DAY)})`, { anonymous: true });
  ok(r.sqlstate === '42501', 'an anonymous session (a till) cannot');
  r = bo(U.both, `select public.wf_till_add_site(${lit(T.ann)}, ${lit(DAY)})`);
  const a1 = json(r);
  ok(r.status === 0 && a1?.ok && a1.staff_id === null, `a manager of both sites adds Ann at Daybreak (${r.message || 'ok'})`);
  const annDay = till(`id = ${lit(a1?.pos_user_id)}`)[0];
  ok(annDay && annDay.location_id === DAY && annDay.pin === '1111' && annDay.nfc_card_id === 'CARD-ANN' && annDay.auth_method === 'card'
    && annDay.role === 'Server' && JSON.stringify(annDay.permissions) === '["refund","void"]', `same PIN, card, sign in method, till role and permissions at Daybreak (${JSON.stringify(annDay)})`);
  ok(sql(`select count(distinct person_id) from public.staff_members where id in (${lit(T.ann)}, ${lit(a1?.pos_user_id)})`) === '1', 'one person');
  ok(sql(`select count(*) from public.wf_audit where action = 'till.site_added'`) === '1', 'one audit row');
  r = bo(U.both, `update public.staff_members set pin = '7777' where id = ${lit(T.ann)}`);
  ok(r.status === 0 && till(`id = ${lit(a1?.pos_user_id)}`)[0].pin === '7777', 'a PIN changed at Provo is the PIN at Daybreak');
  r = bo(U.both, `update public.staff_members set pin = '3333' where id = ${lit(T.ann)}`);
  ok(r.sqlstate === '23505' && /Dee D at Daybreak/.test(r.message), `a PIN used by Dee at Daybreak is refused with her name (${r.message})`);
  r = bo(U.both, `update public.staff_members set role = 'Manager' where id = ${lit(T.ann)}`);
  ok(till(`id = ${lit(a1?.pos_user_id)}`)[0].role === 'Server', 'the till role stays per site');
  r = bo(U.both, `select public.wf_till_add_site(${lit(T.ann)}, ${lit(DAY)})`);
  ok(r.sqlstate === '23505', 'a second till user at the same site is refused');

  console.log('3. a till user with a Workforce record');
  r = bo(U.both, `select public.wf_till_add_site(${lit(T.bo)}, ${lit(DAY)})`);
  const b1 = json(r);
  ok(r.status === 0 && b1?.staff_id, `Bo (with a Workforce record) gets both records at Daybreak (${r.message || 'ok'})`);
  ok(sql(`select count(*) from public.wf_staff where location_id = ${lit(DAY)} and name = 'Bo B' and person_id is not null`) === '1', 'his Daybreak Workforce record is linked');
  ok(sql(`select count(*) from public.staff_members where location_id = ${lit(DAY)} and name = 'Bo B' and pin = '2222'`) === '1', 'and his Daybreak till user has his PIN');

  console.log('4. the first clock in at the new site joins the person');
  // The clock (service role) makes Ann a Workforce record at Daybreak on her first clock in.
  r = as('service_role', `insert into public.wf_staff (org_id, location_id, name, status, pos_user_id) values (${lit(ORG)}, ${lit(DAY)}, 'Ann A', 'active', ${lit(a1?.pos_user_id)}) returning person_id`);
  const annPerson = sql(`select person_id from public.staff_members where id = ${lit(T.ann)}`);
  ok(r.status === 0 && r.out.split('\n').pop() === annPerson, `the new Daybreak record joins Ann (${r.message || r.out})`);
  // And Workforce, Set up on the POS (wf_staff_set_pos_user) at Provo later: that record joins too.
  sql(`insert into public.wf_staff (id, org_id, location_id, name, status) values (${lit(id('5a000000', 9))}, ${lit(ORG)}, ${lit(PROVO)}, 'Ann A', 'active')`);
  r = as('service_role', `select public.wf_staff_set_pos_user(${lit(id('5a000000', 9))}, ${lit(T.ann)}, 'test')`);
  ok(sql(`select coalesce(person_id::text, '-') from public.wf_staff where id = ${lit(id('5a000000', 9))}`) === annPerson, 'a record set up on the POS later joins too');

  console.log('5. Link and Unlink');
  r = bo(U.mgrProvo, `select public.wf_till_link(${lit(T.cy)}, ${lit(T.cyDay)})`);
  ok(r.sqlstate === '42501', 'a manager of Provo only cannot link a Daybreak till user');
  r = bo(U.both, `select public.wf_till_link(${lit(T.cy)}, ${lit(T.cyDay)})`);
  ok(r.status === 0 && json(r)?.ok, `Cy at Provo and Daybreak are linked (${r.message || 'ok'})`);
  const cyDay = till(`id = ${lit(T.cyDay)}`)[0];
  ok(cyDay.pin === '4444' && cyDay.name === 'Cy C' && cyDay.role === 'Kitchen', 'Daybreak takes the Provo PIN and name, keeps its till role');
  r = bo(U.both, `select public.wf_till_unlink(${lit(T.cyDay)})`);
  ok(r.status === 0 && till(`id = ${lit(T.cyDay)}`)[0].person_id === null, 'Unlink');
  bo(U.both, `update public.staff_members set pin = '4545' where id = ${lit(T.cy)}`);
  ok(till(`id = ${lit(T.cyDay)}`)[0].pin === '4444', 'a PIN change no longer copies');

  console.log('6. fences and rollback');
  r = bo(U.owner, `update public.staff_members set person_id = gen_random_uuid() where id = ${lit(T.dee)}`);
  ok(r.sqlstate === '42501', 'person_id is still never written from the API');
  const rb = psql({ args: ['-1', '-f', ROLLBACK] }).stdout.trim().split('\n').pop();
  ok(rb === '0|f', `rollback check row reads 0|f (got ${rb})`);
  ok(sql(`select count(*) from public.staff_members where person_id is not null`) !== '0', 'links stay');
  const re = psql({ args: ['-1', '-f', MIGRATION] }).stdout.trim().split('\n').pop();
  ok(re === '3|f|t|t', `the migration applies again (got ${re})`);
} finally {
  stop();
}
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
