/**
 * stock/recipeRules.js: the rules behind the company recipe screens (multi site stock Drop 2,
 * mockup scrRecipes and scrRecipe, contract 3.2). Pure: no browser, no database, so node --test
 * drives every rule (recipeRules.test.js). The screens in src/backoffice/sections/produce/ only
 * draw what these answer and call the save functions (stockApi). Nothing here decides who may
 * save: the database does (stock_co__guard); these only grey what it would refuse.
 *
 *   recipeTabs(multi), startTabOf          the tabs of the recipe page
 *   KIND_WORDS, FOOD_KIND_WORDS, HOW_WORDS  Dish, Batch, Prep; Food, Drink, Meal deal; Bought in...
 *   rangeWords, gpWords, costWords          '85.0% to 87.0%', '41p avg', '£3.20 to £3.40'
 *   priceForTargetGp, belowTarget           the Under and Below target rules
 *   siteRowModel(site, detail, costs)       one row of the Sites tab
 *   FIELD_WORDS, conflictRows               someone saved first
 *   allergenLabel, factsWords, cardSteps    the Allergens tab, the facts line, the recipe card
 *   toCompanyLines, lineUnitOptions         the lines editor in the company form
 *   filtersToServer, exportRows             the list
 *   detailsDraft, detailsPatch, recipeFields  the Details tab and create mode
 */

import { ALLERGENS } from '../../data/seed.js';
import { UNITS } from './units.js';
import { money } from '../currency.js';
import { conflictRows as itemConflictRows, changeWords as itemChangeWords, valueWords } from './itemPageRules.js';
import { sitesText } from './siteScope.js';
import { fmtVenueDate } from '../venueDate.js';

const num = (v) => (v == null || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
const round = (v, places = 3) => { const f = 10 ** places; return Math.round(Number(v) * f) / f; };
const text = (v) => { const s = String(v ?? '').trim(); return s === '' ? null : s; };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── Tabs ─────────────────────────────────────────────────────────────────────

const TABS = Object.freeze([
  Object.freeze({ id: 'details', value: 'details', key: 'details', label: 'Details' }),
  Object.freeze({ id: 'ingredients', value: 'ingredients', key: 'ingredients', label: 'Ingredients' }),
  Object.freeze({ id: 'sites', value: 'sites', key: 'sites', label: 'Sites' }),
  Object.freeze({ id: 'allergens', value: 'allergens', key: 'allergens', label: 'Allergens and nutrition' }),
  Object.freeze({ id: 'card', value: 'card', key: 'card', label: 'Recipe card' }),
  Object.freeze({ id: 'changes', value: 'changes', key: 'changes', label: 'Changes' }),
]);

/** Details, Ingredients, Sites, Allergens and nutrition, Recipe card, Changes (no Sites tab when not multi). */
export function recipeTabs(multi) {
  return multi ? TABS.slice() : TABS.filter((t) => t.value !== 'sites');
}

/** The tab the page opens on: the asked one when it is there, else Details. */
export function startTabOf(tabs, wanted) {
  return (tabs || []).some((t) => t.value === wanted) ? wanted : 'details';
}

// ── Words ────────────────────────────────────────────────────────────────────

export const KIND_WORDS = Object.freeze({ dish: 'Dish', batch: 'Batch', prep: 'Prep' });
export const KIND_CHOICES = Object.freeze([
  Object.freeze({ value: 'dish', label: 'Dish' }),
  Object.freeze({ value: 'batch', label: 'Batch' }),
  Object.freeze({ value: 'prep', label: 'Prep' }),
]);
export const FOOD_KIND_WORDS = Object.freeze({ food: 'Food', drink: 'Drink', meal_deal: 'Meal deal' });
export const FOOD_KIND_CHOICES = Object.freeze([
  Object.freeze({ value: 'food', label: 'Food' }),
  Object.freeze({ value: 'drink', label: 'Drink' }),
  Object.freeze({ value: 'meal_deal', label: 'Meal deal' }),
]);
export const HOW_WORDS = Object.freeze({ bought: 'Bought in', batches: 'Made here', to_order: 'Made to order' });
export const HOW_CHOICES = Object.freeze([
  Object.freeze({ value: 'bought', label: 'Bought in' }),
  Object.freeze({ value: 'batches', label: 'Made here' }),
  Object.freeze({ value: 'to_order', label: 'Made to order' }),
]);
export const RESOLVED_WORDS = Object.freeze({ msm: 'menu', master_id: 'master', name: 'name', hand: 'by hand' });

const KIND_TO_TYPE = Object.freeze({ dish: 'MENU', batch: 'BATCH', prep: 'PREP' });
const TYPE_TO_KIND = Object.freeze({ MENU: 'dish', BATCH: 'batch', PREP: 'prep' });

/** The company kind (dish, batch, prep) as the recipe_type the save function reads (MENU, BATCH, PREP). */
export const kindToType = (kind) => KIND_TO_TYPE[kind] || 'MENU';
/** A site recipe_type back to the company kind. */
export const typeToKind = (type) => TYPE_TO_KIND[String(type || '').toUpperCase()] || 'dish';

/** '85.0%' from a number; '' for nothing. */
export function pctWords(v) {
  const n = num(v);
  return n == null ? '' : `${n.toFixed(1)}%`;
}

/**
 * A range in words: one value when low and high read the same ('85.0%'), else 'low to high'
 * ('85.0% to 87.0%', '£3.20 to £3.40'). Nothing on both sides is ''.
 */
export function rangeWords(low, high, fmt = (v) => String(v)) {
  const l = num(low);
  const h = num(high);
  if (l == null && h == null) return '';
  if (l == null || h == null) return fmt(l ?? h);
  const a = fmt(Math.min(l, h));
  const b = fmt(Math.max(l, h));
  return a === b ? a : `${a} to ${b}`;
}

/** GP in words: '85.0%' or '85.0% to 87.0%'. */
export function gpWords(low, high) {
  return rangeWords(low, high, pctWords);
}

/** A cost in words: under one pound reads in pence ('41p'); else money ('£2.14'). Other currencies: money. */
export function costWords(v, currency = null) {
  const n = num(v);
  if (n == null) return '';
  const sym = money(0, currency).replace(/[0-9.,]/g, '');
  if (sym === '£' && Math.abs(n) < 1 && n !== 0) return `${Math.round(Math.abs(n) * 100)}p`;
  return money(n, currency);
}

/** The Cost (avg) cell of the company view: '41p avg'; the one site view reads '41p'. */
export function costAvgWords(v, currency = null, { oneSite = false } = {}) {
  const w = costWords(v, currency);
  if (!w) return '';
  return oneSite ? w : `${w} avg`;
}

/** A price range in words: '£3.20' or '£3.20 to £3.40'. */
export function priceWords(low, high, currency = null) {
  return rangeWords(low, high, (v) => money(v, currency));
}

/** The price a plate must sell at (net) to hit the target GP: cost / (1 - target / 100). */
export function priceForTargetGp(cost, targetPct) {
  const c = num(cost);
  const t = num(targetPct);
  if (c == null || t == null || t >= 100) return null;
  return round(c / (1 - t / 100), 4);
}

/** Below target: the lowest GP in scope sits under the recipe's target (the server's flag wins when it is there). */
export function belowTarget(row) {
  if (!row) return false;
  if (typeof row.below_target === 'boolean') return row.below_target;
  const gp = num(row.gp_low ?? row.gp_pct);
  const target = num(row.gp_target_pct);
  return gp != null && target != null && gp < target;
}

/** Under: one site's GP sits under the target. */
export function underTarget(gpPct, targetPct) {
  const g = num(gpPct);
  const t = num(targetPct);
  return g != null && t != null && g < t;
}

/** '2 recipes change at 5 sites' / '1 recipe changes at 1 site'. */
export function swapWords({ recipes = 0, sites = 0 } = {}) {
  const r = Number(recipes) || 0;
  const s = Number(sites) || 0;
  return `${r} recipe${r === 1 ? ' changes' : 's change'} at ${s} site${s === 1 ? '' : 's'}`;
}

/** 'When the customer picks Oat milk then replace Whole milk with Oat milk' / '... then remove Cheddar'. */
export function optionRuleWords(rule, names = {}) {
  const r = rule || {};
  const known = (id) => (id && names && names[id]) || null;
  const nameOf = (id, fallback) => known(id) || fallback || 'an ingredient';
  const option = r.option_name || known(r.option_company_item_id) || r.option_item_name || 'the option';
  if (r.kind === 'remove') return `When the customer picks ${option} then remove ${nameOf(r.removes_item_id, r.removes_item_name)}`;
  return `When the customer picks ${option} then replace ${nameOf(r.replaces_item_id, r.replaces_item_name)} with ${nameOf(r.option_company_item_id, r.option_item_name)}`;
}

/** The pill of one site under an option rule: 'Found at Leeds (menu)' or 'Not found at Leeds: link it'. */
export function optionSiteWords(siteRow, siteName) {
  const name = siteName || 'this site';
  if (!siteRow || !siteRow.site_modifier_id) return { found: false, words: `Not found at ${name}: link it` };
  return { found: true, words: `Found at ${name} (${RESOLVED_WORDS[siteRow.resolved_by] || siteRow.resolved_by || 'by hand'})` };
}

/** 'Latte is on at Leeds. 4 ingredients were ticked there.' */
export function tickWords(recipeName, siteName, itemsAdded) {
  const n = Number(itemsAdded) || 0;
  return `${recipeName} is on at ${siteName}. ${n} ingredient${n === 1 ? ' was' : 's were'} ticked there.`;
}

/** The untick question. */
export function untickWords(recipeName, siteName) {
  return `Take ${recipeName} off ${siteName}? Its till product is unlinked and its sales there show under Recipe missing.`;
}

/** The archive question. */
export function archiveWords(recipeName) {
  return `Archive ${recipeName}? Its till products are unlinked at every site. Archived recipes keep their history.`;
}

/** 'Sales totals cover the last 7 days.' */
export function daysHeldWords(n) {
  const d = Number(n) || 0;
  return `Sales totals cover the last ${d} day${d === 1 ? '' : 's'}.`;
}

/** The 'Not yet' refusal of Made to order while a site holds the made item (55000). */
export function notYetWords(error) {
  const words = error?.message || String(error || '');
  const is = (error?.code === '55000' || /still holds/i.test(words)) && /Made to order/i.test(words);
  return is ? { title: 'Not yet', words, note: 'That stock would never come off if sales took the raw ingredients instead.' } : null;
}

/** A cost line that could not be costed: 'No price yet', 'Unit not understood', 'Not at <site>'. */
export function missingWords(why, siteName = '') {
  const w = String(why || '').toLowerCase();
  if (w.includes('price') || w.includes('cost')) return 'No price yet';
  if (w.includes('unit') || w.includes('pack') || w.includes('usable')) return 'Unit not understood';
  if (w.includes('site') || w.includes('not at') || w.includes('item')) return siteName ? `Not at ${siteName}` : 'Not at this site';
  return why ? String(why) : 'Not costed';
}

/** '<Dish> · <Drink> · sold as <Latte Regular> · target GP 80%' (sold as 'Not linked yet' when nothing is). */
export function subLine(recipe, soldAs = []) {
  const r = recipe || {};
  const names = [...new Set((soldAs || []).filter(Boolean))];
  const parts = [KIND_WORDS[r.kind] || 'Dish'];
  if (FOOD_KIND_WORDS[r.food_kind]) parts.push(FOOD_KIND_WORDS[r.food_kind]);
  parts.push(`sold as ${names.length ? names.slice(0, 3).join(', ') + (names.length > 3 ? ` and ${names.length - 3} more` : '') : 'Not linked yet'}`);
  if (num(r.gp_target_pct) != null) parts.push(`target GP ${round(num(r.gp_target_pct), 1)}%`);
  return parts.join(' · ');
}

/** The Sites cell of the list: 'All 7', '5 of 7', '<site>', 'Local to <site>', 'None yet'. */
export function sitesCell({ onIds, scopeIds, siteById, localId = null } = {}) {
  const w = sitesText({ onIds, scopeIds, siteById, localId });
  return w === 'None here' ? 'None yet' : w;
}

/** The yield in words: '10 L', '20 patties', '1 plate' for a dish with no yield. */
export function yieldWords(recipe, outputName = '') {
  const r = recipe || {};
  const q = num(r.yield_qty);
  const unit = text(r.yield_unit);
  if (r.kind === 'dish' && (q == null || q === 1) && (!unit || unit === 'each')) return '1 plate';
  if (q == null) return outputName || '';
  const u = unit === 'each' ? (outputName || 'each') : (unit || 'each');
  return `${round(q, 3)} ${u}`;
}

/** 'Cost (eat in)' for a dish; 'Batch cost' for a batch or prep. */
export function totalLabel(recipe) {
  return (recipe?.kind || 'dish') === 'dish' ? 'Cost (eat in)' : 'Batch cost';
}

/** 'Cost per L' for a batch or prep (its yield unit, or the made item's base unit). */
export function perYieldLabel(recipe, baseUnit = 'each') {
  const unit = text(recipe?.yield_unit) || baseUnit || 'each';
  return `Cost per ${unit}`;
}

// ── Allergens and facts ──────────────────────────────────────────────────────

const LABELS = Object.freeze(Object.fromEntries((ALLERGENS || []).map((a) => [a.id, a.label])));

/** The label of an allergen id ('Tree nuts' for nuts); an unknown id reads as its own word. */
export function allergenLabel(id) {
  const k = String(id ?? '').trim().toLowerCase();
  if (!k) return '';
  if (LABELS[k]) return LABELS[k];
  return k[0].toUpperCase() + k.slice(1).replace(/_/g, ' ');
}

/** 'Milk, Gluten' from a list of ids; '' for none. */
export function allergenWords(ids) {
  const list = [...new Set((Array.isArray(ids) ? ids : []).filter(Boolean).map((x) => String(x).trim().toLowerCase()))];
  return list.map(allergenLabel).join(', ');
}

/**
 * The Checked cell of a facts row: 'Not checked yet' (neutral), 'Checked by <name>, <day>' (good)
 * or 'Check again: <words>' (warn). tz is the venue's time zone for the day.
 */
export function factsWords(row, tz = null) {
  const r = row || {};
  if (r.needs_check) {
    const w = String(r.check_words || '').trim();
    const words = w ? (w.toLowerCase().startsWith('check again') ? w : `Check again: ${w}`) : 'Check again: the ingredients changed';
    return { state: 'check_again', tone: 'warn', words };
  }
  if (r.checked_at) {
    const day = fmtVenueDate(r.checked_at, tz, { year: false });
    const who = text(r.checked_by_name) || 'someone';
    return { state: 'checked', tone: 'good', words: day ? `Checked by ${who}, ${day}` : `Checked by ${who}` };
  }
  return { state: 'not_checked', tone: 'neutral', words: 'Not checked yet' };
}

/** Signed off: checked and nothing to check again (the PPDS label prints only then). */
export function signedOff(row) {
  return !!row && !!row.checked_at && !row.needs_check;
}

/** The PPDS refusal words. */
export const PPDS_NOT_CHECKED = 'Check the allergens first. The label prints once the recipe is checked.';

/** The one site facts line: the pieces in order (allergens, may contain, kcal). */
export function factsLineWords(row) {
  const r = row || {};
  const out = [];
  const al = allergenWords(r.allergens);
  out.push(al ? `Allergens: ${al}` : 'Allergens: none from the ingredients yet');
  const mc = allergenWords(r.may_contain);
  if (mc) out.push(`May contain: ${mc}`);
  const kcal = num(r.kcal);
  if (kcal != null) out.push(`${Math.round(kcal)} kcal a portion`);
  return out;
}

/**
 * Method text to steps: numbered lines ('1. Grind', '2) Steam') lose their number; else blank
 * lines break the steps; else each line is a step. An array is kept as it is.
 */
export function cardSteps(method) {
  if (Array.isArray(method)) return method.map((s) => String(s ?? '').trim()).filter(Boolean);
  const t = String(method ?? '').replace(/\r\n?/g, '\n').trim();
  if (!t) return [];
  const lines = t.split('\n').map((l) => l.trim());
  const numbered = lines.filter(Boolean).every((l) => /^\d+[.)]\s*/.test(l));
  if (numbered) return lines.filter(Boolean).map((l) => l.replace(/^\d+[.)]\s*/, '')).filter(Boolean);
  if (/\n\s*\n/.test(t)) return t.split(/\n\s*\n/).map((p) => p.replace(/\s*\n\s*/g, ' ').trim()).filter(Boolean);
  return lines.filter(Boolean);
}

// ── Lines in the company form ────────────────────────────────────────────────

/** The unit token a line shows: '@' plus the company pack id for a pack line, else its unit code. */
export function lineToken(line) {
  const l = line || {};
  if (l.pack_id) return `@${l.pack_id}`;
  const u = String(l.unit || '').trim();
  if (u.startsWith('@') && u.length > 1) return u;
  return u && u !== '@' ? u : (l.base_unit || 'each');
}

let keySeq = 0;
/** The detail read's lines in the editor's shape (a client key on each). */
export function editorLinesOf(detailLines) {
  return (detailLines || []).filter(Boolean).map((l, i) => ({
    key: l.id || l.key || `line-${++keySeq}-${i}`,
    id: l.id || null,
    component_item_id: l.component_item_id,
    name: l.name || '',
    base_unit: l.base_unit || 'each',
    kind_at_site: l.kind_at_site || null,
    qty: l.qty == null ? '' : l.qty,
    unit: lineToken(l),
    pack_id: l.pack_id || null,
    packs: Array.isArray(l.packs) ? l.packs : [],
    usable_pct: l.usable_pct == null ? 100 : l.usable_pct,
    order_types: Array.isArray(l.order_types) && l.order_types.length ? l.order_types : null,
    note: l.note || null,
    sort_order: l.sort_order ?? i,
  }));
}

/** A new editor line for a picked item (itemsPage row plus its packs from the detail read). */
export function newEditorLine(item, packs = [], { orderTypes = null } = {}) {
  const it = item || {};
  return {
    key: `new-${++keySeq}`,
    id: null,
    component_item_id: it.id,
    name: it.name || '',
    base_unit: it.base_unit || 'each',
    kind_at_site: null,
    qty: 1,
    unit: it.base_unit || 'each',
    pack_id: null,
    packs: (packs || []).filter((p) => p && !p.archived_at).map((p) => ({ id: p.id, name: p.name, qty_in_base: p.qty_in_base })),
    usable_pct: 100,
    order_types: Array.isArray(orderTypes) && orderTypes.length ? orderTypes : null,
    note: null,
    sort_order: 0,
  };
}

/**
 * The editor's lines as stock_save_recipe p_lines (the company form): a pack token '@<pack id>'
 * becomes unit '@' with pack_id; a line with no item or a quantity of 0 or less is left out.
 */
export function toCompanyLines(lines) {
  const out = [];
  for (const l of lines || []) {
    if (!l || !l.component_item_id) continue;
    const qty = num(l.qty);
    if (qty == null || qty <= 0) continue;
    const token = lineToken(l);
    const row = {
      component_item_id: l.component_item_id,
      qty,
      usable_pct: num(l.usable_pct) == null ? 100 : num(l.usable_pct),
      sort_order: out.length,
      note: text(l.note),
      order_types: Array.isArray(l.order_types) && l.order_types.length ? l.order_types : null,
    };
    if (token.startsWith('@')) { row.unit = '@'; row.pack_id = token.slice(1); } else { row.unit = token; }
    out.push(row);
  }
  return out;
}

/** Every line's quantity times the factor (6 places), for Make sizes and Clone previews. */
export function scaleLines(lines, factor) {
  const f = num(factor);
  if (f == null || f <= 0) return (lines || []).slice();
  return (lines || []).map((l) => ({ ...l, qty: l && num(l.qty) != null ? round(num(l.qty) * f, 6) : l?.qty }));
}

/**
 * The unit choices of one line: its item's packs first (largest first, '@' plus the pack id,
 * labelled by the pack name), the base unit, then the other units of the same dimension.
 */
export function lineUnitOptions(line, units = UNITS) {
  const l = line || {};
  const base = l.base_unit || 'each';
  const dim = units[base]?.dimension || null;
  const out = [];
  const packs = [...(l.packs || [])].filter((p) => p && p.id).sort((a, b) => Number(b.qty_in_base) - Number(a.qty_in_base));
  for (const p of packs) out.push({ token: `@${p.id}`, label: `${p.name} (${String(round(num(p.qty_in_base) ?? 0, 3))} ${base})` });
  out.push({ token: base, label: base });
  for (const [code, u] of Object.entries(units)) if (code !== base && dim && u.dimension === dim) out.push({ token: code, label: code });
  const cur = lineToken(l);
  if (cur && !out.some((o) => o.token === cur)) out.unshift({ token: cur, label: cur.startsWith('@') ? (l.pack_name || 'pack') : cur });
  return out;
}

// ── Someone saved first ──────────────────────────────────────────────────────

/** The recipe's fields in plain words (the change log and the saved first table). */
export const FIELD_WORDS = Object.freeze({
  name: 'Name',
  kind: 'Kind',
  recipe_type: 'Kind',
  food_kind: 'Type',
  meal_food_pct: 'Food %',
  output_item_id: 'Made item',
  yield_qty: 'Yield',
  yield_unit: 'Yield unit',
  portion_weight_g: 'Portion weight (g)',
  cooking_yield_pct: 'Cooking yield (%)',
  wastage_pct: 'Wastage (%)',
  shelf_life_days: 'Shelf life (days)',
  gp_target_pct: 'Target GP (%)',
  msm_product_id: 'Menu product',
  photo: 'Photo link',
  method: 'Method',
  lines: 'Ingredients',
  local_location_id: 'Local to',
  archived_at: 'Archived',
  on_here: 'On at site',
  menu_item_id: 'Till product',
  site_menu_item_id: 'Till product',
  portion: 'Portion',
  how: 'How the site gets it',
  supply_mode: 'How the site gets it',
  why_on: 'Why it is here',
  linked_at: 'Linked',
  option_rule: 'Option rule',
  sizes: 'Sizes',
  restricted: 'Restricted',
  updated_by: 'Changed by',
  created: 'Made',
  suggestion: 'Suggested change',
});

/** The saved first table rows for a recipe: the fields where two versions differ. */
export function conflictRows(draft, fresh, fieldWords = FIELD_WORDS, opts = {}) {
  return itemConflictRows(draft, fresh, fieldWords || FIELD_WORDS, opts);
}

/** One change log row of a recipe as { who, what, old, new }, the recipe's field words first. */
export function recipeChangeWords(row, siteById, opts = {}) {
  const r = row || {};
  const field = r.field || '';
  const base = itemChangeWords(r, siteById, opts);
  // the item rule already says these in full (Ticked at <site>, Made, Suggested a change, the cost)
  if (['on_here', 'created', 'suggestion', 'current_cost'].includes(field) || r.kind === 'cost' || !FIELD_WORDS[field]) return base;
  const site = siteNameOf(siteById, r.location_id);
  const what = site ? `${FIELD_WORDS[field]}, ${site}` : FIELD_WORDS[field];
  const words = (v, table) => (v == null ? 'None' : (table[v] || valueWords(field, v, opts)));
  if (field === 'kind' || field === 'recipe_type') {
    const w = (v) => (v == null ? 'None' : KIND_WORDS[v] || KIND_WORDS[typeToKind(v)] || valueWords(field, v, opts));
    return { ...base, what, old: w(r.before), new: w(r.after) };
  }
  if (field === 'food_kind') return { ...base, what, old: words(r.before, FOOD_KIND_WORDS), new: words(r.after, FOOD_KIND_WORDS) };
  if (field === 'how' || field === 'supply_mode') return { ...base, what, old: words(r.before, HOW_WORDS), new: words(r.after, HOW_WORDS) };
  return { ...base, what };
}

function siteNameOf(siteById, id) {
  if (!id || !siteById) return '';
  if (typeof siteById === 'function') return siteById(id) || '';
  if (siteById instanceof Map) { const s = siteById.get(id); return (typeof s === 'string' ? s : s?.name) || ''; }
  const s = siteById[id];
  return (typeof s === 'string' ? s : s?.name) || '';
}

// ── One row of the Sites tab ─────────────────────────────────────────────────

/**
 * One row of the Sites tab from one site of the login's list, the detail read, and (when given) the
 * live costs of stock_recipe_cost keyed by location_id ({ total, per_yield, missing }).
 */
export function siteRowModel(site, detail, costs = null) {
  const recipe = detail?.recipe || {};
  const id = site?.id ?? site?.location_id ?? null;
  const row = (detail?.sites || []).find((s) => s && s.location_id === id) || null;
  const live = costs && typeof costs.get === 'function' ? costs.get(id) : (costs ? costs[id] : null);
  const cost = live && live.total != null ? num(live.total) : num(row?.cost);
  const net = num(row?.sale_price_net);
  const gp = cost != null && net != null && net > 0 ? ((net - cost) / net) * 100 : num(row?.gp_pct);
  const target = num(recipe.gp_target_pct);
  const under = underTarget(gp, target);
  return {
    siteId: id,
    name: site?.name || row?.name || '',
    currency: site?.currency || null,
    on: !!row?.on,
    siteRecipeId: row?.site_recipe_id || null,
    menuItemId: row?.menu_item_id || null,
    menuItemName: row?.menu_item_name || '',
    salePrice: num(row?.sale_price),
    salePriceNet: net,
    cost,
    perYield: live ? num(live.per_yield) : num(row?.cost_per_yield),
    missing: Array.isArray(live?.missing) ? live.missing : [],
    gpPct: gp,
    target,
    under,
    priceForTarget: under ? (num(row?.price_for_target) ?? priceForTargetGp(cost, target)) : null,
    sold7d: num(row?.sold_7d),
    sales7dNet: num(row?.sales_7d_net),
    how: row?.how || null,
    holds: num(row?.holds),
    why: row?.why_on || '',
    linkedAt: row?.linked_at || null,
    linkRowVersion: row?.link_row_version ?? null,
    needsCheck: !!row?.needs_check,
    checkedByName: row?.checked_by_name || '',
    checkedAt: row?.checked_at || null,
  };
}

/** The Cost at choices of the Ingredients tab: Company average, then every site the recipe is on. */
export function costAtOptions(detail, siteName = null) {
  const out = [{ value: 'avg', label: 'Company average' }];
  for (const s of detail?.sites || []) {
    if (!s || !s.on) continue;
    out.push({ value: s.location_id, label: s.name || (typeof siteName === 'function' ? siteName(s.location_id) : '') || 'Site' });
  }
  return out;
}

/** The first site on in reach (the cost site of the detail read), else the first site named. */
export function costSiteOf(detail, fallback = null) {
  if (detail?.cost_site) return detail.cost_site;
  const on = (detail?.sites || []).find((s) => s && s.on);
  return on?.location_id || (detail?.sites || [])[0]?.location_id || fallback || null;
}

// ── The list ─────────────────────────────────────────────────────────────────

/** The filter boxes as the screen holds them. `site` is 'on:<id>' or 'not:<id>'. */
export const BLANK_FILTERS = Object.freeze({
  kind: '', foodKind: '', site: '',
  belowTarget: false, checkWaiting: false, notLinked: false, local: false, archived: false,
});

/** The chips under the search box, in the mockup's order. */
export const FILTER_CHIPS = Object.freeze([
  { key: 'belowTarget', label: 'Below target' },
  { key: 'checkWaiting', label: 'Check waiting' },
  { key: 'notLinked', label: 'Not linked' },
  { key: 'local', label: 'Local' },
  { key: 'archived', label: 'Archived' },
]);

/** True when any filter box or chip is set. */
export function filtersActive(ui) {
  const f = { ...BLANK_FILTERS, ...(ui || {}) };
  return !!(f.kind || f.foodKind || f.site || f.belowTarget || f.checkWaiting || f.notLinked || f.local || f.archived);
}

/**
 * The screen's filters to stock_recipes_page p_filters (contract 1.7). Only known keys go; nothing
 * set answers null. oneId (the one site view) sets on_at and drops the site box.
 */
export function filtersToServer(ui, oneId = null) {
  const f = { ...BLANK_FILTERS, ...(ui || {}) };
  const out = {};
  if (KIND_WORDS[f.kind]) out.kind = f.kind;
  if (FOOD_KIND_WORDS[f.foodKind]) out.food_kind = f.foodKind;
  if (oneId) out.on_at = oneId;
  else if (typeof f.site === 'string' && f.site.startsWith('on:') && f.site.length > 3) out.on_at = f.site.slice(3);
  else if (typeof f.site === 'string' && f.site.startsWith('not:') && f.site.length > 4) out.not_at = f.site.slice(4);
  if (f.belowTarget) out.below_target = true;
  if (f.checkWaiting) out.check_waiting = true;
  if (f.notLinked) out.not_linked = true;
  if (f.local) out.local = true;
  if (f.archived) out.archived = true;
  return Object.keys(out).length ? out : null;
}

const COLS = Object.freeze({
  name: { key: 'name', label: 'Name' },
  type: { key: 'type', label: 'Type' },
  sold_as: { key: 'sold_as', label: 'Sold as' },
  sites: { key: 'sites', label: 'Sites' },
  cost: { key: 'cost', label: 'Cost (avg)', right: true },
  cost_here: { key: 'cost', label: 'Cost here', right: true },
  price: { key: 'price', label: 'Price', right: true },
  price_here: { key: 'price', label: 'Price here', right: true },
  gp: { key: 'gp', label: 'GP %', right: true },
  target: { key: 'target', label: 'Target', right: true },
  allergens: { key: 'allergens', label: 'Allergens' },
});

/** The columns: company view (Sites, Cost (avg), Price) or one site view (Cost here, Price here). */
export function listColumns({ oneSite = null } = {}) {
  const keys = oneSite
    ? ['name', 'type', 'sold_as', 'cost_here', 'price_here', 'gp', 'target', 'allergens']
    : ['name', 'type', 'sold_as', 'sites', 'cost', 'price', 'gp', 'target', 'allergens'];
  return keys.map((k) => ({ ...COLS[k] }));
}

/** The row's site figures at one site (the one site view), or null. */
export function siteFiguresOf(row, siteId) {
  return (row?.sites || []).find((s) => s && s.location_id === siteId) || null;
}

/** The Type cell: the food kind, with the kind when it is not a dish ('Drink', 'Food · Batch'). */
export function typeCell(row) {
  const parts = [];
  if (FOOD_KIND_WORDS[row?.food_kind]) parts.push(FOOD_KIND_WORDS[row.food_kind]);
  if (row?.kind && row.kind !== 'dish') parts.push(KIND_WORDS[row.kind] || row.kind);
  return parts.join(' · ');
}

/** 'Sold as': the till product names, 'Not linked yet' when none. */
export function soldAsWords(row) {
  const names = [...new Set((row?.sold_as || []).filter(Boolean))];
  return names.length ? names.join(', ') : '';
}

/** The CSV of the list: every figure a column. scope: { sites, siteById }. */
export function exportRows(rows, scope = {}) {
  const sites = scope.sites || [];
  const scopeIds = sites.map((s) => s.id);
  const siteById = scope.siteById || new Map(sites.map((s) => [s.id, s]));
  const headers = [
    { key: 'name', label: 'Name' }, { key: 'kind', label: 'Kind' }, { key: 'type', label: 'Type' }, { key: 'sold_as', label: 'Sold as' },
    { key: 'sites', label: 'Sites' }, { key: 'cost_avg', label: 'Cost (avg)' }, { key: 'price_low', label: 'Price low' },
    { key: 'price_high', label: 'Price high' }, { key: 'gp_low', label: 'GP low %' }, { key: 'gp_high', label: 'GP high %' },
    { key: 'target', label: 'Target GP %' }, { key: 'below', label: 'Below target' }, { key: 'allergens', label: 'Allergens' },
  ];
  const out = (rows || []).map((r) => ({
    name: r.name || '',
    kind: KIND_WORDS[r.kind] || '',
    type: FOOD_KIND_WORDS[r.food_kind] || '',
    sold_as: (r.sold_as || []).join('; '),
    sites: sitesCell({ onIds: (r.sites || []).filter((s) => s.on).map((s) => s.location_id), scopeIds, siteById, localId: r.local_location_id }),
    cost_avg: num(r.cost_avg) == null ? '' : String(round(num(r.cost_avg), 4)),
    price_low: num(r.price_low) == null ? '' : String(round(num(r.price_low), 2)),
    price_high: num(r.price_high) == null ? '' : String(round(num(r.price_high), 2)),
    gp_low: num(r.gp_low) == null ? '' : String(round(num(r.gp_low), 1)),
    gp_high: num(r.gp_high) == null ? '' : String(round(num(r.gp_high), 1)),
    target: num(r.gp_target_pct) == null ? '' : String(round(num(r.gp_target_pct), 1)),
    below: belowTarget(r) ? 'Yes' : '',
    allergens: allergenWords(r.allergens),
  }));
  return { headers, rows: out };
}

/** The export file name: 'recipes-2026-10-21.csv'. */
export const exportFileName = (todayIso) => `recipes-${String(todayIso || '').slice(0, 10) || 'export'}.csv`;

// ── Details and create ───────────────────────────────────────────────────────

const strOrEmpty = (v) => (v == null ? '' : String(v));

/** The Details form from a company recipe row (or nothing: a new recipe). */
export function detailsDraft(recipe) {
  const r = recipe || {};
  return {
    name: r.name || '',
    kind: KIND_WORDS[r.kind] ? r.kind : 'dish',
    food_kind: FOOD_KIND_WORDS[r.food_kind] ? r.food_kind : (r.id ? '' : 'food'),
    meal_food_pct: strOrEmpty(r.meal_food_pct),
    output_item_id: r.output_item_id || null,
    output_item_name: r.output_item_name || '',
    yield_qty: r.yield_qty == null ? '1' : String(r.yield_qty),
    yield_unit: r.yield_unit || 'each',
    portion_weight_g: strOrEmpty(r.portion_weight_g),
    cooking_yield_pct: strOrEmpty(r.cooking_yield_pct),
    wastage_pct: r.wastage_pct == null ? '0' : String(r.wastage_pct),
    shelf_life_days: strOrEmpty(r.shelf_life_days),
    gp_target_pct: strOrEmpty(r.gp_target_pct),
    msm_product_id: r.msm_product_id || null,
    photo: r.photo || '',
    method: r.method || '',
  };
}

const PCT = (label) => (v) => {
  const n = num(v);
  if (n == null) return null;
  if (n < 0 || n > 100) return `${label} is a number from 0 to 100.`;
  return null;
};

/**
 * The Details form cleaned into the save function's keys: name, recipe_type (the kind as MENU, BATCH
 * or PREP), food_kind, meal_food_pct, output_item_id, yield_qty, yield_unit, portion_weight_g,
 * cooking_yield_pct, wastage_pct, shelf_life_days, gp_target_pct, msm_product_id, photo, method.
 * Answer { fields, error }: error is the plain words when a field cannot be saved as typed.
 */
export function recipeFields(draft) {
  const d = draft || {};
  const name = text(d.name);
  if (!name) return { fields: null, error: 'Give the recipe a name.' };
  const kind = KIND_WORDS[d.kind] ? d.kind : 'dish';
  if (kind !== 'dish' && !d.output_item_id) return { fields: null, error: 'Choose the made item this batch produces.' };
  const yieldQty = num(d.yield_qty);
  if (yieldQty == null || yieldQty <= 0) return { fields: null, error: 'Yield is a number above 0.' };
  for (const [k, label] of [['meal_food_pct', 'Food %'], ['cooking_yield_pct', 'Cooking yield'], ['wastage_pct', 'Wastage'], ['gp_target_pct', 'Target GP']]) {
    const e = PCT(label)(d[k]);
    if (e) return { fields: null, error: e };
  }
  const pw = num(d.portion_weight_g);
  if (pw != null && pw < 0) return { fields: null, error: 'Portion weight is 0 or more.' };
  let shelf = null;
  if (String(d.shelf_life_days ?? '').trim() !== '') {
    const n = Number(d.shelf_life_days);
    if (!Number.isInteger(n) || n < 0) return { fields: null, error: 'Shelf life is a whole number of days.' };
    shelf = n;
  }
  const fields = {
    name,
    recipe_type: kindToType(kind),
    food_kind: FOOD_KIND_WORDS[d.food_kind] ? d.food_kind : null,
    meal_food_pct: d.food_kind === 'meal_deal' ? num(d.meal_food_pct) : null,
    output_item_id: kind === 'dish' ? null : d.output_item_id,
    yield_qty: yieldQty,
    yield_unit: text(d.yield_unit) || 'each',
    portion_weight_g: pw,
    cooking_yield_pct: num(d.cooking_yield_pct),
    wastage_pct: num(d.wastage_pct) ?? 0,
    shelf_life_days: shelf,
    gp_target_pct: num(d.gp_target_pct),
    msm_product_id: d.msm_product_id || null,
    photo: text(d.photo),
    method: text(d.method),
  };
  return { fields, error: null };
}

const sameField = (a, b) => {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  if (typeof a === 'number' || typeof b === 'number') return Number(a) === Number(b);
  return String(a) === String(b);
};

/**
 * What the Details Save sends: only the fields that differ from the recipe as loaded. A kind change
 * from dish to batch or prep needs the made item; back to dish clears it (the server's rule).
 * Answer { patch, error }.
 */
export function detailsPatch(draft, recipe) {
  const { fields, error } = recipeFields(draft);
  if (error) return { patch: null, error };
  const before = recipeFields({ ...detailsDraft(recipe), name: recipe?.name || '(none)' }).fields || {};
  const patch = {};
  for (const k of Object.keys(fields)) {
    if (k === 'output_item_id' && fields.recipe_type === 'MENU' && before.output_item_id == null) continue;
    if (!sameField(fields[k], before[k])) patch[k] = fields[k];
  }
  // a kind change always travels with the made item, so the server reads both together
  if (patch.recipe_type && fields.recipe_type !== 'MENU' && !('output_item_id' in patch)) patch.output_item_id = fields.output_item_id;
  return { patch, error: null };
}

/** The fields of a copy: the same recipe named '<name> (copy)' (or as typed), no menu product. */
export function cloneFields(detail, name) {
  const r = detail?.recipe || {};
  const draft = detailsDraft(r);
  draft.name = text(name) || `${r.name || 'Recipe'} (copy)`;
  draft.msm_product_id = null;
  const { fields } = recipeFields(draft);
  return fields;
}

/** The sites a Clone or a new recipe starts at: [{ location_id, on: true, menu_item_id: null }]. */
export function sitesArg(ids) {
  return [...new Set((ids || []).filter((id) => typeof id === 'string' && UUID.test(id)))].map((id) => ({ location_id: id, on: true, menu_item_id: null }));
}

// ── Make sizes and swap ──────────────────────────────────────────────────────

/** The sizes rows cleaned: [{ name, factor }], at most 10. Answer { sizes, error }. */
export function sizesPlan(rows) {
  const list = (rows || []).map((r) => ({ name: text(r?.name), factor: num(r?.factor) })).filter((r) => r.name || r.factor != null);
  if (!list.length) return { sizes: null, error: 'Add at least one size.' };
  if (list.length > 10) return { sizes: null, error: 'Make up to 10 sizes at a time.' };
  for (const r of list) {
    if (!r.name) return { sizes: null, error: 'Give every size a name.' };
    if (r.factor == null || r.factor <= 0) return { sizes: null, error: `The factor of ${r.name} is a number above 0.` };
  }
  const names = new Set();
  for (const r of list) {
    const k = r.name.toLowerCase();
    if (names.has(k)) return { sizes: null, error: `Two sizes are named ${r.name}.` };
    names.add(k);
  }
  return { sizes: list, error: null };
}

/** '<n> sizes made.' */
export function sizesMadeWords(n) {
  const k = Number(n) || 0;
  return `${k} size${k === 1 ? '' : 's'} made.`;
}

/**
 * The Swap an ingredient form as stock_swap_ingredient p_spec. form: { mode, fromItemId, toItemId,
 * scope ('all' | 'chosen'), recipeIds, amountHow ('qty' | 'factor'), qty, unit, factor }.
 * Answer { spec, error }.
 */
export function swapSpec(form) {
  const f = form || {};
  if (!f.fromItemId) return { spec: null, error: 'Pick the ingredient to change.' };
  const recipeIds = f.scope === 'chosen' ? [...new Set((f.recipeIds || []).filter(Boolean))] : null;
  if (f.scope === 'chosen' && !recipeIds.length) return { spec: null, error: 'Tick at least one recipe, or choose Every recipe using it.' };
  if (f.mode === 'amount') {
    if (f.amountHow === 'factor') {
      const factor = num(f.factor);
      if (factor == null || factor <= 0) return { spec: null, error: 'The factor is a number above 0.' };
      return { spec: { mode: 'amount', from_item_id: f.fromItemId, recipe_ids: recipeIds, factor }, error: null };
    }
    const qty = num(f.qty);
    const unit = text(f.unit);
    if (qty == null || qty <= 0) return { spec: null, error: 'The amount is a number above 0.' };
    if (!unit) return { spec: null, error: 'Pick a unit.' };
    return { spec: { mode: 'amount', from_item_id: f.fromItemId, recipe_ids: recipeIds, qty, unit }, error: null };
  }
  if (!f.toItemId) return { spec: null, error: 'Pick the ingredient to swap in.' };
  if (f.toItemId === f.fromItemId) return { spec: null, error: 'Pick two different ingredients.' };
  return { spec: { mode: 'swap', from_item_id: f.fromItemId, to_item_id: f.toItemId, recipe_ids: recipeIds }, error: null };
}

/** A line of the swap preview in words: '30 ml Whole milk'. */
export function lineWords(line) {
  if (!line) return '';
  const q = num(line.qty);
  return [q == null ? '' : String(round(q, 3)), line.unit || '', line.name || ''].filter(Boolean).join(' ');
}
