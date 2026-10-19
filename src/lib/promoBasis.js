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
 * The promo a till checkout holds once promo-redeem says the code is valid (CheckoutModal
 * applyPromoCode calls this, never builds the object itself). `basket` is the figure the code was
 * checked on, kept so the redeem records the same one (promoRedeemBasket). Round 1 fix (19 Oct
 * 2026): the checkout stored it as `basis` while the redeem read `basket`, so the till still
 * recorded record.subtotal (goods before any discount) and a percent code logged a bigger
 * discount_value than the check took. One builder, one name.
 */
export function heldPromo(code, data, basket, lines = null, deliveryFee = null) {
  const d = data && typeof data === 'object' ? data : {};
  const discount = d.discount && typeof d.discount === 'object' ? d.discount : {};
  const held = basket != null && basket !== '' && Number.isFinite(Number(basket)) ? { basket: promoBasketValue({ discountedSub: basket }) } : {};
  // v5.11.81: the basket's lines and delivery fee the code was checked with (promoMath.js), so the
  // redeem works the discount out on the same basket (a category rule, a free item, free delivery).
  const withLines = Array.isArray(lines) && lines.length ? { basketLines: lines } : {};
  const withFee = Number(deliveryFee) > 0 ? { basketDeliveryFee: Number(deliveryFee) } : {};
  return { code, code_id: d.code_id, offer_id: d.offer?.id, ...discount, ...held, ...withLines, ...withFee };
}

/**
 * The basket value a till records when it redeems a promo: the figure it validated on, kept on
 * the applied promo as `basket` (heldPromo); else the record's subtotal (an older applied promo
 * with none). `basis` is read too: the name v5.11.78 round 0 held it under.
 */
export function promoRedeemBasket(promo, record) {
  const held = promo ? (promo.basket ?? promo.basis) : null;
  if (held != null && held !== '' && Number.isFinite(Number(held))) return promoBasketValue({ discountedSub: held });
  return promoBasketValue({ subtotal: record?.subtotal });
}

/**
 * v5.11.81 (round 1 fix, "a free item code kept after the item is removed"): the basket a code was
 * checked on, as one key: the basket value in pence plus every line (item, quantity, price), sorted.
 * A code's amount depends on its lines (category rules, a free item), so a swap at the same price
 * (the free latte for a flat white) is a different basket and the code is checked again. Was the
 * basket value alone on the new kiosk, and never re-checked on the old one.
 * @param {number} basket  the promo basket value (promoBasketValue)
 * @param {Array}  lines   promoBasketLines(...) ({ itemId, price, qty })
 */
export function promoCheckKey(basket, lines) {
  const sig = (Array.isArray(lines) ? lines : [])
    .filter((l) => l && typeof l === 'object')
    .map((l) => `${l.itemId ?? ''}:${Math.max(1, Math.round(num(l.qty) || 1))}:${Math.round(num(l.price) * 100)}`)
    .sort()
    .join(',');
  return `${Math.round(num(basket) * 100)}|${sig}`;
}
