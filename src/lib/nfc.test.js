/**
 * nfc.test.js — card UID normalisation (must match consistently across readers/tills).
 * Run: `node --test`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeCardId } from './nfc.js';

test('uppercases + strips separators/spaces', () => {
  assert.equal(normalizeCardId('04:a2:2b:3c'), '04A22B3C');
  assert.equal(normalizeCardId('04 a2 2b 3c'), '04A22B3C');
  assert.equal(normalizeCardId('04-a2-2b-3c'), '04A22B3C');
  assert.equal(normalizeCardId(' 04a22b3c '), '04A22B3C');
});

test('same physical card → same id regardless of formatting', () => {
  assert.equal(normalizeCardId('AA:BB:CC:DD'), normalizeCardId('aabbccdd'));
});

test('null/empty → empty string (never throws)', () => {
  assert.equal(normalizeCardId(null), '');
  assert.equal(normalizeCardId(undefined), '');
  assert.equal(normalizeCardId(''), '');
});
