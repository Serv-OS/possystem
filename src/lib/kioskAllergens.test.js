// New kiosk design allergen rules (lib/kioskAllergens.js): the 14 UK allergens, other
// spellings, marking (never hiding) and the basket allergen list.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  UK_ALLERGENS, normaliseAllergenId, isUkAllergen, itemAllergenIds, unsafeAllergenIds, isUnsafe,
  basketAllergens, kioskAllergenKey, kioskAllergenLabels, toggleAllergen, orderIds,
  allergenIdsOfLists, sheetUnsafeIds,
} from './kioskAllergens.js';
import { ALLERGENS } from '../data/seed.js';
import { t } from './i18n.js';

test('the 14 ids are the menu editor ids, in the design order', () => {
  assert.equal(UK_ALLERGENS.length, 14);
  assert.deepEqual([...UK_ALLERGENS].sort(), ALLERGENS.map(a => a.id).sort());
  assert.deepEqual(UK_ALLERGENS.slice(0, 3), ['gluten', 'milk', 'eggs']);
  assert.equal(UK_ALLERGENS[13], 'lupin');
});

test('other spellings map to the menu editor id', () => {
  const cases = {
    dairy: 'milk', egg: 'eggs', soya: 'soy', shellfish: 'crustaceans', 'tree nuts': 'nuts',
    peanut: 'peanuts', 'sulphur dioxide': 'sulphites', mollusc: 'molluscs', Tree_Nuts: 'nuts',
    ' MILK ': 'milk', Gluten: 'gluten', 'Sulfur-Dioxide': 'sulphites',
  };
  for (const [raw, id] of Object.entries(cases)) assert.equal(normaliseAllergenId(raw), id, raw);
  assert.equal(normaliseAllergenId('Celeriac'), 'celeriac');
  assert.equal(normaliseAllergenId(null), '');
  assert.equal(normaliseAllergenId('  '), '');
  assert.equal(isUkAllergen('milk'), true);
  assert.equal(isUkAllergen('dairy'), false);
});

test('item allergens are normalised without repeats', () => {
  assert.deepEqual(itemAllergenIds({ allergens: ['Dairy', 'milk', 'Gluten'] }), ['milk', 'gluten']);
  assert.deepEqual(itemAllergenIds({}), []);
});

test('matching ignores case and spelling, and returns the sheet order', () => {
  const item = { allergens: ['Gluten', 'DAIRY', 'Egg'] };
  assert.deepEqual(unsafeAllergenIds(item, new Set(['eggs', 'milk'])), ['milk', 'eggs']);
  assert.equal(isUnsafe(item, ['Milk']), true);
  assert.equal(isUnsafe(item, new Set(['fish'])), false);
  assert.equal(isUnsafe(item, new Set()), false);
  assert.equal(isUnsafe(item, null), false);
  assert.equal(isUnsafe({ allergens: [] }, new Set(['milk'])), false);
});

test('basket allergens count the item, the size row and linked modifier items', () => {
  const items = [
    { id: 'burger', allergens: ['gluten'] },
    { id: 'burger-large', parent_id: 'burger', allergens: ['sesame'] },
    { id: 'cheese', allergens: ['dairy'] },
    { id: 'cola', allergens: [] },
  ];
  const cart = [
    { name: 'Burger', item: items[0], variant: { id: 'burger-large' }, modsArray: [{ label: 'Cheese', itemId: 'cheese' }, { label: 'Note', groupLabel: 'Note' }] },
    { name: 'Cola', item: items[3], modsArray: [] },
    { name: 'Toast', item: { id: 'toast', allergens: ['Gluten'] } },
  ];
  assert.deepEqual(basketAllergens(cart, items), [
    { id: 'gluten', names: ['Burger', 'Toast'] },
    { id: 'milk', names: ['Burger'] },
    { id: 'sesame', names: ['Burger'] },
  ]);
  assert.deepEqual(basketAllergens([], items), []);
  assert.deepEqual(basketAllergens(null, null), []);
});

test('every UK allergen has an English k2.allergen key', () => {
  for (const id of UK_ALLERGENS) {
    const key = kioskAllergenKey(id);
    assert.equal(key, `k2.allergen.${id}`);
    assert.notEqual(t(key, 'en'), key, key);
  }
  assert.equal(kioskAllergenKey('celeriac'), null);
});

test('labels use the key for UK allergens and the stored word otherwise', () => {
  assert.deepEqual(kioskAllergenLabels(['soy', 'celeriac'], (k) => t(k, 'en')), ['Soy', 'Celeriac']);
  assert.deepEqual(kioskAllergenLabels(['milk']), ['k2.allergen.milk']);
});

test('toggle adds and removes normalised ids', () => {
  const a = toggleAllergen(new Set(), 'Dairy');
  assert.deepEqual([...a], ['milk']);
  const b = toggleAllergen(a, 'milk');
  assert.deepEqual([...b], []);
  assert.notEqual(a, b);
  assert.deepEqual(orderIds(['lupin', 'x', 'gluten', 'x']), ['gluten', 'lupin', 'x']);
});

test('a sized item is marked when only its sizes carry the allergen', () => {
  const latte = { id: 'latte', allergens: [] };
  const sizes = [{ id: 'latte-s', parent_id: 'latte', allergens: ['milk'] }, { id: 'latte-l', parent_id: 'latte', allergens: ['Dairy'] }];
  assert.equal(isUnsafe(latte, new Set(['milk'])), false);
  assert.equal(isUnsafe(latte, new Set(['milk']), sizes), true);
  assert.deepEqual(unsafeAllergenIds(latte, ['milk', 'eggs'], sizes), ['milk']);
});

test('the item sheet warns about the picked size and the picked options', () => {
  const item = { id: 'burger', allergens: ['gluten'] };
  const small = { id: 's', allergens: [] };
  const large = { id: 'l', allergens: ['sesame'] };
  const filter = new Set(['milk', 'sesame']);
  // Before a size is picked every size counts; once picked, only that size.
  assert.deepEqual(sheetUnsafeIds({ item, sizes: [small, large], filter }), ['sesame']);
  assert.deepEqual(sheetUnsafeIds({ item, pickedSize: small, sizes: [small, large], filter }), []);
  // An option with milk on the option itself (no linked item).
  const optionIds = allergenIdsOfLists([['Dairy'], [], ['celery']]);
  assert.deepEqual(optionIds, ['milk', 'celery']);
  assert.deepEqual(sheetUnsafeIds({ item, pickedSize: small, optionIds, filter }), ['milk']);
  assert.deepEqual(sheetUnsafeIds({ item, optionIds, filter: null }), []);
});

test('basket allergens count allergens stored on a picked option with no linked item', () => {
  const items = [{ id: 'fries', allergens: [] }];
  const cart = [{ key: 'k1', name: 'Fries', item: items[0], qty: 1, modsArray: [{ label: 'Cheese sauce', price: 1, groupLabel: 'Extras' }] }];
  assert.deepEqual(basketAllergens(cart, items), []);
  assert.deepEqual(basketAllergens(cart, items, new Map([['k1', ['dairy']]])), [{ id: 'milk', names: ['Fries'] }]);
  assert.deepEqual(basketAllergens(cart, items, new Map([['other', ['milk']]])), []);
});

test('allergen chip labels are the menu editor labels', () => {
  for (const a of ALLERGENS) assert.equal(t(`k2.allergen.${a.id}`), a.label, a.id);
});
