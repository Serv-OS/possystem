/**
 * stock/poItemList.js: the PURE rules behind the New purchase order screen's item table.
 *
 * v5.11.67 (16 Oct 2026, Peter: "it should show all the items from the supplier with filters and
 * a search. What if we have 1,000 items from that supplier?"). The Orders screen offered one
 * search box that listed ten names at a time, so a venue ordering from a supplier with hundreds
 * of lines had to know every name it wanted. The screen now lists every item the supplier sells
 * as a table with a quantity box on each row. These rules build those rows, search and filter
 * them, keep the lines already on the order at the top, and turn a typed quantity into an order
 * line. No I/O and no React, so Node's test runner loads this file (poItemList.test.js) and runs
 * it over 1,500 synthetic items.
 *
 * The suggested quantity is the Order pad's rule (purchasingRules.suggestPacks), the pack content
 * is packContentInBase, the net price is the one fetchInventoryItems resolved, so nothing here can
 * drift from the pad.
 */

import { coverDaysFromSchedule, packContent, packContentInBase, suggestPacks } from './purchasingRules.js';

/** The Order pad's defaults for a supplier with no delivery schedule, and the safety buffer. */
export const DEFAULT_COVER_DAYS = 7;
export const DEFAULT_SAFETY_DAYS = 1;

/** Lower case, accents folded, so "creme" finds "Crème" and "SKU-12" finds "sku-12". */
export function foldText(s) {
  return String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

/** NET (ex VAT) pack price, the cost basis fetchInventoryItems already resolved. */
export const spNetPrice = (sp) => (sp && sp.netPackPrice != null) ? Number(sp.netPackPrice) : Number(sp?.packPrice || 0);

/** The storage area an item is kept in, whichever field names it. Empty when none. */
export const itemArea = (it) => String(it?.storageArea || it?.storageAreaName || it?.storageLocation || '').trim();

const lineQtyNum = (l) => Number(l?.qtyPacks) || 0;

/**
 * The pack of ONE supplier we order an item in: the pack flagged preferred, else the first on
 * file. The same reading the Order pad makes through pickSupplierProduct, narrowed to the
 * order's supplier. A supplier with a starred 6 x 2 l case and an older 1 x 2 l bottle on file
 * is ordered in cases here as well as on the pad. null when the supplier has no pack for it.
 */
export function supplierPack(it, supplierId) {
  if (!supplierId) return null;
  const packs = (it?.supplierProducts || []).filter(s => s && s.supplierId === supplierId);
  return packs.find(p => p.isPreferred) || packs[0] || null;
}

/**
 * One row per item the supplier lists, plus one row per order line whose item the supplier
 * does NOT list (an item added through the "Show all items" picker, or on an older draft): those
 * carry the line's own pack and price and are flagged `extra`.
 *
 * @param {object} args
 * @param {Array}  args.items        inventory items as fetchInventoryItems returns them
 * @param {string} args.supplierId   the order's supplier
 * @param {Array}  args.lines        the order's lines (camelCase, qtyPacks may be a string while typing)
 * @param {object} [args.pars]       { itemId: { parLevel, reorderPoint } } in base units
 * @param {object} [args.onOrder]    { itemId: base units outstanding on open orders }
 * @param {object} [args.usage]      { itemId: avg daily base }
 * @param {object} [args.weekday]    { itemId: [sun..sat avg daily base] } or null
 * @param {Array}  [args.deliveryDays]  the supplier's delivery days
 * @param {number} [args.todayDow]   venue JS day of week (0 = Sun)
 * @param {number} [args.coverDays]  default cover when the supplier has no schedule
 * @param {number} [args.safetyDays]
 * @returns {Array} rows, unsorted (see sortPoItemRows)
 */
export function buildPoItemRows({
  items = [], supplierId = null, lines = [], pars = {}, onOrder = {}, usage = {}, weekday = null,
  deliveryDays = [], todayDow = 0, coverDays = DEFAULT_COVER_DAYS, safetyDays = DEFAULT_SAFETY_DAYS,
} = {}) {
  const lineByItem = new Map();
  (lines || []).forEach((l, i) => { if (l?.inventoryItemId && !lineByItem.has(l.inventoryItemId)) lineByItem.set(l.inventoryItemId, { line: l, index: i }); });
  const sched = coverDaysFromSchedule(deliveryDays, todayDow);
  const cover = sched != null ? sched : (Number(coverDays) || DEFAULT_COVER_DAYS);
  const rows = [];
  const listed = new Set();
  for (const it of items || []) {
    if (!it || it.archivedAt || it.kind === 'MADE') continue;
    const sp = supplierPack(it, supplierId);
    if (!sp) continue;
    listed.add(it.id);
    const hit = lineByItem.get(it.id) || null;
    const onHand = Number(it.onHand) || 0;
    const oo = Number(onOrder?.[it.id]) || 0;
    const par = pars?.[it.id]?.parLevel ?? null;
    const perPack = packContentInBase(sp, it.baseUnit, it.conversions || []) ?? packContent(sp);
    const sug = suggestPacks({
      onHand, onOrder: oo, avgDaily: Number(usage?.[it.id]) || 0, profile: weekday?.[it.id] || null,
      todayDow, coverDays: cover, safetyDays, par, perPack,
    });
    rows.push({
      key: it.id, it, sp, extra: false,
      name: it.name || '', sku: it.sku || '', supplierSku: sp.supplierSku || '',
      category: String(it.category || '').trim(), area: itemArea(it),
      packQty: Number(sp.packQty) || 1, innerQty: Number(sp.innerQty) || 1, innerUnit: sp.innerUnit || it.baseUnit || 'each',
      netPrice: spNetPrice(sp), onHand, onOrder: oo, par,
      belowPar: par != null && onHand < Number(par),
      suggestedPacks: sug.suggestedPacks,
      line: hit?.line || null, lineIndex: hit ? hit.index : -1,
      lineQty: hit ? lineQtyNum(hit.line) : 0,
    });
  }
  // Lines for items the supplier does not list: the line is the only record of pack and price.
  const byId = new Map((items || []).map(i => [i.id, i]));
  (lines || []).forEach((l, i) => {
    if (!l || listed.has(l.inventoryItemId)) return;
    if (l.inventoryItemId && rows.some(r => r.extra && r.key === l.inventoryItemId)) return;
    const it = l.inventoryItemId ? byId.get(l.inventoryItemId) : null;
    const onHand = Number(it?.onHand) || 0;
    const par = it ? (pars?.[it.id]?.parLevel ?? null) : null;
    rows.push({
      key: l.inventoryItemId || `line-${i}`, it: it || null, sp: null, extra: true,
      name: it?.name || l.description || 'Item no longer on file', sku: it?.sku || '', supplierSku: '',
      category: String(it?.category || '').trim(), area: itemArea(it),
      packQty: Number(l.packQty) || 1, innerQty: Number(l.innerQty) || 1, innerUnit: l.innerUnit || it?.baseUnit || 'each',
      netPrice: Number(l.unitPrice) || 0, onHand, onOrder: Number(onOrder?.[l.inventoryItemId]) || 0, par,
      belowPar: par != null && onHand < Number(par),
      suggestedPacks: 0,
      line: l, lineIndex: i, lineQty: lineQtyNum(l),
    });
  });
  return rows;
}

/** Line value of a row: packs on the order times the net pack price. */
export const rowLineValue = (r) => (r.line ? (Number(r.line.qtyPacks) || 0) * (Number(r.line.unitPrice) || 0) : 0);

/**
 * Distinct values of a free typed field, A to Z, blanks dropped, ONE entry per spelling once
 * case and accents are folded: 'Dry store', 'dry store' and 'Dry Store' are one option (the
 * first spelling seen), and the filter matches all three. Category and storage area are typed
 * by hand on the item today, so a venue has months of near duplicates on file.
 */
function distinctFolded(values) {
  const m = new Map();
  for (const v of values || []) { const k = foldText(v); if (k && !m.has(k)) m.set(k, v); }
  return [...m.values()].sort((a, b) => a.localeCompare(b));
}

/** Distinct categories, A to Z, blanks dropped, spellings folded. */
export function categoriesOf(rows) {
  return distinctFolded((rows || []).map(r => r.category));
}

/** Distinct storage areas, A to Z, blanks dropped, spellings folded. */
export function areasOf(rows) {
  return distinctFolded((rows || []).map(r => r.area));
}

/** Does one row match the search text? Name, our SKU and the supplier's code, accents and case folded. */
export function rowMatches(row, needle) {
  const n = foldText(needle);
  if (!n) return true;
  const words = n.split(/\s+/).filter(Boolean);
  const hay = `${foldText(row.name)} ${foldText(row.sku)} ${foldText(row.supplierSku)}`;
  return words.every(w => hay.includes(w));
}

/**
 * The rows to show: search and filters applied, then sorted with the lines already on the
 * order first (in the order they were added) and the rest A to Z by name.
 * @param rows     from buildPoItemRows
 * @param filters  { q, category, area, belowPar, onOrderOnly, onThisOrder, pinned }
 *   pinned: an optional Map of row key to position, taken when the list was last opened or
 *   filtered (pinnedLines). With it the "lines first" order is frozen, so a row does not jump
 *   to the top of the table while its quantity is being typed; without it the live lines lead.
 *   With "on this order only" a pinned row also STAYS while its box is cleared, so the row is
 *   not pulled out from under the cursor mid edit; it goes the next time the list is pinned.
 */
export function filterSortPoItems(rows, { q = '', category = '', area = '', belowPar = false, onOrderOnly = false, onThisOrder = false, pinned = null } = {}) {
  const out = [];
  const cat = foldText(category), ar = foldText(area);
  for (const r of rows || []) {
    if (cat && foldText(r.category) !== cat) continue;
    if (ar && foldText(r.area) !== ar) continue;
    if (belowPar && !r.belowPar) continue;
    if (onOrderOnly && !(r.onOrder > 0)) continue;
    if (onThisOrder && !r.line && !(pinned && pinned.has(r.key))) continue;
    if (!rowMatches(r, q)) continue;
    out.push(r);
  }
  return sortPoItemRows(out, pinned);
}

/** The Map filterSortPoItems pins the order by: each line's item, in the order the lines were added. */
export function pinnedLines(lines) {
  const m = new Map();
  (lines || []).forEach((l, i) => { if (l?.inventoryItemId && !m.has(l.inventoryItemId)) m.set(l.inventoryItemId, i); });
  return m;
}

/** Lines on the order first (as added), then by name A to Z, then key so the order is stable. */
export function sortPoItemRows(rows, pinned = null) {
  const pos = (r) => {
    if (pinned) { const p = pinned.get(r.key); return p == null ? -1 : p; }
    return r.line ? r.lineIndex : -1;
  };
  return [...(rows || [])].sort((a, b) => {
    const ap = pos(a), bp = pos(b);
    const al = ap >= 0 ? 0 : 1, bl = bp >= 0 ? 0 : 1;
    if (al !== bl) return al - bl;
    if (al === 0 && ap !== bp) return ap - bp;
    const n = foldText(a.name).localeCompare(foldText(b.name));
    if (n) return n;
    return String(a.key).localeCompare(String(b.key));
  });
}

/** "12 of 1,480 items shown", or "1,480 items" when nothing is hidden. */
export function countLine(shown, total) {
  const fmt = (n) => Number(n || 0).toLocaleString('en-GB');
  if (shown === total) return `${fmt(total)} item${total === 1 ? '' : 's'}`;
  return `${fmt(shown)} of ${fmt(total)} items shown`;
}

/**
 * A fresh order line for a supplier's item, exactly as the Orders screen has always written one:
 * this supplier's pack and NET price, the pack's VAT rate falling back to the item's.
 */
export function lineForRow(row, qtyPacks) {
  const it = row.it || {};
  const sp = row.sp;
  return {
    inventoryItemId: it.id || row.line?.inventoryItemId || null, description: it.name || row.name, qtyPacks,
    packQty: row.packQty, innerQty: row.innerQty, innerUnit: row.innerUnit,
    unitPrice: row.netPrice, qtyReceived: 0, supplierProductId: sp?.id || row.line?.supplierProductId || null,
    purchaseTaxRateId: sp?.purchaseTaxRateId || it.purchaseTaxRateId || row.line?.purchaseTaxRateId || null,
  };
}

/**
 * The order's lines after a quantity was typed on a row. An empty box removes the line; a
 * number on a row with no line adds one at the end; a number on a row with a line updates
 * it. The typed STRING is kept (NumberField reports strings) so "0." can become "0.5".
 */
export function applyQty(lines, row, qtyStr) {
  const ls = Array.isArray(lines) ? lines : [];
  const s = String(qtyStr ?? '').trim();
  const idx = row.it?.id ? ls.findIndex(l => l.inventoryItemId === row.it.id) : row.lineIndex;
  if (s === '') return idx >= 0 ? ls.filter((_, i) => i !== idx) : ls;
  if (idx >= 0) return ls.map((l, i) => (i === idx ? { ...l, qtyPacks: s } : l));
  return [...ls, lineForRow(row, s)];
}

/** Drop a line whose quantity is nothing (an empty or zero box left behind). */
export function dropEmptyLines(lines) {
  return (Array.isArray(lines) ? lines : []).filter(l => Number(l.qtyPacks) > 0);
}

/**
 * Can an item the supplier does not list join the order? It needs a pack (pack size times inner
 * size above zero, with a unit) and a price above zero, the same facts pickSupplierProduct reads
 * from supplier_products for a listed item; receiving refuses a line with no pack content and a
 * zero price would book stock at no cost. With the item's { baseUnit, conversions } the unit
 * must also convert to the item's unit: receiving refuses the WHOLE order otherwise, and by
 * then the order has been sent and its lines cannot be edited. Returns { ok, reason }.
 */
export function unlistedLineCheck({ packQty, innerQty, innerUnit, unitPrice }, { baseUnit = null, conversions = [], itemName = 'the item' } = {}) {
  const pq = Number(packQty), iq = Number(innerQty), price = Number(unitPrice);
  const unit = String(innerUnit || '').trim();
  if (!(pq > 0) || !(iq > 0)) return { ok: false, reason: 'Enter the pack: how many inner units in a pack and how much each holds (for example 6 x 2 l).' };
  if (!unit) return { ok: false, reason: 'Enter the unit the pack is measured in (each, kg, l).' };
  if (baseUnit && packContentInBase({ packQty: pq, innerQty: iq, innerUnit: unit }, baseUnit, conversions || []) == null) {
    return { ok: false, reason: `${unit} cannot be converted to ${itemName}'s unit (${baseUnit}). Use ${baseUnit}, or add a conversion on the item's Units tab first.` };
  }
  if (!(price > 0)) return { ok: false, reason: 'Enter the price of one pack, ex VAT. A line at no price would book stock at no cost.' };
  return { ok: true, reason: null };
}

/**
 * The order's lines after the supplier is changed. A line's pack, price, VAT rate and
 * supplier_product_id belong to the supplier it was typed for, so each line is rebuilt from the
 * NEW supplier's pack (preferred first) at the same number of packs, and a line whose item the
 * new supplier has no pack for comes off. Returns { lines, dropped } with the names taken off,
 * so the screen can say so. Without this the old supplier's pack and price were emailed to the
 * new supplier as 'pack typed' rows.
 */
export function relineForSupplier(lines, items, supplierId) {
  const byId = new Map((items || []).map(i => [i.id, i]));
  const kept = [], dropped = [];
  for (const l of lines || []) {
    const it = byId.get(l?.inventoryItemId) || null;
    const sp = supplierPack(it, supplierId);
    if (!sp) { dropped.push(it?.name || l?.description || 'Item no longer on file'); continue; }
    kept.push({
      ...l, description: it.name,
      packQty: Number(sp.packQty) || 1, innerQty: Number(sp.innerQty) || 1, innerUnit: sp.innerUnit || it.baseUnit || 'each',
      unitPrice: spNetPrice(sp), supplierProductId: sp.id,
      purchaseTaxRateId: sp.purchaseTaxRateId || it.purchaseTaxRateId || null,
    });
  }
  return { lines: kept, dropped };
}
