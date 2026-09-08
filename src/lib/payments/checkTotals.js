/**
 * checkTotals.js — ONE implementation of "what does this check come to".
 *
 * This was extracted verbatim out of the store's getPOSTotals() so that a second
 * caller (SessionSync, stamping a server-readable total onto active_sessions for
 * PaxPay Table Pay) cannot drift away from what the POS actually charges.
 *
 * Two pricing paths is the same failure mode as the sbUpsertCategory /
 * upsertMenuCategory gotcha in CLAUDE.md: it works until someone adds a rule to
 * one of them. There is deliberately only one implementation here — getPOSTotals
 * is now a thin wrapper that supplies the active context.
 *
 * Pure: no store access, no I/O. Everything it needs arrives in `ctx`.
 */

// .js extensions so Node's ESM loader can run this file under `npm test`
// (checkTotals.test.js) — Vite resolves either form identically.
import { resolveServiceCharge } from '../serviceCharge.js';
import { evaluateAutoDiscounts, toAppliedDiscount } from '../discountEngine.js';
import { buildScheduleCtx } from '../scheduleCtx.js';
import { calculateOrderTax } from '../tax.js';
import { computeOrderTaxUnified } from '../taxCompute.js';

/**
 * @param {object} ctx
 * @param {Array}  ctx.items                 line items (voided ones are excluded here)
 * @param {Array}  ctx.checkDiscounts        manual check-level discounts
 * @param {number} ctx.covers
 * @param {boolean} ctx.serviceChargeWaived
 * @param {string} ctx.orderType             'dine-in' | 'takeaway' | 'delivery' | ...
 * @param {object} ctx.deviceConfig          device profile (drives the service charge)
 * @param {Array}  ctx.discountRules         auto-discount rules
 * @param {string} [ctx.timezone]            venue timezone for schedule evaluation
 * @param {object} [ctx.deliveryQuote]       accepted courier quote, delivery only
 * @param {Array}  [ctx.taxRates]            venue tax rates — enables the ADDED-ON
 *                                           (exclusive) sales-tax term. Omitted =
 *                                           exclusiveTax 0 and totals identical to
 *                                           v5.7.30 (UK inclusive VAT contributes
 *                                           nothing here either way).
 * @param {Object} [ctx.taxCtx]              v5.7.34: full tax context
 *                                           (getTaxContext / buildLocalTaxCtx) —
 *                                           when present the exclusive term comes
 *                                           from the unified seam (profiles OR
 *                                           legacy parity) instead of raw taxRates.
 */
export function computeCheckTotals(ctx) {
  const {
    items = [], checkDiscounts = [], covers = 1, serviceChargeWaived = false,
    orderType, deviceConfig, discountRules, timezone, deliveryQuote, taxRates,
  } = ctx || {};

  // Subtotal — voided items excluded, item discounts applied
  const subtotal = items.filter(i => !i.voided).reduce((s, i) => {
    const base = i.price * i.qty;
    if (!i.discount) return s + base;
    return s + (i.discount.type === 'percent' ? base * (1 - i.discount.value / 100) : Math.max(0, base - i.discount.value));
  }, 0);

  // Auto-discount rules (BOGO / bundle / scheduled) — evaluated live against the cart and folded
  // in beside any manual check discounts. toAppliedDiscount emits the SAME {type:'amount',value}
  // shape manual discounts use, so the reducer below + receipts/reports need no change. Channel
  // 'pos'; each rule is gated by its schedule/expiry in location-local time.
  const autoDiscounts = evaluateAutoDiscounts(items, discountRules, 'pos', buildScheduleCtx(timezone))
    .map(toAppliedDiscount);
  const allCheckDiscounts = [...checkDiscounts, ...autoDiscounts];

  // Check-level discounts (manual + auto)
  const checkDiscount = allCheckDiscounts.reduce((s, d) => s + (d.type === 'percent' ? subtotal * d.value / 100 : d.value), 0);
  const discountedSub = Math.max(0, subtotal - checkDiscount);

  // Service charge — from device profile config, dine-in only, respects waived flag
  const serviceRate = resolveServiceCharge({ deviceConfig, orderType, covers, waived: serviceChargeWaived });
  const service = discountedSub * serviceRate;

  // v5.5.646: address-based delivery surcharge. The accepted quote is held on
  // store.deliveryQuote; only fold it in for delivery orders.
  const deliveryFee = (orderType === 'delivery' && deliveryQuote?.available)
    ? (deliveryQuote.customerFeeMinor || 0) / 100
    : 0;

  // v5.7.31: ADDED-ON sales tax (US exclusive rates). The POS has always
  // RENDERED "+ Sales Tax" lines it never charged — the exclusive share now
  // rides the total so the bill equals the receipt. The BASIS is deliberately
  // the engine's existing one: item price × qty, pre item-discount, ignoring
  // check-level discounts, service and delivery — identical to what the tax
  // lines on screen and closed_checks.tax_amount already book. Inclusive (UK)
  // VAT contributes exactly 0, so UK totals are byte-identical to v5.7.30.
  let exclusiveTax = 0;
  if (ctx?.taxCtx) {
    // v5.7.34: the unified seam (profiles cascade OR legacy parity). On a
    // legacy-equivalent venue this IS calculateOrderTax byte-for-byte.
    try { exclusiveTax = computeOrderTaxUnified(items, ctx.taxCtx, orderType || 'dine-in').exclusiveTax || 0; }
    catch { exclusiveTax = 0; }   // fail toward the old behaviour, never a guessed charge
  } else if (Array.isArray(taxRates) && taxRates.length) {
    try { exclusiveTax = calculateOrderTax(items, taxRates, orderType || 'dine-in').exclusiveTax || 0; }
    catch { exclusiveTax = 0; }   // fail toward the old behaviour, never a guessed charge
  }

  return {
    subtotal, checkDiscount, discountedSub, service,
    autoDiscounts,                      // applied auto-discount lines (display + receipt)
    checkDiscounts: allCheckDiscounts,  // manual + auto merged (POS renders each line)
    serviceChargeWaived,
    serviceChargeApplicable: orderType === 'dine-in' && (deviceConfig?.serviceCharge?.enabled !== false),
    deliveryFee,                        // customer-facing delivery surcharge (£)
    deliveryQuote: orderType === 'delivery' ? (deliveryQuote || null) : null,
    exclusiveTax,                       // added-on sales tax charged on top (0 for UK inclusive VAT)
    total: discountedSub + service + deliveryFee + exclusiveTax,
    itemCount: items.filter(i => !i.voided).reduce((s, i) => s + i.qty, 0),
  };
}

/**
 * Minor units for a table session, for the server-readable stamp on
 * active_sessions. Tables are always dine-in.
 *
 * Money crosses into the DB as bigint minor units and nothing downstream ever
 * sees a float — Math.round here is the single conversion point.
 *
 * Returns null when there is nothing payable, so callers can distinguish
 * "no total" from "£0.00" (terminal_start_table_payment refuses on both, but
 * for different reasons).
 */
export function sessionTotalsMinor(session, opts) {
  if (!session || !Array.isArray(session.items) || !session.items.length) return null;
  const t = computeCheckTotals({
    items: session.items,
    checkDiscounts: session.discounts || [],
    covers: session.covers || 1,
    serviceChargeWaived: session.serviceChargeWaived || false,
    orderType: 'dine-in',
    deviceConfig: opts?.deviceConfig,
    discountRules: opts?.discountRules,
    timezone: opts?.timezone,
    deliveryQuote: null,
    // v5.7.31: the stamped table-pay amount must match the till's bill — which
    // now carries added-on sales tax. UK venues: 0, stamp unchanged.
    taxRates: opts?.taxRates,
    // v5.7.34: full tax context so profile venues stamp the same bill the till
    // computes through the unified seam. Absent = legacy taxRates term above.
    taxCtx: opts?.taxCtx,
  });
  if (!Number.isFinite(t.total) || !Number.isFinite(t.subtotal)) return null;
  return {
    subtotalMinor: Math.round(t.subtotal * 100),
    totalMinor: Math.round(t.total * 100),
  };
}
