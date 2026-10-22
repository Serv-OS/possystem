/**
 * menuWaste.test.js: wasting a MENU product with or without stock. Run: npm test.
 *
 * 26 Sep 2026, Peter: "waste isn't showing because they don't have any stock set up, but
 * people still like to waste things and should be able to without stock". Coffee Boy
 * Leeds has 454 menu items and zero stock items, zero recipes. Until now the till modal
 * showed a dead end ("No recipes are linked yet") and the ledger refused a product with
 * no recipe lines ("Nothing to deduct from stock"). These tests pin the pure logic (what
 * the screen lists, what the row looks like) and the visibility rule in the source.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  listWasteProducts, buildMenuWasteRow, usableIngredientLines, wasteTag,
  countLiveStockItems, stockPresence, firstReadError,
} from './menuWaste.js';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');

// A small venue menu: a plain product, a sized product (container + 2 variants), a sold
// alone extra, an option only sub item (never a product) and an archived item.
const menu = [
  { id: 'flat', name: 'Flat White', type: 'product', price: 3.2 },
  { id: 'latte', name: 'Latte', type: 'product', pricing: { base: 0 } },
  { id: 'latte-s', name: 'Small', type: 'product', parentId: 'latte', pricing: { base: 3.0 } },
  { id: 'latte-l', name: 'Latte Large', type: 'product', parentId: 'latte', price: 3.5 },
  { id: 'shot', name: 'Extra shot', type: 'subitem', soldAlone: true, price: 0.5 },
  { id: 'noice', name: 'No Ice', type: 'subitem', soldAlone: false, price: 0 },
  { id: 'old', name: 'Old Brew', type: 'product', archived: true, price: 2 },
];

// ── What the screen lists ─────────────────────────────────────────────────────

test('with no stock and no recipes the list is still every selling item, all unlinked', () => {
  const rows = listWasteProducts(menu, undefined);
  assert.deepEqual(rows.map(r => r.label), ['Extra shot', 'Flat White', 'Latte Large', 'Latte Small']);
  assert.ok(rows.every(r => r.linked === false), 'nothing is recipe linked');
  // Variant container, option only sub item and archived item are not products you can waste.
  assert.ok(!rows.some(r => ['latte', 'noice', 'old'].includes(r.id)));
});

test('the list is the same with an empty recipe map as with none (stock existing changes nothing)', () => {
  assert.deepEqual(listWasteProducts(menu, {}), listWasteProducts(menu, undefined));
});

test('prices come from pricing.base or price, and a recipe link marks the row', () => {
  const rows = listWasteProducts(menu, { 'latte-l': { lines: [{ componentItemId: 'beans', qty: 18, unit: 'g' }] } });
  const by = Object.fromEntries(rows.map(r => [r.id, r]));
  assert.equal(by['latte-s'].price, 3.0);       // pricing.base
  assert.equal(by['latte-l'].price, 3.5);       // price
  assert.equal(by['flat'].price, 3.2);
  assert.equal(by['latte-l'].linked, true);
  assert.equal(by['latte-s'].linked, false);
});

test('variant labels are parent qualified unless the variant already says the parent', () => {
  const by = Object.fromEntries(listWasteProducts(menu).map(r => [r.id, r]));
  assert.equal(by['latte-s'].label, 'Latte Small');
  assert.equal(by['latte-l'].label, 'Latte Large');   // not "Latte Latte Large"
});

test('a missing or odd menu never throws', () => {
  assert.deepEqual(listWasteProducts(null), []);
  assert.deepEqual(listWasteProducts(undefined, null), []);
});

// ── When a venue may still say no ─────────────────────────────────────────────
// v5.11.79 (multi site stock plan, Phase 0, 4.7): a menu waste is NEVER refused. The tag only
// says why nothing came off stock, at a venue that runs stock.

test('a venue with no stock has nothing to say about stock, linked or not, rows or not', () => {
  assert.equal(wasteTag({ hasStock: false, linked: false, rows: [] }), null);
  assert.equal(wasteTag({ hasStock: false, linked: true, rows: [] }), null);
  assert.equal(wasteTag({ hasStock: false, linked: false, rows: undefined }), null);
  assert.equal(wasteTag({ hasStock: undefined, linked: false, rows: [] }), null);
});

test('a product that takes something off stock needs no tag', () => {
  const rows = [{ invId: 'beans', qtyLabel: '18 g', cost: 0.54 }];
  assert.equal(wasteTag({ hasStock: true, linked: true, rows }), null);
  assert.equal(wasteTag({ hasStock: true, linked: false, rows }), null);
});

test('at a stock venue an unlinked product is RECORDED and tagged no recipe (it used to be refused)', () => {
  assert.equal(wasteTag({ hasStock: true, linked: false, rows: [] }), 'no_recipe');
  assert.equal(wasteTag({ hasStock: true, linked: false, rows: undefined }), 'no_recipe');
});

test('at a stock venue a linked recipe that explodes to nothing is RECORDED and tagged nothing to deduct', () => {
  assert.equal(wasteTag({ hasStock: true, linked: true, rows: [] }), 'nothing_to_deduct');
});

test('the old refusal is gone from the module', () => {
  const src = read('./menuWaste.js');
  assert.doesNotMatch(src, /export function wasteRefusal/);
});

// ── What the record looks like ────────────────────────────────────────────────

test('a product with no recipe lines records as a product waste: no stock item, no cost, lost sale kept', () => {
  const row = buildMenuWasteRow({
    locationId: 'loc-1', productName: 'Flat White', qty: 2, salePrice: 3.2, ingredients: [],
    costById: {}, reason: 'Breakage / spill', note: '', source: 'pos',
  });
  assert.deepEqual(row, {
    location_id: 'loc-1', inventory_item_id: null, item_name: 'Flat White', qty: 2, unit: 'item',
    qty_base: 2, reason: 'Breakage / spill', note: null, cost_value: null, sale_value: 6.4, source: 'pos',
  });
});

test('the same product with recipe lines keeps the old shape: cost is the stock cost of the lines', () => {
  const row = buildMenuWasteRow({
    locationId: 'loc-1', productName: 'Latte Large', qty: 1, salePrice: 3.5,
    ingredients: [{ inventoryItemId: 'beans', qtyBase: 18 }, { inventoryItemId: 'milk', qtyBase: 250 }],
    costById: { beans: 0.03, milk: 0.002 }, reason: 'Over-production', note: 'end of day', source: 'pos',
  });
  assert.equal(row.cost_value, 1.04);           // 18 * 0.03 + 250 * 0.002, rounded to 2dp
  assert.equal(row.sale_value, 3.5);
  assert.equal(row.inventory_item_id, null);
  assert.equal(row.item_name, 'Latte Large');
  assert.equal(row.note, 'end of day');
});

test('an unknown cost counts as zero, never null, when there ARE lines (a stock venue is unchanged)', () => {
  const row = buildMenuWasteRow({ locationId: 'l', productName: 'X', qty: 1, salePrice: 1, ingredients: [{ inventoryItemId: 'a', qtyBase: 2 }], costById: {} });
  assert.equal(row.cost_value, 0);
  assert.equal(row.source, 'pos');              // default
});

test('qty defaults to 1, the sale value is rounded and the reason is null when blank', () => {
  const row = buildMenuWasteRow({ locationId: 'l', productName: 'X', qty: 0, salePrice: 2.999, ingredients: null, reason: '', note: null, source: 'backoffice' });
  assert.equal(row.qty, 1);
  assert.equal(row.qty_base, 1);
  assert.equal(row.sale_value, 3);
  // 3 x 1.15 is 3.4499999 in floating point; the row still says 3.45.
  assert.equal(buildMenuWasteRow({ locationId: 'l', productName: 'X', qty: 3, salePrice: 1.15 }).sale_value, 3.45);
  assert.equal(row.reason, null);
  assert.equal(row.source, 'backoffice');
});

test('only lines with an inventory item and a positive base qty can post a movement', () => {
  assert.deepEqual(usableIngredientLines([{ inventoryItemId: 'a', qtyBase: 1 }, { inventoryItemId: null, qtyBase: 5 }, { inventoryItemId: 'b', qtyBase: 0 }, null]),
    [{ inventoryItemId: 'a', qtyBase: 1 }]);
  assert.deepEqual(usableIngredientLines(undefined), []);
  assert.deepEqual(usableIngredientLines('nope'), []);
});

// ── Does this venue run stock? ────────────────────────────────────────────────
// 26 Sep 2026 review (v3): archived stock items do not make a venue a stock venue, and a
// venue with stock items but no recipe linked at all is told why once, above the list.

test('archived stock items do not count, whichever field says so', () => {
  const items = [
    { id: 'a', name: 'Milk' },
    { id: 'b', name: 'Old syrup', archivedAt: '2026-09-01T10:00:00Z' },   // fetchInventoryItems shape
    { id: 'c', name: 'Old cups', archived_at: '2026-08-01T10:00:00Z' },   // raw row shape
    { id: 'd', name: 'Beans', archivedAt: null },
    null,
  ];
  assert.equal(countLiveStockItems(items), 2);
  assert.equal(countLiveStockItems([{ id: 'x', archivedAt: '2026-09-01' }]), 0, 'only archived = no stock');
  assert.equal(countLiveStockItems([]), 0);
  assert.equal(countLiveStockItems(undefined), 0);
  assert.equal(countLiveStockItems('nope'), 0);
});

test('nothing is known about stock until every read succeeded', () => {
  assert.deepEqual(stockPresence({ loaded: false, linkedRecipes: 5, liveStockItems: 5 }), { hasStock: false, recipesMissing: false });
});

test('no live stock items and no recipes is a no stock venue (the Coffee Boy case)', () => {
  assert.deepEqual(stockPresence({ loaded: true, linkedRecipes: 0, liveStockItems: 0 }), { hasStock: false, recipesMissing: false });
  // Every stock item archived counts the same as none.
  const live = countLiveStockItems([{ id: 'x', archivedAt: '2026-09-01' }]);
  assert.deepEqual(stockPresence({ loaded: true, linkedRecipes: 0, liveStockItems: live }), { hasStock: false, recipesMissing: false });
});

test('live stock items with no recipe linked at all is a stock venue with recipes missing', () => {
  assert.deepEqual(stockPresence({ loaded: true, linkedRecipes: 0, liveStockItems: 3 }), { hasStock: true, recipesMissing: true });
});

test('any recipe linked is a stock venue and recipes are not missing', () => {
  assert.deepEqual(stockPresence({ loaded: true, linkedRecipes: 2, liveStockItems: 3 }), { hasStock: true, recipesMissing: false });
  assert.deepEqual(stockPresence({ loaded: true, linkedRecipes: 1, liveStockItems: 0 }), { hasStock: true, recipesMissing: false });
  assert.deepEqual(stockPresence({ loaded: true }), { hasStock: false, recipesMissing: false }, 'missing counts read as zero');
});

// ── Telling a failed read from an empty one ───────────────────────────────────

test('firstReadError: every read fine is null', () => {
  assert.equal(firstReadError([null, null]), null);
  assert.equal(firstReadError([{ data: [], error: null }, { data: [{ id: 1 }], error: null }]), null);
  assert.equal(firstReadError([undefined, { error: null }]), null);
  assert.equal(firstReadError([]), null);
  assert.equal(firstReadError(undefined), null);
});

test('firstReadError: a { data: null, error } among the results is that error, the first one wins', () => {
  const e1 = new Error('fetch failed');
  const e2 = { message: 'permission denied', code: '42501' };
  assert.equal(firstReadError([{ data: [], error: null }, { data: null, error: e1 }, { data: null, error: e2 }]), e1);
  assert.equal(firstReadError([null, undefined, { data: null, error: e2 }]), e2);
});

// ── The visibility rule, pinned in the source ─────────────────────────────────

test('the till modal never hides the menu, never refuses, and asks the database for the one product picked (v5.11.79)', () => {
  const src = read('../../components/PosWasteModal.jsx');
  assert.doesNotMatch(src, /noRecipesAtAll/, 'the "No recipes are linked yet" dead end is gone');
  assert.doesNotMatch(src, />No recipes are linked yet/, 'rendered text, not the comment that says it is gone');
  assert.match(src, /import \{ listWasteProducts, wasteTag, stockPresence \} from '\.\.\/lib\/stock\/menuWaste'/, 'the list and the rules are the shared pure helpers');
  assert.match(src, /listWasteProducts\(menuItems, links\)/);
  assert.doesNotMatch(src, /wasteRefusal/, 'nothing refuses a waste any more');
  assert.doesNotMatch(src, /isn’t linked to a recipe yet/, 'the old refusal toast is gone');
  assert.doesNotMatch(src, /is linked to a recipe that takes nothing off stock, check/, 'the old refusal toast is gone');
  // the till reads which products have a recipe, never the recipe book, on open
  assert.match(src, /fetchWasteLinks\(loc\)\.then/);
  assert.doesNotMatch(src.slice(src.indexOf('fetchWasteLinks(loc).then'), src.indexOf('fetchWasteLinks(loc).then') + 400), /buildDepletionCtx/);
  // the one product's lines come from the database (preview), and only from there
  assert.match(src, /previewMenuWaste\(\{ menuItemId: product\.id, qty: n \}, loc\)/);
  // v5.11.92 (the drainer release, 20261023a): the fallback to the browser's recipe copy is gone. A
  // missing database call is "not loaded": the failure line shows and Record is disabled.
  assert.match(src, /if \(r\.missing\) \{ setLoadFailed\(true\); return; \}/);
  assert.match(src, /if \(r\.error \|\| !r\.data\) \{ setLoadFailed\(true\); return; \}/);
  for (const gone of ['buildDepletionCtx', 'explodeBasket', 'fetchInventoryItems', 'displayInUnits', 'countLiveStockItems', 'fromLegacy', 'setLegacy', 'legacy']) {
    assert.ok(!src.includes(gone), `PosWasteModal no longer has ${gone}`);
  }
  assert.doesNotMatch(src, /from '\.\.\/lib\/stock\/(explode|recipes|data|uom)'/, 'no import of the browser stock engine or the item reads');
  // the record is one call with the product id; no refusal branch before it; the database explodes
  // the dish (stock_record_waste), so no ingredient lines are sent from the till
  // v5.11.96 (Drop 3): the reason shown (the company list or today's) and the manager PIN when the database asked
  assert.match(src, /menuItemId: product\.id, productName: product\.label, qty: n, salePrice: product\.price,\n\s+reason: reasonNow, note: note\.trim\(\) \|\| null, source: 'pos', pin: pinNow\.current,/);
  assert.match(src, /if \(pinState\) \{ setPinAsk\(/, 'the PIN prompt shows only on the database\'s answer');
  assert.doesNotMatch(src, /ingredients:/, 'logMenuItemWaste is called without ingredients');
  assert.match(src, /const tag = product && shown \? wasteTag\(\{ hasStock, linked: product\.linked, rows: shown\.rows \}\) : null;/);
  assert.match(src, /\{hasStock && !p\.linked &&/);
  assert.match(src, /\{tag && <div[^>]*>\{wasteTagText\(/, 'a plain note why nothing comes off stock, never a refusal');
});

test('a failed stock read is "not loaded", never "no stock here": links null, said on screen, Record disabled, old copy', () => {
  const src = read('../../components/PosWasteModal.jsx');
  assert.match(src, /const failed = \(\) => \{ setLinks\(null\); setLiveStockCount\(0\); setLoadFailed\(true\); setLoading\(false\); \};/);
  assert.match(src, /setLoading\(true\); setLoadFailed\(false\);/, 'every open starts clean');
  assert.match(src, /if \(r\?\.error\) \{ failed\(\); return; \}/, 'a failed read is not loaded');
  assert.match(src, /\.catch\(\(\) => \{ if \(live\) failed\(\); \}\)/, 'a thrown error takes the same path');
  assert.match(src, /\{loadFailed && \(\s*<div[^>]*>Stock data did not load, close and try again<\/div>/);
  assert.match(src, /<button onClick=\{submit\} disabled=\{busy \|\| loadFailed\}/);
  assert.match(src, /if \(!links \|\| loadFailed\) \{ showToast\?\.\('Stock data did not load, close and try again', 'error'\); return; \}/);
  assert.match(src, /const \{ hasStock, recipesMissing \} = stockPresence\(\{ loaded: !!links, linkedRecipes: Object\.keys\(links \|\| \{\}\)\.length, liveStockItems: liveStockCount \}\);/);
  assert.match(src, /\{loading \|\| !links \|\| hasStock\s*\? 'Spilled, dropped or binned\? Pick the menu item \u2014 the system works out/);
  assert.match(src, /: 'Spilled, dropped or binned\? Pick the menu item, how many and why\. No stock is set up here/);
});

test('stock items with no recipe linked at all get one amber line under the header, and the list stays', () => {
  const src = read('../../components/PosWasteModal.jsx');
  assert.match(src, /\{!loading && !loadFailed && recipesMissing && \(\s*<div style=\{\{[^}]*color: 'var\(--amb,#e8a020\)'[^}]*\}\}>\{'Stock items exist but no recipes are linked yet, so menu waste is recorded with the lost sale and no stock taken off\. Link recipes in Back Office > Recipes\.'\}<\/div>/);
  assert.match(src, /\{!product \? \(/);
  assert.doesNotMatch(src, /recipesMissing \? \(/, 'the line is an addition, never a replacement for the list');
  for (const line of src.split('\n').filter(l => /Stock items exist but no recipes|Stock data did not load|Training mode: waste not recorded/.test(l))) {
    assert.doesNotMatch(line, /[\u2013\u2014]/, 'new copy carries no em or en dashes');
  }
});

test('Training Mode: neither waste writer commits anything, and both screens say so', () => {
  // in Training Mode "NOTHING the device does is committed" (lib/trainingMode.js). Waste without stock made the
  // product write reachable at every no stock venue, so both writers gate on Training Mode (as the
  // till's old sale path did until v5.11.92 retired it; deplete.js now writes nothing at all).
  const src = read('./waste.js');
  assert.match(src, /^import \{ isTrainingMode \} from '\.\.\/trainingMode';$/m, 'the Training Mode gate import');
  const gate = String.raw`  if \(isMock \|\| !supabase\) return \{ data: null, error: null \};\n(?:  \/\/[^\n]*\n)*  if \(isTrainingMode\(\)\) return \{ data: null, error: null, training: true \};\n  locationId = await ensureLoc\(locationId\);`;
  assert.match(src, new RegExp(String.raw`export const logMenuItemWaste = async [^\n]*\n` + gate), 'logMenuItemWaste: gate right after the isMock guard, before any read or write');
  assert.match(src, new RegExp(String.raw`export const logWaste = async [^\n]*\n` + gate), 'logWaste: the same gate');
  // v5.11.96 (Drop 3): the end of day close down is the third writer, with the same gate
  assert.match(src, /export const logCloseDownWaste = async [^\n]*\n {2}if \(isMock \|\| !supabase\) return \{ data: null, error: null, count: 0 \};\n {2}if \(isTrainingMode\(\)\) return \{ data: null, error: null, training: true, count: 0 \};/);
  assert.equal(src.match(/if \(isTrainingMode\(\)\)/g).length, 3);
  // The till modal closes as done but never says "Waste logged" for a training record.
  const modal = read('../../components/PosWasteModal.jsx');
  assert.match(modal, /const \{ error, training, tag: savedTag, pin: pinState \} = await logMenuItemWaste\(/);
  assert.match(modal, /if \(training\) \{ showToast\?\.\('Training mode: waste not recorded', 'info'\); onClose\?\.\(\); return; \}\s*const why = [^\n]*\n\s*showToast\?\.\(`Waste logged/);
  // Back Office Wastage says the same for raw stock waste.
  const bo = read('../../backoffice/sections/Wastage.jsx');
  assert.match(bo, /const \{ error, training, pin: pinState \} = await logWaste\(/);
  assert.match(bo, /showToast\?\.\(training \? 'Training mode: waste not recorded' : 'Waste logged', training \? 'info' : 'success'\);/);
});

test('buildCostingCtx and buildDepletionCtx hand back the first failed read as ctx.error', () => {
  const src = read('./recipes.js');
  // v3: the helper lives in this pure module (tested above), recipes.js imports it.
  assert.match(src, /^import \{ firstReadError \} from '\.\/menuWaste\.js';$/m);
  assert.doesNotMatch(src, /const firstReadError =/, 'one copy only');
  // buildCostingCtx: every early return carries error null; the real path reports the reads.
  assert.match(src, /if \(isMock \|\| !supabase\) return \{ itemsById: \{\}, recipesByOutputItem: \{\}, error: null \};/);
  assert.match(src, /if \(!locationId\) return \{ itemsById: \{\}, recipesByOutputItem: \{\}, error: null \};/);
  assert.match(src, /return \{ itemsById, recipesByOutputItem, error: firstReadError\(reads\) \};/);
  // buildDepletionCtx: its own reads OR the costing ctx's error (an empty itemsById also explodes to nothing).
  assert.match(src, /return \{ \.\.\.base, menuRecipes, error: base\.error \|\| firstReadError\(reads\) \};/);
  // No read result is thrown away before the error is looked at.
  assert.doesNotMatch(src, /\] = await Promise\.all\(\[\s*supabase\.from\('inventory_items'\)\.select\('id, kind/, 'costing reads are kept as `reads`');
  assert.doesNotMatch(src, /\] = await Promise\.all\(\[\s*supabase\.from\('menu_item_recipes'\)/, 'depletion reads are kept as `reads`');
});

test('the ledger writes a product waste with no lines, and the database takes a movement off per line when there are any', () => {
  const src = read('./waste.js');
  assert.doesNotMatch(src, /Nothing to deduct from stock/);
  // v5.11.84 (multi site stock Drop 0): the database is the one waste writer (stock_record_waste,
  // since v5.11.79). A product is exploded by the database through its recipe; a basket of loose
  // ingredient lines goes with only the usable lines; a product with none is still recorded.
  assert.match(src, /const rpcLines = menuItemId \? null : usableIngredientLines\(ingredients\)\.map\(\(l\) => \(\{ item_id: l\.inventoryItemId, qty_base: Number\(l\.qtyBase\) \}\)\);/);
  // v5.11.96 (Drop 3): a manager PIN answer (pinRefusal) comes back first; every other answer as before
  assert.match(src, /return pinRefusal\(res\) \|\| \{ data: res && res\.id \? \{ id: res\.id \} : res, error: null, tag: res\?\.tag \|\| null, costValue: res\?\.cost_value \?\? null \};/, 'the tag (no recipe, nothing to deduct) comes back to the till');
  // the old browser writer (a waste row, then a movement per ingredient) is gone: it never ran
  // once 20261019b was in, and a refused movement could leave a waste row with nothing taken off.
  assert.doesNotMatch(src, /buildMenuWasteRow|postStockMovement|from\('waste_events'\)\.insert/);
  assert.match(src, /Waste not recorded\. \$\{NEEDS_UPDATE\}/, 'a database without the call is told it needs the update');
});

test('the Waste button is always in the till tab bar and Back Office Wastage points a no stock venue at menu waste', () => {
  const pos = read('../../surfaces/POSSurface.jsx');
  assert.match(pos, /\[\['menu','Menu'\],\['history','History'\],\['deliveries','Deliveries'\],\['waste','Waste'\]\]/, 'the tab is a fixed entry, not gated on stock');
  assert.match(pos, /if\(t==='waste'\)\{ setShowWaste\(true\); return; \}/);
  const bo = read('../../backoffice/sections/Wastage.jsx');
  assert.match(bo, /Waste a menu item…/);
  // The line shows only when the items read SUCCEEDED and came back empty; a failed read keeps the search box.
  assert.match(bo, /setItems\(its\?\.data \|\| \[\]\); setItemsError\(!!its\?\.error\);/, 'the fetch error of fetchInventoryItems is kept');
  // v3: archived items do not count (the search never offers them), same rule as the till.
  assert.match(bo, /!loading && !itemsError && countLiveStockItems\(items\) === 0 \? \(/, 'no live stock items shows the product path instead of an empty search box');
  assert.match(bo, /^import \{ countLiveStockItems \} from '\.\.\/\.\.\/lib\/stock\/menuWaste';$/m);
  assert.doesNotMatch(bo, /!loading && items\.length === 0 \? \(/, 'never without the error check');
  assert.match(bo, /No stock items are set up, so waste is recorded by menu item/);
  // New copy carries no em or en dashes.
  for (const line of bo.split('\n').filter(l => /No stock items are set up/.test(l))) assert.doesNotMatch(line, /[\u2013\u2014]/);
});
