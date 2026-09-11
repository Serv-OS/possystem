/**
 * withTimeout.test.js: a hung promise can never freeze a single flight poll.
 * Run: `npm test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { withTimeout, TimeoutError } from './withTimeout.js';

test('resolves with the value when the promise is quick', async () => {
  assert.equal(await withTimeout(Promise.resolve(42), 1000, 'quick'), 42);
  assert.equal(await withTimeout('plain value', 1000), 'plain value');
});

test('passes a rejection through unchanged', async () => {
  const boom = new Error('boom');
  await assert.rejects(withTimeout(Promise.reject(boom), 1000), (e) => e === boom);
});

test('rejects with a TimeoutError when the promise hangs', async () => {
  const never = new Promise(() => {});
  await assert.rejects(withTimeout(never, 20, 'Order screen feed'), (e) => {
    assert.ok(e instanceof TimeoutError);
    assert.equal(e.code, 'TIMEOUT');
    assert.match(e.message, /Order screen feed timed out after 20 ms/);
    return true;
  });
});

test('always clears its timer', async () => {
  let cleared = 0;
  const timers = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (t) => { cleared += 1; clearTimeout(t); } };
  await withTimeout(Promise.resolve(1), 1000, 'x', timers);
  await assert.rejects(withTimeout(new Promise(() => {}), 5, 'y', timers));
  assert.equal(cleared, 2);
});

test('default timers never call the globals as an object method (browser Illegal invocation)', async () => {
  // A browser throws "Illegal invocation" when setTimeout runs with anything but window as
  // its receiver. Node does not, so this test stands in for the browser: it fails on
  // `timers = { setTimeout, clearTimeout }` (receiver = the object) and passes on wrappers.
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  let badReceiver = false;
  globalThis.setTimeout = function patchedSetTimeout(fn, ms) {
    if (this !== undefined && this !== globalThis) { badReceiver = true; throw new TypeError('Illegal invocation'); }
    return realSet(fn, ms);
  };
  globalThis.clearTimeout = function patchedClearTimeout(id) {
    if (this !== undefined && this !== globalThis) { badReceiver = true; throw new TypeError('Illegal invocation'); }
    return realClear(id);
  };
  try {
    assert.equal(await withTimeout(Promise.resolve('ok'), 50, 'probe'), 'ok');
    await assert.rejects(withTimeout(new Promise(() => {}), 5, 'slow'), TimeoutError);
    assert.equal(badReceiver, false, 'withTimeout called a global timer with the wrong receiver');
  } finally {
    globalThis.setTimeout = realSet;
    globalThis.clearTimeout = realClear;
  }
});
