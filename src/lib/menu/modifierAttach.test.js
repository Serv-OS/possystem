// modifierAttach.test.js — attaching one modifier group to many products.
//
// Peter, 22 Sep 2026: "within the modifier group you can attach them to products
// multiple products at once. normally you would connect 1 modifier groups to
// multiple products."
//
// This edits dozens of products in one press, so every rule is tested: it must
// skip what already has the group, keep the item's option ORDER honest, never
// touch a sub item, and never quietly invent an order field.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  groupIdsOf, itemHasGroup, itemsCarrying, attachableItems, matchItems, matchGroups,
  attachPatches, detachPatches, attachButtonLabel, attachResultLine,
  displayNameOf, expandPicks, pickedRealCount, sizesOf,
} from './modifierAttach.js';

const item = (over) => ({ id: 'i1', name: 'Latte', type: 'product', cat: 'c-hot', ...over });

const ITEMS = [
  item({ id: 'i1', name: 'Latte', cat: 'c-hot' }),
  item({ id: 'i2', name: 'Flat White', cat: 'c-hot', assignedModifierGroups: [{ groupId: 'g-milk' }] }),
  item({ id: 'i3', name: 'Iced Tea', cat: 'c-cold' }),
  item({ id: 'i4', name: 'Oat Milk', type: 'sub' }),
  item({ id: 'i5', name: 'Latte Large', parentId: 'i1' }),
  item({ id: 'i6', name: 'Old Mocha', archived: true }),
];

test('reading what an item carries', () => {
  assert.deepEqual(groupIdsOf(ITEMS[1]), ['g-milk']);
  assert.deepEqual(groupIdsOf(ITEMS[0]), []);
  assert.equal(itemHasGroup(ITEMS[1], 'g-milk'), true);
  assert.equal(itemHasGroup(ITEMS[0], 'g-milk'), false);
  assert.deepEqual(itemsCarrying(ITEMS, 'g-milk').map((i) => i.id), ['i2']);
});

test('sizes ARE offered; sub items and archived items are not', () => {
  // Changed 22 Sep 2026 after Peter: "on varients you cant add to the main
  // product only the varients". A product with sizes never shows its own
  // modifiers at the till (POSSurface opens the variants modal and configures
  // the CHILD), so the sizes must be reachable or the group lands nowhere.
  // A sub item stays out: a sub item IS an option.
  assert.deepEqual(attachableItems(ITEMS).map((i) => i.id), ['i1', 'i2', 'i3', 'i5']);
});

test('a size whose product is archived is not offered either', () => {
  const orphaned = [
    item({ id: 'p', name: 'Old Mocha', archived: true }),
    item({ id: 'c', name: 'Large', parentId: 'p' }),
  ];
  assert.deepEqual(attachableItems(orphaned).map((i) => i.id), []);
});

test('a size is named with the product it belongs to', () => {
  // The list read "Small, Small, Small, Medium, Large" with no hint of what they
  // were sizes of.
  assert.equal(displayNameOf(ITEMS[4], ITEMS), 'Latte — Latte Large');
  assert.equal(displayNameOf(ITEMS[0], ITEMS), 'Latte');
  assert.equal(displayNameOf({ id: 'x', name: 'Small', parentId: 'nope' }, ITEMS), 'Small', 'an orphan keeps its own name');
});

test('ticking a product means ALL of its sizes, because that is where the till looks', () => {
  const withSizes = [
    item({ id: 'am', name: 'Americano' }),
    item({ id: 'am-s', name: 'Small', parentId: 'am' }),
    item({ id: 'am-m', name: 'Medium', parentId: 'am' }),
    item({ id: 'am-l', name: 'Large', parentId: 'am' }),
    item({ id: 'cake', name: 'Brownie' }),
  ];
  assert.deepEqual(expandPicks(withSizes, ['am']).sort(), ['am-l', 'am-m', 'am-s']);
  // a product with no sizes stands for itself
  assert.deepEqual(expandPicks(withSizes, ['cake']), ['cake']);
  // and one size on its own is still just that size
  assert.deepEqual(expandPicks(withSizes, ['am-l']), ['am-l']);
  // no duplicates when both the product and one of its sizes are ticked
  assert.deepEqual(expandPicks(withSizes, ['am', 'am-l']).sort(), ['am-l', 'am-m', 'am-s']);
  assert.equal(pickedRealCount(withSizes, ['am', 'cake']), 4);
});

test('searching finds a size by its product name', () => {
  const withSizes = [
    item({ id: 'am', name: 'Americano' }),
    item({ id: 'am-l', name: 'Large', parentId: 'am' }),
  ];
  assert.deepEqual(matchItems(withSizes, { search: 'americano', all: withSizes }).map((i) => i.id), ['am', 'am-l']);
});

test('search finds products by name, and the category narrows it', () => {
  // A plain substring, deliberately: 'lat' finds Latte AND F-lat-White, which is
  // what someone typing quickly expects to see rather than nothing.
  assert.deepEqual(matchItems(ITEMS, { search: 'lat' }).map((i) => i.id), ['i1', 'i2', 'i5']);
  assert.deepEqual(matchItems(ITEMS, { search: 'latte' }).map((i) => i.id), ['i1', 'i5']);
  assert.deepEqual(matchItems(ITEMS, { search: 'tea', categoryId: 'c-hot' }), []);
  assert.equal(matchItems(ITEMS, {}).length, ITEMS.length, 'matchItems narrows, it does not judge');
});

test('the screen composes the two: attachable first, then narrowed', () => {
  // The exact expression the panel uses. A size inherits its product's
  // categories, so filtering by Hot Drinks keeps the sizes of a hot drink.
  const shown = matchItems(attachableItems(ITEMS), { categoryId: 'c-hot', all: ITEMS });
  assert.deepEqual(shown.map((i) => i.id), ['i1', 'i2', 'i5'], 'no sub item, no archived, sizes kept');
});

test('an item in several categories is found by any of them', () => {
  const multi = [item({ id: 'm1', name: 'Brownie', cat: 'c-cakes', cats: ['c-cakes', 'c-vegan'] })];
  assert.equal(matchItems(multi, { categoryId: 'c-vegan' }).length, 1);
});

// ── the group list search Peter asked for ──────────────────────────────────

test('groups are searchable by their name AND by an option inside them', () => {
  const groups = [
    { id: 'g-milk', name: 'Milk', options: [{ name: 'Oat' }, { name: 'Soya' }] },
    { id: 'g-syr', name: 'Syrups', options: [{ name: 'Vanilla' }] },
  ];
  assert.deepEqual(matchGroups(groups, 'milk').map((g) => g.id), ['g-milk']);
  // somebody looking for the group that holds oat milk
  assert.deepEqual(matchGroups(groups, 'oat').map((g) => g.id), ['g-milk']);
  assert.deepEqual(matchGroups(groups, 'vanilla').map((g) => g.id), ['g-syr']);
  assert.equal(matchGroups(groups, '').length, 2);
  assert.equal(matchGroups(groups, 'zzz').length, 0);
});

// ── attaching ───────────────────────────────────────────────────────────────

test('attaching adds the group and skips anything that already had it', () => {
  const patches = attachPatches(ITEMS, 'g-milk', ['i1', 'i2', 'i3']);
  assert.deepEqual(patches.map((p) => p.id), ['i1', 'i3'], 'i2 already had it');
  assert.deepEqual(patches[0].patch.assignedModifierGroups, [{ groupId: 'g-milk' }]);
});

test('pressing the button twice changes nothing the second time', () => {
  const after = ITEMS.map((i) => {
    const p = attachPatches(ITEMS, 'g-milk', ['i1']).find((x) => x.id === i.id);
    return p ? { ...i, ...p.patch } : i;
  });
  assert.deepEqual(attachPatches(after, 'g-milk', ['i1']), []);
});

test('the option ORDER is kept honest, and never invented', () => {
  // An item that keeps an explicit flow order must have the new group appended,
  // or the item's own flow silently forgets it.
  const ordered = [item({ id: 'o1', assignedModifierGroups: [{ groupId: 'g-a' }], optionGroupOrder: ['g-a'] })];
  const [p] = attachPatches(ordered, 'g-milk', ['o1']);
  assert.deepEqual(p.patch.optionGroupOrder, ['g-a', 'g-milk']);

  // An item with NO order is left without one: absent means "use the default",
  // and writing one here would freeze today's order into the record.
  const plain = attachPatches([item({ id: 'p1' })], 'g-milk', ['p1']);
  assert.equal('optionGroupOrder' in plain[0].patch, false);
});

test('only the products actually picked are touched', () => {
  const patches = attachPatches(ITEMS, 'g-milk', ['i3']);
  assert.deepEqual(patches.map((p) => p.id), ['i3']);
});

test('no group and no selection change nothing', () => {
  assert.deepEqual(attachPatches(ITEMS, '', ['i1']), []);
  assert.deepEqual(attachPatches(ITEMS, 'g-milk', []), []);
  assert.deepEqual(attachPatches(null, 'g-milk', ['i1']), []);
});

// ── detaching ───────────────────────────────────────────────────────────────

test('detaching removes the group from the item and from its order', () => {
  const ordered = [item({ id: 'o1', assignedModifierGroups: [{ groupId: 'g-a' }, { groupId: 'g-milk' }], optionGroupOrder: ['g-a', 'g-milk'] })];
  const [p] = detachPatches(ordered, 'g-milk', ['o1']);
  assert.deepEqual(p.patch.assignedModifierGroups, [{ groupId: 'g-a' }]);
  assert.deepEqual(p.patch.optionGroupOrder, ['g-a']);
});

test('detaching something an item never had is not a change', () => {
  assert.deepEqual(detachPatches(ITEMS, 'g-milk', ['i1']), []);
});

test('the per item settings on OTHER groups survive a detach', () => {
  const rich = [item({ id: 'r1', assignedModifierGroups: [{ groupId: 'g-a', required: true, max: 3 }, { groupId: 'g-milk' }] })];
  const [p] = detachPatches(rich, 'g-milk', ['r1']);
  assert.deepEqual(p.patch.assignedModifierGroups, [{ groupId: 'g-a', required: true, max: 3 }]);
});

// ── what the person reads ───────────────────────────────────────────────────

test('the button says how many products it is about to change', () => {
  assert.equal(attachButtonLabel(0), 'Pick some products first');
  assert.equal(attachButtonLabel(1), 'Add to 1 product');
  assert.equal(attachButtonLabel(18), 'Add to 18 products');
});

test('the result names what really happened', () => {
  assert.equal(attachResultLine(3, 0), 'Added to 3 products.');
  assert.equal(attachResultLine(1, 0), 'Added to 1 product.');
  assert.equal(attachResultLine(2, 4), 'Added to 2 products. 4 already had it.');
  assert.equal(attachResultLine(0, 5), 'All 5 already had it.');
  assert.equal(attachResultLine(0, 1), 'That product already had it.');
  assert.equal(attachResultLine(0, 0), 'Nothing to change.');
});
