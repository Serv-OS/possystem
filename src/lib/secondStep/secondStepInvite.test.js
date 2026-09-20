// src/lib/secondStep/secondStepInvite.test.js
//
// PROOF OF THE EMAIL BEFORE A FIRST SECOND STEP (fix round, 20 Sep 2026, BLOCKER).
//
// A password on its own must never be enough to SET a second step up. 7 of the 13 live logins
// had not signed in for 30 days: a thief with one of those passwords could have enrolled their
// own authenticator app, reached aal2 and been that person for good, with the second step
// protecting the thief. These are the rules of the code we email first
// (supabase/functions/_shared/second-step-invite-rules.ts), plus static checks on the SQL hook
// and the edge function that use them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  CODE_LENGTH, CODE_TTL_MS, MAX_ATTEMPTS, RESEND_WAIT_MS,
  codeFromBytes, normalizeCode, maySend, checkCode, codeMessage, inviteDecision,
} from '../../../supabase/functions/_shared/second-step-invite-rules.ts';

const read = (p) => fs.readFileSync(new URL(`../../../${p}`, import.meta.url), 'utf8');
const NOW = Date.parse('2026-09-20T20:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const row = (over = {}) => ({
  user_id: 'u1', code_hash: 'hash-of-123456', attempts: 0,
  created_at: iso(NOW - 5000), expires_at: iso(NOW + CODE_TTL_MS), proved_at: null, used_at: null, ...over,
});

test('the code is 6 digits, and what people type is read the way they type it', () => {
  assert.equal(codeFromBytes([10, 21, 32, 43, 54, 65, 76, 87]).length, CODE_LENGTH);
  assert.match(codeFromBytes([1, 2, 3, 4, 5, 6]), /^\d{6}$/);
  assert.equal(normalizeCode(' 123 456 '), '123456');
  assert.equal(normalizeCode('123-456'), '123456');
  assert.equal(normalizeCode(null), '');
});

test('one code a minute, so nobody can be buried in emails', () => {
  assert.equal(maySend(null, NOW).ok, true, 'the first one always goes');
  assert.equal(maySend(row({ created_at: iso(NOW - 1000) }), NOW).ok, false);
  assert.ok(maySend(row({ created_at: iso(NOW - 1000) }), NOW).waitMs > 0);
  assert.equal(maySend(row({ created_at: iso(NOW - RESEND_WAIT_MS - 1) }), NOW).ok, true);
});

test('only the code we sent, only once, only for an hour, only five tries', () => {
  assert.equal(checkCode(row(), '123456', 'hash-of-123456', NOW), 'ok');
  assert.equal(checkCode(row(), '999999', 'hash-of-999999', NOW), 'wrong');
  assert.equal(checkCode(null, '123456', 'hash-of-123456', NOW), 'none', 'never asked for one');
  assert.equal(checkCode(row({ used_at: iso(NOW - 10) }), '123456', 'hash-of-123456', NOW), 'used');
  assert.equal(checkCode(row({ expires_at: iso(NOW - 1) }), '123456', 'hash-of-123456', NOW), 'expired');
  assert.equal(checkCode(row({ attempts: MAX_ATTEMPTS }), '123456', 'hash-of-123456', NOW), 'too_many');
  assert.equal(checkCode(row(), '12345', 'hash-of-12345', NOW), 'wrong', 'a short code is never right');
  for (const outcome of ['none', 'expired', 'used', 'too_many', 'wrong']) {
    assert.ok(codeMessage(outcome).length > 10, `${outcome} says what to do`);
    assert.doesNotMatch(codeMessage(outcome), /[–—]/);
  }
});

test('an owner can set up their own staff; nobody invites themselves', () => {
  const owner = { id: 'o1', isSuperAdmin: false, ownedVenues: ['A'] };
  const servos = { id: 's1', isSuperAdmin: true, ownedVenues: [] };
  const staffAtA = { id: 'm1', venues: ['A'], hasVerifiedFactor: false };
  assert.equal(inviteDecision(owner, staffAtA).ok, true);
  assert.equal(inviteDecision(servos, staffAtA).ok, true);
  assert.equal(inviteDecision(servos, { id: 'x', venues: [], hasVerifiedFactor: false }).ok, true, 'even a login with no venue');
  assert.equal(inviteDecision(owner, { ...staffAtA, id: 'o1' }).code, 'self');
  assert.equal(inviteDecision(servos, { ...staffAtA, id: 's1' }).code, 'self');
  assert.equal(inviteDecision(owner, { id: 'm2', venues: ['A', 'B'], hasVerifiedFactor: false }).code, 'other_venue');
  assert.equal(inviteDecision(owner, { id: 'm3', venues: [], hasVerifiedFactor: false }).code, 'no_venue');
  assert.equal(inviteDecision({ id: 'm9', isSuperAdmin: false, ownedVenues: [] }, staffAtA).code, 'not_owner');
  assert.equal(inviteDecision(owner, { ...staffAtA, hasVerifiedFactor: true }).code, 'already_set_up',
    'someone who already has one is a RESET, not an invite');
  for (const d of [inviteDecision(owner, { ...staffAtA, id: 'o1' }), inviteDecision(owner, { id: 'm2', venues: ['A', 'B'], hasVerifiedFactor: false })]) {
    assert.doesNotMatch(d.message, /[–—]/);
  }
});

test('the DATABASE is what enforces it: the Supabase MFA hook, not the screens', () => {
  const sql = read('supabase/migrations/20260919s_OPS_second_step.sql');
  assert.match(sql, /create or replace function public\.second_step_mfa_hook\(event jsonb\)/);
  assert.match(sql, /grant execute on function public\.second_step_mfa_hook\(jsonb\) to supabase_auth_admin/,
    'the auth server is the only caller');
  assert.match(sql, /revoke all on function public\.second_step_mfa_hook\(jsonb\) from public, anon, authenticated/);
  // signing in is never touched, and adding a second factor needs no new code
  assert.match(sql, /SIGNING IN IS NEVER TOUCHED/);
  assert.match(sql, /select coalesce\(bool_or\(f\.status = 'verified'\), false\) into v_this_is_new/);
  // and the switch on step bans anyone who never set one up, so the hook is not the only lock
  assert.match(sql, /update auth\.users u set banned_until = 'infinity'/);
  assert.match(sql, /second_step_reach\(u\.id\) = 'back_office'/);
});

test('the edge function never sends the code anywhere but the address on the account', () => {
  const fn = read('supabase/functions/second-step-invite/index.ts');
  assert.match(fn, /emailCode\(String\(me\.email \?\? ''\), code, await venueForEmail\(me\.id\), false\)/);
  assert.doesNotMatch(fn, /body\.email/, 'never an address from the body');
  assert.match(fn, /issued_kind: 'self'/);
  assert.match(fn, /const needs = requireAal2\(req, \[SERVICE_ROLE\]\);/, 'inviting SOMEONE ELSE needs your own second step');
  assert.match(fn, /if \(me\.is_anonymous\) return json\(\{ error: 'not allowed' \}, 403\);/);
  assert.match(fn, /crypto\.subtle\.digest\('SHA-256'/, 'the code is stored hashed');
  assert.doesNotMatch(fn, /[–—]/);
});

test('the screens ask for the code before a FIRST set up, and never instead of the server', () => {
  const gate = read('src/components/secondStep/SecondStepGate.jsx');
  assert.match(gate, /phase === 'prove'/);
  assert.match(gate, /client\.emailProofStatus\(\)/);
  // From 20 Sep 2026 the plan is decided by the rules, and 'prove_email' still comes FIRST:
  // a stolen password must never be enough to register the thief's own passkey.
  assert.match(gate, /emailProved: p\.proved, needsEmail: p\.needs_email/);
  assert.match(gate, /if \(next === 'prove_email'\) \{ setPhase\('prove'\); return; \}/);
  assert.match(gate, /Email me a code/);
  const client = read('src/lib/secondStep/client.js');
  for (const call of ['emailProofStatus', 'sendEmailCode', 'claimEmailCode']) {
    assert.ok(client.includes(`async function ${call}(`), `${call} is in the client`);
  }
  // the screens must fail SAFE if the function is not deployed yet: the database is the lock
  assert.match(client, /catch \{ return \{ needs_email: false, proved: false, sentTo: '' \}; \}/);
});
