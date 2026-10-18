// Multi site menu, 17 Oct 2026 verification fixes: what an edit stages and what publish would write.
// Each test here failed on the branch before the fix (a1710ba2) and passes after it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { proposeImport, buildCentral } from '../../../supabase/functions/_shared/msmImport.js';
import { planSite, touchedFromChanges, lineWords, sameText } from '../../../supabase/functions/_shared/msmPlan.js';
import { applyChanges, previewSet, mergeStaged, changeKey, siteDrift, bringOptionIn } from '../../../supabase/functions/_shared/msmDiff.js';
import { checkSite, checkCentral } from '../../../supabase/functions/_shared/msmHealth.js';
import { planAddSite } from '../../../supabase/functions/_shared/msmSites.js';
import { newOptionId } from '../../../supabase/functions/_shared/msmModel.js';
import { siteActiveChange, activeMany, newProductChanges, productUpdate, renameFields, copyPricesMany, priceMany, sitePriceChange } from './msmEdit.js';
import { newOptionChanges } from './msmGroupEdit.js';
import { summarise } from './msmSummary.js';
import { statusBar } from './msmStatus.js';
import { mapMenuItemRow, assembleTaxProfiles } from '../rowMapping.js';
import { buildLocalTaxCtx, computeOrderTaxUnified } from '../taxCompute.js';
import { venues, importSites, idGen, A, B, C, ORG, sfx } from './msmFixture.js';
import { groupVenues, groupSites, S, ZERO, PROFILE_A } from './msmGroupFixture.js';

function fold(rows, changes) {
  const by = new Map(rows.map((r) => [changeKey(r), r]));
  for (const c of changes) {
    const m = mergeStaged(by.get(changeKey(c)) || null, c);
    if (m.action === 'insert' || m.action === 'update') by.set(changeKey(c), m.row);
    else if (m.action === 'delete') by.delete(changeKey(c));
  }
  return [...by.values()];
}
const planAt = (central, changes, loc, venue) => planSite({ central: applyChanges(central, changes).central, touched: touchedFromChanges(changes), locationId: loc, orgId: ORG, venue });

function build(v, sites) {
  const built = buildCentral(proposeImport(sites, { idGen: idGen() }), sites, {}, { idGen: idGen('g') });
  assert.ok(built.check.ok, JSON.stringify(built.check.problems));
  const central = built.central;
  central.menu = { id: '99999999-0000-4000-8000-000000000001', name: 'Group menu', description: '', use_name_everywhere: false, refreshed_at: '2026-10-17' };
  return central;
}

// Pie is sold at Site C only, with a required "Pie size" group (Then ask "Pie sauce") and an
// optional "Pie extras" group that only C has.
function pieAtC() {
  const v = groupVenues();
  const c = v[C];
  c.groups.push(
    { id: 'mgd-piesize', location_id: C, name: 'Pie size', min: 1, max: 1, selection_type: 'single', sort_order: 5, options: [{ id: 'opt-small', name: 'Small', price: 0, subGroupId: 'mgd-sauce' }, { id: 'opt-big', name: 'Big', price: 1 }] },
    { id: 'mgd-sauce', location_id: C, name: 'Pie sauce', min: 1, max: 1, selection_type: 'single', sort_order: 6, options: [{ id: 'opt-gravy', name: 'Gravy', price: 0 }] },
    { id: 'mgd-pieext', location_id: C, name: 'Pie extras', min: 0, max: 3, selection_type: 'multiple', sort_order: 7, options: [{ id: 'opt-peas', name: 'Peas', price: 0.5 }] },
  );
  c.items.find((i) => i.id === 'l-pie-c').assigned_modifier_groups = [{ groupId: 'mgd-piesize' }, { groupId: 'mgd-pieext' }];
  const sites = groupSites(v);
  const central = build(v, sites);
  const specials = central.categories.find((c) => c.label === 'Specials');
  specials.route_like_id = central.categories.find((c) => c.label === 'Hot drinks').id;   // prints like Hot drinks at a new site
  return { v, central };
}

test('item 11 / finding: a product turned on where its option groups are not yet takes their options with it (Then ask too)', () => {
  const { v, central } = pieAtC();
  const pie = central.products.find((p) => p.name === 'Pie');
  const ctx = { live: central, eff: central };
  for (const r of [siteActiveChange(ctx, pie.id, A, true), activeMany(ctx, [pie.id], [A], true)]) {
    const changes = r.changes || [r.change, ...(r.extra || [])];
    const optionRows = changes.filter((c) => c.target === 'modifier_option_site' && c.location_id === A);
    assert.equal(optionRows.length, 4, 'Small, Big, Gravy (Then ask) and Peas get a row at A, all on');
    assert.ok(optionRows.every((c) => c.op === 'create' && c.after.active === true));
    const plan = planAt(central, changes, A, v[A]);
    const health = checkSite(plan);
    assert.ok(health.ok, JSON.stringify(health.blocking));
    assert.ok(!health.warnings.some((w) => w.code === 'group_empty'), JSON.stringify(health.warnings));
    const byName = (n) => plan.writes.groups.insert.find((g) => g.name === n);
    assert.deepEqual(byName('Pie size').options.map((o) => o.name), ['Small', 'Big']);
    assert.deepEqual(byName('Pie sauce').options.map((o) => o.name), ['Gravy']);
    assert.deepEqual(byName('Pie extras').options.map((o) => o.name), ['Peas']);
  }
  // A site where the group already is keeps its own rows: an option off there stays off.
  const latte = central.products.find((p) => p.name === 'Latte');
  const off = siteActiveChange(ctx, latte.id, C, false);
  assert.ok(!(off.extra || []).some((c) => c.target === 'modifier_option_site'));
});

test('sizes follow a product that has sizes even when it is not typed "variants" (a size made in the sheet)', () => {
  const live = {
    sites: [{ location_id: 'L1' }, { location_id: 'L2' }],
    products: [
      { id: 'berry', name: 'Berry smoothie', type: 'simple', category_id: 'c', default_price: 4.4 },
      { id: 'large', name: 'Large', type: 'simple', parent_product_id: 'berry', category_id: 'c', default_price: 5.2 },
    ],
    productSites: [
      { product_id: 'berry', location_id: 'L1', venue_item_id: 'b1', active: true },
      { product_id: 'large', location_id: 'L1', venue_item_id: 'l1', active: true },
    ],
  };
  const ctx = { live, eff: live };
  const on = siteActiveChange(ctx, 'berry', 'L2', true);
  assert.deepEqual([on.change, ...on.extra].map((c) => `${c.entity_id}@${c.location_id}:${c.op}`), ['berry@L2:create', 'large@L2:create'], '+ Sell here brings its size');
  const off = siteActiveChange(ctx, 'berry', 'L1', false);
  assert.deepEqual([off.change, ...off.extra].map((c) => `${c.entity_id}:${c.after.active}`), ['berry:false', 'large:false'], 'off takes its size too');
});

test('on, then off again before publishing, where it never was: nothing is left in the draft or the summary', () => {
  const v = venues();
  const sites = importSites(v);
  const central = build(v, sites);
  const pie = central.products.find((p) => p.name === 'Pie');
  pie.site_only_location_id = C;                       // the round 1 mark
  let rows = fold([], [siteActiveChange({ live: central, eff: central }, pie.id, A, true)].flatMap((r) => [r.change, ...(r.extra || [])]));
  assert.equal(rows.length, 2, 'on at A: the site row and the mark cleared');
  const eff = applyChanges(central, rows).central;
  const off = siteActiveChange({ live: central, eff }, pie.id, A, false);
  rows = fold(rows, [off.change, ...(off.extra || [])]);
  assert.deepEqual(rows, [], 'off again: the draft is empty');
  assert.deepEqual(summarise(rows, central), []);
  assert.match(statusBar({ working: { status: 'draft', title: 'x' }, rows }).words, /Empty so far|empty/i);
  // A new product (not live yet) switched off at a site keeps its row: off is a real choice there.
  const created = newProductChanges({ live: central, eff: central }, { id: 'aaaaaaaa-0000-4000-8000-0000000000aa', fields: { name: 'Babka', category_id: pie.category_id, default_price: 3, tax_rate_name: pie.tax_rate_name, tax_rate_percent: pie.tax_rate_percent }, sites: [{ location_id: A, active: true }] });
  const eff2 = applyChanges(central, created.changes).central;
  const off2 = siteActiveChange({ live: central, eff: eff2 }, 'aaaaaaaa-0000-4000-8000-0000000000aa', A, false);
  assert.ok(!off2.change.dropCreate);
});

test('a new product goes last in its category, a new size last among its product\'s sizes', () => {
  const v = venues();
  const central = build(v, importSites(v));
  const hot = central.products.find((p) => p.name === 'Latte').category_id;
  central.products.filter((p) => p.category_id === hot && !p.parent_product_id).forEach((p, i) => { p.sort_order = i + 1; });
  const max = Math.max(...central.products.filter((p) => p.category_id === hot && !p.parent_product_id).map((p) => p.sort_order));
  const latte = central.products.find((p) => p.name === 'Latte');
  const r = newProductChanges({ live: central, eff: central }, { id: 'aaaaaaaa-0000-4000-8000-0000000000ab', fields: { name: 'Flat white', category_id: hot, default_price: 3, tax_rate_name: latte.tax_rate_name, tax_rate_percent: latte.tax_rate_percent }, sites: [{ location_id: A, active: true }] });
  assert.equal(r.changes[0].after.sort_order, max + 1);
  const plan = planAt(central, r.changes, A, v[A]);
  assert.equal(plan.writes.items.insert[0].sort_order, max + 1, 'the till button lands at the end');
});

test('renaming in the sheet renames the till button, the receipt and the kitchen ticket too', () => {
  const v = venues();
  const central = build(v, importSites(v));
  const cola = central.products.find((p) => p.name === 'Cola');
  const form = { name: cola.name, menu_name: cola.menu_name ?? cola.name, receipt_name: cola.receipt_name ?? cola.name, kitchen_name: cola.kitchen_name ?? cola.name };
  const next = renameFields(form, 'Cola Zero');
  const r = productUpdate({ live: central, eff: central }, cola.id, next);
  assert.deepEqual(Object.keys(r.change.after).sort(), ['kitchen_name', 'menu_name', 'name', 'receipt_name']);
  const plan = planAt(central, [r.change], A, v[A]);
  const row = plan.applied.items.find((i) => i.id === 'm-cola');
  const till = mapMenuItemRow(row);
  assert.equal(till.menuName, 'Cola Zero');
  assert.equal(till.receiptName, 'Cola Zero');
  assert.equal(till.kitchenName, 'Cola Zero');
  // A receipt name set on purpose stays.
  assert.equal(renameFields({ ...form, receipt_name: 'COLA 330' }, 'Cola Zero').receipt_name, 'COLA 330');
  // Spaces only never stage a change.
  assert.equal(productUpdate({ live: central, eff: central }, cola.id, { receipt_name: `${form.receipt_name} ` }).change, null);
});

test('copy prices and one price say why nothing changed when the products are not sold at those sites', () => {
  const v = venues();
  const central = build(v, importSites(v));
  const pie = central.products.find((p) => p.name === 'Pie');
  const ctx = { live: central, eff: central };
  assert.match(copyPricesMany(ctx, [pie.id], C, [A, B]).words.join(' '), /not sold at those sites/);
  assert.match(copyPricesMany(ctx, [pie.id], A, [B]).words.join(' '), /not sold at the site you copy from/);
  assert.match(priceMany(ctx, [pie.id], [A], 5).words.join(' '), /not sold at those sites/);
});

test('turn on at a site whose own copy (same id) sits in another of its menus: blocked in words, nothing taken over', () => {
  const v = venues();
  const central = build(v, importSites(v));
  const cola = central.products.find((p) => p.name === 'Cola');
  // Site B drops Cola from the group menu, and keeps its own copy in a second Delivery menu.
  const ps = central.productSites.find((r) => r.product_id === cola.id && r.location_id === B);
  central.productSites = central.productSites.filter((r) => r !== ps);
  const b = v[B];
  b.menus.push({ id: 'menu-del', location_id: B, name: 'Delivery', is_default: false, is_active: true, sort_order: 1 });
  b.categories.push({ id: 'cat-del', location_id: B, menu_id: 'menu-del', parent_id: null, label: 'Delivery', sort_order: 1 });
  b.links.push({ menu_id: 'menu-del', category_id: 'cat-del', sort_order: 1 });
  const copy = b.items.find((i) => i.id === ps.venue_item_id);
  copy.cat = 'cat-del';
  copy.pricing = { base: 2.9 };
  const r = siteActiveChange({ live: central, eff: central }, cola.id, B, true);
  assert.equal(r.change.after.venue_item_id, copy.id, 'the new id is the copy\'s id');
  const plan = planAt(central, [r.change], B, v[B]);
  const h = checkSite(plan);
  assert.ok(h.blocking.some((x) => x.code === 'own_copy_other_menu'), JSON.stringify(h.blocking));
  assert.equal(plan.lines.length, 0, 'the Delivery menu\'s price is never changed');
  // A category taken off the menu (no link, no menu id) blocks the same way.
  copy.cat = S('cat-cold', B);
  b.links = b.links.filter((l) => l.category_id !== S('cat-cold', B));
  b.categories.find((cc) => cc.id === S('cat-cold', B)).menu_id = null;
  const plan2 = planAt(central, [r.change], B, v[B]);
  assert.ok(checkSite(plan2).blocking.some((x) => x.code === 'own_copy_other_menu'));
});

test('Add a site where the site already sells copies of the group products: blocked, never taken over', () => {
  const v = venues();
  const sites = importSites(v).filter((s) => s.location_id !== C);
  const central = build(v, sites);
  const add = planAddSite(central, { locationId: C, venueMenuId: `menu-c_${sfx(C)}` });
  const plan = planAt(central, add.changes, C, v[C]);
  const h = checkSite(plan);
  assert.ok(h.blocking.some((x) => x.code === 'site_has_product'), JSON.stringify(h.blocking));
  assert.ok(!plan.lines.some((l) => l.column.startsWith('pricing.') || l.column === 'archived'), 'no price replaced, nothing turned back on');
  // A truly new site (no menu, no products) is not blocked.
  const fresh = { locationId: 'dddddddd-0000-4000-8000-0000000d0004', menus: [], categories: [], items: [], links: [], groups: [], taxRates: [{ id: 'tr-d', location_id: 'dddddddd-0000-4000-8000-0000000d0004', name: 'VAT', rate: 20, active: true }], printRouting: null, taxProfiles: [], taxProfileLines: [] };
  const add2 = planAddSite(central, { locationId: fresh.locationId });
  const plan3 = planAt(central, add2.changes, fresh.locationId, fresh);
  assert.ok(!checkSite(plan3).blocking.some((x) => x.code === 'site_has_product'));
});

test('a new VAT rate over a generated copy profile clears the copy, so the till charges the new rate; a real profile blocks', () => {
  const v = groupVenues();
  const central = build(v, groupSites(v));
  const cola = central.products.find((p) => p.name === 'Cola');
  const ch = { target: 'product', entity_id: cola.id, location_id: null, op: 'update', after: { tax_rate_name: 'Zero Rate', tax_rate_percent: 0 }, before: { tax_rate_name: cola.tax_rate_name, tax_rate_percent: cola.tax_rate_percent } };
  const plan = planAt(central, [ch], A, v[A]);
  assert.ok(checkSite(plan).ok, JSON.stringify(checkSite(plan).blocking));
  const row = plan.applied.items.find((i) => i.id === 'm-cola');
  assert.equal(row.tax_rate_id, ZERO.A);
  assert.equal(row.tax_profile_id, null, 'the old copy of 20% is cleared');
  const ctx = buildLocalTaxCtx({ taxProfiles: assembleTaxProfiles(v[A].taxProfiles, v[A].taxProfileLines), menuItems: plan.applied.items, taxRates: v[A].taxRates });
  const r = computeOrderTaxUnified([{ id: 'm-cola', itemId: 'm-cola', price: 10, qty: 1, taxRateId: row.tax_rate_id, taxProfileId: row.tax_profile_id }], ctx, 'dine-in');
  assert.equal(r.totalTax, 0, 'the till charges 0% now (it charged 20% through the old copy)');
  const before = computeOrderTaxUnified([{ id: 'm-cola', itemId: 'm-cola', price: 10, qty: 1, taxRateId: row.tax_rate_id, taxProfileId: PROFILE_A }], buildLocalTaxCtx({ taxProfiles: assembleTaxProfiles(v[A].taxProfiles, v[A].taxProfileLines), menuItems: v[A].items.map((i) => (i.id === 'm-cola' ? { ...i, tax_rate_id: ZERO.A } : i)), taxRates: v[A].taxRates }), 'dine-in');
  assert.ok(before.totalTax > 0, 'with the copy left on, the till kept charging the old 20%');
  // A real (edited) profile: blocked in words.
  v[A].taxProfileLines[0].rate = 17.5;
  const plan2 = planAt(central, [ch], A, v[A]);
  assert.ok(checkSite(plan2).blocking.some((x) => x.code === 'real_tax_profile'));
});

test('the preview never shows a raw id, web address or true/false', () => {
  const v = groupVenues();
  const central = build(v, groupSites(v));
  const P = (n) => central.products.find((p) => p.name === n);
  const cat = (l) => central.categories.find((c) => c.label === l);
  const changes = [
    { target: 'product', entity_id: P('Latte').id, location_id: null, op: 'update', after: { category_id: cat('Cold drinks').id }, before: { category_id: cat('Hot drinks').id } },
    { target: 'product', entity_id: P('Cola').id, location_id: null, op: 'update', after: { image: 'https://example.invalid/storage/v1/object/public/product-images/aaaa/items/x.jpg' }, before: { image: null } },
    { target: 'product', entity_id: P('Mocha').id, location_id: null, op: 'update', after: { tax_rate_name: 'Zero Rate', tax_rate_percent: 0 }, before: { tax_rate_name: P('Mocha').tax_rate_name, tax_rate_percent: P('Mocha').tax_rate_percent } },
    { target: 'product', entity_id: P('Tea').id, location_id: null, op: 'update', after: { sold_alone: false, allergens: ['milk'] }, before: { sold_alone: true, allergens: [] } },
    { target: 'product', entity_id: P('Mocha').id, location_id: null, op: 'update', after: { parent_product_id: P('Latte').id }, before: { parent_product_id: null } },
    { target: 'category', entity_id: cat('Hot drinks').id, location_id: null, op: 'update', after: { label: 'Hot', color: '#000000' }, before: { label: 'Hot drinks', color: '#3b82f6' } },
  ];
  const pv = previewSet(central, changes, v, { orgId: ORG });
  const all = pv.sites.flatMap((s) => (s.lines || []).map((l) => l.words));
  assert.ok(all.length > 5);
  for (const w of all) {
    assert.doesNotMatch(w, /https?:\/\/|_[0-9a-f]{8}\b|[0-9a-f]{8}-[0-9a-f]{4}-|\b(cat|tax rate id|parent id|sold alone|true|false)\b|changed to changed|^A product: (label|color)/, w);
  }
  const atB = pv.sites.find((s) => s.location_id === B);
  const wordsB = atB.lines.map((l) => l.words);
  assert.ok(wordsB.includes('Latte: moves to Cold drinks'), wordsB.join(' | '));
  assert.ok(wordsB.some((w) => /^Mocha: VAT rate becomes Zero Rate \(0%\)$/.test(w)), wordsB.join(' | '));
  assert.ok(wordsB.includes('Category Hot drinks: renamed to "Hot"'), wordsB.join(' | '));
  assert.ok(wordsB.includes('Category Hot: colour changes'), wordsB.join(' | '));
  assert.ok(wordsB.includes('Mocha: now a size of Latte'), wordsB.join(' | '));
  assert.notEqual(atB.words, 'Nothing changes here');
  assert.match(atB.words, /category change/);
  assert.match(atB.words, /VAT change/);
});

test('a product new at a site: the preview gives its price and its product, and never "price goes up"', () => {
  const v = venues();
  const central = build(v, importSites(v));
  const pie = central.products.find((p) => p.name === 'Pie');
  const on = siteActiveChange({ live: central, eff: central }, pie.id, A, true);
  let rows = fold([], [on.change, ...(on.extra || [])]);
  const eff = applyChanges(central, rows).central;
  const pc = sitePriceChange({ live: central, eff }, pie.id, A, 5.25);
  rows = fold(rows, [pc.change]);
  const pv = previewSet(central, rows, v, { orgId: ORG, siteNames: { [A]: 'Site A' } });
  const atA = pv.sites.find((s) => s.location_id === A);
  assert.ok(atA.lines.some((l) => l.words === 'Pie: new here at 5.25'), atA.lines.map((l) => l.words).join(' | '));
  const sum = summarise(rows, central, { siteNames: { [A]: 'Site A' } });
  assert.ok(!sum.some((s) => /price goes (up|down)/.test(s)), sum.join(' | '));
  assert.ok(sum.includes('Pie at 5.25 goes on sale at Site A.'), sum.join(' | '));
});

test('one option added to a group never reorders a site that orders its options its own way; bringing an option in writes nothing there', () => {
  const v = groupVenues();
  // Site B shows Coconut before Oat.
  v[B].groups[0].options.reverse();
  const central = build(v, groupSites(v));
  const milk = central.groups.find((g) => g.name === 'Milk');
  const add = newOptionChanges({ eff: central }, { id: 'bbbbbbbb-0000-4000-8000-0000000000aa', groupId: milk.id, name: 'Almond milk', price: 0.45 });
  const plan = planAt(central, add, B, v[B]);
  assert.ok(!plan.writes.groups.update.some((u) => u.options.some((o) => o.op === 'order')), JSON.stringify(plan.writes.groups.update));
  assert.equal(plan.lines.filter((l) => l.column === '(option added)').length, 1);
  // An option the site added in the middle of its list, brought into the group: nothing changes there.
  const vg = v[B].groups[0];
  vg.options.splice(1, 0, { id: 'opt-own-soya', name: 'Soya', price: 0.3 });
  const drift = siteDrift(central, B, v[B]).find((d) => d.kind === 'unknown_option');
  assert.ok(drift);
  const brought = bringOptionIn(central, B, drift, 'bbbbbbbb-0000-4000-8000-0000000000ab');
  const plan2 = planAt(central, brought, B, v[B]);
  assert.equal(plan2.lines.length, 0, JSON.stringify(plan2.lines));
  assert.equal(newOptionId('x').startsWith('opt-msm-'), true);
});

test('health: an own product of the same name; a category off the site\'s menu; a product brought back into a removed category', () => {
  const v = venues();
  const central = build(v, importSites(v));
  const pie = central.products.find((p) => p.name === 'Pie');
  // A has its own Pie (not in the group menu) in another category.
  v[A].items.push({ ...v[A].items.find((i) => i.id === 'm-cola'), id: 'own-pie-a', name: 'Pie', menu_name: 'Pie', receipt_name: 'Pie', kitchen_name: 'Pie', cat: 'cat-hot', master_id: null });
  const r = siteActiveChange({ live: central, eff: central }, pie.id, A, true);
  const h = checkSite(planAt(central, [r.change, ...(r.extra || [])], A, v[A]), { siteName: 'Site A' });
  assert.ok(h.warnings.some((w) => w.code === 'own_same_name' && /already sells its own "Pie"/.test(w.words)), JSON.stringify(h.warnings));
  // Category off the menu at the site (taken off by hand): the product written there would not show.
  const v2 = venues();
  const c2 = build(v2, importSites(v2));
  const cola = c2.products.find((p) => p.name === 'Cola');
  v2[B].links = v2[B].links.filter((l) => l.category_id !== S('cat-cold', B));
  v2[B].categories.find((cc) => cc.id === S('cat-cold', B)).menu_id = null;
  const ch = { target: 'product_site', entity_id: cola.id, location_id: B, op: 'update', after: { price: 2.6 }, before: { price: null } };
  const h2 = checkSite(planAt(c2, [ch], B, v2[B]), { siteName: 'Site B' });
  assert.ok(h2.warnings.some((w) => w.code === 'category_off_menu'), JSON.stringify(h2.warnings));
  // Brought back into a category that was taken off the group menu.
  const gone = c2.categories.find((cc) => cc.label === 'Cold drinks');
  gone.archived = true;
  cola.archived = true;
  const back = [{ target: 'product', entity_id: cola.id, location_id: null, op: 'update', after: { archived: false }, before: { archived: true } }];
  const cc = checkCentral(applyChanges(c2, back).central, touchedFromChanges(back));
  assert.ok(cc.blocking.some((b) => b.code === 'category_removed'), JSON.stringify(cc.blocking));
});

test('the import: a product with sizes and no base price is told to Leave out (Menu Manager has no box for it)', () => {
  const v = venues();
  const row = v[B].items.find((i) => i.id === `m-latte_${sfx(B)}`);
  row.pricing = { dineIn: null };
  const sites = importSites(v);
  const built = buildCentral(proposeImport(sites, { idGen: idGen() }), sites, {}, { idGen: idGen('g') });
  const p = built.check.problems.find((x) => /has no base price/.test(x.words));
  assert.match(p.words, /product with sizes has no base price box in Menu Manager\. Press Leave out on it in step 2/);
  const v2 = venues();
  v2[B].items.find((i) => i.id === `m-cola_${sfx(B)}`).pricing = { dineIn: null };
  const s2 = importSites(v2);
  const b2 = buildCentral(proposeImport(s2, { idGen: idGen() }), s2, {}, { idGen: idGen('g') });
  assert.match(b2.check.problems.find((x) => /has no base price/.test(x.words)).words, /Press Leave out on it in step 2, or open it in that site's Menu Manager/);
});

test('a name saved with its spaces trimmed is the same name: no drift and no rewrite', () => {
  const v = venues();
  v[A].items.find((i) => i.id === 'm-cola').name = 'Cola ';
  v[B].items.find((i) => i.id === `m-cola_${sfx(B)}`).name = 'Cola ';
  v[C].items.find((i) => i.id === `m-cola_${sfx(C)}`).name = 'Cola ';
  const central = build(v, importSites(v));
  const cola = central.products.find((p) => p.menu_name === 'Cola' || p.name.trim() === 'Cola');
  cola.name = cola.name.trim();                    // what msm_import_commit saves
  assert.equal(sameText('Cola ', 'Cola'), true);
  assert.equal(siteDrift(central, A, v[A]).filter((d) => d.column === 'name').length, 0);
  const touch = [{ target: 'product', entity_id: cola.id, location_id: null, op: 'update', after: { name: cola.name, description: 'Fizzy' }, before: { name: cola.name, description: '' } }];
  const plan = planAt(central, touch, B, v[B]);
  assert.ok(!plan.lines.some((l) => l.column === 'name'), JSON.stringify(plan.lines));
});

test('a site whose add site publish did not finish is told to Retry that publish, not to add it again', () => {
  const v = venues();
  const central = build(v, importSites(v));
  central.sites.find((s) => s.location_id === B).venue_menu_id = null;
  const cola = central.products.find((p) => p.name === 'Cola');
  const plan = planAt(central, [{ target: 'product', entity_id: cola.id, location_id: null, op: 'update', after: { default_price: 2.5 }, before: { default_price: 2.2 } }], B, v[B]);
  const words = plan.problems.map((p) => p.words).join(' ');
  assert.match(words, /press Retry on it in Publish history/);
  assert.doesNotMatch(words, /Add the site again/);
});

test('a group takeaway price names the sites with their own Standard price that follow it too', () => {
  const v = venues();
  const central = build(v, importSites(v));
  const cola = central.products.find((p) => p.name === 'Cola');
  const ch = { target: 'product', entity_id: cola.id, location_id: null, op: 'update', after: { default_channels: { takeaway: 2 } }, before: { default_channels: null } };
  const own = central.productSites.find((r) => r.product_id === cola.id && r.price != null);
  assert.ok(own, 'Cola has a site with its own price (2.40 at C)');
  const sum = summarise([ch], central, { siteNames: { [C]: 'Site C', [A]: 'Site A', [B]: 'Site B' } });
  assert.ok(sum.some((s) => /Takeaway becomes 2\.00 at Site C too, where the Standard price is 2\.40/.test(s)), sum.join(' | '));
});

