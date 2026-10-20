/**
 * usagePages.test.js: the Order pad's usage reads in pages of 1,000 items (v5.11.79, 20261019b).
 * Run: npm test.
 *
 * The API answers at most 1,000 rows. The old weekday read answered one row per item AND weekday,
 * in no order, so at 5,000 items (35,000 rows) most items and days were missing and counted as 0.
 * The database half (stock_usage_weekday_page, stock_usage_rates_page) is proved on a local
 * Postgres by supabase/tests/stock_phase0/run.mjs section 18; this pins the client loop.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readUsagePages, weekdayProfile, usageRates, weekdayProfileFromDowRows, USAGE_PAGE } from './usagePages.js';
import { suggestPacks } from './purchasingRules.js';

const CAP = 1000;   // the API's row cap (PostgREST max rows)
const N = 5000;
const ids = Array.from({ length: N }, (_, i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`);
// a deterministic usage per item and weekday; every 7th item is never used
const use = (i, d) => (i % 7 === 0 ? 0 : ((i * 31 + d * 17) % 23) / 4);

// stock_usage_weekday_page as the database answers it: item id order, 1,000 items a call
const pageServer = (after) => {
  const start = after == null ? 0 : ids.indexOf(after) + 1;
  const rows = ids.slice(start, start + USAGE_PAGE).map((id) => {
    const i = ids.indexOf(id);
    return { inventory_item_id: id, by_dow: [0, 1, 2, 3, 4, 5, 6].map((d) => use(i, d)) };
  });
  return Promise.resolve({ data: rows.slice(0, CAP), error: null });
};

test('every one of 5,000 items comes back, with all 7 days, through the 1,000 row cap', async () => {
  const calls = [];
  const r = await readUsagePages((after) => { calls.push(after); return pageServer(after); });
  assert.equal(r.error, null);
  assert.equal(r.rows.length, N);
  assert.equal(calls.length, 6, '5 full pages and one short page');
  assert.equal(calls[0], null);
  assert.equal(calls[1], ids[999], 'the next page starts after the last id');
  const prof = weekdayProfile(r.rows);
  const used = ids.filter((_, i) => i % 7 !== 0);
  assert.equal(Object.keys(prof).length, used.length, 'every used item has a shape; unused items are left out, as before');
  assert.ok(Object.values(prof).every((a) => a.length === 7));
});

test('the suggested order from the paged shape equals the uncapped answer; the old capped read did not', async () => {
  const uncapped = {};
  ids.forEach((id, i) => { const a = [0, 1, 2, 3, 4, 5, 6].map((d) => use(i, d)); if (a.some((v) => v)) uncapped[id] = a; });
  const paged = weekdayProfile((await readUsagePages(pageServer)).rows);
  // the old read: one row per item and day, cut at 1,000 rows, in the database's own order
  const oldRows = [];
  ids.forEach((id, i) => [0, 1, 2, 3, 4, 5, 6].forEach((d) => { if (use(i, d) > 0) oldRows.push({ inventory_item_id: id, dow: d, avg_daily_base: use(i, d) }); }));
  const capped = weekdayProfileFromDowRows(oldRows.reverse().slice(0, CAP));
  const sug = (prof, id) => suggestPacks({ onHand: 2, onOrder: 0, avgDaily: 0, profile: prof[id] || null, todayDow: 4, coverDays: 7, safetyDays: 1, perPack: 6 }).suggestedPacks;
  let pagedDiff = 0; let cappedDiff = 0;
  for (const id of ids) {
    if (sug(paged, id) !== sug(uncapped, id)) pagedDiff++;
    if (sug(capped, id) !== sug(uncapped, id)) cappedDiff++;
  }
  assert.equal(pagedDiff, 0, 'paged: every item suggests what the full data suggests');
  assert.ok(cappedDiff > 3000, `the old capped read got ${cappedDiff} of 5,000 items wrong`);
});

test('a page that fails gives no rows at all (never a partial shape); a missing function on the first call is flagged', async () => {
  let n = 0;
  const failing = (after) => (++n === 3 ? Promise.resolve({ data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } }) : pageServer(after));
  const r = await readUsagePages(failing, { isMissing: () => true });
  assert.equal(r.rows, null);
  assert.equal(r.missing, false, 'a later failure is not "missing": the screen does not fall back to the capped read');
  assert.match(r.error.message, /statement timeout/);
  const missing = await readUsagePages(() => Promise.resolve({ data: null, error: { code: 'PGRST202', message: 'Could not find the function' } }),
    { isMissing: (e) => e.code === 'PGRST202' });
  assert.equal(missing.missing, true);
  const thrown = await readUsagePages(() => Promise.reject(new Error('network')));
  assert.equal(thrown.rows, null);
  assert.match(thrown.error.message, /network/);
});

test('a page that does not move on stops, instead of looping', async () => {
  const stuck = () => Promise.resolve({ data: Array.from({ length: USAGE_PAGE }, () => ({ inventory_item_id: ids[0], by_dow: [1, 1, 1, 1, 1, 1, 1] })), error: null });
  const r = await readUsagePages(stuck);
  assert.equal(r.rows, null);
  assert.match(r.error.message, /did not move on/);
});

test('usage rates: one row per item, unused left out, numbers as numbers', () => {
  assert.deepEqual(usageRates([{ inventory_item_id: 'a', avg_daily_base: '2.5' }, { inventory_item_id: 'b', avg_daily_base: 0 }, null]), { a: 2.5 });
  assert.deepEqual(weekdayProfile([{ inventory_item_id: 'a', by_dow: ['1', 0, 0, 0, 0, 0, 0] }, { inventory_item_id: 'b', by_dow: [1, 2] }]), { a: [1, 0, 0, 0, 0, 0, 0] });
});
