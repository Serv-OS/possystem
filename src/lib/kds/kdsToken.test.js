// 12 Oct 2026, Coffee Boy Barnsley (K8): the hourly sign in renewal could not reach the server for
// 3.5 minutes, and inside the Supabase client every request waited behind it. One bump was held
// for all of it, although the device's token was valid for the first two of those minutes. The
// kitchen screen's own ticket reads and writes now take the stored token while it is still valid
// and only ask the main client (and so wait) once it has truly run out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { kitchenTokenSource, KITCHEN_TOKEN_GUARD_MS } from './kdsToken.js';

const NOW = 1_800_000_000_000;
const now = () => NOW;
const store = (session) => ({ getItem: (key) => (key === 'rpos-auth' && session ? JSON.stringify(session) : null) });
/** The main client, counting how often it was asked (asking it is what waits behind a renewal). */
function mainClient(answer) {
  const m = { asked: 0, sessionToken: async () => { m.asked += 1; if (answer instanceof Error) throw answer; return answer; } };
  return m;
}
const secondsLeft = (s) => NOW / 1000 + s;

test('the guard is 10 s', () => {
  assert.equal(KITCHEN_TOKEN_GUARD_MS, 10000);
});

test('a stored token with over 10 s left is used, and the main client is never asked', async () => {
  const main = mainClient('MAIN');
  const src = kitchenTokenSource({
    storage: store({ access_token: 'STORED', refresh_token: 'r', expires_at: secondsLeft(300) }), storageKey: 'rpos-auth', sessionToken: main.sessionToken, now,
  });
  assert.equal(await src(), 'STORED');
  assert.equal(await src(), 'STORED');
  assert.equal(main.asked, 0, 'no wait behind the sign in lock');
  // 11 s left is still handed out.
  const close = kitchenTokenSource({ storage: store({ access_token: 'STORED', expires_at: secondsLeft(11) }), storageKey: 'rpos-auth', sessionToken: main.sessionToken, now });
  assert.equal(await close(), 'STORED');
  assert.equal(main.asked, 0);
});

test('under 10 s left, or run out: the main client is asked (as every request is today)', async () => {
  for (const left of [10, 5, 0, -60]) {
    const main = mainClient('MAIN');
    const src = kitchenTokenSource({ storage: store({ access_token: 'STORED', expires_at: secondsLeft(left) }), storageKey: 'rpos-auth', sessionToken: main.sessionToken, now });
    assert.equal(await src(), 'MAIN', `${left} s left`);
    assert.equal(main.asked, 1);
  }
});

test('the token is read from storage on EVERY request, so a renewed one is picked up at once', async () => {
  const main = mainClient('MAIN');
  let session = { access_token: 'OLD', expires_at: secondsLeft(3) };
  const storage = { getItem: () => JSON.stringify(session) };
  const src = kitchenTokenSource({ storage, storageKey: 'rpos-auth', sessionToken: main.sessionToken, now });
  assert.equal(await src(), 'MAIN');
  session = { access_token: 'RENEWED', expires_at: secondsLeft(3600) };
  assert.equal(await src(), 'RENEWED');
  assert.equal(main.asked, 1);
});

test('no session anywhere: null, so the client sends the public key exactly as the main client does', async () => {
  const none = mainClient(null);
  assert.equal(await kitchenTokenSource({ storage: store(null), storageKey: 'rpos-auth', sessionToken: none.sessionToken, now })(), null);
  assert.equal(none.asked, 1);
  // Stored but run out, and the main client holds no session either.
  assert.equal(await kitchenTokenSource({ storage: store({ access_token: 'STORED', expires_at: secondsLeft(-60) }), storageKey: 'rpos-auth', sessionToken: none.sessionToken, now })(), null);
  // Another storage key is another device's sign in: never used.
  const other = mainClient(null);
  assert.equal(await kitchenTokenSource({ storage: store({ access_token: 'STORED', expires_at: secondsLeft(300) }), storageKey: 'rpos-auth-office', sessionToken: other.sessionToken, now })(), null);
});

test('a main client that throws, storage that throws, or no storage at all: null, never a throw', async () => {
  const broken = mainClient(new Error('lock stolen'));
  assert.equal(await kitchenTokenSource({ storage: store(null), storageKey: 'rpos-auth', sessionToken: broken.sessionToken, now })(), null);
  const badStorage = { getItem: () => { throw new Error('storage blocked'); } };
  assert.equal(await kitchenTokenSource({ storage: badStorage, storageKey: 'rpos-auth', sessionToken: broken.sessionToken, now })(), null);
  const ok = mainClient('MAIN');
  assert.equal(await kitchenTokenSource({ storage: null, storageKey: 'rpos-auth', sessionToken: ok.sessionToken, now })(), 'MAIN');
  assert.equal(await kitchenTokenSource({ storage: { getItem: () => 'not json' }, storageKey: 'rpos-auth', sessionToken: ok.sessionToken, now })(), 'MAIN');
});

test('the older stored shape (a session wrapped in currentSession) is read too', async () => {
  const main = mainClient('MAIN');
  const src = kitchenTokenSource({ storage: store({ currentSession: { access_token: 'WRAPPED', expires_at: secondsLeft(300) } }), storageKey: 'rpos-auth', sessionToken: main.sessionToken, now });
  assert.equal(await src(), 'WRAPPED');
  assert.equal(main.asked, 0);
});
