// src/lib/masterTill.test.js
//
// The ONE rule for "am I this venue's master till" (lib/masterTill.js).
//
// LIVE, 12 Oct 2026, Coffee Boy Preston. QR table orders for drinks in a sub category (a Latte in
// Coffee, which sits inside Hot/Iced Coffee) landed on the Food kitchen screen. The till's own
// orders were clean. Another app instance had routed them: one whose storage said "master" and
// which held no category tree for the venue. The only test for "may this app send channel orders
// to the kitchen" was isMaster === true in localStorage 'rpos-device-config', a key shared by
// every tab, by both screens of a Sunmi, and never cleared when a till was removed.
// Peter: "both lets fix so this cant happen plus you need to fix the master thing".

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  NON_TILL_MODES, isTillMode, resolvePageMode, pairedTill, configOwner, stampDeviceConfig,
  masterFlagDiffers, carryMasterForward, masterTillDecision, masterBeatRole, hydratableConfig,
  MASTER_REFUSED_TOAST, MASTER_CHANGED_TOAST, NO_MASTER_TEXT, masterRefusedEvent,
  MASTER_SEEN_MS, agoWords, masterSetupReport,
} from './masterTill.js';
import { deviceEntryFromClaim } from './deviceFence.js';

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');

// The till as rpos-device holds it (lib/deviceFence.js deviceEntryFromClaim), secret included.
const DEV = { id: 'dev-1', name: 'POS', type: 'pos', locationId: 'loc-A', locationName: 'Preston', orgId: 'o', profileId: 'prof-1', deviceSecret: 'SECRET', pairedAt: 1 };
const CFG = { profileId: 'prof-1', profileName: 'POS', isMaster: true };
const STAMPED = { ...CFG, ownerDeviceId: 'dev-1', ownerLocationId: 'loc-A' };
// Everything right: a till mode, this page's session, the paired till, its own config, its own venue.
const OK = { mode: 'pos', sessionDeviceId: 'dev-1', device: DEV, config: STAMPED, venueId: 'loc-A' };
const TILL_MODES = ['pos', 'kds', 'bar', 'tables', 'orders', 'ai'];

// ── modes ────────────────────────────────────────────────────────────────────

test('isTillMode: pos, kds, bar, tables, orders, ai and an unknown word are till modes; nothing and every named non till mode are not', () => {
  for (const mode of [...TILL_MODES, 'whatever']) assert.equal(isTillMode(mode), true, mode);
  for (const mode of ['', null, undefined, ...NON_TILL_MODES]) assert.equal(isTillMode(mode), false, String(mode));
  assert.ok(Object.isFrozen(NON_TILL_MODES));
  assert.deepEqual([...NON_TILL_MODES], ['office', 'backoffice', 'admin', 'kiosk', 'customer-display', 'owner', 'menuboard', 'orderscreen',
    'readerdemo', 'ops', 'waitlist', 'bookings', 'staff', 'manager', 'mpos', 'clock', 'ryft-test']);
});

test('every mode App.jsx routes away is named, so a new surface cannot become a master by accident', () => {
  const app = read('../App.jsx');
  const routed = new Set([...app.matchAll(/deviceMode === '([a-z_-]+)'/g)].map((x) => x[1]));
  assert.ok(routed.size >= 16, 'App.jsx still names its modes this way');
  for (const m of routed) assert.ok(NON_TILL_MODES.includes(m), 'name the new surface in NON_TILL_MODES: ' + m);
  assert.match(app, /urlMode === 'ryft-test'/);
  assert.ok(NON_TILL_MODES.includes('ryft-test'));
  // The rear screen of a Sunmi till and a handset: the two that share a till's storage or profile.
  assert.ok(NON_TILL_MODES.includes('customer-display'));
  assert.ok(NON_TILL_MODES.includes('mpos'));
});

test('resolvePageMode: the address wins over the stored mode both ways round (one storage, two Sunmi screens)', () => {
  // The till screen loads ?mode=pos while the shared key says customer-display, and the other way round.
  assert.equal(resolvePageMode({ urlMode: 'pos', storedAtLoad: 'customer-display' }), 'pos');
  assert.equal(resolvePageMode({ urlMode: 'customer-display', storedAtLoad: 'pos' }), 'customer-display');
  // No mode in the address: the mode that was stored when the page loaded.
  assert.equal(resolvePageMode({ urlMode: '', storedAtLoad: 'pos' }), 'pos');
  assert.equal(resolvePageMode({ urlMode: null, storedAtLoad: 'office' }), 'office');
  assert.equal(resolvePageMode({}), '');
  assert.equal(resolvePageMode(), '');
});

// ── the paired till and whose config it is ───────────────────────────────────

test('pairedTill: a claimed device gives id, name and venue, and never the secret', () => {
  const entry = deviceEntryFromClaim({ device_id: 'd9', name: 'POS 1', type: 'pos', location_id: 'loc-Z', location: { name: 'Leeds' }, profile_id: 'p', device_secret: 'TOP-SECRET' });
  const till = pairedTill(entry);
  assert.deepEqual(till, { id: 'd9', name: 'POS 1', locationId: 'loc-Z' });
  assert.ok(!JSON.stringify(till).includes('TOP-SECRET'));
  // The whole way through the rule, straight from a claim (written before the stamp existed).
  assert.equal(masterTillDecision({ mode: 'pos', sessionDeviceId: 'd9', device: entry, config: { isMaster: true }, venueId: 'loc-Z' }).master, true);
});

test('pairedTill: the Back Office placeholder, a row with no venue, nothing and junk are not a paired till; the type is never tested', () => {
  // PairingScreen "Access Back Office" stores this in rpos-device.
  assert.equal(pairedTill({ id: 'admin', name: 'Admin', type: 'admin', locationId: null, adminMode: true }), null);
  assert.equal(pairedTill({ id: 'admin', locationId: 'loc-A' }), null);
  assert.equal(pairedTill({ id: 'dev-1', adminMode: true, locationId: 'loc-A' }), null);
  assert.equal(pairedTill({ id: 'dev-1', name: 'POS' }), null);
  assert.equal(pairedTill({ name: 'POS', locationId: 'loc-A' }), null);
  for (const junk of [null, undefined, 'x', 7, []]) assert.equal(pairedTill(junk), null);
  // A kiosk TYPE row paired on a till's pairing screen is a paired till: the page mode decides, not the type.
  assert.deepEqual(pairedTill({ id: 'k1', name: 'Kiosk 1', type: 'kiosk', locationId: 'loc-A' }), { id: 'k1', name: 'Kiosk 1', locationId: 'loc-A' });
  assert.deepEqual(pairedTill({ id: 'n1', locationId: 'loc-A' }), { id: 'n1', name: null, locationId: 'loc-A' });
});

test('configOwner: none, unstamped, own, other; a device stamp with no venue stamp is never a mismatch', () => {
  const till = pairedTill(DEV);
  assert.equal(configOwner(null, till), 'none');
  assert.equal(configOwner(undefined, till), 'none');
  assert.equal(configOwner('junk', till), 'none');
  assert.equal(configOwner(CFG, till), 'unstamped');
  assert.equal(configOwner({ ...CFG, ownerDeviceId: '' }, till), 'unstamped');
  assert.equal(configOwner({ ...CFG, ownerDeviceId: null, ownerLocationId: 'loc-A' }, till), 'unstamped');
  assert.equal(configOwner(STAMPED, till), 'own');
  assert.equal(configOwner({ ...CFG, ownerDeviceId: 'dev-1' }, till), 'own');
  assert.equal(configOwner({ ...CFG, ownerDeviceId: 'dev-9', ownerLocationId: 'loc-A' }, till), 'other');
  assert.equal(configOwner({ ...CFG, ownerDeviceId: 'dev-1', ownerLocationId: 'loc-B' }, till), 'other');
  assert.equal(configOwner(STAMPED, null), 'other');
});

test('stampDeviceConfig: adds the two keys, replaces an old stamp, strips it when there is no till, never changes its input', () => {
  const till = pairedTill(DEV);
  const input = { ...CFG };
  assert.deepEqual(stampDeviceConfig(input, till), STAMPED);
  assert.deepEqual(input, CFG, 'the input is not changed');
  assert.deepEqual(stampDeviceConfig({ ...CFG, ownerDeviceId: 'old', ownerLocationId: 'old-loc' }, till), STAMPED);
  assert.deepEqual(stampDeviceConfig({ ...CFG, ownerDeviceId: 'x', ownerLocationId: 'y' }, null), CFG);
  assert.deepEqual(stampDeviceConfig(null, till), { ownerDeviceId: 'dev-1', ownerLocationId: 'loc-A' });
  assert.deepEqual(stampDeviceConfig(undefined, null), {});
});

// ── THE rule ─────────────────────────────────────────────────────────────────

test('masterTillDecision, the master: its own stamped config, a till mode, this page holds the session, its own venue', () => {
  assert.deepEqual(masterTillDecision(OK), { master: true, reason: 'ok', storedMaster: true });
  // Asked with no venue (the catering sweep asks before it has resolved one).
  for (const venueId of [undefined, null, '']) {
    assert.deepEqual(masterTillDecision({ ...OK, venueId }), { master: true, reason: 'ok', storedMaster: true }, String(venueId));
  }
});

test('masterTillDecision, the update moment: an UNSTAMPED master config counts in every till mode, so no real till stops', () => {
  for (const mode of TILL_MODES) {
    assert.deepEqual(masterTillDecision({ ...OK, mode, config: CFG }), { master: true, reason: 'ok', storedMaster: true }, mode);
  }
});

test('masterTillDecision, never in a non till mode: a perfect master config with a session still answers "mode"', () => {
  // Back Office, the rear customer display, a handset, the clock, bookings, the kiosk: all of them.
  for (const mode of [...NON_TILL_MODES, '', null, undefined]) {
    assert.deepEqual(masterTillDecision({ ...OK, mode }), { master: false, reason: 'mode', storedMaster: true }, String(mode));
    assert.equal(masterTillDecision({ ...OK, mode, config: CFG }).master, false, 'unstamped, ' + String(mode));
  }
});

test('masterTillDecision, the page must hold the session: the pairing screen, a kicked second tab and "Checking device" are never the master', () => {
  assert.deepEqual(masterTillDecision({ ...OK, sessionDeviceId: null }), { master: false, reason: 'session', storedMaster: true });
  assert.equal(masterTillDecision({ ...OK, sessionDeviceId: undefined }).reason, 'session');
  assert.equal(masterTillDecision({ ...OK, sessionDeviceId: '' }).reason, 'session');
  // A session for another device (a re pair in the same page before the reload).
  assert.equal(masterTillDecision({ ...OK, sessionDeviceId: 'dev-2' }).reason, 'session');
});

test('masterTillDecision, the other reasons, each one named', () => {
  assert.deepEqual(masterTillDecision({ ...OK, device: { id: 'admin', adminMode: true, locationId: null } }), { master: false, reason: 'unpaired', storedMaster: true });
  assert.equal(masterTillDecision({ ...OK, device: null }).reason, 'unpaired');
  assert.deepEqual(masterTillDecision({ ...OK, config: null }), { master: false, reason: 'no-config', storedMaster: false });
  assert.deepEqual(masterTillDecision({ ...OK, config: { ...CFG, ownerDeviceId: 'dev-9', ownerLocationId: 'loc-A' } }), { master: false, reason: 'other-device', storedMaster: true });
  assert.deepEqual(masterTillDecision({ ...OK, config: { ...CFG, ownerDeviceId: 'dev-1', ownerLocationId: 'loc-B' } }), { master: false, reason: 'other-device', storedMaster: true });
  // The flag was cleared (removed in Back Office, unpaired, no profile) or never set.
  assert.deepEqual(masterTillDecision({ ...OK, config: { ...STAMPED, isMaster: false } }), { master: false, reason: 'not-master', storedMaster: false });
  assert.equal(masterTillDecision({ ...OK, config: { profileId: 'prof-1' } }).reason, 'not-master');
  assert.equal(masterTillDecision({ ...OK, config: { ...STAMPED, isMaster: 'true' } }).reason, 'not-master', 'only the boolean true');
  assert.deepEqual(masterTillDecision({ ...OK, venueId: 'loc-B' }), { master: false, reason: 'venue', storedMaster: true });
  // Nothing at all: not master, and it does not throw.
  assert.deepEqual(masterTillDecision(), { master: false, reason: 'mode', storedMaster: false });
  assert.deepEqual(masterTillDecision({}), { master: false, reason: 'mode', storedMaster: false });
});

test('two venues: a config stamped at venue A is not honoured in a browser now paired at venue B, and a till never routes another venue', () => {
  const atB = { ...DEV, id: 'dev-2', locationId: 'loc-B' };
  // The old till's config was left in storage (PairingScreen used to keep it).
  assert.equal(masterTillDecision({ mode: 'pos', sessionDeviceId: 'dev-2', device: atB, config: STAMPED, venueId: 'loc-B' }).reason, 'other-device');
  // The same device moved venue: its old stamp names the old venue.
  const moved = { ...DEV, locationId: 'loc-B' };
  assert.equal(masterTillDecision({ mode: 'pos', sessionDeviceId: 'dev-1', device: moved, config: STAMPED, venueId: 'loc-B' }).reason, 'other-device');
  // The master of venue A asked about venue B's orders.
  assert.equal(masterTillDecision({ ...OK, venueId: 'loc-B' }).reason, 'venue');
  assert.equal(masterTillDecision({ ...OK, config: CFG, venueId: 'loc-B' }).reason, 'venue', 'unstamped too');
});

test('carryMasterForward: a config that did not come from the profile row keeps the stored answer for the same profile only', () => {
  const till = pairedTill(DEV);
  // The offline profile cache and the minimal config carry no master answer.
  assert.deepEqual(carryMasterForward({ profileId: 'prof-1' }, CFG, till), { profileId: 'prof-1', isMaster: true });
  assert.deepEqual(carryMasterForward({ profileId: 'prof-1', isMaster: true }, { profileId: 'prof-1', isMaster: false }, till), { profileId: 'prof-1', isMaster: false });
  assert.deepEqual(carryMasterForward({ profileId: 'prof-1' }, STAMPED, till), { profileId: 'prof-1', isMaster: true });
  // Another profile, a config stamped for another device, no stored config, no till: left as it is.
  assert.deepEqual(carryMasterForward({ profileId: 'prof-2' }, CFG, till), { profileId: 'prof-2' });
  assert.deepEqual(carryMasterForward({ profileId: 'prof-1' }, { ...CFG, ownerDeviceId: 'dev-9' }, till), { profileId: 'prof-1' });
  assert.deepEqual(carryMasterForward({ profileId: 'prof-1' }, null, till), { profileId: 'prof-1' });
  assert.deepEqual(carryMasterForward({ profileId: 'prof-1' }, CFG, null), { profileId: 'prof-1' });
  assert.deepEqual(carryMasterForward({ profileId: 'prof-1' }, { isMaster: true }, till), { profileId: 'prof-1' }, 'a stored config with no profile');
  assert.equal(carryMasterForward(null, CFG, till), null);
});

test('masterFlagDiffers: true only when exactly one side says master', () => {
  assert.equal(masterFlagDiffers({ isMaster: true }, { isMaster: false }), true);
  assert.equal(masterFlagDiffers({ isMaster: true }, {}), true);
  assert.equal(masterFlagDiffers(null, { isMaster: true }), true);
  assert.equal(masterFlagDiffers({ isMaster: true }, { isMaster: true }), false);
  assert.equal(masterFlagDiffers({ isMaster: false }, {}), false);
  assert.equal(masterFlagDiffers(undefined, null), false);
});

// ── Back Office: is the master set up right? (D9) ────────────────────────────

const NOW = Date.parse('2026-10-12T15:00:00Z');
const PROFS = [{ id: 'pm', is_master: true }, { id: 'pn', is_master: false }];
const dev = (id, name, status = 'active', profile_id = 'pm', type = 'pos') => ({ id, name, type, status, profile_id });
const seen = (device_id, role, msAgo) => ({ device_id, role, last_seen: new Date(NOW - msAgo).toISOString() });

test('masterSetupReport, counting: only a live till (type pos, active or online) on a master profile is a master', () => {
  // Nothing read, or no devices: say nothing rather than warn wrongly.
  assert.deepEqual(masterSetupReport({ devices: [], profiles: PROFS }), { masters: [], lines: [] });
  assert.deepEqual(masterSetupReport({ devices: [dev('a', 'A')], profiles: null }), { masters: [], lines: [] });
  assert.deepEqual(masterSetupReport({ devices: null, profiles: PROFS }), { masters: [], lines: [] });
  assert.deepEqual(masterSetupReport(), { masters: [], lines: [] });
  // No till on a master profile at all (the Leeds shape: one till, no master profile).
  assert.deepEqual(masterSetupReport({ devices: [dev('a', 'POS', 'active', 'pn')], profiles: PROFS }).lines, [{ level: 'error', text: NO_MASTER_TEXT }]);
  // Birmingham: the only till on the master profile is unpaired.
  assert.deepEqual(masterSetupReport({ devices: [dev('a', 'Mickey', 'unpaired')], profiles: PROFS }).lines, [{ level: 'error', text: NO_MASTER_TEXT }]);
  // Removed rows are not counted.
  assert.deepEqual(masterSetupReport({ devices: [dev('a', 'Old', 'removed'), dev('b', 'KDS', 'active', null, 'kds')], profiles: PROFS }).lines, [{ level: 'error', text: NO_MASTER_TEXT }]);
  // Coffee Boy Barnsley: a kiosk TYPE row sits on the master profile beside the one real master. No "more than one".
  const barnsley = masterSetupReport({ devices: [dev('a', 'POS 1'), dev('k', 'Kiosk 1', 'online', 'pm', 'kiosk')], profiles: PROFS });
  assert.deepEqual(barnsley, { masters: [{ id: 'a', name: 'POS 1' }], lines: [] });
  // A handheld on a master profile is not a master either.
  assert.deepEqual(masterSetupReport({ devices: [dev('h', 'Handheld', 'active', 'pm', 'handheld')], profiles: PROFS }).lines, [{ level: 'error', text: NO_MASTER_TEXT }]);
  // Provo: two live tills on master profiles. Named, and said to be safe.
  const provo = masterSetupReport({ devices: [dev('a', 'Apple Test POS'), dev('b', 'Sunmi', 'online'), dev('c', 'TEst 1', 'unpaired')], profiles: PROFS });
  assert.deepEqual(provo.masters, [{ id: 'a', name: 'Apple Test POS' }, { id: 'b', name: 'Sunmi' }]);
  assert.deepEqual(provo.lines, [{ level: 'warn', text: 'More than one master till: Apple Test POS, Sunmi. This is safe, each order is sent once. One is enough.' }]);
  // A till with no name.
  assert.deepEqual(masterSetupReport({ devices: [dev('a', ''), dev('b', null)], profiles: PROFS }).lines[0].text,
    'More than one master till: A till, A till. This is safe, each order is sent once. One is enough.');
});

test('masterSetupReport, live facts: one line per master from its own heartbeat row', () => {
  const one = [dev('a', 'POS')];
  const line = (heartbeats) => masterSetupReport({ devices: one, profiles: PROFS, heartbeats, now: NOW }).lines;
  assert.deepEqual(line([seen('a', 'master', 30_000)]), [{ level: 'ok', text: 'Master till POS is on.' }]);
  assert.deepEqual(line([seen('a', 'child', 30_000)]), [{ level: 'error', text: 'POS is set as master but is running as a normal till. Restart it.' }]);
  assert.deepEqual(line([seen('a', 'master', 14 * 3600_000)]), [{ level: 'warn', text: 'Master till POS was last seen 14 hours ago. While it is off, QR, online and kiosk orders wait.' }]);
  assert.deepEqual(line([]), [{ level: 'warn', text: 'Master till POS has not been seen yet. Open it to start sending orders to the kitchen.' }]);
  // Preston: the heartbeat row of the deleted "Test" till still says master. It is not this till's row.
  assert.deepEqual(line([seen('ghost', 'master', 5 * 86_400_000)]), [{ level: 'warn', text: 'Master till POS has not been seen yet. Open it to start sending orders to the kitchen.' }]);
  assert.deepEqual(line([seen('ghost', 'master', 5 * 86_400_000), seen('a', 'master', 10_000)]), [{ level: 'ok', text: 'Master till POS is on.' }]);
  // The seen window is two minutes, edge included.
  assert.equal(MASTER_SEEN_MS, 120_000);
  assert.equal(line([seen('a', 'master', MASTER_SEEN_MS)])[0].level, 'ok');
  assert.equal(line([seen('a', 'master', MASTER_SEEN_MS + 1)])[0].level, 'warn');
  // An old child row is "last seen", not "running as a normal till".
  assert.equal(line([seen('a', 'child', 3 * 3600_000)])[0].text, 'Master till POS was last seen 3 hours ago. While it is off, QR, online and kiosk orders wait.');
  // A junk time reads as never seen.
  assert.equal(line([{ device_id: 'a', role: 'master', last_seen: 'junk' }])[0].level, 'warn');
  // Heartbeats not read: the set up lines only.
  assert.deepEqual(masterSetupReport({ devices: one, profiles: PROFS, heartbeats: null, now: NOW }).lines, []);
  // Two masters: the "more than one" line, then one line each.
  const two = masterSetupReport({ devices: [dev('a', 'Apple Test POS'), dev('b', 'Sunmi')], profiles: PROFS, heartbeats: [seen('a', 'master', 30_000), seen('b', 'child', 30_000)], now: NOW }).lines;
  assert.deepEqual(two.map((l) => l.level), ['warn', 'ok', 'error']);
  assert.equal(two[1].text, 'Master till Apple Test POS is on.');
  assert.equal(two[2].text, 'Sunmi is set as master but is running as a normal till. Restart it.');
});

test('masterSetupReport: a row of another type counts ONLY when its own heartbeat says it runs as master (review, 12 Oct 2026)', () => {
  // The rule on the till never looks at the row's type, so a kiosk TYPE row opened on the till
  // address with a master profile is a real master. The Devices screen used to miss it.
  const kiosk = dev('k', 'Kiosk 1', 'online', 'pm', 'kiosk');
  const report = (devices, heartbeats) => masterSetupReport({ devices, profiles: PROFS, heartbeats, now: NOW });
  // It is the venue's only master and it is running: no false "No master till".
  assert.deepEqual(report([kiosk], [seen('k', 'master', 20_000)]), { masters: [{ id: 'k', name: 'Kiosk 1' }], lines: [{ level: 'ok', text: 'Master till Kiosk 1 is on.' }] });
  // Switched off overnight: it is still the master, said as "last seen", never "No master till".
  assert.deepEqual(report([kiosk], [seen('k', 'master', 9 * 3600_000)]).lines, [{ level: 'warn', text: 'Master till Kiosk 1 was last seen 9 hours ago. While it is off, QR, online and kiosk orders wait.' }]);
  // Beside a pos master: both are named.
  const both = report([dev('a', 'POS 1'), kiosk], [seen('a', 'master', 10_000), seen('k', 'master', 10_000)]);
  assert.deepEqual(both.masters, [{ id: 'a', name: 'POS 1' }, { id: 'k', name: 'Kiosk 1' }]);
  assert.equal(both.lines[0].text, 'More than one master till: POS 1, Kiosk 1. This is safe, each order is sent once. One is enough.');
  // Coffee Boy Barnsley as it is today: Kiosk 1 on the master profile with NO heartbeat (the
  // stand alone kiosk). Not a master, no "more than one" line.
  assert.deepEqual(report([dev('a', 'POS 1'), kiosk], [seen('a', 'master', 10_000)]), { masters: [{ id: 'a', name: 'POS 1' }], lines: [{ level: 'ok', text: 'Master till POS 1 is on.' }] });
  // Provo "Kiosk": a kiosk type row that ran the till path as a CHILD. Not a master.
  assert.deepEqual(report([kiosk], [seen('k', 'child', 5 * 86_400_000)]).lines, [{ level: 'error', text: NO_MASTER_TEXT }]);
  // Its newest row decides: a master beat long ago and a child beat since is not a master.
  assert.deepEqual(report([kiosk], [seen('k', 'master', 86_400_000), seen('k', 'child', 60_000)]).lines, [{ level: 'error', text: NO_MASTER_TEXT }]);
  // A handheld the same way, and never on a profile that is not a master profile, nor when removed.
  assert.equal(report([dev('h', 'Handheld', 'active', 'pm', 'handheld')], [seen('h', 'master', 5_000)]).masters.length, 1);
  assert.deepEqual(report([dev('k', 'Kiosk 1', 'online', 'pn', 'kiosk')], [seen('k', 'master', 5_000)]).lines, [{ level: 'error', text: NO_MASTER_TEXT }]);
  assert.deepEqual(report([dev('k', 'Kiosk 1', 'removed', 'pm', 'kiosk')], [seen('k', 'master', 5_000)]).lines, [{ level: 'error', text: NO_MASTER_TEXT }]);
  // Heartbeats not read: only type pos rows can be counted, as before.
  assert.deepEqual(report([kiosk], null).lines, [{ level: 'error', text: NO_MASTER_TEXT }]);
});

// ── the heartbeat follows the rule (review, 12 Oct 2026) ─────────────────────

test('masterBeatRole: master while the rule says yes, child while this page still holds the session, nothing at all without it', () => {
  assert.equal(masterBeatRole(masterTillDecision(OK)), 'master');
  // Still this till's page, no longer the master: the row says so, and the Devices screen reads
  // "is set as master but is running as a normal till".
  assert.equal(masterBeatRole(masterTillDecision({ ...OK, config: { ...STAMPED, isMaster: false } })), 'child');   // the answer was cleared
  assert.equal(masterBeatRole(masterTillDecision({ ...OK, config: null })), 'child');                               // the config was wiped
  assert.equal(masterBeatRole(masterTillDecision({ ...OK, config: { ...STAMPED, ownerDeviceId: 'dev-9' } })), 'child');
  assert.equal(masterBeatRole(masterTillDecision({ ...OK, venueId: 'loc-B' })), 'child');
  // No till session on this page: "This terminal has been disconnected" (another session holds
  // the device and its heartbeat row), the pairing screen of a removed till, a page that turned
  // into Back Office. It writes NOTHING, so two pages never flap one row between two roles.
  assert.equal(masterBeatRole(masterTillDecision({ ...OK, sessionDeviceId: null })), null);
  assert.equal(masterBeatRole(masterTillDecision({ ...OK, sessionDeviceId: 'dev-2' })), null);
  assert.equal(masterBeatRole(masterTillDecision({ ...OK, device: null })), null);
  assert.equal(masterBeatRole(masterTillDecision({ ...OK, mode: 'office' })), null);
  // Every reason the rule can give has an answer here, and junk writes nothing.
  const answers = { ok: 'master', mode: null, unpaired: null, session: null, 'no-config': 'child', 'other-device': 'child', 'not-master': 'child', venue: 'child' };
  for (const [reason, role] of Object.entries(answers)) {
    assert.equal(masterBeatRole({ master: reason === 'ok', reason }), role, reason);
  }
  for (const junk of [null, undefined, {}, { reason: 'new-reason' }, { master: 'yes', reason: 'ok' }]) assert.equal(masterBeatRole(junk), null);
});

// ── what a page may start from (review, 12 Oct 2026) ─────────────────────────

test('hydratableConfig: the paired till\'s own page starts from its config as before, stamped or not', () => {
  const training = { ...CFG, trainingMode: true };
  for (const mode of [...TILL_MODES, 'mpos']) {
    assert.equal(hydratableConfig({ mode, device: DEV, config: training, venueTag: 'loc-A' }), training, mode);
    assert.deepEqual(hydratableConfig({ mode, device: DEV, config: { ...STAMPED, trainingMode: true }, venueTag: 'loc-A' }), { ...STAMPED, trainingMode: true }, mode);
    // The tag another tab left (a Back Office tab on another venue) does not take the till's own config away.
    assert.equal(hydratableConfig({ mode, device: DEV, config: training, venueTag: 'loc-B' }), training, mode);
    assert.equal(hydratableConfig({ mode, device: DEV, config: training, venueTag: null }), training, mode);
  }
  // Before any pairing record (or with the Back Office placeholder) an unstamped config still reads, as it always did.
  assert.equal(hydratableConfig({ mode: 'pos', device: null, config: training }), training);
});

test('hydratableConfig: a page that is not the till starts from it only for the venue the browser was last used for', () => {
  const training = { ...STAMPED, trainingMode: true };
  const others = ['office', 'backoffice', 'bookings', 'waitlist', 'kiosk', 'manager', 'customer-display', 'clock', 'admin', 'owner', ''];
  for (const mode of others) {
    // Same venue: exactly as before (the fence never wiped it there).
    assert.equal(hydratableConfig({ mode, device: DEV, config: training, venueTag: 'loc-A' }), training, mode);
    assert.equal(hydratableConfig({ mode, device: DEV, config: training, venueTag: null }), training, mode + ', no tag yet');
    // The browser has since been used for venue B: the fence used to wipe the key. Now it is
    // kept for the till and simply not read here, so a Bookings page never inherits training mode.
    assert.equal(hydratableConfig({ mode, device: DEV, config: training, venueTag: 'loc-B' }), null, mode);
    // An unstamped copy (written before this release) is fenced the same way, by the paired till's venue.
    assert.equal(hydratableConfig({ mode, device: DEV, config: { ...CFG, trainingMode: true }, venueTag: 'loc-B' }), null, mode);
    // No real till paired in this browser: the config is nobody's.
    assert.equal(hydratableConfig({ mode, device: null, config: { ...CFG, trainingMode: true }, venueTag: 'loc-A' }), null, mode);
    assert.equal(hydratableConfig({ mode, device: { id: 'admin', adminMode: true, locationId: null }, config: { ...CFG, trainingMode: true } }), null, mode);
  }
});

test('hydratableConfig: a config stamped for another device or venue is nobody\'s here, in any mode; junk is nothing', () => {
  for (const mode of ['pos', 'kds', 'mpos', 'office', 'bookings']) {
    assert.equal(hydratableConfig({ mode, device: DEV, config: { ...STAMPED, ownerDeviceId: 'dev-9' }, venueTag: 'loc-A' }), null, mode);
    assert.equal(hydratableConfig({ mode, device: DEV, config: { ...STAMPED, ownerLocationId: 'loc-B' }, venueTag: 'loc-A' }), null, mode);
    assert.equal(hydratableConfig({ mode, device: null, config: STAMPED, venueTag: 'loc-A' }), null, mode + ', the till was removed');
    for (const junk of [null, undefined, 'x', 7]) assert.equal(hydratableConfig({ mode, device: DEV, config: junk }), null);
  }
  assert.equal(hydratableConfig(), null);
});

test('agoWords: just now, minutes, hours, days', () => {
  assert.equal(agoWords(0), 'just now');
  assert.equal(agoWords(59_000), 'just now');
  assert.equal(agoWords(60_000), '1 minute ago');
  assert.equal(agoWords(3 * 60_000), '3 minutes ago');
  assert.equal(agoWords(61 * 60_000), '1 hour ago');
  assert.equal(agoWords(14 * 3600_000), '14 hours ago');
  assert.equal(agoWords(50 * 3600_000), '2 days ago');
  assert.equal(agoWords(NaN), 'just now');
});

test('words: short, plain, no long dashes, never the text N/A', () => {
  assert.equal(MASTER_REFUSED_TOAST, 'This till is set as master but is not sending orders to the kitchen. Restart it.');
  assert.equal(MASTER_CHANGED_TOAST, 'Master till setting changed. Restart this till.');
  assert.equal(NO_MASTER_TEXT, 'No master till. QR, online and kiosk orders will not reach the kitchen.');
  const ev = masterRefusedEvent({ deviceId: 'dev-1', deviceName: 'POS' });
  assert.deepEqual(ev, {
    kind: 'ops', severity: 'urgent',
    title: 'Master till is not sending orders',
    body: 'POS is set as master but is not sending QR, online and kiosk orders to the kitchen. Restart it.',
    refType: 'master_till', refId: 'dev-1',
  });
  assert.equal(masterRefusedEvent().body, 'This till is set as master but is not sending QR, online and kiosk orders to the kitchen. Restart it.');
  assert.equal(masterRefusedEvent().refId, null);
  const reportLines = [
    ...masterSetupReport({ devices: [dev('a', 'POS', 'active', 'pn')], profiles: PROFS }).lines,
    ...masterSetupReport({ devices: [dev('a', 'A'), dev('b', 'B'), dev('c', 'C'), dev('d', 'D')], profiles: PROFS, now: NOW,
      heartbeats: [seen('a', 'master', 1000), seen('b', 'child', 1000), seen('c', 'master', 9 * 86_400_000)] }).lines,
  ].map((l) => l.text);
  assert.equal(reportLines.length, 6, 'every kind of line is in the list');
  const words = [MASTER_REFUSED_TOAST, MASTER_CHANGED_TOAST, NO_MASTER_TEXT, ev.title, ev.body, ...reportLines,
    ...[0, 60_000, 180_000, 3600_000, 7200_000, 3 * 86_400_000].map(agoWords)];
  for (const w of words) {
    assert.ok(!/[\u2013\u2014]/.test(w), 'no long dash: ' + w);
    assert.ok(!/N\/A/i.test(w), 'never N/A: ' + w);
  }
});
