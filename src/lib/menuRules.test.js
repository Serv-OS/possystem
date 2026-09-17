// The shared menu rules (lib/menuRules.js), with the live Provo rows from 15 Sep 2026.

import test from 'node:test';
import assert from 'node:assert/strict';
import { isOptionOnlyItem, assignmentGroupId, sizeOrMainOptions, modifierGroupMin, modifierGroupRequired, instructionGroupMin, moveMainProductOptions, resolveSoldAlone, soldAlonePatchForTypeChange, subitemNameIndex } from './menuRules.js';

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

// 17 Sep 2026: "Sold alone" switched itself ON for sub items. Every writer saved
// sold_alone = soldAlone ?? sold_alone ?? true, and Back Office makes a sub item by adding a plain
// item and then tapping the "Sub item" chip, so the flag was never set and the save wrote true.
const OTHER_TYPES = ['simple', 'modifiable', 'variants', 'combo', 'pizza', 'spacer', undefined];
const oldWriterDefault = (item) => item.soldAlone ?? item.sold_alone ?? true;   // db.js before the fix

test('6. nobody chose: a sub item is NOT sold alone, every other type is', () => {
  assert.equal(resolveSoldAlone({ type: 'subitem' }), false);
  assert.equal(resolveSoldAlone({ type: 'subitem', soldAlone: undefined }), false);
  assert.equal(resolveSoldAlone({ type: 'subitem', soldAlone: null }), false);
  assert.equal(resolveSoldAlone({ type: 'subitem', sold_alone: null }), false);
  assert.equal(resolveSoldAlone({ type: 'subitem', soldAlone: null, sold_alone: null }), false);
  // The bug: the old writer said true here.
  assert.equal(oldWriterDefault({ type: 'subitem' }), true);
  // Online ordering and the HubRise catalog hide ANY item with sold_alone false, so a plain
  // product with no flag must stay true.
  for (const type of OTHER_TYPES) {
    assert.equal(resolveSoldAlone({ type }), true, String(type));
    assert.equal(resolveSoldAlone({ type, soldAlone: null, sold_alone: null }), true, String(type));
  }
  assert.equal(resolveSoldAlone(null), true);
  assert.equal(resolveSoldAlone(undefined), true);
});

test('6. a real choice is kept untouched, for every type', () => {
  for (const type of ['subitem', ...OTHER_TYPES]) {
    assert.equal(resolveSoldAlone({ type, soldAlone: true }), true, String(type));
    assert.equal(resolveSoldAlone({ type, soldAlone: false }), false, String(type));
    assert.equal(resolveSoldAlone({ type, sold_alone: true }), true, String(type));     // raw row
    assert.equal(resolveSoldAlone({ type, sold_alone: false }), false, String(type));
    // The store shape wins over a stale raw field (a loaded row carries both).
    assert.equal(resolveSoldAlone({ type, soldAlone: false, sold_alone: true }), false, String(type));
    assert.equal(resolveSoldAlone({ type, soldAlone: true, sold_alone: false }), true, String(type));
    // A missing store field falls back to the raw row.
    assert.equal(resolveSoldAlone({ type, soldAlone: undefined, sold_alone: true }), true, String(type));
    assert.equal(resolveSoldAlone({ type, soldAlone: null, sold_alone: false }), false, String(type));
  }
  // Chips (sub item, sold as a side on purpose) stays on sale through any save.
  assert.equal(resolveSoldAlone({ id: 'sub-chips', type: 'subitem', soldAlone: true, cat: 'cat-sides' }), true);
});

test('6. what is saved and what the till shows agree', () => {
  // A sub item with no flag is hidden on the till (rule 1). The saved row now says the same.
  for (const flag of [undefined, null]) {
    const item = { type: 'subitem', soldAlone: flag };
    assert.equal(isOptionOnlyItem(item), true);
    assert.equal(isOptionOnlyItem({ type: 'subitem', sold_alone: resolveSoldAlone(item) }), true);
    // Before: the saved row came back as a product after a refresh.
    assert.equal(isOptionOnlyItem({ type: 'subitem', sold_alone: oldWriterDefault(item) }), false);
  }
});

// The merge store updateMenuItem does (menuRulesUsage.test.js checks the store uses this exact one).
const applyEdit = (item, patch) => ({ ...item, ...patch, ...soldAlonePatchForTypeChange(item, patch) });

test('7. tapping the "Sub item" chip turns Sold alone OFF, and the save writes false', () => {
  // Back Office adds every item as a plain item (soldAlone stamped true at birth, rule 6).
  const born = { id: 'm-1', type: 'simple', cat: 'cat-drinks', visibility: { pos: true, kiosk: true, online: true } };
  born.soldAlone = resolveSoldAlone(born);
  assert.equal(born.soldAlone, true);
  // The chip sends only the type.
  const asSub = applyEdit(born, { type: 'subitem' });
  assert.equal(asSub.soldAlone, false);
  assert.equal(resolveSoldAlone(asSub), false);          // what upsertMenuItem writes
  assert.equal(isOptionOnlyItem(asSub), true);            // hidden from the till and kiosk
  // Nothing else moves: there is no screen to put visibility back.
  assert.deepEqual(asSub.visibility, born.visibility);
  assert.equal(asSub.cat, born.cat);
  // An item made before the fix, flag never set in memory.
  assert.deepEqual(soldAlonePatchForTypeChange({ type: 'simple' }, { type: 'subitem' }), { soldAlone: false });
  assert.deepEqual(soldAlonePatchForTypeChange({ type: 'modifiable', sold_alone: true }, { type: 'subitem' }), { soldAlone: false });
});

test('7. a choice made in the same edit always wins', () => {
  assert.deepEqual(soldAlonePatchForTypeChange({ type: 'simple' }, { type: 'subitem', soldAlone: true }), {});
  assert.deepEqual(soldAlonePatchForTypeChange({ type: 'simple' }, { type: 'subitem', sold_alone: true }), {});
  assert.deepEqual(soldAlonePatchForTypeChange({ type: 'subitem', soldAlone: true }, { type: 'simple', soldAlone: false }), {});
  assert.equal(applyEdit({ type: 'simple', soldAlone: true }, { type: 'subitem', soldAlone: true }).soldAlone, true);
  // A flag that is present but empty is not a choice.
  assert.deepEqual(soldAlonePatchForTypeChange({ type: 'simple' }, { type: 'subitem', soldAlone: undefined }), { soldAlone: false });
});

test('7. an item that already is a sub item is never touched by a save', () => {
  const chips = { id: 'sub-chips', type: 'subitem', soldAlone: true, cat: 'cat-sides' };
  for (const patch of [{ pricing: { base: 3.5 } }, { menuName: 'Fries' }, { cat: 'cat-x' }, { type: 'subitem' }, { type: 'subitem', subGroup: 'Sides' }, {}]) {
    assert.deepEqual(soldAlonePatchForTypeChange(chips, patch), {}, JSON.stringify(patch));
    assert.equal(applyEdit(chips, patch).soldAlone, true, JSON.stringify(patch));
  }
  // Same for one that is only an option, and for saved rows nobody may bulk change.
  assert.equal(applyEdit({ type: 'subitem', soldAlone: false }, { pricing: { base: 1 } }).soldAlone, false);
  assert.equal(resolveSoldAlone(applyEdit({ type: 'subitem', sold_alone: true }, { pricing: { base: 1 } })), true);
  // A plain product is never switched off by a save or by a change between plain types.
  for (const patch of [{ pricing: { base: 9 } }, { type: 'modifiable' }, { type: 'variants' }, { type: 'simple' }, { type: undefined }]) {
    assert.deepEqual(soldAlonePatchForTypeChange({ type: 'simple', soldAlone: true }, patch), {}, JSON.stringify(patch));
  }
  assert.deepEqual(soldAlonePatchForTypeChange(null, { type: 'subitem' }), {});
  assert.deepEqual(soldAlonePatchForTypeChange({ type: 'simple' }, null), {});
});

test('7. a wrong tap on the chip is undone by tapping back: the product is on sale again', () => {
  const burger = { id: 'm-b', type: 'simple', soldAlone: true, sold_alone: true, cat: 'cat-mains', visibility: { pos: true, kiosk: true, online: true } };
  const wrong = applyEdit(burger, { type: 'subitem' });
  assert.equal(wrong.soldAlone, false);
  const back = applyEdit(wrong, { type: 'simple' });
  assert.equal(back.soldAlone, true);
  assert.equal(resolveSoldAlone(back), true);             // online and HubRise hide sold_alone false
  assert.deepEqual(back.visibility, burger.visibility);
  assert.equal(back.cat, burger.cat);
  // A sub item turned into a plain product goes on sale: only sub items have the switch.
  assert.deepEqual(soldAlonePatchForTypeChange({ type: 'subitem', soldAlone: false }, { type: 'modifiable' }), { soldAlone: true });
  assert.deepEqual(soldAlonePatchForTypeChange({ type: 'subitem' }, { type: 'simple' }), { soldAlone: true });
});

test('rule 8: sub item name index, allergens and 86 see every sub item, pictures only sold alone ones', () => {
  const items = [
    { id: 'm1', type: 'subitem', name: 'Pistachio milk', soldAlone: false, allergens: ['nuts'], image: 'p.jpg' },
    { id: 'm2', type: 'subitem', name: 'Oat milk', menuName: 'Oat', sold_alone: true, allergens: ['gluten'] },
    { id: 'm3', type: 'subitem', name: 'Soy milk', archived: true, soldAlone: true },
    { id: 'b1', type: 'simple', name: 'Pistachio milk' },
    { id: 'm4', type: 'subitem', name: 'Rice milk' },   // flag missing: a sub item defaults to not sold alone
  ];
  const any = subitemNameIndex(items);
  const sold = subitemNameIndex(items, { soldAloneOnly: true });
  assert.equal(any.get('pistachio milk').id, 'm1', 'an option only sub item is found for allergens and 86');
  assert.deepEqual(any.get('pistachio milk').allergens, ['nuts']);
  assert.equal(sold.get('pistachio milk'), undefined, 'its picture is not shown to customers');
  assert.equal(sold.get('oat').id, 'm2', 'aliases are indexed, snake case flag read');
  assert.equal(any.has('soy milk'), false, 'archived rows are skipped');
  assert.equal(any.get('rice milk').id, 'm4');
  assert.equal(sold.has('rice milk'), false);
  assert.equal(subitemNameIndex(null).size, 0);
});
