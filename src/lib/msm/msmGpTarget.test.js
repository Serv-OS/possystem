// Multi site menu, 5.12.105: GP is judged against the recipe's own Target GP, and nothing else.
// Peter, 25 Nov 2026: "where are these figures getting pulled from we have new targets in the head
// office but these should be editable and managable we cant juts make this stuff up". The grid
// was green from a fixed 60% nobody chose, and its key held sample figures that read as data.
// His call the same day: the recipe's target only; with none, a figure and no verdict.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { marginFor, siteMargins, withMargins, targetOf, gpTone, gpWordsWithTarget, gpCellWords, gpHoverWords } from './msmMargin.js';
import { plateTargetMap } from '../stock/plateCostsRead.js';

test('a GP figure carries its recipe\'s target and whether it is under it', () => {
  const at = marginFor({ price: 10, vatPct: 0, cost: 3, target: 70 });
  assert.deepEqual([at.gpPct, at.target, at.under], [70, 70, false]);
  const under = marginFor({ price: 10, vatPct: 0, cost: 3.5, target: 70 });
  assert.deepEqual([under.gpPct, under.under], [65, true]);
  const none = marginFor({ price: 10, vatPct: 0, cost: 5 });
  assert.deepEqual([none.gpPct, none.target, none.under], [50, null, null], '50% with no target is NOT called low');
  assert.equal(marginFor({ price: 10, cost: null, target: 70 }).noRecipe, true);
});

test('the colour: good at or above target, low under it, plain with no target, none with no recipe', () => {
  assert.equal(gpTone(marginFor({ price: 10, cost: 3, target: 70 })), 'good');
  assert.equal(gpTone(marginFor({ price: 10, cost: 3.5, target: 70 })), 'low');
  assert.equal(gpTone(marginFor({ price: 10, cost: 5 })), 'plain', 'the old rule called this coral, against a made up 60%');
  assert.equal(gpTone(marginFor({ price: 10, cost: 3 })), 'plain', 'and this green: it is neither');
  assert.equal(gpTone(marginFor({ price: 10, cost: null })), 'none');
  assert.equal(gpTone(null), 'none');
});

test('a target is a number from 0 to 100 or it is no target', () => {
  assert.equal(targetOf('72.5'), 72.5);
  assert.equal(targetOf(0), 0);
  for (const bad of [null, undefined, '', 'abc', -1, 101]) assert.equal(targetOf(bad), null);
});

test('the words say the target, or that there is none', () => {
  const money = (n) => `$${Number(n).toFixed(2)}`;
  assert.equal(gpWordsWithTarget(marginFor({ price: 10, cost: 3, target: 70 }), money), '70% GP · cost $3.00 · target 70%');
  assert.equal(gpWordsWithTarget(marginFor({ price: 10, cost: 5 }), money), '50% GP · cost $5.00 · no target set');
  assert.equal(gpWordsWithTarget(marginFor({ price: 10, cost: null }), money), 'No recipe');
});

test('the grid box is one short line (three parts wrapped into the row below); the cost is on the hover', () => {
  const money = (n) => `$${Number(n).toFixed(2)}`;
  const m = marginFor({ price: 10, cost: 3.5, target: 70 });
  assert.equal(gpCellWords(m), '65% GP · target 70%');
  assert.ok(gpCellWords(m).length <= '65% GP · cost $3.50'.length, 'no longer than the line it replaces');
  assert.equal(gpCellWords(marginFor({ price: 10, cost: 5 })), '50% GP · no target');
  assert.equal(gpCellWords(marginFor({ price: 10, cost: null })), 'No recipe');
  assert.equal(gpHoverWords(m, money), "Cost $3.50. Under its recipe's Target GP of 70%.");
  assert.equal(gpHoverWords(marginFor({ price: 10, cost: 3, target: 70 }), money), "Cost $3.00. At or above its recipe's Target GP of 70%.");
  assert.ok(gpHoverWords(marginFor({ price: 10, cost: 5 }), money).startsWith("Cost $5.00. This product's recipe has no Target GP, so the figure is not judged."));
  assert.equal(gpHoverWords(marginFor({ price: 10, cost: null }), money), '');
});

test('targets by product come from the recipe linked at that site; no target is left out, never filled in', () => {
  const rows = [
    { menu_item_id: 'm-cheese', site_recipe_id: 'r1', recipe_id: 'c1', cost: 3 },
    { menu_item_id: 'm-salad', site_recipe_id: 'r2', recipe_id: 'c2', cost: 2 },
    { menu_item_id: 'm-bread', site_recipe_id: 'r3', recipe_id: 'c3', cost: 1 },
    { menu_item_id: 'm-nolink', site_recipe_id: null, recipe_id: null, cost: null },
  ];
  const recipes = [{ id: 'r1', gp_target_pct: '72' }, { id: 'r2', gp_target_pct: null }, { id: 'r3', gp_target_pct: 'x' }, { id: 'r9', gp_target_pct: 65 }];
  assert.deepEqual([...plateTargetMap(rows, recipes)], [['m-cheese', 72]]);
  assert.deepEqual([...plateTargetMap(rows, [])], []);
  assert.deepEqual([...plateTargetMap(null, null)], []);
});

test('site margins and the Change prices rows take the targets; with none given, nothing is judged', () => {
  const central = { products: [{ id: 'p', default_price: 10, tax_rate_percent: 0 }], productSites: [{ product_id: 'p', location_id: 'L', venue_item_id: 'm', price: null }] };
  const costs = { L: new Map([['m', 3.5]]) };
  assert.equal(siteMargins(central, costs, {}, { L: new Map([['m', 70]]) }).get('p').get('L').under, true);
  assert.equal(siteMargins(central, costs, {}).get('p').get('L').under, null);
  const rows = withMargins([{ productId: 'p', locationId: 'L', before: 10, after: 12 }], central, costs, {}, { L: new Map([['m', 70]]) });
  assert.deepEqual([rows[0].gpBefore.under, rows[0].gpAfter.under], [true, false]);
});

test('no fixed GP threshold and no sample figures are left in the group menu', () => {
  const grid = readFileSync(new URL('../../backoffice/sections/msm/MsmGrid.jsx', import.meta.url), 'utf8');
  assert.ok(!/GP_LOW\s*=\s*\d/.test(grid), 'no hard coded GP threshold');
  for (const sample of ['>3.40<', '>3.60<', '>65% GP<', '>48% GP<']) assert.ok(!grid.includes(sample), `${sample} is gone from the key`);
  assert.ok(grid.includes('color: GP_COLOUR[gpTone(gp)]'));
});
