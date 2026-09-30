// src/lib/closedCheckRefundFields.js
//
// The closed_checks columns a REFUND reads, mapped onto the in-memory (camelCase) check.
// The reverse of the payment half of closedCheckRow, shared by every place that turns a
// closed_checks row into a till's copy: the boot loaders (db.fetchClosedChecks and
// fetchClosedChecksRange), the realtime INSERT and UPDATE handlers and MasterSync.
//
// 28 Sep 2026 (Leeds R6404, 27 Sep): a kitchen screen's terminal job reconciler booked a
// reader sale, so POS 1 only knew the check from the realtime INSERT. That copy was built
// by hand and carried no card reference, no processor and no tenders, so refundCheck found
// no card leg and told staff to refund 3.80 by hand. The boot loaders had these fields all
// along; realtime and MasterSync never did. One map, so no copy can drop them again.
// Pure: no supabase import, testable in Node.
export function closedCheckRefundFields(row) {
  return {
    giftCard: row?.gift_card || null,                        // v5.5.217: gift card reversal on refund
    stripePaymentIntentId: row?.stripe_payment_intent_id || null,
    paymentIntents: row?.payment_intents || null,            // v5.5.323: multi-card refund source
    processor: row?.processor || 'stripe',                   // refund routes by this
    loyalty: row?.loyalty || null,
    source: row?.source || 'pos',                            // v5.5.140: report filters
    // v5.9.11: what paid the check. A reader sale's card tender carries its psp_ref, which
    // is the last record of the card leg when nothing else is (refundMath.cardLegsOf).
    tenders: Array.isArray(row?.tenders) ? row.tenders : null,
  };
}

// ── Money the SERVER moved on a closed check after it closed ────────────────────
// The realtime UPDATE handler merges only refunds and status from another device, because the
// till's own camelCase copy is richer than the snake_case row. Two server writers change the
// money on a closed check, and each marks the row so the handler can tell:
//   v5.7.5 tip on the printed receipt: a payment_intents leg carries a `capture` key
//   v5.11.16 reader tip heal: a card tender carries `tip_added_at`
// For those rows the handler also takes tip and total (and the legs / tenders the server wrote),
// so History and the Z report repaint without a reload. A plain refund UPDATE keeps the old
// merge exactly.
function hasCaptureLegs(row) {
  return Array.isArray(row?.payment_intents)
    && row.payment_intents.some((l) => l && typeof l === 'object' && 'capture' in l);
}
function hasServerAddedTip(row) {
  return Array.isArray(row?.tenders)
    && row.tenders.some((t) => t && typeof t === 'object' && t.tip_added_at != null);
}

/** Did the server move money on this closed check after it closed? */
export function serverTipChanged(row) {
  return hasCaptureLegs(row) || hasServerAddedTip(row);
}

/** The fields a realtime UPDATE of a closed check may take from the server row ({} for a plain refund). */
export function serverTipFields(row) {
  if (!serverTipChanged(row)) return {};
  const out = {};
  if (hasCaptureLegs(row) || (hasServerAddedTip(row) && Array.isArray(row.payment_intents))) {
    out.paymentIntents = row.payment_intents;
  }
  if (hasServerAddedTip(row)) out.tenders = row.tenders;
  if (row.tip != null) out.tip = row.tip;
  if (row.total != null) out.total = row.total;
  return out;
}
