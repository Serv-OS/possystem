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

const nowIso = () => new Date().toISOString();

/** Resolve a usable locationId or null (never loc-demo). */
async function ensureLoc(locationId) {
  if (!locationId || locationId === 'loc-demo') locationId = getActiveLocationSync();
  if (!locationId || locationId === 'loc-demo') locationId = await getLocationId().catch(() => null);
  if (!locationId || locationId === 'loc-demo') return null;
  return locationId;
}

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
});
const spToRow = (sp, locationId) => ({
  ...(sp.id ? { id: sp.id } : {}),
  location_id: locationId, inventory_item_id: sp.inventoryItemId, supplier_id: sp.supplierId,
  supplier_sku: sp.supplierSku || null, pack_description: sp.packDescription || null,
  pack_qty: Number(sp.packQty) || 1, inner_qty: Number(sp.innerQty) || 1, inner_unit: sp.innerUnit || 'each',
  pack_price: Number(sp.packPrice) || 0, is_preferred: sp.isPreferred === true, updated_at: nowIso(),
});

const convFromRow = (r) => ({
  id: r.id, inventoryItemId: r.inventory_item_id,
  fromQty: Number(r.from_qty), fromUnit: r.from_unit, toQty: Number(r.to_qty), toUnit: r.to_unit,
});

const packFromRow = (r) => ({
  id: r.id, inventoryItemId: r.inventory_item_id, name: r.name,
  qtyInBase: Number(r.qty_in_base), parentFormatId: r.parent_format_id,
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
  const [{ data: items, error }, { data: convs }, { data: sps }, { data: packs }] = await Promise.all([
    supabase.from('inventory_items').select('*').eq('location_id', locationId).order('name'),
    supabase.from('inventory_item_conversions').select('*').eq('location_id', locationId),
    supabase.from('supplier_products').select('*').eq('location_id', locationId),
    supabase.from('item_packaging_formats').select('*').eq('location_id', locationId),
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
      let baseUnitCost = null;
      try {
        baseUnitCost = packBaseUnitCost({
          packPrice: sp.packPrice, packQty: sp.packQty, innerQty: sp.innerQty,
          innerUnit: sp.innerUnit, baseUnit: it.baseUnit, itemConversions: bridges,
        }).baseUnitCost;
      } catch { /* unit bridge missing — surfaced in UI */ }
      return { ...sp, baseUnitCost };
    });
    return it;
  });
  return { data: mapped, error: null };
};

export const upsertInventoryItem = async (item, locationId = null) => {
  if (isMock || !supabase) return { data: null, error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: null, error: new Error('No locationId') };
  return supabase.from('inventory_items').upsert(itemToRow(item, locationId)).select().maybeSingle();
};

export const setInventoryItemArchived = async (id, archived, locationId = null) => {
  if (isMock || !supabase) return { data: null, error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: null, error: new Error('No locationId') };
  return supabase.from('inventory_items')
    .update({ archived_at: archived ? nowIso() : null, updated_at: nowIso() })
    .eq('location_id', locationId).eq('id', id);
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
  return { data: data ? supplierFromRow(data) : null, error };
};

export const setSupplierArchived = async (id, archived, locationId = null) => {
  if (isMock || !supabase) return { data: null, error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: null, error: new Error('No locationId') };
  return supabase.from('suppliers').update({ archived_at: archived ? nowIso() : null, updated_at: nowIso() })
    .eq('location_id', locationId).eq('id', id);
};

// ── supplier products (the pack→unit cost source) ─────────────────────────────
export const upsertSupplierProduct = async (sp, locationId = null) => {
  if (isMock || !supabase) return { data: null, error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: null, error: new Error('No locationId') };
  // Only one preferred per item: clear others first when this one is preferred.
  if (sp.isPreferred && sp.inventoryItemId) {
    await supabase.from('supplier_products').update({ is_preferred: false })
      .eq('location_id', locationId).eq('inventory_item_id', sp.inventoryItemId);
  }
  const { data, error } = await supabase.from('supplier_products').upsert(spToRow(sp, locationId)).select().maybeSingle();
  if (!error && sp.inventoryItemId) await recomputeItemCost(sp.inventoryItemId, locationId);
  return { data: data ? spFromRow(data) : null, error };
};

export const deleteSupplierProduct = async (id, inventoryItemId, locationId = null) => {
  if (isMock || !supabase) return { data: null, error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: null, error: new Error('No locationId') };
  const res = await supabase.from('supplier_products').delete().eq('location_id', locationId).eq('id', id);
  if (!res.error && inventoryItemId) await recomputeItemCost(inventoryItemId, locationId);
  return res;
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
  const res = await supabase.from('inventory_item_conversions').upsert(row).select().maybeSingle();
  if (!res.error && conv.inventoryItemId) await recomputeItemCost(conv.inventoryItemId, locationId);
  return res;
};

export const deleteItemConversion = async (id, inventoryItemId, locationId = null) => {
  if (isMock || !supabase) return { data: null, error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: null, error: new Error('No locationId') };
  const res = await supabase.from('inventory_item_conversions').delete().eq('location_id', locationId).eq('id', id);
  if (!res.error && inventoryItemId) await recomputeItemCost(inventoryItemId, locationId);
  return res;
};

// ── packaging formats (pack-of-packs) ────────────────────────────────────────
export const upsertPackagingFormat = async (pack, locationId = null) => {
  if (isMock || !supabase) return { data: null, error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: null, error: new Error('No locationId') };
  const row = {
    ...(pack.id ? { id: pack.id } : {}),
    location_id: locationId, inventory_item_id: pack.inventoryItemId,
    name: (pack.name || '').trim(), qty_in_base: Number(pack.qtyInBase) || 0,
    parent_format_id: pack.parentFormatId || null,
  };
  return supabase.from('item_packaging_formats').upsert(row).select().maybeSingle();
};

export const deletePackagingFormat = async (id, locationId = null) => {
  if (isMock || !supabase) return { data: null, error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: null, error: new Error('No locationId') };
  return supabase.from('item_packaging_formats').delete().eq('location_id', locationId).eq('id', id);
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
  if (isMock || !supabase || !itemId) return { ok: false };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { ok: false };
  const [{ data: itemRows }, { data: sps }, { data: convs }] = await Promise.all([
    supabase.from('inventory_items').select('*').eq('location_id', locationId).eq('id', itemId).limit(1),
    supabase.from('supplier_products').select('*').eq('location_id', locationId).eq('inventory_item_id', itemId),
    supabase.from('inventory_item_conversions').select('*').eq('location_id', locationId).eq('inventory_item_id', itemId),
  ]);
  const item = itemRows?.[0];
  if (!item) return { ok: false };
  if (!sps || !sps.length) return { ok: true, unchanged: true };
  const bridges = (convs || []).map((c) => ({ fromQty: Number(c.from_qty), fromUnit: c.from_unit, toQty: Number(c.to_qty), toUnit: c.to_unit }));

  let chosen = null, chosenCost = Infinity;
  for (const sp of sps) {
    let bc;
    try {
      bc = packBaseUnitCost({
        packPrice: Number(sp.pack_price), packQty: Number(sp.pack_qty), innerQty: Number(sp.inner_qty),
        innerUnit: sp.inner_unit, baseUnit: item.base_unit, itemConversions: bridges,
      }).baseUnitCost;
    } catch { continue; }
    if (sp.is_preferred) { chosen = sp; chosenCost = bc; break; }
    if (bc < chosenCost) { chosen = sp; chosenCost = bc; }
  }
  if (!chosen || !Number.isFinite(chosenCost)) return { ok: true, unchanged: true };

  const prev = item.current_cost == null ? null : Number(item.current_cost);
  const changed = prev == null || Math.abs(prev - chosenCost) > 1e-9;
  if (changed) {
    await supabase.from('item_cost_history').update({ effective_to: nowIso() })
      .eq('location_id', locationId).eq('inventory_item_id', itemId).is('effective_to', null);
    await supabase.from('item_cost_history').insert({
      location_id: locationId, inventory_item_id: itemId, supplier_product_id: chosen.id,
      pack_price: Number(chosen.pack_price), base_unit_cost: chosenCost, source: 'CATALOG', effective_from: nowIso(),
    });
    await supabase.from('inventory_items').update({ current_cost: chosenCost, updated_at: nowIso() })
      .eq('location_id', locationId).eq('id', itemId);
  }
  return { ok: true, baseUnitCost: chosenCost, changed };
}
