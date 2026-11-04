// supabase/functions/_shared/menuStockFacts.js
//
// The ONE merge rule for the stock facts a till product carries at one site (v5.11.93, multi site
// stock Drop 2, contract 3.6; table menu_item_stock_facts, migration 20261025a). Every channel
// reads the menu rows it always has and lays the facts over them here: the till (boot read and
// Push to POS snapshot), the kiosk, online and QR, catering, the booking widget, the menu boards,
// the print menu and the HubRise catalogue. The menu rows in the database are never changed.
//
// The rule: an item with a facts row shows the allergens that were TYPED on the menu (their own
// spelling, in order) plus every allergen the recipe at that site adds (by normalised id), never
// fewer than typed. It also gets `kcal` (a number or null) and `stockFacts` (needs check, may
// contain, diets, the ingredient declaration, when it was checked). Items with no row are left as
// they are, and with no rows at all the same array comes back.
//
// Pure: imports only allergenIds.js, so node:test and Deno both load it.

import { normaliseAllergenId, allergenIds } from './allergenIds.js';

export const KCAL_KEY = 'product.kcal';
export const KCAL_NOTE_KEY = 'product.kcalNote';
export const MAY_CONTAIN_KEY = 'product.mayContain';
export const ALLERGEN_CHECK_KEY = 'product.allergenCheck';

/** The English words of the four keys, for surfaces with no language picker (boards, print). */
export const KCAL_NOTE_EN = 'Adults need around 2,000 kcal a day';
// 5.12.57: a US venue prints the FDA statement and 'Cal' (21 CFR 101.11) instead of the UK line.
export const KCAL_NOTE_US = '2,000 calories a day is used for general nutrition advice, but calorie needs vary.';

// A string may be a currency ('USD') or a country ('US'); a row is read as regionPack.js regionOf
// reads it (a country first, else the currency). Kept here so this file imports only the alias table.
const US_WORDS = new Set(['US', 'USA', 'UNITED STATES', 'USD']);
const COUNTRY_WORDS = new Set(['US', 'USA', 'UNITED STATES', 'UK', 'GB', 'UNITED KINGDOM', 'IE', 'IRL', 'IRELAND']);
const isUs = (venue) => {
  if (venue == null || venue === '') return false;
  const up = (v) => String(v ?? '').trim().toUpperCase();
  if (typeof venue === 'string') return US_WORDS.has(up(venue));
  if (COUNTRY_WORDS.has(up(venue.country))) return US_WORDS.has(up(venue.country));
  return up(venue.currency) === 'USD';
};

/**
 * 5.12.57: the calorie line for a venue (a currency code, a country or a row): the FDA statement
 * at a US venue, else the UK line (through product.kcalNote when `t` is given, as before).
 */
export function kcalNoteFor(venue = null, t = null) {
  if (isUs(venue)) return KCAL_NOTE_US;
  const v = typeof t === 'function' ? t(KCAL_NOTE_KEY) : null;
  return typeof v === 'string' && v && v !== KCAL_NOTE_KEY ? v : KCAL_NOTE_EN;
}
export const ALLERGEN_CHECK_EN = 'Allergens being checked, ask staff';

const list = (v) => (Array.isArray(v) ? v.filter((x) => x != null && String(x).trim() !== '').map(String) : []);

const numberOrNull = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** The facts rows keyed by menu item id (as text). */
export function factsByItemId(rows) {
  const map = new Map();
  for (const r of (Array.isArray(rows) ? rows : [])) {
    if (!r || r.menu_item_id == null) continue;
    map.set(String(r.menu_item_id), r);
  }
  return map;
}

/** One item with its facts row laid over it (a new object; the item is not changed). */
export function withItemFacts(item, f) {
  if (!item || !f) return item;
  const typed = list(item.allergens);
  const have = new Set(typed.map(normaliseAllergenId).filter(Boolean));
  const extra = [];
  for (const id of allergenIds(f.allergens)) {
    if (have.has(id)) continue;
    have.add(id);
    extra.push(id);
  }
  return {
    ...item,
    allergens: [...typed, ...extra],
    kcal: numberOrNull(f.kcal),
    stockFacts: {
      needsCheck: f.needs_check === true,
      mayContain: allergenIds(f.may_contain),
      diets: list(f.diets),
      ingredientsText: typeof f.ingredients_text === 'string' && f.ingredients_text.trim() ? f.ingredients_text : null,
      checkedAt: f.checked_at || null,
    },
  };
}

/**
 * The items with their facts rows laid over them. The same array when there are no facts rows or
 * none of them names an item here; otherwise a new array where only the items with a row changed.
 *   items      menu rows (raw snake case or mapped camel case: only `id` and `allergens` are read)
 *   factsRows  menu_item_stock_facts rows, or a Map from factsByItemId
 */
export function mergeStockFacts(items, factsRows) {
  if (!Array.isArray(items) || !items.length) return items;
  const facts = factsRows instanceof Map ? factsRows : factsByItemId(factsRows);
  if (!facts.size) return items;
  let changed = false;
  const out = items.map((it) => {
    if (!it || it.id == null) return it;
    const f = facts.get(String(it.id));
    if (!f) return it;
    changed = true;
    return withItemFacts(it, f);
  });
  return changed ? out : items;
}

/** Show calories: the one venue setting, locations.pos_settings.show_calories (decision 12). */
export function showCalories(posSettings) {
  return !!posSettings && typeof posSettings === 'object' && posSettings.show_calories === true;
}

/**
 * '146 kcal' through the i18n key product.kcal ('{n} kcal'). `t` is the i18n t function; with
 * none, or a t that does not know the key, the English words. '' when there is no figure.
 */
export function kcalWords(kcal, t = null, venue = null) {
  const n = numberOrNull(kcal);
  if (n === null || n < 0) return '';
  const shown = String(Math.round(n));
  if (isUs(venue)) return `${shown} Cal`;   // 5.12.57: the FDA's word on a US menu
  const tpl = typeof t === 'function' ? t(KCAL_KEY) : null;
  if (typeof tpl === 'string' && tpl.includes('{n}')) return tpl.replace('{n}', shown);
  return `${shown} kcal`;
}

/** 'May contain: Milk, Nuts' through product.mayContain; '' when the list is empty. */
export function mayContainWords(labels, t = null) {
  const names = list(labels);
  if (!names.length) return '';
  const joined = names.join(', ');
  const tpl = typeof t === 'function' ? t(MAY_CONTAIN_KEY) : null;
  if (typeof tpl === 'string' && tpl.includes('{list}')) return tpl.replace('{list}', joined);
  return `May contain: ${joined}`;
}
