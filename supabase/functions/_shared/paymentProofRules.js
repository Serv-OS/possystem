// supabase/functions/_shared/paymentProofRules.js
//
// WHAT COUNTS AS PROOF THAT MONEY WAS TAKEN (database fence stage 1, contract C0).
//
// Pure decisions only. No I/O, no Deno, no Supabase: imported by the payment-proof edge
// function and unit tested from src/lib/paymentProofRules.test.js under plain node.
//
// The rule for every processor: the amount comes from the PROCESSOR's own record (or our
// server written ledger), never from the request body. A proof is written only for a payment
// the function could see, for THIS venue, in the state the kind asks for:
//   card     money taken (Stripe succeeded, Ryft Approved or Captured, Adyen authorised
//            and not a hold)
//   preauth  a card hold that is still open (Stripe requires_capture, Ryft Approved with a
//            manual capture flow, Adyen authorised hold not captured yet)
//   capture  a hold that was captured (Stripe succeeded, Ryft Captured, Adyen captured)
//   gift     a gift card redeem row on the ledger, for a card of the venue's company
//   loyalty  a loyalty redemption row on the ledger, for the venue's company or venue

export const PROOF_KINDS = ['card', 'preauth', 'capture', 'gift', 'loyalty'];
export const PROOF_PROCESSORS = ['stripe', 'ryft', 'adyen', 'gift', 'loyalty'];

const posInt = (v) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/** Validate the request. Returns { ok, body } or { ok: false, reason }. */
export function parseProofRequest(raw) {
  const b = raw && typeof raw === 'object' ? raw : {};
  const ops = String(b.ops_location_id || '').trim();
  const processor = String(b.processor || '').trim().toLowerCase();
  const kind = String(b.kind || '').trim().toLowerCase();
  const ref = String(b.payment_ref || '').trim();
  if (!ops || !/^[0-9a-f-]{36}$/i.test(ops)) return { ok: false, reason: 'venue' };
  if (!PROOF_PROCESSORS.includes(processor)) return { ok: false, reason: 'processor' };
  if (!PROOF_KINDS.includes(kind)) return { ok: false, reason: 'kind' };
  if (!ref || ref.length > 200) return { ok: false, reason: 'payment_ref' };
  if ((processor === 'gift') !== (kind === 'gift')) return { ok: false, reason: 'kind' };
  if ((processor === 'loyalty') !== (kind === 'loyalty')) return { ok: false, reason: 'kind' };
  return { ok: true, body: { ops_location_id: ops, processor, kind, payment_ref: ref } };
}

/**
 * Stripe PaymentIntent (fetched with the venue's Stripe-Account header).
 * metadata.ops_location_id must name this venue: every customer page sets it.
 */
export function stripeProof(pi, kind, opsLocationId) {
  if (!pi || typeof pi !== 'object') return { ok: false, reason: 'not_seen' };
  const md = pi.metadata || {};
  if (String(md.ops_location_id || '') !== String(opsLocationId)) return { ok: false, reason: 'other_venue' };
  const currency = pi.currency ? String(pi.currency).toUpperCase() : null;
  if (kind === 'card' || kind === 'capture') {
    if (pi.status !== 'succeeded') return { ok: false, reason: 'not_paid' };
    const amt = posInt(pi.amount_received);
    return amt > 0 ? { ok: true, amount_minor: amt, currency } : { ok: false, reason: 'not_paid' };
  }
  if (kind === 'preauth') {
    if (pi.status !== 'requires_capture') return { ok: false, reason: pi.status === 'succeeded' ? 'captured' : 'not_held' };
    const amt = posInt(pi.amount_capturable);
    return amt > 0 ? { ok: true, amount_minor: amt, currency } : { ok: false, reason: 'not_held' };
  }
  return { ok: false, reason: 'kind' };
}

/** Ryft payment session (fetched on the venue's sub-account). */
export function ryftProof(session, kind, { venueAccountId } = {}) {
  if (!session || typeof session !== 'object') return { ok: false, reason: 'not_seen' };
  // The session must belong to the venue's sub account when the venue has one. Ryft echoes
  // the account it was booked to in paymentSettings; a session read through the venue's
  // Account header is the venue's already, so a missing echo is accepted.
  const bookTo = session?.paymentSettings?.platform?.paymentFees?.combined?.bookTo || null;
  if (venueAccountId && bookTo && bookTo !== venueAccountId) return { ok: false, reason: 'other_venue' };
  const status = String(session.status || '');
  const currency = session.currency ? String(session.currency).toUpperCase() : null;
  const manual = String(session.captureFlow || '').toLowerCase() === 'manual';
  const amount = posInt(session.amount);
  const captured = posInt(session.capturedAmount ?? session.amountCaptured ?? 0);
  if (kind === 'card') {
    if (status === 'Captured') return { ok: true, amount_minor: captured || amount, currency };
    if (status === 'Approved' && !manual) return { ok: true, amount_minor: amount, currency };
    return { ok: false, reason: 'not_paid' };
  }
  if (kind === 'preauth') {
    if (status === 'Approved' && manual) return amount > 0 ? { ok: true, amount_minor: amount, currency } : { ok: false, reason: 'not_held' };
    return { ok: false, reason: status === 'Captured' ? 'captured' : 'not_held' };
  }
  if (kind === 'capture') {
    if (status === 'Captured') return { ok: true, amount_minor: captured || amount, currency };
    return { ok: false, reason: 'not_captured' };
  }
  return { ok: false, reason: 'kind' };
}

/**
 * Adyen: the platform ledger row the webhook wrote (adyen_payments, keyed by psp_reference).
 * venuePlatformIds: the venue's Platform location id(s); the row's location_id must be one.
 */
export function adyenProof(row, kind, { venuePlatformIds = [] } = {}) {
  if (!row || typeof row !== 'object') return { ok: false, reason: 'not_seen' };
  if (!row.location_id || !venuePlatformIds.map(String).includes(String(row.location_id))) return { ok: false, reason: 'other_venue' };
  if (row.success !== true && String(row.success) !== 'true') return { ok: false, reason: 'not_paid' };
  const cancelled = /^(CANCELLATION|CANCEL_OR_REFUND|REFUND)$/.test(String(row.last_event_code || ''));
  if (cancelled) return { ok: false, reason: 'cancelled' };
  const currency = row.currency ? String(row.currency).toUpperCase() : null;
  const amount = posInt(row.amount_minor);
  const hold = row.capture_required === true;
  const capturedMinor = posInt(row.raw && row.raw.captured_minor);
  const isCaptured = !!row.captured_at || capturedMinor > 0;
  if (kind === 'card') {
    if (hold && !isCaptured) return { ok: false, reason: 'not_paid' };
    const amt = isCaptured && capturedMinor ? capturedMinor : amount;
    return amt > 0 ? { ok: true, amount_minor: amt, currency } : { ok: false, reason: 'not_paid' };
  }
  if (kind === 'preauth') {
    // The webhook sets capture_required only when the notification says PreAuth; an online tab
    // hold whose notification did not echo it has capture_required null. Only an explicit
    // false (never written today) refuses; an uncaptured authorisation otherwise counts.
    if (row.capture_required === false) return { ok: false, reason: 'not_held' };
    if (isCaptured) return { ok: false, reason: 'captured' };
    return amount > 0 ? { ok: true, amount_minor: amount, currency } : { ok: false, reason: 'not_held' };
  }
  if (kind === 'capture') {
    if (!isCaptured) return { ok: false, reason: 'not_captured' };
    const amt = capturedMinor || amount;
    return amt > 0 ? { ok: true, amount_minor: amt, currency } : { ok: false, reason: 'not_captured' };
  }
  return { ok: false, reason: 'kind' };
}

/** Gift: the redeem ledger row (gift_card_transactions) for this idempotency key. */
export function giftProof(tx, { companyId } = {}) {
  if (!tx || typeof tx !== 'object') return { ok: false, reason: 'not_seen' };
  if (tx.type !== 'redeem') return { ok: false, reason: 'not_redeem' };
  if (!companyId || String(tx.company_id) !== String(companyId)) return { ok: false, reason: 'other_venue' };
  const amt = posInt(Math.abs(Number(tx.amount_minor)));
  return amt > 0 ? { ok: true, amount_minor: amt, currency: null } : { ok: false, reason: 'not_paid' };
}

/**
 * Loyalty: a points redemption (loyalty_transactions, company scoped) or a stamp redemption
 * (stamp_transactions, venue scoped). The ledgers record points or stamps, not money, so the
 * proof's amount is the reward's money value when the caller's server lookup found one, and
 * otherwise 1 (a marker: place_public_order only needs gift or loyalty proof above zero for
 * a check whose total is zero).
 */
export function loyaltyProof(row, { companyId, opsLocationId, rewardValueMinor } = {}) {
  if (!row || typeof row !== 'object') return { ok: false, reason: 'not_seen' };
  if (row.type !== 'redeem') return { ok: false, reason: 'not_redeem' };
  const companyOk = companyId && row.company_id && String(row.company_id) === String(companyId);
  const venueOk = opsLocationId && row.location_id && String(row.location_id) === String(opsLocationId);
  if (!companyOk && !venueOk) return { ok: false, reason: 'other_venue' };
  const amt = posInt(rewardValueMinor) || 1;
  return { ok: true, amount_minor: amt, currency: null };
}

/** Per caller throttle (about 30 proofs in 10 minutes). Pure: the caller keeps the map. */
export function allowProofRequest(history, now, { max = 30, windowMs = 10 * 60 * 1000 } = {}) {
  const recent = (Array.isArray(history) ? history : []).filter((t) => now - t < windowMs);
  if (recent.length >= max) return { ok: false, history: recent };
  return { ok: true, history: [...recent, now] };
}

/**
 * Fix round (19 Sep 2026, contract C18): the processor's OWN order reference for this payment,
 * recorded as meta.order_ref on the proof. place_public_order and verify_public_order_payment
 * never let a proof whose order_ref names another order pay this one (a payment made for one
 * order cannot be replayed onto a bigger one). Null when the processor record names none (the
 * proof then counts for the order it is attached to, as before).
 *   stripe  payment_intent.metadata.ref (every customer page sets it)
 *   adyen   the ledger row's merchant_reference, else raw.merchantReference (our order ref)
 *   ryft    the session metadata ref or order_ref, when the page set one
 */
export function processorOrderRef(processor, record) {
  if (!record || typeof record !== 'object') return null;
  let ref = null;
  if (processor === 'stripe') ref = record.metadata && record.metadata.ref;
  else if (processor === 'adyen') ref = record.merchant_reference || (record.raw && (record.raw.merchantReference || record.raw.merchant_reference));
  else if (processor === 'ryft') ref = record.metadata && (record.metadata.ref || record.metadata.order_ref);
  const s = ref == null ? '' : String(ref).trim();
  // Only an order ref shape (place_public_order: letters, digits, dot, underscore, colon, dash,
  // up to 40). Adyen references of other flows (terminal jobs, refunds, tab captures) are not
  // order refs.
  if (!s || !/^[A-Za-z0-9][A-Za-z0-9._:-]{1,39}$/.test(s)) return null;
  if (processor === 'adyen' && /^(tj-|rf:|tab-capture:|tab-cancel:)/.test(s)) return null;
  return s;
}

/**
 * C18: a loyalty reward's fixed money value in pence (loyalty_rewards.reward_value.amount_minor),
 * or 0 when the reward has none (a free item, a percentage): the proof then keeps the marker 1.
 * The server caps a declared loyalty discount at this value.
 */
export function loyaltyRewardValueMinor(reward) {
  const v = reward && reward.reward_value;
  if (!v || typeof v !== 'object') return 0;
  return posInt(v.amount_minor);
}
