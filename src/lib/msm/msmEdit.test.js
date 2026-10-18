// Multi site menu: what each edit on the screens stages (msmEdit.js). Before comes from the
// menu as published, a price equal to what the site would follow is stored as "follows", turning
// a product on where it is not sold adds it there with a new venue id, nothing is ever deleted,
// and Change prices results carry their before so the draft remembers where it started.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  followPrice, sitePrice, sitePriceChange, siteActiveChange, defaultPriceChange, productProblems, productUpdate,
  newProductChanges, removeProductChange, restoreProductChange, groupValueChange, newCategoryChange,
  activeMany, priceMany, copyPricesMany, moveMany, pasteColumn, taxChoices, withBefore, withoutUnticked,
} from './msmEdit.js';
import { applyChanges, mergeStaged } from '../../../supabase/functions/_shared/msmDiff.js';
import { applyPriceChange } from '../../../supabase/functions/_shared/msmPrice.js';
import { checkChange } from '../../../supabase/functions/_shared/msmModel.js';

const P1 = 'aaaaaaaa-1111-4000-8000-000000000001';
const L1 = 'site-0000-0000-0000-00000000aa01', L2 = 'site-0000-0000-0000-00000000bb02', L3 = 'site-0000-0000-0000-00000000cc03';
function live() {
  return {
    menu: { id: 'm', name: 'Menu' },
    sites: [{ location_id: L1 }, { location_id: L2 }, { location_id: L3 }],
    categories: [{ id: 'hot', label: 'Hot', sort_order: 1 }, { id: 'cold', label: 'Cold', sort_order: 2 }],
    products: [
      { id: 'latte', name: 'Latte', menu_name: 'Latte', category_id: 'hot', default_price: 3, default_channels: null, tax_rate_name: 'VAT', tax_rate_percent: 20, family_base: 'm-latte' },
      { id: 'latte-l', name: 'Large latte', category_id: 'hot', parent_product_id: 'latte', default_price: 3.5, tax_rate_name: 'VAT', tax_rate_percent: 20 },
      { id: 'cola', name: 'Cola', category_id: 'cold', default_price: 2.2, tax_rate_name: 'VAT', tax_rate_percent: 20 },
      { id: 'pie', name: 'Pie', category_id: 'cold', default_price: 4.5, site_only_location_id: L3, tax_rate_name: 'VAT', tax_rate_percent: 20 },
    ],
    productSites: [
      { product_id: 'latte', location_id: L1, venue_item_id: 'm-latte', price: null, active: true, kept: {} },
      { product_id: 'latte', location_id: L2, venue_item_id: 'm-latte_00bb02', price: 3.2, active: true, kept: { cat: 'x', image: 'y' }, channel_prices: { takeaway: 3.1 } },
      { product_id: 'latte-l', location_id: L1, venue_item_id: 'm-latte-l', price: null, active: true },
      { product_id: 'latte-l', location_id: L2, venue_item_id: 'm-latte-l_b', price: null, active: true },
      { product_id: 'cola', location_id: L1, venue_item_id: 'cola-1', price: null, active: true },
      { product_id: 'cola', location_id: L2, venue_item_id: 'cola-2', price: 2.4, active: false },
      { product_id: 'pie', location_id: L3, venue_item_id: 'pie-3', price: null, active: true },
    ],
  };
}
const ctxOf = (draft = []) => { const l = live(); return { live: l, eff: applyChanges(l, draft).central }; };

test('a site price: its own price, back on the group price when it equals it, nothing when nothing changes', () => {
  const ctx = ctxOf();
  assert.deepEqual(sitePriceChange(ctx, 'latte', L1, 3.4).change, { target: 'product_site', entity_id: 'latte', location_id: L1, op: 'update', after: { price: 3.4 }, before: { price: null } });
  assert.deepEqual(sitePriceChange(ctx, 'latte', L2, 3).change.after, { price: null }, '3.00 is the group price: the site follows it again');
  assert.deepEqual(sitePriceChange(ctx, 'latte', L2, null).change.after, { price: null });
  assert.equal(sitePriceChange(ctx, 'latte', L2, 3.2).change, null, 'already 3.20');
  assert.equal(sitePriceChange(ctx, 'latte', L1, 3).change, null, 'already follows 3.00');
  assert.match(sitePriceChange(ctx, 'latte', L1, -1).words, /below zero/);
  assert.match(sitePriceChange(ctx, 'latte', L3, 3).words, /not at that site/);
  assert.equal(sitePriceChange(ctx, 'latte', L1, 3.333).change.after.price, 3.33, 'whole pence');
  for (const c of [sitePriceChange(ctx, 'latte', L1, 3.4).change]) assert.ok(checkChange(c).ok, 'the database guard would take it');
});

test('a site price per channel: one key changes, clearing deletes the key, before is the published value', () => {
  const ctx = ctxOf();
  const r = sitePriceChange(ctx, 'latte', L2, 3.3, 'takeaway').change;
  assert.deepEqual(r.after, { channel_prices: { takeaway: 3.3 } });
  assert.deepEqual(r.before, { channel_prices: { takeaway: 3.1 } });
  assert.deepEqual(sitePriceChange(ctx, 'latte', L2, null, 'takeaway').change.after, { channel_prices: null }, 'the last key gone: no channel prices at all');
  assert.deepEqual(sitePriceChange(ctx, 'latte', L2, 3.2, 'delivery').change, null, 'equal to what delivery follows there (the site\'s 3.20)');
  assert.deepEqual(sitePriceChange(ctx, 'latte', L1, 3.6, 'delivery').change.after, { channel_prices: { delivery: 3.6 } });
  assert.equal(followPrice(ctx.eff.products[0], ctx.eff.productSites[1], 'delivery'), 3.2);
  assert.equal(sitePrice(ctx.eff.products[0], ctx.eff.productSites[1], 'takeaway'), 3.1);
});

test('editing the same cell twice keeps the FIRST before, and putting it back removes the staged row', () => {
  const ctx0 = ctxOf();
  const first = sitePriceChange(ctx0, 'latte', L1, 3.4).change;
  const row = { ...mergeStaged(null, first).row, id: 'r1' };
  const ctx1 = ctxOf([row]);
  const second = sitePriceChange(ctx1, 'latte', L1, 3.6).change;
  assert.deepEqual(second.before, { price: null }, 'before comes from the published menu');
  assert.deepEqual(mergeStaged(row, second).row.after, { price: 3.6 });
  const back = sitePriceChange(ctx1, 'latte', L1, 3).change;
  assert.equal(mergeStaged(row, back).action, 'delete');
});

test('on and off at a site; on where it is not sold adds it with a venue id in the sharing scheme; a one site product goes on at a second site (UI issue 8)', () => {
  const ctx = ctxOf();
  assert.deepEqual(siteActiveChange(ctx, 'cola', L2, true).change.after, { active: true });
  assert.deepEqual(siteActiveChange(ctx, 'cola', L2, true).change.before, { active: false });
  assert.equal(siteActiveChange(ctx, 'cola', L1, true).change, null);
  const add = siteActiveChange(ctx, 'latte', L3, true).change;
  assert.equal(add.op, 'create');
  assert.deepEqual(add.after, { venue_item_id: 'm-latte_0000cc03', active: true, price: null, channel_prices: null });
  assert.ok(checkChange(add).ok);
  assert.equal(siteActiveChange(ctx, 'latte', L3, false).change, null, 'off where it is not sold: nothing');
  const pie = siteActiveChange(ctx, 'pie', L1, true);
  assert.equal(pie.words, undefined, 'never refused');
  assert.equal(pie.change.op, 'create');
  assert.deepEqual(pie.extra.map((c) => [c.target, c.after]), [['product', { site_only_location_id: null }]], 'it becomes a normal product on at both');
  assert.equal(siteActiveChange(ctx, 'cola', L1, true).already, true, 'already on: said, never silent');
  assert.match(siteActiveChange(ctx, 'latte', 'elsewhere', true).words, /not in the group menu/);
});

test('the group price: In store cannot be blank; a channel can be cleared', () => {
  const ctx = ctxOf();
  assert.deepEqual(defaultPriceChange(ctx, 'latte', 3.1).change, { target: 'product', entity_id: 'latte', location_id: null, op: 'update', after: { default_price: 3.1 }, before: { default_price: 3 } });
  assert.match(defaultPriceChange(ctx, 'latte', null).words, /cannot be blank/);
  assert.equal(defaultPriceChange(ctx, 'latte', 3).change, null);
  const ch = defaultPriceChange(ctx, 'latte', 3.5, 'delivery').change;
  assert.deepEqual(ch.after, { default_channels: { delivery: 3.5 } });
  assert.deepEqual(ch.before, { default_channels: null });
});

test('a product\'s own fields: only what differs, with words for what is wrong', () => {
  const ctx = ctxOf();
  const r = productUpdate(ctx, 'latte', { name: 'Latte', menu_name: 'Caffe latte', category_id: 'hot', allergens: ['milk'] });
  assert.deepEqual(r.change.after, { menu_name: 'Caffe latte', allergens: ['milk'] });
  assert.deepEqual(r.change.before, { menu_name: 'Latte', allergens: null });
  assert.equal(productUpdate(ctx, 'latte', { name: 'Latte' }).change, null);
  assert.match(productUpdate(ctx, 'latte', { name: '  ' }).words, /name/);
  assert.match(productUpdate(ctx, 'latte', { category_id: null }).words, /category/);
  assert.equal(productUpdate(ctx, 'latte', { family_base: 'x', site_only_location_id: L1 }).change, null, 'never staged from the sheet');
  assert.deepEqual(productProblems({ name: 'X', category_id: 'hot', default_price: 1 }, ctx), ['Pick the VAT rate.']);
  assert.deepEqual(productProblems({ name: 'X', category_id: 'hot', default_price: 1, tax_rate_percent: 20 }, ctx), []);
  assert.deepEqual(productProblems({ name: 'X', category_id: 'hot', default_price: '' }, { eff: { products: [] } }), ['Give the product a price (0.00 for free).']);
});

test('a new product: the product first, then each site with a new venue id; a price equal to the group\'s follows it', () => {
  const ctx = ctxOf();
  const r = newProductChanges(ctx, { id: P1, fields: { name: ' Gingerbread latte ', category_id: 'hot', default_price: 4.2, tax_rate_name: 'VAT', tax_rate_percent: 20 }, sites: [{ location_id: L1, price: null }, { location_id: L2, price: 4.2 }, { location_id: L3, price: 4.5 }, { location_id: 'not-ours', price: 1 }] });
  assert.equal(r.words, undefined);
  assert.deepEqual(r.changes.map((c) => [c.target, c.op, c.location_id]), [['product', 'create', null], ['product_site', 'create', L1], ['product_site', 'create', L2], ['product_site', 'create', L3]]);
  assert.equal(r.changes[0].after.name, 'Gingerbread latte');
  assert.equal(r.changes[0].after.menu_name, 'Gingerbread latte');
  assert.deepEqual(r.changes.slice(1).map((c) => c.after.venue_item_id), ['msm-aaaaaaaa1111_0000aa01', 'msm-aaaaaaaa1111_0000bb02', 'msm-aaaaaaaa1111_0000cc03']);
  assert.deepEqual(r.changes.slice(1).map((c) => c.after.price), [null, null, 4.5]);
  for (const c of r.changes) assert.ok(checkChange(c).ok, `${c.target} passes the guard`);
  // Shown in the grid at once (the draft applied).
  const eff = applyChanges(live(), r.changes).central;
  assert.equal(eff.products.find((p) => p.id === P1).default_price, 4.2);
  assert.equal(eff.productSites.filter((s) => s.product_id === P1).length, 3);
});

test('a site only extra goes to its one site only; a new product needs a site, a name, a category and a price', () => {
  const ctx = ctxOf();
  const r = newProductChanges(ctx, { id: P1, fields: { name: 'Station deal', category_id: 'cold', default_price: 6.5, tax_rate_percent: 20, site_only_location_id: L2 }, sites: [{ location_id: L1 }, { location_id: L2 }] });
  assert.deepEqual(r.changes.map((c) => c.location_id), [null, L2]);
  assert.equal(r.changes[0].after.site_only_location_id, L2);
  const none = newProductChanges(ctx, { id: P1, fields: { name: 'Station deal', category_id: 'cold', default_price: 6.5, tax_rate_percent: 20, site_only_location_id: L2 }, sites: [] });
  assert.deepEqual(none.changes.map((c) => c.location_id), [null, L2], 'an extra with no sites ticked still goes on at its site');
  assert.match(newProductChanges(ctx, { id: P1, fields: { name: 'X', category_id: 'cold', default_price: 1, tax_rate_percent: 20 }, sites: [] }).words, /at least one site/);
  assert.match(newProductChanges(ctx, { id: P1, fields: { category_id: 'cold', default_price: 1, tax_rate_percent: 20 }, sites: [{ location_id: L1 }] }).words, /name/);
  assert.match(newProductChanges(ctx, { id: 'latte', fields: { name: 'X', category_id: 'cold', default_price: 1, tax_rate_percent: 20 }, sites: [{ location_id: L1 }] }).words, /already exists/);
});

test('remove and bring back are the archived flag, never a delete', () => {
  const ctx = ctxOf();
  assert.deepEqual(removeProductChange(ctx, 'cola').change.after, { archived: true });
  assert.equal(restoreProductChange(ctx, 'cola').change, null);
  const gone = ctxOf([{ target: 'product', entity_id: 'cola', op: 'update', after: { archived: true } }]);
  assert.deepEqual(restoreProductChange(gone, 'cola').change, { target: 'product', entity_id: 'cola', location_id: null, op: 'update', after: { archived: false }, before: { archived: false } });
  assert.equal(removeProductChange(gone, 'cola').change, null);
});

test('use the group\'s value: the kept column is taken out, the rest stay kept', () => {
  const ctx = ctxOf();
  const r = groupValueChange(ctx, 'latte', L2, 'cat').change;
  assert.deepEqual(r.after, { kept: { image: 'y' } });
  assert.deepEqual(r.before, { kept: { cat: 'x', image: 'y' } });
  assert.equal(groupValueChange(ctx, 'latte', L1, 'cat').change, null);
});

test('a new category: a top level one must say which category it prints like (the tills would print nothing otherwise)', () => {
  const ctx = ctxOf();
  assert.match(newCategoryChange(ctx, { id: P1, label: 'Christmas' }).words, /prints like/);
  const top = newCategoryChange(ctx, { id: P1, label: ' Christmas ', route_like_id: 'hot' }).change;
  assert.deepEqual([top.after.label, top.after.parent_id, top.after.route_like_id, top.after.sort_order], ['Christmas', null, 'hot', 3]);
  assert.ok(checkChange(top).ok);
  const sub = newCategoryChange(ctx, { id: P1, label: 'Seasonal', parent_id: 'hot' }).change;
  assert.equal(sub.after.route_like_id, null, 'a sub category prints like its parent');
  assert.match(newCategoryChange(ctx, { id: P1, label: '' }).words, /name/);
  assert.match(newCategoryChange(ctx, { id: P1, label: 'X', parent_id: 'nope' }).words, /under/);
});

test('the bulk bar: on, off, one price, copy from a site, move with sizes, paste down a column', () => {
  const ctx = ctxOf();
  const on = activeMany(ctx, ['cola', 'pie'], [L1, L2, L3], true);
  assert.deepEqual(on.changes.map((c) => [c.target, c.entity_id, c.location_id, c.op]), [
    ['product_site', 'cola', L2, 'update'], ['product_site', 'cola', L3, 'create'],
    ['product_site', 'pie', L1, 'create'], ['product', 'pie', null, 'update'], ['product_site', 'pie', L2, 'create'],
  ], 'a one site product goes on at the others too, its old mark cleared once (UI issues 8 and 11)');
  const off = activeMany(ctx, ['latte'], [L1, L2], false);
  assert.equal(off.changes.length, 2);
  const price = priceMany(ctx, ['latte', 'cola'], [L1, L2, L3], 3.2);
  assert.deepEqual(price.changes.map((c) => [c.entity_id, c.location_id, c.after.price]), [['latte', L1, 3.2], ['cola', L1, 3.2], ['cola', L2, 3.2]], 'only where sold; Latte at L2 is already 3.20');
  const copy = copyPricesMany(ctx, ['latte'], L2, [L1, L3]);
  assert.deepEqual(copy.changes.map((c) => [c.location_id, c.after.price]), [[L1, 3.2]]);
  const move = moveMany(ctx, ['latte'], 'cold');
  assert.deepEqual(move.changes.map((c) => c.entity_id).sort(), ['latte', 'latte-l'], 'the size moves with it');
  assert.deepEqual(moveMany(ctx, ['latte'], 'nope').words, ['Pick a category.']);
  const paste = pasteColumn(ctx, [{ productId: 'latte', value: 3.3 }, { productId: 'cola', value: null }, { productId: 'latte-l', value: 3.9 }], L1);
  assert.deepEqual(paste.changes.map((c) => [c.entity_id, c.after.price]), [['latte', 3.3], ['latte-l', 3.9]]);
  const pasteDefault = pasteColumn(ctx, [{ productId: 'cola', value: 2.5 }], null);
  assert.deepEqual(pasteDefault.changes[0].after, { default_price: 2.5 });
});

test('Change prices: the before of each change comes from the published menu, and unticked rows are left out', () => {
  const ctx = ctxOf();
  const res = applyPriceChange(ctx.eff, { scope: { all: true }, change: { direction: 'up', mode: 'amount', value: 0.1 }, sites: 'all' });
  const staged = withBefore(ctx.live, res.changes);
  const latteDefault = staged.find((c) => c.target === 'product' && c.entity_id === 'latte');
  assert.deepEqual(latteDefault.before, { default_price: 3 });
  const latteL2 = staged.find((c) => c.target === 'product_site' && c.entity_id === 'latte' && c.location_id === L2);
  assert.deepEqual([latteL2.after.price, latteL2.before.price], [3.3, 3.2]);
  for (const c of staged) assert.ok(checkChange(c).ok);
  const kept = withoutUnticked(staged, new Set(['cola']), new Set([`latte|${L2}`]));
  assert.equal(kept.some((c) => c.entity_id === 'cola'), false);
  assert.equal(kept.some((c) => c.entity_id === 'latte' && c.location_id === L2), false);
  assert.equal(kept.some((c) => c.entity_id === 'latte' && c.target === 'product'), true, 'the group price still changes');
});

test('VAT choices: the rates the menu uses, most used first', () => {
  const c = live();
  c.products.push({ id: 'water', name: 'Water', tax_rate_name: 'Zero', tax_rate_percent: 0 });
  assert.deepEqual(taxChoices(c).map((t) => t.label), ['VAT 20%', 'Zero 0%']);
});

test('drive thru follows takeaway before In store, like the till (one chain everywhere)', () => {
  const product = { id: 'p', default_price: 3, default_channels: { takeaway: 3.2 } };
  assert.equal(followPrice(product, { price: null }, 'driveThru'), 3.2);
  assert.equal(followPrice(product, { price: null, channel_prices: { takeaway: 3.4 } }, 'driveThru'), 3.4, 'the site\'s own takeaway first');
  assert.equal(followPrice({ id: 'p', default_price: 3 }, { price: 3.5 }, 'driveThru'), 3.5, 'then the site\'s own In store price');
  assert.equal(followPrice(product, { price: 3.5 }, 'delivery'), 3.5, 'other channels skip takeaway');
});
