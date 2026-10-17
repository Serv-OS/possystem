// src/lib/msm/msmTill.js
//
// MULTI SITE MENU (17 Oct 2026, v5.11.75): when a counter till may take a head office menu update
// by itself (design 4a). Pure, tested (msmMargin.test.js, msmTillWatch.test.js). Wired into the
// tills by msmTillWatch.js (the idle watcher, the "Menu updated by head office" note and the catch
// up on reconnect) through these functions only, so ordinary Push to POS pushes keep today's
// behaviour exactly.
//
//   * Only a push with pushSource.kind 'msm' and applyWhenIdle is ever applied by itself.
//   * Never mid sale: no lines in the current order, no card payment running, no check open on
//     screen, no modal open.

/** Is the till idle enough to swap its menu? state = { lines, paymentInProgress, checkOpen, modalOpen } */
export function tillIsIdle(state) {
  const s = state || {};
  const lines = Array.isArray(s.lines) ? s.lines.length : Number(s.lines) || 0;
  return lines === 0 && !s.paymentInProgress && !s.checkOpen && !s.modalOpen;
}

/** Is this push one a till may apply by itself (when idle)? */
export function isMsmAutoApply(snapshot) {
  const src = snapshot && snapshot.pushSource;
  return !!src && src.kind === 'msm' && src.applyWhenIdle !== false;
}

/**
 * Catch up after being offline: should the till fetch and apply this latest push?
 *   latest       { id, created_at, kind } of the venue's newest push (one tiny read)
 *   lastApplied  { id, created_at } the till remembers applying
 * Only head office pushes are caught up this way; an ordinary push keeps today's Sync POS banner.
 */
export function shouldCatchUp(latest, lastApplied) {
  if (!latest || latest.kind !== 'msm') return false;
  if (!lastApplied || !lastApplied.id) return true;
  if (latest.id === lastApplied.id) return false;
  const a = Date.parse(latest.created_at || ''), b = Date.parse(lastApplied.created_at || '');
  return Number.isFinite(a) && (!Number.isFinite(b) || a > b);
}

/** The banner while a sale is open: never applied mid sale. */
export const PENDING_WORDS = 'Head office menu update: applies when this sale ends';
export const APPLIED_WORDS = 'Menu updated by head office';
