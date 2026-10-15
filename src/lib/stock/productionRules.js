/**
 * stock/productionRules.js: the pure rules behind making a batch. Tested (productionRules.test.js).
 *
 * v5.11.65 (15 Oct 2026 audit):
 *  - Back Office "Produce batch" inserted a row whose planned_qty and actual_qty sat INSIDE a
 *    trailing code comment, so every batch made that way had no planned or made quantity
 *    (Batch history read "Output:  each", the Production report's yield was blank). The row is
 *    built here, where a test can read it.
 *  - The prep schedule offered units the engine cannot convert ('portions', 'trays', 'batch')
 *    and completion GUESSED: 'batch' became the recipe's yield unit (2 batches of 10 l soup
 *    completed as 2 litres) and 'portions' fell back through 'each' to the yield unit (10
 *    portions became 10 litres). The schedule now offers only the item's own units plus
 *    'batch', 'batch' means yield x n, and a unit that cannot be read is refused with words,
 *    never guessed.
 */

import { isKnownUnit, normUnit, unitDimension } from './units.js';

/** The production_batches row a one step Produce writes (status DRAFT until its movements post). */
export function batchRow({ locationId, recipeId, outputItemId, outputName, plannedQty, actualQty, outputUnit, plan, lotCode = null, expiryAt = null, notes = null, producedAt = null }) {
  return {
    location_id: locationId, recipe_id: recipeId, output_item_id: outputItemId,
    output_name: outputName || null,
    planned_qty: plannedQty == null || plannedQty === '' || !Number.isFinite(Number(plannedQty)) ? null : Number(plannedQty),
    actual_qty: Number(actualQty),
    output_unit: outputUnit, status: 'DRAFT',
    theoretical_cost: plan?.totalCost ?? null, actual_cost: plan?.totalCost ?? null,
    output_unit_cost: plan?.outputUnitCost ?? null,
    lot_code: lotCode || null, expiry_at: expiryAt || null,
    produced_at: producedAt, notes: notes || null,
  };
}

const COUNTED = new Set(['ea', 'each', 'portion', 'portions', 'tray', 'trays', 'unit', 'units', 'piece', 'pieces', 'pcs']);

/**
 * Turn a scheduled quantity into something the costing engine can convert.
 * @param outputUnit  the schedule's unit as typed ('batch', 'L', 'Tub', 'portions' ...)
 * @param actualQty   what was made, in that unit
 * @param recipe      { yieldQty, yieldUnit }
 * @param item        the output stock item { name?, baseUnit, formats: [{ id, name, qtyInBase }] }
 * @returns { qty, unit }  a quantity in a unit convert() understands (a global unit code), or throws
 *   'batch'          = yieldQty x n, in the recipe's yield unit
 *   a pack name      = n x that pack's size, in the base unit
 *   each / portions  = 'each' when the item is counted in each, refused otherwise
 *   a global unit    = as given
 */
export function resolveBatchOutput({ outputUnit, actualQty, recipe = {}, item = {} }) {
  const n = Number(actualQty);
  if (!Number.isFinite(n) || n <= 0) throw new Error('Enter how much was made (more than zero)');
  const base = normUnit(item.baseUnit) || 'each';
  const yieldUnit = normUnit(recipe.yieldUnit) || base;
  const raw = String(outputUnit ?? '').trim();
  const u = raw.toLowerCase();
  const name = item.name ? item.name : 'this item';
  if (!u) return { qty: n, unit: yieldUnit };
  if (u === 'batch' || u === 'batches') return { qty: n * (Number(recipe.yieldQty) > 0 ? Number(recipe.yieldQty) : 1), unit: yieldUnit };
  const fmt = (item.formats || []).find((f) => String(f.name || '').trim().toLowerCase() === u);
  if (fmt) {
    if (!(Number(fmt.qtyInBase) > 0)) throw new Error(`The unit "${raw}" on ${name} has no size. Fix it on the item's Units tab.`);
    return { qty: n * Number(fmt.qtyInBase), unit: base };
  }
  if (COUNTED.has(u)) {
    if (base === 'each') return { qty: n, unit: 'each' };
    throw new Error(`"${raw}" is not a unit ${name} is measured in (its unit is ${base}). Set the prep schedule unit to ${base}, one of the item's own units, or batch.`);
  }
  if (isKnownUnit(u)) {
    // v5.11.65: a known unit of another dimension ('L' on an item counted in each) is refused here
    // in words, not by the engine's "No conversion path" text at the Done button.
    if (unitDimension(u) !== unitDimension(base)) throw new Error(`"${raw}" is not a unit ${name} is measured in (its unit is ${base}). Set the prep schedule unit to ${base}, one of the item's own units, or batch.`);
    return { qty: n, unit: u };
  }
  throw new Error(`"${raw}" is not a unit ${name} understands. Set the prep schedule unit to ${base}, one of the item's own units, or batch.`);
}

/**
 * The units the prep schedule editor may offer for a linked made item: its base unit, its own
 * named units, and 'batch' (one recipe yield). A unit already saved that is none of these is
 * kept in the list, flagged, so the editor shows what is stored rather than silently swapping it.
 */
export function scheduleUnitOptions(item, currentUnit = '') {
  if (!item) return [];
  const base = normUnit(item.baseUnit) || 'each';
  const opts = [{ value: base, label: base }];
  for (const f of item.formats || item.packaging || []) {
    if (f?.name && !opts.some((o) => o.value.toLowerCase() === String(f.name).trim().toLowerCase())) {
      opts.push({ value: String(f.name).trim(), label: `${String(f.name).trim()} (${f.qtyInBase} ${base})` });
    }
  }
  opts.push({ value: 'batch', label: 'batch (one recipe yield)' });
  const cur = String(currentUnit || '').trim();
  if (cur && !opts.some((o) => o.value.toLowerCase() === cur.toLowerCase())) {
    // a known unit of the wrong dimension (the editor's old default 'L' on an each item) is stale too
    const ok = isKnownUnit(cur) && !COUNTED.has(cur.toLowerCase()) && unitDimension(cur) === unitDimension(base);
    opts.push({ value: cur, label: ok ? cur : `${cur} (not a unit this item understands)`, stale: !ok });
  }
  return opts;
}
