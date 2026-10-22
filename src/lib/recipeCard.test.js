// node --test: the recipe card read and its pure words (lib/recipeCard.js, v5.11.93, multi site
// stock Drop 2, contract 3.6). The client is a stand in; card null hides the tab or button.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  readRecipeCard, isMissingRecipeCardFn, cardSteps, buildLineWords, buildRows, cardKcalWords, useByWords,
  portionHeading, searchRecipes, RECIPE_CARD_FN, RECIPE_CARD_REFUSED,
} from './recipeCard.js';

const CARD = {
  recipe_id: '11111111-1111-4111-8111-111111111111', name: 'Latte', photo: null, kind: 'dish', portion_words: '12 oz',
  build: [{ qty: 18, unit: 'g', name: 'Espresso beans' }, { qty: 200, unit: 'ml', name: 'Whole milk' }, { qty: null, unit: '', name: 'Cocoa dust' }],
  method: 'Grind 18 g, pull a double shot.\n\nSteam 200 ml milk to 65 C.\n\nPour, finish with a heart.',
  allergens: ['milk'], may_contain: ['nuts'], kcal: 146.4, use_by_days: null, ingredients_text: '*Milk*, coffee', signed_off: true, restricted: false,
};

function client(reply) {
  const calls = [];
  return {
    calls,
    async rpc(name, args) {
      calls.push({ name, args });
      if (typeof reply === 'function') return reply(name, args);
      return reply;
    },
  };
}

test('readRecipeCard asks stock_recipe_card with the till product and answers the card', async () => {
  const c = client({ data: CARD, error: null });
  const r = await readRecipeCard(c, 'L1', { menuItemId: 'm-latte' });
  assert.equal(r.error, null);
  assert.equal(r.card.name, 'Latte');
  assert.deepEqual(c.calls, [{ name: RECIPE_CARD_FN, args: { p_loc: 'L1', p_menu_item_id: 'm-latte', p_recipe: null } }]);
  assert.equal(RECIPE_CARD_FN, 'stock_recipe_card');
  const byRecipe = client({ data: CARD, error: null });
  await readRecipeCard(byRecipe, 'L1', { recipeId: CARD.recipe_id });
  assert.deepEqual(byRecipe.calls[0].args, { p_loc: 'L1', p_menu_item_id: null, p_recipe: CARD.recipe_id });
});

test('readRecipeCard: a missing function, a refusal, nothing linked, a throw, no client or no product all give card null', async () => {
  const missing = await readRecipeCard(client({ data: null, error: { code: 'PGRST202', message: 'Could not find the function public.stock_recipe_card' } }), 'L1', { menuItemId: 'm' });
  assert.deepEqual(missing, { card: null, error: null }, 'before 20261025a: quiet, the tab is hidden');
  const refused = await readRecipeCard(client({ data: null, error: { code: '42501', message: RECIPE_CARD_REFUSED } }), 'L1', { menuItemId: 'm' });
  assert.equal(refused.card, null);
  assert.equal(refused.error.message, 'Sign in to see recipe cards.');
  assert.deepEqual(await readRecipeCard(client({ data: null, error: null }), 'L1', { menuItemId: 'm' }), { card: null, error: null });
  const notOk = await readRecipeCard(client({ data: { ok: false, error: 'No recipe is linked here.' }, error: null }), 'L1', { menuItemId: 'm' });
  assert.equal(notOk.card, null);
  assert.equal(notOk.error.message, 'No recipe is linked here.');
  const thrown = await readRecipeCard(client(() => { throw new Error('offline'); }), 'L1', { menuItemId: 'm' });
  assert.equal(thrown.card, null);
  assert.equal(thrown.error.message, 'offline');
  const c = client({ data: CARD, error: null });
  assert.deepEqual(await readRecipeCard(null, 'L1', { menuItemId: 'm' }), { card: null, error: null });
  assert.deepEqual(await readRecipeCard(c, 'loc-demo', { menuItemId: 'm' }), { card: null, error: null });
  assert.deepEqual(await readRecipeCard(c, 'L1', {}), { card: null, error: null });
  assert.deepEqual(await readRecipeCard(c, null, { menuItemId: 'm' }), { card: null, error: null });
  assert.equal(c.calls.length, 0, 'nothing was asked without a venue and a product');
  assert.equal(isMissingRecipeCardFn({ code: '42883' }), true);
  assert.equal(isMissingRecipeCardFn({ message: 'function public.stock_recipe_card(uuid,text,uuid) does not exist' }), true);
  assert.equal(isMissingRecipeCardFn({ code: '42501', message: RECIPE_CARD_REFUSED }), false);
  assert.equal(isMissingRecipeCardFn(null), false);
});

test('cardSteps: an array as it is, text split on blank lines, else on numbered lines, numbers taken off', () => {
  assert.deepEqual(cardSteps(['Grind', ' Pull ', '', null]), ['Grind', 'Pull']);
  assert.deepEqual(cardSteps(CARD.method), ['Grind 18 g, pull a double shot.', 'Steam 200 ml milk to 65 C.', 'Pour, finish with a heart.']);
  assert.deepEqual(cardSteps('1. Grind the beans\n2) Pull the shot\n3. Pour'), ['Grind the beans', 'Pull the shot', 'Pour']);
  assert.deepEqual(cardSteps('One step only'), ['One step only']);
  assert.deepEqual(cardSteps('Two lines\nof one step\n\nThen another'), ['Two lines of one step', 'Then another']);
  assert.deepEqual(cardSteps(''), []);
  assert.deepEqual(cardSteps(null), []);
  assert.deepEqual(cardSteps(42), []);
});

test('the build rows and the words around the card', () => {
  assert.deepEqual(buildRows(CARD), [
    { qty: 18, unit: 'g', name: 'Espresso beans', words: '18 g' },
    { qty: 200, unit: 'ml', name: 'Whole milk', words: '200 ml' },
    { qty: null, unit: '', name: 'Cocoa dust', words: '' },
  ]);
  assert.deepEqual(buildRows({ build: null }), []);
  assert.deepEqual(buildRows(null), []);
  assert.equal(buildLineWords({ qty: 0.3333333, unit: 'kg' }), '0.333 kg');
  assert.equal(buildLineWords({ qty: '2', unit: 'slices' }), '2 slices');
  assert.equal(buildLineWords({ qty: 1, unit: '' }), '1');
  assert.equal(buildLineWords({ qty: 'x', unit: 'each' }), 'each');
  assert.equal(buildLineWords(null), '');
  assert.equal(cardKcalWords(CARD), '146 kcal');
  assert.equal(cardKcalWords({ kcal: null }), '');
  assert.equal(cardKcalWords({ kcal: '90' }), '90 kcal');
  assert.equal(cardKcalWords(null), '');
  assert.equal(useByWords({ use_by_days: 3 }), 'Use within 3 days');
  assert.equal(useByWords({ use_by_days: 1 }), 'Use within 1 day');
  assert.equal(useByWords({ use_by_days: 0 }), '');
  assert.equal(useByWords(CARD), '');
  assert.equal(portionHeading(CARD), 'Ingredients (12 oz)');
  assert.equal(portionHeading({}), 'Ingredients (1 portion)');
  assert.equal(portionHeading(null), 'Ingredients (1 portion)');
});

test('searchRecipes: case blind contains, name order, capped, bad rows left out', () => {
  const list = [{ menu_item_id: 'c', name: 'Soup of the day' }, { menu_item_id: 'a', name: 'Latte' }, { menu_item_id: 'b', name: 'Flat white' }, { menu_item_id: null, name: 'Ghost' }, { menu_item_id: 'd', name: '' }];
  assert.deepEqual(searchRecipes(list, '').map((p) => p.name), ['Flat white', 'Latte', 'Soup of the day']);
  assert.deepEqual(searchRecipes(list, 'LAT').map((p) => p.menu_item_id), ['b', 'a']);
  assert.deepEqual(searchRecipes(list, 'soup').map((p) => p.menu_item_id), ['c']);
  assert.deepEqual(searchRecipes(list, 'zzz'), []);
  assert.equal(searchRecipes(list, '', 2).length, 2);
  assert.deepEqual(searchRecipes(null, 'x'), []);
});

test('the card file never names a cost or a price, imports no client of its own, and carries no dashes', () => {
  const src = fs.readFileSync(new URL('./recipeCard.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /from '\.\/supabase/, 'the client is passed in (the hook takes it in its options)');
  assert.doesNotMatch(src, /[\u2013\u2014]/);
  assert.doesNotMatch(src, /\.(cost|price|unit_cost|gp_pct)\b/, 'a recipe card never shows money');
});
