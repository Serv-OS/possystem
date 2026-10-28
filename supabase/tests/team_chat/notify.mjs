#!/usr/bin/env node
// notify.mjs: proves 20261105a (chat notifications, release 5.11.109) on a local, throwaway
// PostgreSQL, on top of 20261103a, before Peter runs it on the Ops database. Never connects to Supabase.
//
//   node supabase/tests/team_chat/notify.mjs
//
// What it proves, in order:
//   1. it refuses to run before 20261103a; then applies in one transaction, its check row reads as
//      documented, the POSUP Test company is switched to notify always, a second run is refused;
//   2. every message pushes by default: someone off shift gets it (the company default is off now);
//   3. the person's own Quiet when off shift holds their messages back off shift, as the company
//      setting does; urgent announcements and a manager's @mention still come through; on shift
//      they get everything; turning it off brings them back;
//   4. the phones handed to the push code carry their company and person (for the log);
//   5. the chats list: for_you counts unread direct messages and @mentions of me, and the answer
//      carries my profile id;
//   6. Notifications in Settings: phone count and the last 20 pushes for owners and managers, not
//      staff, never another company; the push log is closed to the API; the new functions are the
//      service role's only; the nightly clean up keeps 30 days of log;
//   7. the ROLLBACK puts the 20261103a functions back word for word and drops what this added, and
//      20261105a applies again after it.
// Exit code 0 only when every check holds.

import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..');
const CHAT = join(repo, 'supabase/migrations/20261103a_OPS_team_chat.sql');
const MIGRATION = join(repo, 'supabase/migrations/20261105a_OPS_chat_notifications.sql');
const ROLLBACK = join(repo, 'supabase/migrations/20261105a_OPS_chat_notifications_ROLLBACK.sql');
const POSUP_TEST = 'a59a6d97-ffaa-470e-8bb7-04cba789f335';

const bin = (name) => (existsSync(`/opt/homebrew/bin/${name}`) ? `/opt/homebrew/bin/${name}` : name);
const env = { ...process.env, LC_ALL: 'en_US.UTF-8', PGOPTIONS: '-c client_min_messages=warning' };
let failures = 0, passes = 0;
const ok = (cond, msg) => { if (cond) { passes++; console.log(`  ok   ${msg}`); } else { failures++; console.log(`  FAIL ${msg}`); } };

const port = String(55800 + Math.floor(Math.random() * 80));
const dir = mkdtempSync(join(tmpdir(), 'pgn.'));
const data = join(dir, 'data');
{
  let r = spawnSync(bin('initdb'), ['-D', data, '-U', 'postgres', '--auth=trust', '-E', 'UTF8'], { env, encoding: 'utf8' });
  if (r.status !== 0) { console.error(r.stderr || r.stdout); process.exit(2); }
  r = spawnSync(bin('pg_ctl'), ['-D', data, '-l', join(dir, 'pg.log'), '-w', '-o', `-p ${port} -c listen_addresses='' -k ${dir} -c timezone=UTC`, 'start'], { env, encoding: 'utf8' });
  if (r.status !== 0) { console.error(r.stderr || r.stdout); process.exit(2); }
}
function stop() { spawnSync(bin('pg_ctl'), ['-D', data, '-m', 'fast', '-w', 'stop'], { env, encoding: 'utf8' }); rmSync(dir, { recursive: true, force: true }); }
const psqlArgs = (login, extra = []) => ['-h', dir, '-p', port, '-U', login, '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-X', '-q', '-At', ...extra];
function psql({ login = 'postgres', input, args = [], allowFail = false }) {
  const r = spawnSync(bin('psql'), psqlArgs(login, args), { env, input, encoding: 'utf8' });
  if (r.status !== 0 && !allowFail) { console.error('psql failed:\n', (input || '').slice(0, 400), '\n', r.stderr || r.stdout); stop(); process.exit(2); }
  return r;
}
const sql = (q) => psql({ input: q }).stdout.trim();
const lit = (v) => (v == null ? 'null' : `'${String(v).replace(/'/g, "''")}'`);
const arr = (xs) => `array[${xs.map(lit).join(',')}]::uuid[]`;
const id = (p, n) => `${p}-0000-4000-8000-${String(n).padStart(12, '0')}`;
function as(role, body, { sub = null } = {}) {
  const lines = ['begin;'];
  const claims = role === 'service_role' ? { role } : { role, sub, aud: 'authenticated' };
  lines.push(`select set_config('request.jwt.claims', ${lit(JSON.stringify(claims))}, true) \\g /dev/null`, `set local role ${role};`, body.trim().replace(/;?$/, ';'), 'commit;');
  const r = psql({ login: 'authenticator', input: lines.join('\n') + '\n', allowFail: true });
  const m = /ERROR:\s+(?:([0-9A-Z]{5}):\s*)?(.*)/.exec(r.stderr || '');
  return { status: r.status, sqlstate: m ? (m[1] || (/permission denied/.test(m[2]) ? '42501' : null)) : null, message: m ? m[2] : '', out: r.stdout.trim() };
}
const fn = (name, ...args) => JSON.parse(as('service_role', `select public.${name}(${args.join(', ')})`).out || 'null');
const fnSrc = (file, name) => { const s = readFileSync(file, 'utf8'); const i = s.indexOf(`function public.${name}(`); const a = s.indexOf('$f$', i) + 3; return s.slice(a, s.indexOf('$f$', a)); };

const ORG_A = POSUP_TEST, ORG_B = id('0b000000', 1);
const LA = id('a0000000', 1), LB = id('b0000000', 1);
const U = { s1: id('10000000', 1), s2: id('10000000', 2), s3: id('10000000', 3), b1: id('10000000', 4), mA: id('20000000', 1), oA: id('20000000', 2), oB: id('20000000', 3) };
const S = { s1: id('c0000000', 1), s2: id('c0000000', 2), s3: id('c0000000', 3), b1: id('c0000000', 4) };

try {
  console.log('1. the migration');
  psql({ args: ['-1', '-f', join(here, 'schema.sql')] });
  sql(`insert into public.organisations values (${lit(ORG_A)}, 'POSUP Test'), (${lit(ORG_B)}, 'Other Co');
       insert into public.locations (id, org_id, name, timezone) values (${lit(LA)}, ${lit(ORG_A)}, 'Leeds', 'Europe/London'), (${lit(LB)}, ${lit(ORG_B)}, 'Provo', 'America/Denver');
       insert into public.user_profiles (id, org_id, role, full_name) values (${lit(U.mA)}, ${lit(ORG_A)}, 'manager', 'Mo'), (${lit(U.oA)}, ${lit(ORG_A)}, 'owner', 'Olive'), (${lit(U.oB)}, ${lit(ORG_B)}, 'owner', 'Otto');
       insert into public.user_locations (user_id, location_id, role) values (${lit(U.mA)}, ${lit(LA)}, 'manager'), (${lit(U.oA)}, ${lit(LA)}, 'owner'), (${lit(U.oB)}, ${lit(LB)}, 'owner');
       insert into public.wf_staff (id, org_id, location_id, name, role_key, portal_user_id) values
         (${lit(S.s1)}, ${lit(ORG_A)}, ${lit(LA)}, 'Cara C', 'bar', ${lit(U.s1)}), (${lit(S.s2)}, ${lit(ORG_A)}, ${lit(LA)}, 'Dev D', 'bar', ${lit(U.s2)}),
         (${lit(S.s3)}, ${lit(ORG_A)}, ${lit(LA)}, 'Quinn Q', 'kitchen', ${lit(U.s3)}), (${lit(S.b1)}, ${lit(ORG_B)}, ${lit(LB)}, 'Xan X', 'bar', ${lit(U.b1)});`);
  const early = psql({ args: ['-1', '-f', MIGRATION], allowFail: true });
  ok(early.status !== 0 && /is not in this database yet/.test(early.stderr), 'it refuses to run before 20261103a');
  psql({ args: ['-1', '-f', CHAT] });
  // As live: the POSUP Test company has a settings row with Quiet when off shift on.
  sql(`insert into public.chat_settings (org_id) values (${lit(ORG_A)})`);
  ok(sql(`select quiet_off_shift from public.chat_settings where org_id = ${lit(ORG_A)}`) === 't', 'before: POSUP Test has Quiet when off shift on (the old default)');
  const mig = psql({ args: ['-1', '-f', MIGRATION] });
  const check = mig.stdout.trim().split('\n').pop();
  ok(check === '55|3|t|f|t|f|f|0', `check row as documented (${check})`);
  const again = psql({ args: ['-1', '-f', MIGRATION], allowFail: true });
  ok(again.status !== 0 && /has run already/.test(again.stderr), 'a second run is refused');
  const raw = readFileSync(MIGRATION, 'utf8') + readFileSync(ROLLBACK, 'utf8');
  ok([...raw].every((c) => c.charCodeAt(0) < 128) && !raw.includes('!'), 'both files are ASCII and carry no exclamation mark');
  ok(sql(`insert into public.chat_settings (org_id) values (${lit(ORG_B)}) returning quiet_off_shift`) === 'f', 'a new company row starts with Quiet when off shift off');

  const M = (staffId) => sql(`select id from public.chat_profiles where staff_id = ${lit(staffId)}`);
  const MA = { s1: M(S.s1), s2: M(S.s2), s3: M(S.s3), b1: M(S.b1) };
  const office = (org, uid, name) => fn('chat_profile_for', lit(org), 'null', lit(uid), lit(name)).member_id;
  const MO = { mA: office(ORG_A, U.mA, 'Mo'), oA: office(ORG_A, U.oA, 'Olive'), oB: office(ORG_B, U.oB, 'Otto') };
  fn('chat_sync_org', lit(ORG_A)); fn('chat_sync_org', lit(ORG_B));
  const V = sql(`select id from public.chat_conversations where kind = 'venue' and location_id = ${lit(LA)}`);
  for (const [m, tok] of [[MA.s1, 'c1'], [MA.s2, 'd2'], [MA.s3, 'q3'], [MA.b1, 'x4']]) {
    fn('chat_push_register', lit(m), lit('webpush'), lit(`https://push.example/${tok}`), `'{"keys":{"p256dh":"x","auth":"y"}}'`, 'null', lit('web'));
  }
  const targets = (msgId) => fn('chat_push_targets', String(msgId));
  const ids = (t) => t.targets.map((x) => x.member_id);
  const send = (from, conv, text, mentions = []) => fn('chat_send', lit(from), lit(conv), lit(text), "'[]'", 'null', 'false', 'null', mentions.length ? arr(mentions) : "'{}'");

  console.log('2. every message pushes by default');
  const m1 = send(MA.s1, V, 'who is in today');
  let t = targets(m1.message.id);
  ok(ids(t).includes(MA.s2) && ids(t).includes(MA.s3), 'Dev and Quinn have no shift now and still get it');
  ok(!ids(t).includes(MA.s1), 'never the sender');

  console.log('3. the person\'s own Quiet when off shift');
  ok(fn('chat_whoami', lit(MA.s2)).my_quiet_off_shift === false, 'whoami says it is off to start with');
  const q = fn('chat_me_quiet', lit(MA.s2), 'true');
  ok(q.ok && q.my_quiet_off_shift === true && fn('chat_whoami', lit(MA.s2)).my_quiet_off_shift === true, 'Dev turns it on');
  t = targets(m1.message.id);
  ok(!ids(t).includes(MA.s2) && ids(t).includes(MA.s3), 'off shift Dev is held back; Quinn still gets it');
  const ment = send(MO.mA, V, '@Dev D can you cover', [MA.s2]);
  ok(ids(targets(ment.message.id)).includes(MA.s2), 'a manager @mention still comes through');
  const staffMent = send(MA.s1, V, '@Dev D hi', [MA.s2]);
  ok(!ids(targets(staffMent.message.id)).includes(MA.s2), 'a staff @mention does not wake him off shift');
  const ann = fn('chat_group_create', lit(MO.mA), lit('announce'), lit('Leeds news'), 'null', lit(LA), 'null', 'null', "'{}'");
  const urgent = fn('chat_send', lit(MO.mA), lit(ann.conversation_id), lit('Kitchen closed'), "'[]'", 'null', 'true', 'null', "'{}'");
  ok(ids(targets(urgent.message.id)).includes(MA.s2), 'an urgent announcement still comes through');
  sql(`insert into public.wf_shifts (location_id, org_id, staff_id, shift_date, start_time, finish_time, status)
       values (${lit(LA)}, ${lit(ORG_A)}, ${lit(S.s2)}, (now() at time zone 'Europe/London')::date - 1, '00:00', '00:00', 'published'),
              (${lit(LA)}, ${lit(ORG_A)}, ${lit(S.s2)}, (now() at time zone 'Europe/London')::date, '00:00', '23:59', 'published')`);
  ok(ids(targets(m1.message.id)).includes(MA.s2), 'on shift he gets everything');
  sql(`delete from public.wf_shifts where staff_id = ${lit(S.s2)}`);
  fn('chat_me_quiet', lit(MA.s2), 'false');
  ok(ids(targets(m1.message.id)).includes(MA.s2), 'turned off again: back to every message');
  fn('chat_settings_save', lit(MO.oA), `'{"quiet_off_shift":true}'`);
  ok(!ids(targets(m1.message.id)).includes(MA.s2) && !ids(targets(m1.message.id)).includes(MA.s3), 'the company setting on still quiets everyone off shift');
  fn('chat_settings_save', lit(MO.oA), `'{"quiet_off_shift":false}'`);
  ok(fn('chat_me_quiet', 'null', 'true').ok === false, 'no profile, no change');

  console.log('4. phones carry their company and person');
  const dev = targets(m1.message.id).targets.find((x) => x.member_id === MA.s3).devices[0];
  ok(dev.org_id === ORG_A && dev.member_id === MA.s3 && dev.token === 'https://push.example/q3', 'chat push phones');
  const sd = fn('chat_push_staff_devices', arr([S.s1]));
  ok(sd.staff[0].devices[0].org_id === ORG_A && sd.staff[0].devices[0].member_id === MA.s1, 'rota push phones');

  console.log('5. what is for you');
  const dm = fn('chat_dm_open', lit(MA.s1), lit(MA.s3));
  send(MA.s1, dm.conversation_id, 'are you in tomorrow');
  send(MA.s1, dm.conversation_id, 'let me know');
  const inbox = fn('chat_inbox', lit(MA.s3));
  const row = (cid) => inbox.convs.find((c) => c.id === cid);
  ok(inbox.member_id === MA.s3, 'the answer carries my profile id');
  ok(row(dm.conversation_id).unread === 2 && row(dm.conversation_id).for_you === 2, 'a direct message: 2 unread, both for you');
  ok(row(V).unread >= 3 && row(V).for_you === 0, 'the venue group: unread, none for Quinn');
  send(MO.mA, V, '@Quinn Q fridge temps please', [MA.s3]);
  const inbox2 = fn('chat_inbox', lit(MA.s3));
  ok(inbox2.convs.find((c) => c.id === V).for_you === 1, 'an @mention of Quinn: 1 for you');
  const last = inbox2.convs.find((c) => c.id === V).last.id;
  fn('chat_read', lit(MA.s3), lit(V), String(last));
  ok(fn('chat_inbox', lit(MA.s3)).convs.find((c) => c.id === V).for_you === 0, 'read: nothing left for you');

  console.log('6. Notifications in Settings');
  sql(`insert into public.push_log (org_id, member_id, kind, ok, status, reason, created_at) values
       (${lit(ORG_A)}, ${lit(MA.s1)}, 'chat', true, 201, null, now() - interval '2 minutes'),
       (${lit(ORG_A)}, ${lit(MA.s2)}, 'chat', false, 410, 'gone', now() - interval '1 minute'),
       (${lit(ORG_B)}, ${lit(MA.b1)}, 'chat', true, 201, null, now()),
       (${lit(ORG_A)}, ${lit(MA.s3)}, 'chat', true, 201, null, now() - interval '40 days')`);
  sql(`insert into public.push_log (org_id, member_id, kind, ok) select ${lit(ORG_A)}, ${lit(MA.s1)}, 'rota_notification', true from generate_series(1, 25)`);
  const st = fn('chat_notify_status', lit(MO.oA));
  ok(st.ok && st.phones === 3 && st.people === 3 && st.browsers === 3 && st.iphones === 0, `the owner sees 3 phones on (${st.phones})`);
  ok(st.pushes.length === 20 && st.pushes.every((p) => p.name !== 'Xan X'), 'the last 20 pushes, never another company\'s');
  const st2 = fn('chat_notify_status', lit(MO.mA));
  ok(st2.ok && st2.phones === 3, 'a manager sees it too');
  sql(`delete from public.push_log where kind = 'rota_notification'`);
  const st3 = fn('chat_notify_status', lit(MO.oA));
  ok(st3.pushes[0].ok === false && st3.pushes[0].status === 410 && st3.pushes[0].name === 'Dev D' && st3.pushes[1].ok === true, 'newest first, with failed and sent and the name');
  ok(fn('chat_notify_status', lit(MA.s1)).code === 'not_allowed', 'staff cannot');
  ok(fn('chat_notify_status', lit(MO.oB)).phones === 1, 'another company sees only its own');
  for (const role of ['anon', 'authenticated']) {
    ok(as(role, 'select count(*) from public.push_log', { sub: U.s1 }).status !== 0, `${role} cannot read the push log`);
    ok(as(role, `insert into public.push_log (org_id, ok) values (${lit(ORG_A)}, true)`, { sub: U.s1 }).status !== 0, `${role} cannot write it`);
    ok(as(role, `select public.chat_me_quiet(${lit(MA.s1)}, true)`, { sub: U.s1 }).status !== 0 && as(role, `select public.chat_notify_status(${lit(MO.oA)})`, { sub: U.oA }).status !== 0,
      `${role} cannot run the new functions`);
  }
  ok(as('authenticated', 'select quiet_off_shift from public.chat_profiles', { sub: U.s1 }).status !== 0, 'nor read anyone\'s own quiet choice');
  fn('chat_purge');
  ok(sql(`select count(*) from public.push_log where created_at < now() - interval '30 days'`) === '0' && sql('select count(*) from public.push_log') === '3', 'the nightly clean up keeps 30 days of log');

  console.log('7. the rollback');
  const rb = psql({ args: ['-1', '-f', ROLLBACK] });
  ok(rb.stdout.trim().split('\n').pop() === '53|3|f|f|t', `rollback check row (${rb.stdout.trim().split('\n').pop()})`);
  const live = (name) => sql(`select prosrc from pg_proc where proname = ${lit(name)} and pronamespace = 'public'::regnamespace`);
  const differ = ['_chat_settings', 'chat_whoami', 'chat_push_targets', 'chat_push_staff_devices', 'chat_inbox', 'chat_purge'].filter((n) => live(n) !== fnSrc(CHAT, n).trim());
  ok(!differ.length,
    `the six functions are the 20261103a text word for word (${differ.join(', ') || 'all the same'})`);
  ok(sql(`select count(*) from pg_proc where proname in ('chat_me_quiet', 'chat_notify_status')`) === '0', 'the new functions are gone');
  ok(sql(`select quiet_off_shift from public.chat_settings where org_id = ${lit(ORG_A)}`) === 'f', 'POSUP Test keeps notify always');
  const re = psql({ args: ['-1', '-f', MIGRATION] });
  ok(re.stdout.trim().split('\n').pop() === '55|3|t|f|t|f|f|0', 'and 20261105a applies again after it');
} finally {
  stop();
}
console.log(`\n${passes} checks passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
