// The live menu loader (ARCHITECTURE.md section 7): the storefront's reads, the till's prices,
// sold out from eighty_six or stock 0, sizes shown "from", timed menus through the shared resolver,
// and never a throw when a read fails.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadMenu, shapeItem, groupMenu, formatPrice, capCategories, itemCategoryIds, visibleOnline } from './data/loadMenu.js';

// A tiny fake Supabase client: tables → rows, with the chain the loader uses. `fail` names a table
// whose read answers with an error.
function fakeClient(tables, { fail = [], throwOn = [] } = {}) {
  const calls = [];
  return {
    calls,
    from(table) {
      calls.push(table);
      const rows = tables[table] || [];
      const q = {
        _filters: [],
        select() { return q; }, order() { return q; },
        eq(k, v) { q._filters.push((r) => String(r[k]) === String(v)); return q; },
        in(k, vs) { q._filters.push((r) => vs.includes(r[k])); return q; },
        _run() {
          if (throwOn.includes(table)) throw new Error(`${table} exploded`);
          if (fail.includes(table)) return { data: null, error: new Error(`${table} failed`) };
          return { data: rows.filter((r) => q._filters.every((f) => f(r))), error: null };
        },
        range(a, b) { const r = q._run(); return Promise.resolve(r.error ? r : { data: r.data.slice(a, b + 1), error: null }); },
        then(res, rej) { return Promise.resolve(q._run()).then(res, rej); },
      };
      return q;
    },
  };
}

const LOC = 'ops-1';
const TABLES = {
  menu_categories: [
    { id: 'c-pizza', location_id: LOC, name: 'Pizza', sort_order: 1, menu_id: 'm-all' },
    { id: 'c-pizza-veg', location_id: LOC, name: 'Veg pizza', sort_order: 2, parent_id: 'c-pizza' },
    { id: 'c-drinks', location_id: LOC, name: 'Drinks', sort_order: 3, menu_id: 'm-all' },
    { id: 'c-brunch', location_id: LOC, name: 'Brunch', sort_order: 0, menu_id: 'm-brunch' },
    { id: 'c-spec', location_id: LOC, name: 'Specials', sort_order: 9, is_special: true, menu_id: 'm-all' },
  ],
  menu_items: [
    { id: 'i-marg', location_id: LOC, name: 'Margherita', description: 'Classic', cat: 'c-pizza', pricing: { base: 9, collection: 8.5, delivery: 9.5, dineIn: 10 }, tags: ['v'], allergens: ['gluten'], image: 'https://x/m.jpg', archived: false, sort_order: 1 },
    { id: 'i-veg', location_id: LOC, name: 'Garden', cat: 'c-pizza-veg', pricing: { base: 11 }, tags: ['vegan', 'special'], archived: false, sort_order: 2 },
    { id: 'i-cola', location_id: LOC, name: 'Cola', cat: 'c-drinks', pricing: { base: 0 }, type: 'variants', archived: false, sort_order: 1 },
    { id: 'i-cola-s', location_id: LOC, name: 'Small', cat: 'c-drinks', parent_id: 'i-cola', pricing: { base: 2 }, archived: false, sort_order: 1 },
    { id: 'i-cola-l', location_id: LOC, name: 'Large', cat: 'c-drinks', parent_id: 'i-cola', pricing: { base: 3 }, archived: false, sort_order: 2 },
    { id: 'i-eggs', location_id: LOC, name: 'Eggs', cat: 'c-brunch', pricing: { base: 7 }, archived: false, sort_order: 1 },
    { id: 'i-gone', location_id: LOC, name: 'Gone', cat: 'c-pizza', pricing: { base: 5 }, archived: false, sort_order: 3 },
    { id: 'i-other', location_id: 'ops-2', name: 'Other venue', cat: 'c-pizza', pricing: { base: 1 }, archived: false },
  ],
  menus: [
    { id: 'm-all', location_id: LOC, name: 'All day', is_active: true, is_default: true, sort_order: 1 },
    { id: 'm-brunch', location_id: LOC, name: 'Brunch', is_active: true, priority: 5, schedule: { days: [], from: '07:00', to: '11:00' }, sort_order: 0 },
  ],
  menu_category_links: [],
  eighty_six: [{ location_id: LOC, item_id: 'i-gone' }],
  stock_levels: [{ location_id: LOC, item_id: 'i-eggs', remaining: 0 }],
};

test('the all day menu at lunch: prices by mode, sub category folds into its parent, sizes show from, sold out marked', async () => {
  const noon = new Date('2026-10-31T12:00:00Z');
  const r = await loadMenu(fakeClient(TABLES), LOC, { priceMode: 'collection', timezone: 'Europe/London', currency: 'GBP', now: noon });
  assert.equal(r.error, null);
  assert.equal(r.menuId, 'm-all');
  assert.deepEqual(r.categories.map((c) => c.label), ['Pizza', 'Drinks']);
  const pizza = r.categories[0];
  assert.deepEqual(pizza.items.map((i) => i.name), ['Margherita', 'Garden', 'Gone']);
  const marg = pizza.items[0];
  assert.equal(marg.price, 8.5, 'collection price');
  assert.deepEqual(marg.dietary, ['V']);
  assert.deepEqual(marg.allergens, ['gluten']);
  assert.equal(marg.image, 'https://x/m.jpg');
  assert.equal(marg.description, 'Classic');
  assert.equal(pizza.items[2].sold_out, true, '86 list');
  const cola = r.categories[1].items[0];
  assert.equal(cola.price, 2, 'cheapest size');
  assert.equal(cola.from, true);
  assert.equal(r.categories[1].items.length, 1, 'size children are not listed on their own');
  assert.deepEqual(r.specials.map((i) => i.name), ['Garden'], 'tagged special');
  const dine = await loadMenu(fakeClient(TABLES), LOC, { priceMode: 'dinein', now: noon });
  assert.equal(dine.categories[0].items[0].price, 10);
  const del = await loadMenu(fakeClient(TABLES), LOC, { priceMode: 'delivery', now: noon });
  assert.equal(del.categories[0].items[0].price, 9.5);
});

test('timed menu: at 08:00 the brunch menu wins and stock 0 is sold out; a named menu id wins over the schedule', async () => {
  const early = new Date('2026-10-31T07:00:00Z'); // 08:00 BST
  const r = await loadMenu(fakeClient(TABLES), LOC, { timezone: 'Europe/London', now: early });
  assert.equal(r.menuId, 'm-brunch');
  assert.deepEqual(r.categories.map((c) => c.label), ['Brunch']);
  assert.equal(r.categories[0].items[0].sold_out, true, 'stock remaining 0');
  const named = await loadMenu(fakeClient(TABLES), LOC, { menuId: 'm-all', timezone: 'Europe/London', now: early });
  assert.equal(named.menuId, 'm-all');
  const hidden = await loadMenu(fakeClient(TABLES), LOC, { timezone: 'Europe/London', now: early, hideSoldOut: true });
  assert.deepEqual(hidden.categories, [], 'the only brunch item is sold out and hidden');
});

test('category filter and max items', async () => {
  const noon = new Date('2026-10-31T12:00:00Z');
  const r = await loadMenu(fakeClient(TABLES), LOC, { now: noon, categories: ['c-drinks'] });
  assert.deepEqual(r.categories.map((c) => c.label), ['Drinks']);
  const capped = await loadMenu(fakeClient(TABLES), LOC, { now: noon, maxItems: 2 });
  assert.equal(capped.categories.reduce((n, c) => n + c.items.length, 0), 2);
});

test('never throws: a failed items read, a failed side read, a throwing table, no client', async () => {
  const bad = await loadMenu(fakeClient(TABLES, { fail: ['menu_items'] }), LOC, {});
  assert.deepEqual(bad.categories, []);
  assert.match(bad.error.message, /menu_items failed/);
  const side = await loadMenu(fakeClient(TABLES, { fail: ['eighty_six', 'stock_levels', 'menus'] }), LOC, { now: new Date('2026-10-31T12:00:00Z') });
  assert.equal(side.error, null, 'side reads failing still gives a menu');
  assert.ok(side.categories.length >= 2);
  const boom = await loadMenu(fakeClient(TABLES, { throwOn: ['menu_categories'] }), LOC, {});
  assert.ok(Array.isArray(boom.categories));
  const none = await loadMenu(null, LOC, {});
  assert.deepEqual(none.categories, []);
  assert.ok(none.error);
  const noLoc = await loadMenu(fakeClient(TABLES), null, {});
  assert.ok(noLoc.error);
});

test('reads are scoped to the venue and use the storefront tables', async () => {
  const c = fakeClient(TABLES);
  const r = await loadMenu(c, LOC, { now: new Date('2026-10-31T12:00:00Z') });
  assert.ok(!r.categories.flatMap((x) => x.items).some((i) => i.name === 'Other venue'));
  for (const t of ['menu_items', 'menu_categories', 'menus', 'eighty_six', 'stock_levels']) assert.ok(c.calls.includes(t), t);
});

test('helpers: shapeItem defaults, groupMenu skips specials and empties, capCategories, formatPrice', () => {
  const it = shapeItem({ id: 'x', name: 'X' }, { channel: 'collection', menuId: null, currency: 'USD', soldOutIds: new Set(), stock: new Map() });
  assert.equal(it.price, 0);
  assert.equal(it.currency, 'USD');
  assert.deepEqual(it.dietary, []);
  const g = groupMenu([{ id: 'a', category_id: 'c1', sold_out: true }], [{ id: 'c1', name: 'One' }, { id: 'c2', name: 'Two' }, { id: 'c3', name: 'Sp', is_special: true }], { hideSoldOut: true });
  assert.deepEqual(g, []);
  const cap = capCategories([{ id: 'a', items: [{ id: 1 }, { id: 2, sold_out: true }] }, { id: 'b', items: [{ id: 3 }] }], true, 1);
  assert.deepEqual(cap.map((c) => c.items.length), [1]);
  assert.equal(formatPrice(9.5, 'GBP'), '£9.50');
  assert.equal(formatPrice(12, 'USD'), '$12.00');
  assert.equal(formatPrice('x'), '');
});

// 5.12.5: the Ops table has cat (primary) and cats (every category), never category_id. The first
// live site read category_id and showed "The menu is being updated" with 157 items in the venue.
test('real Ops rows: cat and cats place the item, an item in two sections appears in both, hidden online items stay off', async () => {
  const items = TABLES.menu_items.concat([
    { id: 'i-cats-only', location_id: LOC, name: 'Garlic bread', cat: null, cats: ['c-pizza'], pricing: { base: 4 }, archived: false, sort_order: 4 },
    { id: 'i-two', location_id: LOC, name: 'Lemonade', cat: 'c-drinks', cats: ['c-drinks', 'c-pizza'], pricing: { base: 3 }, archived: false, sort_order: 5 },
    { id: 'i-hidden', location_id: LOC, name: 'Staff meal', cat: 'c-pizza', visibility: { pos: true, online: false }, pricing: { base: 1 }, archived: false, sort_order: 6 },
    { id: 'i-nocat', location_id: LOC, name: 'Loose item', cat: null, cats: [], pricing: { base: 1 }, archived: false, sort_order: 7 },
  ]);
  const r = await loadMenu(fakeClient({ ...TABLES, menu_items: items }), LOC, { timezone: 'Europe/London', now: new Date('2026-10-31T12:00:00Z') });
  assert.equal(r.error, null);
  const pizza = r.categories.find((c) => c.label === 'Pizza');
  const drinks = r.categories.find((c) => c.label === 'Drinks');
  assert.deepEqual(pizza.items.map((i) => i.name), ['Margherita', 'Garden', 'Gone', 'Garlic bread', 'Lemonade']);
  assert.deepEqual(drinks.items.map((i) => i.name), ['Cola', 'Lemonade']);
  assert.ok(!r.categories.some((c) => c.items.some((i) => i.name === 'Staff meal')), 'visibility.online false never reaches the site');
  assert.ok(!r.categories.some((c) => c.items.some((i) => i.name === 'Loose item')), 'an item in no category is not shown');
  assert.deepEqual(itemCategoryIds({ cat: 'a', cats: ['a', 'b'], category_id: 'c' }), ['a', 'b', 'c']);
  assert.deepEqual(itemCategoryIds({ cats: ['b'] }), ['b']);
  assert.equal(visibleOnline({ visibility: { online: false } }), false);
  assert.equal(visibleOnline({ visibility: { online: true } }), true);
  assert.equal(visibleOnline({}), true, 'no visibility column means shown, as the storefront does');
  assert.equal(shapeItem({ id: 'x', cat: 'c1', cats: ['c1', 'c2'], pricing: { base: 1 } }, { channel: 'collection', menuId: null, currency: 'GBP' }).category_id, 'c1');
});
