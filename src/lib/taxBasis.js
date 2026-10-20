/**
 * taxBasis.js - WHAT each order line is taxed on (v5.9.12).
 *
 * THE BUG THIS FIXES (found 19 Sep 2026): every surface taxed US added-on sales
 * tax on item price x qty BEFORE any discount, and never on the service charge
 * or the delivery fee. In most US states a store discount reduces the taxable
 * amount (so a discounted check over-collected), and a mandatory service charge
 * is taxable in many (New York, California), so those checks under-collected.
 *
 * This module turns a check's adjustments into per-line figures the tax engine
 * can apply line by line, so each line's own tax profile decides what it taxes
 * (taxEngine.lineBasisSettings: tax_basis, tax_service_charge, tax_delivery_fee):
 *
 *   netValue       the line after its own item discount and its share of every
 *                  check level discount (manual, auto, promo code, loyalty reward)
 *   serviceShare   the line's share of the service charge
 *   deliveryShare  the line's share of the delivery fee
 *
 * ALLOCATION RULES (the Toast / Square norm):
 *   - an item discount belongs to its own line;
 *   - a check discount that names the units it applied to (auto discounts carry
 *     appliedItems [{ uid, saving }]) goes to those lines first;
 *   - everything else is spread pro rata by line value;
 *   - service and delivery are spread pro rata by the discounted line value, so an
 *     exempt line's share stays untaxed and a taxable line's share is taxed at
 *     that line's own rates.
 *
 * The item discount maths is EXACTLY computeCheckTotals' subtotal reducer, and a
 * percent check discount is taken off the post item discount subtotal exactly as
 * computeCheckTotals takes it, so the lines here always add up to the bill.
 *
 * Callers never use this directly: they hand `checkBasis` to the one tax seam
 * (taxCompute.computeOrderTaxUnified) and it allocates. PURE, no imports.
 */

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

/** Line value after its own item discount (computeCheckTotals' reducer, verbatim maths). */
export function lineAfterItemDiscount(i) {
  const base = num(i?.price) * (i?.qty || 1);
  const d = i?.discount;
  if (!d) return base;
  return d.type === 'percent' ? base * (1 - num(d.value) / 100) : Math.max(0, base - num(d.value));
}

/** One check discount's amount in major units: percent of the subtotal, else its value. */
export function checkDiscountAmount(d, subtotal) {
  if (!d) return 0;
  if (d.type === 'percent') return subtotal * num(d.value) / 100;
  return num(d.value ?? d.amount);
}

/**
 * v5.11.81: what each check discount takes off the bill ON SCREEN, in order, never more than is left
 * of the subtotal (computeCheckTotals floors the bill at 0.00). An amount discount bigger than the
 * bill showed its typed value (10.00 off a 6.00 bill read -10.00 while the bill took 6.00).
 */
export function shownCheckDiscounts(discounts, subtotal) {
  let left = Math.max(0, num(subtotal));
  return (Array.isArray(discounts) ? discounts : []).map((d) => {
    const take = Math.min(Math.max(0, checkDiscountAmount(d, num(subtotal))), left);
    left -= take;
    return take;
  });
}

/** Pro rata weights: the first list with a positive sum wins, else equal shares. */
function weightsOf(...lists) {
  for (const w of lists) {
    const s = w.reduce((a, b) => a + b, 0);
    if (s > 0) return { w, s };
  }
  const n = lists[0]?.length || 0;
  return { w: new Array(n).fill(1), s: n };
}

/**
 * Allocate a check's discounts, service charge and delivery fee to its lines.
 *
 * @param {Array}  items  LIVE order lines (voided already removed), in order
 * @param {Object} checkBasis
 * @param {Array}  [checkBasis.discounts]  check level discounts in the shared shape
 *                   { type: 'percent'|'amount', value, amount?, appliedItems? }
 *                   (manual + auto + promo + loyalty, all store funded)
 * @param {number} [checkBasis.service]      service charge in major units
 * @param {number} [checkBasis.deliveryFee]  delivery fee in major units
 * @returns {{ lines: Array<{netValue:number, serviceShare:number, deliveryShare:number}>,
 *             subtotal:number, discount:number, net:number }}
 */
export function allocateCheckBasis(items = [], checkBasis = {}) {
  const live = Array.isArray(items) ? items : [];
  const gross = live.map(i => num(i?.price) * (i?.qty || 1));
  const after = live.map(lineAfterItemDiscount);
  const subtotal = after.reduce((a, b) => a + b, 0);

  const remaining = after.slice();
  let untargeted = 0;
  let discount = 0;
  for (const d of (Array.isArray(checkBasis?.discounts) ? checkBasis.discounts : [])) {
    const amt = checkDiscountAmount(d, subtotal);
    if (!(amt > 0)) continue;
    discount += amt;
    let left = amt;
    if (Array.isArray(d.appliedItems)) {
      for (const ai of d.appliedItems) {
        if (!(left > 0)) break;
        if (ai?.uid == null) continue;
        const idx = live.findIndex(i => i?.uid != null && i.uid === ai.uid);
        if (idx < 0) continue;
        const take = Math.min(num(ai.saving), remaining[idx], left);
        if (take > 0) { remaining[idx] -= take; left -= take; }
      }
    }
    untargeted += left;
  }
  const rest = remaining.reduce((a, b) => a + b, 0);
  const factor = rest > 0 ? Math.max(0, 1 - untargeted / rest) : 0;
  const net = remaining.map(v => v * factor);

  const { w, s } = weightsOf(net, after, gross);
  const service = num(checkBasis?.service);
  const deliveryFee = num(checkBasis?.deliveryFee);
  const lines = live.map((_, n) => ({
    netValue: net[n],
    serviceShare: service > 0 && s > 0 ? service * w[n] / s : 0,
    deliveryShare: deliveryFee > 0 && s > 0 ? deliveryFee * w[n] / s : 0,
  }));
  return { lines, subtotal, discount, net: net.reduce((a, b) => a + b, 0) };
}

/**
 * Normalise the loose credits a checkout applies AFTER the bill (promo code,
 * loyalty reward) into check discount entries for the tax basis. Amounts in
 * major units; zero or missing credits are dropped.
 */
export function creditDiscounts({ promo = 0, loyalty = 0 } = {}) {
  const out = [];
  if (num(promo) > 0) out.push({ type: 'amount', value: num(promo), source: 'promo' });
  if (num(loyalty) > 0) out.push({ type: 'amount', value: num(loyalty), source: 'loyalty' });
  return out;
}

/**
 * The same credits, read off a checkout's paymentInfo (what a close path gets):
 * promoRedemption.amount is major units (promo-redeem), loyaltyRedemption
 * .discount_value is MINOR units (loyalty-redeem). A close recomputes the bill
 * with these so the tax it books is the tax the checkout charged.
 */
export function creditDiscountsFromPayment(paymentInfo) {
  const p = paymentInfo || {};
  // A terminal close carries the credits the checkout froze into its draft.
  if (Array.isArray(p.taxCredits) && p.taxCredits.length) return p.taxCredits;
  return creditDiscounts({
    promo: num(p.promoRedemption?.amount),
    loyalty: num(p.loyaltyRedemption?.discount_value) / 100,
  });
}

/** 27 Sep 2026: the live lines after their own item discounts (what a lines-only bill charges). */
export function linesAfterItemDiscounts(items) {
  return (Array.isArray(items) ? items : []).filter(i => i && !i.voided).reduce((s, i) => s + lineAfterItemDiscount(i), 0);
}

/**
 * 19 Oct 2026 (v5.11.78, channel parity): every manual check discount on a closed check carries the
 * amount the bill actually took off, worked out on the lines it closed with. A percent discount's
 * `amount` was frozen when staff applied it, so a 10% applied at 3.70 and then charged on 8.10
 * stored 0.37 where the bill took 0.81 off (26 live checks in 60 days); an MPOS discount stored no
 * amount at all, and the receipt and most reports then read its value (a 10% read as 10.00). The
 * bill itself was always right: it charges `value` percent of the live goods (computeCheckTotals).
 *
 * A percent line becomes that same figure: the live lines after their own item discounts, times
 * value / 100, exactly computeCheckTotals' reducer (unrounded, as DiscountModal stored it). An
 * amount line with no amount gets its value, which is what the bill took. Automatic deals (isAuto,
 * worked out at close), promo codes, loyalty and channel discounts (any `source`: the server's or
 * the platform's figure is the truth) are left exactly as they are. Same array back when nothing
 * changes, so a record whose discounts are already right is byte for byte as before.
 */
export function stampDiscountAmounts(items, discounts) {
  if (!Array.isArray(discounts) || !discounts.length) return discounts;
  const sub = linesAfterItemDiscounts(items);
  let changed = false;
  const out = discounts.map(d => {
    if (!d || typeof d !== 'object' || d.isAuto || d.source) return d;
    let amount;
    if (d.type === 'percent') amount = sub * num(d.value) / 100;
    else if (d.amount == null || d.amount === '') amount = num(d.value);
    else return d;
    if (d.amount != null && d.amount !== '' && Number(d.amount) === amount) return d;
    changed = true;
    return { ...d, amount };
  });
  return changed ? out : discounts;
}

/**
 * MPOS charges each line after its own item discount and NOTHING else (no check
 * discount, no service charge, no delivery fee: a separate, known MPOS gap). Its
 * tax basis is exactly that, so the handheld taxes what it charges.
 */
export const LINES_ONLY_BASIS = Object.freeze({ discounts: [], service: 0, deliveryFee: 0 });

/**
 * The basis a CLOSED check was charged on, rebuilt from its record, for a reprint
 * or report that has to recompute (older rows, rows written without
 * tax_breakdown). discounts as recorded (manual, auto, POS promo), plus the
 * loyalty / promo credits kiosk and online store beside them; service; delivery.
 */
export function recordCheckBasis(check) {
  const c = check || {};
  const discounts = Array.isArray(c.discounts) ? [...c.discounts] : [];
  const loyaltyMinor = num(c.loyalty?.discount_value ?? c.loyaltyRedemption?.discount_value);
  if (loyaltyMinor > 0) discounts.push({ type: 'amount', value: loyaltyMinor / 100, source: 'loyalty' });
  const deliveryFee = num(c.deliveryFee ?? c.delivery_fee ?? c.customer?.delivery_fee);
  // 19 Oct 2026 (v5.11.78): catering books its delivery fee in customer.delivery_fee only, like
  // every other source, so `service` is a service charge everywhere. (Its rows put the fee in
  // `service` too until v5.11.78; none had a delivery fee, so the special case that undid it is gone.)
  return { discounts, service: num(c.service), deliveryFee };
}

/**
 * The tax a device actually CHARGED, handed to a close (MPOS: paymentInfo
 * .chargedTaxBreakdown). A close books it only when it carries added-on tax: an
 * inclusive-only check charges nothing on top, so the close computes as before
 * (UK byte-identical).
 */
export function chargedAddedOnTax(paymentInfo) {
  const t = paymentInfo?.chargedTaxBreakdown;
  return (t && typeof t === 'object' && t.hasExclusiveTax && Number(t.exclusiveTax) > 0) ? t : null;
}

/**
 * 27 Sep 2026: the tax a device CHARGED, for a close to book. The added-on tax as above, or an
 * inclusive (UK) record: MPOS works its VAT out on the lines it charges (after their item
 * discounts, taxShare.inclusiveTaxOnCharged), and it never takes the check or auto discounts a
 * close would otherwise apply (a known MPOS gap), so its own figure is the VAT on the money
 * taken. Null when nothing usable was handed over (every other close computes as before).
 */
export function chargedTaxOf(paymentInfo) {
  const added = chargedAddedOnTax(paymentInfo);
  if (added) return added;
  const t = paymentInfo?.chargedTaxBreakdown;
  return (t && typeof t === 'object' && !t.hasExclusiveTax && Array.isArray(t.breakdown)
    && t.totalTax != null && Number.isFinite(Number(t.totalTax))) ? t : null;
}
