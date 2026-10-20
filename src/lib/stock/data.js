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
 *
 * v5.11.82 (multi site stock Drop 0): every catalogue write is ONE database save function
 * (stock_save_item, stock_save_supplier, stock_save_supplier_item, stock_save_pack,
 * stock_set_pack_default, stock_save_bridge, the stock_archive_* functions, stock_save_cost_rule).
 * Each writes the site row and its company record together and takes the cost step (with a REVALUE
 * when cost moves while stock is held) on the server. Names, arguments and answers stay as they
 * were, so the screens do not change. Until the database has the functions (PGRST202 or 42883)
 * each falls back to today's direct write; that fallback is deleted in Drop 1. A pack, bridge or
 * supplier price that is archived is never offered again (archived_at), and a delete is an archive.
 */

import { supabase, isMock, getLocationId, getActiveLocationSync } from '../supabase';
import { packBaseUnitCost } from './costing.js';
import { purchaseNet } from '../tax.js';
import { readAllPagesResult } from '../pagedRead.js';
import { areasReady, areasReadySync, fetchItemAreas } from './areas.js';
import { DEFAULT_COST_RULE, normCostRule, priceSetsCost, isMissingFunctionError } from './phase0Rules.js';
import { readUsagePages, weekdayProfile, usageRates, weekdayProfileFromDowRows } from './usagePages.js';
import {
  itemFromRow, itemToRow, supplierFromRow, supplierToRow, spFromRow, spToRow, convFromRow, packFromRow, liveOnly,
  itemSaveArgs, supplierSaveArgs, supplierItemSaveArgs, packSaveArgs, bridgeSaveArgs, archiveArgs, versionOf, SECTIONS,
} from './saveRules.js';
import { saveOrDirect, callSave, liveOrAll } from './companyData.js';

/** stock_site_settings is not there yet (20261019b not run): read as the default, never an error. */
const isMissingTableError = (e) => /42P01|PGRST205|relation .* does not exist|Could not find the table/i.test(`${e?.code || ''} ${e?.message || ''}`);

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

// ── mappers ──────────────────────────────────────────────────────────────────
// v5.11.82 (multi site stock Drop 0): the row mappers live in saveRules.js (pure, tested) so the
// save arguments and the rows they come back as can be checked without a database. Each reads
// row_version into rowVersion, and the save functions get it back as p_version.

// ── units ────────────────────────────────────────────────────────────────────
export const fetchStockUnits = async () => {
  if (isMock || !supabase) return { data: [], error: null };
  return supabase.from('stock_units').select('*').order('dimension');
};

// ── inventory items (+ joined conversions & supplier products) ────────────────
/**
 * Fetch all inventory items for a location, each with its conversions[] and
 * supplierProducts[] (with a client-derived baseUnitCost for display), and, once the 16 Oct
 * stock areas migration has run, its use area as `areaId` (null = No area).
 *
 * 16 Oct 2026: the four reads go in pages of 1,000 (lib/pagedRead.js), ordered on a unique key.
 * They asked for everything in one request and PostgREST answers 1,000 rows at most, so a venue
 * over 1,000 items (or 1,000 supplier packs) was silently cut on every stock screen. A failed
 * page is an error, never "no rows".
 */
export const fetchInventoryItems = async (locationId = null) => {
  if (isMock || !supabase) return { data: [], error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: [], error: null };
  // v5.11.67: every table read in pages of 1,000 (lib/pagedRead.js). PostgREST answers at most
  // 1,000 rows a request whatever .limit() asks for and says nothing about the rest, so a venue
  // with 1,200 stock items, or 1,200 supplier packs across its suppliers, silently lost the tail:
  // items missing from every stock screen, packs missing so items showed "no supplier". Each
  // read orders on a unique key so a row cannot land on two pages or fall between them.
  const page = (what, table, order) => readAllPagesResult(what, (first) => {
    let q = supabase.from(table).select('*', first ? { count: 'exact' } : undefined).eq('location_id', locationId);
    for (const col of order) q = q.order(col);
    return q;
  });
  const ready = await areasReady(locationId);
  const [{ data: items, error }, convRes, spRes, packRes, ratesById, areaRes] = await Promise.all([
    page('stock items', 'inventory_items', ['name', 'id']),
    page('unit conversions', 'inventory_item_conversions', ['created_at', 'id']),
    // Ordered, not incidental: readers pick the buy/count default and the preferred
    // supplier with .find(), so an unordered fetch let two devices resolve a different
    // row from the same data and price purchase orders off a different pack size.
    page('supplier packs', 'supplier_products', ['created_at', 'id']),
    page('packaging units', 'item_packaging_formats', ['created_at', 'id']),
    fetchTaxRateMap(locationId),
    ready ? fetchItemAreas(locationId) : Promise.resolve({ data: {}, error: null }),
  ]);
  const err = error || convRes.error || spRes.error || packRes.error || areaRes.error;
  if (err) return { data: [], error: err };
  // v5.11.82 (Drop 0): an archived pack, unit bridge or supplier price is never offered again.
  // (A filter on the rows read, so a database without the column yet reads exactly as before.)
  const convs = liveOnly(convRes.data), sps = liveOnly(spRes.data), packs = liveOnly(packRes.data);
  const itemAreas = areaRes.data || {};
  const convByItem = {};
  (convs || []).forEach((c) => { (convByItem[c.inventory_item_id] ??= []).push(convFromRow(c)); });
  const spByItem = {};
  (sps || []).forEach((s) => { (spByItem[s.inventory_item_id] ??= []).push(spFromRow(s)); });
  const packByItem = {};
  (packs || []).forEach((p) => { (packByItem[p.inventory_item_id] ??= []).push(packFromRow(p)); });
  const mapped = (items || []).map((r) => {
    const it = itemFromRow(r);
    it.areaId = itemAreas[r.id] || null;
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

/**
 * v5.11.82 (Drop 0): the site row a save function wrote, in the shape the direct write's .select()
 * handed back (a raw row), so every caller reads the answer exactly as before.
 */
const siteRowOf = (res, idKey) => res?.site_row || (res?.[idKey] ? { id: res[idKey] } : null);

export const upsertInventoryItem = async (item, locationId = null, opts = {}) => {
  if (isMock || !supabase) return { data: null, error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: null, error: new Error('No locationId') };
  const r = await saveOrDirect(supabase, 'stock_save_item', itemSaveArgs(item, locationId, opts), async () => {
    // maybeSingle() hands back data:null with error:null when nothing came back:
    // a blocked write reads exactly like a save. Report it.
    const { data, error } = await supabase.from('inventory_items').upsert(itemToRow(item, locationId)).select().maybeSingle();
    return { data, error: error || noRow('Item save', data) };
  });
  if (r.via === 'direct') return { data: r.data, error: r.error };
  if (r.error) return { data: null, error: r.error, conflict: r.conflict };
  return { data: siteRowOf(r.data, 'site_item_id'), error: null, queued: r.data?.queued || [] };
};

export const setInventoryItemArchived = async (id, archived, locationId = null, opts = {}) => {
  if (isMock || !supabase) return { data: null, error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: null, error: new Error('No locationId') };
  // The database refuses while a site still holds stock or a live recipe uses the item, in its words.
  const r = await saveOrDirect(supabase, 'stock_archive_item', archiveArgs('p_item', id, archived, opts, SECTIONS.inventory), async () => {
    const { data, error } = await supabase.from('inventory_items')
      .update({ archived_at: archived ? nowIso() : null, updated_at: nowIso() })
      .eq('location_id', locationId).eq('id', id).select('id');
    return { data, error: error || zeroRows(archived ? 'Archive item' : 'Restore item', data) };
  });
  if (r.via === 'direct') return { data: r.data, error: r.error };
  return { data: r.error ? null : [{ id }], error: r.error };
};

// ── suppliers ─────────────────────────────────────────────────────────────────
export const fetchSuppliers = async (locationId = null) => {
  if (isMock || !supabase) return { data: [], error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: [], error: null };
  // v5.11.79: in pages of 1,000 (lib/pagedRead.js), never a silent cut.
  const { data, error } = await readAllPagesResult('suppliers', (first) => supabase.from('suppliers')
    .select('*', first ? { count: 'exact' } : undefined).eq('location_id', locationId).is('archived_at', null).order('name').order('id'));
  return { data: (data || []).map(supplierFromRow), error };
};

/**
 * Save a supplier. v5.11.82 (Drop 0): stock_save_supplier writes every field the Suppliers form has
 * (name, contact, email, phone, account number, payment terms, minimum order, delivery days, cut off,
 * notes) at this venue's row in one call. opts.section names the screen ('purchasing', or
 * 'inventory' for the Stock items quick add).
 */
export const upsertSupplier = async (supplier, locationId = null, opts = {}) => {
  if (isMock || !supabase) return { data: null, error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: null, error: new Error('No locationId') };
  const r = await saveOrDirect(supabase, 'stock_save_supplier', supplierSaveArgs(supplier, locationId, opts), async () => {
    const { data, error } = await supabase.from('suppliers').upsert(supplierToRow(supplier, locationId)).select().maybeSingle();
    return { data: data ? supplierFromRow(data) : null, error: error || noRow('Supplier save', data) };
  });
  if (r.via === 'direct') return { data: r.data, error: r.error };
  if (r.error) return { data: null, error: r.error, conflict: r.conflict };
  const row = siteRowOf(r.data, 'site_supplier_id');
  return { data: row ? supplierFromRow(row) : null, error: null, queued: r.data?.queued || [] };
};

export const setSupplierArchived = async (id, archived, locationId = null, opts = {}) => {
  if (isMock || !supabase) return { data: null, error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: null, error: new Error('No locationId') };
  const r = await saveOrDirect(supabase, 'stock_archive_supplier', archiveArgs('p_supplier', id, archived, opts, SECTIONS.purchasing), async () => {
    const { data, error } = await supabase.from('suppliers').update({ archived_at: archived ? nowIso() : null, updated_at: nowIso() })
      .eq('location_id', locationId).eq('id', id).select('id');
    return { data, error: error || zeroRows(archived ? 'Archive supplier' : 'Restore supplier', data) };
  });
  if (r.via === 'direct') return { data: r.data, error: r.error };
  return { data: r.error ? null : [{ id }], error: r.error };
};

// ── supplier products (the pack→unit cost source) ─────────────────────────────
/** Today's direct write of a supplier pack (only before the database has stock_save_supplier_item). */
async function directSupplierProduct(sp, locationId) {
  // Only one preferred per item: clear others first when this one is preferred.
  // Abort if that clear fails: carrying on would leave TWO preferred suppliers, and
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
    // `error` as "nothing happened" and leave the form populated, so the operator saves
    // again and, because spToRow omits `id` for a new pack, inserts a SECOND row for the
    // same pack. Two rows, and recomputeItemCost then picks whichever it walks first.
    const { error: costErr } = await recomputeItemCost(sp.inventoryItemId, locationId);
    if (costErr) partial = `Pack saved, but the item cost was NOT updated: ${costErr.message || costErr}`;
  }
  return { data: data ? spFromRow(data) : null, error: null, partial };
}

/**
 * Save a supplier pack. v5.11.82 (Drop 0): stock_save_supplier_item writes the pack, the one
 * preferred pack per item and the item's cost in ONE transaction (the cost step runs in the
 * database, with a REVALUE when the cost moves while stock is held), so there is no "pack saved, cost
 * not" half any more and `partial` is null. A busy site catches up within a minute (`queued`).
 */
export const upsertSupplierProduct = async (sp, locationId = null, opts = {}) => {
  if (isMock || !supabase) return { data: null, error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: null, error: new Error('No locationId') };
  const r = await saveOrDirect(supabase, 'stock_save_supplier_item', supplierItemSaveArgs(sp, locationId, opts), () => directSupplierProduct(sp, locationId));
  if (r.via === 'direct') return { data: r.data, error: r.error, partial: r.partial ?? null };
  if (r.error) return { data: null, error: r.error, partial: null, conflict: r.conflict };
  const row = siteRowOf(r.data, 'site_supplier_product_id');
  return { data: row ? spFromRow(row) : null, error: null, partial: null, queued: r.data?.queued || [] };
};

/**
 * Remove a supplier pack. v5.11.82 (Drop 0): an ARCHIVE, never a delete (stock_archive_supplier_item):
 * order lines and the cost history keep the pack they were bought in. The next live pack becomes the
 * preferred one and the cost step runs, in the same transaction.
 */
export const deleteSupplierProduct = async (id, inventoryItemId, locationId = null, opts = {}) => {
  if (isMock || !supabase) return { data: null, error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: null, error: new Error('No locationId') };
  const r = await saveOrDirect(supabase, 'stock_archive_supplier_item', archiveArgs('p_si', id, true, opts, SECTIONS.inventory), async () => {
    const { data, error } = await supabase.from('supplier_products').delete()
      .eq('location_id', locationId).eq('id', id).select('id');
    const delErr = error || zeroRows('Delete supplier product', data);
    if (!delErr && inventoryItemId) await recomputeItemCost(inventoryItemId, locationId);
    return { data, error: delErr };
  });
  if (r.via === 'direct') return { data: r.data, error: r.error };
  return { data: r.error ? null : [{ id }], error: r.error };
};

// ── item unit conversions (cross-dimension bridges) ───────────────────────────
export const upsertItemConversion = async (conv, locationId = null, opts = {}) => {
  if (isMock || !supabase) return { data: null, error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: null, error: new Error('No locationId') };
  // v5.11.82 (Drop 0): stock_save_bridge saves the bridge and re costs the item in one transaction.
  const r = await saveOrDirect(supabase, 'stock_save_bridge', bridgeSaveArgs(conv, locationId, opts), async () => {
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
      // `error`: reporting it as a failure makes the operator re-save and duplicate the row.
      const { error: costErr } = await recomputeItemCost(conv.inventoryItemId, locationId);
      if (costErr) partial = `Bridge saved, but the item cost was NOT updated: ${costErr.message || costErr}`;
    }
    return { data, error: null, partial };
  });
  if (r.via === 'direct') return { data: r.data, error: r.error, partial: r.partial ?? null };
  if (r.error) return { data: null, error: r.error, partial: null, conflict: r.conflict };
  return { data: siteRowOf(r.data, 'site_bridge_id'), error: null, partial: null, queued: r.data?.queued || [] };
};

/** v5.11.82 (Drop 0): an archive (stock_archive_bridge), refused while a recipe or a supplier pack needs it. */
export const deleteItemConversion = async (id, inventoryItemId, locationId = null, opts = {}) => {
  if (isMock || !supabase) return { data: null, error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: null, error: new Error('No locationId') };
  const r = await saveOrDirect(supabase, 'stock_archive_bridge', archiveArgs('p_bridge', id, true, opts, SECTIONS.inventory), async () => {
    const { data, error } = await supabase.from('inventory_item_conversions').delete()
      .eq('location_id', locationId).eq('id', id).select('id');
    const delErr = error || zeroRows('Delete conversion', data);
    if (!delErr && inventoryItemId) await recomputeItemCost(inventoryItemId, locationId);
    return { data, error: delErr };
  });
  if (r.via === 'direct') return { data: r.data, error: r.error };
  return { data: r.error ? null : [{ id }], error: r.error };
};

// ── packaging / "units you use" (named packs: Keg, Case, Bottle, glass…) ──────
//
// THE INVARIANT: exactly one format per item may hold is_purchase_default, and one
// is_count_default. v5.11.82 (Drop 0): stock_save_pack and stock_set_pack_default keep it in ONE
// database transaction. The direct path below runs only before the database has them, and keeps
// today's rule there: there is no unique partial index behind either column, and PostgREST gives
// the client no transaction (clear-others and set-this are two round trips), so it is ORDER + CHECK:
//   • clear first, set second: if the second write is lost the item is left with NO
//     default (readers fall back to the base unit) instead of TWO, where which one
//     wins is whatever the fetch returned first and can differ between devices
//   • never continue past a failed clear: that is the write that creates the duplicate
//   • read back afterwards, because an RLS policy matching zero rows looks exactly
//     like a successful clear
// The buy default decides the pack size and price on every purchase order, which is
// why this is worth three round trips on an operation staff perform once per pack.

/** Confirm exactly one format holds `col` for this item, and that it is `expectedId`. */
async function verifySingleDefault(col, inventoryItemId, expectedId, locationId) {
  const { data, error } = await supabase.from('item_packaging_formats')
    .select('id').eq('location_id', locationId).eq('inventory_item_id', inventoryItemId).eq(col, true);
  if (error) return null;                    // can't verify: don't invent a failure
  const ids = (data || []).map((r) => String(r.id));
  if (ids.length === 1 && ids[0] === String(expectedId)) return null;
  const what = col === 'is_purchase_default' ? 'buy' : 'count';
  return new Error(ids.length === 0
    ? `No ${what} unit is set for this item: the change did not stick.`
    : `${ids.length} units are flagged as the ${what} unit: the previous one was not cleared.`);
}

export const upsertPackagingFormat = async (pack, locationId = null, opts = {}) => {
  if (isMock || !supabase) return { data: null, error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: null, error: new Error('No locationId') };
  const r = await saveOrDirect(supabase, 'stock_save_pack', packSaveArgs(pack, locationId, opts), async () => {
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
  });
  if (r.via === 'direct') return { data: r.data, error: r.error };
  if (r.error) return { data: null, error: r.error, conflict: r.conflict };
  return { data: siteRowOf(r.data, 'site_pack_id'), error: null, queued: r.data?.queued || [] };
};

/** Set one format as the count-default or purchase-default (clears the others). */
export const setUnitDefault = async (formatId, inventoryItemId, kind, locationId = null, opts = {}) => {
  if (isMock || !supabase) return { error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { error: new Error('No locationId') };
  // Without the item id the clear below matches nothing, which is precisely how a
  // second default gets created: refuse instead.
  if (!inventoryItemId) return { error: new Error('No inventory item') };
  const col = kind === 'purchase' ? 'is_purchase_default' : 'is_count_default';
  const r = await saveOrDirect(supabase, 'stock_set_pack_default', {
    p_pack: formatId, p_which: kind === 'purchase' ? 'purchase' : 'count',
    p_version: versionOf(opts.version), p_section: opts.section || SECTIONS.inventory,
  }, async () => {
    const { error: clearErr } = await supabase.from('item_packaging_formats').update({ [col]: false })
      .eq('location_id', locationId).eq('inventory_item_id', inventoryItemId)
      .neq('id', formatId)                     // don't clear the one we're about to set
      .select('id');                           // (0 rows here is normal: nothing else was flagged)
    if (clearErr) return { error: clearErr };
    const { data, error } = await supabase.from('item_packaging_formats').update({ [col]: true })
      .eq('location_id', locationId).eq('id', formatId).select('id');
    const setErr = error || zeroRows('Default unit', data);
    if (setErr) return { error: setErr };
    return { error: await verifySingleDefault(col, inventoryItemId, formatId, locationId) };
  });
  return { error: r.error || null };
};

/**
 * Remove a unit. v5.11.82 (Drop 0): an archive (stock_archive_pack), refused while a recipe line uses
 * the pack, in the database's own words ("This pack is used in a recipe ...").
 */
export const deletePackagingFormat = async (id, locationId = null, opts = {}) => {
  if (isMock || !supabase) return { data: null, error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: null, error: new Error('No locationId') };
  const r = await saveOrDirect(supabase, 'stock_archive_pack', archiveArgs('p_pack', id, true, opts, SECTIONS.inventory), async () => {
    const { data, error } = await supabase.from('item_packaging_formats').delete()
      .eq('location_id', locationId).eq('id', id).select('id');
    return { data, error: error || zeroRows('Delete unit', data) };
  });
  if (r.via === 'direct') return { data: r.data, error: r.error };
  return { data: r.error ? null : [{ id }], error: r.error };
};

// ── stock movements ledger (slice 2) ─────────────────────────────────────────
const MOVEMENT_LABELS = {
  OPENING_BALANCE: 'Opening', PURCHASE_RECEIPT: 'Delivery', SALE_DEPLETION: 'Sale',
  WASTE: 'Waste', STOCK_COUNT_ADJ: 'Count adjust', PRODUCTION_CONSUME: 'Production (used)',
  PRODUCTION_OUTPUT: 'Production (made)', TRANSFER_IN: 'Transfer in', TRANSFER_OUT: 'Transfer out',
  RETURN: 'Return', MANUAL_ADJ: 'Manual adjust',
};
export const movementLabel = (t) => MOVEMENT_LABELS[t] || t;

/**
 * Post one ledger movement (idempotent on idempotencyKey). Returns { data:{id,on_hand,duplicate,area_id,area_on_hand}, error }.
 * 16 Oct 2026: `areaId` names the area the movement touches (a count line, a chosen delivery
 * area). It is sent ONLY when the stock areas migration is known to have run: the 11 argument
 * function refuses an unknown argument name (PGRST202) and the movement would be lost. With no
 * areaId the database works the area out itself (the receiving area for a delivery, else the
 * item's use area), so every caller that does not know about areas keeps working as it did.
 */
export const postStockMovement = async (m, locationId = null) => {
  if (isMock || !supabase) return { data: null, error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: null, error: new Error('No locationId') };
  const args = {
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
  };
  if (m.areaId && areasReadySync() === true) args.p_area_id = m.areaId;
  return supabase.rpc('post_stock_movement', args);
};

/**
 * v5.11.77 central stock depletion (migration 20261018c). Which path takes stock off at this venue:
 * 'browser' (the till, as before), 'central' (the database books every check) or 'paused'.
 * A missing RPC (migration not run), a refused call or any error reads as 'browser' in
 * centralMode.modeFromRpc, so nothing changes until the venue is switched on.
 */
export const fetchStockVenueMode = async (locationId = null) => {
  if (isMock || !supabase) return { data: 'browser', error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: null, error: new Error('No locationId') };
  return supabase.rpc('stock_venue_mode', { p_location_id: locationId });
};

/**
 * The central depletion backlog for the Back Office stock screens: mode, pending, oldest pending
 * age (s), held, dead, done in 24 h, last drain run, and the rows that need a person.
 */
export const fetchStockOutboxHealth = async (locationId = null) => {
  if (isMock || !supabase) return { data: null, error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: null, error: new Error('No locationId') };
  return supabase.rpc('stock_outbox_health', { p_location_id: locationId });
};

/**
 * v5.11.79 (stock plan Phase 0): the Multi site menu's read only warning rows, one per site at most:
 * { location_id, site_name, missing, from_location_id, from_site_name, from_count } for "12 products
 * have a recipe at Provo but none at Location 2" (msm_stock_recipe_gaps, 20261019b). Before the
 * migration the call is missing and the screen shows nothing.
 */
export const fetchMsmRecipeGaps = async (menuId) => {
  if (isMock || !supabase || !menuId) return { data: [], error: null };
  return supabase.rpc('msm_stock_recipe_gaps', { p_menu: menuId });
};

/** A Back Office login releases a held or dead outbox row: it posts on the next drain. */
export const releaseStockOutbox = async (id) => {
  if (isMock || !supabase) return { data: { ok: false, error: 'offline' }, error: null };
  return supabase.rpc('stock_outbox_release', { p_id: Number(id) });
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
// 5 Oct 2026: every movement of the range, in pages of 1,000 (lib/pagedRead.js). It asked for
// 5,000 (8,000 for the usage rate) in one request and the API answers 1,000 at most, newest
// first, so a busy period lost its oldest movements without a word. On the ceiling or a
// failed page: { data: [], error, tooMany }.
export const fetchMovementsRange = async (fromIso, toIso, locationId = null, opts = {}) => {
  if (isMock || !supabase) return { data: [], error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: [], error: null };
  const o = (opts && typeof opts === 'object') ? opts : {};
  const { data, error, tooMany } = await readAllPagesResult('stock movements', (first) => {
    let q = supabase.from('stock_movements')
      .select('id, inventory_item_id, qty_base, value_delta, movement_type, occurred_at', first ? { count: 'exact' } : undefined)
      .eq('location_id', locationId);
    if (fromIso) q = q.gte('occurred_at', fromIso);
    if (toIso) q = q.lte('occurred_at', toIso);
    return q.order('occurred_at', { ascending: false }).order('id', { ascending: false });
  }, { onProgress: o.onProgress, stop: o.stop });
  if (error) return { data: [], error, tooMany: !!tooMany };
  return {
    data: (data || []).map(r => ({
      id: r.id, inventoryItemId: r.inventory_item_id, qtyBase: Number(r.qty_base),
      valueDelta: r.value_delta == null ? null : Number(r.value_delta), movementType: r.movement_type, occurredAt: r.occurred_at,
    })),
    error,
  };
};

/**
 * The WEEKDAY SHAPE of usage: { itemId: [sun..sat avg daily base] }. Returns data:null (not {})
 * when no shape is available, so the Order Pad can tell "no shape, use the flat rate" apart from
 * "profiled, this item just has no usage".
 * v5.11.79 (20261019b): read from stock_usage_weekday_page, one row per item, 1,000 items a page,
 * on the venue's own clock (usagePages.js). The old one row per item and day read was cut at 1,000
 * rows, so items and days went missing as 0. A failed page gives no shape at all (never a partial
 * one); before 20261019b the old read runs.
 */
export const fetchUsageByWeekday = async (weeks = 8, locationId = null) => {
  if (isMock || !supabase) return { data: null, error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: null, error: null };
  const paged = await readUsagePages((after) => supabase.rpc('stock_usage_weekday_page', { p_location_id: locationId, p_weeks: weeks, p_after: after }),
    { isMissing: isMissingFunctionError });
  if (!paged.error) return { data: weekdayProfile(paged.rows), error: null };
  if (!paged.missing) {
    console.warn('[stock] weekday usage read failed, using the flat rate:', paged.error?.message || paged.error);
    return { data: null, error: paged.error };
  }
  const { data, error } = await supabase.rpc('stock_usage_by_weekday', { p_location_id: locationId, p_weeks: weeks });
  if (error || !Array.isArray(data)) return { data: null, error: null };   // migration not applied yet — flat fallback
  return { data: weekdayProfileFromDowRows(data), error: null };
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
  // v5.11.79 (20261019b): one row per item, 1,000 items a page (the old read was cut at 1,000 rows).
  const paged = await readUsagePages((after) => supabase.rpc('stock_usage_rates_page', { p_location_id: locationId, p_days: days, p_after: after }),
    { isMissing: isMissingFunctionError });
  if (!paged.error) return { data: usageRates(paged.rows), error: null };
  if (!paged.missing) return { data: {}, error: paged.error };
  const { data: rpcData, error: rpcErr } = await supabase.rpc('stock_usage_rates', { p_location_id: locationId, p_days: days });
  if (!rpcErr && Array.isArray(rpcData)) {
    const rate = {};
    rpcData.forEach(r => { rate[r.inventory_item_id] = Number(r.avg_daily_base) || 0; });
    return { data: rate, error: null };
  }
  // fallback — RPC missing/not yet migrated: aggregate from the movements range.
  const fromIso = new Date(Date.now() - days * 86400000).toISOString();
  const { data: moves } = await fetchMovementsRange(fromIso, null, locationId);
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
 * v5.11.79 (stock plan Phase 0, 4.5, decision 2): each venue's cost rule. 'price_list' (the default,
 * and the answer whenever nothing is stored: exactly what every venue did before) or 'deliveries'.
 * v5.11.82 (Drop 0): read through stock_cost_rule, which answers the site's override, else the
 * company's rule (a one site company: its own), else the price list. Before the database has the
 * function the stock_site_settings row is read as before.
 */
export const fetchCostRule = async (locationId = null) => {
  if (isMock || !supabase) return { data: DEFAULT_COST_RULE, error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: DEFAULT_COST_RULE, error: null };
  const r = await callSave(supabase, 'stock_cost_rule', { p_location_id: locationId });
  if (!r.missing) return { data: r.error ? DEFAULT_COST_RULE : normCostRule(r.data), error: r.error || null };
  const { data, error } = await supabase.from('stock_site_settings').select('cost_rule').eq('location_id', locationId).maybeSingle();
  if (error) return { data: DEFAULT_COST_RULE, error: isMissingTableError(error) ? null : error };
  return { data: normCostRule(data?.cost_rule), error: null };
};

/**
 * Save the venue's cost rule. v5.11.82 (Drop 0): stock_save_cost_rule saves the company rule (for a
 * one site company that is the site's rule, and any Back Office login of the venue may change it,
 * as today). Before the database has it: the stock_site_settings row, as before.
 */
export const saveCostRule = async (rule, byName = null, locationId = null) => {
  if (isMock || !supabase) return { data: null, error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: null, error: new Error('No locationId') };
  const r = await saveOrDirect(supabase, 'stock_save_cost_rule', {
    p_org: null, p_rule: normCostRule(rule), p_override_location: null, p_location: locationId,
  }, async () => {
    const { data, error } = await supabase.from('stock_site_settings')
      .upsert({ location_id: locationId, cost_rule: normCostRule(rule), updated_at: nowIso(), updated_by_name: byName || null })
      .select('location_id');
    return { data, error: error || zeroRows('Cost rule save', data) };
  });
  if (r.via === 'direct') return { data: r.data, error: r.error };
  return { data: r.error ? null : [{ location_id: locationId }], error: r.error };
};

/**
 * Recompute a PURCHASED item's current_cost from its supplier products (preferred,
 * else cheapest derived). Appends an effective-dated item_cost_history row and
 * updates inventory_items.current_cost when the cost changes. MADE items derive
 * cost from their recipe (slice 3) and are skipped unless they have supplier
 * products of their own.
 * v5.11.82 (Drop 0): the fallback of the direct writes only. With the save functions installed the
 * cost step runs inside the database (and writes a REVALUE); this leaves the browser in Drop 1.
 */
export async function recomputeItemCost(itemId, locationId = null) {
  // Callers read `.error`, so a bare { ok:false } reads to them as success. Mock mode is a
  // genuine no-op; the rest are real failures and must carry one — an item hidden by RLS
  // used to come back silent and leave a stale cost behind a clean save toast.
  if (isMock || !supabase) return { ok: true, skipped: true };
  if (!itemId) return { ok: false, error: new Error('no item id') };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { ok: false, error: new Error('no location resolved') };
  // v5.11.82 (Drop 0): only LIVE supplier prices and unit bridges (archived ones are never offered).
  const liveRead = (table) => liveOrAll((live) => {
    const q = supabase.from(table).select('*').eq('location_id', locationId).eq('inventory_item_id', itemId);
    return live ? q.is('archived_at', null) : q;
  });
  const [{ data: itemRows }, { data: sps }, { data: convs }, ratesById] = await Promise.all([
    supabase.from('inventory_items').select('*').eq('location_id', locationId).eq('id', itemId).limit(1),
    liveRead('supplier_products'),
    liveRead('inventory_item_conversions'),
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
  // v5.11.79: the venue's cost rule. Price list (default): the price sets the cost, as before.
  // Deliveries: the price only sets the cost of an item never received or with no cost yet.
  const { data: rule } = await fetchCostRule(locationId);
  if (normCostRule(rule) === 'deliveries') {
    const { data: rec } = await supabase.from('stock_movements').select('id')
      .eq('location_id', locationId).eq('inventory_item_id', itemId).eq('movement_type', 'PURCHASE_RECEIPT').limit(1);
    if (!priceSetsCost({ rule, newCost: chosenCost, currentCost: prev, everReceived: (rec || []).length > 0 })) {
      return { ok: true, unchanged: true, rule: 'deliveries' };
    }
  }
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
