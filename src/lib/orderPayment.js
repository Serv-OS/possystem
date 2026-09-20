// src/lib/orderPayment.js: is a queued order paid, unpaid, or is its payment being checked?
// Database fence stage 1, fix round (docs/FENCE_STAGE_1_APP.md section 11, S3).
//
// Since 20260919a2 the SERVER decides "paid" for online, QR and catering orders
// (place_public_order). An order whose payment it could not prove yet (a slow card processor,
// a webhook that lands late) still reaches the venue, but with paid false and
// customer.payment_state 'checking'. That is a THIRD state:
//   - it is NOT unpaid: the customer was very likely charged. The till must never offer the
//     charge step or "take payment" for it (before this, an unverified QR or catering order
//     looked unpaid and invited a second charge);
//   - it is NOT paid: its closed check is kept on the server until the payment is proven
//     (verify_public_order_payment) or a manager confirms it (confirm_public_order_payment);
//     only then does it reach the reports (before this, an unverified online order looked paid
//     and never got its closed check).
//
// Pure helpers only (no Supabase, no store): OrdersHub, MPOS, CheckoutModal, the kitchen ticket
// and the tests all use the same rules.

export const PAYMENT_CHECKING = 'checking';
export const PAYMENT_SHORT = 'short';   // fix round 2 (S5), see paymentShortInfo below
export const PAYMENT_CHECKING_LABEL = 'Payment being checked';
export const PAYMENT_CHECKING_HELP = 'The customer paid on their phone and the venue is confirming it. Do not charge it again.';

// Channels that always pay before the order reaches the queue (OrdersHub v5.5.659).
export const PREPAID_CHANNELS = Object.freeze(['online', 'kiosk']);

/**
 * 'paid' | 'checking' | 'unpaid' for an order_queue entry (store shape or row shape).
 * A paid flag (the column, or customer.paid which QueueSync keeps) always wins: once the server
 * verified the payment, or staff confirmed it, the order is paid even if an older copy of the
 * customer block on some till still says 'checking'.
 */
export function orderPaymentState(o) {
  if (!o || typeof o !== 'object') return 'unpaid';
  const c = (o.customer && typeof o.customer === 'object') ? o.customer : {};
  if (o.paid === true || c.paid === true) return 'paid';
  // Fix round 2 (S5): 'short' (money proven, but less than the server's own price) is never
  // charged again either: it reads as checking everywhere a charge could start.
  if (c.payment_state === PAYMENT_CHECKING || c.payment_state === PAYMENT_SHORT || c.payment_unverified === true) return 'checking';
  if (PREPAID_CHANNELS.includes(o.source)) return 'paid';
  return 'unpaid';
}

// ── Fix round 2 (S5): "Payment short" ────────────────────────────────────────
//
// place_public_order now prices every online, QR and catering order ITSELF from the menu. An order
// whose proven money is less than that price arrives with customer.payment_state 'short' (and
// payment_unverified), customer.order_pricing { due_minor, proven_minor, unknown_lines }. A QR tab
// whose close came up short has the same state on its rounds, with customer.tab_close_short
// { paid_minor, due_minor }. It is never charged in full again: staff may take ONLY the difference
// on the till, then a manager confirms (confirm_public_order_payment with p_amount_minor = the
// part the online payment really took, so the two checks never count the same money twice).

export const PAYMENT_SHORT_LABEL = 'Payment short';
export const PAYMENT_SHORT_HELP = 'The customer paid less than the menu price for this order. Do not charge the full amount again: take only the difference on the till if you want it, then a manager confirms.';

const minorOf = (v) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n > 0 ? n : 0; };

/**
 * { provenMinor, dueMinor, shortMinor, unknownLines, tabClose } for an order whose payment is
 * short, or null (paid, unpaid, or only being checked).
 */
export function paymentShortInfo(o) {
  if (!o || typeof o !== 'object' || orderPaymentState(o) !== 'checking') return null;
  const c = (o.customer && typeof o.customer === 'object') ? o.customer : {};
  if (c.payment_state !== PAYMENT_SHORT) return null;
  const p = (c.order_pricing && typeof c.order_pricing === 'object') ? c.order_pricing : {};
  const t = (c.tab_close_short && typeof c.tab_close_short === 'object') ? c.tab_close_short : null;
  const provenMinor = minorOf(p.proven_minor ?? (t ? t.paid_minor : 0));
  const dueMinor = minorOf(p.due_minor ?? (t ? t.due_minor : 0));
  const unknownLines = Math.max(0, Math.round(Number(p.unknown_lines) || 0));
  return { provenMinor, dueMinor, shortMinor: Math.max(0, dueMinor - provenMinor), unknownLines, tabClose: !!t };
}

/** The badge words for an order that must not be charged: 'Payment short' or 'Payment being checked'. */
export function paymentStatusLabel(o) {
  return paymentShortInfo(o) ? PAYMENT_SHORT_LABEL : PAYMENT_CHECKING_LABEL;
}

/**
 * One plain line for staff, or '' when the payment is not short:
 * "Paid £12.00 of £15.00 · 1 item not on the menu". formatMoney formats pounds (lib/currency money).
 */
export function paymentShortLine(o, formatMoney = (n) => n.toFixed(2)) {
  const s = paymentShortInfo(o);
  if (!s) return '';
  const parts = [`Paid ${formatMoney(s.provenMinor / 100)} of ${formatMoney(s.dueMinor / 100)}`];
  if (s.unknownLines > 0) parts.push(`${s.unknownLines} item${s.unknownLines === 1 ? '' : 's'} not on the menu`);
  return parts.join(' · ');
}

/**
 * What a manager's Confirm books for the online payment: for a short order ONLY the part the
 * online payment really took (order_pricing.proven_minor), so taking the difference on the till
 * as its own sale never counts that money twice. null for an order only being checked (the
 * manager saw the whole payment in the processor; the server books what the order needed).
 */
export function confirmAmountMinor(o) {
  const s = paymentShortInfo(o);
  return s && s.provenMinor > 0 ? s.provenMinor : null;
}

/**
 * S5 for a QR TAB: the phone closed it, its card was captured, but the capture did not cover the
 * tab as the server values it (settle_qr_tab answered 'short' and marked every round with
 * customer.tab_close_short { paid_minor, due_minor }). Returns { paidMinor, dueMinor, restMinor }
 * from the rounds, or null. The hold is already captured: the till must never capture or charge
 * the tab again. Staff close it booking what was paid, and take the rest as its own sale.
 */
export function qrTabShortInfo(rows) {
  for (const r of rows || []) {
    const c = r && r.customer && typeof r.customer === 'object' ? r.customer : null;
    if (!c || c.payment_state !== PAYMENT_SHORT) continue;
    const t = c.tab_close_short && typeof c.tab_close_short === 'object' ? c.tab_close_short : null;
    if (!t) continue;
    const paidMinor = minorOf(t.paid_minor);
    const dueMinor = minorOf(t.due_minor);
    if (paidMinor > 0) return { paidMinor, dueMinor, restMinor: Math.max(0, dueMinor - paidMinor) };
  }
  return null;
}

/** The badge words on a QR tab whose close came up short, or '' (formatMoney formats pounds). */
export function qrTabShortLine(rows, formatMoney = (n) => n.toFixed(2)) {
  const s = qrTabShortInfo(rows);
  if (!s) return '';
  return `Paid ${formatMoney(s.paidMinor / 100)} of ${formatMoney(s.dueMinor / 100)}`;
}

/**
 * S5 for a QR tab whose close came up short: the ONE closed check the till writes when staff close
 * it. The phone's capture already took the money, so nothing is captured or charged again, and the
 * check books ONLY what that capture took (paidMinor). The rest is taken on the till as its own
 * sale. The id is fixed per card hold ('chk-qrshort-<hold>'), so pressing Close twice can never book
 * the same money twice (the second insert is refused as a duplicate, 23505).
 *   tab: the Orders Hub QR tab (rows, allItems, firstRow, payment_intent_id, payment_session_id,
 *        processor, tableId, tableLabel)
 */
export function shortTabClosedCheck(tab, short, { nowIso = new Date().toISOString() } = {}) {
  if (!tab || !short || !(short.paidMinor > 0)) return null;
  const processor = ['stripe', 'ryft', 'adyen'].includes(tab.processor) ? tab.processor : 'stripe';
  const holdRef = processor === 'ryft' ? (tab.payment_session_id || tab.payment_intent_id) : tab.payment_intent_id;
  if (!holdRef) return null;
  const paid = Math.round(short.paidMinor) / 100;
  const rows = Array.isArray(tab.rows) ? tab.rows : [];
  const tipMinor = rows.reduce((t, r) => t + Math.round((Number(r && r.customer && r.customer.tip) || 0) * 100), 0);
  const tip = Math.min(tipMinor, Math.round(short.paidMinor)) / 100;
  const first = (tab.firstRow && typeof tab.firstRow === 'object') ? tab.firstRow : (rows[0] || {});
  const baseCustomer = (first.customer && typeof first.customer === 'object') ? { ...first.customer } : {};
  delete baseCustomer.tab_join_code;
  delete baseCustomer.payment_unverified;
  return {
    id: `chk-qrshort-${holdRef}`.slice(0, 120),
    ref: baseCustomer.tab_ref || first.ref || holdRef,
    location_id: first.location_id || null,
    server: 'QR (closed short on the till)',
    covers: 1,
    order_type: 'dine-in',
    customer: {
      ...baseCustomer,
      tab_closed_at: nowIso,
      tab_closed_short_on_till: true,
      tab_close_short: { paid_minor: Math.round(short.paidMinor), due_minor: Math.round(short.dueMinor || 0) },
      shortfall_minor: Math.max(0, Math.round((short.dueMinor || 0) - short.paidMinor)),
    },
    items: (Array.isArray(tab.allItems) ? tab.allItems : []).map((i) => ({ ...i, voided: false })),
    discounts: [],
    subtotal: +Math.max(0, paid - tip).toFixed(2),
    service: 0,
    tip,
    tax_amount: null,
    total: paid,
    method: 'card',
    processor,
    stripe_payment_intent_id: processor === 'stripe' ? holdRef : null,
    payment_intents: [{ id: holdRef, amountMinor: Math.round(short.paidMinor) }],
    closed_at: nowIso,
    status: 'paid',
    refunds: [],
    table_id: tab.tableId || null,
    table_label: `Table ${tab.tableLabel || ''}`.trim(),
    source: 'qr',
  };
}

export const isOrderPaid = (o) => orderPaymentState(o) === 'paid';
export const isPaymentChecking = (o) => orderPaymentState(o) === 'checking';
/** Only a truly unpaid order may be charged on the till. */
export const mayChargeOrder = (o) => orderPaymentState(o) === 'unpaid';

const PROCESSORS = ['stripe', 'ryft', 'adyen'];

/**
 * What "Check payment" asks the payment-proof function for: the card payment the server recorded
 * on the order (customer.payment_processor and customer.payment_ref). Null when the order names
 * no card payment (a gift card or promo only order): only a manager can confirm those.
 */
export function paymentCheckRequest(o) {
  const c = (o && o.customer) || {};
  const processor = String(c.payment_processor || c.processor || '').toLowerCase();
  const ref = String(c.payment_ref || c.payment_intent_id || '').trim();
  if (!ref || !PROCESSORS.includes(processor)) return null;
  return { processor, kind: 'card', paymentRef: ref };
}

/** verify_public_order_payment / confirm_public_order_payment answer in plain terms. */
export function readPaymentAnswer({ data, error } = {}, { isMissingRpc } = {}) {
  if (error) {
    if (isMissingRpc && isMissingRpc(error)) return { status: 'unsupported', message: 'This check is not available yet. Look the payment up in the card processor.' };
    return { status: 'error', message: error.message || 'Could not reach the server. Try again.' };
  }
  const d = data || {};
  if (d.ok && d.paid) return { status: 'paid', checkId: d.check_id || null, already: d.already === true };
  if (d.ok && d.paid === false) {
    const unknownLines = Math.max(0, Math.round(Number(d.unknown_lines) || 0));
    const provenMinor = Number(d.proven_minor) || 0;
    const dueMinor = Number(d.due_minor) || 0;
    // Fix round 2 (S5): money proven but less than the server's price, or an item not on the menu.
    let message = 'The card processor has not shown this payment yet. Try again in a minute, or a manager can confirm it after checking the processor.';
    if (unknownLines > 0) message = d.message || 'Something on this order is not on the menu. A manager must check it and confirm the payment.';
    else if (provenMinor > 0 && dueMinor > provenMinor) message = 'The payment is short of the menu price. Take only the difference on the till if you want it, then a manager confirms. Never charge the full amount again.';
    return { status: 'unproven', dueMinor, provenMinor, unknownLines, message };
  }
  if (d.reason === 'no_check') return { status: 'no_check', message: 'This order has no payment to check. Take payment on the till.' };
  if (d.reason === 'not_found') return { status: 'not_found', message: 'Order not found.' };
  return { status: 'error', message: d.message || 'Could not check the payment.' };
}

/**
 * Staff "Check payment" (S3): ask payment-proof for the order's card payment, then
 * verify_public_order_payment with the proof. A proof that cannot be had is not fatal: the
 * server also counts any proof already written for the payments the kept check names.
 *
 * @param {Function} o.requestProof ({processor, kind, paymentRef}) => {proofId}|{failed}|{unavailable}
 * @param {Function} o.rpc          (name, args) => {data, error}
 */
export async function checkOrderPayment({ requestProof, rpc, locationId, order, isMissingRpc } = {}) {
  if (!rpc || !locationId || !order || !order.ref) return { status: 'error', message: 'No order.' };
  const req = paymentCheckRequest(order);
  const proofIds = [];
  if (req && requestProof) {
    try {
      const p = await requestProof(req);
      if (p && p.proofId) proofIds.push(p.proofId);
    } catch { /* the server may still hold an earlier proof */ }
  }
  let res;
  try { res = await rpc('verify_public_order_payment', { p_location_id: String(locationId), p_ref: String(order.ref), p_proof_ids: proofIds }); }
  catch (e) { res = { error: e || { message: 'failed' } }; }
  return readPaymentAnswer(res || {}, { isMissingRpc });
}

/**
 * Manager "Confirm payment" (S3): staff saw the payment in the processor. Needs a note.
 * Fix round 2 (S5): for a short order the online check books only what the online payment took
 * (p_amount_minor = confirmAmountMinor(order)); any difference taken on the till is its own sale.
 */
export async function confirmOrderPayment({ rpc, locationId, order, note, isMissingRpc } = {}) {
  if (!rpc || !locationId || !order || !order.ref) return { status: 'error', message: 'No order.' };
  const n = String(note || '').trim();
  if (!n) return { status: 'error', message: 'Say what you checked, for example "seen in Stripe".' };
  const args = { p_location_id: String(locationId), p_ref: String(order.ref), p_note: n.slice(0, 200) };
  const amount = confirmAmountMinor(order);
  if (amount) args.p_amount_minor = amount;
  let res;
  try { res = await rpc('confirm_public_order_payment', args); }
  catch (e) { res = { error: e || { message: 'failed' } }; }
  return readPaymentAnswer(res || {}, { isMissingRpc });
}

/**
 * The local copy of an order once the server said it is paid, so this till stops showing
 * "Payment being checked" straight away (realtime brings the server row too). The paid column
 * is set on the server; QueueSync never writes it.
 */
export function markOrderPaymentSettled(o, { byStaff = false } = {}) {
  const c = { ...((o && o.customer) || {}) };
  delete c.payment_unverified;
  c.payment_state = byStaff ? 'confirmed_by_staff' : 'verified';
  return { ...o, paid: true, customer: c };
}
