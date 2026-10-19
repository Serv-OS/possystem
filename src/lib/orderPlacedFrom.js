// orderPlacedFrom.js: an order a customer page placed, ready for the till to take payment for
// (v5.11.78, channel parity).
//
// 19 Oct 2026: a pay later catering order (or an unpaid online or QR order) opened from Orders to
// take payment was rebuilt on the till from its lines alone:
//   - its lines are the customer page's shape, base price plus priced options, and the till's
//     bill reads price x qty, so every option was dropped (a 30.00 platter with a 10.00 option
//     charged 30.00);
//   - its delivery fee was not read from the order: the till charged whatever a fresh quote said
//     (outside the radius it refused, so staff switched the order to collection and lost the fee;
//     a courier venue quoted a live marked up price), and a quote left over from the previous sale
//     could apply;
//   - its promo code, already used when the order was placed, was ignored, so the customer was
//     charged the full price.
// The till now loads it as the customer agreed it. Lines that came from the till itself (a counter
// order sent and reopened) are left exactly as they are: they are already in the till's contract.
//
// Round 1 fixes (19 Oct 2026):
//   - the promo is handed to the checkout as the promo CREDIT it was (a promo tender, VAT left on
//     the goods), never a check discount: as a discount the till scaled the UK VAT down by it and
//     the reports counted it as a discount, so the same catering order booked 6.67 of VAT paid on
//     the page and 5.83 paid at the till. It is marked alreadyRedeemed: the code was used when the
//     order was placed and is never used again here;
//   - the order's delivery fee is bound to the order (orderRef): it counts only while that order is
//     the one on the till. Opening an order and pressing Clear left the fee on the till, and the
//     next delivery sale charged the old fee, sent no courier and logged no surcharge.
// PURE: imports only channelMoney.js.

import { foldLineMods } from './channelMoney.js';

/** Sources whose queue lines are the customer page's shape (base price plus priced options). */
export const PLACED_SOURCES = Object.freeze(['catering', 'online', 'qr']);

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

/**
 * @param {object} o  the Orders Hub entry (ref, items, customer, source, type, _raw)
 * @returns {{ items: Array, promo: object|null, deliveryQuote: object|null }}
 *   items          the lines to put in the till's cart (folded for a customer page's order)
 *   promo          the order's promo code as the checkout's held promo (CheckoutModal
 *                  promoApplied): { code, amount, type: 'amount', value, label, alreadyRedeemed:
 *                  true, orderRef }. The checkout takes it off the bill as a promo tender and
 *                  store.redeemPromoCode never redeems it again. Null when the order carries none.
 *   deliveryQuote  the order's own delivery fee, marked fromOrder and bound to the order's ref
 *                  (never re-quoted, never logged or dispatched again, never charged on another
 *                  order: quoteForWalkIn); null when the order carries none
 */
export function placedOrderForTill(o) {
  const src = String(o?.source || o?._raw?.source || '');
  const items = Array.isArray(o?.items) ? o.items : [];
  if (!PLACED_SOURCES.includes(src)) return { items, promo: null, deliveryQuote: null };
  const c = (o && o.customer && typeof o.customer === 'object') ? o.customer : {};
  const type = o?._raw?.type || o?.type || null;
  const orderRef = o?.ref ?? o?._raw?.ref ?? null;
  const fee = num(c.delivery_fee);
  const feeMinor = Math.round(fee * 100);
  const deliveryQuote = type === 'delivery' && feeMinor > 0
    ? {
        available: true, fromOrder: true, orderRef, configured: true, dispatchable: false,
        mode: c.delivery_mode || 'self', customerFeeMinor: feeMinor, trueCostMinor: feeMinor,
      }
    : null;
  const amount = Math.round(num(c.promo_discount) * 100) / 100;
  const code = c.promo_code ? String(c.promo_code) : 'PROMO';
  const promo = amount > 0
    ? { code, amount, type: 'amount', value: amount, label: `Promo ${c.promo_code || ''}`.trim(), alreadyRedeemed: true, orderRef }
    : null;
  return { items: foldLineMods(items), promo, deliveryQuote };
}

/** Is this quote a fee an order brought with it, and is that order the one the till holds? */
export function isQuoteOfOrder(quote, walkInOrder) {
  return !!(quote && quote.fromOrder && quote.orderRef != null
    && walkInOrder && walkInOrder.ref != null && walkInOrder.ref === quote.orderRef);
}

/**
 * The delivery quote the till may charge, record and act on for the walk in order it holds
 * (getPOSTotals, recordWalkInClosed, the MPOS recovery record). A live quote is returned as it is
 * (the same object: nothing changes for a till's own delivery sale). A fee an order brought with
 * it counts only while that order is on the till; for any other order (after Clear, another order
 * opened, a table) it is no quote at all, so the till quotes afresh.
 */
export function quoteForWalkIn(quote, walkInOrder) {
  if (!quote) return null;
  if (!quote.fromOrder) return quote;
  return isQuoteOfOrder(quote, walkInOrder) ? quote : null;
}

/**
 * The promo a checkout starts with: the walk in order's own already used promo (OrdersHub puts it
 * on walkInOrder.placedPromo), only when this checkout is paying that walk in order (not a table,
 * not a bar tab) and the promo belongs to it.
 */
export function placedPromoFor(walkInOrder, { tableId = null, orderType = null } = {}) {
  if (tableId || orderType === 'bar-tab') return null;
  const p = walkInOrder?.placedPromo;
  if (!p || !p.alreadyRedeemed || !(num(p.amount) > 0)) return null;
  if (p.orderRef == null || walkInOrder.ref !== p.orderRef) return null;
  return p;
}
