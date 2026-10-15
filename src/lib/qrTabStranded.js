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

/**
 * Does this queue row belong to the QR tab open on this table?
 *
 * 2 Oct 2026: `label` is the floor table's own label, optional. A venue's QR link carries
 * whatever was typed after /t/, and at Coffee Boy that is the LABEL ("T6") while the floor
 * table's id is "t-1790408276961". The floor sync resolves the label to the id before it writes
 * the session; with `label` this match does the same. The Orders screen passes it
 * (qrSessionShownInQrSection). The two till guards (clearTable, openTableInPOS) do not yet:
 * they are left exactly as they were during service.
 */
export function isQrTabForTable(row, tableId, session, label) {
  if (!row || row.source !== 'qr') return false;
  const cust = row.customer || {};
  const ids = [cust.tableId, cust.table_id, row.tableId].map((v) => String(v ?? '').trim()).filter(Boolean);
  if (tableId && ids.includes(String(tableId))) return true;
  // The table as the guest's link named it, when that was the label and not the id.
  const want = String(label ?? '').trim().toLowerCase();
  if (want && ids.some((v) => v.toLowerCase() === want)) return true;
  // Older rows carry only the label the customer saw; the session knows it too.
  const labels = [cust.tableLabel, cust.table_label].map((v) => String(v ?? '').trim().toLowerCase()).filter(Boolean);
  const mine = [session?.tableLabel, session?.label, tableId, label].map((v) => String(v ?? '').trim().toLowerCase()).filter(Boolean);
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
export function qrCloseDecision({ session, tableId, orderQueue, label } = {}) {
  if (session?.source !== 'qr') return { block: false, reason: 'not_qr' };
  const rows = Array.isArray(orderQueue) ? orderQueue : [];
  const live = rows.some((row) => isQrTabForTable(row, tableId, session, label));
  return live ? { block: true, reason: 'live_tab' } : { block: false, reason: 'stranded' };
}

/**
 * Is this table's session only a floor plan COPY of QR orders the Orders screen already shows
 * in its QR section?
 *
 * 2 Oct 2026, Peter, Coffee Boy Leeds, live: "when you order to table you get 2 orders ... one
 * on the actual table 6 and 6.1, that needs to not happen." The Orders screen listed the QR
 * floor session as a Tables card ("Table T6, In service, Open") next to the QR card for the
 * same order, and its Open button loaded the paid order into the till's pay flow. A QR session
 * is a summary of the queue rows (lib/qrTableSession.js), so while those rows are in the queue
 * the QR card is the order and the Tables card is left out.
 *
 * It stays on the Orders screen when it is the only place the money shows:
 *   - no QR row for the table is left in the queue (the stranded tab, 21 Sep), or
 *   - staff added a line at the till. Every line the floor sync writes carries `tab_pi`, a
 *     line rung in on the till does not, and that line is not on any QR card.
 *
 * @param table  a store table: { id, label, session }
 */
export function qrSessionShownInQrSection(table, orderQueue) {
  const session = table?.session;
  if (!session || session.source !== 'qr') return false;
  const items = Array.isArray(session.items) ? session.items : [];
  if (items.some((i) => !i || !Object.prototype.hasOwnProperty.call(i, 'tab_pi'))) return false;
  const rows = Array.isArray(orderQueue) ? orderQueue : [];
  return rows.some((row) => isQrTabForTable(row, table.id, session, table.label));
}

// ── A QR floor copy whose money is already booked (2 Oct 2026, review) ───────────
// Hiding the copy on the Orders screen is not enough: it comes back the moment its QR row is
// collected, as "Table T6, In service, Open, 5.60" for an order paid at 10:35, and the floor
// plan shows the table busy all along. Deleting the active_sessions row does not remove it
// either: every till that holds the session puts the row straight back (the "tables never
// lost" self heal). The Leeds row proves it: written by the phone at 10:35, written again by
// a till at 11:16 with the till's own totals stamped on it.
//
// The only thing that makes every till let go of a table is proof that its money is booked
// (sync/sessionClosure.js). For a QR copy that proof is on the lines themselves: the floor
// sync stamps each line with `tab_pi`, the payment that covers it, and the sale the server
// books for a paid QR order carries the same payment (QR-FAUOB: HZRBXVNKS23PB4H6 on the
// line and on closed check chk-1790937346153-4st). So a QR copy is finished when EVERY line
// carries a payment and EVERY one of those payments is on a closed check.
//
// It is never finished, and so never dropped, when:
//   - a line has no `tab_pi`: staff rang it in at the till (Preston, 2 Oct, the tea), or
//   - any payment is not booked yet: an open tab, whose sale is only written when it closes, or
//   - the session is not a QR copy (no source 'qr', or it has a seatedAt of its own).

/** Every payment reference a closed check carries (store shape and database shape). */
function checkPaymentIds(check) {
  if (!check || typeof check !== 'object') return [];
  const cust = check.customer && typeof check.customer === 'object' ? check.customer : {};
  const legs = [check.paymentIntents, check.payment_intents].find(Array.isArray) || [];
  const tenders = Array.isArray(check.tenders) ? check.tenders : [];
  return [
    cust.payment_intent_id, check.stripePaymentIntentId, check.stripe_payment_intent_id,
    ...legs.map((l) => l && l.id),
    ...tenders.map((t) => t && (t.psp_ref ?? t.pspRef)),
  ].map((v) => String(v ?? '').trim()).filter(Boolean);
}

/**
 * True when this session is a QR floor copy and every line on it is already booked as a sale.
 *   session       a table's session (store or active_sessions shape)
 *   closedChecks  the closed checks this device holds
 */
export function qrSessionPaidOff(session, closedChecks) {
  if (!session || typeof session !== 'object' || session.source !== 'qr' || session.seatedAt) return false;
  const items = Array.isArray(session.items) ? session.items : [];
  if (!items.length) return false;
  const want = new Set();
  for (const i of items) {
    const pi = String(i?.tab_pi ?? '').trim();
    if (!pi) return false;
    want.add(pi);
  }
  const booked = new Set();
  for (const c of (Array.isArray(closedChecks) ? closedChecks : [])) {
    for (const id of checkPaymentIds(c)) booked.add(id);
  }
  for (const pi of want) if (!booked.has(pi)) return false;
  return true;
}
