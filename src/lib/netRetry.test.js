// src/lib/netRetry.test.js
//
// The contract for one retry of a request that never completed.
//
// LIVE, 20 Sep 2026: a member of staff building a menu in Back Office kept
// getting "YOUR CHANGES ARE NOT SAVING — TypeError: NetworkError when
// attempting to fetch resource". The Ops API logged ONE failed write in the
// whole of that day, so those saves never reached the database at all. These
// tests pin what may be sent again, and what must never be.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { isTransportFailure, isReplaySafe, makeRetryingFetch, RETRY_DELAYS_MS } from './netRetry.js';

const REST = 'https://x.supabase.co/rest/v1/menu_categories';
const upsert = { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=representation' } };
const never = () => new Promise(() => {});   // a sleep that never resolves, so a wrong retry hangs the test

test('every browser wording for "the request never completed" is recognised', () => {
  assert.equal(isTransportFailure(new TypeError('NetworkError when attempting to fetch resource')), true, 'Firefox, the live one');
  assert.equal(isTransportFailure(new TypeError('Failed to fetch')), true, 'Chrome');
  assert.equal(isTransportFailure(new TypeError('Load failed')), true, 'Safari');
  assert.equal(isTransportFailure({ message: 'Network request failed' }), true, 'the Android shell');
  // an HTTP error is a COMPLETED request: fetch resolves, so it never reaches here
  assert.equal(isTransportFailure(new Error('permission denied for table menu_categories')), false);
  assert.equal(isTransportFailure(new Error('JWT expired')), false);
  assert.equal(isTransportFailure(null), false);
});

test('our own abort is never a network fault', () => {
  const abort = new Error('The operation was aborted.');
  abort.name = 'AbortError';
  assert.equal(isTransportFailure(abort), false, 'a timeout or an unmount is not the network');
  assert.equal(isTransportFailure(new TypeError('aborted')), false);
});

test('what may be sent again: keyed writes and reads, nothing else', () => {
  // the menu save, which is what broke
  assert.equal(isReplaySafe(REST, upsert), true, 'an upsert is keyed, so twice is once');
  assert.equal(isReplaySafe(REST, { method: 'POST', headers: new Map() }), false, 'a plain insert could duplicate');
  assert.equal(isReplaySafe(REST, { method: 'POST' }), false);
  assert.equal(isReplaySafe(REST, { method: 'PATCH' }), true, 'applies to the rows a filter picks');
  assert.equal(isReplaySafe(REST, { method: 'DELETE' }), true);
  assert.equal(isReplaySafe(REST, undefined), true, 'a read');
  // headers in any shape supabase-js might use
  assert.equal(isReplaySafe(REST, { method: 'POST', headers: [['prefer', 'resolution=merge-duplicates']] }), true);
  assert.equal(isReplaySafe(REST, { method: 'POST', headers: new Headers({ Prefer: 'resolution=merge-duplicates' }) }), true);
  assert.equal(isReplaySafe(new Request(REST, upsert), undefined), true, 'a Request object carries its own method');
});

test('never replay anything that can count, mint, charge or sign out', () => {
  // a refresh token is single use: replaying a grant can kill the session it renews
  assert.equal(isReplaySafe('https://x.supabase.co/auth/v1/token?grant_type=refresh_token', { method: 'POST' }), false);
  assert.equal(isReplaySafe('https://x.supabase.co/auth/v1/logout', { method: 'POST' }), false);
  assert.equal(isReplaySafe('https://x.supabase.co/auth/v1/user', { method: 'GET' }), true, 'reading is fine');
  // an edge function may take a payment; a database function may mint a gift card
  assert.equal(isReplaySafe('https://x.supabase.co/functions/v1/adyen-checkout', { method: 'POST' }), false);
  assert.equal(isReplaySafe('https://x.supabase.co/rest/v1/rpc/next_order_number', { method: 'POST' }), false);
  assert.equal(isReplaySafe('https://x.supabase.co/rest/v1/rpc/decrement_stock', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates' } }), false,
    'a Prefer header does not make a database function idempotent');
});

test('a menu save that drops twice still lands', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls < 3) throw new TypeError('NetworkError when attempting to fetch resource');
    return { ok: true, status: 201 };
  };
  const slept = [];
  const f = makeRetryingFetch(fetchImpl, { sleep: (ms) => { slept.push(ms); return Promise.resolve(); } });
  const res = await f(REST, upsert);
  assert.equal(res.status, 201);
  assert.equal(calls, 3, 'the first try and both retries');
  assert.deepEqual(slept, [...RETRY_DELAYS_MS], 'it waits longer each time');
});

test('it gives up rather than hammering, and the caller still sees the real error', async () => {
  let calls = 0;
  const f = makeRetryingFetch(async () => { calls += 1; throw new TypeError('Failed to fetch'); },
    { sleep: () => Promise.resolve() });
  await assert.rejects(() => f(REST, upsert), /Failed to fetch/);
  assert.equal(calls, RETRY_DELAYS_MS.length + 1, 'three attempts, then the truth');
});

test('an order insert is NOT sent again, so a blip cannot double an order', async () => {
  let calls = 0;
  const f = makeRetryingFetch(async () => { calls += 1; throw new TypeError('Failed to fetch'); }, { sleep: never });
  await assert.rejects(() => f('https://x.supabase.co/rest/v1/order_queue', { method: 'POST' }), /Failed to fetch/);
  assert.equal(calls, 1, 'once only');
});

test('a refusal from the database is passed straight back, never retried', async () => {
  let calls = 0;
  const f = makeRetryingFetch(async () => { calls += 1; return { ok: false, status: 401 }; }, { sleep: never });
  const res = await f(REST, upsert);
  assert.equal(res.status, 401, 'fetch RESOLVES for any status; retrying would hide an expired session');
  assert.equal(calls, 1);
});

test('the clients use it, and the banner tells the truth about a dropped connection', () => {
  const client = readFileSync(new URL('./supabase.js', import.meta.url), 'utf8');
  assert.equal((client.match(/global: \{ fetch: retryingFetch \}/g) || []).length, 3, 'ops, staff and platform');
  // window.fetch called without its receiver throws "Illegal invocation" (v5.8.56)
  const mod = readFileSync(new URL('./netRetry.js', import.meta.url), 'utf8');
  assert.match(mod, /globalThis\.fetch\(input, init\)/, 'the base fetch is CALLED, never passed detached');

  const health = readFileSync(new URL('./saveHealth.js', import.meta.url), 'utf8');
  assert.match(health, /const offline = isTransportFailure\(error\)/);
  assert.match(health, /navigator\.onLine === false/);
  assert.match(health, /authy: authy && !offline/, 'a dropped connection is not an expired sign-in');
  const banner = readFileSync(new URL('../backoffice/BackOfficeApp.jsx', import.meta.url), 'utf8');
  assert.match(banner, /NO CONNECTION TO THE SERVER/);
  assert.match(banner, /health\.offline/);
});
