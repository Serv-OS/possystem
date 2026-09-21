// src/lib/qrTabStranded.js
//
// A QR TAB WITH NO TAB LEFT TO CLOSE.
//
// LIVE, 21 Sep 2026. Peter: "I also have a table that says removed table, then
// when I try to close it with cash it wont, I have no idea where that came
// from." Table t1 at Provo, three lines, GBP 46.00, and it could not be closed
// by ANY route:
//
//   * the floor plan calls it "Removed table" (no floor_tables row: it was
//     deleted while the session was open, which is the tombstone the till is
//     supposed to keep so money is never lost),
//   * clearTable refuses it, because active_sessions says source 'qr' and a QR
//     tab holds a card pre-authorisation that only Orders Hub can capture,
//   * and Orders Hub has nothing to show, because the order_queue row that WAS
//     the tab is gone.
//
// The guard is right (closing a live QR tab on the floor would double charge and
// write a source-less check). What was missing is the other half: once there is
// no tab in the queue, there is nothing to capture and nothing to orphan, and
// the refusal is just a dead end with the venue's money inside it.
//
// So the rule is "refuse while there is something to refuse FOR".

/** Does this queue row belong to the QR tab open on this table? */
export function isQrTabForTable(row, tableId, session) {
  if (!row || row.source !== 'qr') return false;
  const cust = row.customer || {};
  const ids = [cust.tableId, cust.table_id, row.tableId].map((v) => String(v ?? '').trim()).filter(Boolean);
  if (tableId && ids.includes(String(tableId))) return true;
  // Older rows carry only the label the customer saw; the session knows it too.
  const labels = [cust.tableLabel, cust.table_label].map((v) => String(v ?? '').trim().toLowerCase()).filter(Boolean);
  const mine = [session?.tableLabel, session?.label, tableId].map((v) => String(v ?? '').trim().toLowerCase()).filter(Boolean);
  if (labels.some((l) => mine.includes(l))) return true;
  // And a tab the customer joined by ref.
  const ref = String(session?.qrRef ?? session?.ref ?? '').trim();
  return !!ref && String(row.ref ?? '') === ref;
}

/**
 * May the till close this table itself?
 *
 * @returns {{ block: true, reason: 'live_tab' } | { block: false, reason: 'not_qr' | 'stranded' }}
 *   block  -> send them to Orders Hub, which owns the card hold
 *   false  -> close it here: either it was never a QR tab, or its tab is gone
 */
export function qrCloseDecision({ session, tableId, orderQueue } = {}) {
  if (session?.source !== 'qr') return { block: false, reason: 'not_qr' };
  const rows = Array.isArray(orderQueue) ? orderQueue : [];
  const live = rows.some((row) => isQrTabForTable(row, tableId, session));
  return live ? { block: true, reason: 'live_tab' } : { block: false, reason: 'stranded' };
}
