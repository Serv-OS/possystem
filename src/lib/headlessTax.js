// headlessTax.js: a card sale closed by the reconciler books its VAT like any other.
//
// Peter, 27 Sep 2026: "for some reason every products tax rate has been removed
// but they where there earlier". Chasing it found Leeds had 183 of 298 checks
// with NO VAT. Every one was a card sale sent to the reader and closed by
// TerminalJobReconciler (source pos_send_to_terminal): that "headless" record
// hard coded taxAmount null and taxBreakdown null. Whichever of the modal and
// the reconciler wrote the check first won, so whether a sale had VAT depended
// on a race, not on the product.
//
// The tax a headless close books, in order:
//   1. the bill's own tax, frozen into the draft by CheckoutModal when the card
//      job was sent (exactly what the screen showed and the card charged);
//   2. otherwise the same maths buildCloseRecord uses (computeCheckTotals) over
//      the frozen items and discounts, with this till's tax context (a draft
//      from older till code, or one written by the Table Pay RPC);
//   3. null only when the venue has no tax set up at all.
// A product with no rate takes the venue's default rate (lib/tax.js
// resolveTaxRate), the same on every path.

import { computeCheckTotals } from './payments/checkTotals.js';
import { lineTaxRefs } from './venueTaxRates.js';
import { computeOrderTaxUnified } from './taxCompute.js';

/** A frozen breakdown is usable when it carries a real number for the total tax. */
export function isUsableBreakdown(b) {
  return !!b && typeof b === 'object' && b.totalTax != null && Number.isFinite(Number(b.totalTax));
}

/**
 * @param {object} draft  terminal_jobs.check_draft
 * @param {object} ctx    { taxRates, taxCtx, hasTaxConfig, deviceConfig, discountRules, timezone }
 * @returns {object|null} a computeCheckTotals style tax object ({ totalTax, breakdown, ... }) or null
 */
export function headlessTaxBreakdown(draft, ctx = {}) {
  const d = draft || {};
  if (isUsableBreakdown(d.taxBreakdown)) return d.taxBreakdown;
  const hasConfig = (Array.isArray(ctx.taxRates) && ctx.taxRates.length > 0) || !!ctx.hasTaxConfig;
  if (!hasConfig) return null;
  // A line naming a rate this till does not hold takes the venue default, as at the till
  // (lineTaxRefs, 27 Sep 2026): never no VAT because of another venue's rate id.
  const items = (Array.isArray(d.items) ? d.items.filter((i) => i && !i.voided) : []).map((i) => {
    const refs = lineTaxRefs(i.taxRateId ?? i.tax_rate_id ?? null, i.taxOverrides ?? i.tax_overrides ?? {}, ctx.taxRates);
    return refs.dropped.length ? { ...i, taxRateId: refs.taxRateId, tax_rate_id: refs.taxRateId, taxOverrides: refs.taxOverrides, tax_overrides: refs.taxOverrides } : i;
  });
  if (!items.length) return null;
  try {
    const t = computeCheckTotals({
      items,
      checkDiscounts: Array.isArray(d.discounts) ? d.discounts : [],
      covers: d.covers || 1,
      serviceChargeWaived: d.serviceChargeWaived === true,
      orderType: d.orderType || (d.tableId ? 'dine-in' : 'takeaway'),
      deviceConfig: ctx.deviceConfig,
      discountRules: ctx.discountRules,
      timezone: ctx.timezone,
      taxRates: ctx.taxRates,
      taxCtx: ctx.taxCtx,
      creditDiscounts: Array.isArray(d.taxCredits) ? d.taxCredits : [],
    });
    return isUsableBreakdown(t?.tax) ? t.tax : null;
  } catch {
    return null;   // fail toward the old record (no tax figure), never toward a guessed one
  }
}

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * A tax record for a share of a bill (0..1): every figure scaled, per item
 * detail dropped (it would not add up to the share). For a QR tab whose card
 * capture came up short, the check books only what the card took, so it books
 * only that share of the VAT; the rest is taken on the till as its own sale,
 * which books its own (27 Sep 2026, review of the Leeds fix).
 */
export function scaleTaxRecord(t, share) {
  if (!isUsableBreakdown(t)) return null;
  const f = Math.max(0, Math.min(1, Number(share)));
  if (!Number.isFinite(f)) return null;
  if (f === 1) return t;
  const out = {
    ...t,
    subtotal: (Number(t.subtotal) || 0) * f,
    totalTax: round2(Number(t.totalTax) * f),
    total: (Number(t.total) || 0) * f,
    exclusiveTax: round2((Number(t.exclusiveTax) || 0) * f),
    breakdown: Array.isArray(t.breakdown) ? t.breakdown.map((b) => ({ ...b, tax: (Number(b.tax) || 0) * f, net: (Number(b.net) || 0) * f, gross: (Number(b.gross) || 0) * f })) : [],
    share: f,
  };
  delete out.lineTaxes;
  delete out.serviceTax;
  delete out.deliveryTax;
  delete out.taxV2;
  return out;
}

/**
 * The VAT of a list of lines at this till's rates, for a check the till writes
 * without a checkout screen (a QR tab force closed, or closed short, in Orders;
 * 27 Sep 2026, review: these booked tax_amount null). Items only, as the QR
 * checkout computes them: the price the guest was shown already includes any
 * offer. A line naming a rate this till does not hold takes the venue default.
 * Null only when the venue has no tax set up at all, or nothing to tax.
 */
export function itemsTaxRecord(items, ctx = {}, { orderType = 'dine-in', share = 1 } = {}) {
  const hasConfig = (Array.isArray(ctx.taxRates) && ctx.taxRates.length > 0) || !!ctx.hasTaxConfig;
  if (!hasConfig) return null;
  const live = (Array.isArray(items) ? items.filter((i) => i && !i.voided) : []).map((i) => {
    const refs = lineTaxRefs(i.taxRateId ?? i.tax_rate_id ?? null, i.taxOverrides ?? i.tax_overrides ?? {}, ctx.taxRates);
    return { ...i, taxRateId: refs.taxRateId, taxOverrides: refs.taxOverrides };
  });
  if (!live.length) return null;
  try {
    const t = computeOrderTaxUnified(live, ctx.taxCtx || { taxRates: ctx.taxRates || [] }, orderType);
    if (!isUsableBreakdown(t)) return null;
    return share === 1 ? t : scaleTaxRecord(t, share);
  } catch {
    return null;   // fail toward the old record (no tax figure), never toward a guessed one
  }
}

/** The share of a bill's goods a payment covered (0..1): what the check books over the goods it lists. */
export function paidShare(paidGoods, items) {
  const gross = (Array.isArray(items) ? items : []).filter((i) => i && !i.voided)
    .reduce((t, i) => t + (Number(i.price) || 0) * (Number(i.qty) || 1), 0);
  const paid = Number(paidGoods);
  if (!(gross > 0) || !Number.isFinite(paid)) return 1;
  return Math.max(0, Math.min(1, paid / gross));
}

/**
 * The service a headless close books (27 Sep 2026, second review). The frozen
 * draft's total minus its subtotal is whatever was on the bill over the goods.
 * At a sales tax venue (exclusive, US) that includes the tax added on top, and
 * the record now also books that tax as taxAmount, so taking it out of sales
 * (lib/accountingDay.js) with the service still holding it would count it
 * twice and understate goods. The added-on tax is taken out of service here,
 * never below zero. UK inclusive VAT adds nothing on top (exclusiveTax 0), so
 * nothing changes there.
 */
export function headlessService(draft, tax = null) {
  const d = draft || {};
  const overMinor = Math.max(0, (Number(d.totalMinor) || 0) - (Number(d.subtotalMinor) || 0));
  const addedMinor = isUsableBreakdown(tax) ? Math.round((Number(tax.exclusiveTax) || 0) * 100) : 0;
  return Math.max(0, overMinor - Math.max(0, addedMinor)) / 100;
}

/**
 * v5.9.97 (review of the card VAT fix): a bill discounted to nothing (a 100% comp) took no money
 * for goods, so it books no VAT. UK inclusive VAT is worked out on prices before discount
 * (calculateOrderTax), so without this a comp booked £0 taken with the full price's VAT. Gift card,
 * loyalty and promo credits never reduce `grand` (CheckoutModal books the gross), so only a real
 * discount to zero lands here. Unchanged when the charged amount is not known.
 */
export function taxForChargedGoods(tax, paymentInfo = {}) {
  if (!isUsableBreakdown(tax)) return tax;
  const grand = paymentInfo?.grand;
  if (grand == null || grand === '' || !Number.isFinite(Number(grand))) return tax;
  const goods = Number(grand) - (Number(paymentInfo?.tip) || 0);
  return goods <= 0.004 ? scaleTaxRecord(tax, 0) : tax;
}
