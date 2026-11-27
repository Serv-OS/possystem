// Multi site menu, 5.12.120: A DELIVERY PRICE, like every other order type.
//
// Peter, 27 Nov 2026 (Mozz): "then also I cant set a delivery price in the multi site menu manager".
// On 17 Oct 2026 Delivery had been left out on purpose ("a platform price, set by the menu chosen for
// that platform at each site"), so the group menu stored delivery prices and no screen showed them
// and publish never wrote them.
//
// THE GUARD these tests pin: a delivery price a SITE set for itself, that the group menu never held,
// is never touched by a publish. An edit to Takeaway must not clear it.
//
// Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { proposeImport, buildCentral } from '../../../supabase/functions/_shared/msmImport.js';
import { planSite, touchedFromChanges } from '../../../supabase/functions/_shared/msmPlan.js';
import { applyChanges } from '../../../supabase/functions/_shared/msmDiff.js';
import { PUBLISHED_CHANNELS, CHANNELS } from '../../../supabase/functions/_shared/msmModel.js';
import { defaultPriceChange, sitePriceChange } from './msmEdit.js';
import { shownPriceTypes, examplePrice } from './msmOrderTypes.js';
import { A, B, ORG, idGen } from './msmFixture.js';
import { groupVenues, groupSites } from './msmGroupFixture.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

function setup(prep = () => {}) {
  const v = groupVenues();
  prep(v);
  const sites = groupSites(v);
  const { central } = buildCentral(proposeImport(sites, { idGen: idGen() }), sites, {}, { idGen: idGen('g') });
  // A plain product sold at both sites, with no sizes.
  const product = central.products.find((p) => !p.archived && !p.parent_product_id && p.type !== 'subitem'
    && !central.products.some((x) => x.parent_product_id === p.id)
    && [A, B].every((loc) => central.productSites.some((s) => s.product_id === p.id && s.location_id === loc && s.active !== false)));
  const rowAt = (loc, vv = v) => vv[loc].items.find((i) => i.id === central.productSites.find((s) => s.product_id === product.id && s.location_id === loc).venue_item_id);
  const plan = (c, changes, loc, venue = v[loc]) => planSite({ central: applyChanges(c, changes).central, touched: touchedFromChanges(changes), locationId: loc, orgId: ORG, venue });
  const pricingWrites = (pl) => pl.lines.filter((l) => String(l.column || '').startsWith('pricing.')).map((l) => [l.column, l.after]);
  return { v, central, product, rowAt, plan, pricingWrites };
}

test('Delivery is an order type price the group menu sets and publish writes', () => {
  assert.deepEqual([...PUBLISHED_CHANNELS], ['dineIn', 'takeaway', 'collection', 'delivery', 'driveThru']);
  assert.deepEqual([...PUBLISHED_CHANNELS], [...CHANNELS], 'every price a venue row carries is one the group menu can set');
  assert.deepEqual(shownPriceTypes({ menu: { order_types: ['dineIn', 'delivery'] }, products: [] }).types, ['dineIn', 'delivery']);
  assert.equal(examplePrice('delivery', { default_price: 10, default_channels: { delivery: 12 } }, {}), 12, 'the tax example uses the delivery price');
  assert.equal(examplePrice('delivery', { default_price: 10, default_channels: {} }, {}), 10, 'blank uses the Standard price');
  const details = read('../../backoffice/sections/msm/MsmDetails.jsx');
  assert.match(details, /const TYPE_CHOICES = \['dineIn', 'takeaway', 'collection', 'delivery', 'driveThru', 'bar'\];/, 'Delivery can be ticked under Order types');
});

test('a group delivery price goes to every site; one site can have its own', () => {
  const { central, product, plan, pricingWrites } = setup();
  const ctx = { live: central, eff: central };
  const set = defaultPriceChange(ctx, product.id, 12.5, 'delivery');
  assert.ok(set.change, set.words);
  for (const loc of [A, B]) assert.deepEqual(pricingWrites(plan(central, [set.change], loc)), [['pricing.delivery', 12.5]], `one write at the site: the delivery price`);
  // One site's own delivery price: only that site is written.
  const own = sitePriceChange(ctx, product.id, B, 14, 'delivery');
  assert.ok(own.change, own.words);
  assert.deepEqual(pricingWrites(plan(central, [own.change], B)), [['pricing.delivery', 14]]);
  assert.deepEqual(pricingWrites(plan(central, [own.change], A)), []);
});

test('THE GUARD: a delivery price a site set for itself is never cleared by another price edit', () => {
  // Site A set its own delivery price in its Back Office after the group menu was made.
  const { v, central, product, rowAt, plan, pricingWrites } = setup();
  assert.equal(product.default_channels?.delivery ?? null, null, 'the group menu holds no delivery price for it');
  rowAt(A).pricing = { ...(rowAt(A).pricing || {}), delivery: 9.75 };
  const ctx = { live: central, eff: central };
  const takeaway = defaultPriceChange(ctx, product.id, 3.15, 'takeaway');
  assert.ok(takeaway.change, takeaway.words);
  const lines = pricingWrites(plan(central, [takeaway.change], A, v[A]));
  assert.deepEqual(lines, [['pricing.takeaway', 3.15]], 'only Takeaway is written; the site\'s delivery price is left alone');
  // The same for a Standard price change, and for a site level change to another order type.
  const std = defaultPriceChange(ctx, product.id, Number(product.default_price) + 1);
  assert.ok(!pricingWrites(plan(central, [std.change], A, v[A])).some(([c]) => c === 'pricing.delivery'));
  const siteTake = sitePriceChange(ctx, product.id, A, 3.35, 'takeaway');
  assert.deepEqual(pricingWrites(plan(central, [siteTake.change], A, v[A])), [['pricing.takeaway', 3.35]]);
});

test('taking the group\'s delivery price away does take it away at the sites', () => {
  const { v, central, product, rowAt, plan, pricingWrites } = setup();
  // Published state: the group menu holds 12.50 for delivery and both sites have it.
  const live = applyChanges(central, [defaultPriceChange({ live: central, eff: central }, product.id, 12.5, 'delivery').change]).central;
  for (const loc of [A, B]) rowAt(loc).pricing = { ...(rowAt(loc).pricing || {}), delivery: 12.5 };
  const clear = defaultPriceChange({ live, eff: live }, product.id, null, 'delivery');
  assert.ok(clear.change, clear.words);
  assert.equal(clear.change.before.default_channels.delivery, 12.5, 'the change says what was there');
  for (const loc of [A, B]) assert.deepEqual(pricingWrites(plan(live, [clear.change], loc, v[loc])), [['pricing.delivery', null]]);
  // A change with no "before" (an older draft): not known what moved, so a delivery price is only
  // ever written where the group menu holds one. Nothing is cleared by guesswork.
  const blind = { ...clear.change, before: {} };
  assert.deepEqual(pricingWrites(plan(live, [blind], A, v[A])), []);
});

test('a site that joins or a product turned on at a site: a delivery price goes on the new row only when the group has one', () => {
  const { v, central, product, plan } = setup();
  const ctx = { live: central, eff: central };
  const set = defaultPriceChange(ctx, product.id, 12.5, 'delivery').change;
  // Site B has no row for the product yet: turn it on there.
  const ps = central.productSites.find((s) => s.product_id === product.id && s.location_id === B);
  const vB = { ...v[B], items: v[B].items.filter((i) => i.id !== ps.venue_item_id) };
  const on = { target: 'product_site', entity_id: product.id, location_id: B, op: 'create', after: { active: true, venue_item_id: ps.venue_item_id }, before: {} };
  const withPrice = plan(central, [set, on], B, vB).writes.items.insert.find((r) => r.id === ps.venue_item_id);
  assert.equal(withPrice?.pricing?.delivery, 12.5);
  const without = plan(central, [on], B, vB).writes.items.insert.find((r) => r.id === ps.venue_item_id);
  assert.ok(without, 'the row is made');
  assert.ok(!('delivery' in without.pricing), 'no delivery key when the group menu has no delivery price');
});
