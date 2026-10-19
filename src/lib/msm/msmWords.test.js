// Multi site menu: a staged change in plain words, for the Changes panel (msmWords.js), and what
// taking one back takes with it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { changeWords, groupChanges, unstageOrder, ruleSentence, priceTypeWord, colWord, WORDS, COL_WORDS } from './msmWords.js';
import fs from 'node:fs';

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
  assert.equal(w({ target: 'product_site', entity_id: 'latte', location_id: 'l1', op: 'update', after: { active: false, price: null }, before: { active: true, price: 3.2 } }), 'Station: turned off, price back to the group price (was 3.20)');
  assert.equal(w({ target: 'product_site', entity_id: 'latte', location_id: 'l2', op: 'update', after: { channel_prices: { takeaway: 3.3 } }, before: { channel_prices: { takeaway: 3.1, delivery: 4 } } }), 'Riverside: Takeaway price 3.10 to 3.30, Delivery price back to the Standard price (was 4.00)');
  assert.equal(w({ target: 'product_site', entity_id: 'latte', location_id: 'l2', op: 'update', after: { kept: { image: 'y' } }, before: { kept: { cat: 'x', image: 'y' } } }), "Riverside: uses the group's category");
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

// ── Round 2: option groups, VAT by order type, the word list ────────────────
const gnames = {
  ...names,
  groups: new Map([['milk', 'Milk options'], ['syrup', 'Syrups']]),
  options: new Map([['oat', 'Oat milk'], ['soy', 'Soya milk']]),
  optionGroup: new Map([['oat', 'milk'], ['soy', 'milk']]),
};
const gw = (row) => changeWords(row, gnames).words;

test('option groups and options in words', () => {
  assert.equal(gw({ target: 'modifier_group', entity_id: 'g9', op: 'create', after: { name: 'Toppings', min: 0, max: 3 } }), 'New option group: Choose up to 3');
  assert.equal(gw({ target: 'modifier_group', entity_id: 'milk', op: 'remove', after: { archived: true } }), 'Removed: taken off every product (nothing is deleted)');
  assert.equal(gw({ target: 'modifier_group', entity_id: 'milk', op: 'update', after: { min: 1, max: 1 }, before: { min: 0, max: 1 } }), 'now: Choose exactly 1');
  assert.equal(gw({ target: 'modifier_option', entity_id: 'oat', op: 'update', after: { price: 0.6 }, before: { price: 0.5 } }), 'price 0.50 to 0.60 at every site that follows it');
  assert.equal(gw({ target: 'modifier_option', entity_id: 'x', op: 'create', after: { name: 'Hemp milk', group_id: 'milk', price: 0.6 } }), 'New option in Milk options, 0.60');
  assert.equal(gw({ target: 'modifier_option_site', entity_id: 'oat', location_id: 'l1', op: 'update', after: { active: false }, before: { active: true } }), 'Station: turned off');
  assert.equal(gw({ target: 'modifier_option_site', entity_id: 'oat', location_id: 'l2', op: 'update', after: { price: null }, before: { price: 0.7 } }), 'Riverside: price back to the group price (was 0.70)');
  assert.equal(gw({ target: 'product', entity_id: 'latte', op: 'update', after: { tax_by_type: { takeaway: { name: 'Zero Rate', percent: 0 } } }, before: { tax_by_type: null } }), 'Takeaway VAT to Zero Rate');
  assert.equal(gw({ target: 'product', entity_id: 'latte', op: 'update', after: { modifier_groups: [{ groupId: 'milk' }] }, before: { modifier_groups: [] } }), 'Milk options added');
  assert.equal(gw({ target: 'product', entity_id: 'd', op: 'create', after: { name: 'Donut', type: 'subitem', sold_alone: false } }), 'New sub item, only used as an option');
});

test('options are grouped under their option group, with the option named on each line', () => {
  const g = groupChanges([
    { target: 'modifier_option', entity_id: 'oat', op: 'update', after: { price: 0.6 }, before: { price: 0.5 } },
    { target: 'modifier_option_site', entity_id: 'soy', location_id: 'l1', op: 'update', after: { active: false }, before: { active: true } },
    { target: 'modifier_group', entity_id: 'milk', op: 'update', after: { name: 'Milks' }, before: { name: 'Milk options' } },
  ], gnames);
  assert.equal(g.length, 1);
  assert.equal(g[0].subject, 'Milks');
  assert.deepEqual(g[0].lines.map((l) => l.words), ['Oat milk: price 0.50 to 0.60 at every site that follows it', 'Soya milk: Station: turned off', 'renamed to Milks']);
});

test('taking back a new option takes its site rows; a new group in use is refused; a new group takes its new options', () => {
  const rows = [
    { id: 'g', target: 'modifier_group', entity_id: 'tops', op: 'create', after: { name: 'Toppings' } },
    { id: 'o', target: 'modifier_option', entity_id: 'sprk', op: 'create', after: { name: 'Sprinkles', group_id: 'tops' } },
    { id: 'os1', target: 'modifier_option_site', entity_id: 'sprk', location_id: 'l1', op: 'create', after: {} },
    { id: 'p', target: 'product', entity_id: 'latte', op: 'update', after: { modifier_groups: [{ groupId: 'tops' }] } },
  ];
  assert.deepEqual(unstageOrder(rows, rows[1]).rows.map((r) => r.id), ['os1', 'o']);
  assert.match(unstageOrder(rows, rows[0]).words, /Toppings is on 1 product in this draft/);
  assert.deepEqual(unstageOrder(rows.slice(0, 3), rows[0]).rows.map((r) => r.id), ['os1', 'o', 'g']);
  const sub = [{ id: 's', target: 'product', entity_id: 'donut', op: 'create', after: { name: 'Donut', type: 'subitem' } }, { id: 'o2', target: 'modifier_option', entity_id: 'x', op: 'create', after: { name: 'Donut', product_id: 'donut', group_id: 'box' } }];
  assert.match(unstageOrder(sub, sub[0]).words, /is an option in this draft/);
});

test('the word list: rule sentences, order types and columns in words, never a code', () => {
  assert.equal(ruleSentence(1, 1), 'Choose exactly 1');
  assert.equal(ruleSentence(0, 3), 'Choose up to 3');
  assert.equal(ruleSentence(1, 3), 'Choose between 1 and 3');
  assert.equal(ruleSentence(0, 99), 'Choose as many as they like');
  assert.equal(priceTypeWord(null), 'Standard price');
  assert.equal(priceTypeWord('dineIn'), 'Eat in');
  assert.equal(priceTypeWord('nonsense'), 'Another order type');
  assert.equal(colWord('tax_overrides'), 'VAT by order type');
  assert.equal(colWord('some_new_column'), 'its own setting', 'never the raw column');
  assert.equal(WORDS.standardPrice, 'Standard price');
  for (const v of Object.values(COL_WORDS)) assert.doesNotMatch(v, /_/, `${v} is a word, not a code`);
});

test('the screens use the word list: no "In store", no "staged" or "change set" in what people read', () => {
  const dir = new URL('../../backoffice/sections/msm/', import.meta.url);
  for (const f of ['MsmGrid.jsx', 'MsmProductSheet.jsx', 'MsmChangePrices.jsx', 'MsmChangesPanel.jsx', 'MultiSiteMenu.jsx', 'MsmGroups.jsx']) {
    const src = fs.readFileSync(new URL(f, dir), 'utf8').split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
    const strings = [...src.matchAll(/(['`"])((?:(?!\1).){3,})\1/g)].map((m) => m[2]).filter((t) => /[a-z] [a-z]/i.test(t) && !/^[a-z-]+\(|var\(|^\.\.?\//.test(t));
    for (const t of strings) {
      assert.doesNotMatch(t, /\bIn store\b/, `${f}: "${t}"`);
      assert.doesNotMatch(t, /\bstaged\b|\bchange set\b|\bsite only extra\b/i, `${f}: "${t}"`);
    }
  }
});
