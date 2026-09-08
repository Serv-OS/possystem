// src/lib/nfc.js
//
// Web wrapper around the native `window.RposNfc` bridge (NFC staff cards/fobs).
// Mirrors the printer/biometric bridge pattern. The native APK enables NFC reader mode and pushes
// each tap to the web via `window.__rposNfcTap('<uid>')`. OFF-DEVICE (browser, no NFC, before the
// APK ships the bridge) everything is a graceful no-op → callers keep PIN as the fallback.
//
// A card UID is a non-secret identifier (like a username) — we match it to staff_members.nfc_card_id.

const _tapHandlers = new Set();

if (typeof window !== 'undefined') {
  // Native → web: called on every card tap with the UID (hex string).
  window.__rposNfcTap = (rawUid) => {
    const id = normalizeCardId(rawUid);
    if (!id) return;
    for (const h of Array.from(_tapHandlers)) { try { h(id); } catch { /* ignore */ } }
  };
}

function bridge() {
  return (typeof window !== 'undefined' && window.RposNfc) ? window.RposNfc : null;
}

/** Normalise a raw card UID → uppercase hex, no separators/spaces. Pure (unit-tested). */
export function normalizeCardId(raw) {
  if (raw == null) return '';
  return String(raw).trim().replace(/[\s:\-]/g, '').toUpperCase();
}

/** Is an NFC reader available on this device? Safe off-device → false. */
export function nfcAvailable() {
  const b = bridge();
  if (!b || typeof b.isAvailable !== 'function') return false;
  try { return b.isAvailable() === 'true' || b.isAvailable() === true; } catch { return false; }
}

/**
 * Listen for card taps. `onTap(cardId)` fires on each tap. Starts the native reader.
 * Returns a stop() that removes the handler + stops the reader when the last listener leaves.
 * No-op (returns a no-op stop) off-device.
 */
export function onNfcTap(onTap) {
  const b = bridge();
  if (!b || typeof onTap !== 'function') return () => {};
  _tapHandlers.add(onTap);
  try { b.startScan && b.startScan(); } catch { /* ignore */ }
  return () => {
    _tapHandlers.delete(onTap);
    if (_tapHandlers.size === 0) { try { b.stopScan && b.stopScan(); } catch { /* ignore */ } }
  };
}

/** Capture a single tap (for enrolment) → Promise<{ ok, cardId }>. Times out after `ms`. */
export function scanCardOnce(ms = 20000) {
  return new Promise((resolve) => {
    if (!bridge()) { resolve({ ok: false, error: 'unavailable' }); return; }
    let stop = () => {};
    const timer = setTimeout(() => { stop(); resolve({ ok: false, error: 'timeout' }); }, ms);
    stop = onNfcTap((cardId) => { clearTimeout(timer); stop(); resolve({ ok: true, cardId }); });
  });
}
