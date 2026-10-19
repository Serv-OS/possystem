/**
 * stock/phase0Rules.js: the pure rules of the stock safety pass (v5.11.79, multi site stock plan
 * Phase 0). No React, no Supabase: tested in phase0Rules.test.js. The database half is
 * supabase/migrations/20261019b_OPS_stock_phase0.sql (proof: supabase/tests/stock_phase0/run.mjs).
 *
 *   newUuid                   a client made id (waste events), safe on older WebViews
 *   isMissingFunctionError    a call to a function the database does not have yet (before 20261019b)
 *   COST_RULES, priceSetsCost the per venue cost rule (decision 2): price list (default) or deliveries
 *   wasteStockTag             why a product waste took nothing off stock (never a refusal)
 *   openingCostOf             the cost an item's opening count is valued at, when the screen knows one
 *   approvalOutcome           the words after a count approval in one database call
 *   invoiceOutcome            the words after an invoice posted in one database call
 *   recipeGapWords            the Multi site menu's read only "recipe at Provo, none at Location 2" line
 */

import { pickSupplierProduct } from '../../../supabase/functions/_shared/purchasingRules.js';

/** A v4 uuid for a client made id (a waste event, so a retry never records twice). */
export function newUuid() {
  try { if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID(); } catch { /* fall through */ }
  const h = '0123456789abcdef';
  let out = '';
  for (let i = 0; i < 36; i++) {
    if (i === 8 || i === 13 || i === 18 || i === 23) { out += '-'; continue; }
    if (i === 14) { out += '4'; continue; }
    const r = Math.floor(Math.random() * 16);
    out += i === 19 ? h[(r & 3) | 8] : h[r];
  }
  return out;
}

/** True when the error says the database function is not there (PGRST202, 42883, or the wording). */
export function isMissingFunctionError(error) {
  if (!error) return false;
  const msg = `${error.code || ''} ${error.message || ''} ${error.details || ''} ${error.hint || ''}`;
  if (/PGRST202|42883/.test(msg)) return true;
  return /could not find the function|function .* does not exist/i.test(msg);
}

// ── Cost rule per venue (plan 4.5, decision 2) ─────────────────────────────────────────────────────
export const COST_RULES = Object.freeze(['price_list', 'deliveries']);
export const DEFAULT_COST_RULE = 'price_list';
export const COST_RULE_WORDS = Object.freeze({
  price_list: {
    label: 'Cost from the price list',
    help: 'A supplier price change sets the cost of the item here at once (what every venue does today). Deliveries still move the average.',
  },
  deliveries: {
    label: 'Cost from deliveries',
    help: 'The cost is the average of what was paid on deliveries. A supplier price change only sets the cost of an item that has never been received.',
  },
});
export const normCostRule = (rule) => (COST_RULES.includes(rule) ? rule : DEFAULT_COST_RULE);

/**
 * May saving a supplier price change this item's cost here?
 *   price_list (default): yes, as today.
 *   deliveries: only for an item that has never been received, or has no cost yet (an unknown cost
 *   is never left standing when a price is known).
 * A price of 0 or less never sets a cost (a cost is never 0).
 */
export function priceSetsCost({ rule = DEFAULT_COST_RULE, newCost, currentCost = null, everReceived = false } = {}) {
  if (!(Number(newCost) > 0)) return false;
  if (normCostRule(rule) === 'price_list') return true;
  if (!(Number(currentCost) > 0)) return true;
  return !everReceived;
}

// ── Waste is never refused (plan 4.7) ───────────────────────────────────────────────────────────────
export const NO_RECIPE_WORDS = 'No recipe: stock not taken off';
/**
 * Why a product waste took nothing off stock, or null when it did. Never a refusal: the waste is
 * recorded all the same, by product, with the lost sale, and tagged so someone adds the recipe.
 *   'no_recipe'          the product has no recipe linked
 *   'nothing_to_deduct'  a recipe is linked but nothing in it can come off stock (no lines, an
 *                        ingredient missing, a unit that will not convert)
 */
export function wasteStockTag({ linked = false, rows = [] } = {}) {
  if (Array.isArray(rows) && rows.length > 0) return null;
  return linked ? 'nothing_to_deduct' : 'no_recipe';
}
/** The line the till and Back Office show under a product with no stock behind it. */
export function wasteTagText(tag) {
  if (tag === 'no_recipe') return `${NO_RECIPE_WORDS}. It is recorded with the lost sale; link a recipe in Back Office, Recipes, so the next one comes off stock.`;
  if (tag === 'nothing_to_deduct') return 'Its recipe takes nothing off stock (check its ingredients and units in Back Office, Recipes). It is recorded with the lost sale.';
  return '';
}

// ── Opening count (plan 4.6) ────────────────────────────────────────────────────────────────────────
/**
 * The cost an item's opening count is valued at, from what the screen knows: the item's cost here,
 * else its supplier price per base unit (the preferred pack, the default supplier's, else the
 * cheapest). Null when nothing is known: the manager types one (a count is never valued at 0).
 * `item`: a fetchInventoryItems item (currentCost, supplierProducts[].baseUnitCost).
 */
export function openingCostOf(item) {
  if (!item) return null;
  if (Number(item.currentCost) > 0) return Number(item.currentCost);
  const sp = pickSupplierProduct(item);
  if (sp && Number(sp.baseUnitCost) > 0) return Number(sp.baseUnitCost);
  const any = (item.supplierProducts || []).map((p) => Number(p?.baseUnitCost)).filter((c) => c > 0).sort((a, b) => a - b)[0];
  return any > 0 ? any : null;
}

/**
 * The p_costs the approval sends: for each item the database says needs a cost, the cost the screen
 * knows (openingCostOf) or the one the manager typed (typed: { itemId: '0.85' }, per base unit).
 * Returns { costs: { itemId: number }, missing: [{ itemId, name }] }.
 */
export function openingCosts(needs, itemsById = {}, typed = {}) {
  const costs = {};
  const missing = [];
  for (const n of needs || []) {
    const id = n?.item_id || n?.itemId;
    if (!id) continue;
    const t = Number(String(typed?.[id] ?? '').replace(',', '.'));
    const known = openingCostOf(itemsById[id]);
    const c = t > 0 ? t : known;
    if (c > 0) costs[id] = c; else missing.push({ itemId: id, name: n?.name || itemsById[id]?.name || 'An item' });
  }
  return { costs, missing };
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The words after approve_stock_count (its jsonb answer). */
export function approvalOutcome(res) {
  if (!res) return { ok: false, text: 'The count was not approved: no answer from the database. Approve again (nothing posts twice).' };
  if (res.ok === false) {
    if (res.code === 'needs_cost') {
      const names = (res.needs_cost || []).map((n) => n.name).filter(Boolean);
      return { ok: false, needsCost: res.needs_cost || [], text: `Not approved yet: ${plural(names.length, 'item')} counted for the first time ${names.length === 1 ? 'has' : 'have'} no cost (${names.slice(0, 5).join(', ')}${names.length > 5 ? ', ...' : ''}). Enter a cost for each, so opening stock is never valued at 0.` };
    }
    return { ok: false, text: `Not approved: ${res.error || 'the database refused it'}. Nothing was posted.` };
  }
  if (res.duplicate) return { ok: true, text: 'This count was approved already. Nothing posted twice.' };
  const parts = [];
  const total = Number(res.total) || 0;
  const opening = Number(res.opening) || 0;
  parts.push(total === 0 ? 'Count approved. Nothing differed from the system, so no stock moved.' : `Count approved: ${plural(total, 'line')} adjusted, stock reconciled.`);
  if (opening > 0) parts.push(`${plural(opening, 'line')} ${opening === 1 ? 'was' : 'were'} opening stock (left out of The Gap).`);
  parts.push('Each line was worked out from the moment it was counted, so sales during the count are not added back.');
  return { ok: true, text: parts.join(' ') };
}

/** The words after stock_post_invoice (its jsonb answer), or a database error. */
export function invoiceOutcome(res, error = null, lineCount = 0) {
  if (error) {
    const msg = `${error.code || ''} ${error.message || error}`;
    if (/23505|supplier_invoices_posted_number_uniq|duplicate key/i.test(msg)) return { ok: false, text: 'That invoice number from this supplier is posted already at this venue. Nothing was posted again.' };
    return { ok: false, text: error.message || String(error) };
  }
  if (!res) return { ok: false, text: 'The invoice was not posted: no answer from the database.' };
  if (res.ok === false) return { ok: false, code: res.code || null, text: res.error || 'The invoice was refused.' };
  if (res.duplicate === true) return { ok: true, duplicate: true, text: 'This invoice was posted already. Nothing was posted twice.' };
  if (res.stock === false) return { ok: true, text: 'Invoice posted as paperwork for an order received already: its stock is in, nothing was counted twice.' };
  return { ok: true, text: `Posted invoice: ${plural(lineCount, 'line')} received into stock.` };
}

// ── Multi site menu: recipes at one site and not another (read only, plan Phase 0) ──────────────────
/**
 * The words for msm_stock_recipe_gaps rows ({ site_name, missing, from_site_name, from_count }):
 * "3 products have a recipe at Provo but none at Location 2." One sentence per site, most first.
 */
export function recipeGapWords(rows) {
  return (Array.isArray(rows) ? rows : [])
    .filter((r) => r && Number(r.missing) > 0)
    .sort((a, b) => Number(b.missing) - Number(a.missing))
    .map((r) => {
      const n = Number(r.missing);
      const from = r.from_site_name || 'another site';
      return `${n} product${n === 1 ? '' : 's'} ${n === 1 ? 'has' : 'have'} a recipe at ${from} but none at ${r.site_name || 'a site'}.`;
    });
}
