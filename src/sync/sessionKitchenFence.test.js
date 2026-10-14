// sessionKitchenFence.test.js: which pages publish a table, end to end through the REAL
// sync/SessionSync.js and sync/SessionReconciler.js (12 Oct 2026, lib/queueDeleteRule.js
// showsKitchenScreen).
//
// Leeds, 26 Sep 2026: a kitchen screen that booted with a leaked order kept putting the table back
// after the till voided it. v5.9.72 stopped a kitchen screen publishing tables, but it tested the
// page's mode word (kds). That is the ServOS KDS app. A tablet paired as a Kitchen Display inside a
// till mode page (mode pos, devices.type kds) was missed, and so was a POS pairing on a profile
// that boots straight to the kitchen screen. Here a fake database counts what each page sends:
//   - a kitchen screen in every shape sends nothing to active_sessions: no publish of a table it
//     heard, no delete of one it saw close, no put back, and its reconciler does not even read;
//   - a till still publishes, deletes, puts back and reconciles, exactly as before;
//   - a page that SHOWS a till inside the kitchen app publishes (it was wrongly stopped before);
//   - the Bookings host stand is not stopped: it seats tables and publishes them here.
//
// lib/supabase.js (Vite's import.meta.env) and the store are replaced by small stubs through two
// module hooks, as queueDeleteFence.test.js does. Everything else is the shipped code.
import test, { mock } from 'node:test';
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

// ── A fake database that logs every read and write ───────────────────────────────────────────
const LOC = 'L1';
const server = { rows: { active_sessions: [] }, log: [] };

function query(table) {
  const q = { op: 'select', payload: undefined, filters: [], cols: null, onConflict: 'id', single: false };
  const valueOf = (row, c) => {
    if (!c.includes('->>')) return row[c];
    const [col, key] = c.split('->>');
    const v = row[col]?.[key];
    return v === undefined || v === null ? v : String(v);
  };
  const matches = (row) => q.filters.every(([k, c, v]) => {
    const val = valueOf(row, c);
    if (k === 'eq') return val !== undefined && val !== null && String(val) === String(v);
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
    server.log.push({ table, op: q.op, filters: q.filters.map((f) => [...f]), payload: q.payload === undefined ? undefined : structuredClone(q.payload) });
    const rows = server.rows[table] || (server.rows[table] = []);
    if (q.op === 'delete') {
      const hit = rows.filter(matches);
      server.rows[table] = rows.filter((r) => !hit.includes(r));
      return { data: q.cols ? hit.map(project) : null, error: null };
    }
    if (q.op === 'upsert') {
      const list = Array.isArray(q.payload) ? q.payload : [q.payload];
      const keys = q.onConflict.split(',').map((s) => s.trim());
      for (const p of list) {
        const i = rows.findIndex((r) => keys.every((k) => String(r[k]) === String(p[k])));
        const row = { ...(i >= 0 ? rows[i] : {}), ...structuredClone(p) };
        if (i >= 0) rows[i] = row; else rows.push(row);
      }
      return { data: null, error: null };
    }
    const found = rows.filter(matches).map(project);
    return { data: q.single ? (found[0] || null) : found, error: null };
  };
  const b = {
    delete() { q.op = 'delete'; return b; },
    upsert(p, o) { q.op = 'upsert'; q.payload = p; q.onConflict = (o && o.onConflict) || 'id'; return b; },
    eq(c, v) { q.filters.push(['eq', c, v]); return b; },
    in(c, v) { q.filters.push(['in', c, v]); return b; },
    match(m) { for (const [c, v] of Object.entries(m || {})) q.filters.push(['eq', c, v]); return b; },
    order() { return b; }, limit() { return b; },
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
  channel: () => ({ on() { return this; }, subscribe() { return this; } }),
  removeChannel() {},
};

// What this page is, and its store. A test sets these before it acts.
globalThis.__s = { client, mode: 'pos', state: {} };

const SUPABASE_STUB = `
export const supabase = globalThis.__s.client;
export const isMock = false;
export async function getLocationId() { return '${LOC}'; }
export function getDeviceMode() { return globalThis.__s.mode; }
export function readLocalDevice() { return { kind: 'till', id: 'dev-1', deviceSecret: 's', pairingCode: null, locationName: 'Beta' }; }
export function isBackOfficeMode() { return false; }
export function isHostStandMode() { return globalThis.__s.mode === 'bookings' || globalThis.__s.mode === 'waitlist'; }
export function getLastDeviceLinkOutcome() { return null; }
export async function sendDeviceHeartbeat() { return null; }
export async function linkDevice() { return { outcome: 'linked' }; }
`;
const STORE_STUB = `
const listeners = new Set();
export const useStore = {
  getState: () => globalThis.__s.state,
  setState(patch) {
    const prev = globalThis.__s.state;
    const p = typeof patch === 'function' ? patch(prev) : patch;
    globalThis.__s.state = { ...prev, ...p };
    for (const l of listeners) l(globalThis.__s.state, prev);
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

const SS = await import('./SessionSync.js');
const RC = await import('./SessionReconciler.js');
const { useStore } = await import(STORE_URL);

// ── Helpers ──────────────────────────────────────────────────────────────────────────────────
const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms));
const buffered = () => [...(idb.stores.get('queue') || new Map()).values()].sort((a, b) => a.id - b.id);
const touches = () => server.log.filter((l) => l.table === 'active_sessions');
const writes = () => touches().filter((l) => l.op !== 'select');
const upserts = () => touches().filter((l) => l.op === 'upsert');
const deletes = () => touches().filter((l) => l.op === 'delete');
const serverTable = (id) => server.rows.active_sessions.find((r) => r.table_id === id) || null;
const held = (id) => (globalThis.__s.state.tables || []).find((t) => t.id === id) || null;

const SEATED = Date.now() - 20 * 60_000;
function session(n = 1, over = {}) {
  return {
    id: `sess-${n}`, seatedAt: SEATED + n, covers: 2, server: 'Sam', _loc: LOC,
    items: [{ uid: `i${n}`, id: 'p1', name: 'Latte', price: 3.5, qty: 1, status: 'sent' }],
    subtotal: 3.5, ...over,
  };
}
const floor = (sessions = {}) => ['t1', 't2', 't3'].map((id) => ({
  id, label: id.toUpperCase(), status: sessions[id] ? 'occupied' : 'available', session: sessions[id] || null,
}));
const serverRow = (tableId, sess) => ({ location_id: LOC, table_id: tableId, session: sess, updated_at: new Date().toISOString() });

/** A fresh page of the given kind: an empty floor, an empty database, the sync module reset. */
function page({ mode = 'pos', type = 'pos', config = { defaultSurface: 'tables', profileName: 'Main counter' } } = {}) {
  SS.teardown();
  RC.stopSessionReconciler();
  idb.stores.get('queue')?.clear();
  for (const k of [...disk.keys()]) disk.delete(k);
  server.rows = { active_sessions: [] };
  globalThis.__s.mode = mode;
  globalThis.__s.state = {
    tables: floor(), deviceConfig: config, closedChecks: [], activeTableId: null, bootLocationId: LOC,
    discountRules: [], taxRates: [], locationConfig: { timezone: 'Europe/London' }, getTaxContext: () => null,
    _dataLocationId: null,
  };
  if (type) localStorage.setItem('rpos-device', JSON.stringify({ id: 'dev-1', type, locationId: LOC }));
  server.log = [];
}
/** Become another kind of page while the app stays open (a profile or pairing change). */
function become({ mode, type, config }) {
  if (mode !== undefined) globalThis.__s.mode = mode;
  if (type !== undefined) localStorage.setItem('rpos-device', JSON.stringify({ id: 'dev-1', type, locationId: LOC }));
  if (config !== undefined) useStore.setState({ deviceConfig: config });
}
async function flush() { await SS.flushSessions(); await tick(); }

const TILL = { mode: 'pos', type: 'pos', config: { defaultSurface: 'tables', profileName: 'Main counter' } };

// Every shape of kitchen screen in the field. The first is the only one the old mode word test
// stopped; the other three published tables until this change.
const KITCHEN_SCREENS = [
  ['the KDS app (kitchen mode)', { mode: 'kds', type: 'kds', config: { defaultSurface: 'kds', profileName: 'Kitchen Display' } }],
  ['a till mode page paired as a kitchen display', { mode: 'pos', type: 'kds', config: { defaultSurface: 'kds', profileName: 'Kitchen Display' } }],
  ['a till mode page on a kitchen profile', { mode: 'pos', type: 'pos', config: { defaultSurface: 'kds', profileName: 'Drinks screen' } }],
  ['the KDS app on a POS pairing with a kitchen profile', { mode: 'kds', type: 'pos', config: { defaultSurface: 'kds', profileName: 'Kitchen pass' } }],
];

// The steps every page below runs: it hears a table a till seated, then sees that table close.
// Returns what it sent for each half.
async function hearThenSeeClosed() {
  server.rows.active_sessions.push(serverRow('t1', session(1)));
  await SS.loadSessions();                       // the table arrives from the database, as on any device
  assert.equal(held('t1')?.status, 'occupied', 'the page holds the table it heard');
  server.log = [];
  await flush();
  const afterHearing = { upserts: upserts().length, deletes: deletes().length };

  // The till closes the table; this page lets go of its copy.
  server.rows.active_sessions = [];
  useStore.setState({ tables: floor() });
  server.log = [];
  mock.timers.enable({ apis: ['Date'], now: Date.now() });
  try {
    await flush();                               // first sight: the 3 second grace starts
    mock.timers.tick(4000);
    await flush();                               // past the grace
  } finally { mock.timers.reset(); }
  return { afterHearing, afterClose: { upserts: upserts().length, deletes: deletes().length } };
}

for (const [name, shape] of KITCHEN_SCREENS) {
  test(`kitchen screen, ${name}: publishes no table and deletes none`, async () => {
    page(shape);
    const sent = await hearThenSeeClosed();
    assert.deepEqual(sent.afterHearing, { upserts: 0, deletes: 0 }, 'a table it heard is not published again');
    assert.deepEqual(sent.afterClose, { upserts: 0, deletes: 0 }, 'a table it saw close is not deleted');
    assert.deepEqual(writes(), []);
    assert.deepEqual(buffered(), [], 'and nothing is buffered to send later');
    SS.teardown();
  });

  test(`kitchen screen, ${name}: a leaked table in its memory is never put back`, async () => {
    // Leeds: the screen booted holding a table the server no longer has.
    page(shape);
    useStore.setState({ tables: floor({ t1: session(1) }) });
    await flush();
    SS.reassertSession('t1');                    // what the realtime and reconciler paths call
    await flush();
    assert.deepEqual(writes(), [], 'no write to active_sessions');
    assert.equal(serverTable('t1'), null, 'the table stays closed on the server');
    assert.deepEqual(buffered(), []);
    SS.teardown();
  });

  test(`kitchen screen, ${name}: the reconciler does not read or heal`, async () => {
    page(shape);
    server.rows.active_sessions.push(serverRow('t2', session(2)));
    useStore.setState({ tables: floor({ t1: session(1) }) });   // held here, gone on the server
    await RC.startSessionReconciler();
    await tick();
    RC.stopSessionReconciler();
    assert.deepEqual(touches(), [], 'not one request about tables');
    assert.equal(held('t2')?.session, null, 'and its own floor is left as it was');
    SS.teardown();
  });
}

test('till: the same steps publish the table it heard and delete the one it closed (the test can fail)', async () => {
  page(TILL);
  const sent = await hearThenSeeClosed();
  assert.deepEqual(sent.afterHearing, { upserts: 1, deletes: 0 }, 'a till stamps the bill on a table it heard');
  assert.deepEqual(sent.afterClose, { upserts: 0, deletes: 1 }, 'and removes the row of a table it closed');
  SS.teardown();
});

test('till: a table seated here is published, and put back if its row goes missing', async () => {
  page(TILL);
  useStore.setState({ tables: floor({ t1: session(1) }) });
  await flush();
  assert.equal(upserts().length, 1);
  assert.equal(serverTable('t1')?.session?.id, 'sess-1', 'on the server');
  assert.equal(serverTable('t1')?.total_minor, 350, 'with its bill stamped');

  server.rows.active_sessions = [];              // the row is removed out of band
  server.log = [];
  await flush();
  assert.deepEqual(writes(), [], 'unchanged, so nothing is sent by a plain flush');
  SS.reassertSession('t1');
  await flush();
  assert.equal(upserts().length, 1, 'the put back');
  assert.ok(serverTable('t1'));
  SS.teardown();
});

test('till: the reconciler reads the tables, takes one seated elsewhere and heals its own', async () => {
  page(TILL);
  server.rows.active_sessions.push(serverRow('t2', session(2)));
  useStore.setState({ tables: floor({ t1: session(1) }) });
  await RC.startSessionReconciler();
  RC.stopSessionReconciler();
  assert.ok(touches().some((l) => l.op === 'select'), 'it reads');
  assert.equal(held('t2')?.session?.id, 'sess-2', 'the table seated on another till appears here');
  await flush();                                  // the heal asked for a flush
  assert.equal(serverTable('t1')?.session?.id, 'sess-1', 'its own missing table is back on the server');
  SS.teardown();
});

test('the put back fence is its own fence, and is read on every call', async () => {
  // As a till, publish t1. Both latches now say "sent".
  page(TILL);
  useStore.setState({ tables: floor({ t1: session(1) }) });
  await flush();
  assert.equal(upserts().length, 1);

  // The profile changes to a kitchen screen while the page is open. A put back is asked for.
  become({ config: { defaultSurface: 'kds', profileName: 'Kitchen Display' } });
  server.log = [];
  SS.reassertSession('t1');
  await flush();
  assert.deepEqual(writes(), [], 'a kitchen screen: nothing');

  // Back to a till. Had the put back been taken while it was a kitchen screen, it would go now.
  become({ config: TILL.config });
  await flush();
  assert.deepEqual(writes(), [], 'the request made on the kitchen screen was dropped, not kept');

  // And the till works again at once: a real change is published.
  useStore.setState({ tables: floor({ t1: session(1, { covers: 4 }) }) });
  await flush();
  assert.equal(upserts().length, 1);
  assert.equal(serverTable('t1')?.session?.covers, 4);
  SS.teardown();
});

test('the reconciler asks on every pass: a kitchen screen that becomes a till reconciles', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  page({ mode: 'pos', type: 'pos', config: { defaultSurface: 'kds', profileName: 'Drinks screen' } });
  server.rows.active_sessions.push(serverRow('t2', session(2)));
  await RC.startSessionReconciler();
  assert.deepEqual(touches(), [], 'kitchen screen: stands still');

  become({ config: TILL.config });                // Back Office moves it to a till profile
  t.mock.timers.tick(13_000);                     // the next pass (10 seconds, give or take 2)
  await tick(); await tick();
  assert.ok(touches().some((l) => l.op === 'select'), 'till: reads again');
  assert.equal(held('t2')?.session?.id, 'sess-2');
  RC.stopSessionReconciler();
  SS.teardown();
});

// ── Not fenced, on purpose ───────────────────────────────────────────────────────────────────

const NOT_FENCED = [
  // The kitchen app paired with a till's code on a till profile shows the PIN pad and the till.
  // The old mode word test stopped it: tables opened on it never reached the other tills.
  ['a till inside the KDS app', { mode: 'kds', type: 'pos', config: { defaultSurface: 'tables', profileName: 'Main counter' } }],
  ['a counter till that only opens on its kitchen view', { mode: 'pos', type: 'pos', config: { defaultSurface: 'kds', profileName: 'Main counter' } }],
  // The Bookings host stand seats tables (walk ins and bookings) and publishes them here.
  ['the Bookings host stand', { mode: 'bookings', type: null, config: null }],
  ['the Bookings host stand in a browser that also holds a kitchen pairing', { mode: 'bookings', type: 'kds', config: { defaultSurface: 'kds', profileName: 'Kitchen Display' } }],
  // A profile that opens on the kiosk: not a kitchen screen, left as it was.
  ['a kiosk profile in the till shell', { mode: 'pos', type: 'pos', config: { defaultSurface: 'kiosk', profileName: 'Kiosk' } }],
  ['the handset page', { mode: 'mpos', type: 'pos', config: { defaultSurface: 'mpos', profileName: 'Handset' } }],
];

for (const [name, shape] of NOT_FENCED) {
  test(`not fenced: ${name} publishes a table seated on it`, async () => {
    page(shape);
    useStore.setState({ tables: floor({ t3: session(3) }) });
    await flush();
    assert.equal(upserts().length, 1, name);
    assert.equal(serverTable('t3')?.session?.id, 'sess-3', name);
    SS.teardown();
  });
}
