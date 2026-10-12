// src/lib/masterTillDevice.js
//
// The thin reader and the ONE writer beside lib/masterTill.js (12 Oct 2026, Peter: "you need to
// fix the master thing"). It gathers what the pure rule needs from THIS page (its mode, its till
// session) and from storage (the paired device, the device config), and it is the only code that
// writes or removes localStorage 'rpos-device-config' as a whole. No network. No import of
// lib/supabase.js, so node:test can load it; every function takes an optional `env` for tests.
//
// Three things live in memory here, per page load, on purpose:
//   the stored mode as it was when the page loaded (the key is shared by every tab and by both
//   screens of a Sunmi, and flips between 'pos' and 'customer-display' there);
//   the till session mark (set by ValidatedPOSApp in the same statement that calls the device
//   valid; storage cannot tell a kicked second tab from the good one);
//   nothing else.
import {
  resolvePageMode, pairedTill, configOwner, stampDeviceConfig, masterFlagDiffers,
  carryMasterForward, masterTillDecision, hydratableConfig,
} from './masterTill.js';
import { venueHoldsMenu, routeGateDecision, MENU_WAIT_MS } from './channelRouteGate.js';

export const DEVICE_KEY = 'rpos-device';
export const DEVICE_CONFIG_KEY = 'rpos-device-config';
export const TERMINAL_CONFIG_KEY = 'rpos-terminal-config';   // the tab's own copy (sessionStorage, the store writes it)
export const MASTER_TILL_EVENT = 'rpos-master-till-changed';
export const VENUE_TAG_KEY = 'rpos-active-location';         // the tenant fence's tag: the venue this browser was last used for (a plain id)

const safeLocal = () => { try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch { return null; } };
const safeSession = () => { try { return typeof sessionStorage !== 'undefined' ? sessionStorage : null; } catch { return null; } };
const readJson = (storage, key) => { try { return storage ? JSON.parse(storage.getItem(key) || 'null') : null; } catch { return null; } };

const STORED_MODE_AT_LOAD = (() => { try { return safeLocal()?.getItem('rpos-device-mode') || ''; } catch { return ''; } })();

/** This page's own mode: its address first, else the mode stored when the page loaded. */
export function pageMode() {
  let urlMode = '';
  try { urlMode = new URL(window.location.href).searchParams.get('mode') || ''; } catch { /* no window */ }
  return resolvePageMode({ urlMode, storedAtLoad: STORED_MODE_AT_LOAD });
}

const announce = () => { try { window.dispatchEvent(new Event(MASTER_TILL_EVENT)); } catch { /* no window */ } };

// ── This page's till session ─────────────────────────────────────────────────
let _session = null;   // { deviceId, validAt }

/** ValidatedPOSApp calls this with the paired device id when the device is valid, and with null for every other state. */
export function markTillSession(deviceId) {
  const next = deviceId ? String(deviceId) : null;
  if ((_session?.deviceId || null) === next) return;   // unchanged: the menu wait is counted from the FIRST valid moment
  _session = next ? { deviceId: next, validAt: Date.now() } : null;
  announce();
}
export function tillSession() { return _session; }

// ── Readers ──────────────────────────────────────────────────────────────────

/** The answer of the one rule for this page. env is for tests: { storage, mode, session }. */
export function readMasterTill({ venueId } = {}, env = {}) {
  const storage = env.storage || safeLocal();
  const session = 'session' in env ? env.session : _session;
  return masterTillDecision({
    mode: 'mode' in env ? env.mode : pageMode(),
    sessionDeviceId: session?.deviceId || null,
    device: readJson(storage, DEVICE_KEY),
    config: readJson(storage, DEVICE_CONFIG_KEY),
    venueId,
  });
}

export function isMasterTillHere(venueId, env) {
  return readMasterTill({ venueId }, env).master;
}

/** Who this page is, for the stamp on a ticket: id and name only, never the device secret. */
export function routerIdentity(env = {}) {
  const dev = readJson(env.storage || safeLocal(), DEVICE_KEY);
  return {
    deviceId: dev && dev.id ? String(dev.id) : null,
    deviceName: dev && dev.name ? String(dev.name) : null,
    mode: 'mode' in env ? env.mode : pageMode(),
  };
}

/**
 * The stored device config a page may START from (the store's deviceConfig and training mode
 * at load), or null. The rule is lib/masterTill.js hydratableConfig: the paired till's own page
 * as before; any other page only for the venue the browser was last used for; never a config
 * stamped for another device or venue. A fresh parse each call. env is for tests.
 */
export function hydratableDeviceConfig(env = {}) {
  try {
    const storage = env.storage || safeLocal();
    if (!storage) return null;
    return hydratableConfig({
      mode: 'mode' in env ? env.mode : pageMode(),
      device: readJson(storage, DEVICE_KEY),
      config: readJson(storage, DEVICE_CONFIG_KEY),
      venueTag: storage.getItem(VENUE_TAG_KEY),
    });
  } catch { return null; }
}

/**
 * May the AUTO route go for this venue now? 'route' | 'route-blind' | 'wait' | 'skip'
 * (lib/channelRouteGate.js). Plain and synchronous: no await is added before the claim.
 * storeState is useStore.getState().
 */
export function autoRouteGate(storeState, venueId, now = Date.now(), env = {}) {
  if (!venueId || !readMasterTill({ venueId }, env).master) return 'skip';
  const s = storeState || {};
  const session = 'session' in env ? env.session : _session;
  return routeGateDecision({
    master: true,
    booted: s.bootLocationId === venueId,
    menuReady: venueHoldsMenu({
      venueId, categories: s.menuCategories, bootLocationId: s.bootLocationId, catsReadLocationId: s._catsReadLocationId,
    }).ready,
    now,
    deadlineAt: session ? session.validAt + MENU_WAIT_MS : null,
  });
}

// ── The one writer ───────────────────────────────────────────────────────────

/**
 * Write the device config, stamped with the paired till it was derived for. Storage is rewritten
 * when the caller says the config changed (force), when what is stored is not this till's own
 * stamped copy, or when the stored master answer differs. Otherwise storage is left alone.
 * This runs OUTSIDE the App.jsx change gate on purpose: that gate compares against the in memory
 * store, which hydrates from the tab's session copy, so a flag removed from storage (a re pair in
 * the same tab, a wipe from another tab) was never put back until a cold start, and a stamp added
 * inside the gate would never have been written for an unchanged profile.
 * deviceId (12 Oct 2026, review): the device the config was READ for. The stamp is taken from
 * the pairing in storage at write time, so a page whose refresh still belonged to device X
 * could save X's profile answer as device Y's own after another tab re paired the browser.
 * When the pairing in storage is another device, nothing is written.
 * Returns true when it wrote.
 */
export function saveDeviceConfig(config, { force = false, deviceId = null } = {}, env = {}) {
  const storage = env.storage || safeLocal();
  if (!config || typeof config !== 'object' || !storage) return false;
  try {
    const paired = readJson(storage, DEVICE_KEY);
    if (deviceId && paired && paired.id && String(paired.id) !== String(deviceId)) return false;
    const till = pairedTill(paired);
    const stored = readJson(storage, DEVICE_CONFIG_KEY);
    if (!force && configOwner(stored, till) === 'own' && !masterFlagDiffers(stored, config)) return false;
    storage.setItem(DEVICE_CONFIG_KEY, JSON.stringify(stampDeviceConfig(config, till)));
    announce();
    return true;
  } catch { return false; }   // quota or private mode: the till keeps working from memory
}

/** For a config that did not come from a fresh profile read: keep the stored master answer (lib/masterTill.js carryMasterForward). */
export function keepStoredMaster(config, env = {}) {
  try {
    const storage = env.storage || safeLocal();
    return carryMasterForward(config, readJson(storage, DEVICE_CONFIG_KEY), pairedTill(readJson(storage, DEVICE_KEY)));
  } catch { return config; }
}

/**
 * This device is no longer a master (removed in Back Office, unpaired, or it has no profile).
 * Only the master answer is cleared, in the shared copy AND in this tab's own copy, so a KDS
 * keeps its centre and a till keeps its start screen. Returns true when anything was written.
 */
export function clearMasterFlag(env = {}) {
  let wrote = false;
  for (const [storage, key] of [[env.storage || safeLocal(), DEVICE_CONFIG_KEY], [env.session || safeSession(), TERMINAL_CONFIG_KEY]]) {
    try {
      const cfg = readJson(storage, key);
      if (cfg && cfg.isMaster === true) { storage.setItem(key, JSON.stringify({ ...cfg, isMaster: false })); wrote = true; }
    } catch { /* nothing to clear */ }
  }
  if (wrote) announce();
  return wrote;
}

/** A NEW pairing: the previous device's config must not be inherited (PairingScreen). Both copies go. */
export function forgetDeviceConfig(env = {}) {
  try { (env.storage || safeLocal())?.removeItem(DEVICE_CONFIG_KEY); } catch { /* none */ }
  try { (env.session || safeSession())?.removeItem(TERMINAL_CONFIG_KEY); } catch { /* none */ }
  announce();
}

/**
 * The Back Office buttons that open the POS. They used to delete the pairing and its config,
 * which unpaired a real till in another tab of the same browser. Now only the Back Office
 * placeholder ("Access Back Office" on the pairing screen) and a leftover config with no real
 * pairing are removed. Returns true when it removed them.
 */
export function dropAdminPlaceholder(env = {}) {
  try {
    const storage = env.storage || safeLocal();
    if (!storage || pairedTill(readJson(storage, DEVICE_KEY))) return false;
    storage.removeItem(DEVICE_KEY);
    storage.removeItem(DEVICE_CONFIG_KEY);
    return true;
  } catch { return false; }
}
