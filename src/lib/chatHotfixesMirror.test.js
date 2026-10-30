// src/lib/chatHotfixesMirror.test.js
// 5.11.122: the repo mirror of the two chat hotfixes run live on 28 Oct 2026 says exactly what the
// hotfix files said, and the migration list carries it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const MIG = read('supabase/migrations/20261110a_OPS_chat_hotfixes_mirror.sql');
const RB = read('supabase/migrations/20261110a_OPS_chat_hotfixes_mirror_ROLLBACK.sql');
const CHAT_TABLES = ['chat_settings', 'chat_word_lists', 'chat_profiles', 'chat_conversations', 'chat_members',
  'chat_messages', 'chat_reactions', 'chat_reports', 'chat_moderation_log', 'chat_person_state'];

test('both files: ASCII only, no exclamation mark, Ops only guard, 3 s lock wait, a check row', () => {
  for (const [name, s] of [['migration', MIG], ['rollback', RB]]) {
    assert.ok([...s].every((c) => c.charCodeAt(0) < 128), `${name} is ASCII`);
    assert.ok(!s.includes('!'), `${name} has no exclamation mark`);
    assert.match(s, /to_regclass\('public\.billing_state'\) is not null/, `${name} refuses the Platform database`);
    assert.match(s, /set local lock_timeout = '3s';/, `${name} waits 3 s for a lock`);
    assert.match(s, /-- VISIBLE CHECK/);
  }
  assert.ok(MIG.indexOf('do $guard$') < MIG.indexOf('alter table'), 'the guard runs before any change');
  assert.match(MIG, /Run 20261103a_OPS_team_chat and 20260919s_OPS_second_step first/);
});

test('hotfix 1: every chat table of 20261103a goes to NO FORCE, and the rollback puts FORCE back', () => {
  const orig = read('supabase/migrations/20261103a_OPS_team_chat.sql');
  for (const t of CHAT_TABLES) {
    assert.ok(orig.includes(`'${t}'`), `${t} is a 20261103a table`);
    assert.ok(MIG.includes(`'${t}'`), `${t} is in the mirror`);
    assert.ok(RB.includes(`'${t}'`), `${t} is in the rollback`);
  }
  assert.match(MIG, /no force row level security/);
  assert.ok(!/alter table public\.%I force row level security/.test(MIG), 'the mirror never forces');
  assert.match(RB, /alter table public\.%I force row level security/);
});

test('hotfix 2: the request check skips /chat_ and /rpc/chat_ paths and still raises for everything else', () => {
  const fn = MIG.slice(MIG.indexOf('create or replace function public.second_step_check_request()'), MIG.indexOf('$fn$;'));
  assert.match(fn, /security definer/);
  assert.match(fn, /set search_path to ''/);
  assert.match(fn, /v_path like '\/chat\\_%' or v_path like '\/rpc\/chat\\_%'/);
  assert.ok(fn.indexOf("like '/chat\\_%'") < fn.indexOf('second_step_ok()'), 'the skip runs before the check');
  assert.match(fn, /message = 'second_step_required'/);
  assert.match(fn, /errcode = '42501'/);
  const rbFn = RB.slice(RB.indexOf('create or replace function public.second_step_check_request()'), RB.indexOf('$fn$;'));
  assert.ok(!rbFn.includes('/chat\\_%'), 'the rollback has no chat skip');
  assert.match(rbFn, /second_step_required/);
});

test('the mirror says what the hotfix files Peter ran said (same table list, same skip, same words)', () => {
  // The hotfix files live outside the repo (~/.claude/servos-release/hotfix_chat_force_rls); what matters
  // here is that the migration carries the exact statements the live database received.
  assert.match(MIG, /execute format\('alter table public\.%I no force row level security', t\);/);
  assert.match(MIG, /detail  = 'This Back Office sign in has not finished its second step\.'/);
  assert.match(MIG, /hint    = 'Sign out, then sign in again with Face ID, fingerprint or your authenticator app code\.'/);
});
