// src/lib/qrTabStranded.test.js
//
// "I also have a table that says removed table, then when I try to close it with cash it
// wont, I have no idea where that came from" (Peter, 21 Sep 2026, live).
//
// Table t1 at Provo: three lines, GBP 46.00, and no way out.
//   * the floor plan showed "Removed table" (no floor_tables row: deleted while the
//     session was open, which is the tombstone that keeps the money visible),
//   * clearTable refused it, because active_sessions said source 'qr' and a QR tab holds
//     a card pre-authorisation that only Orders Hub can capture,
//   * and Orders Hub had nothing to show: the order_queue row that WAS the tab was gone.
//
// The guard is right while the tab is live. It is a dead end once the tab is not.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { qrCloseDecision, isQrTabForTable } from './qrTabStranded.js';

const STORE = readFileSync(new URL('../store/index.js', import.meta.url), 'utf8');
const qrSession = { source: 'qr', items: [{ name: 'Beer' }] };

test('a LIVE QR tab still belongs to Orders Hub', () => {
  const queue = [{ ref: 'QR-1', source: 'qr', customer: { tableId: 't1', tableLabel: 'T1' } }];
  const d = qrCloseDecision({ session: qrSession, tableId: 't1', orderQueue: queue });
  assert.deepEqual(d, { block: true, reason: 'live_tab' }, 'closing it on the floor would double charge');
});

test('Peter s table: a QR session whose tab has gone can be closed at the till', () => {
  const d = qrCloseDecision({ session: qrSession, tableId: 't1', orderQueue: [] });
  assert.deepEqual(d, { block: false, reason: 'stranded' });
  // and the same with a queue that simply holds other people's orders
  const others = [{ ref: 'OL-9', source: 'online' }, { ref: 'QR-2', source: 'qr', customer: { tableId: 't9' } }];
  assert.equal(qrCloseDecision({ session: qrSession, tableId: 't1', orderQueue: others }).block, false);
});

test('an ordinary table is never touched by this rule', () => {
  assert.deepEqual(qrCloseDecision({ session: { source: 'pos' }, tableId: 't4', orderQueue: [] }), { block: false, reason: 'not_qr' });
  assert.deepEqual(qrCloseDecision({ session: null, tableId: 't4' }), { block: false, reason: 'not_qr' });
  assert.deepEqual(qrCloseDecision({}), { block: false, reason: 'not_qr' });
});

test('a tab is matched by id, by the label the customer saw, or by its ref', () => {
  assert.equal(isQrTabForTable({ source: 'qr', customer: { tableId: 't1' } }, 't1'), true);
  assert.equal(isQrTabForTable({ source: 'qr', customer: { tableLabel: 'T1' } }, 'x', { label: 't1' }), true, 'case does not matter');
  assert.equal(isQrTabForTable({ source: 'qr', ref: 'QR-77' }, 'x', { ref: 'QR-77' }), true);
  // never match another table, and never match a non QR row
  assert.equal(isQrTabForTable({ source: 'qr', customer: { tableId: 't2' } }, 't1'), false);
  assert.equal(isQrTabForTable({ source: 'online', customer: { tableId: 't1' } }, 't1'), false);
  assert.equal(isQrTabForTable(null, 't1'), false);
});

test('both till paths ask the same question', () => {
  // clearTable (taking the money) and openTableInPOS (opening the order)
  assert.equal((STORE.match(/qrCloseDecision\(/g) || []).length, 2);
  assert.match(STORE, /const qrClose = qrCloseDecision\(\{ session: qrTable\?\.session, tableId, orderQueue: get\(\)\.orderQueue \}\);/);
  assert.match(STORE, /if \(qrClose\.block\) \{/);
  // the old unconditional refusal is gone from both
  assert.doesNotMatch(STORE, /if \(qrTable\?\.session\?\.source === 'qr'\) \{/);
  assert.doesNotMatch(STORE, /if \(t\?\.session\?\.source === 'qr'\) \{/);
  // and a stranded close says so in the log, because it is a close somebody may ask about
  assert.match(STORE, /QR session with no open tab in the queue/);
});
