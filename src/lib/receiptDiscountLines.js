// src/lib/receiptDiscountLines.js (29 Oct 2026, v5.11.114)
//
// WHY. A bill with a discount printed "Subtotal 16.00 ... TOTAL 14.40" with nothing in between,
// and the till's History screen listed the same two figures with no line for the 1.60. The
// receipt builder (lib/printDoc.js) has printed one named line per entry of `check.discounts`
// since v5.5.853, but only channel orders ever handed it that list: the till's own receipt at
// pay, the Receipt dialog's Print button and the History reprint built a check object with no
// discounts on it. Back Office reads closed_checks.discounts directly, which is why it was right.
//
// WHAT. One rule that turns a check's discounts into the lines a customer sees: the label and
// what it took off this bill. Amounts come from taxBasis.stampDiscountAmounts, the same rule the
// closed check is written with, so the receipt, History and Back Office all show one figure.
// Auto discounts (discountEngine.toAppliedDiscount) and promo entries already carry an amount
// and pass straight through. Anything that took nothing off is left out.
import { stampDiscountAmounts } from './taxBasis.js';

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/**
 * @param {Array} items      the check's lines (voided lines are ignored)
 * @param {Array} discounts  the check's discounts (manual, percent or amount; auto; promo)
 * @param {Array} [extra]    further entries already carrying an amount (the till's live auto discounts)
 * @returns {Array<{label:string, amount:number}>} named lines, in order, amounts > 0 only
 */
export function receiptDiscountLines(items, discounts, extra = []) {
  const live = Array.isArray(items) ? items.filter(i => i && !i.voided) : [];
  const stamped = stampDiscountAmounts(live, Array.isArray(discounts) ? discounts : []) || [];
  const all = [...stamped, ...(Array.isArray(extra) ? extra : [])];
  return all
    .filter(d => d && typeof d === 'object')
    .map(d => ({
      label: String(d.label || d.name || 'Discount'),
      amount: Math.round(num(d.amount ?? d.value) * 100) / 100,
    }))
    .filter(d => d.amount > 0);
}
