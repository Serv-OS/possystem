/**
 * eodPayments.js: which orders the Close day page reads for its Payment methods, beyond the
 * shift's own. Coffee Boy Castleford, 25 Nov 2026: "where can we see what is card payment and
 * what is app payments. The end of day report doesn't separate them."
 *
 * A till sale is stamped with the shift it was taken in. An order taken away from the tills
 * (online ordering, the app, a kiosk, QR at the table) carries no shift at all, so Close day
 * never showed it. Those closed since the shift opened are read in here, so the page can name
 * card at the till apart from card taken online.
 *
 * Pure, import free, so node:test can load it (eodPayments.test.js).
 */
const ms = (v) => (v == null ? null : typeof v === 'number' ? v : Number.isFinite(Date.parse(v)) ? Date.parse(v) : null);

/**
 * The checks with no shift, not voided, closed at or after `openedAt`. Without a shift start
 * there is nothing to measure from, so nothing is read in.
 */
export function offTillChecksSince(closedChecks, openedAt) {
  const from = ms(openedAt);
  if (from == null) return [];
  return (Array.isArray(closedChecks) ? closedChecks : []).filter((c) => {
    if (!c || c.status === 'voided') return false;
    if (c.shiftId != null && c.shiftId !== '') return false;
    const at = ms(c.closedAt ?? c.closed_at);
    return at != null && at >= from;
  });
}
