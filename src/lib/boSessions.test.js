// boSessions.test.js: a Back Office tab says when another tab of this browser is open on its venue.
// 27 Sep 2026, Peter: "for some reason every products tax rate has been removed but they where
// there earlier". Two Back Office sessions were open at Leeds; the older one undid the newer one.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startBoSessionWatch, otherSessionEvent, BO_SESSION_CHANNEL } from './boSessions.js';

// A BroadcastChannel stand in: every channel of the same name hears every OTHER one's posts.
function fakeBus() {
  const all = [];
  class FakeChannel {
    constructor(name) { this.name = name; this.closed = false; this.onmessage = null; all.push(this); }
    postMessage(data) {
      if (this.closed) throw new Error('closed');
      for (const c of all) if (c !== this && !c.closed && c.name === this.name && c.onmessage) c.onmessage({ data });
    }
    close() { this.closed = true; }
  }
  return FakeChannel;
}

test('two tabs on the same venue each see the other; a third on another venue sees nobody', () => {
  const Channel = fakeBus();
  const seen = { a: [], b: [], c: [] };
  const stopA = startBoSessionWatch({ venue: 'leeds', tab: 'a', Channel, onChange: (n) => seen.a.push(n) });
  const stopB = startBoSessionWatch({ venue: 'leeds', tab: 'b', Channel, onChange: (n) => seen.b.push(n) });
  startBoSessionWatch({ venue: 'train-station', tab: 'c', Channel, onChange: (n) => seen.c.push(n) });
  assert.deepEqual(seen.a, [1], 'the first tab hears the second arrive');
  assert.deepEqual(seen.b, [1], 'the second hears the first answer');
  assert.deepEqual(seen.c, [], 'another venue is not a clash');
  stopB();
  assert.deepEqual(seen.a, [1, 0], 'closing the other tab clears the warning');
  stopA();
});

test('messages are read strictly', () => {
  assert.equal(otherSessionEvent({ kind: 'hello', venue: 'leeds', tab: 'x' }, { venue: 'leeds', tab: 'me' }), 'open');
  assert.equal(otherSessionEvent({ kind: 'here', venue: 'leeds', tab: 'x' }, { venue: 'leeds', tab: 'me' }), 'open');
  assert.equal(otherSessionEvent({ kind: 'bye', venue: 'leeds', tab: 'x' }, { venue: 'leeds', tab: 'me' }), 'closed');
  assert.equal(otherSessionEvent({ kind: 'hello', venue: 'leeds', tab: 'me' }, { venue: 'leeds', tab: 'me' }), null, 'never itself');
  assert.equal(otherSessionEvent({ kind: 'hello', venue: 'preston', tab: 'x' }, { venue: 'leeds', tab: 'me' }), null);
  assert.equal(otherSessionEvent({ kind: 'nonsense', venue: 'leeds', tab: 'x' }, { venue: 'leeds', tab: 'me' }), null);
  assert.equal(otherSessionEvent(null, { venue: 'leeds', tab: 'me' }), null);
  assert.equal(BO_SESSION_CHANNEL, 'rpos-bo-sessions');
});

test('no venue, or no BroadcastChannel: nothing happens and stop is harmless', () => {
  assert.doesNotThrow(() => startBoSessionWatch({ venue: null, Channel: fakeBus() })());
  assert.doesNotThrow(() => startBoSessionWatch({ venue: 'leeds', Channel: null })());
  class Broken { constructor() { throw new Error('blocked'); } }
  assert.doesNotThrow(() => startBoSessionWatch({ venue: 'leeds', Channel: Broken })());
});

test('wiring: the Back Office shows the banner for its venue', () => {
  const bo = fs.readFileSync(new URL('../backoffice/BackOfficeApp.jsx', import.meta.url), 'utf8');
  assert.match(bo, /<OtherTabBanner key=\{orgCtx\?\.locationId \|\| 'none'\} venue=\{orgCtx\?\.locationId \|\| null\} \/>/);
  assert.match(bo, /startBoSessionWatch\(\{ venue, onChange:/);
  assert.match(bo, /window\.addEventListener\('pagehide', stop\)/, 'a closed tab says goodbye');
});

test('the same sign in keeps its user object, so a tab keeps its own venue (27 Sep 2026)', async () => {
  const { sameAuthUser } = await import('./boSessions.js');
  const a = { id: 'u1', email: 'peter@x' };
  assert.equal(sameAuthUser(a, { id: 'u1', email: 'peter@x', last_sign_in_at: 'later' }), true, 'a refresh or another tab loading');
  assert.equal(sameAuthUser(a, { id: 'u2', email: 'neil@x' }), false, 'a different person');
  assert.equal(sameAuthUser(a, null), false, 'signed out');
  assert.equal(sameAuthUser(null, a), false, 'first sign in');
  const fs = await import('node:fs');
  const app = fs.readFileSync(new URL('../backoffice/BackOfficeApp.jsx', import.meta.url), 'utf8');
  assert.match(app, /setAuthUser\(prev => \(sameAuthUser\(prev, next\) \? prev : next\)\);/);
});
