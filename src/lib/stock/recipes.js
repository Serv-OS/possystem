/**
 * stock/recipes.js — data layer for recipes, sub-recipes and the menu↔recipe link.
 *
 * Recipes cost up from stock items via the pure engine in costing.js. This module
 * fetches the recipe tables, saves through the database save functions and assembles the
 * CostingCtx the engine needs ({ itemsById, recipesByOutputItem }). Same house pattern as
 * stock/data.js.
 *
 * v5.11.86 (multi site stock Drop 1): 0b is live, so the Drop 0 fallbacks are gone: the old four
 * call recipe save (upsertRecipe, replaceRecipeLines, linkMenuItemRecipe's upsert,
 * recomputeMadeItemCost writing the cost from the browser) and the direct archive, link and unlink
 * writes. A database without a save function answers 'This needs a database update. Ask ServOS to
 * run it.', never a direct write.
 */

import { supabase, isMock, getLocationId, getActiveLocationSync } from '../supabase';
import { computeRecipe } from './costing.js';
import { firstReadError } from './menuWaste.js';
import { readAllPagesResult } from '../pagedRead.js';
import { archiveArgs, versionOf, SECTIONS } from './saveRules.js';
import { callSave, runRecipeSave } from './companyData.js';

/**
 * v5.11.79 (stock plan Phase 0, 1,000 row cap): every recipe and costing read in pages of 1,000
 * (lib/pagedRead.js), ordered on a unique key. PostgREST answers at most 1,000 rows a request and
 * says nothing about the rest: a recipe book past 1,000 lines (about 470 products a site at 2 to 5
 * lines) silently dropped lines, so plate costs and stock off came out short. A failed page is an
 * error, never "no rows".
 */
const pageAll = (what, table, cols, locationId, order = [], live = false) => readAllPagesResult(what, (first) => {
  let q = supabase.from(table).select(cols, first ? { count: 'exact' } : undefined).eq('location_id', locationId);
  if (live) q = q.is('archived_at', null);
  for (const col of [...order, 'id']) q = q.order(col);
  return q;
});
async function ensureLoc(locationId) {
  if (!locationId || locationId === 'loc-demo') locationId = getActiveLocationSync();
  if (!locationId || locationId === 'loc-demo') locationId = await getLocationId().catch(() => null);
  if (!locationId || locationId === 'loc-demo') return null;
  return locationId;
}

const recipeFromRow = (r) => ({
  id: r.id, locationId: r.location_id, name: r.name, recipeType: r.recipe_type,
  outputItemId: r.output_item_id, yieldQty: Number(r.yield_qty), yieldUnit: r.yield_unit,
  wastagePct: Number(r.wastage_pct) || 0, gpTargetPct: r.gp_target_pct == null ? null : Number(r.gp_target_pct),
  method: r.method, photo: r.photo, status: r.status, archivedAt: r.archived_at,
  // v5.11.84 (multi site stock Drop 0): the version the save sends back, and the company record behind it
  rowVersion: versionOf(r.row_version), companyRef: r.company_ref || null,
});
const lineFromRow = (r) => ({
  id: r.id, recipeId: r.recipe_id, componentItemId: r.component_item_id,
  qty: Number(r.qty), unit: r.unit, usablePct: r.usable_pct == null ? 100 : Number(r.usable_pct),
  sortOrder: r.sort_order || 0, note: r.note,
  // null/[] = applies to all order types; an array restricts the line to those types.
  orderTypes: Array.isArray(r.order_types) && r.order_types.length ? r.order_types : null,
});

/** All recipes for a location, each with lines[] and (for MENU) menuItemId/portion. */
export const fetchRecipes = async (locationId = null) => {
  if (isMock || !supabase) return { data: [], error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: [], error: null };
  const reads = await Promise.all([
    pageAll('recipes', 'recipes', '*', locationId, ['name'], true),
    pageAll('recipe lines', 'recipe_lines', '*', locationId, ['sort_order']),
    pageAll('recipe links', 'menu_item_recipes', '*', locationId),
  ]);
  const [{ data: recs }, { data: lines }, { data: links }] = reads;
  const error = firstReadError(reads);
  if (error) return { data: [], error };
  const linesByRecipe = {};
  (lines || []).forEach((l) => { (linesByRecipe[l.recipe_id] ??= []).push(lineFromRow(l)); });
  const linkByRecipe = {};
  (links || []).forEach((k) => { linkByRecipe[k.recipe_id] = { menuItemId: k.menu_item_id, portion: Number(k.portion) }; });
  const data = (recs || []).map((r) => {
    const rc = recipeFromRow(r);
    rc.lines = linesByRecipe[r.id] || [];
    const link = linkByRecipe[r.id];
    rc.menuItemId = link?.menuItemId || null;
    rc.portion = link?.portion || 1;
    return rc;
  });
  return { data, error: null };
};

/**
 * v5.11.84 (multi site stock Drop 0, plan 4.5): save a recipe, its ingredient lines and its till
 * product link in ONE database call (stock_save_recipe), which also re costs the made item it
 * produces (with a REVALUE when stock is held) and never leaves the lines half replaced. Used by
 * Recipes.jsx `save` and the Stock items Recipe tab, which keep their toasts word for word.
 * Answer: { data: { id, rowVersion }, error, stage, costOk } (companyData.js runRecipeSave):
 * stage 'recipe' nothing saved (a database without the function says it needs an update); costOk
 * false is the "cost was NOT recalculated" warning.
 * opts.section: 'produce' (Recipes) or 'inventory' (the made item's own Recipe tab).
 */
export const saveRecipeWithLines = async (draft, locationId = null, opts = {}) => {
  if (isMock || !supabase) return { data: null, error: null, stage: null, costOk: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: null, error: new Error('No locationId'), stage: 'recipe', costOk: null };
  return runRecipeSave({ client: supabase }, draft, locationId, opts);
};

/**
 * Archive (or restore) a recipe. v5.11.84 (Drop 0): stock_archive_recipe archives it AND removes its
 * till product links, so a removed dish no longer takes stock off. opts: { version, section }.
 */
export const setRecipeArchived = async (id, archived, locationId = null, opts = {}) => {
  if (isMock || !supabase) return { data: null, error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: null, error: new Error('No locationId') };
  const r = await callSave(supabase, 'stock_archive_recipe', archiveArgs('p_recipe', id, archived, opts, SECTIONS.produce));
  return { data: r.data ?? null, error: r.error || null };
};

/** Link a till product to a recipe: stock_link_menu_item (v5.11.84 Drop 0; Drop 1: no direct write). */
export const linkMenuItemRecipe = async (menuItemId, recipeId, portion = 1, locationId = null, opts = {}) => {
  if (isMock || !supabase) return { error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { error: new Error('No locationId') };
  const r = await callSave(supabase, 'stock_link_menu_item', {
    p_location: locationId, p_menu_item_id: String(menuItemId), p_recipe: recipeId, p_portion: Number(portion) || 1,
    p_section: opts.section || SECTIONS.produce,
  });
  return { data: r.data ?? null, error: r.error || null };
};

/** Unlink a till product: stock_link_menu_item with no recipe (v5.11.84 Drop 0; Drop 1: no direct delete). */
export const unlinkMenuItem = async (menuItemId, locationId = null, opts = {}) => {
  if (isMock || !supabase) return { error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { error: new Error('No locationId') };
  const r = await callSave(supabase, 'stock_link_menu_item', {
    p_location: locationId, p_menu_item_id: String(menuItemId), p_recipe: null, p_portion: 1,
    p_section: opts.section || SECTIONS.produce,
  });
  return { data: r.data ?? null, error: r.error || null };
};

// 26 Sep 2026 (waste without stock review): supabase-js never throws on a failed read, it
// resolves { data: null, error }, and the builders below coerce that to []. So an empty ctx
// used to look the same whether the venue has no stock or the network blipped. The first
// read error rides back on the ctx as `error` for callers that must tell the two apart (the
// till Waste modal: "no stock here" must never be a guess). Every other reader ignores the key.
// firstReadError is pure and tested in menuWaste.js.

/**
 * Build the CostingCtx ({ itemsById, recipesByOutputItem, error }) the engine needs to
 * cost recipes and roll up MADE items. itemsById carries each item's base unit,
 * currentCost (for purchased) and conversions; recipesByOutputItem maps a MADE
 * item id → its PREP recipe so nested costing resolves. `error` is the first failed
 * read (null when every read succeeded).
 */
export const buildCostingCtx = async (locationId = null) => {
  if (isMock || !supabase) return { itemsById: {}, recipesByOutputItem: {}, error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { itemsById: {}, recipesByOutputItem: {}, error: null };
  const reads = await Promise.all([
    pageAll('stock items', 'inventory_items', 'id, name, kind, base_unit, current_cost', locationId),
    pageAll('unit conversions', 'inventory_item_conversions', '*', locationId),
    pageAll('recipes', 'recipes', 'id, output_item_id, yield_qty, yield_unit, wastage_pct, recipe_type', locationId, [], true),
    pageAll('recipe lines', 'recipe_lines', '*', locationId, ['sort_order']),
    pageAll('packaging units', 'item_packaging_formats', 'id, inventory_item_id, name, qty_in_base', locationId),
  ]);
  const [{ data: items }, { data: convs }, { data: recs }, { data: lines }, { data: packs }] = reads;
  const convByItem = {};
  (convs || []).forEach((c) => { (convByItem[c.inventory_item_id] ??= []).push({ fromQty: Number(c.from_qty), fromUnit: c.from_unit, toQty: Number(c.to_qty), toUnit: c.to_unit }); });
  const fmtByItem = {};
  (packs || []).forEach((p) => { (fmtByItem[p.inventory_item_id] ??= []).push({ id: p.id, name: p.name, qtyInBase: Number(p.qty_in_base) }); });
  const itemsById = {};
  (items || []).forEach((it) => {
    itemsById[it.id] = {
      id: it.id, name: it.name, kind: it.kind, baseUnit: it.base_unit,
      currentCost: it.current_cost == null ? null : Number(it.current_cost),
      itemConversions: convByItem[it.id] || [], formats: fmtByItem[it.id] || [],
    };
  });
  const linesByRecipe = {};
  (lines || []).forEach((l) => {
    (linesByRecipe[l.recipe_id] ??= []).push({
      componentItemId: l.component_item_id, qty: Number(l.qty), unit: l.unit,
      usablePct: l.usable_pct == null ? 100 : Number(l.usable_pct),
    });
  });
  const recipesByOutputItem = {};
  (recs || []).forEach((r) => {
    if (!r.output_item_id) return; // MENU recipes have no inventory output
    recipesByOutputItem[r.output_item_id] = {
      outputItemId: r.output_item_id, yieldQty: Number(r.yield_qty), yieldUnit: r.yield_unit,
      wastagePct: Number(r.wastage_pct) || 0, lines: linesByRecipe[r.id] || [],
    };
  });
  return { itemsById, recipesByOutputItem, error: firstReadError(reads) };
};

/**
 * Build the context for SALE depletion: the costing ctx plus a menuRecipes map
 * (menu_item_id → { lines, portion, wastagePct }) so a sold dish can be exploded
 * into the stock items it consumes. Used by stock/deplete.js.
 */
export const buildDepletionCtx = async (locationId = null) => {
  const base = await buildCostingCtx(locationId);
  locationId = await ensureLoc(locationId);
  if (!locationId) return { ...base, menuRecipes: {} };
  const reads = await Promise.all([
    pageAll('recipe links', 'menu_item_recipes', 'id, menu_item_id, recipe_id, portion', locationId),
    pageAll('recipes', 'recipes', 'id, wastage_pct', locationId, [], true),
    pageAll('recipe lines', 'recipe_lines', 'id, recipe_id, component_item_id, qty, unit, usable_pct, order_types', locationId, ['sort_order']),
  ]);
  const [{ data: links }, { data: recs }, { data: lines }] = reads;
  const wastageByRecipe = {};
  (recs || []).forEach((r) => { wastageByRecipe[r.id] = Number(r.wastage_pct) || 0; });
  const linesByRecipe = {};
  (lines || []).forEach((l) => {
    (linesByRecipe[l.recipe_id] ??= []).push({
      componentItemId: l.component_item_id, qty: Number(l.qty), unit: l.unit,
      usablePct: l.usable_pct == null ? 100 : Number(l.usable_pct),
      orderTypes: Array.isArray(l.order_types) && l.order_types.length ? l.order_types : null,
    });
  });
  const menuRecipes = {};
  (links || []).forEach((k) => {
    menuRecipes[String(k.menu_item_id)] = {
      lines: linesByRecipe[k.recipe_id] || [], portion: Number(k.portion) || 1,
      wastagePct: wastageByRecipe[k.recipe_id] || 0,
    };
  });
  // 26 Sep 2026: a failed costing read counts too, an empty itemsById also explodes to nothing.
  return { ...base, menuRecipes, error: base.error || firstReadError(reads) };
};

/**
 * Cost a recipe given its lines + an output descriptor. Pure-engine wrapper for the UI.
 * `orderType` (optional) scopes which lines count — null = the base (dine-in) recipe.
 */
export const costRecipeWith = (recipe, ctx, orderType = null) => {
  const outputItem = recipe.outputItemId
    ? ctx.itemsById[recipe.outputItemId]
    : { baseUnit: recipe.yieldUnit || 'each', itemConversions: [] };
  try {
    return computeRecipe(
      { yieldQty: recipe.yieldQty, yieldUnit: recipe.yieldUnit, wastagePct: recipe.wastagePct, lines: recipe.lines },
      outputItem, ctx, new Set(recipe.outputItemId ? [recipe.outputItemId] : []), orderType,
    );
  } catch (e) { return { error: e.message }; }
};
