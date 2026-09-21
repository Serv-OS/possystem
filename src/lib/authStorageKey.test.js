// src/lib/authStorageKey.test.js
//
// One browser, two kinds of sign in.
//
// LIVE, 21 Sep 2026. Peter's own device log, six hours of one evening:
//
//   TEst 1   reclaimed       33   a new auth uid every time
//   POS 1    refused_secret   7   "wrong or missing device secret"
//
// Every ServOS surface shared ONE stored session, so whoever signed in or out last
// owned the browser: a Back Office sign in knocked the till beside it off its
// identity, and the till re-claimed its row with its device secret. A device with
// no secret cannot do that and simply falls off, which is where the Provo kiosk
// ended up (awaiting_pairing). The same shared key signed the Back Office out in
// the 6 Aug incident recorded in CLAUDE.md.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { storageKeyFor, adoptSharedSession, PERSON_STORAGE_KEY, PERSON_MODES } from './authStorageKey.js';
import { DEFAULT_STORAGE_KEY } from './authSession.js';

const SUPA = readFileSync(new URL('./supabase.js', import.meta.url), 'utf8');

/** A localStorage that only exists in this test. */
const store = (seed = {}) => {
  const m = new Map(Object.entries(seed));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v), _map: m };
};
const personSession = JSON.stringify({ access_token: 'a', refresh_token: 'r', user: { id: 'u1', email: 'a@b.c', is_anonymous: false } });
const tillSession = JSON.stringify({ access_token: 'a', refresh_token: 'r', user: { id: 'u2', is_anonymous: true } });

test('a person signs in under their own key; a device keeps the shared one', () => {
  for (const mode of PERSON_MODES) assert.equal(storageKeyFor(mode), PERSON_STORAGE_KEY, mode);
  // the surfaces that must NEVER be disturbed by somebody signing in
  for (const mode of ['pos', 'kiosk', 'kds', 'bar', 'tables', 'mpos', 'clock', 'orders', 'menuboard', 'orderscreen', '']) {
    assert.equal(storageKeyFor(mode), DEFAULT_STORAGE_KEY, mode || '(no mode)');
  }
  assert.equal(storageKeyFor(undefined), DEFAULT_STORAGE_KEY);
  assert.notEqual(PERSON_STORAGE_KEY, DEFAULT_STORAGE_KEY);
});

test('an existing Back Office sign in moves across once, so nobody is signed out', () => {
  const s = store({ [DEFAULT_STORAGE_KEY]: personSession });
  assert.equal(adoptSharedSession(s), 'adopted');
  assert.equal(s.getItem(PERSON_STORAGE_KEY), personSession);
  // and the till's copy is left exactly where it was
  assert.equal(s.getItem(DEFAULT_STORAGE_KEY), personSession);
  // it never runs twice
  assert.equal(adoptSharedSession(s), 'already');
});

test("a till's anonymous session is NEVER adopted as somebody's login", () => {
  // this is the "blank back office" bug (v5.5.307): an anonymous session read as a person
  const s = store({ [DEFAULT_STORAGE_KEY]: tillSession });
  assert.equal(adoptSharedSession(s), 'anonymous');
  assert.equal(s.getItem(PERSON_STORAGE_KEY), null);
  // nor is a half written session with no refresh token
  const half = store({ [DEFAULT_STORAGE_KEY]: JSON.stringify({ user: { id: 'u', email: 'a@b.c' } }) });
  assert.equal(adoptSharedSession(half), 'anonymous');
});

test('nothing to move, or nothing readable, is never a crash', () => {
  assert.equal(adoptSharedSession(store()), 'none');
  assert.equal(adoptSharedSession(null), 'none');
  assert.equal(adoptSharedSession(store({ [DEFAULT_STORAGE_KEY]: 'not json' })), 'unreadable');
  // a device surface asks for no move at all
  assert.equal(adoptSharedSession(store({ [DEFAULT_STORAGE_KEY]: personSession }), DEFAULT_STORAGE_KEY), 'none');
});

test('the client and its token helper read the SAME key', () => {
  assert.match(SUPA, /export const AUTH_STORAGE_KEY = storageKeyFor\(getDeviceMode\(\)\);/);
  // both places that name a storage key must use that one constant, or a Back
  // Office tab would write one key and read another
  assert.equal((SUPA.match(/storageKey: AUTH_STORAGE_KEY/g) || []).length, 2);
  assert.doesNotMatch(SUPA, /storageKey: DEFAULT_STORAGE_KEY/);
  assert.match(SUPA, /adoptSharedSession\(localStorage, AUTH_STORAGE_KEY\)/);
  // the staff app keeps its own, as it has since the 6 Aug incident
  assert.match(SUPA, /storageKey: 'rpos-staff-auth'/);
});

test('switching venue never wipes the person who is signed in', () => {
  // 21 Sep 2026, live: the tenant fence wipes every rpos-* key on a venue
  // change and its keep list named 'rpos-auth' by hand. v5.9.33 moved a Back
  // Office sign in to its own key, which was NOT in that list, so every
  // location switch signed Peter out.
  const keep = SUPA.slice(SUPA.indexOf('const TENANT_FENCE_KEEP'));
  const list = keep.slice(0, keep.indexOf(']);'));
  assert.match(list, /PERSON_STORAGE_KEY/, 'a signed in person must survive the tenant fence');
  assert.match(list, /'rpos-auth'/, 'a device session must still survive it too');
  // taken from the module, never retyped, so a rename cannot leave the list behind
  assert.match(SUPA, /import \{[^}]*PERSON_STORAGE_KEY[^}]*\} from '\.\/authStorageKey'/);
});
