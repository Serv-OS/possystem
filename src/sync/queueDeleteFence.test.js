// queueDeleteFence.test.js: who deletes an open order or a bar tab, end to end through the REAL
// sync/QueueSync.js and sync/OfflineQueue.js (12 Oct 2026, lib/queueDeleteRule.js).
//
// Coffee Boy Barnsley, 12 Oct 2026: the drinks screen (a kitchen tablet) sent 32 DELETE requests
// to order_queue in two minutes. The cause is in QueueSync's flush: any row that was no longer
// open in THIS device's own list was deleted on the server, on every device and whatever the
// cause. Here a fake database counts what each kind of device sends:
//   - a kitchen tablet (either shape: kitchen mode, or a till mode page paired as a kitchen
//     display) sends nothing, for orders and for bar tabs, however its list changes;
//   - a till no longer answers a delete it HEARD with a delete of its own;
//   - a till still removes what staff finished on it, by number, as before;
//   - a till clears an order another device marked collected only while the server still says
//     collected, so a newer order with the same number is never removed;
//   - a catering order moved to a later day leaves the till's list and stays in the database;
//   - a write the list sync buffered on an older build is never sent from a kitchen tablet.
//
// lib/supabase.js (Vite's import.meta.env) and the store are replaced by small stubs through two
// module hooks, as offlineQueueFence.test.js does. Everything else is the shipped code.
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

// ── The browser the app expects ──────────────────────────────────────────────────────────────
globalThis.window = new EventTarget();
const doc = new EventTarget();
doc.visibilityState = 'visible';
globalThis.document = doc;
Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true, writable: true });
const disk = new Map();
globalThis.localStorage = {
  getItem: (k) => (disk.has(k) ? disk.get(k) : null),
  setItem: (k, v) => { disk.set(k, String(v)); },
  removeItem: (k) => { disk.delete(k); },
};

function fakeIndexedDB() {
  const stores = new Map();
  let autoId = 0;
  const later = (fn) => {
    const r = { result: undefined, error: null, onsuccess: null, onerror: null };
    queueMicrotask(() => {
      try { r.result = fn(); if (r.onsuccess) r.onsuccess({ target: r }); }
      catch (e) { r.error = e; if (r.onerror) r.onerror({ target: r }); }
    });
    return r;
  };
  const storeApi = (name) => {
    const m = stores.get(name);
    return {
      indexNames: { contains: () => true },
      createIndex() {},
      add: (item) => later(() => { const id = ++autoId; m.set(id, structuredClone({ ...item, id })); return id; }),
      put: (item) => later(() => { const id = item.id != null ? item.id : ++autoId; m.set(id, structuredClone({ ...item, id })); return id; }),
      get: (id) => later(() => (m.has(id) ? structuredClone(m.get(id)) : undefined)),
      getAll: () => later(() => [...m.keys()].sort((a, b) => a - b).map((k) => structuredClone(m.get(k)))),
      delete: (id) => later(() => { m.delete(id); }),
      clear: () => later(() => { m.clear(); }),
    };
  };
  const db = {
    objectStoreNames: { contains: (n) => stores.has(n) },
    createObjectStore(name) { stores.set(name, new Map()); return storeApi(name); },
    transaction(name) { return { objectStore: () => storeApi(name) }; },
  };
  return {
    stores,
    open() {
      const r = { result: db, error: null, onupgradeneeded: null, onsuccess: null, onerror: null };
      queueMicrotask(() => {
        if (!stores.has('queue') && r.onupgradeneeded) r.onupgradeneeded({ target: { result: db, transaction: { objectStore: storeApi } } });
        if (r.onsuccess) r.onsuccess({ target: { result: db } });
      });
      return r;
    },
  };
}
const idb = fakeIndexedDB();
globalThis.indexedDB = idb;

// ── A fake database that logs every write ────────────────────────────────────────────────────
const LOC = 'L1';
const server = { rows: { order_queue: [], bar_tabs: [], kds_tickets: [] }, log: [] };

function query(table) {
  const q = { op: 'select', payload: undefined, filters: [], cols: null, onConflict: 'id', single: false };
  const matches = (row) => q.filters.every(([k, c, v]) => {
    const val = row[c];
    if (k === 'eq') return val !== undefined && val !== null && String(val) === String(v);
    if (k === 'neq') return val === undefined || val === null || String(val) !== String(v);
    if (k === 'in') return val !== undefined && val !== null && v.map(String).includes(String(val));
    return true;
  });
  const project = (row) => {
    if (!q.cols || q.cols === '*') return structuredClone(row);
    const out = {};
    for (const c of q.cols.split(',').map((s) => s.trim())) out[c] = row[c];
    return out;
  };
  const run = () => {
    server.log.push({ table, op: q.op, filters: q.filters.map((f) => [...f]) });
    const rows = server.rows[table] || (server.rows[table] = []);
    if (q.op === 'update') {
      const hit = rows.filter(matches);
      for (const r of hit) Object.assign(r, structuredClone(q.payload), { updated_at: new Date().toISOString() });
      return { data: q.cols ? hit.map(project) : null, error: null };
    }
    if (q.op === 'delete') {
      const hit = rows.filter(matches);
      server.rows[table] = rows.filter((r) => !hit.includes(r));
      return { data: q.cols ? hit.map(project) : null, error: null };
    }
    if (q.op === 'upsert' || q.op === 'insert') {
      const list = Array.isArray(q.payload) ? q.payload : [q.payload];
      const keys = q.onConflict.split(',').map((s) => s.trim());
      const out = [];
      for (const p of list) {
        const i = q.op === 'upsert' ? rows.findIndex((r) => keys.every((k) => String(r[k]) === String(p[k]))) : -1;
        const row = { ...(i >= 0 ? rows[i] : {}), ...structuredClone(p), updated_at: new Date().toISOString() };
        if (i >= 0) rows[i] = row; else rows.push(row);
        out.push(row);
      }
      return { data: q.cols ? out.map(project) : null, error: null };
    }
    const found = rows.filter(matches).map(project);
    return { data: q.single ? (found[0] || null) : found, error: null };
  };
  const b = {
    update(p) { q.op = 'update'; q.payload = p; return b; },
    delete() { q.op = 'delete'; return b; },
    insert(p) { q.op = 'insert'; q.payload = p; return b; },
    upsert(p, o) { q.op = 'upsert'; q.payload = p; q.onConflict = (o && o.onConflict) || 'id'; return b; },
    eq(c, v) { q.filters.push(['eq', c, v]); return b; },
    neq(c, v) { q.filters.push(['neq', c, v]); return b; },
    in(c, v) { q.filters.push(['in', c, v]); return b; },
    or() { return b; }, order() { return b; }, limit() { return b; }, gte() { return b; },
    maybeSingle() { q.single = true; return b; },
    select(cols) { q.cols = cols || '*'; return b; },
    then(res, rej) { return Promise.resolve().then(run).then(res, rej); },
  };
  return b;
}
const client = {
  from: (table) => query(table),
  rpc: (name) => Promise.resolve(name === 'device_status'
    ? { data: { bound: true, device_id: 'dev-1', has_secret: true, status: 'active' }, error: null }
    : { data: null, error: { code: 'PGRST202', message: `Could not find the function public.${name}` } }),
};

// What this page is, and its store. A test sets these before it acts.
globalThis.__q = { client, mode: 'pos', state: { orderQueue: [], tabs: [], deviceConfig: null } };

const SUPABASE_STUB = `
export const supabase = globalThis.__q.client;
export const isMock = false;
export async function getLocationId() { return '${LOC}'; }
export function getDeviceMode() { return globalThis.__q.mode; }
export function readLocalDevice() { return { kind: 'till', id: 'dev-1', deviceSecret: 's', pairingCode: null, locationName: 'Beta' }; }
export function isBackOfficeMode() { return false; }
export function isHostStandMode() { return false; }
export function getLastDeviceLinkOutcome() { return null; }
export async function sendDeviceHeartbeat() { return null; }
export async function linkDevice() { return { outcome: 'linked' }; }
`;
const STORE_STUB = `
const listeners = new Set();
export const useStore = {
  getState: () => globalThis.__q.state,
  setState(patch) {
    const prev = globalThis.__q.state;
    const p = typeof patch === 'function' ? patch(prev) : patch;
    globalThis.__q.state = { ...prev, ...p };
    for (const l of listeners) l(globalThis.__q.state, prev);
  },
  subscribe(l) { listeners.add(l); return () => listeners.delete(l); },
};
`;
const STORE_URL = 'file:///virtual/rpos-store-stub.js';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '../store' || specifier === STORE_URL) return { url: STORE_URL, shortCircuit: true };
    if ((specifier.startsWith('./') || specifier.startsWith('../')) && !/\.[a-z]+(\?.*)?$/i.test(specifier)) {
      return nextResolve(`${specifier}.js`, context);
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === STORE_URL) return { format: 'module', source: STORE_STUB, shortCircuit: true };
    if (url.endsWith('/src/lib/supabase.js')) return { format: 'module', source: SUPABASE_STUB, shortCircuit: true };
    return nextLoad(url, context);
  },
});

const QS = await import('./QueueSync.js');
const OQ = await import('./OfflineQueue.js');
const { useStore } = await import(STORE_URL);
const { dropBufferedQueueWrite } = await import('../lib/queueDeleteRule.js');

// What SyncBridge does when the list changes: record removals, then flush. The flush is called
// by hand here (no debounce) so each step is checked on its own.
useStore.subscribe((state, prev) => {
  if (state.orderQueue !== prev.orderQueue) QS.noteQueueRemovals(prev.orderQueue, state.orderQueue);
  if (state.tabs !== prev.tabs) QS.noteTabRemovals(prev.tabs, state.tabs);
});

// ── Helpers ──────────────────────────────────────────────────────────────────────────────────
const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms));
const buffered = () => [...(idb.stores.get('queue') || new Map()).values()].sort((a, b) => a.id - b.id);
const deletes = (table) => server.log.filter((l) => l.table === table && l.op === 'delete');
const writes = (table) => server.log.filter((l) => l.table === table && l.op !== 'select');
const hasFilter = (l, kind, col) => l.filters.some(([k, c]) => k === kind && c === col);
const serverOrder = (ref) => server.rows.order_queue.find((r) => r.ref === ref) || null;
const held = (ref) => (globalThis.__q.state.orderQueue || []).find((o) => o.ref === ref) || null;

let stamp = 0;
function orderRow(ref, over = {}) {
  stamp += 1;
  return {
    ref, location_id: LOC, type: 'takeaway', customer: {}, items: [{ name: 'Latte', qty: 1 }], total: 3.5,
    status: 'received', staff: 'Sam', created_at: new Date(Date.now() - 60_000).toISOString(), sent_at: null,
    collection_time: null, is_asap: true, source: 'pos',
    updated_at: new Date(Date.now() + stamp).toISOString(), ...over,
  };
}
function tabRow(id, over = {}) {
  stamp += 1;
  return {
    id, location_id: LOC, ref: null, name: 'Tab', seat_id: null, table_id: null, opened_by: 'Sam',
    opened_at: new Date(Date.now() - 60_000).toISOString(), status: 'open', pre_auth: false, pre_auth_amount: 0,
    pre_auth_ref: null, pre_auth_processor: null, pre_auth_held_minor: null, pre_auth_account: null,
    rounds: [], note: '', total: 12, updated_at: new Date(Date.now() + stamp).toISOString(), ...over,
  };
}
/** The server gets the row and this device hears it (adopted and latched, as on any device). */
function serverInsertsOrder(row) {
  server.rows.order_queue.push(structuredClone(row));
  QS.applyQueueRealtimeEvent({ eventType: 'INSERT', new: structuredClone(row) });
}
function serverUpdatesOrder(ref, patch) {
  const row = serverOrder(ref);
  stamp += 1;
  Object.assign(row, patch, { updated_at: new Date(Date.now() + stamp).toISOString() });
  QS.applyQueueRealtimeEvent({ eventType: 'UPDATE', new: structuredClone(row) });
}
function serverDeletesOrder(ref) {
  const row = serverOrder(ref);
  server.rows.order_queue = server.rows.order_queue.filter((r) => r.ref !== ref);
  QS.applyQueueRealtimeEvent({ eventType: 'DELETE', old: structuredClone(row) });
}
function serverInsertsTab(row) {
  server.rows.bar_tabs.push(structuredClone(row));
  QS.applyTabRealtimeEvent({ eventType: 'INSERT', new: structuredClone(row) });
}
async function flush() { await QS.flushQueues(); await tick(); }

/** A fresh page of the given kind with an empty list and an empty database. */
async function page({ mode = 'pos', type = 'pos', config = null } = {}) {
  QS.teardownQueueSync();
  idb.stores.get('queue')?.clear();
  server.rows = { order_queue: [], bar_tabs: [], kds_tickets: [] };
  globalThis.__q.mode = mode;
  globalThis.__q.state = { orderQueue: [], tabs: [], deviceConfig: config };
  if (type) localStorage.setItem('rpos-device', JSON.stringify({ id: 'dev-1', type, locationId: LOC }));
  else localStorage.removeItem('rpos-device');
  QS.primeQueueSync(LOC);
  server.log = [];
}

// The two shapes of kitchen tablet in the field: the ServOS KDS app (?mode=kds), and a tablet
// paired as a Kitchen Display inside the till shell (the Barnsley drinks screen: type kds).
const KITCHEN_TABLETS = [
  ['the KDS app (kitchen mode)', { mode: 'kds', type: 'kds', config: { defaultSurface: 'kds', profileName: 'Kitchen Display' } }],
  ['a till mode page paired as a kitchen display', { mode: 'pos', type: 'kds', config: { defaultSurface: 'kds', profileName: 'Kitchen Display' } }],
  ['a till mode page on a kitchen profile', { mode: 'pos', type: 'pos', config: { defaultSurface: 'kds', profileName: 'Drinks screen' } }],
];

// Each shape uses its own order numbers: a number this page saw finish is not adopted again for
// 30 seconds (QueueSync RECENT_CLEAR_MS), and the three run back to back.
for (const [i, [name, shape]] of KITCHEN_TABLETS.entries()) {
  const K1 = `K${i}-1`, K2 = `K${i}-2`, K3 = `K${i}-3`;
  test(`kitchen tablet, ${name}: hears orders finish and sends no delete, no update, nothing`, async () => {
    await page(shape);
    serverInsertsOrder(orderRow(K1));
    serverInsertsOrder(orderRow(K2));
    serverInsertsOrder(orderRow(K3));
    await flush();
    assert.equal(globalThis.__q.state.orderQueue.length, 3, 'the tablet holds the three open orders');

    serverDeletesOrder(K1);                              // a till paid it off
    await flush();
    serverUpdatesOrder(K2, { status: 'collected' });     // the last bump marked it collected
    await flush();

    assert.equal(held(K1), null, 'the paid order left the tablet');
    assert.equal(held(K2)?.status, 'collected');
    assert.deepEqual(writes('order_queue'), [], 'no write to order_queue from a kitchen tablet');
    assert.deepEqual(buffered(), [], 'and nothing buffered to send later');
    assert.ok(serverOrder(K2) && serverOrder(K3), 'the server rows are untouched');

    serverDeletesOrder(K2);                              // a till cleared the collected order
    await flush();
    assert.equal(held(K2), null, 'the cleared order leaves the tablet when the till removes it');
    assert.deepEqual(writes('order_queue'), []);
  });

  test(`kitchen tablet, ${name}: never deletes a bar tab it knows of`, async () => {
    await page(shape);
    serverInsertsTab(tabRow('tab-1'));
    serverInsertsTab(tabRow('tab-2'));
    await flush();
    await flush();
    assert.deepEqual(writes('bar_tabs'), [], 'no write to bar_tabs from a kitchen tablet');
    assert.equal(server.rows.bar_tabs.length, 2, 'both tabs are still open on the server');
    assert.deepEqual(buffered(), []);
  });
}

test('till: a delete it HEARD is not answered with a delete of its own', async () => {
  await page();
  serverInsertsOrder(orderRow('T1'));
  await flush();
  serverDeletesOrder('T1');
  await flush();
  assert.equal(held('T1'), null);
  assert.deepEqual(deletes('order_queue'), [], 'no echo');
  assert.deepEqual(buffered().filter((i) => i.type === 'delete'), []);
});

test('till: an order paid off or removed here is deleted by its number, as before', async () => {
  await page();
  serverInsertsOrder(orderRow('T2'));
  await flush();
  useStore.setState({ orderQueue: globalThis.__q.state.orderQueue.filter((o) => o.ref !== 'T2') });   // staff paid it
  await flush();
  const d = deletes('order_queue');
  assert.equal(d.length, 1);
  assert.ok(hasFilter(d[0], 'eq', 'location_id') && hasFilter(d[0], 'in', 'ref') && !hasFilter(d[0], 'eq', 'status'), 'by venue and number');
  assert.equal(serverOrder('T2'), null, 'gone from the server');
  const kept = buffered().filter((i) => i.type === 'delete');
  assert.equal(kept.length, 1, 'and written to the durable queue first');
  assert.deepEqual(kept[0].match, { location_id: LOC, ref: 'T2' });
});

test('till: staff mark an order collected here, it is deleted by its number, as before', async () => {
  await page();
  serverInsertsOrder(orderRow('T3', { status: 'ready' }));
  await flush();
  useStore.setState({ orderQueue: globalThis.__q.state.orderQueue.map((o) => (o.ref === 'T3' ? { ...o, status: 'collected' } : o)) });
  await flush();
  const d = deletes('order_queue');
  assert.equal(d.length, 1);
  assert.ok(!hasFilter(d[0], 'eq', 'status'), 'the server still says ready: the delete must not wait for collected');
  assert.equal(serverOrder('T3'), null);
});

test('till: an order the kitchen marked collected is cleared only while the server still says collected', async () => {
  await page();
  serverInsertsOrder(orderRow('T4', { status: 'ready' }));
  serverInsertsOrder(orderRow('T5', { status: 'ready' }));
  await flush();
  serverUpdatesOrder('T4', { status: 'collected' });
  serverUpdatesOrder('T5', { status: 'collected' });
  // Before this till's flush runs, number T5 is given to a NEW open order on the server.
  Object.assign(serverOrder('T5'), { status: 'received', items: [{ name: 'Flat white', qty: 2 }] });
  await flush();

  const d = deletes('order_queue');
  assert.equal(d.length, 1);
  assert.ok(hasFilter(d[0], 'eq', 'status') && hasFilter(d[0], 'eq', 'location_id') && hasFilter(d[0], 'in', 'ref'), 'venue, numbers and status collected');
  assert.equal(serverOrder('T4'), null, 'the collected order is cleared');
  assert.equal(serverOrder('T5')?.status, 'received', 'the newer order with the same number is untouched');
  const kept = buffered().filter((i) => i.type === 'delete');
  assert.deepEqual(kept.map((i) => i.match), [
    { location_id: LOC, ref: 'T4', status: 'collected' },
    { location_id: LOC, ref: 'T5', status: 'collected' },
  ], 'the durable copies carry the same condition');

  // The durable copies replay: still nothing but a collected row can go.
  await OQ.replayQueue(client);
  await tick();
  assert.equal(serverOrder('T5')?.status, 'received');
});

test('till: a catering order moved to a later day leaves the list and stays in the database', async () => {
  await page();
  serverInsertsOrder(orderRow('C1', { source: 'catering', status: 'scheduled', sent_at: new Date(Date.now() - 60_000).toISOString() }));
  await flush();
  assert.ok(held('C1'), 'due today: on the till');
  serverUpdatesOrder('C1', { sent_at: new Date(Date.now() + 7 * 86_400_000).toISOString() });   // moved to next week
  await flush();
  assert.equal(held('C1'), null, 'off the live list');
  assert.deepEqual(deletes('order_queue'), [], 'not deleted');
  assert.ok(serverOrder('C1'), 'still in the database for its day');
});

test('till: a bar tab removed here is deleted, a delete it heard is not echoed', async () => {
  await page();
  serverInsertsTab(tabRow('tab-9'));
  serverInsertsTab(tabRow('tab-10'));
  await flush();
  assert.deepEqual(deletes('bar_tabs'), [], 'holding tabs deletes nothing');
  // Another till removed tab-9.
  server.rows.bar_tabs = server.rows.bar_tabs.filter((t) => t.id !== 'tab-9');
  QS.applyTabRealtimeEvent({ eventType: 'DELETE', old: { id: 'tab-9', location_id: LOC } });
  await flush();
  assert.deepEqual(deletes('bar_tabs'), [], 'no echo');
  // Staff removed tab-10 on this till.
  useStore.setState({ tabs: globalThis.__q.state.tabs.filter((t) => t.id !== 'tab-10') });
  await flush();
  assert.equal(deletes('bar_tabs').length, 1);
  assert.equal(server.rows.bar_tabs.length, 0);
});

test('till: an order taken here is still published and updated (the fence stops nothing a till owns)', async () => {
  await page();
  useStore.setState({ orderQueue: [{ ref: 'T6', type: 'takeaway', customer: {}, items: [{ name: 'Mocha', qty: 1 }], total: 4, status: 'received', staff: 'Sam', createdAt: Date.now(), source: 'pos' }] });
  await flush();
  assert.ok(serverOrder('T6'), 'published');
  assert.ok(held('T6')?._sync?.hash, 'and confirmed');
  useStore.setState({ orderQueue: globalThis.__q.state.orderQueue.map((o) => ({ ...o, status: 'prep' })) });
  await flush();
  assert.equal(serverOrder('T6')?.status, 'prep', 'updated');
});

test('Back Office and a host stand never sync the list', async () => {
  for (const mode of ['office', 'backoffice', 'bookings']) {
    await page({ mode, type: null });
    serverInsertsOrder(orderRow(`B-${mode}`));
    serverInsertsTab(tabRow(`tab-${mode}`));
    await flush();
    serverDeletesOrder(`B-${mode}`);
    await flush();
    assert.deepEqual(writes('order_queue'), [], mode);
    assert.deepEqual(writes('bar_tabs'), [], mode);
    assert.deepEqual(buffered(), [], mode);
  }
});

test('a restart: orders already finished in the saved list are never deleted by number', async () => {
  // A fresh copy of the module, as after an app restart (the boot capture runs once per page).
  const boot = await import('./QueueSync.js?restart-till');
  await page();
  const done = boot.queueFromRow(orderRow('R1', { status: 'collected' }));             // the server said collected
  const tapped = { ...boot.queueFromRow(orderRow('R2', { status: 'ready' })), status: 'collected' };   // collected here, then the app closed
  const open = boot.queueFromRow(orderRow('R3'));
  globalThis.__q.state = { orderQueue: [done, tapped, open], tabs: [], deviceConfig: null };
  // Both numbers now belong to NEW open orders on the server.
  server.rows.order_queue = [orderRow('R1'), orderRow('R2'), orderRow('R3')];
  boot.captureQueueBoot();
  boot.primeQueueSync(LOC);
  server.log = [];
  await boot.flushQueues();
  await tick();

  const d = deletes('order_queue');
  assert.ok(d.length >= 1 && d.every((l) => hasFilter(l, 'eq', 'status')), 'only deletes that need status collected');
  assert.equal(server.rows.order_queue.length, 3, 'no live order was removed');
  assert.ok(buffered().filter((i) => i.type === 'delete').every((i) => i.match.status === 'collected'));
  boot.teardownQueueSync();
});

test('a restart on a kitchen tablet sends nothing at all', async () => {
  const boot = await import('./QueueSync.js?restart-kitchen');
  await page({ mode: 'pos', type: 'kds', config: { defaultSurface: 'kds', profileName: 'Kitchen Display' } });
  const saved = [];
  for (let i = 1; i <= 31; i += 1) saved.push(boot.queueFromRow(orderRow(`S${i}`, { status: 'collected' })));
  globalThis.__q.state = { orderQueue: saved, tabs: [], deviceConfig: globalThis.__q.state.deviceConfig };
  server.rows.order_queue = [orderRow('S7'), orderRow('S19')];   // two of those numbers are live orders now
  boot.captureQueueBoot();
  boot.primeQueueSync(LOC);
  server.log = [];
  await boot.flushQueues();
  await tick();
  assert.deepEqual(writes('order_queue'), []);
  assert.deepEqual(buffered(), []);
  assert.equal(server.rows.order_queue.length, 2);
  boot.teardownQueueSync();
});

test('a write the list sync buffered on an older build is never sent from a kitchen tablet', async () => {
  await page({ mode: 'kds', type: 'kds' });
  server.rows.order_queue = [orderRow('O1'), orderRow('O2')];
  server.rows.bar_tabs = [tabRow('tab-o1')];
  server.rows.kds_tickets = [{ id: 'kt-1', location_id: LOC, status: 'pending' }];
  await OQ.queueWrite({ type: 'delete', table: 'order_queue', match: { location_id: LOC, ref: 'O1' } });
  await OQ.queueWrite({ type: 'delete', table: 'bar_tabs', match: { id: 'tab-o1' } });
  await OQ.queueWrite({ type: 'upsert', table: 'order_queue', payload: orderRow('O9'), onConflict: 'location_id,ref' });
  await OQ.queueWrite({ type: 'update', table: 'kds_tickets', payload: { status: 'bumped' }, match: { id: 'kt-1', location_id: LOC } });
  server.log = [];
  OQ.setReplayGuard({ drop: (item) => dropBufferedQueueWrite({ role: 'reader', item }) });
  await OQ.replayQueue(client);
  await tick();
  assert.deepEqual(writes('order_queue'), [], 'no order write left the tablet');
  assert.deepEqual(writes('bar_tabs'), [], 'no bar tab write left the tablet');
  assert.ok(serverOrder('O1') && !serverOrder('O9') && server.rows.bar_tabs.length === 1);
  assert.equal(server.rows.kds_tickets[0].status, 'bumped', 'the kitchen ticket write still goes');
  assert.deepEqual(buffered(), [], 'the dropped writes are gone from the queue');

  // On a till the same buffered writes are its own and are all sent.
  await OQ.queueWrite({ type: 'delete', table: 'order_queue', match: { location_id: LOC, ref: 'O1' } });
  await OQ.queueWrite({ type: 'delete', table: 'bar_tabs', match: { id: 'tab-o1' } });
  OQ.setReplayGuard({ drop: (item) => dropBufferedQueueWrite({ role: 'till', item }) });
  await OQ.replayQueue(client);
  await tick();
  assert.equal(serverOrder('O1'), null);
  assert.equal(server.rows.bar_tabs.length, 0);
  OQ.setReplayGuard(null);
});
