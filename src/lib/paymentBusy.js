// src/lib/paymentBusy.js (v5.11.1): is this device in the middle of taking money?
//
// UpdateGuard applies a new release by reloading the page. Since v5.5.870 it said it paused
// "while a payment/checkout is in progress (window.__RPOS_BUSY)", but nothing ever set that
// flag, so a release could reload a till in the middle of a card payment. Coffee Boy Leeds,
// POS 1, 27 Sep 2026: the check was minted at 13:11:44 UTC, the card machine job sent at
// 13:11:47, then the page reloaded (v5.9.89/90 had gone out at 13:09). The checkout died with
// it, a kitchen screen's reconciler booked the sale, and the refund later found no card leg.
//
// Every pay flow HOLDS this while it runs and RELEASES it when it ends:
//
//   const release = holdPaymentBusy('checkout');
//   try { ...take the money... } finally { release(); }
//
// or, in a component, lib/usePaymentBusy.js. Each hold is its own token, never one shared
// true/false or a bare counter: two flows that overlap (the checkout and the card machine job
// it sent) can never clear each other, and a release called twice does nothing the second time.
//
// An update waits while anything holds, and for PAYMENT_QUIET_MS after the last hold ended, so
// the sale's own writes (closed check, receipt) land before the page goes.
//
// Pure: no React, no network. window.__RPOS_BUSY mirrors the number of live holds for on
// device diagnostics (it used to be read and never written).

export const PAYMENT_QUIET_MS = 15_000;

const holds = new Map();          // token -> { reason, since }
const listeners = new Set();
let nextToken = 1;
let lastReleasedAt = 0;
let clock = () => Date.now();

function publish() {
  const n = holds.size;
  if (typeof window !== 'undefined') {
    try { window.__RPOS_BUSY = n; } catch { /* a locked down window never stops a payment */ }
  }
  for (const fn of [...listeners]) {
    try { fn(n); } catch { /* a listener never stops a payment */ }
  }
}
publish();   // the mirror reads 0 from page load, never undefined

/**
 * Mark this device busy taking money. Returns the release: call it exactly when the flow
 * ends (a finally, or an effect's cleanup). Calling it again is harmless.
 */
export function holdPaymentBusy(reason = 'payment') {
  const token = nextToken++;
  holds.set(token, { reason: String(reason || 'payment'), since: clock() });
  publish();
  let released = false;
  return function releasePaymentBusy() {
    if (released) return;
    released = true;
    holds.delete(token);
    lastReleasedAt = clock();
    publish();
  };
}

/** Run `fn` holding the flag; released however `fn` ends (resolve, throw or abort). */
export async function withPaymentBusy(reason, fn) {
  const release = holdPaymentBusy(reason);
  try {
    return await fn();
  } finally {
    release();
  }
}

export function isPaymentBusy() {
  return holds.size > 0;
}

export function paymentBusyCount() {
  return holds.size;
}

/** What is holding, oldest first (diagnostics). */
export function paymentBusyReasons() {
  return [...holds.values()].sort((a, b) => a.since - b.since).map(h => h.reason);
}

/**
 * The update rule, pure: never while a hold is live, nor within `quietMs` of the last one
 * ending. `lastReleasedAt` 0 means nothing has held since the page loaded.
 */
export function updateMayApply({ holdCount, lastReleasedAt: last, now, quietMs = PAYMENT_QUIET_MS }) {
  if (holdCount > 0) return false;
  if (last > 0 && now - last < quietMs) return false;
  return true;
}

/**
 * One second of UpdateGuard's countdown, pure. While an update may not apply the count holds
 * where it is (paused, never re-armed and never run down). Otherwise it counts down, or goes
 * straight to 0 when staff pressed Update now, and applies at 0.
 */
export function updateCountdownStep({ left, mayApply, nowRequested = false }) {
  if (!mayApply) return { left, waiting: true, apply: false };
  const next = nowRequested ? 0 : Math.max(0, left - 1);
  return { left: next, waiting: false, apply: next === 0 };
}

/** May an automatic update reload this page right now? */
export function canApplyUpdate(now = clock()) {
  return updateMayApply({ holdCount: holds.size, lastReleasedAt, now });
}

/** Called with the number of live holds whenever it changes. Returns the unsubscribe. */
export function subscribePaymentBusy(fn) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

// ── tests only ──────────────────────────────────────────────────────────────
export function _resetPaymentBusyForTests({ now } = {}) {
  holds.clear();
  listeners.clear();
  nextToken = 1;
  lastReleasedAt = 0;
  clock = typeof now === 'function' ? now : () => Date.now();
  publish();
}
