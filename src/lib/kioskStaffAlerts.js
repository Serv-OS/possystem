// src/lib/kioskStaffAlerts.js: the live side of the kiosk card problem alert on the tills.
//
// Owner's live test (14 Sep 2026): a kiosk with no card reader told the customer "ask a member
// of staff" and wrote an urgent activity event. The till beeped and flashed a 2.8 second toast,
// so nobody knew why. Now a kiosk_payment event STAYS on every till (components/KioskStaffAlert)
// until staff tap OK, which acknowledges it for every till.
//
// One queue in the store (kioskStaffAlerts), fed only from here:
//   receiveKioskAlertRow   realtime.js activity_events INSERT and UPDATE (no second channel)
//   restoreKioskAlerts     unacknowledged kiosk alerts from the last 15 minutes, when realtime
//                          starts or resubscribes and when a till alert host mounts, so a till
//                          that restarted or lost its connection still shows an open problem
//   acknowledgeKioskAlert  OK on the alert
// The wording and the queue rules are pure (lib/kioskStaffAlertView.js, tested there).
//
// Only a till mounts the host (App.jsx), never a kiosk, customer page or the Back Office.
// Where no host is mounted, realtime.js keeps its old toast and chime for these events.
import { fetchOpenActivityByRefType, fetchActivityAckState, ackActivity } from './activity';
import { isTrainingMode } from './trainingMode';
import {
  KIOSK_ALERT_REF_TYPE, KIOSK_ALERT_RESTORE_MS, isKioskStaffAlert, kioskAlertQueueAdd, kioskAlertQueueRemove,
} from './kioskStaffAlertView';

let rt = null;               // { store, locationId } while realtime runs for a real location
let lastLocationId = null;   // the location the queue belongs to (survives stop, so a switch clears it)
let hosts = 0;               // mounted KioskStaffAlert hosts on this device
const dismissed = new Set(); // keys this till closed with OK: never shown again here
const chimed = new Set();    // keys this till has already chimed for
// OKs whose write has not landed yet (id -> who). Retried on every restore (realtime
// resubscribe, host mount, the browser coming back online) until the write succeeds, so an OK
// tapped while the till was offline still clears the other tills later.
const pendingAcks = new Map();
let restoreRunning = false;
let restoreAgain = false;
let onlineListener = null;

const SET_MAX = 500;
function remember(set, key) {
  set.add(key);
  if (set.size > SET_MAX) set.delete(set.values().next().value);
}

const queueOf = (store) => {
  try { return store.getState().kioskStaffAlerts || []; } catch { return []; }
};

// Apply a queue change. Returning the same state when nothing changed keeps subscribers quiet.
function updateQueue(store, fn) {
  store.setState((s) => {
    const cur = s.kioskStaffAlerts || [];
    const next = fn(cur);
    return next === cur ? s : { kioskStaffAlerts: next };
  });
}

const realLocation = (id) => !!id && id !== 'loc-demo';

/**
 * A realtime activity_events row (INSERT or UPDATE). Queues, updates or removes a kiosk alert.
 * Returns true when a till alert host will show it, so the caller skips its toast and chime.
 */
export function receiveKioskAlertRow(store, row, { now = Date.now() } = {}) {
  try {
    if (!store || !isKioskStaffAlert(row)) return false;
    // Acknowledged on some till: remember it, so a restore that was already on its way with the
    // row still open can never bring it back here.
    if (row && (row.acked_at || row.ackedAt) && row.id) remember(dismissed, String(row.id));
    updateQueue(store, (q) => kioskAlertQueueAdd(q, row, { now, dismissed }));
    return hosts > 0;
  } catch {
    return false;
  }
}

/** realtime.js started streaming this location. A different venue from last time empties the queue. */
export function kioskAlertsRealtimeStarted(store, locationId) {
  if (!store || !realLocation(locationId)) { rt = null; return; }
  if (lastLocationId && lastLocationId !== locationId) {
    try { updateQueue(store, (q) => (q.length ? [] : q)); } catch { /* noop */ }
  }
  lastLocationId = locationId;
  rt = { store, locationId };
  restoreKioskAlerts();
}

/** realtime.js stopped. */
export function kioskAlertsRealtimeStopped() {
  rt = null;
}

/** A till alert host mounted. Returns its unregister function. */
export function registerKioskAlertHost() {
  hosts += 1;
  if (!onlineListener && typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    onlineListener = () => { restoreKioskAlerts(); };
    try { window.addEventListener('online', onlineListener); } catch { onlineListener = null; }
  }
  restoreKioskAlerts();
  let done = false;
  return () => {
    if (done) return;
    done = true;
    hosts = Math.max(0, hosts - 1);
  };
}

/**
 * Load unacknowledged kiosk alerts from the last 15 minutes into the queue, and drop waiting
 * alerts that were acknowledged elsewhere while this till was not listening. Runs only with
 * realtime on a real location and a host on screen. Calls that land while one runs are folded
 * into one more run. Never throws.
 */
export async function restoreKioskAlerts() {
  if (!rt || hosts < 1) return;
  if (restoreRunning) { restoreAgain = true; return; }
  restoreRunning = true;
  try {
    do {
      restoreAgain = false;
      const ctx = rt;
      if (!ctx || hosts < 1 || !realLocation(ctx.locationId)) break;
      await flushPendingAcks();
      const now = Date.now();
      const rows = await fetchOpenActivityByRefType(ctx.locationId, KIOSK_ALERT_REF_TYPE, {
        sinceIso: new Date(now - KIOSK_ALERT_RESTORE_MS).toISOString(),
      });
      if (rt !== ctx) { restoreAgain = !!rt; continue; }
      updateQueue(ctx.store, (q) => rows.reduce((acc, r) => kioskAlertQueueAdd(acc, r, { now, dismissed }), q));
      const open = new Set(rows.map((r) => r && r.id).filter(Boolean));
      const check = queueOf(ctx.store).map((e) => e.id).filter((id) => id && !open.has(id));
      if (check.length) {
        const states = await fetchActivityAckState(check);
        if (rt !== ctx) { restoreAgain = !!rt; continue; }
        updateQueue(ctx.store, (q) => states.reduce((acc, s) => (s && s.acked_at ? kioskAlertQueueRemove(acc, s.id) : acc), q));
      }
    } while (restoreAgain);
  } catch (e) {
    console.warn('[kioskAlert] restore failed', e?.message || e);
  } finally {
    restoreRunning = false;
  }
}

// Write the OKs that have not landed yet. Each one that succeeds is dropped; the rest wait for
// the next restore.
async function flushPendingAcks() {
  for (const [id, who] of Array.from(pendingAcks.entries())) {
    try {
      const r = await ackActivity(id, who);
      if (r?.ok) pendingAcks.delete(id);
    } catch { /* stays pending */ }
  }
}

/**
 * OK on an alert: it leaves this till at once, and the acknowledgement clears it on every other
 * till (their realtime UPDATE). A write that fails stays pending and is retried on every restore
 * (reconnect, the browser coming back online) until it lands.
 * A TRAINING till only closes it on itself: a trainee's OK must never clear a real kiosk
 * problem from the live tills (review finding, 15 Sep 2026).
 */
export async function acknowledgeKioskAlert(store, key, who = null) {
  if (!store || !key) return { ok: false };
  const item = queueOf(store).find((e) => e.key === key) || null;
  remember(dismissed, key);
  updateQueue(store, (q) => kioskAlertQueueRemove(q, key));
  // With fewer waiting, a till that was holding the maximum can load the next open ones.
  restoreKioskAlerts();
  if (!item || !item.id) return { ok: false };
  let training = false;
  try { training = isTrainingMode(); } catch { training = false; }
  if (training) return { ok: true, local: true };
  pendingAcks.set(item.id, who);
  try {
    const r = await ackActivity(item.id, who);
    if (r?.ok) pendingAcks.delete(item.id);
    else if (r?.error) console.warn('[kioskAlert] acknowledge failed, will retry', r.error);
    return r || { ok: false };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

/** Test and diagnostics only: OKs still waiting to be written. */
export function kioskAlertPendingAckCount() {
  return pendingAcks.size;
}

/** True the first time a key is seen here (so each alert chimes once on this till). */
export function markKioskAlertChimed(key) {
  if (!key || chimed.has(key)) return false;
  remember(chimed, key);
  return true;
}
