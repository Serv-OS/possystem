// backendDown.test.js — an outage must never be reported as a user's fault.
//
// 22 Sep 2026, 01:35 to 02:35 UTC. The Ops database ran out of CPU on a Micro
// instance. It did not crash; it stopped answering in time. What staff saw:
//
//   291 x 401 "unauthorized"            (auth timed out, we read the null)
//    70 x 403 "no access to this location"  (PostgREST 503, we read "no rows")
//
// Peter's words at the time: "no one can get into the back office". The real
// fault was a starving database, and the app's own words sent everyone,
// including me, chasing a permissions problem that did not exist.
//
// Every string below is one this system actually logged that night.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  looksLikeBackendDown, backendDownBody, backendDownHeaders, accessFrom, ACCESS, RETRY_AFTER_SECONDS,
} from '../../supabase/functions/_shared/backendDown.js';

const read = (rel) => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

// ── the real errors of 22 Sep ───────────────────────────────────────────────

test('the auth failures that produced 291 false 401s are recognised', () => {
  assert.equal(looksLikeBackendDown({ status: 504, message: 'context deadline exceeded' }), true);
  assert.equal(looksLikeBackendDown({ status: 500, message: 'Unhandled server error: failed to connect to `host=localhost`' }), true);
  assert.equal(looksLikeBackendDown({ name: 'AuthRetryableFetchError', message: 'Failed to fetch' }), true);
});

test('the PostgREST failures that produced 70 false 403s are recognised', () => {
  assert.equal(looksLikeBackendDown({ code: 'PGRST002', message: 'Could not query the database for the schema cache. Retrying.' }), true);
  assert.equal(looksLikeBackendDown({ code: 'PGRST000', message: 'connection to server at "localhost" (::1), port 5432 failed: Connection refused' }), true);
  assert.equal(looksLikeBackendDown({ code: '57014', message: 'canceling statement due to statement timeout' }), true);
  assert.equal(looksLikeBackendDown({ message: 'Connection terminated due to connection timeout' }), true);
});

test('a starving database, in its own words', () => {
  assert.equal(looksLikeBackendDown({ code: '53300', message: 'sorry, too many clients already' }), true);
  assert.equal(looksLikeBackendDown({ code: '57P03', message: 'the database system is starting up' }), true);
  assert.equal(looksLikeBackendDown({ status: 503 }), true);
});

// ── and, just as important, what is NOT an outage ───────────────────────────

test('a real refusal stays a real refusal', () => {
  // These must never become a 503, or a genuinely invalid token would be
  // retried for ever and a real permission problem would look like an outage.
  assert.equal(looksLikeBackendDown({ status: 401, message: 'invalid JWT: unable to parse or verify signature' }), false);
  assert.equal(looksLikeBackendDown({ status: 403, message: 'permission denied for table customers' }), false);
  assert.equal(looksLikeBackendDown({ code: 'PGRST116', message: 'The result contains 0 rows' }), false);
  assert.equal(looksLikeBackendDown({ code: '42501', message: 'new row violates row-level security policy' }), false);
  assert.equal(looksLikeBackendDown({ code: '23505', message: 'duplicate key value violates unique constraint' }), false);
  assert.equal(looksLikeBackendDown(null), false);
  assert.equal(looksLikeBackendDown(undefined), false);
});

// ── the three way answer ────────────────────────────────────────────────────

test('three reads that all answered give a real yes or no', () => {
  const yes = accessFrom([{ data: { location_id: 'L1' } }, { data: null }, { data: null }],
    ([ul, prof, dev]) => !!ul?.data || prof?.data?.role === 'super_admin' || !!dev?.data);
  assert.equal(yes, ACCESS.YES);

  const no = accessFrom([{ data: null }, { data: { role: 'manager' } }, { data: null }],
    ([ul, prof, dev]) => !!ul?.data || prof?.data?.role === 'super_admin' || !!dev?.data);
  assert.equal(no, ACCESS.NO);
});

test('one read that could not answer makes the whole verdict UNKNOWN', () => {
  // This is the bug of 22 Sep in one assertion. All three came back null
  // because PostgREST was 503ing, and null was read as "no".
  const verdict = accessFrom(
    [{ data: null, error: { code: 'PGRST002', message: 'Could not query the database for the schema cache. Retrying.' } },
     { data: null, error: { code: 'PGRST002', message: 'Could not query the database for the schema cache. Retrying.' } },
     { data: null, error: { code: 'PGRST002', message: 'Could not query the database for the schema cache. Retrying.' } }],
    () => false);
  assert.equal(verdict, ACCESS.UNKNOWN, 'a database that did not answer must never mean "you have no access"');
});

test('a genuine no-rows error does not become unknown', () => {
  const verdict = accessFrom([{ data: null, error: { code: 'PGRST116', message: 'The result contains 0 rows' } }], () => false);
  assert.equal(verdict, ACCESS.NO);
});

test('a decider that throws is unknown, never a refusal', () => {
  assert.equal(accessFrom([{ data: null }], () => { throw new Error('bad shape'); }), ACCESS.UNKNOWN);
});

// ── what the caller says out loud ───────────────────────────────────────────

test('the words staff read do not blame them', () => {
  const body = backendDownBody('sign in');
  assert.match(body.detail, /not a problem with your login/i);
  assert.match(body.detail, /try again/i);
  assert.equal(body.error, 'service_unavailable');
  assert.equal(body.part, 'sign in');
  assert.equal(backendDownHeaders()['Retry-After'], String(RETRY_AFTER_SECONDS));
});

// ── the call sites that got it wrong ────────────────────────────────────────

test('terminal-job-status no longer turns a timeout into a login failure', () => {
  const src = read('../../supabase/functions/terminal-job-status/index.ts');
  // the error from getUser is READ, not discarded
  assert.match(src, /const \{ data, error \} = await opsAdmin\.auth\.getUser\(token\)/);
  assert.match(src, /looksLikeBackendDown\(authError\)/);
  assert.match(src, /backendDownBody\('sign in'\), 503/);
  // canRead answers three ways now
  assert.match(src, /Promise<'yes' \| 'no' \| 'unknown'>/);
  assert.doesNotMatch(src, /return !!ul \|\| prof\?\.role === 'super_admin' \|\| !!dev;/,
    'the boolean that could not tell "no" from "we could not find out" is gone');
  // and both call sites act on unknown
  assert.equal((src.match(/verdict === 'unknown'/g) || []).length, 2);
});

test('the Adyen webhook will not acknowledge money it failed to record', () => {
  const src = read('../../supabase/functions/adyen-webhook/index.ts');
  // the lookup no longer swallows its own failure
  assert.doesNotMatch(src, /\} catch \(e\) \{ console\.error\('\[adyen-webhook\] terminal_jobs match:'/,
    'the try/catch that turned a failed lookup into "no such job" is gone');
  assert.match(src, /thrown\.backendDown = true/);
  // and the handler refuses the ack
  assert.match(src, /if \(res === 'unavailable'\)/);
  assert.match(src, /new Response\('backend unavailable, please retry', \{ status: 503 \}\)/);
  // an ordinary code bug is still acknowledged, or Adyen retries for ever
  assert.match(src, /\? 'unavailable' : 'failed'/);
});

test('the shared rule is used, not copied', () => {
  for (const rel of ['../../supabase/functions/terminal-job-status/index.ts',
                     '../../supabase/functions/adyen-webhook/index.ts']) {
    assert.match(read(rel), /from '\.\.\/_shared\/backendDown\.js'/, rel + ' imports the shared rule');
  }
});
