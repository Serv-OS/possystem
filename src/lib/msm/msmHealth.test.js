// Multi site menu: the menu health check (supabase/functions/_shared/msmHealth.js). Each blocking
// problem and each warning, in words, from a plan.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkSite, checkCentral, failWords } from '../../../supabase/functions/_shared/msmHealth.js';
import { touchedFromChanges } from '../../../supabase/functions/_shared/msmPlan.js';

const item = (id, extra = {}) => ({ id, name: id, menu_name: id, cat: 'c1', cats: [], pricing: { base: 2 }, archived: false, parent_id: null, item_code: null, assigned_modifier_groups: [], type: 'simple', ...extra });
const plan = (items, { lines = [], written = [], inserted = [], groups = [], writes = null, newCategories = [], problems = [] } = {}) => ({
  locationId: 'site', venueMenuId: 'menu-1', problems, newCategories,
  applied: { items, groups, categories: [{ id: 'c1' }] },
  lines, writtenItemIds: written, insertedItemIds: inserted,
  writes: writes || { categories: { insert: [], update: [] } },
});
const codes = (h) => [...h.blocking.map((b) => `B:${b.code}`), ...h.warnings.map((w) => `W:${w.code}`)];

test('blocking: an active product with no category, when the plan wrote it there', () => {
  const h = checkSite(plan([item('x', { cat: null })], { inserted: ['x'], lines: [{ table: 'items', id: 'x', column: '(new)' }] }));
  assert.deepEqual(codes(h), ['B:no_category']);
  assert.match(h.blocking[0].words, /"x" has no category at this site/);
  const kept = checkSite(plan([item('y', { cat: null })], { written: ['y'], lines: [{ table: 'items', id: 'y', column: 'pricing.base' }] }));
  assert.deepEqual(codes(kept), ['W:no_category_kept'], 'kept from the venue: a warning');
});

test('blocking: price missing or below zero; warning: 0.00', () => {
  const l = (id) => [{ table: 'items', id, column: 'pricing.base' }];
  assert.deepEqual(codes(checkSite(plan([item('a', { pricing: { base: null } })], { written: ['a'], lines: l('a') }))), ['B:no_price']);
  assert.deepEqual(codes(checkSite(plan([item('b', { pricing: { base: -1 } })], { written: ['b'], lines: l('b') }))), ['B:price_below_zero']);
  assert.deepEqual(codes(checkSite(plan([item('c', { pricing: { base: 0 } })], { written: ['c'], lines: l('c') }))), ['W:price_zero']);
});

test('blocking: an item code already used at the site (the unique index would refuse it)', () => {
  const h = checkSite(plan([item('a', { item_code: 'LAT1' }), item('b', { item_code: ' lat1 ', archived: true })], { inserted: ['a'], lines: [{ table: 'items', id: 'a', column: '(new)' }] }));
  assert.ok(codes(h).includes('B:item_code_clash'));
});

test('blocking: a size whose parent is not on sale here', () => {
  const h = checkSite(plan([item('p', { archived: true }), item('s', { parent_id: 'p' })], { inserted: ['s'], lines: [{ table: 'items', id: 's', column: '(new)' }] }));
  assert.ok(codes(h).includes('B:size_parent_inactive'));
});

test('blocking: a category taken off the menu still holding products on sale', () => {
  const h = checkSite(plan([item('a', { cat: 'c1' })], { lines: [{ table: 'links', id: 'c1', column: '(off menu)', categoryId: 'central-c1' }] }));
  assert.deepEqual(codes(h), ['B:category_removed_with_products']);
});

test('blocking: a category photo the venue table would refuse', () => {
  const h = checkSite(plan([], { writes: { categories: { insert: [{ id: 'k', label: 'K', image: 'https://evil.example/x.png' }], update: [] } } }));
  assert.deepEqual(codes(h), ['B:category_image']);
  const ok = checkSite(plan([], { writes: { categories: { insert: [{ id: 'k', label: 'K', image: 'https://abc.supabase.co/storage/v1/object/public/product-images/loc/categories/k-123.jpg' }], update: [] } } }));
  assert.deepEqual(codes(ok), []);
});

test('the planner\'s own blocking problems pass through (no VAT rate, no menu, not printed)', () => {
  const h = checkSite(plan([], { problems: [{ code: 'no_tax_rate', level: 'block', words: 'No VAT' }, { code: 'option_dropped', level: 'warn', words: 'dropped' }] }));
  assert.deepEqual(codes(h), ['B:no_tax_rate', 'W:option_dropped']);
  assert.equal(h.ok, false);
});

test('warnings: duplicate names in a category, an option not on sale, a tier price that wins, new categories and discounts, changed at the venue', () => {
  const items = [
    item('a', { name: 'Latte', menu_name: 'Latte', pricing: { base: 3, menus: { 'menu-1': { base: 2.5 } } }, assigned_modifier_groups: [{ groupId: 'g' }] }),
    item('b', { name: 'latte', menu_name: 'latte' }),
    item('oat', { archived: true }),
  ];
  const h = checkSite(plan(items, {
    written: ['a'], lines: [{ table: 'items', id: 'a', column: 'pricing.base' }],
    groups: [{ id: 'g', name: 'Milk', options: [{ name: 'Oat', itemId: 'oat' }] }],
    newCategories: [{ categoryId: 'k' }],
  }), { drift: [{ words: 'Latte was set to 3.10 at the venue', productId: 'p' }] });
  assert.deepEqual(codes(h).sort(), ['W:changed_at_venue', 'W:duplicate_name', 'W:new_category_discounts', 'W:option_inactive', 'W:tier_price_wins'].sort());
  assert.equal(h.ok, true, 'warnings let it through');
});

test('across the menu: a product on sale nowhere (warning), a category removed while it holds products (blocking)', () => {
  const central = {
    products: [{ id: 'p', name: 'Lonely', category_id: 'k' }],
    productSites: [{ product_id: 'p', location_id: 's', active: false }],
    categories: [{ id: 'k', label: 'Drinks', archived: true }],
  };
  const t = touchedFromChanges([{ target: 'product', entity_id: 'p', op: 'update', after: { name: 'Lonely' } }, { target: 'category', entity_id: 'k', op: 'remove', after: {} }]);
  const c = checkCentral(central, t);
  assert.deepEqual(c.warnings.map((w) => w.code), ['active_nowhere']);
  assert.deepEqual(c.blocking.map((b) => b.code), ['category_removed_with_products']);
});

test('the words for a site that will not get an update', () => {
  assert.equal(failWords('Site B', 'Monday price rise', [{ words: 'This site has no 20% VAT rate.' }]),
    'Site B will not get "Monday price rise": This site has no 20% VAT rate.');
  assert.match(failWords('Site B', '', [{ words: 'a.' }, { words: 'b.' }]), /\(and 1 more\)/);
});
