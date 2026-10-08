// barTabTax.js: the tax a bar tab close books.
//
// 27 Sep 2026 (after the v5.9.97 Leeds reader sales): a bar tab at a UK venue closed with
// tax_amount null. BarSurface only stamped tax when the tab charged added-on (US) tax, so every
// UK bar tab booked no VAT, the same fault as the 192 reader sales. The bill itself was right
// (the checkout screen showed "of which VAT"); only the record dropped it.
//
// The record now books:
//   - added-on (US) tax: the bill's own record, exactly as before (what the checkout charged);
//   - UK inclusive VAT: computeCheckTotals over the tab's lines, the ONE place every till close
//     books UK VAT (scaled by the bill's discounts, taxShare.inclusiveTaxOnCharged). A tab has no
//     check discounts, no auto deals and no service charge of its own, so none go in; promo and
//     loyalty credits are tenders and never move UK VAT. A bill comped to nothing books none
//     (taxForChargedGoods), as recordWalkInClosed;
//   - nothing (the old record) when the venue has no tax set up, or anything goes wrong.
// PURE: no store, runs under node --test.

import { computeCheckTotals } from './payments/checkTotals.js';
import { computeOrderTaxUnified, taxCtxHasConfig } from './taxCompute.js';
import { creditDiscountsFromPayment } from './taxBasis.js';
import { taxForChargedGoods } from './headlessTax.js';
import { isUsableBreakdown } from './taxShare.js';
import { roundVat } from './taxRule.js';

/**
 * What a bar tab's bill comes to (moved unchanged out of BarSurface tabBillWithTax, 27 Sep 2026).
 * v5.7.34: through the unified seam (order type 'bar-tab'), GATED on the bill carrying an added-on
 * component; inclusive-only venues (every UK site) get the tab total unchanged. v5.9.12: the
 * checkout's promo / loyalty credits lower the added-on tax; no credits = the pre-v5.9.12 call.
 * `tax` is the full breakdown, even inclusive-only, for the checkout screen's VAT lines.
 */
export function tabBill(tab, taxCtx, creditDiscounts = []) {
  const items = (tab?.rounds || []).flatMap(r => (r.items || []).filter(i => !i.voided));
  let bd = null;
  try {
    bd = computeOrderTaxUnified(items, taxCtx, 'bar-tab',
      creditDiscounts.length ? { discounts: creditDiscounts } : null);
  }
  catch { bd = null; }   // fail toward the old behaviour, never a guessed charge
  const exclusiveTax = Number(bd?.exclusiveTax) || 0;
  const active = exclusiveTax > 0;
  return {
    taxBreakdown: active ? bd : null,
    tax: bd,                          // always: CheckoutModal shows UK "of which VAT" from it
    exclusiveTax: active ? exclusiveTax : 0,
    total: active ? +(((tab?.total || 0) + exclusiveTax).toFixed(2)) : (tab?.total || 0),
  };
}

/**
 * @param {Array}  items        the tab's live lines (voided left out)
 * @param {object} taxCtx       the till's tax context (getTaxContext())
 * @param {object} opts
 * @param {object} [opts.bill]         BarSurface tabBillWithTax(tab, credits): { taxBreakdown, ... }
 * @param {object} [opts.paymentInfo]  what the checkout or the held card capture handed over
 * @returns {{ taxAmount: number|null, taxBreakdown: object }|null}  null = stamp nothing (as before)
 *   taxAmount is rounded once with the one rule (taxRule.roundVat, 8 Oct 2026); the record stays raw.
 */
export function tabCloseTax(items, taxCtx, { bill = null, paymentInfo = {} } = {}) {
  try {
    // Added-on (US) tax: the record the bill charged, unchanged since v5.9.12.
    if (bill?.taxBreakdown) return { taxAmount: roundVat(bill.taxBreakdown.totalTax), taxBreakdown: bill.taxBreakdown };
    if (!taxCtxHasConfig(taxCtx)) return null;
    const live = (Array.isArray(items) ? items : []).filter((i) => i && !i.voided);
    if (!live.length) return null;
    const t = computeCheckTotals({
      items: live,
      checkDiscounts: [],
      covers: 1,
      orderType: 'bar-tab',
      taxCtx,
      creditDiscounts: creditDiscountsFromPayment(paymentInfo),
    }).tax;
    // The bill charged no added-on tax (bill.taxBreakdown was null), so a record that would add
    // some is not what was charged: book nothing rather than a figure the card never took.
    if (!isUsableBreakdown(t) || (Number(t.exclusiveTax) || 0) > 0) return null;
    const booked = taxForChargedGoods(t, paymentInfo);
    if (!isUsableBreakdown(booked)) return null;
    return { taxAmount: roundVat(booked.totalTax), taxBreakdown: booked };
  } catch {
    return null;   // fail toward the old record (no tax figure), never toward a guessed one
  }
}
