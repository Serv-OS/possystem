// src/lib/kioskCardLink.js
//
// A kiosk card sale taken on a card machine (a terminal job: Adyen or Ryft), booked so the
// till can refund it to the card.
//
// 30 Sep 2026 (Coffee Boy Barnsley, R3127 and R3128): the kiosk sent the charge to the reader
// as a terminal job with a throwaway closed check id ('chk-kiosk-<uuid>'), and on approval
// called onPaid() with nothing. submitOrder then booked the sale under its own id with no
// processor (so the column default 'stripe'), no card reference and no tenders. The till's
// "Return to card" said "via Stripe Terminal" and "No card payment is linked to this check",
// and a manager's refund was recorded while the card was never reversed.
//
// Now the reader's approved job is handed to submitOrder, and the sale is booked the way the
// till books a reader sale (store.closeApprovedTerminalJob):
//   the check id is the job's closed_check_id (ScreenPay sends the basket's check id),
//   processor = the job's processor,
//   stripe_payment_intent_id = the job's transaction_id (the refund leg, refundMath.cardLegsOf),
//   tenders = the card leg (psp_ref = transaction_id) plus the gift card and credits,
// and the job is then marked reconciled.
//
// Pure: imports only lib/accounting/tenders.js (import free), so node:test can load it.
import { tillTenders } from './accounting/tenders.js';

const KIND = 'terminal_job';

/**
 * The card payment a kiosk terminal job took, or null when the job does not prove one.
 * Only an APPROVED job with a real charge counts (the same guard closeApprovedTerminalJob
 * uses): anything else never books a card leg. The transaction id may be null (an approved
 * settle can carry no reference); the sale is then booked on the right processor with no
 * card reference, which is honest, and a refund goes back by hand.
 * @param {any} job              terminal_jobs row as terminal-job-status returns it
 * @param {string|null} closedCheckId the id ScreenPay sent as the job's closed_check_id
 */
export function kioskReaderPayment(job, closedCheckId = null) {
  if (!job || typeof job !== 'object') return null;
  if (job.status !== 'approved') return null;
  const chargeMinor = Math.round(Number(job.charge_minor));
  if (!Number.isFinite(chargeMinor) || chargeMinor <= 0) return null;
  const tipMinor = Math.max(0, Math.round(Number(job.tip_minor) || 0));
  return {
    kind: KIND,
    jobId: job.id != null ? String(job.id) : null,
    processor: job.processor ? String(job.processor).toLowerCase() : null,
    transactionId: job.transaction_id ? String(job.transaction_id) : null,
    chargeMinor,
    tipMinor: Math.min(tipMinor, chargeMinor),
    card: job.card && typeof job.card === 'object' ? job.card : null,
    authCode: job.auth_code || null,
    closedCheckId: job.closed_check_id || closedCheckId || null,
  };
}

/**
 * Is this a card payment from kioskReaderPayment? The pay screen's "Place order" buttons pass
 * a click event (old screen: onClick={onPaid}) or nothing (new screen), and neither may ever
 * be read as a card payment.
 */
export function isKioskReaderPayment(x) {
  return !!x && typeof x === 'object' && x.kind === KIND
    && Number.isInteger(x.chargeMinor) && x.chargeMinor > 0;
}

/**
 * Does this card machine payment belong to the basket on screen? It does when it carries the
 * basket's check id (ScreenPay sends that id as the job's closed_check_id, KioskApp ensureCheckId).
 * A reset clears the basket's id, so a payment whose approval lands after the X or the idle
 * reset (ScreenPay hands it over 0.8 s after approval) is never this basket's: it is booked once
 * under its own id and never kept for the next customer's basket.
 * @param {any} payment           kioskReaderPayment(...)
 * @param {string|null} basketCheckId  the basket's check id now (checkIdRef), or null after a reset
 */
export function kioskPaymentIsThisBasket(payment, basketCheckId) {
  return isKioskReaderPayment(payment)
    && typeof basketCheckId === 'string' && basketCheckId !== ''
    && payment.closedCheckId === basketCheckId;
}

/**
 * Does a card machine payment kept from an earlier attempt (the charge went through, the order
 * did not save, then the pay screen opened again) still pay this basket exactly? What the card
 * took for the order (less any tip the reader added itself) must be what the basket asks the
 * card for now, in minor units. When the basket has changed since (a gift card added, an item
 * removed) the answer is no: the sale is never booked against a payment of another amount, and
 * the card is never charged again either, so a member of staff sorts it out.
 * @param {any} held       kioskReaderPayment(...)
 * @param {number} dueMinor what the card should take for the basket now (Math.round(grandTotal * 100))
 */
export function kioskHeldPaymentFits(held, dueMinor) {
  if (!isKioskReaderPayment(held)) return false;
  const due = Number(dueMinor);
  if (!Number.isFinite(due)) return false;
  const tookMinor = held.chargeMinor - Math.max(0, Math.round(Number(held.tipMinor) || 0));
  return tookMinor === Math.round(due);
}

/**
 * The payment columns of a kiosk closed_checks row.
 *   reader        kioskReaderPayment(...) or null
 *   tip           the kiosk tip (major units), inside the card charge
 *   giftRecord    giftCardCheckRecord(...) (applied in MINOR units, what was really debited)
 *   loyaltyCredit, promoCredit   major units (discount credits)
 *
 * With a reader payment: { processor, stripe_payment_intent_id, tenders } (the first two only
 * when the job names them). The card tender is what the card really took, less any tip the
 * reader added itself (the reader tip heal adds that to the sale later, like the till).
 *
 * With none: {} and the row is written exactly as before. A kiosk that cannot name its card
 * payment (the Stripe reader branch, which still passes nothing) must never write a tender
 * list that leaves the card out, and a fully covered order is split exactly from its own
 * gift_card, loyalty and promo fields by the accounting reader (_shared/accountingDay.js).
 */
export function kioskCheckPaymentFields({ reader = null, tip = 0, giftRecord = null, loyaltyCredit = 0, promoCredit = 0 } = {}) {
  if (!isKioskReaderPayment(reader)) return {};
  const tillMoney = (reader.chargeMinor - (Number(reader.tipMinor) || 0)) / 100;
  const tenders = tillTenders({
    method: 'card',
    tillMoney,
    tip: Math.max(0, Number(tip) || 0),
    giftRecord,
    loyaltyCredit: Math.max(0, Number(loyaltyCredit) || 0),
    promoCredit: Math.max(0, Number(promoCredit) || 0),
    pspRef: reader.transactionId || null,
    processor: reader.processor || null,
  });
  return {
    ...(reader.processor ? { processor: reader.processor } : {}),
    ...(reader.transactionId ? { stripe_payment_intent_id: reader.transactionId } : {}),
    ...(tenders ? { tenders } : {}),
  };
}
