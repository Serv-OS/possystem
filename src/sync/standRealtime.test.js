// standRealtime.test.js: the REAL lib/realtime.js sessions channel on a host stand and on a till
// (16 Oct 2026, Provo demo, T1).
//
// A host stand (Table Bookings, Tables Ready) edits no check. Its clock ran ahead, so every copy
// it held looked newer than the till's row by seatedAt, and the UPDATE handler kept the stand's
// copy and re published it over the till's. A stand now takes the server row on INSERT and
// UPDATE and never re publishes; a till keeps both guards exactly as before.
//
// lib/supabase.js and the store are replaced by stubs (every export name kept, so the rest of the
// import graph links); a fake client records each channel's handlers so the test can fire them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';

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

const LOC = 'L1';
const handlers = [];   // { channel, event, table, fn }
const reads = [];
const serverRows = new Map();   // table_id -> session
const client = {
  from(table) {
    const q = { table, filters: [] };
    const b = {
      select() { return b; }, eq(c, v) { q.filters.push([c, v]); return b; }, in() { return b; },
      order() { return b; }, limit() { return b; }, gte() { return b; }, lte() { return b; },
      maybeSingle() { q.single = true; return b; }, single() { q.single = true; return b; },
      upsert(p) { q.upsert = p; return b; }, update() { return b; }, insert() { return b; }, delete() { return b; },
      then(res, rej) {
        reads.push(q);
        let data = [];
        if (table === 'active_sessions') {
          const tid = q.filters.find(([c]) => c === 'table_id')?.[1];
          const s = tid ? serverRows.get(tid) : null;
          data = q.single ? (s ? { table_id: tid, session: s } : null) : [];
        } else if (q.single) data = null;
        return Promise.resolve({ data, error: null }).then(res, rej);
      },
    };
    return b;
  },
  rpc: () => Promise.resolve({ data: null, error: null }),
  channel(name) {
    const ch = {
      on(kind, filter, fn) { handlers.push({ channel: name, event: filter?.event, table: filter?.table, fn }); return ch; },
      subscribe() { return ch; },
      unsubscribe() {},
    };
    return ch;
  },
  removeChannel() {},
  auth: { getSession: () => Promise.resolve({ data: { session: null } }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }) },
};
globalThis.__rt = { client, mode: 'bookings', state: {} };

const exportsOf = (rel) => {
  const src = readFileSync(new URL(rel, import.meta.url), 'utf8');
  const names = new Set();
  for (const m of src.matchAll(/^export (?:async )?(?:function|const|let|class) ([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  for (const m of src.matchAll(/^export \{([^}]*)\}/gm)) for (const n of m[1].split(',')) { const k = n.trim().split(/\s+as\s+/).pop(); if (k) names.add(k); }
  return names;
};
const stubFor = (names, own) => {
  const lines = [own];
  for (const n of names) if (!new RegExp(`export (?:async )?(?:function|const|let) ${n}\\b`).test(own)) lines.push(`export const ${n} = () => null;`);
  return lines.join('\n');
};
const SUPABASE_STUB = stubFor(exportsOf('../lib/supabase.js'), `
export const supabase = globalThis.__rt.client;
export const isMock = false;
export const LOCATION_ID = '${LOC}';
export const platformSupabase = globalThis.__rt.client;
export const kitchenClient = globalThis.__rt.client;
export const staffSupabase = globalThis.__rt.client;
export async function getLocationId() { return '${LOC}'; }
export function getDeviceMode() { return globalThis.__rt.mode; }
export function isBackOfficeMode() { return false; }
export function isHostStandMode() { return globalThis.__rt.mode === 'bookings' || globalThis.__rt.mode === 'waitlist'; }
export function readLocalDevice() { return null; }
export function getActiveLocationSync() { return '${LOC}'; }
export function getResolvedLocationIdSync() { return '${LOC}'; }
`);
const STORE_STUB = stubFor(exportsOf('../store/index.js'), `
const listeners = new Set();
export const useStore = {
  getState: () => globalThis.__rt.state,
  setState(patch) {
    const prev = globalThis.__rt.state;
    const p = typeof patch === 'function' ? patch(prev) : patch;
    globalThis.__rt.state = { ...prev, ...p };
    for (const l of listeners) l(globalThis.__rt.state, prev);
  },
  subscribe(l) { listeners.add(l); return () => listeners.delete(l); },
};
export const capClosedChecks = (list) => list;
export const isMenuRowPending = () => false;
`);

registerHooks({
  resolve(specifier, context, nextResolve) {
    if ((specifier.startsWith('./') || specifier.startsWith('../')) && !/\.[a-z]+(\?.*)?$/i.test(specifier)) {
      try { return nextResolve(`${specifier}.js`, context); } catch { return nextResolve(`${specifier}/index.js`, context); }
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.endsWith('/src/store/index.js')) return { format: 'module', source: STORE_STUB, shortCircuit: true };
    if (url.endsWith('/src/lib/supabase.js')) return { format: 'module', source: SUPABASE_STUB, shortCircuit: true };
    return nextLoad(url, context);
  },
});

const RT = await import('../lib/realtime.js');
const SS = await import('./SessionSync.js');
const { useStore } = await import('../store/index.js');

const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms));
const sessionHandler = (event) => handlers.find((h) => h.table === 'active_sessions' && h.event === event && h.channel.startsWith('sessions:'))?.fn;
const held = (id) => (useStore.getState().tables || []).find((t) => t.id === id) || null;

function start(mode) {
  RT.stopRealtime?.();
  SS.teardown();
  handlers.length = 0;
  reads.length = 0;
  serverRows.clear();
  globalThis.__rt.mode = mode;
  globalThis.__rt.state = {
    tables: ['t1', 't2'].map((id) => ({ id, label: id.toUpperCase(), session: null, status: 'available' })),
    activeTableId: null, closedChecks: [], deviceConfig: { defaultSurface: 'tables', profileName: 'Main counter' },
    bootLocationId: LOC, discountRules: [], taxRates: [], locationConfig: { timezone: 'Europe/London' }, getTaxContext: () => null,
  };
  RT.startRealtime(useStore, LOC);
  assert.ok(sessionHandler('UPDATE'), 'the sessions channel is subscribed');
}

const NOW = Date.now();
// The stand's clock runs 5 minutes ahead: its seat stamped seatedAt in the future.
const standSeat = { id: 'sess-1', seatedAt: NOW + 5 * 60_000, covers: 2, items: [] };
// The till rang lines in on the same check a minute later (by the real clock).
const tillRow = (over = {}) => ({
  location_id: LOC, table_id: 't1', updated_at: new Date(NOW + 60_000).toISOString(),
  session: { id: 'sess-1', seatedAt: NOW, covers: 2, lastUpdated: NOW + 60_000, items: [{ uid: 'i1', name: 'Latte', qty: 2, price: 3.5 }], ...over },
});

test('host stand, clock ahead: a till UPDATE replaces the stand copy, nothing is re published', async () => {
  start('bookings');
  useStore.setState({ tables: useStore.getState().tables.map((t) => (t.id === 't1' ? { ...t, session: standSeat, status: 'occupied' } : t)) });
  sessionHandler('UPDATE')({ new: tillRow() });
  await tick();
  assert.equal(held('t1').session.items.length, 1, 'the till lines are on the stand');
  assert.equal(held('t1').session.seatedAt, NOW, 'the server row, not the stand copy');
  assert.equal(held('t1').status, 'occupied');
  await tick(700);   // past the 600 ms flush debounce: a reassert would have written by now
  assert.equal(reads.filter((q) => q.upsert).length, 0, 'no write from the stand');
});

test('host stand, clock ahead: a till INSERT replaces the stand copy too', async () => {
  start('waitlist');
  useStore.setState({ tables: useStore.getState().tables.map((t) => (t.id === 't1' ? { ...t, session: standSeat, status: 'occupied' } : t)), activeTableId: 't1' });
  sessionHandler('INSERT')({ new: tillRow() });
  await tick();
  assert.equal(held('t1').session.seatedAt, NOW, 'taken even with a newer looking copy and the table active');
});

test('till: the same UPDATE over a newer local copy is kept and re published, as before', async () => {
  start('pos');
  const tillCopy = { id: 'sess-1', seatedAt: NOW, covers: 2, lastUpdated: NOW + 120_000, items: [{ uid: 'i1', name: 'Latte', qty: 3, price: 3.5 }] };
  useStore.setState({ tables: useStore.getState().tables.map((t) => (t.id === 't1' ? { ...t, session: tillCopy, status: 'occupied' } : t)) });
  sessionHandler('UPDATE')({ new: tillRow() });
  await tick(700);
  assert.equal(held('t1').session.items[0].qty, 3, 'the till keeps its newer lines');
  assert.ok(reads.some((q) => q.table === 'active_sessions' && q.upsert), 're published (main behaviour)');
});

test('host stand DELETE: no server row clears the copy; a row keeps it; a till keeps an item copy as before', async () => {
  const old = { id: 'sess-9', seatedAt: NOW - 60 * 60_000, items: [{ uid: 'i9', name: 'Pint', qty: 1 }] };
  start('bookings');
  useStore.setState({ tables: useStore.getState().tables.map((t) => ({ ...t, session: { ...old }, status: 'occupied' })) });
  serverRows.set('t2', old);
  sessionHandler('DELETE')({ old: { location_id: LOC, table_id: 't1' } });
  sessionHandler('DELETE')({ old: { location_id: LOC, table_id: 't2' } });
  await tick();
  assert.equal(held('t1').session, null, 'the T1 fault: cashed off on the till, cleared on the stand');
  assert.equal(held('t2').session?.id, 'sess-9', 'a row on the server keeps the copy');

  start('pos');
  useStore.setState({ tables: useStore.getState().tables.map((t) => ({ ...t, session: { ...old }, status: 'occupied' })) });
  sessionHandler('DELETE')({ old: { location_id: LOC, table_id: 't1' } });
  await tick();
  assert.equal(held('t1').session?.id, 'sess-9', 'a till: main Guard 2 keeps a copy with items');
  assert.equal(reads.filter((q) => q.table === 'active_sessions' && !q.upsert).length, 0, 'and reads nothing');
  await tick(700);   // let the till's put back flush before the file ends
  RT.stopRealtime?.();
  SS.teardown();
});
