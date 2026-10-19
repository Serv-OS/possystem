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
//   tax_amount          our tax engine over the lines, rounded once (taxRule.roundVat). 8 Oct 2026
//                       (D4): a line whose ref is not one of our products takes the VENUE DEFAULT
//                       rate and the record says so (tax_breakdown.fallbacks, reason
//                       'item-not-on-menu'). It used to book 0 on purpose: 17 HubRise sales at
//                       Provo booked £0 VAT on £692.71 that way. With no tax set up at all the
//                       sale books null (not recorded), never 0.00.
//   total               the channel's headline total (already nets all of the above)

import { computeOrderTaxUnified, taxCtxHasConfig } from './taxCompute.js';
import { roundVat, NOT_IN_MENU } from './taxRule.js';
import { lineTaxRefsFor } from './taxRefs.js';
import { lineCategories } from './lineCategories.js';

/** v5.11.81 round 1: the one category a line counts under for tax (a size: its product's). */
const lineCat = (mi, menuItems) => { const c = lineCategories(mi, menuItems); return c.cat ?? (c.cats ? c.cats[0] : null) ?? null; };
import { inclusiveTaxOnCharged } from './taxShare.js';

/** Modifier total for one line, per unit — includes modifier quantity. */
export const modsTotal = (mods) =>
  (mods || []).reduce((s, m) => s + (Number(m.price) || 0) * (Number(m.qty) || 1), 0);

/** Gross for one line including modifiers. */
export const lineGross = (it) =>
  (Number(it.qty) || 1) * ((Number(it.price) || 0) + modsTotal(it.mods));

/**
 * 19 Oct 2026 (v5.11.78, channel parity): THE line contract every booked check follows is the
 * till's. A line's `price` INCLUDES its paid options (store addItem, cartUnitPrice) and each option
 * keeps its own price for display (receipts and the Product mix modifier table read them; 6,300
 * till, kiosk and reader checks with paid options are stored this way). Queue rows from the
 * customer pages (online, QR, catering) arrive base price plus priced options. Writing them raw
 * split closed_checks into two conventions: the daily VAT check, the save guard, the Tax and Z
 * report split by rate, a part refund and the till's cart all read price x qty, so 12 QR and 1
 * online check with paid options read their lines WITHOUT the options (a 4.00 latte with a 0.70
 * syrup derived 0.67 of VAT where 0.78 was booked, and the daily check told the owner the VAT was
 * wrong). The server books public checks the same way since migration 20261019a.
 *
 * This folds the options into the price ONCE and leaves each option's price in place, marking the
 * line `_modsFolded` so it is never folded twice. Same array back when no line has priced
 * options. Never pass a till line through it (already folded, options priced, no marker): it would
 * count them twice. Callers fold only the items they SAVE (or put in the till's cart), after any
 * VAT has been worked out from the raw lines (those maths add the options themselves).
 */
export function foldLineMods(items) {
  if (!Array.isArray(items)) return items;
  let changed = false;
  const out = items.map((i) => {
    if (!i || typeof i !== 'object' || i._modsFolded) return i;
    const extra = modsTotal(i.mods);
    if (!(extra > 0)) return i;
    changed = true;
    return { ...i, price: +(((Number(i.price) || 0) + extra).toFixed(2)), _modsFolded: true };
  });
  return changed ? out : items;
}

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
export function buildChannelCloseFields(order, { menuItems = [], taxRates = [], taxCtx = null } = {}) {
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
  // rate by folding into the line gross.
  const svc = order.channel || order.type;
  const hrOrderType = channelOrderTypeForTax(svc);
  const taxItems = items.map(it => {
    const mi = menuItems.find(m => m.id === (it.itemId || it.id));
    // 19 Oct 2026 (v5.11.78, channel parity): a matched line carries the till's own tax
    // references (lib/taxRefs.js): a size with no VAT of its own follows its product, exactly as
    // store addItem does. This read the size row alone, so a Deliveroo size on "Use default"
    // under a 5% product booked the venue's 20%, and nothing corrected it.
    const refs = mi ? lineTaxRefsFor(mi, menuItems) : null;
    return {
      price: Number(it.price) || 0,   // already folded above — mods inherit the line's rate
      qty: Number(it.qty) || 1,
      // Matched item: its rate (null = venue default, resolved by the engine v5.5.857).
      // UNKNOWN ref: the sentinel id. 8 Oct 2026 (D4): the engine resolves it to the venue
      // default and notes the line in tax_breakdown.fallbacks ('item-not-on-menu'), so the sale
      // carries VAT and the owner sees which line needs mapping. Until then it resolved NO rate
      // and booked zero on purpose, which is wrong at a venue where everything is standard rated.
      // v5.7.34: matched items also carry their profile cascade inputs; unknown
      // refs carry NO itemId/cat so no profile can ever apply to them either.
      itemId: mi ? mi.id : null,
      // v5.11.81 round 1: a size counts under its PRODUCT's category (lineCategories, the till's
      // rule), so a category tax profile reaches it; the size row's own (often stale) one did not.
      cat: mi ? lineCat(mi, menuItems) : null,
      taxProfileId: refs ? refs.taxProfileId : null,
      taxRateId: refs ? refs.taxRateId : NOT_IN_MENU,
      taxOverrides: refs ? refs.taxOverrides : {},
      // So a fallback note names the channel line (its own id and name, not our item's).
      lineId: it.uid ?? it.id ?? it.itemId ?? null,
      name: it.name ?? null,
    };
  });
  let taxBreakdown = null;
  // 8 Oct 2026: only with tax set up (rates or profiles). A till holding no rates used to run the
  // seam over an empty list and book 0.00, which every report reads as zero rated; now it books
  // null (not recorded), which the close guard refuses at a venue that has tax set up.
  const ctx = taxCtx || { taxRates };
  if (taxCtxHasConfig(ctx)) {
    // v5.7.34: through the unified seam — legacy-equivalent venues get
    // calculateOrderTax byte-identical; profile venues get the cascade.
    // 19 Oct 2026 (v5.11.78, channel parity): the till's basis rule (payments/checkTotals.js).
    // The channel's discounts, its service type charges and its delivery fee are the check
    // basis, so added on (US) tax follows the discount and taxes a bag or service fee where the
    // line's profile says so (the till does); and UK inclusive VAT is the share of the goods
    // actually charged (taxShare.inclusiveTaxOnCharged), exactly as the till books a discounted
    // bill. Before, a 2.11 Deliveroo offer on 10.55 booked 1.76 VAT where the till books 1.41,
    // and the daily VAT check then named the sale. With no discount the record is the same
    // object as before (share 1), and UK VAT never reads the service or delivery basis.
    try {
      taxBreakdown = computeOrderTaxUnified(taxItems, ctx, hrOrderType, { discounts, service, deliveryFee });
      taxBreakdown = inclusiveTaxOnCharged(taxBreakdown, subtotal, Math.max(0, subtotal - discountTotal));
    } catch { /* conservative: null */ }
  }

  // Paid/due — from the decoded channel payments, same rule as the queue decode.
  const payments = order.customer?.payments || [];
  const paidAmount = +payments.reduce((s, p) => s + (Number(p.amount) || 0), 0).toFixed(2);
  const due = Math.max(0, +(total - paidAmount).toFixed(2));

  return {
    items, subtotal, discounts, discountTotal,
    deliveryFee, service, tip, charges,
    taxAmount: taxBreakdown ? roundVat(taxBreakdown.totalTax) : null,   // the one rounding rule (8 Oct 2026)
    taxBreakdown,
    total, payments, paidAmount, due,
    channelPaid: payments.length > 0 && paidAmount >= total - 0.005,
  };
}
