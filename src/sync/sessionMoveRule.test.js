// sessionMoveRule.test.js: when one session id on two tables is a move (16 Oct 2026, audit item 6).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sameOccupation, clearAsMoved, skipAsMovedHere, MOVE_GRACE_MS } from './sessionMoveRule.js';

const NOW = 1792166400000;
const old = NOW - 10 * 60 * 1000;   // seated 10 minutes ago, well past the grace

test('a transfer keeps id and seatedAt: same occupation', () => {
  const s = { id: 'ORD-1001', seatedAt: old, items: [{}] };
  assert.equal(sameOccupation(s, { ...s, items: [] }), true);
});

test('THE LIVE BUG: two parties sharing ORD-1001 with different seatedAt are NOT the same party', () => {
  const t1 = { id: 'ORD-1001', seatedAt: NOW - 60 * 60 * 1000 };
  const t2 = { id: 'ORD-1001', seatedAt: NOW - 26 * 60 * 60 * 1000 };
  assert.equal(sameOccupation(t1, t2), false);
  // so the reconciler keeps this till's live T1 instead of clearing it
  assert.equal(clearAsMoved({ tableId: 'T1', local: t1, dbHomeTableId: 'T2', dbHomeSession: t2, now: NOW }), false);
  // and adds the other device's T2 instead of hiding it
  assert.equal(skipAsMovedHere({ tableId: 'T2', dbSession: t2, localHomeTableId: 'T1', localHomeSession: t1 }), false);
});

test('a combine: the source id inside absorbedSessions is the same party whatever seatedAt says', () => {
  const src = { id: 'ORD-a', seatedAt: old };
  const dest = { id: 'ORD-b', seatedAt: old - 5000, absorbedSessions: ['ORD-a'] };
  assert.equal(sameOccupation(src, dest), true);
  assert.equal(clearAsMoved({ tableId: 'T1', local: src, dbHomeTableId: 'T3', dbHomeSession: dest, now: NOW }), true);
  assert.equal(skipAsMovedHere({ tableId: 'T1', dbSession: src, localHomeTableId: 'T3', localHomeSession: dest }), true);
});

test('a real move a sleeping device missed is still cleared (the 26 Aug duplicate party)', () => {
  const s = { id: 'ORD-x', seatedAt: old };
  assert.equal(clearAsMoved({ tableId: 'T1', local: s, dbHomeTableId: 'T3', dbHomeSession: { ...s }, now: NOW }), true);
});

test('never cleared inside the 30 second grace, even when it looks like a move', () => {
  const s = { id: 'ORD-x', seatedAt: NOW - (MOVE_GRACE_MS - 1000) };
  assert.equal(clearAsMoved({ tableId: 'T1', local: s, dbHomeTableId: 'T3', dbHomeSession: { ...s }, now: NOW }), false);
  const after = { id: 'ORD-x', seatedAt: NOW - (MOVE_GRACE_MS + 1000) };
  assert.equal(clearAsMoved({ tableId: 'T1', local: after, dbHomeTableId: 'T3', dbHomeSession: { ...after }, now: NOW }), true);
});

test('never cleared on the active table', () => {
  const s = { id: 'ORD-x', seatedAt: old };
  assert.equal(clearAsMoved({ tableId: 'T1', local: s, dbHomeTableId: 'T3', dbHomeSession: { ...s }, activeTableId: 'T1', now: NOW }), false);
});

test('the same table, a missing home or a missing session is never a move', () => {
  const s = { id: 'ORD-x', seatedAt: old };
  assert.equal(clearAsMoved({ tableId: 'T1', local: s, dbHomeTableId: 'T1', dbHomeSession: s, now: NOW }), false);
  assert.equal(clearAsMoved({ tableId: 'T1', local: s, dbHomeTableId: null, dbHomeSession: null, now: NOW }), false);
  assert.equal(clearAsMoved({ tableId: 'T1', local: null, dbHomeTableId: 'T3', dbHomeSession: s, now: NOW }), false);
  assert.equal(skipAsMovedHere({ tableId: 'T1', dbSession: s, localHomeTableId: 'T1', localHomeSession: s }), false);
  assert.equal(sameOccupation({ seatedAt: old }, { seatedAt: old }), false); // no id, no match
});

test('old QR tabs with no seatedAt on either side keep the id-only answer', () => {
  assert.equal(sameOccupation({ id: 'qr-1' }, { id: 'qr-1' }), true);
  assert.equal(sameOccupation({ id: 'qr-1' }, { id: 'qr-1', seatedAt: old }), false);
});

test('seatedAt compares as text, so a number and its string are the same', () => {
  assert.equal(sameOccupation({ id: 'a', seatedAt: 123 }, { id: 'a', seatedAt: '123' }), true);
});
