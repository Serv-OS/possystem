// node --test: counting and waste on the phone (v5.11.80, multi site stock Phase 1b).
import test from 'node:test';
import assert from 'node:assert/strict';
import { queueEntry, pendingEntries, flushEntries, findByCode, toBaseQty, qtyWords, BATCH } from './stockPhone.js';
import { countedAt, cleanEntries, save, openCount, waste, CLOCK_SLACK_MS } from '../../../supabase/functions/_shared/stockPhone.js';

const store = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) }; };
const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

test('figures wait on the phone and survive a dropped signal', async () => {
  const s = store();
  queueEntry('c1', { item_id: U(1), qty_base: 5, counted_at: '2026-10-19T10:00:00Z' }, { store: s });
  queueEntry('c1', { item_id: U(2), qty_base: 3, counted_at: '2026-10-19T10:01:00Z' }, { store: s });
  queueEntry('c1', { item_id: U(1), qty_base: 6, counted_at: '2026-10-19T10:02:00Z' }, { store: s });
  assert.deepEqual(pendingEntries('c1', { store: s }).map((e) => [e.item_id, e.qty_base]), [[U(2), 3], [U(1), 6]], 'the newest figure for an item replaces the older');
  let r = await flushEntries('c1', async () => ({ ok: false, error: 'offline' }), { store: s });
  assert.deepEqual([r.sent, r.left, r.error], [0, 2, 'offline']);
  assert.equal(pendingEntries('c1', { store: s }).length, 2, 'nothing lost');
  const got = [];
  r = await flushEntries('c1', async (batch, sentAt) => { got.push(...batch); assert.ok(sentAt); return { ok: true }; }, { store: s });
  assert.deepEqual([r.sent, r.left], [2, 0]);
  assert.equal(got[1].counted_at, '2026-10-19T10:02:00Z', 'each figure keeps the time it was typed');
  assert.equal(pendingEntries('c1', { store: s }).length, 0);
});

test('a figure typed again while a batch is in flight is kept', async () => {
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

test('barcode then SKU; packs to base units; words', () => {
  const items = [{ id: 'a', barcode: '5000', sku: 'MILK', base_unit: 'ml', count_pack: { name: 'Case', qty: 6000 } }, { id: 'b', barcode: null, sku: 'beans', base_unit: 'kg' }];
  assert.equal(findByCode(items, ' 5000 ').id, 'a');
  assert.equal(findByCode(items, 'BEANS').id, 'b');
  assert.equal(findByCode(items, 'nope'), null);
  assert.equal(toBaseQty('2', items[0]), 12000);
  assert.equal(toBaseQty('2', items[0], false), 2);
  assert.equal(toBaseQty('1,5', items[1]), 1.5);
  assert.equal(toBaseQty('', items[1]), null);
  assert.equal(toBaseQty('-1', items[1]), null);
  assert.equal(qtyWords(9000, items[0]), '1.5 Case (9000 ml)');
  assert.equal(qtyWords(2, items[1]), '2 kg');
});

test('the counted time: the phone clock corrected, never in the future, never before the count, a bad clock not trusted', () => {
  const now = '2026-10-19T12:00:00.000Z';
  assert.equal(countedAt({ clientAt: '2026-10-19T11:50:00Z', sentAt: '2026-10-19T12:00:00Z', now, startedAt: '2026-10-19T11:00:00Z' }), '2026-10-19T11:50:00.000Z');
  assert.equal(countedAt({ clientAt: '2026-10-19T11:48:00Z', sentAt: '2026-10-19T11:58:00Z', now, startedAt: '2026-10-19T11:00:00Z' }), '2026-10-19T11:50:00.000Z', 'a phone 2 minutes slow is corrected');
  assert.equal(countedAt({ clientAt: '2026-10-19T09:00:00Z', sentAt: '2026-10-19T12:00:00Z', now, startedAt: '2026-10-19T11:00:00Z' }), '2026-10-19T11:00:00.000Z', 'never before the count started');
  assert.equal(countedAt({ clientAt: '2026-10-19T14:00:00Z', sentAt: '2026-10-19T14:00:00Z', now, startedAt: null }), now, 'a clock 2 hours out is not trusted');
  assert.equal(countedAt({ clientAt: 'junk', sentAt: now, now, startedAt: null }), now);
  assert.ok(CLOCK_SLACK_MS === 600000);
});

test('entries are checked before anything is written', () => {
  assert.equal(cleanEntries([]).ok, false);
  assert.equal(cleanEntries([{ item_id: 'x', qty_base: 1 }]).ok, false);
  assert.equal(cleanEntries([{ item_id: U(1), qty_base: -1 }]).ok, false);
  const c = cleanEntries([{ item_id: U(1), qty_base: 1.234567 }, { item_id: U(1), qty_base: 2 }]);
  assert.equal(c.ok, true); assert.deepEqual(c.entries.map((e) => e.qty_base), [2], 'the last figure for an item in one batch wins');
});

// a small stand in for the service role client: enough of supabase-js for the steps
function fakeSb(db) {
  const calls = [];
  const from = (table) => {
    const st = { table, filters: [], op: 'select', payload: null };
    const rows = () => (db[table] || []).filter((r) => st.filters.every(([k, op, v]) => (op === 'eq' ? r[k] === v : op === 'in' ? v.includes(r[k]) : op === 'is' ? (r[k] ?? null) === v : op === 'like' ? String(r[k] || '').startsWith(v.replace('%', '')) : op === 'gte' ? r[k] >= v : true)));
    const q = {
      select: () => q, order: () => q, limit: () => q, range: () => q,
      eq: (k, v) => { st.filters.push([k, 'eq', v]); return q; }, in: (k, v) => { st.filters.push([k, 'in', v]); return q; },
      is: (k, v) => { st.filters.push([k, 'is', v]); return q; }, like: (k, v) => { st.filters.push([k, 'like', v]); return q; },
      gte: (k, v) => { st.filters.push([k, 'gte', v]); return q; },
      insert: (p) => { st.op = 'insert'; st.payload = p; return q; },
      update: (p) => { st.op = 'update'; st.payload = p; return q; },
      maybeSingle: async () => { const r = await q.then((x) => x); return { data: Array.isArray(r.data) ? r.data[0] || null : r.data, error: r.error }; },
      then: (res, rej) => {
        calls.push({ table, op: st.op, payload: st.payload, filters: st.filters });
        let out;
        if (st.op === 'insert') {
          const list = (Array.isArray(st.payload) ? st.payload : [st.payload]).map((p, i) => ({ id: p.id || `${table}-${(db[table] || []).length + i}`, ...p }));
          db[table] = [...(db[table] || []), ...list];
          out = { data: Array.isArray(st.payload) ? list : list[0], error: null };
        } else if (st.op === 'update') { const rs = rows(); rs.forEach((r) => Object.assign(r, st.payload)); out = { data: rs, error: null }; } else out = { data: rows(), error: null };
        return Promise.resolve(out).then(res, rej);
      },
    };
    return q;
  };
  return { from, rpc: async (name, args) => { calls.push({ rpc: name, args }); return { data: { ok: true, id: 'w1' }, error: null }; }, calls };
}

test('save: new figures are inserted with their own time, a changed figure is updated, another venue\'s item is refused', async () => {
  const L = U(900), C = U(901);
  const db = {
    stock_counts: [{ id: C, location_id: L, status: 'DRAFT', storage_area: 'all', started_at: '2026-10-19T11:00:00Z', name: 'Phone count: whole venue' }],
    inventory_items: [{ id: U(1), location_id: L, on_hand: 4, current_cost: 1.5 }, { id: U(2), location_id: L, on_hand: 0, current_cost: null }, { id: U(3), location_id: U(999), on_hand: 0 }],
    stock_count_lines: [{ id: 'l2', location_id: L, count_id: C, inventory_item_id: U(2), area_id: null, counted_qty: 1 }],
  };
  const sb = fakeSb(db);
  let r = await save(sb, L, C, [{ item_id: U(1), qty_base: 5, counted_at: '2026-10-19T11:30:00Z' }, { item_id: U(2), qty_base: 7 }], { sentAt: '2026-10-19T12:00:00Z', now: new Date('2026-10-19T12:00:00Z') });
  assert.equal(r.saved, 2);
  const ins = db.stock_count_lines.find((l) => l.inventory_item_id === U(1));
  assert.equal(ins.counted_at, '2026-10-19T11:30:00.000Z'); assert.equal(ins.expected_qty, 4);
  assert.equal(db.stock_count_lines.find((l) => l.id === 'l2').counted_qty, 7);
  r = await save(sb, L, C, [{ item_id: U(3), qty_base: 1 }]);
  assert.match(r.error, /not at this venue/);
  db.stock_counts[0].status = 'APPROVED';
  r = await save(sb, L, C, [{ item_id: U(1), qty_base: 1 }]);
  assert.match(r.error, /approved already/);
});

test('open a count: one per area per morning, reused; waste goes to the one database call', async () => {
  const L = U(800), A = U(801);
  const db = { storage_areas: [{ id: A, location_id: L, name: 'Bar' }], stock_counts: [] };
  const sb = fakeSb(db);
  const a = await openCount(sb, L, A, 'Mia', new Date('2026-10-19T08:00:00Z'));
  assert.equal(a.reused, false); assert.equal(db.stock_counts[0].name, 'Phone count: Bar'); assert.equal(db.stock_count_areas.length, 1);
  db.stock_counts[0].started_at = '2026-10-19T08:00:00.000Z';
  const b = await openCount(sb, L, A, 'Mia', new Date('2026-10-19T09:00:00Z'));
  assert.equal(b.reused, true);
  assert.match((await openCount(sb, L, U(5), 'Mia')).error, /not at this venue/);
  const w = await waste(sb, L, { item_id: U(1), qty_base: 2, reason: 'Spilt' }, 'Mia');
  assert.equal(w.ok, true);
  const call = sb.calls.find((c) => c.rpc === 'stock_record_waste');
  assert.equal(call.args.p_event.kind, 'item'); assert.equal(call.args.p_event.qty_base, 2); assert.equal(call.args.p_event.source, 'manager');
  assert.match((await waste(sb, L, { item_id: U(1), qty_base: 0 }, 'Mia')).error, /more than 0/);
});
