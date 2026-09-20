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
//
// Fix round 2 (19 Sep 2026):
//   - confirmLinkAfterZeroRows: an update or delete that changed 0 rows asks here whether the
//     device is still linked (lib/rowWriteFence.js). The check STARTS after the write answered.
//   - getLinkEpoch: moves on every link answer, so a write that was in flight while a re-link
//     landed is sent again instead of being counted as done.
//   - deviceHeartbeat: a till that is bound but has no device secret collects it on the next
//     heartbeat (the release runs before file A, so a till that stays on screen booted without
//     one). No restart needed.
//   - confirmLinkBeforeCard: no card payment starts on a device that is not linked.
import { supabase, isMock, readLocalDevice, linkDevice, sendDeviceHeartbeat, isBackOfficeMode, isHostStandMode } from './supabase';
import {
  isPermissionError, linkStateFromStatus, heartbeatNextStep, cardLinkDecision, cardLinkRefusalMessage,
  cardLinkCheckNeeded,
} from './deviceFence';

const state = { lost: false, suspect: false, reason: null, message: null, supported: null, checkedAt: 0 };
const listeners = new Set();
let _checking = null;
let _suspectTimer = null;
let _boundAt = 0;        // when the server last said this device is linked (device_status or heartbeat)
let _unsupportedAt = 0;  // when a check last answered "the fence functions do not exist yet"
let _linkEpoch = 0;      // moves on every link answer (lib/rowWriteFence.js: a re-link during a write)

const emit = () => { const snap = getDeviceLinkState(); listeners.forEach((fn) => { try { fn(snap); } catch { /* listener */ } }); };
const dispatch = (name, detail) => { try { window.dispatchEvent(new CustomEvent(name, { detail })); } catch { /* no window */ } };

export function getDeviceLinkState() { return { ...state }; }
export function subscribeDeviceLink(fn) { listeners.add(fn); return () => listeners.delete(fn); }

/** True while an empty read of shared rows must be treated as unknown (contract A9). */
export function isDeviceLinkUncertain() { return state.lost === true || state.suspect === true; }

/** Moves on every link answer of this page (linked or relinked), from any caller. */
export function getLinkEpoch() { return _linkEpoch; }

// Counted from the moment this module loads, whether or not the monitor has started: a write
// in flight while ANY link call answered must not be judged on a check made after it.
if (typeof window !== 'undefined') {
  const bump = () => { _linkEpoch += 1; _boundAt = Date.now(); };
  try {
    window.addEventListener('rpos-device-linked', bump);
    window.addEventListener('rpos-device-relinked', bump);
  } catch { /* no window */ }
}

/** The device the fence checks: a paired till or kiosk, never Back Office or a host stand. */
function fencedDevice() {
  if (isMock || !supabase) return null;
  try { if (isBackOfficeMode() || isHostStandMode()) return null; } catch { /* mode unknown */ }
  return readLocalDevice();
}

function markLinked({ relinked = false } = {}) {
  // Only a server confirmed loss releases parked writes. A refusal that turned out not to be
  // a lost link (suspect) must not: releasing would replay a write refused for another
  // reason, be refused again and loop.
  const wasLost = state.lost;
  state.lost = false; state.suspect = false; state.reason = null; state.message = null;
  state.supported = true; state.checkedAt = Date.now();
  _boundAt = Date.now();
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
  _unsupportedAt = Date.now();
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
      if (st === 'bound') _boundAt = Date.now();
      // Fix round 2: linked AND the secret is on both sides. A till that is bound without a
      // secret (it booted before file A) goes on to the re-link below, which collects it.
      if (st === 'bound' && !state.lost && !state.suspect && local && local.deviceSecret && data && data.has_secret === true) {
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

/**
 * Heartbeat (contract A10). A heartbeat that says "not bound" starts a re-check; fix round 2:
 * one that says bound while this device (or the server) has no device secret starts the secret
 * collection (lib/deviceFence.js heartbeatNextStep), so a till already running the release when
 * file A runs collects its secret within a minute, without a restart.
 */
export async function deviceHeartbeat() {
  if (isMock || !supabase) return null;
  const local = readLocalDevice();
  if (!local) return null;
  const res = await sendDeviceHeartbeat();
  if (!res) return null;
  if (res.unsupported) {
    _unsupportedAt = Date.now();
    if (state.supported !== false || state.suspect || state.lost) markUnsupported();
    return res;
  }
  const linkState = linkStateFromStatus({ data: res, localDeviceId: local.id });
  if (linkState === 'bound') {
    _boundAt = Date.now();
    if (state.supported !== true) { state.supported = true; emit(); }
  }
  const next = heartbeatNextStep({
    linkState, serverHasSecret: res.has_secret === true, localHasSecret: !!local.deviceSecret,
    lost: state.lost, suspect: state.suspect,
  });
  if (next !== 'none') checkDeviceLink();
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

// ── Fix round 2: the link behind a write that changed 0 rows ─────────────────

const ZERO_BATCH_MS = 40;          // writes that answer within this window share one check
const STATUS_TIMEOUT_MS = 8000;    // a device_status that never answers counts as "could not check"
let _zeroBatch = null;

function deviceStatusWithin(ms) {
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const finish = (r) => { if (!settled) { settled = true; clearTimeout(timer); resolve(r); } };
    // A plain setTimeout call (never a method of an object: Illegal invocation in browsers).
    timer = setTimeout(() => finish({ data: null, error: { message: 'device_status timed out' } }), ms);
    let call;
    try { call = supabase.rpc('device_status'); }
    catch (e) { finish({ data: null, error: e || { message: 'failed' } }); return; }
    Promise.resolve(call).then(
      (r) => finish(r || { data: null, error: { message: 'no answer' } }),
      (e) => finish({ data: null, error: e || { message: 'failed' } }),
    );
  });
}

function noteStatusAnswer(st) {
  if (st === 'bound') {
    _boundAt = Date.now();
    if (state.supported !== true) { state.supported = true; emit(); }
    // The monitor still thinks the link is lost: let the normal check clear the banner (and
    // dispatch the relinked event that releases parked writes).
    if (state.lost || state.suspect) checkDeviceLink();
  } else if (st === 'unbound') {
    if (!state.lost) markLost({ reason: 'not_bound', message: 'This device is not linked to its venue.' });
  } else if (st === 'unsupported') {
    _unsupportedAt = Date.now();
    if (state.supported !== false) markUnsupported();
  }
}

/**
 * An update or delete changed 0 rows: is this device still linked? Resolves 'bound' |
 * 'unbound' | 'unsupported' | 'unknown' | 'not_device' (lib/rowWriteFence.js zeroRowDecision).
 * Writes that answer within a few milliseconds of each other share ONE device_status, which
 * starts only after all of them answered (a check started before a write answered says nothing
 * about it). 'unbound' shows the banner at once.
 */
export function confirmLinkAfterZeroRows() {
  if (!fencedDevice()) return Promise.resolve('not_device');
  if (!_zeroBatch) {
    _zeroBatch = new Promise((resolve) => {
      setTimeout(async () => {
        _zeroBatch = null;   // a write answering from now on starts its own check
        let st = 'unknown';
        try {
          const cur = readLocalDevice();
          const { data, error } = await deviceStatusWithin(STATUS_TIMEOUT_MS);
          st = linkStateFromStatus({ data, error, localDeviceId: cur && cur.id });
        } catch { st = 'unknown'; }
        try { noteStatusAnswer(st); } catch { /* state only */ }
        resolve(st);
      }, ZERO_BATCH_MS);
    });
  }
  return _zeroBatch;
}

// ── Fix round 2: no card payment on a device that is not linked ──────────────

const CARD_GATE_REUSE_MS = 5000;        // two checks for one payment (the modal, then the reader start)
const CARD_STATUS_TIMEOUT_MS = 5000;    // a customer at a kiosk waits for this check: keep it short
let _cardGate = null;

/**
 * Before a reader, a terminal job, Tap to Pay or a card capture starts: is this device linked?
 * A kiosk that is not linked would take the card and then have its order refused (its
 * closed_checks insert needs the link after 20260919b), with nothing kept. Resolves
 * { ok, reason, message }. Never throws.
 */
export async function confirmLinkBeforeCard() {
  const local = fencedDevice();
  if (!local) return { ok: true, reason: 'not_device', message: null };
  if (_cardGate && _cardGate.result.ok && Date.now() - _cardGate.at < CARD_GATE_REUSE_MS) return _cardGate.result;
  // FENCE STAGE 1 FALLBACK: while the fence functions do not exist (a check said so in the last
  // 90 seconds) there is no link to check, so no round trip is added to the payment.
  if (!cardLinkCheckNeeded({
    supported: state.supported, lost: state.lost, suspect: state.suspect,
    unsupportedAgoMs: _unsupportedAt ? Date.now() - _unsupportedAt : null,
  })) {
    return { ok: true, reason: 'unsupported', message: null };
  }
  let linkState = 'unknown';
  try {
    const { data, error } = await deviceStatusWithin(CARD_STATUS_TIMEOUT_MS);
    linkState = linkStateFromStatus({ data, error, localDeviceId: local.id });
  } catch { linkState = 'unknown'; }
  let relinkOutcome = null;
  if (linkState === 'unbound') {
    // A till whose login changed re-links with its secret: one try, then decide.
    try { relinkOutcome = (await linkDevice({ allowLegacy: false }))?.outcome || null; }
    catch { relinkOutcome = null; }
  } else {
    try { noteStatusAnswer(linkState); } catch { /* state only */ }
  }
  const d = cardLinkDecision({
    linkState, relinkOutcome, lost: state.lost, supported: state.supported,
    boundAgoMs: _boundAt ? Date.now() - _boundAt : null,
  });
  if (!d.ok && linkState === 'unbound' && !state.lost) markLost({ reason: 'not_bound', message: 'This device is not linked to its venue.' });
  const result = {
    ok: d.ok,
    reason: d.reason,
    message: d.ok ? null : cardLinkRefusalMessage({ kind: local.kind, venueName: local.locationName, reason: d.reason }),
  };
  _cardGate = { at: Date.now(), result };
  return result;
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
  _boundAt = 0; _unsupportedAt = 0; _cardGate = null;
  clearTimeout(_suspectTimer);
  if (_beatTimer) { clearInterval(_beatTimer); _beatTimer = null; }
  emit();
}

/** Tell the app a Supabase write was refused. Safe to call from any module (no imports needed). */
export function reportWriteRefused(error) {
  if (!isPermissionError(error)) return;
  dispatch('rpos-write-refused', { code: error?.code || null, message: error?.message || String(error || '') });
}
