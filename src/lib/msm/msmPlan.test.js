// Multi site menu: THE PLANNER (supabase/functions/_shared/msmPlan.js). What a publish writes at a
// venue, proved on a company shaped like the live estate (msmFixture.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planSite, touchedFromChanges, centresFor, mapTaxRate, countsWords, lineWords } from '../../../supabase/functions/_shared/msmPlan.js';
import { checkSite } from '../../../supabase/functions/_shared/msmHealth.js';
import { applyChanges } from '../../../supabase/functions/_shared/msmDiff.js';
import { proposeImport, buildCentral } from '../../../supabase/functions/_shared/msmImport.js';
import { planAddSite } from '../../../supabase/functions/_shared/msmSites.js';
import { A, B, C, sfx, ORG, importSites, idGen, venues } from './msmFixture.js';

function setup() {
  const v = venues();
  const sites = importSites(v);
  const { central } = buildCentral(proposeImport(sites, { idGen: idGen() }), sites, {}, { idGen: idGen('g') });
  central.menu = { id: '99999999-0000-4000-8000-000000000001', name: 'Group menu', description: '', use_name_everywhere: false };
  const P = (name) => central.products.find((p) => p.name === name);
  const K = (label) => central.categories.find((c) => c.label === label);
  return { v, central, P, K };
}
const plan = (central, changes, loc, venue) => {
  const after = applyChanges(central, changes).central;
  return planSite({ central: after, touched: touchedFromChanges(changes), locationId: loc, orgId: ORG, venue });
};

test('only the touched field is written, and only where it differs', () => {
  const { v, central, P } = setup();
  const p = plan(central, [{ target: 'product', entity_id: P('Mocha').id, op: 'update', after: { description: 'Rich' } }], A, v[A]);
  assert.deepEqual(p.writes.items.update, [{ id: 'm-mocha', set: { description: 'Rich' } }]);
  assert.equal(p.writes.items.insert.length, 0);
  const again = plan(central, [{ target: 'product', entity_id: P('Mocha').id, op: 'update', after: { description: '' } }], A, v[A]);
  assert.equal(again.empty, true, 'the venue already holds it: nothing to write');
});

test('a default price moves every site that follows it, never a site with its own price', () => {
  const { v, central, P } = setup();
  const ch = [{ target: 'product', entity_id: P('Latte').id, op: 'update', after: { default_price: 3.3 } }];
  const a = plan(central, ch, A, v[A]);
  const b = plan(central, ch, B, v[B]);
  assert.equal(a.empty, true, 'site A has its own 3.00');
  assert.deepEqual(b.writes.items.update, [{ id: `m-latte_${sfx(B)}`, set: {}, pricing: { base: 3.3 } }]);
});

test('pricing is a patch of base and channel keys: the venue\'s menu tier prices are never touched', () => {
  const { v, central, P } = setup();
  const p = plan(central, [{ target: 'product_site', entity_id: P('Latte').id, location_id: A, op: 'update', after: { price: 3.1 } }], A, v[A]);
  const u = p.writes.items.update[0];
  assert.deepEqual(u.pricing, { base: 3.1 });
  assert.deepEqual(p.applied.items.find((i) => i.id === 'm-latte').pricing.menus, { 'menu-a': { base: 2.5 } });
});

test('ids never change: an update targets the venue\'s own id; venue products not in the group are left alone', () => {
  const { v, central, P } = setup();
  const p = plan(central, [{ target: 'product', entity_id: P('Cola').id, op: 'update', after: { name: 'Cola Zero' } }], C, v[C]);
  assert.deepEqual(p.writes.items.update.map((u) => u.id), [`m-cola_${sfx(C)}`]);
  assert.ok(!p.lines.some((l) => l.id === 'l-pie-c' || l.id === 'l-cookie-a'));
});

test('a kept venue value is never written at that site; "Use the group\'s" clears it and writes it', () => {
  const { v, central, P } = setup();
  const mocha = P('Mocha');
  const change = [{ target: 'product', entity_id: mocha.id, op: 'update', after: { name: 'Mocha', category_id: central.categories.find((c) => c.label === 'Cold drinks').id } }];
  const c1 = plan(central, change, C, v[C]);
  assert.ok(!c1.lines.some((l) => l.column === 'cat'), 'site C keeps its own category');
  const a1 = plan(central, change, A, v[A]);
  assert.ok(a1.lines.some((l) => l.column === 'cat' && l.after === 'cat-cold'), 'site A follows the group');
  const clear = [{ target: 'product_site', entity_id: mocha.id, location_id: C, op: 'update', after: { kept: {} }, before: { kept: { cat: 'cat-c-own' } } }];
  const c2 = plan(central, clear, C, v[C]);
  assert.deepEqual(c2.writes.items.update, [{ id: `m-mocha_${sfx(C)}`, set: { cat: `cat-hot_${sfx(C)}` } }]);
});

test('turning a product off is never a delete: archived = true', () => {
  const { v, central, P } = setup();
  const p = plan(central, [{ target: 'product_site', entity_id: P('Cola').id, location_id: B, op: 'update', after: { active: false } }], B, v[B]);
  assert.deepEqual(p.writes.items.update, [{ id: `m-cola_${sfx(B)}`, set: { archived: true } }]);
  const r = plan(central, [{ target: 'product', entity_id: P('Cola').id, op: 'remove', after: {} }], A, v[A]);
  assert.deepEqual(r.writes.items.update, [{ id: 'm-cola', set: { archived: true } }]);
});

test('a new product in a new category: ids in the suffix scheme, parents first, menu link, routing by "Send like"', () => {
  const { v, central, K } = setup();
  const catId = 'e0000000-0000-4000-8000-0000000000c1';
  const pid = 'e0000000-0000-4000-8000-0000000000p1'.replace('p', '0');
  const ch = [
    { target: 'category', entity_id: catId, op: 'create', after: { label: 'Christmas', sort_order: 5, route_like_id: K('Hot drinks').id } },
    { target: 'product', entity_id: pid, op: 'create', after: { name: 'Gingerbread latte', category_id: catId, default_price: 3.95, tax_rate_name: 'VAT', tax_rate_percent: 20, type: 'simple', sold_alone: true } },
    { target: 'product_site', entity_id: pid, location_id: A, op: 'create', after: { venue_item_id: `msm-e00000000000_${sfx(A)}`, active: true } },
    { target: 'product_site', entity_id: pid, location_id: B, op: 'create', after: { venue_item_id: `msm-e00000000000_${sfx(B)}`, active: true } },
  ];
  const a = plan(central, ch, A, v[A]);
  const newCat = `msmc-${catId.replace(/-/g, '').slice(0, 12)}_${sfx(A)}`;
  assert.deepEqual(a.writes.categories.insert.map((c) => c.id), [newCat]);
  assert.equal(a.writes.categories.insert[0].menu_id, 'menu-a');
  assert.deepEqual(a.writes.links.insert, [{ menu_id: 'menu-a', category_id: newCat, sort_order: 5 }]);
  const ins = a.writes.items.insert[0];
  assert.equal(ins.id, `msm-e00000000000_${sfx(A)}`);
  assert.equal(ins.cat, newCat);
  assert.equal(ins.tax_rate_id, 'tr-a');
  assert.equal(ins.scope, 'local');
  assert.equal(ins.org_id, ORG);
  assert.deepEqual(a.writes.routing, [{ centre_id: 'pc-k', category_id: newCat }], 'goes wherever Hot drinks goes');
  assert.deepEqual(a.writes.maps.categories, [{ category_id: catId, venue_category_id: newCat }]);
  assert.ok(checkSite(a).ok);
  const b = plan(central, ch, B, v[B]);
  assert.equal(b.writes.items.insert[0].tax_rate_id, 'tr-b', 'site B: mapped by percent (Standard Rate 20%)');
});

test('REVIEW BLOCKER 1: a new top level category nobody prints is blocking', () => {
  const { v, central } = setup();
  const catId = 'e0000000-0000-4000-8000-0000000000c2';
  const pid = 'e0000000-0000-4000-8000-0000000000a2';
  const ch = [
    { target: 'category', entity_id: catId, op: 'create', after: { label: 'Brunch' } },
    { target: 'product', entity_id: pid, op: 'create', after: { name: 'Eggs', category_id: catId, default_price: 6, tax_rate_name: 'VAT', tax_rate_percent: 20 } },
    { target: 'product_site', entity_id: pid, location_id: A, op: 'create', after: { venue_item_id: `msm-e00000000000_${sfx(A)}`, active: true } },
  ];
  const a = plan(central, ch, A, v[A]);
  const h = checkSite(a);
  assert.equal(h.ok, false);
  assert.match(h.blocking[0].words, /not sent to any printer or kitchen screen/);
  assert.equal(a.writes.routing.length, 0);
});

test('a new sub category inherits its parent\'s printer (the chain routes)', () => {
  const { v, central, K } = setup();
  const catId = 'e0000000-0000-4000-8000-0000000000c3';
  const pid = 'e0000000-0000-4000-8000-0000000000a3';
  const ch = [
    { target: 'category', entity_id: catId, op: 'create', after: { label: 'Seasonal', parent_id: K('Hot drinks').id } },
    { target: 'product', entity_id: pid, op: 'create', after: { name: 'Pumpkin latte', category_id: catId, default_price: 4, tax_rate_name: 'VAT', tax_rate_percent: 20 } },
    { target: 'product_site', entity_id: pid, location_id: A, op: 'create', after: { venue_item_id: `msm-e00000000000_${sfx(A)}`, active: true } },
  ];
  const a = plan(central, ch, A, v[A]);
  assert.equal(a.writes.categories.insert[0].parent_id, 'cat-hot');
  assert.ok(checkSite(a).ok);
  assert.equal(a.writes.routing.length, 0, 'no routing written: it inherits');
});

test('tax: by name and rate, then the only rate at that percent, else blocking and never a foreign id', () => {
  assert.equal(mapTaxRate({ tax_rate_name: 'VAT', tax_rate_percent: 20 }, [{ id: 'x', name: 'VAT', rate: 20 }, { id: 'y', name: 'Zero', rate: 0 }]).id, 'x');
  assert.equal(mapTaxRate({ tax_rate_name: 'VAT', tax_rate_percent: 20 }, [{ id: 'z', name: 'Standard', rate: 20 }]).id, 'z');
  assert.equal(mapTaxRate({ tax_rate_name: 'VAT', tax_rate_percent: 20 }, [{ id: 'p', name: 'A', rate: 20 }, { id: 'q', name: 'B', rate: 20 }]).ok, false);
  const { v, central, P } = setup();
  v[C].taxRates = [];
  const p = plan(central, [{ target: 'product', entity_id: P('Cola').id, op: 'update', after: { tax_rate_name: 'VAT', tax_rate_percent: 20 } }], C, v[C]);
  assert.ok(!p.lines.some((l) => l.column === 'tax_rate_id'));
  assert.match(checkSite(p).blocking[0].words, /no 20% VAT rate/);
});

test('removing a category takes it off the venue menu, never deletes it; blocked while it holds products', () => {
  const { v, central, K, P } = setup();
  const cold = K('Cold drinks');
  const p = plan(central, [{ target: 'category', entity_id: cold.id, op: 'remove', after: {} }], A, v[A]);
  assert.deepEqual(p.writes.categories.update, [{ id: 'cat-cold', set: { menu_id: null } }]);
  assert.deepEqual(p.writes.links.delete, [{ menu_id: 'menu-a', category_id: 'cat-cold' }]);
  assert.equal(p.applied.categories.some((c) => c.id === 'cat-cold'), true, 'the row is still there');
  assert.equal(checkSite(p).blocking[0].code, 'category_removed_with_products');
  const moved = [
    { target: 'product', entity_id: P('Cola').id, op: 'update', after: { category_id: K('Hot drinks').id } },
    { target: 'product', entity_id: P('Cookie').id, op: 'update', after: { category_id: K('Hot drinks').id } },
    { target: 'category', entity_id: cold.id, op: 'remove', after: {} },
  ];
  assert.ok(checkSite(plan(central, moved, A, v[A])).ok);
});

test('a category a venue emptied by hand is never refilled: a change elsewhere writes nothing there', () => {
  const { v, central, P } = setup();
  const p = plan(central, [{ target: 'product', entity_id: P('Tea').id, op: 'update', after: { default_price: 2.1 } }], B, v[B]);
  assert.ok(!p.lines.some((l) => l.column === 'cat'), 'site B kept "no category" for Tea');
  assert.deepEqual(p.writes.items.update, [{ id: `m-tea_${sfx(B)}`, set: {}, pricing: { base: 2.1 } }]);
});

test('REVIEW BLOCKER 2: a sub item\'s option price and name follow it', () => {
  const { v, central, P } = setup();
  const p = plan(central, [{ target: 'product', entity_id: P('Oat milk').id, op: 'update', after: { default_price: 0.5, name: 'Oat', menu_name: 'Oat' } }], A, v[A]);
  assert.deepEqual(p.writes.options, [{ item_id: 'm-oat', price: 0.5, name: 'Oat' }]);
  const g = p.applied.groups.find((x) => x.id === 'mgd-milk');
  assert.deepEqual(g.options[0], { id: 'opt-oat', name: 'Oat', price: 0.5, itemId: 'm-oat' });
});

test('a size whose parent is not at the site is blocking', () => {
  const { v, central, P } = setup();
  const lg = P('Large latte');
  const latte = P('Latte');
  central.productSites = central.productSites.filter((s) => !(s.product_id === latte.id && s.location_id === C));
  const ch = [{ target: 'product_site', entity_id: lg.id, location_id: C, op: 'create', after: { venue_item_id: `m-latte-l_${sfx(C)}`, active: true } }];
  const p = plan(central, ch, C, v[C]);
  assert.equal(checkSite(p).blocking.some((b) => b.code === 'size_parent_missing'), true);
});

test('ADD A SITE: venue menu, categories parents first, modifier groups remapped to the new sub items, products, links', () => {
  const { central } = setup();
  const D = 'dddddddd-0000-4000-8000-0000000d0004';
  const blank = { locationId: D, menus: [], categories: [], items: [], links: [], groups: [], taxRates: [{ id: 'tr-d', name: 'VAT', rate: 20, active: true }], printRouting: { centres: [{ id: 'pc-d' }], routing: {} } };
  const add = planAddSite(central, { locationId: D, prices: 'copy', copyFrom: B });
  assert.match(add.words, /will go on sale at the new site/);
  // the grid's "Send like" for the new site's top categories
  const ch = [...add.changes];
  for (const c of central.categories) ch.push({ target: 'category', entity_id: c.id, op: 'update', after: { route_like_id: c.id } });
  const after = applyChanges(central, ch).central;
  const p = planSite({ central: after, touched: touchedFromChanges(ch), locationId: D, orgId: ORG, venue: blank });
  assert.equal(p.writes.menus.insert.length, 1);
  assert.equal(p.writes.maps.menu_site.venue_menu_id, p.writes.menus.insert[0].id);
  assert.ok(p.writes.items.insert.length >= 5);
  const g = p.writes.groups.insert[0];
  const oat = p.writes.items.insert.find((i) => i.name === 'Oat milk');
  assert.equal(g.options[0].itemId, oat.id, 'the option points at the NEW site\'s sub item');
  const latte = p.writes.items.insert.find((i) => i.name === 'Latte');
  assert.deepEqual(latte.assigned_modifier_groups, [{ groupId: g.id }]);
  assert.equal(latte.pricing.base, 3.2, 'copied from site B (its price follows the default there)');
  const large = p.writes.items.insert.find((i) => i.name === 'Large latte');
  assert.equal(large.parent_id, latte.id);
  assert.equal(large.pricing.base, 3.7, 'site B\'s own price copied as an override');
  assert.ok(p.writes.links.insert.length >= 2);
  // the new site has no printers routed: every new category is blocking until sent like another
  assert.equal(checkSite(p).ok, false);
});

test('routing rule: nearest ticked category wins, Not here below it is respected', () => {
  const row = { centres: [{ id: 'k' }, { id: 'b' }], routing: { k: { assignedCategories: ['top'] }, b: { assignedCategories: ['top'], excludedCategories: ['mid'] } } };
  const parentOf = new Map([['leaf', 'mid'], ['mid', 'top'], ['top', null]]);
  assert.deepEqual(centresFor('leaf', row, parentOf), ['k']);
  assert.deepEqual(centresFor('nowhere', row, parentOf), []);
});

test('the words: counts and one line', () => {
  assert.equal(countsWords({ prices: 12, newProducts: 3 }), '12 prices, 3 new products');
  assert.equal(lineWords({ table: 'items', id: 'x', column: 'pricing.base', before: 2.8, after: 2.95, productId: 'p' }, { p: 'Latte' }), 'Latte: 2.80 to 2.95');
});

test('two central ids sharing their first 12 characters never collide at a venue: the long id is used', () => {
  const { v, central, K } = setup();
  const c1 = 'e0000000-0000-4000-8000-0000000000c1', c2 = 'e0000000-0000-4000-8000-0000000000c2';
  const p1 = 'e0000000-0000-4000-8000-0000000000a1', p2 = 'e0000000-0000-4000-8000-0000000000a2';
  const ch = [
    { target: 'category', entity_id: c1, op: 'create', after: { label: 'One', route_like_id: K('Hot drinks').id } },
    { target: 'category', entity_id: c2, op: 'create', after: { label: 'Two', route_like_id: K('Hot drinks').id } },
    { target: 'product', entity_id: p1, op: 'create', after: { name: 'P1', category_id: c1, default_price: 1, tax_rate_name: 'VAT', tax_rate_percent: 20 } },
    { target: 'product', entity_id: p2, op: 'create', after: { name: 'P2', category_id: c2, default_price: 1, tax_rate_name: 'VAT', tax_rate_percent: 20 } },
    { target: 'product_site', entity_id: p1, location_id: A, op: 'create', after: { venue_item_id: 'new-p1_x', active: true } },
    { target: 'product_site', entity_id: p2, location_id: A, op: 'create', after: { venue_item_id: 'new-p2_x', active: true } },
  ];
  const a = plan(central, ch, A, v[A]);
  const ids = a.writes.categories.insert.map((c) => c.id);
  assert.equal(new Set(ids).size, 2);
  assert.ok(ids.includes(`msmc-e00000000000_${sfx(A)}`));
  assert.ok(ids.includes(`msmc-${c2.replace(/-/g, '')}_${sfx(A)}`));
  assert.ok(checkSite(a).ok);
});
