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

/**
 * One runner with a gate the test turns by hand and a read that counts itself. timing hands the
 * runner a short rate limit gap and a short retry, so the tests of "later, never dropped" run in
 * milliseconds; without it the runner uses the real 30 s and 10 s.
 */
function rig({ decision = 'skip', rows = [], timing = {} } = {}) {
  const routed = [];
  let fetches = 0;
  const ctl = { decision, rows, boom: false };
  const store = fakeStore({
    menuCategories: [], bootLocationId: null, _catsReadLocationId: null,
    routeKioskOrderPrints: async (order, opts) => { routed.push([order.ref, opts.trigger]); await tick(); },
  });
  const start = (mode = 'pos') => startChannelAutoRouter({
    store, venueId: 'loc-A', mode, ...timing,
    gate: () => ctl.decision,
    fetchUnrouted: async () => { fetches++; if (ctl.boom) throw new Error('network'); return ctl.rows; },
  });
  return { store, routed, ctl, start, get fetches() { return fetches; } };
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
/** Wait until cond() is true (a timer may be late on a busy machine, never early). */
const until = async (cond, ms = 4000) => { const end = Date.now() + ms; while (!cond() && Date.now() < end) await tick(); return cond(); };
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

test('a scan that stops because the gate closed leaves the runner CLOSED, so the gate opening again scans for what was left (review)', async (t) => {
  quiet(t);
  // Review, 12 Oct 2026. The loop broke but the runner still believed the gate was open: the
  // menu landing was ignored (the store subscription returns early while open) and B and C
  // waited for an outside event.
  const r = rig({ decision: 'route', rows: [row('A'), row('B'), row('C')] });
  const left = new Set(['A', 'B', 'C']);
  r.store.setState({ routeKioskOrderPrints: async (order, opts) => {
    r.routed.push([order.ref, opts.trigger]); left.delete(order.ref);
    if (order.ref === 'A') r.ctl.decision = 'wait';      // the till lost its menu, or its answer, mid scan
  } });
  r.start();
  await settle();
  assert.deepEqual(r.routed, [['A', 'backfill']]);
  assert.equal(r.fetches, 1);
  // The menu lands: a store change, with no other event. The read now holds what was left.
  r.ctl.rows = [row('B'), row('C')];
  r.ctl.decision = 'route';
  r.store.setState({ menuCategories: [{ id: 'c', location_id: 'loc-A' }] });
  await settle(8);
  assert.equal(r.fetches, 2, 'the gate re opened and scanned again');
  assert.deepEqual([...left], []);
  assert.deepEqual(r.routed.map((x) => x[0]), ['A', 'B', 'C']);
  stopChannelAutoRouter();
});

test('a scan that stops because the gate closed is looked at again by the clock alone, about a second later (review)', async (t) => {
  quiet(t);
  const r = rig({ decision: 'route', rows: [row('A'), row('B')] });
  r.store.setState({ routeKioskOrderPrints: async (order, opts) => { r.routed.push([order.ref, opts.trigger]); if (order.ref === 'A') r.ctl.decision = 'wait'; } });
  r.start();
  await settle();
  assert.deepEqual(r.routed, [['A', 'backfill']]);
  // Nothing happens on the page: no store change, no event. The wait check runs each second.
  r.ctl.rows = [row('B')];
  r.ctl.decision = 'route-blind';
  const from = Date.now();
  assert.ok(await until(() => r.fetches >= 2), 'looked again with no event');
  assert.ok(Date.now() - from >= 900, 'by the one second check, not at once');
  await settle(4);
  assert.deepEqual(r.routed, [['A', 'backfill'], ['B', 'backfill']]);
  stopChannelAutoRouter();
});

test('one order that makes the route throw does not block the orders behind it, in this scan or the next (review)', async (t) => {
  quiet(t);
  const warned = [];
  t.mock.method(console, 'warn', (...a) => warned.push(a.join(' ')));
  // routeKioskOrderPrints maps order.items before its own try, so a null line rejects.
  const r = rig({ decision: 'route', rows: [row('BAD'), row('GOOD-1'), row('GOOD-2')], timing: { minGapMs: 40 } });
  r.store.setState({ routeKioskOrderPrints: async (order, opts) => {
    if (order.ref === 'BAD') throw new TypeError("Cannot read properties of null (reading 'id')");
    r.routed.push([order.ref, opts.trigger]);
  } });
  r.start();
  await settle();
  assert.deepEqual(r.routed, [['GOOD-1', 'backfill'], ['GOOD-2', 'backfill']]);
  assert.equal(warned.length, 1);
  assert.match(warned[0], /one order failed, the rest go on BAD /);
  // The bad row is still unrouted next time. It fails again and still blocks nobody.
  r.ctl.rows = [row('BAD'), row('GOOD-3')];
  await wait(60);
  requestCatchUp('online');
  await settle();
  assert.deepEqual(r.routed.map((x) => x[0]), ['GOOD-1', 'GOOD-2', 'GOOD-3']);
  // It was a route that failed, not the read: no retry is armed for it.
  await wait(120);
  assert.equal(r.fetches, 2);
  stopChannelAutoRouter();
});

test('an order due later whose hand over threw is offered again by the next scan', async (t) => {
  quiet(t);
  t.mock.method(console, 'warn', () => {});
  const future = new Date(Date.now() + 3600_000).toISOString();
  const r = rig({ decision: 'route', rows: [row('OL-9', { source: 'online', sent_at: future })], timing: { minGapMs: 30 } });
  let fail = true;
  r.store.setState({ routeKioskOrderPrints: async (order, opts) => { if (fail) throw new Error('boom'); r.routed.push([order.ref, opts.trigger]); } });
  r.start();
  await settle();
  assert.deepEqual(r.routed, []);
  fail = false;
  await wait(45);
  requestCatchUp('online');
  await settle();
  assert.deepEqual(r.routed, [['OL-9', 'backfill']]);
  stopChannelAutoRouter();
});

test('rate limited means LATER, never dropped: a request inside the gap is one more read when the gap ends (review)', async (t) => {
  quiet(t);
  // Review, 12 Oct 2026, the wake. The tab is visible at once and scans. The socket that died
  // in sleep joins again some seconds later and asks for a catch up: inside the gap. An order
  // paid between the read and the rejoin has no INSERT event and was in no scan. The request
  // used to be thrown away and nothing was armed, so the order waited for the next wake.
  const GAP = 300;
  const r = rig({ decision: 'route', rows: [], timing: { minGapMs: GAP } });
  const scanAt = Date.now();
  r.start();
  await settle(2);
  assert.equal(r.fetches, 1, 'the wake scan');
  // QR-LATE lands after that read, with the socket down. Then the socket joins again.
  r.ctl.rows = [row('QR-LATE')];
  requestCatchUp('subscribed');
  requestCatchUp('subscribed');
  requestCatchUp('online');
  await settle(2);
  assert.equal(r.fetches, 1, 'still inside the gap: no read yet');
  assert.deepEqual(r.routed, []);
  // The gap ends. Exactly one more read, however many asked, and not before the gap is over.
  assert.ok(await until(() => r.fetches >= 2), 'the deferred read came with no further event');
  assert.ok(Date.now() - scanAt >= GAP - 5, 'not before the end of the gap');
  await settle(4);
  assert.equal(r.fetches, 2, 'one deferred read');
  assert.deepEqual(r.routed, [['QR-LATE', 'backfill']]);
  // And nothing keeps reading afterwards: no request, no read.
  r.ctl.rows = [];
  await wait(GAP * 2 + 80);
  assert.equal(r.fetches, 2, 'no polling');
  stopChannelAutoRouter();
});

test('the deferred look asks the gate again: a gate that closed in the meantime reads nothing', async (t) => {
  quiet(t);
  const r = rig({ decision: 'route', rows: [], timing: { minGapMs: 60 } });
  r.start();
  await settle(2);
  requestCatchUp('subscribed');
  r.ctl.decision = 'skip';                 // the till stopped being the master before the gap ended
  await wait(110);
  assert.equal(r.fetches, 1);
  // Master again: the gate opening scans, as always.
  r.ctl.decision = 'route';
  requestCatchUp('x');
  await settle(2);
  assert.equal(r.fetches, 2);
  stopChannelAutoRouter();
});

test('a failed read is tried again by the till itself, with no outside event, and slower each time (review)', async (t) => {
  quiet(t);
  t.mock.method(console, 'warn', () => {});
  // Review, 12 Oct 2026: a read that answered null armed nothing. Routed [] and reads 1, for
  // as long as no wake, no online event and no rejoin came.
  const at = [];
  const routed = [];
  let rows = null;
  const store = fakeStore({ routeKioskOrderPrints: async (order, opts) => { routed.push([order.ref, opts.trigger]); } });
  startChannelAutoRouter({
    store, venueId: 'loc-A', mode: 'pos', gate: () => 'route', retryMs: 60, minGapMs: 60_000,
    fetchUnrouted: async () => { at.push(Date.now()); if (at.length === 3) rows = [row('P')]; return at.length < 3 ? null : rows; },
  });
  // Nothing happens on the page from here on: no request, no event, no store change.
  assert.ok(await until(() => at.length >= 3), 'it asked again by itself, twice: ' + at.length);
  await settle(4);
  assert.deepEqual(routed, [['P', 'backfill']], 'the order that was waiting went as soon as a read worked');
  // 60 ms, then 120 ms (10 s, then 20 s on a till). A timer is never early, so these are floors.
  assert.ok(at[1] - at[0] >= 55, 'first retry after the base delay: ' + (at[1] - at[0]));
  assert.ok(at[2] - at[1] >= 115, 'second retry waits twice as long: ' + (at[2] - at[1]));
  // It worked: the retries stop. No fourth read comes (the rate limit gap is a minute here).
  await wait(450);
  assert.equal(at.length, 3);
  stopChannelAutoRouter();
});

test('a read that throws is retried the same way', async (t) => {
  quiet(t);
  t.mock.method(console, 'warn', () => {});
  const r = rig({ decision: 'route', rows: [row('QR-8')], timing: { retryMs: 30, minGapMs: 60_000 } });
  r.ctl.boom = true;
  r.start();
  await settle(2);
  assert.equal(r.fetches, 1);
  assert.deepEqual(r.routed, []);
  r.ctl.boom = false;
  assert.ok(await until(() => r.fetches >= 2), 'retried with no outside event');
  await settle(4);
  assert.deepEqual(r.routed, [['QR-8', 'backfill']]);
  stopChannelAutoRouter();
});

test('stopping clears the retry and the deferred look: nothing reads after a stop', async (t) => {
  quiet(t);
  t.mock.method(console, 'warn', () => {});
  // A retry is armed (the read failed), then the runner stops.
  const failed = rig({ decision: 'route', rows: null, timing: { retryMs: 30, minGapMs: 60_000 } });
  failed.start();
  await settle(2);
  assert.equal(failed.fetches, 1);
  stopChannelAutoRouter();
  // A deferred look is armed (a request inside the gap), then the runner stops.
  const asked = rig({ decision: 'route', rows: [], timing: { minGapMs: 40 } });
  asked.start();
  await settle(2);
  assert.equal(asked.fetches, 1);
  requestCatchUp('subscribed');
  stopChannelAutoRouter();
  await wait(160);
  assert.equal(failed.fetches, 1, 'no retry after the stop');
  assert.equal(asked.fetches, 1, 'no deferred look after the stop');
});

test('route-blind routes; an order due later is handed over once; after stop nothing routes', async (t) => {
  quiet(t);
  const future = new Date(Date.now() + 3600_000).toISOString();
  const r = rig({ decision: 'route-blind', rows: [row('OL-1', { source: 'online', sent_at: future })] });
  r.start();
  await settle();
  assert.deepEqual(r.routed, [['OL-1', 'backfill']]);
  assert.equal(r.fetches, 1);
  // The order channel subscribed again, twice, seconds after the scan: inside the real 30 s
  // gap, so no read now (one look is armed for the end of the gap, tested above).
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
