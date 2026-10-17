// Multi site menu: the Change prices maths (supabase/functions/_shared/msmPrice.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyPriceChange, changeOne, roundPence, productsInScope, priceChangeWords } from '../../../supabase/functions/_shared/msmPrice.js';

const L1 = 'site-1', L2 = 'site-2', L3 = 'site-3';
function central() {
  return {
    sites: [{ location_id: L1 }, { location_id: L2 }, { location_id: L3 }],
    categories: [{ id: 'hot' }, { id: 'seasonal', parent_id: 'hot' }, { id: 'cold' }],
    products: [
      { id: 'latte', name: 'Latte', category_id: 'hot', default_price: 2.8, default_channels: null },
      { id: 'latte-l', name: 'Large latte', category_id: 'hot', parent_product_id: 'latte', default_price: 3.2 },
      { id: 'pumpkin', name: 'Pumpkin', category_id: 'seasonal', default_price: 3.95 },
      { id: 'cola', name: 'Cola', category_id: 'cold', default_price: 2 },
      { id: 'meal', name: 'Meal deal', category_id: 'cold', type: 'variants', default_price: 0 },
      { id: 'gone', name: 'Gone', category_id: 'hot', default_price: 1, archived: true },
    ],
    productSites: [
      { product_id: 'latte', location_id: L1, price: null, active: true },
      { product_id: 'latte', location_id: L2, price: 3.0, active: true },
      { product_id: 'latte', location_id: L3, price: null, active: true },
      { product_id: 'latte-l', location_id: L1, price: null, active: true },
      { product_id: 'pumpkin', location_id: L1, price: null, active: true },
      { product_id: 'cola', location_id: L1, price: null, active: true },
      { product_id: 'cola', location_id: L2, price: 2.1, active: true },
    ],
  };
}

test('percent is worked in whole pence, half up', () => {
  assert.equal(changeOne(280, { direction: 'up', mode: 'percent', value: 5 }).pence, 294);   // 294.0
  assert.equal(changeOne(285, { direction: 'up', mode: 'percent', value: 10 }).pence, 314);  // 313.5 -> 314
  assert.equal(changeOne(300, { direction: 'down', mode: 'percent', value: 2.5 }).pence, 293); // 292.5 -> 293
});

test('amount and set to', () => {
  assert.equal(changeOne(280, { direction: 'up', mode: 'amount', value: 0.15 }).pence, 295);
  assert.equal(changeOne(280, { direction: 'down', mode: 'amount', value: '0.30' }).pence, 250);
  assert.equal(changeOne(280, { mode: 'set', value: 3.49 }, { mode: '5p' }).pence, 349, 'rounding is never applied to an exact price');
});

test('rounding: nearest 5p, ties up; endings by the last digit', () => {
  assert.equal(roundPence(282, { mode: '5p' }, 0, null), 280);
  assert.equal(roundPence(283, { mode: '5p' }, 0, null), 285);
  assert.equal(roundPence(2825 / 10, { mode: '5p' }, 0, null), 285, 'a tie rounds up');
  assert.equal(roundPence(286, { mode: 'ending', endings: [5, 9] }, 0, null), 285);
  assert.equal(roundPence(287, { mode: 'ending', endings: [5, 9] }, 0, null), 289, '2.87 is 2 from 2.85 and 2.89: a tie goes up');
});

test('rounding never goes against the change', () => {
  assert.equal(changeOne(280, { direction: 'up', mode: 'percent', value: 0.5 }, { mode: '5p' }).pence, 280, 'up never ends below the old price');
  assert.equal(changeOne(284, { direction: 'up', mode: 'amount', value: 0.01 }, { mode: 'ending', endings: [0] }).pence, 290, 'up to the next allowed price, never down to 2.80');
  assert.equal(changeOne(286, { direction: 'down', mode: 'amount', value: 0.01 }, { mode: 'ending', endings: [9] }).pence, 279, 'down never ends above the old price');
});

test('never below zero: clamped and flagged', () => {
  const r = changeOne(50, { direction: 'down', mode: 'amount', value: 1 });
  assert.deepEqual(r, { pence: 0, clamped: true });
});

test('ALL SITES: the default moves, followers move with it (no rows), overrides change too', () => {
  const out = applyPriceChange(central(), { scope: { productIds: ['latte'], includeSizes: false }, change: { direction: 'up', mode: 'amount', value: 0.2 }, sites: 'all' });
  assert.deepEqual(out.changes, [
    { target: 'product', entity_id: 'latte', location_id: null, op: 'update', after: { default_price: 3 } },
    { target: 'product_site', entity_id: 'latte', location_id: L2, op: 'update', after: { price: 3.2 } },
  ], 'site 2 had its own 3.00: it goes to 3.20 and stays its own; sites 1 and 3 follow the new 3.00 with no row');
  const shown = out.rows.filter((r) => r.locationId === L1 || r.locationId === L3);
  assert.ok(shown.every((r) => r.follows && r.before === 2.8 && r.after === 3), 'the preview still shows the followers moving');
});

test('an override that ends equal to the default is cleared', () => {
  const c = central();
  c.productSites.find((s) => s.product_id === 'latte' && s.location_id === L2).price = 2.9;
  const out = applyPriceChange(c, { scope: { productIds: ['latte'], includeSizes: false }, change: { direction: 'up', mode: 'amount', value: 0.1 }, sites: [L2] });
  // chosen sites: site 2 is worked from 2.90 to 3.00; the default stays 2.80, so it stays an override
  assert.deepEqual(out.changes, [{ target: 'product_site', entity_id: 'latte', location_id: L2, op: 'update', after: { price: 3 } }]);
  const back = applyPriceChange(c, { scope: { productIds: ['latte'], includeSizes: false }, change: { direction: 'down', mode: 'amount', value: 0.1 }, sites: [L2] });
  assert.deepEqual(back.changes, [{ target: 'product_site', entity_id: 'latte', location_id: L2, op: 'update', after: { price: null } }], '2.90 down 0.10 = the default: follows it again');
  assert.equal(back.summary.clears, 1);
});

test('CHOSEN SITES: the default stays; each chosen site worked from its current price and stored as its own', () => {
  const out = applyPriceChange(central(), { scope: { productIds: ['latte'], includeSizes: false }, change: { direction: 'up', mode: 'percent', value: 10 }, sites: [L1, L2] });
  assert.deepEqual(out.changes, [
    { target: 'product_site', entity_id: 'latte', location_id: L1, op: 'update', after: { price: 3.08 } },
    { target: 'product_site', entity_id: 'latte', location_id: L2, op: 'update', after: { price: 3.3 } },
  ]);
  assert.ok(!out.changes.some((c) => c.target === 'product'));
  assert.equal(out.summary.sites, 2);
});

test('SET TO at all sites sets the default and clears every override in scope (review nit)', () => {
  const out = applyPriceChange(central(), { scope: { productIds: ['latte', 'cola'], includeSizes: false }, change: { mode: 'set', value: 2.5 }, sites: 'all' });
  assert.ok(out.changes.some((c) => c.target === 'product' && c.entity_id === 'cola' && c.after.default_price === 2.5));
  assert.ok(out.changes.some((c) => c.target === 'product_site' && c.entity_id === 'latte' && c.location_id === L2 && c.after.price === null));
  assert.equal(out.summary.clears, 2);
  assert.match(priceChangeWords(out.summary), /clears 2 site prices/);
});

test('scope: categories include sub categories; sizes follow their product; variants parents and archived never', () => {
  const ids = (s) => productsInScope(central(), s).map((p) => p.id).sort();
  assert.deepEqual(ids({ categoryIds: ['hot'] }), ['latte', 'latte-l', 'pumpkin']);
  assert.deepEqual(ids({ productIds: ['latte'] }), ['latte', 'latte-l']);
  assert.deepEqual(ids({ productIds: ['latte'], includeSizes: false }), ['latte']);
  assert.deepEqual(ids({ all: true }), ['cola', 'latte', 'latte-l', 'pumpkin']);
});

test('a channel price: worked from the inherited price and stored as that channel only', () => {
  const out = applyPriceChange(central(), { scope: { productIds: ['cola'] }, change: { direction: 'up', mode: 'amount', value: 0.5 }, channel: 'delivery', sites: 'all' });
  assert.deepEqual(out.changes[0], { target: 'product', entity_id: 'cola', location_id: null, op: 'update', after: { default_channels: { delivery: 2.5 } } });
});

test('the preview headline', () => {
  const out = applyPriceChange(central(), { scope: { all: true }, change: { direction: 'up', mode: 'percent', value: 5 }, sites: 'all' });
  assert.match(priceChangeWords(out.summary), /^\d+ prices change at \d sites/);
});
