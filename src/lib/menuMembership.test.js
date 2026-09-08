import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  linkedCategoryIdSet,
  categoryVisibleInMenu,
  menusWithCategories,
  allowedCategoryIds,
  itemInAllowedCats,
} from './menuMembership.js';

// Fixture mirrors the live shape: "main" owns its cats as PRIMARY homes,
// "bar" owns cats only via menu_category_links (the Menu Manager "assign
// existing categories" flow) — the shape that broke the POS resolver.
const CATS = [
  { id: 'cat-food',   label: 'Food',      menuId: 'main' },
  { id: 'cat-mains',  label: 'Mains',     menuId: 'main', parentId: 'cat-food' },
  { id: 'cat-drinks', label: 'Drinks',    menuId: 'main' },
  { id: 'cat-beer',   label: 'Beer',      menuId: 'main', parentId: 'cat-drinks' },
  { id: 'cat-spec',   label: 'Specials',  menuId: 'main', isSpecial: true },
];
const LINKS = [
  { menu_id: 'bar', category_id: 'cat-drinks' },
];

// ── linkedCategoryIdSet ──────────────────────────────────────────────────────
test('linkedCategoryIdSet: collects link rows for the menu only', () => {
  const s = linkedCategoryIdSet(LINKS, 'bar');
  assert.deepEqual([...s], ['cat-drinks']);
  assert.equal(linkedCategoryIdSet(LINKS, 'main').size, 0);
});

test('linkedCategoryIdSet: no menu or no links → empty set', () => {
  assert.equal(linkedCategoryIdSet(LINKS, null).size, 0);
  assert.equal(linkedCategoryIdSet(null, 'bar').size, 0);
});

// ── categoryVisibleInMenu ────────────────────────────────────────────────────
test('categoryVisibleInMenu: no device menu → everything shows', () => {
  for (const c of CATS) assert.equal(categoryVisibleInMenu(c, null, new Set()), true);
});

test('categoryVisibleInMenu: primary home OR linked passes, others hidden', () => {
  const linked = linkedCategoryIdSet(LINKS, 'bar');
  assert.equal(categoryVisibleInMenu(CATS[2], 'bar', linked), true);  // linked
  assert.equal(categoryVisibleInMenu(CATS[0], 'bar', linked), false); // main-only
  assert.equal(categoryVisibleInMenu(CATS[0], 'main', new Set()), true); // primary
});

test('categoryVisibleInMenu: reads snake_case menu_id too', () => {
  assert.equal(categoryVisibleInMenu({ id: 'x', menu_id: 'bar' }, 'bar', new Set()), true);
});

// ── menusWithCategories (the resolver guard — the root-cause fix) ────────────
test('menusWithCategories: counts LINKS-ONLY menus as having categories', () => {
  const s = menusWithCategories(CATS, LINKS);
  assert.equal(s.has('main'), true);
  assert.equal(s.has('bar'), true); // was the bug: bar looked empty, pin was overridden
});

test('menusWithCategories: link to a child or special category does not qualify', () => {
  const s = menusWithCategories(CATS, [
    { menu_id: 'ghost1', category_id: 'cat-beer' }, // child cat
    { menu_id: 'ghost2', category_id: 'cat-spec' }, // special cat
    { menu_id: 'ghost3', category_id: 'no-such' },  // dangling link
  ]);
  assert.equal(s.has('ghost1'), false);
  assert.equal(s.has('ghost2'), false);
  assert.equal(s.has('ghost3'), false);
});

// ── allowedCategoryIds ───────────────────────────────────────────────────────
test('allowedCategoryIds: null (no restriction) when no menu pinned', () => {
  assert.equal(allowedCategoryIds(CATS, null, LINKS), null);
});

test('allowedCategoryIds: linked cat AND its children are in', () => {
  const s = allowedCategoryIds(CATS, 'bar', LINKS);
  assert.equal(s.has('cat-drinks'), true);
  assert.equal(s.has('cat-beer'), true);   // child follows linked parent
  assert.equal(s.has('cat-food'), false);
  assert.equal(s.has('cat-mains'), false);
});

test('allowedCategoryIds: primary menu keeps all its own cats', () => {
  const s = allowedCategoryIds(CATS, 'main', LINKS);
  for (const id of ['cat-food', 'cat-mains', 'cat-drinks', 'cat-beer', 'cat-spec']) {
    assert.equal(s.has(id), true, id);
  }
});

// ── itemInAllowedCats ────────────────────────────────────────────────────────
test('itemInAllowedCats: null set → everything passes (menu-less profile)', () => {
  assert.equal(itemInAllowedCats({ id: 'i1', cat: 'anything' }, null), true);
});

test('itemInAllowedCats: primary cat or multi-membership cats[] pass', () => {
  const allowed = allowedCategoryIds(CATS, 'bar', LINKS);
  assert.equal(itemInAllowedCats({ id: 'i1', cat: 'cat-drinks' }, allowed), true);
  assert.equal(itemInAllowedCats({ id: 'i2', cat: 'cat-beer' }, allowed), true);
  assert.equal(itemInAllowedCats({ id: 'i3', cat: 'cat-food' }, allowed), false);
  assert.equal(itemInAllowedCats({ id: 'i4', cat: 'cat-food', cats: ['cat-drinks'] }, allowed), true);
  assert.equal(itemInAllowedCats({ id: 'i5' }, allowed), false); // no cat at all
});
