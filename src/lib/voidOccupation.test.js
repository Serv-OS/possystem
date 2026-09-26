// voidOccupation.test.js: a void closes a QR floor order that never had a seatedAt (v5.9.81).
// Leeds, 26 Sep 2026, Peter: "it still reloads after voiding". The leaked QR order on table t1 had
// openedAt and no seatedAt; the void tombstone carried seated_at null and matched nothing, so the
// till's reconciler rebuilt the table every 15 seconds.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { checkClosesOccupation, voidOccupationKey } from './rowWriteFence.js';

const read = (rel) => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const OPENED = 1782772603516;
const qr = { source: 'qr', openedAt: OPENED, items: [{ name: 'Pepperoni' }] };

test('a seated occupation closes on any check with its seatedAt, as before', () => {
  const s = { seatedAt: 1000, openedAt: 5 };
  assert.equal(checkClosesOccupation('t-1', s, { tableId: 't-1', seatedAt: 1000, method: 'card' }), true, 'a payment');
  assert.equal(checkClosesOccupation('t-1', s, { table_id: 't-1', seated_at: new Date(1000).toISOString(), voided: true }), true, 'a void, database shape');
  assert.equal(checkClosesOccupation('t-1', s, { tableId: 't-1', seatedAt: 999 }), false, 'another occupation');
  assert.equal(checkClosesOccupation('t-1', s, { tableId: 't-1', seatedAt: 5, voided: true }), false, 'a seated session is never keyed on openedAt');
  assert.equal(checkClosesOccupation('t-2', s, { tableId: 't-1', seatedAt: 1000 }), false, 'another table');
});

test('a QR floor order with no seatedAt closes ONLY on a VOID keyed on its openedAt', () => {
  assert.equal(checkClosesOccupation('t1', qr, { table_id: 't1', seated_at: new Date(OPENED).toISOString(), voided: true, status: 'void' }), true);
  assert.equal(checkClosesOccupation('t1', qr, { tableId: 't1', seatedAt: OPENED, status: 'void' }), true, 'store shape, status only');
  assert.equal(checkClosesOccupation('t1', qr, { tableId: 't1', seatedAt: OPENED, method: 'card' }), false, 'a PAYMENT never keys on openedAt (an open QR sub tab can share it)');
  assert.equal(checkClosesOccupation('t1', qr, { tableId: 't1', seatedAt: null, voided: true }), false, 'the old tombstones (seated_at null) still match nothing');
  assert.equal(checkClosesOccupation('t1', qr, { tableId: 't1', seatedAt: OPENED + 1, voided: true }), false, 'a later QR occupation is not closed by an earlier void');
  assert.equal(checkClosesOccupation('t1', { source: 'qr' }, { tableId: 't1', seatedAt: OPENED, voided: true }), false, 'no key at all: never closed');
  assert.equal(checkClosesOccupation('t1', null, { tableId: 't1', seatedAt: OPENED, voided: true }), false);
});

test('the void stores seatedAt, else openedAt, else nothing', () => {
  assert.equal(voidOccupationKey({ seatedAt: 1000, openedAt: 5 }), 1000);
  assert.equal(voidOccupationKey(qr), OPENED);
  assert.equal(voidOccupationKey({ openedAt: new Date(OPENED).toISOString() }), OPENED);
  assert.equal(voidOccupationKey({}), null);
  assert.equal(voidOccupationKey(null), null);
});

test('pins: the void writes the key, and every closed test uses the one rule', () => {
  const store = read('../store/index.js');
  assert.match(store, /voided: true, status: 'void', method: 'void',\n[^\n]*\n[^\n]*\n\s+seatedAt: voidOccupationKey\(session\),/);
  const closure = read('../sync/sessionClosure.js');
  assert.match(closure, /if \(checkClosesOccupation\(tableId, session, c\)\) return true;/);
  const master = read('../sync/MasterSync.js');
  assert.match(master, /checkClosesOccupation\(tableId, sess, c\)/, 'the boot closed set knows the void rule too');
  const row = read('./closedCheckRow.js');
  assert.match(row, /seated_at:\s+check\.seatedAt \? new Date\(check\.seatedAt\)\.toISOString\(\) : null/, 'the tombstone key reaches the database');
});
