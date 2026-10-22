/**
 * stock/factsRules.js: the pure rules behind "What is in it" on a supplier item (multi site stock
 * Drop 2, contract 3.4 and 4.4). What a site buys says what is in a dish: the 14 allergens, may
 * contain, diet tags, the ingredient list in weight order, nutrition per 100 g or 100 ml, and who
 * checked it and when. These rules only shape drafts, patches and words; the database decides who
 * may save (stock_save_supplier_item) and rolls the allergens up to the item and every recipe.
 *
 *   DIET_IDS, DIET_LABELS, DIETS        the diet tags ServOS knows (the Menu Manager ids plus three)
 *   NUTRITION_FIELDS                     the eight numbers per 100 g, in the order the screen shows
 *   allergenLabels(ids)                  seed labels ('Tree nuts') in the order of the 14
 *   allergenWords(ids)                   'Milk, Gluten' or 'none'
 *   factsOf(si)                          the facts of one supplier item, whatever shape the read has
 *   factsDraft(si) / factsPatch(draft)   the screen's draft and the patch stock_save_supplier_item takes
 *   checkedWords(name, at, tz)           'Checked by Pat, 18 Oct' or 'Not checked yet'
 *   savedFactsWords(itemName)            the toast after a save
 *   differRule(facts, itemName)          the allergen rule words, or null when every supplier agrees
 *   newItemName, supplierItemSiteIds, makeNewItemPlan   Make it a new item
 *
 * Pure: no React, no database. Unit tested in factsRules.test.js with made up names.
 */

import { ALLERGENS } from '../../data/seed.js';
import { UK_ALLERGENS, normaliseAllergenId, orderIds } from '../kioskAllergens.js';
import { fmtVenueDate } from '../venueDate.js';

// ── allergens ─────────────────────────────────────────────────────────────────

const SEED_LABEL = new Map((ALLERGENS || []).map((a) => [a.id, a.label]));

/** The allergen ids of a stored list: normalised, once each, the 14 first in their order. */
export function allergenIds(list) {
  const out = [];
  for (const v of (Array.isArray(list) ? list : [])) {
    const id = normaliseAllergenId(v);
    if (id && !out.includes(id)) out.push(id);
  }
  return orderIds(out);
}

/** One allergen id in words: the seed label for one of the 14 ('nuts' is 'Tree nuts'), else as typed with a capital. */
export function allergenLabel(id) {
  const key = normaliseAllergenId(id);
  if (!key) return '';
  if (SEED_LABEL.has(key)) return SEED_LABEL.get(key);
  return key.charAt(0).toUpperCase() + key.slice(1);
}

/** The labels of a list, in the order of the 14 then the rest. */
export function allergenLabels(ids) {
  return allergenIds(ids).map(allergenLabel).filter(Boolean);
}

/** 'Milk, Gluten', or 'none' for an empty list. */
export function allergenWords(ids) {
  const labels = allergenLabels(ids);
  return labels.length ? labels.join(', ') : 'none';
}

/** The 14 as { id, label } in the sheet's order (the chips). */
export const ALLERGEN_CHIPS = Object.freeze(UK_ALLERGENS.map((id) => Object.freeze({ id, label: allergenLabel(id) })));

// ── diets ─────────────────────────────────────────────────────────────────────

/** The diet ids the database knows (stock_co__diet_ids): the Menu Manager tags plus the three free ones. */
export const DIET_IDS = Object.freeze(['vegan', 'vegetarian', 'pescatarian', 'halal', 'kosher', 'gluten_free', 'dairy_free', 'nut_free']);

export const DIET_LABELS = Object.freeze({
  vegan: 'Vegan',
  vegetarian: 'Vegetarian',
  pescatarian: 'Pescatarian',
  halal: 'Halal',
  kosher: 'Kosher',
  gluten_free: 'Gluten free',
  dairy_free: 'Dairy free',
  nut_free: 'Nut free',
});

export const DIETS = Object.freeze(DIET_IDS.map((id) => Object.freeze({ id, label: DIET_LABELS[id] })));

/** A stored diet value to its id ('Gluten-free', 'gluten free' and 'GLUTEN_FREE' are gluten_free); '' for nothing. */
export function normaliseDietId(value) {
  const s = String(value ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  return s;
}

/** Diet ids of a stored list: known ids only, once each, in DIET_IDS order. */
export function dietIds(list) {
  const set = new Set((Array.isArray(list) ? list : []).map(normaliseDietId));
  return DIET_IDS.filter((id) => set.has(id));
}

/** 'Vegan, Gluten free' or 'none'. */
export function dietWords(list) {
  const labels = dietIds(list).map((id) => DIET_LABELS[id]);
  return labels.length ? labels.join(', ') : 'none';
}

// ── nutrition ─────────────────────────────────────────────────────────────────

/** Per 100 g or 100 ml, in the order the screen shows them (contract 4.4). */
export const NUTRITION_FIELDS = Object.freeze([
  Object.freeze({ key: 'kcal', label: 'kcal', unit: 'kcal' }),
  Object.freeze({ key: 'fat_g', label: 'Fat', unit: 'g' }),
  Object.freeze({ key: 'saturates_g', label: 'of which saturates', unit: 'g' }),
  Object.freeze({ key: 'carbs_g', label: 'Carbs', unit: 'g' }),
  Object.freeze({ key: 'sugars_g', label: 'of which sugars', unit: 'g' }),
  Object.freeze({ key: 'protein_g', label: 'Protein', unit: 'g' }),
  Object.freeze({ key: 'salt_g', label: 'Salt', unit: 'g' }),
  Object.freeze({ key: 'fibre_g', label: 'Fibre', unit: 'g' }),
]);

const NUTRITION_KEYS = NUTRITION_FIELDS.map((f) => f.key);

const numOrNull = (v) => (v == null || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null));

/** A stored nutrition object with every key, numbers or null (unknown keys left out). */
export function nutritionOf(value) {
  const src = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return Object.fromEntries(NUTRITION_KEYS.map((k) => [k, numOrNull(src[k])]));
}

/** True when every nutrition number is empty. */
export const nutritionEmpty = (n) => NUTRITION_KEYS.every((k) => n?.[k] == null);

// ── the facts of one supplier item ────────────────────────────────────────────

const str = (v) => (v == null ? '' : String(v));

/**
 * The facts of one supplier item from the stock_item_detail read: the Drop 2 `facts` object when it
 * is there, else the 0a columns on the row. Always the same shape:
 * { allergens, may_contain, diets, ingredients_text, nutrition, checked_by_name, checked_at }.
 */
export function factsOf(si) {
  const s = si || {};
  const f = s.facts && typeof s.facts === 'object' ? s.facts : {};
  return {
    allergens: allergenIds(f.allergens ?? s.allergens),
    may_contain: allergenIds(f.may_contain ?? s.may_contain),
    diets: dietIds(f.diets ?? s.diets),
    ingredients_text: str(f.ingredients_text ?? s.ingredients_text),
    nutrition: nutritionOf(f.nutrition ?? s.nutrition),
    checked_by_name: str(f.checked_by_name ?? s.facts_checked_by_name ?? '') || null,
    checked_at: f.checked_at ?? s.facts_checked_at ?? null,
  };
}

/** The screen's draft: lists, the text, and every nutrition number as text ('' for none). */
export function factsDraft(si) {
  const f = factsOf(si);
  return {
    allergens: [...f.allergens],
    may_contain: [...f.may_contain],
    diets: [...f.diets],
    ingredients_text: f.ingredients_text,
    nutrition: Object.fromEntries(NUTRITION_KEYS.map((k) => [k, f.nutrition[k] == null ? '' : String(f.nutrition[k])])),
  };
}

const sameList = (a, b) => JSON.stringify([...(a || [])].sort()) === JSON.stringify([...(b || [])].sort());

/**
 * What stock_save_supplier_item takes from the draft (contract 3.4: all five keys every time):
 * { patch, changed, error }. error in words when a nutrition box is not a number from 0 up; changed
 * false when nothing differs from the supplier item it was read from.
 */
export function factsPatch(draft, si) {
  const d = draft || {};
  const nutrition = {};
  for (const f of NUTRITION_FIELDS) {
    const raw = d.nutrition?.[f.key];
    const t = String(raw ?? '').trim();
    if (t === '') { nutrition[f.key] = null; continue; }
    const v = Number(t);
    if (!Number.isFinite(v) || v < 0) return { patch: null, changed: false, error: `${f.label} per 100 g must be a number from 0 up.` };
    nutrition[f.key] = v;
  }
  const patch = {
    allergens: allergenIds(d.allergens),
    may_contain: allergenIds(d.may_contain),
    diets: dietIds(d.diets),
    ingredients_text: String(d.ingredients_text ?? '').trim() || null,
    nutrition,
  };
  const was = factsOf(si);
  const changed = !sameList(patch.allergens, was.allergens) || !sameList(patch.may_contain, was.may_contain) || !sameList(patch.diets, was.diets)
    || (patch.ingredients_text || '') !== (was.ingredients_text || '').trim()
    || NUTRITION_KEYS.some((k) => (patch.nutrition[k] ?? null) !== (was.nutrition[k] ?? null));
  return { patch, changed, error: null };
}

/** 'Checked by Pat Lee, 18 Oct', or 'Not checked yet'. */
export function checkedWords(name, at, tz = null) {
  if (!at) return 'Not checked yet';
  const day = fmtVenueDate(at, tz, { year: false });
  const who = String(name || '').trim() || 'someone';
  return day ? `Checked by ${who}, ${day}` : `Checked by ${who}`;
}

/** The toast after What is in it saves (contract 4.4). */
export function savedFactsWords(itemName) {
  return `Saved. Every recipe using ${itemName || 'this item'} at every site now shows these allergens.`;
}

// ── the allergen rule ─────────────────────────────────────────────────────────

/** True when two live supplier items declare different allergen sets (the fallback when the read has no `differ`). */
export function factsDiffer(from) {
  const list = (Array.isArray(from) ? from : []).map((x) => allergenIds(x?.allergens).join(','));
  return new Set(list).size > 1;
}

/**
 * The allergen rule (contract 3.4): every supplier item on one stock item must declare the same
 * allergens. When two differ: { words, supplierB, supplierA, allergens, supplierItemId } where B has
 * what A does not, else null. Reads `facts.differ` from the database when it is there, else works it
 * out from `facts.from`. The words are the contract's, exactly.
 */
export function differRule(facts, itemName) {
  const from = Array.isArray(facts?.from) ? facts.from.filter(Boolean) : [];
  const differ = facts?.differ === true || (facts?.differ == null && factsDiffer(from));
  if (!differ || from.length < 2) return null;
  // B: the supplier item declaring the most; A: one that lacks something B has
  const sorted = from.map((x) => ({ ...x, ids: allergenIds(x.allergens) })).sort((a, b) => b.ids.length - a.ids.length);
  const b = sorted[0];
  const a = sorted.find((x) => x !== b && b.ids.some((id) => !x.ids.includes(id))) || sorted[sorted.length - 1];
  const extra = b.ids.filter((id) => !(a.ids || []).includes(id));
  const has = allergenWords(extra.length ? extra : b.ids);
  const item = String(itemName || 'item').trim();
  const words = `The ${item} from ${b.supplier_name || 'one supplier'} has ${has} and the one from ${a.supplier_name || 'another supplier'} does not. Make it a new item so each site buys what it says.`;
  return { words, supplierB: b.supplier_name || null, supplierA: a.supplier_name || null, allergens: extra.length ? extra : b.ids, supplierItemId: b.supplier_item_id || null };
}

// ── Make it a new item ────────────────────────────────────────────────────────

/** 'Brioche bun (Hill Bakery)'. */
export function newItemName(itemName, supplierName) {
  const item = String(itemName || '').trim();
  const sup = String(supplierName || '').trim();
  return sup ? `${item} (${sup})` : item;
}

/** The sites where a supplier item is on (its site rows that are not off there), as ids. */
export function supplierItemSiteIds(si) {
  const out = [];
  for (const s of (Array.isArray(si?.sites) ? si.sites : [])) {
    if (!s || !s.location_id || s.off_here === true) continue;
    if (!out.includes(s.location_id)) out.push(s.location_id);
  }
  return out;
}

export const OLD_PACK_WORDS = 'The old supplier pack is archived, never deleted. Orders and invoices keep it.';

const copyNum = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

/**
 * Make it a new item (contract 3.4, decision 7): { item, sites, si, error }.
 *   item   the new company item: the same base unit, category and type as this one
 *   sites  [{ location_id, on: true }] from the ticked sites (the supplier item's sites pre ticked)
 *   si     a copy of the supplier item with its facts, for saveSupplierItem under the new item
 * Nothing moves between items: the old supplier item is archived by the caller, never deleted.
 */
export function makeNewItemPlan(detail, si, { name = null, siteIds = [] } = {}) {
  const item = detail?.item || {};
  const s = si || {};
  const newName = String(name ?? newItemName(item.name, s.supplier_name)).trim();
  if (!newName) return { item: null, sites: null, si: null, error: 'Give the new item a name.' };
  const ticked = [...new Set((siteIds || []).filter(Boolean))];
  if (!ticked.length) return { item: null, sites: null, si: null, error: 'Tick at least one site.' };
  if (!s.supplier_id) return { item: null, sites: null, si: null, error: 'This supplier pack has no supplier.' };
  const f = factsOf(s);
  const newItem = { location_id: ticked[0], name: newName, base_unit: item.base_unit || 'each' };
  if (item.category_id) newItem.category_id = item.category_id;
  if (item.type) newItem.type = item.type;
  if (item.purchase_vat_rate != null) newItem.purchase_vat_rate = item.purchase_vat_rate;
  const copy = {
    supplier_id: s.supplier_id,
    supplier_product_name: s.supplier_product_name || null,
    supplier_sku: s.sku || s.supplier_sku || null,
    pack_qty: copyNum(s.pack_qty) ?? 1,
    inner_qty: copyNum(s.inner_qty) ?? 1,
    inner_unit: s.inner_unit || item.base_unit || 'each',
    pack_description: s.pack_description || `${copyNum(s.pack_qty) ?? 1} x ${copyNum(s.inner_qty) ?? 1} ${s.inner_unit || item.base_unit || 'each'}`,
    pack_price: copyNum(s.pack_price) ?? 0,
    purchase_vat_rate: copyNum(s.purchase_vat_rate),
    price_includes_tax: s.price_includes_tax === true,
    ...(s.currency ? { currency: s.currency } : {}),
    allergens: f.allergens,
    may_contain: f.may_contain,
    diets: f.diets,
    ingredients_text: f.ingredients_text || null,
    nutrition: f.nutrition,
  };
  return { item: newItem, sites: ticked.map((id) => ({ location_id: id, on: true })), si: copy, error: null };
}

/** The words after Make it: what was done, and what did not happen when a later step failed. */
export function madeNewItemWords(newName, supplierName, missed = []) {
  const base = `${newName} saved. ${supplierName ? `${supplierName}'s pack is under it now.` : ''}`.trim();
  const list = (missed || []).filter(Boolean);
  if (!list.length) return `${base} ${OLD_PACK_WORDS}`.trim();
  return `${base} ${list.join(' ')}`.trim();
}
