/**
 * sessionClosure — "has this table occupation already been cashed off?"
 *
 * THE BUG THIS EXISTS FOR
 *   A table cashed off on the POS kept REAPPEARING on the floor. The close deletes
 *   the active_sessions row correctly, but any OTHER device (a second till, a phone,
 *   another tab) that still held that session in memory re-published it — the
 *   SessionReconciler self-heal and both realtime DELETE handlers all call
 *   reassertSession() to "repair" a row that vanished, on the assumption that a
 *   missing row means an accidental/stale delete rather than a deliberate close.
 *   There was no way to tell the two apart, so the "tables MUST never be lost"
 *   machinery faithfully resurrected a table that was paid and gone.
 *
 * THE TOMBSTONE
 *   A closed_check IS the durable, cross-device record that an occupation ended.
 *   It already carries the table and the occupation's seatedAt, and already syncs
 *   to every device (checksChannel realtime + the boot load). So the tombstone
 *   costs no new table and no migration: an occupation is closed iff a closed_check
 *   exists for the same table with the same seatedAt.
 *
 * WHY seatedAt AND NOT A TIMESTAMP COMPARISON
 *   seatedAt is stamped ONCE when the table is seated and copied verbatim onto both
 *   the live session and the closed_check. Matching on it is an exact equality on a
 *   value that originated on a single device — immune to cross-device clock skew. A
 *   re-seat produces a NEW seatedAt, so an old close never tombstones a fresh
 *   occupation. That is what keeps this from ever losing a live table: the ONLY
 *   thing it will drop is the exact occupation that was actually cashed off.
 */

import { useStore } from '../store';
import { checkClosesOccupation } from '../lib/rowWriteFence';

// closedChecks entries arrive in three shapes (local recordClosedCheck camelCase, realtime, the
// MasterSync boot load); lib/rowWriteFence.js checkClosesOccupation reads both shapes.

/**
 * True when THIS occupation has already been closed — i.e. any surviving in-memory
 * copy is a ghost that must not be re-published or re-added to the floor.
 *
 * Returns false when the session has no seatedAt: without it we cannot identify the
 * occupation, and refusing to tombstone is the safe direction (a table that briefly
 * reappears is a nuisance; a live table wrongly dropped is lost money).
 */
export function isSessionClosed(tableId, session) {
  if (!tableId || !session) return false;
  // v5.9.81: one rule (lib/rowWriteFence.js checkClosesOccupation): seatedAt as always, and a
  // VOID keyed on openedAt for a session that never had a seatedAt (a QR floor session).
  if (!session.seatedAt && !session.openedAt) return false;
  const checks = useStore.getState().closedChecks || [];
  for (const c of checks) {
    if (checkClosesOccupation(tableId, session, c)) return true;
  }
  return false;
}
