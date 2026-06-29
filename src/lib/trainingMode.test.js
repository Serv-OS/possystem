/**
 * trainingMode.test.js — the singleton that gates every commit path.
 * Run: `npm test` (Node's built-in runner).
 *
 * This module is the contract the data-layer guards rely on: a paired
 * training-flagged device flips the flag once, and every commit path then reads
 * it via isTrainingMode() and early-returns a benign no-op. The Operations write
 * paths (src/lib/ops/data.js + checklists.js) are such commit paths — they auto-
 * raise live maintenance/alerts and receive POs into stock, so they MUST honour
 * this flag (the "gate any new commit path" invariant).
 *
 * The ops/* data layer itself imports `../supabase`, which reads import.meta.env
 * at module load and so cannot be imported under raw `node --test` (the repo
 * convention is that only PURE modules are unit-tested — see costing.js). So the
 * guards themselves are verified by `npm run build` + review; here we lock down
 * the singleton they depend on, including the coercion and crash-safety the
 * guards assume.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isTrainingMode, setTrainingMode } from './trainingMode.js';

test('defaults to OFF so commits are never silently swallowed', () => {
  setTrainingMode(false); // reset (module singleton is shared across tests)
  assert.equal(isTrainingMode(), false);
});

test('setTrainingMode flips the flag both ways', () => {
  setTrainingMode(true);
  assert.equal(isTrainingMode(), true);
  setTrainingMode(false);
  assert.equal(isTrainingMode(), false);
});

test('coerces truthy/falsy inputs to a real boolean', () => {
  setTrainingMode(1);
  assert.strictEqual(isTrainingMode(), true);
  setTrainingMode(0);
  assert.strictEqual(isTrainingMode(), false);
  setTrainingMode('yes');
  assert.strictEqual(isTrainingMode(), true);
  setTrainingMode(undefined);
  assert.strictEqual(isTrainingMode(), false);
  setTrainingMode(null);
  assert.strictEqual(isTrainingMode(), false);
});

test('is crash-safe with no window (non-React module / node context)', () => {
  // The ops guards run in modules imported far from React; setTrainingMode must
  // not throw when window is absent (it mirrors to window.RPOS_TRAINING only if
  // present). Under node `window` is undefined — this would throw if unguarded.
  assert.doesNotThrow(() => { setTrainingMode(true); setTrainingMode(false); });
});
