// promoBasis.js: the ONE basket figure a promo code is checked, valued and recorded on (v5.11.78).
//
// 18 Oct 2026 (channel parity audit, D4): the same 10% code was worth a different amount on each
// channel. The till checked it on `total` (goods after deals PLUS service charge, delivery fee
// and any added on US tax) and then recorded the use against record.subtotal (goods BEFORE any
// discount); the new kiosk used goods before deals; the old kiosk used the grand total, tip
// included; online and the server (_public_order_promo in place_public_order) used goods after
// item, check and automatic discounts, before service, tip and tax. Minimum spend was judged on
// the same mixed bases, so a code could pass on one channel and fail on another, and a till
// could give the discount and then have the redeem refused for min_spend, leaving a one time
// code usable again.
//
// The rule, the server's: goods after item, check and automatic discounts (manual and auto),
// before service, delivery, tip and tax. Every channel validates, judges minimum spend and
// records basket_value with this one figure.
//
// PURE: no imports, runs under node --test.

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

/**
 * The promo basket value from a bill's figures.
 * @param {object} p
 * @param {number} [p.discountedSub]  goods after item, check and auto discounts (computeCheckTotals.discountedSub,
 *                                    the kiosk's and QR's discountedSubtotal, online's subtotal less offers)
 * @param {number} [p.subtotal]       fallback: goods after item discounts only (a caller with no deals)
 */
export function promoBasketValue({ discountedSub, subtotal } = {}) {
  const d = discountedSub != null && discountedSub !== '' ? Number(discountedSub) : NaN;
  if (Number.isFinite(d)) return Math.max(0, +d.toFixed(2));
  return Math.max(0, +num(subtotal).toFixed(2));
}

/**
 * The basket value a till records when it redeems a promo: the figure it validated on, kept on
 * the applied promo as `basket`; else the bill's discounted goods; else the record's subtotal
 * (an older applied promo with neither).
 */
export function promoRedeemBasket(promo, record) {
  if (promo && promo.basket != null && Number.isFinite(Number(promo.basket))) return promoBasketValue({ discountedSub: promo.basket });
  return promoBasketValue({ subtotal: record?.subtotal });
}
