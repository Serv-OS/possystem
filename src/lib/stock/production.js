/**
 * stock/production.js — production batches (make-here replenishment).
 *
 * Completing a batch posts to the ledger via post_stock_movement:
 *   • PRODUCTION_CONSUME (negative) for each recipe component at its current cost
 *   • PRODUCTION_OUTPUT  (positive) for the made item, valued at consumed-cost ÷
 *     actual output, so the made item is replenished at real production cost.
 * Idempotent per (batch, item) so a retried completion never double-posts.
 */

import { supabase, isMock, getLocationId, getActiveLocationSync } from '../supabase';
import { convert } from './conversion.js';
import { componentUnitCost } from './costing.js';
import { buildCostingCtx } from './recipes.js';
import { postStockMovement } from './data.js';

const nowIso = () => new Date().toISOString();
async function ensureLoc(locationId) {
  if (!locationId || locationId === 'loc-demo') locationId = getActiveLocationSync();
  if (!locationId || locationId === 'loc-demo') locationId = await getLocationId().catch(() => null);
  if (!locationId || locationId === 'loc-demo') return null;
  return locationId;
}

const batchFromRow = (r) => ({
  id: r.id, locationId: r.location_id, recipeId: r.recipe_id, outputItemId: r.output_item_id,
  outputName: r.output_name, plannedQty: r.planned_qty == null ? null : Number(r.planned_qty),
  actualQty: r.actual_qty == null ? null : Number(r.actual_qty), outputUnit: r.output_unit,
  status: r.status, theoreticalCost: r.theoretical_cost == null ? null : Number(r.theoretical_cost),
  actualCost: r.actual_cost == null ? null : Number(r.actual_cost),
  outputUnitCost: r.output_unit_cost == null ? null : Number(r.output_unit_cost),
  lotCode: r.lot_code, expiryAt: r.expiry_at, producedAt: r.produced_at, notes: r.notes, createdAt: r.created_at,
  scheduleId: r.schedule_id || null, plannedFor: r.planned_for || null, dueTime: r.due_time || null,
});

export const fetchBatches = async (locationId = null, limit = 100) => {
  if (isMock || !supabase) return { data: [], error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: [], error: null };
  const { data, error } = await supabase.from('production_batches').select('*')
    .eq('location_id', locationId).order('created_at', { ascending: false }).limit(limit);
  return { data: (data || []).map(batchFromRow), error };
};

/**
 * Compute a batch plan for `actualQty` of a recipe's output (pure-ish; needs ctx).
 * Returns { outputBase, outputUnitCost, totalCost, consume:[{itemId,qtyBase,unitCost}] }.
 */
export function planBatch(recipe, lines, actualQty, outputUnit, ctx) {
  const outItem = ctx.itemsById[recipe.outputItemId];
  if (!outItem) throw new Error('Output stock item not found');
  const conv = { itemConversions: outItem.itemConversions || [] };
  const yieldBase = convert(Number(recipe.yieldQty) || 1, recipe.yieldUnit || outItem.baseUnit, outItem.baseUnit, conv);
  const outputBase = convert(Number(actualQty), outputUnit || recipe.yieldUnit || outItem.baseUnit, outItem.baseUnit, conv);
  if (!(outputBase > 0) || !(yieldBase > 0)) throw new Error('Invalid yield/output quantity');
  const scale = outputBase / yieldBase;
  const wf = 1 + (Number(recipe.wastagePct) || 0) / 100;
  const consume = [];
  let totalCost = 0;
  for (const l of lines || []) {
    const comp = ctx.itemsById[l.componentItemId];
    if (!comp) continue;
    const base = convert(Number(l.qty), l.unit, comp.baseUnit, { itemConversions: comp.itemConversions || [] });
    const usable = (l.usablePct == null ? 100 : Number(l.usablePct)) / 100;
    if (!(usable > 0)) continue;
    const qtyBase = (base / usable) * wf * scale;
    const unitCost = componentUnitCost(l.componentItemId, ctx);
    consume.push({ itemId: l.componentItemId, qtyBase, unitCost });
    totalCost += qtyBase * unitCost;
  }
  return { outputBase, outputUnitCost: totalCost / outputBase, totalCost, consume };
}

/** Preview a batch's cost/consumption without writing (for the UI). */
export const previewBatch = async (recipeId, actualQty, outputUnit, locationId = null) => {
  if (isMock || !supabase) return { error: 'mock' };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { error: 'No location' };
  const [{ data: rec }, { data: lines }, ctx] = await Promise.all([
    supabase.from('recipes').select('*').eq('location_id', locationId).eq('id', recipeId).maybeSingle(),
    supabase.from('recipe_lines').select('*').eq('location_id', locationId).eq('recipe_id', recipeId).order('sort_order'),
    buildCostingCtx(locationId),
  ]);
  if (!rec) return { error: 'Recipe not found' };
  const recipe = { outputItemId: rec.output_item_id, yieldQty: Number(rec.yield_qty), yieldUnit: rec.yield_unit, wastagePct: Number(rec.wastage_pct) || 0 };
  const mappedLines = (lines || []).map(l => ({ componentItemId: l.component_item_id, qty: Number(l.qty), unit: l.unit, usablePct: l.usable_pct == null ? 100 : Number(l.usable_pct) }));
  try { return { plan: planBatch(recipe, mappedLines, actualQty, outputUnit, ctx), recipe: rec }; }
  catch (e) { return { error: e.message }; }
};

/**
 * Create and complete a production batch in one step: posts consume/output
 * movements and writes the COMPLETED batch row. Returns { data: batch, error }.
 */

/**
 * THE SCHEDULE BUILDS THE BATCHES. (v5.5.933)
 * For every active, recipe-linked prep_schedule row that cooks TODAY, ensure exactly one
 * production_batches row exists (status PLANNED, planned qty/unit/due time from the plan).
 * Idempotent by construction: a unique index on (location, schedule, day) means racing
 * callers — the Batches screen, the Manager app, tomorrow's reload — cannot double-plan.
 * Never throws: planning failing must not take down the screen that called it.
 */
export const ensureTodaysPlannedBatches = async (locationId = null) => {
  if (isMock || !supabase) return { data: 0, error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: 0, error: null };
  const today = new Date(); const dow = today.getDay();
  const ymd = today.toISOString().slice(0, 10);
  const { data: scheds } = await supabase.from('prep_schedule')
    .select('id, name, qty, unit, due_time, days_of_week, recipe_id, output_item_id')
    .eq('location_id', locationId).eq('active', true).not('recipe_id', 'is', null);
  let created = 0;
  for (const sc of (scheds || [])) {
    const days = Array.isArray(sc.days_of_week) && sc.days_of_week.length ? sc.days_of_week : [0,1,2,3,4,5,6];
    if (!days.includes(dow)) continue;
    const { error } = await supabase.from('production_batches').insert({
      location_id: locationId, schedule_id: sc.id, planned_for: ymd, due_time: sc.due_time || null,
      recipe_id: sc.recipe_id, output_item_id: sc.output_item_id || null, output_name: sc.name,
      planned_qty: sc.qty == null ? null : Number(sc.qty), output_unit: sc.unit || 'each', status: 'PLANNED',
    });
    if (!error) created++;   // unique-index conflict = already planned today: exactly the idea
  }
  return { data: created, error: null };
};

/**
 * Complete a PLANNED batch: staff enter what was actually made; ingredients are consumed
 * and the output stocked against THIS row (movement keys carry this batch id, so a retry
 * cannot double-move). This is the only path from PLANNED to COMPLETED.
 */
export const completePlannedBatch = async (batchId, actualQty, locationId = null) => {
  if (isMock || !supabase) return { data: null, error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: null, error: new Error('No locationId') };
  const { data: b } = await supabase.from('production_batches').select('*')
    .eq('location_id', locationId).eq('id', batchId).maybeSingle();
  if (!b) return { data: null, error: new Error('Batch not found') };
  if (b.status === 'COMPLETED') return { data: batchFromRow(b), error: null };   // already done — idempotent
  if (!b.recipe_id) return { data: null, error: new Error('This batch has no recipe linked') };

  const [{ data: rec }, { data: lines }, ctx] = await Promise.all([
    supabase.from('recipes').select('*').eq('location_id', locationId).eq('id', b.recipe_id).maybeSingle(),
    supabase.from('recipe_lines').select('*').eq('location_id', locationId).eq('recipe_id', b.recipe_id).order('sort_order'),
    buildCostingCtx(locationId),
  ]);
  if (!rec?.output_item_id) return { data: null, error: new Error('Recipe has no output stock item') };
  const recipe = { outputItemId: rec.output_item_id, yieldQty: Number(rec.yield_qty), yieldUnit: rec.yield_unit, wastagePct: Number(rec.wastage_pct) || 0 };
  const mappedLines = (lines || []).map(l => ({ componentItemId: l.component_item_id, qty: Number(l.qty), unit: l.unit, usablePct: l.usable_pct == null ? 100 : Number(l.usable_pct) }));
  // v5.5.934 — schedules store operator-friendly units ('ea', 'portions', 'trays')
  // that the conversion engine does not know. A unit it cannot read must not kill the
  // Done button: normalise the obvious ones, then walk fallbacks — the batch's own
  // unit, the recipe's yield unit, plain 'each'. First one that converts wins.
  const norm = (u) => ({ ea: 'each', portion: 'each', portions: 'each', trays: 'each', batch: rec.yield_unit }[String(u || '').toLowerCase()] || u);
  const candidates = [...new Set([norm(b.output_unit), rec.yield_unit, 'each'].filter(Boolean))];
  let plan = null, planErr = null;
  for (const u of candidates) {
    try { plan = planBatch(recipe, mappedLines, actualQty, u, ctx); planErr = null; break; }
    catch (e) { planErr = e; }
  }
  if (!plan) return { data: null, error: new Error(`Cannot work out the quantity: "${b.output_unit}" is not a unit this item understands (${planErr?.message || ''})`) };

  for (const c of plan.consume) {
    if (!(c.qtyBase > 0)) continue;
    await postStockMovement({
      inventoryItemId: c.itemId, qtyBase: -c.qtyBase, movementType: 'PRODUCTION_CONSUME', unitCost: c.unitCost,
      sourceType: 'production_batch', sourceId: batchId, idempotencyKey: `batch:${batchId}:consume:${c.itemId}`,
    }, locationId);
  }
  await postStockMovement({
    inventoryItemId: rec.output_item_id, qtyBase: plan.outputBase, movementType: 'PRODUCTION_OUTPUT',
    unitCost: plan.outputUnitCost, sourceType: 'production_batch', sourceId: batchId,
    idempotencyKey: `batch:${batchId}:output`,
  }, locationId);

  const { data: done, error } = await supabase.from('production_batches').update({
    status: 'COMPLETED', actual_qty: Number(actualQty), output_item_id: rec.output_item_id,
    actual_cost: plan.totalCost, theoretical_cost: plan.totalCost, output_unit_cost: plan.outputUnitCost,
    produced_at: nowIso(), updated_at: nowIso(),
  }).eq('location_id', locationId).eq('id', batchId).select().maybeSingle();
  return { data: done ? batchFromRow(done) : null, error };
};

export const produceBatch = async ({ recipeId, actualQty, outputUnit, lotCode, expiryAt, notes }, locationId = null) => {
  if (isMock || !supabase) return { data: null, error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: null, error: new Error('No locationId') };

  const [{ data: rec }, { data: lines }, ctx] = await Promise.all([
    supabase.from('recipes').select('*').eq('location_id', locationId).eq('id', recipeId).maybeSingle(),
    supabase.from('recipe_lines').select('*').eq('location_id', locationId).eq('recipe_id', recipeId).order('sort_order'),
    buildCostingCtx(locationId),
  ]);
  if (!rec) return { data: null, error: new Error('Recipe not found') };
  if (!rec.output_item_id) return { data: null, error: new Error('This recipe has no output stock item') };
  const outUnit = outputUnit || rec.yield_unit;
  const recipe = { outputItemId: rec.output_item_id, yieldQty: Number(rec.yield_qty), yieldUnit: rec.yield_unit, wastagePct: Number(rec.wastage_pct) || 0 };
  const mappedLines = (lines || []).map(l => ({ componentItemId: l.component_item_id, qty: Number(l.qty), unit: l.unit, usablePct: l.usable_pct == null ? 100 : Number(l.usable_pct) }));

  let plan;
  try { plan = planBatch(recipe, mappedLines, actualQty, outUnit, ctx); }
  catch (e) { return { data: null, error: e }; }

  const outName = ctx.itemsById[rec.output_item_id] ? undefined : null;
  // Create the batch row first so its id keys the idempotent movements.
  const { data: batchRow, error: insErr } = await supabase.from('production_batches').insert({
    location_id: locationId, recipe_id: recipeId, output_item_id: rec.output_item_id,
    output_name: rec.name || outName, planned_qty: Number(rec.yield_qty), actual_qty: Number(actualQty),
    output_unit: outUnit, status: 'DRAFT', theoretical_cost: plan.totalCost, actual_cost: plan.totalCost,
    output_unit_cost: plan.outputUnitCost, lot_code: lotCode || null, expiry_at: expiryAt || null,
    produced_at: nowIso(), notes: notes || null,
  }).select().maybeSingle();
  if (insErr || !batchRow) return { data: null, error: insErr || new Error('Could not create batch') };
  const batchId = batchRow.id;

  // Post consume movements (negative), then the output (positive). Idempotent.
  for (const c of plan.consume) {
    if (!(c.qtyBase > 0)) continue;
    await postStockMovement({
      inventoryItemId: c.itemId, qtyBase: -c.qtyBase, movementType: 'PRODUCTION_CONSUME', unitCost: c.unitCost,
      sourceType: 'production_batch', sourceId: batchId, idempotencyKey: `batch:${batchId}:consume:${c.itemId}`,
    }, locationId);
  }
  await postStockMovement({
    inventoryItemId: rec.output_item_id, qtyBase: plan.outputBase, movementType: 'PRODUCTION_OUTPUT',
    unitCost: plan.outputUnitCost, sourceType: 'production_batch', sourceId: batchId,
    idempotencyKey: `batch:${batchId}:output`,
  }, locationId);

  const { data: done } = await supabase.from('production_batches')
    .update({ status: 'COMPLETED', updated_at: nowIso() }).eq('location_id', locationId).eq('id', batchId).select().maybeSingle();
  return { data: batchFromRow(done || batchRow), error: null };
};
