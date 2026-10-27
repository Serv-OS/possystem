// src/lib/teamChatMigration.test.js
//
// 5.11.102 team chat: the text of 20261103a_OPS_team_chat.sql and its ROLLBACK (the local Postgres proof
// is supabase/tests/team_chat/run.mjs), and the wiring of the team-chat edge function: every write is
// a service role call into a chat_* function that exists, the caller comes from the login, and the
// filter runs before anything is stored.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const MIG = read('supabase/migrations/20261103a_OPS_team_chat.sql');
const RB = read('supabase/migrations/20261103a_OPS_team_chat_ROLLBACK.sql');
const FN = read('supabase/functions/team-chat/index.ts');

test('both files: ASCII only, no exclamation mark, Ops only guard, refuse a second run, 3 s lock wait, a check row', () => {
  for (const [name, s] of [['migration', MIG], ['rollback', RB]]) {
    assert.ok([...s].every((c) => c.charCodeAt(0) < 128), `${name} is ASCII`);
    assert.ok(!s.includes('!'), `${name} has no exclamation mark`);
    assert.match(s, /to_regclass\('public\.billing_state'\) is not null/, `${name} refuses the Platform database`);
    assert.match(s, /set local lock_timeout = '3s';/, `${name} waits 3 s for a lock`);
    assert.match(s, /-- VISIBLE CHECK/);
  }
  assert.match(MIG, /has run already\. Nothing was changed\./);
  assert.ok(MIG.indexOf('do $guard$') < MIG.indexOf('create table'), 'the guard runs before any change');
  assert.match(RB, /chat message\(s\)\. They would be lost/, 'the rollback refuses while messages exist');
});

test('every function has a fixed search path, and only the service role may run them (bar the three read helpers)', () => {
  const fns = [...MIG.matchAll(/create function public\.(\w+)\(/g)].map((m) => m[1]);
  assert.ok(fns.length >= 30);
  for (const f of fns) {
    const start = MIG.indexOf(`create function public.${f}(`);
    const head = MIG.slice(start, MIG.indexOf('$f$', start));
    assert.match(head, /set search_path = public, pg_temp/, `${f} fixes its search path`);
  }
  assert.match(MIG, /revoke all on function %s from public, anon, authenticated/);
  assert.match(MIG, /grant execute on function public\.chat_my_member_ids\(\), public\.chat_my_conversation_ids\(\), public\.chat_my_org_ids\(\) to authenticated;/);
  assert.match(MIG, /revoke all on public\.%I from public, anon, authenticated/);
  assert.doesNotMatch(MIG, /grant (insert|update|delete)[^;]*to (anon|authenticated)/i, 'no write grant to the API roles');
  assert.doesNotMatch(MIG, /create policy[^;]*for (insert|update|delete|all)/i, 'no write policy');
  assert.doesNotMatch(MIG.match(/grant select \([^)]*\)\s+on public\.chat_messages/)[0], /original_body|removed_body|removed_photos/, 'hidden text is never granted');
});

test('the staff app login is matched through portal_user_id inside a SECURITY DEFINER helper, not in a policy', () => {
  const helper = MIG.slice(MIG.indexOf('create function public.chat_my_member_ids()'), MIG.indexOf('create function public.chat_my_conversation_ids()'));
  assert.match(helper, /security definer/);
  assert.match(helper, /s\.portal_user_id = auth\.uid\(\) and s\.status <> 'leaver'/);
  const policies = [...MIG.matchAll(/create policy (\w+) on public\.(\w+) for select to authenticated\s+using \(([^;]+)\);/g)];
  assert.equal(policies.length, 6);
  for (const m of policies) {
    assert.match(m[3], /^\w+ in \(select public\.chat_my_(conversation|org)_ids\(\)\)\)?$/, `${m[1]} only calls a helper`);
  }
});

test('every rpc the edge function calls is a function of the migration', () => {
  const called = [...new Set([...FN.matchAll(/rpc\('(\w+)'/g)].map((m) => m[1]))];
  assert.ok(called.length >= 20, `calls ${called.length}`);
  for (const c of called) assert.ok(MIG.includes(`create function public.${c}(`), `${c} exists`);
});

test('the edge function: the caller from the login, anonymous refused, the filter before the store, second step on moderation', () => {
  assert.match(FN, /admin\.auth\.getUser\(jwt\)/);
  assert.match(FN, /is_anonymous/);
  assert.match(FN, /eq\('portal_user_id', uid\)\.neq\('status', 'leaver'\)/);
  const send = FN.slice(FN.indexOf("case 'send':"), FN.indexOf("case 'edit':"));
  assert.ok(send.indexOf('checkMessage(') < send.indexOf("rpc('chat_send'"), 'the filter runs before the send');
  for (const a of ['mod.hide', 'owner.open_dm', 'settings.save', 'words.save', 'export_person', 'report.context']) {
    assert.match(FN.match(/SECOND_STEP_ACTIONS = new Set\(\[[^\]]+\]\)/)[0], new RegExp(`'${a.replace('.', '\\.')}'`), `${a} needs the second step`);
  }
  assert.match(FN, /MARKER 5\.11\.102 team-chat/);
  assert.match(FN, /AI_MODEL = 'claude-haiku-5-5'/);
});

test('the staff app reads exactly the message columns the migration grants (select * would be refused)', async () => {
  const { MSG_COLUMNS } = await import('../staff/chatModel.js');
  const granted = MIG.match(/grant select \(([^)]*)\)\s+on public\.chat_messages/)[1];
  assert.equal(MSG_COLUMNS.replace(/\s/g, ''), granted.replace(/\s/g, ''));
  for (const f of ['src/staff/StaffChat.jsx', 'src/staff/useTeamChat.js']) {
    assert.doesNotMatch(read(f), /from\('chat_messages'\)\.select\('\*'\)/, f);
  }
});
