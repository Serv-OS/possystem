// supabase/functions/_shared/allergenIds.js
//
// The one allergen alias table (v5.11.93, multi site stock Drop 2, contract 3.6). Moved word for
// word from src/lib/kioskAllergens.js (lines 16 to 58 as they were), so the till, the kiosk, the
// edge functions and the SQL twin (stock_co__allergen_ids, migration 20261025a) share one list.
// src/lib/kioskAllergens.js re exports everything here; its own functions stay there.
//
// Pure: NO imports, so node:test and Deno both load it.

// The 14 UK allergens, in the order the design's allergen sheet shows them.
export const UK_ALLERGENS = Object.freeze([
  'gluten', 'milk', 'eggs', 'fish', 'crustaceans', 'nuts', 'peanuts',
  'soy', 'sesame', 'celery', 'mustard', 'sulphites', 'molluscs', 'lupin',
]);

const UK_SET = new Set(UK_ALLERGENS);

// Other spellings seen in menu data, mapped to the menu editor id.
export const ALIASES = new Map(Object.entries({
  'cereals containing gluten': 'gluten',
  wheat: 'gluten',
  dairy: 'milk',
  lactose: 'milk',
  egg: 'eggs',
  soya: 'soy',
  soybean: 'soy',
  soybeans: 'soy',
  shellfish: 'crustaceans',
  crustacean: 'crustaceans',
  'tree nuts': 'nuts',
  'tree nut': 'nuts',
  treenuts: 'nuts',
  nut: 'nuts',
  peanut: 'peanuts',
  'sesame seeds': 'sesame',
  'sulphur dioxide': 'sulphites',
  'sulfur dioxide': 'sulphites',
  sulphite: 'sulphites',
  sulfites: 'sulphites',
  sulfite: 'sulphites',
  mollusc: 'molluscs',
  mollusk: 'molluscs',
  mollusks: 'molluscs',
  lupine: 'lupin',
}));

/** The menu editor id for an allergen value ('Dairy' gives 'milk'), or '' for nothing. */
export function normaliseAllergenId(value) {
  if (value === null || value === undefined) return '';
  const s = String(value).trim().toLowerCase().replace(/[\s_-]+/g, ' ');
  if (!s) return '';
  if (UK_SET.has(s)) return s;
  return ALIASES.get(s) || s;
}

/** True when the id is one of the 14 UK allergens. */
export function isUkAllergen(id) {
  return UK_SET.has(id);
}

/**
 * A list of allergen values as normalised ids, without repeats: the 14 in UK_ALLERGENS order
 * first, then any other id in plain code point order (the SQL twin stock_co__allergen_ids
 * sorts the rest the same way; the harness compares the two on random lists).
 */
export function allergenIds(list) {
  const seen = new Set();
  for (const v of (Array.isArray(list) ? list : [])) {
    const id = normaliseAllergenId(v);
    if (id) seen.add(id);
  }
  const known = UK_ALLERGENS.filter((id) => seen.has(id));
  const other = [...seen].filter((id) => !UK_SET.has(id)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return [...known, ...other];
}
