/**
 * stock/data.js — Supabase data layer for the stock system (slice 1 tables).
 *
 * Mirrors the house pattern in src/lib/db.js: every function resolves a real
 * locationId (guarding the loc-demo trap), maps camelCase ↔ snake_case explicitly,
 * and returns { data, error } or a small result object. Cost derivation reuses the
 * pure engine in costing.js so the maths lives in exactly one place.
 *
 * Tables: inventory_items, inventory_item_conversions, suppliers, supplier_products,
 * item_packaging_formats, item_cost_history (see 20260621d_stock_foundation.sql).
 */

import { supabase, isMock, getLocationId, getActiveLocationSync } from '../supabase';
import { packBaseUnitCost } from './costing.js';
import { purchaseNet } from '../tax.js';

const nowIso = () => new Date().toISOString();

/**
 * Fetch this location's purchase VAT rates as { rateId: rateDecimal } (0.2 for 20%).
 * Reuses the sales tax_rates table (same Ops DB). Missing/empty → no rates → no VAT
 * stripping happens, so callers degrade safely to net-as-entered.
 */
export async function fetchTaxRateMap(locationId) {
  const out = {};
  if (!supabase || !locationId) return out;
  const { data } = await supabase.from('tax_rates').select('id, rate').eq('location_id', locationId);
  (data || []).forEach((r) => { out[r.id] = Number(r.rate) || 0; });
  return out;
}
/** Resolved purchase VAT rate (decimal) for a supplier product: line override → item default → 0. */
const spVatRate = (sp, item, ratesById) => Number(ratesById[sp.purchaseTaxRateId || item.purchaseTaxRateId] || 0);

/** Resolve a usable locationId or null (never loc-demo). */
async function ensureLoc(locationId) {
  if (!locationId || locationId === 'loc-demo') locationId = getActiveLocationSync();
  if (!locationId || locationId === 'loc-demo') locationId = await getLocationId().catch(() => null);
  if (!locationId || locationId === 'loc-demo') return null;
  return locationId;
}

/**
 * A write that matched NO rows comes back from PostgREST as a plain success with an
 * empty body — an RLS policy that matches nothing is indistinguishable from a save,
 * so the caller's `if (error)` passes and the UI says "done". Every write below asks
 * for the id back and treats nothing coming back as the failure it is.
 * (Same check as src/backoffice/sections/DeviceProfiles.jsx.)
 */
const zeroRows = (what, data) => (!data || data.length === 0)
  ? new Error(`${what} matched 0 rows — RLS blocked it or the row no longer exists`)
  : null;
/** Same check for .select().maybeSingle(), which returns data:null with error:null. */
const noRow = (what, row) => row ? null
  : new Error(`${what} returned no row — RLS blocked it or it matched nothing`);

const num = (v) => (v === '' || v == null ? null : Number(v));

// ── mappers ──────────────────────────────────────────────────────────────────
const itemFromRow = (r) => ({
  id: r.id, locationId: r.location_id, orgId: r.org_id, name: r.name, kind: r.kind,
  baseUnit: r.base_unit, accountingGroup: r.accounting_group, category: r.category,
  isTracked: r.is_tracked !== false, isSellable: r.is_sellable === true,
  currentCost: r.current_cost == null ? null : Number(r.current_cost),
  costMethod: r.cost_method || 'MOVING_AVG',
  onHand: r.on_hand == null ? 0 : Number(r.on_hand),
  allergens: Array.isArray(r.allergens) ? r.allergens : [],
  shelfLifeDays: r.shelf_life_days, storageLocation: r.storage_location,
  defaultSupplierId: r.default_supplier_id, sku: r.sku, barcode: r.barcode, notes: r.notes,
  purchaseTaxRateId: r.purchase_tax_rate_id || null,
  archivedAt: r.archived_at, createdAt: r.created_at, updatedAt: r.updated_at,
});
const itemToRow = (i, locationId) => ({
  ...(i.id ? { id: i.id } : {}),
  location_id: locationId, org_id: i.orgId || null,
  name: (i.name || '').trim(), kind: i.kind === 'MADE' ? 'MADE' : 'PURCHASED',
  base_unit: i.baseUnit || 'each', accounting_group: i.accountingGroup || null,
  category: i.category || null, is_tracked: i.isTracked !== false, is_sellable: i.isSellable === true,
  current_cost: num(i.currentCost), cost_method: i.costMethod || 'MOVING_AVG',
  allergens: Array.isArray(i.allergens) ? i.allergens : [],
  shelf_life_days: i.shelfLifeDays == null || i.shelfLifeDays === '' ? null : Number(i.shelfLifeDays),
  storage_location: i.storageLocation || null, default_supplier_id: i.defaultSupplierId || null,
  sku: i.sku || null, barcode: i.barcode || null, notes: i.notes || null,
  purchase_tax_rate_id: i.purchaseTaxRateId || null,
  updated_at: nowIso(),
});

const supplierFromRow = (r) => ({
  id: r.id, locationId: r.location_id, orgId: r.org_id, name: r.name, contactName: r.contact_name,
  email: r.email, phone: r.phone, accountNumber: r.account_number,
  paymentTermsDays: r.payment_terms_days, minOrderValue: r.min_order_value == null ? null : Number(r.min_order_value),
  deliveryDays: Array.isArray(r.delivery_days) ? r.delivery_days : [], cutoffTime: r.cutoff_time,
  notes: r.notes, archivedAt: r.archived_at,
});
const supplierToRow = (s, locationId) => ({
  ...(s.id ? { id: s.id } : {}),
  location_id: locationId, org_id: s.orgId || null, name: (s.name || '').trim(),
  contact_name: s.contactName || null, email: s.email || null, phone: s.phone || null,
  account_number: s.accountNumber || null,
  payment_terms_days: s.paymentTermsDays == null || s.paymentTermsDays === '' ? null : Number(s.paymentTermsDays),
  min_order_value: num(s.minOrderValue), delivery_days: Array.isArray(s.deliveryDays) ? s.deliveryDays : [],
  cutoff_time: s.cutoffTime || null, notes: s.notes || null, updated_at: nowIso(),
});

const spFromRow = (r) => ({
  id: r.id, locationId: r.location_id, inventoryItemId: r.inventory_item_id, supplierId: r.supplier_id,
  supplierSku: r.supplier_sku, packDescription: r.pack_description,
  packQty: Number(r.pack_qty), innerQty: Number(r.inner_qty), innerUnit: r.inner_unit,
  packPrice: Number(r.pack_price), isPreferred: r.is_preferred === true,
  purchaseTaxRateId: r.purchase_tax_rate_id || null, priceIncludesTax: r.price_includes_tax === true,
});
const spToRow = (sp, locationId) => ({
  ...(sp.id ? { id: sp.id } : {}),
  location_id: locationId, inventory_item_id: sp.inventoryItemId, supplier_id: sp.supplierId,
  supplier_sku: sp.supplierSku || null, pack_description: sp.packDescription || null,
  pack_qty: Number(sp.packQty) || 1, inner_qty: Number(sp.innerQty) || 1, inner_unit: sp.innerUnit || 'each',
  pack_price: Number(sp.packPrice) || 0, is_preferred: sp.isPreferred === true,
  purchase_tax_rate_id: sp.purchaseTaxRateId || null, price_includes_tax: sp.priceIncludesTax === true,
  updated_at: nowIso(),
});

const convFromRow = (r) => ({
  id: r.id, inventoryItemId: r.inventory_item_id,
  fromQty: Number(r.from_qty), fromUnit: r.from_unit, toQty: Number(r.to_qty), toUnit: r.to_unit,
});

const packFromRow = (r) => ({
  id: r.id, inventoryItemId: r.inventory_item_id, name: r.name,
  qtyInBase: Number(r.qty_in_base), parentFormatId: r.parent_format_id,
  isCountDefault: r.is_count_default === true, isPurchaseDefault: r.is_purchase_default === true,
});

// ── units ────────────────────────────────────────────────────────────────────
export const fetchStockUnits = async () => {
  if (isMock || !supabase) return { data: [], error: null };
  return supabase.from('stock_units').select('*').order('dimension');
};

// ── inventory items (+ joined conversions & supplier products) ────────────────
/**
 * Fetch all inventory items for a location, each with its conversions[] and
 * supplierProducts[] (with a client-derived baseUnitCost for display).
 */
export const fetchInventoryItems = async (locationId = null) => {
  if (isMock || !supabase) return { data: [], error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: [], error: null };
  const [{ data: items, error }, { data: convs }, { data: sps }, { data: packs }, ratesById] = await Promise.all([
    supabase.from('inventory_items').select('*').eq('location_id', locationId).order('name'),
    supabase.from('inventory_item_conversions').select('*').eq('location_id', locationId),
    // Ordered, not incidental: readers pick the buy/count default and the preferred
    // supplier with .find(), so an unordered fetch let two devices resolve a different
    // row from the same data — and price purchase orders off a different pack size.
    supabase.from('supplier_products').select('*').eq('location_id', locationId).order('created_at').order('id'),
    supabase.from('item_packaging_formats').select('*').eq('location_id', locationId).order('created_at').order('id'),
    fetchTaxRateMap(locationId),
  ]);
  if (error) return { data: [], error };
  const convByItem = {};
  (convs || []).forEach((c) => { (convByItem[c.inventory_item_id] ??= []).push(convFromRow(c)); });
  const spByItem = {};
  (sps || []).forEach((s) => { (spByItem[s.inventory_item_id] ??= []).push(spFromRow(s)); });
  const packByItem = {};
  (packs || []).forEach((p) => { (packByItem[p.inventory_item_id] ??= []).push(packFromRow(p)); });
  const mapped = (items || []).map((r) => {
    const it = itemFromRow(r);
    it.conversions = convByItem[r.id] || [];
    it.packaging = packByItem[r.id] || [];
    const bridges = it.conversions.map((c) => ({ fromQty: c.fromQty, fromUnit: c.fromUnit, toQty: c.toQty, toUnit: c.toUnit }));
    it.supplierProducts = (spByItem[r.id] || []).map((sp) => {
      // NET pack price feeds costing: strip VAT only when the price was entered inc-VAT.
      const vatRate = spVatRate(sp, it, ratesById);
      const netPackPrice = purchaseNet(sp.packPrice, sp.priceIncludesTax, vatRate);
      let baseUnitCost = null;
      try {
        baseUnitCost = packBaseUnitCost({
          packPrice: netPackPrice, packQty: sp.packQty, innerQty: sp.innerQty,
          innerUnit: sp.innerUnit, baseUnit: it.baseUnit, itemConversions: bridges,
        }).baseUnitCost;
      } catch { /* unit bridge missing — surfaced in UI */ }
      return { ...sp, baseUnitCost, netPackPrice, vatRate };
    });
    return it;
  });
  return { data: mapped, error: null };
};

export const upsertInventoryItem = async (item, locationId = null) => {
  if (isMock || !supabase) return { data: null, error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: null, error: new Error('No locationId') };
  // maybeSingle() hands back data:null with error:null when nothing came back —
  // a blocked write reads exactly like a save. Report it.
  const { data, error } = await supabase.from('inventory_items').upsert(itemToRow(item, locationId)).select().maybeSingle();
  return { data, error: error || noRow('Item save', data) };
};

export const setInventoryItemArchived = async (id, archived, locationId = null) => {
  if (isMock || !supabase) return { data: null, error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: null, error: new Error('No locationId') };
  const { data, error } = await supabase.from('inventory_items')
    .update({ archived_at: archived ? nowIso() : null, updated_at: nowIso() })
    .eq('location_id', locationId).eq('id', id).select('id');
  return { data, error: error || zeroRows(archived ? 'Archive item' : 'Restore item', data) };
};

// ── suppliers ─────────────────────────────────────────────────────────────────
export const fetchSuppliers = async (locationId = null) => {
  if (isMock || !supabase) return { data: [], error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: [], error: null };
  const { data, error } = await supabase.from('suppliers').select('*')
    .eq('location_id', locationId).is('archived_at', null).order('name');
  return { data: (data || []).map(supplierFromRow), error };
};

export const upsertSupplier = async (supplier, locationId = null) => {
  if (isMock || !supabase) return { data: null, error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: null, error: new Error('No locationId') };
  const { data, error } = await supabase.from('suppliers').upsert(supplierToRow(supplier, locationId)).select().maybeSingle();
  return { data: data ? supplierFromRow(data) : null, error: error || noRow('Supplier save', data) };
};

export const setSupplierArchived = async (id, archived, locationId = null) => {
  if (isMock || !supabase) return { data: null, error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: null, error: new Error('No locationId') };
  const { data, error } = await supabase.from('suppliers').update({ archived_at: archived ? nowIso() : null, updated_at: nowIso() })
    .eq('location_id', locationId).eq('id', id).select('id');
  return { data, error: error || zeroRows(archived ? 'Archive supplier' : 'Restore supplier', data) };
};

// ── supplier products (the pack→unit cost source) ─────────────────────────────
export const upsertSupplierProduct = async (sp, locationId = null) => {
  if (isMock || !supabase) return { data: null, error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: null, error: new Error('No locationId') };
  // Only one preferred per item: clear others first when this one is preferred.
  // Abort if that clear fails — carrying on would leave TWO preferred suppliers, and
  // recomputeItemCost takes the first preferred it walks past, so the item's cost
  // would depend on which row the fetch happened to return first.
  if (sp.isPreferred && sp.inventoryItemId) {
    let clear = supabase.from('supplier_products').update({ is_preferred: false })
      .eq('location_id', locationId).eq('inventory_item_id', sp.inventoryItemId);
    if (sp.id) clear = clear.neq('id', sp.id);   // leave the row we're about to write
    const { error: clearErr } = await clear.select('id');
    if (clearErr) return { data: null, error: clearErr };
  }
  const { data, error } = await supabase.from('supplier_products').upsert(spToRow(sp, locationId)).select().maybeSingle();
  const saveErr = error || noRow('Supplier product save', data);
  if (saveErr) return { data: null, error: saveErr };
  let partial = null;
  if (sp.inventoryItemId) {
    // The pack IS the cost source, so a lost recompute has to reach the operator. But it
    // is reported as `partial`, NOT as `error`: the pack row DID save, and callers treat
    // `error` as "nothing happened" and leave the form populated — so the operator saves
    // again and, because spToRow omits `id` for a new pack, inserts a SECOND row for the
    // same pack. Two rows, and recomputeItemCost then picks whichever it walks first.
    const { error: costErr } = await recomputeItemCost(sp.inventoryItemId, locationId);
    if (costErr) partial = `Pack saved, but the item cost was NOT updated: ${costErr.message || costErr}`;
  }
  return { data: data ? spFromRow(data) : null, error: null, partial };
};

export const deleteSupplierProduct = async (id, inventoryItemId, locationId = null) => {
  if (isMock || !supabase) return { data: null, error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: null, error: new Error('No locationId') };
  const { data, error } = await supabase.from('supplier_products').delete()
    .eq('location_id', locationId).eq('id', id).select('id');
  const delErr = error || zeroRows('Delete supplier product', data);
  if (!delErr && inventoryItemId) await recomputeItemCost(inventoryItemId, locationId);
  return { data, error: delErr };
};

// ── item unit conversions (cross-dimension bridges) ───────────────────────────
export const upsertItemConversion = async (conv, locationId = null) => {
  if (isMock || !supabase) return { data: null, error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: null, error: new Error('No locationId') };
  const row = {
    ...(conv.id ? { id: conv.id } : {}),
    location_id: locationId, inventory_item_id: conv.inventoryItemId,
    from_qty: Number(conv.fromQty) || 0, from_unit: conv.fromUnit,
    to_qty: Number(conv.toQty) || 0, to_unit: conv.toUnit,
  };
  const { data, error } = await supabase.from('inventory_item_conversions').upsert(row).select().maybeSingle();
  const saveErr = error || noRow('Conversion save', data);
  if (saveErr) return { data: null, error: saveErr };
  let partial = null;
  if (conv.inventoryItemId) {
    // Same rule as supplier products: the bridge DID save, so this is `partial`, not
    // `error` — reporting it as a failure makes the operator re-save and duplicate the row.
    const { error: costErr } = await recomputeItemCost(conv.inventoryItemId, locationId);
    if (costErr) partial = `Bridge saved, but the item cost was NOT updated: ${costErr.message || costErr}`;
  }
  return { data, error: null, partial };
};

export const deleteItemConversion = async (id, inventoryItemId, locationId = null) => {
  if (isMock || !supabase) return { data: null, error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: null, error: new Error('No locationId') };
  const { data, error } = await supabase.from('inventory_item_conversions').delete()
    .eq('location_id', locationId).eq('id', id).select('id');
  const delErr = error || zeroRows('Delete conversion', data);
  if (!delErr && inventoryItemId) await recomputeItemCost(inventoryItemId, locationId);
  return { data, error: delErr };
};

// ── packaging / "units you use" (named packs: Keg, Case, Bottle, glass…) ──────
//
// THE INVARIANT: exactly one format per item may hold is_purchase_default, and one
// is_count_default. There is no unique partial index behind either column yet, and
// PostgREST gives the client no transaction — clear-others and set-this are two
// separate round trips. So the rule here is ORDER + CHECK:
//   • clear first, set second — if the second write is lost the item is left with NO
//     default (readers fall back to the base unit) instead of TWO, where which one
//     wins is whatever the fetch returned first and can differ between devices
//   • never continue past a failed clear — that is the write that creates the duplicate
//   • read back afterwards, because an RLS policy matching zero rows looks exactly
//     like a successful clear
// The buy default decides the pack size and price on every purchase order, which is
// why this is worth three round trips on an operation staff perform once per pack.

/** Confirm exactly one format holds `col` for this item, and that it is `expectedId`. */
async function verifySingleDefault(col, inventoryItemId, expectedId, locationId) {
  const { data, error } = await supabase.from('item_packaging_formats')
    .select('id').eq('location_id', locationId).eq('inventory_item_id', inventoryItemId).eq(col, true);
  if (error) return null;                    // can't verify — don't invent a failure
  const ids = (data || []).map((r) => String(r.id));
  if (ids.length === 1 && ids[0] === String(expectedId)) return null;
  const what = col === 'is_purchase_default' ? 'buy' : 'count';
  return new Error(ids.length === 0
    ? `No ${what} unit is set for this item — the change did not stick.`
    : `${ids.length} units are flagged as the ${what} unit — the previous one was not cleared.`);
}

export const upsertPackagingFormat = async (pack, locationId = null) => {
  if (isMock || !supabase) return { data: null, error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: null, error: new Error('No locationId') };
  // Only one count-default and one purchase-default per item.
  if (pack.inventoryItemId && (pack.isCountDefault || pack.isPurchaseDefault)) {
    const patch = {};
    if (pack.isCountDefault) patch.is_count_default = false;
    if (pack.isPurchaseDefault) patch.is_purchase_default = false;
    let clear = supabase.from('item_packaging_formats').update(patch)
      .eq('location_id', locationId).eq('inventory_item_id', pack.inventoryItemId);
    if (pack.id) clear = clear.neq('id', pack.id);   // leave the row we're about to write
    const { error: clearErr } = await clear.select('id');
    // Refuse the save rather than add a second default on top of the old one.
    if (clearErr) return { data: null, error: clearErr };
  }
  const row = {
    ...(pack.id ? { id: pack.id } : {}),
    location_id: locationId, inventory_item_id: pack.inventoryItemId,
    name: (pack.name || '').trim(), qty_in_base: Number(pack.qtyInBase) || 0,
    parent_format_id: pack.parentFormatId || null,
    is_count_default: pack.isCountDefault === true, is_purchase_default: pack.isPurchaseDefault === true,
  };
  const { data, error } = await supabase.from('item_packaging_formats').upsert(row).select().maybeSingle();
  return { data, error: error || noRow('Unit save', data) };
};

/** Set one format as the count-default or purchase-default (clears the others). */
export const setUnitDefault = async (formatId, inventoryItemId, kind, locationId = null) => {
  if (isMock || !supabase) return { error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { error: new Error('No locationId') };
  // Without the item id the clear below matches nothing, which is precisely how a
  // second default gets created — refuse instead.
  if (!inventoryItemId) return { error: new Error('No inventory item') };
  const col = kind === 'purchase' ? 'is_purchase_default' : 'is_count_default';
  const { error: clearErr } = await supabase.from('item_packaging_formats').update({ [col]: false })
    .eq('location_id', locationId).eq('inventory_item_id', inventoryItemId)
    .neq('id', formatId)                     // don't clear the one we're about to set
    .select('id');                           // (0 rows here is normal — nothing else was flagged)
  if (clearErr) return { error: clearErr };
  const { data, error } = await supabase.from('item_packaging_formats').update({ [col]: true })
    .eq('location_id', locationId).eq('id', formatId).select('id');
  const setErr = error || zeroRows('Default unit', data);
  if (setErr) return { error: setErr };
  return { error: await verifySingleDefault(col, inventoryItemId, formatId, locationId) };
};

export const deletePackagingFormat = async (id, locationId = null) => {
  if (isMock || !supabase) return { data: null, error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: null, error: new Error('No locationId') };
  const { data, error } = await supabase.from('item_packaging_formats').delete()
    .eq('location_id', locationId).eq('id', id).select('id');
  return { data, error: error || zeroRows('Delete unit', data) };
};

// ── stock movements ledger (slice 2) ─────────────────────────────────────────
const MOVEMENT_LABELS = {
  OPENING_BALANCE: 'Opening', PURCHASE_RECEIPT: 'Delivery', SALE_DEPLETION: 'Sale',
  WASTE: 'Waste', STOCK_COUNT_ADJ: 'Count adjust', PRODUCTION_CONSUME: 'Production (used)',
  PRODUCTION_OUTPUT: 'Production (made)', TRANSFER_IN: 'Transfer in', TRANSFER_OUT: 'Transfer out',
  RETURN: 'Return', MANUAL_ADJ: 'Manual adjust',
};
export const movementLabel = (t) => MOVEMENT_LABELS[t] || t;

/** Post one ledger movement (idempotent on idempotencyKey). Returns { data:{id,on_hand,duplicate}, error }. */
export const postStockMovement = async (m, locationId = null) => {
  if (isMock || !supabase) return { data: null, error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: null, error: new Error('No locationId') };
  return supabase.rpc('post_stock_movement', {
    p_location_id: locationId,
    p_inventory_item_id: m.inventoryItemId,
    p_qty_base: Number(m.qtyBase),
    p_movement_type: m.movementType,
    p_unit_cost: m.unitCost == null ? null : Number(m.unitCost),
    p_source_type: m.sourceType || null,
    p_source_id: m.sourceId || null,
    p_idempotency_key: m.idempotencyKey || null,
    p_occurred_at: m.occurredAt || null,
    p_created_by: m.createdBy || null,
    p_notes: m.notes || null,
  });
};

/** Set an item's on-hand to a counted figure (posts the delta as STOCK_COUNT_ADJ). */
export const setInventoryOnHand = async (inventoryItemId, countedQty, notes = null, locationId = null) => {
  if (isMock || !supabase) return { data: null, error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: null, error: new Error('No locationId') };
  return supabase.rpc('set_inventory_on_hand', {
    p_location_id: locationId, p_inventory_item_id: inventoryItemId,
    p_counted_qty: Number(countedQty), p_created_by: null, p_notes: notes,
  });
};

/** Recent movements across ALL items (for the overview feed), newest first. */
export const fetchRecentMovements = async (locationId = null, limit = 15) => {
  if (isMock || !supabase) return { data: [], error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: [], error: null };
  const { data, error } = await supabase.from('stock_movements')
    .select('id, inventory_item_id, qty_base, value_delta, movement_type, occurred_at')
    .eq('location_id', locationId).order('occurred_at', { ascending: false }).limit(limit);
  return {
    data: (data || []).map(r => ({
      id: r.id, inventoryItemId: r.inventory_item_id, qtyBase: Number(r.qty_base),
      valueDelta: r.value_delta == null ? null : Number(r.value_delta), movementType: r.movement_type, occurredAt: r.occurred_at,
    })),
    error,
  };
};

/** All movements in a date range (for stock reports / the gap). */
export const fetchMovementsRange = async (fromIso, toIso, locationId = null, limit = 5000) => {
  if (isMock || !supabase) return { data: [], error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: [], error: null };
  let q = supabase.from('stock_movements')
    .select('id, inventory_item_id, qty_base, value_delta, movement_type, occurred_at')
    .eq('location_id', locationId);
  if (fromIso) q = q.gte('occurred_at', fromIso);
  if (toIso) q = q.lte('occurred_at', toIso);
  const { data, error } = await q.order('occurred_at', { ascending: false }).limit(limit);
  return {
    data: (data || []).map(r => ({
      id: r.id, inventoryItemId: r.inventory_item_id, qtyBase: Number(r.qty_base),
      valueDelta: r.value_delta == null ? null : Number(r.value_delta), movementType: r.movement_type, occurredAt: r.occurred_at,
    })),
    error,
  };
};

/**
 * Average daily usage per item over the last `days`, as { itemId: avgDailyBase }.
 * The WEEKDAY SHAPE of usage — { itemId: [sun..sat avg daily base] } from the
 * stock_usage_by_weekday RPC. Returns data:null (not {}) when the RPC is not yet
 * migrated, so the Order Pad can tell "no shape available, use the flat rate"
 * apart from "profiled, this item just has no usage".
 */
export const fetchUsageByWeekday = async (weeks = 8, locationId = null) => {
  if (isMock || !supabase) return { data: null, error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: null, error: null };
  const { data, error } = await supabase.rpc('stock_usage_by_weekday', { p_location_id: locationId, p_weeks: weeks });
  if (error || !Array.isArray(data)) return { data: null, error: null };   // migration not applied yet — flat fallback
  const prof = {};
  data.forEach(r => {
    const a = (prof[r.inventory_item_id] ??= [0, 0, 0, 0, 0, 0, 0]);
    const d = Number(r.dow); if (d >= 0 && d <= 6) a[d] = Number(r.avg_daily_base) || 0;
  });
  return { data: prof, error: null };
};

/**
 * Prefers the server-side `stock_usage_rates` RPC (aggregates in Postgres, scales
 * to any number of movements); falls back to a client-side aggregate of the
 * movements range if the RPC isn't deployed yet, so the Order Pad works either way.
 */
export const fetchUsageRates = async (days = 28, locationId = null) => {
  if (isMock || !supabase) return { data: {}, error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: {}, error: null };
  const { data: rpcData, error: rpcErr } = await supabase.rpc('stock_usage_rates', { p_location_id: locationId, p_days: days });
  if (!rpcErr && Array.isArray(rpcData)) {
    const rate = {};
    rpcData.forEach(r => { rate[r.inventory_item_id] = Number(r.avg_daily_base) || 0; });
    return { data: rate, error: null };
  }
  // fallback — RPC missing/not yet migrated: aggregate from the movements range.
  const fromIso = new Date(Date.now() - days * 86400000).toISOString();
  const { data: moves } = await fetchMovementsRange(fromIso, null, locationId, 8000);
  const used = {};
  (moves || []).forEach(m => { if (m.movementType === 'SALE_DEPLETION' || m.movementType === 'PRODUCTION_CONSUME') used[m.inventoryItemId] = (used[m.inventoryItemId] || 0) + (-m.qtyBase); });
  const rate = {};
  Object.entries(used).forEach(([id, base]) => { rate[id] = base / days; });
  return { data: rate, error: null };
};

/** Recent movements for one item, newest first (the reconciliation view). */
export const fetchItemMovements = async (inventoryItemId, locationId = null, limit = 100) => {
  if (isMock || !supabase) return { data: [], error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: [], error: null };
  const { data, error } = await supabase.from('stock_movements')
    .select('id, qty_base, unit_cost, value_delta, movement_type, source_type, source_id, occurred_at, notes')
    .eq('location_id', locationId).eq('inventory_item_id', inventoryItemId)
    .order('occurred_at', { ascending: false }).limit(limit);
  return {
    data: (data || []).map(r => ({
      id: r.id, qtyBase: Number(r.qty_base), unitCost: r.unit_cost == null ? null : Number(r.unit_cost),
      valueDelta: r.value_delta == null ? null : Number(r.value_delta), movementType: r.movement_type,
      sourceType: r.source_type, sourceId: r.source_id, occurredAt: r.occurred_at, notes: r.notes,
    })),
    error,
  };
};

/**
 * Recompute a PURCHASED item's current_cost from its supplier products (preferred,
 * else cheapest derived). Appends an effective-dated item_cost_history row and
 * updates inventory_items.current_cost when the cost changes. MADE items derive
 * cost from their recipe (slice 3) and are skipped unless they have supplier
 * products of their own.
 */
export async function recomputeItemCost(itemId, locationId = null) {
  // Callers read `.error`, so a bare { ok:false } reads to them as success. Mock mode is a
  // genuine no-op; the rest are real failures and must carry one — an item hidden by RLS
  // used to come back silent and leave a stale cost behind a clean save toast.
  if (isMock || !supabase) return { ok: true, skipped: true };
  if (!itemId) return { ok: false, error: new Error('no item id') };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { ok: false, error: new Error('no location resolved') };
  const [{ data: itemRows }, { data: sps }, { data: convs }, ratesById] = await Promise.all([
    supabase.from('inventory_items').select('*').eq('location_id', locationId).eq('id', itemId).limit(1),
    supabase.from('supplier_products').select('*').eq('location_id', locationId).eq('inventory_item_id', itemId),
    supabase.from('inventory_item_conversions').select('*').eq('location_id', locationId).eq('inventory_item_id', itemId),
    fetchTaxRateMap(locationId),
  ]);
  const item = itemRows?.[0];
  if (!item) return { ok: false, error: new Error('inventory item not found or not readable') };
  if (!sps || !sps.length) return { ok: true, unchanged: true };
  const bridges = (convs || []).map((c) => ({ fromQty: Number(c.from_qty), fromUnit: c.from_unit, toQty: Number(c.to_qty), toUnit: c.to_unit }));
  // NET pack price per supplier: strip VAT only when the price was entered inc-VAT.
  const netOfSp = (sp) => purchaseNet(Number(sp.pack_price), sp.price_includes_tax === true,
    Number(ratesById[sp.purchase_tax_rate_id || item.purchase_tax_rate_id] || 0));

  let chosen = null, chosenCost = Infinity, chosenNetPack = null;
  for (const sp of sps) {
    let bc; const netPack = netOfSp(sp);
    try {
      bc = packBaseUnitCost({
        packPrice: netPack, packQty: Number(sp.pack_qty), innerQty: Number(sp.inner_qty),
        innerUnit: sp.inner_unit, baseUnit: item.base_unit, itemConversions: bridges,
      }).baseUnitCost;
    } catch { continue; }
    if (sp.is_preferred) { chosen = sp; chosenCost = bc; chosenNetPack = netPack; break; }
    if (bc < chosenCost) { chosen = sp; chosenCost = bc; chosenNetPack = netPack; }
  }
  if (!chosen || !Number.isFinite(chosenCost)) return { ok: true, unchanged: true };

  const prev = item.current_cost == null ? null : Number(item.current_cost);
  const changed = prev == null || Math.abs(prev - chosenCost) > 1e-9;
  if (changed) {
    // These three writes ARE the cost record. Silently losing one leaves the history
    // and inventory_items.current_cost disagreeing, and every recipe cost and PO
    // priced off whichever of the two a screen happens to read. Stop at the first
    // failure and hand the error back instead of half-writing the trail.
    // (No 0-row check on the close: there is legitimately no open row the first time.)
    const { error: closeErr } = await supabase.from('item_cost_history').update({ effective_to: nowIso() })
      .eq('location_id', locationId).eq('inventory_item_id', itemId).is('effective_to', null);
    if (closeErr) return { ok: false, error: closeErr };
    const { error: histErr } = await supabase.from('item_cost_history').insert({
      location_id: locationId, inventory_item_id: itemId, supplier_product_id: chosen.id,
      pack_price: chosenNetPack, base_unit_cost: chosenCost, source: 'CATALOG', effective_from: nowIso(),
    });
    if (histErr) return { ok: false, error: histErr };
    const { data: upd, error: costErr } = await supabase.from('inventory_items')
      .update({ current_cost: chosenCost, updated_at: nowIso() })
      .eq('location_id', locationId).eq('id', itemId).select('id');
    const err = costErr || zeroRows('Item cost update', upd);
    if (err) return { ok: false, error: err };
  }
  return { ok: true, baseUnitCost: chosenCost, changed };
}
