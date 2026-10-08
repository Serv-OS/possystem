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
// resolveLineTaxRate), the same on every path. 8 Oct 2026: a line naming a rate
// this till does not hold takes the venue default there too, and the record says
// so (tax_breakdown.fallbacks), so this file no longer cleans rate ids itself.

import { computeCheckTotals } from './payments/checkTotals.js';
import { computeOrderTaxUnified } from './taxCompute.js';
import { modsTotal } from './channelMoney.js';
import { isUsableBreakdown, scaleTaxRecord } from './taxShare.js';
import { roundVat, TAX_FALLBACK_REASONS } from './taxRule.js';

// Moved to taxShare.js (27 Sep 2026) so the check totals seam can use them; re-exported here.
export { isUsableBreakdown, scaleTaxRecord };

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
  const items = Array.isArray(d.items) ? d.items.filter((i) => i && !i.voided) : [];
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
  } catch (e) {
    // 8 Oct 2026 (VAT audit, Fix 3): never caught into null quietly. The record then meets the
    // save time guard (lib/saleVatGuard.js), which repairs it from the frozen lines or refuses the
    // save by name; it is never saved as null at a venue with rates.
    console.error("[tax] headless close: the VAT could not be worked out:", e?.message || e);
    return null;
  }
}

// 8 Oct 2026: the one rounding rule (taxRule.roundVat), half up to the penny; a number in, a number out.
const round2 = (n) => roundVat(n) ?? 0;

/**
 * The VAT of a list of lines at this till's rates, for a check the till writes
 * without a checkout screen (a QR tab force closed, or closed short, in Orders;
 * 27 Sep 2026, review: these booked tax_amount null). Items only, as the QR
 * checkout computes them: the price the guest was shown already includes any
 * offer. A line naming a rate this till does not hold takes the venue default,
 * and the record says so (the seam's fallbacks, 8 Oct 2026).
 * Null only when the venue has no tax set up at all, or nothing to tax.
 */
export function itemsTaxRecord(items, ctx = {}, { orderType = 'dine-in', share = 1 } = {}) {
  const hasConfig = (Array.isArray(ctx.taxRates) && ctx.taxRates.length > 0) || !!ctx.hasTaxConfig;
  if (!hasConfig) return null;
  const live = Array.isArray(items) ? items.filter((i) => i && !i.voided) : [];
  if (!live.length) return null;
  try {
    const t = computeOrderTaxUnified(live, ctx.taxCtx || { taxRates: ctx.taxRates || [] }, orderType);
    if (!isUsableBreakdown(t)) return null;
    return share === 1 ? t : scaleTaxRecord(t, share);
  } catch (e) {
    // 8 Oct 2026 (VAT audit, Fix 3): logged, never silent; the save time guard repairs or refuses.
    console.error("[tax] items tax record: the VAT could not be worked out:", e?.message || e);
    return null;
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
 * QR order lines ready to tax (27 Sep 2026, the dropped v5.9.97 QR close fix). order_queue lines
 * keep the base price and each modifier's price apart (mods[].price) and carry no tax rate, so a
 * naive tax over them missed every priced modifier and took the venue default for every product.
 * Each line's unit price takes its modifiers (modsTotal, as QrCheckout taxed them), and its rate,
 * per order type overrides and tax profile come back from this till's menu by itemId (else the
 * variant's parent), as channelMoney.buildChannelCloseFields does. A line not on this till's menu
 * keeps whatever it carries; one that carries no rate of its own takes the venue default and is
 * flagged 'item-not-on-menu' (8 Oct 2026, D4), never quietly.
 */
export function qrTaxLines(items, menuItems = []) {
  const byId = new Map();
  for (const m of (Array.isArray(menuItems) ? menuItems : [])) if (m && m.id != null) byId.set(String(m.id), m);
  const find = (id) => (id != null && id !== '' ? byId.get(String(id)) : undefined);
  return (Array.isArray(items) ? items : []).filter((i) => i && !i.voided).map((i) => {
    const mi = find(i.itemId ?? i.id) || find(i.parentId);
    const out = {
      ...i,
      price: +((Number(i.price) || 0) + modsTotal(i.mods)).toFixed(2),
      qty: Number(i.qty) || 1,
      itemId: i.itemId ?? i.id ?? null,
    };
    if (mi) {
      out.taxRateId = mi.taxRateId ?? mi.tax_rate_id ?? null;
      out.taxOverrides = mi.taxOverrides ?? mi.tax_overrides ?? {};
      out.taxProfileId = mi.taxProfileId ?? mi.tax_profile_id ?? null;
      if (out.cat == null && !(Array.isArray(out.cats) && out.cats.length)) out.cat = mi.cat ?? (Array.isArray(mi.cats) ? mi.cats[0] : null) ?? null;
    } else if (!(i.taxRateId ?? i.tax_rate_id) && !i.taxFallback) {
      out.taxFallback = { reason: TAX_FALLBACK_REASONS.ITEM_NOT_ON_MENU, rateId: null };
    }
    return out;
  });
}

/**
 * The tax a QR check the till writes books: a tab or a single order force closed in Orders, or a
 * tab the guest closed short. `paidGoods` is the goods money the check books (captured less tip
 * and surcharge); a short capture books only its share of the VAT (paidShare), the rest is taken
 * on the till as its own sale. Returns the closed_checks fields:
 *   taxAmount     the VAT booked (null only when the venue has no tax set up, or nothing to tax),
 *                 rounded once with the one rule (taxRule.roundVat)
 *   taxBreakdown  the record, always (8 Oct 2026; it was written only for added-on tax or a
 *                 share): the split by rate the Xero daily invoice reads, and any fallback note
 *                 (a line that took the venue default), which must never be dropped. A share is
 *                 what reports must read as booked (taxShare.bookedTaxRecord).
 *   exclusiveTax  the added-on (US) tax in it, which QR round totals include, so the caller
 *                 takes it out of the subtotal it books (0 for UK VAT)
 * Never throws.
 */
export function qrCloseTax(items, ctx = {}, { paidGoods = null } = {}) {
  const none = { taxAmount: null, taxBreakdown: null, exclusiveTax: 0 };
  try {
    const lines = qrTaxLines(items, ctx.menuItems);
    const share = paidGoods == null ? 1 : paidShare(Math.max(0, Number(paidGoods) || 0), lines);
    const rec = itemsTaxRecord(lines, ctx, { orderType: 'dine-in', share });
    if (!rec) return none;
    const exclusiveTax = rec.hasExclusiveTax ? round2(Math.max(0, Number(rec.exclusiveTax) || 0)) : 0;
    return {
      taxAmount: round2(rec.totalTax),
      taxBreakdown: rec,
      exclusiveTax,
    };
  } catch (e) {
    // 8 Oct 2026 (VAT audit, Fix 3): logged, never silent; the save time guard repairs or refuses.
    console.error("[tax] QR close: the VAT could not be worked out:", e?.message || e);
    return none;
  }
}

/**
 * A QR tab the guest closes on their own phone (TabResumeScreen). 27 Sep 2026: it booked
 * tax_amount null, whoever wrote the check (the phone's fallback write, or settle_qr_tab on the
 * server). `rounds` are the tab's order_queue rows, `runningTotal` what the phone charged, each
 * round's tip included. The goods booked are runningTotal less the tips, so a whole tab books its
 * whole VAT (qrCloseTax: modifiers folded in, rates restored from the menu). Returns the tip, the
 * subtotal to book (goods less any added-on tax, which QR round totals include) and qrCloseTax's
 * taxAmount / taxBreakdown / exclusiveTax. Never throws.
 */
export function qrTabCloseFields(rounds, runningTotal, ctx = {}) {
  const rows = Array.isArray(rounds) ? rounds : [];
  const tip = +rows.reduce((t, r) => t + (Number(r?.customer?.tip) || 0), 0).toFixed(2);
  const goods = +((Number(runningTotal) || 0) - tip).toFixed(2);
  const tax = qrCloseTax(rows.flatMap((r) => (Array.isArray(r?.items) ? r.items : [])), ctx, { paidGoods: goods });
  return { tip, subtotal: +(goods - tax.exclusiveTax).toFixed(2), ...tax };
}

/**
 * The VAT a phone hands settle_qr_tab in p_check (27 Sep 2026). The server books it the way
 * place_public_order books a page's tax_amount, clamped to the goods it books (migration
 * 20260927c); a server without that migration ignores both keys. Empty when there is no figure.
 */
export function qrTabSettleVat(fields) {
  if (!fields || fields.taxAmount == null || !Number.isFinite(Number(fields.taxAmount))) return {};
  return { tax_amount: round2(fields.taxAmount), exclusive_tax: round2(Math.max(0, Number(fields.exclusiveTax) || 0)) };
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
