// kioskVat.js: the kiosk books VAT like the till, or it does not sell (8 Oct 2026).
//
// WHY (VAT audit of 8 Oct 2026, Fix 2). The kiosk read tax_rates once per boot inside the menu
// load, never looked at the read's error, kept an empty list, and wrote tax_amount null for every
// sale until a restart. Its lines carried no rate id, UK sales stored no split by rate (138
// Barnsley sales carry the right VAT with no record of the rate), a size was taxed at its parent's
// rate, and an automatic offer never scaled the VAT the way the till does.
//
// Peter's rule, 8 Oct 2026: "VAT despite the order type should follow the Tax rules set on the back
// office per menu item." So the kiosk:
//   1. loads the rates on their own, after its session exists, and retries (lib/customerRates.js
//      loadCustomerRates, the same loader the customer pages use), then keeps retrying in the
//      background while they are missing (kioskRatesRetryMs);
//   2. refuses to open the card screen while the rates are missing at a venue whose menu names
//      rates (kioskVatGate, the same ratesGate the customer pages use), with a staff message;
//   3. taxes a size at its own Back Office rate when it has one (lib/kioskLine.js kioskLineTaxRefs);
//   4. books UK VAT on what the offer left to pay, as the till does (kioskChargedTax,
//      taxShare.inclusiveTaxOnCharged), and always stores the split by rate;
//   5. hands its own rates to the save time guard (kioskVenueTax, lib/saleVatGuard.js), because
//      the kiosk's store holds no venue rates of its own.
//
// PURE: no React, no supabase. KioskApp wires it; node --test proves it.

import { ratesGate, venueExpectsRates } from './customerRates.js';
import { computeOrderTaxUnified, taxCtxHasConfig } from './taxCompute.js';
import { inclusiveTaxOnCharged } from './taxShare.js';

/** Plain words for the customer and the member of staff they fetch. Short, no dashes. */
export const KIOSK_VAT_WORDS = Object.freeze({
  title: 'Please ask a member of staff',
  loading: 'This kiosk is still loading the VAT rates, so it cannot take payment yet. Nothing has been charged.',
  failed: 'This kiosk could not load the VAT rates, so it cannot take payment yet. Nothing has been charged. Staff: press Try again, or restart the kiosk.',
  retry: 'Try again',
});

/**
 * null when the card screen may open; otherwise { code: 'loading' | 'failed', message } in the
 * kiosk's words. The rule is the customer pages' ratesGate: still loading blocks; a failed read
 * blocks; an empty list blocks when the menu names rates; a venue whose menu names no rate (and
 * has no profiles) is not blocked, it books "not recorded" as before.
 */
export function kioskVatGate({ ratesState, items = [], taxCtx = null } = {}) {
  const g = ratesGate({
    ratesState,
    expectsRates: venueExpectsRates(items),
    hasTaxConfig: taxCtx ? taxCtxHasConfig(taxCtx) : false,
  });
  if (!g) return null;
  return { code: g.code, message: g.code === 'loading' ? KIOSK_VAT_WORDS.loading : KIOSK_VAT_WORDS.failed };
}

/** The pauses between background re reads while the rates are missing (ms): 30 s, 60 s, then every 2 minutes. */
export function kioskRatesRetryMs(attempt) {
  const n = Math.max(0, Number(attempt) || 0);
  return n === 0 ? 30000 : n === 1 ? 60000 : 120000;
}

/**
 * The tax a kiosk basket is charged: the engine over the lines (each at its own Back Office rate
 * and override, order type dine-in or takeaway), then UK VAT scaled to what the automatic offers
 * left to pay, exactly as the till's computeCheckTotals does (taxShare.inclusiveTaxOnCharged:
 * goods are the lines at full price, charged is the discounted subtotal). With no offer it is the
 * very same object. Added-on (US) tax already carries the offers in its basis and is never scaled.
 * Null when the venue has no tax set up or there is nothing to tax.
 */
export function kioskChargedTax(lines, taxCtx, orderType, { autoDiscounts = [], goods = null, charged = null } = {}) {
  if (!taxCtx || !taxCtxHasConfig(taxCtx) || !Array.isArray(lines) || !lines.length) return null;
  const t = computeOrderTaxUnified(lines, taxCtx, orderType, { discounts: autoDiscounts });
  if (goods == null || charged == null) return t;
  return inclusiveTaxOnCharged(t, goods, charged);
}

/** What the kiosk hands the save time guard (saleVatGuard.assertSaleVat): its own rates and context. */
export function kioskVenueTax({ taxRates = [], taxCtx = null } = {}) {
  if (!taxCtx && !(Array.isArray(taxRates) && taxRates.length)) return null;
  return { taxRates: Array.isArray(taxRates) ? taxRates : [], taxCtx: taxCtx || { taxRates }, hasTaxConfig: taxCtx ? taxCtxHasConfig(taxCtx) : taxRates.length > 0 };
}
