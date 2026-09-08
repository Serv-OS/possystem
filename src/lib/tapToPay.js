// tapToPay.js — web-side client for the MPOS native Tap to Pay bridge (window.RposTapToPay).
//
// The Stripe Tap to Pay flow cannot run in a browser/WebView, so the MPOS Android app exposes
// a native bridge. This module is a thin, promise-based wrapper around it, with feature
// detection so every caller degrades gracefully OUTSIDE the MPOS app (desktop POS, browser,
// Sunmi devices) — there it returns isAvailable()===false and callers use their existing
// reader path (WisePOS REST / Ryft / online checkout).
//
// Native contract (see android/mpos TapToPayBridge.kt):
//   window.RposTapToPay.isAvailable()                       -> "true" on an MPOS device
//   window.RposTapToPay.init(configJson, callbackId)        -> connect the Tap to Pay reader
//   window.RposTapToPay.collectPayment(requestJson, cbId)   -> run a tap for a PaymentIntent
//   window.RposTapToPay.cancel(callbackId)                  -> cancel an in-progress tap
//   window.RposTapToPay.status(callbackId)                  -> reader/SDK readiness
// Native delivers results via window.__rposTapCallback(callbackId, resultJson).

let _seq = 0;
const _pending = new Map(); // callbackId -> { resolve }

// Single global dispatcher the native layer calls back into.
function ensureCallback() {
  if (typeof window === 'undefined') return;
  if (window.__rposTapCallback) return;
  window.__rposTapCallback = (callbackId, resultJson) => {
    const entry = _pending.get(callbackId);
    if (!entry) return;
    _pending.delete(callbackId);
    let result;
    try { result = JSON.parse(resultJson); }
    catch (e) { result = { ok: false, code: 'BAD_RESULT', message: 'Unparseable native result' }; }
    entry.resolve(result);
  };
}

function bridge() {
  return (typeof window !== 'undefined' && window.RposTapToPay) || null;
}

/** True only inside the MPOS native app (the bridge is injected there). */
export function tapToPayAvailable() {
  const b = bridge();
  try { return !!b && typeof b.isAvailable === 'function' && b.isAvailable() === 'true'; }
  catch (e) { return false; }
}

// Generic invoke: call a bridge method that takes (payloadJson?, callbackId) and resolves
// when native fires __rposTapCallback. Times out so a wedged native call can't hang the UI.
function invoke(method, payload, { timeoutMs = 120000 } = {}) {
  return new Promise((resolve) => {
    const b = bridge();
    if (!tapToPayAvailable() || !b || typeof b[method] !== 'function') {
      resolve({ ok: false, code: 'UNAVAILABLE', message: 'Tap to Pay bridge not available' });
      return;
    }
    ensureCallback();
    const callbackId = `tap_${Date.now()}_${++_seq}`;
    let done = false;
    const settle = (r) => { if (done) return; done = true; _pending.delete(callbackId); resolve(r); };
    _pending.set(callbackId, { resolve: settle });
    const timer = setTimeout(
      () => settle({ ok: false, code: 'TIMEOUT', message: `${method} timed out` }),
      timeoutMs
    );
    const wrap = _pending.get(callbackId);
    wrap.resolve = (r) => { clearTimeout(timer); settle(r); };
    try {
      if (payload === undefined) b[method](callbackId);
      else b[method](JSON.stringify(payload), callbackId);
    } catch (e) {
      clearTimeout(timer);
      settle({ ok: false, code: 'BRIDGE_THREW', message: String(e && e.message || e) });
    }
  });
}

/**
 * One-time setup: connect the phone's Tap to Pay reader.
 * config: { locationId, supabaseUrl, supabaseAnonKey, accessToken, stripeTerminalLocationId }
 */
export function tapInit(config) {
  return invoke('init', config, { timeoutMs: 60000 });
}

/**
 * Run a tap for a server-created PaymentIntent.
 * request: { clientSecret, paymentIntentId, amountMinor, currency, closedCheckId }
 * resolves { ok, paymentIntentId, status } or { ok:false, stage, code, message }.
 */
export function tapCollect(request) {
  return invoke('collectPayment', request, { timeoutMs: 180000 });
}

export function tapCancel() {
  return invoke('cancel', undefined, { timeoutMs: 30000 });
}

export function tapStatus() {
  return invoke('status', undefined, { timeoutMs: 15000 });
}
