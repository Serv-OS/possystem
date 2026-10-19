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
// PURE: imports only channelMoney.js.

import { foldLineMods } from './channelMoney.js';

/** Sources whose queue lines are the customer page's shape (base price plus priced options). */
export const PLACED_SOURCES = Object.freeze(['catering', 'online', 'qr']);

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

/**
 * @param {object} o  the Orders Hub entry (items, customer, source, type, _raw)
 * @returns {{ items: Array, discounts: Array, deliveryQuote: object|null }}
 *   items          the lines to put in the till's cart (folded for a customer page's order)
 *   discounts      the order's promo code as the discount it was (catering pay later)
 *   deliveryQuote  the order's own delivery fee, marked fromOrder (never re-quoted, never logged
 *                  or dispatched again); null when the order carries none
 */
export function placedOrderForTill(o) {
  const src = String(o?.source || o?._raw?.source || '');
  const items = Array.isArray(o?.items) ? o.items : [];
  if (!PLACED_SOURCES.includes(src)) return { items, discounts: [], deliveryQuote: null };
  const c = (o && o.customer && typeof o.customer === 'object') ? o.customer : {};
  const type = o?._raw?.type || o?.type || null;
  const fee = num(c.delivery_fee);
  const feeMinor = Math.round(fee * 100);
  const deliveryQuote = type === 'delivery' && feeMinor > 0
    ? {
        available: true, fromOrder: true, configured: true, dispatchable: false,
        mode: c.delivery_mode || 'self', customerFeeMinor: feeMinor, trueCostMinor: feeMinor,
      }
    : null;
  const promo = num(c.promo_discount);
  const discounts = promo > 0
    ? [{ id: `promo-${c.promo_code || 'code'}`, type: 'amount', value: promo, amount: promo, label: `Promo ${c.promo_code || ''}`.trim(), code: c.promo_code || null, source: 'promo', scope: 'check' }]
    : [];
  return { items: foldLineMods(items), discounts, deliveryQuote };
}
