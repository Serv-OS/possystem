// src/sync/sessionMoveRule.js
//
// When does one session id on two tables mean the party MOVED? 16 Oct 2026, bookings audit
// item 6. Pure, so the rule is tested under node (sessionMoveRule.test.js) and SessionReconciler
// only wires it.
//
// A transfer keeps the whole session (id AND seatedAt, store transferTable spreads it), and a
// combine records the source's id in the destination's absorbedSessions. Until today the
// reconciler matched on the id alone. Session ids were ORD-<counter> and every device restarted
// its counter at 1000, so two different parties on two tables could share ORD-1001 (live at
// Provo on 16 Oct). The reconciler then read the other device's table as "this session moved
// there" and cleared a live table here, or refused to show the other device's table.
//
// The rule now:
//   same occupation  the two copies share the id AND the same write once seatedAt (or both
//                    have none, an old QR tab), or this
//                    session's id is in the other's absorbedSessions (a combine)
//   never cleared    the active table on this device, or a table seated inside the 30 second
//                    grace (its own write may simply not have landed yet)
// Anything else is two different parties that happen to share an id: both stay.

export const MOVE_GRACE_MS = 30_000;

const seatOf = (s) => {
  const v = s && typeof s === 'object' ? s.seatedAt : null;
  return v === undefined || v === null || v === '' ? null : String(v);
};

// Are these two session copies the same party (one moved or merged into the other)?
//   mine    the session this device holds
//   theirs  the session the database holds on another table
export function sameOccupation(mine, theirs) {
  if (!mine || !theirs || typeof mine !== 'object' || typeof theirs !== 'object') return false;
  if (!mine.id) return false;
  const absorbed = Array.isArray(theirs.absorbedSessions) ? theirs.absorbedSessions : [];
  if (absorbed.includes(mine.id)) return true;
  if (theirs.id !== mine.id) return false;
  // Both without a seatedAt (old QR tabs) keep the old id-only answer: there is nothing else
  // to tell them apart by, and a missed move duplicates a party.
  return seatOf(mine) === seatOf(theirs);
}

// This device holds `local` on `tableId`; the database has no row for it but holds a session
// with the same id (or absorbing it) on `dbHomeTableId`. Clear the local copy as moved?
export function clearAsMoved({ tableId, local, dbHomeTableId, dbHomeSession, activeTableId = null, now = Date.now() } = {}) {
  if (!local || !dbHomeTableId || dbHomeTableId === tableId) return false;
  if (tableId === activeTableId) return false;
  const seated = Number(local.seatedAt);
  if (Number.isFinite(seated) && seated > 0 && (now - seated) < MOVE_GRACE_MS) return false;
  return sameOccupation(local, dbHomeSession);
}

// The database holds `dbSession` on `tableId`; this device holds a session with the same id on
// `localHomeTableId`. Skip adding the database row (it is the stale source of a move this
// device made)? Only when it is the same party; a different party that shares an id is added.
export function skipAsMovedHere({ tableId, dbSession, localHomeTableId, localHomeSession } = {}) {
  if (!dbSession || !localHomeTableId || localHomeTableId === tableId) return false;
  return sameOccupation(dbSession, localHomeSession);
}
