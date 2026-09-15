// The shared menu rules (lib/menuRules.js), with the live Provo rows from 15 Sep 2026.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isOptionOnlyItem, assignmentGroupId, sizeOrMainOptions, modifierGroupMin, modifierGroupRequired,
  instructionGroupMin, moveMainProductOptions,
} from './menuRules.js';

// Live rows (Ops DB, Provo).
const NO_ICE = { id: 'm-1776807172397', name: 'No Ice', type: 'subitem', sold_alone: false, cat: 'cat-1776803885509' };
const MILK = { id: 'mgd-1776289719220', name: 'Milk', min: 1, max: 1, min_select: 0, max_select: 1, selection_type: 'single' };
const SOFT_OPTIONS = { id: 'mgd-1776807157339', name: 'Soft Drinks Options', min: 0, max: 99, min_select: 0, max_select: 1 };
const COOK = { id: 'igd-cook-temp', name: 'Cooking preference', min: null, max: null };

test('1. an option only sub item is never a product; every other row is left alone', () => {
  assert.equal(isOptionOnlyItem(NO_ICE), true);                                   // raw row
  assert.equal(isOptionOnlyItem({ type: 'subitem', soldAlone: false }), true);     // store row
  assert.equal(isOptionOnlyItem({ type: 'subitem' }), true);                        // flag missing: the till hid it
  assert.equal(isOptionOnlyItem({ type: 'subitem', sold_alone: null }), true);
  assert.equal(isOptionOnlyItem({ type: 'subitem', soldAlone: true }), false);
  assert.equal(isOptionOnlyItem({ type: 'subitem', sold_alone: true }), false);
  // The store shape wins over a stale raw field, as the till reads soldAlone.
  assert.equal(isOptionOnlyItem({ type: 'subitem', soldAlone: true, sold_alone: false }), false);
  for (const type of ['simple', 'variants', 'modifiable', 'pizza', 'combo', undefined]) {
    assert.equal(isOptionOnlyItem({ type, soldAlone: false, sold_alone: false }), false, String(type));
  }
  assert.equal(isOptionOnlyItem(null), false);
});

test('1. same answer as the till\'s own expression for every flag value', () => {
  const till = (i) => i.type === 'subitem' && !i.soldAlone;   // POSSurface, BarSurface before v5.8.70
  for (const type of ['subitem', 'simple', 'variants']) {
    for (const soldAlone of [true, false, undefined, null, 0, 1]) {
      assert.equal(isOptionOnlyItem({ type, soldAlone }), till({ type, soldAlone }), `${type} ${soldAlone}`);
    }
  }
});

test('assignmentGroupId reads every saved shape', () => {
  assert.equal(assignmentGroupId('mgd-1'), 'mgd-1');
  assert.equal(assignmentGroupId({ groupId: 'mgd-2', min: 0, max: 1 }), 'mgd-2');
  assert.equal(assignmentGroupId({ id: 'mgd-3' }), 'mgd-3');
  assert.equal(assignmentGroupId(''), null);
  assert.equal(assignmentGroupId({}), null);
  assert.equal(assignmentGroupId(7), null);
});

test('2. a size uses its own options, the main product\'s only when it has none', () => {
  const own = [{ groupId: MILK.id }];
  const main = [{ groupId: SOFT_OPTIONS.id }];
  assert.equal(sizeOrMainOptions(own, main), own);
  assert.equal(sizeOrMainOptions([], main), main);
  assert.equal(sizeOrMainOptions(undefined, main), main);
  assert.deepEqual(sizeOrMainOptions(undefined, undefined), []);
  // Latte (live): the sizes carry Milk, the main product's leftovers are never used.
  const latteMain = [{ max: 1, min: 0, groupId: 'mgd-1776287941070' }, { max: 1, min: 0, groupId: MILK.id }];
  const small = [{ max: 1, min: 0, groupId: 'mgd-1776287941070' }, { max: 1, min: 0, groupId: MILK.id }];
  const medium = [{ max: 1, min: 0, groupId: MILK.id }];
  assert.equal(sizeOrMainOptions(medium, latteMain), medium);
  assert.equal(sizeOrMainOptions(small, latteMain), small);
  // Americano (live): no size has options, so Milk comes from the main product.
  const americanoMain = [{ groupId: MILK.id }];
  assert.equal(sizeOrMainOptions([], americanoMain), americanoMain);
});

test('3. Milk is required: the group decides, not an item\'s old min 0 copy', () => {
  assert.equal(modifierGroupMin(MILK), 1);
  assert.equal(modifierGroupRequired(MILK), true);
  assert.equal(modifierGroupRequired(SOFT_OPTIONS), false);
  assert.equal(modifierGroupMin({ min: null }), 0);
  assert.equal(modifierGroupMin({ min: -2 }), 0);
  assert.equal(modifierGroupMin({ min: 3 }), 3);
  assert.equal(modifierGroupRequired(null), false);
  // Same answer as the till's InlineItemFlow: required: (def.min ?? 0) > 0.
  for (const min of [0, 1, 2, null, undefined]) {
    assert.equal(modifierGroupRequired({ min }), (min ?? 0) > 0, String(min));
  }
});

test('4. Cooking preference: required only when the item or the group says so', () => {
  assert.equal(instructionGroupMin('igd-cook-temp', COOK), 0);                       // plain id: optional
  assert.equal(instructionGroupMin({ groupId: COOK.id }, COOK), 0);                    // no min: optional
  assert.equal(instructionGroupMin({ groupId: COOK.id, min: 1 }, COOK), 1);            // Flow tab: required
  assert.equal(instructionGroupMin({ groupId: COOK.id, min: 0 }, { ...COOK, min: 1 }), 0);
  assert.equal(instructionGroupMin({ groupId: COOK.id, min: null }, { ...COOK, min: 1 }), 1);
  assert.equal(instructionGroupMin(null, null), 0);
  // Same answer as the till's InlineItemFlow and the Flow tab: a.min ?? def.min ?? 0 > 0.
  for (const a of [undefined, null, 0, 1]) {
    for (const d of [undefined, null, 0, 1]) {
      const till = ({ min: a }.min ?? { min: d }.min ?? 0) > 0;
      assert.equal(instructionGroupMin({ min: a }, { min: d }) > 0, till, `${a} ${d}`);
    }
  }
});

test('5. options left on a main product move onto the sizes that have none', () => {
  // Americano (live): Milk only on the main product.
  const americano = { id: 'm-impmo51s7x4-0', assignedModifierGroups: [{ groupId: MILK.id }], assignedInstructionGroups: [] };
  const sizes = ['1', '2', '3'].map(n => ({ id: `m-impmo51s7x4-${n}`, assignedModifierGroups: [], assignedInstructionGroups: [] }));
  const move = moveMainProductOptions(americano, sizes);
  assert.deepEqual(move.mainPatch, { assignedModifierGroups: [], assignedInstructionGroups: [] });
  assert.deepEqual(move.sizePatches, sizes.map(s => ({ id: s.id, patch: { assignedModifierGroups: [{ groupId: MILK.id }] } })));
  // Copies, not the same objects.
  assert.notEqual(move.sizePatches[0].patch.assignedModifierGroups[0], americano.assignedModifierGroups[0]);
  // What each size shows is unchanged by the move (rule 2).
  for (const s of sizes) {
    const before = sizeOrMainOptions(s.assignedModifierGroups, americano.assignedModifierGroups);
    const after = sizeOrMainOptions(move.sizePatches.find(p => p.id === s.id).patch.assignedModifierGroups, move.mainPatch.assignedModifierGroups);
    assert.deepEqual(after, before);
  }

  // Latte (live): every size has its own, so the leftovers are just cleared.
  const latte = { id: 'm-1776286744987', assigned_modifier_groups: [{ groupId: 'mgd-1776287941070' }, { groupId: MILK.id }] };
  const latteSizes = [{ id: 's', assigned_modifier_groups: [{ groupId: MILK.id }] }, { id: 'm', assigned_modifier_groups: [{ groupId: MILK.id }] }];
  assert.deepEqual(moveMainProductOptions(latte, latteSizes), { mainPatch: { assignedModifierGroups: [], assignedInstructionGroups: [] }, sizePatches: [] });

  // Kinds are separate: a size with its own modifiers still takes the main product's instructions.
  const steak = { id: 'st', assignedModifierGroups: [{ groupId: 'mgd-sides' }], assignedInstructionGroups: [{ groupId: COOK.id, min: 1 }] };
  const steakSizes = [{ id: '8oz', assignedModifierGroups: [{ groupId: 'mgd-sauce' }] }, { id: '10oz', assignedInstructionGroups: [{ groupId: 'igd-x' }] }];
  assert.deepEqual(moveMainProductOptions(steak, steakSizes).sizePatches, [
    { id: '8oz', patch: { assignedInstructionGroups: [{ groupId: COOK.id, min: 1 }] } },
    { id: '10oz', patch: { assignedModifierGroups: [{ groupId: 'mgd-sides' }] } },
  ]);

  // Nothing to move.
  assert.equal(moveMainProductOptions(americano, []), null);
  assert.equal(moveMainProductOptions({ id: 'x', assignedModifierGroups: [] }, sizes), null);
  assert.equal(moveMainProductOptions(null, sizes), null);
});
