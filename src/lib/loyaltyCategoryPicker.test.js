// v5.9.66: the Back Office "Products or Categories" picker, category side, and the saved shape
// it produces read back by the till/kiosk/online matcher (lib/loyaltyMenuMatch.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupCategoriesByPath, categoryQualifies } from './stampCategoryGroups.js';
import { eligibleMatcher } from './loyaltyMenuMatch.js';
import {
  categoryEntriesFor, catEntrySelected, catEntryCovered, toggleCatEntry, categoryChips, removeCategoryChip,
  categoryIdChips, removeCategoryIdChip, MISSING_CHIP, itemEntriesFromIds, itemIdsFromEntries,
} from './loyaltyCategoryPicker.js';

// Two sites with the same menu shape, different ids.
const rows = (site) => [
  { id: `${site}-drinks`, label: 'Drinks', parent_id: null, location_id: site },
  { id: `${site}-coffee`, label: 'Coffee', parent_id: `${site}-drinks`, location_id: site },
  { id: `${site}-food`, label: 'Food', parent_id: null, location_id: site },
];
const CATS = [...rows('leeds'), ...rows('barn')];
const groups = groupCategoriesByPath(CATS);
const g = (label) => groups.find(x => x.label === label);

test('ticking Coffee saves one entry per site with the label and the path', () => {
  const entries = toggleCatEntry(g('Coffee'), [], groups);
  assert.deepEqual(entries, [
    { id: 'leeds-coffee', name: 'Coffee', path: ['drinks', 'coffee'] },
    { id: 'barn-coffee', name: 'Coffee', path: ['drinks', 'coffee'] },
  ]);
  assert.equal(catEntrySelected(g('Coffee'), entries), true);
  assert.equal(catEntrySelected(g('Drinks'), entries), false);
  assert.deepEqual(toggleCatEntry(g('Coffee'), entries, groups), []);
  assert.deepEqual(categoryEntriesFor(g('Food')).map(e => e.id), ['leeds-food', 'barn-food']);
});

test('a ticked parent covers its subcategory; the chips read once per path', () => {
  const entries = toggleCatEntry(g('Drinks'), [], groups);
  assert.equal(catEntryCovered(g('Coffee'), entries, groups), true);
  assert.equal(catEntryCovered(g('Drinks'), entries, groups), false);
  assert.equal(catEntryCovered(g('Food'), entries, groups), false);
  assert.deepEqual(categoryChips(entries), [{ key: 'drinks', name: 'Drinks', count: 2 }]);
  assert.deepEqual(removeCategoryChip('drinks', entries), []);
});

test('an entry saved by id only is selected and covers through the groups', () => {
  const entries = [{ id: 'leeds-drinks', name: 'Drinks' }];
  assert.equal(catEntrySelected(g('Drinks'), entries), true);
  assert.equal(catEntryCovered(g('Coffee'), entries, groups), true);
});

test('what the picker saves redeems at a site that did not exist when it was saved', () => {
  const entries = toggleCatEntry(g('Coffee'), [], groups);          // saved with Leeds + Barnsley ids
  const pres = rows('pres');                                          // a third site, opened later
  const m = eligibleMatcher({ eligible_categories: entries }, pres);
  assert.equal(m.matches({ ids: [], labels: [], catIds: ['pres-coffee'] }), true);
  assert.equal(m.matches({ ids: [], labels: [], catIds: ['pres-food'] }), false);
  // And a Drinks entry covers Preston's Coffee through the path too.
  const drinks = toggleCatEntry(g('Drinks'), [], groups);
  assert.equal(categoryQualifies('pres-coffee', drinks.map(e => e.id), pres, ['drinks']), true);
});

test('id-only selections (qualifying categories) chip per path and flag stale ids', () => {
  const ids = ['leeds-coffee', 'barn-coffee', 'gone-1', 'gone-2'];
  assert.deepEqual(categoryIdChips(ids, groups), [
    { key: g('Coffee').key, name: 'Coffee', count: 2 },
    { key: MISSING_CHIP, name: '2 no longer exist', count: 1, missing: true },
  ]);
  assert.deepEqual(removeCategoryIdChip(MISSING_CHIP, ids, groups), ['leeds-coffee', 'barn-coffee']);
  assert.deepEqual(removeCategoryIdChip(g('Coffee').key, ids, groups), ['gone-1', 'gone-2']);
});

test('qualifying items: ids become picker entries with names, and back to ids once each', () => {
  const items = [
    { id: 'cap', name: 'Cappuccino', parent_id: null },
    { id: 'cap-l', name: 'Large', parent_id: 'cap' },
    { id: 'latte', name: 'Latte', parent_id: null },
  ];
  assert.deepEqual(itemEntriesFromIds(['cap-l', 'latte', 'gone'], items), [
    { id: 'cap-l', name: 'Cappuccino - Large' },
    { id: 'latte', name: 'Latte' },
    { id: 'gone', name: '' },
  ]);
  assert.deepEqual(itemIdsFromEntries([{ id: 'a', name: 'x' }, { id: 'a', name: 'x' }, { id: 'b' }, null]), ['a', 'b']);
});
