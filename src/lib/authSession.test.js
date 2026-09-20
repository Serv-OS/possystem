/**
 * authSession.test.js: v5.8.57
 *
 * The rule under test: a device that still holds a refresh token NEVER gets a new
 * anonymous identity, no matter what auth-js reports. Paired tills, kiosks, menu
 * board TVs and order screen TVs are fenced on auth.uid() (devices.device_uid,
 * menu_board_screens.device_uid), so swapping it cuts them off their own rows.
 *
 * The harness fakes supabase.auth, so the three cases that matter are driven
 * exactly: the retryable fetch error (session null, session KEPT in storage), the
 * revoked refresh token (session null, storage CLEARED by auth-js), and no
 * session at all.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveAuthToken,
  isRetryableAuthError,
  readStoredSession,
  hasStoredRefreshToken,
  storedTokenUsable,
  createRetryState,
  AUTH_OUTCOMES,
  RETRYABLE_ERROR_NAME,
} from './authSession.js';

// ── harness ───────────────────────────────────────────────────────────────────

const NOW = 1_757_600_000_000;            // a fixed clock, ms
const clockAt = (ms) => () => ms;

/** The error auth-js raises from lib/fetch.ts on a network failure or a 502/503/504. */
function retryableError(message = 'Failed to fetch', status = 0) {
  const e = new Error(message);
  e.name = RETRYABLE_ERROR_NAME;
  e.__isAuthError = true;
  e.status = status;
  return e;
}

/** A definite refusal: refresh token revoked, reused, or the user is gone. */
function fatalAuthError(message = 'Invalid Refresh Token: Already Used') {
  const e = new Error(message);
  e.name = 'AuthApiError';
  e.__isAuthError = true;
  e.status = 400;
  return e;
}

/** A stored Session exactly as auth-js writes it (helpers.ts setItemAsync: plain JSON). */
function session({ access = 'tok-device', refresh = 'ref-device', expiresInSec = 60, user = 'uid-device' } = {}) {
  return {
    access_token: access,
    refresh_token: refresh,
    token_type: 'bearer',
    expires_in: expiresInSec,
    expires_at: Math.floor(NOW / 1000) + expiresInSec,
    user: { id: user, is_anonymous: false },
  };
}

/** localStorage stand-in. `locked: true` makes every read throw (Safari private mode). */
function fakeStorage(initial = {}, { locked = false } = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem(k) {
      if (locked) throw new Error('storage is not available');
      return map.has(k) ? map.get(k) : null;
    },
    setItem(k, v) { map.set(k, v); },
    removeItem(k) { map.delete(k); },
    _map: map,
  };
}

function storageWith(sess, opts) {
  return fakeStorage(sess ? { 'rpos-auth': JSON.stringify(sess) } : {}, opts);
}

/**
 * A fake supabase.auth.
 *  getSession  : one scripted answer per call, last one repeats
 *  refreshSession: same, and `clearsStorageOnFatal` reproduces auth-js removing
 *                   the session on a NON retryable error (GoTrueClient.ts:4624)
 */
function fakeAuth({ getSession = [], refreshSession = [], signInAnonymously = null, storage = null } = {}) {
  const calls = { getSession: 0, refreshSession: 0, signInAnonymously: 0, refreshTokensSeen: [] };
  const take = (list, n) => (list.length ? list[Math.min(n, list.length - 1)] : { data: { session: null }, error: null });
  return {
    calls,
    async getSession() {
      const r = take(getSession, calls.getSession++);
      if (typeof r === 'function') return r();
      if (r instanceof Error) throw r;
      return r;
    },
    async refreshSession(arg) {
      calls.refreshTokensSeen.push(arg?.refresh_token ?? null);
      const r = take(refreshSession, calls.refreshSession++);
      if (r instanceof Error) throw r;
      // auth-js clears the stored session on a definite refusal, and keeps it on
      // a retryable one. Mirror that so the fence is tested against the truth.
      if (r?.error && !isRetryableAuthError(r.error) && storage) storage.removeItem('rpos-auth');
      return r;
    },
    async signInAnonymously() {
      calls.signInAnonymously++;
      return signInAnonymously || { data: { session: { access_token: 'tok-anon', user: { id: 'uid-anon', is_anonymous: true } } }, error: null };
    },
  };
}

const ok = (sess) => ({ data: { session: sess }, error: null });
const fail = (error) => ({ data: { session: null }, error });

/** Collects the backoff delays so the budget in front of a card payment is provable. */
function recordingSleep(into) {
  return async (ms) => { into.push(ms); };
}

function run(auth, storage, extra = {}) {
  return resolveAuthToken({
    auth,
    storage,
    storageKey: 'rpos-auth',
    state: createRetryState(),
    sleep: async () => {},
    now: clockAt(NOW),
    ...extra,
  });
}

// ── the error and storage primitives ──────────────────────────────────────────

test('isRetryableAuthError matches on the auth-js name, not on message text', () => {
  assert.equal(isRetryableAuthError(retryableError()), true);
  assert.equal(isRetryableAuthError(retryableError('Service unavailable', 503)), true);
  assert.equal(isRetryableAuthError(fatalAuthError()), false);
  assert.equal(isRetryableAuthError(new Error('Failed to fetch')), false, 'a plain fetch-sounding error is not the auth-js one');
  assert.equal(isRetryableAuthError(null), false);
  assert.equal(isRetryableAuthError(undefined), false);
});

test('readStoredSession reads what auth-js writes, and survives unreadable storage', () => {
  const s = session();
  assert.deepEqual(readStoredSession(storageWith(s), 'rpos-auth'), s);
  assert.equal(readStoredSession(storageWith(null), 'rpos-auth'), null);
  assert.equal(readStoredSession(fakeStorage({ 'rpos-auth': 'not json' }), 'rpos-auth'), null);
  assert.equal(readStoredSession(storageWith(s, { locked: true }), 'rpos-auth'), null);
  assert.equal(readStoredSession(null, 'rpos-auth'), null);
  // The older wrapped shape still resolves to the session.
  const wrapped = fakeStorage({ 'rpos-auth': JSON.stringify({ currentSession: s, expiresAt: 1 }) });
  assert.deepEqual(readStoredSession(wrapped, 'rpos-auth'), s);
});

test('hasStoredRefreshToken is the identity fence', () => {
  assert.equal(hasStoredRefreshToken(session()), true);
  assert.equal(hasStoredRefreshToken({ ...session(), refresh_token: '' }), false);
  assert.equal(hasStoredRefreshToken({ access_token: 'x' }), false);
  assert.equal(hasStoredRefreshToken(null), false);
});

test('storedTokenUsable trusts only a token with real time left on it', () => {
  // auth-js refreshes 90s BEFORE expiry (EXPIRY_MARGIN_MS), so a session it calls
  // expired usually still carries a token the server accepts.
  assert.equal(storedTokenUsable(session({ expiresInSec: 60 }), { now: clockAt(NOW) }), true);
  assert.equal(storedTokenUsable(session({ expiresInSec: 1 }), { now: clockAt(NOW) }), false);
  assert.equal(storedTokenUsable(session({ expiresInSec: -30 }), { now: clockAt(NOW) }), false);
  assert.equal(storedTokenUsable({ access_token: 'x' }, { now: clockAt(NOW) }), false, 'no expiry means unknown age, so no');
  assert.equal(storedTokenUsable(null, { now: clockAt(NOW) }), false);
});

// ── 1. the ordinary path is untouched ─────────────────────────────────────────

test('a live session answers straight away, with no refresh and no sign-in', async () => {
  const auth = fakeAuth({ getSession: [ok(session())] });
  const res = await run(auth, storageWith(session()));
  assert.equal(res.token, 'tok-device');
  assert.equal(res.outcome, AUTH_OUTCOMES.SESSION);
  assert.equal(auth.calls.refreshSession, 0);
  assert.equal(auth.calls.signInAnonymously, 0);
});

// ── 2. the retryable error: the failure mode this release fixes ───────────────

test('retryable error then a retry that works: the device keeps its own identity', async () => {
  const stored = session();
  const storage = storageWith(stored);
  const auth = fakeAuth({
    getSession: [fail(retryableError())],
    refreshSession: [ok(session({ access: 'tok-fresh' }))],
    storage,
  });
  const res = await run(auth, storage);
  assert.equal(res.token, 'tok-fresh');
  assert.equal(res.outcome, AUTH_OUTCOMES.REFRESHED);
  assert.equal(res.attempts, 1);
  assert.equal(auth.calls.signInAnonymously, 0, 'NEVER swap the identity');
  assert.deepEqual(auth.calls.refreshTokensSeen, ['ref-device'], 'retried with the device own refresh token');
});

test('retryable error, retries exhausted, stored token still valid: card payments carry on as this device', async () => {
  const stored = session({ expiresInSec: 60 });   // inside auth-js 90s refresh margin
  const storage = storageWith(stored);
  const auth = fakeAuth({
    getSession: [fail(retryableError('Service unavailable', 503))],
    refreshSession: [fail(retryableError()), fail(retryableError())],
    storage,
  });
  const res = await run(auth, storage);
  assert.equal(res.token, 'tok-device', 'the device own token, not a new anonymous one');
  assert.equal(res.outcome, AUTH_OUTCOMES.STORED);
  assert.equal(res.attempts, 2);
  assert.equal(auth.calls.signInAnonymously, 0);
  assert.ok(storage.getItem('rpos-auth'), 'auth-js keeps the session on a retryable error, and so do we');
});

test('retryable error, retries exhausted, stored token spent: hold the identity and hand back nothing', async () => {
  const stored = session({ expiresInSec: -120 });
  const storage = storageWith(stored);
  const auth = fakeAuth({
    getSession: [fail(retryableError())],
    refreshSession: [fail(retryableError()), fail(retryableError())],
    storage,
  });
  const res = await run(auth, storage);
  assert.equal(res.token, null);
  assert.equal(res.outcome, AUTH_OUTCOMES.HELD);
  assert.equal(auth.calls.signInAnonymously, 0, 'a spent token is still no reason to become somebody else');
  assert.ok(storage.getItem('rpos-auth'), 'the refresh token is kept so the next call can recover');
});

test('getSession throwing is treated as transient, never as proof the token is dead', async () => {
  const stored = session();
  const storage = storageWith(stored);
  const auth = fakeAuth({
    getSession: [new Error('acquiring the lock timed out')],
    refreshSession: [ok(session({ access: 'tok-fresh' }))],
    storage,
  });
  const res = await run(auth, storage);
  assert.equal(res.token, 'tok-fresh');
  assert.equal(res.outcome, AUTH_OUTCOMES.REFRESHED);
  assert.equal(auth.calls.signInAnonymously, 0);
});

test('the retry budget in front of a card payment stays under a second', async () => {
  const delays = [];
  const stored = session();
  const storage = storageWith(stored);
  const auth = fakeAuth({
    getSession: [fail(retryableError())],
    refreshSession: [fail(retryableError()), fail(retryableError())],
    storage,
  });
  await run(auth, storage, { sleep: recordingSleep(delays) });
  assert.deepEqual(delays, [250, 750]);
  assert.ok(delays.reduce((a, b) => a + b, 0) <= 1000, 'a till operator must not be held up');
});

test('the cool-down keeps a poll loop snappy while the outage lasts', async () => {
  const state = createRetryState();
  const stored = session();
  const storage = storageWith(stored);
  const mk = () => fakeAuth({
    getSession: [fail(retryableError())],
    refreshSession: [fail(retryableError()), fail(retryableError())],
    storage,
  });

  const first = mk();
  await run(first, storage, { state });
  assert.equal(first.calls.refreshSession, 2, 'the first call pays for the retries');

  // A Stripe reader poll ticks every 1.5s. Inside the cool-down it must not pay again.
  const second = mk();
  const res = await resolveAuthToken({
    auth: second, storage, storageKey: 'rpos-auth', state,
    sleep: async () => {}, now: clockAt(NOW + 1500),
  });
  assert.equal(second.calls.refreshSession, 0, 'no second backoff inside the cool-down');
  assert.equal(second.calls.signInAnonymously, 0);
  assert.equal(res.outcome, AUTH_OUTCOMES.STORED);

  // Past the cool-down it tries again.
  const third = mk();
  await resolveAuthToken({
    auth: third, storage, storageKey: 'rpos-auth', state,
    sleep: async () => {}, now: clockAt(NOW + 20_000),
  });
  assert.equal(third.calls.refreshSession, 2);
});

// ── 3. the revoked refresh token: auth-js clears storage, so anonymous is right ─

test('a revoked refresh token is not retried, and the browser may start fresh', async () => {
  // auth-js already removed the session before getSession returned
  // (GoTrueClient.ts:4624 calls _removeSession on a non retryable error).
  const storage = storageWith(null);
  const auth = fakeAuth({ getSession: [fail(fatalAuthError())], storage });
  const res = await run(auth, storage);
  assert.equal(res.outcome, AUTH_OUTCOMES.ANONYMOUS);
  assert.equal(res.token, 'tok-anon');
  assert.equal(auth.calls.refreshSession, 0, 'a revoked token is never worth a backoff');
  assert.equal(auth.calls.signInAnonymously, 1);
});

test('revoked mid-retry: the loop stops on the refusal and does not burn the rest of the backoff', async () => {
  const stored = session();
  const storage = storageWith(stored);
  const auth = fakeAuth({
    getSession: [fail(retryableError())],          // looked transient
    refreshSession: [fail(fatalAuthError())],      // and was not: token revoked, storage cleared
    storage,
  });
  const res = await run(auth, storage);
  assert.equal(auth.calls.refreshSession, 1, 'stopped after the definite refusal');
  assert.equal(storage.getItem('rpos-auth'), null, 'auth-js removed the session, so there is no identity left to protect');
  assert.equal(res.outcome, AUTH_OUTCOMES.ANONYMOUS);
  assert.equal(auth.calls.signInAnonymously, 1);
});

test('a revoked token whose session somehow survived is still never swapped', async () => {
  // Defence in depth: if storage still holds a refresh token, the fence holds
  // even on a fatal error. Re-pairing is a decision for a person, not for a blip.
  const stored = session({ expiresInSec: -600 });
  const storage = storageWith(stored);
  const auth = fakeAuth({ getSession: [fail(fatalAuthError())] });  // no storage wiring: nothing clears it
  const res = await run(auth, storage);
  assert.equal(res.outcome, AUTH_OUTCOMES.HELD);
  assert.equal(auth.calls.signInAnonymously, 0);
});

// ── 4. no session at all: the original behaviour, unchanged ───────────────────

test('a device with no session signs in anonymously, exactly as before', async () => {
  const storage = storageWith(null);
  const auth = fakeAuth({ getSession: [ok(null)], storage });
  const res = await run(auth, storage);
  assert.equal(res.token, 'tok-anon');
  assert.equal(res.outcome, AUTH_OUTCOMES.ANONYMOUS);
  assert.equal(auth.calls.signInAnonymously, 1);
});

test('unreadable storage falls back to anonymous rather than locking the device out', async () => {
  const storage = storageWith(session(), { locked: true });
  const auth = fakeAuth({ getSession: [ok(null)] });
  const res = await run(auth, storage);
  assert.equal(res.outcome, AUTH_OUTCOMES.ANONYMOUS);
});

test('a failed anonymous sign-in reports itself instead of pretending', async () => {
  const storage = storageWith(null);
  const auth = fakeAuth({
    getSession: [ok(null)],
    signInAnonymously: { data: { session: null }, error: new Error('Anonymous sign-ins are disabled') },
    storage,
  });
  const res = await run(auth, storage);
  assert.equal(res.token, null);
  assert.equal(res.outcome, AUTH_OUTCOMES.ANON_FAILED);
  assert.match(res.error.message, /Anonymous sign-ins are disabled/);
});

test('no client at all answers null, the way mock mode expects', async () => {
  const res = await resolveAuthToken({ auth: null, storage: storageWith(null) });
  assert.equal(res.token, null);
  assert.equal(res.outcome, AUTH_OUTCOMES.NO_CLIENT);
});

// ── 5. back office: barred from minting, still helped through a blip ──────────

test('back office never mints an anonymous session, in any of these cases', async () => {
  const storage = storageWith(null);
  const auth = fakeAuth({ getSession: [ok(null)], storage });
  const res = await run(auth, storage, { allowAnonymous: false });
  assert.equal(res.token, null);
  assert.equal(res.outcome, AUTH_OUTCOMES.BLOCKED);
  assert.equal(auth.calls.signInAnonymously, 0);
});

test('back office still rides out a blip on its own session', async () => {
  const stored = session({ access: 'tok-bo', refresh: 'ref-bo', user: 'uid-manager' });
  const storage = storageWith(stored);
  const auth = fakeAuth({
    getSession: [fail(retryableError())],
    refreshSession: [ok(session({ access: 'tok-bo-fresh', user: 'uid-manager' }))],
    storage,
  });
  const res = await run(auth, storage, { allowAnonymous: false });
  assert.equal(res.token, 'tok-bo-fresh');
  assert.equal(res.outcome, AUTH_OUTCOMES.REFRESHED);
  assert.equal(auth.calls.signInAnonymously, 0);
});

// ── 6. the whole point, stated once ───────────────────────────────────────────

test('no path signs in anonymously while a refresh token is in storage', async () => {
  const cases = [
    { name: 'retryable, token valid', getSession: [fail(retryableError())], refreshSession: [fail(retryableError())], stored: session({ expiresInSec: 60 }) },
    { name: 'retryable, token spent', getSession: [fail(retryableError())], refreshSession: [fail(retryableError())], stored: session({ expiresInSec: -60 }) },
    { name: '503 on every call', getSession: [fail(retryableError('Service unavailable', 503))], refreshSession: [fail(retryableError('Service unavailable', 503))], stored: session() },
    { name: 'getSession throws', getSession: [new Error('lock timeout')], refreshSession: [fail(retryableError())], stored: session() },
    { name: 'session null with no error', getSession: [ok(null)], refreshSession: [], stored: session() },
  ];
  for (const c of cases) {
    const storage = storageWith(c.stored);
    const auth = fakeAuth({ getSession: c.getSession, refreshSession: c.refreshSession });
    const res = await run(auth, storage);
    assert.equal(auth.calls.signInAnonymously, 0, `${c.name}: identity was swapped`);
    assert.notEqual(res.token, 'tok-anon', `${c.name}: handed back an anonymous token`);
  }
});
