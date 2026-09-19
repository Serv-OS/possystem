// src/lib/deviceLink.js: is this till still linked to its venue? (database fence stage 1,
// contract A7 to A10).
//
// Holds one small piece of state for the whole app: whether the server said this device is
// NOT the paired till any more (lost), or a write was just refused and the link has not been
// re-checked yet (suspect). The banner (components/DeviceLinkBanner.jsx) shows only on lost.
// The reconcilers ask isDeviceLinkUncertain() before believing an EMPTY read (contract A9):
// after file 2 a till without its link reads zero rows, which must never clear tables,
// orders or kitchen tickets.
//
// Nothing here writes a table. The checks are device_status (read only), the re-link in
// supabase.js linkDevice(), and device_heartbeat. While the fence functions do not exist yet
// (20260919a not run) every check answers "unsupported" and the state stays linked, which is
// exactly today's behaviour. FENCE STAGE 1 FALLBACK: after 20260919b the unsupported branch
// can go (grep that tag).
import { supabase, isMock, readLocalDevice, linkDevice, sendDeviceHeartbeat } from './supabase';
import { isPermissionError, linkStateFromStatus } from './deviceFence';

const state = { lost: false, suspect: false, reason: null, message: null, supported: null, checkedAt: 0 };
const listeners = new Set();
let _checking = null;
let _suspectTimer = null;

const emit = () => { const snap = getDeviceLinkState(); listeners.forEach((fn) => { try { fn(snap); } catch { /* listener */ } }); };
const dispatch = (name, detail) => { try { window.dispatchEvent(new CustomEvent(name, { detail })); } catch { /* no window */ } };

export function getDeviceLinkState() { return { ...state }; }
export function subscribeDeviceLink(fn) { listeners.add(fn); return () => listeners.delete(fn); }

/** True while an empty read of shared rows must be treated as unknown (contract A9). */
export function isDeviceLinkUncertain() { return state.lost === true || state.suspect === true; }

function markLinked({ relinked = false } = {}) {
  // Only a server confirmed loss releases parked writes. A refusal that turned out not to be
  // a lost link (suspect) must not: releasing would replay a write refused for another
  // reason, be refused again and loop.
  const wasLost = state.lost;
  state.lost = false; state.suspect = false; state.reason = null; state.message = null;
  state.supported = true; state.checkedAt = Date.now();
  emit();
  // Parked writes (OfflineQueue, DataSafe) go again once the till is linked again.
  if (wasLost && !relinked) dispatch('rpos-device-relinked', { outcome: 'linked' });
}

function markLost(detail = {}) {
  state.lost = true; state.suspect = false;
  state.reason = detail.reason || 'not_bound'; state.message = detail.message || null;
  state.supported = true; state.checkedAt = Date.now();
  emit();
}

function markUnsupported() {
  state.lost = false; state.suspect = false; state.supported = false; state.checkedAt = Date.now();
  emit();
}

/**
 * Ask the server. A device that is bound stays as it is; one that is not is re-linked with its
 * secret (supabase.js linkDevice). Only a clear server answer changes the banner.
 */
export function checkDeviceLink() {
  if (isMock || !supabase || !readLocalDevice()) return Promise.resolve(getDeviceLinkState());
  if (_checking) return _checking;
  _checking = (async () => {
    const local = readLocalDevice();
    try {
      const { data, error } = await supabase.rpc('device_status');
      const st = linkStateFromStatus({ data, error, localDeviceId: local && local.id });
      if (st === 'unsupported') { markUnsupported(); return getDeviceLinkState(); }
      if (st === 'unknown') return getDeviceLinkState();
      if (st === 'bound' && !state.lost && !state.suspect && local && local.deviceSecret) {
        markLinked(); return getDeviceLinkState();
      }
      // Not bound, or bound without a secret on this device, or recovering from a refusal:
      // the full re-link (it also collects a secret). It dispatches the events we listen to.
      await linkDevice({ allowLegacy: false });
    } catch { /* offline: keep the state */ }
    return getDeviceLinkState();
  })().finally(() => { _checking = null; });
  return _checking;
}

/** Heartbeat (contract A10). A heartbeat that says "not bound" starts a re-check. */
export async function deviceHeartbeat() {
  if (isMock || !supabase || !readLocalDevice()) return null;
  const res = await sendDeviceHeartbeat();
  if (!res) return null;
  if (res.unsupported) { if (state.supported !== false || state.suspect || state.lost) markUnsupported(); return res; }
  if (res.bound === false && !state.lost) checkDeviceLink();
  if (res.bound === true && (state.lost || state.suspect)) checkDeviceLink();
  return res;
}

/**
 * A write was refused (42501 or a row level security message). Hooked into the Supabase error
 * paths of SessionSync, QueueSync, OfflineQueue, DataSafe, printer.js and db.js, which fire
 * the rpos-write-refused window event so they need not import this module.
 */
export function noteWriteRefused(error) {
  if (!isPermissionError(error)) return;
  if (!readLocalDevice()) return;
  if (!state.lost) { state.suspect = true; emit(); }
  clearTimeout(_suspectTimer);
  _suspectTimer = setTimeout(() => { checkDeviceLink(); }, 1500);
}

let _started = false;
let _beatTimer = null;

/** Start once per page: boot check, wake, online, events, and the 60 s heartbeat while visible. */
export function startDeviceLinkMonitor() {
  if (_started || isMock || !supabase) return;
  if (typeof window === 'undefined') return;
  _started = true;
  window.addEventListener('rpos-device-link-lost', (e) => markLost(e?.detail || {}));
  window.addEventListener('rpos-device-relinked', () => { if (state.lost || state.suspect || state.supported !== true) { state.lost = false; state.suspect = false; state.supported = true; emit(); } });
  window.addEventListener('rpos-device-linked', () => markLinked({ relinked: false }));
  window.addEventListener('rpos-device-link-unsupported', () => markUnsupported());
  window.addEventListener('rpos-write-refused', (e) => noteWriteRefused(e?.detail));
  window.addEventListener('online', () => { checkDeviceLink(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { checkDeviceLink(); deviceHeartbeat(); }
  });
  const beat = () => { if (typeof document === 'undefined' || document.visibilityState === 'visible') deviceHeartbeat(); };
  _beatTimer = setInterval(beat, 60_000);
  beat();
}

/** For the tests and a re-pair: forget everything. */
export function resetDeviceLinkState() {
  state.lost = false; state.suspect = false; state.reason = null; state.message = null; state.supported = null; state.checkedAt = 0;
  clearTimeout(_suspectTimer);
  if (_beatTimer) { clearInterval(_beatTimer); _beatTimer = null; }
  emit();
}

/** Tell the app a Supabase write was refused. Safe to call from any module (no imports needed). */
export function reportWriteRefused(error) {
  if (!isPermissionError(error)) return;
  dispatch('rpos-write-refused', { code: error?.code || null, message: error?.message || String(error || '') });
}
