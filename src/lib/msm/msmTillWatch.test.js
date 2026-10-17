// Multi site menu: the till side of a scheduled menu push (msmTillWatch.js). A counter till takes
// a head office push by itself, never mid sale; an ordinary Push to POS keeps its banner; a till
// that missed a push while offline catches up.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  createMsmTillWatch, counterTillState, setTillUiState, resetTillUiState, needsCatchUp, startMsmCatchUp,
  readSeen, markSeen, kioskMayRefresh, isUnattendedDevice, IDLE_CHECK_MS,
} from './msmTillWatch.js';
import { APPLIED_WORDS } from './msmTill.js';

const MSM = (v = 1) => ({ version: v, pushSource: { kind: 'msm', applyWhenIdle: true } });
const ORDINARY = { version: 9, pushedBy: 'Manager' };

function fakeTimers() {
  const live = new Map();
  let n = 0;
  return {
    setInterval: (fn, ms) => { live.set(++n, { fn, ms }); return n; },
    clearInterval: (id) => { live.delete(id); },
    tick: () => { for (const { fn } of [...live.values()]) fn(); },
    count: () => live.size,
  };
}
function fakeStore(over = {}) {
  const state = {
    configUpdateAvailable: false, configUpdateSnapshot: null, walkInOrder: null, activeTableId: null, tables: [], pendingItem: null,
    applied: 0, toasts: [],
    setConfigUpdate(snap) { state.configUpdateAvailable = true; state.configUpdateSnapshot = snap; },
    applyConfigUpdate() { state.applied++; state.configUpdateAvailable = false; state.configUpdateSnapshot = null; },
    showToast(msg) { state.toasts.push(msg); },
    ...over,
  };
  return { getState: () => state, state };
}
function memStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}

beforeEach(() => resetTillUiState());

test('an idle counter till applies a head office push at once and says so', () => {
  const store = fakeStore();
  const timers = fakeTimers();
  const w = createMsmTillWatch({ store, timers });
  const snap = MSM();
  store.state.setConfigUpdate(snap);
  assert.equal(w.take(snap), 'applied');
  assert.equal(store.state.applied, 1);
  assert.deepEqual(store.state.toasts, [APPLIED_WORDS]);
  assert.equal(timers.count(), 0);
});

test('never mid sale: it waits while the order has lines, then applies within a check once the sale ends', () => {
  const store = fakeStore({ walkInOrder: { items: [{ id: 'l1' }] } });
  const timers = fakeTimers();
  const w = createMsmTillWatch({ store, timers });
  const snap = MSM();
  store.state.setConfigUpdate(snap);
  assert.equal(w.take(snap), 'waiting');
  assert.equal(store.state.applied, 0);
  timers.tick();
  assert.equal(store.state.applied, 0, 'still mid sale');
  store.state.walkInOrder = null;
  timers.tick();
  assert.equal(store.state.applied, 1);
  assert.equal(timers.count(), 0, 'the watcher stops once applied');
});

test('the payment screen, an open check with lines, or any modal holds it back', () => {
  const store = fakeStore();
  const timers = fakeTimers();
  const w = createMsmTillWatch({ store, timers });
  const snap = MSM();
  store.state.setConfigUpdate(snap);
  setTillUiState({ paymentInProgress: true });
  assert.equal(w.take(snap), 'waiting');
  setTillUiState({ paymentInProgress: false, modalOpen: true });
  timers.tick();
  assert.equal(store.state.applied, 0);
  setTillUiState({ modalOpen: false });
  store.state.activeTableId = 't1';
  store.state.tables = [{ id: 't1', session: { items: [{ id: 'a' }] } }];
  timers.tick();
  assert.equal(store.state.applied, 0, 'a table with lines is open');
  store.state.tables = [{ id: 't1', session: { items: [] } }];
  timers.tick();
  assert.equal(store.state.applied, 1);
});

test('an ordinary Push to POS keeps today\'s banner, and so does a head office push sent with the switch off', () => {
  const store = fakeStore();
  const w = createMsmTillWatch({ store, timers: fakeTimers() });
  store.state.setConfigUpdate(ORDINARY);
  assert.equal(w.take(ORDINARY), 'banner');
  const off = { version: 2, pushSource: { kind: 'msm', applyWhenIdle: false } };
  store.state.setConfigUpdate(off);
  assert.equal(w.take(off), 'banner');
  assert.equal(store.state.applied, 0);
});

test('a newer ordinary push replaces a waiting head office one: the watcher stops and the banner stays', () => {
  const store = fakeStore({ walkInOrder: { items: [{}] } });
  const timers = fakeTimers();
  const w = createMsmTillWatch({ store, timers });
  const snap = MSM();
  store.state.setConfigUpdate(snap);
  w.take(snap);
  store.state.setConfigUpdate(ORDINARY);
  store.state.walkInOrder = null;
  timers.tick();
  assert.equal(store.state.applied, 0);
  assert.equal(timers.count(), 0);
});

test('unattended devices apply elsewhere; the watcher leaves them alone', () => {
  const store = fakeStore();
  const w = createMsmTillWatch({ store, timers: fakeTimers() });
  assert.equal(w.take(MSM(), { unattended: true }), 'banner');
  const st = memStorage();
  st.setItem('rpos-device-config', JSON.stringify({ defaultSurface: 'kds' }));
  assert.equal(isUnattendedDevice(st), true);
  assert.equal(isUnattendedDevice(memStorage()), false);
});

test('counterTillState reads the POS screen lines and any open dialog on the page', () => {
  setTillUiState({ orderLines: 2 });
  assert.equal(counterTillState({}).lines, 2);
  resetTillUiState();
  const doc = { querySelector: () => ({}) };
  assert.equal(counterTillState({}, doc).modalOpen, true);
});

test('catch up: only a head office push this till has not taken, never one it already applied or holds', () => {
  const latest = { id: 'p2', created_at: '2026-10-17T06:00:00Z', kind: 'msm', version: '200' };
  assert.equal(needsCatchUp(latest, null, '100', null), true);
  assert.equal(needsCatchUp(latest, { id: 'p2' }, '100', null), false, 'already seen');
  assert.equal(needsCatchUp(latest, null, '200', null), false, 'already applied at boot');
  assert.equal(needsCatchUp(latest, null, '100', 200), false, 'already waiting in the store');
  assert.equal(needsCatchUp({ ...latest, kind: null }, null, '100', null), false, 'an ordinary push is never caught up');
});

test('catch up reads the newest push, fetches a missed head office one by id and delivers it once', async () => {
  const storage = memStorage();
  const timers = fakeTimers();
  const delivered = [];
  const reads = [];
  const stop = startMsmCatchUp({
    locationId: 'L1', storage, sessionStore: memStorage(), store: fakeStore(), timers,
    readLatest: async () => ({ id: 'p9', created_at: '2026-10-17T06:00:00Z', kind: 'msm', version: '900' }),
    readSnapshot: async (id) => { reads.push(id); return MSM(900); },
    deliver: (s) => delivered.push(s),
  });
  timers.tick();
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(reads, ['p9']);
  assert.equal(delivered.length, 1);
  assert.equal(readSeen(storage, 'L1').id, 'p9');
  timers.tick();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(delivered.length, 1, 'never twice');
  stop();
  assert.equal(timers.count(), 0);
});

test('a failed read changes nothing', async () => {
  const storage = memStorage();
  markSeen(storage, 'L1', { id: 'p1' });
  const timers = fakeTimers();
  let delivered = 0;
  startMsmCatchUp({
    locationId: 'L1', storage, sessionStore: memStorage(), store: fakeStore(), timers,
    readLatest: async () => { throw new Error('offline'); }, readSnapshot: async () => null, deliver: () => { delivered++; },
  });
  timers.tick();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(delivered, 0);
  assert.equal(readSeen(storage, 'L1').id, 'p1');
});

test('the kiosk reads its menu again only on the start screen with an empty basket', () => {
  assert.equal(kioskMayRefresh({ pending: true, screen: 'attract', cartCount: 0 }), true);
  assert.equal(kioskMayRefresh({ pending: true, screen: 'menu', cartCount: 0 }), false);
  assert.equal(kioskMayRefresh({ pending: true, screen: 'attract', cartCount: 1 }), false);
  assert.equal(kioskMayRefresh({ pending: false, screen: 'attract', cartCount: 0 }), false);
});

test('the idle check runs every 5 seconds', () => {
  assert.equal(IDLE_CHECK_MS, 5000);
});
