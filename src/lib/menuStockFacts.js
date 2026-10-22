// src/lib/menuStockFacts.js
//
// The web side of the stock facts (v5.11.93, multi site stock Drop 2, contract 3.6). The merge
// rule itself lives in supabase/functions/_shared/menuStockFacts.js (one copy for the browser and
// the edge functions); this file re exports it and adds the two reads a channel makes:
//
//   fetchMenuStockFacts(client, locationId, { ids })   the venue's facts rows, paged past the
//                                                       1,000 row cap; a failed or missing table
//                                                       answers { rows: [], error } and the
//                                                       caller keeps the typed allergens
//   withFacts(client, locationId, items)               read then merge; never throws; the same
//                                                       array when nothing could be added
//
// Back Office panels read through stockApi.menuStockFacts (lib/stock/companyData.js) instead.
// Pure: the Supabase client is passed in (node:test drives it with a fake).

import { readAllRows } from './venueMenuRead.js';
import { mergeStockFacts, kcalWords } from '../../supabase/functions/_shared/menuStockFacts.js';
import { allergenIds } from '../../supabase/functions/_shared/allergenIds.js';

export {
  mergeStockFacts, withItemFacts, factsByItemId, showCalories, kcalWords, mayContainWords,
  KCAL_KEY, KCAL_NOTE_KEY, MAY_CONTAIN_KEY, ALLERGEN_CHECK_KEY, KCAL_NOTE_EN, ALLERGEN_CHECK_EN,
} from '../../supabase/functions/_shared/menuStockFacts.js';
export { allergenIds, normaliseAllergenId, UK_ALLERGENS } from '../../supabase/functions/_shared/allergenIds.js';

export const FACTS_TABLE = 'menu_item_stock_facts';
export const FACTS_IDS_CHUNK = 200;   // the most ids one .in() list carries

const canRead = (client, locationId) =>
  !!client && typeof client.from === 'function' && !!locationId && locationId !== 'loc-demo';

/**
 * The facts rows of one venue, every page, ordered by menu item id. With `ids`, only those
 * products (read in lists of 200). A failed page, a missing table (before 20261025a) or no
 * client answers { rows: [], error } so the caller shows the typed allergens as today.
 */
export async function fetchMenuStockFacts(client, locationId, { ids = null } = {}) {
  if (!canRead(client, locationId)) return { rows: [], error: null };
  const loc = String(locationId);
  const want = Array.isArray(ids) ? [...new Set(ids.filter((x) => x != null && x !== '').map(String))] : null;
  if (want && !want.length) return { rows: [], error: null };
  const chunks = want ? [] : [null];
  for (let i = 0; want && i < want.length; i += FACTS_IDS_CHUNK) chunks.push(want.slice(i, i + FACTS_IDS_CHUNK));
  const rows = [];
  for (const chunk of chunks) {
    const make = () => {
      let q = client.from(FACTS_TABLE).select('*').eq('location_id', loc);
      if (chunk) q = q.in('menu_item_id', chunk);
      return q.order('menu_item_id');
    };
    const r = await readAllRows(make);
    if (!r.rows) return { rows: [], error: r.error || new Error('The stock facts could not be read.') };
    rows.push(...r.rows);
  }
  return { rows, error: null };
}

/** 'Checked by Jo, 17 Oct' or 'Not checked yet' (the Menu Manager panel and the one site line). */
export function factsCheckedWords(row, { locale = 'en-GB', timeZone = undefined } = {}) {
  if (!row || !row.checked_at) return 'Not checked yet';
  const d = new Date(row.checked_at);
  const day = Number.isFinite(d.getTime()) ? d.toLocaleDateString(locale, { day: 'numeric', month: 'short', ...(timeZone ? { timeZone } : {}) }) : '';
  const who = String(row.checked_by_name || '').trim() || 'someone';
  return day ? `Checked by ${who}, ${day}` : `Checked by ${who}`;
}

/**
 * The words of the read only 'From the recipe at this site' panel for one facts row:
 *   { allergens: [ids], mayContain: [ids], kcal: '146 kcal' | '', checked: 'Checked by ...' |
 *     'Not checked yet', check: 'Check again: ...' | '' }
 * null when there is no row (the panel shows nothing then).
 */
export function factsPanelWords(row, opts = {}) {
  if (!row || typeof row !== 'object') return null;
  const words = row.needs_check === true ? (String(row.check_words || '').trim() || 'Check again: the recipe changed') : '';
  return {
    allergens: allergenIds(row.allergens),
    mayContain: allergenIds(row.may_contain),
    kcal: kcalWords(row.kcal),
    checked: factsCheckedWords(row, opts),
    check: words && !/^Check again:/i.test(words) ? `Check again: ${words}` : words,
  };
}

/**
 * The items with the venue's facts laid over them (fetchMenuStockFacts then mergeStockFacts).
 * Never throws: a failed read, or no facts, gives the items back as they are.
 */
export async function withFacts(client, locationId, items) {
  if (!Array.isArray(items) || !items.length) return items;
  try {
    const { rows } = await fetchMenuStockFacts(client, locationId);
    return rows.length ? mergeStockFacts(items, rows) : items;
  } catch {
    return items;
  }
}
