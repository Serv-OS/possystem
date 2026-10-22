/**
 * stock/plateCostsRead.js: plate costs from the database (v5.11.91, multi site stock Drop 2,
 * contract 3.1). stock_plate_costs answers one row per live till product link at a site
 * ({ menu_item_id, site_recipe_id, recipe_id, cost }), 1,000 a page keyed on menu_item_id, the same
 * figure the drainer and the reports use. Pure: the api (stockApi, or a stand in) is handed in, so
 * node --test drives every path (plateCostsRead.test.js).
 *
 *   plateCostMap(rows)                 Map(menu item id -> cost); a row with no cost is left out, so a
 *                                      product it could not cost reads "No recipe", never 0
 *   readPlateCosts(api, loc)           every page of a site: { data: rows | null, error, needsUpdate }
 *   readPlateCostMap(api, loc)         the same, as the Map: { data: Map | null, error, needsUpdate }
 *   costOrFallback(readDb, readToday)  the database first; today's maths (fetchRecipes plus
 *                                      buildCostingCtx) only when the database has no stock_plate_costs
 *                                      yet (needsUpdate), so a develop build before the migration still
 *                                      shows GP. Any other refusal is the answer: never a wrong figure.
 */

export const PLATE_PAGES_MAX = 50;   // 50,000 links at one site: more than any venue menu

const noDbAnswer = () => ({ data: null, error: new Error('No database'), needsUpdate: false });

/** Map(menu item id -> cost) from stock_plate_costs rows. A row with no cost (not costable) is left out. */
export function plateCostMap(rows) {
  const out = new Map();
  for (const r of rows || []) {
    if (!r || r.menu_item_id == null || r.menu_item_id === '') continue;
    if (r.cost == null) continue;
    const c = Number(r.cost);
    if (!Number.isFinite(c)) continue;
    out.set(String(r.menu_item_id), c);
  }
  return out;
}

/**
 * Every page of a site's plate costs, through api.plateCosts(loc, after) until `next` is null.
 * A failed page is a failure (never part of a menu as if it were all of it); a database without
 * the function says needsUpdate.
 */
export async function readPlateCosts(api, loc, { maxPages = PLATE_PAGES_MAX } = {}) {
  if (!api || typeof api.plateCosts !== 'function') return noDbAnswer();
  if (!loc) return { data: null, error: new Error('No site'), needsUpdate: false };
  const rows = [];
  let after = null;
  for (let p = 0; p < maxPages; p++) {
    let r;
    try { r = await api.plateCosts(loc, after); } catch (e) { r = { data: null, error: e, needsUpdate: false }; }
    if (r?.error) return { data: null, error: r.error, needsUpdate: !!r.needsUpdate };
    const page = Array.isArray(r?.data?.rows) ? r.data.rows : [];
    rows.push(...page);
    const next = r?.data?.next;
    if (next == null || next === '' || !page.length) return { data: rows, error: null, needsUpdate: false };
    after = next;
  }
  return { data: null, error: new Error('Too many rows to show at once.'), needsUpdate: false };
}

/** readPlateCosts as the Map the GP views read. */
export async function readPlateCostMap(api, loc, opts = {}) {
  const r = await readPlateCosts(api, loc, opts);
  if (r.error) return { data: null, error: r.error, needsUpdate: r.needsUpdate };
  return { data: plateCostMap(r.data), error: null, needsUpdate: false };
}

/**
 * The database's costs, or today's maths only when the database has no stock_plate_costs yet.
 *   readDb     async () => { data, error, needsUpdate }
 *   readToday  async () => { data, error }
 * Answer { data, error, via: 'database' | 'today' }. Neither reader's throw escapes.
 */
export async function costOrFallback(readDb, readToday) {
  let db;
  try { db = await readDb(); } catch (e) { db = { data: null, error: e, needsUpdate: false }; }
  if (!db?.needsUpdate) return { data: db?.data ?? null, error: db?.error || null, via: 'database' };
  let today;
  try { today = await readToday(); } catch (e) { today = { data: null, error: e }; }
  return { data: today?.data ?? null, error: today?.error || null, via: 'today' };
}
