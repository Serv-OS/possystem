// Multi site menu: the grid's rules (msmGrid.js). Rows grouped by category with sizes under their
// product, cells that follow or hold their own price (In store and per channel), filters, the
// windowed rows, typing and pasting prices, and the keys.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  indexCentral, categoryTree, withSubcategories, categoryPath, defaultFor, cellFor, pricesDiffer, stagedIndex, cellStaged,
  buildGridRows, visibleRange, priceInput, parsePastedColumn, price2, moveFocus, NO_CATEGORY, ROW_H,
} from './msmGrid.js';
import { proposeImport, buildCentral } from '../../../supabase/functions/_shared/msmImport.js';
import { A, B, C, importSites, idGen } from './msmFixture.js';

function fixtureCentral() {
  const sites = importSites();
  return buildCentral(proposeImport(sites, { idGen: idGen() }), sites, {}, { idGen: idGen('g') }).central;
}
const byName = (c, n) => c.products.find((p) => p.name === n);

function small() {
  return {
    sites: [{ location_id: 'l1' }, { location_id: 'l2' }],
    categories: [
      { id: 'hot', label: 'Hot', sort_order: 1 }, { id: 'cold', label: 'Cold', sort_order: 2 },
      { id: 'xmas', label: 'Christmas', parent_id: 'hot', sort_order: 9 },
    ],
    products: [
      { id: 'latte', name: 'Latte', category_id: 'hot', default_price: 3, sort_order: 2, default_channels: { delivery: 3.5 } },
      { id: 'latte-l', name: 'Large latte', category_id: 'hot', parent_product_id: 'latte', default_price: 3.5, sort_order: 3 },
      { id: 'tea', name: 'Tea', category_id: 'hot', default_price: 2, sort_order: 1 },
      { id: 'ginger', name: 'Gingerbread latte', category_id: 'xmas', default_price: 4.2 },
      { id: 'cola', name: 'Cola', category_id: 'cold', default_price: 2.2 },
      { id: 'lost', name: 'Lost one', category_id: null, default_price: 1 },
      { id: 'pie', name: 'Pie', category_id: 'cold', default_price: 4.5, site_only_location_id: 'l2' },
      { id: 'gone', name: 'Gone', category_id: 'cold', default_price: 1, archived: true },
    ],
    productSites: [
      { product_id: 'latte', location_id: 'l1', price: null, active: true, kept: {} },
      { product_id: 'latte', location_id: 'l2', price: 3.2, active: true, kept: { cat: 'x' }, channel_prices: { takeaway: 3.1 } },
      { product_id: 'latte-l', location_id: 'l1', price: null, active: true },
      { product_id: 'tea', location_id: 'l1', price: null, active: true },
      { product_id: 'tea', location_id: 'l2', price: null, active: false },
      { product_id: 'ginger', location_id: 'l1', price: null, active: true },
      { product_id: 'cola', location_id: 'l1', price: null, active: true },
      { product_id: 'cola', location_id: 'l2', price: null, active: true },
      { product_id: 'lost', location_id: 'l1', price: null, active: true },
      { product_id: 'pie', location_id: 'l2', price: null, active: true },
    ],
  };
}
const ids = (rows) => rows.map((r) => (r.kind === 'cat' ? `#${r.id}` : r.id));

test('rows: categories in central order, sub categories under their parent, sizes under their product, no category last', () => {
  const { rows, products } = buildGridRows(small(), { siteIds: ['l1', 'l2'] });
  assert.deepEqual(ids(rows), ['#hot', 'tea', 'latte', 'latte-l', '#xmas', 'ginger', '#cold', 'cola', 'pie', `#${NO_CATEGORY}`, 'lost']);
  assert.equal(products, 7, 'the removed product is not counted');
  assert.equal(rows.find((r) => r.id === 'latte-l').size, true);
  assert.equal(rows.find((r) => r.id === 'xmas').depth, 1);
  assert.equal(rows.find((r) => r.id === 'hot').count, 4, 'a category counts what is under it');
});

test('rows: a closed category hides its products and its sub categories, and still shows its count', () => {
  const { rows } = buildGridRows(small(), { siteIds: ['l1', 'l2'], collapsed: new Set(['hot']) });
  assert.deepEqual(ids(rows), ['#hot', '#cold', 'cola', 'pie', `#${NO_CATEGORY}`, 'lost']);
  assert.equal(rows[0].collapsed, true);
  assert.equal(rows[0].count, 4);
});

test('rows: search, category and the Show filters', () => {
  const c = small();
  const r = (o) => ids(buildGridRows(c, { siteIds: ['l1', 'l2'], ...o }).rows);
  assert.deepEqual(r({ search: 'LATTE' }), ['#hot', 'latte', 'latte-l', '#xmas', 'ginger']);
  assert.deepEqual(r({ categoryId: 'hot' }), ['#hot', 'tea', 'latte', 'latte-l', '#xmas', 'ginger'], 'a category includes the ones under it');
  assert.deepEqual(r({ show: 'differ' }), ['#hot', 'latte'], 'Latte is 3.00 at one site and 3.20 at the other');
  assert.deepEqual(r({ show: 'off' }), ['#hot', 'tea']);
  assert.deepEqual(r({ show: 'kept' }), ['#hot', 'latte']);
  assert.deepEqual(r({ show: 'archived' }), ['#cold', 'gone']);
  assert.deepEqual(r({ show: 'staged', staged: stagedIndex([{ target: 'product_site', entity_id: 'cola', location_id: 'l2', op: 'update', after: { price: 2.5 } }]) }), ['#cold', 'cola']);
  assert.deepEqual(r({ show: 'staged', siteIds: ['l1'], staged: stagedIndex([{ target: 'product_site', entity_id: 'cola', location_id: 'l2', op: 'update', after: { price: 2.5 } }]) }), [], 'a hidden site column does not count');
});

test('cells: follows the group price in grey, its own price in full, not sold; no "site only extra" any more', () => {
  const ix = indexCentral(small());
  const latte = ix.products.get('latte');
  assert.deepEqual(pick(cellFor(ix, latte, 'l1')), { exists: true, active: true, price: 3, own: null, follows: true });
  assert.deepEqual(pick(cellFor(ix, latte, 'l2')), { exists: true, active: true, price: 3.2, own: 3.2, follows: false });
  assert.deepEqual(cellFor(ix, latte, 'l2').keptCols, ['cat']);
  assert.equal(cellFor(ix, ix.products.get('ginger'), 'l2').exists, false);
  assert.equal(cellFor(ix, ix.products.get('ginger'), 'l2').siteOnlyElsewhere, false);
  assert.equal(cellFor(ix, ix.products.get('pie'), 'l1').siteOnlyElsewhere, false, 'a product at one site is a normal product: "+ Sell here" elsewhere (UI issue 6)');
  assert.equal(cellFor(ix, ix.products.get('tea'), 'l2').active, false);
});
const pick = (c) => ({ exists: c.exists, active: c.active, price: c.price, own: c.own, follows: c.follows });

test('cells per channel: the site\'s own channel price, else the group\'s channel price, else the site\'s In store price, else the group\'s', () => {
  const ix = indexCentral(small());
  const latte = ix.products.get('latte');
  assert.equal(defaultFor(latte, 'delivery'), 3.5);
  assert.equal(defaultFor(latte, 'takeaway'), 3, 'no group channel price: the In store one');
  assert.equal(defaultFor(latte, 'nonsense'), 3);
  assert.deepEqual(pick(cellFor(ix, latte, 'l2', 'takeaway')), { exists: true, active: true, price: 3.1, own: 3.1, follows: false });
  assert.deepEqual(pick(cellFor(ix, latte, 'l2', 'delivery')), { exists: true, active: true, price: 3.5, own: null, follows: true });
  assert.deepEqual(pick(cellFor(ix, latte, 'l2', 'collection')), { exists: true, active: true, price: 3.2, own: null, follows: true }, 'falls to the site\'s In store price');
  assert.deepEqual(pick(cellFor(ix, latte, 'l1', 'collection')), { exists: true, active: true, price: 3, own: null, follows: true });
  assert.equal(pricesDiffer(ix, latte, ['l1', 'l2'], 'delivery'), false);
  assert.equal(pricesDiffer(ix, latte, ['l1', 'l2']), true);
});

test('categories: tree, sub categories, path', () => {
  const c = small();
  assert.deepEqual(categoryTree(c).map((t) => [t.id, t.depth]), [['hot', 0], ['xmas', 1], ['cold', 0]]);
  assert.deepEqual([...withSubcategories(c, 'hot')].sort(), ['hot', 'xmas']);
  assert.equal(categoryPath(c, 'xmas'), 'Hot > Christmas');
});

test('staged marks: a price, a switch, a new site row, a product field', () => {
  const s = stagedIndex([
    { target: 'product_site', entity_id: 'latte', location_id: 'l1', op: 'update', after: { price: 3.1 } },
    { target: 'product_site', entity_id: 'cola', location_id: 'l2', op: 'update', after: { channel_prices: { delivery: 3 } } },
    { target: 'product_site', entity_id: 'ginger', location_id: 'l2', op: 'create', after: { venue_item_id: 'x', price: null } },
    { target: 'product', entity_id: 'tea', op: 'update', after: { default_price: 2.1 } },
    { target: 'product', entity_id: 'new', op: 'create', after: { name: 'New' } },
  ]);
  assert.deepEqual(cellStaged(s, 'latte', 'l1'), { price: true, active: false, kept: false });
  assert.deepEqual(cellStaged(s, 'cola', 'l2'), { price: false, active: false, kept: false });
  assert.deepEqual(cellStaged(s, 'cola', 'l2', 'delivery'), { price: true, active: false, kept: false });
  assert.deepEqual(cellStaged(s, 'ginger', 'l2'), { price: true, active: true, kept: false });
  assert.equal(s.products.get('tea').has('default_price'), true);
  assert.equal(s.created.has('new'), true);
  assert.equal(s.count, 5);
});

test('the coffee chain fixture: every product placed once, Latte prices differ, Tea off at one site', () => {
  const c = fixtureCentral();
  const all = c.sites.map((s) => s.location_id);
  const { rows } = buildGridRows(c, { siteIds: all });
  const productRows = rows.filter((r) => r.kind === 'product');
  assert.equal(new Set(productRows.map((r) => r.id)).size, productRows.length, 'no product twice');
  const optionOnly = (p) => p.type === 'subitem' && p.sold_alone !== true;
  assert.equal(productRows.length, c.products.filter((p) => !p.archived && !optionOnly(p)).length, 'Products hides sub items only used as options');
  const subs = buildGridRows(c, { siteIds: all, show: 'subs' }).rows.filter((r) => r.kind === 'product');
  assert.ok(subs.length > 0 && subs.every((r) => optionOnly(r.product)), 'Sub items only used as options shows just those');
  const every = buildGridRows(c, { siteIds: all, show: 'everything' }).rows.filter((r) => r.kind === 'product');
  assert.equal(every.length, c.products.filter((p) => !p.archived).length, 'Everything shows both');
  const ix = indexCentral(c);
  assert.equal(pricesDiffer(ix, byName(c, 'Latte'), all), true);
  assert.equal(cellFor(ix, byName(c, 'Tea'), C).active, false);
  assert.equal(cellFor(ix, byName(c, 'Tea'), A).active, true);
  assert.ok(rows.findIndex((r) => r.id === byName(c, 'Large latte').id) === rows.findIndex((r) => r.id === byName(c, 'Latte').id) + 1, 'the size sits under its product');
  void B;
});

test('1,000 products by 20 sites: the rows build fast and only a screenful is drawn', () => {
  const sites = Array.from({ length: 20 }, (_, i) => ({ location_id: `s${i}` }));
  const categories = Array.from({ length: 25 }, (_, i) => ({ id: `c${i}`, label: `Cat ${i}`, sort_order: i }));
  const products = Array.from({ length: 1000 }, (_, i) => ({ id: `p${i}`, name: `Product ${i}`, category_id: `c${i % 25}`, default_price: 2 + (i % 7) / 10, sort_order: i }));
  const productSites = [];
  for (const p of products) for (const s of sites) productSites.push({ product_id: p.id, location_id: s.location_id, price: Number(p.id.slice(1)) % 3 === 0 && s.location_id === 's0' ? 9 : null, active: true });
  const central = { sites, categories, products, productSites };
  const t0 = Date.now();
  const ix = indexCentral(central);
  const { rows } = buildGridRows(ix, { siteIds: sites.map((s) => s.location_id), show: 'differ' });
  const ms = Date.now() - t0;
  assert.equal(rows.filter((r) => r.kind === 'product').length, 334, 'every third product has its own price at one site');
  const everything = buildGridRows(ix, { siteIds: sites.map((s) => s.location_id) }).rows;
  assert.equal(everything.length, 1025);
  assert.ok(ms < 1500, `built in ${ms} ms`);
  const { start, end } = visibleRange(20000, 700, rows.length);
  assert.ok(end - start <= Math.ceil(700 / ROW_H) + 17, `draws ${end - start} rows`);
});

test('visible range: overscan, clamped at both ends', () => {
  assert.deepEqual(visibleRange(0, 400, 100, 40, 8), { start: 0, end: 18 });
  assert.deepEqual(visibleRange(4000, 400, 100, 40, 8), { start: 92, end: 100 });
  assert.deepEqual(visibleRange(-50, 400, 5, 40, 8), { start: 0, end: 5 });
  assert.deepEqual(visibleRange(0, 0, 0), { start: 0, end: 0 });
});

test('typing a price: pounds and pence, a symbol, blank follows, anything else refused in words', () => {
  assert.deepEqual(priceInput('3.2'), { ok: true, value: 3.2 });
  assert.deepEqual(priceInput(' £3.20 '), { ok: true, value: 3.2 });
  assert.deepEqual(priceInput('1,250.5'), { ok: true, value: 1250.5 });
  assert.deepEqual(priceInput(''), { ok: true, value: null });
  assert.deepEqual(priceInput('.5'), { ok: true, value: 0.5 });
  assert.deepEqual(priceInput('0'), { ok: true, value: 0 });
  for (const bad of ['3.205', '-1', 'abc', '.', '3..2', '10000', '1e3']) assert.equal(priceInput(bad).ok, false, bad);
  assert.match(priceInput('abc').words, /pounds and pence/);
  // A comma is a thousands separator only: '3,20' is refused, never 320.00 (17 Oct review).
  for (const bad of ['3,20', '2,5', '12,50', '1,25,000']) assert.equal(priceInput(bad).ok, false, bad);
  assert.match(priceInput('3,20').words, /full stop/);
  assert.deepEqual(priceInput('1,250'), { ok: true, value: 1250 });
});

test('pasting a column: one price per line, the first cell of each, blank lines skipped, words kept', () => {
  assert.deepEqual(parsePastedColumn('3.20\r\n£3.40\tLatte\n\nabc\n2\n\n'), [{ value: 3.2 }, { value: 3.4 }, { skip: true }, { invalid: true, text: 'abc' }, { value: 2 }]);
  assert.deepEqual(parsePastedColumn(''), []);
  assert.equal(price2(3.2), '3.20');
  assert.equal(price2(null), '');
});

test('keys: arrows and Enter skip category rows; left and right stay inside the columns', () => {
  const rows = [{ kind: 'cat' }, { kind: 'product' }, { kind: 'cat' }, { kind: 'product' }];
  assert.deepEqual(moveFocus(rows, 3, { row: 1, col: 0 }, 'ArrowDown'), { row: 3, col: 0 });
  assert.deepEqual(moveFocus(rows, 3, { row: 3, col: 0 }, 'Enter'), { row: 3, col: 0 }, 'the last row stays');
  assert.deepEqual(moveFocus(rows, 3, { row: 3, col: 0 }, 'ArrowUp'), { row: 1, col: 0 });
  assert.deepEqual(moveFocus(rows, 3, { row: 1, col: 0 }, 'ArrowUp'), { row: 1, col: 0 });
  assert.deepEqual(moveFocus(rows, 3, { row: 1, col: 2 }, 'Tab'), { row: 1, col: 2 });
  assert.deepEqual(moveFocus(rows, 3, { row: 1, col: 0 }, 'ShiftTab'), { row: 1, col: 0 });
  assert.deepEqual(moveFocus(rows, 3, { row: 1, col: 1 }, 'ArrowLeft'), { row: 1, col: 0 });
  assert.equal(moveFocus([], 3, { row: 0, col: 0 }, 'ArrowDown').row, 0);
});

test('the grid shows drive thru from takeaway when drive thru is not priced, like the till', () => {
  const product = { id: 'p', default_price: 3, default_channels: { takeaway: 3.2 } };
  const ix = indexCentral({ products: [product], productSites: [{ product_id: 'p', location_id: 'L', price: null, active: true }], categories: [], sites: [{ location_id: 'L' }] });
  assert.equal(cellFor(ix, product, 'L', 'driveThru').price, 3.2);
  assert.equal(defaultFor(product, 'driveThru'), 3.2);
});

test('search keeps a product\'s sizes under it, and a matched size under its product (UI issue 9)', () => {
  const c = {
    sites: [{ location_id: 'l1' }],
    categories: [{ id: 'wine', label: 'Wine', sort_order: 1 }],
    products: [
      { id: 'red', name: 'House Red', category_id: 'wine', type: 'variants', default_price: 0 },
      { id: 'r175', name: '175 ml glass', category_id: 'wine', parent_product_id: 'red', default_price: 5, sort_order: 1 },
      { id: 'r250', name: '250 ml glass', category_id: 'wine', parent_product_id: 'red', default_price: 7, sort_order: 2 },
      { id: 'rbtl', name: 'Bottle', category_id: 'wine', parent_product_id: 'red', default_price: 20, sort_order: 3 },
      { id: 'white', name: 'House White', category_id: 'wine', default_price: 5 },
    ],
    productSites: [],
  };
  const r = (o) => buildGridRows(c, { siteIds: ['l1'], ...o }).rows.map((x) => (x.kind === 'cat' ? `#${x.id}` : `${x.size ? '  ' : ''}${x.id}`));
  assert.deepEqual(r({ search: 'house red' }), ['#wine', 'red', '  r175', '  r250', '  rbtl']);
  assert.deepEqual(r({ search: '250' }), ['#wine', 'red', '  r250'], 'the parent above, the size indented under it');
  assert.deepEqual(r({ search: 'bottle' }), ['#wine', 'red', '  rbtl']);
});
