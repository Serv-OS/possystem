// walkInCheckId.js: ONE closed check id per counter basket (v5.11.81, 19 Oct 2026).
//
// A counter sale's check id was minted per CHECKOUT (CheckoutModal checkIdRef) and, on the
// handheld, per payment attempt (MPOSSurface). A basket that was paid, came back on screen and was
// paid again (a second Complete after the first close threw, a checkout opened again on the same
// cart) minted a second id, and the upsert on id could not collapse the two: the same sale was
// booked twice (Provo R40, two cash closes of 85.82, 18 s apart, 20 Sep 2026).
//
// Now the id belongs to the BASKET (store.walkInOrder.checkId, minted once by
// store.ensureWalkInCheckId): every checkout and every retry of that basket books under it, and
// recordWalkInClosed refuses to book an id that is already booked. A new basket gets a new id.
// PURE: no imports, runs under node --test.

/** A fresh check id in the till's format (chk-<ms>-<6 hex>). */
export function mintCheckId(now = Date.now(), rand = Math.random) {
  return `chk-${now}-${rand().toString(16).slice(2, 8).padEnd(6, '0')}`;
}

/** True for an id a close may book under (a non empty string). */
export function usableCheckId(id) {
  return typeof id === 'string' && id.trim().length > 0;
}

/**
 * The id a counter close books: the checkout's own (paymentInfo.closedCheckId: a card machine job
 * froze it, or the checkout took it from the basket), else the basket's, else null (the caller
 * mints one, as before).
 */
export function walkInCloseId(walkInOrder, paymentInfo) {
  if (usableCheckId(paymentInfo?.closedCheckId)) return paymentInfo.closedCheckId;
  if (usableCheckId(walkInOrder?.checkId)) return walkInOrder.checkId;
  return null;
}

/** The record already booked under this id on this till, or null. */
export function bookedCheck(closedChecks, id) {
  if (!usableCheckId(id) || !Array.isArray(closedChecks)) return null;
  return closedChecks.find((c) => c && c.id === id) || null;
}

/**
 * v5.11.81 (round 1 fix, "basket check id lets a till charge the same basket twice"): the card job
 * key leg for ONE checkout of a counter basket. The closed check id stays the basket's (one sale,
 * one row), but each checkout gets its own key, so the server's double charge net (terminal-job-create
 * section 3e) still sees an earlier approved job on the same basket from another checkout and asks
 * before charging again. With one key per basket the net skipped it as "a retry, not a repeat". A
 * retry inside the same checkout keeps the same key (the checkout keeps its nonce) and re-attaches.
 */
export function checkoutKeyLeg(checkId, nonce) {
  return usableCheckId(nonce) ? `${checkId}:${nonce}` : checkId;
}

/** A short random nonce for checkoutKeyLeg (6 hex). */
export function mintKeyNonce(rand = Math.random) {
  return rand().toString(16).slice(2, 8).padEnd(6, '0');
}

/**
 * v5.11.81 (round 1 fix): staff answered "Different customer, take payment" on a possible repeat
 * whose earlier job is booked under THIS checkout's basket id. The new charge must book its own
 * row, or it shares the id and is never booked (recordWalkInClosed refuses an id already booked).
 * Rotate only for a counter basket, and only when no gift card was debited on this checkout (its
 * debit is keyed to the current id; a new id would debit it again).
 */
export function rotateOnRepeatOverride({ priorClosedCheckId, checkId, counter, giftDebited }) {
  return !!counter && !giftDebited && usableCheckId(priorClosedCheckId) && priorClosedCheckId === checkId;
}

/** Every card transaction id a booked check names (its single id, its legs, its card tenders). */
function cardIdsOf(check) {
  const ids = new Set();
  const add = (v) => { if (usableCheckId(v)) ids.add(v); };
  add(check?.stripePaymentIntentId);
  add(check?.stripe_payment_intent_id);
  for (const p of [check?.paymentIntents, check?.payment_intents]) {
    if (Array.isArray(p)) for (const x of p) add(x?.id);
  }
  if (Array.isArray(check?.tenders)) for (const t of check.tenders) if (t?.method === 'card') add(t?.psp_ref);
  return ids;
}

/**
 * v5.11.81 (round 1 fix): a close for a basket already booked that carries a DIFFERENT card payment
 * than the booked one is a second charge with no sale behind it. Returns that card id (staff must
 * be told loudly), else null (a plain retry of the same sale, or no card on this close).
 */
export function secondCardOnBooked(booked, paymentInfo) {
  const id = paymentInfo?.stripePaymentIntentId || paymentInfo?.paymentIntentId || null;
  if (!usableCheckId(id) || !booked) return null;
  return cardIdsOf(booked).has(id) ? null : id;
}
