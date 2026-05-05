// src/lib/stripeTerminal.js
// Web-side wrapper around window.RposStripeTerminal (Android Kotlin bridge).
//
// Lifecycle:
//   1. App boot: call hasStripeTerminalBridge() to detect the native side.
//   2. On login (or token refresh): pushAuthToken(supabaseJwt).
//   3. Before first use: await initialize().
//   4. Reader pairing: await ensurePermissions(), await discoverReaders(onUpdate),
//      then await connectReader(serial, locationId).
//   5. Checkout: await collectPayment({ amountMinor, currency, locationId, channel, closedCheckId }).
//
// The native bridge dispatches results via two global functions which we install
// on first import: window.dispatchPosTerminalCallback(id, payload) for promises,
// and window.dispatchPosTerminalEvent(payload) for fire-and-forget status events.

import { supabase, platformSupabase } from './supabase';

const native = () => (typeof window !== 'undefined' ? window.RposStripeTerminal : null);

export function hasStripeTerminalBridge() {
  try {
    return !!native() && native().isAvailable() === 'true';
  } catch {
    return false;
  }
}

// ── Callback plumbing ─────────────────────────────────────────────────────
const pending = new Map(); // callbackId → { resolve, reject, onUpdate? }
const eventListeners = new Set(); // (event) => void

if (typeof window !== 'undefined' && !window.__posTerminalDispatchInstalled) {
  window.dispatchPosTerminalCallback = function (callbackId, payload) {
    try {
      const handler = pending.get(callbackId);
      if (!handler) {
        console.warn('[stripeTerminal] no handler for', callbackId);
        return;
      }
      const { ok, data } = payload || {};
      // Streaming callbacks (event field set) call onUpdate but don't resolve
      // until we get { event: "complete" } or { event: "error" } / non-event.
      if (data && typeof data.event === 'string') {
        if (data.event === 'complete' || data.event === 'error') {
          pending.delete(callbackId);
          ok ? handler.resolve(data) : handler.reject(new Error(data.error || 'failed'));
        } else if (handler.onUpdate) {
          try { handler.onUpdate(data); } catch (e) { console.error(e); }
        }
        return;
      }
      pending.delete(callbackId);
      ok ? handler.resolve(data) : handler.reject(new Error(data?.error || 'failed'));
    } catch (e) {
      console.error('[stripeTerminal] dispatch failure', e);
    }
  };
  window.dispatchPosTerminalEvent = function (payload) {
    eventListeners.forEach((fn) => {
      try { fn(payload); } catch (e) { console.error(e); }
    });
  };
  window.__posTerminalDispatchInstalled = true;
}

let cbCounter = 0;
function newCallbackId() { return `cb_${Date.now()}_${++cbCounter}`; }

function call(method, args = [], onUpdate = null) {
  const bridge = native();
  if (!bridge) return Promise.reject(new Error('Native bridge not available'));
  // Best-effort: keep the token fresh on every call. Fire-and-forget — if
  // there's no session yet the token stays empty and the native side will
  // surface "no auth token" downstream.
  syncAuthTokenFromSession().catch(() => {});
  return new Promise((resolve, reject) => {
    const id = newCallbackId();
    pending.set(id, { resolve, reject, onUpdate });
    try {
      bridge[method].apply(bridge, [...args, id]);
    } catch (e) {
      pending.delete(id);
      reject(e);
    }
  });
}

// ── Public API ────────────────────────────────────────────────────────────

/** Push the current Supabase auth token into the native bridge. Idempotent. */
export async function pushAuthToken(jwt) {
  const bridge = native();
  if (!bridge) return false;
  bridge.setAuthToken(jwt || '');
  return true;
}

/** Convenience: read the current session and push its token. */
export async function syncAuthTokenFromSession() {
  const bridge = native();
  if (!bridge) return false;
  const { data } = await supabase.auth.getSession();
  bridge.setAuthToken(data?.session?.access_token || '');
  return true;
}

export function initialize() {
  return call('initialize');
}

export function checkPermissions() {
  return call('checkPermissions');
}

export function requestPermissions() {
  return call('requestPermissions');
}

/** Returns parsed { initialized, hasAuthToken, connection?, reader? }. */
export function getStatus() {
  const bridge = native();
  if (!bridge) return { initialized: false, hasAuthToken: false };
  try {
    return JSON.parse(bridge.getStatus());
  } catch {
    return { initialized: false, hasAuthToken: false };
  }
}

/**
 * Start BT discovery. `onReader(reader)` is called as readers are surfaced.
 * Resolves on `complete` event; rejects on error. Call cancelDiscovery() to stop early.
 */
export function discoverReaders(onReadersUpdate) {
  return call('discoverReaders', [], (data) => {
    if (data?.event === 'readers' && Array.isArray(data.readers)) {
      onReadersUpdate?.(data.readers);
    }
  });
}

export function cancelDiscovery() {
  return call('cancelDiscovery');
}

export function connectReader(serialNumber, locationId) {
  return call('connectReader', [serialNumber, locationId]);
}

export function disconnectReader() {
  return call('disconnectReader');
}

/**
 * Run the full collect → confirm flow on the connected reader.
 * Returns { status, paymentIntentId, amount, markup_percent, application_fee_minor }.
 */
export function collectPayment({ amountMinor, currency, locationId, channel = 'card_present', closedCheckId = null }) {
  if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
    return Promise.reject(new Error('amountMinor must be a positive integer'));
  }
  if (currency !== 'gbp' && currency !== 'usd') {
    return Promise.reject(new Error("currency must be 'gbp' or 'usd'"));
  }
  if (!locationId) return Promise.reject(new Error('locationId required'));
  return call('collectPayment', [amountMinor, currency, locationId, channel, closedCheckId || '']);
}

/** Subscribe to status events from the bridge. Returns an unsubscribe fn. */
export function onStatusEvent(fn) {
  eventListeners.add(fn);
  return () => eventListeners.delete(fn);
}

// ── POS device identity + persistent reader pairing ───────────────────────
// Each POS device has its own paired reader. We persist the pairing in
// localStorage under the same key shape used elsewhere in the app.

const POS_DEVICE_KEY = 'rpos-device';
const PAIRED_READER_KEY = 'posup-paired-reader';

export function getPosDeviceId() {
  try {
    const raw = localStorage.getItem(POS_DEVICE_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    return obj?.id || null;
  } catch { return null; }
}

/**
 * Returns the locally-saved pairing for THIS POS device:
 * { serialNumber, deviceType, label, locationId, pairedAt } or null.
 */
export function getSavedPairing() {
  try {
    const raw = localStorage.getItem(PAIRED_READER_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    // Belt-and-braces: the saved pairing must match THIS pos device id.
    if (obj?.posDeviceId && obj.posDeviceId !== getPosDeviceId()) return null;
    return obj;
  } catch { return null; }
}

export function savePairing({ serialNumber, deviceType, label, locationId }) {
  try {
    localStorage.setItem(PAIRED_READER_KEY, JSON.stringify({
      serialNumber, deviceType, label, locationId,
      posDeviceId: getPosDeviceId(),
      pairedAt: new Date().toISOString(),
    }));
    window.dispatchEvent(new CustomEvent('posup-paired-reader-updated'));
  } catch {}
}

export function clearPairing() {
  try {
    localStorage.removeItem(PAIRED_READER_KEY);
    window.dispatchEvent(new CustomEvent('posup-paired-reader-updated'));
  } catch {}
}

/**
 * On app boot, if we have a saved pairing for this POS device, attempt to
 * silently reconnect to the reader. Returns true on success, false if the
 * reader can't be found within 15s. Caller is expected to show a non-blocking
 * UI while this runs.
 */
export async function autoReconnect() {
  const saved = getSavedPairing();
  if (!saved?.serialNumber || !saved?.locationId) return false;
  if (!hasStripeTerminalBridge()) return false;
  try {
    await syncAuthTokenFromSession();
    await initialize();
    const status = getStatus();
    if (status?.reader?.serialNumber === saved.serialNumber) return true;     // already connected
    await connectReader(saved.serialNumber, saved.locationId);
    return true;
  } catch {
    return false;
  }
}

// ── Location-id resolution ────────────────────────────────────────────────
// The POS holds the Ops DB location_id. Stripe billing tables are keyed by
// the Platform DB location id (which is the same UUID for new locations but
// differs for legacy seeded ones). Resolve via Platform DB.

let platformIdCache = null;
let platformIdCachedFor = null;

export async function resolvePlatformLocationId(opsLocationId) {
  if (!opsLocationId) return null;
  if (platformIdCachedFor === opsLocationId && platformIdCache) return platformIdCache;
  if (!platformSupabase) return opsLocationId;       // fallback: assume same
  // Try direct match first (most new locations have id = ops_location_id)
  const { data: direct } = await platformSupabase
    .from('locations').select('id').eq('id', opsLocationId).maybeSingle();
  if (direct?.id) {
    platformIdCache = direct.id; platformIdCachedFor = opsLocationId;
    return direct.id;
  }
  // Fallback: lookup by ops_location_id column (for legacy seeded rows)
  const { data: byOps } = await platformSupabase
    .from('locations').select('id').eq('ops_location_id', opsLocationId).maybeSingle();
  if (byOps?.id) {
    platformIdCache = byOps.id; platformIdCachedFor = opsLocationId;
    return byOps.id;
  }
  return null;
}
