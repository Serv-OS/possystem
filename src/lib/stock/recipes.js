/**
 * stock/recipes.js — data layer for recipes, sub-recipes and the menu↔recipe link.
 *
 * Recipes cost up from stock items via the pure engine in costing.js. This module
 * fetches/writes the recipe tables and assembles the CostingCtx the engine needs
 * ({ itemsById, recipesByOutputItem }). Same house pattern as stock/data.js.
 */

import { supabase, isMock, getLocationId, getActiveLocationSync } from '../supabase';
import { componentUnitCost, computeRecipe } from './costing.js';

const nowIso = () => new Date().toISOString();
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
});
const recipeToRow = (rc, locationId) => ({
  ...(rc.id ? { id: rc.id } : {}),
  location_id: locationId, name: (rc.name || '').trim(),
  recipe_type: rc.recipeType || 'MENU', output_item_id: rc.outputItemId || null,
  yield_qty: Number(rc.yieldQty) || 1, yield_unit: rc.yieldUnit || 'each',
  wastage_pct: Number(rc.wastagePct) || 0,
  gp_target_pct: rc.gpTargetPct == null || rc.gpTargetPct === '' ? null : Number(rc.gpTargetPct),
  method: rc.method || null, photo: rc.photo || null, status: rc.status || 'active', updated_at: nowIso(),
});
const lineFromRow = (r) => ({
  id: r.id, recipeId: r.recipe_id, componentItemId: r.component_item_id,
  qty: Number(r.qty), unit: r.unit, usablePct: r.usable_pct == null ? 100 : Number(r.usable_pct),
  sortOrder: r.sort_order || 0, note: r.note,
});

/** All recipes for a location, each with lines[] and (for MENU) menuItemId/portion. */
export const fetchRecipes = async (locationId = null) => {
  if (isMock || !supabase) return { data: [], error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: [], error: null };
  const [{ data: recs, error }, { data: lines }, { data: links }] = await Promise.all([
    supabase.from('recipes').select('*').eq('location_id', locationId).is('archived_at', null).order('name'),
    supabase.from('recipe_lines').select('*').eq('location_id', locationId).order('sort_order'),
    supabase.from('menu_item_recipes').select('*').eq('location_id', locationId),
  ]);
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

export const upsertRecipe = async (recipe, locationId = null) => {
  if (isMock || !supabase) return { data: null, error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: null, error: new Error('No locationId') };
  return supabase.from('recipes').upsert(recipeToRow(recipe, locationId)).select().maybeSingle();
};

export const setRecipeArchived = async (id, archived, locationId = null) => {
  if (isMock || !supabase) return { data: null, error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: null, error: new Error('No locationId') };
  return supabase.from('recipes').update({ archived_at: archived ? nowIso() : null, updated_at: nowIso() })
    .eq('location_id', locationId).eq('id', id);
};

/** Replace a recipe's lines wholesale (delete then insert) — simplest robust save. */
export const replaceRecipeLines = async (recipeId, lines, locationId = null) => {
  if (isMock || !supabase) return { error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { error: new Error('No locationId') };
  const del = await supabase.from('recipe_lines').delete().eq('location_id', locationId).eq('recipe_id', recipeId);
  if (del.error) return { error: del.error };
  const rows = (lines || []).filter(l => l.componentItemId && Number(l.qty) > 0).map((l, i) => ({
    location_id: locationId, recipe_id: recipeId, component_item_id: l.componentItemId,
    qty: Number(l.qty), unit: l.unit, usable_pct: l.usablePct == null ? 100 : Number(l.usablePct),
    sort_order: i, note: l.note || null,
  }));
  if (!rows.length) return { error: null };
  return supabase.from('recipe_lines').insert(rows);
};

export const linkMenuItemRecipe = async (menuItemId, recipeId, portion = 1, locationId = null) => {
  if (isMock || !supabase) return { error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { error: new Error('No locationId') };
  return supabase.from('menu_item_recipes').upsert({
    location_id: locationId, menu_item_id: String(menuItemId), recipe_id: recipeId, portion: Number(portion) || 1,
  }, { onConflict: 'location_id,menu_item_id' });
};

export const unlinkMenuItem = async (menuItemId, locationId = null) => {
  if (isMock || !supabase) return { error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { error: new Error('No locationId') };
  return supabase.from('menu_item_recipes').delete().eq('location_id', locationId).eq('menu_item_id', String(menuItemId));
};

/**
 * Build the CostingCtx ({ itemsById, recipesByOutputItem }) the engine needs to
 * cost recipes and roll up MADE items. itemsById carries each item's base unit,
 * currentCost (for purchased) and conversions; recipesByOutputItem maps a MADE
 * item id → its PREP recipe so nested costing resolves.
 */
export const buildCostingCtx = async (locationId = null) => {
  if (isMock || !supabase) return { itemsById: {}, recipesByOutputItem: {} };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { itemsById: {}, recipesByOutputItem: {} };
  const [{ data: items }, { data: convs }, { data: recs }, { data: lines }] = await Promise.all([
    supabase.from('inventory_items').select('id, kind, base_unit, current_cost').eq('location_id', locationId),
    supabase.from('inventory_item_conversions').select('*').eq('location_id', locationId),
    supabase.from('recipes').select('id, output_item_id, yield_qty, yield_unit, wastage_pct, recipe_type').eq('location_id', locationId).is('archived_at', null),
    supabase.from('recipe_lines').select('*').eq('location_id', locationId).order('sort_order'),
  ]);
  const convByItem = {};
  (convs || []).forEach((c) => { (convByItem[c.inventory_item_id] ??= []).push({ fromQty: Number(c.from_qty), fromUnit: c.from_unit, toQty: Number(c.to_qty), toUnit: c.to_unit }); });
  const itemsById = {};
  (items || []).forEach((it) => {
    itemsById[it.id] = {
      id: it.id, kind: it.kind, baseUnit: it.base_unit,
      currentCost: it.current_cost == null ? null : Number(it.current_cost),
      itemConversions: convByItem[it.id] || [],
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
  return { itemsById, recipesByOutputItem };
};

/**
 * Recompute a MADE item's current_cost from its PREP recipe roll-up and persist it
 * (inventory_items.current_cost + an item_cost_history row, source RECIPE_ROLLUP).
 * Call after saving a PREP recipe so dependent costs reflect the change.
 */
export const recomputeMadeItemCost = async (outputItemId, locationId = null) => {
  if (isMock || !supabase || !outputItemId) return { ok: false };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { ok: false };
  const ctx = await buildCostingCtx(locationId);
  let cost;
  try { cost = componentUnitCost(outputItemId, ctx); } catch { return { ok: false }; }
  if (!Number.isFinite(cost)) return { ok: false };
  const { data: itemRows } = await supabase.from('inventory_items').select('current_cost').eq('location_id', locationId).eq('id', outputItemId).limit(1);
  const prev = itemRows?.[0]?.current_cost == null ? null : Number(itemRows[0].current_cost);
  if (prev != null && Math.abs(prev - cost) <= 1e-9) return { ok: true, unchanged: true, cost };
  await supabase.from('item_cost_history').update({ effective_to: nowIso() })
    .eq('location_id', locationId).eq('inventory_item_id', outputItemId).is('effective_to', null);
  await supabase.from('item_cost_history').insert({
    location_id: locationId, inventory_item_id: outputItemId, base_unit_cost: cost,
    source: 'RECIPE_ROLLUP', effective_from: nowIso(),
  });
  await supabase.from('inventory_items').update({ current_cost: cost, updated_at: nowIso() })
    .eq('location_id', locationId).eq('id', outputItemId);
  return { ok: true, cost };
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
  const [{ data: links }, { data: recs }, { data: lines }] = await Promise.all([
    supabase.from('menu_item_recipes').select('menu_item_id, recipe_id, portion').eq('location_id', locationId),
    supabase.from('recipes').select('id, wastage_pct').eq('location_id', locationId).is('archived_at', null),
    supabase.from('recipe_lines').select('recipe_id, component_item_id, qty, unit, usable_pct').eq('location_id', locationId).order('sort_order'),
  ]);
  const wastageByRecipe = {};
  (recs || []).forEach((r) => { wastageByRecipe[r.id] = Number(r.wastage_pct) || 0; });
  const linesByRecipe = {};
  (lines || []).forEach((l) => {
    (linesByRecipe[l.recipe_id] ??= []).push({
      componentItemId: l.component_item_id, qty: Number(l.qty), unit: l.unit,
      usablePct: l.usable_pct == null ? 100 : Number(l.usable_pct),
    });
  });
  const menuRecipes = {};
  (links || []).forEach((k) => {
    menuRecipes[String(k.menu_item_id)] = {
      lines: linesByRecipe[k.recipe_id] || [], portion: Number(k.portion) || 1,
      wastagePct: wastageByRecipe[k.recipe_id] || 0,
    };
  });
  return { ...base, menuRecipes };
};

/** Cost a recipe given its lines + an output descriptor. Pure-engine wrapper for the UI. */
export const costRecipeWith = (recipe, ctx) => {
  const outputItem = recipe.outputItemId
    ? ctx.itemsById[recipe.outputItemId]
    : { baseUnit: recipe.yieldUnit || 'each', itemConversions: [] };
  try {
    return computeRecipe(
      { yieldQty: recipe.yieldQty, yieldUnit: recipe.yieldUnit, wastagePct: recipe.wastagePct, lines: recipe.lines },
      outputItem, ctx, new Set(recipe.outputItemId ? [recipe.outputItemId] : []),
    );
  } catch (e) { return { error: e.message }; }
};
