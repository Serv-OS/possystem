// Online and QR storefront sections (lib/onlineMenuTree.js): a section is its top level
// category plus its sub categories, the till's rule.
//
// 2 Oct 2026, Coffee Boy Leeds, Peter: "online the menu is not right, for example coffee:
// anything in sub categories is not showing on the online menu". The rows below are the real
// Leeds shape, cut down to the trees that matter: every category row, and every item with a
// long id, is as read from the live tables that day (id, parent, cat, cats, sold alone). The
// few items with a short id (m-pizza, m-donut-glazed) are stand ins with the same shape as
// the real rows they represent.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { categoryTreeIds, onlineSectionTrees, itemInSection } from './onlineMenuTree.js';

const MENU = 'menu-1790259342963-5c26956b';
const cat = (id, label, parent_id, sort_order) => ({ id, label, parent_id, sort_order, menu_id: MENU });

// Top level
const HOT_ICED = 'cat-1790020616524_5c26956b';   // Hot/Iced Coffee: holds ONLY option rows
const TEA_ROOT = 'cat-1790021643193_5c26956b';   // Tea & Iced Tea: holds nothing itself
const SPECIAL  = 'cat-1790000161889_5c26956b';   // Speciality
const SMOOTH   = 'cat-1790045044647_5c26956b';   // Smoothies | Shakes | Coolers
const DOBOY    = 'cat-1790142354222_5c26956b';   // Doboy
// Sub categories
const COFFEE   = 'cat-1789160729377_5c26956b';
const ICED     = 'cat-1789160769545_5c26956b';
const TEAS     = 'cat-1789998780286_5c26956b';
const ICED_TEA = 'cat-1789993395377_5c26956b';
const SMOOTHIE = 'cat-1790045090326_5c26956b';
const DONUTS   = 'cat-1790683980881';

const LEEDS_CATS = [
  cat(HOT_ICED, 'Hot/Iced Coffee', null, 1),
  cat(COFFEE, 'Coffee', HOT_ICED, 1),
  cat(ICED, 'Iced Coffee', HOT_ICED, 2),
  cat(TEA_ROOT, 'Tea & Iced Tea', null, 2),
  cat(TEAS, 'Teas', TEA_ROOT, 2),
  cat(ICED_TEA, 'Iced Teas', TEA_ROOT, 4),
  cat(SPECIAL, 'Speciality', null, 5),
  cat(SMOOTH, 'Smoothies | Shakes | Coolers', null, 6),
  cat(SMOOTHIE, 'Smoothies', SMOOTH, 0),
  cat(DOBOY, 'Doboy', null, 10),
  cat(DONUTS, 'Donuts', DOBOY, 0),
];

const row = (id, name, type, catId, cats = [], extra = {}) => ({
  id, name, type, cat: catId, cats, parent_id: null, sold_alone: true, archived: false, allergens: [], ...extra,
});

const LEEDS_ITEMS = [
  // Coffee (sub of Hot/Iced Coffee), nothing in cats: the rows that were missing online
  row('m-1789160788884_5c26956b', 'Latte', 'variants', COFFEE),
  row('m-1789647980622_5c26956b', 'Cappuccino', 'variants', COFFEE, [], { allergens: ['milk'] }),
  row('m-1789669490611_5c26956b', 'Flat White', 'modifiable', COFFEE),
  // a size row of Latte: never a card
  row('m-latte-large', 'Large', 'simple', COFFEE, [], { parent_id: 'm-1789160788884_5c26956b' }),
  // Iced Coffee (sub of Hot/Iced Coffee); two real rows list their own category in cats as well
  row('m-1789161808958_5c26956b', 'Iced Latte', 'variants', ICED),
  row('m-1789992386503_5c26956b', 'Honey Oat Iced Latte', 'variants', ICED, [ICED]),
  row('m-1789840912829_5c26956b', 'Protein Scoop', 'subitem', ICED, [], { sold_alone: false }),
  // the option rows that sit in Hot/Iced Coffee itself
  row('m-1789650712119_5c26956b', 'Oat Milk', 'subitem', HOT_ICED, [], { sold_alone: false }),
  row('m-1789162802726_5c26956b', 'Extra Shot', 'subitem', HOT_ICED, [], { sold_alone: false }),
  // Speciality product also ticked into Coffee
  row('m-1790000017202_5c26956b', 'Chai Latte', 'variants', SPECIAL, [COFFEE]),
  // Teas: one product, its choices are option rows
  row('m-1790501864145', 'Tea', 'variants', TEAS),
  row('m-1789998799887_5c26956b', 'English Breakfast Tea', 'subitem', TEAS, [], { sold_alone: false }),
  row('m-1789993663299_5c26956b', 'Raspberry Iced Tea', 'variants', ICED_TEA),
  row('m-1789993440538_5c26956b', 'Made with Lemonade', 'subitem', ICED_TEA, [], { sold_alone: false }),
  // Smoothies: in the sub category AND ticked into the parent (why these always showed)
  row('m-smoothie-berry', 'Berry Smoothie', 'variants', SMOOTHIE, [SMOOTH]),
  // Doboy: one product in the parent, one donut ticked into the parent, one not
  row('m-doboy-box', 'Doboy Box', 'simple', DOBOY),
  row('m-donut-glazed', 'Glazed Donut', 'simple', DONUTS, [DOBOY]),
  row('m-donut-toffee', 'Sticky Toffee Donut', 'simple', DONUTS),
  // on no category at all (the Leeds pizzas and cookies): no section, before and after
  row('m-pizza', 'Margherita Pizza', 'simple', null),
];

// The storefront's own list: top level categories on the live menu, in order.
const top = LEEDS_CATS.filter(c => !c.parent_id).sort((a, b) => a.sort_order - b.sort_order);
const trees = onlineSectionTrees(top, LEEDS_CATS);
// The storefront's own card filter (OnlineSurface itemsForCat) around the section rule: not
// a size row, not archived, sold alone, then the allergy filter. The last test here pins that
// the surface really is written this way.
const cards = (items, treeIds, allergens = []) => (items || []).filter(i => {
  if (i.parent_id || i.archived || i.sold_alone === false) return false;
  if (!itemInSection(i, treeIds)) return false;
  if (allergens.length && (i.allergens || []).some(a => allergens.includes(a))) return false;
  return true;
});
const names = (rootId, allergens = []) => cards(LEEDS_ITEMS, trees.get(rootId), allergens).map(i => i.name);

// The rule the storefront had since v5.5.108, kept here to prove the bug on the same rows.
const oldRule = (catId) => LEEDS_ITEMS.filter(i =>
  !(i.parent_id || i.archived || i.sold_alone === false)
  && (i.cat === catId || (Array.isArray(i.cats) && i.cats.includes(catId)))).map(i => i.name);

test('the bug on the real Leeds rows: the old rule shows nothing under Hot/Iced Coffee or Tea & Iced Tea', () => {
  assert.deepEqual(oldRule(HOT_ICED), []);
  assert.deepEqual(oldRule(TEA_ROOT), []);
  assert.deepEqual(oldRule(DOBOY), ['Doboy Box', 'Glazed Donut']);
});

test('Hot/Iced Coffee shows the products in Coffee and Iced Coffee, and never the option rows', () => {
  assert.deepEqual(names(HOT_ICED), ['Latte', 'Cappuccino', 'Flat White', 'Iced Latte', 'Honey Oat Iced Latte', 'Chai Latte']);
});

test('Tea & Iced Tea shows Tea and the iced teas (its sub categories), not the tea choices', () => {
  assert.deepEqual(names(TEA_ROOT), ['Tea', 'Raspberry Iced Tea']);
});

test('an item in a sub category and also ticked into the parent shows once, as before', () => {
  assert.deepEqual(names(SMOOTH), ['Berry Smoothie']);
  assert.deepEqual(names(DOBOY), ['Doboy Box', 'Glazed Donut', 'Sticky Toffee Donut']);
});

test('an item ticked into a sub category of another section shows in both sections', () => {
  assert.deepEqual(names(SPECIAL), ['Chai Latte']);
  assert.ok(names(HOT_ICED).includes('Chai Latte'));
});

test('nothing that showed before is lost, section by section', () => {
  for (const c of top) {
    const now = names(c.id);
    for (const n of oldRule(c.id)) assert.ok(now.includes(n), `${c.label} lost ${n}`);
  }
});

test('the allergy filter still hides an item inside a sub category', () => {
  assert.deepEqual(names(HOT_ICED, ['milk']), ['Latte', 'Flat White', 'Iced Latte', 'Honey Oat Iced Latte', 'Chai Latte']);
});

test('an item on no category is in no section', () => {
  for (const c of top) assert.ok(!names(c.id).includes('Margherita Pizza'));
});

test('categoryTreeIds: the category first, then everything under it, at any depth', () => {
  assert.deepEqual(categoryTreeIds(HOT_ICED, LEEDS_CATS), [HOT_ICED, COFFEE, ICED]);
  assert.deepEqual(categoryTreeIds(SPECIAL, LEEDS_CATS), [SPECIAL]);
  const deep = [{ id: 'a', parent_id: null }, { id: 'b', parent_id: 'a' }, { id: 'c', parent_id: 'b' }, { id: 'x', parent_id: null }];
  assert.deepEqual(categoryTreeIds('a', deep), ['a', 'b', 'c']);
  // the store's camel spelling is read too
  assert.deepEqual(categoryTreeIds('a', [{ id: 'a' }, { id: 'b', parentId: 'a' }]), ['a', 'b']);
});

test('categoryTreeIds: a cyclic parent_id does not hang, and bad input is empty', () => {
  const loop = [{ id: 'a', parent_id: 'b' }, { id: 'b', parent_id: 'a' }];
  assert.deepEqual(categoryTreeIds('a', loop), ['a', 'b']);
  assert.deepEqual(categoryTreeIds(null, loop), []);
  assert.deepEqual(categoryTreeIds('a', null), ['a']);
});

test('sub categories follow their parent even when only the parent is on the live menu', () => {
  // The storefront passes its menu filtered list as the sections and EVERY venue category as
  // the tree, so a sub category with another menu_id (or none) still shows under its parent.
  const all = [cat('drinks', 'Drinks', null, 0), { id: 'hot', label: 'Hot', parent_id: 'drinks', sort_order: 0, menu_id: null }];
  const t = onlineSectionTrees([all[0]], all);
  assert.equal(itemInSection(row('i1', 'Latte', 'simple', 'hot'), t.get('drinks')), true);
  assert.equal(itemInSection(row('i2', 'Chips', 'simple', 'food'), t.get('drinks')), false);
});

test('itemInSection: a bare category id works, and no section or no item is false', () => {
  assert.deepEqual(cards(LEEDS_ITEMS, COFFEE).map(i => i.name), ['Latte', 'Cappuccino', 'Flat White', 'Chai Latte']);
  assert.equal(itemInSection({ id: 'a', cat: COFFEE, cats: null }, COFFEE), true);
  assert.equal(itemInSection({ id: 'a', cat: COFFEE }, undefined), false);
  assert.equal(itemInSection(null, trees.get(HOT_ICED)), false);
  // an item on no category never matches, even against an odd tree
  assert.equal(itemInSection({ id: 'a', cat: null, cats: [] }, new Set([null])), false);
  // archived rows are never cards
  assert.deepEqual(cards([row('z', 'Old', 'simple', COFFEE, [], { archived: true })], COFFEE), []);
});

test('the storefront (online and QR, one surface) builds its sections with this rule', () => {
  const src = fs.readFileSync(new URL('../surfaces/online/OnlineSurface.jsx', import.meta.url), 'utf8');
  assert.match(src, /onlineSectionTrees\(topCategories, rawCats\)/);
  assert.ok(src.includes('if (!itemInSection(i, sectionTrees.get(catId) || catId)) return false;'));
  // and the card filter around it is the one copied into `cards` above
  assert.ok(src.includes('if (i.parent_id || i.archived || i.sold_alone === false) return false;'));
  assert.ok(src.includes('if (activeAllergens.length && (i.allergens || []).some(a => activeAllergens.includes(a))) return false;'));
  // the old exact match must not come back
  assert.doesNotMatch(src, /i\.cat === catId/);
});
