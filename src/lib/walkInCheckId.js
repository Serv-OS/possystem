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
