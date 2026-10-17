// Multi site menu: a staged change in plain words, for the Changes panel (msmWords.js), and what
// taking one back takes with it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { changeWords, groupChanges, unstageOrder } from './msmWords.js';

const names = {
  products: new Map([['latte', 'Latte'], ['cola', 'Cola']]),
  categories: new Map([['hot', 'Hot drinks'], ['xmas', 'Christmas']]),
  sites: new Map([['l1', 'Station'], ['l2', 'Riverside']]),
};
const w = (row) => changeWords(row, names).words;

test('products: new, removed, brought back, prices, moves and renames in words', () => {
  assert.equal(w({ target: 'product', entity_id: 'g', op: 'create', after: { name: 'Gingerbread latte', default_price: 4.2, category_id: 'xmas' } }), 'New product, group price 4.20, in Christmas');
  assert.equal(changeWords({ target: 'product', entity_id: 'g', op: 'create', after: { name: 'Gingerbread latte', default_price: 4.2 } }, names).subject, 'Gingerbread latte');
  assert.equal(w({ target: 'product', entity_id: 'latte', op: 'update', after: { archived: true } }), 'Removed from every site');
  assert.equal(w({ target: 'product', entity_id: 'latte', op: 'update', after: { archived: false } }), 'Brought back');
  assert.equal(w({ target: 'product', entity_id: 'latte', op: 'update', after: { default_price: 3.1 }, before: { default_price: 3 } }), 'group price 3.00 to 3.10');
  assert.equal(w({ target: 'product', entity_id: 'latte', op: 'update', after: { category_id: 'xmas', name: 'X', menu_name: 'X' } }), 'moved to Christmas, renamed to X');
  assert.equal(w({ target: 'product', entity_id: 'latte', op: 'update', after: { tax_rate_name: 'Z', tax_rate_percent: 0, allergens: [] } }), 'VAT changed, allergens changed');
  assert.equal(w({ target: 'product', entity_id: 'latte', op: 'update', after: { default_channels: { delivery: 3.5 } }, before: { default_channels: null } }), 'Delivery group price to 3.50');
});

test('sites: added, on and off, prices back to the group price, channel prices, kept values', () => {
  assert.equal(w({ target: 'product_site', entity_id: 'latte', location_id: 'l1', op: 'create', after: { venue_item_id: 'x', active: true, price: 3.3 } }), 'Station: added at 3.30');
  assert.equal(w({ target: 'product_site', entity_id: 'latte', location_id: 'l1', op: 'update', after: { active: false, price: null }, before: { active: true, price: 3.2 } }), 'Station: turned off, price 3.20 to the group price');
  assert.equal(w({ target: 'product_site', entity_id: 'latte', location_id: 'l2', op: 'update', after: { channel_prices: { takeaway: 3.3 } }, before: { channel_prices: { takeaway: 3.1, delivery: 4 } } }), 'Riverside: Takeaway price 3.10 to 3.30, Delivery price 4.00 to the group price');
  assert.equal(w({ target: 'product_site', entity_id: 'latte', location_id: 'l2', op: 'update', after: { kept: { image: 'y' } }, before: { kept: { cat: 'x', image: 'y' } } }), "Riverside: uses the group's cat");
  assert.equal(changeWords({ target: 'product_site', entity_id: 'nope', location_id: 'zz', op: 'update', after: {} }, names).words, 'a site: no change');
});

test('categories, menu details and a new site', () => {
  assert.equal(w({ target: 'category', entity_id: 'c', op: 'create', after: { label: 'Seasonal', parent_id: 'hot' } }), 'New category under Hot drinks');
  assert.equal(w({ target: 'category', entity_id: 'c', op: 'create', after: { label: 'Christmas', route_like_id: 'hot' } }), 'New category, prints like Hot drinks');
  assert.equal(w({ target: 'menu', entity_id: 'm', op: 'update', after: { name: 'X', use_name_everywhere: true } }), 'name changed, name at every site changed');
  assert.deepEqual(changeWords({ target: 'menu_site', entity_id: 'm', location_id: 'l2', op: 'create', after: {} }, names), { subject: 'Riverside', words: 'Joins the group menu' });
});

test('grouped by product: the product\'s own change and its sites together', () => {
  const g = groupChanges([
    { target: 'product_site', entity_id: 'latte', location_id: 'l1', op: 'update', after: { price: 3.3 }, before: { price: null } },
    { target: 'product', entity_id: 'cola', op: 'update', after: { default_price: 2.5 }, before: { default_price: 2.2 } },
    { target: 'product', entity_id: 'latte', op: 'update', after: { menu_name: 'Caffe latte', name: 'Caffe latte' } },
  ], names);
  assert.deepEqual(g.map((x) => [x.subject, x.lines.length]), [['Caffe latte', 2], ['Cola', 1]]);
});

test('taking back: a new product takes its new sites with it (sites first); a category in use is refused in words', () => {
  const rows = [
    { id: '1', target: 'category', entity_id: 'xmas', op: 'create', after: { label: 'Christmas', route_like_id: 'hot' } },
    { id: '2', target: 'product', entity_id: 'g', op: 'create', after: { name: 'Gingerbread latte', category_id: 'xmas' } },
    { id: '3', target: 'product_site', entity_id: 'g', location_id: 'l1', op: 'create', after: {} },
    { id: '4', target: 'product_site', entity_id: 'g', location_id: 'l2', op: 'create', after: {} },
    { id: '5', target: 'product_site', entity_id: 'latte', location_id: 'l1', op: 'update', after: { price: 3 } },
  ];
  assert.deepEqual(unstageOrder(rows, rows[1]).rows.map((r) => r.id), ['3', '4', '2']);
  assert.deepEqual(unstageOrder(rows, rows[4]).rows.map((r) => r.id), ['5']);
  const refused = unstageOrder(rows, rows[0]);
  assert.deepEqual(refused.rows, []);
  assert.match(refused.words, /Christmas is still used by Gingerbread latte/);
  assert.deepEqual(unstageOrder(rows.filter((r) => r.entity_id !== 'g'), rows[0]).rows.map((r) => r.id), ['1']);
  const withChild = [rows[0], { id: '6', target: 'category', entity_id: 'sub', op: 'create', after: { label: 'Sub', parent_id: 'xmas' } }];
  assert.match(unstageOrder(withChild, rows[0]).words, /under it/);
});
