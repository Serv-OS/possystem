// src/lib/bookings/departOnClose.js
//
// 16 Oct 2026 (audit item 4): cashing off a table never marked its booking
// departed. Nothing wrote it: not clearTable, not recordClosedCheck, not the
// closed_checks realtime handler. The host floor kept the table as Dining with
// the guest's name and walk ins were blocked until the turn ran out.
//
// The rule, pure and tested: which booking ids a closed check departs.
//   1. The closing session carries session.booking.bookingId (seatBooking
//      stamps it) and it is the occupation the check closed (same seatedAt).
//   2. Any booking still DINING whose primary table is the check's table and
//      whose seatedAt is within a minute of the check's seatedAt (another
//      device, or a session this device no longer holds).
// Never for a QR pay now round or a void tombstone.
// Never for a split child check (T4-2): the party's main check is still open.
// A booking known here in any status other than dining is left alone, so a
// party re seated, undone or already departed is never touched. A booking not
// loaded on this device (session only) is still returned: the write itself is
// conditional on the row still being dining (bookingsData.departBookingIfDining).

const GRACE_MS = 60 * 1000; // seatBooking stamps the booking a few seconds after the session it opens

// 16 Oct 2026 (review): "same table, closed after the seat" is not the same occupation. A QR pay
// now round paid mid meal (closed_checks row on the table, source qr, no seated_at) departed a
// party still eating, and so did the next party's check on a table the booking had been moved off
// (transferTable moves session.booking, not the booking's primaryTableId). So a close departs only
// the occupation it closed, keyed on seatedAt as isSessionClosed keys it.
export function bookingIdsToDepart({ check = null, session = null, tableIsChild = false, bookings = [] } = {}) {
  if (!check || !check.tableId || tableIsChild) return [];
  if (/^qr/i.test(String(check.source || '')) || check.status === 'voided') return [];
  const closedAt = Number(check.closedAt) || null;
  const checkSeatedAt = Number(check.seatedAt) || null;
  const byId = new Map((bookings || []).filter(Boolean).map((b) => [b.id, b]));
  const ids = [];
  const add = (id) => { if (id && !ids.includes(id)) ids.push(id); };

  // Rule 1: the session that closed names its booking.
  const fromSession = session?.booking?.bookingId || null;
  if (fromSession) {
    const sessSeatedAt = Number(session?.seatedAt) || null;
    const sameOccupation = checkSeatedAt
      ? sessSeatedAt === checkSeatedAt
      : (!closedAt || !sessSeatedAt || sessSeatedAt <= closedAt);
    if (sameOccupation) add(fromSession);
  }

  // Rule 2: a booking still dining on the check's table, seated in the occupation that closed.
  // Needs both seat stamps: without them this cannot tell one occupation from the next.
  if (checkSeatedAt) {
    for (const b of bookings || []) {
      if (!b || b.status !== 'dining') continue;
      if (b.primaryTableId !== check.tableId) continue;
      const bSeated = Number(b.seatedAt) || null;
      if (!bSeated || Math.abs(bSeated - checkSeatedAt) > GRACE_MS) continue;
      add(b.id);
    }
  }

  return ids.filter((id) => {
    const known = byId.get(id);
    return !known || known.status === 'dining';
  });
}
