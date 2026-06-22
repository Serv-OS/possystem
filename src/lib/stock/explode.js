/**
 * explode.js — turn sold menu items into the stock-item quantities they consume.
 *
 * Pure (no I/O). Used by stock/deplete.js to post SALE_DEPLETION movements.
 *
 * Model: deplete the DIRECT components of a dish recipe. A made sub-recipe used as
 * a component is depleted as the made item itself (not recursed to its raws) —
 * production batches (slice 6) replenish made items, so recursing here would
 * double-count. A menu item with no recipe consumes nothing (safe no-op), so this
 * is harmless until recipes exist.
 *
 * ctx shape (from recipes.buildDepletionCtx):
 *   itemsById:   { [id]: { baseUnit, itemConversions } }
 *   menuRecipes: { [menuItemId]: { lines:[{componentItemId,qty,unit,usablePct}], portion, wastagePct } }
 */

import { convert } from './conversion.js';

/** Accumulate one sold menu line's component usage (base units) into `out`. */
export function explodeMenuItem(menuItemId, qty, ctx, out = {}) {
  const mr = ctx?.menuRecipes?.[String(menuItemId)];
  if (!mr) return out;
  const n = Number(qty) || 0;
  if (n <= 0) return out;
  const mult = n * (Number(mr.portion) || 1) * (1 + (Number(mr.wastagePct) || 0) / 100);
  for (const line of mr.lines || []) {
    const comp = ctx.itemsById?.[line.componentItemId];
    if (!comp) continue;
    let qtyBase;
    try { qtyBase = convert(Number(line.qty), line.unit, comp.baseUnit, { itemConversions: comp.itemConversions || [] }); }
    catch { continue; } // missing conversion bridge — can't deplete safely, skip
    const usable = (line.usablePct == null ? 100 : Number(line.usablePct)) / 100;
    if (!(usable > 0)) continue;
    out[line.componentItemId] = (out[line.componentItemId] || 0) + (qtyBase / usable) * mult;
  }
  return out;
}

/** Aggregate a basket of {itemId, qty} sold lines into { [inventoryItemId]: qtyBase }. */
export function explodeBasket(lines, ctx) {
  const out = {};
  for (const l of lines || []) explodeMenuItem(l.itemId, l.qty, ctx, out);
  return out;
}
