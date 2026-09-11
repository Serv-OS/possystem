/**
 * preorderChoices.test.js — guest pre-order choices (10 Sep 2026).
 * The server keeps only options that really exist on the dish and restamps
 * their prices; the page decides which dishes open the sheet. Run: `npm test`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  groupIdsOf, sizeChildren, optionGroupIdsFor, itemHasOptions, itemNeedsSheetReturn,
  choiceConfigured, modsExtra, choiceSummary, sanitiseChoice, MAX_CHOICE_MODS,
} from './preorderChoices.js';

// A venue menu as the database returns it (snake_case).
const ROWS = [
  { id: 'm-steak', name: 'Ribeye', type: 'item', assigned_modifier_groups: [{ groupId: 'g-sauce', min: 0 }], assigned_instruction_groups: ['igd-cook'] },
  { id: 'm-steak-8', name: '8oz', menu_name: '8oz', parent_id: 'm-steak', type: 'item' },
  { id: 'm-steak-12', name: '12oz', menu_name: '12oz', parent_id: 'm-steak', type: 'item' },
  { id: 'm-steak-old', name: '16oz', parent_id: 'm-steak', archived: true },
  { id: 'm-soup', name: 'Soup', type: 'item' },
  { id: 'm-fish', name: 'Sea bass', type: 'item', assigned_modifier_groups: ['g-side'] },
  { id: 'm-pepper', name: 'Peppercorn sauce', type: 'subitem', sold_alone: true },
  { id: 'm-pizza', name: 'Margherita', type: 'pizza', assigned_modifier_groups: ['g-side'] },
];
const GROUPS = [
  { id: 'g-sauce', name: 'Sauce', min: 0, max: 1, options: [
    { id: 'o-pep', name: 'Peppercorn sauce', price: 2.5, subGroupId: 'g-serve' },
    { id: 'o-bearn', name: 'Bearnaise', price: 3, itemId: 'm-bearn-link' },
  ] },
  { id: 'g-serve', name: 'Served', min: 0, max: 1, options: [{ id: 'o-side', name: 'On the side', price: 0 }] },
  { id: 'g-side', name: 'Side', min: 1, max: 1, options: [{ id: 'o-chips', name: 'Chips', price: 1 }] },
];
const DEFS = [
  { id: 'igd-cook', name: 'Cooking preference', options: ['Rare', 'Medium rare', 'Well done'] },
  { id: 'igd-spice', name: 'Spice level', required: true, options: ['Mild', 'Hot'] },
];
const row = (id) => ROWS.find((r) => r.id === id);

test('group ids read bare ids and override objects', () => {
  assert.deepEqual(groupIdsOf(['a', { groupId: 'b' }, { id: 'c' }, null, {}]), ['a', 'b', 'c']);
});

test('sizes are the live children only; a size with no groups uses the dish groups', () => {
  assert.deepEqual(sizeChildren(row('m-steak'), ROWS).map((r) => r.id), ['m-steak-8', 'm-steak-12']);
  const g = optionGroupIdsFor(row('m-steak-12'), ROWS);
  assert.deepEqual({ mod: g.mod, inst: g.inst }, { mod: ['g-sauce'], inst: ['igd-cook'] });
});

test('which dishes have options (the till badge test, pizza excluded)', () => {
  assert.equal(itemHasOptions(row('m-steak'), ROWS), true);
  assert.equal(itemHasOptions(row('m-fish'), ROWS), true);
  assert.equal(itemHasOptions(row('m-soup'), ROWS), false);
  assert.equal(itemHasOptions(row('m-pizza'), ROWS), false);
  assert.equal(itemHasOptions(null, ROWS), false);
});

test('a dish counts as chosen only after the sheet when a size, required instruction or group minimum applies', () => {
  // sizes must be picked
  assert.equal(itemNeedsSheetReturn(row('m-steak'), ROWS, {}), true);
  // a group with min 1, once the minimums have loaded
  assert.equal(itemNeedsSheetReturn(row('m-fish'), ROWS, { groupMin: { 'g-side': 1 } }), true);
  // minimums unknown: does not block
  assert.equal(itemNeedsSheetReturn(row('m-fish'), ROWS, {}), false);
  // a required instruction group
  const curry = { id: 'm-curry', name: 'Curry', assigned_instruction_groups: ['igd-spice'] };
  assert.equal(itemNeedsSheetReturn(curry, [...ROWS, curry], { instDefs: DEFS }), true);
  // optional only
  const salad = { id: 'm-salad', name: 'Salad', assigned_instruction_groups: ['igd-cook'] };
  assert.equal(itemNeedsSheetReturn(salad, [...ROWS, salad], { instDefs: DEFS, groupMin: {} }), false);
  assert.equal(itemNeedsSheetReturn(row('m-soup'), ROWS, {}), false);
});

test('configured, extras and the one line summary', () => {
  assert.equal(choiceConfigured(null), false);
  assert.equal(choiceConfigured({ name: 'Ribeye', mods: [] }), false);
  assert.equal(choiceConfigured({ name: 'Ribeye', mods: [], configured: true }), true);
  assert.equal(choiceConfigured({ name: 'Ribeye', mods: [], variantItemId: 'm-steak-8' }), true);
  const pick = { name: 'Ribeye', variantName: '12oz', mods: [
    { label: 'Medium rare', price: 0, _instruction: true },
    { name: 'Peppercorn sauce', label: 'Peppercorn sauce', price: 2.5 },
    { name: 'Chips', label: 'Chips ×2', price: 2 },
  ] };
  assert.equal(choiceSummary(pick), '12oz, Medium rare, Peppercorn sauce, Chips ×2');
  assert.equal(modsExtra(pick.mods), 4.5);
  assert.equal(modsExtra(null), 0);
});

test('SERVER: keeps real options, restamps prices from the database, drops the rest', () => {
  const c = sanitiseChoice({
    lineItemId: 'm-steak', variantItemId: 'm-steak-12', rows: ROWS, groups: GROUPS, instDefs: DEFS,
    mods: [
      { id: 'o-pep', name: 'Peppercorn sauce', price: 0.01 },               // price tampered
      { id: 'o-side', name: 'On the side', groupLabel: 'Served', price: 0 }, // sub-group option
      { id: 'o-chips', name: 'Chips', price: 1 },                           // not on this dish
      { id: 'o-fake', name: 'Lobster', price: 0 },                          // does not exist
      { id: 'ig-igd-cook-Medium rare', label: 'Medium rare', price: 9, _instruction: true },
      { label: 'Hot', groupLabel: 'Spice level', _instruction: true },      // group not on this dish
      'junk', null,
    ],
  });
  assert.equal(c.variantItemId, 'm-steak-12');
  assert.equal(c.variantName, '12oz');
  assert.deepEqual(c.mods.map((m) => m.name), ['Peppercorn sauce', 'On the side', 'Medium rare']);
  assert.equal(c.mods[0].price, 2.5);
  assert.equal(c.mods[0].itemId, 'm-pepper');     // sold-alone sub-item of the same name
  assert.equal(c.mods[0].groupLabel, 'Sauce');
  assert.equal(c.mods[1].groupLabel, 'Served');
  assert.deepEqual(c.mods[2], { id: 'ig-igd-cook-Medium rare', name: 'Medium rare', label: 'Medium rare', groupLabel: 'Cooking preference', price: 0, _instruction: true });
});

test('SERVER: an option matches by name when its id changed; quantity is priced and capped', () => {
  const c = sanitiseChoice({
    lineItemId: 'm-steak', rows: ROWS, groups: GROUPS, instDefs: DEFS,
    mods: [{ id: 'old-id', name: 'bearnaise', groupLabel: 'Sauce', qty: 2 }, { name: 'Bearnaise', qty: 999 }],
  });
  assert.equal(c.mods.length, 2);
  assert.deepEqual(c.mods[0], { id: 'o-bearn', name: 'Bearnaise', label: 'Bearnaise ×2', itemId: 'm-bearn-link', groupLabel: 'Sauce', price: 6, qty: 2 });
  assert.equal(c.mods[1].qty, 20);
  assert.equal(c.mods[1].price, 60);
});

test('SERVER: a size that is not a live size of the dish is dropped; a free text line carries nothing', () => {
  const bad = sanitiseChoice({ lineItemId: 'm-steak', variantItemId: 'm-steak-old', rows: ROWS, groups: GROUPS, instDefs: DEFS, mods: [] });
  assert.equal(bad.variantItemId, null);
  assert.equal(bad.variantName, null);
  const other = sanitiseChoice({ lineItemId: 'm-steak', variantItemId: 'm-soup', rows: ROWS, groups: GROUPS, mods: [] });
  assert.equal(other.variantItemId, null);
  const free = sanitiseChoice({ lineItemId: null, variantItemId: 'm-steak-8', rows: ROWS, groups: GROUPS, mods: [{ id: 'o-pep' }] });
  assert.deepEqual(free, { mods: [], variantItemId: null, variantName: null });
});

test('SERVER: the list is capped', () => {
  const many = Array.from({ length: 80 }, () => ({ id: 'o-pep', name: 'Peppercorn sauce' }));
  const c = sanitiseChoice({ lineItemId: 'm-steak', rows: ROWS, groups: GROUPS, mods: many });
  assert.equal(c.mods.length, MAX_CHOICE_MODS);
});
