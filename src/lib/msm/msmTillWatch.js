// src/lib/msm/msmTillWatch.js
//
// MULTI SITE MENU (17 Oct 2026, v5.11.75): the till side of a head office menu update (design
// step 5). Peter: "these items need to be on the POS by X date and time". The server writes each
// venue's rows and inserts a config push with pushSource.kind 'msm'. This file makes the tills
// take that push by themselves:
//
//   * Kitchen screens, kiosks, order screens and handhelds already apply every push by themselves
//     (realtime.js). Nothing changes for them, except the catch up below.
//   * A COUNTER till takes a head office push by itself only when it is idle (msmTill.js
//     tillIsIdle): no lines in the order, no check open with lines, no payment screen, no modal.
//     It looks again every 5 seconds. Until then the Sync POS banner says the update applies when
//     this sale ends, and staff can still tap it.
//   * Catch up: Realtime never replays a push a till missed while it was offline or asleep. On
//     reconnect, on waking and every 5 minutes the till reads the id, time, kind and version of
//     its venue's newest push (one tiny read). A head office push it has not taken is read by id
//     and goes the same way.
//   * An ordinary Push to POS is never touched: it keeps today's banner exactly
//     (msmTill.isMsmAutoApply and shouldCatchUp are true only for pushSource.kind 'msm').
//   * The "Apply on counter tills automatically when idle" switch on the Publish tab sends
//     applyWhenIdle false: then a counter till shows the banner only, as today.

import { tillIsIdle, isMsmAutoApply, shouldCatchUp, APPLIED_WORDS } from './msmTill.js';

export const IDLE_CHECK_MS = 5000;
export const CATCH_UP_MS = 5 * 60 * 1000;
const UNATTENDED_SURFACES = ['kds', 'kiosk', 'orders', 'mpos'];

// What the POS screen tells us about itself (POSSurface sets it; it holds the modal states).
let ui = { paymentInProgress: false, modalOpen: false, orderLines: 0 };
export function setTillUiState(next) {
  ui = { ...ui, ...(next || {}) };
}
export function resetTillUiState() {
  ui = { paymentInProgress: false, modalOpen: false, orderLines: 0 };
}

/** The same rule realtime.js uses: an unattended device applies every push by itself. */
export function isUnattendedDevice(storage) {
  try {
    let surface = '';
    try { surface = JSON.parse(storage.getItem('rpos-device-config') || '{}')?.defaultSurface || ''; } catch { /* none */ }
    const devMode = storage.getItem('rpos-device-mode') || '';
    return UNATTENDED_SURFACES.includes(surface) || devMode === 'kiosk' || devMode === 'mpos';
  } catch {
    return false;
  }
}

/** The counter till's state for tillIsIdle, from the store, the POS screen and the page. */
export function counterTillState(state, doc = null) {
  const s = state || {};
  const walk = Array.isArray(s.walkInOrder?.items) ? s.walkInOrder.items : [];
  const table = s.activeTableId ? (Array.isArray(s.tables) ? s.tables : []).find((t) => t && t.id === s.activeTableId) : null;
  const tableLines = Array.isArray(table?.session?.items) ? table.session.items : [];
  let domModal = false;
  try { domModal = !!(doc && doc.querySelector && doc.querySelector('[aria-modal="true"],[role="dialog"]')); } catch { /* no page */ }
  return {
    lines: Math.max(walk.length, Number(ui.orderLines) || 0),
    paymentInProgress: !!ui.paymentInProgress,
    checkOpen: tableLines.length > 0,
    modalOpen: !!ui.modalOpen || !!s.pendingItem || domModal,
  };
}

// ── Which head office push this till has seen (per venue, survives a reload) ─
const seenKey = (loc) => `rpos-msm-seen:${loc}`;
export function readSeen(storage, loc) {
  try { const v = JSON.parse(storage.getItem(seenKey(loc)) || 'null'); return v && v.id ? v : null; } catch { return null; }
}
export function markSeen(storage, loc, push) {
  if (!loc || !push || !push.id) return;
  try { storage.setItem(seenKey(loc), JSON.stringify({ id: push.id, created_at: push.created_at || null })); } catch { /* best effort */ }
}

/**
 * The watcher. deps:
 *   store        the zustand store (getState: configUpdateSnapshot, configUpdateAvailable,
 *                applyConfigUpdate, setConfigUpdate, showToast, walkInOrder, tables, ...)
 *   doc          document (for open dialogs), or null
 *   timers       { setInterval, clearInterval } (tests pass fakes)
 */
export function createMsmTillWatch({ store, doc = null, timers = globalThis }) {
  let timer = null;
  let pending = null;

  const stop = () => {
    if (timer) { timers.clearInterval(timer); timer = null; }
    pending = null;
  };

  const tryApply = () => {
    const s = store.getState();
    // Applied by hand, or replaced by a newer push (an ordinary one keeps its banner): stop.
    if (!pending || !s.configUpdateAvailable || s.configUpdateSnapshot !== pending) { stop(); return false; }
    if (!tillIsIdle(counterTillState(s, doc))) return false;
    s.applyConfigUpdate();
    try { s.showToast?.(APPLIED_WORDS, 'success', 4000); } catch { /* no toast here */ }
    stop();
    return true;
  };

  /**
   * A push snapshot the store now holds (setConfigUpdate already called). Unattended devices
   * apply it themselves elsewhere; a counter till takes a head office one when idle.
   * Returns 'applied' | 'waiting' | 'banner'.
   */
  const take = (snapshot, { unattended = false } = {}) => {
    if (unattended || !isMsmAutoApply(snapshot)) return 'banner';
    stop();
    pending = snapshot;
    if (tryApply()) return 'applied';
    timer = timers.setInterval(tryApply, IDLE_CHECK_MS);
    return 'waiting';
  };

  return { take, tryApply, stop, isWaiting: () => !!pending };
}

/**
 * Catch up: should this till fetch the latest push by id?
 *   latest          { id, created_at, kind, version } (the tiny read)
 *   seen            readSeen(...)
 *   appliedVersion  the version this tab applied last (sessionStorage rpos-config-version)
 *   pendingVersion  the version waiting in the store (configUpdateSnapshot.version)
 */
export function needsCatchUp(latest, seen, appliedVersion, pendingVersion) {
  if (!shouldCatchUp(latest, seen)) return false;
  const v = latest && latest.version != null ? String(latest.version) : null;
  if (v && (v === String(appliedVersion ?? '') || v === String(pendingVersion ?? ''))) return false;
  return true;
}

/**
 * Start the catch up for one venue. deps:
 *   readLatest()       → { id, created_at, kind, version } | null   (the tiny read)
 *   readSnapshot(id)   → snapshot | null
 *   deliver(snapshot)  hands it to the same path a live push takes
 *   win                window (online, visibilitychange), or null
 * Returns stop().
 */
export function startMsmCatchUp({ locationId, storage, sessionStore, store, readLatest, readSnapshot, deliver, win = null, timers = globalThis }) {
  if (!locationId) return () => {};
  let busy = false;
  let stopped = false;
  const check = async () => {
    if (busy || stopped) return;
    busy = true;
    try {
      const latest = await readLatest();
      if (!latest || stopped) return;
      let applied = null;
      try { applied = sessionStore?.getItem('rpos-config-version') ?? null; } catch { /* none */ }
      const pendingVersion = store?.getState?.().configUpdateSnapshot?.version ?? null;
      if (!needsCatchUp(latest, readSeen(storage, locationId), applied, pendingVersion)) {
        if (latest.kind === 'msm') markSeen(storage, locationId, latest);
        return;
      }
      const snap = await readSnapshot(latest.id);
      if (!snap || stopped) return;
      markSeen(storage, locationId, latest);
      deliver(snap);
    } catch { /* a failed read changes nothing; the next tick tries again */ } finally {
      busy = false;
    }
  };
  const onOnline = () => { check(); };
  const onVisible = () => { try { if (!win.document || win.document.visibilityState === 'visible') check(); } catch { check(); } };
  if (win && win.addEventListener) {
    win.addEventListener('online', onOnline);
    try { win.document?.addEventListener?.('visibilitychange', onVisible); } catch { /* none */ }
  }
  const t = timers.setInterval(check, CATCH_UP_MS);
  return () => {
    stopped = true;
    timers.clearInterval(t);
    if (win && win.removeEventListener) {
      win.removeEventListener('online', onOnline);
      try { win.document?.removeEventListener?.('visibilitychange', onVisible); } catch { /* none */ }
    }
  };
}

// ── The kiosk (new design) reads its menu straight from the tables ──────────
/** May the kiosk read its menu again now? Only on the start screen with an empty basket. */
export function kioskMayRefresh({ pending, screen, cartCount }) {
  return !!pending && screen === 'attract' && !(Number(cartCount) > 0);
}
