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
import { evaluateAutoDiscounts, toAppliedDiscount } from './discountEngine.js';
import { buildScheduleCtx } from './scheduleCtx.js';
import { checkDiscountAmount } from './taxBasis.js';
import { computeOrderTaxUnified } from './taxCompute.js';
import { modsTotal } from './channelMoney.js';
import { sizeTaxRefs } from './taxRefs.js';
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
 * 8 Oct 2026 (review): a SIZE row that is on the menu inherits exactly as the till's addItem and
 * the kiosk's kioskLineTaxRefs do: with no overrides of its own it reads its parent's overrides,
 * and with no rate of its own its parent's rate. Before this a Babyccino size saved with "Use
 * default" under a 5% parent booked 20% when its tab was force closed in Orders, and 5% on the
 * phone or the till. One sale, one rate, whichever screen closes it.
 */
export function qrTaxLines(items, menuItems = []) {
  const byId = new Map();
  for (const m of (Array.isArray(menuItems) ? menuItems : [])) if (m && m.id != null) byId.set(String(m.id), m);
  const find = (id) => (id != null && id !== '' ? byId.get(String(id)) : undefined);
  return (Array.isArray(items) ? items : []).filter((i) => i && !i.voided).map((i) => {
    const mi = find(i.itemId ?? i.id) || find(i.parentId);
    const out = {
      ...i,
      // A line already in the till's contract (channelMoney.foldLineMods) carries its options in
      // its price: never add them twice.
      price: i._modsFolded ? (Number(i.price) || 0) : +((Number(i.price) || 0) + modsTotal(i.mods)).toFixed(2),
      qty: Number(i.qty) || 1,
      itemId: i.itemId ?? i.id ?? null,
    };
    if (mi) {
      // 18 Oct 2026 (v5.11.78): the one shared size rule (lib/taxRefs.js sizeTaxRefs), the till's.
      const refs = sizeTaxRefs(mi, find(mi.parentId ?? mi.parent_id) || null);
      out.taxRateId = refs.taxRateId;
      out.taxOverrides = refs.taxOverrides;
      out.taxProfileId = refs.taxProfileId;
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
  // 19 Oct 2026 (v5.11.78, channel parity): the QR service charge each round took is booked as
  // service, as on a QR pay now check and at the till, never as goods (it carries no VAT).
  const service = Math.min(qrTabService(rows), Math.max(0, +((Number(runningTotal) || 0) - tip).toFixed(2)));
  const goods = +((Number(runningTotal) || 0) - tip - service).toFixed(2);
  const tax = qrCloseTax(rows.flatMap((r) => (Array.isArray(r?.items) ? r.items : [])), ctx, { paidGoods: goods });
  return { tip, service, subtotal: +(goods - tax.exclusiveTax).toFixed(2), ...tax };
}

/**
 * 19 Oct 2026 (v5.11.78, channel parity): the QR service charge a tab's rounds took, summed
 * (customer.service_charge per round, the figure QrCheckout charged on that round). Every close
 * of a QR tab (Orders force close, the short close, the phone's fallback write and settle_qr_tab
 * on the server) books it as service, as a QR pay now check and a till table do. Before, it
 * stayed inside the goods: VAT was booked on it and the service and tronc lines missed it.
 */
export function qrTabService(rows) {
  const list = Array.isArray(rows) ? rows : [];
  return +list.reduce((t, r) => t + Math.max(0, Number(r?.customer?.service_charge) || 0), 0).toFixed(2);
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
export function headlessService(draft, tax = null, discounts = null) {
  const d = draft || {};
  // 19 Oct 2026 (v5.11.78, channel parity): the service the till CHARGED when it froze one (a till
  // since v5.11.78 freezes serviceMinor into the draft, from the same bill it charged).
  if (d.serviceMinor != null && Number.isFinite(Number(d.serviceMinor))) return Math.max(0, Math.round(Number(d.serviceMinor))) / 100;
  // Otherwise what was on the bill over the goods AFTER the discounts it lists: the subtotal is
  // before them, so a 12.5% service charge on a discounted bill read as 0.00 (the charge sat in
  // sales). No discounts: exactly as before.
  const subMinor = Number(d.subtotalMinor) || 0;
  const offMinor = Array.isArray(discounts) && discounts.length
    ? Math.round(discounts.reduce((s, x) => s + checkDiscountAmount(x, subMinor / 100), 0) * 100) : 0;
  const overMinor = Math.max(0, (Number(d.totalMinor) || 0) - Math.max(0, subMinor - offMinor));
  const addedMinor = isUsableBreakdown(tax) ? Math.round((Number(tax.exclusiveTax) || 0) * 100) : 0;
  return Math.max(0, overMinor - Math.max(0, addedMinor)) / 100;
}

/**
 * 19 Oct 2026 (v5.11.78, channel parity): the discounts a check booked from a frozen card job
 * draft carries, as the till's own close records them (store buildCloseRecord / recordWalkInClosed):
 * the manual discounts the draft froze, plus the venue's automatic deals ('pos' rules). A till since
 * v5.11.78 freezes the deals its bill applied (draft.autoDiscounts), so the deal booked is the one
 * charged even if a scheduled window closes before the reconciler books; a draft from the server
 * (Table Pay, pay at table) or an older till carries none, so they are worked out over the frozen
 * lines with the same engine the VAT above already applies. A list that already holds a deal line
 * is taken as it is. This record booked the manual list only (Shifts, Servers, Exceptions and the
 * Z report then read 0.00 of deals on a reader sale).
 */
export function headlessDiscounts(draft, { discountRules = null, timezone } = {}) {
  const d = draft || {};
  const manual = Array.isArray(d.discounts) ? d.discounts : [];
  if (manual.some((x) => x && x.isAuto)) return manual;
  if (Array.isArray(d.autoDiscounts)) return [...manual, ...d.autoDiscounts];
  const items = (Array.isArray(d.items) ? d.items : []).filter((i) => i && !i.voided);
  if (!items.length || !Array.isArray(discountRules) || !discountRules.length) return manual;
  try {
    return [...manual, ...evaluateAutoDiscounts(items, discountRules, 'pos', buildScheduleCtx(timezone)).map(toAppliedDiscount)];
  } catch { return manual; }
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
