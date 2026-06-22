/**
 * costing.js — the stock costing engine (pack→unit cost, nested recipe roll-up, GP).
 *
 * Costing correctness is paramount, so this module is pure (no I/O, no store, no
 * Supabase) and fully unit-tested (costing.test.js). All money is per BASE UNIT of
 * the item; convert before you cost.
 *
 * Two cost models (kept strictly separate — see README):
 *   • PURCHASED item  → cost comes from invoices/pack history (item.currentCost,
 *                       £ per base unit). Derived from a supplier pack via
 *                       packBaseUnitCost().
 *   • MADE item       → cost is rolled up bottom-up from its recipe; a manual unit
 *                       cost is NEVER trusted for a MADE item.
 *
 * GP is computed against the NET (ex-VAT) selling price, matching the platform's
 * Daily Trading P&L which treats VAT as never-profit.
 */

import { convert } from './conversion.js';
import { toBase } from './uom.js';

/**
 * Derive the per-base-unit cost of a purchased item from a supplier pack.
 *
 * Worked example (from the brief): a crate of 24 cans @ £40, base unit "each":
 *   packQty=24, innerQty=1, innerUnit='each', packPrice=40, baseUnit='each'
 *   → baseContent = 24, baseUnitCost = 40 / 24 = £1.6667 per can.
 *
 * Pack-of-packs (1 box = 6 bottles × 0.75 L), base unit "ml":
 *   packQty=6, innerQty=0.75, innerUnit='l', packPrice=27, baseUnit='ml'
 *   → baseContent = convert(4.5, 'l', 'ml') = 4500, baseUnitCost = £0.006 per ml.
 *
 * NEVER store baseUnitCost as the only truth — persist the pack facts and re-derive
 * so a pack-size change recomputes correctly.
 *
 * @returns {{ baseContent:number, baseUnitCost:number }}
 */
export function packBaseUnitCost({ packPrice, packQty = 1, innerQty = 1, innerUnit, baseUnit, itemConversions = [] }) {
  const price = Number(packPrice);
  if (!Number.isFinite(price) || price < 0) throw new Error('packBaseUnitCost: packPrice must be a non-negative number');
  const contentInInner = Number(packQty) * Number(innerQty);
  if (!(contentInInner > 0)) throw new Error('packBaseUnitCost: packQty × innerQty must be > 0');
  const baseContent = (innerUnit && baseUnit && innerUnit !== baseUnit)
    ? convert(contentInInner, innerUnit, baseUnit, { itemConversions })
    : contentInInner;
  if (!(baseContent > 0)) throw new Error('packBaseUnitCost: resolved base content must be > 0');
  return { baseContent, baseUnitCost: price / baseContent };
}

/**
 * New moving-average cost after receiving stock (default valuation policy for food).
 *   new_avg = (onHand·oldAvg + recvQty·recvCost) / (onHand + recvQty)
 * All quantities/costs are per base unit. Falls back to recvCost when there is no
 * prior on-hand.
 */
export function movingAverageCost({ onHandQty = 0, currentAvg = 0, receivedQty, receivedUnitCost }) {
  const oh = Number(onHandQty) || 0;
  const rq = Number(receivedQty);
  const rc = Number(receivedUnitCost);
  if (!(rq > 0)) return Number(currentAvg) || 0;
  const denom = oh + rq;
  if (!(denom > 0)) return rc;
  return (oh * (Number(currentAvg) || 0) + rq * rc) / denom;
}

/**
 * @typedef {Object} CostingCtx
 * @property {Record<string, any>} itemsById            inventory items keyed by id
 *   each: { id, kind:'PURCHASED'|'MADE', baseUnit, currentCost?, itemConversions? }
 * @property {Record<string, any>} [recipesByOutputItem] MADE-item recipe keyed by output item id
 *   recipe: { outputItemId?, yieldQty, yieldUnit, wastagePct?, lines:[{componentItemId, qty, unit, usablePct?}] }
 * @property {Map<string, number>} [memo]               internal roll-up cache (created if absent)
 */

/**
 * Per-base-unit cost of any inventory item.
 * PURCHASED → item.currentCost. MADE → rolled-up recipe cost ÷ yield.
 * Detects cycles (A→B→A) and throws rather than looping forever; memoises so a
 * single price change recomputes the whole DAG in one pass.
 *
 * @param {string} itemId
 * @param {CostingCtx} ctx
 * @param {Set<string>} [stack] internal recursion guard
 * @returns {number} £ per base unit
 */
export function componentUnitCost(itemId, ctx, stack = new Set()) {
  if (!ctx.memo) ctx.memo = new Map();
  if (ctx.memo.has(itemId)) return ctx.memo.get(itemId);

  const item = ctx.itemsById?.[itemId];
  if (!item) throw new Error(`componentUnitCost: unknown inventory item "${itemId}"`);

  const recipe = ctx.recipesByOutputItem?.[itemId];
  // Treat as purchased when it has no production recipe (even if flagged MADE but
  // not yet costed) — use its stored currentCost.
  if (item.kind !== 'MADE' || !recipe) {
    const c = Number(item.currentCost);
    if (!Number.isFinite(c)) {
      throw new Error(`componentUnitCost: item "${itemId}" has no currentCost and no recipe`);
    }
    ctx.memo.set(itemId, c);
    return c;
  }

  if (stack.has(itemId)) {
    throw new Error(`componentUnitCost: recipe cycle detected at item "${itemId}" (${[...stack, itemId].join(' → ')})`);
  }
  stack.add(itemId);
  const { costPerYieldBase } = computeRecipe(recipe, item, ctx, stack);
  stack.delete(itemId);

  ctx.memo.set(itemId, costPerYieldBase);
  return costPerYieldBase;
}

/**
 * Compute a recipe's total cost and per-yield-unit cost.
 * @param {object} recipe   { yieldQty, yieldUnit, wastagePct?, lines:[...] }
 * @param {object} outputItem the item the recipe produces ({ baseUnit, itemConversions? })
 * @param {CostingCtx} ctx
 * @param {Set<string>} [stack]
 * @returns {{ totalCost:number, yieldBase:number, costPerYieldBase:number }}
 */
export function computeRecipe(recipe, outputItem, ctx, stack = new Set()) {
  if (!ctx.memo) ctx.memo = new Map();
  let total = 0;
  for (const line of recipe.lines || []) {
    const comp = ctx.itemsById?.[line.componentItemId];
    if (!comp) throw new Error(`computeRecipe: line references unknown item "${line.componentItemId}"`);
    const qtyBase = toBase(Number(line.qty), line.unit, comp);
    const usable = (line.usablePct == null ? 100 : Number(line.usablePct)) / 100;
    if (!(usable > 0)) throw new Error(`computeRecipe: usablePct must be > 0 (line "${line.componentItemId}")`);
    const unitCost = componentUnitCost(line.componentItemId, ctx, stack);
    total += (qtyBase / usable) * unitCost;
  }
  total *= 1 + (Number(recipe.wastagePct) || 0) / 100;

  const yieldUnit = recipe.yieldUnit || outputItem.baseUnit;
  const yieldBase = toBase(Number(recipe.yieldQty ?? 1), yieldUnit, outputItem);
  if (!(yieldBase > 0)) throw new Error('computeRecipe: recipe yield must convert to a positive base quantity');
  return { totalCost: total, yieldBase, costPerYieldBase: total / yieldBase };
}

/**
 * Cost a top-level recipe (a MENU plate or a PREP/BATCH sub-recipe).
 * For a plate, `totalCost` is the plate cost used for GP. Output item is resolved
 * from recipe.outputItemId, or recipe.output, or a synthetic 'each' yield.
 *
 * @param {object} recipe
 * @param {CostingCtx} ctx
 * @returns {{ totalCost:number, yieldBase:number, costPerYieldBase:number }}
 */
export function recipeCost(recipe, ctx) {
  if (!ctx.memo) ctx.memo = new Map();
  const outputItem = recipe.outputItemId
    ? ctx.itemsById?.[recipe.outputItemId]
    : (recipe.output || { baseUnit: recipe.yieldUnit || 'each', itemConversions: [] });
  if (!outputItem) throw new Error(`recipeCost: unknown output item "${recipe.outputItemId}"`);
  const stack = new Set(recipe.outputItemId ? [recipe.outputItemId] : []);
  return computeRecipe(recipe, outputItem, ctx, stack);
}

// ── Gross-profit helpers (against NET / ex-VAT selling price) ────────────────

/** Food-cost % = cost ÷ net price × 100. Returns null when price ≤ 0. */
export function foodCostPct(cost, netPrice) {
  const p = Number(netPrice);
  if (!(p > 0)) return null;
  return (Number(cost) / p) * 100;
}

/** GP in money = net price − cost. */
export function gpAmount(netPrice, cost) {
  return Number(netPrice) - Number(cost);
}

/** GP % = (net price − cost) ÷ net price × 100. Returns null when price ≤ 0. */
export function gpPct(netPrice, cost) {
  const p = Number(netPrice);
  if (!(p > 0)) return null;
  return ((p - Number(cost)) / p) * 100;
}
