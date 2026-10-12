// src/lib/masterTillDevice.test.js
//
// The thin reader and the ONE writer beside the master till rule (lib/masterTillDevice.js).
//
// 12 Oct 2026, Coffee Boy Preston. Storage is shared: every tab of a browser, and both screens of
// a Sunmi, read one 'rpos-device' and one 'rpos-device-config'. So the reader takes two things
// that storage cannot hold from the PAGE (its own mode, and whether it holds a valid till
// session), and the writer ties the config to the till it was derived for. Every function takes
// a fake storage here, so nothing below touches a browser.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEVICE_KEY, DEVICE_CONFIG_KEY, TERMINAL_CONFIG_KEY, MASTER_TILL_EVENT,
  pageMode, markTillSession, tillSession, readMasterTill, isMasterTillHere, routerIdentity, autoRouteGate,
  saveDeviceConfig, keepStoredMaster, clearMasterFlag, forgetDeviceConfig, dropAdminPlaceholder,
} from './masterTillDevice.js';
import { MENU_WAIT_MS } from './channelRouteGate.js';

/** A storage that only exists in this test. It counts its writes. */
const fake = (seed = {}) => {
  const m = new Map(Object.entries(seed).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));
  let sets = 0;
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { sets++; m.set(k, String(v)); },
    removeItem: (k) => m.delete(k),
    json: (k) => JSON.parse(m.get(k) || 'null'),
    has: (k) => m.has(k),
    get sets() { return sets; },
  };
};

const DEV = { id: 'dev-1', name: 'POS', type: 'pos', locationId: 'loc-A', locationName: 'Preston', orgId: 'o', profileId: 'prof-1', deviceSecret: 'SECRET', pairedAt: 1 };
const CFG = { profileId: 'prof-1', profileName: 'POS', defaultSurface: 'pos', isMaster: true };
const STAMPED = { ...CFG, ownerDeviceId: 'dev-1', ownerLocationId: 'loc-A' };
const SESSION = { deviceId: 'dev-1', validAt: 1000 };
const till = (config = CFG) => {
  const storage = fake({ [DEVICE_KEY]: DEV, ...(config ? { [DEVICE_CONFIG_KEY]: config } : {}) });
  return { storage, env: { storage, mode: 'pos', session: SESSION } };
};

test('the keys: one name each, the same ones the app has always used', () => {
  assert.equal(DEVICE_KEY, 'rpos-device');
  assert.equal(DEVICE_CONFIG_KEY, 'rpos-device-config');
  assert.equal(TERMINAL_CONFIG_KEY, 'rpos-terminal-config');
  assert.equal(MASTER_TILL_EVENT, 'rpos-master-till-changed');
  // No window here: the page has no mode, so it is no till.
  assert.equal(pageMode(), '');
});

// ── the reader ───────────────────────────────────────────────────────────────

test('readMasterTill: the paired till with a master config, a till mode and its session is the master', () => {
  const { env } = till();
  assert.deepEqual(readMasterTill({ venueId: 'loc-A' }, env), { master: true, reason: 'ok', storedMaster: true });
  assert.equal(isMasterTillHere('loc-A', env), true);
  assert.equal(isMasterTillHere(undefined, env), true, 'no venue asked');
  assert.equal(isMasterTillHere('loc-B', env), false, 'another venue');
});

test('readMasterTill: the SAME storage read by the rear customer display, a Back Office tab or a page with no session is not the master', () => {
  const { env } = till(STAMPED);
  for (const mode of ['customer-display', 'office', 'backoffice', 'mpos', 'clock', 'bookings', '']) {
    assert.deepEqual(readMasterTill({ venueId: 'loc-A' }, { ...env, mode }), { master: false, reason: 'mode', storedMaster: true }, mode);
  }
  // The pairing screen of a removed till, a kicked second tab, "Checking device".
  assert.equal(readMasterTill({ venueId: 'loc-A' }, { ...env, session: null }).reason, 'session');
  assert.equal(readMasterTill({ venueId: 'loc-A' }, { ...env, session: { deviceId: 'dev-2', validAt: 1 } }).reason, 'session');
});

test('readMasterTill: junk in either key is not master and does not throw', () => {
  const junkDevice = fake({ [DEVICE_KEY]: '{not json', [DEVICE_CONFIG_KEY]: CFG });
  assert.equal(readMasterTill({ venueId: 'loc-A' }, { storage: junkDevice, mode: 'pos', session: SESSION }).reason, 'unpaired');
  const junkConfig = fake({ [DEVICE_KEY]: DEV, [DEVICE_CONFIG_KEY]: '{not json' });
  assert.equal(readMasterTill({ venueId: 'loc-A' }, { storage: junkConfig, mode: 'pos', session: SESSION }).reason, 'no-config');
  const empty = fake();
  assert.deepEqual(readMasterTill({}, { storage: empty, mode: 'pos', session: SESSION }), { master: false, reason: 'unpaired', storedMaster: false });
  // No storage at all (node, or a browser that refuses it): the module's own page has no mode.
  assert.equal(readMasterTill().master, false);
  assert.equal(isMasterTillHere('loc-A'), false);
});

test('routerIdentity: id, name and mode only, never the device secret', () => {
  const { storage } = till();
  const who = routerIdentity({ storage, mode: 'pos' });
  assert.deepEqual(who, { deviceId: 'dev-1', deviceName: 'POS', mode: 'pos' });
  assert.ok(!JSON.stringify(who).includes('SECRET'));
  assert.deepEqual(routerIdentity({ storage: fake(), mode: 'office' }), { deviceId: null, deviceName: null, mode: 'office' });
  assert.deepEqual(routerIdentity({ storage: fake({ [DEVICE_KEY]: 'junk{' }), mode: 'pos' }), { deviceId: null, deviceName: null, mode: 'pos' });
});

// ── this page's till session ─────────────────────────────────────────────────

test('markTillSession: the first valid moment sets the time, the same device again keeps it, null clears', async () => {
  markTillSession(null);
  assert.equal(tillSession(), null);
  const before = Date.now();
  markTillSession('dev-1');
  const first = tillSession();
  assert.equal(first.deviceId, 'dev-1');
  assert.ok(first.validAt >= before && first.validAt <= Date.now());
  await new Promise((r) => setTimeout(r, 15));
  // refreshDevice calls it again on every devices row change: the menu wait is NOT restarted.
  markTillSession('dev-1');
  assert.equal(tillSession().validAt, first.validAt);
  assert.equal(tillSession(), first);
  // Another device (a re pair before the reload) is a new session.
  markTillSession('dev-2');
  assert.equal(tillSession().deviceId, 'dev-2');
  assert.ok(tillSession().validAt >= first.validAt + 10);
  markTillSession(null);
  assert.equal(tillSession(), null);
  markTillSession(undefined);
  assert.equal(tillSession(), null);
});

// ── the gate for the auto route ──────────────────────────────────────────────

test('autoRouteGate: skip when this page is not the venue\'s master', () => {
  const { env } = till();
  const cats = [{ id: 'c', location_id: 'loc-A' }];
  const held = { bootLocationId: 'loc-A', menuCategories: cats };
  assert.equal(autoRouteGate(held, 'loc-B', 1500, env), 'skip', 'another venue');
  assert.equal(autoRouteGate(held, 'loc-A', 1500, { ...env, mode: 'office' }), 'skip', 'Back Office');
  assert.equal(autoRouteGate(held, 'loc-A', 1500, { ...env, mode: 'customer-display' }), 'skip', 'the rear screen');
  assert.equal(autoRouteGate(held, 'loc-A', 1500, { ...env, session: null }), 'skip', 'no till session on this page');
  assert.equal(autoRouteGate(held, '', 1500, env), 'skip', 'no venue');
  assert.equal(autoRouteGate(held, null, 1500, env), 'skip');
  const child = till({ ...CFG, isMaster: false });
  assert.equal(autoRouteGate(held, 'loc-A', 1500, child.env), 'skip', 'a normal till');
});

test('autoRouteGate: route with this venue\'s menu, wait without it, route-blind 20 s after the session became valid, never blind when the page did not boot', () => {
  const { env } = till();
  const cats = [{ id: 'c', location_id: 'loc-A' }];
  assert.equal(autoRouteGate({ bootLocationId: 'loc-A', menuCategories: cats }, 'loc-A', 1500, env), 'route');
  assert.equal(autoRouteGate({ bootLocationId: 'loc-A', menuCategories: [], _catsReadLocationId: 'loc-A' }, 'loc-A', 1500, env), 'route', 'a new venue with no categories');
  assert.equal(autoRouteGate({ bootLocationId: 'loc-A', menuCategories: [] }, 'loc-A', 1500, env), 'wait');
  assert.equal(autoRouteGate({ bootLocationId: 'loc-A', menuCategories: [] }, 'loc-A', SESSION.validAt + MENU_WAIT_MS - 1, env), 'wait');
  assert.equal(autoRouteGate({ bootLocationId: 'loc-A', menuCategories: [] }, 'loc-A', SESSION.validAt + MENU_WAIT_MS, env), 'route-blind');
  assert.equal(autoRouteGate({ bootLocationId: 'loc-A', menuCategories: [{ id: 'x', location_id: 'loc-B' }] }, 'loc-A', 99_000, env), 'route-blind', 'another venue\'s list is no menu');
  // The page's sync never started for this venue: it can never hold the menu, so it only waits.
  assert.equal(autoRouteGate({ bootLocationId: null, menuCategories: [] }, 'loc-A', 99_000, env), 'wait');
  assert.equal(autoRouteGate({ bootLocationId: 'loc-B', menuCategories: [] }, 'loc-A', 99_000, env), 'wait');
  assert.equal(autoRouteGate(null, 'loc-A', 99_000, env), 'wait', 'no store state');
  assert.equal(autoRouteGate(undefined, 'loc-A', 1500, env), 'wait');
});

// ── the one writer ───────────────────────────────────────────────────────────

test('saveDeviceConfig heals OUTSIDE the change gate: an unstamped copy is stamped once, then storage is left alone', () => {
  const { storage, env } = till();
  // The first profile refresh after the update: the profile is unchanged, so the caller does not force.
  assert.equal(saveDeviceConfig(CFG, {}, env), true);
  assert.deepEqual(storage.json(DEVICE_CONFIG_KEY), STAMPED);
  const n = storage.sets;
  assert.equal(saveDeviceConfig(CFG, {}, env), false);
  assert.equal(saveDeviceConfig(CFG, { force: false }, env), false);
  assert.equal(storage.sets, n, 'no second write');
  // The master answer differs from what is stored: written, forced or not.
  assert.equal(saveDeviceConfig({ ...CFG, isMaster: false }, {}, env), true);
  assert.equal(storage.json(DEVICE_CONFIG_KEY).isMaster, false);
  assert.equal(isMasterTillHere('loc-A', env), false);
  assert.equal(saveDeviceConfig(CFG, {}, env), true);
  assert.equal(isMasterTillHere('loc-A', env), true);
  // force always writes (the caller saw the profile change).
  const m = storage.sets;
  assert.equal(saveDeviceConfig({ ...CFG, profileName: 'Counter' }, { force: true }, env), true);
  assert.equal(storage.sets, m + 1);
  assert.deepEqual(storage.json(DEVICE_CONFIG_KEY), { ...STAMPED, profileName: 'Counter' });
  // A caller's own stamp is never trusted: the paired till's replaces it.
  saveDeviceConfig({ ...CFG, ownerDeviceId: 'dev-9', ownerLocationId: 'loc-Z' }, { force: true }, env);
  assert.deepEqual(storage.json(DEVICE_CONFIG_KEY), STAMPED);
});

test('saveDeviceConfig after a wipe: storage with the pairing and NO config gets the stamped config back, unforced', () => {
  // A Back Office tab on another venue wiped it (the tenant fence), or a re pair in the same tab
  // overwrote it, while the store still held the same config, so the change gate said "no change".
  const { storage, env } = till(null);
  assert.equal(isMasterTillHere('loc-A', env), false);
  assert.equal(saveDeviceConfig(CFG, {}, env), true);
  assert.deepEqual(storage.json(DEVICE_CONFIG_KEY), STAMPED);
  assert.equal(isMasterTillHere('loc-A', env), true);
  // A config stamped for another device is replaced too.
  const other = till({ ...CFG, isMaster: true, ownerDeviceId: 'dev-9', ownerLocationId: 'loc-A' });
  assert.equal(isMasterTillHere('loc-A', other.env), false);
  assert.equal(saveDeviceConfig(CFG, {}, other.env), true);
  assert.deepEqual(other.storage.json(DEVICE_CONFIG_KEY), STAMPED);
});

test('saveDeviceConfig never throws: no storage, no config, a storage that refuses the write', () => {
  assert.equal(saveDeviceConfig(CFG), false, 'no storage in node');
  const { storage, env } = till();
  assert.equal(saveDeviceConfig(null, { force: true }, env), false);
  assert.equal(saveDeviceConfig('junk', { force: true }, env), false);
  assert.deepEqual(storage.json(DEVICE_CONFIG_KEY), CFG, 'untouched');
  const full = { getItem: storage.getItem, setItem: () => { throw new Error('QuotaExceededError'); }, removeItem: () => {} };
  assert.equal(saveDeviceConfig(CFG, { force: true }, { storage: full }), false);
  // No pairing in storage (PairingScreen before rpos-device, or the placeholder): written with no stamp.
  const bare = fake();
  assert.equal(saveDeviceConfig(CFG, { force: true }, { storage: bare }), true);
  assert.deepEqual(bare.json(DEVICE_CONFIG_KEY), CFG);
});

test('keepStoredMaster: a fallback config for the same profile keeps the stored answer; another profile does not', () => {
  const { env } = till();
  // The offline profile cache and the minimal config carry no master answer.
  assert.deepEqual(keepStoredMaster({ profileId: 'prof-1', profileName: 'POS' }, env), { profileId: 'prof-1', profileName: 'POS', isMaster: true });
  assert.deepEqual(keepStoredMaster({ profileId: 'prof-2' }, env), { profileId: 'prof-2' });
  const child = till({ ...STAMPED, isMaster: false });
  assert.deepEqual(keepStoredMaster({ profileId: 'prof-1', isMaster: true }, child.env), { profileId: 'prof-1', isMaster: false });
  // Nothing stored, or junk: the config as it is.
  assert.deepEqual(keepStoredMaster({ profileId: 'prof-1' }, till(null).env), { profileId: 'prof-1' });
  assert.deepEqual(keepStoredMaster({ profileId: 'prof-1' }, { storage: fake() }), { profileId: 'prof-1' });
  assert.deepEqual(keepStoredMaster({ profileId: 'prof-1' }), { profileId: 'prof-1' });
});

test('clearMasterFlag: only the master answer goes, in the shared copy AND the tab\'s own copy', () => {
  const storage = fake({ [DEVICE_KEY]: DEV, [DEVICE_CONFIG_KEY]: { ...STAMPED, centreId: 'pc-1', centreName: 'Food' } });
  const session = fake({ [TERMINAL_CONFIG_KEY]: { ...CFG, centreId: 'pc-1' } });
  assert.equal(clearMasterFlag({ storage, session }), true);
  assert.deepEqual(storage.json(DEVICE_CONFIG_KEY), { ...STAMPED, isMaster: false, centreId: 'pc-1', centreName: 'Food' });
  assert.deepEqual(session.json(TERMINAL_CONFIG_KEY), { ...CFG, isMaster: false, centreId: 'pc-1' });
  assert.ok(storage.has(DEVICE_KEY), 'the pairing record is kept');
  assert.equal(isMasterTillHere('loc-A', { storage, mode: 'pos', session: SESSION }), false);
  // Nothing says master any more: nothing is written.
  const a = storage.sets; const b = session.sets;
  assert.equal(clearMasterFlag({ storage, session }), false);
  assert.equal(storage.sets, a);
  assert.equal(session.sets, b);
  // Only one copy says master.
  const onlyTab = fake({ [TERMINAL_CONFIG_KEY]: CFG });
  assert.equal(clearMasterFlag({ storage: fake(), session: onlyTab }), true);
  assert.equal(onlyTab.json(TERMINAL_CONFIG_KEY).isMaster, false);
  // Junk and no storage: false, no throw.
  assert.equal(clearMasterFlag({ storage: fake({ [DEVICE_CONFIG_KEY]: '{junk' }), session: fake() }), false);
  assert.equal(clearMasterFlag(), false);
});

test('forgetDeviceConfig: a new pairing inherits nothing; the pairing record stays', () => {
  const storage = fake({ [DEVICE_KEY]: DEV, [DEVICE_CONFIG_KEY]: STAMPED, 'rpos-device-mode': 'pos' });
  const session = fake({ [TERMINAL_CONFIG_KEY]: CFG, 'rpos-session-dev-1': 'tok' });
  forgetDeviceConfig({ storage, session });
  assert.ok(!storage.has(DEVICE_CONFIG_KEY));
  assert.ok(!session.has(TERMINAL_CONFIG_KEY));
  assert.ok(storage.has(DEVICE_KEY));
  assert.ok(storage.has('rpos-device-mode'));
  assert.ok(session.has('rpos-session-dev-1'));
  assert.doesNotThrow(() => forgetDeviceConfig());
  assert.doesNotThrow(() => forgetDeviceConfig({ storage: fake(), session: fake() }));
});

test('dropAdminPlaceholder: Back Office cannot take a real till down', () => {
  // A real pairing in the same browser (a till tab beside the Back Office tab): nothing is touched.
  const real = fake({ [DEVICE_KEY]: DEV, [DEVICE_CONFIG_KEY]: STAMPED });
  assert.equal(dropAdminPlaceholder({ storage: real }), false);
  assert.deepEqual(real.json(DEVICE_KEY), DEV);
  assert.deepEqual(real.json(DEVICE_CONFIG_KEY), STAMPED);
  // The placeholder that "Access Back Office" on the pairing screen stores, and a leftover config.
  const admin = fake({ [DEVICE_KEY]: { id: 'admin', name: 'Admin', type: 'admin', locationId: null, adminMode: true }, [DEVICE_CONFIG_KEY]: CFG });
  assert.equal(dropAdminPlaceholder({ storage: admin }), true);
  assert.ok(!admin.has(DEVICE_KEY));
  assert.ok(!admin.has(DEVICE_CONFIG_KEY));
  // No pairing at all: a leftover config goes.
  const none = fake({ [DEVICE_CONFIG_KEY]: CFG });
  assert.equal(dropAdminPlaceholder({ storage: none }), true);
  assert.ok(!none.has(DEVICE_CONFIG_KEY));
  assert.equal(dropAdminPlaceholder(), false, 'no storage');
});
