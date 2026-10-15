/**
 * stock/valuation.js — how stock is valued on the Overview, the Valuation report and By
 * supplier. Pure, tested (valuation.test.js).
 *
 * v5.11.65 (15 Oct 2026 audit): a negative on hand (an item sold past zero because no batch or
 * delivery was recorded) was multiplied by its cost and SUBTRACTED from the total, while the
 * row itself printed £0.00. Provo's total read £2,519.80 and hid a £322 hole. Stock you do not
 * have is worth nothing, not less than nothing: the value floors at zero, and the negative
 * items are listed so the hole is seen instead of hidden.
 */

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** The value of one item's stock: on hand floored at zero times its unit cost. */
export function lineValue(onHand, cost) {
  return Math.max(0, num(onHand)) * num(cost);
}

/** What the negative stock WOULD have taken off the total (a negative number, 0 when none). */
export function negativeValue(onHand, cost) {
  const oh = num(onHand);
  return oh < 0 ? oh * num(cost) : 0;
}

/** Total stock value over items ({ onHand, currentCost }), negatives floored at zero. */
export function totalStockValue(items) {
  return (items || []).reduce((s, i) => s + lineValue(i?.onHand, i?.currentCost), 0);
}

/** The items below zero, with the signed value each would have subtracted. Worst first. */
export function negativeStock(items) {
  return (items || [])
    .filter((i) => i && num(i.onHand) < 0)
    .map((i) => ({ id: i.id, name: i.name, onHand: num(i.onHand), value: negativeValue(i.onHand, i.currentCost) }))
    .sort((a, b) => a.value - b.value);
}
