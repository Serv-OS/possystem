// src/lib/orderPayment.js: is a queued order paid, unpaid, or is its payment being checked?
// Database fence stage 1, fix round (docs/FENCE_STAGE_1_APP.md section 11, S3).
//
// Since 20260919a the SERVER decides "paid" for online, QR and catering orders
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
  if (c.payment_state === PAYMENT_CHECKING || c.payment_unverified === true) return 'checking';
  if (PREPAID_CHANNELS.includes(o.source)) return 'paid';
  return 'unpaid';
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
    return {
      status: 'unproven',
      dueMinor: Number(d.due_minor) || 0,
      provenMinor: Number(d.proven_minor) || 0,
      message: 'The card processor has not shown this payment yet. Try again in a minute, or a manager can confirm it after checking the processor.',
    };
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

/** Manager "Confirm payment" (S3): staff saw the payment in the processor. Needs a note. */
export async function confirmOrderPayment({ rpc, locationId, order, note, isMissingRpc } = {}) {
  if (!rpc || !locationId || !order || !order.ref) return { status: 'error', message: 'No order.' };
  const n = String(note || '').trim();
  if (!n) return { status: 'error', message: 'Say what you checked, for example "seen in Stripe".' };
  let res;
  try { res = await rpc('confirm_public_order_payment', { p_location_id: String(locationId), p_ref: String(order.ref), p_note: n.slice(0, 200) }); }
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
