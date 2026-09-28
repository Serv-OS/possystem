// src/lib/payments/refundCardLegs.js
//
// Which card legs a refund reverses, when the till's own copy of the check may be short.
//
// 28 Sep 2026, Leeds R6404: a 9.90 reader sale was booked by a kitchen screen's terminal
// job reconciler (POS 1 had reloaded for a release mid payment), so POS 1 only held the
// realtime copy, and that copy had no card reference. Staff refunded 3.80, the till found
// no card leg and said "issue the card refund manually"; the money never went back. The
// closed_checks row had the card all along (stripe_payment_intent_id and tenders[].psp_ref).
//
// So: the till's copy first (refundMath.cardLegsOf). When it has no card leg but the check
// says a card paid, read the row itself and take the legs from there. A read that FAILS is
// reported as such, so the caller can refuse to record a refund it cannot send to the card
// instead of writing one that can never be retried. Pure: the read is injected.
import { cardLegsOf } from './refundMath.js';
import { closedCheckRefundFields } from '../closedCheckRefundFields.js';

/**
 * Did a card take money on this check? A 'card' or 'split' PART of the method
 * ('card', 'split', 'loyalty+gift_card+card', 'promo+split'), or a card tender. Matched by
 * part, never by substring: 'gift_card' is not a card payment, and a gift card sale must
 * never wait on (or be refused by) a read for a card it never had.
 */
export function checkSaysCard(check) {
  const parts = String(check?.method || '').toLowerCase().split('+');
  if (parts.includes('card') || parts.includes('split')) return true;
  return Array.isArray(check?.tenders) && check.tenders.some((t) => t?.method === 'card');
}

/**
 * @param {object} check                the till's copy of the closed check
 * @param {object} opts
 * @param {boolean} opts.cashPayout     money handed back from the drawer: never look for a card
 * @param {Function|null} opts.readRow  async () => closed_checks row (processor,
 *                                      stripe_payment_intent_id, payment_intents, tenders) or
 *                                      null when there is no row; throws when the read fails
 * @returns {Promise<{legs: Array, from: 'memory'|'database'|'none', lookupFailed: boolean, error?: string}>}
 */
export async function resolveRefundCardLegs(check, { cashPayout = false, readRow = null } = {}) {
  const legs = cardLegsOf(check);
  if (legs.length) return { legs, from: 'memory', lookupFailed: false };
  if (cashPayout || typeof readRow !== 'function' || !checkSaysCard(check)) {
    return { legs: [], from: 'none', lookupFailed: false };
  }
  let row;
  try {
    row = await readRow();
  } catch (e) {
    return { legs: [], from: 'none', lookupFailed: true, error: e?.message || String(e) };
  }
  if (!row) return { legs: [], from: 'none', lookupFailed: false };
  // The row is the record: its processor and card fields replace the copy's. The copy keeps
  // everything else (total caps the single id leg, exactly as a loaded check would).
  const fromRow = cardLegsOf({ ...check, ...closedCheckRefundFields(row) });
  return { legs: fromRow, from: fromRow.length ? 'database' : 'none', lookupFailed: false };
}
