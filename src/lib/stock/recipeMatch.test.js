/** recipeMatch.test.js: the smart match between a till product and a recipe (multi site stock Drop 2). Run: npm test */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normName, matchRecipe, priceDiffPct, menuItemLabel, sellableMenuItems, suggestTillProduct, suggestWords, linksOf, rowKey,
} from './recipeMatch.js';
import { normName as msmNormName } from '../../../supabase/functions/_shared/msmModel.js';

// Synthetic fixtures only (public repo): made up sites, products and prices.
const SITE_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const SITE_B = 'aaaaaaaa-0000-4000-8000-000000000002';
const RECIPE = 'cccccccc-0000-4000-8000-000000000001';
const RECIPE_2 = 'cccccccc-0000-4000-8000-000000000002';
const MSM = 'dddddddd-0000-4000-8000-000000000001';

test('normName is the Multi site menu rule, one copy', () => {
  assert.equal(normName, msmNormName);
  assert.equal(normName('  Flat White & Oat  '), 'flat white and oat');
  assert.equal(normName('Latte (Large)'), 'latte large');
  assert.equal(normName(null), '');
});

test('priceDiffPct: a fraction of the other price; null when a side is unknown', () => {
  assert.equal(priceDiffPct(3.2, 3.2), 0);
  assert.ok(Math.abs(priceDiffPct(3.4, 3.2) - 0.0625) < 1e-9);
  assert.equal(priceDiffPct(null, 3.2), null);
  assert.equal(priceDiffPct(3.2, ''), null);
  assert.equal(priceDiffPct(0, 0), 0);
  assert.equal(priceDiffPct(1, 0), null);
});

test('matchRecipe: msm first, then master, then name within the price tolerance', () => {
  const candidates = [
    { recipeId: RECIPE_2, recipeName: 'Flat white', msmProductId: null, masterId: 'm-9', menuItemName: null, price: null },
    { recipeId: RECIPE, recipeName: 'Latte', msmProductId: MSM, masterId: 'm-1', menuItemName: 'Latte Regular', price: 3.2, siteId: SITE_A },
  ];
  assert.deepEqual(matchRecipe({ product: { name: 'Anything', msmProductId: MSM, price: 3.3 }, candidates }), { recipeId: RECIPE, how: 'msm', priceDiffPct: priceDiffPct(3.3, 3.2) });
  assert.deepEqual(matchRecipe({ product: { name: 'Anything', masterId: 'm-1', price: null }, candidates }), { recipeId: RECIPE, how: 'master', priceDiffPct: null });
  assert.deepEqual(matchRecipe({ product: { name: 'latte', price: 3.3 }, candidates }), { recipeId: RECIPE, how: 'name', priceDiffPct: priceDiffPct(3.3, 3.2) });
  assert.deepEqual(matchRecipe({ product: { name: 'Latte Regular', price: 3.4 }, candidates }), { recipeId: RECIPE, how: 'name', priceDiffPct: priceDiffPct(3.4, 3.2) });
  // a price 25% away is not a name match
  assert.equal(matchRecipe({ product: { name: 'Latte', price: 4.0 }, candidates }), null);
  // a side with no price is not compared
  assert.equal(matchRecipe({ product: { name: 'Flat White', price: 9 }, candidates })?.recipeId, RECIPE_2);
  // nothing matches
  assert.equal(matchRecipe({ product: { name: 'Soup of the day', price: 5 }, candidates }), null);
  assert.equal(matchRecipe({ product: { name: '' }, candidates }), null);
  assert.equal(matchRecipe({}), null);
  // the tolerance can be widened
  assert.equal(matchRecipe({ product: { name: 'Latte', price: 4.0 }, candidates, priceTolerance: 0.3 })?.how, 'name');
});

test('menuItemLabel and sellableMenuItems: parent qualified names, variant parents left out, archived left out', () => {
  const items = [
    { id: 'p1', name: 'Latte', parentId: null, pricing: { base: 0 } },
    { id: 'c1', name: 'Regular', parentId: 'p1', pricing: { base: 3.2 }, masterId: 'm-1' },
    { id: 'c2', name: 'Latte Large', parentId: 'p1', pricing: { base: 3.6 } },
    { id: 'x1', name: 'Old', archived: true, pricing: { base: 1 } },
    { id: 's1', name: 'Soup of the day', parent_id: null, price: 5 },
  ];
  const byId = new Map(items.map((m) => [m.id, m]));
  assert.equal(menuItemLabel(items[1], byId), 'Latte Regular');
  assert.equal(menuItemLabel(items[2], byId), 'Latte Large');
  assert.equal(menuItemLabel(items[0], byId), 'Latte');
  const rows = sellableMenuItems(items);
  assert.deepEqual(rows.map((r) => r.id), ['c2', 'c1', 's1']);
  assert.deepEqual(rows.find((r) => r.id === 'c1'), { id: 'c1', name: 'Latte Regular', price: 3.2, masterId: 'm-1', parentId: 'p1' });
  assert.equal(rows.find((r) => r.id === 's1').price, 5);
});

test('suggestTillProduct: the recipe name, or a product linked at another site, picks the row to offer first', () => {
  const recipe = { id: RECIPE, name: 'Latte', msm_product_id: null };
  const sites = [
    { location_id: SITE_A, on: true, menu_item_id: 'a-1', menu_item_name: 'Latte Regular', sale_price: 3.2 },
    { location_id: SITE_B, on: false },
  ];
  const menuItems = [
    { id: 'b-9', name: 'Mocha', pricing: { base: 3.5 } },
    { id: 'b-1', name: 'Latte Regular', pricing: { base: 3.4 } },
  ];
  assert.equal(suggestTillProduct({ recipe, sites, menuItems, siteId: SITE_B }), 'b-1');
  // the price at the other site is too far away: no suggestion by name
  assert.equal(suggestTillProduct({ recipe, sites, menuItems: [{ id: 'b-1', name: 'Latte Regular', pricing: { base: 5.0 } }], siteId: SITE_B }), null);
  // the recipe's own name has no price to compare, so it always offers
  assert.equal(suggestTillProduct({ recipe, sites: [], menuItems: [{ id: 'b-2', name: 'latte', pricing: { base: 9 } }], siteId: SITE_B }), 'b-2');
  assert.equal(suggestTillProduct({ recipe, sites: [], menuItems: [], siteId: SITE_B }), null);
  assert.equal(suggestTillProduct({}), null);
});

test('suggestWords: No match, Use <site>\'s recipe here, or the recipe name', () => {
  assert.equal(suggestWords({ suggested: null }), 'No match');
  assert.equal(suggestWords({}), 'No match');
  assert.equal(suggestWords({ suggested: { recipe_id: RECIPE, name: 'Latte', how: 'msm' } }, { fromSiteName: 'Site A' }), "Use Site A's recipe here");
  assert.equal(suggestWords({ suggested: { recipe_id: RECIPE, name: 'Latte', how: 'master' } }, { fromSiteName: 'Site A' }), "Use Site A's recipe here");
  assert.equal(suggestWords({ suggested: { recipe_id: RECIPE, name: 'Latte', how: 'name' } }, { fromSiteName: 'Site A' }), 'Latte');
  assert.equal(suggestWords({ suggested: { recipe_id: RECIPE, name: 'Latte', how: 'msm' } }), 'Latte');
});

test('linksOf: the ticked rows with a recipe, the picked one over the suggestion, at most 200', () => {
  const rows = [
    { location_id: SITE_A, menu_item_id: 'a-1', suggested: { recipe_id: RECIPE } },
    { location_id: SITE_A, menu_item_id: 'a-2', suggested: null },
    { location_id: SITE_B, menu_item_id: 'b-1', suggested: { recipe_id: RECIPE } },
  ];
  const ticked = new Set([rowKey(rows[0]), rowKey(rows[1]), rowKey(rows[2])]);
  const out = linksOf(rows, ticked, { [rowKey(rows[1])]: RECIPE_2, [rowKey(rows[2])]: RECIPE_2 });
  assert.deepEqual(out, {
    links: [
      { location_id: SITE_A, menu_item_id: 'a-1', recipe_id: RECIPE },
      { location_id: SITE_A, menu_item_id: 'a-2', recipe_id: RECIPE_2 },
      { location_id: SITE_B, menu_item_id: 'b-1', recipe_id: RECIPE_2 },
    ],
    over: 0,
  });
  // a No match row with nothing picked is skipped; unticked rows are skipped
  assert.deepEqual(linksOf(rows, [rowKey(rows[1])]).links, []);
  assert.deepEqual(linksOf(rows, [rowKey(rows[2])]).links, [{ location_id: SITE_B, menu_item_id: 'b-1', recipe_id: RECIPE }]);
  // the cap
  const many = Array.from({ length: 205 }, (_, i) => ({ location_id: SITE_A, menu_item_id: `m-${i}`, suggested: { recipe_id: RECIPE } }));
  const capped = linksOf(many, new Set(many.map(rowKey)));
  assert.equal(capped.links.length, 200);
  assert.equal(capped.over, 5);
  assert.equal(rowKey({ location_id: SITE_A, menu_item_id: 'x' }), `${SITE_A}|x`);
});
