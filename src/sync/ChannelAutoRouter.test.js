// src/sync/ChannelAutoRouter.test.js
//
// The gate in front of the channel auto route (sync/ChannelAutoRouter.js).
//
// 12 Oct 2026, Coffee Boy Preston. realtime.js used to send every new QR, kiosk, online and
// delivery app order to the kitchen from any page whose storage said "master", menu or no menu,
// and looked for orders it had missed once only, at boot. Now a closed gate claims nothing and
// drops nothing: the order stays unrouted in order_queue and ONE catch up read routes it when the
// gate opens. These tests drive the runner with a fake store, a fake gate and a fake read.

import test from 'node:test';
import assert from 'node:assert/strict';

import { startChannelAutoRouter, stopChannelAutoRouter, offerLiveOrder, requestCatchUp } from './ChannelAutoRouter.js';

const tick = () => new Promise((r) => setTimeout(r, 5));
const settle = async (n = 4) => { for (let i = 0; i < n; i++) await tick(); };

/** A zustand shaped store that only exists in this test. */
function fakeStore(initial) {
  let state = { ...initial };
  const subs = new Set();
  return {
    getState: () => state,
    setState: (p) => { const prev = state; state = { ...state, ...p }; subs.forEach((f) => f(state, prev)); },
    subscribe: (f) => { subs.add(f); return () => subs.delete(f); },
    get subs() { return subs.size; },
  };
}

/** One runner with a gate the test turns by hand and a read that counts itself. */
function rig({ decision = 'skip', rows = [] } = {}) {
  const routed = [];
  let fetches = 0;
  const ctl = { decision, rows };
  const store = fakeStore({
    menuCategories: [], bootLocationId: null, _catsReadLocationId: null,
    routeKioskOrderPrints: async (order, opts) => { routed.push([order.ref, opts.trigger]); await tick(); },
  });
  const start = (mode = 'pos') => startChannelAutoRouter({
    store, venueId: 'loc-A', mode,
    gate: () => ctl.decision,
    fetchUnrouted: async () => { fetches++; return ctl.rows; },
  });
  return { store, routed, ctl, start, get fetches() { return fetches; } };
}
const row = (ref, over = {}) => ({ ref, source: 'qr', status: 'received', items: [{ name: 'Latte' }], sent_at: new Date().toISOString(), ...over });
const quiet = (t) => t.mock.method(console, 'log', () => {});

test('closed at start: nothing is read and nothing is routed', async (t) => {
  quiet(t);
  const r = rig({ decision: 'skip', rows: [row('QR-1')] });
  r.start();
  await settle();
  assert.equal(r.fetches, 0);
  assert.deepEqual(r.routed, []);
  assert.equal(r.store.subs, 1, 'it listens for the menu');
  offerLiveOrder({ ref: 'QR-2', items: [1] });
  await settle();
  assert.equal(r.fetches, 0);
  assert.deepEqual(r.routed, [], 'not the master: the live order is left alone');
  stopChannelAutoRouter();
  assert.equal(r.store.subs, 0);
});

test('a page in a non till mode never starts: the rear customer display, Back Office, a handset', async (t) => {
  quiet(t);
  for (const mode of ['customer-display', 'office', 'backoffice', 'mpos', 'bookings', 'clock', '']) {
    // Even a gate that says "route" is never asked.
    const r = rig({ decision: 'route', rows: [row('QR-1')] });
    r.start(mode);
    await settle(2);
    assert.equal(r.fetches, 0, mode);
    assert.equal(r.store.subs, 0, 'no store subscription in ' + mode);
    offerLiveOrder({ ref: 'QR-9', items: [1] });
    await settle(2);
    assert.deepEqual(r.routed, [], mode);
    stopChannelAutoRouter();
  }
});

test('missing pieces do nothing: no store, no venue, no read', async () => {
  const r = rig({ decision: 'route', rows: [row('QR-1')] });
  startChannelAutoRouter({ store: null, venueId: 'loc-A', fetchUnrouted: async () => [], mode: 'pos' });
  startChannelAutoRouter({ store: r.store, venueId: '', fetchUnrouted: async () => [], mode: 'pos' });
  startChannelAutoRouter({ store: r.store, venueId: 'loc-A', mode: 'pos' });
  startChannelAutoRouter();
  await settle(2);
  assert.equal(r.store.subs, 0);
  offerLiveOrder({ ref: 'QR-9', items: [1] });
  assert.deepEqual(r.routed, []);
  assert.doesNotThrow(() => requestCatchUp('x'));
  assert.doesNotThrow(() => stopChannelAutoRouter());
});

test('waits for the menu: nothing is claimed while it waits, and one scan routes what waited when the menu lands', async (t) => {
  quiet(t);
  const r = rig({
    decision: 'wait',
    rows: [row('QR-1'), row('HR-1', { source: 'hubrise', status: 'received' }), row('HR-2', { source: 'hubrise', status: 'prep' })],
  });
  r.start();
  await settle(2);
  // The order arrives while the till has no menu yet: not routed, not read, not dropped.
  offerLiveOrder({ ref: 'QR-1', items: [1] });
  await settle(2);
  assert.equal(r.fetches, 0);
  assert.deepEqual(r.routed, []);
  // The menu lands (SyncBridge puts the categories in the store).
  r.ctl.decision = 'route';
  r.store.setState({ menuCategories: [{ id: 'c', location_id: 'loc-A' }] });
  await settle(6);
  assert.equal(r.fetches, 1, 'one read');
  // The delivery app order on manual accept is left for staff; the auto accepted one goes.
  assert.deepEqual(r.routed, [['QR-1', 'backfill'], ['HR-2', 'backfill']]);
  // More store changes while the gate is open do not read again.
  r.store.setState({ menuCategories: [{ id: 'c', location_id: 'loc-A' }, { id: 'd', location_id: 'loc-A' }] });
  r.store.setState({ bootLocationId: 'loc-A' });
  await settle(2);
  assert.equal(r.fetches, 1);
  stopChannelAutoRouter();
});

test('a store change that is not the menu does not wake a waiting gate', async (t) => {
  quiet(t);
  const r = rig({ decision: 'skip', rows: [row('QR-1')] });
  r.start();
  await settle(2);
  r.ctl.decision = 'route';
  r.store.setState({ toast: { msg: 'hello' } });
  await settle(2);
  assert.equal(r.fetches, 0);
  r.store.setState({ _catsReadLocationId: 'loc-A' });
  await settle(4);
  assert.equal(r.fetches, 1);
  assert.deepEqual(r.routed, [['QR-1', 'backfill']]);
  stopChannelAutoRouter();
});

test('open gate: a live order is routed in the same tick, with trigger live and no read', async (t) => {
  quiet(t);
  const r = rig({ decision: 'route', rows: [] });
  r.start();
  await settle(2);
  assert.equal(r.fetches, 1, 'the scan when the gate first opened');
  offerLiveOrder({ ref: 'QR-5', items: [1] });
  // No await before this line: the route call was made synchronously.
  assert.deepEqual(r.routed, [['QR-5', 'live']]);
  assert.equal(r.fetches, 1, 'no read for a live order');
  offerLiveOrder({ ref: '', items: [1] });
  offerLiveOrder(null);
  assert.equal(r.routed.length, 1, 'an order with no ref is not offered');
  stopChannelAutoRouter();
});

test('the whole rule again for every order: the gate turning false during a scan stops it and the rest are not routed', async (t) => {
  quiet(t);
  const r = rig({ decision: 'route', rows: [row('A'), row('B'), row('C')] });
  // The first route flips the rule (the till was unpaired, or the master flag was cleared).
  r.store.setState({ routeKioskOrderPrints: async (order, opts) => { r.routed.push([order.ref, opts.trigger]); r.ctl.decision = 'skip'; } });
  r.start();
  await settle();
  assert.deepEqual(r.routed, [['A', 'backfill']]);
  assert.equal(r.fetches, 1);
  stopChannelAutoRouter();
});

test('route-blind routes; catch up requests inside the gap do not read again; an order due later is handed over once; after stop nothing routes', async (t) => {
  quiet(t);
  const future = new Date(Date.now() + 3600_000).toISOString();
  const r = rig({ decision: 'route-blind', rows: [row('OL-1', { source: 'online', sent_at: future })] });
  r.start();
  await settle();
  assert.deepEqual(r.routed, [['OL-1', 'backfill']]);
  assert.equal(r.fetches, 1);
  // The order channel subscribed again, twice, seconds after the scan: inside the 30 s gap.
  requestCatchUp('subscribed');
  requestCatchUp('subscribed');
  await settle(2);
  assert.equal(r.fetches, 1, 'inside the gap');
  // The gate closes and opens again: a new scan, and the pre order is not handed over twice
  // (routeKioskOrderPrints armed one timer for it the first time).
  r.ctl.decision = 'skip';
  requestCatchUp('x');
  r.ctl.decision = 'route';
  requestCatchUp('y');
  await settle();
  assert.equal(r.fetches, 2);
  assert.deepEqual(r.routed, [['OL-1', 'backfill']]);
  stopChannelAutoRouter();
  offerLiveOrder({ ref: 'Z', items: [1] });
  requestCatchUp('z');
  await settle(2);
  assert.equal(r.routed.length, 1, 'stopped');
  assert.equal(r.fetches, 2, 'stopped');
});

test('a live order that finds the gate open unseen catches up on what waited as well as going itself, with one read', async (t) => {
  quiet(t);
  const r = rig({ decision: 'skip', rows: [row('OLD-1')] });
  r.start();
  await settle(2);
  // The rule turned true with no event this runner saw. The next live order finds out.
  r.ctl.decision = 'route';
  offerLiveOrder({ ref: 'NEW-1', items: [1] });
  await settle(6);
  assert.deepEqual(r.routed.map((x) => x[0]).sort(), ['NEW-1', 'OLD-1']);
  assert.deepEqual(r.routed.find((x) => x[0] === 'NEW-1'), ['NEW-1', 'live']);
  assert.deepEqual(r.routed.find((x) => x[0] === 'OLD-1'), ['OLD-1', 'backfill']);
  assert.equal(r.fetches, 1);
  stopChannelAutoRouter();
});

test('a failed read is tried again by the next trigger and is not held back by the gap', async (t) => {
  quiet(t);
  const r = rig({ decision: 'route', rows: null });
  r.start();
  await settle(2);
  assert.equal(r.fetches, 1);
  assert.deepEqual(r.routed, []);
  r.ctl.rows = [row('QR-7')];
  requestCatchUp('online');
  await settle(6);
  assert.equal(r.fetches, 2);
  assert.deepEqual(r.routed, [['QR-7', 'backfill']]);
  stopChannelAutoRouter();
});

test('a read that throws does not break the runner: the next trigger looks again', async (t) => {
  quiet(t);
  t.mock.method(console, 'warn', () => {});
  const r = rig({ decision: 'route', rows: [row('QR-8')] });
  let boom = true;
  let fetches = 0;
  startChannelAutoRouter({
    store: r.store, venueId: 'loc-A', mode: 'pos', gate: () => r.ctl.decision,
    fetchUnrouted: async () => { fetches++; if (boom) throw new Error('network'); return r.ctl.rows; },
  });
  await settle(2);
  assert.equal(fetches, 1);
  boom = false;
  requestCatchUp('online');
  await settle(6);
  assert.equal(fetches, 2);
  assert.deepEqual(r.routed, [['QR-8', 'backfill']]);
  stopChannelAutoRouter();
});

test('starting again stops the earlier run: one venue, one runner', async (t) => {
  quiet(t);
  const a = rig({ decision: 'skip' });
  a.start();
  const b = rig({ decision: 'route', rows: [] });
  b.start();
  await settle(2);
  assert.equal(a.store.subs, 0, 'the first run let go of its store');
  assert.equal(b.store.subs, 1);
  offerLiveOrder({ ref: 'QR-3', items: [1] });
  assert.deepEqual(a.routed, []);
  assert.deepEqual(b.routed, [['QR-3', 'live']]);
  stopChannelAutoRouter();
});
