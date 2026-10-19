/**
 * Usage reads in pages of 1,000 items (v5.11.79, database update 20261019b).
 *
 * The Order pad, Purchase orders and Batches read how much of each stock item a venue uses. The old
 * reads (stock_usage_by_weekday, stock_usage_rates) answer one row per item and weekday, and the API
 * cuts every answer at 1,000 rows with no order: past about 142 items used every day, items or days
 * went missing and counted as 0, so suggested orders came out wrong with no warning.
 *
 * The new reads (stock_usage_weekday_page, stock_usage_rates_page) answer ONE row per stock item,
 * at most 1,000 items per call, in item id order. readUsagePages asks again with p_after = the last
 * item id until a call answers fewer than 1,000 rows. Any error after the first call gives NO rows,
 * never a partial result (a partial profile would look like real zeros). An error on the first call
 * that says the function is missing (a database before 20261019b) is flagged `missing`, so the
 * caller can use the old read.
 *
 * Pure: no supabase import, so node tests run it with a fake fetchPage.
 */

export const USAGE_PAGE = 1000;

/**
 * @param {(after: string|null) => Promise<{ data: any[]|null, error: any }>} fetchPage
 * @param {{ page?: number, maxPages?: number, isMissing?: (error: any) => boolean }} [opts]
 * @returns {Promise<{ rows: any[]|null, error: any, missing: boolean }>}
 */
export async function readUsagePages(fetchPage, { page = USAGE_PAGE, maxPages = 100, isMissing = null } = {}) {
  const rows = [];
  let after = null;
  for (let n = 0; n < maxPages; n++) {
    let res;
    try { res = await fetchPage(after); } catch (e) { res = { data: null, error: e }; }
    const { data, error } = res || {};
    if (error) return { rows: null, error, missing: n === 0 && !!(isMissing && isMissing(error)) };
    const list = Array.isArray(data) ? data : [];
    rows.push(...list);
    if (list.length < page) return { rows, error: null, missing: false };
    const last = list[list.length - 1]?.inventory_item_id;
    if (!last || last === after) return { rows: null, error: new Error('The usage read did not move on to the next page.'), missing: false };
    after = last;
  }
  return { rows: null, error: new Error(`The usage read stopped at ${maxPages * page} items.`), missing: false };
}

/** { itemId: [sun..sat average daily base] } from stock_usage_weekday_page rows; items with no use are left out (as before). */
export function weekdayProfile(rows) {
  const prof = {};
  for (const r of rows || []) {
    if (!r || !r.inventory_item_id || !Array.isArray(r.by_dow) || r.by_dow.length !== 7) continue;
    const a = r.by_dow.map((v) => Number(v) || 0);
    if (a.every((v) => v === 0)) continue;
    prof[r.inventory_item_id] = a;
  }
  return prof;
}

/** { itemId: average daily base } from stock_usage_rates_page rows; items with no use are left out (as before). */
export function usageRates(rows) {
  const rate = {};
  for (const r of rows || []) {
    if (!r || !r.inventory_item_id) continue;
    const v = Number(r.avg_daily_base) || 0;
    if (v !== 0) rate[r.inventory_item_id] = v;
  }
  return rate;
}

/** The old one row per item and weekday answer (stock_usage_by_weekday) as a profile. */
export function weekdayProfileFromDowRows(rows) {
  const prof = {};
  for (const r of rows || []) {
    const a = (prof[r.inventory_item_id] ??= [0, 0, 0, 0, 0, 0, 0]);
    const d = Number(r.dow);
    if (d >= 0 && d <= 6) a[d] = Number(r.avg_daily_base) || 0;
  }
  return prof;
}
