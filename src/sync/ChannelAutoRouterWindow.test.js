// src/sync/ChannelAutoRouterWindow.test.js
//
// The channel auto route gate in a PAGE: with a window, a document and a localStorage.
//
// 12 Oct 2026, review of the master till fence (Coffee Boy Preston). The runner's other tests
// (ChannelAutoRouter.test.js) run in node with no window, so nothing held the parts that only
// exist in a browser: the one second check that ends the bounded menu wait, the wake, online and
// other tab triggers, the event the till session and the one writer send, and the page mode that
// is latched when the page loads. Nine hand made faults in those lines passed every test.
// This file gives the modules a window that only exists here, set BEFORE they load. node --test
// runs each test file in its own process, so no other test sees it.

import test from 'node:test';
import assert from 'node:assert/strict';

const put = (name, value) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });

const win = new EventTarget();
win.location = { href: 'https://till.test/?mode=pos' };
put('window', win);
const doc = new EventTarget();
doc.visibilityState = 'visible';
put('document', doc);
const mem = (seed = []) => {
  const m = new Map(seed);
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); }, m };
};
const ls = mem([['rpos-device-mode', 'pos']]);
put('localStorage', ls);
put('sessionStorage', mem());

const { startChannelAutoRouter, stopChannelAutoRouter, offerLiveOrder, requestCatchUp } = await import('./ChannelAutoRouter.js');
const {
  markTillSession, pageMode, saveDeviceConfig, clearMasterFlag, forgetDeviceConfig, isMasterTillHere, hydratableDeviceConfig,
  MASTER_TILL_EVENT, DEVICE_KEY, DEVICE_CONFIG_KEY, VENUE_TAG_KEY,
} = await import('../lib/masterTillDevice.js');
const { MENU_WAIT_MS, CATCH_UP_MIN_GAP_MS } = await import('../lib/channelRouteGate.js');

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const until = async (cond, ms = 5000) => { const end = Date.now() + ms; while (!cond() && Date.now() < end) await tick(); return cond(); };
const quiet = (t) => t.mock.method(console, 'log', () => {});
const row = (ref) => ({ ref, source: 'qr', status: 'received', items: [{ name: 'Latte' }], sent_at: new Date().toISOString() });

/** A runner with a gate the test turns by hand. */
function rig(decision, timing = {}) {
  const ctl = { decision, rows: [row('QR-1')] };
  const routed = []; let fetches = 0;
  const store = { getState: () => ({ routeKioskOrderPrints: async (o, opts) => { routed.push([o.ref, opts.trigger]); } }), subscribe: () => () => {} };
  startChannelAutoRouter({ store, venueId: 'loc-A', mode: 'pos', gate: () => ctl.decision, fetchUnrouted: async () => { fetches++; return ctl.rows; }, ...timing });
  return { ctl, routed, get fetches() { return fetches; } };
}

/** A zustand shaped store, for the tests that use the REAL gate. */
function realStore(initial) {
  let state = { ...initial };
  const subs = new Set();
  return {
    getState: () => state,
    setState: (p) => { const prev = state; state = { ...state, ...p }; subs.forEach((f) => f(state, prev)); },
    subscribe: (f) => { subs.add(f); return () => subs.delete(f); },
  };
}
const DEV = { id: 'dev-1', name: 'POS', type: 'pos', locationId: 'loc-A', deviceSecret: 'SECRET' };
const MASTER = { profileId: 'prof-1', isMaster: true };
const pairMaster = () => {
  ls.setItem(DEVICE_KEY, JSON.stringify(DEV));
  ls.setItem(DEVICE_CONFIG_KEY, JSON.stringify(MASTER));
};
const unpair = () => { ls.removeItem(DEVICE_KEY); ls.removeItem(DEVICE_CONFIG_KEY); markTillSession(null); };

test('the wait runs out by the clock alone: no store change, no event, and the order still goes about a second later', async (t) => {
  quiet(t);
  const r = rig('wait');
  await tick(20);
  assert.equal(r.fetches, 0);
  r.ctl.decision = 'route-blind';          // the deadline passed; nothing else happens on the page
  assert.ok(await until(() => r.routed.length === 1), 'the one second check found the gate open');
  assert.deepEqual(r.routed, [['QR-1', 'backfill']]);
  stopChannelAutoRouter();
});

test('the wait keeps checking, second after second, until the gate opens', async (t) => {
  quiet(t);
  const r = rig('wait');
  await tick(1250);                         // the first check has run and found "wait" again
  assert.equal(r.fetches, 0);
  r.ctl.decision = 'route';
  assert.ok(await until(() => r.routed.length === 1), 'a later check opened it');
  stopChannelAutoRouter();
});

test('the till session becoming valid opens the gate (the master till event), with no store change', async (t) => {
  quiet(t);
  const r = rig('skip');
  await tick(20);
  r.ctl.decision = 'route';
  let heard = 0;
  const count = () => { heard++; };
  win.addEventListener(MASTER_TILL_EVENT, count);
  markTillSession('dev-1');                // ValidatedPOSApp said the device is valid
  assert.equal(heard, 1, 'markTillSession tells the page');
  await tick(20);
  assert.deepEqual(r.routed, [['QR-1', 'backfill']]);
  markTillSession('dev-1');
  assert.equal(heard, 1, 'the same device again is no news');
  markTillSession(null);
  assert.equal(heard, 2);
  win.removeEventListener(MASTER_TILL_EVENT, count);
  stopChannelAutoRouter();
});

test('the one writer tells the page: a healed or changed config, a cleared answer and a forgotten config all send the event', () => {
  let heard = 0;
  const count = () => { heard++; };
  win.addEventListener(MASTER_TILL_EVENT, count);
  ls.setItem(DEVICE_KEY, JSON.stringify(DEV));
  ls.removeItem(DEVICE_CONFIG_KEY);
  assert.equal(saveDeviceConfig(MASTER), true);                       // the heal after a wipe
  assert.equal(heard, 1, 'saveDeviceConfig announces when it writes');
  assert.equal(saveDeviceConfig(MASTER), false);
  assert.equal(heard, 1, 'and stays silent when it leaves storage alone');
  assert.equal(clearMasterFlag(), true);
  assert.equal(heard, 2, 'clearMasterFlag announces');
  assert.equal(clearMasterFlag(), false);
  assert.equal(heard, 2);
  forgetDeviceConfig();
  assert.equal(heard, 3, 'forgetDeviceConfig announces');
  win.removeEventListener(MASTER_TILL_EVENT, count);
  unpair();
});

test('the healed config opens a real gate: a master till whose config was wiped starts sending again at its next profile refresh', async (t) => {
  quiet(t);
  // The REAL gate (lib/masterTillDevice.js autoRouteGate), reading this page and this storage.
  ls.setItem(DEVICE_KEY, JSON.stringify(DEV));
  ls.removeItem(DEVICE_CONFIG_KEY);
  markTillSession('dev-1');
  const routed = []; let fetches = 0;
  const store = realStore({
    bootLocationId: 'loc-A', _catsReadLocationId: null, menuCategories: [{ id: 'c', location_id: 'loc-A' }],
    routeKioskOrderPrints: async (o, opts) => { routed.push([o.ref, opts.trigger]); },
  });
  startChannelAutoRouter({ store, venueId: 'loc-A', fetchUnrouted: async () => { fetches++; return [row('QR-WAITED')]; } });
  await tick(20);
  assert.equal(isMasterTillHere('loc-A'), false, 'no config: not the master');
  offerLiveOrder({ ref: 'QR-WAITED', items: [1] });
  await tick(20);
  assert.deepEqual([fetches, routed], [0, []], 'nothing claimed while it is not the master');
  saveDeviceConfig(MASTER);                 // the profile refresh puts the config back, stamped
  assert.ok(await until(() => routed.length === 1));
  assert.deepEqual(routed, [['QR-WAITED', 'backfill']]);
  assert.equal(JSON.parse(ls.getItem(DEVICE_CONFIG_KEY)).ownerDeviceId, 'dev-1');
  stopChannelAutoRouter();
  unpair();
});

test('the real gate, the real wait: the master with no menu waits, sends when the menu lands, and after 20 s sends anyway', async (t) => {
  quiet(t);
  pairMaster();
  markTillSession('dev-1');
  const routed = []; let rows = [row('QR-A')];
  const store = realStore({
    bootLocationId: 'loc-A', _catsReadLocationId: null, menuCategories: [],
    routeKioskOrderPrints: async (o, opts) => { routed.push([o.ref, opts.trigger]); },
  });
  startChannelAutoRouter({ store, venueId: 'loc-A', fetchUnrouted: async () => rows });
  offerLiveOrder({ ref: 'QR-A', items: [1] });
  await tick(30);
  assert.deepEqual(routed, [], 'no menu yet: nothing claimed');
  // The category rows land in the store (the boot patch).
  store.setState({ menuCategories: [{ id: 'c', location_id: 'loc-A' }] });
  assert.ok(await until(() => routed.length === 1));
  assert.deepEqual(routed, [['QR-A', 'backfill']]);
  stopChannelAutoRouter();

  // The same till, a menu that never comes. Before the deadline: wait. After it: the order goes.
  routed.length = 0; rows = [row('QR-B')];
  store.setState({ menuCategories: [] });
  startChannelAutoRouter({ store, venueId: 'loc-A', fetchUnrouted: async () => rows });
  await tick(30);
  assert.deepEqual(routed, []);
  const realNow = Date.now;
  t.mock.method(Date, 'now', () => realNow() + MENU_WAIT_MS + 500);   // the tablet's clock is past the wait
  assert.ok(await until(() => routed.length === 1), 'the one second check sent it with what the till holds');
  assert.deepEqual(routed, [['QR-B', 'backfill']]);
  stopChannelAutoRouter();
  unpair();
});

test('wake and online look again; inside the gap the look is put off to the end of the gap, never dropped', async (t) => {
  quiet(t);
  const GAP = 250;
  const r = rig('route', { minGapMs: GAP });
  await tick(20);
  assert.equal(r.fetches, 1);
  // The wake: the tab is visible again at once, the network a moment later. Both inside the gap.
  doc.dispatchEvent(new Event('visibilitychange'));
  win.dispatchEvent(new Event('online'));
  requestCatchUp('subscribed');
  await tick(20);
  assert.equal(r.fetches, 1, 'inside the gap');
  assert.ok(await until(() => r.fetches === 2), 'one look when the gap ended');
  await tick(GAP + 60);
  assert.equal(r.fetches, 2, 'one, not three');
  // Past the gap each trigger reads at once.
  win.dispatchEvent(new Event('online'));
  await tick(20);
  assert.equal(r.fetches, 3, 'online');
  await tick(GAP + 20);
  doc.dispatchEvent(new Event('visibilitychange'));
  await tick(20);
  assert.equal(r.fetches, 4, 'tab visible');
  // A hidden tab does not look.
  await tick(GAP + 20);
  doc.visibilityState = 'hidden';
  doc.dispatchEvent(new Event('visibilitychange'));
  await tick(20);
  assert.equal(r.fetches, 4, 'hidden');
  doc.visibilityState = 'visible';
  stopChannelAutoRouter();
  // After the stop the page's events reach nobody.
  win.dispatchEvent(new Event('online'));
  doc.dispatchEvent(new Event('visibilitychange'));
  await tick(GAP + 60);
  assert.equal(r.fetches, 4, 'stopped');
});

test('the real gap is 30 seconds: a wake 31 s after the last look reads at once', async (t) => {
  quiet(t);
  const r = rig('route');
  await tick(20);
  assert.equal(r.fetches, 1);
  const realNow = Date.now;
  t.mock.method(Date, 'now', () => realNow() + CATCH_UP_MIN_GAP_MS + 1000);
  win.dispatchEvent(new Event('online'));
  await tick(20);
  assert.equal(r.fetches, 2);
  stopChannelAutoRouter();
});

test('a change in another tab (the pairing or the config key) re evaluates; any other key does not', async (t) => {
  quiet(t);
  for (const key of [DEVICE_KEY, DEVICE_CONFIG_KEY]) {
    const s = rig('skip');
    await tick(20);
    s.ctl.decision = 'route';
    const other = new Event('storage'); other.key = 'rpos-theme';
    win.dispatchEvent(other);
    await tick(20);
    assert.equal(s.fetches, 0, 'rpos-theme is not our business');
    const ev = new Event('storage'); ev.key = key;
    win.dispatchEvent(ev);
    await tick(20);
    assert.equal(s.fetches, 1, key);
    stopChannelAutoRouter();
  }
});

test('the page mode is latched at load: the shared key changing later does not change it', () => {
  win.location = { href: 'https://till.test/' };           // a bare address
  assert.equal(pageMode(), 'pos', 'the mode stored when the page loaded');
  ls.setItem('rpos-device-mode', 'office');                // a Back Office tab loaded in this browser
  assert.equal(pageMode(), 'pos', 'never the live shared key');
  ls.setItem('rpos-device-mode', 'customer-display');      // the rear screen of a Sunmi booted
  assert.equal(pageMode(), 'pos');
  win.location = { href: 'https://till.test/?mode=customer-display' };
  assert.equal(pageMode(), 'customer-display', 'the address wins');
  win.location = { href: 'https://till.test/?mode=pos' };
  ls.setItem('rpos-device-mode', 'pos');
});

test('what the store starts from, in a page: the till reads its config, a Back Office page on another venue does not', () => {
  const training = { ...MASTER, trainingMode: true, ownerDeviceId: 'dev-1', ownerLocationId: 'loc-A' };
  ls.setItem(DEVICE_KEY, JSON.stringify(DEV));
  ls.setItem(DEVICE_CONFIG_KEY, JSON.stringify(training));
  ls.setItem(VENUE_TAG_KEY, 'loc-B');                      // a Back Office tab on venue B tagged the browser
  assert.deepEqual(hydratableDeviceConfig(), training, 'this page is the till (?mode=pos)');
  win.location = { href: 'https://till.test/?mode=office' };
  assert.equal(hydratableDeviceConfig(), null, 'Back Office for venue B does not start in training mode');
  win.location = { href: 'https://till.test/?mode=bookings' };
  assert.equal(hydratableDeviceConfig(), null);
  ls.setItem(VENUE_TAG_KEY, 'loc-A');
  assert.deepEqual(hydratableDeviceConfig(), training, 'the same venue: as it always was');
  win.location = { href: 'https://till.test/?mode=pos' };
  ls.removeItem(VENUE_TAG_KEY);
  unpair();
});
