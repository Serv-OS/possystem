// Channel-order (HubRise) money model — ONE builder for every path that books a
// delivery-channel sale into closed_checks, so the figures are identical whether the
// order completes via the Orders Hub "collected" advance (prepaid) or via the POS pay
// flow (unpaid / part-paid balance collected at the till).
//
// The invariant this file exists to protect (owner: "it has to match financially
// perfectly"):
//
//   subtotal (all lines incl modifiers) − discounts + delivery + service + tip = total
//
// with every figure decoded from the channel order, tax resolved from OUR tax engine,
// and the paid/due split taken from the decoded payments[] — never recomputed from
// whatever cart the order happened to be loaded into.
//
// closed_checks mapping for a channel order:
//   subtotal            Σ line gross incl modifier prices (and modifier qty)
//   discounts[]         channel discounts, POS shape + name + ref (reports show real names)
//   customer.delivery_fee  Σ delivery-type charges (same slot online/catering delivery uses,
//                          so receipts + reports read one field for every source)
//   service             Σ remaining charges (bag fee, service fee, …) — NEVER delivery
//   tip                 Σ tip/gratuity-type charges
//   tax_amount          our tax engine over matched lines (unknown refs book 0, never guessed)
//   total               the channel's headline total (already nets all of the above)

import { calculateOrderTax } from './tax.js';

/** Modifier total for one line, per unit — includes modifier quantity. */
export const modsTotal = (mods) =>
  (mods || []).reduce((s, m) => s + (Number(m.price) || 0) * (Number(m.qty) || 1), 0);

/** Gross for one line including modifiers. */
export const lineGross = (it) =>
  (Number(it.qty) || 1) * ((Number(it.price) || 0) + modsTotal(it.mods));

/** Charge classification. HubRise charge types are free-ish ('delivery'|'tip'|'other'…)
 *  and channels often send type 'other' with a descriptive name — classify on both. */
export const isDeliveryCharge = (ch) =>
  ch?.type === 'delivery' || /deliv/i.test(String(ch?.name || ch?.ref || ''));
export const isTipCharge = (ch) =>
  ch?.type === 'tip' || /\btip\b|gratuity/i.test(String(ch?.name || ''));

/** Map a channel service type onto our tax-engine order types. */
export const channelOrderTypeForTax = (svc) =>
  svc === 'collection' ? 'takeaway' : svc === 'dine-in' || svc === 'eat_in' ? 'dine-in' : 'delivery';

/**
 * Build the money fields for a channel order's closed check.
 * `order` is the Orders Hub queue entry (items + customer jsonb with decoded
 * payments/charges/discounts). Pure — callers add ids/staff/method/timestamps.
 */
export function buildChannelCloseFields(order, { menuItems = [], taxRates = [] } = {}) {
  // Booked lines follow the NATIVE POS line contract: unit price INCLUDES modifier
  // prices (checkTotals, receipts, refunds all compute price × qty and ignore mod
  // prices). Channel queue rows arrive base-price + priced mods, so fold here; each
  // mod keeps its decoded price under _channelPrice for audit, but is zeroed so no
  // consumer can ever double-count it.
  const items = (order.items || []).map(i => ({
    ...i, voided: false,
    price: +(((Number(i.price) || 0) + modsTotal(i.mods)).toFixed(2)),
    mods: (i.mods || []).map(m => ({ ...m, price: 0, _channelPrice: Number(m.price) || 0 })),
  }));
  const subtotal = +items.reduce((s, it) => s + lineGross(it), 0).toFixed(2);
  const total = Number(order.total) || 0;

  // Discounts — POS shape (label) + name + ref so Exceptions/EOD and the HubRise
  // reconciliation can all read them.
  const discounts = (order.customer?.discounts || [])
    .filter(d => Number(d.amount))
    .map(d => ({
      label: d.name || 'Channel discount', name: d.name || 'Channel discount',
      ref: d.ref || null, type: 'amount',
      value: Number(d.amount), amount: Number(d.amount),
      scope: 'check', source: 'channel',
    }));
  const discountTotal = +discounts.reduce((s, d) => s + d.amount, 0).toFixed(2);

  // Charges — split by kind so delivery money is recorded as delivery money.
  const charges = (order.customer?.charges || []).filter(c => Number(c.amount));
  const deliveryFee = +charges.filter(isDeliveryCharge).reduce((s, c) => s + Number(c.amount), 0).toFixed(2);
  const tip = +charges.filter(c => !isDeliveryCharge(c) && isTipCharge(c)).reduce((s, c) => s + Number(c.amount), 0).toFixed(2);
  const service = +charges.filter(c => !isDeliveryCharge(c) && !isTipCharge(c)).reduce((s, c) => s + Number(c.amount), 0).toFixed(2);

  // Tax — OUR rates. sku_ref == our menu_item id; modifiers inherit the parent line's
  // rate by folding into the line gross. Unknown refs resolve no rate -> 0 for that line.
  const svc = order.channel || order.type;
  const hrOrderType = channelOrderTypeForTax(svc);
  const taxItems = items.map(it => {
    const mi = menuItems.find(m => m.id === (it.itemId || it.id));
    return {
      price: Number(it.price) || 0,   // already folded above — mods inherit the line's rate
      qty: Number(it.qty) || 1,
      taxRateId: mi?.taxRateId ?? null,
      taxOverrides: mi?.taxOverrides || {},
    };
  });
  let taxBreakdown = null;
  if (taxRates.length) {
    try { taxBreakdown = calculateOrderTax(taxItems, taxRates, hrOrderType); } catch { /* conservative: null */ }
  }

  // Paid/due — from the decoded channel payments, same rule as the queue decode.
  const payments = order.customer?.payments || [];
  const paidAmount = +payments.reduce((s, p) => s + (Number(p.amount) || 0), 0).toFixed(2);
  const due = Math.max(0, +(total - paidAmount).toFixed(2));

  return {
    items, subtotal, discounts, discountTotal,
    deliveryFee, service, tip, charges,
    taxAmount: taxBreakdown ? +taxBreakdown.totalTax.toFixed(2) : null,
    taxBreakdown,
    total, payments, paidAmount, due,
    channelPaid: payments.length > 0 && paidAmount >= total - 0.005,
  };
}
