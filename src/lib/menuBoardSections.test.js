// v5.9.67: what a menu board lists (lib/menuBoardSections.js), the one rule for the TV and the
// Back Office builder. Peter, 24 Sep 2026: subcategories on their own, and never a sub item
// unless it is sold alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { boardVisibleItem, boardItemsByCategory, boardCategoryChoices, boardSectionTitle, boardSections } from './menuBoardSections.js';

const read = (rel) => fs.readFileSync(new URL('../' + rel, import.meta.url), 'utf8');

const CATS = [
  { id: 'coffee', label: 'Coffee', parent_id: null, sort_order: 1 },
  { id: 'iced', label: 'Iced', parent_id: 'coffee', sort_order: 2 },
  { id: 'hot', label: 'Hot', parent_id: 'coffee', sort_order: 1 },
  { id: 'food', label: 'Food', parent_id: null, sort_order: 2 },
  { id: 'opts', label: 'Milk options', parent_id: null, sort_order: 3, is_special: true },
  { id: 'orphan', label: 'Orphan', parent_id: 'gone', sort_order: 9 },
];
const ITEMS = [
  { id: 'latte', name: 'Latte', cat: 'hot', type: 'simple', sort_order: 1 },
  { id: 'cold', name: 'Cold brew', cat: 'iced', type: 'simple', sort_order: 1 },
  { id: 'beans', name: 'Beans', cat: 'coffee', type: 'simple', sort_order: 1 },
  { id: 'oat', name: 'Oat milk', cat: 'hot', type: 'subitem', sold_alone: false, sort_order: 0 },
  { id: 'shot', name: 'Extra shot', cat: 'hot', type: 'subitem', sold_alone: true, sort_order: 2 },
  { id: 'cap', name: 'Cappuccino', cat: 'hot', type: 'variants', sort_order: 3 },
  { id: 'cap-l', name: 'Large', parent_id: 'cap', cat: 'hot', sort_order: 2 },
  { id: 'cap-s', name: 'Small', parent_id: 'cap', cat: 'hot', sort_order: 1 },
  { id: 'old', name: 'Old', cat: 'hot', type: 'simple', archived: true },
  { id: 'hidden', name: 'Hidden', cat: 'hot', type: 'simple', visibility: { kiosk: false } },
  { id: 'toast', name: 'Toast', cat: 'food', cats: ['food'], type: 'simple', sort_order: 1 },
];
const ids = (list) => list.map(x => x.id);

test('a sub item is a line only when it is sold alone (the till rule), archived and kiosk hidden never', () => {
  assert.equal(boardVisibleItem(ITEMS.find(i => i.id === 'oat')), false);
  assert.equal(boardVisibleItem(ITEMS.find(i => i.id === 'shot')), true);
  assert.equal(boardVisibleItem(ITEMS.find(i => i.id === 'latte')), true);
  assert.equal(boardVisibleItem(ITEMS.find(i => i.id === 'old')), false);
  assert.equal(boardVisibleItem(ITEMS.find(i => i.id === 'hidden')), false);
  assert.equal(boardVisibleItem({ id: 'x', type: 'subitem', soldAlone: true }), true);   // store shape
  assert.equal(boardVisibleItem({ id: 'x', type: 'subitem' }), false);                  // sold_alone defaults false in the DB
  assert.equal(boardVisibleItem(null), false);
});

test('items group per category in menu order with sizes nested, never as lines of their own', () => {
  const byCat = boardItemsByCategory(ITEMS);
  assert.deepEqual(ids(byCat.hot), ['latte', 'shot', 'cap']);
  assert.deepEqual(ids(byCat.hot.find(i => i.id === 'cap')._variants), ['cap-s', 'cap-l']);
  assert.deepEqual(ids(byCat.iced), ['cold']);
  assert.deepEqual(ids(byCat.coffee), ['beans']);
  assert.deepEqual(ids(byCat.food), ['toast']);
  assert.equal(byCat['cap-l'], undefined);
});

test('choices: tree order, subcategories with a path, specials out, a category with no parent row is a root', () => {
  const c = boardCategoryChoices(CATS);
  assert.deepEqual(ids(c), ['coffee', 'hot', 'iced', 'food', 'orphan']);
  assert.deepEqual(c.map(x => x.depth), [0, 1, 1, 0, 0]);
  assert.equal(c.find(x => x.id === 'iced').path, 'Coffee › Iced');
  assert.equal(c.find(x => x.id === 'coffee').path, 'Coffee');
  // a parent_id cycle does not loop
  assert.deepEqual(ids(boardCategoryChoices([{ id: 'a', label: 'A', parent_id: 'b' }, { id: 'b', label: 'B', parent_id: 'a' }])), []);
});

test('a subcategory block stands on its own, with its own heading, without its parent', () => {
  const itemsByCat = boardItemsByCategory(ITEMS);
  const s = boardSections({ blocks: [{ categoryId: 'iced' }], cats: CATS, itemsByCat });
  assert.deepEqual(s.map(x => [x.id, x.title, ids(x.items)]), [['iced', 'Iced', ['cold']]]);
});

test('a parent block lists only what sits directly in the parent (as before)', () => {
  const itemsByCat = boardItemsByCategory(ITEMS);
  const s = boardSections({ blocks: [{ categoryId: 'coffee' }], cats: CATS, itemsByCat });
  assert.deepEqual(s.map(x => ids(x.items)), [['beans']]);
});

test('a block heading overrides the label and the span passes through', () => {
  const itemsByCat = boardItemsByCategory(ITEMS);
  const [s] = boardSections({ blocks: [{ categoryId: 'hot', title: '  Hot drinks ', span: 'all' }], cats: CATS, itemsByCat });
  assert.equal(s.title, 'Hot drinks');
  assert.equal(s.span, 'all');
  assert.equal(boardSectionTitle({ title: '' }, { label: 'Hot' }), 'Hot');
  assert.equal(boardSectionTitle(null, { label: 'Hot' }), 'Hot');
});

test('no blocks = top level categories in menu order; empty sections dropped; a gone block skipped', () => {
  const itemsByCat = boardItemsByCategory(ITEMS);
  assert.deepEqual(ids(boardSections({ blocks: [], cats: CATS, itemsByCat })), ['coffee', 'food']);
  assert.deepEqual(ids(boardSections({ cats: CATS, itemsByCat })), ['coffee', 'food']);
  assert.deepEqual(ids(boardSections({ blocks: [{ categoryId: 'gone' }, { categoryId: 'food' }, { categoryId: 'opts' }], cats: CATS, itemsByCat })), ['food']);
});

test('pins: the TV and the builder read this module, not their own copies', () => {
  const tv = read('surfaces/MenuBoardSurface.jsx');
  assert.match(tv, /boardItemsByCategory\(data\.items\)/);
  assert.match(tv, /boardSections\(\{ blocks: data\.board\?\.layout\?\.blocks, cats: data\.cats, itemsByCat \}\)/);
  assert.match(tv, /\{sec\.title \|\| cat\.label\}/, 'the heading honours the block title');
  assert.doesNotMatch(tv, /filter\(\(c\) => !c\.parent_id && !c\.is_special\)/, 'top level only filter is gone');
  const bo = read('backoffice/sections/MenuBoards.jsx');
  assert.match(bo, /setCats\(boardCategoryChoices\(/);
  assert.match(bo, /useMemo\(\(\) => boardItemsByCategory\(items\), \[items\]\)/);
  assert.match(bo, /boardSectionTitle\(b, /, 'the preview uses the block heading');
  assert.match(bo, /setBlockTitle\(i, e\.target\.value\)/, 'the heading is editable per block');
  assert.doesNotMatch(bo, /!x\.parent_id && !x\.is_special/);
});
