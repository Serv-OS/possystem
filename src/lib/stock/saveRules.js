/**
 * stock/saveRules.js: the stock catalogue's row shapes and the save function arguments built from
 * them (v5.11.84, multi site stock Drop 0). Pure: no React, no Supabase, so node --test drives it
 * (saveRules.test.js, saveContract.test.js).
 *
 * Drop 0 moves every catalogue write in the browser to one database save function each
 * (stock_save_item, stock_save_supplier, stock_save_supplier_item, stock_save_pack,
 * stock_save_bridge, stock_save_recipe, stock_save_item_site and the archive functions). The
 * screens do not change: data.js, recipes.js, counts.js and areas.js keep their names, arguments
 * and answers, and only their bodies change. The argument shapes are fixed in the Drop 0 contract
 * (section 3.4): a key the database does not know is refused, so these builders send exactly the
 * listed keys, the site form of every id (site_item_id and so on, never both forms for one field),
 * never org_id, on_hand or current_cost.
 *
 * Versions: every mapper reads row_version into rowVersion and every builder sends it back as
 * p_version for an existing record. In Drop 0 a missing version means "no check" in the database.
 *
 * The row mappers moved here from data.js unchanged (plus rowVersion, companyRef and archivedAt),
 * so the round trip "form, save arguments, saved row, form" can be tested without a database.
 */

import { normDeliveryDays } from './purchasingRules.js';

/** The words a screen shows when the database does not have a function this build needs yet. */
export const NEEDS_UPDATE = 'This needs a database update. Ask ServOS to run it.';

/** Back Office section keys a save names (lib/boSections.js keys; the database checks them too). */
export const SECTIONS = Object.freeze({ inventory: 'inventory', produce: 'produce', purchasing: 'purchasing' });

const nowIso = () => new Date().toISOString();
const num = (v) => (v === '' || v == null ? null : Number(v));
const intOrNull = (v) => (v == null || v === '' ? null : Number(v));

/** A stored row_version as a positive whole number, or null (no version known: no check in Drop 0). */
export function versionOf(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * True when the error says a column is not there yet (archived_at or row_version before 0a). A paged
 * read wraps the database error ("Could not read ...") and keeps it as `cause`: both are read.
 */
export function isMissingColumnError(error, column = null) {
  if (!error) return false;
  const c = error.cause && typeof error.cause === 'object' ? error.cause : {};
  const msg = `${error.code || ''} ${error.message || ''} ${error.details || ''} ${c.code || ''} ${c.message || ''}`;
  const named = !column || msg.includes(column);
  if (/PGRST204|42703/.test(msg)) return named;
  return /column .* does not exist|could not find the .* column/i.test(msg) && named;
}

/**
 * A save function's answer that is not a success: { ok: false, conflict } (someone saved first) or
 * any other { ok: false, error }. Returns an Error carrying the database's own words, or null.
 */
export function saveRefusal(data) {
  if (!data || typeof data !== 'object' || data.ok !== false) return null;
  const words = data.error || (data.conflict
    ? 'Someone else saved this first. Reload to see the change, then save again.'
    : 'It did not save. Try again.');
  const err = new Error(String(words));
  err.code = data.conflict ? 'conflict' : (data.code || 'refused');
  if (data.conflict) err.conflict = data.conflict;
  return err;
}

// ── row mappers (moved from data.js) ─────────────────────────────────────────────────────────────
export const itemFromRow = (r) => ({
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
  // v5.11.84 (Drop 0): the version the save sends back, and the company record behind this row
  rowVersion: versionOf(r.row_version), companyRef: r.company_ref || null,
});
/** The direct write of today (only when the database has no stock_save_item yet). */
export const itemToRow = (i, locationId) => ({
  ...(i.id ? { id: i.id } : {}),
  location_id: locationId, org_id: i.orgId || null,
  name: (i.name || '').trim(), kind: i.kind === 'MADE' ? 'MADE' : 'PURCHASED',
  base_unit: i.baseUnit || 'each', accounting_group: i.accountingGroup || null,
  category: i.category || null, is_tracked: i.isTracked !== false, is_sellable: i.isSellable === true,
  // v5.11.79 (stock plan Phase 0, 4.5): the item screen NEVER writes current_cost. It held the cost it
  // read when the sheet opened, so a delivery received while it was open was written back over with
  // the old figure. Cost moves only through deliveries, the price list rule (recomputeItemCost), an
  // opening count, transfers and production, each on the server or from fresh rows.
  cost_method: i.costMethod || 'MOVING_AVG',
  allergens: Array.isArray(i.allergens) ? i.allergens : [],
  shelf_life_days: i.shelfLifeDays == null || i.shelfLifeDays === '' ? null : Number(i.shelfLifeDays),
  storage_location: i.storageLocation || null, default_supplier_id: i.defaultSupplierId || null,
  sku: i.sku || null, barcode: i.barcode || null, notes: i.notes || null,
  purchase_tax_rate_id: i.purchaseTaxRateId || null,
  updated_at: nowIso(),
});

export const supplierFromRow = (r) => ({
  id: r.id, locationId: r.location_id, orgId: r.org_id, name: r.name, contactName: r.contact_name,
  email: r.email, phone: r.phone, accountNumber: r.account_number,
  paymentTermsDays: r.payment_terms_days, minOrderValue: r.min_order_value == null ? null : Number(r.min_order_value),
  // v5.11.65: days stored as numbers (1 = Mon .. 7 = Sun, the seed wrote [1,2,3,4,5,6]) read as the
  // names the Suppliers editor and the Order pad compare, so every venue's schedule is understood.
  deliveryDays: normDeliveryDays(r.delivery_days), cutoffTime: r.cutoff_time,
  notes: r.notes, archivedAt: r.archived_at,
  rowVersion: versionOf(r.row_version), companyRef: r.company_ref || null,
});
export const supplierToRow = (s, locationId) => ({
  ...(s.id ? { id: s.id } : {}),
  location_id: locationId, org_id: s.orgId || null, name: (s.name || '').trim(),
  contact_name: s.contactName || null, email: s.email || null, phone: s.phone || null,
  account_number: s.accountNumber || null,
  payment_terms_days: s.paymentTermsDays == null || s.paymentTermsDays === '' ? null : Number(s.paymentTermsDays),
  min_order_value: num(s.minOrderValue), delivery_days: normDeliveryDays(s.deliveryDays),
  cutoff_time: s.cutoffTime || null, notes: s.notes || null, updated_at: nowIso(),
});

export const spFromRow = (r) => ({
  id: r.id, locationId: r.location_id, inventoryItemId: r.inventory_item_id, supplierId: r.supplier_id,
  supplierSku: r.supplier_sku, packDescription: r.pack_description,
  packQty: Number(r.pack_qty), innerQty: Number(r.inner_qty), innerUnit: r.inner_unit,
  packPrice: Number(r.pack_price), isPreferred: r.is_preferred === true,
  purchaseTaxRateId: r.purchase_tax_rate_id || null, priceIncludesTax: r.price_includes_tax === true,
  rowVersion: versionOf(r.row_version), companyRef: r.company_ref || null, archivedAt: r.archived_at || null,
});
export const spToRow = (sp, locationId) => ({
  ...(sp.id ? { id: sp.id } : {}),
  location_id: locationId, inventory_item_id: sp.inventoryItemId, supplier_id: sp.supplierId,
  supplier_sku: sp.supplierSku || null, pack_description: sp.packDescription || null,
  pack_qty: Number(sp.packQty) || 1, inner_qty: Number(sp.innerQty) || 1, inner_unit: sp.innerUnit || 'each',
  pack_price: Number(sp.packPrice) || 0, is_preferred: sp.isPreferred === true,
  purchase_tax_rate_id: sp.purchaseTaxRateId || null, price_includes_tax: sp.priceIncludesTax === true,
  updated_at: nowIso(),
});

export const convFromRow = (r) => ({
  id: r.id, inventoryItemId: r.inventory_item_id,
  fromQty: Number(r.from_qty), fromUnit: r.from_unit, toQty: Number(r.to_qty), toUnit: r.to_unit,
  rowVersion: versionOf(r.row_version), companyRef: r.company_ref || null, archivedAt: r.archived_at || null,
});

export const packFromRow = (r) => ({
  id: r.id, inventoryItemId: r.inventory_item_id, name: r.name,
  qtyInBase: Number(r.qty_in_base), parentFormatId: r.parent_format_id,
  isCountDefault: r.is_count_default === true, isPurchaseDefault: r.is_purchase_default === true,
  rowVersion: versionOf(r.row_version), companyRef: r.company_ref || null, archivedAt: r.archived_at || null,
});

/** Rows a chooser may offer: never one archived (archived_at is set by the archive functions). */
export const liveOnly = (rows) => (rows || []).filter((r) => r && !r.archived_at);

// ── save function arguments (contract section 3.4) ────────────────────────────────────────────────
const sectionOr = (opts, fallback) => (opts && typeof opts.section === 'string' && opts.section) || fallback;

/** stock_save_item(p_item, p_sites, p_version, p_section) from a Stock items form. */
export function itemSaveArgs(i, locationId, opts = {}) {
  const item = {
    ...(i.id ? { site_item_id: i.id } : {}),
    location_id: locationId,
    name: (i.name || '').trim(),
    category: i.category || null,
    accounting_group: i.accountingGroup || null,
    base_unit: i.baseUnit || 'each',
    sku: i.sku || null,
    barcode: i.barcode || null,
    shelf_life_days: i.shelfLifeDays == null || i.shelfLifeDays === '' ? null : Number(i.shelfLifeDays),
    allergens: Array.isArray(i.allergens) ? i.allergens : [],
    purchase_tax_rate_id: i.purchaseTaxRateId || null,
    site: {
      kind: i.kind === 'MADE' ? 'MADE' : 'PURCHASED',
      is_tracked: i.isTracked !== false,
      is_sellable: i.isSellable === true,
      cost_method: i.costMethod || 'MOVING_AVG',
      storage_location: i.storageLocation || null,
      default_supplier_id: i.defaultSupplierId || null,
      notes: i.notes || null,
    },
  };
  return { p_item: item, p_sites: null, p_version: i.id ? versionOf(i.rowVersion) : null, p_section: sectionOr(opts, SECTIONS.inventory) };
}

/**
 * stock_save_supplier from the Suppliers form (and the Stock items quick add). Drop 0 rule for every
 * company: the company keys at the top, the site's own keys (account, order email, minimum, days,
 * cut off, notes) inside `site`, all written at location_id's row in the same call.
 */
export function supplierSaveArgs(s, locationId, opts = {}) {
  const supplier = {
    ...(s.id ? { site_supplier_id: s.id } : {}),
    location_id: locationId,
    name: (s.name || '').trim(),
    contact_name: s.contactName || null,
    phone: s.phone || null,
    payment_terms_days: intOrNull(s.paymentTermsDays),
    site: {
      account_number: s.accountNumber || null,
      email: s.email || null,
      min_order_value: num(s.minOrderValue),
      delivery_days: normDeliveryDays(s.deliveryDays),
      cutoff_time: s.cutoffTime || null,
      notes: s.notes || null,
    },
  };
  return { p_supplier: supplier, p_sites: null, p_version: s.id ? versionOf(s.rowVersion) : null, p_section: sectionOr(opts, SECTIONS.purchasing) };
}

/** stock_save_supplier_item from a supplier pack row on the Stock items Suppliers tab. */
export function supplierItemSaveArgs(sp, locationId, opts = {}) {
  const si = {
    ...(sp.id ? { site_supplier_product_id: sp.id } : {}),
    location_id: locationId,
    site_item_id: sp.inventoryItemId,
    site_supplier_id: sp.supplierId,
    supplier_sku: sp.supplierSku || null,
    pack_description: sp.packDescription || null,
    pack_qty: Number(sp.packQty) || 1,
    inner_qty: Number(sp.innerQty) || 1,
    inner_unit: sp.innerUnit || 'each',
    pack_price: Number(sp.packPrice) || 0,
    purchase_tax_rate_id: sp.purchaseTaxRateId || null,
    price_includes_tax: sp.priceIncludesTax === true,
    site: { is_preferred: sp.isPreferred === true },
  };
  return { p_si: si, p_version: sp.id ? versionOf(sp.rowVersion) : null, p_section: sectionOr(opts, SECTIONS.inventory) };
}

/** stock_save_pack from the Units tab. */
export function packSaveArgs(pack, locationId, opts = {}) {
  const p = {
    ...(pack.id ? { site_pack_id: pack.id } : {}),
    location_id: locationId,
    site_item_id: pack.inventoryItemId,
    name: (pack.name || '').trim(),
    qty_in_base: Number(pack.qtyInBase) || 0,
    site_parent_pack_id: pack.parentFormatId || null,
    is_count_default: pack.isCountDefault === true,
    is_purchase_default: pack.isPurchaseDefault === true,
  };
  return { p_pack: p, p_version: pack.id ? versionOf(pack.rowVersion) : null, p_section: sectionOr(opts, SECTIONS.inventory) };
}

/** stock_save_bridge from the Dimension and Measure tab. */
export function bridgeSaveArgs(conv, locationId, opts = {}) {
  const b = {
    ...(conv.id ? { site_bridge_id: conv.id } : {}),
    location_id: locationId,
    site_item_id: conv.inventoryItemId,
    from_qty: Number(conv.fromQty) || 0,
    from_unit: conv.fromUnit,
    to_qty: Number(conv.toQty) || 0,
    to_unit: conv.toUnit,
  };
  return { p_bridge: b, p_version: conv.id ? versionOf(conv.rowVersion) : null, p_section: sectionOr(opts, SECTIONS.inventory) };
}

/** The archive call of one record (stock_archive_item and the rest): the same four arguments. */
export function archiveArgs(idKey, id, archived, opts = {}, fallbackSection = SECTIONS.inventory) {
  return { [idKey]: id, p_version: versionOf(opts.version), p_archived: archived !== false, p_section: sectionOr(opts, fallbackSection) };
}

/**
 * stock_save_item_site p_patch for a par edit. A key the screen did not send keeps its stored value
 * (the old upsert wrote min_level null whenever the Stock tab saved par and reorder only); an empty
 * box is an explicit null, which clears it.
 */
export function parPatch(par = {}) {
  const out = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(par || {}, k);
  if (has('parLevel')) out.par_level = num(par.parLevel);
  if (has('reorderPoint')) out.reorder_point = num(par.reorderPoint);
  if (has('minLevel')) out.min_level = num(par.minLevel);
  return out;
}

/** stock_save_item_site p_patch for an area change (the old area's holding moves with it by default). */
export function areaPatch(areaId, { moveHolding = true, byName = null } = {}) {
  return { area_id: areaId || null, move_holding: moveHolding !== false, by_name: byName || null };
}

/** The recipe lines a save keeps: a component and a quantity above 0 (as replaceRecipeLines did). */
export const keptRecipeLines = (lines) => (lines || []).filter((l) => l && l.componentItemId && Number(l.qty) > 0);

/**
 * stock_save_recipe(p_recipe, p_lines, p_version, p_section): the recipe, its lines and the till
 * product link in ONE call, from a Recipes screen draft or the made item Recipe tab.
 */
export function recipeSaveArgs(draft, locationId, opts = {}) {
  const type = draft.recipeType || 'MENU';
  const recipe = {
    ...(draft.id ? { site_recipe_id: draft.id } : {}),
    location_id: locationId,
    name: (draft.name || '').trim(),
    recipe_type: type,
    site_output_item_id: draft.outputItemId || null,
    yield_qty: Number(draft.yieldQty) || 1,
    yield_unit: draft.yieldUnit || 'each',
    wastage_pct: Number(draft.wastagePct) || 0,
    gp_target_pct: draft.gpTargetPct == null || draft.gpTargetPct === '' ? null : Number(draft.gpTargetPct),
    method: draft.method || null,
    photo: draft.photo || null,
    ...(type === 'MENU' && draft.menuItemId ? { menu_item_id: String(draft.menuItemId), portion: Number(draft.portion) || 1 } : {}),
  };
  const lines = keptRecipeLines(draft.lines).map((l, i) => ({
    site_component_item_id: l.componentItemId,
    qty: Number(l.qty),
    unit: l.unit,
    usable_pct: l.usablePct == null ? 100 : Number(l.usablePct),
    sort_order: i,
    note: l.note || null,
    // null = applies to all order types (the shared base); an array scopes it to those types.
    order_types: Array.isArray(l.orderTypes) && l.orderTypes.length ? l.orderTypes : null,
  }));
  return { p_recipe: recipe, p_lines: lines, p_version: draft.id ? versionOf(draft.rowVersion) : null, p_section: sectionOr(opts, SECTIONS.produce) };
}

/**
 * What the recipe screens need from a stock_save_recipe answer: the site recipe id, its new version,
 * and whether the made item's cost was rolled up (cost.ok false is the "NOT recalculated" warning).
 */
export function recipeSaveOutcome(res, draft = {}) {
  const r = res && typeof res === 'object' ? res : {};
  return {
    id: r.site_recipe_id || r.site_row?.id || draft.id || null,
    rowVersion: versionOf(r.site_row?.row_version ?? r.row_version),
    linesSaved: Number(r.lines_saved) || 0,
    linked: r.linked === true,
    costOk: r.cost && typeof r.cost === 'object' ? r.cost.ok !== false : null,
    queued: Array.isArray(r.queued) ? r.queued : [],
  };
}
