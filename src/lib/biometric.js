// src/lib/biometric.js
//
// Web wrapper around the native `window.RposBiometric` bridge (Sunmi D3 Pro fingerprint).
// Mirrors the `window.RposPrinter` pattern: the native APK exposes a JS interface; the web app
// calls it and the native side calls back via `window.__rposBiometricCallback(id, ok, payloadJson)`.
//
// OFF-DEVICE (browser, non-Sunmi hardware, or before the APK ships the bridge) every call is a
// graceful no-op — callers MUST keep PIN as the fallback. The fingerprint UI is shown ONLY when
// `biometricCaps()` reports the capability, so there is zero behaviour change until the native
// bridge is live.
//
// Capability model — the bridge's isAvailable() returns a JSON string of what the device's
// fingerprint stack can actually do:
//   identify : 1:N — tap → returns WHICH staff (true fingerprint LOGIN). Needs the Sunmi SDK.
//   verify   : 1:1 — confirm the device-enrolled user (step-up). Android BiometricPrompt.
//   enroll   : register a staff member's fingerprint, associated with their staff id.
// staffRef returned by identify() is the staff id passed to enroll() (the SDK stores templates
// keyed by that id) — so the web never sees a raw fingerprint or template.

let _seq = 0;
const _pending = new Map();

if (typeof window !== 'undefined') {
  // Native → web callback. payloadJson e.g. {"staffRef":"abc"} or {"error":"..."}.
  window.__rposBiometricCallback = (callbackId, ok, payloadJson) => {
    const resolve = _pending.get(callbackId);
    if (!resolve) return;
    _pending.delete(callbackId);
    let payload = {};
    try { payload = payloadJson ? JSON.parse(payloadJson) : {}; } catch { payload = {}; }
    resolve({ ok: !!ok, ...payload });
  };
}

function bridge() {
  return (typeof window !== 'undefined' && window.RposBiometric) ? window.RposBiometric : null;
}

/** Parse the native isAvailable() result into a capability object. Pure (unit-tested). */
export function parseBiometricCaps(raw) {
  const none = { available: false, identify: false, verify: false, enroll: false };
  if (!raw) return none;
  if (raw === 'true' || raw === true) return { available: true, identify: false, verify: true, enroll: false };
  try {
    const o = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!o || typeof o !== 'object') return none;
    return { available: !!o.available, identify: !!o.identify, verify: !!o.verify, enroll: !!o.enroll };
  } catch { return none; }
}

/** Synchronous capability probe. Safe off-device → all false. */
export function biometricCaps() {
  const b = bridge();
  if (!b || typeof b.isAvailable !== 'function') return parseBiometricCaps(null);
  try { return parseBiometricCaps(b.isAvailable()); } catch { return parseBiometricCaps(null); }
}

function call(method, args) {
  return new Promise((resolve) => {
    const b = bridge();
    if (!b || typeof b[method] !== 'function') { resolve({ ok: false, error: 'unavailable' }); return; }
    const id = `bio-${Date.now()}-${++_seq}`;
    _pending.set(id, resolve);
    const timer = setTimeout(() => { if (_pending.has(id)) { _pending.delete(id); resolve({ ok: false, error: 'timeout' }); } }, 30000);
    const done = (r) => { clearTimeout(timer); return r; };
    const wrapped = (r) => resolve(done(r));
    _pending.set(id, wrapped);
    try { b[method](...args, id); } catch (e) { _pending.delete(id); clearTimeout(timer); resolve({ ok: false, error: String(e?.message || e) }); }
  });
}

/** 1:N identify → { ok, staffRef? } : which staff member tapped (true fingerprint login). */
export function biometricIdentify() { return call('identify', []); }

/** 1:1 verify → { ok } : confirm the device-enrolled user (manager step-up / unlock). */
export function biometricVerify(reason = 'Confirm') { return call('verify', [String(reason)]); }

/** Enroll a staff member's fingerprint, associated with their staff id → { ok, templateId? }. */
export function biometricEnroll(staffRef, label = '') { return call('enroll', [String(staffRef), String(label)]); }
