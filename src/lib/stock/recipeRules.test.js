/** recipeRules.test.js: the company recipe screen rules (multi site stock Drop 2). Run: npm test */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  recipeTabs, startTabOf, KIND_WORDS, FOOD_KIND_WORDS, HOW_WORDS, kindToType, typeToKind, pctWords, rangeWords, gpWords,
  costWords, costAvgWords, priceWords, priceForTargetGp, belowTarget, underTarget, swapWords, optionRuleWords, optionSiteWords,
  tickWords, untickWords, archiveWords, daysHeldWords, notYetWords, missingWords, subLine, sitesCell, yieldWords, totalLabel,
  perYieldLabel, allergenLabel, allergenWords, factsWords, signedOff, PPDS_NOT_CHECKED, factsLineWords, cardSteps, lineToken,
  editorLinesOf, newEditorLine, toCompanyLines, scaleLines, lineUnitOptions, FIELD_WORDS, conflictRows, recipeChangeWords,
  siteRowModel, costAtOptions, costSiteOf, BLANK_FILTERS, FILTER_CHIPS, filtersActive, filtersToServer, listColumns,
  siteFiguresOf, typeCell, soldAsWords, exportRows, exportFileName, detailsDraft, recipeFields, detailsPatch, cloneFields,
  sitesArg, sizesPlan, sizesMadeWords, swapSpec, lineWords,
} from './recipeRules.js';

// Synthetic fixtures only (public repo): made up sites, recipes and prices.
const SITE_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const SITE_B = 'aaaaaaaa-0000-4000-8000-000000000002';
const SITE_C = 'aaaaaaaa-0000-4000-8000-000000000003';
const ITEM_MILK = 'bbbbbbbb-0000-4000-8000-000000000001';
const ITEM_OAT = 'bbbbbbbb-0000-4000-8000-000000000002';
const ITEM_BEANS = 'bbbbbbbb-0000-4000-8000-000000000003';
const PACK_BTL = 'eeeeeeee-0000-4000-8000-000000000001';
const RECIPE = 'cccccccc-0000-4000-8000-000000000001';
const SITES = [{ id: SITE_A, name: 'Site A', currency: 'GBP' }, { id: SITE_B, name: 'Site B', currency: 'GBP' }, { id: SITE_C, name: 'Site C', currency: 'GBP' }];
const byId = new Map(SITES.map((s) => [s.id, s]));

const detail = () => ({
  recipe: { id: RECIPE, name: 'Latte', kind: 'dish', food_kind: 'drink', gp_target_pct: 80, yield_qty: 1, yield_unit: 'each', wastage_pct: 0, method: '1. Grind\n2. Steam', row_version: 3 },
  row_version: 3,
  cost_site: SITE_A,
  lines: [
    { id: 'l1', component_item_id: ITEM_MILK, name: 'Whole milk', base_unit: 'ml', qty: 200, unit: 'ml', pack_id: null, usable_pct: 100, order_types: null, sort_order: 0, packs: [{ id: PACK_BTL, name: 'Bottle', qty_in_base: 2000 }] },
    { id: 'l2', component_item_id: ITEM_BEANS, name: 'Beans', base_unit: 'g', qty: 1, unit: '@', pack_id: PACK_BTL, pack_name: 'Bag', usable_pct: 100, order_types: ['takeaway'], sort_order: 1, packs: [{ id: PACK_BTL, name: 'Bag', qty_in_base: 1000 }] },
  ],
  sites: [
    { location_id: SITE_A, name: 'Site A', on: true, site_recipe_id: 'sr-a', menu_item_id: 'mi-a', menu_item_name: 'Latte Regular', sale_price: 3.2, sale_price_net: 2.6667, cost: 0.41, gp_pct: 84.6, price_for_target: null, sold_7d: 412, sales_7d_net: 1098.67, how: null, holds: null, why_on: 'Added by Jane', needs_check: false, checked_by_name: 'Jane Smith', checked_at: '2026-10-14T10:00:00Z' },
    { location_id: SITE_B, name: 'Site B', on: true, site_recipe_id: 'sr-b', menu_item_id: null, menu_item_name: null, sale_price: null, sale_price_net: null, cost: 0.6, gp_pct: null, sold_7d: null, how: null, why_on: 'Added by the Multi site menu' },
    { location_id: SITE_C, name: 'Site C', on: false },
  ],
});

test('recipeTabs: the six tabs; no Sites tab when not multi; startTabOf falls back to Details', () => {
  assert.deepEqual(recipeTabs(true).map((t) => t.label), ['Details', 'Ingredients', 'Sites', 'Allergens and nutrition', 'Recipe card', 'Changes']);
  assert.deepEqual(recipeTabs(false).map((t) => t.id), ['details', 'ingredients', 'allergens', 'card', 'changes']);
  assert.equal(startTabOf(recipeTabs(true), 'sites'), 'sites');
  assert.equal(startTabOf(recipeTabs(false), 'sites'), 'details');
  assert.equal(startTabOf(recipeTabs(true), 'nonsense'), 'details');
  for (const t of recipeTabs(true)) { assert.equal(t.id, t.value); assert.equal(t.key, t.value); }
});

test('words: kinds, types, how, kind to recipe_type and back', () => {
  assert.deepEqual(KIND_WORDS, { dish: 'Dish', batch: 'Batch', prep: 'Prep' });
  assert.deepEqual(FOOD_KIND_WORDS, { food: 'Food', drink: 'Drink', meal_deal: 'Meal deal' });
  assert.deepEqual(HOW_WORDS, { bought: 'Bought in', batches: 'Made here', to_order: 'Made to order' });
  assert.equal(kindToType('dish'), 'MENU'); assert.equal(kindToType('batch'), 'BATCH'); assert.equal(kindToType('prep'), 'PREP'); assert.equal(kindToType(null), 'MENU');
  assert.equal(typeToKind('MENU'), 'dish'); assert.equal(typeToKind('batch'), 'batch'); assert.equal(typeToKind('PREP'), 'prep'); assert.equal(typeToKind(''), 'dish');
});

test('rangeWords, gpWords, priceWords, costWords: one value when both read the same, else low to high', () => {
  assert.equal(pctWords(85), '85.0%');
  assert.equal(pctWords(null), '');
  assert.equal(gpWords(85, 87), '85.0% to 87.0%');
  assert.equal(gpWords(85.04, 85.01), '85.0%');
  assert.equal(gpWords(87, 85), '85.0% to 87.0%');
  assert.equal(gpWords(null, 85), '85.0%');
  assert.equal(gpWords(null, null), '');
  assert.equal(rangeWords(1, 2, (v) => `${v}`), '1 to 2');
  assert.equal(priceWords(3.2, 3.4, 'GBP'), '£3.20 to £3.40');
  assert.equal(priceWords(3.2, 3.2, 'GBP'), '£3.20');
  assert.equal(costWords(0.41, 'GBP'), '41p');
  assert.equal(costWords(0.414, 'GBP'), '41p');
  assert.equal(costWords(2.14, 'GBP'), '£2.14');
  assert.equal(costWords(0, 'GBP'), '£0.00');
  assert.equal(costWords(null), '');
  assert.equal(costWords(0.41, 'USD'), '$0.41');
  assert.equal(costAvgWords(0.41, 'GBP'), '41p avg');
  assert.equal(costAvgWords(0.41, 'GBP', { oneSite: true }), '41p');
  assert.equal(costAvgWords(null, 'GBP'), '');
});

test('priceForTargetGp, belowTarget, underTarget', () => {
  assert.equal(priceForTargetGp(0.41, 80), 2.05);
  assert.equal(priceForTargetGp(2, 50), 4);
  assert.equal(priceForTargetGp(2, 100), null);
  assert.equal(priceForTargetGp(2, 120), null);
  assert.equal(priceForTargetGp(null, 80), null);
  assert.equal(priceForTargetGp(2, null), null);
  assert.equal(belowTarget({ below_target: true }), true);
  assert.equal(belowTarget({ below_target: false, gp_low: 10, gp_target_pct: 80 }), false);
  assert.equal(belowTarget({ gp_low: 79.9, gp_target_pct: 80 }), true);
  assert.equal(belowTarget({ gp_low: 80, gp_target_pct: 80 }), false);
  assert.equal(belowTarget({ gp_pct: 70, gp_target_pct: 80 }), true);
  assert.equal(belowTarget({ gp_low: null, gp_target_pct: 80 }), false);
  assert.equal(belowTarget(null), false);
  assert.equal(underTarget(79, 80), true);
  assert.equal(underTarget(81, 80), false);
  assert.equal(underTarget(null, 80), false);
});

test('sentences: swap, option rules, ticks, archive, days held, not yet, missing, sub line, sites cell', () => {
  assert.equal(swapWords({ recipes: 2, sites: 5 }), '2 recipes change at 5 sites');
  assert.equal(swapWords({ recipes: 1, sites: 1 }), '1 recipe changes at 1 site');
  assert.equal(swapWords(), '0 recipes change at 0 sites');
  const names = { [ITEM_MILK]: 'Whole milk', [ITEM_OAT]: 'Oat milk' };
  assert.equal(optionRuleWords({ kind: 'replace', option_name: 'Oat milk', replaces_item_id: ITEM_MILK, option_company_item_id: ITEM_OAT }, names), 'When the customer picks Oat milk then replace Whole milk with Oat milk');
  assert.equal(optionRuleWords({ kind: 'remove', option_name: 'No cheese', removes_item_name: 'Cheddar' }), 'When the customer picks No cheese then remove Cheddar');
  assert.equal(optionRuleWords({ kind: 'replace', option_item_name: 'Oat milk', replaces_item_name: 'Whole milk', option_company_item_id: ITEM_OAT }), 'When the customer picks Oat milk then replace Whole milk with Oat milk');
  assert.deepEqual(optionSiteWords({ site_modifier_id: 'x', resolved_by: 'msm' }, 'Site A'), { found: true, words: 'Found at Site A (menu)' });
  assert.deepEqual(optionSiteWords({ site_modifier_id: 'x', resolved_by: 'master_id' }, 'Site A'), { found: true, words: 'Found at Site A (master)' });
  assert.deepEqual(optionSiteWords({ site_modifier_id: 'x', resolved_by: 'name' }, 'Site A'), { found: true, words: 'Found at Site A (name)' });
  assert.deepEqual(optionSiteWords({ site_modifier_id: 'x', resolved_by: 'hand' }, 'Site A'), { found: true, words: 'Found at Site A (by hand)' });
  assert.deepEqual(optionSiteWords({ site_modifier_id: null }, 'Site A'), { found: false, words: 'Not found at Site A: link it' });
  assert.deepEqual(optionSiteWords(null, 'Site A'), { found: false, words: 'Not found at Site A: link it' });
  assert.equal(tickWords('Latte', 'Site B', 4), 'Latte is on at Site B. 4 ingredients were ticked there.');
  assert.equal(tickWords('Latte', 'Site B', 1), 'Latte is on at Site B. 1 ingredient was ticked there.');
  assert.equal(untickWords('Latte', 'Site B'), 'Take Latte off Site B? Its till product is unlinked and its sales there show under Recipe missing.');
  assert.equal(archiveWords('Latte'), 'Archive Latte? Its till products are unlinked at every site. Archived recipes keep their history.');
  assert.equal(daysHeldWords(7), 'Sales totals cover the last 7 days.');
  assert.equal(daysHeldWords(1), 'Sales totals cover the last 1 day.');
  const ny = notYetWords({ code: '55000', message: 'Site A still holds 4 L of Burger sauce. Use it up or count it to zero first, then switch to Made to order.' });
  assert.equal(ny.title, 'Not yet');
  assert.match(ny.words, /still holds 4 L/);
  assert.equal(ny.note, 'That stock would never come off if sales took the raw ingredients instead.');
  assert.equal(notYetWords({ code: '22023', message: 'Tick sites on the Sites tab.' }), null);
  assert.equal(notYetWords(null), null);
  assert.equal(missingWords('no price'), 'No price yet');
  assert.equal(missingWords('usable'), 'Unit not understood');
  assert.equal(missingWords('unit'), 'Unit not understood');
  assert.equal(missingWords('not at site', 'Site A'), 'Not at Site A');
  assert.equal(missingWords('item missing'), 'Not at this site');
  assert.equal(missingWords(''), 'Not costed');
  assert.equal(subLine({ kind: 'dish', food_kind: 'drink', gp_target_pct: 80 }, ['Latte Regular']), 'Dish · Drink · sold as Latte Regular · target GP 80%');
  assert.equal(subLine({ kind: 'batch', gp_target_pct: null }, []), 'Batch · sold as Not linked yet');
  assert.equal(subLine({ kind: 'dish', food_kind: 'food', gp_target_pct: 72.5 }, ['A', 'B', 'C', 'D', 'A']), 'Dish · Food · sold as A, B, C and 1 more · target GP 72.5%');
  const scopeIds = SITES.map((s) => s.id);
  assert.equal(sitesCell({ onIds: scopeIds, scopeIds, siteById: byId }), 'All 3');
  assert.equal(sitesCell({ onIds: [SITE_A, SITE_B], scopeIds, siteById: byId }), '2 of 3');
  assert.equal(sitesCell({ onIds: [SITE_A], scopeIds, siteById: byId }), 'Site A');
  assert.equal(sitesCell({ onIds: [SITE_A], scopeIds, siteById: byId, localId: SITE_A }), 'Local to Site A');
  assert.equal(sitesCell({ onIds: [], scopeIds, siteById: byId }), 'None yet');
  assert.equal(yieldWords({ kind: 'dish', yield_qty: 1, yield_unit: 'each' }), '1 plate');
  assert.equal(yieldWords({ kind: 'batch', yield_qty: 10, yield_unit: 'l' }), '10 l');
  assert.equal(yieldWords({ kind: 'batch', yield_qty: 20, yield_unit: 'each' }, 'patties'), '20 patties');
  assert.equal(totalLabel({ kind: 'dish' }), 'Cost (eat in)');
  assert.equal(totalLabel({ kind: 'prep' }), 'Batch cost');
  assert.equal(perYieldLabel({ kind: 'batch', yield_unit: 'l' }), 'Cost per l');
  assert.equal(perYieldLabel({ kind: 'batch', yield_unit: '' }, 'g'), 'Cost per g');
});

test('allergens: the seed labels, Tree nuts for nuts; words; the facts cell; signed off; the facts line', () => {
  assert.equal(allergenLabel('nuts'), 'Tree nuts');
  assert.equal(allergenLabel('milk'), 'Milk');
  assert.equal(allergenLabel('MILK'), 'Milk');
  assert.equal(allergenLabel('treenuts'), 'Treenuts');
  assert.equal(allergenLabel('gluten_free'), 'Gluten free');
  assert.equal(allergenLabel(''), '');
  assert.equal(allergenWords(['milk', 'gluten', 'milk']), 'Milk, Gluten');
  assert.equal(allergenWords(null), '');
  assert.deepEqual(factsWords({ needs_check: true, check_words: 'Check again: Cheddar from a supplier changed 17 Oct' }), { state: 'check_again', tone: 'warn', words: 'Check again: Cheddar from a supplier changed 17 Oct' });
  assert.equal(factsWords({ needs_check: true, check_words: 'the recipe no longer has milk' }).words, 'Check again: the recipe no longer has milk');
  assert.equal(factsWords({ needs_check: true }).words, 'Check again: the ingredients changed');
  assert.deepEqual(factsWords({ checked_at: '2026-10-14T10:00:00Z', checked_by_name: 'Jane Smith' }, 'Europe/London'), { state: 'checked', tone: 'good', words: 'Checked by Jane Smith, 14 Oct' });
  assert.deepEqual(factsWords({}), { state: 'not_checked', tone: 'neutral', words: 'Not checked yet' });
  assert.deepEqual(factsWords(null), { state: 'not_checked', tone: 'neutral', words: 'Not checked yet' });
  assert.equal(signedOff({ checked_at: '2026-10-14T10:00:00Z', needs_check: false }), true);
  assert.equal(signedOff({ checked_at: '2026-10-14T10:00:00Z', needs_check: true }), false);
  assert.equal(signedOff({ checked_at: null }), false);
  assert.equal(PPDS_NOT_CHECKED, 'Check the allergens first. The label prints once the recipe is checked.');
  assert.deepEqual(factsLineWords({ allergens: ['milk', 'gluten'], may_contain: ['nuts'], kcal: 146.4 }), ['Allergens: Milk, Gluten', 'May contain: Tree nuts', '146 kcal a portion']);
  assert.deepEqual(factsLineWords({ allergens: [], may_contain: [], kcal: null }), ['Allergens: none from the ingredients yet']);
});

test('cardSteps: numbered lines lose their number; blank lines break steps; else each line', () => {
  assert.deepEqual(cardSteps('1. Grind 18 g\n2) Steam the milk\n3. Pour'), ['Grind 18 g', 'Steam the milk', 'Pour']);
  assert.deepEqual(cardSteps('Grind the beans\nand tamp.\n\nSteam the milk.'), ['Grind the beans and tamp.', 'Steam the milk.']);
  assert.deepEqual(cardSteps('Grind\nSteam\nPour'), ['Grind', 'Steam', 'Pour']);
  assert.deepEqual(cardSteps('Grind\r\nSteam'), ['Grind', 'Steam']);
  assert.deepEqual(cardSteps(['A', ' B ', '']), ['A', 'B']);
  assert.deepEqual(cardSteps(''), []);
  assert.deepEqual(cardSteps(null), []);
});

test('lines: tokens, editor lines, company lines, scaling and unit options', () => {
  const d = detail();
  assert.equal(lineToken(d.lines[0]), 'ml');
  assert.equal(lineToken(d.lines[1]), `@${PACK_BTL}`);
  assert.equal(lineToken({ unit: '@', pack_id: null, base_unit: 'g' }), 'g');
  assert.equal(lineToken({ unit: `@${PACK_BTL}` }), `@${PACK_BTL}`);
  const ed = editorLinesOf(d.lines);
  assert.equal(ed.length, 2);
  assert.equal(ed[0].key, 'l1');
  assert.equal(ed[0].unit, 'ml');
  assert.equal(ed[1].unit, `@${PACK_BTL}`);
  assert.deepEqual(ed[1].order_types, ['takeaway']);
  assert.equal(ed[0].order_types, null);
  const fresh = newEditorLine({ id: ITEM_OAT, name: 'Oat milk', base_unit: 'ml' }, [{ id: PACK_BTL, name: 'Carton', qty_in_base: 1000 }, { id: 'x', name: 'Old', qty_in_base: 5, archived_at: '2026-01-01' }], { orderTypes: ['takeaway'] });
  assert.equal(fresh.component_item_id, ITEM_OAT);
  assert.equal(fresh.qty, 1);
  assert.equal(fresh.unit, 'ml');
  assert.deepEqual(fresh.packs, [{ id: PACK_BTL, name: 'Carton', qty_in_base: 1000 }]);
  assert.deepEqual(fresh.order_types, ['takeaway']);
  assert.ok(fresh.key.startsWith('new-'));
  const co = toCompanyLines([...ed, { component_item_id: ITEM_OAT, qty: 0, unit: 'ml' }, { component_item_id: null, qty: 2, unit: 'ml' }, { component_item_id: ITEM_OAT, qty: '2.5', unit: 'l', usable_pct: null, note: ' hot ' }]);
  assert.deepEqual(co, [
    { component_item_id: ITEM_MILK, qty: 200, unit: 'ml', usable_pct: 100, sort_order: 0, note: null, order_types: null },
    { component_item_id: ITEM_BEANS, qty: 1, unit: '@', pack_id: PACK_BTL, usable_pct: 100, sort_order: 1, note: null, order_types: ['takeaway'] },
    { component_item_id: ITEM_OAT, qty: 2.5, unit: 'l', usable_pct: 100, sort_order: 2, note: 'hot', order_types: null },
  ]);
  assert.ok(!('pack_id' in co[0]), 'no pack key on a unit line');
  assert.deepEqual(scaleLines([{ qty: 200 }, { qty: '1' }, { qty: null }], 1.4), [{ qty: 280 }, { qty: 1.4 }, { qty: null }]);
  assert.deepEqual(scaleLines([{ qty: 200 }], 0), [{ qty: 200 }]);
  const opts = lineUnitOptions(ed[0]);
  assert.deepEqual(opts.slice(0, 2), [{ token: `@${PACK_BTL}`, label: 'Bottle (2000 ml)' }, { token: 'ml', label: 'ml' }]);
  assert.ok(opts.some((o) => o.token === 'l') && opts.some((o) => o.token === 'pt'));
  assert.ok(!opts.some((o) => o.token === 'g'), 'no weight unit on a volume item');
  // a line whose pack is no longer listed keeps its token so the box never shows the wrong unit
  const odd = lineUnitOptions({ base_unit: 'g', unit: '@', pack_id: 'gone', pack_name: 'Sack', packs: [] });
  assert.deepEqual(odd[0], { token: '@gone', label: 'Sack' });
});

test('FIELD_WORDS and conflictRows: the recipe fields in plain words', () => {
  assert.equal(FIELD_WORDS.gp_target_pct, 'Target GP (%)');
  assert.equal(FIELD_WORDS.msm_product_id, 'Menu product');
  assert.equal(FIELD_WORDS.lines, 'Ingredients');
  const rows = conflictRows({ name: 'Latte', gp_target_pct: 80, method: 'a' }, { name: 'Latte', gp_target_pct: 75, method: 'a' });
  assert.deepEqual(rows.map((r) => [r.label, r.theirs, r.mine]), [['Target GP (%)', '75', '80']]);
  assert.deepEqual(conflictRows({ name: 'A' }, { name: 'A' }), []);
});

test('recipeChangeWords: kinds, types and how read as words; the recipe field names win', () => {
  const siteById = byId;
  assert.deepEqual(recipeChangeWords({ field: 'kind', before: 'dish', after: 'batch', who_name: 'Jane' }, siteById), { who: 'Jane', what: 'Kind', old: 'Dish', new: 'Batch' });
  assert.deepEqual(recipeChangeWords({ field: 'food_kind', before: null, after: 'meal_deal', who_name: 'Jane' }, siteById), { who: 'Jane', what: 'Type', old: 'None', new: 'Meal deal' });
  const how = recipeChangeWords({ field: 'how', before: 'batches', after: 'to_order', who_name: 'Jane', location_id: SITE_A }, siteById);
  assert.equal(how.what, 'How the site gets it, Site A');
  assert.equal(how.old, 'Made here');
  assert.equal(how.new, 'Made to order');
  const gp = recipeChangeWords({ field: 'gp_target_pct', before: 75, after: 80, who_name: 'Tom' }, siteById);
  assert.deepEqual(gp, { who: 'Tom', what: 'Target GP (%)', old: '75', new: '80' });
  // the item words know shelf_life_days as 'Shelf life'; the recipe says 'Shelf life (days)'
  assert.equal(recipeChangeWords({ field: 'shelf_life_days', before: 3, after: 5, who_name: 'Tom' }, siteById).what, 'Shelf life (days)');
  // a site tick keeps the item words (Ticked at <site>)
  assert.equal(recipeChangeWords({ field: 'on_here', after: true, who_name: 'Tom', location_id: SITE_B }, siteById).what, 'Ticked at Site B');
  // an unknown field falls back to the item rule
  assert.equal(recipeChangeWords({ field: 'something_else', before: 1, after: 2, source: 'import' }, siteById).who, 'An import');
});

test('siteRowModel: one row of the Sites tab, live costs over the detail cost, Under and the price for target', () => {
  const d = detail();
  const a = siteRowModel(SITES[0], d);
  assert.equal(a.on, true);
  assert.equal(a.menuItemName, 'Latte Regular');
  assert.equal(a.salePrice, 3.2);
  assert.equal(a.cost, 0.41);
  assert.ok(Math.abs(a.gpPct - ((2.6667 - 0.41) / 2.6667) * 100) < 1e-9);
  assert.equal(a.target, 80);
  assert.equal(a.under, false);
  assert.equal(a.priceForTarget, null);
  assert.equal(a.sold7d, 412);
  assert.equal(a.why, 'Added by Jane');
  assert.equal(a.checkedByName, 'Jane Smith');
  // live costs win and make the row Under: the price for target comes from the cost and target
  const costs = new Map([[SITE_A, { total: 0.9, per_yield: 0.9, missing: [] }]]);
  const live = siteRowModel(SITES[0], d, costs);
  assert.equal(live.cost, 0.9);
  assert.equal(live.under, true);
  assert.equal(live.priceForTarget, priceForTargetGp(0.9, 80));
  // the server's price_for_target wins when it is there
  d.sites[0].price_for_target = 4.5;
  assert.equal(siteRowModel(SITES[0], d, costs).priceForTarget, 4.5);
  // a plain object of costs works too
  assert.equal(siteRowModel(SITES[0], d, { [SITE_A]: { total: 0.5 } }).cost, 0.5);
  const b = siteRowModel(SITES[1], d);
  assert.equal(b.on, true);
  assert.equal(b.menuItemId, null);
  assert.equal(b.gpPct, null);
  assert.equal(b.why, 'Added by the Multi site menu');
  const c = siteRowModel(SITES[2], d);
  assert.equal(c.on, false);
  assert.equal(c.name, 'Site C');
  assert.equal(c.cost, null);
  assert.deepEqual(costAtOptions(d), [{ value: 'avg', label: 'Company average' }, { value: SITE_A, label: 'Site A' }, { value: SITE_B, label: 'Site B' }]);
  assert.equal(costSiteOf(d), SITE_A);
  assert.equal(costSiteOf({ sites: [{ location_id: SITE_B, on: false }, { location_id: SITE_C, on: true }] }), SITE_C);
  assert.equal(costSiteOf({ sites: [] }, SITE_A), SITE_A);
});

test('list filters: the chips, the server keys, the one site view sets on_at', () => {
  assert.deepEqual(FILTER_CHIPS.map((c) => c.label), ['Below target', 'Check waiting', 'Not linked', 'Local', 'Archived']);
  assert.equal(filtersActive(BLANK_FILTERS), false);
  assert.equal(filtersActive({ kind: 'dish' }), true);
  assert.equal(filtersActive({ site: `on:${SITE_A}` }), true);
  assert.equal(filtersToServer(BLANK_FILTERS), null);
  assert.deepEqual(filtersToServer({ kind: 'batch', foodKind: 'drink', site: `on:${SITE_A}`, belowTarget: true, checkWaiting: true, notLinked: true, local: true, archived: true }),
    { kind: 'batch', food_kind: 'drink', on_at: SITE_A, below_target: true, check_waiting: true, not_linked: true, local: true, archived: true });
  assert.deepEqual(filtersToServer({ site: `not:${SITE_B}` }), { not_at: SITE_B });
  assert.deepEqual(filtersToServer({ site: `not:${SITE_B}` }, SITE_A), { on_at: SITE_A }, 'the one site view drops the site box');
  assert.deepEqual(filtersToServer({ kind: 'nonsense', foodKind: 'nonsense' }), null);
  assert.deepEqual(listColumns({}).map((c) => c.label), ['Name', 'Type', 'Sold as', 'Sites', 'Cost (avg)', 'Price', 'GP %', 'Target', 'Allergens']);
  assert.deepEqual(listColumns({ oneSite: SITE_A }).map((c) => c.label), ['Name', 'Type', 'Sold as', 'Cost here', 'Price here', 'GP %', 'Target', 'Allergens']);
  const row = { kind: 'dish', food_kind: 'drink', sold_as: ['Latte Regular', 'Latte Regular'], sites: [{ location_id: SITE_A, on: true, cost: 0.41 }] };
  assert.equal(siteFiguresOf(row, SITE_A).cost, 0.41);
  assert.equal(siteFiguresOf(row, SITE_B), null);
  assert.equal(typeCell(row), 'Drink');
  assert.equal(typeCell({ kind: 'batch', food_kind: 'food' }), 'Food · Batch');
  assert.equal(typeCell({ kind: 'prep' }), 'Prep');
  assert.equal(soldAsWords(row), 'Latte Regular');
  assert.equal(soldAsWords({ sold_as: [] }), '');
});

test('exportRows: every figure a column, synthetic rows', () => {
  const rows = [{
    name: 'Latte', kind: 'dish', food_kind: 'drink', sold_as: ['Latte Regular'], local_location_id: null,
    sites: [{ location_id: SITE_A, on: true }, { location_id: SITE_B, on: true }],
    cost_avg: 0.41234, price_low: 3.2, price_high: 3.4, gp_low: 85.04, gp_high: 87, gp_target_pct: 80, below_target: false, allergens: ['milk'],
  }];
  const { headers, rows: out } = exportRows(rows, { sites: SITES, siteById: byId });
  assert.deepEqual(headers.map((h) => h.label), ['Name', 'Kind', 'Type', 'Sold as', 'Sites', 'Cost (avg)', 'Price low', 'Price high', 'GP low %', 'GP high %', 'Target GP %', 'Below target', 'Allergens']);
  assert.deepEqual(out[0], { name: 'Latte', kind: 'Dish', type: 'Drink', sold_as: 'Latte Regular', sites: '2 of 3', cost_avg: '0.4123', price_low: '3.2', price_high: '3.4', gp_low: '85', gp_high: '87', target: '80', below: '', allergens: 'Milk' });
  assert.equal(exportFileName('2026-10-21'), 'recipes-2026-10-21.csv');
  assert.equal(exportFileName(''), 'recipes-export.csv');
});

test('detailsDraft, recipeFields, detailsPatch: the form, the save keys and only what changed', () => {
  const r = detail().recipe;
  const draft = detailsDraft(r);
  assert.equal(draft.kind, 'dish');
  assert.equal(draft.food_kind, 'drink');
  assert.equal(draft.gp_target_pct, '80');
  assert.equal(draft.yield_qty, '1');
  assert.equal(draft.shelf_life_days, '');
  assert.equal(detailsDraft(null).food_kind, 'food', 'a new recipe starts as Food');
  const { fields, error } = recipeFields(draft);
  assert.equal(error, null);
  assert.equal(fields.recipe_type, 'MENU');
  assert.equal(fields.name, 'Latte');
  assert.equal(fields.output_item_id, null);
  assert.equal(fields.gp_target_pct, 80);
  assert.equal(fields.method, '1. Grind\n2. Steam');
  assert.equal(fields.meal_food_pct, null);
  assert.ok(!('kind' in fields), 'the save function reads recipe_type, never kind');
  assert.equal(recipeFields({ ...draft, name: '  ' }).error, 'Give the recipe a name.');
  assert.equal(recipeFields({ ...draft, kind: 'batch', output_item_id: null }).error, 'Choose the made item this batch produces.');
  assert.equal(recipeFields({ ...draft, yield_qty: '0' }).error, 'Yield is a number above 0.');
  assert.equal(recipeFields({ ...draft, gp_target_pct: '120' }).error, 'Target GP is a number from 0 to 100.');
  assert.equal(recipeFields({ ...draft, shelf_life_days: '2.5' }).error, 'Shelf life is a whole number of days.');
  assert.equal(recipeFields({ ...draft, food_kind: 'meal_deal', meal_food_pct: '60' }).fields.meal_food_pct, 60);
  // nothing changed: an empty patch
  assert.deepEqual(detailsPatch(draft, r), { patch: {}, error: null });
  // one field changed: only it goes
  assert.deepEqual(detailsPatch({ ...draft, gp_target_pct: '75' }, r), { patch: { gp_target_pct: 75 }, error: null });
  // a kind change to batch travels with the made item
  const toBatch = detailsPatch({ ...draft, kind: 'batch', output_item_id: ITEM_OAT }, r);
  assert.deepEqual(toBatch.patch, { recipe_type: 'BATCH', output_item_id: ITEM_OAT });
  // a batch back to dish clears the made item
  const batch = { ...r, kind: 'batch', output_item_id: ITEM_OAT };
  assert.deepEqual(detailsPatch({ ...detailsDraft(batch), kind: 'dish' }, batch).patch, { recipe_type: 'MENU', output_item_id: null });
  assert.equal(detailsPatch({ ...draft, name: '' }, r).error, 'Give the recipe a name.');
  const clone = cloneFields(detail(), '');
  assert.equal(clone.name, 'Latte (copy)');
  assert.equal(clone.msm_product_id, null);
  assert.equal(clone.recipe_type, 'MENU');
  assert.equal(cloneFields(detail(), 'Latte big').name, 'Latte big');
  assert.deepEqual(sitesArg([SITE_A, SITE_A, 'nonsense', null]), [{ location_id: SITE_A, on: true, menu_item_id: null }]);
});

test('sizesPlan, sizesMadeWords, swapSpec, lineWords', () => {
  assert.deepEqual(sizesPlan([{ name: 'Regular', factor: '1' }, { name: 'Large', factor: 1.4 }, { name: '', factor: '' }]), { sizes: [{ name: 'Regular', factor: 1 }, { name: 'Large', factor: 1.4 }], error: null });
  assert.equal(sizesPlan([]).error, 'Add at least one size.');
  assert.equal(sizesPlan([{ name: '', factor: 2 }]).error, 'Give every size a name.');
  assert.equal(sizesPlan([{ name: 'Large', factor: 0 }]).error, 'The factor of Large is a number above 0.');
  assert.equal(sizesPlan([{ name: 'Large', factor: 1 }, { name: 'large', factor: 2 }]).error, 'Two sizes are named large.');
  assert.equal(sizesPlan(Array.from({ length: 11 }, (_, i) => ({ name: `S${i}`, factor: 1 }))).error, 'Make up to 10 sizes at a time.');
  assert.equal(sizesMadeWords(3), '3 sizes made.');
  assert.equal(sizesMadeWords(1), '1 size made.');
  assert.deepEqual(swapSpec({ mode: 'swap', fromItemId: ITEM_MILK, toItemId: ITEM_OAT, scope: 'all' }), { spec: { mode: 'swap', from_item_id: ITEM_MILK, to_item_id: ITEM_OAT, recipe_ids: null }, error: null });
  assert.deepEqual(swapSpec({ mode: 'swap', fromItemId: ITEM_MILK, toItemId: ITEM_OAT, scope: 'chosen', recipeIds: [RECIPE, RECIPE] }).spec.recipe_ids, [RECIPE]);
  assert.equal(swapSpec({ mode: 'swap', fromItemId: ITEM_MILK, toItemId: ITEM_OAT, scope: 'chosen', recipeIds: [] }).error, 'Tick at least one recipe, or choose Every recipe using it.');
  assert.equal(swapSpec({ mode: 'swap', fromItemId: null }).error, 'Pick the ingredient to change.');
  assert.equal(swapSpec({ mode: 'swap', fromItemId: ITEM_MILK, toItemId: null }).error, 'Pick the ingredient to swap in.');
  assert.equal(swapSpec({ mode: 'swap', fromItemId: ITEM_MILK, toItemId: ITEM_MILK }).error, 'Pick two different ingredients.');
  assert.deepEqual(swapSpec({ mode: 'amount', fromItemId: ITEM_MILK, amountHow: 'qty', qty: '250', unit: 'ml', scope: 'all' }), { spec: { mode: 'amount', from_item_id: ITEM_MILK, recipe_ids: null, qty: 250, unit: 'ml' }, error: null });
  assert.deepEqual(swapSpec({ mode: 'amount', fromItemId: ITEM_MILK, amountHow: 'factor', factor: '1.1', scope: 'all' }), { spec: { mode: 'amount', from_item_id: ITEM_MILK, recipe_ids: null, factor: 1.1 }, error: null });
  assert.equal(swapSpec({ mode: 'amount', fromItemId: ITEM_MILK, amountHow: 'qty', qty: '0', unit: 'ml' }).error, 'The amount is a number above 0.');
  assert.equal(swapSpec({ mode: 'amount', fromItemId: ITEM_MILK, amountHow: 'qty', qty: '2', unit: '' }).error, 'Pick a unit.');
  assert.equal(swapSpec({ mode: 'amount', fromItemId: ITEM_MILK, amountHow: 'factor', factor: '-1' }).error, 'The factor is a number above 0.');
  assert.equal(lineWords({ qty: 30, unit: 'ml', name: 'Whole milk' }), '30 ml Whole milk');
  assert.equal(lineWords({ qty: 0.3333333, unit: 'l', name: 'Oat milk' }), '0.333 l Oat milk');
  assert.equal(lineWords(null), '');
});
