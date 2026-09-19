// src/lib/closedCheckRow.js
//
// The one camelCase→snake_case closed_check row map, shared by insert (normal closes),
// upsert (the terminal-job reconciler), the offline replay (DataSafe.reconcilePendingChecks)
// and the MPOS close-failure recovery. One shape, so they can never drift.
//
// v5.9.11: moved here out of db.js (it was module-private, so DataSafe and MPOS each kept a
// hand copy that had already drifted: the replay dropped tax_breakdown and seated_at), and it
// maps `tenders` (lib/accounting/tenders.js). Pure: no supabase import, testable in Node.
export function closedCheckRow(check, locationId) {
  const row = {
    id:           check.id,
    location_id:  locationId,
    ref:          check.ref,
    server:       check.server,
    staff_id:     check.staffId   || null,   // v4.6.19 — FK to staff_members.id
    covers:       check.covers,
    order_type:   check.orderType,
    customer:     check.customer,
    items:        check.items,
    discounts:    check.discounts,
    subtotal:     check.subtotal,
    service:      check.service,
    tip:          check.tip,
    tax_amount:   check.taxAmount != null ? check.taxAmount : null,  // v4.6.19 — stored explicitly
    tax_breakdown: check.taxBreakdown || null,  // v5.5.853: was computed+carried but never mapped — per-rate VAT now persists
    total:        check.total,
    method:       check.method,
    drawer_id:    check.drawerId || null,   // v4.6.37
    shift_id:     check.shiftId  || null,   // v4.6.37
    closed_at:    check.closedAt ? new Date(check.closedAt).toISOString() : new Date().toISOString(),
    seated_at:    check.seatedAt ? new Date(check.seatedAt).toISOString() : null,   // Tables Ready: seat->close turn time feeds the waitlist estimator's learning loop
    status:       check.status || 'paid',
    refunds:      check.refunds || [],
    table_id:     check.tableId || null,
    table_label:  check.tableLabel || null,
    gift_card:    check.giftCard || null,   // v5.5.217: gift card reversal on refund
    loyalty:      check.loyalty  || null,   // v5.5.218: loyalty points summary (earn/redeem)
    source:       check.source   || null,   // v5.5.276: pos / kiosk / online / qr — null = 'pos' default
    stripe_payment_intent_id: check.stripePaymentIntentId || null,  // v5.5.301: for card refunds
    payment_intents: check.paymentIntents || null,  // v5.5.323: ALL card PIs (split portions + bar tabs) for multi-card refund
    processor:    check.processor || 'stripe',   // which processor took the payment — refund routes by this
  };
  // v5.9.11: only sent when there is a list, so a check with none never needs the column.
  if (Array.isArray(check.tenders) && check.tenders.length) row.tenders = check.tenders;
  return row;
}
