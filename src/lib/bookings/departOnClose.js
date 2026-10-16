// src/lib/bookings/departOnClose.js
//
// 16 Oct 2026 (audit item 4): cashing off a table never marked its booking
// departed. Nothing wrote it: not clearTable, not recordClosedCheck, not the
// closed_checks realtime handler. The host floor kept the table as Dining with
// the guest's name and walk ins were blocked until the turn ran out.
//
// The rule, pure and tested: which booking ids a closed check departs.
//   1. The closing session carries session.booking.bookingId (seatBooking
//      stamps it) and the session was seated before the check closed.
//   2. Any booking still DINING whose primary table is the check's table and
//      which was seated before the check closed (another device, or a session
//      this device no longer holds).
// Never for a split child check (T4-2): the party's main check is still open.
// A booking known here in any status other than dining is left alone, so a
// party re seated, undone or already departed is never touched. A booking not
// loaded on this device (session only) is still returned: the write itself is
// conditional on the row still being dining (bookingsData.departBookingIfDining).

const GRACE_MS = 60 * 1000; // device clocks drift; a seat stamped a moment after the close is the same occupation

export function bookingIdsToDepart({ check = null, session = null, tableIsChild = false, bookings = [] } = {}) {
  if (!check || !check.tableId || tableIsChild) return [];
  const closedAt = Number(check.closedAt) || null;
  const seatedBeforeClose = (seatedAt) => !closedAt || !seatedAt || Number(seatedAt) <= closedAt + GRACE_MS;
  const byId = new Map((bookings || []).filter(Boolean).map((b) => [b.id, b]));
  const ids = [];
  const add = (id) => { if (id && !ids.includes(id)) ids.push(id); };

  const fromSession = session?.booking?.bookingId || null;
  if (fromSession && seatedBeforeClose(session?.seatedAt)) add(fromSession);

  for (const b of bookings || []) {
    if (!b || b.status !== 'dining') continue;
    if (b.primaryTableId !== check.tableId) continue;
    if (!seatedBeforeClose(b.seatedAt)) continue;
    add(b.id);
  }

  return ids.filter((id) => {
    const known = byId.get(id);
    return !known || known.status === 'dining';
  });
}
