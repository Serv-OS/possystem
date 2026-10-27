#!/usr/bin/env node
// run.mjs: proves 20261103a (team chat) on a local, throwaway PostgreSQL 17, before Peter runs it on
// the Ops database. It never connects to Supabase.
//
//   node supabase/tests/team_chat/run.mjs
//
// It starts its own cluster in a temp folder (initdb and pg_ctl from PATH or /opt/homebrew/bin),
// builds the live shape (schema.sql) and stops it at the end. Calls are made the way the API makes
// them: logged in as authenticator, SET ROLE anon, authenticated or service_role, the claims set.
// What it proves, in order:
//   1. the migration applies in one transaction, its check row reads as documented, the backfill
//      built a venue group per venue with the right people in it; a second run is refused;
//   2. no direct writes: anon and authenticated cannot insert, update or delete any chat table,
//      cannot run any chat function but the three read helpers, cannot read the hidden text;
//   3. reads: only members read a conversation (staff app logins matched through
//      wf_staff.portal_user_id, with no user_profiles row), anon reads nothing, a leaver and a
//      person with chat off read nothing, a Back Office manager reads their venue's group;
//   4. the company fence: company A can never read or write company B (every function, and the
//      foreign keys themselves);
//   5. the role rules: staff, manager and owner (groups, posting, announcements, DMs and the DM
//      setting, editing, moderation for their own venues, never about themselves, the owner's
//      typed reason, settings and word lists, export);
//   6. automatic membership: start, move, leave (the wf_staff trigger);
//   7. 50 people sending at the same moment, and one retry racing itself;
//   8. the moderation log is append only;
//   9. the ROLLBACK refuses while messages exist, then puts everything back, and the migration
//      applies again after it.
// Exit code 0 only when every check holds.

import { spawnSync, spawn } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..');
const MIGRATION = process.env.CHAT_MIGRATION || join(repo, 'supabase/migrations/20261103a_OPS_team_chat.sql');
const ROLLBACK = process.env.CHAT_ROLLBACK || join(repo, 'supabase/migrations/20261103a_OPS_team_chat_ROLLBACK.sql');
const EXPECT_CHECK = '11|53|3|f|f|6|0|t|3|t';

const bin = (name) => (existsSync(`/opt/homebrew/bin/${name}`) ? `/opt/homebrew/bin/${name}` : name);
const env = { ...process.env, LC_ALL: 'en_US.UTF-8', PGOPTIONS: '-c client_min_messages=warning' };
let failures = 0, passes = 0;
const ok = (cond, msg) => { if (cond) { passes++; console.log(`  ok   ${msg}`); } else { failures++; console.log(`  FAIL ${msg}`); } };

const port = process.env.CHAT_PGPORT || String(55600 + Math.floor(Math.random() * 80));
const dir = mkdtempSync(join(tmpdir(), 'pgc.'));
const data = join(dir, 'data');
{
  let r = spawnSync(bin('initdb'), ['-D', data, '-U', 'postgres', '--auth=trust', '-E', 'UTF8'], { env, encoding: 'utf8' });
  if (r.status !== 0) { console.error(r.stderr || r.stdout); process.exit(2); }
  r = spawnSync(bin('pg_ctl'), ['-D', data, '-l', join(dir, 'pg.log'), '-w', '-o', `-p ${port} -c listen_addresses='' -k ${dir} -c timezone=UTC -c max_connections=200`, 'start'], { env, encoding: 'utf8' });
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
const arr = (xs) => `array[${xs.map(lit).join(',')}]::uuid[]`;

const id = (p, n) => `${p}-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ORG_A = id('0a000000', 1), ORG_B = id('0b000000', 1);
const LA1 = id('a0000000', 1), LA2 = id('a0000000', 2), LB = id('b0000000', 1);
const U = { a1: id('10000000', 1), a2: id('10000000', 2), a3: id('10000000', 3), a4: id('10000000', 4), a5: id('10000000', 5), b1: id('10000000', 6),
  mA1: id('20000000', 1), mA2: id('20000000', 2), oA: id('20000000', 3), mB: id('20000000', 4), oB: id('20000000', 5), anonUser: id('30000000', 1) };
const S = { a1: id('c0000000', 1), a2: id('c0000000', 2), a3: id('c0000000', 3), a4: id('c0000000', 4), a5: id('c0000000', 5), b1: id('c0000000', 6) };
const EXTRA = Array.from({ length: 50 }, (_, i) => id('c0000000', 100 + i));

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
const fn = (name, ...args) => json(`select public.${name}(${args.join(', ')})`);
const read = (sub, q) => as('authenticated', q, { sub });
// A Manager app call: team-chat sends the PIN holder and the paired venue as request headers.
let mpHudds = null;
function MP_HUDDS() {
  if (mpHudds) return mpHudds;
  const SM2 = id('d0000000', 2), SP2 = id('c0000000', 801);
  sql(`insert into public.staff_members (id, location_id, org_id, name, role, pin) values (${lit(SM2)}, ${lit(id('a0000000', 2))}, ${lit(id('0a000000', 1))}, 'Hal Till', 'Manager', '5555');
       insert into public.wf_staff (id, org_id, location_id, name, role_key, pos_user_id) values (${lit(SP2)}, ${lit(id('0a000000', 1))}, ${lit(id('a0000000', 2))}, 'Hal Till', 'bar', ${lit(SM2)})`);
  mpHudds = sql(`select id from public.chat_profiles where staff_id = ${lit(SP2)}`);
  return mpHudds;
}
const fnPin = (member, loc, name, ...args) => JSON.parse(as('service_role',
  `select set_config('request.headers', ${lit(JSON.stringify({ 'x-chat-pin-member': member, 'x-chat-pin-location': loc }))}, true) \\g /dev/null\nselect public.${name}(${args.join(', ')})`).out || 'null');

function concurrent(body) {
  return new Promise((resolve) => {
    const input = ['begin;', `select set_config('request.jwt.claims', '{"role":"service_role"}', true) \\g /dev/null`, 'set local role service_role;', body.trim().replace(/;?$/, ';'), 'commit;'].join('\n') + '\n';
    const p = spawn(bin('psql'), psqlArgs('authenticator'), { env });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => resolve({ code, out: out.trim(), err }));
    p.stdin.end(input);
  });
}

try {
  console.log('schema');
  psql({ args: ['-1', '-f', join(here, 'schema.sql')] });
  sql(`insert into public.organisations values (${lit(ORG_A)}, 'Mozz'), (${lit(ORG_B)}, 'Other Co');
       insert into public.locations (id, org_id, name) values (${lit(LA1)}, ${lit(ORG_A)}, 'Leeds'), (${lit(LA2)}, ${lit(ORG_A)}, 'Hudds'), (${lit(LB)}, ${lit(ORG_B)}, 'Provo');
       insert into public.user_profiles (id, org_id, role, full_name) values (${lit(U.mA1)}, ${lit(ORG_A)}, 'manager', 'Mo Leeds'), (${lit(U.mA2)}, ${lit(ORG_A)}, 'manager', 'Max Hudds'),
         (${lit(U.oA)}, ${lit(ORG_A)}, 'owner', 'Olive Owner'), (${lit(U.mB)}, ${lit(ORG_B)}, 'manager', 'Bea B'), (${lit(U.oB)}, ${lit(ORG_B)}, 'owner', 'Otto B');
       insert into public.user_locations (user_id, location_id, role) values (${lit(U.mA1)}, ${lit(LA1)}, 'manager'), (${lit(U.mA2)}, ${lit(LA2)}, 'manager'),
         (${lit(U.oA)}, ${lit(LA1)}, 'owner'), (${lit(U.mB)}, ${lit(LB)}, 'manager'), (${lit(U.oB)}, ${lit(LB)}, 'owner');
       insert into public.wf_staff (id, org_id, location_id, name, role_key, status, venue_ids, portal_user_id) values
         (${lit(S.a1)}, ${lit(ORG_A)}, ${lit(LA1)}, 'Cara C', 'bar', 'active', '{}', ${lit(U.a1)}),
         (${lit(S.a2)}, ${lit(ORG_A)}, ${lit(LA1)}, 'Dev D', 'kitchen', 'active', '{}', ${lit(U.a2)}),
         (${lit(S.a3)}, ${lit(ORG_A)}, ${lit(LA2)}, 'Quinn Q', 'bar', 'active', array[${lit(LA1)}]::uuid[], ${lit(U.a3)}),
         (${lit(S.a4)}, ${lit(ORG_A)}, ${lit(LA1)}, 'Lee L', 'bar', 'leaver', '{}', ${lit(U.a4)}),
         (${lit(S.a5)}, ${lit(ORG_A)}, ${lit(LA2)}, 'Pat P', 'bar', 'active', '{}', ${lit(U.a5)}),
         (${lit(S.b1)}, ${lit(ORG_B)}, ${lit(LB)}, 'Xan X', 'bar', 'active', '{}', ${lit(U.b1)})
         ${EXTRA.map((e, i) => `, (${lit(e)}, ${lit(ORG_A)}, ${lit(LA1)}, 'Extra ${i}', 'bar', 'active', '{}', ${lit(id('40000000', i))})`).join('')};`);

  console.log('1. the migration');
  const mig = psql({ args: ['-1', '-f', MIGRATION] });
  const check = mig.stdout.trim().split('\n').pop();
  ok(check === EXPECT_CHECK, `check row as documented (${check})`);
  const again = psql({ args: ['-1', '-f', MIGRATION], allowFail: true });
  ok(again.status !== 0 && /has run already/.test(again.stderr), 'a second run is refused');
  ok(sql(`select count(*) from pg_indexes where indexname in ('chat_messages_reply_to', 'chat_reports_message')`) === '2', 'review fix S6: reply and report lookups are indexed');
  const raw = readFileSync(MIGRATION, 'utf8') + readFileSync(ROLLBACK, 'utf8');
  ok([...raw].every((c) => c.charCodeAt(0) < 128) && !raw.includes('!'), 'both files are ASCII and carry no exclamation mark');

  const M = (staffId) => sql(`select id from public.chat_profiles where staff_id = ${lit(staffId)}`);
  const MA = { a1: M(S.a1), a2: M(S.a2), a3: M(S.a3), a5: M(S.a5), b1: M(S.b1) };
  const venue = (loc) => sql(`select id from public.chat_conversations where kind = 'venue' and location_id = ${lit(loc)}`);
  const V1 = venue(LA1), V2 = venue(LA2), VB = venue(LB);
  const members = (conv) => Number(sql(`select count(*) from public.chat_members where conversation_id = ${lit(conv)} and left_at is null`));
  ok(V1 && V2 && VB, 'the backfill made a venue group for each of the three venues');
  ok(members(V1) === 53, `Leeds group: Cara, Dev, Quinn (works at both) and the 50 extras, not the leaver (${members(V1)})`);
  ok(members(V2) === 2 && members(VB) === 1, 'Hudds group: Quinn and Pat; Provo group: Xan');
  ok(sql(`select count(*) from public.chat_profiles where staff_id = ${lit(S.a4)}`) === '0', 'the leaver has no chat profile');

  // Back Office logins get a profile on first use (the edge function), then the sync makes managers admins.
  const office = (org, uid, name) => fn('chat_profile_for', lit(org), 'null', lit(uid), lit(name));
  const MO = { mA1: office(ORG_A, U.mA1, 'Mo Leeds').member_id, mA2: office(ORG_A, U.mA2, 'Max Hudds').member_id, oA: office(ORG_A, U.oA, 'Olive').member_id,
    mB: office(ORG_B, U.mB, 'Bea').member_id, oB: office(ORG_B, U.oB, 'Otto').member_id };
  ok(office(ORG_B, U.mA1, 'Mo').ok === false, 'a Back Office login cannot get a profile in a company it has no venue in');
  ok(fn('chat_profile_for', lit(ORG_B), lit(S.a1), 'null', 'null').ok === false, 'a staff member cannot get a profile in another company');
  fn('chat_sync_org', lit(ORG_A)); fn('chat_sync_org', lit(ORG_B));
  ok(sql(`select role from public.chat_members where conversation_id = ${lit(V1)} and member_id = ${lit(MO.mA1)}`) === 'admin', 'the Leeds manager is an admin of the Leeds group');
  ok(sql(`select count(*) from public.chat_members where conversation_id = ${lit(V2)} and member_id = ${lit(MO.mA1)}`) === '0', 'and not in the Hudds group');
  ok(fn('chat_whoami', lit(MA.a1)).level === 'staff' && fn('chat_whoami', lit(MO.mA1)).level === 'manager' && fn('chat_whoami', lit(MO.oA)).level === 'owner', 'levels: staff, manager, owner');

  console.log('2. no direct writes');
  for (const t of ['chat_messages', 'chat_conversations', 'chat_members', 'chat_reactions', 'chat_profiles', 'chat_settings', 'chat_reports', 'chat_moderation_log', 'chat_person_state', 'push_devices', 'chat_word_lists']) {
    const ins = read(U.a1, `insert into public.${t} default values`);
    const upd = read(U.a1, `update public.${t} set org_id = org_id`);
    const del = read(U.a1, `delete from public.${t}`);
    ok(ins.sqlstate === '42501' && upd.sqlstate === '42501' && del.sqlstate === '42501', `authenticated cannot insert, update or delete ${t}`);
    const an = as('anon', `select count(*) from public.${t}`);
    const ai = as('anon', `insert into public.${t} default values`);
    ok(an.sqlstate === '42501' && ai.sqlstate === '42501', `anon cannot read or write ${t}`);
  }
  for (const t of ['chat_reports', 'chat_moderation_log', 'chat_person_state', 'push_devices', 'chat_word_lists']) {
    ok(read(U.a1, `select count(*) from public.${t}`).sqlstate === '42501', `a staff login cannot read ${t}`);
  }
  ok(read(U.a1, 'select original_body from public.chat_messages').sqlstate === '42501' && read(U.a1, 'select removed_body from public.chat_messages').sqlstate === '42501',
    'the edited and removed text cannot be read through the API');
  ok(read(U.a1, 'select staff_id from public.chat_profiles').sqlstate === '42501', 'nor which staff record or login a profile is');
  ok(read(U.a1, 'select * from public.chat_messages').sqlstate === '42501', 'select * on messages is refused (the apps list their columns)');
  ok(read(U.a1, `select ${readFileSync(join(repo, 'src/staff/chatModel.js'), 'utf8').match(/MSG_COLUMNS = '([^']+)'/)[1]} from public.chat_messages`).status === 0, 'the columns the staff app lists are readable');
  const sendSql = `select public.chat_send(${lit(MA.a1)}, ${lit(V1)}, 'hi', '[]', null, false, null, '{}')`;
  ok(read(U.a1, sendSql).sqlstate === '42501' && as('anon', sendSql).sqlstate === '42501', 'neither anon nor a login can run chat_send itself');
  ok(read(U.a1, `select public.chat_sync_org(${lit(ORG_A)})`).sqlstate === '42501', 'nor the sync');
  ok(as('anon', 'select * from public.chat_my_conversation_ids()').sqlstate === '42501', 'anon cannot run the read helpers');

  console.log('3. reads, members only');
  const m1 = fn('chat_send', lit(MA.a1), lit(V1), lit('Morning all'), "'[]'", 'null', 'false', 'null', "'{}'");
  ok(m1.ok === true && m1.message.id, 'Cara posts in the Leeds group');
  const cnt = (sub, q) => read(sub, q).out;
  ok(cnt(U.a1, 'select count(*) from public.chat_messages') === '1', 'Cara reads it');
  ok(cnt(U.a3, 'select count(*) from public.chat_messages') === '1', 'Quinn (Hudds, also works at Leeds) reads it');
  ok(cnt(U.a5, 'select count(*) from public.chat_messages') === '0', 'Pat (Hudds only) does not');
  ok(cnt(U.b1, 'select count(*) from public.chat_messages') === '0', 'Xan (the other company) does not');
  ok(cnt(U.anonUser, 'select count(*) from public.chat_messages') === '0', 'a login with no profile (an anonymous sign in) reads nothing');
  ok(cnt(U.a4, 'select count(*) from public.chat_messages') === '0', 'the leaver reads nothing');
  ok(cnt(U.mA1, 'select count(*) from public.chat_messages') === '1', 'the Leeds manager (Back Office login) reads it');
  ok(cnt(U.mA2, 'select count(*) from public.chat_messages') === '0', 'the Hudds manager does not');
  ok(cnt(U.a1, 'select count(*) from public.chat_conversations') === '1' && cnt(U.a3, 'select count(*) from public.chat_conversations') === '2', 'conversations: Cara sees one, Quinn two');
  ok(cnt(U.a1, `select count(*) from public.chat_profiles where org_id = ${lit(ORG_B)}`) === '0' && Number(cnt(U.a1, 'select count(*) from public.chat_profiles')) > 50, 'profiles: names of her own company only');
  ok(cnt(U.b1, `select count(*) from public.chat_members where conversation_id = ${lit(V1)}`) === '0', 'the other company cannot list the Leeds members');

  console.log('4. the company fence');
  ok(fn('chat_send', lit(MA.b1), lit(V1), lit('hello from B'), "'[]'", 'null', 'false', 'null', "'{}'").code === 'not_found', 'B cannot post in an A group');
  ok(fn('chat_dm_open', lit(MA.b1), lit(MA.a1)).code === 'not_found', 'B cannot open a DM with A');
  ok(fn('chat_report', lit(MA.b1), m1.message.id, lit('x')).code === 'not_found', 'B cannot report an A message');
  ok(fn('chat_react', lit(MA.b1), m1.message.id, lit('x'), 'true').code === 'not_found', 'B cannot react to an A message');
  ok(fn('chat_edit', lit(MA.b1), m1.message.id, lit('x')).code === 'not_found', 'B cannot edit an A message');
  ok(fn('chat_delete', lit(MA.b1), m1.message.id).code === 'not_found', 'B cannot delete an A message');
  ok(fn('chat_mod', lit(MO.oB), lit('hide'), 'null', m1.message.id, 'null', 'null', 'null', 'null').code === 'not_found', 'B owner cannot hide an A message');
  ok(fn('chat_mod', lit(MO.oB), lit('chat_off'), 'null', 'null', lit(MA.a1), 'null', 'null', 'null').code === 'not_found', 'B owner cannot switch chat off for an A person');
  ok(fn('chat_group_create', lit(MO.oA), lit('group'), lit('Mixed'), 'null', 'null', 'null', 'null', arr([MA.a1, MA.b1])).code === 'cross_company', 'a group cannot include someone from B');
  ok(fn('chat_members_change', lit(MO.mA1), lit(V1), lit('admin'), arr([MA.b1])).code === 'cross_company', 'B people cannot be added or promoted in A');
  ok(fn('chat_group_update', lit(MO.oB), lit(V1), `'{"name":"pwned"}'`).code === 'not_found', 'B owner cannot rename an A group');
  ok(fn('chat_read', lit(MA.b1), lit(V1), m1.message.id).code === 'not_found', 'B cannot mark A messages read');
  ok(fn('chat_group_create', lit(MO.mB), lit('announce'), lit('x'), 'null', lit(LA1), 'null', 'null', "'{}'").code === 'not_found', 'B manager cannot make an announcement group at an A venue');
  ok(fn('chat_export_person', lit(MO.oB), lit(MA.a1), lit('subject access request')).code === 'not_found', 'B owner cannot export an A person');
  const fk1 = as('postgres', `insert into public.chat_members (conversation_id, member_id, org_id) values (${lit(V1)}, ${lit(MA.b1)}, ${lit(ORG_A)})`);
  const fk2 = as('postgres', `insert into public.chat_messages (org_id, conversation_id, sender_member_id, body) values (${lit(ORG_B)}, ${lit(V1)}, ${lit(MA.b1)}, 'x')`);
  ok(fk1.sqlstate === '23503' && fk2.sqlstate === '23503', 'even a direct database write cannot link rows of two companies (foreign keys on id and company)');

  console.log('5. the role rules');
  ok(fn('chat_group_create', lit(MA.a1), lit('group'), lit('Bar team'), 'null', 'null', 'null', 'null', arr([MA.a2])).code === 'not_allowed', 'staff cannot make a group (default: managers)');
  ok(fn('chat_settings_save', lit(MA.a1), `'{"groups_by":"everyone"}'`).code === 'not_allowed', 'staff cannot change settings');
  ok(fn('chat_settings_save', lit(MO.mA1), `'{"groups_by":"everyone"}'`).code === 'not_allowed', 'a manager cannot change settings');
  ok(fn('chat_settings_save', lit(MO.oA), `'{"keep_years":9}'`).code === 'bad_setting', 'a bad setting is refused');
  ok(fn('chat_settings_save', lit(MO.oA), `'{"groups_by":"everyone"}'`).ok === true, 'the owner opens groups to everyone');
  ok(cnt(U.a1, 'select groups_by from public.chat_settings') === 'everyone' && cnt(U.b1, 'select count(*) from public.chat_settings') === '0', 'staff of the company read the setting, the other company does not');
  const g1 = fn('chat_group_create', lit(MA.a1), lit('group'), lit('Bar team'), 'null', 'null', 'null', 'null', arr([MA.a2, MA.a3]));
  ok(g1.ok === true, 'now staff can make a group');
  ok(cnt(U.a5, `select count(*) from public.chat_conversations where id = ${lit(g1.conversation_id)}`) === '0' && cnt(U.a2, `select count(*) from public.chat_conversations where id = ${lit(g1.conversation_id)}`) === '1', 'only its members see it');
  ok(fn('chat_group_create', lit(MA.a1), lit('announce'), lit('News'), 'null', lit(LA1), 'null', 'null', "'{}'").code === 'not_allowed', 'staff cannot make an announcement group');
  ok(fn('chat_group_create', lit(MO.mA1), lit('announce'), lit('News'), 'null', lit(LA2), 'null', 'null', "'{}'").code === 'not_allowed', 'a manager cannot make one for another venue');
  ok(fn('chat_group_create', lit(MO.mA1), lit('announce'), lit('News'), 'null', 'null', 'null', 'null', "'{}'").code === 'not_allowed', 'nor a company wide one');
  const ann = fn('chat_group_create', lit(MO.mA1), lit('announce'), lit('Leeds news'), 'null', lit(LA1), 'null', 'null', "'{}'");
  ok(ann.ok === true && members(ann.conversation_id) === 55, `the Leeds manager makes Leeds announcements; everyone at Leeds is in it, the manager and the owner as admins (${members(ann.conversation_id)})`);
  ok(fn('chat_send', lit(MA.a1), lit(ann.conversation_id), lit('can I post'), "'[]'", 'null', 'false', 'null', "'{}'").code === 'admins_only', 'staff cannot post announcements');
  ok(fn('chat_send', lit(MA.a1), lit(V1), lit('urgent'), "'[]'", 'null', 'true', 'null', "'{}'").code === 'urgent_not_allowed', 'nor mark anything urgent');
  const urg = fn('chat_send', lit(MO.mA1), lit(ann.conversation_id), lit('Fire drill at 3'), "'[]'", 'null', 'true', 'null', "'{}'");
  ok(urg.ok === true && urg.message.urgent === true, 'the manager posts an urgent announcement');
  const pos = fn('chat_group_create', lit(MO.oA), lit('position'), lit('All bartenders'), 'null', 'null', lit('bar'), 'null', "'{}'");
  ok(pos.ok === true && members(pos.conversation_id) === 54, `the owner makes a company wide position group: every bartender plus the owner (${members(pos.conversation_id)})`);
  ok(fn('chat_leave', lit(MA.a1), lit(V1)).code === 'automatic' && fn('chat_members_change', lit(MO.mA1), lit(V1), lit('remove'), arr([MA.a2])).code === 'automatic', 'nobody leaves or is taken out of a venue group by hand');

  // DMs and the DM setting.
  const dm = fn('chat_dm_open', lit(MA.a1), lit(MA.a2));
  ok(dm.ok === true && fn('chat_dm_open', lit(MA.a2), lit(MA.a1)).conversation_id === dm.conversation_id, 'one DM per pair');
  const dmMsg = fn('chat_send', lit(MA.a1), lit(dm.conversation_id), lit('you free saturday'), "'[]'", 'null', 'false', 'null', "'{}'");
  ok(cnt(U.mA1, `select count(*) from public.chat_messages where conversation_id = ${lit(dm.conversation_id)}`) === '0', 'a DM is private: the manager cannot read it');
  ok(cnt(U.oA, `select count(*) from public.chat_messages where conversation_id = ${lit(dm.conversation_id)}`) === '0', 'nor the owner, through the API');
  fn('chat_settings_save', lit(MO.oA), `'{"dm_scope":"venue"}'`);
  ok(fn('chat_dm_open', lit(MA.a1), lit(MA.a5)).code === 'dm_scope', 'same venue only: Cara (Leeds) cannot DM Pat (Hudds)');
  ok(fn('chat_dm_open', lit(MA.a1), lit(MA.a3)).ok === true, 'but can DM Quinn, who also works at Leeds');
  fn('chat_settings_save', lit(MO.oA), `'{"dm_scope":"off"}'`);
  ok(fn('chat_dm_open', lit(MA.a2), lit(MA.a3)).code === 'dm_off', 'DMs off: staff cannot start one');
  ok(fn('chat_dm_open', lit(MO.mA1), lit(MA.a5)).ok === true, 'a manager still can');
  fn('chat_settings_save', lit(MO.oA), `'{"dm_scope":"company"}'`);

  // Editing and deleting.
  const e1 = fn('chat_edit', lit(MA.a1), m1.message.id, lit('Morning everyone'));
  ok(e1.ok === true && e1.message.edited_at && e1.message.original_body === undefined, 'the sender edits within 15 minutes; the old text is not handed back');
  ok(fn('chat_edit', lit(MA.a2), m1.message.id, lit('hacked')).code === 'not_yours', 'nobody else can edit it');
  sql(`update public.chat_messages set created_at = now() - interval '16 minutes' where id = ${m1.message.id}`);
  ok(fn('chat_edit', lit(MA.a1), m1.message.id, lit('later')).code === 'too_late', 'after 15 minutes it cannot be edited');
  {
    const fresh = fn('chat_send', lit(MA.a2), lit(V1), lit('typo here'), "'[]'", 'null', 'false', 'null', "'{}'");
    sql(`insert into public.chat_person_state (member_id, org_id, muted_until) values (${lit(MA.a2)}, ${lit(ORG_A)}, now() + interval '1 hour')`);
    ok(fn('chat_edit', lit(MA.a2), fresh.message.id, lit('typo fixed')).code === 'muted', 'review fix S8: a muted person cannot edit either');
    sql(`update public.chat_person_state set muted_until = null, chat_off = true where member_id = ${lit(MA.a2)}`);
    ok(fn('chat_edit', lit(MA.a2), fresh.message.id, lit('typo fixed')).code === 'chat_off', 'nor someone with chat off');
    sql(`delete from public.chat_person_state where member_id = ${lit(MA.a2)}`);
    sql(`update public.chat_conversations set archived_at = now() where id = ${lit(V1)}`);
    ok(fn('chat_edit', lit(MA.a2), fresh.message.id, lit('typo fixed')).code === 'archived', 'nor in a closed chat');
    sql(`update public.chat_conversations set archived_at = null where id = ${lit(V1)}`);
    ok(fn('chat_edit', lit(MA.a2), fresh.message.id, lit('typo fixed')).ok === true, 'otherwise the edit goes through');
  }
  ok(fn('chat_delete', lit(MA.a2), m1.message.id).code === 'not_yours', 'nobody else can delete it');
  const d1 = fn('chat_delete', lit(MA.a1), dmMsg.message.id);
  ok(d1.ok === true && d1.message.body === '' && d1.message.deleted_at, 'the sender deletes their own message: the text is gone for everyone');
  ok(sql(`select removed_body from public.chat_messages where id = ${dmMsg.message.id}`) === 'you free saturday', 'and kept for the server only');

  // Reacting, reading, muting.
  ok(fn('chat_react', lit(MA.a3), m1.message.id, lit('thumbs'), 'true').ok === true && cnt(U.a1, 'select count(*) from public.chat_reactions') === '1', 'a member reacts; members see it');
  ok(fn('chat_react', lit(MA.a5), m1.message.id, lit('thumbs'), 'true').code === 'not_member', 'a non member cannot react');
  ok(fn('chat_read', lit(MA.a3), lit(V1), m1.message.id).ok === true, 'reading moves the read marker');
  ok(fn('chat_mute', lit(MA.a3), lit(V1), `now() + interval '1 hour'`).ok === true, 'a person mutes a group for themselves');

  // Reports and moderation.
  const bad = fn('chat_send', lit(MA.a2), lit(V1), lit('you are useless'), "'[]'", 'null', 'false', 'null', "'{}'");
  ok(fn('chat_report', lit(MA.a2), bad.message.id, lit('mine')).code === 'own_message', 'nobody reports their own message');
  const rep = fn('chat_report', lit(MA.a1), bad.message.id, lit('rude'));
  ok(rep.ok === true && fn('chat_report', lit(MA.a1), bad.message.id, lit('again')).report_id === rep.report_id, 'Cara reports it (once)');
  ok(fn('chat_mod', lit(MA.a3), lit('hide'), lit(rep.report_id), 'null', 'null', 'null', 'null', 'null').code === 'not_allowed', 'staff cannot moderate');
  ok(fn('chat_report_context', lit(MA.a3), lit(rep.report_id)).code === 'not_allowed', 'nor see a report');
  ok(fn('chat_mod', lit(MO.mA2), lit('hide'), lit(rep.report_id), 'null', 'null', 'null', 'null', 'null').code === 'not_allowed', 'the Hudds manager cannot handle a Leeds report');
  const ctx = fn('chat_report_context', lit(MO.mA1), lit(rep.report_id));
  ok(ctx.ok === true && ctx.messages.length >= 2 && ctx.messages.length <= 11, `the Leeds manager sees the message and those around it (${ctx.messages?.length})`);
  const hid = fn('chat_mod', lit(MO.mA1), lit('hide'), lit(rep.report_id), 'null', 'null', 'null', 'null', lit('not on'));
  ok(hid.ok === true && sql(`select status || '|' || body from public.chat_messages where id = ${bad.message.id}`) === 'hidden|', 'the Leeds manager hides it: the text is gone for everyone');
  ok(sql(`select status from public.chat_reports where id = ${lit(rep.report_id)}`) === 'hidden', 'the report is closed as hidden');
  ok(fn('chat_mod', lit(MO.oA), lit('keep'), lit(rep.report_id), 'null', 'null', 'null', 'null', 'null').ok === true
    && sql(`select status || '|' || body from public.chat_messages where id = ${bad.message.id}`) === 'visible|you are useless', 'the owner keeps it after all: the message comes back');
  // A manager cannot handle a report about themselves.
  const mm = fn('chat_send', lit(MO.mA1), lit(V1), lit('shift swap sorted'), "'[]'", 'null', 'false', 'null', "'{}'");
  const rep2 = fn('chat_report', lit(MA.a1), mm.message.id, lit('about the manager'));
  ok(fn('chat_mod', lit(MO.mA1), lit('hide'), lit(rep2.report_id), 'null', 'null', 'null', 'null', 'null').code === 'own_report', 'a manager cannot handle a report about themselves');
  ok(fn('chat_report_context', lit(MO.mA1), lit(rep2.report_id)).code === 'own_report', 'nor read it');
  ok(fn('chat_mod', lit(MO.oA), lit('keep'), lit(rep2.report_id), 'null', 'null', 'null', 'null', 'null').ok === true, 'the owner can');
  ok(fn('chat_mod', lit(MO.mA1), lit('mute_person'), 'null', 'null', lit(MO.oA), 'null', 'null', 'null').code === 'not_allowed', 'a manager cannot mute an owner');
  // Muting a person and chat off.
  ok(fn('chat_mod', lit(MO.mA1), lit('mute_person'), 'null', 'null', lit(MA.a2), 'null', `now() + interval '1 hour'`, lit('cool off')).ok === true, 'the manager mutes Dev for an hour');
  ok(fn('chat_send', lit(MA.a2), lit(V1), lit('hello?'), "'[]'", 'null', 'false', 'null', "'{}'").code === 'muted', 'Dev cannot post while muted');
  ok(cnt(U.a2, 'select count(*) from public.chat_messages') !== '0', 'but still reads');
  ok(fn('chat_mod', lit(MO.mA1), lit('mute_person'), 'null', 'null', lit(MA.a5), 'null', 'null', 'null').code === 'not_allowed', 'the Leeds manager cannot mute Pat (Hudds only)');
  // Review fix S1: who a moderation is about comes from the database, never the caller (X1 to X4).
  {
    const om = fn('chat_send', lit(MO.oA), lit(V1), lit('owner says hi'), "'[]'", 'null', 'false', 'null', "'{}'");
    const x1 = fn('chat_mod', lit(MO.mA1), lit('hide'), 'null', om.message.id, lit(MA.a1), 'null', 'null', 'null');
    ok(x1.code === 'mismatch' && sql(`select status from public.chat_messages where id = ${om.message.id}`) === 'visible', 'X1: a manager cannot hide the owner\'s message by naming someone else');
    ok(fn('chat_mod', lit(MO.mA1), lit('hide'), 'null', om.message.id, 'null', 'null', 'null', 'null').code === 'not_allowed', 'nor plainly (managers never moderate an owner)');
    ok(fn('chat_mod', lit(MO.mA1), lit('chat_off'), 'null', 'null', lit(MA.a5), lit(V1), 'null', 'null').code === 'not_allowed'
      && sql(`select count(*) from public.chat_person_state where member_id = ${lit(MA.a5)} and chat_off`) === '0', 'X2: naming his own venue\'s group does not let the Leeds manager switch Pat (Hudds) off');
    ok(fn('chat_mod', lit(MO.mA1), lit('chat_off'), 'null', 'null', lit(MO.mA2), lit(V1), 'null', 'null').code === 'not_allowed', 'X3: nor the Hudds manager');
    ok(fn('chat_mod', lit(MO.mA1), lit('mute_person'), 'null', 'null', lit(MA.a3), lit(V1), 'null', 'null').ok === true, 'he still mutes Quinn, who works at Leeds too');
    fn('chat_mod', lit(MO.mA1), lit('unmute_person'), 'null', 'null', lit(MA.a3), 'null', 'null', 'null');
    const mmx = fn('chat_send', lit(MO.mA1), lit(V1), lit('manager rant'), "'[]'", 'null', 'false', 'null', "'{}'");
    const repx = fn('chat_report', lit(MA.a1), mmx.message.id, lit('about the manager'));
    fn('chat_mod', lit(MO.oA), lit('hide'), lit(repx.report_id), 'null', 'null', 'null', 'null', 'null');
    const x4 = fn('chat_mod', lit(MO.mA1), lit('keep'), lit(repx.report_id), 'null', lit(MA.a1), 'null', 'null', 'null');
    ok(x4.code === 'mismatch' && sql(`select status from public.chat_reports where id = ${lit(repx.report_id)}`) === 'hidden', 'X4: a manager cannot keep a report about himself by naming someone else');
    ok(fn('chat_mod', lit(MO.mA1), lit('keep'), lit(repx.report_id), 'null', 'null', 'null', 'null', 'null').code === 'own_report', 'nor plainly');
    ok(fn('chat_mod', lit(MO.mA1), lit('hide'), lit(repx.report_id), String(m1.message.id), 'null', 'null', 'null', 'null').code === 'mismatch', 'a report with a different message is refused');
    ok(fn('chat_mod', lit(MO.mA2), lit('remove'), 'null', 'null', lit(MA.a1), lit(VB), 'null', 'null').code === 'not_found', 'remove: never a group of another company');
    fn('chat_mod', lit(MO.oA), lit('keep'), lit(repx.report_id), 'null', 'null', 'null', 'null', 'null');
  }
  ok(fn('chat_mod', lit(MO.mA1), lit('chat_off'), 'null', 'null', lit(MA.a2), 'null', 'null', lit('investigation')).ok === true, 'chat off for Dev');
  ok(cnt(U.a2, 'select count(*) from public.chat_messages') === '0' && fn('chat_send', lit(MA.a2), lit(V1), lit('x'), "'[]'", 'null', 'false', 'null', "'{}'").code === 'chat_off', 'Dev now reads and sends nothing');
  fn('chat_mod', lit(MO.mA1), lit('chat_on'), 'null', 'null', lit(MA.a2), 'null', 'null', 'null');
  fn('chat_mod', lit(MO.mA1), lit('unmute_person'), 'null', 'null', lit(MA.a2), 'null', 'null', 'null');
  ok(cnt(U.a2, 'select count(*) from public.chat_messages') !== '0', 'chat back on: Dev reads again');
  // Owner opens a DM.
  ok(fn('chat_owner_open_dm', lit(MO.mA1), lit(dm.conversation_id), lit('long enough reason'), 'null', '50').code === 'not_allowed', 'a manager cannot open a DM');
  ok(fn('chat_owner_open_dm', lit(MO.oA), lit(dm.conversation_id), lit('why'), 'null', '50').code === 'reason_required', 'the owner must type a reason');
  const od = fn('chat_owner_open_dm', lit(MO.oA), lit(dm.conversation_id), lit('grievance raised by Dev, HR case 12'), 'null', '50');
  ok(od.ok === true && od.messages.length === 1, 'with a reason the owner opens it');
  ok(sql(`select count(*) from public.chat_moderation_log where action = 'owner.open_dm' and reason like 'grievance%'`) === '1', 'and the reason is logged');
  // Group admin rules.
  ok(fn('chat_group_update', lit(MA.a2), lit(g1.conversation_id), `'{"name":"Renamed"}'`).code === 'not_allowed', 'a plain member cannot rename a group');
  ok(fn('chat_group_update', lit(MA.a1), lit(g1.conversation_id), `'{"name":"Bar crew"}'`).ok === true, 'its admin can');
  ok(fn('chat_members_change', lit(MA.a1), lit(g1.conversation_id), lit('add'), arr([MA.a5])).ok === true && members(g1.conversation_id) === 4, 'its admin adds Pat');
  ok(fn('chat_leave', lit(MA.a5), lit(g1.conversation_id)).ok === true && members(g1.conversation_id) === 3, 'Pat leaves');
  ok(fn('chat_group_update', lit(MA.a1), lit(g1.conversation_id), `'{"archived":true}'`).ok === true
    && fn('chat_send', lit(MA.a1), lit(g1.conversation_id), lit('x'), "'[]'", 'null', 'false', 'null', "'{}'").code === 'archived', 'an archived group takes no messages');
  // Words, export, phones, photos.
  ok(fn('chat_words_save', lit(MO.mA1), lit('block'), `array['pineapple']`).code === 'not_allowed', 'a manager cannot change the word lists');
  ok(fn('chat_words_save', lit(MO.oA), lit('block'), `array['pineapple', 'Pineapple ', 'anchovy']`).count === 2, 'the owner saves a block list (duplicates folded)');
  ok(fn('chat_export_person', lit(MO.mA1), lit(MA.a1), lit('subject access request')).code === 'not_allowed', 'a manager cannot export a person');
  const ex = fn('chat_export_person', lit(MO.oA), lit(MA.a1), lit('subject access request'));
  ok(ex.ok === true && ex.messages.some((m) => m.text === 'you free saturday'), 'the owner exports everything Cara wrote, deleted text included');
  ok(fn('chat_push_register', lit(MA.a1), lit('webpush'), lit('https://push.example/abc123'), `'{"keys":{}}'`, 'null', lit('web')).ok === true, 'a phone registers for push');
  ok(fn('chat_push_register', lit(MA.a1), lit('apns'), lit('ab'.repeat(32)), 'null', lit('sandbox'), lit('staff')).ok === true
    && sql(`select environment from public.push_devices where token = '${'ab'.repeat(32)}'`) === 'sandbox', 'an Xcode build registers with the sandbox environment kept');
  ok(fn('chat_push_register', lit(MA.a1), lit('apns'), lit('cd'.repeat(32)), 'null', lit('beta'), lit('staff')).code === 'bad_device', 'an unknown environment is refused');
  ok(fn('chat_push_register', lit(MA.a1), lit('apns'), lit('ef'.repeat(32)), 'null', lit('production'), lit('manager')).code === 'bad_device', 'review fix A3: no push on the Manager app (shared venue devices)');
  ok(fn('chat_push_unregister', lit(MA.b1), lit('apns'), lit('ab'.repeat(32))).removed === 0, 'signing out forgets only your own phone');
  sql(`insert into public.push_devices (org_id, member_id, platform, token, app) values (${lit(ORG_A)}, ${lit(MA.a1)}, 'apns', '${'99'.repeat(32)}', 'manager')`);
  ok(fn('chat_send', lit(MA.a1), lit(V1), lit(''), `'[{"path":"${ORG_B}/${V1}/x.jpg"}]'`, 'null', 'false', 'null', "'{}'").code === 'bad_photos', 'a photo path outside this company and group is refused');
  ok(fn('chat_send', lit(MA.a1), lit(V1), lit(''), `'[{"path":"${ORG_A}/${V1}/x.jpg","caption":"tonight"}]'`, 'null', 'false', 'null', "'{}'").ok === true, 'a photo in its own folder is fine');
  ok(fn('chat_send', lit(MA.a1), lit(V1), lit('   '), "'[]'", 'null', 'false', 'null', "'{}'").code === 'empty', 'an empty message is refused');

  console.log('5b. reads for the server (the Manager app and Back Office)');
  {
    const SM = id('d0000000', 1), SP = id('c0000000', 800);
    sql(`insert into public.staff_members (id, location_id, org_id, name, role, pin) values (${lit(SM)}, ${lit(LA2)}, ${lit(ORG_A)}, 'Pip Till', 'Manager', '4321');
         insert into public.wf_staff (id, org_id, location_id, name, role_key, pos_user_id) values (${lit(SP)}, ${lit(ORG_A)}, ${lit(LA2)}, 'Pip Till', 'bar', ${lit(SM)})`);
    const MP = M(SP);
    const wp = fn('chat_whoami', lit(MP));
    ok(wp.level === 'manager' && JSON.stringify(wp.manages) === JSON.stringify([LA2]), 'a manager on the till (PIN, no Back Office login) manages their own venue');
    ok(fn('chat_mod', lit(MP), lit('mute_person'), 'null', 'null', lit(MA.a5), 'null', `now() + interval '1 minute'`, 'null').ok === true
      && fn('chat_mod', lit(MP), lit('mute_person'), 'null', 'null', lit(MA.a2), 'null', 'null', 'null').code === 'not_allowed', 'and moderates Hudds people only');
    fn('chat_mod', lit(MP), lit('unmute_person'), 'null', 'null', lit(MA.a5), 'null', 'null', 'null');
    sql(`update public.staff_members set role = 'Server' where id = ${lit(SM)}`);
    ok(fn('chat_whoami', lit(MP)).level === 'staff', 'a server on the till is staff');
    const inbox = fn('chat_inbox', lit(MA.a1));
    ok(inbox.ok && inbox.convs.some((c) => c.id === V1) && !inbox.convs.some((c) => c.id === VB || c.id === V2), 'the inbox lists my chats only');
    ok(inbox.convs.find((c) => c.id === V1).last && inbox.convs.find((c) => c.id === V1).last.original_body === undefined, 'with the newest message, never the hidden text');
    ok(inbox.profiles.every((p) => p.id && p.display_name) && !inbox.profiles.some((p) => p.id === MA.b1), 'names of my company only');
    ok(fn('chat_inbox', lit(MA.b1)).convs.every((c) => c.org_id === ORG_B), 'the other company sees its own');
    const th = fn('chat_thread', lit(MA.a1), lit(V1), 'null', 'null', '50');
    ok(th.ok && th.messages.length > 0 && th.messages.every((m) => m.conversation_id === V1 && m.removed_body === undefined), 'a page of my chat');
    ok(fn('chat_thread', lit(MA.a5), lit(V1), 'null', 'null', '50').code === 'not_member' && fn('chat_thread', lit(MA.b1), lit(V1), 'null', 'null', '50').code === 'not_found', 'not for a non member, nor another company');
    const after = fn('chat_thread', lit(MA.a1), lit(V1), 'null', String(th.messages[0].id), '50');
    ok(after.ok && after.messages.length === 0, 'a poll after the newest brings nothing new');
    ok(fn('chat_members_list', lit(MA.a1), lit(V1)).members.length > 50 && fn('chat_members_list', lit(MA.b1), lit(V1)).code === 'not_found', 'members of my chat only');
    const gA1 = fn('chat_admin_groups', lit(MO.mA1));
    ok(gA1.ok && gA1.groups.some((g) => g.id === V1) && !gA1.groups.some((g) => g.id === V2) && !gA1.groups.some((g) => g.kind === 'dm'), 'Back Office groups: the Leeds manager sees Leeds groups, never DMs');
    ok(fn('chat_admin_groups', lit(MO.oA)).groups.some((g) => g.id === V2) && !fn('chat_admin_groups', lit(MO.oB)).groups.some((g) => g.id === V1), 'the owner sees every group of the company, not another company');
    ok(fn('chat_admin_groups', lit(MA.a1)).code === 'not_allowed', 'staff do not');
    ok(fn('chat_admin_members', lit(MO.mA1), lit(V1)).members.length > 50 && fn('chat_admin_members', lit(MO.mA2), lit(V1)).code === 'not_allowed', 'members of a group for those who run it');
    const ppl = fn('chat_people', lit(MO.mA1), lit(LA2), 'null');
    ok(ppl.ok && ppl.people.some((p) => p.member_id === MA.a5) && !ppl.people.some((p) => p.member_id === MA.a1) && ppl.venues.length === 2, 'the picker filters by venue and lists the venues');
    ok(fn('chat_people', lit(MO.mA1), 'null', lit('kitchen')).people.every((p) => p.role_key === 'kitchen'), 'and by position');
    ok(fn('chat_people', lit(MA.a1), 'null', 'null').code === 'not_allowed', 'staff cannot list people this way');
    const rl1 = fn('chat_reports_list', lit(MO.mA1), lit('all'), '100');
    ok(rl1.ok && rl1.reports.some((r) => r.id === rep.report_id) && !rl1.reports.some((r) => r.id === rep2.report_id), 'reports: the Leeds manager sees Leeds reports, not the one about himself');
    ok(fn('chat_reports_list', lit(MO.mA2), lit('all'), '100').reports.length === 0, 'the Hudds manager sees none of them');
    const rlo = fn('chat_reports_list', lit(MO.oA), lit('all'), '100');
    ok(rlo.reports.some((r) => r.id === rep2.report_id) && rlo.reports.find((r) => r.id === rep.report_id).text === 'you are useless', 'the owner sees both, with the reported text');
    ok(fn('chat_reports_list', lit(MA.a1), 'null', '100').code === 'not_allowed' && fn('chat_reports_list', lit(MO.oB), lit('all'), '100').reports.length === 0, 'staff see none; nor does another company');
    ok(fn('chat_log_list', lit(MO.oA), 'null', '50').log.length > 5 && fn('chat_log_list', lit(MO.mA1), 'null', '50').code === 'not_allowed', 'the log: owners only');
    const dms = fn('chat_dm_list', lit(MO.oA));
    ok(dms.ok && dms.dms.some((d) => d.id === dm.conversation_id) && JSON.stringify(dms).indexOf('saturday') === -1, 'the owner lists DMs (who and when, never what)');
    ok(fn('chat_dm_list', lit(MO.mA1)).code === 'not_allowed', 'a manager cannot');
  }

  console.log('5c. who a push reaches');
  {
    const targetsOf = (msgId) => fn('chat_push_targets', String(msgId));
    const ids = (t) => t.targets.map((x) => x.member_id);
    fn('chat_push_register', lit(MA.a2), lit('webpush'), lit('https://push.example/dev1'), `'{"keys":{"p256dh":"x","auth":"y"}}'`, 'null', lit('web'));
    const plain = fn('chat_send', lit(MA.a1), lit(V1), lit('who is in today'), "'[]'", 'null', 'false', 'null', "'{}'");
    let t = targetsOf(plain.message.id);
    ok(t.ok && !ids(t).includes(MA.a1), 'never the sender');
    ok(!ids(t).includes(MA.a2), 'quiet when off shift: Dev has no shift now, so no push');
    ok(ids(t).includes(MO.mA1), 'a Back Office manager is never quiet');
    sql(`insert into public.wf_shifts (location_id, org_id, staff_id, shift_date, start_time, finish_time, status)
         values (${lit(LA1)}, ${lit(ORG_A)}, ${lit(S.a2)}, (now() at time zone 'Europe/London')::date - 1, '00:00', '00:00', 'published'),
                (${lit(LA1)}, ${lit(ORG_A)}, ${lit(S.a2)}, (now() at time zone 'Europe/London')::date, '00:00', '23:59', 'published')`);
    t = targetsOf(plain.message.id);
    const dev = t.targets.find((x) => x.member_id === MA.a2);
    ok(dev && dev.devices.length === 1 && dev.devices[0].token === 'https://push.example/dev1' && dev.sms === null, 'on shift: Dev gets it, on his phone, no text');
    ok(!ids(t).includes(MA.a3), 'Quinn muted the Leeds group: no push');
    const ment = fn('chat_send', lit(MO.mA1), lit(V1), lit('@Quinn Q can you cover'), "'[]'", 'null', 'false', 'null', arr([MA.a3]));
    ok(ids(targetsOf(ment.message.id)).includes(MA.a3), 'a manager @mention gets through a mute and off shift');
    const staffMent = fn('chat_send', lit(MA.a1), lit(V1), lit('@Quinn Q hi'), "'[]'", 'null', 'false', 'null', arr([MA.a3]));
    ok(!ids(targetsOf(staffMent.message.id)).includes(MA.a3), 'a staff @mention does not wake someone off shift');
    sql(`update public.wf_staff set mobile = '07700 900123' where id = ${lit(S.a1)}`);
    const urgent2 = fn('chat_send', lit(MO.mA1), lit(ann.conversation_id), lit('Kitchen closed, go home safe'), "'[]'", 'null', 'true', 'null', "'{}'");
    const tu = targetsOf(urgent2.message.id);
    ok(tu.urgent === true && tu.title.startsWith('Urgent:') && ids(tu).includes(MA.a1) && ids(tu).length > 50, 'an urgent announcement reaches everyone, off shift or muted');
    ok(tu.targets.find((x) => x.member_id === MA.a1).sms?.mobile === '07700 900123', 'with the mobile for the text backup');
    fn('chat_settings_save', lit(MO.oA), `'{"sms_backup_urgent":false}'`);
    ok(targetsOf(urgent2.message.id).targets.every((x) => x.sms === null), 'no text backup when the setting is off');
    fn('chat_settings_save', lit(MO.oA), `'{"quiet_off_shift":false,"sms_backup_urgent":true}'`);
    ok(ids(targetsOf(plain.message.id)).includes(MA.a5) === false && ids(targetsOf(plain.message.id)).length > 50, 'quiet off: everyone in the chat but muted people');
    ok(!JSON.stringify(fn('chat_push_staff_devices', arr([S.a1]))).includes('99'.repeat(32)), 'a Manager app phone (an older row) is never pushed');
    ok(fn('chat_push_unregister', lit(MA.a1), lit('apns'), lit('ab'.repeat(32))).removed === 1, 'signing out of the staff app forgets that phone');
    const sd = fn('chat_push_staff_devices', arr([S.a2, S.a5]));
    ok(sd.ok && sd.staff.length === 1 && sd.staff[0].staff_id === S.a2, 'rota messages find a staff member\'s phones');
    ok(read(U.a1, 'select public.chat_push_targets(1)').sqlstate === '42501', 'nobody but the server can ask who a push reaches');
  }

  console.log('5d. re-review: the PIN cap, one person on two profiles, private DMs');
  {
    // R1 / E1: an owner whose Workforce record is linked to a till user (the Manager app PIN profile).
    const SMO = id('d0000000', 9), SO = id('c0000000', 910);
    sql(`insert into public.staff_members (id, location_id, org_id, name, role, pin) values (${lit(SMO)}, ${lit(LA2)}, ${lit(ORG_A)}, 'Olive Till', 'Owner', '9999');
         insert into public.wf_staff (id, org_id, location_id, name, role_key, pos_user_id, portal_user_id) values (${lit(SO)}, ${lit(ORG_A)}, ${lit(LA2)}, 'Olive Till', 'bar', ${lit(SMO)}, ${lit(U.oA)})`);
    const MPO = M(SO);
    ok(fn('chat_whoami', lit(MPO)).level === 'owner', 'E1 setup: without the PIN this profile is an owner (the staff app)');
    const capped = fnPin(MPO, LA2, 'chat_whoami', lit(MPO));
    ok(capped.level === 'manager' && JSON.stringify(capped.manages) === JSON.stringify([LA2]), 'R1: through the PIN it is a manager of the paired venue only');
    ok(fnPin(MPO, LA1, 'chat_whoami', lit(MPO)).level === 'manager' && fnPin(MP_HUDDS(), LA1, 'chat_whoami', lit(MP_HUDDS())).level === 'staff', 'a PIN at a venue the person does not manage is staff');
    const sec = fn('chat_group_create', lit(MO.mA1), lit('group'), lit('Leeds managers private'), 'null', 'null', 'null', 'null', arr([MA.a1]));
    fn('chat_send', lit(MO.mA1), lit(sec.conversation_id), lit('private history line'), "'[]'", 'null', 'false', 'null', "'{}'");
    ok(fnPin(MPO, LA2, 'chat_members_change', lit(MPO), lit(sec.conversation_id), lit('add'), arr([MPO])).code === 'not_allowed'
      && fnPin(MPO, LA2, 'chat_thread', lit(MPO), lit(sec.conversation_id), 'null', 'null', '50').code === 'not_member', 'E1: the owner PIN cannot add itself to a private group nor read it');
    ok(fnPin(MPO, LA2, 'chat_group_update', lit(MPO), lit(V2), `'{"name":"renamed by PIN"}'`).code === 'not_allowed'
      && sql(`select name from public.chat_conversations where id = ${lit(V2)}`) !== 'renamed by PIN', 'E1b: nor rename the Hudds venue group');
    ok(fnPin(MPO, LA2, 'chat_group_create', lit(MPO), lit('announce'), lit('Company wide'), 'null', 'null', 'null', 'null', "'{}'").code === 'not_allowed', 'E1c: nor make an announcement group');
    ok(fnPin(MPO, LA2, 'chat_group_create', lit(MPO), lit('group'), lit('Till chat'), 'null', 'null', 'null', 'null', arr([MA.a5])).ok === true, 'a plain group is fine');
    const hann = fn('chat_group_create', lit(MO.mA2), lit('announce'), lit('Hudds news'), 'null', lit(LA2), 'null', 'null', "'{}'");
    ok(fnPin(MPO, LA2, 'chat_send', lit(MPO), lit(hann.conversation_id), lit('owner via till'), "'[]'", 'null', 'false', 'null', "'{}'").code === 'admins_only', 'R1: no posting in announcements through the PIN unless an admin of that group');
    ok(fnPin(MPO, LA2, 'chat_send', lit(MPO), lit(V2), lit('urgent via till'), "'[]'", 'null', 'true', 'null', "'{}'").code === 'urgent_not_allowed', 'nor urgent');
    ok(fn('chat_send', lit(MPO), lit(hann.conversation_id), lit('owner from the staff app'), "'[]'", 'null', 'false', 'null', "'{}'").ok === true, 'the same owner in the staff app still posts');
    sql(`update public.wf_staff set status = 'leaver' where id = ${lit(SO)}`);
    // E1d: a manager PIN profile and a private group at its own venue.
    const g = fn('chat_group_create', lit(MO.mA2), lit('group'), lit('Hudds private'), 'null', lit(LA2), 'null', 'null', arr([MA.a5]));
    fn('chat_send', lit(MA.a5), lit(g.conversation_id), lit('hudds secret'), "'[]'", 'null', 'false', 'null', "'{}'");
    const MP2 = MP_HUDDS();
    ok(fnPin(MP2, LA2, 'chat_members_change', lit(MP2), lit(g.conversation_id), lit('add'), arr([MP2])).code === 'not_allowed'
      && fnPin(MP2, LA2, 'chat_thread', lit(MP2), lit(g.conversation_id), 'null', 'null', '50').code === 'not_member', 'E1d: a manager PIN cannot add itself to a private group at its venue');
    ok(fnPin(MP2, LA2, 'chat_mod', lit(MP2), lit('mute_person'), 'null', 'null', lit(MA.a5), 'null', `now() + interval '1 minute'`, 'null').ok === true, 'but moderates people at the paired venue');
    ok(fnPin(MP2, LA1, 'chat_mod', lit(MP2), lit('unmute_person'), 'null', 'null', lit(MA.a5), 'null', 'null', 'null').code === 'not_allowed', 'and nobody when paired elsewhere');
    fn('chat_mod', lit(MO.oA), lit('unmute_person'), 'null', 'null', lit(MA.a5), 'null', 'null', 'null');
    // R2 / E2: one login with a Back Office profile and a staff profile.
    const UX = id('20000000', 9), SX = id('c0000000', 911);
    sql(`insert into public.user_profiles (id, org_id, role, full_name) values (${lit(UX)}, ${lit(ORG_A)}, 'manager', 'Xena');
         insert into public.user_locations (user_id, location_id, role) values (${lit(UX)}, ${lit(LA1)}, 'manager')`);
    const MOX = office(ORG_A, UX, 'Xena').member_id;
    fn('chat_sync_org', lit(ORG_A));
    const mx = fn('chat_send', lit(MOX), lit(V1), lit('xena from back office'), "'[]'", 'null', 'false', 'null', "'{}'");
    const rx = fn('chat_report', lit(MA.a1), mx.message.id, lit('about xena'));
    sql(`insert into public.wf_staff (id, org_id, location_id, name, role_key, portal_user_id) values (${lit(SX)}, ${lit(ORG_A)}, ${lit(LA1)}, 'Xena', 'bar', ${lit(UX)})`);
    const MSX = M(SX);
    ok(fn('chat_whoami', lit(MSX)).level === 'manager', 'E2 setup: the staff profile of the same login is a manager too');
    ok(fn('chat_mod', lit(MSX), lit('keep'), lit(rx.report_id), 'null', 'null', 'null', 'null', 'null').code === 'own_report'
      && fn('chat_report_context', lit(MSX), lit(rx.report_id)).code === 'own_report', 'R2 E2: the same login on its staff profile cannot handle a report about its Back Office profile');
    ok(!fn('chat_reports_list', lit(MSX), lit('all'), '100').reports.some((r) => r.id === rx.report_id), 'nor see it in Reports to check');
    // The same email on a staff record and a Back Office profile; a till user's login.
    const UE = id('20000000', 10), SE = id('c0000000', 912), SMA = id('d0000000', 10), SA2 = id('c0000000', 913);
    sql(`insert into public.user_profiles (id, org_id, role, full_name, email) values (${lit(UE)}, ${lit(ORG_A)}, 'manager', 'Eve', 'Eve@Example.test');
         insert into public.user_locations (user_id, location_id, role) values (${lit(UE)}, ${lit(LA1)}, 'manager');
         insert into public.wf_staff (id, org_id, location_id, name, role_key, email) values (${lit(SE)}, ${lit(ORG_A)}, ${lit(LA1)}, 'Eve', 'bar', ' eve@example.test');
         insert into public.staff_members (id, location_id, org_id, name, role, pin, auth_user_id) values (${lit(SMA)}, ${lit(LA1)}, ${lit(ORG_A)}, 'Eve Till', 'Server', '1212', ${lit(UE)});
         insert into public.wf_staff (id, org_id, location_id, name, role_key, pos_user_id) values (${lit(SA2)}, ${lit(ORG_A)}, ${lit(LA1)}, 'Eve Till', 'bar', ${lit(SMA)})`);
    const MOE = office(ORG_A, UE, 'Eve').member_id;
    const me1 = fn('chat_send', lit(M(SE)), lit(V1), lit('eve on the floor'), "'[]'", 'null', 'false', 'null', "'{}'");
    ok(fn('chat_mod', lit(MOE), lit('hide'), 'null', me1.message.id, 'null', 'null', 'null', 'null').code === 'own_report', 'R2: the same email (any case, spaces) is the same person');
    const me2 = fn('chat_send', lit(M(SA2)), lit(V1), lit('eve on the till'), "'[]'", 'null', 'false', 'null', "'{}'");
    ok(fn('chat_mod', lit(MOE), lit('hide'), 'null', me2.message.id, 'null', 'null', 'null', 'null').code === 'own_report', 'R2: so is the till user\'s own login');
    ok(fn('chat_mod', lit(MO.mA1), lit('hide'), 'null', me2.message.id, 'null', 'null', 'null', 'null').ok === true, 'another manager still can');
    fn('chat_mod', lit(MO.oA), lit('keep'), 'null', me2.message.id, 'null', 'null', 'null', 'null');
    // R4 / E3i: a DM stays private.
    const d = fn('chat_dm_open', lit(MA.a3), lit(MA.a5));
    const dq = fn('chat_send', lit(MA.a3), lit(d.conversation_id), lit('quinn dm'), "'[]'", 'null', 'false', 'null', "'{}'");
    ok(fn('chat_mod', lit(MO.mA1), lit('hide'), 'null', dq.message.id, 'null', 'null', 'null', 'null').code === 'report_needed'
      && sql(`select status from public.chat_messages where id = ${dq.message.id}`) === 'visible', 'R4 E3i: no hiding a DM message nobody reported');
    fn('chat_report', lit(MA.a5), dq.message.id, lit('not nice'));
    ok(fn('chat_mod', lit(MO.mA1), lit('hide'), 'null', dq.message.id, 'null', 'null', 'null', 'null').ok === true, 'once it is reported, a manager of the sender can');
  }

  console.log('6. automatic membership');
  const NEW = id('c0000000', 900);
  sql(`insert into public.wf_staff (id, org_id, location_id, name, role_key, portal_user_id) values (${lit(NEW)}, ${lit(ORG_A)}, ${lit(LA2)}, 'Nia New', 'bar', ${lit(id('10000000', 900))})`);
  const MN = M(NEW);
  ok(MN && sql(`select count(*) from public.chat_members where member_id = ${lit(MN)} and conversation_id = ${lit(V2)} and left_at is null`) === '1', 'a new starter is in their venue group straight away');
  ok(sql(`select count(*) from public.chat_members where member_id = ${lit(MN)} and conversation_id = ${lit(pos.conversation_id)} and left_at is null`) === '1', 'and in the bartenders group');
  sql(`update public.wf_staff set location_id = ${lit(LA1)} where id = ${lit(NEW)}`);
  ok(sql(`select string_agg(c.location_id::text, ',') from public.chat_members m join public.chat_conversations c on c.id = m.conversation_id where m.member_id = ${lit(MN)} and m.left_at is null and c.kind = 'venue'`) === LA1, 'moving venue moves their group');
  sql(`update public.wf_staff set status = 'leaver' where id = ${lit(NEW)}`);
  ok(sql(`select count(*) from public.chat_members where member_id = ${lit(MN)} and left_at is null`) === '0', 'offboarding takes them out of every conversation');
  ok(cnt(id('10000000', 900), 'select count(*) from public.chat_messages') === '0', 'and they read nothing');
  sql(`update public.wf_staff set status = 'active' where id = ${lit(NEW)}`);
  ok(sql(`select count(*) from public.chat_members where member_id = ${lit(MN)} and conversation_id = ${lit(V1)} and left_at is null`) === '1', 'coming back puts them back in their venue group');
  // A removed person stays removed.
  ok(fn('chat_mod', lit(MO.mA1), lit('remove'), 'null', 'null', lit(MA.a3), lit(V1), 'null', lit('asked')).ok === true, 'a manager removes Quinn from the Leeds group');
  fn('chat_sync_org', lit(ORG_A));
  ok(sql(`select left_reason from public.chat_members where member_id = ${lit(MA.a3)} and conversation_id = ${lit(V1)}`) === 'removed', 'the sync does not put a removed person back');
  // The trigger never blocks a staff save.
  sql(`alter table public.chat_members add constraint t_block check (false) not valid`);
  const saved = as('postgres', `insert into public.wf_staff (org_id, location_id, name) values (${lit(ORG_A)}, ${lit(LA1)}, 'Blocked Sync')`);
  sql(`alter table public.chat_members drop constraint t_block`);
  ok(saved.status === 0, 'a staff save goes through even when the chat sync fails (a warning only)');

  console.log('7. 50 at the same moment');
  const EXM = EXTRA.map((e) => M(e));
  const before = Number(sql(`select count(*) from public.chat_messages where conversation_id = ${lit(V1)}`));
  const res = await Promise.all(EXM.map((m, i) => concurrent(`select public.chat_send(${lit(m)}, ${lit(V1)}, ${lit('rush ' + i)}, '[]', null, false, ${lit('c-' + i)}, '{}')`)));
  const oks = res.filter((r) => r.code === 0 && JSON.parse(r.out || '{}').ok === true).length;
  ok(oks === 50, `50 senders at once: ${oks} sent`);
  ok(Number(sql(`select count(*) from public.chat_messages where conversation_id = ${lit(V1)}`)) === before + 50, 'exactly 50 new rows');
  ok(sql(`select count(distinct id) = count(*) from public.chat_messages`) === 't', 'every id unique');
  ok(sql(`select last_message_at >= (select max(created_at) from public.chat_messages where conversation_id = ${lit(V1)}) from public.chat_conversations where id = ${lit(V1)}`) === 't', 'the group shows the newest message time');
  const dup = await Promise.all([0, 1, 2, 3].map(() => concurrent(`select public.chat_send(${lit(EXM[0])}, ${lit(V1)}, 'retry', '[]', null, false, 'same-id', '{}')`)));
  ok(dup.every((r) => r.code === 0) && sql(`select count(*) from public.chat_messages where client_id = 'same-id'`) === '1', 'one message sent four times at once (a retry) is stored once');
  ok(cnt(U.b1, 'select count(*) from public.chat_messages') === '0', 'the other company still reads nothing');

  console.log('8. the moderation log');
  const n = sql('select count(*) from public.chat_moderation_log');
  ok(Number(n) > 5, `the log has the actions (${n})`);
  ok(as('postgres', 'update public.chat_moderation_log set reason = null').status !== 0 && as('postgres', 'delete from public.chat_moderation_log').status !== 0, 'nobody can change or delete it');

  console.log('9. the rollback');
  const rb1 = psql({ args: ['-1', '-f', ROLLBACK], allowFail: true });
  ok(rb1.status !== 0 && /chat message/.test(rb1.stderr), 'the rollback refuses while messages exist');
  sql('delete from public.chat_messages');
  const rb2 = psql({ args: ['-1', '-f', ROLLBACK] });
  const rbCheck = rb2.stdout.trim().split('\n').pop();
  ok(rbCheck === '0|0|f|t', `rollback check row (${rbCheck})`);
  ok(sql(`select count(*) from public.wf_staff`) !== '0' && sql(`select count(*) from storage.buckets where id = 'chat-photos'`) === '0', 'staff kept, the empty photo bucket gone (through protect_buckets_delete, review fix S4)');
  ok(as('postgres', `delete from storage.buckets where id = 'nothing'`).status !== 0, 'the harness bucket guard is real: a plain delete is refused');
  const reapply = psql({ args: ['-1', '-f', MIGRATION], allowFail: true });
  ok(reapply.status === 0 && reapply.stdout.trim().split('\n').pop() === EXPECT_CHECK, 'the migration applies again after the rollback');
  ok(Number(sql(`select count(*) from public.chat_members where conversation_id = (select id from public.chat_conversations where kind = 'venue' and location_id = ${lit(LA1)})`)) > 50, 'and rebuilds the venue groups');
} finally {
  stop();
}
console.log(`\n${passes} checks passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
