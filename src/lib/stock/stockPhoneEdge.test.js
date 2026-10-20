// node --test: counting and waste on the phone, the server side (supabase/functions/_shared/stockPhone.js,
// v5.11.84, multi site stock Drop 0: Phase 1b re landed with its fixes, plan 4.23). The client side
// has its own test (src/lib/manager/stockPhone.test.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  countedAt, cleanEntries, save, openCount, waste, sheet, items, approve, areas, liveOrAll, liveFilter, isMissingNewColumn,
  chunks, readIn, readAll, CLOCK_SLACK_MS, IN_CHUNK, PAGE, MAX_ENTRIES,
} from '../../../supabase/functions/_shared/stockPhone.js';

const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// A stand in for the service role client: enough of supabase-js for the steps. It honours ranges
// and the 1,000 row cap, records every .in() list, and keeps one line per (count, item, area) the way
// the unique index stock_count_lines_one_per_area does (23505 on a second insert).
function fakeSb(db, { cap = 1000, uniqueLines = true, missingArchived = false } = {}) {
  const calls = [];
  const lineKey = (l) => `${l.count_id}|${l.inventory_item_id}|${l.area_id || ''}`;
  const from = (table) => {
    const st = { table, filters: [], op: 'select', payload: null, lo: 0, hi: null, limit: null, single: false };
    const rows = () => (db[table] || []).filter((r) => st.filters.every(([k, op, v]) => (
      op === 'eq' ? r[k] === v : op === 'in' ? v.includes(r[k]) : op === 'is' ? (r[k] ?? null) === v
        : op === 'like' ? String(r[k] || '').startsWith(v.replace('%', '')) : op === 'gte' ? r[k] >= v : true)));
    const q = {
      select: () => q, order: () => q,
      limit: (n) => { st.limit = n; return q; },
      range: (a, b) => { st.lo = a; st.hi = b; return q; },
      eq: (k, v) => { st.filters.push([k, 'eq', v]); return q; },
      in: (k, v) => { st.filters.push([k, 'in', v]); calls.push({ table, in: v.length }); return q; },
      is: (k, v) => { st.filters.push([k, 'is', v]); return q; },
      like: (k, v) => { st.filters.push([k, 'like', v]); return q; },
      gte: (k, v) => { st.filters.push([k, 'gte', v]); return q; },
      insert: (p) => { st.op = 'insert'; st.payload = p; return q; },
      update: (p) => { st.op = 'update'; st.payload = p; return q; },
      maybeSingle: async () => { st.single = true; const r = await q.then((x) => x); return { data: Array.isArray(r.data) ? r.data[0] || null : r.data, error: r.error }; },
      then: (res, rej) => {
        calls.push({ table, op: st.op, payload: st.payload, filters: st.filters });
        let out;
        if (missingArchived && st.filters.some(([k]) => k === 'archived_at') && table !== 'inventory_items' && table !== 'storage_areas') {
          out = { data: null, error: { code: '42703', message: `column ${table}.archived_at does not exist` } };
        } else if (st.op === 'insert') {
          const list = (Array.isArray(st.payload) ? st.payload : [st.payload]).map((p, i) => ({ id: p.id || `${table}-${(db[table] || []).length + i}`, ...p }));
          if (table === 'stock_count_lines' && uniqueLines) {
            const seen = new Set((db[table] || []).map(lineKey));
            const clash = list.find((l) => { const k = lineKey(l); if (seen.has(k)) return true; seen.add(k); return false; });
            if (clash) out = { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "stock_count_lines_one_per_area"' } };
          }
          if (!out) { db[table] = [...(db[table] || []), ...list]; out = { data: Array.isArray(st.payload) ? list : list[0], error: null }; }
        } else if (st.op === 'update') {
          const rs = rows(); rs.forEach((r) => Object.assign(r, st.payload)); out = { data: rs, error: null };
        } else {
          let rs = rows();
          if (st.hi != null) rs = rs.slice(st.lo, Math.min(st.hi, st.lo + cap - 1) + 1);
          else rs = rs.slice(0, cap);
          if (st.limit != null) rs = rs.slice(0, st.limit);
          out = { data: rs, error: null };
        }
        return Promise.resolve(out).then(res, rej);
      },
    };
    return q;
  };
  return { from, rpc: async (name, args) => { calls.push({ rpc: name, args }); return { data: { ok: true, id: 'w1' }, error: null }; }, calls };
}

test('the counted time: the phone clock corrected, never in the future, never before the count, a bad clock not trusted', () => {
  const now = '2026-10-19T12:00:00.000Z';
  assert.equal(countedAt({ clientAt: '2026-10-19T11:50:00Z', sentAt: '2026-10-19T12:00:00Z', now, startedAt: '2026-10-19T11:00:00Z' }), '2026-10-19T11:50:00.000Z');
  assert.equal(countedAt({ clientAt: '2026-10-19T11:48:00Z', sentAt: '2026-10-19T11:58:00Z', now, startedAt: '2026-10-19T11:00:00Z' }), '2026-10-19T11:50:00.000Z', 'a phone 2 minutes slow is corrected');
  assert.equal(countedAt({ clientAt: '2026-10-19T09:00:00Z', sentAt: '2026-10-19T12:00:00Z', now, startedAt: '2026-10-19T11:00:00Z' }), '2026-10-19T11:00:00.000Z', 'never before the count started');
  assert.equal(countedAt({ clientAt: '2026-10-19T14:00:00Z', sentAt: '2026-10-19T14:00:00Z', now, startedAt: null }), now, 'a clock 2 hours out is not trusted');
  assert.equal(countedAt({ clientAt: 'junk', sentAt: now, now, startedAt: null }), now);
  assert.equal(CLOCK_SLACK_MS, 600000);
});

test('entries are checked before anything is written', () => {
  assert.equal(cleanEntries([]).ok, false);
  assert.equal(cleanEntries(null).ok, false);
  assert.equal(cleanEntries([{ item_id: 'x', qty_base: 1 }]).ok, false);
  assert.equal(cleanEntries([{ item_id: U(1), qty_base: -1 }]).ok, false);
  assert.equal(cleanEntries([{ item_id: U(1), qty_base: null }]).ok, false, 'an empty figure is never read as 0');
  assert.equal(cleanEntries([{ item_id: U(1), qty_base: 1, area_id: 'nope' }]).ok, false);
  assert.equal(cleanEntries(Array.from({ length: MAX_ENTRIES + 1 }, (_, i) => ({ item_id: U(i), qty_base: 1 }))).ok, false);
  const c = cleanEntries([{ item_id: U(1), qty_base: 1.234567 }, { item_id: U(1), qty_base: 2 }]);
  assert.equal(c.ok, true); assert.deepEqual(c.entries.map((e) => e.qty_base), [2], 'the last figure for an item in one batch wins');
  assert.deepEqual(cleanEntries([{ item_id: U(1), qty_base: 0 }]).entries[0].qty_base, 0, 'a real 0 is a figure');
});

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
  assert.equal(ins.counted_at, '2026-10-19T11:30:00.000Z'); assert.equal(ins.expected_qty, 4); assert.equal(ins.unit_cost, 1.5);
  assert.equal(db.stock_count_lines.find((l) => l.id === 'l2').counted_qty, 7);
  // the same figure again changes nothing
  const before = sb.calls.length;
  r = await save(sb, L, C, [{ item_id: U(1), qty_base: 5 }]);
  assert.equal(r.saved, 1);
  assert.ok(!sb.calls.slice(before).some((x) => x.op === 'update' || x.op === 'insert'), 'nothing written for an unchanged figure');
  r = await save(sb, L, C, [{ item_id: U(3), qty_base: 1 }]);
  assert.match(r.error, /not at this venue/);
  db.stock_counts[0].status = 'APPROVED';
  r = await save(sb, L, C, [{ item_id: U(1), qty_base: 1 }]);
  assert.match(r.error, /approved already/);
  assert.match((await save(sb, L, U(5), [{ item_id: U(1), qty_base: 1 }])).error, /not found for this location/);
});

test('a recount sent late keeps the time it was typed: the figure, then its time', async () => {
  const L = U(700), C = U(701);
  const db = {
    stock_counts: [{ id: C, location_id: L, status: 'DRAFT', storage_area: 'all', started_at: '2026-10-19T11:00:00Z', name: 'Phone count: whole venue' }],
    inventory_items: [{ id: U(1), location_id: L, on_hand: 380, current_cost: 0.05 }],
    stock_count_lines: [{ id: 'l1', location_id: L, count_id: C, inventory_item_id: U(1), area_id: null, counted_qty: 400, counted_at: '2026-10-19T11:40:00.000Z' }],
  };
  const sb = fakeSb(db);
  const r = await save(sb, L, C, [{ item_id: U(1), qty_base: 380, counted_at: '2026-10-19T11:50:00Z' }], { sentAt: '2026-10-19T12:00:00Z', now: new Date('2026-10-19T12:00:00Z') });
  assert.equal(r.saved, 1);
  const line = db.stock_count_lines[0];
  assert.equal(line.counted_qty, 380);
  assert.equal(line.counted_at, '2026-10-19T11:50:00.000Z', 'the time it was typed, not the time it arrived');
  const ups = sb.calls.filter((x) => x.table === 'stock_count_lines' && x.op === 'update');
  assert.deepEqual(ups.map((x) => Object.keys(x.payload)), [['counted_qty'], ['counted_at']]);
});

test('one line per count, item and area: a figure another phone saved first is updated, never a second line (the upsert)', async () => {
  const L = U(650), C = U(651), AREA = U(652);
  const db = {
    stock_counts: [{ id: C, location_id: L, status: 'DRAFT', storage_area: AREA, started_at: '2026-10-19T11:00:00Z', name: 'Phone count: Bar' }],
    inventory_items: [{ id: U(1), location_id: L, on_hand: 10, current_cost: 1 }, { id: U(2), location_id: L, on_hand: 3, current_cost: 2 }],
    stock_count_lines: [],
  };
  const sb = fakeSb(db);
  // this phone read the lines (none), then another phone inserted item 1 before this phone's insert
  const from0 = sb.from;
  let raced = false;
  sb.from = (table) => {
    const q = from0(table);
    if (table === 'stock_count_lines') {
      const insert0 = q.insert;
      q.insert = (p) => {
        if (!raced) { raced = true; db.stock_count_lines.push({ id: 'other', location_id: L, count_id: C, inventory_item_id: U(1), area_id: AREA, counted_qty: 8, counted_at: '2026-10-19T11:20:00.000Z' }); }
        return insert0(p);
      };
    }
    return q;
  };
  const r = await save(sb, L, C, [{ item_id: U(1), qty_base: 9, counted_at: '2026-10-19T11:30:00Z' }, { item_id: U(2), qty_base: 4, counted_at: '2026-10-19T11:31:00Z' }], { sentAt: '2026-10-19T12:00:00Z', now: new Date('2026-10-19T12:00:00Z') });
  assert.equal(r.error, undefined, r.error);
  assert.equal(r.saved, 2);
  const ofItem1 = db.stock_count_lines.filter((l) => l.inventory_item_id === U(1));
  assert.equal(ofItem1.length, 1, 'still one line for item 1');
  assert.equal(ofItem1[0].id, 'other');
  assert.equal(ofItem1[0].counted_qty, 9, 'the newer figure, on the line that was there');
  assert.equal(ofItem1[0].counted_at, '2026-10-19T11:30:00.000Z');
  assert.equal(db.stock_count_lines.filter((l) => l.inventory_item_id === U(2)).length, 1, 'item 2 went in on its own');
  // and the same batch sent twice (two overlapping sends) leaves one line each
  const again = await save(sb, L, C, [{ item_id: U(1), qty_base: 9 }, { item_id: U(2), qty_base: 4 }]);
  assert.equal(again.saved, 2);
  assert.equal(db.stock_count_lines.length, 2);
});

test('save reads items and lines 100 ids a request (a page of ids is too long for one address)', async () => {
  const L = U(600), C = U(601);
  const itemsList = Array.from({ length: MAX_ENTRIES }, (_, i) => ({ id: U(10000 + i), location_id: L, on_hand: 1, current_cost: 1 }));
  const db = { stock_counts: [{ id: C, location_id: L, status: 'DRAFT', storage_area: 'all', started_at: '2026-10-19T11:00:00Z' }], inventory_items: itemsList, stock_count_lines: [] };
  const sb = fakeSb(db);
  const r = await save(sb, L, C, itemsList.map((it) => ({ item_id: it.id, qty_base: 2 })));
  assert.equal(r.saved, MAX_ENTRIES);
  const ins = sb.calls.filter((x) => x.in != null);
  assert.ok(ins.length >= 4, `${ins.length} .in() reads`);
  assert.ok(ins.every((x) => x.in <= IN_CHUNK), `an .in() list of ${Math.max(...ins.map((x) => x.in))}`);
  assert.equal(IN_CHUNK, 100);
  assert.deepEqual(chunks([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunks(null), []);
});

test('the count sheet finds every item\'s count pack when 500 items have 1,500 packs (past the 1,000 row cap), and leaves archived packs out', async () => {
  const L = U(500), C = U(501);
  const itemsList = Array.from({ length: PAGE }, (_, i) => ({ id: U(20000 + i), location_id: L, name: `Item ${String(i).padStart(3, '0')}`, base_unit: 'each', is_tracked: true, archived_at: null }));
  const packs = itemsList.flatMap((it, i) => [0, 1, 2].map((k) => ({ id: U(30000 + i * 3 + k), location_id: L, inventory_item_id: it.id, name: k === 2 ? 'Count case' : `Pack ${k}`, qty_in_base: 6 + k, is_count_default: k === 2, archived_at: null })));
  // an archived pack marked as the count default on the first item is never offered
  packs.push({ id: U(39999), location_id: L, inventory_item_id: itemsList[0].id, name: 'Old case', qty_in_base: 99, is_count_default: true, archived_at: '2026-10-19T00:00:00Z' });
  const db = { stock_counts: [{ id: C, location_id: L, status: 'DRAFT', storage_area: 'all', started_at: '2026-10-19T11:00:00Z' }], inventory_items: itemsList, item_packaging_formats: packs, stock_count_lines: [] };
  const sb = fakeSb(db);
  const r = await sheet(sb, L, C, 0);
  assert.equal(r.items.length, PAGE);
  assert.equal(r.more, true);
  assert.equal(r.items.filter((x) => x.count_pack?.name !== 'Count case').length, 0, 'every item shows its live count pack');
  assert.ok(sb.calls.filter((x) => x.in != null).every((x) => x.in <= IN_CHUNK));
  assert.equal(r.items[0].head_office, undefined, 'no head office flag: every item is a company record from Drop 0');
  const w = await items(fakeSb(db), L, 0);
  assert.equal(w.items.filter((x) => x.count_pack?.name !== 'Count case').length, 0, 'the waste list too');
});

test('an area sheet: the items of that area, in name order, read 100 ids at a time', async () => {
  const L = U(450), C = U(451), AREA = U(452);
  const itemsList = Array.from({ length: 250 }, (_, i) => ({ id: U(40000 + i), location_id: L, name: `Z${String(249 - i).padStart(3, '0')}`, base_unit: 'g', is_tracked: true, archived_at: null }));
  const db = {
    stock_counts: [{ id: C, location_id: L, status: 'DRAFT', storage_area: AREA, started_at: '2026-10-19T11:00:00Z' }],
    inventory_items: itemsList,
    inventory_item_areas: itemsList.map((it) => ({ location_id: L, area_id: AREA, inventory_item_id: it.id })),
    item_packaging_formats: [],
    stock_count_lines: [{ id: 'x', location_id: L, count_id: C, inventory_item_id: itemsList[0].id, area_id: AREA, counted_qty: 3, counted_at: '2026-10-19T11:10:00Z' }],
  };
  const sb = fakeSb(db);
  const r = await sheet(sb, L, C, 0);
  assert.equal(r.items.length, 250);
  assert.equal(r.more, false);
  assert.equal(r.items[0].name, 'Z000', 'sorted by name after the chunked reads');
  assert.equal(r.items.find((i) => i.id === itemsList[0].id).counted_qty, 3);
  assert.ok(sb.calls.filter((x) => x.in != null).every((x) => x.in <= IN_CHUNK));
});

test('before 20261021a (no archived_at on packs) the sheet reads every pack, as before', async () => {
  const L = U(400), C = U(401);
  const db = {
    stock_counts: [{ id: C, location_id: L, status: 'DRAFT', storage_area: 'all', started_at: '2026-10-19T11:00:00Z' }],
    inventory_items: [{ id: U(1), location_id: L, name: 'Milk', base_unit: 'ml', is_tracked: true, archived_at: null }],
    item_packaging_formats: [{ id: 'p', location_id: L, inventory_item_id: U(1), name: 'Crate', qty_in_base: 12000, is_count_default: true }],
    stock_count_lines: [],
  };
  const r = await sheet(fakeSb(db, { missingArchived: true }), L, C, 0);
  assert.equal(r.error, undefined, r.error);
  assert.equal(r.items[0].count_pack.name, 'Crate');
});

test('liveOrAll: archived rows left out; the column missing (before 20261021a) reads every row; any other error stands', async () => {
  const q = (rows, err = null) => ({ is: (k, v) => ({ k, v, rows: rows.filter((r) => r[k] == null), err }), rows, err });
  assert.deepEqual(liveFilter(q([{ a: 1, archived_at: null }, { a: 2, archived_at: 'x' }]), true).rows, [{ a: 1, archived_at: null }]);
  assert.equal(liveFilter(q([{ a: 1 }]), false).rows.length, 1);
  let tries = [];
  let r = await liveOrAll(async (live) => { tries.push(live); return live ? { data: null, error: { code: '42703', message: 'column supplier_products.archived_at does not exist' } } : { data: [1, 2], error: null }; });
  assert.deepEqual([tries, r.data], [[true, false], [1, 2]]);
  tries = [];
  r = await liveOrAll(async (live) => { tries.push(live); return { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } }; });
  assert.deepEqual(tries, [true], 'a timeout is not a missing column');
  assert.equal(r.error.code, '57014');
  // pagedRows throws its own words with the database message inside
  tries = [];
  r = await liveOrAll(async (live) => { tries.push(live); if (live) throw new Error('Could not read supplier packs: column supplier_products.archived_at does not exist'); return [9]; });
  assert.deepEqual([tries, r], [[true, false], [9]]);
  await assert.rejects(liveOrAll(async () => { throw new Error('Could not read supplier packs: permission denied'); }), /permission denied/);
  assert.equal(isMissingNewColumn({ code: '42703', message: 'column stock_counts.approved_by_staff_id does not exist' }), true);
  assert.equal(isMissingNewColumn({ code: '42703', message: 'column x.other does not exist' }), false);
});

test('readAll and readIn page past the cap and stop on an error', async () => {
  const rows = Array.from({ length: 2500 }, (_, i) => ({ id: i }));
  const build = () => { const q = { range: (a, b) => Promise.resolve({ data: rows.slice(a, Math.min(b, a + 999) + 1), error: null }) }; return q; };
  assert.equal((await readAll(build)).data.length, 2500);
  const bad = () => ({ range: () => Promise.resolve({ data: null, error: { message: 'boom' } }) });
  assert.equal((await readAll(bad)).error.message, 'boom');
  const seen = [];
  const r = await readIn(Array.from({ length: 250 }, (_, i) => i), (part) => { seen.push(part.length); return { range: () => Promise.resolve({ data: part.map((id) => ({ id })), error: null }) }; });
  assert.deepEqual(seen, [100, 100, 50]);
  assert.equal(r.data.length, 250);
});

test('open a count: one per area per morning, reused; another venue\'s area refused; the areas list', async () => {
  const L = U(800), A = U(801);
  const db = { storage_areas: [{ id: A, location_id: L, name: 'Bar', archived_at: null }], stock_counts: [] };
  const sb = fakeSb(db);
  const a = await openCount(sb, L, A, 'Floor Staff', new Date('2026-10-19T08:00:00Z'));
  assert.equal(a.reused, false); assert.equal(db.stock_counts[0].name, 'Phone count: Bar'); assert.equal(db.stock_counts[0].count_type, 'AREA'); assert.equal(db.stock_count_areas.length, 1);
  db.stock_counts[0].started_at = '2026-10-19T08:00:00.000Z';
  const b = await openCount(sb, L, A, 'Floor Staff', new Date('2026-10-19T09:00:00Z'));
  assert.equal(b.reused, true);
  assert.match((await openCount(sb, L, U(5), 'Floor Staff')).error, /not at this venue/);
  assert.match((await openCount(sb, L, 'junk', 'Floor Staff')).error, /not valid/);
  const whole = await openCount(sb, L, 'all', 'Floor Staff', new Date('2026-10-19T09:00:00Z'));
  assert.equal(whole.count.name, 'Phone count: whole venue');
  const list = await areas(sb, L);
  assert.equal(list.areas.length, 1);
  assert.ok(list.open.length >= 1);
});

test('waste goes to the one database call, source manager, the amount checked first', async () => {
  const sb = fakeSb({});
  const w = await waste(sb, U(1), { item_id: U(2), qty_base: 2, reason: 'Spilt', id: U(3) }, 'Floor Staff');
  assert.equal(w.ok, true);
  const call = sb.calls.find((c) => c.rpc === 'stock_record_waste');
  assert.deepEqual([call.args.p_location_id, call.args.p_event.kind, call.args.p_event.qty_base, call.args.p_event.source, call.args.p_event.id, call.args.p_lines], [U(1), 'item', 2, 'manager', U(3), null]);
  assert.match(call.args.p_event.note, /Logged on the phone by Floor Staff/);
  assert.match((await waste(sb, U(1), { item_id: U(2), qty_base: 0 }, 'x')).error, /more than 0/);
  assert.match((await waste(sb, U(1), { item_id: 'x', qty_base: 1 }, 'x')).error, /pick a stock item/);
});

test('approve: the opening costs the server works out, ONE database call, then the PIN holder on the count', async () => {
  const L = U(300), C = U(301), S = U(302);
  const db = { stock_counts: [{ id: C, location_id: L, status: 'DRAFT', storage_area: 'all' }], stock_count_areas: [{ id: 'a', location_id: L, count_id: C, status: 'open' }] };
  const sb = fakeSb(db);
  const calls = [];
  sb.rpc = async (name, args) => {
    calls.push({ name, args });
    if (name === 'stock_opening_costs') return { data: { [U(1)]: 0.0011, junk: 5, [U(2)]: 0 }, error: null };
    return { data: { ok: true, posted: 1 }, error: null };
  };
  const r = await approve(sb, L, C, 'Duty Manager', { id: S, name: 'Duty Manager' });
  assert.equal(r.ok, true);
  assert.equal(r.approved_by_pin, 'Duty Manager');
  assert.equal(r.pin_holder_saved, true);
  const ap = calls.find((x) => x.name === 'approve_stock_count');
  assert.deepEqual(ap.args.p_costs, { [U(1)]: 0.0011 }, 'only real item ids with a cost above 0');
  assert.equal(ap.args.p_preview, false);
  assert.deepEqual([db.stock_counts[0].approved_by_staff_id, db.stock_counts[0].approved_by_staff_name], [S, 'Duty Manager']);
  assert.equal(db.stock_count_areas[0].status, 'complete');
  assert.ok(!calls.some((x) => x.name === 'msm_stock_opening_costs'), 'the Phase 1 name is gone');
});

test('approve: before 20261021a no costs are sent; a cost missing is named; a repeat or a refusal writes no PIN holder', async () => {
  const L = U(200), C = U(201);
  const db = { stock_counts: [{ id: C, location_id: L, status: 'DRAFT', storage_area: 'all' }] };
  const sb = fakeSb(db);
  sb.rpc = async (name) => (name === 'stock_opening_costs' ? { data: null, error: { message: 'Could not find the function' } } : { data: { ok: false, code: 'needs_cost', needs_cost: [{ item_id: U(1), name: 'Oat milk' }] }, error: null });
  const r2 = await approve(sb, L, C, 'Duty Manager', { id: U(9), name: 'Duty Manager' });
  assert.equal(r2.ok, false);
  assert.match(r2.error, /Oat milk has no cost here yet/);
  assert.equal(db.stock_counts[0].approved_by_staff_id, undefined);
  sb.rpc = async () => ({ data: { ok: false, error: 'Nothing has been counted on this sheet yet' }, error: null });
  const r3 = await approve(sb, L, C, 'x', { id: U(9), name: 'x' });
  assert.equal(r3.ok, false);
  assert.equal(db.stock_counts[0].approved_by_staff_id, undefined);
  db.stock_counts[0].status = 'APPROVED';
  assert.deepEqual(await approve(sb, L, C, 'x', { id: U(9), name: 'x' }), { ok: true, duplicate: true });
  // the PIN holder columns missing: the approval still stands and says the holder was not stored
  db.stock_counts[0].status = 'DRAFT';
  const sb2 = fakeSb(db);
  sb2.rpc = async () => ({ data: { ok: true, posted: 2 }, error: null });
  const from0 = sb2.from;
  sb2.from = (t) => { const q = from0(t); if (t === 'stock_counts') { const u0 = q.update; q.update = (p) => { if ('approved_by_staff_id' in p) { const fail = { eq: () => fail, then: (res) => Promise.resolve({ data: null, error: { code: '42703', message: 'column stock_counts.approved_by_staff_id does not exist' } }).then(res) }; return fail; } return u0(p); }; } return q; };
  const r4 = await approve(sb2, L, C, 'x', { id: U(9), name: 'x' });
  assert.deepEqual([r4.ok, r4.pin_holder_saved], [true, false]);
});
