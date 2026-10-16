/**
 * stock/areaRules.js: the pure rules behind stock areas (16 Oct 2026). Tested (areaRules.test.js).
 *
 * Peter: "Things come in then go into a central cellar then they get distributed to fridges and
 * freezers. Counts are just all items which is wrong: you need to count by location then
 * complete as whole, or count via supplier, or just do a spot check." "Each stock area should
 * have its own holding of said item."
 *
 * Every venue has a managed list of areas; every item has a use area; every area holds its own
 * quantity of each item (the ledger's stock_movements.area_id, cached in
 * inventory_item_area_stock); a count is Full, By area, By supplier or Spot check, counted per
 * (item, area), ticked off per area, approved as a whole. No React, no Supabase in here: the
 * data layer is areas.js and counts.js, the screens are StockAreas.jsx and StockCounts.jsx.
 */

import { fmtVenueDate } from '../venueDate.js';

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const r4 = (v) => Math.round(num(v) * 10000) / 10000;

// ── Kinds and the usual six ────────────────────────────────────────────────────
export const AREA_KINDS = Object.freeze([
  { id: 'cellar', label: 'Cellar' },
  { id: 'walk_in', label: 'Walk in fridge' },
  { id: 'fridge', label: 'Fridge' },
  { id: 'freezer', label: 'Freezer' },
  { id: 'dry_store', label: 'Dry store' },
  { id: 'bar', label: 'Bar' },
  { id: 'kitchen', label: 'Kitchen' },
  { id: 'other', label: 'Other' },
]);
export const kindLabel = (kind) => AREA_KINDS.find((k) => k.id === kind)?.label || 'Other';

/** "Add the usual six": the areas a venue with none starts with. None is flagged receiving. */
export const USUAL_SIX = Object.freeze([
  { name: 'Cellar', kind: 'cellar' },
  { name: 'Walk in fridge', kind: 'walk_in' },
  { name: 'Freezer', kind: 'freezer' },
  { name: 'Dry store', kind: 'dry_store' },
  { name: 'Bar', kind: 'bar' },
  { name: 'Kitchen', kind: 'kitchen' },
]);

export const COUNT_TYPES = Object.freeze([
  { id: 'FULL', label: 'Full', desc: 'Every tracked item, every area. The whole venue on one sheet.' },
  { id: 'AREA', label: 'By area', desc: 'Pick the areas to count. Each area is marked complete by its counter, then the count is approved as a whole.' },
  { id: 'SUPPLIER', label: 'By supplier', desc: 'Every item one supplier delivers, in every area it sits in.' },
  { id: 'SPOT', label: 'Spot check', desc: 'Pick a few items and check them now.' },
]);
export const UNASSIGNED = 'unassigned';
export const UNASSIGNED_LABEL = 'Unassigned';

// ── Legacy storage text to areas ──────────────────────────────────────────────
/**
 * One spelling for the free text venues typed into "Storage location": trimmed, spaces
 * collapsed, lower case, dashes and underscores to spaces, a leading "the " dropped.
 * "Walk-in fridge" and "Walk in fridge" are one area; "Main Fridge " is its own area.
 * The migration's backfill says the same in SQL (20261016_OPS_stock_areas.sql, step 8a).
 */
export function normaliseAreaName(text) {
  let s = String(text ?? '').trim().replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').toLowerCase();
  if (s.startsWith('the ')) s = s.slice(4);
  return s;
}

/** The kind an area name suggests. Order matters: "Walk in freezer" is a freezer. */
export function kindFromName(text) {
  const n = normaliseAreaName(text);
  if (!n) return 'other';
  if (n.includes('freezer')) return 'freezer';
  if (n.includes('walk')) return 'walk_in';
  if (n.includes('fridge') || n.includes('chiller')) return 'fridge';
  if (n.includes('cellar')) return 'cellar';
  if (n.includes('dry') || n.includes('store') || n.includes('pantry')) return 'dry_store';
  if (n.includes('bar')) return 'bar';
  if (n.includes('kitchen') || n.includes('prep')) return 'kitchen';
  return 'other';
}

/** The live area a legacy text names, or null. */
export function legacyAreaFor(text, areas) {
  const n = normaliseAreaName(text);
  if (!n) return null;
  return (areas || []).find((a) => a && !a.archivedAt && normaliseAreaName(a.name) === n) || null;
}

/**
 * The areas a venue's items imply: one per distinct normalised text, the first spelling seen
 * (by createdAt, then name) as the display name, kind from the words. Live items only, so an
 * archived test item's "Fridge 14" does not become an area.
 */
export function legacyAreasFromItems(items) {
  const seen = new Map();
  const live = (items || []).filter((i) => i && !i.archivedAt && String(i.storageLocation ?? '').trim());
  live.sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')) || String(a.name || '').localeCompare(String(b.name || '')));
  for (const i of live) {
    const n = normaliseAreaName(i.storageLocation);
    if (!n || seen.has(n)) continue;
    seen.set(n, { name: String(i.storageLocation).trim(), kind: kindFromName(i.storageLocation) });
  }
  return [...seen.values()];
}

// ── Holdings per area ─────────────────────────────────────────────────────────
/**
 * Roll a list of movements { inventoryItemId, areaId, qtyBase } into
 * { [itemId]: { areas: { [areaId]: qty }, unassigned, total } }.
 */
export function areaHoldings(movements) {
  const out = {};
  for (const m of movements || []) {
    if (!m || !m.inventoryItemId) continue;
    const h = (out[m.inventoryItemId] ??= { areas: {}, unassigned: 0, total: 0 });
    const q = num(m.qtyBase);
    if (m.areaId) h.areas[m.areaId] = r4((h.areas[m.areaId] || 0) + q);
    else h.unassigned = r4(h.unassigned + q);
    h.total = r4(h.total + q);
  }
  return out;
}

/**
 * THE INVARIANT: an item's on hand equals the sum of its areas plus its movements with no area.
 * Returns the items that break it (expects none). `holdings` is areaHoldings()'s shape.
 */
export function holdingsInvariant(items, holdings) {
  const bad = [];
  for (const i of items || []) {
    if (!i) continue;
    const h = holdings?.[i.id];
    const areas = h ? Object.values(h.areas).reduce((s, q) => s + num(q), 0) : 0;
    const sum = r4(areas + num(h?.unassigned));
    if (Math.abs(sum - num(i.onHand)) > 1e-6) bad.push({ itemId: i.id, name: i.name, onHand: num(i.onHand), areas: r4(areas), unassigned: r4(num(h?.unassigned)), sum });
  }
  return bad;
}

/**
 * Stock an item WITH a use area holds in no area at all: its on hand minus the sum of its area
 * holdings. [{ itemId, name, areaId, qty }], expected empty: the database re homes such stock to
 * the item's area the moment the area is given (inventory_item_areas trigger, 16 Oct review), and
 * a Full count would otherwise find it in the area, expect 0 there and post it twice.
 * `holdings` is the simple map { itemId: { areaId: qty } }.
 */
export function strandedHoldings(items, holdings) {
  const out = [];
  for (const i of items || []) {
    if (!i || !i.areaId || i.archivedAt) continue;
    const areas = Object.values(holdings?.[i.id] || {}).reduce((s, q) => s + num(q), 0);
    const qty = r4(num(i.onHand) - areas);
    if (Math.abs(qty) > 1e-6) out.push({ itemId: i.id, name: i.name, areaId: i.areaId, qty });
  }
  return out;
}

/** Items with any area below zero: [{ itemId, areaId, qty }]. `holdings` is { itemId: { areaId: qty } }. */
export function areasBelowZero(holdings) {
  const out = [];
  for (const [itemId, areas] of Object.entries(holdings || {})) {
    for (const [areaId, qty] of Object.entries(areas || {})) if (num(qty) < 0) out.push({ itemId, areaId, qty: num(qty) });
  }
  return out;
}

/** An item's holding in one area from the simple map { itemId: { areaId: qty } }. */
export const holdingOf = (holdings, itemId, areaId) => num(holdings?.[itemId]?.[areaId]);

// ── Transfers (the pure part; the posting is post_stock_transfer_leg in SQL) ──
/**
 * The movement pairs a within venue transfer posts: OUT from `fromAreaId`, IN to `toAreaId`,
 * same quantity opposite sign, the carried cost, one key family. The item total never moves:
 * the pair sums to zero.
 */
export function transferPlan(lines, fromAreaId, toAreaId, costById = {}, transferId = 't') {
  const movements = [];
  for (const l of lines || []) {
    if (!l || !l.itemId || !(num(l.qtyBase) > 0)) continue;
    const cost = num(costById[l.itemId]);
    movements.push({ itemId: l.itemId, areaId: fromAreaId || null, qtyBase: -num(l.qtyBase), movementType: 'TRANSFER_OUT', unitCost: cost, idempotencyKey: `transfer:${transferId}:${l.id}:out` });
    movements.push({ itemId: l.itemId, areaId: toAreaId || null, qtyBase: num(l.qtyBase), movementType: 'TRANSFER_IN', unitCost: cost, idempotencyKey: `transfer:${transferId}:${l.id}:in` });
  }
  const netByItem = {};
  movements.forEach((m) => { netByItem[m.itemId] = r4((netByItem[m.itemId] || 0) + m.qtyBase); });
  return { movements, netByItem };
}

const normKey = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
/**
 * Match the sender's lines to the receiver's items: normalised SKU first, then normalised
 * name, never an archived item. Lines carry { id, skuSnapshot, nameSnapshot, toInventoryItemId, dropped }.
 * Returns { lines: [{ ...line, toInventoryItemId, matchedBy }], unmatched: [lineIds] }.
 */
export function matchTransferLines(lines, receiverItems) {
  const live = (receiverItems || []).filter((i) => i && !i.archivedAt);
  const bySku = new Map(); const byName = new Map();
  for (const i of live) {
    const sku = normKey(i.sku); const name = normKey(i.name);
    if (sku && !bySku.has(sku)) bySku.set(sku, i.id);
    if (name && !byName.has(name)) byName.set(name, i.id);
  }
  const out = []; const unmatched = [];
  for (const l of lines || []) {
    if (!l) continue;
    if (l.dropped) { out.push({ ...l, matchedBy: null }); continue; }
    if (l.toInventoryItemId && live.some((i) => i.id === l.toInventoryItemId)) { out.push({ ...l, matchedBy: 'kept' }); continue; }
    const sku = normKey(l.skuSnapshot); const name = normKey(l.nameSnapshot);
    const id = (sku && bySku.get(sku)) || (name && byName.get(name)) || null;
    if (id) out.push({ ...l, toInventoryItemId: id, matchedBy: sku && bySku.get(sku) === id ? 'sku' : 'name' });
    else { out.push({ ...l, toInventoryItemId: null, matchedBy: null }); unmatched.push(l.id); }
  }
  return { lines: out, unmatched };
}

/** A transfer can be received only when every line is matched or dropped. */
export function canReceive(lines) {
  const list = (lines || []).filter(Boolean);
  if (!list.length) return false;
  return list.every((l) => l.dropped || l.toInventoryItemId);
}

// ── Count scope ───────────────────────────────────────────────────────────────
/**
 * Which lines a new count gets.
 *   scope: { type: FULL | AREA | SUPPLIER | SPOT | PARTIAL, areaIds, supplierId, itemIds }
 *   ctx:   { items, itemAreas: { itemId: areaId }, holdings: { itemId: { areaId: qty } },
 *            supplierProducts: [{ inventoryItemId, supplierId }], areas: [{ id, name, sortOrder }] }
 * Items considered: live and tracked (PARTIAL keeps every live item, as before). FULL: every item.
 * SUPPLIER: items with a supplier_products row for that supplier. SPOT and PARTIAL: the picks.
 * AREA: items whose use area is ticked, plus items with a non zero holding in a ticked area.
 * Lines per item: one per area in union(use area, every area with a non zero holding); an item
 * with neither gets one Unassigned line (areaId null). AREA counts keep only the ticked areas.
 * expected_qty: the area's holding now; for an Unassigned line the item's on hand, as before.
 */
export function resolveCountScope(scope, ctx) {
  const type = String(scope?.type || 'FULL').toUpperCase();
  const items = (ctx?.items || []).filter((i) => i && !i.archivedAt && (type === 'PARTIAL' || i.isTracked !== false));
  const itemAreas = ctx?.itemAreas || {};
  const holdings = ctx?.holdings || {};
  const areas = (ctx?.areas || []).filter((a) => a && !a.archivedAt);
  const areaOrder = new Map(areas.map((a, i) => [a.id, num(a.sortOrder ?? i)]));
  const liveArea = (id) => !!id && areaOrder.has(id);
  const ticked = new Set((scope?.areaIds || []).filter(liveArea));
  const picks = new Set(scope?.itemIds || []);
  const supplierItems = new Set((ctx?.supplierProducts || []).filter((sp) => sp && scope?.supplierId && sp.supplierId === scope.supplierId).map((sp) => sp.inventoryItemId));

  const areasOfItem = (i) => {
    const set = new Set();
    const use = itemAreas[i.id];
    if (liveArea(use)) set.add(use);
    for (const [areaId, qty] of Object.entries(holdings[i.id] || {})) if (liveArea(areaId) && Math.abs(num(qty)) > 1e-9) set.add(areaId);
    return set;
  };

  let chosen;
  if (type === 'AREA') chosen = items.filter((i) => [...areasOfItem(i)].some((a) => ticked.has(a)));
  else if (type === 'SUPPLIER') chosen = items.filter((i) => supplierItems.has(i.id));
  else if (type === 'SPOT' || type === 'PARTIAL') chosen = items.filter((i) => picks.has(i.id));
  else chosen = items;

  const lines = [];
  for (const i of chosen) {
    let set = [...areasOfItem(i)];
    if (type === 'AREA') set = set.filter((a) => ticked.has(a));
    if (!set.length) {
      lines.push({ itemId: i.id, areaId: null, expectedQty: num(i.onHand), unitCost: i.currentCost == null ? null : num(i.currentCost) });
      continue;
    }
    for (const areaId of set) {
      lines.push({ itemId: i.id, areaId, expectedQty: holdingOf(holdings, i.id, areaId), unitCost: i.currentCost == null ? null : num(i.currentCost) });
    }
  }
  const nameOf = (id) => String(ctx?.items?.find((x) => x.id === id)?.name || '');
  lines.sort((a, b) => {
    const oa = a.areaId ? areaOrder.get(a.areaId) : Number.MAX_SAFE_INTEGER;
    const ob = b.areaId ? areaOrder.get(b.areaId) : Number.MAX_SAFE_INTEGER;
    return (oa - ob) || nameOf(a.itemId).localeCompare(nameOf(b.itemId)) || String(a.areaId || '').localeCompare(String(b.areaId || ''));
  });
  lines.forEach((l, i) => { l.sortOrder = i; });
  const areaIds = [...new Set(lines.map((l) => l.areaId).filter(Boolean))];
  return { lines, areaIds, itemIds: [...new Set(lines.map((l) => l.itemId))] };
}

/** Which area a movement with no area of its own lands in (what post_stock_movement does). */
export function defaultAreaFor(movementType, itemId, { itemAreas = {}, receivingAreaId = null } = {}) {
  if (movementType === 'PURCHASE_RECEIPT' && receivingAreaId) return receivingAreaId;
  return itemAreas[itemId] || null;
}

// ── The sheet ─────────────────────────────────────────────────────────────────
/**
 * Lines grouped by area, in area sort order, Unassigned last. Only groups with lines are
 * returned, so a venue with no areas gets one group (Unassigned) and the screen shows no header.
 * Lines are camelCase ({ areaId }).
 */
export function groupLinesByArea(lines, areas) {
  const live = (areas || []).filter(Boolean);
  const order = new Map(live.map((a, i) => [a.id, num(a.sortOrder ?? i)]));
  const groups = new Map();
  for (const l of lines || []) {
    if (!l) continue;
    const key = l.areaId && order.has(l.areaId) ? l.areaId : UNASSIGNED;
    if (!groups.has(key)) groups.set(key, { areaId: key === UNASSIGNED ? null : key, key, name: key === UNASSIGNED ? UNASSIGNED_LABEL : (live.find((a) => a.id === key)?.name || 'Area'), lines: [] });
    groups.get(key).lines.push(l);
  }
  return [...groups.values()].sort((a, b) => {
    const oa = a.areaId ? order.get(a.areaId) : Number.MAX_SAFE_INTEGER;
    const ob = b.areaId ? order.get(b.areaId) : Number.MAX_SAFE_INTEGER;
    return oa - ob;
  });
}

/**
 * Per area subtotal: counted lines / lines, and the variance value of the counted lines
 * (counted minus expected, times the line's unit cost). `countedOf(line)` gives the figure the
 * screen holds for a line (typed or saved), null when none.
 */
export function areaSubtotal(lines, countedOf = (l) => l.countedQty) {
  let counted = 0, varianceValue = 0;
  for (const l of lines || []) {
    const c = countedOf(l);
    if (c == null || c === '') continue;
    counted += 1;
    varianceValue += (num(c) - num(l.expectedQty)) * num(l.unitCost);
  }
  return { counted, total: (lines || []).length, varianceValue: r4(varianceValue) };
}

/**
 * Per item roll up across the sheet: counted total, expected total, the per area pieces, and
 * "moved between areas" when the pieces differ but the totals match (the Cellar 0 / fridge 12
 * case: the count recorded a transfer nobody wrote down).
 */
export function rollUpLinesPerItem(lines, countedOf = (l) => l.countedQty) {
  const out = {};
  for (const l of lines || []) {
    if (!l) continue;
    const r = (out[l.inventoryItemId] ??= { counted: 0, expected: 0, pieces: [], allCounted: true, anyCounted: false, movedBetweenAreas: false });
    const c = countedOf(l);
    const has = c != null && c !== '';
    r.pieces.push({ lineId: l.id, areaId: l.areaId || null, counted: has ? num(c) : null, expected: num(l.expectedQty) });
    r.expected = r4(r.expected + num(l.expectedQty));
    if (has) { r.counted = r4(r.counted + num(c)); r.anyCounted = true; } else r.allCounted = false;
  }
  for (const r of Object.values(out)) {
    if (!r.allCounted || r.pieces.length < 2) continue;
    const piecesDiffer = r.pieces.some((p) => Math.abs(num(p.counted) - p.expected) > 1e-9);
    r.movedBetweenAreas = piecesDiffer && Math.abs(r.counted - r.expected) < 1e-9;
  }
  return out;
}

/** The idempotency key of a count adjustment: one shape per count+item+area, the old one for area null. */
export function adjustmentKey(countId, itemId, areaId) {
  return areaId ? `count:${countId}:${itemId}:${areaId}` : `count:${countId}:${itemId}`;
}

// ── Approval ──────────────────────────────────────────────────────────────────
const joinNames = (names) => {
  const n = names.filter(Boolean);
  if (n.length <= 1) return n.join('');
  return `${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}`;
};

/**
 * May this count be approved? areaRows: [{ areaId, name, status }]. ok when every row is
 * complete, or when the approver confirmed. The confirm text names the incomplete areas; the
 * note goes on stock_counts.approval_note. No long dashes anywhere in the words.
 */
export function approvalGate(areaRows, { confirmIncomplete = false } = {}) {
  const rows = (areaRows || []).filter(Boolean);
  const incomplete = rows.filter((r) => r.status !== 'complete').map((r) => r.name || 'an area');
  if (!incomplete.length) return { ok: true, incomplete: [], confirmText: null, note: null };
  const names = joinNames(incomplete);
  const verb = incomplete.length === 1 ? 'is' : 'are';
  const its = incomplete.length === 1 ? 'Its' : 'Their';
  return {
    ok: !!confirmIncomplete,
    incomplete,
    confirmText: `${names} ${verb} not marked complete. Approve anyway? ${its} uncounted lines will be left as the system has them.`,
    note: `Approved with ${incomplete.join(', ')} not marked complete`,
  };
}

/**
 * The warnings an AREA, SUPPLIER or SPOT approval shows first (16 Oct review, finding 1c): every
 * counted line whose item has a non zero holding in another area, with the item total after
 * approval, and the "it was moved from X" offer when the counted figure is within what the
 * receiving area (or, failing that, the one other area) holds.
 *   lines: camelCase count lines with a counted figure (countedOf gives it)
 *   holdings: { itemId: { areaId: qty } }  areas: [{ id, name }]  receivingAreaId: the venue's, or null
 * Returns [{ lineId, itemId, areaId, counted, areaHolding, others: [{ areaId, name, qty }], totalAfter,
 *            moveFrom: { areaId, name, qty } | null }]
 */
export function otherAreaWarnings(lines, holdings, areas, receivingAreaId = null, countedOf = (l) => l.countedQty) {
  const nameOf = (id) => (areas || []).find((a) => a && a.id === id)?.name || 'another area';
  const out = [];
  for (const l of lines || []) {
    if (!l || !l.areaId) continue;
    const c = countedOf(l);
    if (c == null || c === '') continue;
    const counted = num(c);
    const mine = holdingOf(holdings, l.inventoryItemId, l.areaId);
    const others = Object.entries(holdings?.[l.inventoryItemId] || {})
      .filter(([areaId, qty]) => areaId !== l.areaId && Math.abs(num(qty)) > 1e-9)
      .map(([areaId, qty]) => ({ areaId, name: nameOf(areaId), qty: num(qty) }));
    if (!others.length) continue;
    const delta = r4(counted - mine);
    const totalAfter = r4(counted + others.reduce((s, o) => s + o.qty, 0));
    let moveFrom = null;
    if (delta > 0) {
      const src = others.find((o) => o.areaId === receivingAreaId) || (others.length === 1 ? others[0] : null);
      if (src && src.qty >= delta) moveFrom = { areaId: src.areaId, name: src.name, qty: delta };
    }
    out.push({ lineId: l.id, itemId: l.inventoryItemId, areaId: l.areaId, counted, areaHolding: mine, others, totalAfter, moveFrom });
  }
  return out;
}

// ── Names and status words ────────────────────────────────────────────────────
/**
 * "Count 16 Oct 2026 · Walk in fridge", "Count 16 Oct 2026 · Cellar, Freezer" (up to two names),
 * "Count 16 Oct 2026 · 3 areas", "Count 16 Oct 2026 · Hartley Fresh Foods",
 * "Count 16 Oct 2026 · Spot check", "Count 16 Oct 2026 · Full". The venue's clock.
 */
export function countNameFor({ ts = new Date(), tz = null, type = 'FULL', areaNames = [], supplierName = null } = {}) {
  const day = fmtVenueDate(ts, tz) || '';
  const t = String(type || 'FULL').toUpperCase();
  let kind = 'Full';
  if (t === 'AREA') {
    const names = (areaNames || []).filter(Boolean);
    kind = names.length === 0 ? 'By area' : names.length <= 2 ? names.join(', ') : `${names.length} areas`;
  } else if (t === 'SUPPLIER') kind = supplierName ? String(supplierName) : 'By supplier';
  else if (t === 'SPOT') kind = 'Spot check';
  else if (t === 'PARTIAL') kind = 'Partial';
  return `Count ${day} · ${kind}`.replace(/\s+·/, ' ·');
}

/** "2 of 4 areas complete", or "All 4 areas complete · ready to approve". Empty for a count with no areas. */
export function countStatusText(areaRows) {
  const rows = (areaRows || []).filter(Boolean);
  if (!rows.length) return { text: '', ready: false };
  const done = rows.filter((r) => r.status === 'complete').length;
  if (done === rows.length) return { text: rows.length === 1 ? 'Area complete · ready to approve' : `All ${rows.length} areas complete · ready to approve`, ready: true };
  return { text: `${done} of ${rows.length} area${rows.length === 1 ? '' : 's'} complete`, ready: false };
}

/** The receiving area's one line of explanation on the Areas screen. */
export const RECEIVING_HELP = 'Deliveries will land here. Move them out with a transfer, or the fridge will show below zero.';

// ── Search, filters and paging (1,000 item venues) ────────────────────────────
const textOf = (item) => {
  const codes = (item?.supplierProducts || []).map((sp) => sp.supplierSku).filter(Boolean);
  return `${item?.name || ''} ${item?.sku || ''} ${item?.category || ''} ${codes.join(' ')}`.toLowerCase();
};

/**
 * Filter items for a picker or list. filters: { q, areaId ('any' | 'none' | id), category,
 * supplierId, noAreaOnly, includeArchived }. ctx: { itemAreas: { itemId: areaId },
 * supplierProducts: [{ inventoryItemId, supplierId, supplierSku }] } (items may also carry
 * their own supplierProducts). Search matches name, SKU, category and supplier code.
 */
export function filterItems(items, filters = {}, ctx = {}) {
  const q = String(filters.q || '').trim().toLowerCase();
  const itemAreas = ctx.itemAreas || {};
  const spByItem = new Map();
  for (const sp of ctx.supplierProducts || []) {
    if (!sp?.inventoryItemId) continue;
    if (!spByItem.has(sp.inventoryItemId)) spByItem.set(sp.inventoryItemId, []);
    spByItem.get(sp.inventoryItemId).push(sp);
  }
  const words = q ? q.split(/\s+/) : [];
  return (items || []).filter((i) => {
    if (!i) return false;
    if (!filters.includeArchived && i.archivedAt) return false;
    const areaOf = itemAreas[i.id] ?? i.areaId ?? null;
    if (filters.noAreaOnly && areaOf) return false;
    if (filters.areaId && filters.areaId !== 'any') {
      if (filters.areaId === 'none' ? !!areaOf : areaOf !== filters.areaId) return false;
    }
    if (filters.category && (i.category || '') !== filters.category) return false;
    if (filters.supplierId) {
      const sps = [...(i.supplierProducts || []), ...(spByItem.get(i.id) || [])];
      if (!sps.some((sp) => sp.supplierId === filters.supplierId)) return false;
    }
    if (words.length) {
      const extra = (spByItem.get(i.id) || []).map((sp) => sp.supplierSku).filter(Boolean).join(' ').toLowerCase();
      const hay = `${textOf(i)} ${extra}`;
      if (!words.every((w) => hay.includes(w))) return false;
    }
    return true;
  });
}

/**
 * Filter count lines in memory. filters: { q, areaId ('any' | 'none' | id), category,
 * uncountedOnly, varianceOnly }. ctx: { itemsById, countedOf(line) }. Lines are camelCase.
 */
export function filterLines(lines, filters = {}, ctx = {}) {
  const itemsById = ctx.itemsById || {};
  const countedOf = ctx.countedOf || ((l) => l.countedQty);
  const q = String(filters.q || '').trim().toLowerCase();
  const words = q ? q.split(/\s+/) : [];
  return (lines || []).filter((l) => {
    if (!l) return false;
    const item = itemsById[l.inventoryItemId];
    if (filters.areaId && filters.areaId !== 'any') {
      if (filters.areaId === 'none' ? !!l.areaId : l.areaId !== filters.areaId) return false;
    }
    if (filters.category && (item?.category || '') !== filters.category) return false;
    const c = countedOf(l);
    const has = c != null && c !== '';
    if (filters.uncountedOnly && has) return false;
    if (filters.varianceOnly && (!has || Math.abs(num(c) - num(l.expectedQty)) < 1e-9)) return false;
    if (words.length) {
      const hay = textOf(item || { name: '' });
      if (!words.every((w) => hay.includes(w))) return false;
    }
    return true;
  });
}

/** Distinct categories of a list, sorted, blanks dropped. */
export function categoriesOf(items) {
  return [...new Set((items || []).map((i) => (i?.category || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

/** Rows in chunks of `size` (the line insert goes 200 a request). */
export function chunkArray(rows, size = 200) {
  const n = Math.max(1, Math.floor(num(size)) || 1);
  const out = [];
  for (let i = 0; i < (rows || []).length; i += n) out.push(rows.slice(i, i + n));
  return out;
}

/**
 * How many rows a long list shows: `chunks` chunks of `step` rows, never more than `total`.
 * The sentinel at the bottom of a list bumps `chunks`; 1,000 items is never 1,000 rows at once.
 */
export function visibleRows(total, chunks = 1, step = 50) {
  const t = Math.max(0, Math.floor(num(total)));
  const c = Math.max(1, Math.floor(num(chunks)) || 1);
  const s = Math.max(1, Math.floor(num(step)) || 1);
  return Math.min(t, c * s);
}

/** A sheet with more than this many lines opens with its groups collapsed. */
export const COLLAPSE_OVER = 300;
export const RENDER_STEP = 50;
export const INSERT_CHUNK = 200;
export const POST_IN_FLIGHT = 3;

/** "Posting 240 of 1,100" for the Approve button while the adjustments go through. */
export function postingText(done, total) {
  const fmt = (n) => Math.max(0, Math.floor(num(n))).toLocaleString('en-GB');
  return `Posting ${fmt(done)} of ${fmt(total)}`;
}

/** The toast after Bulk assign: "38 items moved to Dry store, 12 holdings moved", with ", 2 failed" only when something did. */
export function bulkAssignText({ moved = 0, holdings = 0, failed = 0, areaName = 'No area' } = {}) {
  const n = (v, w) => `${v} ${w}${v === 1 ? '' : 's'}`;
  return `${n(moved, 'item')} moved to ${areaName}, ${n(holdings, 'holding')} moved${failed > 0 ? `, ${failed} failed` : ''}`;
}

/** Archive refusal words: "Move 12 items and 3 holdings out first". Null when the area is clear. */
export function archiveRefusal(itemCount, holdingCount) {
  const items = num(itemCount), holdings = num(holdingCount);
  if (items <= 0 && holdings <= 0) return null;
  const parts = [];
  if (items > 0) parts.push(`${items} item${items === 1 ? '' : 's'}`);
  if (holdings > 0) parts.push(`${holdings} holding${holdings === 1 ? '' : 's'}`);
  return `Move ${parts.join(' and ')} out first`;
}

/** A tidy TR-XXXXXX reference for a transfer. */
export function transferReference(rand = Math.random) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i += 1) s += chars[Math.floor(rand() * chars.length) % chars.length];
  return `TR-${s}`;
}

// ── Stock by area (the report tab, builder B) ─────────────────────────────────
/**
 * One row per item for the Stock by area grid: the holding in each live area, the Unassigned
 * figure (on hand minus the sum of its areas, shown only when it differs), the item total and
 * the value (each area floored at zero, like valuation.js floors the item). filters:
 * { q, areaId ('any' | id), belowOnly }. With an area filter only items with a holding or an
 * assignment there are kept. Rows are sorted by name. Totals per area and overall come back too.
 *   items: fetchInventoryItems items (id, name, sku, category, onHand, currentCost, areaId, archivedAt)
 *   areas: live areas [{ id, name, sortOrder }]
 *   holdings: { itemId: { areaId: qtyBase } }
 */
export function stockByAreaRows(items, areas, holdings, filters = {}) {
  const live = (areas || []).filter((a) => a && !a.archivedAt);
  const q = String(filters.q || '').trim().toLowerCase();
  const words = q ? q.split(/\s+/) : [];
  const areaFilter = filters.areaId && filters.areaId !== 'any' ? filters.areaId : null;
  const rows = [];
  const totals = { perArea: {}, unassigned: 0, total: 0, value: 0 };
  live.forEach((a) => { totals.perArea[a.id] = 0; });
  for (const i of (items || [])) {
    if (!i || i.archivedAt) continue;
    const per = {};
    let areaSum = 0;
    let value = 0;
    let below = false;
    for (const a of live) {
      const qty = r4(holdings?.[i.id]?.[a.id]);
      per[a.id] = qty;
      areaSum += qty;
      value += Math.max(0, qty) * num(i.currentCost);
      if (qty < 0) below = true;
    }
    const total = r4(num(i.onHand));
    const unassigned = r4(total - areaSum);
    if (Math.abs(unassigned) > 1e-9) { value += Math.max(0, unassigned) * num(i.currentCost); if (unassigned < 0) below = true; }
    if (areaFilter && !(Math.abs(per[areaFilter] || 0) > 1e-9 || (i.areaId || null) === areaFilter)) continue;
    if (filters.belowOnly && !below) continue;
    if (words.length) {
      const hay = `${i.name || ''} ${i.sku || ''} ${i.category || ''}`.toLowerCase();
      if (!words.every((w) => hay.includes(w))) continue;
    }
    rows.push({ id: i.id, name: i.name || '', sku: i.sku || '', category: i.category || '', areaId: i.areaId || null, perArea: per, unassigned, total, value: Math.round(value * 100) / 100, below });
    live.forEach((a) => { totals.perArea[a.id] = r4(totals.perArea[a.id] + per[a.id]); });
    totals.unassigned = r4(totals.unassigned + unassigned);
    totals.total = r4(totals.total + total);
    totals.value += value;
  }
  totals.value = Math.round(totals.value * 100) / 100;
  rows.sort((a, b) => a.name.localeCompare(b.name));
  const showUnassigned = rows.some((r) => Math.abs(r.unassigned) > 1e-9);
  return { rows, totals, showUnassigned, belowCount: rows.filter((r) => r.below).length };
}
