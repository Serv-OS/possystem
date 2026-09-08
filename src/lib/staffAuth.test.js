/**
 * staffAuth.test.js — per-staff sign-in method enforcement (the security core).
 * Run: `node --test`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveSignIn, canOverride } from './staffAuth.js';

const STAFF = [
  { id: 'a', name: 'Ann',  pin: '1111', authMethod: 'pin' },
  { id: 'b', name: 'Bob',  pin: '2222', authMethod: 'card', nfcCardId: '04A22B3C' },
  { id: 'c', name: 'Cas',  pin: '3333', authMethod: 'pin',  nfcCardId: 'AABBCCDD' },
];

test('PIN staff signs in with their PIN', () => {
  const r = resolveSignIn(STAFF, { pin: '1111' });
  assert.equal(r.ok, true); assert.equal(r.staff.id, 'a'); assert.equal(r.method, 'pin');
});

test('CARD staff is REFUSED a PIN (the whole point)', () => {
  const r = resolveSignIn(STAFF, { pin: '2222' });
  assert.equal(r.ok, false); assert.equal(r.reason, 'use_card'); assert.equal(r.staff.id, 'b');
});

test('CARD staff PIN allowed only under manager override → method "override"', () => {
  const r = resolveSignIn(STAFF, { pin: '2222', allowOverride: true });
  assert.equal(r.ok, true); assert.equal(r.staff.id, 'b'); assert.equal(r.method, 'override');
});

test('card tap signs in the matching staff (format-insensitive)', () => {
  const r = resolveSignIn(STAFF, { cardId: '04:a2:2b:3c' });
  assert.equal(r.ok, true); assert.equal(r.staff.id, 'b'); assert.equal(r.method, 'card');
});

test('unknown card / unknown PIN', () => {
  assert.equal(resolveSignIn(STAFF, { cardId: 'FFFF' }).reason, 'card_unknown');
  assert.equal(resolveSignIn(STAFF, { pin: '9999' }).reason, 'pin_unknown');
});

test('a card on a PIN-method staff does NOT let a typed PIN through as card; PIN works normally', () => {
  // Cas is pin-method but happens to have a card → PIN still works (method pin)
  assert.equal(resolveSignIn(STAFF, { pin: '3333' }).method, 'pin');
  // and tapping Cas's card still signs Cas in
  assert.equal(resolveSignIn(STAFF, { cardId: 'AABBCCDD' }).staff.id, 'c');
});

test('canOverride: Manager role / staff perm yes; plain server no', () => {
  assert.equal(canOverride({ role: 'Manager' }), true);
  assert.equal(canOverride({ role: 'Server', permissions: ['staff'] }), true);
  assert.equal(canOverride({ role: 'Server', permissions: ['void'] }), false);
  assert.equal(canOverride(null), false);
});
