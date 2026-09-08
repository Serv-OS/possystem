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

import { toBase } from './uom.js';
import { lineAppliesToOrderType } from './costing.js';

/**
 * Accumulate one sold menu line's component usage (base units) into `out`.
 * `orderType` scopes which recipe lines deplete — a takeaway latte depletes its disposable cup
 * while a dine-in latte (reusable mug) does not. Untagged lines deplete for every order type; a
 * missing order type defaults to the dine-in/base recipe (see lineAppliesToOrderType).
 */
export function explodeMenuItem(menuItemId, qty, ctx, out = {}, orderType = null) {
  const mr = ctx?.menuRecipes?.[String(menuItemId)];
  if (!mr) return out;
  const n = Number(qty) || 0;
  if (n <= 0) return out;
  const mult = n * (Number(mr.portion) || 1) * (1 + (Number(mr.wastagePct) || 0) / 100);
  for (const line of mr.lines || []) {
    if (!lineAppliesToOrderType(line, orderType)) continue;
    const comp = ctx.itemsById?.[line.componentItemId];
    if (!comp) continue;
    let qtyBase;
    try { qtyBase = toBase(Number(line.qty), line.unit, comp); }
    catch { continue; } // can't resolve the unit — skip rather than deplete wrongly
    const usable = (line.usablePct == null ? 100 : Number(line.usablePct)) / 100;
    if (!(usable > 0)) continue;
    out[line.componentItemId] = (out[line.componentItemId] || 0) + (qtyBase / usable) * mult;
  }
  return out;
}

/** Aggregate a basket of {itemId, qty} sold lines into { [inventoryItemId]: qtyBase }, scoped to orderType. */
export function explodeBasket(lines, ctx, orderType = null) {
  const out = {};
  for (const l of lines || []) {
    explodeMenuItem(l.itemId, l.qty, ctx, out, orderType);
    // v5.5.935 — MODIFIER SUB-ITEMS COUNT. "Cheeseburger, brioche bun": the bun is a
    // modifier option linked to its own menu item (the same link 86/sold-out already
    // uses), and that item's recipe says what it consumes. Each chosen mod explodes as
    // an extra line — bun picked, bun stock moves. Mods without a linked item (plain
    // "no onions" instructions) explode nothing, exactly as before.
    for (const m of (Array.isArray(l.mods) ? l.mods : [])) {
      if (m && m.itemId && !m._instruction) {
        explodeMenuItem(m.itemId, (Number(m.qty) || 1) * (Number(l.qty) || 1), ctx, out, orderType);
      }
    }
  }
  return out;
}
