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
