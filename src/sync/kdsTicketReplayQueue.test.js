// kdsTicketReplayQueue.test.js: a till replay can never un bump a kitchen ticket (K7), end to end
// through the REAL lib/db.js (insertKDSTicket), sync/OfflineQueue.js and lib/rowWrites.js.
//
// 12 Oct 2026, Barnsley hunt (reproduced on the live build, not the cause that day): a till's
// kitchen ticket insert landed but its answer was lost, so the till queued the ticket again as a
// merging UPSERT carrying status 'pending' and the items as sent. The kitchen bumped the ticket.
// The queue replayed later (the browser's online event, a reload, any other queued write) and
// the ticket went back to pending with its ticks wiped. Nobody had touched it.
//
// Here a fake PostgREST answers like the real one (insert = a new row or 23505; upsert = merge on
// the conflict key, or leave the row alone with ignoreDuplicates; update with a row count) and can
// lose an answer or a whole request. Browser only modules are loaded with two small module hooks,
// as in offlineQueueFence.test.js: extensionless relative imports get '.js', and lib/supabase.js
// (which needs Vite's import.meta.env) is replaced by a stub that hands out the fake client.
// Everything else is the shipped code.
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

// ── The browser the app expects ─────────────────────────────────────────────────────────────────
globalThis.window = new EventTarget();
const doc = new EventTarget();
doc.visibilityState = 'visible';
globalThis.document = doc;
// Offline at the start: the queue then sets no timers of its own and every replay here is asked
// for by the test, so nothing depends on timing.
Object.defineProperty(globalThis, 'navigator', { value: { onLine: false }, configurable: true, writable: true });
const memory = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); } };
};
globalThis.localStorage = memory();
globalThis.sessionStorage = memory();

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

// ── A fake PostgREST ─────────────────────────────────────────────────────────────────────────────
// net: 'ok' | 'reply_lost' (the server DOES the write, the till gets a transport error, which is
// how supabase-js reports a fetch that rejected) | 'down' (the request never arrives).
const server = { rows: {}, net: 'ok', log: [] };
const TRANSPORT = () => ({ message: 'TypeError: Load failed', details: '', hint: '', code: '' });

function query(table) {
  const q = { op: 'select', payload: null, options: null, filters: [], cols: null };
  const run = () => {
    const net = server.net;
    server.log.push({ table, op: q.op, net, options: q.options, many: Array.isArray(q.payload) ? q.payload.length : null });
    if (net === 'down') return { data: null, error: TRANSPORT() };
    const rows = server.rows[table] || (server.rows[table] = []);
    const matches = (r) => q.filters.every(([c, v]) => String(r[c]) === String(v));
    let out = { data: null, error: null };
    if (q.op === 'insert') {
      const list = Array.isArray(q.payload) ? q.payload : [q.payload];
      if (list.some((p) => rows.some((r) => r.id === p.id))) {
        out = { data: null, error: { code: '23505', message: `duplicate key value violates unique constraint "${table}_pkey"` } };
      } else {
        list.forEach((p) => rows.push(structuredClone(p)));
      }
    } else if (q.op === 'upsert') {
      // INSERT ... ON CONFLICT (keys) DO UPDATE SET <the payload's columns>, or DO NOTHING when the
      // request says "Prefer: resolution=ignore-duplicates" (supabase-js ignoreDuplicates: true).
      const keys = String((q.options && q.options.onConflict) || 'id').split(',').map((s) => s.trim());
      const ignore = !!(q.options && q.options.ignoreDuplicates);
      for (const p of (Array.isArray(q.payload) ? q.payload : [q.payload])) {
        const i = rows.findIndex((r) => keys.every((k) => String(r[k]) === String(p[k])));
        if (i < 0) rows.push(structuredClone(p));
        else if (!ignore) rows[i] = { ...rows[i], ...structuredClone(p) };
      }
    } else if (q.op === 'update') {
      const hit = rows.filter(matches);
      hit.forEach((r) => Object.assign(r, structuredClone(q.payload)));
      out = { data: q.cols ? hit.map((r) => ({ id: r.id })) : null, error: null };
    } else {
      out = { data: rows.filter(matches).map((r) => structuredClone(r)), error: null };
    }
    if (net === 'reply_lost' && q.op !== 'select') return { data: null, error: TRANSPORT() };
    return out;
  };
  const b = {
    insert(p) { q.op = 'insert'; q.payload = p; return b; },
    upsert(p, o) { q.op = 'upsert'; q.payload = p; q.options = o === undefined ? null : structuredClone(o); return b; },
    update(p) { q.op = 'update'; q.payload = p; return b; },
    delete() { q.op = 'delete'; return b; },
    eq(c, v) { q.filters.push([c, v]); return b; },
    neq() { return b; },
    in() { return b; },
    select(cols) { q.cols = cols || '*'; return b; },
    abortSignal() { return b; },
    order() { return b; },
    limit() { return b; },
    maybeSingle() { return b; },
    single() { return b; },
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
globalThis.__kdsReplay = { client };

// lib/supabase.js, as the modules under test use it: a paired, linked counter till at venue L1.
const SUPABASE_STUB = `
export const supabase = globalThis.__kdsReplay.client;
export const staffSupabase = null;
export const platformSupabase = null;
export const isMock = false;
export const KIOSK_SECRET_KEY = 'k';
export const LOCATION_ID = 'L1';
export const getLocationId = async () => 'L1';
export const getActiveLocationSync = () => 'L1';
export const getResolvedLocationIdSync = () => 'L1';
export const setResolvedLocationId = () => {};
export const clearResolvedLocationId = () => {};
export const enforceTenantFence = () => {};
export const isBackOfficeMode = () => false;
export const isHostStandMode = () => false;
export const isLoginSurfaceMode = () => false;
export const getDeviceMode = () => 'pos';
export const getLastDeviceLinkOutcome = () => null;
export const ensureAuthToken = async () => null;
export const readLocalDevice = () => ({ kind: 'till', id: 'dev-1', deviceSecret: 's' });
export const linkDevice = async () => ({ outcome: 'linked' });
export const sendDeviceHeartbeat = async () => null;
export const claimPairedDeviceOnBoot = async () => null;
export const whenDeviceClaimed = async () => null;
export const viaWifiPortal = (u) => u;
export const kitchenClient = () => null;
`;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if ((specifier.startsWith('./') || specifier.startsWith('../')) && !/\.[a-z]+$/i.test(specifier)) {
      return nextResolve(`${specifier}.js`, context);
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.endsWith('/src/lib/supabase.js')) return { format: 'module', source: SUPABASE_STUB, shortCircuit: true };
    const r = nextLoad(url, context);
    // Vite fills import.meta.env at build time; node has none. Modules on the way to db.js read it.
    if (url.includes('/src/') && r.source && String(r.source).includes('import.meta.env')) {
      return { ...r, source: `import.meta.env = import.meta.env || {};\n${String(r.source)}` };
    }
    return r;
  },
});

const warn = console.warn;
const error = console.error;
const hush = () => { console.warn = () => {}; console.error = () => {}; };   // the queue's own "queued for retry" lines
const unhush = () => { console.warn = warn; console.error = error; };

const DB = await import('../lib/db.js');
const OQ = await import('./OfflineQueue.js');
const RW = await import('../lib/rowWrites.js');
OQ.initOfflineQueue(client);

// ── Helpers ─────────────────────────────────────────────────────────────────────────────────────
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const queued = () => [...(idb.stores.get('queue') || new Map()).values()].sort((a, b) => a.id - b.id);
const kitchenRow = (id) => (server.rows.kds_tickets || []).find((r) => r.id === id) || null;
const upserts = (table = 'kds_tickets') => server.log.filter((l) => l.table === table && l.op === 'upsert');
function reset() {
  idb.stores.get('queue')?.clear();
  server.rows = { kds_tickets: [], order_queue: [], bar_tabs: [] };
  server.net = 'ok';
  server.log = [];
}
const replay = async () => { await OQ.replayQueue(client); await tick(5); };
// The same call the kitchen screen makes (surfaces/kds/KDSSurface.jsx ticketWrite).
const kitchenWrite = (id, payload, label) => RW.mustChangeRow({ table: 'kds_tickets', type: 'update', payload, match: { id }, kind: 'kds_ticket', label });

const SENT_AT = Date.parse('2026-10-12T14:24:29.141Z');
const BUMPED_AT = '2026-10-12T14:27:00.000Z';
const ticket = (id, extra = {}) => ({
  id, table: 'takeaway', server: 'Freya', covers: 1, centreId: 'pc-drinks', sentAt: SENT_AT,
  firedCourses: [0], allCourses: [0], items: [{ qty: 1, name: 'Chai Latte' }, { qty: 1, name: 'Flat White' }], ...extra,
});
const TICKED = [{ qty: 1, name: 'Chai Latte', _bumped: true }, { qty: 1, name: 'Flat White', _bumped: true }];

// ── K7 ───────────────────────────────────────────────────────────────────────────────────────────

test('the insert lands but its answer is lost, the kitchen ticks and bumps, the queue replays: the ticket stays bumped', async () => {
  reset();
  hush();
  server.net = 'reply_lost';
  const res = await DB.insertKDSTicket(ticket('kds-1'), 'L1');
  unhush();
  assert.ok(res.error, 'the till was told the send failed');
  assert.equal(kitchenRow('kds-1').status, 'pending', 'but the ticket IS in the database');
  assert.equal(queued().length, 1, 'so the till queued it for a retry');
  assert.equal(queued()[0].table, 'kds_tickets');
  assert.equal(queued()[0].type, 'upsert');
  assert.equal(queued()[0].ignoreDuplicates, true, 'as insert if missing');
  assert.equal(queued()[0].payload.status, 'pending', 'the queued copy still says pending, as sent');

  // The kitchen works the ticket: ticks both items, then bumps it.
  server.net = 'ok';
  assert.equal((await kitchenWrite('kds-1', { items: TICKED }, 'Item tick')).outcome, 'applied');
  assert.equal((await kitchenWrite('kds-1', { status: 'bumped', bumped_at: BUMPED_AT }, 'Kitchen ticket bumped')).outcome, 'applied');

  // Later the till's queue replays (here by the browser's online event, the real trigger).
  window.dispatchEvent(new Event('online'));
  await tick(20);
  window.dispatchEvent(new Event('offline'));   // back to "no timers" for the rest of the file

  const row = kitchenRow('kds-1');
  assert.equal(row.status, 'bumped', 'the replay did not put the ticket back on the screen');
  assert.equal(row.bumped_at, BUMPED_AT);
  assert.deepEqual(row.items, TICKED, 'and the ticks are still there');
  assert.equal(queued().length, 0, 'the queued copy is done');
  assert.deepEqual(upserts().map((l) => l.options), [{ onConflict: 'id', ignoreDuplicates: true }], 'one replay, sent as insert if missing');
});

test('the insert never arrived: the replay creates the ticket, with its original sent time', async () => {
  reset();
  hush();
  server.net = 'down';
  const res = await DB.insertKDSTicket(ticket('kds-2', { meta: { v: 1, ref: 'R11828' } }), 'L1');
  assert.ok(res.error);
  assert.equal(kitchenRow('kds-2'), null);
  assert.equal(queued().length, 1);
  await replay();                               // still down: the try is counted, the ticket is kept
  unhush();
  assert.equal(kitchenRow('kds-2'), null);
  assert.equal(queued().length, 1);
  assert.equal(queued()[0].attempts, 1);
  assert.equal(queued()[0].status, 'retry_pending');

  server.net = 'ok';
  await replay();
  const row = kitchenRow('kds-2');
  assert.ok(row, 'a missing ticket is still created by the replay');
  assert.equal(row.status, 'pending');
  assert.equal(row.sent_at, '2026-10-12T14:24:29.141Z', 'stamped with the time it was sent, not the time it arrived');
  assert.equal(row.centre_id, 'pc-drinks');
  assert.equal(row.location_id, 'L1');
  assert.deepEqual(row.items, ticket('kds-2').items);
  assert.equal(queued().length, 0);
});

test('a "duplicate key" answer means the ticket is already there: nothing is queued and the till gets no error', async () => {
  reset();
  // The first send landed (its answer was lost) and the kitchen has already bumped the ticket.
  server.rows.kds_tickets.push({ id: 'kds-3', location_id: 'L1', status: 'bumped', bumped_at: BUMPED_AT, items: TICKED, sent_at: '2026-10-12T14:24:29.141Z' });
  const before = structuredClone(kitchenRow('kds-3'));
  const res = await DB.insertKDSTicket(ticket('kds-3'), 'L1');
  assert.deepEqual(res, { data: null, error: null }, 'reported as sent');
  assert.equal(queued().length, 0, 'nothing queued');
  assert.deepEqual(kitchenRow('kds-3'), before, 'the row is exactly as the kitchen left it');
  assert.equal(server.rows.kds_tickets.length, 1);
  assert.equal(upserts().length, 0);
  // The first send is still a plain insert (the order path is unchanged).
  assert.deepEqual(server.log.filter((l) => l.table === 'kds_tickets').map((l) => l.op), ['insert']);
});

test('a kitchen ticket queued by an older build (no flag) still cannot change a ticket that exists', async () => {
  reset();
  server.rows.kds_tickets.push({ id: 'kds-4', location_id: 'L1', status: 'held', bumped_at: null, items: TICKED, sent_at: '2026-10-12T14:24:29.141Z' });
  const before = structuredClone(kitchenRow('kds-4'));
  // Exactly what v5.11.50 and earlier wrote to the queue.
  await OQ.queueWrite({ type: 'upsert', table: 'kds_tickets', payload: { id: 'kds-4', location_id: 'L1', status: 'pending', items: ticket('kds-4').items, sent_at: '2026-10-12T14:24:29.141Z' }, onConflict: 'id' });
  await replay();
  assert.deepEqual(kitchenRow('kds-4'), before, 'held, ticked and untouched');
  assert.equal(queued().length, 0);
  assert.deepEqual(upserts().map((l) => l.options), [{ onConflict: 'id', ignoreDuplicates: true }]);
});

test('a batched replay of kitchen tickets changes no ticket that exists and still creates the missing one', async () => {
  reset();
  server.rows.kds_tickets.push({ id: 'kds-5', location_id: 'L1', status: 'bumped', bumped_at: BUMPED_AT, items: TICKED });
  server.rows.kds_tickets.push({ id: 'kds-6', location_id: 'L1', status: 'bumped', bumped_at: '2026-10-12T14:28:10.000Z', items: TICKED });
  const five = structuredClone(kitchenRow('kds-5'));
  const six = structuredClone(kitchenRow('kds-6'));
  hush();
  server.net = 'down';
  await DB.insertKDSTicket(ticket('kds-5'), 'L1');
  await DB.insertKDSTicket(ticket('kds-6'), 'L1');
  await DB.insertKDSTicket(ticket('kds-7'), 'L1');     // this one never reached the kitchen
  unhush();
  assert.equal(queued().length, 3);
  server.net = 'ok';
  server.log = [];
  await replay();
  assert.deepEqual(kitchenRow('kds-5'), five);
  assert.deepEqual(kitchenRow('kds-6'), six);
  assert.equal(kitchenRow('kds-7').status, 'pending');
  assert.equal(queued().length, 0);
  assert.deepEqual(upserts(), [{ table: 'kds_tickets', op: 'upsert', net: 'ok', options: { onConflict: 'id', ignoreDuplicates: true }, many: 3 }], 'one statement for the three, sent as insert if missing');
});

test('an old and a new queued kitchen ticket share one statement; a bar tab beside them still merges', async () => {
  reset();
  server.rows.kds_tickets.push({ id: 'kds-8', location_id: 'L1', status: 'bumped', bumped_at: BUMPED_AT, items: TICKED });
  server.rows.bar_tabs.push({ id: 'tab-1', location_id: 'L1', status: 'open', total: 10 });
  const eight = structuredClone(kitchenRow('kds-8'));
  await OQ.queueWrite({ type: 'upsert', table: 'kds_tickets', payload: { id: 'kds-8', location_id: 'L1', status: 'pending', items: [] }, onConflict: 'id' });   // older build
  await OQ.queueWrite({ type: 'upsert', table: 'kds_tickets', payload: { id: 'kds-9', location_id: 'L1', status: 'pending', items: [] }, onConflict: 'id', ignoreDuplicates: true });
  await OQ.queueWrite({ type: 'upsert', table: 'bar_tabs', payload: { id: 'tab-1', location_id: 'L1', status: 'open', total: 24 }, onConflict: 'id' });
  await OQ.queueWrite({ type: 'upsert', table: 'order_queue', payload: { location_id: 'L1', ref: '1042', status: 'prep' }, onConflict: 'location_id,ref' });
  await replay();
  assert.deepEqual(kitchenRow('kds-8'), eight);
  assert.equal(kitchenRow('kds-9').status, 'pending');
  assert.equal(server.rows.bar_tabs[0].total, 24, 'every other table replays as a merge, exactly as before');
  assert.deepEqual(server.rows.order_queue, [{ location_id: 'L1', ref: '1042', status: 'prep' }]);
  assert.equal(queued().length, 0);
  assert.deepEqual(upserts('kds_tickets').map((l) => [l.many, l.options]), [[2, { onConflict: 'id', ignoreDuplicates: true }]]);
  assert.deepEqual(upserts('bar_tabs').map((l) => l.options), [{ onConflict: 'id' }], 'no new option on a bar tab');
  assert.deepEqual(upserts('order_queue').map((l) => l.options), [{ onConflict: 'location_id,ref' }], 'nor on an order');
});
