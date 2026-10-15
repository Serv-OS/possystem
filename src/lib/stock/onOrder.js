/**
 * stock/onOrder.js: what is already on its way, for the Order pad. Pure, tested (onOrder.test.js).
 *
 * v5.11.65 (15 Oct 2026 audit): "on order" counted DRAFT orders (never sent) and SENT orders
 * from July that will never arrive, so some items were never suggested again; and a line
 * written in a unit other than the item's base unit was added as if it were base units. Only
 * SENT and PARTIAL orders count, an order whose expected date (or ordered date plus a week) is
 * more than `staleDays` past is left out and reported so the pad can say so, and every line is
 * converted from its pack unit to the item's base unit the way receiving does.
 */

import { convert } from './conversion.js';
import { addDaysYmd } from '../venueDate.js';

export const ON_ORDER_STATUSES = ['SENT', 'PARTIAL'];

/**
 * @param pos        purchase orders as fetchPurchaseOrders returns them (camelCase, with lines[])
 * @param itemsById  { itemId: { baseUnit, conversions|itemConversions } }
 * @param opts       { todayYmd, staleDays = 7 }  (no todayYmd = nothing is stale)
 * @returns { byItem: { itemId: base units outstanding }, stale: [{ id, reference, supplierId, expectedDate, due }] }
 */
export function outstandingOnOrder(pos, itemsById = {}, { todayYmd = null, staleDays = 7 } = {}) {
  const byItem = {};
  const stale = [];
  const cutoff = todayYmd ? addDaysYmd(todayYmd, -(Number(staleDays) || 0)) : null;
  for (const p of pos || []) {
    if (!p || !ON_ORDER_STATUSES.includes(p.status)) continue;
    const ordered = String(p.orderedAt || p.createdAt || '').slice(0, 10);
    const due = p.expectedDate || (ordered ? addDaysYmd(ordered, 7) : null);
    if (cutoff && due && due < cutoff) {
      stale.push({ id: p.id, reference: p.reference || null, supplierId: p.supplierId || null, expectedDate: p.expectedDate || null, due });
      continue;
    }
    for (const l of p.lines || []) {
      if (!l?.inventoryItemId) continue;
      const out = (Number(l.qtyPacks) || 0) - (Number(l.qtyReceived) || 0);
      if (!(out > 0)) continue;
      const perPack = (Number(l.packQty) || 1) * (Number(l.innerQty) || 0);
      if (!(perPack > 0)) continue;
      let base = perPack;
      const it = itemsById[l.inventoryItemId];
      if (it?.baseUnit) {
        try {
          base = convert(perPack, l.innerUnit || it.baseUnit, it.baseUnit, { itemConversions: it.itemConversions || it.conversions || [] });
        } catch { base = perPack; }   // no path between the units: the pack content as written, as before
      }
      byItem[l.inventoryItemId] = (byItem[l.inventoryItemId] || 0) + out * base;
    }
  }
  return { byItem, stale };
}
