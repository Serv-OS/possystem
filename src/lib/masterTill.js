// src/lib/masterTill.js
//
// ONE rule for "am I this venue's master till" (12 Oct 2026, Peter: "you need to fix the master
// thing"). Pure: plain values in, a plain answer out, no storage, no network, so node:test pins it.
// The thin reader that gathers the values from this page and its storage is lib/masterTillDevice.js.
//
// Why it exists. At Coffee Boy Preston QR drinks landed on the Food screen. The only test for "may
// this app route channel orders" was isMaster === true in localStorage 'rpos-device-config', and
// that key is shared by every tab and (on a Sunmi) by the rear customer display, and was never
// cleared when a till was removed. So a page with no menu (the customer display, a Back Office
// tab, a removed till sat on its pairing screen) won the claim and routed with no category tree.
//
// The rule. Master only when ALL hold:
//   1. the page runs in a till mode (a mode App.jsx sends to ValidatedPOSApp);
//   2. a real till is paired in storage (not the Back Office placeholder);
//   3. THIS PAGE holds a valid till session for that device (ValidatedPOSApp said the device is
//      valid: not "Checking device", not the pairing screen, not a kicked second tab);
//   4. the stored device config belongs to that paired device (its stamp, or no stamp at all:
//      every till in the field at the moment of this update);
//   5. the config says master;
//   6. when a venue is asked about, it is the paired device's own venue.

// Every mode App.jsx returns for BEFORE ValidatedPOSApp. None of these pages can be a master,
// whatever storage holds. mpos is here on purpose: a handset never ran the master heartbeat or the
// print engines, no venue has one on a master profile, and Back Office could not see it.
export const NON_TILL_MODES = Object.freeze([
  'office', 'backoffice', 'admin', 'kiosk', 'customer-display', 'owner', 'menuboard', 'orderscreen',
  'readerdemo', 'ops', 'waitlist', 'bookings', 'staff', 'manager', 'mpos', 'clock',
]);
const NON_TILL = new Set(NON_TILL_MODES);

/** A till mode: any mode word that App.jsx lets fall through to ValidatedPOSApp (pos, kds, bar, tables, orders, ai). */
export function isTillMode(mode) {
  return typeof mode === 'string' && mode !== '' && !NON_TILL.has(mode);
}

/**
 * The page's OWN mode: the address first, else the mode that was stored when the page loaded.
 * Never the live stored key: 'rpos-device-mode' is one key for every tab and both Sunmi screens.
 */
export function resolvePageMode({ urlMode, storedAtLoad } = {}) {
  return (typeof urlMode === 'string' && urlMode) || (typeof storedAtLoad === 'string' && storedAtLoad) || '';
}

/** The paired till in storage as { id, name, locationId }, or null (nothing, junk, or the Back Office placeholder). */
export function pairedTill(device) {
  if (!device || typeof device !== 'object') return null;
  if (!device.id || device.id === 'admin' || device.adminMode || !device.locationId) return null;
  return { id: String(device.id), name: device.name ? String(device.name) : null, locationId: String(device.locationId) };
}

/**
 * Whose config is this? 'none' (no config), 'unstamped' (written before 12 Oct 2026, or by a
 * writer with no pairing), 'own' (stamped for this till), 'other' (stamped for another device or
 * venue). A missing stamp field is never a mismatch.
 */
export function configOwner(config, till) {
  if (!config || typeof config !== 'object') return 'none';
  const dev = config.ownerDeviceId ? String(config.ownerDeviceId) : '';
  const loc = config.ownerLocationId ? String(config.ownerLocationId) : '';
  if (!dev) return 'unstamped';
  if (!till) return 'other';
  if (dev !== till.id) return 'other';
  if (loc && loc !== till.locationId) return 'other';
  return 'own';
}

/** The config with the stamp of the till it was derived for (or with no stamp when there is no till). */
export function stampDeviceConfig(config, till) {
  const { ownerDeviceId: _d, ownerLocationId: _l, ...rest } = config || {};
  return till ? { ...rest, ownerDeviceId: till.id, ownerLocationId: till.locationId } : rest;
}

export function masterFlagDiffers(a, b) {
  return (a?.isMaster === true) !== (b?.isMaster === true);
}

/**
 * A config that did NOT come from a fresh read of the profile row (the offline profile cache, the
 * minimal config) keeps the stored master answer for the same profile. Only a successful read of
 * the profile row may turn master on or off.
 */
export function carryMasterForward(next, stored, till) {
  if (!next || !stored || !till) return next;
  if (configOwner(stored, till) === 'other') return next;
  if (!stored.profileId || stored.profileId !== next.profileId) return next;
  return { ...next, isMaster: stored.isMaster === true };
}

/**
 * THE rule. Returns { master, reason, storedMaster }.
 * reason: 'ok' | 'mode' | 'unpaired' | 'session' | 'no-config' | 'other-device' | 'not-master' | 'venue'.
 * storedMaster: storage says master (used to say so out loud when the rule says no).
 */
export function masterTillDecision({ mode, sessionDeviceId, device, config, venueId } = {}) {
  const storedMaster = !!config && typeof config === 'object' && config.isMaster === true;
  const no = (reason) => ({ master: false, reason, storedMaster });
  if (!isTillMode(mode)) return no('mode');
  const till = pairedTill(device);
  if (!till) return no('unpaired');
  if (!sessionDeviceId || String(sessionDeviceId) !== till.id) return no('session');
  const owner = configOwner(config, till);
  if (owner === 'none') return no('no-config');
  if (owner === 'other') return no('other-device');
  if (!storedMaster) return no('not-master');
  if (venueId != null && venueId !== '' && String(venueId) !== till.locationId) return no('venue');
  return { master: true, reason: 'ok', storedMaster: true };
}

/**
 * What the master heartbeat writes at each beat, from the rule's answer AT THAT BEAT
 * (12 Oct 2026, review). The role used to be fixed when the page loaded and the beat never
 * stopped, so a page that had stopped sending orders (disconnected by another session, removed
 * in Back Office, its master answer cleared) went on saying "master" with a fresh time, and the
 * Devices screen read "Master till is on" while nothing reached the kitchen.
 *   'master'  the rule says yes: the same row as always
 *   'child'   this page still holds the till's session but is no master now: say so
 *   null      this page holds no till session for the device (kicked, unpaired, removed, not a
 *             till page): write NOTHING. Another session may own this device's row, and two
 *             pages writing different roles to one row would flap. The row goes stale and the
 *             Devices screen says "last seen".
 */
export function masterBeatRole(verdict) {
  if (verdict && verdict.master === true) return 'master';
  const reason = verdict ? verdict.reason : null;
  return reason === 'no-config' || reason === 'other-device' || reason === 'not-master' || reason === 'venue' ? 'child' : null;
}

/**
 * May a page START from the stored device config? The store reads it at load for the device
 * settings and for training mode, in EVERY mode. 12 Oct 2026 (review): the tenant fence now
 * keeps 'rpos-device-config' when the browser moves to another venue (the till needs it), and
 * it used to wipe it. Without this rule a browser that held a training mode till for venue A
 * and was then used as Back Office, Bookings, Waitlist or a kiosk for venue B started in
 * training mode on every load, and those pages then skip their saves in silence.
 *   - a config stamped for another device or venue than the paired till is nobody's here;
 *   - the paired till's own page (a till mode, or the handset) starts from it as before;
 *   - any other page starts from it only when a real till is paired in this browser AND the
 *     venue the browser was last used for (the fence tag) is that till's venue. That is what
 *     the fence wipe used to give: same venue, unchanged; another venue, nothing.
 * Returns the config, or null.
 */
export function hydratableConfig({ mode, device, config, venueTag } = {}) {
  if (!config || typeof config !== 'object') return null;
  const till = pairedTill(device);
  if (configOwner(config, till) === 'other') return null;
  if (isTillMode(mode) || mode === 'mpos') return config;
  if (!till) return null;
  if (venueTag && String(venueTag) !== till.locationId) return null;
  return config;
}

// ── Words (short and plain) ──────────────────────────────────────────────────

export const MASTER_REFUSED_TOAST = 'This till is set as master but is not sending QR, online and kiosk orders to the kitchen. Restart it.';
export const MASTER_CHANGED_TOAST = 'Master till setting changed. Restart this till.';
export const NO_MASTER_TEXT = 'No master till. QR, online and kiosk orders will not reach the kitchen. Turn on Master POS for one till in Device profiles.';

/** The urgent activity event for a till that storage calls master while the rule says no. */
export function masterRefusedEvent({ deviceId, deviceName } = {}) {
  const name = deviceName || 'This till';
  return {
    kind: 'ops', severity: 'urgent',
    title: 'Master till is not sending orders',
    body: `${name} is set as master but is not sending QR, online and kiosk orders to the kitchen. Restart it.`,
    refType: 'master_till', refId: deviceId || null,
  };
}

// ── Back Office: is the master set up right? (D9, words only, nothing enforced) ──

export const MASTER_SEEN_MS = 2 * 60_000;
const LIVE_STATUSES = new Set(['active', 'online']);

export function agoWords(ms) {
  const m = Math.floor((Number(ms) || 0) / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return m === 1 ? '1 minute ago' : `${m} minutes ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return h === 1 ? '1 hour ago' : `${h} hours ago`;
  const d = Math.floor(h / 24);
  return `${d} days ago`;
}

/**
 * devices: rows of `devices` for one venue. profiles: rows of device_profiles (id, is_master).
 * heartbeats: rows of device_heartbeats (device_id, role, last_seen), or null when unread.
 * A master till is a row of type 'pos', status active or online, on a master profile. A kiosk
 * or handheld on a master profile is not one, nor is a removed or unpaired till.
 * 12 Oct 2026 (review): with ONE exception. The rule on the till never looks at the row's type
 * (masterTillDecision), so a row of another type that is opened on the till address with a
 * master profile really is a master. Such a row is counted when its own heartbeat says it runs
 * as master, and only then: no venue is told "No master till" while one is sending, and a
 * second master of another type is named. A kiosk row with no master heartbeat (the stand alone
 * kiosk) is still not counted.
 * Returns { masters: [{ id, name }], lines: [{ level: 'error' | 'warn' | 'ok', text }] }.
 */
export function masterSetupReport({ devices, profiles, heartbeats, now = Date.now() } = {}) {
  if (!Array.isArray(devices) || !Array.isArray(profiles) || !devices.length) return { masters: [], lines: [] };
  const masterProfiles = new Set(profiles.filter((p) => p && p.is_master === true).map((p) => p.id));
  const beatOf = (d) => (Array.isArray(heartbeats) ? heartbeats : []).filter((h) => h && h.device_id === d.id)
    .sort((a, b) => (Date.parse(b.last_seen) || 0) - (Date.parse(a.last_seen) || 0))[0];
  const rows = devices.filter((d) => d && LIVE_STATUSES.has(d.status) && d.profile_id && masterProfiles.has(d.profile_id)
    && (d.type === 'pos' || beatOf(d)?.role === 'master'));
  const nameOf = (d) => d.name || 'A till';
  const masters = rows.map((d) => ({ id: d.id, name: nameOf(d) }));
  const lines = [];
  if (!rows.length) return { masters, lines: [{ level: 'error', text: NO_MASTER_TEXT }] };
  if (rows.length > 1) lines.push({ level: 'warn', text: `More than one master till: ${rows.map(nameOf).join(', ')}. This is safe, each order is sent once. One is enough.` });
  if (Array.isArray(heartbeats)) {
    for (const d of rows) {
      const hb = beatOf(d);
      const age = hb ? now - Date.parse(hb.last_seen) : NaN;
      if (!hb || !Number.isFinite(age)) lines.push({ level: 'warn', text: `Master till ${nameOf(d)} has not been seen yet. Open it to start sending orders to the kitchen.` });
      else if (age <= MASTER_SEEN_MS && hb.role !== 'master') lines.push({ level: 'error', text: `${nameOf(d)} is set as master but is running as a normal till. Restart it.` });
      else if (age <= MASTER_SEEN_MS) lines.push({ level: 'ok', text: `Master till ${nameOf(d)} is on.` });
      else lines.push({ level: 'warn', text: `Master till ${nameOf(d)} was last seen ${agoWords(age)}. While it is off, QR, online and kiosk orders wait.` });
    }
  }
  return { masters, lines };
}
