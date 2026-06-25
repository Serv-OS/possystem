/**
 * trainingMode.js — single source of truth for "Training Mode".
 *
 * Per-device: when a till's device profile has training_mode = true, NOTHING the
 * device does is committed — no closed_checks / order_queue / active_sessions rows,
 * no real card charge, no stock / loyalty / gift / CRM mutation, no kitchen fire,
 * no receipts / SMS, no cash-drawer pulse. The POS still behaves normally
 * in-memory so staff can train realistically; only the side effects are gated.
 *
 * This is a plain module singleton (NOT the Zustand store) so it can be read from
 * non-React modules — db.js, sync/*, surfaces — without a circular import. The
 * store owns the truth and mirrors it here via setTrainingMode() on every change
 * and at boot from the paired device profile.
 *
 * Gate pattern at a commit path:
 *     if (isTrainingMode()) return <harmless no-op result>;
 */

let _trainingMode = false;

export function setTrainingMode(v) {
  _trainingMode = !!v;
  // Surface for on-screen diagnostics inside the Sunmi/iPad APK (locked devices
  // where console isn't reachable) — mirrors window.RPOS_VERSION.
  if (typeof window !== 'undefined') window.RPOS_TRAINING = _trainingMode;
}

export function isTrainingMode() {
  return _trainingMode;
}
