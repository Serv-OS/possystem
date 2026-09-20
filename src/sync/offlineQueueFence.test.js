// offlineQueueFence.test.js: database fence stage 1, fix round 2, the zero row blocker, end to end
// through the REAL sync/OfflineQueue.js, lib/rowWrites.js and lib/deviceLink.js.
//
// Proven on the harness (round 1 floor review): after file A, a till that lost its link has its
// updates and deletes of bar_tabs and closed_checks (after file B also active_sessions,
// order_queue, kds_tickets and print_jobs) silently ignored: no error, 0 rows. Before this fix the
// till counted them as sent, so a paid bar tab or table stayed open on the server for a second
// charge. Here a fake Postgres answers exactly like row level security does (a hidden row is
// "0 rows, no error"; an insert or upsert is refused with 42501), and the tests prove:
//   - every such write on an unlinked till is KEPT (parked), shows the banner, and lands once the
//     till is linked again, exactly once, in order;
//   - on a linked till a write whose row is really gone is done, never kept, never resent;
//   - a till already running the release collects its device secret on the next heartbeat;
//   - a kiosk or till that is not linked never starts a card payment.
//
// Browser only modules are loaded with two small module hooks: extensionless relative imports get
// '.js', and lib/supabase.js (which needs Vite's import.meta.env) is replaced by a stub that hands
// out the fake client below. Everything else is the shipped code.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

// ── The browser the app expects ─────────────────────────────────────────────────────────────────
globalThis.window = new EventTarget();
const doc = new EventTarget();
doc.visibilityState = 'visible';
globalThis.document = doc;
Object.defineProperty(globalThis, 'navigator', { value: { onLine: false }, configurable: true, writable: true });

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

// ── A fake Postgres with the fence's row level security ──────────────────────────────────────────
const FENCED = new Set(['bar_tabs', 'active_sessions', 'order_queue', 'closed_checks', 'kds_tickets', 'print_jobs']);
const DEV = '11111111-1111-4111-8111-111111111111';

const server = { linked: true, hasSecret: true, statusMissing: false, statusError: null, rows: {}, log: [], rpcCalls: [] };

const colOf = (row, col) => {
  if (col.includes('->>')) {
    const [a, b] = col.split('->>');
    const o = row[a];
    const v = o && typeof o === 'object' ? o[b] : undefined;
    return v === undefined || v === null ? null : (typeof v === 'object' ? JSON.stringify(v) : String(v));
  }
  return row[col];
};

function query(table) {
  const q = { table, op: 'select', payload: undefined, filters: [], cols: null, onConflict: 'id' };
  const run = () => {
    server.log.push({ table, op: q.op, filters: q.filters.map((f) => [...f]) });
    const fenced = FENCED.has(table);
    const visible = () => !fenced || server.linked;
    const matches = (row) => q.filters.every(([k, c, v]) => {
      const val = colOf(row, c);
      if (k === 'eq') return val !== undefined && val !== null && String(val) === String(v);
      if (k === 'neq') return val !== undefined && val !== null && String(val) !== String(v);
      if (k === 'in') return val !== undefined && val !== null && v.map(String).includes(String(val));
      return true;
    });
    const project = (row) => {
      if (!q.cols || q.cols === '*') return structuredClone(row);
      const out = {};
      for (const c of q.cols.split(',').map((s) => s.trim())) out[c] = row[c];
      return out;
    };
    const rows = server.rows[table] || (server.rows[table] = []);
    if (q.op === 'update') {
      const hit = rows.filter((r) => visible(r) && matches(r));
      for (const r of hit) Object.assign(r, structuredClone(q.payload));
      return { data: q.cols ? hit.map(project) : null, error: null };
    }
    if (q.op === 'delete') {
      const hit = rows.filter((r) => visible(r) && matches(r));
      server.rows[table] = rows.filter((r) => !hit.includes(r));
      return { data: q.cols ? hit.map(project) : null, error: null };
    }
    if (q.op === 'insert' || q.op === 'upsert') {
      if (fenced && !server.linked) return { data: null, error: { code: '42501', message: `new row violates row-level security policy for table "${table}"` } };
      const list = Array.isArray(q.payload) ? q.payload : [q.payload];
      const keys = q.onConflict.split(',').map((s) => s.trim());
      for (const p of list) {
        const i = q.op === 'upsert' ? rows.findIndex((r) => keys.every((k) => String(r[k]) === String(p[k]))) : -1;
        if (i >= 0) rows[i] = { ...rows[i], ...structuredClone(p) }; else rows.push(structuredClone(p));
      }
      return { data: null, error: null };
    }
    return { data: rows.filter((r) => visible(r) && matches(r)).map(project), error: null };
  };
  const b = {
    update(p) { q.op = 'update'; q.payload = p; return b; },
    delete() { q.op = 'delete'; return b; },
    insert(p) { q.op = 'insert'; q.payload = p; return b; },
    upsert(p, o) { q.op = 'upsert'; q.payload = p; q.onConflict = (o && o.onConflict) || 'id'; return b; },
    eq(c, v) { q.filters.push(['eq', c, v]); return b; },
    neq(c, v) { q.filters.push(['neq', c, v]); return b; },
    in(c, v) { q.filters.push(['in', c, v]); return b; },
    select(cols) { q.cols = cols || '*'; return b; },
    then(res, rej) { return Promise.resolve().then(run).then(res, rej); },
  };
  return b;
}

const client = {
  from: (table) => query(table),
  rpc(name) {
    server.rpcCalls.push(name);
    if (name === 'device_status') {
      if (server.statusMissing) return Promise.resolve({ data: null, error: { code: 'PGRST202', message: 'Could not find the function public.device_status' } });
      if (server.statusError) return Promise.resolve({ data: null, error: server.statusError });
      return Promise.resolve({ data: { bound: server.linked, device_id: server.linked ? DEV : null, has_secret: server.hasSecret, status: 'active' }, error: null });
    }
    return Promise.resolve({ data: null, error: { code: 'PGRST202', message: `Could not find the function public.${name}` } });
  },
};

globalThis.__fence = {
  client, server,
  device: { kind: 'till', id: DEV, deviceSecret: 'secret-1', pairingCode: null, locationName: 'Beta' },
  heartbeat: null, linkCalls: 0, secretsIssued: 0,
};

// lib/supabase.js, as the modules under test use it. linkDevice behaves like the real one: a
// linked session collects a missing secret and answers 'linked'; an unlinked one answers 'lost'.
const SUPABASE_STUB = `
const f = () => globalThis.__fence;
const send = (name, detail) => { try { window.dispatchEvent(new CustomEvent(name, { detail })); } catch { /* none */ } };
export const supabase = globalThis.__fence.client;
export const isMock = false;
export function readLocalDevice() { return f().device; }
export function isBackOfficeMode() { return false; }
export function isHostStandMode() { return false; }
export function getLastDeviceLinkOutcome() { return null; }
export async function sendDeviceHeartbeat() { return f().heartbeat; }
export async function linkDevice() {
  const s = f();
  s.linkCalls += 1;
  if (!s.server.linked) { send('rpos-device-link-lost', { reason: 'not_bound' }); return { outcome: 'lost', reason: 'not_bound' }; }
  if (!s.server.hasSecret || !s.device.deviceSecret) {
    s.server.hasSecret = true; s.device = { ...s.device, deviceSecret: 'issued-' + (++s.secretsIssued) };
  }
  send('rpos-device-linked', { outcome: 'linked' });
  return { outcome: 'linked' };
}
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
    return nextLoad(url, context);
  },
});

const OQ = await import('./OfflineQueue.js');
const RW = await import('../lib/rowWrites.js');
const DL = await import('../lib/deviceLink.js');
const { PARKED_LINK, occupationMatch } = await import('../lib/rowWriteFence.js');

OQ.initOfflineQueue(client);
DL.startDeviceLinkMonitor();
after(() => { DL.resetDeviceLinkState(); });

// ── Helpers ─────────────────────────────────────────────────────────────────────────────────────
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
async function until(cond, timeout = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { if (await cond()) return true; await tick(10); }
  return false;
}
const queued = () => [...(idb.stores.get('queue') || new Map()).values()].sort((a, b) => a.id - b.id);
async function settle() {
  // Let any replay started by an event finish (the queue does one pass at a time).
  await tick(60);
  await until(async () => { await tick(20); return true; }, 200);
}
function reset({ linked = true, device } = {}) {
  idb.stores.get('queue')?.clear();
  server.linked = linked; server.hasSecret = true; server.statusMissing = false; server.statusError = null;
  server.rows = {
    bar_tabs: [{ id: 'tab-1', location_id: 'L1', status: 'open', total: 24 }],
    closed_checks: [{ id: 'chk-1', location_id: 'L1', refunds: [], status: 'paid' }],
    active_sessions: [{ location_id: 'L1', table_id: 'T9', session: { seatedAt: 1726700000000, items: [1] } }],
    order_queue: [{ location_id: 'L1', ref: '1042', status: 'received' }],
    kds_tickets: [{ id: 'kt-1', location_id: 'L1', status: 'pending' }],
    print_jobs: [{ id: 'pj-1', location_id: 'L1', status: 'pending' }],
  };
  server.log = []; server.rpcCalls = [];
  globalThis.__fence.device = device || { kind: 'till', id: DEV, deviceSecret: 'secret-1', pairingCode: null, locationName: 'Beta' };
  globalThis.__fence.heartbeat = null; globalThis.__fence.linkCalls = 0;
  DL.resetDeviceLinkState();
}
const relink = async () => {
  server.linked = true;
  window.dispatchEvent(new CustomEvent('rpos-device-relinked', { detail: { outcome: 'relinked' } }));
  await until(() => queued().length === 0);
  await settle();
};
const writes = (table, op) => server.log.filter((l) => l.table === table && l.op === op).length;

window.dispatchEvent(new Event('online'));   // the queue is online from here on
await settle();

// ── The zero row blocker ─────────────────────────────────────────────────────────────────────────

test('an unlinked till: tab close, tab delete, refund, table clear, order bump, ticket and print job are all KEPT, then land after Pair again, once each', async () => {
  reset({ linked: true });
  server.linked = false;   // file A ran and this till lost its link (a "pair again" till)

  // QueueSync's durable path: every order_queue and bar_tabs update and delete is queued first.
  await OQ.queueWrite({ type: 'update', table: 'bar_tabs', payload: { id: 'tab-1', status: 'closed' }, match: { id: 'tab-1' }, notMatch: { status: 'closed' } });
  await OQ.queueWrite({ type: 'delete', table: 'bar_tabs', match: { id: 'tab-1' } });
  await OQ.replayQueue(client);
  // The live writers (db.js refunds, SessionSync, the store, KDS, print).
  const refund = await RW.mustChangeRow({ table: 'closed_checks', type: 'update', payload: { refunds: [{ amount: 5 }], status: 'refunded' }, match: { id: 'chk-1', location_id: 'L1' }, kind: 'refund' });
  const clear = await RW.mustChangeRows({ table: 'active_sessions', type: 'delete', match: { location_id: 'L1' }, inColumn: 'table_id', keys: ['T9'], identityFor: () => occupationMatch(1726700000000) });
  const bump = await RW.mustChangeRow({ table: 'order_queue', type: 'update', payload: { status: 'prep' }, match: { ref: '1042', location_id: 'L1', status: 'received' } });
  const ticket = await RW.mustChangeRow({ table: 'kds_tickets', type: 'update', payload: { status: 'bumped' }, match: { id: 'kt-1', location_id: 'L1' } });
  const job = await RW.mustChangeRow({ table: 'print_jobs', type: 'update', payload: { status: 'done' }, match: { id: 'pj-1' } });
  await settle();

  assert.equal(refund.outcome, 'parked');
  assert.equal(clear.outcome, 'parked');
  assert.deepEqual(clear.parked, ['T9']);
  assert.equal(bump.outcome, 'parked');
  assert.equal(ticket.outcome, 'parked');
  assert.equal(job.outcome, 'parked');
  // Nothing reached the server, and nothing was counted as sent.
  assert.equal(server.rows.bar_tabs[0].status, 'open');
  assert.deepEqual(server.rows.closed_checks[0].refunds, []);
  assert.equal(server.rows.active_sessions.length, 1);
  assert.equal(server.rows.order_queue[0].status, 'received');
  const items = queued();
  assert.equal(items.length, 7, 'every write is still on the till');
  // Each write is parked for the link, or (the tab delete) waits untouched behind the parked
  // close of the same tab, so the two land in order. Nothing is failed or counted as sent.
  const tabWrites = items.filter((i) => i.table === 'bar_tabs');
  assert.equal(tabWrites[0].type, 'update');
  assert.equal(tabWrites[0].status, PARKED_LINK);
  assert.equal(tabWrites[1].type, 'delete');
  assert.ok(tabWrites[1].status === PARKED_LINK || (tabWrites[1].status === 'pending' && !tabWrites[1].attempts), 'the delete waits behind the close');
  assert.ok(items.filter((i) => i.table !== 'bar_tabs').every((i) => i.status === PARKED_LINK), 'parked for the link, not failed');
  assert.ok(items.every((i) => !i.permanentFailure && !i.attempts));
  assert.deepEqual(items.find((i) => i.table === 'active_sessions').match, { location_id: 'L1', table_id: 'T9', 'session->>seatedAt': '1726700000000' });
  assert.equal(DL.getDeviceLinkState().lost, true, 'the red banner shows');
  // A replay while still unlinked sends nothing new and keeps everything.
  const before = server.log.length;
  await OQ.replayQueue(client);
  assert.equal(server.log.length, before, 'parked writes wait for the link, they are not retried');

  await relink();   // Pair again (or the secret re-link): the till is linked again

  assert.equal(queued().length, 0, 'every kept write was sent');
  assert.equal(server.rows.bar_tabs.length, 0, 'the paid tab was closed, then deleted, on the server');
  assert.deepEqual(server.rows.closed_checks[0].refunds, [{ amount: 5 }]);
  assert.equal(server.rows.closed_checks[0].status, 'refunded');
  assert.equal(server.rows.active_sessions.length, 0, 'the paid table left the floor');
  assert.equal(server.rows.order_queue[0].status, 'prep');
  assert.equal(server.rows.kds_tickets[0].status, 'bumped');
  assert.equal(server.rows.print_jobs[0].status, 'done');
  assert.equal(DL.getDeviceLinkState().lost, false, 'the banner is gone');
  // Exactly once: one refund update landed after the relink, and nothing is left to resend.
  const refundsAfter = server.log.filter((l) => l.table === 'closed_checks' && l.op === 'update').length;
  await OQ.replayQueue(client);
  assert.equal(server.log.filter((l) => l.table === 'closed_checks' && l.op === 'update').length, refundsAfter, 'never sent twice');
});

for (const [table, match] of [
  ['bar_tabs', { id: 'gone-1' }],
  ['active_sessions', { location_id: 'L1', table_id: 'T404' }],
  ['order_queue', { location_id: 'L1', ref: '9999' }],
  ['closed_checks', { id: 'chk-gone' }],
  ['kds_tickets', { id: 'kt-gone' }],
  ['print_jobs', { id: 'pj-gone' }],
]) {
  test(`${table}: on a LINKED till a write whose row is really gone is done, never kept, no banner`, async () => {
    reset({ linked: true });
    for (const type of ['update', 'delete']) {
      const r = await RW.mustChangeRow({ table, type, match, ...(type === 'update' ? { payload: { status: 'x' } } : {}) });
      assert.equal(r.outcome, 'gone', `${type}`);
    }
    await settle();
    assert.equal(queued().length, 0);
    assert.equal(DL.getDeviceLinkState().lost, false);
    assert.ok(server.rpcCalls.includes('device_status'), 'the link was asked after the write answered');
  });

  test(`${table}: on an UNLINKED till the same write is kept, and after the relink it is done (row gone)`, async () => {
    reset({ linked: false });
    const r = await RW.mustChangeRow({ table, type: 'delete', match });
    assert.equal(r.outcome, 'parked');
    assert.equal(queued().length, 1);
    await relink();
    assert.equal(queued().length, 0, 'the row is gone on the server: done, not kept for ever');
  });
}

test('a write that changed its row is applied at once, with no link check', async () => {
  reset({ linked: true });
  const r = await RW.mustChangeRow({ table: 'kds_tickets', type: 'update', payload: { status: 'bumped' }, match: { id: 'kt-1' } });
  assert.equal(r.outcome, 'applied');
  assert.equal(server.rows.kds_tickets[0].status, 'bumped');
  assert.equal(server.rpcCalls.length, 0);
  assert.equal(queued().length, 0);
});

test('QueueSync\'s durable delete, replayed after the live delete already landed: done (linked), gone from the queue', async () => {
  reset({ linked: true });
  server.rows.bar_tabs = [];   // the live delete already removed it
  await OQ.queueWrite({ type: 'delete', table: 'bar_tabs', match: { id: 'tab-1' } });
  await OQ.replayQueue(client);
  await settle();
  assert.equal(queued().length, 0);
});

test('order is kept: a recall made while the bump is parked waits behind it, so the ticket ends recalled', async () => {
  reset({ linked: false });
  const bump = await RW.mustChangeRow({ table: 'kds_tickets', type: 'update', payload: { status: 'bumped' }, match: { id: 'kt-1' } });
  assert.equal(bump.outcome, 'parked');
  const recall = await RW.mustChangeRow({ table: 'kds_tickets', type: 'update', payload: { status: 'pending' }, match: { id: 'kt-1' } });
  assert.equal(recall.outcome, 'queued', 'not sent ahead of the parked bump');
  await relink();
  assert.equal(server.rows.kds_tickets[0].status, 'pending', 'the LAST write wins');
});

test('order is kept in the second between a relink and its replay: a new write queues behind the released one', async () => {
  reset({ linked: false });
  await RW.mustChangeRow({ table: 'kds_tickets', type: 'update', payload: { status: 'bumped' }, match: { id: 'kt-1' } });
  server.linked = true;
  await OQ.releaseParkedPermissionWrites();   // released, not replayed yet
  assert.equal(queued()[0].status, 'pending');
  const recall = await RW.mustChangeRow({ table: 'kds_tickets', type: 'update', payload: { status: 'pending' }, match: { id: 'kt-1' } });
  assert.equal(recall.outcome, 'queued');
  await OQ.replayQueue(client);
  await settle();
  assert.equal(queued().length, 0);
  assert.equal(server.rows.kds_tickets[0].status, 'pending');
});

test('in one replay pass, a later write of a row waits when an earlier one could not land', async () => {
  reset({ linked: true });
  server.statusError = { message: 'network' };   // the link cannot be checked
  server.rows.order_queue = [];                  // the first update finds nothing
  await OQ.queueWrite({ type: 'update', table: 'order_queue', payload: { status: 'prep' }, match: { location_id: 'L1', ref: '1042' } });
  await OQ.queueWrite({ type: 'upsert', table: 'order_queue', payload: { location_id: 'L1', ref: '1042', status: 'ready' }, onConflict: 'location_id,ref' });
  await OQ.replayQueue(client);
  await settle();
  const items = queued();
  assert.equal(items.length, 2, 'the upsert of the same row did not jump ahead');
  assert.equal(items[0].status, 'retry_pending');
  assert.equal(items[1].status, 'pending');
  assert.equal(server.rows.order_queue.length, 0);
});

test('paired again the next day: the paid tab and table still leave the server; a stale order update is held for review', async () => {
  reset({ linked: false });
  await RW.mustChangeRow({ table: 'bar_tabs', type: 'delete', match: { id: 'tab-1' } });
  await RW.mustChangeRows({ table: 'active_sessions', type: 'delete', match: { location_id: 'L1' }, inColumn: 'table_id', keys: ['T9'], identityFor: () => occupationMatch(1726700000000) });
  await RW.mustChangeRow({ table: 'order_queue', type: 'update', payload: { status: 'prep' }, match: { ref: '1042', location_id: 'L1' } });
  await settle();
  // Age every kept write by 13 hours (past the 12 hour replay limit).
  const store = idb.stores.get('queue');
  for (const [id, it] of store) store.set(id, { ...it, ts: it.ts - 13 * 3600 * 1000 });
  server.linked = true;
  window.dispatchEvent(new CustomEvent('rpos-device-relinked', { detail: { outcome: 'relinked' } }));
  await until(() => server.rows.bar_tabs.length === 0 && server.rows.active_sessions.length === 0);
  await until(() => [...store.values()].every((i) => i.status === 'failed_stale'));
  await settle();
  assert.equal(server.rows.bar_tabs.length, 0, 'the paid tab left the server');
  assert.equal(server.rows.active_sessions.length, 0, 'the paid table left the floor');
  assert.equal(server.rows.order_queue[0].status, 'received', 'a 13 hour old order change is not applied blind');
  const left = [...store.values()];
  assert.equal(left.length, 1);
  assert.equal(left[0].status, 'failed_stale', 'held on the till for review, never dropped');
});

test('an upsert refused while unlinked (42501) is kept and released on relink too', async () => {
  reset({ linked: false });
  await OQ.queueWrite({ type: 'upsert', table: 'active_sessions', payload: { location_id: 'L1', table_id: 'T5', session: { seatedAt: 5 } }, onConflict: 'location_id,table_id' });
  await OQ.replayQueue(client);
  await settle();
  assert.equal(queued()[0].status, 'retry_pending');
  await relink();
  assert.ok(server.rows.active_sessions.some((r) => r.table_id === 'T5'));
});

test('not a device (Back Office): 0 rows is today\'s behaviour, nothing kept, no link call', async () => {
  reset({ linked: true, device: null });
  globalThis.__fence.device = null;
  const r = await RW.mustChangeRow({ table: 'order_queue', type: 'update', payload: { status: 'x' }, match: { location_id: 'L1', ref: 'nope' } });
  assert.equal(r.outcome, 'gone');
  assert.equal(server.rpcCalls.length, 0);
  assert.equal(queued().length, 0);
});

test('before file A (the fence functions do not exist): today\'s behaviour, nothing kept', async () => {
  reset({ linked: true });
  server.statusMissing = true;
  const r = await RW.mustChangeRow({ table: 'bar_tabs', type: 'update', payload: { status: 'x' }, match: { id: 'nope' } });
  assert.equal(r.outcome, 'gone');
  assert.equal(queued().length, 0);
  assert.equal(DL.getDeviceLinkState().supported, false);
});

// ── HIGH: a till already running the release collects its device secret on the heartbeat ────────

test('heartbeat: bound with no device secret collects it (no restart, no wake, no reboot)', async () => {
  reset({ linked: true, device: { kind: 'till', id: DEV, deviceSecret: null, pairingCode: null, locationName: 'Beta' } });
  server.hasSecret = false;
  globalThis.__fence.heartbeat = { bound: true, device_id: DEV, has_secret: false, status: 'active' };
  await DL.deviceHeartbeat();
  await until(() => globalThis.__fence.linkCalls > 0);
  assert.equal(globalThis.__fence.linkCalls, 1, 'the heartbeat started the secret collection');
  assert.ok(globalThis.__fence.device.deviceSecret, 'the till now holds its secret');
  // The next heartbeat finds the secret on both sides and asks for nothing.
  globalThis.__fence.heartbeat = { bound: true, device_id: DEV, has_secret: true, status: 'active' };
  await DL.deviceHeartbeat();
  await settle();
  assert.equal(globalThis.__fence.linkCalls, 1);
  // Server has a secret but this till does not (a copy lost): collected again.
  globalThis.__fence.device = { ...globalThis.__fence.device, deviceSecret: null };
  await DL.deviceHeartbeat();
  await until(() => globalThis.__fence.linkCalls > 1);
  assert.equal(globalThis.__fence.linkCalls, 2);
});

test('heartbeat: before file A (unsupported) nothing is asked; not bound starts the re-link', async () => {
  reset({ linked: true });
  globalThis.__fence.heartbeat = { unsupported: true };
  await DL.deviceHeartbeat();
  await settle();
  assert.equal(globalThis.__fence.linkCalls, 0);
  assert.equal(DL.getDeviceLinkState().supported, false);
  reset({ linked: false });
  globalThis.__fence.heartbeat = { bound: false, device_id: null, has_secret: false };
  await DL.deviceHeartbeat();
  await until(() => globalThis.__fence.linkCalls > 0);
  assert.equal(globalThis.__fence.linkCalls, 1);
  await settle();
  assert.equal(DL.getDeviceLinkState().lost, true);
});

// ── HIGH: no card payment starts on a kiosk or till that is not linked ─────────────────────────

test('card gate: an unlinked kiosk never starts the reader; a linked one does', async () => {
  reset({ linked: false, device: { kind: 'kiosk', id: DEV, deviceSecret: 'k-secret', pairingCode: null, locationName: null } });
  const no = await DL.confirmLinkBeforeCard();
  assert.equal(no.ok, false);
  assert.equal(no.reason, 'not_linked');
  assert.match(no.message, /ask a member of staff/i);
  assert.match(no.message, /Nothing has been charged/);
  assert.equal(globalThis.__fence.linkCalls, 1, 'one re-link with the secret was tried first');
  reset({ linked: true, device: { kind: 'kiosk', id: DEV, deviceSecret: 'k-secret', pairingCode: null, locationName: null } });
  const yes = await DL.confirmLinkBeforeCard();
  assert.equal(yes.ok, true);
  assert.equal(yes.reason, 'linked');
});

test('card gate: a till whose login changed re-links with its secret and then takes the card', async () => {
  reset({ linked: false });
  // The re-link succeeds (the server takes the secret) while the gate is checking.
  const realLink = globalThis.__fence.server;
  const r = DL.confirmLinkBeforeCard();
  realLink.linked = true;   // device_status already answered unbound; the re-link now works
  const out = await r;
  assert.equal(out.ok, true);
  assert.equal(out.reason, 'relinked');
});

test('card gate: an unlinked till is refused in plain words; a failed check is refused unless linked moments ago', async () => {
  reset({ linked: false });
  const no = await DL.confirmLinkBeforeCard();
  assert.equal(no.ok, false);
  assert.match(no.message, /not linked to Beta/);
  assert.match(no.message, /cannot take card payments/);
  reset({ linked: true });
  server.statusError = { message: 'network down' };
  const unknown = await DL.confirmLinkBeforeCard();
  assert.equal(unknown.ok, false);
  assert.equal(unknown.reason, 'unknown');
  // A heartbeat said "linked" a moment ago: a blip does not stop the payment.
  server.statusError = null;
  globalThis.__fence.heartbeat = { bound: true, device_id: DEV, has_secret: true };
  await DL.deviceHeartbeat();
  DL.resetDeviceLinkState();
  globalThis.__fence.heartbeat = { bound: true, device_id: DEV, has_secret: true };
  await DL.deviceHeartbeat();
  server.statusError = { message: 'network down' };
  const recent = await DL.confirmLinkBeforeCard();
  assert.equal(recent.ok, true);
  assert.equal(recent.reason, 'recently_linked');
});

test('card gate: before file A no round trip is added to the payment', async () => {
  reset({ linked: true });
  globalThis.__fence.heartbeat = { unsupported: true };
  await DL.deviceHeartbeat();
  server.rpcCalls = [];
  const r = await DL.confirmLinkBeforeCard();
  assert.equal(r.ok, true);
  assert.equal(r.reason, 'unsupported');
  assert.deepEqual(server.rpcCalls, [], 'no device_status before the card starts');
  // Without that recent answer the check is made, and "function missing" is still today's path.
  reset({ linked: true });
  server.statusMissing = true;
  const r2 = await DL.confirmLinkBeforeCard();
  assert.equal(r2.ok, true);
  assert.deepEqual(server.rpcCalls, ['device_status']);
});

test('card gate: Back Office and customer pages are not devices and are never gated', async () => {
  reset({ linked: false, device: null });
  globalThis.__fence.device = null;
  const r = await DL.confirmLinkBeforeCard();
  assert.equal(r.ok, true);
  assert.equal(r.reason, 'not_device');
  assert.equal(server.rpcCalls.length, 0);
});
