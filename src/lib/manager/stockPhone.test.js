// node --test: counting and waste on the phone, the client side (v5.11.82, multi site stock Drop 0:
// Phase 1b re landed, plan 4.23). The server side (_shared/stockPhone.js) has its own test.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { queueEntry, pendingEntries, flushEntries, isFlushing, findByCode, toBaseQty, qtyWords, phoneStockNotReady, BATCH } from './stockPhone.js';

const store = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) }; };
const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');

test('figures wait on the phone and survive a dropped signal', async () => {
  const s = store();
  queueEntry('c1', { item_id: U(1), qty_base: 5, counted_at: '2026-10-19T10:00:00Z' }, { store: s });
  queueEntry('c1', { item_id: U(2), qty_base: 3, counted_at: '2026-10-19T10:01:00Z' }, { store: s });
  queueEntry('c1', { item_id: U(1), qty_base: 6, counted_at: '2026-10-19T10:02:00Z' }, { store: s });
  assert.deepEqual(pendingEntries('c1', { store: s }).map((e) => [e.item_id, e.qty_base]), [[U(2), 3], [U(1), 6]], 'the newest figure for an item replaces the older');
  let r = await flushEntries('c1', async () => ({ ok: false, error: 'offline' }), { store: s });
  assert.deepEqual([r.sent, r.left, r.error], [0, 2, 'offline']);
  assert.equal(pendingEntries('c1', { store: s }).length, 2, 'nothing lost');
  const thrown = await flushEntries('c1', async () => { throw new Error('Failed to fetch'); }, { store: s });
  assert.equal(thrown.error, 'Failed to fetch'); assert.equal(pendingEntries('c1', { store: s }).length, 2);
  const got = [];
  r = await flushEntries('c1', async (batch, sentAt) => { got.push(...batch); assert.ok(sentAt); return { ok: true }; }, { store: s });
  assert.deepEqual([r.sent, r.left], [2, 0]);
  assert.equal(got[1].counted_at, '2026-10-19T10:02:00Z', 'each figure keeps the time it was typed');
  assert.equal(pendingEntries('c1', { store: s }).length, 0);
});

test('a figure typed again while a batch is in flight is kept and goes in the next batch', async () => {
  const s = store();
  for (let i = 0; i < BATCH + 5; i++) queueEntry('c2', { item_id: U(i), qty_base: i, counted_at: `2026-10-19T10:00:${String(i % 60).padStart(2, '0')}Z` }, { store: s });
  let first = true;
  const r = await flushEntries('c2', async () => {
    if (first) { first = false; queueEntry('c2', { item_id: U(0), qty_base: 99, counted_at: '2026-10-19T11:00:00Z' }, { store: s }); }
    return { ok: true };
  }, { store: s });
  assert.equal(r.error, null);
  assert.ok(r.sent >= BATCH + 5, `${r.sent} sent`);
  assert.equal(pendingEntries('c2', { store: s }).length, 0, 'the newer figure went in the next batch');
});

test('in flight guard: the 5 second send and Approve never send the same figures twice', async () => {
  const s = store();
  queueEntry('c3', { item_id: U(1), qty_base: 4, counted_at: '2026-10-19T10:00:00Z' }, { store: s });
  queueEntry('c3', { item_id: U(2), qty_base: 1, counted_at: '2026-10-19T10:00:01Z' }, { store: s });
  let release;
  const gate = new Promise((res) => { release = res; });
  const sends = [];
  const send = async (batch) => { sends.push(batch.map((e) => e.item_id)); await gate; return { ok: true }; };
  const a = flushEntries('c3', send, { store: s });      // the timer's send
  assert.equal(isFlushing('c3'), true);
  const b = flushEntries('c3', send, { store: s });      // Approve pressed while it runs
  assert.equal(a, b, 'the second call gets the send that is running, not a second send');
  release();
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(sends.length, 1, 'the figures went once');
  assert.deepEqual(ra, rb); assert.equal(ra.sent, 2);
  assert.equal(isFlushing('c3'), false, 'the guard is let go when the send ends');
  // a failed send lets go too, so the next one can run
  queueEntry('c3', { item_id: U(3), qty_base: 2, counted_at: '2026-10-19T10:05:00Z' }, { store: s });
  await flushEntries('c3', async () => ({ ok: false, error: 'offline' }), { store: s });
  assert.equal(isFlushing('c3'), false);
  const again = await flushEntries('c3', async () => ({ ok: true }), { store: s });
  assert.equal(again.sent, 1);
  // two counts send side by side: the guard is per count
  queueEntry('c4', { item_id: U(1), qty_base: 1 }, { store: s });
  queueEntry('c5', { item_id: U(1), qty_base: 1 }, { store: s });
  const [x, y] = [flushEntries('c4', async () => ({ ok: true }), { store: s }), flushEntries('c5', async () => ({ ok: true }), { store: s })];
  assert.notEqual(x, y);
  await Promise.all([x, y]);
});

test('barcode then SKU; packs to base units; words', () => {
  const items = [{ id: 'a', barcode: '5000', sku: 'MILK', base_unit: 'ml', count_pack: { name: 'Case', qty: 6000 } }, { id: 'b', barcode: null, sku: 'beans', base_unit: 'kg' }];
  assert.equal(findByCode(items, ' 5000 ').id, 'a');
  assert.equal(findByCode(items, 'BEANS').id, 'b');
  assert.equal(findByCode(items, 'nope'), null);
  assert.equal(findByCode(items, ''), null);
  assert.equal(toBaseQty('2', items[0]), 12000);
  assert.equal(toBaseQty('2', items[0], false), 2);
  assert.equal(toBaseQty('1,5', items[1]), 1.5);
  assert.equal(toBaseQty('', items[1]), null);
  assert.equal(toBaseQty('-1', items[1]), null);
  assert.equal(qtyWords(9000, items[0]), '1.5 Case (9000 ml)');
  assert.equal(qtyWords(2, items[1]), '2 kg');
  assert.equal(qtyWords(null, items[1]), '');
  assert.equal(phoneStockNotReady('Unknown action: stock.areas'), true);
  assert.equal(phoneStockNotReady('PIN not recognised'), false);
});

test('the Kitchen tab opens counting only where there is stock; the sheet is the manager-approve stock actions (source)', () => {
  const kitchen = read('../../surfaces/manager/ManagerKitchen.jsx');
  assert.match(kitchen, /^import ManagerStock from '\.\/ManagerStock';$/m);
  assert.match(kitchen, /if \(stockOpen\) return <ManagerStock ctx=\{ctx\} onClose=\{\(\) => setStockOpen\(false\)\} \/>;/);
  assert.match(kitchen, /const hasStock = snap\?\.kitchen\?\.trackedItems != null \? snap\.kitchen\.trackedItems > 0 : items\.length > 0;/);
  assert.match(kitchen, /data-testid="manager-stock-open"/);
  assert.match(kitchen, /scanInvoice\(b64, f\.type, loc\)/, 'the delivery note scan names the venue');
  const stock = read('../../surfaces/manager/ManagerStock.jsx');
  for (const action of ['stock.areas', 'stock.count_open', 'stock.count_sheet', 'stock.count_save', 'stock.items', 'stock.waste']) {
    assert.ok(stock.includes(`'${action}'`), action);
  }
  assert.match(stock, /managerApprove\(loc, approvePin, 'stock\.count_approve', count\.id\)/, 'approve is the manager PIN, not the unlock PIN');
  assert.match(stock, /const r = await flushEntries\(count\.id, async \(batch, sentAt\) => \{/, 'every send goes through the guarded flush');
  assert.match(stock, /await flush\(\);\s+\/\/[^\n]*\n\s+if \(pendingEntries\(count\.id\)\.length\) await flush\(\);/, 'Approve sends what waits first');
  assert.match(stock, /const t = setInterval\(flush, 5000\);\s+return \(\) => clearInterval\(t\);/);
  for (const [name, text] of [['ManagerStock.jsx', stock], ['stockPhone.js', read('./stockPhone.js')]]) {
    assert.doesNotMatch(text, /[\u2013\u2014]/, `${name}: no long dashes`);
  }
});
