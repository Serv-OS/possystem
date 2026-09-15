// New kiosk design menu rules (lib/kioskMenu.js): rail roots, sub category headings, sold
// out and low stock, and the one tap add rule.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  kioskRailRoots, kioskActiveRoot, kioskMenuSections, kioskSectionItemCount, kioskItemSoldOut,
  kioskAvailableSizes, kioskLowStock, kioskAddMode, kioskGroupIds, kioskCardEligible, kioskCardButton,
  kioskOptionOnlySubitem, kioskLegacyCategoryShown,
} from './kioskMenu.js';

const cat = (id, parent_id = null, sort_order = 0, label = id) => ({ id, parent_id, sort_order, label });
const item = (id, catId, extra = {}) => ({ id, cat: catId, cats: null, parent_id: null, sort_order: 0, visibility: { kiosk: true }, allergens: [], ...extra });

test('rail shows top level categories only, and a sub whose parent is missing counts as top level', () => {
  const cats = [cat('drinks'), cat('coffee', 'drinks'), cat('orphan', 'gone'), cat('food')];
  assert.deepEqual(kioskRailRoots(cats).map(c => c.id), ['drinks', 'orphan', 'food']);
});

test('rail hides top level categories with no kiosk item anywhere under them', () => {
  const cats = [cat('drinks'), cat('coffee', 'drinks'), cat('food'), cat('empty'), cat('hidden')];
  const items = [
    item('latte', 'coffee'),                                   // only in the sub category
    item('chips', null, { cats: ['food'] }),                   // through cats
    item('secret', 'hidden', { visibility: { kiosk: false } }),
    item('size', 'empty', { parent_id: 'latte' }),             // a size row is not a card
  ];
  assert.deepEqual(kioskRailRoots(cats, items).map(c => c.id), ['drinks', 'food']);
  assert.deepEqual(kioskRailRoots(null, items), []);
});

test('active root follows the selection up to its tile, else the first tile', () => {
  const cats = [cat('drinks'), cat('coffee', 'drinks'), cat('hot', 'coffee'), cat('food')];
  const roots = kioskRailRoots(cats);
  assert.equal(kioskActiveRoot(roots, cats, 'food'), 'food');
  assert.equal(kioskActiveRoot(roots, cats, 'hot'), 'drinks');
  assert.equal(kioskActiveRoot(roots, cats, 'nope'), 'drinks');
  assert.equal(kioskActiveRoot(roots, cats, null), 'drinks');
  assert.equal(kioskActiveRoot([], cats, 'food'), null);
  // A cycle never hangs.
  const loop = [cat('a', 'b'), cat('b', 'a'), cat('c')];
  assert.equal(kioskActiveRoot([cat('c')], loop, 'a'), 'c');
});

test('sections: the root items first, then sub categories in tree order with headings', () => {
  const cats = [cat('drinks', null, 0, 'Drinks'), cat('tea', 'drinks', 1, 'Tea'), cat('coffee', 'drinks', 0, 'Coffee'), cat('iced', 'coffee', 0, 'Iced')];
  const items = [
    item('water', 'drinks', { sort_order: 2 }),
    item('juice', 'drinks', { sort_order: 1 }),
    item('latte', 'coffee', { sort_order: 1 }),
    item('mocha', 'coffee', { sort_order: 0, cats: ['drinks'] }),   // in the root too: shows once, in the root
    item('icedlatte', 'iced'),
    item('green', 'tea', { visibility: { kiosk: false } }),       // hidden: Tea section dropped
  ];
  const sections = kioskMenuSections({ rootId: 'drinks', visibleCategories: cats, items });
  assert.deepEqual(sections.map(s => [s.heading, s.items.map(i => i.id)]), [
    [null, ['mocha', 'juice', 'water']],
    ['Coffee', ['latte']],
    ['Iced', ['icedlatte']],
  ]);
  assert.equal(kioskSectionItemCount(sections), 5);
  assert.deepEqual(kioskMenuSections({ rootId: 'missing', visibleCategories: cats, items }), []);
  assert.deepEqual(kioskMenuSections(), []);
});

test('a root with no own items starts with its first sub category heading', () => {
  const cats = [cat('drinks', null, 0, 'Drinks'), cat('coffee', 'drinks', 0, 'Coffee')];
  const sections = kioskMenuSections({ rootId: 'drinks', visibleCategories: cats, items: [item('latte', 'coffee')] });
  assert.deepEqual(sections.map(s => s.heading), ['Coffee']);
});

test('card eligibility', () => {
  assert.equal(kioskCardEligible(item('a', 'x')), true);
  assert.equal(kioskCardEligible(item('a', 'x', { parent_id: 'p' })), false);
  assert.equal(kioskCardEligible(item('a', 'x', { visibility: { kiosk: false } })), false);
  assert.equal(kioskCardEligible(item('a', 'x', { visibility: null })), true);
});

test('sold out: 86 on the item or its parent, or a daily count at 0', () => {
  assert.equal(kioskItemSoldOut(item('a', 'x'), [], {}), false);
  assert.equal(kioskItemSoldOut(item('a', 'x'), ['a'], {}), true);
  assert.equal(kioskItemSoldOut(item('a', 'x', { parent_id: 'p' }), ['p'], {}), true);
  assert.equal(kioskItemSoldOut(item('a', 'x'), [], { a: { remaining: 0, par: 10 } }), true);
  assert.equal(kioskItemSoldOut(item('a', 'x'), [], { a: { remaining: 2, par: 10 } }), false);
});

test('low stock badge at 40% of par or fewer', () => {
  assert.equal(kioskLowStock(item('a', 'x'), { a: { remaining: 4, par: 10 } }), 4);
  assert.equal(kioskLowStock(item('a', 'x'), { a: { remaining: 5, par: 10 } }), null);
  assert.equal(kioskLowStock(item('a', 'x'), { a: { remaining: 0, par: 10 } }), null);
  assert.equal(kioskLowStock(item('a', 'x'), { a: { remaining: 3 } }), null);
  assert.equal(kioskLowStock(item('a', 'x'), {}), null);
});

const rules = new Map([
  ['optional', { id: 'optional', selection_type: 'multiple', min: 0, max: 3 }],
  ['required', { id: 'required', selection_type: 'single', min: 1, max: 1 }],
  ['box', { id: 'box', selection_type: 'quantity', min: null, max: 3 }],
]);
const ctx = (extra = {}) => ({ items: [], eightySixIds: [], dailyCounts: {}, allergenFilter: new Set(), instructionDefs: [], groupRules: rules, ...extra });

test('add mode: plain item is one tap with no extras', () => {
  assert.deepEqual(kioskAddMode(item('a', 'x'), ctx()), { mode: 'quick', hasExtras: false });
});

test('add mode: optional groups are one tap with extras', () => {
  assert.deepEqual(kioskAddMode(item('a', 'x', { assigned_modifier_groups: ['optional'] }), ctx()), { mode: 'quick', hasExtras: true });
});

test('add mode: a required group, a quantity group or a min override opens the sheet', () => {
  const req = { mode: 'sheet', reason: 'required' };
  assert.deepEqual(kioskAddMode(item('a', 'x', { assigned_modifier_groups: ['optional', 'required'] }), ctx()), req);
  assert.deepEqual(kioskAddMode(item('a', 'x', { assigned_modifier_groups: ['box'] }), ctx()), req);
  assert.deepEqual(kioskAddMode(item('a', 'x', { assigned_modifier_groups: [{ groupId: 'optional', min: 1 }] }), ctx()), req);
  assert.deepEqual(kioskAddMode(item('a', 'x', { assigned_modifier_groups: [{ groupId: 'required', min: 0 }] }), ctx()), { mode: 'quick', hasExtras: true });
});

test('add mode: instruction groups are required by default, optional with min 0, skipped when missing', () => {
  const defs = [{ id: 'cook', name: 'Cooking', options: ['Rare', 'Well done'] }];
  assert.deepEqual(kioskAddMode(item('a', 'x', { assigned_instruction_groups: ['cook'] }), ctx({ instructionDefs: defs })), { mode: 'sheet', reason: 'required' });
  assert.deepEqual(kioskAddMode(item('a', 'x', { assigned_instruction_groups: [{ groupId: 'cook', min: 0 }] }), ctx({ instructionDefs: defs })), { mode: 'quick', hasExtras: false });
  assert.deepEqual(kioskAddMode(item('a', 'x', { assigned_instruction_groups: ['gone'] }), ctx({ instructionDefs: defs })), { mode: 'quick', hasExtras: false });
});

test('add mode: sizes always open the sheet, and every size gone is sold out', () => {
  const parent = item('lager', 'x');
  const items = [parent, item('half', 'x', { parent_id: 'lager' }), item('pint', 'x', { parent_id: 'lager' })];
  assert.deepEqual(kioskAddMode(parent, ctx({ items })), { mode: 'sheet', reason: 'sizes' });
  assert.deepEqual(kioskAddMode(parent, ctx({ items, eightySixIds: ['half'] })), { mode: 'sheet', reason: 'sizes' });
  assert.deepEqual(kioskAddMode(parent, ctx({ items, eightySixIds: ['half'], dailyCounts: { pint: { remaining: 0, par: 5 } } })), { mode: 'soldout' });
  assert.deepEqual(kioskAvailableSizes(parent, items, ['half'], {}).map(i => i.id), ['pint']);
  // archived sizes do not count as sizes
  const archived = [parent, item('old', 'x', { parent_id: 'lager', archived: true })];
  assert.deepEqual(kioskAddMode(parent, ctx({ items: archived })), { mode: 'quick', hasExtras: false });
});

test('add mode: rules not loaded opens the sheet; a missing group row is skipped', () => {
  const it = item('a', 'x', { assigned_modifier_groups: ['optional'] });
  assert.deepEqual(kioskAddMode(it, ctx({ groupRules: null })), { mode: 'sheet', reason: 'unknown' });
  assert.deepEqual(kioskAddMode(item('a', 'x', { assigned_modifier_groups: ['gone'] }), ctx()), { mode: 'quick', hasExtras: true });
  assert.deepEqual(kioskAddMode(item('a', 'x'), ctx({ groupRules: null })), { mode: 'quick', hasExtras: false });
});

test('add mode: 86 on the item or its parent, or an empty count, is sold out', () => {
  assert.deepEqual(kioskAddMode(item('a', 'x'), ctx({ eightySixIds: ['a'] })), { mode: 'soldout' });
  assert.deepEqual(kioskAddMode(item('a', 'x', { parent_id: 'p' }), ctx({ eightySixIds: ['p'] })), { mode: 'soldout' });
  assert.deepEqual(kioskAddMode(item('a', 'x'), ctx({ dailyCounts: { a: { remaining: 0, par: 3 } } })), { mode: 'soldout' });
  assert.deepEqual(kioskAddMode(null, ctx()), { mode: 'soldout' });
});

test('add mode: an unsafe item opens the sheet so the warning is seen', () => {
  const it = item('a', 'x', { allergens: ['Dairy'] });
  assert.deepEqual(kioskAddMode(it, ctx({ allergenFilter: new Set(['milk']) })), { mode: 'sheet', reason: 'unsafe' });
  assert.deepEqual(kioskAddMode(it, ctx({ allergenFilter: new Set(['fish']) })), { mode: 'quick', hasExtras: false });
});

test('group ids across the menu, without repeats', () => {
  const items = [
    item('a', 'x', { assigned_modifier_groups: ['g1', { groupId: 'g2' }] }),
    item('b', 'x', { assigned_modifier_groups: [{ id: 'g1' }, 'g3'] }),
    item('c', 'x'),
  ];
  assert.deepEqual(kioskGroupIds(items), ['g1', 'g2', 'g3']);
  assert.deepEqual(kioskGroupIds(null), []);
});

test('card button: an unsafe item says Add only when there is nothing to choose', () => {
  const milk = new Set(['milk']);
  const plain = item('a', 'x', { allergens: ['milk'] });
  const withChoice = item('b', 'x', { allergens: ['milk'], assigned_modifier_groups: ['required'] });
  const withExtras = item('c', 'x', { allergens: ['milk'], assigned_modifier_groups: ['optional'] });
  const btn = (it) => kioskCardButton(kioskAddMode(it, ctx({ allergenFilter: milk })), kioskAddMode(it, ctx()));
  assert.equal(btn(plain), 'add');
  assert.equal(btn(withChoice), 'choose');
  assert.equal(btn(withExtras), 'add');
  assert.equal(kioskCardButton({ mode: 'soldout' }), 'soldOut');
  assert.equal(kioskCardButton({ mode: 'sheet', reason: 'sizes' }), 'chooseSize');
  assert.equal(kioskCardButton({ mode: 'sheet', reason: 'unknown' }), 'choose');
  assert.equal(kioskCardButton({ mode: 'quick', hasExtras: false }), 'add');
});

// ── Sub items that are only sold as an option (Provo, 14 Sep) ───────────────
// The live rows: "No Ice" and "No Lemon" are the option rows behind Soft Drinks Options,
// type 'subitem', sold_alone FALSE, in the Soft Drinks category. The kiosk drew them as
// "+ Add · £0.00" product cards. The till hides type 'subitem' && !soldAlone.
const SOFT = 'cat-1776803885509';
const liveRow = (extra) => ({ cats: null, parent_id: null, sort_order: 0, visibility: { kiosk: true }, allergens: [], ...extra });
const PEPSI_MAX = liveRow({ id: 'm-impmo951ym5-0', name: 'Pepsi Max', type: 'variants', sold_alone: true, cat: SOFT, assigned_modifier_groups: [] });
const PM_REGULAR = liveRow({ id: 'm-impmo951ym5-1', name: 'Regular', type: 'simple', parent_id: 'm-impmo951ym5-0', cat: SOFT, pricing: { base: 3 }, assigned_modifier_groups: [{ groupId: 'mgd-1776807157339' }] });
const PM_LARGE = liveRow({ id: 'm-impmo951ym5-2', name: 'Large', type: 'simple', parent_id: 'm-impmo951ym5-0', cat: SOFT, pricing: { base: 4.5 }, assigned_modifier_groups: [{ groupId: 'mgd-1776807157339' }] });
const NO_ICE = liveRow({ id: 'm-1776807172397', name: 'No Ice', type: 'subitem', sold_alone: false, cat: SOFT, cats: [SOFT] });
const NO_LEMON = liveRow({ id: 'm-1776807202338', name: 'No Lemon', type: 'subitem', sold_alone: false, cat: SOFT, cats: [SOFT] });
const LIVE = [PEPSI_MAX, PM_REGULAR, PM_LARGE, NO_ICE, NO_LEMON];

test('card eligibility: sub items that are not sold alone are never cards (the live rows)', () => {
  assert.equal(kioskCardEligible(PEPSI_MAX), true);
  assert.equal(kioskCardEligible(PM_REGULAR), false);          // a size row, as before
  assert.equal(kioskCardEligible(NO_ICE), false);
  assert.equal(kioskCardEligible(NO_LEMON), false);
  assert.equal(kioskOptionOnlySubitem(NO_ICE), true);
  // sold_alone must be exactly true; the store shape (soldAlone) is read too.
  assert.equal(kioskCardEligible({ ...NO_ICE, sold_alone: true }), true);
  assert.equal(kioskCardEligible({ ...NO_ICE, sold_alone: null }), false);
  assert.equal(kioskCardEligible({ ...NO_ICE, sold_alone: undefined }), false);
  assert.equal(kioskCardEligible({ ...NO_ICE, sold_alone: undefined, soldAlone: true }), true);
  assert.equal(kioskCardEligible({ ...NO_ICE, sold_alone: undefined, soldAlone: false }), false);
  // Only type 'subitem': simple and variants items are never hidden by the sold alone flag.
  assert.equal(kioskCardEligible({ ...PEPSI_MAX, sold_alone: false }), true);
  assert.equal(kioskCardEligible(liveRow({ id: 's', type: 'simple', sold_alone: false, cat: SOFT })), true);
  assert.equal(kioskCardEligible(liveRow({ id: 'n', cat: SOFT })), true);   // no type at all
  // Every existing rule still applies to a sold alone sub item.
  assert.equal(kioskCardEligible({ ...NO_ICE, sold_alone: true, visibility: { kiosk: false } }), false);
  assert.equal(kioskCardEligible({ ...NO_ICE, sold_alone: true, parent_id: 'p' }), false);
  assert.equal(kioskCardEligible(null), false);
});

test('new design: the Soft Drinks list shows Pepsi Max, not No Ice or No Lemon', () => {
  const cats = [cat(SOFT, null, 0, 'Soft Drinks'), cat('mixers', null, 1, 'Mixers'), cat('empty', null, 2, 'Empty')];
  const items = [...LIVE, liveRow({ id: 'ice-only', type: 'subitem', sold_alone: false, cat: 'mixers' })];
  const sections = kioskMenuSections({ rootId: SOFT, visibleCategories: cats, items });
  assert.deepEqual(sections.map(sec => sec.items.map(i => i.name)), [['Pepsi Max']]);
  assert.equal(kioskSectionItemCount(sections), 1);
  // A category whose only rows are option sub items has no tile; the rail never shows it.
  assert.deepEqual(kioskRailRoots(cats, items).map(c => c.id), [SOFT]);
  assert.equal(kioskActiveRoot(kioskRailRoots(cats, items), cats, 'mixers'), SOFT);
});

test('old design: a category that only held option sub items is left out, nothing else changes', () => {
  const items = [...LIVE, liveRow({ id: 'ice-only', type: 'subitem', sold_alone: false, cats: ['mixers'] }),
    liveRow({ id: 'hidden', cat: 'secret', visibility: { kiosk: false } }), liveRow({ id: 'kid', cat: 'sizesonly', parent_id: 'x' })];
  assert.equal(kioskLegacyCategoryShown(SOFT, items), true);        // Pepsi Max is a card
  assert.equal(kioskLegacyCategoryShown('mixers', items), false);   // only option rows, now empty
  assert.equal(kioskLegacyCategoryShown('empty', items), true);     // already empty: as before
  assert.equal(kioskLegacyCategoryShown('secret', items), true);    // only hidden rows: as before
  assert.equal(kioskLegacyCategoryShown('sizesonly', items), true); // only size rows: as before
  assert.equal(kioskLegacyCategoryShown('mixers', null), true);
});

test('both designs use ONE card rule: KioskApp visibleItems filters with kioskCardEligible', () => {
  const app = fs.readFileSync(new URL('../surfaces/KioskApp.jsx', import.meta.url), 'utf8');
  const i = app.indexOf('const visibleItems = useMemo(() => {');
  const block = app.slice(i, app.indexOf('}, [items, selectedCategoryId]);', i));
  assert.ok(i > 0 && block.includes('.filter(kioskCardEligible)'), 'the old grid must use kioskCardEligible');
  assert.ok(block.includes('.filter(i => itemInCategory(i, selectedCategoryId))'));
  // No second copy of the old inline rules left behind.
  assert.ok(!block.includes('!i.parent_id') && !block.includes('i.visibility?.kiosk'));
  assert.ok(app.includes("import { kioskCardEligible, itemInCategory, kioskLegacyCategoryShown } from '../lib/kioskMenu';"));
  assert.ok(app.includes('categories={legacyCategories} items={visibleItems}'));
  // The old grid, run on the live rows, gives the same cards as the new design's list.
  const oldGrid = LIVE.filter(kioskCardEligible).filter(it => it.cat === SOFT || (Array.isArray(it.cats) && it.cats.includes(SOFT)));
  const newList = kioskMenuSections({ rootId: SOFT, visibleCategories: [cat(SOFT)], items: LIVE }).flatMap(sec => sec.items);
  assert.deepEqual(oldGrid.map(i => i.id), newList.map(i => i.id));
});
