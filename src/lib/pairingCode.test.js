/**
 * pairingCode.test.js: TV pairing code shape and rejection sampling.
 * Run: `node --test`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { generatePairingCode, PAIRING_ALPHABET } from './pairingCode.js';

const SHAPE = /^[ABCDEFGHJKMNPQRSTVWXYZ23456789]{4}-[ABCDEFGHJKMNPQRSTVWXYZ23456789]{4}$/;

test('alphabet is the 30 unambiguous symbols', () => {
  assert.equal(PAIRING_ALPHABET.length, 30);
  assert.equal(new Set(PAIRING_ALPHABET).size, 30);
  for (const bad of 'ILOU01') assert.equal(PAIRING_ALPHABET.includes(bad), false);
});

test('1000 codes match the XXXX-XXXX shape', () => {
  for (let i = 0; i < 1000; i++) assert.match(generatePairingCode(), SHAPE);
});

test('bytes of 240 or more are skipped', () => {
  // 240..255 must be rejected; 0 maps to A, 29 to 9, 30 wraps to A, 239 maps to 9.
  const feed = [240, 255, 0, 250, 29, 30, 241, 239, 1, 2, 3, 245];
  let pos = 0;
  const source = (n) => {
    const out = [];
    for (let i = 0; i < n; i++) out.push(pos < feed.length ? feed[pos++] : 0);
    return out;
  };
  // Accepted in order: 0 A, 29 9, 30 A, 239 9, 1 B, 2 C, 3 D, then padding 0 A.
  assert.equal(generatePairingCode(source), 'A9A9-BCDA');
});

test('a source that only gives rejected bytes still returns a valid code', () => {
  assert.match(generatePairingCode(() => new Uint8Array(16).fill(250)), SHAPE);
});

test('no secure source falls back to Math.random', () => {
  assert.match(generatePairingCode(() => null), SHAPE);
  assert.match(generatePairingCode(() => { throw new Error('no crypto'); }), SHAPE);
});
