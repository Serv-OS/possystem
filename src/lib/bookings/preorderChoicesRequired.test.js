/**
 * preorderChoicesRequired.test.js — required cooking temperatures and the
 * choice matcher, with the shapes Back Office really writes (10 Sep 2026
 * review). The Required toggle saves { groupId, min: 1 } on the ITEM; the
 * instruction group defs have no required field at all.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  instructionEntriesOf, optionGroupIdsFor, requiredInstructionGroups, missingInstructionGroups,
  itemNeedsSheetReturn, choiceConfigured, matchChoice, sanitiseChoice,
} from './preorderChoices.js';

const DEFS = [
  { id: 'igd-cook-temp', name: 'Cooking temperature', options: ['Rare', 'Medium rare', 'Well done'] },
  { id: 'igd-sauce-side', name: 'Sauce on the side', options: ['Yes', 'No'] },
];
const ROWS = [
  { id: 'm-ribeye', name: 'Ribeye', type: 'variants',
    assigned_modifier_groups: ['g-sauce'],
    assigned_instruction_groups: [{ groupId: 'igd-cook-temp', min: 1 }, { groupId: 'igd-sauce-side', min: 0 }] },
  { id: 'm-ribeye-8', name: '8oz', parent_id: 'm-ribeye' },
  { id: 'm-ribeye-12', name: '12oz', parent_id: 'm-ribeye' },
  { id: 'm-fillet', name: 'Fillet', assigned_instruction_groups: [{ groupId: 'igd-cook-temp', min: 1 }] },
  { id: 'm-salad', name: 'Salad', assigned_instruction_groups: ['igd-sauce-side'] },
];
const GROUPS = [{ id: 'g-sauce', name: 'Sauce', min: 0, max: 1, options: [{ id: 'o-pep', name: 'Peppercorn', price: 2.5 }] }];
const row = (id) => ROWS.find((r) => r.id === id);

test('instruction entries keep the per item minimum; a size uses the dish entries', () => {
  assert.deepEqual(instructionEntriesOf(['a', { groupId: 'b', min: 1 }, { id: 'c' }, null]),
    [{ groupId: 'a', min: undefined }, { groupId: 'b', min: 1 }, { groupId: 'c', min: undefined }]);
  assert.deepEqual(optionGroupIdsFor(row('m-ribeye-12'), ROWS).inst, ['igd-cook-temp', 'igd-sauce-side']);
  assert.deepEqual(optionGroupIdsFor(row('m-ribeye-12'), ROWS).instEntries[0], { groupId: 'igd-cook-temp', min: 1 });
});

test('required groups come from the item min (or a def min, or def.required), never from a def field Back Office does not write', () => {
  assert.deepEqual(requiredInstructionGroups(row('m-ribeye'), ROWS, DEFS).map((d) => d.id), ['igd-cook-temp']);
  assert.deepEqual(requiredInstructionGroups(row('m-salad'), ROWS, DEFS), []);
  assert.deepEqual(requiredInstructionGroups(row('m-salad'), ROWS, [{ ...DEFS[1], min: 1 }]).map((d) => d.id), ['igd-sauce-side']);
  assert.deepEqual(requiredInstructionGroups(row('m-salad'), ROWS, [{ ...DEFS[1], required: true }]).map((d) => d.id), ['igd-sauce-side']);
  assert.deepEqual(requiredInstructionGroups(row('m-fillet'), ROWS, []), [], 'no defs loaded: nothing can be required');
});

test('a steak with no sizes and only a required temperature needs the sheet', () => {
  assert.equal(itemNeedsSheetReturn(row('m-fillet'), ROWS, { instDefs: DEFS }), true);
  assert.equal(itemNeedsSheetReturn(row('m-salad'), ROWS, { instDefs: DEFS, groupMin: {} }), false);
});

test('the lens case: 12oz with peppercorn and NO temperature is not configured', () => {
  const pick = { name: 'Ribeye', variantItemId: 'm-ribeye-12', mods: [{ id: 'o-pep', name: 'Peppercorn', price: 2.5 }], configured: true };
  assert.equal(choiceConfigured(pick), true, 'without the menu row the old rule still applies');
  assert.equal(choiceConfigured(pick, { item: row('m-ribeye'), rows: ROWS, instDefs: DEFS }), false);
  assert.deepEqual(missingInstructionGroups({ item: row('m-ribeye-12'), rows: ROWS, instDefs: DEFS, mods: pick.mods }).map((d) => d.id), ['igd-cook-temp']);
  // The sheet's shape answers it.
  const sheet = { ...pick, mods: [...pick.mods, { id: 'ig-igd-cook-temp-Rare', name: 'Rare', label: 'Rare', groupLabel: 'Cooking temperature', price: 0, _instruction: true }] };
  assert.equal(choiceConfigured(sheet, { item: row('m-ribeye'), rows: ROWS, instDefs: DEFS }), true);
  // So does the till's shape (no id, the group's name).
  const till = { ...pick, mods: [...pick.mods, { groupLabel: 'cooking temperature', label: 'Rare', price: 0, _instruction: true }] };
  assert.equal(choiceConfigured(till, { item: row('m-ribeye'), rows: ROWS, instDefs: DEFS }), true);
  // The server keeps the temperature it is sent.
  const kept = sanitiseChoice({ lineItemId: 'm-ribeye', variantItemId: 'm-ribeye-12', mods: sheet.mods, rows: ROWS, groups: GROUPS, instDefs: DEFS });
  assert.deepEqual(kept.mods.map((m) => m.name), ['Peppercorn', 'Rare']);
});

test('matchChoice: course plus name, then name, then item; a dish in two courses lands in the right one', () => {
  const groups = [
    { course: 1, options: [{ name: 'Soup', itemId: 'm-soup' }, { name: 'Small ribeye', itemId: 'm-ribeye' }] },
    { course: 2, options: [{ name: 'Ribeye', itemId: 'm-ribeye' }, { name: 'Fish', itemId: 'm-fish' }] },
  ];
  assert.equal(matchChoice(groups, { course: 2, name: 'Ribeye', itemId: 'm-ribeye' }).g.course, 2);
  assert.equal(matchChoice(groups, { course: 1, name: 'Small ribeye', itemId: 'm-ribeye' }).g.course, 1);
  assert.equal(matchChoice(groups, { course: '2', name: 'Ribeye' }).opt.name, 'Ribeye');
  assert.equal(matchChoice(groups, { name: 'Fish' }).g.course, 2, 'an older page sends only the name');
  assert.equal(matchChoice(groups, { displayName: 'Soup' }).opt.itemId, 'm-soup');
  assert.equal(matchChoice(groups, { itemId: 'm-fish' }).opt.name, 'Fish', 'item id as the last resort');
  assert.equal(matchChoice(groups, { name: 'Lobster' }), null);
  assert.equal(matchChoice(null, { name: 'Soup' }), null);
});
