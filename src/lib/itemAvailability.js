// v5.5.141 — single source of truth for "is this item available right now".
// Used by every customer-facing surface (POS, Kiosk, Online, MPOS, QR table-side)
// so the same item that shows OUT OF STOCK on one screen shows OUT OF STOCK on every
// screen at the venue.
//
// Two reasons an item can be unavailable:
//   1. Operator manually 86'd it (added to eightySixIds)
//   2. Daily count dropped to zero — store auto-adds to eightySixIds AND writes
//      to the `eighty_six` DB table (v5.5.141 fix) so customer surfaces see it
//
// Variants: a child variant inherits its parent's 86 status. Operator 86s
// "House Wine" (parent) → all variants (175ml / 250ml / bottle) become unavailable.
// Operator 86s a single variant → only that variant becomes unavailable.

/**
 * @param {object} item - menu item row (must have .id; .parentId / .parent_id optional for variants)
 * @param {string[]} eightySixIds - ids the operator/system has flagged 86'd
 * @returns {boolean} true if the item should be shown as Out of stock
 */
export function isItemEightySixed(item, eightySixIds) {
  if (!item || !Array.isArray(eightySixIds) || !eightySixIds.length) return false;
  if (eightySixIds.includes(item.id)) return true;
  const parentId = item.parentId || item.parent_id;
  if (parentId && eightySixIds.includes(parentId)) return true;
  return false;
}

/**
 * @param {object} item - menu item row
 * @param {string[]} eightySixIds
 * @param {Record<string, {par:number,remaining:number}>=} dailyCounts - optional, operator-only
 * @returns {boolean} true if the customer can order this item right now
 */
export function isItemAvailable(item, eightySixIds, dailyCounts) {
  if (isItemEightySixed(item, eightySixIds)) return false;
  // dailyCounts is operator-side only; customer surface won't have it but the
  // auto-86 on count exhaustion (v5.5.141) propagates via the eighty_six DB
  // table so customer surfaces still know via eightySixIds alone.
  if (dailyCounts) {
    const c = dailyCounts[item.id];
    if (c && c.remaining <= 0) return false;
  }
  return true;
}
