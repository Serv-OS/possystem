// v5.9.72: a void leaves the same tombstone a payment does (Leeds, 26 Sep 2026: "this order is
// being voided but still coming back"), demo tabs stay in demo mode, a kitchen screen never
// publishes tables or tabs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { closedCheckRow } from './closedCheckRow.js';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');

test('a voided tombstone reaches the row as voided, status void, nothing on it', () => {
  const row = closedCheckRow({ id: 'void-1', tableId: 't1', items: [{ name: 'Latte', voided: true }], total: 0, subtotal: 0, method: 'void', status: 'void', voided: true, seatedAt: 1786124809674 }, 'loc-1');
  assert.equal(row.voided, true);
  assert.equal(row.status, 'void');
  assert.equal(row.method, 'void');
  assert.equal(Number(row.total), 0);
  assert.equal(row.seated_at, new Date(1786124809674).toISOString(), 'the occupation key every device tombstones on');
  assert.equal(closedCheckRow({ id: 'c1', tableId: 't1', items: [], total: 5, method: 'card' }, 'loc-1').voided, false, 'a normal close is not voided');
});

test('pins: voidCheck writes the tombstone; demo tabs only in mock; a KDS never publishes', () => {
  const store = read('../store/index.js');
  const v = store.slice(store.indexOf('  voidCheck: (tableId, { manager, reason }) => {'), store.indexOf('  // ── Discounts'));
  assert.match(v, /voided: true, status: 'void', method: 'void',/);
  assert.match(v, /set\(s => \(\{ closedChecks: \[tomb, \.\.\.\(s\.closedChecks \|\| \[\]\)\] \}\)\);/, 'the tombstone is in memory at once, so this device never republishes');
  assert.match(v, /insertClosedCheck\(tomb\);/);
  assert.match(store, /seedTabs: \(\) => \{ if \(!isMock\) return; set\(\{ tabs:\[/);
  assert.match(read('../surfaces/BarSurface.jsx'), /if \(tabs\.length===0 && isMock\) seedTabs\(\);/);
  assert.match(read('../sync/SessionSync.js'), /if \(getDeviceMode\(\) === 'kds'\) return;/);
  assert.match(read('../sync/SessionSync.js'), /if \(getDeviceMode\(\) === 'kds'\) return;   \/\/ v5\.9\.72: a kitchen screen never resurrects a table/);
  assert.match(read('../sync/SyncBridge.jsx'), /if \(!isMock && getDeviceMode\(\) !== 'kds'\) startSessionReconciler\(\);/);
  assert.match(read('../sync/QueueSync.js'), /const tabs = getDeviceMode\(\) === 'kds' \? \[\] : \(state\.tabs \|\| \[\]\);/);
});
