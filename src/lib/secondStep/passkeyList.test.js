// src/lib/secondStep/passkeyList.test.js
//
// A reset must take EVERY passkey, and the lock out must not ban the people who
// set one up.
//
// LIVE, 21 Sep 2026. Three logins on production hold a passkey. Our own record,
// public.second_step_passkeys, had a row for two of them: the third
// (peter@posup.co.uk) was made without its row ever landing, because that row is
// written by the browser in a separate call after the passkey is created.
//
// Two things followed from that one missing row:
//   1. second-step-reset sweeps the passkeys it finds in OUR table, so for that
//      login a reset would have reported a clean sweep and left the passkey
//      alive. A passkey signs in on its own, with no password.
//   2. the team list counts the same table, so that person reads as "not set
//      up" and would be caught by the lock out.
//
// And the lock out command itself, written before passkeys, counted only
// authenticator apps: on this project a passkey is NOT an auth.mfa_factors row,
// so it would have banned everyone who had done what they were asked.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SQL = readFileSync(new URL('../../../supabase/migrations/20260921s_OPS_second_step_passkey_list.sql', import.meta.url), 'utf8');
const OLD_SQL = readFileSync(new URL('../../../supabase/migrations/20260919s_OPS_second_step.sql', import.meta.url), 'utf8');
const RESET = readFileSync(new URL('../../../supabase/functions/second-step-reset/index.ts', import.meta.url), 'utf8');

test('the list comes from Supabase itself, in the id the delete route takes', () => {
  assert.match(SQL, /from auth\.webauthn_credentials w\s*\n\s*where w\.user_id = p_user/);
  // the admin route deletes by the credential ROW's uuid; both rows we recorded
  // correctly on production match auth.webauthn_credentials.id exactly
  assert.match(SQL, /select w\.id::text, w\.friendly_name, w\.created_at/);
  assert.match(SQL, /create or replace function public\.second_step_passkey_counts\(p_users uuid\[\]\)/);
});

test('neither function is reachable with a browser key', () => {
  // schema public grants EXECUTE on every new function to anon and authenticated,
  // and `revoke from public` does not take it away (v5.9.15)
  for (const fn of ['second_step_user_passkeys\\(uuid\\)', 'second_step_passkey_counts\\(uuid\\[\\]\\)']) {
    assert.match(SQL, new RegExp(`revoke all on function public\\.${fn} from public, anon, authenticated;`));
    assert.match(SQL, new RegExp(`grant execute on function public\\.${fn} to service_role;`));
  }
  assert.match(SQL, /Self test: the passkey list is not private/);
  // and it refuses on a database that has not had the passkey step
  assert.match(SQL, /The passkey step \(20260920p\) has not run/);
  assert.match(SQL, /ROLL BACK/);
});

test('the reset sweeps the union of both lists, and re-asks what is left', () => {
  const fn = RESET.slice(RESET.indexOf('async function knownPasskeyIds'), RESET.indexOf('async function sendNotice'));
  assert.match(fn, /admin\.rpc\('second_step_user_passkeys', \{ p_user: targetId \}\)/, 'Supabase first');
  assert.match(fn, /\.from\('second_step_passkeys'\)/, 'and our own record as well');
  assert.match(fn, /return \{ ids: \[\.\.\.ids\], fromSupabase \}/, 'the UNION: neither list is trusted alone');
  // "did it work" is answered by asking again, not by inference
  assert.match(fn, /if \(fromSupabase\) \{[\s\S]{0,320}left = \(\(after\.data \?\? \[\]\) as any\[\]\)\.length;/);
  // and it still works before the SQL file is run
  assert.match(fn, /if \(!rpc\.error\)/, 'a missing function is not an error, it is the fallback');
});

test('the team list counts what Supabase holds, and falls back to ours', () => {
  const team = RESET.slice(RESET.indexOf("if (action === 'team')"), RESET.indexOf('second_step: factorSummary'));
  assert.match(team, /admin\.rpc\('second_step_passkey_counts', \{ p_users: ids \}\)/);
  assert.match(team, /20260921s has not been run/, 'the old path is kept as the fallback');
});

test('the lock out counts a passkey as having set up', () => {
  const block = OLD_SQL.slice(OLD_SQL.indexOf('LOCK OUT THE ONES WHO NEVER SET UP'));
  assert.match(block, /and not exists \(select 1 from auth\.webauthn_credentials w where w\.user_id = u\.id\);/,
    'a passkey is not an mfa_factor on this project');
  assert.match(block, /A PASSKEY COUNTS \(21 Sep 2026\)/, 'and it says why, next to the command');
});
