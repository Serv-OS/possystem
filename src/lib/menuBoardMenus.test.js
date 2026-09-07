import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boardFollowsMenus, resolveBoardMenu, applyMenuToSections } from './menuBoardMenus.js';

// 2026-09-07 is a Monday. Instants are UTC; venue timezones are passed explicitly
// so the assertions never depend on the machine running the tests.
const MON_1300Z = new Date('2026-09-07T13:00:00Z'); // 14:00 London (BST), 09:00 New York
const MON_1800Z = new Date('2026-09-07T18:00:00Z'); // 19:00 London, 14:00 New York

const everyDay = [1, 2, 3, 4, 5, 6, 7];
const menus = [
  { id: 'brk', name: 'Breakfast', is_active: true, priority: 5, schedule: { days: everyDay, from: '07:00', to: '11:00' } },
  { id: 'lun', name: 'Lunch', is_active: true, priority: 5, schedule: { days: everyDay, from: '11:30', to: '16:00' } },
  { id: 'eve', name: 'Evening', is_active: true, priority: 5, schedule: { days: everyDay, from: '17:00', to: '23:00' } },
  { id: 'all', name: 'All day', is_active: true, is_default: true, priority: 0 },
];
const cats = [
  { id: 'c-eggs', label: 'Eggs', menu_id: 'brk' },
  { id: 'c-mains', label: 'Mains', menu_id: 'lun' },
  { id: 'c-grill', label: 'Grill', menu_id: 'eve' },
  { id: 'c-drinks', label: 'Drinks', menu_id: 'all' },
  { id: 'c-sub', label: 'Steaks', menu_id: null, parent_id: 'c-grill' },
];
const links = [{ menu_id: 'lun', category_id: 'c-drinks' }];   // Drinks also on Lunch via a link
const on = { layout: { followMenus: true, blocks: [] } };
const off = { layout: { followMenus: false, blocks: [] } };

// ── boardFollowsMenus ───────────────────────────────────────────────────────
test('boardFollowsMenus: default false for old rows, null rows and non-true values', () => {
  assert.equal(boardFollowsMenus(null), false);
  assert.equal(boardFollowsMenus({}), false);
  assert.equal(boardFollowsMenus({ layout: { columns: 'auto', blocks: [] } }), false);
  assert.equal(boardFollowsMenus({ layout: { followMenus: 'yes' } }), false);
  assert.equal(boardFollowsMenus(off), false);
  assert.equal(boardFollowsMenus(on), true);
});

// ── resolveBoardMenu ────────────────────────────────────────────────────────
test('resolveBoardMenu: flag off is null even when menus exist', () => {
  assert.equal(resolveBoardMenu({ board: off, menus, categories: cats, links, timezone: 'Europe/London', now: MON_1300Z }), null);
  assert.equal(resolveBoardMenu({ board: { layout: { blocks: [] } }, menus, categories: cats, links, timezone: 'Europe/London', now: MON_1300Z }), null);
});

test('resolveBoardMenu: no menus (failed or fenced read) is null, never a throw', () => {
  assert.equal(resolveBoardMenu({ board: on, menus: [], timezone: 'Europe/London', now: MON_1300Z }), null);
  assert.equal(resolveBoardMenu({ board: on, menus: null, timezone: 'Europe/London', now: MON_1300Z }), null);
  assert.equal(resolveBoardMenu({ board: on, menus: undefined }), null);
});

test('resolveBoardMenu: evaluates on the VENUE clock, not the device clock', () => {
  // Same instant, two venues: 14:00 in London is Lunch, 09:00 in New York is Breakfast.
  assert.equal(resolveBoardMenu({ board: on, menus, categories: cats, links, timezone: 'Europe/London', now: MON_1300Z }), 'lun');
  assert.equal(resolveBoardMenu({ board: on, menus, categories: cats, links, timezone: 'America/New_York', now: MON_1300Z }), 'brk');
  assert.equal(resolveBoardMenu({ board: on, menus, categories: cats, links, timezone: 'Europe/London', now: MON_1800Z }), 'eve');
  assert.equal(resolveBoardMenu({ board: on, menus, categories: cats, links, timezone: 'America/New_York', now: MON_1800Z }), 'lun');
});

test('resolveBoardMenu: missing timezone defaults to Europe/London', () => {
  assert.equal(resolveBoardMenu({ board: on, menus, categories: cats, links, now: MON_1300Z }), 'lun');
  assert.equal(resolveBoardMenu({ board: on, menus, categories: cats, links, timezone: null, now: MON_1300Z }), 'lun');
});

test('resolveBoardMenu: a gap in the schedules falls to the default menu', () => {
  const gap = new Date('2026-09-07T15:30:00Z'); // 16:30 London: between Lunch and Evening
  assert.equal(resolveBoardMenu({ board: on, menus, categories: cats, links, timezone: 'Europe/London', now: gap }), 'all');
});

test('resolveBoardMenu: an empty menu never wins when categories are supplied', () => {
  const withEmpty = [...menus, { id: 'ghost', name: 'New Test', is_active: true, priority: 99 }];   // always on, no categories
  assert.equal(resolveBoardMenu({ board: on, menus: withEmpty, categories: cats, links, timezone: 'Europe/London', now: MON_1300Z }), 'lun');
});

// ── applyMenuToSections ─────────────────────────────────────────────────────
const sec = (id, n = 1) => ({ cat: { id }, items: Array.from({ length: n }, (_, i) => ({ id: `${id}-${i}` })) });
const arranged = [sec('c-grill'), sec('c-eggs'), sec('c-mains'), sec('c-drinks')];

test('applyMenuToSections: no active menu leaves the arranged board untouched', () => {
  assert.equal(applyMenuToSections(arranged, { categories: cats, links, activeMenuId: null }), arranged);
  assert.equal(applyMenuToSections(arranged, { categories: cats, links }), arranged);
});

test('applyMenuToSections: keeps only the categories on the menu, in arranged order', () => {
  const out = applyMenuToSections(arranged, { categories: cats, links, activeMenuId: 'lun' });
  assert.deepEqual(out.map((s) => s.cat.id), ['c-mains', 'c-drinks']);   // primary home + linked, board order kept
  const eve = applyMenuToSections(arranged, { categories: cats, links, activeMenuId: 'eve' });
  assert.deepEqual(eve.map((s) => s.cat.id), ['c-grill']);
});

test('applyMenuToSections: a sub category follows its parent onto the menu', () => {
  const withSub = [...arranged, sec('c-sub')];
  const out = applyMenuToSections(withSub, { categories: cats, links, activeMenuId: 'eve' });
  assert.deepEqual(out.map((s) => s.cat.id), ['c-grill', 'c-sub']);
});

test('applyMenuToSections: never blank, the full board returns when nothing would survive', () => {
  const brkBoard = [sec('c-mains'), sec('c-grill')];   // nothing from Breakfast on this board
  assert.equal(applyMenuToSections(brkBoard, { categories: cats, links, activeMenuId: 'brk' }), brkBoard);
  // unknown menu id: nothing allowed, full board
  assert.equal(applyMenuToSections(arranged, { categories: cats, links, activeMenuId: 'nope' }), arranged);
  // missing categories / links: nothing allowed, full board
  assert.equal(applyMenuToSections(arranged, { activeMenuId: 'lun' }), arranged);
});

test('applyMenuToSections: kept categories with no items count as nothing, full board returns', () => {
  const board = [sec('c-mains', 0), sec('c-grill', 3)];
  assert.equal(applyMenuToSections(board, { categories: cats, links, activeMenuId: 'lun' }), board);
  // but one kept category with items is enough to narrow
  const board2 = [sec('c-mains', 0), sec('c-drinks', 2), sec('c-grill', 3)];
  assert.deepEqual(applyMenuToSections(board2, { categories: cats, links, activeMenuId: 'lun' }).map((s) => s.cat.id), ['c-mains', 'c-drinks']);
});

test('applyMenuToSections: injectable accessors for the Back Office preview shape', () => {
  const preview = [
    { id: 'c-grill', label: 'Grill', items: [{ id: 'x' }] },
    { id: 'c-mains', label: 'Mains', items: [{ id: 'y' }] },
  ];
  const out = applyMenuToSections(preview, { categories: cats, links, activeMenuId: 'lun', categoryIdOf: (s) => s.id });
  assert.deepEqual(out.map((s) => s.id), ['c-mains']);
  // default accessor also reads a plain id when there is no cat
  assert.deepEqual(applyMenuToSections(preview, { categories: cats, links, activeMenuId: 'eve' }).map((s) => s.id), ['c-grill']);
});

test('applyMenuToSections: tolerates junk input', () => {
  assert.deepEqual(applyMenuToSections(null, { categories: cats, links, activeMenuId: 'lun' }), []);
  assert.deepEqual(applyMenuToSections(undefined, {}), []);
  assert.equal(applyMenuToSections(arranged), arranged);
});
