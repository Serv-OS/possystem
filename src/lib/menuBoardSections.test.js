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
  assert.match(tv, /boardSections\(\{ blocks: data\.board\?\.layout\?\.blocks, cats: data\.cats, itemsByCat, addOnsByCat \}\)/);
  assert.match(read('surfaces/menuboard/BoardParts.jsx'), /\}\}>\{sec\.title\}<\/div>/, 'the heading is the section title (block heading, else the category name)');
  assert.doesNotMatch(tv, /filter\(\(c\) => !c\.parent_id && !c\.is_special\)/, 'top level only filter is gone');
  const bo = read('backoffice/sections/MenuBoards.jsx');
  assert.match(bo, /setCats\(boardCategoryChoices\(/);
  assert.match(bo, /useMemo\(\(\) => boardItemsByCategory\(items\), \[items\]\)/);
  assert.match(bo, /boardSections\(\{ blocks, cats: allCats, itemsByCat, addOnsByCat \}\)/, 'the preview builds the TV\'s sections (block headings included)');
  assert.match(bo, /setBlockTitle\(i, e\.target\.value\)/, 'the heading is editable per block');
  assert.doesNotMatch(bo, /!x\.parent_id && !x\.is_special/);
});

// ── v5.9.68: add-ons, text panels, the price grid runs, one text size rule, sizes and colours ──
import {
  boardAddOnsByCategory, boardSectionsForMenu, newTextBlock, isTextBlock, sizeRuns,
  boardColumns, fitFont, scaledFont, boardSizes, boardColors,
} from './menuBoardSections.js';

test('add-ons: option only sub items per category, listed only when a block ticks them, in menu order', () => {
  const addOnsByCat = boardAddOnsByCategory(ITEMS);
  assert.deepEqual(ids(addOnsByCat.hot), ['oat']);
  assert.equal(addOnsByCat.hot[0]._addOn, true);
  const itemsByCat = boardItemsByCategory(ITEMS);
  const off = boardSections({ blocks: [{ categoryId: 'hot' }], cats: CATS, itemsByCat, addOnsByCat });
  assert.deepEqual(ids(off[0].items), ['latte', 'shot', 'cap']);
  const on = boardSections({ blocks: [{ categoryId: 'hot', addOnIds: ['oat', 'gone'] }], cats: CATS, itemsByCat, addOnsByCat });
  assert.deepEqual(ids(on[0].items), ['oat', 'latte', 'shot', 'cap']);   // oat sorts first (sort_order 0)
  assert.deepEqual(on[0].items.map(i => !!i._addOn), [true, false, false, false]);
});

test('text panels: a boxed heading, lines and last line among the categories; an empty one is skipped', () => {
  const itemsByCat = boardItemsByCategory(ITEMS);
  const t = { ...newTextBlock(), id: 't1', title: ' SYRUPS ', body: '#Caramel\n#Vanilla', footer: '#EACH 0.70', span: 'all' };
  assert.equal(isTextBlock(t), true);
  assert.equal(isTextBlock({ categoryId: 'food' }), false);
  const s = boardSections({ blocks: [t, { categoryId: 'food' }, newTextBlock()], cats: CATS, itemsByCat });
  assert.deepEqual(s.map(x => [x.type, x.id]), [['text', 't1'], ['category', 'food']]);
  assert.deepEqual([s[0].title, s[0].body, s[0].footer, s[0].boxed, s[0].span], ['SYRUPS', '#Caramel\n#Vanilla', '#EACH 0.70', true, 'all']);
});

test('follow timed menus narrows the categories and always keeps the text panels', () => {
  const cats = CATS.map(c => ({ ...c, menu_id: c.id === 'food' ? 'm1' : 'm2' }));
  const itemsByCat = boardItemsByCategory(ITEMS);
  const secs = boardSections({ blocks: [{ type: 'text', id: 't1', title: 'Syrups' }, { categoryId: 'coffee' }, { categoryId: 'food' }], cats, itemsByCat });
  assert.deepEqual(ids(boardSectionsForMenu(secs, { categories: cats, links: [], activeMenuId: 'm1' })), ['t1', 'food']);
  assert.deepEqual(ids(boardSectionsForMenu(secs, { categories: cats, links: [], activeMenuId: null })), ['t1', 'coffee', 'food']);
});

test('price grid runs: one size header per run, unsized lines join the run above', () => {
  const v = (id, name) => ({ id, name });
  const lines = [
    { id: 'flat', name: 'Flat white', _variants: [] },
    { id: 'latte', name: 'Latte', _variants: [v('l1', 'Small Boy'), v('l2', 'Big Boy'), v('l3', 'XL Boy')] },
    { id: 'mocha', name: 'Mocha', _variants: [v('m1', 'Small Boy'), v('m2', 'Big Boy'), v('m3', 'XL Boy')] },
    { id: 'flat8', name: 'Flat white (8oz)', _variants: [] },
    { id: 'esp', name: 'Espresso', _variants: [v('e1', 'Single'), v('e2', 'Double')] },
    { id: 'cream', name: 'Whipped cream', _addOn: true, _variants: [] },
  ];
  const runs = sizeRuns(lines);
  assert.deepEqual(runs.map(r => [r.sizes, ids(r.lines)]), [
    [[], ['flat']],
    [['Small Boy', 'Big Boy', 'XL Boy'], ['latte', 'mocha', 'flat8']],
    [['Single', 'Double'], ['esp', 'cream']],
  ]);
  assert.deepEqual(sizeRuns([]), []);
});

test('one text size rule: columns by size and content, fit by probe, scale below the fill only', () => {
  assert.equal(boardColumns({ textScale: 1, orientation: 'landscape', totalItems: 30 }), 3);
  assert.equal(boardColumns({ textScale: 0.7, orientation: 'landscape', totalItems: 30 }), 3, 'smaller keeps its columns and shrinks instead');
  assert.equal(boardColumns({ textScale: 1.15, orientation: 'landscape', totalItems: 30 }), 5);   // v5.9.71: the top tiers open one more column
  assert.equal(boardColumns({ textScale: 1.3, orientation: 'landscape', totalItems: 30 }), 6);
  assert.equal(boardColumns({ textScale: 1.3, orientation: 'portrait', totalItems: 30 }), 3);
  assert.equal(boardColumns({ textScale: 1.5, orientation: 'landscape', totalItems: 4 }), 2, 'never more columns than two items each');
  assert.equal(boardColumns({ textScale: 1, orientation: 'portrait', totalItems: 30 }), 1);
  assert.equal(boardColumns({ textScale: 1, orientation: 'landscape', fixedCols: 2, totalItems: 30 }), 2, 'the Columns setting wins');
  assert.equal(fitFont(px => px <= 23, { min: 4, max: 44 }), 23);
  assert.equal(fitFont(() => false, { min: 11, max: 160 }), 11);
  assert.equal(scaledFont(40, 1), 40);
  assert.equal(scaledFont(40, 0.7), 28);
  assert.equal(scaledFont(40, 1.3), 40);
  assert.equal(scaledFont(5, 0.5, 4), 4);
});

test('sizes and colours: today\'s look by default, each element its own choice', () => {
  assert.deepEqual(boardSizes({}), { logo: 2.2, title: 1.2, note: 0.7, heading: 0.82, item: 0.56 });   // large logo by default (the photo); note readable from the counter (v5.9.74)
  assert.deepEqual(boardSizes({ logoSize: 'xl', headingSize: 'l', itemSize: 's', titleSize: 'nope', subtitleSize: 'xl' }), { logo: 3.2, title: 1.2, note: 1.15, heading: 1.0, item: 0.48 });
  const d = boardColors({});
  assert.equal(d.heading, '#E8A23C', 'headings take the accent unless set');
  assert.equal(d.price, '#E8A23C');
  assert.equal(boardColors({ headingColor: '#123456' }).heading, '#123456');
  assert.equal(boardColors({ priceStyle: 'plain' }).price, '#F5EFE6', 'plain prices read in the text colour');
  assert.equal(boardColors({ priceStyle: 'plain', priceColor: '#ff0' }).price, '#ff0');
});

test('pins: the TV and the builder draw with the shared parts and size with the shared rule', () => {
  const tv = read('surfaces/MenuBoardSurface.jsx');
  assert.match(tv, /from '\.\/menuboard\/BoardParts'/);
  assert.match(tv, /<BoardHeader theme=\{theme\} name=\{data\.board\?\.name\} basePx=\{headerPx\} \/>/, 'v5.9.77: the header is sized by the screen');
  assert.match(tv, /const headerPx = headerBasePx\(stage\.w, stage\.h\);/);
  // v5.9.76: the body measures, packs and fits (BoardParts BoardBody); the surfaces only pick the column count.
  assert.match(tv, /<BoardBody rootRef=\{boardRef\} sections=\{sections\} cols=\{cols\} textScale=\{textScale\} fontRange=\{FIT\} gapEm=\{1\.7\} whole=\{boardKeepsWhole\(disp\)\} fitKey=\{fitKey\}/);
  assert.match(tv, /defaultImage=\{data\.defaultImage\}/);
  assert.match(tv, /<BoardFooter theme=\{theme\} live pages=\{pages\.length\} page=\{page % pages\.length\} basePx=\{headerPx\} \/>/);
  assert.doesNotMatch(tv, /columnFill|columnCount|fitFont|scaledFont\(/, 'no CSS columns and no fit loop of its own on the TV');
  assert.match(tv, /sizeGrid: true, flow: 'fill' \}/, 'the price grid and the filled columns are the defaults');
  assert.match(tv, /const cols = boardColumns\(\{ textScale, orientation, fixedCols, totalItems \}\)/);
  assert.match(tv, /const allSections = useMemo\(/, 'sections are memoised, or the body would fit on every render');
  assert.doesNotMatch(tv, /^function Section\(/m, 'no private section renderer on the TV');
  const bo = read('backoffice/sections/MenuBoards.jsx');
  assert.match(bo, /from '\.\.\/\.\.\/surfaces\/menuboard\/BoardParts'/);
  assert.match(bo, /<BoardHeader theme=\{t\} name=\{board\.name\} basePx=\{headerPx\} \/>/, 'the preview sizes the header by its frame');
  assert.match(bo, /const headerPx = headerBasePx\(frame\.w, frame\.h\);/);
  assert.match(bo, /fitKey=\{`\$\{page\}\|\$\{headerPx\}`\}/, 'a header size change re-fits the body');
  assert.match(bo, /<BoardBody rootRef=\{rootRef\} sections=\{secs\} cols=\{cols\} textScale=\{disp\.textScale\} fontRange=\{PREVIEW_FIT\} gapEm=\{1\.7\} whole=\{boardKeepsWhole\(disp\)\}/, 'the preview is the TV in miniature: same body, same rule');
  assert.match(bo, /<BoardFooter theme=\{t\} pages=\{pages\.length\} page=\{page % pages\.length\} basePx=\{headerPx\} \/>/);
  assert.doesNotMatch(bo, /columnFill|columnCount|fitFont|scaledFont\(/, 'no CSS columns and no fit loop of its own in the preview');
  assert.match(bo, /sizeGrid: true, flow: 'fill' \}/, 'the builder default agrees with the TV');
  assert.match(bo, /const cols = boardColumns\(\{ textScale: board\.display_options\?\.textScale, orientation: board\.orientation, fixedCols, totalItems \}\)/);
  assert.match(bo, /const allSecs = useMemo\(/, 'sections are memoised, or the body would fit on every render');
  assert.match(bo, /label="Fill the columns: a long category continues in the next column/, 'Layout & display has the switch');
  assert.match(bo, /set=\{v => setDisp\(\{ flow: v \? 'fill' : 'whole' \}\)\}/);
});


// ── v5.9.71: image panels and page breaks ──
import { boardPages, newPageBreak, isPageBreak, pageSeconds } from './menuBoardSections.js';

test('an image panel is a section with its slides; without slides it vanishes; it survives the menu filter', () => {
  const itemsByCat = boardItemsByCategory(ITEMS);
  const img = { type: 'image', id: 'img1', slides: [{ url: 'https://x/a.jpg' }], fit: 'contain', ratio: '4:3', span: 'all' };
  const s = boardSections({ blocks: [img, { categoryId: 'food' }, { type: 'image', id: 'empty', slides: [] }], cats: CATS, itemsByCat });
  assert.deepEqual(s.map(x => [x.type, x.id]), [['image', 'img1'], ['category', 'food']]);
  assert.deepEqual([s[0].fit, s[0].ratio, s[0].span, s[0].slides.length], ['contain', '4:3', 'all', 1]);
  const cats = CATS.map(c => ({ ...c, menu_id: c.id === 'coffee' ? 'm1' : 'm2' }));
  assert.deepEqual(ids(boardSectionsForMenu(boardSections({ blocks: [img, { categoryId: 'coffee' }, { categoryId: 'food' }], cats, itemsByCat }), { categories: cats, links: [], activeMenuId: 'm1' })), ['img1', 'coffee']);
});

test('page breaks split the sections into screens; empty screens vanish; seconds per page has a floor', () => {
  const itemsByCat = boardItemsByCategory(ITEMS);
  const pb = newPageBreak();
  assert.equal(isPageBreak(pb), true);
  const secs = boardSections({ blocks: [{ categoryId: 'coffee' }, pb, { categoryId: 'gone' }, pb, { categoryId: 'food' }, { type: 'text', id: 't', title: 'Syrups' }], cats: CATS, itemsByCat });
  const pages = boardPages(secs);
  assert.deepEqual(pages.map(pg => ids(pg)), [['coffee'], ['food', 't']]);
  assert.deepEqual(boardPages([]), [[]]);
  assert.deepEqual(boardPages(boardSections({ blocks: [{ categoryId: 'food' }], cats: CATS, itemsByCat })).map(pg => ids(pg)), [['food']]);
  assert.equal(pageSeconds({}), 12);
  assert.equal(pageSeconds({ pageSeconds: 2 }), 12, 'below five seconds is the default');
  assert.equal(pageSeconds({ pageSeconds: 20 }), 20);
});
