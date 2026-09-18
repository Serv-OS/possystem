// ============================================================
// src/lib/kioskLine.js — kiosk basket line → order line, with sizes
// ============================================================
// A kiosk item with sizes (a variant parent, e.g. Latte with Small / Large
// child rows) is added to the basket as the PARENT: the basket screen shows
// "Latte" with the summary "Large · Oat Milk", and every money path (subtotal,
// auto discounts, tax, Stripe line items) reads the parent line exactly as it
// always has. The chosen size rides on the basket line as `line.variant`.
//
// Before this module the size was dropped the moment the line left the basket
// screen: the kitchen ticket, KDS, receipt, closed_checks / order_queue items,
// stock count and recipe depletion all saw only the parent. These helpers put
// the size back on every destination by writing the SAME order line shape the
// till writes for a size (InlineItemFlow.jsx → store.addItem):
//   itemId   = the size (child) id
//   name     = "<parent display name> — <size display name>"
//   parentId = the parent id
//   kitchenName / receiptName = the child's explicit overrides (null when unset)
// so routing (parentId), KDS / print (kitchenName || name), receipts
// (receiptName || name), Product Mix (name) and stock-deplete (itemId) all
// work unchanged, and kiosk and till sales of the same size group together.
//
// Every helper falls back to the parent when a line has no `variant`, so a
// plain item behaves byte for byte as before.
//
// Pure: imports only itemDisplay.js, so node:test can load it.
// ============================================================

import { kitchenOverride, receiptOverride } from './itemDisplay.js';

const nameOf = (row) => row?.menuName || row?.menu_name || row?.name || '';

/**
 * The chosen size for a basket line, or null when no size was picked.
 * `lineName` uses the till's formula (InlineItemFlow.jsx) so the stored order
 * line name matches a till sale of the same size.
 */
export function kioskVariant(parent, child) {
  if (!parent || !child || !child.id) return null;
  return {
    id: child.id,
    lineName: `${nameOf(parent)} — ${nameOf(child)}`,
    // The size's own menu name, so a free item reward can match "<parent> - <size>" by name
    // at every site of the company (lib/loyaltyMenuMatch.js kioskLineCandidates).
    itemName: typeof child.name === 'string' ? child.name : '',
    kitchenName: kitchenOverride(child),
    receiptName: receiptOverride(child),
  };
}

/** The id whose RECIPE this line depletes: the size when picked, else the item. */
export function kioskLineStockId(line) {
  return line?.variant?.id || line?.item?.id || null;
}

/**
 * Every id whose daily stock COUNT this line uses: the size and its parent for
 * a size line, the item alone otherwise. Same rule as the till's
 * store.decrementDailyCount, which counts down the child AND the parent when
 * each has a count set (so a venue can track "House Wine" bottles on the parent
 * while selling 175ml / 250ml sizes). An untracked id is harmless: every caller
 * only compares against dailyCounts.
 */
export function kioskLineStockIds(line) {
  const ids = [];
  const vid = line?.variant?.id;
  const pid = line?.item?.id;
  if (vid) ids.push(vid);
  if (pid && pid !== vid) ids.push(pid);
  return ids;
}

/**
 * The lowest remaining daily count across this line's tracked ids, or null
 * when none of them is tracked. For a plain item this is exactly
 * dailyCounts[item.id].remaining, as before.
 */
export function kioskLineRemaining(line, dailyCounts) {
  let min = null;
  for (const id of kioskLineStockIds(line)) {
    const stock = dailyCounts?.[id];
    if (!stock) continue;
    const rem = Number(stock.remaining);
    if (min === null || rem < min) min = rem;
  }
  return min;
}

/**
 * How many more of this line fit in stock given what is already in the basket
 * (lowest of remaining minus in basket across tracked ids, floored at 0), or
 * null when no id is tracked.
 */
export function kioskLineRoom(line, dailyCounts, usage) {
  let min = null;
  for (const id of kioskLineStockIds(line)) {
    const stock = dailyCounts?.[id];
    if (!stock) continue;
    const room = Math.max(0, stock.remaining - ((usage && usage[id]) || 0));
    if (min === null || room < min) min = room;
  }
  return min;
}

/**
 * Basket merge key. Two lines merge only when the same size and the same picks
 * were chosen. With no size this is exactly the key the kiosk always used.
 */
export function kioskLineKey(item, variant, selectedMods) {
  return (variant?.id || item?.id) + ':' + JSON.stringify(selectedMods);
}

/**
 * The modal's final stock gate need map for one line: the size and its parent
 * (or the item when there is no size) × qty, plus each linked modifier × its
 * qty × qty. Both the size and the parent are counted, like the till.
 */
export function kioskLineNeed({ item, variantItem, mods, qty }) {
  const need = {};
  for (const id of kioskLineStockIds({ item, variant: variantItem })) {
    need[id] = (need[id] || 0) + qty;
  }
  for (const m of (mods || [])) {
    if (m && m.itemId) need[m.itemId] = (need[m.itemId] || 0) + (Number(m.qty) || 1) * qty;
  }
  return need;
}

/**
 * Total usage of each stock id across the basket: the line's size and parent
 * (or item) plus modifier options with an itemId. Used to enforce stock limits in
 * KioskProductModal and the basket screen.
 */
export function kioskCartUsage(cart) {
  const usage = {};
  for (const line of (cart || [])) {
    // Direct item (the size and its parent when a size was picked)
    for (const stockId of kioskLineStockIds(line)) {
      usage[stockId] = (usage[stockId] || 0) + line.qty;
    }
    // Modifier options with itemId
    if (line.modsArray) {
      for (const mod of line.modsArray) {
        if (mod.itemId) {
          usage[mod.itemId] = (usage[mod.itemId] || 0) + line.qty;
        }
      }
    }
  }
  return usage;
}

/**
 * The order line written to closed_checks.items, order_queue.items and the
 * customer_orders record. Price is the basket line price (size price plus
 * modifiers), never a separate size price, so nothing can count it twice.
 */
export function kioskOrderItem(l) {
  const v = l.variant || null;
  return {
    id: v ? v.id : l.item.id,
    ...(v ? { itemId: v.id, parentId: l.item.id } : {}),
    name: v ? v.lineName : l.name,
    // Triple-naming: explicit kitchen/receipt names ride into closed_checks
    // + order_queue (null when not set). routeKioskOrderPrints reads
    // kitchenName || name for KDS/tickets; receipt builders read
    // receiptName || name. l.item is a raw Supabase row (snake_case) —
    // the itemDisplay resolvers read both shapes. A size line takes the
    // size's own overrides, like the till.
    kitchenName: v ? v.kitchenName : kitchenOverride(l.item),
    receiptName: v ? v.receiptName : receiptOverride(l.item),
    qty: l.qty,
    price: l.linePrice,
    // POS expects mods as array of { label, price, groupLabel }
    mods: Array.isArray(l.modsArray) ? l.modsArray : [],
    cat: l.item.cat,
    // KIOSK NEVER HOLDS COURSES. A kiosk order is paid and gone — there is no
    // server to fire course 2, so every line must be produced in one go. Stamped
    // at SOURCE (same three fields online sets, OnlineCheckout.jsx:316-318) so it
    // holds no matter which downstream path picks the order up: routeKioskOrderPrints
    // already forces course 1, but fireScheduledOrder (store/index.js:2165) replays a
    // scheduled order through the normal walk-in sendToKitchen, where
    // computeFiredOnSend honours per-line courses and would hold anything above the
    // lowest occupied course.
    status: 'sent',
    fired: true,
    course: 1,
  };
}

/** The line handed to the stock-deplete edge function (recipes live on the size). */
export function kioskDepleteItem(l) {
  return {
    itemId: kioskLineStockId(l),
    qty: l.qty,
    // v5.5.935: chosen modifier sub-items (the bun) deplete too — options carry itemId
    // when linked (KioskProductModal stamps it), plain instructions don't and are skipped.
    mods: (Array.isArray(l.modsArray) ? l.modsArray : []).filter(m => m && m.itemId).map(m => ({ itemId: m.itemId, qty: m.qty || 1 })),
  };
}
