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

// Latte with its size taken off (17 Oct recheck: a product with live sizes is priced by them and
// never moved itself), for the tests about a product's own price.
function centralP() {
  const c = central();
  c.products.find((p) => p.id === 'latte-l').archived = true;
  return c;
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
  const out = applyPriceChange(centralP(), { scope: { productIds: ['latte'], includeSizes: false }, change: { direction: 'up', mode: 'amount', value: 0.2 }, sites: 'all' });
  assert.deepEqual(out.changes, [
    { target: 'product', entity_id: 'latte', location_id: null, op: 'update', after: { default_price: 3 } },
    { target: 'product_site', entity_id: 'latte', location_id: L2, op: 'update', after: { price: 3.2 } },
  ], 'site 2 had its own 3.00: it goes to 3.20 and stays its own; sites 1 and 3 follow the new 3.00 with no row');
  const shown = out.rows.filter((r) => r.locationId === L1 || r.locationId === L3);
  assert.ok(shown.every((r) => r.follows && r.before === 2.8 && r.after === 3), 'the preview still shows the followers moving');
});

test('an override that ends equal to the default is cleared', () => {
  const c = centralP();
  c.productSites.find((s) => s.product_id === 'latte' && s.location_id === L2).price = 2.9;
  const out = applyPriceChange(c, { scope: { productIds: ['latte'], includeSizes: false }, change: { direction: 'up', mode: 'amount', value: 0.1 }, sites: [L2] });
  // chosen sites: site 2 is worked from 2.90 to 3.00; the default stays 2.80, so it stays an override
  assert.deepEqual(out.changes, [{ target: 'product_site', entity_id: 'latte', location_id: L2, op: 'update', after: { price: 3 } }]);
  const back = applyPriceChange(c, { scope: { productIds: ['latte'], includeSizes: false }, change: { direction: 'down', mode: 'amount', value: 0.1 }, sites: [L2] });
  assert.deepEqual(back.changes, [{ target: 'product_site', entity_id: 'latte', location_id: L2, op: 'update', after: { price: null } }], '2.90 down 0.10 = the default: follows it again');
  assert.equal(back.summary.clears, 1);
});

test('CHOSEN SITES: the default stays; each chosen site worked from its current price and stored as its own', () => {
  const out = applyPriceChange(centralP(), { scope: { productIds: ['latte'], includeSizes: false }, change: { direction: 'up', mode: 'percent', value: 10 }, sites: [L1, L2] });
  assert.deepEqual(out.changes, [
    { target: 'product_site', entity_id: 'latte', location_id: L1, op: 'update', after: { price: 3.08 } },
    { target: 'product_site', entity_id: 'latte', location_id: L2, op: 'update', after: { price: 3.3 } },
  ]);
  assert.ok(!out.changes.some((c) => c.target === 'product'));
  assert.equal(out.summary.sites, 2);
});

test('SET TO at all sites sets the default and clears every override in scope (review nit)', () => {
  const out = applyPriceChange(centralP(), { scope: { productIds: ['latte', 'cola'], includeSizes: false }, change: { mode: 'set', value: 2.5 }, sites: 'all' });
  assert.ok(out.changes.some((c) => c.target === 'product' && c.entity_id === 'cola' && c.after.default_price === 2.5));
  assert.ok(out.changes.some((c) => c.target === 'product_site' && c.entity_id === 'latte' && c.location_id === L2 && c.after.price === null));
  assert.equal(out.summary.clears, 2);
  assert.match(priceChangeWords(out.summary), /clears 2 site prices/);
});

test('scope: categories include sub categories; sizes follow their product; variants parents and archived never', () => {
  // 17 Oct recheck: Latte has a live size, so it is priced by its sizes (typed so or not) and never moved itself.
  const ids = (s) => productsInScope(central(), s).map((p) => p.id).sort();
  assert.deepEqual(ids({ categoryIds: ['hot'] }), ['latte-l', 'pumpkin']);
  assert.deepEqual(ids({ productIds: ['latte'] }), ['latte-l']);
  assert.deepEqual(ids({ productIds: ['latte'], includeSizes: false }), []);
  assert.deepEqual(ids({ all: true }), ['cola', 'latte-l', 'pumpkin']);
  // Its size off sale: Latte is priced by itself again.
  const idsP = (s) => productsInScope(centralP(), s).map((p) => p.id).sort();
  assert.deepEqual(idsP({ categoryIds: ['hot'] }), ['latte', 'pumpkin']);
});

test('17 Oct recheck: a site with no price is skipped by an amount or a percent (said and counted); Set to gives it the price', () => {
  const c = centralP();
  c.productSites.find((s) => s.product_id === 'cola' && s.location_id === L1).kept = { no_price: true };
  for (const change of [{ direction: 'up', mode: 'amount', value: 0.1 }, { direction: 'up', mode: 'percent', value: 10 }]) {
    for (const sites of ['all', [L1, L2]]) {
      const r = applyPriceChange(c, { scope: { productIds: ['cola'] }, change, sites });
      assert.ok(!r.changes.some((x) => x.target === 'product_site' && x.location_id === L1), JSON.stringify(r.changes));
      assert.equal(r.summary.noPrice, 1);
      const row = r.rows.find((x) => x.locationId === L1);
      assert.deepEqual([row.noPrice, row.skipped, row.before, row.after, row.changed], [true, true, null, null, false]);
      assert.match(priceChangeWords(r.summary), /1 with no price at its site was skipped \(it keeps no price there\)/);
      assert.ok(r.changes.some((x) => x.target === 'product_site' && x.location_id === L2), 'the site with a price still moves');
    }
  }
  // Set to: the price is chosen on purpose, "no price" goes in the same change.
  const all = applyPriceChange(c, { scope: { productIds: ['cola'] }, change: { mode: 'set', value: 2.5 }, sites: 'all' });
  assert.deepEqual(all.changes.find((x) => x.location_id === L1).after, { price: null, kept: {} }, 'it follows the new group price');
  const some = applyPriceChange(c, { scope: { productIds: ['cola'] }, change: { mode: 'set', value: 2.6 }, sites: [L1] });
  assert.deepEqual(some.changes.find((x) => x.location_id === L1).after, { price: 2.6, kept: {} });
  assert.equal(some.summary.noPrice, 0);
  // An order type price of its own still moves at a site with no Standard price.
  c.productSites.find((s) => s.product_id === 'cola' && s.location_id === L1).channel_prices = { takeaway: 1.9 };
  const tk = applyPriceChange(c, { scope: { productIds: ['cola'] }, change: { direction: 'up', mode: 'amount', value: 0.1 }, channel: 'takeaway', sites: [L1] });
  assert.equal(tk.changes.find((x) => x.location_id === L1).after.channel_prices.takeaway, 2);
  const tk2 = applyPriceChange(c, { scope: { productIds: ['cola'] }, change: { direction: 'up', mode: 'amount', value: 0.1 }, channel: 'dineIn', sites: [L1] });
  assert.equal(tk2.changes.length, 0, 'eat in would only fall back to its missing Standard price');
  assert.equal(tk2.rows.find((x) => x.locationId === L1).noPrice, true);
});

test('a channel price: worked from the inherited price and stored as that channel only', () => {
  const out = applyPriceChange(central(), { scope: { productIds: ['cola'] }, change: { direction: 'up', mode: 'amount', value: 0.5 }, channel: 'delivery', sites: 'all' });
  assert.deepEqual(out.changes[0], { target: 'product', entity_id: 'cola', location_id: null, op: 'update', after: { default_channels: { delivery: 2.5 } } });
});

test('the preview headline', () => {
  const out = applyPriceChange(central(), { scope: { all: true }, change: { direction: 'up', mode: 'percent', value: 5 }, sites: 'all' });
  assert.match(priceChangeWords(out.summary), /^\d+ prices change at \d sites/);
});

// ── 17 Oct review ────────────────────────────────────────────────────────────
const one = (product, sites) => ({
  sites: sites.map((s) => ({ location_id: s.location_id })),
  categories: [],
  products: [{ id: 'p', name: 'P', category_id: null, ...product }],
  productSites: sites.map((s) => ({ product_id: 'p', active: true, price: null, ...s })),
});

test('a channel rise at All sites never lowers a site that charges its own In store price for that channel', () => {
  const c = one({ default_price: 3, default_channels: null }, [{ location_id: L1, price: 3.5 }, { location_id: L2 }]);
  const out = applyPriceChange(c, { scope: { all: true }, change: { direction: 'up', mode: 'percent', value: 10 }, channel: 'delivery', sites: 'all' });
  const group = out.changes.find((x) => x.target === 'product');
  assert.equal(group.after.default_channels.delivery, 3.3);
  const london = out.changes.find((x) => x.target === 'product_site' && x.location_id === L1);
  assert.equal(london.after.channel_prices.delivery, 3.85, 'site 1 charged 3.50 for delivery: +10% is 3.85, never 3.30');
  const row = out.rows.find((r) => r.locationId === L1);
  assert.equal(row.before, 3.5);
  assert.equal(row.after, 3.85);
  assert.equal(row.staged, true, 'it can be unticked');
  assert.ok(!out.changes.some((x) => x.target === 'product_site' && x.location_id === L2), 'site 2 follows the group price, no row of its own');
});

test('drive thru reads takeaway first, like the till', () => {
  const c = one({ default_price: 3, default_channels: { takeaway: 3.2 } }, [{ location_id: L1 }]);
  const out = applyPriceChange(c, { scope: { all: true }, change: { direction: 'up', mode: 'percent', value: 10 }, channel: 'driveThru', sites: 'all' });
  const group = out.rows.find((r) => r.locationId === null);
  assert.equal(group.before, 3.2, 'the till charges the takeaway 3.20 for drive thru today');
  assert.equal(group.after, 3.52);
  const site = out.rows.find((r) => r.locationId === L1);
  assert.equal(site.before, 3.2);
  assert.equal(site.after, 3.52);
});

test('All sites keeps a site where the product is off in step: Set to clears its old price there too', () => {
  const c = one({ default_price: 3 }, [{ location_id: L1, price: 3.5, active: false }, { location_id: L2 }]);
  const out = applyPriceChange(c, { scope: { all: true }, change: { mode: 'set', value: 4 }, sites: 'all' });
  const offRow = out.changes.find((x) => x.target === 'product_site' && x.location_id === L1);
  assert.deepEqual(offRow.after, { price: null }, 'the old 3.50 is cleared, so turning it back on charges 4.00');
  const r = out.rows.find((x) => x.locationId === L1);
  assert.equal(r.off, true);
  assert.equal(out.summary.offSites, 1);
  assert.equal(out.summary.sites, 1, 'only site 2 counts as a till price change');
  assert.equal(out.summary.prices, 1);
  assert.match(priceChangeWords(out.summary), /where it is off/);
});

test('an In store change flags products with an Eat in price set separately (the counter charges that first)', () => {
  const c = one({ default_price: 3, default_channels: { dineIn: 3 } }, [{ location_id: L1 }]);
  const out = applyPriceChange(c, { scope: { all: true }, change: { direction: 'up', mode: 'amount', value: 0.2 }, sites: 'all' });
  assert.deepEqual(out.rows.find((r) => r.locationId === L1).pinned, ['dineIn']);
  assert.equal(out.summary.pinned, 1);
});

test('the headline counts site prices only, never the group price row', () => {
  const c = one({ default_price: 3 }, [{ location_id: L1 }, { location_id: L2 }, { location_id: L3 }]);
  const out = applyPriceChange(c, { scope: { all: true }, change: { direction: 'up', mode: 'amount', value: 0.1 }, sites: 'all' });
  assert.equal(out.summary.prices, 3);
  assert.match(priceChangeWords(out.summary), /^3 prices change at 3 sites/);
});

test('chosen sites: a site whose new price lands on the group price is staged, so it can be unticked', () => {
  const c = one({ default_price: 3 }, [{ location_id: L1, price: 2.9 }]);
  const out = applyPriceChange(c, { scope: { all: true }, change: { direction: 'up', mode: 'amount', value: 0.1 }, sites: [L1] });
  const r = out.rows.find((x) => x.locationId === L1);
  assert.equal(r.follows, true);
  assert.equal(r.staged, true);
});

test('a minus sign in a percent never flips the direction', () => {
  assert.equal(changeOne(300, { direction: 'up', mode: 'percent', value: -10 }).pence, 330);
});

// ── Round 2 review (17 Oct 2026) ────────────────────────────────────────────

test('review: "also order type prices" never clears a site\'s own Takeaway to follow a value the till will not charge (every site)', () => {
  const c = centralP();
  c.products[0].default_channels = null;
  c.productSites[1] = { product_id: 'latte', location_id: L2, price: 3.5, channel_prices: { takeaway: 2.8 }, active: true };
  const r = applyPriceChange(c, { scope: { productIds: ['latte'], includeSizes: false }, change: { direction: 'up', mode: 'amount', value: 0.2 }, sites: 'all', alsoChannels: true });
  const l2 = r.changes.find((x) => x.target === 'product_site' && x.location_id === L2);
  assert.equal(l2.after.price, 3.7, 'Leeds Standard 3.50 to 3.70');
  assert.equal(l2.after.channel_prices.takeaway, 3, 'its own Takeaway 2.80 to 3.00, kept as its own (cleared it would charge 3.70)');
});

test('review: "also order type prices" never clears a site\'s own Takeaway to follow (only some sites)', () => {
  const c = centralP();
  c.productSites[1] = { product_id: 'latte', location_id: L2, price: 3.5, channel_prices: { takeaway: 3.3 }, active: true };
  const r = applyPriceChange(c, { scope: { productIds: ['latte'], includeSizes: false }, change: { direction: 'up', mode: 'amount', value: 0.2 }, sites: [L2], alsoChannels: true });
  const l2 = r.changes.find((x) => x.target === 'product_site' && x.location_id === L2);
  assert.equal(l2.after.price, 3.7);
  assert.equal(l2.after.channel_prices.takeaway, 3.5, 'Takeaway 3.30 to 3.50 stays its own (the new Standard is 3.70)');
});

test('review: an option that takes money off is never clamped to 0.00 by Change prices', () => {
  const c = {
    sites: [{ location_id: L1 }, { location_id: L2 }],
    groups: [{ id: 'milk', name: 'Milk' }],
    options: [{ id: 'none', group_id: 'milk', name: 'No milk', price: -0.2 }, { id: 'oat', group_id: 'milk', name: 'Oat', price: 0.4 }],
    optionSites: [
      { option_id: 'none', location_id: L1, active: true, price: null }, { option_id: 'none', location_id: L2, active: true, price: -0.3 },
      { option_id: 'oat', location_id: L1, active: true, price: null }, { option_id: 'oat', location_id: L2, active: true, price: null },
    ],
    products: [], productSites: [], categories: [],
  };
  for (const change of [{ direction: 'up', mode: 'amount', value: 0.1 }, { direction: 'up', mode: 'percent', value: 10 }]) {
    for (const sites of ['all', [L1, L2]]) {
      const r = applyPriceChange(c, { scope: { optionGroupIds: ['milk'] }, change, sites });
      assert.ok(!r.changes.some((x) => x.entity_id === 'none'), JSON.stringify(r.changes));
      assert.equal(r.summary.clamped, 0);
      assert.ok(r.summary.minusKept >= 1);
      assert.match(priceChangeWords(r.summary), /take(s)? money off (was|were) left as (it is|they are)/);
    }
  }
});
