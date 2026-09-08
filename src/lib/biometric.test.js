/**
 * biometric.test.js — capability parsing for the native fingerprint bridge.
 * Run: `node --test`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseBiometricCaps } from './biometric.js';

test('no bridge / empty → all false', () => {
  assert.deepEqual(parseBiometricCaps(null), { available: false, identify: false, verify: false, enroll: false });
  assert.deepEqual(parseBiometricCaps(''), { available: false, identify: false, verify: false, enroll: false });
});

test('legacy "true" → available + verify only (1:1), never identify', () => {
  const c = parseBiometricCaps('true');
  assert.equal(c.available, true);
  assert.equal(c.verify, true);
  assert.equal(c.identify, false);
  assert.equal(c.enroll, false);
});

test('full JSON caps parse', () => {
  const c = parseBiometricCaps('{"available":true,"identify":true,"verify":true,"enroll":true}');
  assert.deepEqual(c, { available: true, identify: true, verify: true, enroll: true });
});

test('partial caps (Sunmi SDK not wired → verify only)', () => {
  const c = parseBiometricCaps('{"available":true,"identify":false,"verify":true,"enroll":false}');
  assert.equal(c.identify, false);
  assert.equal(c.verify, true);
});

test('garbage → all false (never throws)', () => {
  assert.deepEqual(parseBiometricCaps('{not json'), { available: false, identify: false, verify: false, enroll: false });
  assert.deepEqual(parseBiometricCaps(42), { available: false, identify: false, verify: false, enroll: false });
});
