/**
 * standSessionSync.test.js — a host stand takes what is open from the server (16 Oct 2026).
 *
 * The till cashed off T1 and the bookings stand kept its copy, so "Seat now" refused with
 * "Still has an open tab" while the till showed nothing open. Later the stand seated T1, the
 * server row appeared, and the stand still drew the table as "no session". The merge below is
 * what the 30 second stand reconcile, the seat check and the post seat refresh all run.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  mergeServerSessions, readServerSessions, reconcileStandSessions, startStandSessionSync,
  decideOnDelete, withinWriteGrace, STAND_SESSION_SYNC_MS, WRITE_GRACE_MS,
} from './standSessionSync.js';

const NOW = Date.now();           // the reconcile reads the real clock, so the fixtures sit on it too
const OLD = NOW - 60 * 60 * 1000;   // seated an hour ago, far outside the write grace
const sess = (id, extra = {}) => ({ id, items: [], seatedAt: OLD, ...extra });
const floor = (sessions = {}) => ['t1', 't2', 't3'].map((id) => ({
  id, label: id.toUpperCase(), session: sessions[id] || null, status: sessions[id] ? 'occupied' : 'available',
}));

test('a table the server no longer holds is cleared, host stand included (the T1 fault)', () => {
  const local = floor({ t1: sess('ORD-1', { items: [{ name: 'Pint', qty: 2, price: 5 }] }) });
  const next = mergeServerSessions(local, [], { now: NOW });
  assert.notEqual(next, local);
  assert.equal(next[0].session, null);
  assert.equal(next[0].status, 'available');
  // items on the local copy are no reason to keep it: that was the old Guard 2 heuristic
});

test('a server row the stand lacks is taken, and the floor colour follows (seated, nothing ordered)', () => {
  const srv = sess('ORD-9', { seatedAt: NOW - 5000, booking: { bookingId: 'bk-1' }, customer: { name: 'Jane' } });
  const next = mergeServerSessions(floor(), [{ table_id: 't1', session: srv }], { now: NOW });
  assert.deepEqual(next[0].session, srv);
  assert.equal(next[0].status, 'occupied');
  assert.equal(next[1].session, null);
});

test('nothing changed returns the same array, so the store is not written', () => {
  const s1 = sess('ORD-1');
  const local = floor({ t1: s1 });
  const next = mergeServerSessions(local, [{ table_id: 't1', session: { ...s1 } }], { now: NOW });
  assert.equal(next, local);
});

test('a server copy that differs replaces the local one (voids, new lines from the till)', () => {
  const local = floor({ t1: sess('ORD-1', { items: [{ name: 'Pint', qty: 1 }] }) });
  const srv = sess('ORD-1', { items: [{ name: 'Pint', qty: 1 }, { name: 'Chips', qty: 1 }] });
  const next = mergeServerSessions(local, [{ table_id: 't1', session: srv }], { now: NOW });
  assert.equal(next[0].session.items.length, 2);
});

test('a seat made moments ago with no server row yet is kept (the write is in flight)', () => {
  const local = floor({ t1: sess('ORD-1', { seatedAt: NOW - 2000 }) });
  assert.equal(mergeServerSessions(local, [], { now: NOW }), local);
  // and once the grace has passed it goes
  const later = mergeServerSessions(local, [], { now: NOW + WRITE_GRACE_MS + 1 });
  assert.equal(later[0].session, null);
});

test('tableIds limits the merge to the booking tables; keepIds protects a till active table', () => {
  const local = floor({ t1: sess('ORD-1'), t2: sess('ORD-2'), t3: sess('ORD-3') });
  const next = mergeServerSessions(local, [], { tableIds: ['t1', 't2'], keepIds: new Set(['t2']), now: NOW });
  assert.equal(next[0].session, null);          // t1: asked for, no row, cleared
  assert.equal(next[1].session.id, 'ORD-2');    // t2: kept, the till is editing it
  assert.equal(next[2].session.id, 'ORD-3');    // t3: not asked for
});

test('clearMissing false never nulls a table (the refresh right after a seat)', () => {
  const local = floor({ t1: sess('ORD-1') });
  assert.equal(mergeServerSessions(local, [], { clearMissing: false, now: NOW }), local);
  const srv = sess('ORD-1', { covers: 4 });
  const next = mergeServerSessions(local, [{ table_id: 't1', session: srv }], { clearMissing: false, now: NOW });
  assert.equal(next[0].session.covers, 4);
});

test('a cashed off ghost row (isClosed) counts as no row', () => {
  const local = floor({ t1: sess('ORD-1') });
  const next = mergeServerSessions(local, [{ table_id: 't1', session: sess('ORD-1') }], {
    isClosed: (tid, s) => tid === 't1' && s.id === 'ORD-1', now: NOW,
  });
  assert.equal(next[0].session, null);
});

test('withinWriteGrace: a seat inside 20 seconds, never a session with no seatedAt', () => {
  assert.equal(WRITE_GRACE_MS, 20_000);
  assert.equal(withinWriteGrace({ seatedAt: NOW - 1000 }, NOW), true);
  assert.equal(withinWriteGrace({ seatedAt: NOW - WRITE_GRACE_MS }, NOW), false);
  assert.equal(withinWriteGrace({ seatedAt: 0 }, NOW), false);
  assert.equal(withinWriteGrace({}, NOW), false);
  assert.equal(withinWriteGrace(null, NOW), false);
});

// ── decideOnDelete: what a device does with its copy when an active_sessions DELETE arrives ──
const FRESH = () => sess('ORD-5', { seatedAt: NOW - 300 });     // re seated 300 ms ago, flush pending
const row = (s) => ({ table_id: 't1', session: s });

test('delete, till, the table it is editing: kept, re published when the server has no row', () => {
  const local = sess('ORD-1', { items: [{ name: 'Pint', qty: 1 }] });
  // decided before any read (serverRow null): re publish
  assert.equal(decideOnDelete({ localSession: local, serverRow: null, isActive: true, hostStand: false, now: NOW }), 'reassert');
  // after a read that found the row: keep
  assert.equal(decideOnDelete({ localSession: local, serverRow: row(local), isActive: true, hostStand: false, now: NOW }), 'keep');
  // nothing on it locally: nothing to re publish, nothing cleared
  assert.equal(decideOnDelete({ localSession: null, serverRow: null, isActive: true, hostStand: false, now: NOW }), 'keep');
  // an old session is still never cleared while it is being edited
  assert.equal(decideOnDelete({ localSession: sess('ORD-1'), serverRow: null, isActive: true, hostStand: false, now: NOW + 10 * WRITE_GRACE_MS }), 'reassert');
});

test('delete, till, another table with a server row: kept, re published when ours is newer by seatedAt', () => {
  const older = sess('ORD-1', { seatedAt: OLD });
  const newer = sess('ORD-2', { seatedAt: OLD + 5000 });
  assert.equal(decideOnDelete({ localSession: older, serverRow: row(older), isActive: false, hostStand: false, now: NOW }), 'keep');
  assert.equal(decideOnDelete({ localSession: older, serverRow: row(newer), isActive: false, hostStand: false, now: NOW }), 'keep');
  assert.equal(decideOnDelete({ localSession: newer, serverRow: row(older), isActive: false, hostStand: false, now: NOW }), 'reassert');
  // an explicit answer wins over the seatedAt comparison
  assert.equal(decideOnDelete({ localSession: older, serverRow: row(older), isActive: false, hostStand: false, now: NOW, localNewerThanServer: true }), 'reassert');
});

test('delete, till, another table, no server row, inside the write grace: re published (the 600 ms flush window)', () => {
  assert.equal(decideOnDelete({ localSession: FRESH(), serverRow: null, isActive: false, hostStand: false, now: NOW }), 'reassert');
  assert.equal(decideOnDelete({ localSession: sess('ORD-5', { seatedAt: NOW - WRITE_GRACE_MS + 1 }), serverRow: null, isActive: false, hostStand: false, now: NOW }), 'reassert');
});

test('delete, till, another table, no server row, past the write grace: cleared', () => {
  assert.equal(decideOnDelete({ localSession: sess('ORD-1'), serverRow: null, isActive: false, hostStand: false, now: NOW }), 'clear');
  assert.equal(decideOnDelete({ localSession: sess('ORD-1', { seatedAt: NOW - WRITE_GRACE_MS }), serverRow: null, isActive: false, hostStand: false, now: NOW }), 'clear');
  // no seatedAt is never inside the grace
  assert.equal(decideOnDelete({ localSession: { id: 'ORD-1', items: [{ name: 'Pint' }] }, serverRow: null, isActive: false, hostStand: false, now: NOW }), 'clear');
  // no local copy at all: cleared (the colour follows)
  assert.equal(decideOnDelete({ localSession: null, serverRow: null, isActive: false, hostStand: false, now: NOW }), 'clear');
});

test('delete, host stand: a row keeps, no row clears, never re published, active or not', () => {
  const older = sess('ORD-1', { seatedAt: OLD });
  const newer = sess('ORD-2', { seatedAt: OLD + 5000 });
  for (const isActive of [false, true]) {
    assert.equal(decideOnDelete({ localSession: older, serverRow: row(older), isActive, hostStand: true, now: NOW }), 'keep');
    assert.equal(decideOnDelete({ localSession: newer, serverRow: row(older), isActive, hostStand: true, now: NOW }), 'keep');
    assert.equal(decideOnDelete({ localSession: older, serverRow: null, isActive, hostStand: true, now: NOW }), 'clear');
    assert.equal(decideOnDelete({ localSession: null, serverRow: null, isActive, hostStand: true, now: NOW }), 'clear');
  }
});

test('delete, host stand, a seat it made inside the write grace: kept, the same rule as the 30 second merge', () => {
  const local = floor({ t1: FRESH() });
  assert.equal(decideOnDelete({ localSession: FRESH(), serverRow: null, isActive: false, hostStand: true, now: NOW }), 'keep');
  assert.equal(mergeServerSessions(local, [], { now: NOW }), local, 'the merge keeps it too');
  const later = NOW + WRITE_GRACE_MS;
  assert.equal(decideOnDelete({ localSession: FRESH(), serverRow: null, isActive: false, hostStand: true, now: later }), 'clear');
  assert.equal(mergeServerSessions(local, [], { now: later })[0].session, null, 'and both let it go together');
});

test('delete, a failed read changes nothing on any device', () => {
  for (const hostStand of [false, true]) {
    for (const isActive of [false, true]) {
      assert.equal(decideOnDelete({ localSession: sess('ORD-1'), serverRow: null, readFailed: true, isActive, hostStand, now: NOW }), 'keep');
    }
  }
});

// A PostgREST shaped client: from().select().eq().in() is thenable.
function fakeClient(rows, { error = null, calls = [] } = {}) {
  return {
    calls,
    from(table) {
      const st = { table, filters: [] };
      const b = {
        select(cols) { st.cols = cols; return b; },
        eq(c, v) { st.filters.push(['eq', c, v]); return b; },
        in(c, vs) { st.filters.push(['in', c, vs]); return b; },
        then(res, rej) { calls.push(st); return Promise.resolve(error ? { data: null, error } : { data: rows, error: null }).then(res, rej); },
      };
      return b;
    },
  };
}

test('readServerSessions asks for the venue, the tables when given, and answers null on a failed read', async () => {
  const calls = [];
  const rows = [{ table_id: 't1', session: sess('ORD-1') }];
  assert.deepEqual(await readServerSessions(fakeClient(rows, { calls }), 'loc-1', ['t1', 't2']), rows);
  assert.equal(calls[0].table, 'active_sessions');
  assert.equal(calls[0].cols, 'table_id, session');
  assert.deepEqual(calls[0].filters, [['eq', 'location_id', 'loc-1'], ['in', 'table_id', ['t1', 't2']]]);
  assert.deepEqual(await readServerSessions(fakeClient(rows, { calls }), 'loc-1'), rows);
  assert.deepEqual(calls[1].filters, [['eq', 'location_id', 'loc-1']]);
  assert.equal(await readServerSessions(fakeClient(null, { error: { message: 'down' } }), 'loc-1'), null);
  assert.equal(await readServerSessions(null, 'loc-1'), null);
  assert.equal(await readServerSessions(fakeClient(rows), null), null);
});

function fakeStore(tables) {
  let state = { tables };
  return {
    getState: () => state,
    setState: (patch) => { state = { ...state, ...patch }; },
  };
}
function fakeStorage(seed = {}) {
  const m = new Map(Object.entries(seed));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v), _map: m };
}

test('reconcileStandSessions replaces the floor from the server and drops the local copies of cleared tables', async () => {
  const stale = sess('ORD-1', { items: [{ name: 'Pint', qty: 1 }] });
  const store = fakeStore(floor({ t1: stale }));
  const storage = fakeStorage({
    'rpos-session-backup': JSON.stringify({ t1: stale, t2: sess('ORD-2') }),
    'rpos-session-snapshot': JSON.stringify({ v: '4.5.2', ts: 1, sessions: { t1: stale } }),
  });
  const srv = sess('ORD-7');
  const ok = await reconcileStandSessions({ store, client: fakeClient([{ table_id: 't3', session: srv }]), locationId: 'loc-1', storage });
  assert.equal(ok, true);
  const t = store.getState().tables;
  assert.equal(t[0].session, null);
  assert.deepEqual(t[2].session, srv);
  assert.deepEqual(JSON.parse(storage.getItem('rpos-session-backup')), { t2: sess('ORD-2') });
  assert.deepEqual(JSON.parse(storage.getItem('rpos-session-snapshot')).sessions, {});
});

test('a failed read changes nothing', async () => {
  const local = floor({ t1: sess('ORD-1') });
  const store = fakeStore(local);
  const ok = await reconcileStandSessions({ store, client: fakeClient(null, { error: { message: 'down' } }), locationId: 'loc-1' });
  assert.equal(ok, false);
  assert.equal(store.getState().tables, local);
});

test('startStandSessionSync runs at once, every 30 seconds, and stops', async () => {
  assert.equal(STAND_SESSION_SYNC_MS, 30_000);
  const calls = [];
  const store = fakeStore(floor({ t1: sess('ORD-1') }));
  const stop = startStandSessionSync({ store, client: fakeClient([], { calls }), locationId: 'loc-1', intervalMs: 5 });
  await new Promise((r) => setTimeout(r, 30));
  stop();
  const n = calls.length;
  assert.ok(n >= 2, `expected at least two reads, got ${n}`);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls.length, n);
  assert.equal(store.getState().tables[0].session, null);
});
