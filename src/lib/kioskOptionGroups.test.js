// Kiosk item screen groups for items with sizes (lib/kioskOptionGroups.js).
//
// The owner's report (Provo, 14 Sep): the Pepsi Max sheet showed Size and "Anything else?"
// but no No Ice or No Lemon. Pepsi Max's parent carries no groups; both sizes carry "Soft
// Drinks Options". The kiosk read only the parent's groups. The till (InlineItemFlow.jsx, the
// flow the POS and bar run) shows the picked size's own groups, and the parent's only when the
// size has none. The owner: options are set on the variants, not the master product.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {
  kioskModifierAssignments, kioskInstructionAssignments, kioskOptionGroupPlan, kioskSheetGroupIds,
  kioskSheetInstructionIds, kioskSheetGroups, kioskPruneSelections, kioskPruneNestedSelections,
  validateSelections, priceDelta, buildModsArray, summarizeForDisplay,
} from './kioskOptionGroups.js';
import { normalizeGroup, kioskSheetGroupHint } from './kioskGroupRules.js';
import { orderOptionFlow } from './optionFlow.js';
import { kioskVariant, kioskOrderItem, kioskDepleteItem, kioskLineKey } from './kioskLine.js';
import { kioskLineKeyV2 } from './kioskBasket.js';
import { displayName } from './itemDisplay.js';

// ── The live rows (Provo, Ops DB) ───────────────────────────────────────────
const SOFT = 'cat-1776803885509';
const SOFT_OPTIONS_ID = 'mgd-1776807157339';
const NO_ICE_OPT = 'opt-1776807218824-m-1776807172397';
const NO_LEMON_OPT = 'opt-1776807222077-m-1776807202338';
const PEPSI_MAX = { id: 'm-impmo951ym5-0', name: 'Pepsi Max', type: 'variants', sold_alone: true, cat: SOFT, parent_id: null, assigned_modifier_groups: [], description: '0 kcal | 0 kcal' };
const PM_REGULAR = { id: 'm-impmo951ym5-1', name: 'Regular', type: 'simple', parent_id: PEPSI_MAX.id, cat: SOFT, pricing: { base: 3 }, assigned_modifier_groups: [{ groupId: SOFT_OPTIONS_ID }] };
const PM_LARGE = { id: 'm-impmo951ym5-2', name: 'Large', type: 'simple', parent_id: PEPSI_MAX.id, cat: SOFT, pricing: { base: 4.5 }, assigned_modifier_groups: [{ groupId: SOFT_OPTIONS_ID }] };
const SOFT_OPTIONS = {
  id: SOFT_OPTIONS_ID, name: 'Soft Drinks Options', min_select: 0, max_select: 1, min: 0, max: 99, selection_type: 'multiple',
  options: [{ id: NO_ICE_OPT, name: 'No Ice', price: 0 }, { id: NO_LEMON_OPT, name: 'No Lemon', price: 0 }],
};

// Latte: the parent carries 2 groups; Medium and Large carry Milk with a min 0 max 1
// override; Small carries an EXTRA group as well.
const MILK_ID = 'mgd-1776289719220';
const EXTRA_ID = 'mgd-1776287941070';
const SYRUP_ID = 'mgd-latte-syrup';
const MATCHA_EXTRA_ID = 'mgd-1782758602598';
const LATTE = { id: 'm-latte', name: 'Latte', type: 'variants', cat: 'coffee', assigned_modifier_groups: [{ groupId: MILK_ID }, { groupId: SYRUP_ID }] };
const L_SMALL = { id: 'm-latte-s', name: 'Small', type: 'simple', parent_id: 'm-latte', pricing: { base: 2.8 }, assigned_modifier_groups: [{ max: 1, min: 0, groupId: EXTRA_ID }, { max: 1, min: 0, groupId: MILK_ID }] };
const L_MEDIUM = { id: 'm-latte-m', name: 'Medium', type: 'simple', parent_id: 'm-latte', pricing: { base: 3.2 }, assigned_modifier_groups: [{ max: 1, min: 0, groupId: MILK_ID }] };
const L_LARGE = { id: 'm-latte-l', name: 'Large', type: 'simple', parent_id: 'm-latte', pricing: { base: 3.6 }, assigned_modifier_groups: [{ max: 1, min: 0, groupId: MILK_ID }] };
const MILK = { id: MILK_ID, name: 'Milk', selection_type: 'single', min: 1, max: 1, options: [{ id: 'o-oat', name: 'Oat', price: 0.4 }, { id: 'o-whole', name: 'Whole', price: 0 }] };
const SYRUP = { id: SYRUP_ID, name: 'Syrup', selection_type: 'multiple', min: 0, max: 2, options: [{ id: 'o-van', name: 'Vanilla', price: 0.5 }] };
const EXTRA = { id: EXTRA_ID, name: 'Babyccino', selection_type: 'single', min: 1, max: 1, options: [{ id: 'o-choc', name: 'Chocolate dust', price: 0, subGroupId: 'mg-sprinkle' }, { id: 'o-plain', name: 'Plain', price: 0 }] };
const MATCHA_EXTRA = { id: MATCHA_EXTRA_ID, name: 'Sweetener', selection_type: 'multiple', min: 0, max: 2, options: [{ id: 'o-honey', name: 'Honey', price: 0.3 }] };

// Matcha: the parent carries no groups; every size carries two.
const MATCHA = { id: 'm-matcha', name: 'Matcha', type: 'variants', assigned_modifier_groups: [] };
const M_REG = { id: 'm-matcha-r', name: 'Regular', parent_id: 'm-matcha', assigned_modifier_groups: [{ groupId: MILK_ID }, { groupId: MATCHA_EXTRA_ID }] };
const M_LG = { id: 'm-matcha-l', name: 'Large', parent_id: 'm-matcha', assigned_modifier_groups: [{ groupId: MILK_ID }, { groupId: MATCHA_EXTRA_ID }] };

const ROWS = new Map([SOFT_OPTIONS, MILK, SYRUP, EXTRA, MATCHA_EXTRA].map(g => [g.id, g]));

// The Size group exactly as KioskProductModal synthesises it (absolute prices).
const sizeGroupFor = (sizes) => normalizeGroup({
  id: '__variants__', name: 'Size', selection_type: 'single', min: 1, max: 1, min_select: 1, max_select: 1,
  __isVariantGroup: true, __cheapestPrice: Math.min(...sizes.map(s => s.pricing?.base ?? 0)),
  options: sizes.map(c => ({ id: c.id, name: c.name, itemId: c.id, price: 0, __absolutePrice: c.pricing?.base ?? 0 })),
});

// What the sheet shows for a pick, built the way KioskProductModal builds it.
function sheet(parent, sizes, pickedSizeId, { rows = ROWS, defs = [] } = {}) {
  const plan = kioskOptionGroupPlan({ parent, sizes, pickedSizeId });
  const groups = kioskSheetGroups({
    plan, sizeGroup: sizes.length ? sizeGroupFor(sizes) : null, groupRows: rows, instructionDefs: defs, normalizeGroup, orderOptionFlow,
  });
  return { plan, groups };
}
const shown = (groups) => groups.map(g => [g.id, g._min, g._max]);

// ── Pepsi Max ───────────────────────────────────────────────────────────────

test('Pepsi Max: Soft Drinks Options shows before a size is picked, and after either size', () => {
  const sizes = [PM_REGULAR, PM_LARGE];
  const before = sheet(PEPSI_MAX, sizes, null);
  assert.equal(before.plan.sizeId, null);
  assert.deepEqual(before.plan.modifiers, [{ id: SOFT_OPTIONS_ID, min: null, max: null }]);
  assert.deepEqual(shown(before.groups), [['__variants__', 1, 1], [SOFT_OPTIONS_ID, 0, 99]]);
  assert.deepEqual(before.groups[1].options.map(o => o.name), ['No Ice', 'No Lemon']);
  for (const size of sizes) {
    const after = sheet(PEPSI_MAX, sizes, size.id);
    assert.equal(after.plan.sizeId, size.id);
    // The same groups in the same place: nothing jumps when a size is tapped.
    assert.deepEqual(shown(after.groups), shown(before.groups));
  }
  // Nothing is preselected and the Size group still blocks Add until a size is picked.
  assert.equal(validateSelections(before.groups, {}, {}, {}), 'Pick a Size');
  assert.equal(validateSelections(before.groups, { __variants__: [PM_REGULAR.id] }, {}, {}), null);
  // Before the fix: only the parent's (empty) list was read.
  assert.deepEqual(kioskModifierAssignments(PEPSI_MAX.assigned_modifier_groups), []);
});

test('the sheet reads the parent\'s and every offered size\'s groups in one query', () => {
  assert.deepEqual(kioskSheetGroupIds(PEPSI_MAX, [PM_REGULAR, PM_LARGE]), [SOFT_OPTIONS_ID]);
  assert.deepEqual(kioskSheetGroupIds(LATTE, [L_SMALL, L_MEDIUM, L_LARGE]), [MILK_ID, SYRUP_ID, EXTRA_ID]);
  assert.deepEqual(kioskSheetGroupIds(MATCHA, [M_REG, M_LG]), [MILK_ID, MATCHA_EXTRA_ID]);
  assert.deepEqual(kioskSheetGroupIds({ assigned_modifier_groups: ['a', { id: 'b' }, null, 7] }, null), ['a', 'b']);
  assert.deepEqual(kioskSheetInstructionIds({ assigned_instruction_groups: ['t'] }, [{ assigned_instruction_groups: [{ groupId: 'l' }, 't'] }]), ['t', 'l']);
});

// ── Latte ───────────────────────────────────────────────────────────────────

test('Latte: the picked size\'s own groups; the parent\'s leftover groups are not shown', () => {
  const sizes = [L_SMALL, L_MEDIUM, L_LARGE];
  // Before a pick: only what every size shows. Milk is on every size (same override); the
  // parent's Syrup is NOT shown (every size has its own groups, so the till ignores the parent's).
  const before = sheet(LATTE, sizes, null);
  assert.deepEqual(shown(before.groups), [['__variants__', 1, 1], [MILK_ID, 0, 1]]);
  // Medium: the same groups.
  assert.deepEqual(shown(sheet(LATTE, sizes, L_MEDIUM.id).groups), shown(before.groups));
  // Small: its own two groups in its own order, with its override on Milk.
  const small = sheet(LATTE, sizes, L_SMALL.id);
  assert.deepEqual(shown(small.groups), [['__variants__', 1, 1], [EXTRA_ID, 0, 1], [MILK_ID, 0, 1]]);
  assert.deepEqual(small.plan.modifiers, [{ id: EXTRA_ID, min: 0, max: 1 }, { id: MILK_ID, min: 0, max: 1 }]);
  // The parent alone (no sizes) keeps its own groups and the Milk row's own rule (required).
  assert.deepEqual(shown(sheet(LATTE, [], null).groups), [[MILK_ID, 1, 1], [SYRUP_ID, 0, 2]]);
});

test('a size with no groups (or only deleted ones) uses the parent\'s, as the till does', () => {
  const parent = { id: 'p', assigned_modifier_groups: [{ groupId: MILK_ID, min: 1 }] };
  const a = { id: 'a', parent_id: 'p', assigned_modifier_groups: [{ groupId: MILK_ID, min: 0, max: 1 }, { groupId: SYRUP_ID, max: 1 }] };
  const b = { id: 'b', parent_id: 'p', assigned_modifier_groups: [] };
  assert.deepEqual(kioskOptionGroupPlan({ parent, sizes: [a, b], pickedSizeId: 'b' }).modifiers, [{ id: MILK_ID, min: 1, max: null }]);
  assert.deepEqual(kioskOptionGroupPlan({ parent, sizes: [a, b], pickedSizeId: 'a' }).modifiers, [{ id: MILK_ID, min: 0, max: 1 }, { id: SYRUP_ID, min: null, max: 1 }]);
  // Before a pick: Milk is the one group both sizes show, with the first size's assignment.
  assert.deepEqual(kioskOptionGroupPlan({ parent, sizes: [a, b] }).modifiers, [{ id: MILK_ID, min: 0, max: 1 }]);
  // The live Latte shape: a size whose ONLY group was deleted falls back to the parent's once
  // the rows are known (the till only counts groups that exist); before the rows load it does not.
  const gone = { id: 'g', parent_id: 'p', assigned_modifier_groups: [{ groupId: 'mgd-deleted' }] };
  const rows = new Map([[MILK_ID, MILK], [SYRUP_ID, SYRUP]]);
  assert.deepEqual(kioskOptionGroupPlan({ parent, sizes: [gone], pickedSizeId: 'g', groupRows: rows }).modifiers, [{ id: MILK_ID, min: 1, max: null }]);
  assert.deepEqual(kioskOptionGroupPlan({ parent, sizes: [gone], pickedSizeId: 'g' }).modifiers, [{ id: 'mgd-deleted', min: null, max: null }]);
  // A size that still has one existing group keeps its own list (the deleted one is simply not drawn).
  const mixed = { id: 'm', parent_id: 'p', assigned_modifier_groups: [{ groupId: 'mgd-deleted' }, { groupId: SYRUP_ID }] };
  assert.deepEqual(sheet(parent, [mixed], 'm').groups.map(g => g.id), ['__variants__', SYRUP_ID]);
});

// ── Matcha ──────────────────────────────────────────────────────────────────

test('Matcha: groups only on the sizes show before a pick and after', () => {
  const sizes = [M_REG, M_LG];
  const expected = [['__variants__', 1, 1], [MILK_ID, 1, 1], [MATCHA_EXTRA_ID, 0, 2]];
  assert.deepEqual(shown(sheet(MATCHA, sizes, null).groups), expected);
  assert.deepEqual(shown(sheet(MATCHA, sizes, M_LG.id).groups), expected);
  // Milk is required on every size, so Add is blocked until it is answered.
  const { groups } = sheet(MATCHA, sizes, M_LG.id);
  assert.equal(validateSelections(groups, { __variants__: [M_LG.id] }, {}, {}), 'Pick a Milk');
  assert.equal(validateSelections(groups, { __variants__: [M_LG.id], [MILK_ID]: ['o-oat'] }, {}, {}), null);
  // When only ONE size is offered (the other 86'd), its groups are what every offered size shares.
  assert.deepEqual(shown(sheet(MATCHA, [M_LG], null).groups), expected);
});

// ── Instruction groups, order, edges ────────────────────────────────────────

const DEFS = [
  { id: 'ig-temp', name: 'Temperature', options: ['Hot', 'Extra hot'] },
  { id: 'ig-lid', name: 'Lid', options: ['Lid', 'No lid'] },
];

test('instruction groups follow the same rule, each kind on its own', () => {
  const parent = { id: 'tea', assigned_instruction_groups: ['ig-temp'] };
  const big = { id: 'tea-l', parent_id: 'tea', assigned_instruction_groups: [{ groupId: 'ig-temp', min: 0 }] };
  const small = { id: 'tea-s', parent_id: 'tea', assigned_instruction_groups: [{ groupId: 'ig-temp', min: 0 }, 'ig-lid'] };
  const sizes = [small, big];
  const opts = { defs: DEFS };
  assert.deepEqual(kioskInstructionAssignments(small.assigned_instruction_groups), [{ id: 'ig-temp', min: 0 }, { id: 'ig-lid', min: null }]);
  // Before a pick: both sizes agree on min 0 for Temperature; Lid only on Small.
  assert.deepEqual(shown(sheet(parent, sizes, null, opts).groups), [['__variants__', 1, 1], ['__instr__ig-temp', 0, 1]]);
  assert.deepEqual(shown(sheet(parent, sizes, 'tea-s', opts).groups), [['__variants__', 1, 1], ['__instr__ig-temp', 0, 1], ['__instr__ig-lid', 1, 1]]);
  assert.deepEqual(shown(sheet(parent, sizes, 'tea-l', opts).groups), [['__variants__', 1, 1], ['__instr__ig-temp', 0, 1]]);
  // Built as before: single choice, 0 priced options, flagged as an instruction.
  const lid = sheet(parent, sizes, 'tea-s', opts).groups[2];
  assert.equal(lid.__isInstructionGroup, true);
  assert.deepEqual(lid.options, [{ id: 'instr-ig-lid-0', name: 'Lid', price: 0 }, { id: 'instr-ig-lid-1', name: 'No lid', price: 0 }]);
  // A missing definition is skipped.
  assert.deepEqual(shown(sheet({ assigned_instruction_groups: ['gone', 'ig-lid'] }, [], null, opts).groups), [['__instr__ig-lid', 1, 1]]);
  // A size with no instruction groups uses the parent's, even when it has its own modifiers.
  const bare = { id: 'tea-b', parent_id: 'tea', assigned_modifier_groups: [SYRUP_ID] };
  assert.deepEqual(shown(sheet(parent, [bare], 'tea-b', opts).groups), [['__variants__', 1, 1], ['__instr__ig-temp', 1, 1], [SYRUP_ID, 0, 2]]);
});

test('option_group_order: the parent\'s, as on the till; the Size group always first', () => {
  const parent = { id: 'p', assigned_modifier_groups: [MILK_ID, SYRUP_ID], assigned_instruction_groups: ['ig-temp'], option_group_order: [SYRUP_ID, 'ig-temp', MILK_ID] };
  const own = { id: 'own', parent_id: 'p', assigned_modifier_groups: [], option_group_order: [MILK_ID, SYRUP_ID, 'ig-temp'] };
  const none = { id: 'none', parent_id: 'p', assigned_modifier_groups: [] };
  const sizes = [own, none];
  const ids = (g) => g.map(x => x.id);
  const opts = { defs: DEFS };
  const parentOrder = ['__variants__', SYRUP_ID, '__instr__ig-temp', MILK_ID];
  assert.deepEqual(ids(sheet(parent, sizes, null, opts).groups), parentOrder);
  assert.deepEqual(ids(sheet(parent, sizes, 'none', opts).groups), parentOrder);
  // The till reads the parent's order even when a size has its own saved order.
  assert.deepEqual(ids(sheet(parent, sizes, 'own', opts).groups), parentOrder);
  // No saved order on the parent: instructions first (the v5.5.947 rule), but after Size.
  const plain = { ...parent, option_group_order: null };
  assert.deepEqual(ids(sheet(plain, [none], null, opts).groups), ['__variants__', '__instr__ig-temp', MILK_ID, SYRUP_ID]);
  assert.equal(kioskOptionGroupPlan({ parent: plain, sizes: [own, none] }).order, null);
  // A plain item keeps its own order, exactly as before.
  assert.deepEqual(kioskOptionGroupPlan({ parent }).order, parent.option_group_order);
});

test('a picked size that is not offered counts as no pick; an unknown group is skipped', () => {
  const sizes = [L_SMALL, L_MEDIUM];
  const gone = kioskOptionGroupPlan({ parent: LATTE, sizes, pickedSizeId: 'm-latte-xl' });
  assert.equal(gone.sizeId, null);
  assert.deepEqual(gone, kioskOptionGroupPlan({ parent: LATTE, sizes, pickedSizeId: null }));
  // An unknown group id stays in the plan but its row is not found, so it is not drawn.
  const parent = { id: 'x', assigned_modifier_groups: ['mgd-deleted', SYRUP_ID] };
  const { plan, groups } = sheet(parent, [], null);
  assert.deepEqual(plan.modifiers.map(m => m.id), ['mgd-deleted', SYRUP_ID]);
  assert.deepEqual(groups.map(g => g.id), [SYRUP_ID]);
  // No rows at all (the read failed): the Size group still shows on its own.
  assert.deepEqual(sheet(PEPSI_MAX, [PM_REGULAR, PM_LARGE], null, { rows: {} }).groups.map(g => g.id), ['__variants__']);
  // Bad inputs never throw.
  assert.deepEqual(kioskOptionGroupPlan(), { sizeId: null, modifiers: [], instructions: [], order: null });
  assert.deepEqual(kioskModifierAssignments('x'), []);
  // A duplicate assignment shows once (the till de-duplicates by group id).
  assert.deepEqual(kioskOptionGroupPlan({ parent: { assigned_modifier_groups: [SYRUP_ID, { groupId: SYRUP_ID, max: 1 }] } }).modifiers, [{ id: SYRUP_ID, min: null, max: null }]);
});

test('a plain item (no sizes) gets exactly its own groups, as the kiosk always built them', () => {
  const pizza = { id: 'pz', assigned_modifier_groups: [SYRUP_ID, { groupId: MILK_ID, min: 0 }] };
  const { groups } = sheet(pizza, [], null);
  const legacy = [SYRUP, { ...MILK, min: 0 }].map(normalizeGroup);
  assert.deepEqual(groups, legacy);
});

// ── Size change: picks kept, dropped and validated ──────────────────────────

test('switching Small to Medium drops the extra group\'s picks and nested picks, keeps Milk', () => {
  const sizes = [L_SMALL, L_MEDIUM, L_LARGE];
  const small = sheet(LATTE, sizes, L_SMALL.id).groups;
  const sprinkle = normalizeGroup({ id: 'mg-sprinkle', name: 'Sprinkle', selection_type: 'single', min: 1, max: 1, options: [{ id: 'o-sp', name: 'Rainbow', price: 0.1 }] });
  const subs = { 'mg-sprinkle': sprinkle };
  const sel = { __variants__: [L_SMALL.id], [MILK_ID]: ['o-oat'], [EXTRA_ID]: ['o-choc'] };
  const nested = { [`${EXTRA_ID}:o-choc:0`]: { 'mg-sprinkle': ['o-sp'] }, [`${MILK_ID}:o-oat:0`]: { x: [] } };
  assert.equal(validateSelections(small, sel, nested, subs), null);
  assert.equal(priceDelta(small, sel, nested, subs), 0.4 + 0.1);

  // The customer taps Medium: the extra group is no longer shown.
  const switched = { ...sel, __variants__: [L_MEDIUM.id] };
  const medium = sheet(LATTE, sizes, L_MEDIUM.id).groups;
  const sel2 = kioskPruneSelections(medium, switched);
  const nested2 = kioskPruneNestedSelections(medium, nested);
  assert.deepEqual(sel2, { __variants__: [L_MEDIUM.id], [MILK_ID]: ['o-oat'] });
  assert.deepEqual(nested2, { [`${MILK_ID}:o-oat:0`]: { x: [] } });
  assert.equal(validateSelections(medium, sel2, nested2, subs), null);
  assert.equal(priceDelta(medium, sel2, nested2, subs), 0.4);
  // Nothing more to drop: the same objects come back (no render loop).
  assert.equal(kioskPruneSelections(medium, sel2), sel2);
  assert.equal(kioskPruneNestedSelections(medium, nested2), nested2);

  // A size whose extra group is REQUIRED (no min override, the row says min 1): picking it
  // shows the group unanswered and Add is blocked until it is answered.
  const smallReq = { ...L_SMALL, assigned_modifier_groups: [{ groupId: EXTRA_ID }, { max: 1, min: 0, groupId: MILK_ID }] };
  const reqSizes = [smallReq, L_MEDIUM, L_LARGE];
  const back = kioskPruneSelections(sheet(LATTE, reqSizes, smallReq.id).groups, { ...sel2, __variants__: [smallReq.id] });
  const smallRequired = sheet(LATTE, reqSizes, smallReq.id).groups;
  assert.deepEqual(shown(smallRequired).find(g => g[0] === EXTRA_ID), [EXTRA_ID, 1, 1]);
  assert.equal(validateSelections(smallRequired, back, nested2, subs), 'Pick a Babyccino');
  assert.deepEqual(kioskSheetGroupHint(smallRequired, back), { key: 'k2.sheet.pickOne', vars: { group: 'Babyccino' } });
  assert.equal(validateSelections(smallRequired, { ...back, [EXTRA_ID]: ['o-plain'] }, nested2, subs), null);
  // Before any pick that group is not shown (only Small carries it), so it cannot block.
  assert.equal(validateSelections(sheet(LATTE, reqSizes, null).groups, { __variants__: [L_MEDIUM.id], [MILK_ID]: ['o-oat'] }, {}, {}), null);
  // Toggling the size off hides Small's group again, and Size blocks Add.
  const off = sheet(LATTE, sizes, null).groups;
  assert.deepEqual(kioskPruneSelections(off, { __variants__: [], [EXTRA_ID]: ['o-plain'] }), { __variants__: [] });
  assert.equal(validateSelections(off, { __variants__: [] }, {}, {}), 'Pick a Size');
});

test('prune: an option a shown group no longer has is dropped; bad input is safe', () => {
  const groups = [normalizeGroup({ id: 'g', name: 'G', selection_type: 'multiple', min: 0, max: 5, options: [{ id: 'a' }, { id: 'b' }] })];
  assert.deepEqual(kioskPruneSelections(groups, { g: ['a', 'gone', 'a'] }), { g: ['a', 'a'] });
  assert.deepEqual(kioskPruneNestedSelections(groups, { 'g:gone:0': {}, 'g:a:1': { s: ['x'] }, junk: {} }), { 'g:a:1': { s: ['x'] } });
  assert.deepEqual(kioskPruneSelections([], null), null);
  assert.deepEqual(kioskPruneNestedSelections(null, undefined), undefined);
});

// ── The basket line carries a size group's option like a parent group's ─────

test('Pepsi Max Regular with No Ice: the order line, kitchen, receipt and totals see No Ice', () => {
  const sizes = [PM_REGULAR, PM_LARGE];
  const { groups } = sheet(PEPSI_MAX, sizes, PM_REGULAR.id);
  const selections = { __variants__: [PM_REGULAR.id], [SOFT_OPTIONS_ID]: [NO_ICE_OPT] };
  assert.equal(validateSelections(groups, selections, {}, {}), null);
  const mods = buildModsArray(groups, selections, {}, {});
  assert.deepEqual(mods, [{ label: 'No Ice', price: 0, groupLabel: 'Soft Drinks Options' }]);
  assert.equal(summarizeForDisplay(groups, selections, {}, {}), 'Regular · No Ice');
  // The modal's price: the size's absolute price plus the option deltas.
  const priceEach = groups[0].options.find(o => o.id === PM_REGULAR.id).__absolutePrice + priceDelta(groups, selections, {}, {});
  assert.equal(priceEach, 3);

  // KioskApp addToCart's line, then the order line every destination reads.
  const variant = kioskVariant(PEPSI_MAX, PM_REGULAR);
  const line = { key: kioskLineKey(PEPSI_MAX, variant, selections), item: PEPSI_MAX, variant, name: displayName(PEPSI_MAX), qty: 2, modsArray: mods, linePrice: priceEach, lineTotal: 2 * priceEach };
  const o = kioskOrderItem(line);
  assert.equal(o.name, 'Pepsi Max — Regular');
  assert.equal(o.id, PM_REGULAR.id);
  assert.equal(o.parentId, PEPSI_MAX.id);
  assert.deepEqual(o.mods, [{ label: 'No Ice', price: 0, groupLabel: 'Soft Drinks Options' }]);
  assert.equal(o.price, 3);
  assert.equal(o.kitchenName || o.name, 'Pepsi Max — Regular');
  // No Ice is not a linked stock item, so nothing extra is depleted.
  assert.deepEqual(kioskDepleteItem(line), { itemId: PM_REGULAR.id, qty: 2, mods: [] });

  // Exactly what a pick from the SAME group assigned on the parent gives.
  const parentCarries = { ...PEPSI_MAX, assigned_modifier_groups: [{ groupId: SOFT_OPTIONS_ID }] };
  const bare = sizes.map(s => ({ ...s, assigned_modifier_groups: [] }));
  const viaParent = sheet(parentCarries, bare, bare[0].id).groups;
  assert.deepEqual(buildModsArray(viaParent, selections, {}, {}), mods);
  assert.deepEqual(viaParent, groups);

  // The new design's basket key tells Regular with No Ice apart from plain Regular.
  assert.notEqual(kioskLineKeyV2({ item: PEPSI_MAX, variant, mods }), kioskLineKeyV2({ item: PEPSI_MAX, variant, mods: [] }));

  // Switch to Large: No Ice stays, the price follows the size.
  const large = sheet(PEPSI_MAX, sizes, PM_LARGE.id).groups;
  const kept = kioskPruneSelections(large, { ...selections, __variants__: [PM_LARGE.id] });
  assert.deepEqual(kept[SOFT_OPTIONS_ID], [NO_ICE_OPT]);
  assert.equal(large[0].options.find(o => o.id === PM_LARGE.id).__absolutePrice + priceDelta(large, kept, {}, {}), 4.5);
  assert.equal(kioskOrderItem({ ...line, variant: kioskVariant(PEPSI_MAX, PM_LARGE), modsArray: buildModsArray(large, kept, {}, {}) }).name, 'Pepsi Max — Large');
});

test('a priced option from a size group is added to the line price like any option', () => {
  // Large carries Milk and a priced Syrup group of its own.
  const lg = { ...L_LARGE, assigned_modifier_groups: [{ max: 1, min: 0, groupId: MILK_ID }, { groupId: SYRUP_ID }] };
  const sizes = [L_SMALL, L_MEDIUM, lg];
  const { groups } = sheet(LATTE, sizes, lg.id);
  const selections = { __variants__: [lg.id], [MILK_ID]: ['o-oat'], [SYRUP_ID]: ['o-van'] };
  const mods = buildModsArray(groups, selections, {}, {});
  assert.deepEqual(mods.map(m => [m.groupLabel, m.label, m.price]), [['Milk', 'Oat', 0.4], ['Syrup', 'Vanilla', 0.5]]);
  const each = +(3.6 + priceDelta(groups, selections, {}, {})).toFixed(2);
  assert.equal(each, 4.5);
  const o = kioskOrderItem({ item: LATTE, variant: kioskVariant(LATTE, lg), name: 'Latte', qty: 1, modsArray: mods, linePrice: each, lineTotal: each });
  assert.equal(o.name, 'Latte — Large');
  assert.equal(o.price, 4.5);
  assert.deepEqual(o.mods, mods);
});

// ── The moved helpers are the modal's, word for word ────────────────────────

test('the selection helpers are the word for word copy from KioskProductModal at v5.8.68', () => {
  const src = fs.readFileSync(new URL('./kioskOptionGroups.js', import.meta.url), 'utf8');
  const i = src.indexOf('// Walks all selected occurrences');
  const j = src.indexOf('\n}\n', src.indexOf('export function summarizeForDisplay(')) + 2;
  const block = src.slice(i, j).replace(/^export function /gm, 'function ');
  assert.equal(block.length, 5424);
  assert.equal(crypto.createHash('sha256').update(block).digest('hex'), '5573676cea75256430672016e1f9ec0f376b7189c8887b7f5e6de71847c9455a');
  assert.ok(!/^import /m.test(src), 'kioskOptionGroups.js must stay import free');
  const modal = fs.readFileSync(new URL('../surfaces/KioskProductModal.jsx', import.meta.url), 'utf8');
  for (const fn of ['collectNestedOccurrences', 'validateSelections', 'priceDelta', 'buildModsArray', 'summarizeForDisplay']) {
    assert.ok(!modal.includes(`function ${fn}(`), `the modal must import ${fn}, not keep a second copy`);
  }
  // The modal builds its groups through this file, for both kiosk designs.
  assert.ok(modal.includes('kioskOptionGroupPlan({ parent: item, sizes: offeredSizes, pickedSizeId, groupRows, instructionDefs: allInstructionDefs })'));
  assert.ok(modal.includes('kioskSheetGroupIds(item, offered)'));
});
