// src/lib/reportSiteMenu.test.js: each site's own menu, tax and stations for the reports that
// read them (step 4 of the multi site reports, 5 Oct 2026).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSiteMenu, itemFamily, categoryFamily, lookupModItem, canonicalItemName,
  siteItemRows, siteCategoryRows, siteModifierRows, joinSiteRows,
  siteTrendRows, joinTrendRows, TREND_STANDALONE,
  siteEngineeringItems, classifyItems, median,
  siteCheckTax, siteTaxAnalysis, rateFamilyKey, taxSourceNote,
  siteStationLabel, stationKey, siteKitchenStats, joinKitchenStats, percentile,
} from './reportSiteMenu.js';
import { recordedCheckTax } from './taxCompute.js';

// Two Coffee Boy sites: each holds its OWN copy of the shared products and categories, with
// the same master_id (db.js: "<masterId>_<locShort>"). Leeds also has a local only product.
const leeds = buildSiteMenu({
  id: 'leeds',
  items: [
    { id: 'm-1_leeds', name: 'Flat White', menu_name: 'Flat White', cat: 'cat-1_leeds', master_id: 'm-1', scope: 'shared' },
    { id: 'm-2_leeds', name: 'Latte', cat: 'cat-1_leeds', master_id: 'm-2', scope: 'shared' },
    { id: 'm-3_leeds', name: 'Large', menu_name: 'Large', parent_id: 'm-2_leeds', cat: 'cat-1_leeds', master_id: 'm-3' },
    { id: 'm-9', name: 'Leeds Bun', cat: 'cat-9', scope: 'local' },
    { id: 'm-7_leeds', name: 'Bueno Donut', cat: 'cat-2_leeds', master_id: 'm-7' },
  ],
  categories: [
    { id: 'cat-1_leeds', label: 'Hot Drinks', master_id: 'cat-1' },
    { id: 'cat-2_leeds', label: 'Bakery', master_id: 'cat-2' },
    { id: 'cat-9', label: 'Specials' },
  ],
  taxRates: [{ id: 'r-leeds-std', name: 'Standard Rate', label: 'Standard Rate', rate: 0.2, type: 'inclusive', active: true, isDefault: true, appliesTo: ['all'] }],
});
const preston = buildSiteMenu({
  id: 'preston',
  items: [
    { id: 'm-1_preston', name: 'Flat White', cat: 'cat-1_preston', master_id: 'm-1', scope: 'shared' },
    { id: 'm-2_preston', name: 'Latte', cat: 'cat-1_preston', master_id: 'm-2', scope: 'shared' },
    { id: 'm-8', name: 'Leeds Bun', cat: 'cat-8', scope: 'local' },   // a LOCAL product with the same name
    { id: 'm-7_preston', name: 'Bueno Donut', cat: 'cat-2_preston', master_id: 'm-7' },
  ],
  categories: [
    { id: 'cat-1_preston', label: 'Hot Drinks', master_id: 'cat-1' },
    { id: 'cat-2_preston', label: 'Bakery', master_id: 'cat-2' },
    { id: 'cat-8', label: 'Specials' },
  ],
  // Preston is on a REDUCED rate by default: another site's VAT must come out at 5%, never Leeds' 20%
  taxRates: [{ id: 'r-preston-red', name: 'Reduced Rate', label: 'Reduced Rate', rate: 0.05, type: 'inclusive', active: true, isDefault: true, appliesTo: ['all'] }],
});

const T0 = Date.parse('2026-10-05T10:00:00Z');
const check = (over = {}) => ({ id: over.id || 'c1', status: 'closed', closedAt: T0, total: 10, orderType: 'dine-in', items: [], ...over });

// ── grouping ─────────────────────────────────────────────────────────────────

test('a shared product is one family across sites (master id); a local one is grouped by name', () => {
  const a = itemFamily({ itemId: 'm-1_leeds', name: 'Flat White' }, leeds);
  const b = itemFamily({ itemId: 'm-1_preston', name: 'Flat white' }, preston);
  assert.equal(a.key, 'master:m-1');
  assert.equal(b.key, a.key);
  assert.equal(a.name, 'Flat White');
  // two local products called Leeds Bun at two sites land together, by name
  assert.equal(itemFamily({ itemId: 'm-9', name: 'Leeds Bun' }, leeds).key, 'name:leeds bun');
  assert.equal(itemFamily({ itemId: 'm-8', name: 'Leeds Bun' }, preston).key, 'name:leeds bun');
  // a line whose product the site no longer has keeps the name on the line
  const gone = itemFamily({ itemId: 'm-404', name: 'Old Thing', cat: 'cat-x' }, leeds);
  assert.equal(gone.key, 'name:old thing');
  assert.equal(gone.name, 'Old Thing');
  assert.equal(gone.cat, 'cat-x');
  // no menu at all (the read failed): by name, and the line's own category id
  assert.equal(itemFamily({ itemId: 'm-1_leeds', name: 'Flat White', cat: 'cat-1_leeds' }, null).key, 'name:flat white');
});

test('a variant child is named with its parent, as the single site trend names it', () => {
  assert.equal(canonicalItemName(leeds.byItemId.get('m-3_leeds'), leeds), 'Latte — Large');
  assert.equal(canonicalItemName(leeds.byItemId.get('m-1_leeds'), leeds), 'Flat White');
});

test('a category id is named at ITS OWN site, then grouped by master id, else by label', () => {
  assert.deepEqual(categoryFamily('cat-1_leeds', leeds), { key: 'master:cat-1', label: 'Hot Drinks' });
  assert.deepEqual(categoryFamily('cat-1_preston', preston), { key: 'master:cat-1', label: 'Hot Drinks' });
  // the local Specials at each site join on their label
  assert.equal(categoryFamily('cat-9', leeds).key, 'name:specials');
  assert.equal(categoryFamily('cat-8', preston).key, 'name:specials');
  // Leeds' category id looked up at Preston is unknown there: the id, never Preston's category
  assert.deepEqual(categoryFamily('cat-1_leeds', preston), { key: 'id:cat-1_leeds', label: 'cat-1_leeds' });
  assert.deepEqual(categoryFamily(null, leeds), { key: '__uncat', label: 'Uncategorized' });
});

test('a modifier option is matched to its menu item by id, m- tail, name, then label', () => {
  assert.equal(lookupModItem({ id: 'm-7_leeds' }, leeds).id, 'm-7_leeds');
  assert.equal(lookupModItem({ id: 'opt-12-m-9' }, leeds).id, 'm-9');
  assert.equal(lookupModItem({ name: 'bueno donut' }, leeds).id, 'm-7_leeds');
  assert.equal(lookupModItem({ label: 'Bueno Donut ×3' }, leeds).id, 'm-7_leeds');
  assert.equal(lookupModItem({ name: 'Oat milk' }, leeds), null);
  assert.equal(lookupModItem({ id: 'm-7_leeds' }, null), null);
});

test('Product mix items: each site against its own menu, joined on the family', () => {
  const lRows = siteItemRows([check({ items: [
    { itemId: 'm-1_leeds', name: 'Flat White', cat: 'cat-1_leeds', qty: 2, price: 3.5 },
    { itemId: 'm-9', name: 'Leeds Bun', cat: 'cat-9', qty: 1, price: 2 },
  ] })], leeds, () => 'morning');
  const pRows = siteItemRows([check({ items: [
    { itemId: 'm-1_preston', name: 'Flat White', cat: 'cat-1_preston', qty: 3, price: 3.6 },
    { itemId: 'm-8', name: 'Leeds Bun', cat: 'cat-8', qty: 4, price: 2 },
    { itemId: 'm-1_preston', name: 'Flat White', cat: 'cat-1_preston', qty: 1, price: 3.6, voided: true },
  ] })], preston, () => 'lunch');
  assert.equal(lRows.totalRev, 9);
  assert.equal(pRows.totalRev, 18.8);
  assert.equal(lRows.rows[0].catLabel, 'Hot Drinks');
  assert.equal(pRows.rows.find((r) => r.key === 'master:m-1').morning, 0);
  assert.equal(pRows.rows.find((r) => r.key === 'master:m-1').lunch, 3);
  const joined = joinSiteRows([{ siteId: 'leeds', rows: lRows.rows }, { siteId: 'preston', rows: pRows.rows }], ['qty', 'rev']);
  assert.deepEqual(joined.map((r) => [r.key, r.label, r.qty, +r.rev.toFixed(2)]), [
    ['master:m-1', 'Flat White', 5, 17.8],
    ['name:leeds bun', 'Leeds Bun', 5, 10],
  ]);
  assert.equal(joined[0].bySite.leeds.qty, 2);
  assert.equal(joined[0].bySite.preston.qty, 3);
  assert.equal(joined[0].catLabel, 'Hot Drinks');
});

test('Product mix categories join on the category family and count a shared product once', () => {
  const l = siteCategoryRows([check({ items: [{ itemId: 'm-1_leeds', cat: 'cat-1_leeds', qty: 1, price: 3 }, { itemId: 'm-2_leeds', cat: 'cat-1_leeds', qty: 1, price: 3 }] })], leeds);
  const p = siteCategoryRows([check({ items: [{ itemId: 'm-1_preston', cat: 'cat-1_preston', qty: 2, price: 3 }] })], preston);
  const joined = joinSiteRows([{ siteId: 'leeds', rows: l.rows }, { siteId: 'preston', rows: p.rows }], ['qty', 'rev']);
  assert.equal(joined.length, 1);
  assert.equal(joined[0].label, 'Hot Drinks');
  assert.equal(joined[0].qty, 4);
  assert.equal(joined[0].itemCount, 2);   // Flat White and Latte, Flat White once
});

test('Product mix modifiers key by name; the attach rate is of that site\'s lines', () => {
  const m = siteModifierRows([check({ items: [
    { qty: 2, price: 3, mods: [{ name: 'Oat milk', price: 0.4 }] },
    { qty: 1, price: 3, mods: [] },
    { qty: 1, price: 3, voided: true, mods: [{ name: 'Oat milk', price: 0.4 }] },
  ] })]);
  assert.equal(m.totalItemCount, 3);
  assert.deepEqual(m.rows.map((r) => [r.key, r.qty, r.revenue]), [['name:oat milk', 2, 0.8]]);
  assert.ok(Math.abs(m.rows[0].attachRate - 66.666) < 0.01);
});

test('Item trend: each site on its own business day, modifier components resolved at their site, joined on the family', () => {
  const days = ['2026-10-04', '2026-10-05'];
  const l = siteTrendRows([
    check({ id: 'a', items: [{ itemId: 'm-1_leeds', name: 'Flat White', qty: 2, price: 3 }] }),
    // a Box with a Bueno inside: the Bueno is Leeds' own menu item, so it gets a row of its own
    check({ id: 'b', items: [{ itemId: 'm-x', name: 'Box of 3', qty: 1, price: 6, mods: [{ id: 'm-7_leeds', name: 'Bueno Donut', qty: 3, price: 0 }] }] }),
    check({ id: 'c', closedAt: Date.parse('2026-10-01T10:00:00Z'), items: [{ itemId: 'm-1_leeds', qty: 9, price: 3 }] }),   // outside the axis
  ], leeds, { dayOf: (ts) => new Date(ts).toISOString().slice(0, 10), days });
  const p = siteTrendRows([check({ items: [{ itemId: 'm-1_preston', name: 'Flat White', qty: 1, price: 3 }] })], preston, { dayOf: () => '2026-10-04', days });
  assert.equal(l.totalsByDay['2026-10-05'], 2 + 1 + 3);
  const bueno = l.rows.find((r) => r.key === 'master:m-7');
  assert.equal(bueno.total, 3);
  assert.deepEqual(bueno.sources, { 'Box of 3': 3 });
  const joined = joinTrendRows([{ siteId: 'leeds', rows: l.rows }, { siteId: 'preston', rows: p.rows }]);
  const fw = joined.find((r) => r.key === 'master:m-1');
  assert.equal(fw.total, 3);
  assert.deepEqual(fw.byDay, { '2026-10-05': 2, '2026-10-04': 1 });
  assert.deepEqual(fw.bySite, { leeds: { total: 2, totalRev: 6 }, preston: { total: 1, totalRev: 3 } });
  assert.equal(fw.sources[TREND_STANDALONE], 3);
  // modifier components left out when asked
  const noMods = siteTrendRows([check({ id: 'b', items: [{ itemId: 'm-x', name: 'Box of 3', qty: 1, price: 6, mods: [{ id: 'm-7_leeds', qty: 3 }] }] })], leeds, { dayOf: () => '2026-10-05', days, includeMods: false });
  assert.equal(noMods.rows.length, 1);
});

test('Menu engineering: items by family, quadrants on the medians of the set they are in', () => {
  const items = siteEngineeringItems([check({ items: [
    { itemId: 'm-1_leeds', qty: 10, price: 3 }, { itemId: 'm-2_leeds', qty: 2, price: 4 }, { itemId: 'm-9', qty: 1, price: 1 },
  ] })], leeds);
  assert.equal(items.length, 3);
  const { items: classed, popMed, contribMed } = classifyItems(items);
  assert.equal(popMed, 2);
  assert.equal(contribMed, 3);
  assert.deepEqual(Object.fromEntries(classed.map((i) => [i.key, i.quadrant])), { 'master:m-1': 'star', 'master:m-2': 'star', 'name:leeds bun': 'dog' });
  assert.equal(median([]), 0);
  assert.equal(median([1, 2, 3, 4]), 2.5);
});

// ── the tax source rule ──────────────────────────────────────────────────────

test('tax: the check\'s own booked record first, then ITS OWN site\'s rates, never the signed in site\'s', () => {
  const line = { itemId: 'm-1_preston', name: 'Flat White', qty: 1, price: 12, taxRateId: 'r-preston-red' };
  const c = check({ items: [line], total: 12, taxAmount: 0.57 });
  // Preston's rows at Preston's 5%: 12 / 1.05 = 11.43 net, 0.57 tax
  const own = siteCheckTax(c, preston);
  assert.equal(own.source, 'rates');
  assert.ok(Math.abs(own.totalTax - 0.5714) < 0.001);
  assert.equal(own.breakdown[0].rate.id, 'r-preston-red');
  // the same row through the signed in site's (Leeds) context knows no such rate: it books Leeds'
  // 20% default and flags the line (8 Oct 2026, D4; until then it booked NOTHING), and a line on
  // "use default" books Leeds' 20% too. Either way the wrong site's answer: the fault this file removes
  const wrong = recordedCheckTax(c, leeds.taxCtx);
  assert.ok(Math.abs(wrong.totalTax - 2) < 0.001);
  assert.deepEqual(wrong.fallbacks.map((f) => [f.reason, f.rateId]), [['rate-not-found', 'r-preston-red']]);
  assert.ok(Math.abs(recordedCheckTax(check({ items: [{ qty: 1, price: 12 }] }), leeds.taxCtx).totalTax - 2) < 0.001);
  // a booked record (US added-on, a scaled UK record) wins over any rates
  const booked = siteCheckTax(check({ items: [line], taxBreakdown: { totalTax: 0.99, subtotal: 11.01, hasExclusiveTax: true, breakdown: [{ rate: { id: 'x', label: 'Sales Tax', rate: 0.09, type: 'exclusive' }, tax: 0.99, net: 11.01, gross: 12, items: 1 }] } }), preston);
  assert.equal(booked.source, 'booked');
  assert.equal(booked.totalTax, 0.99);
  // rates could not be read: the tax stored on the check, no breakdown
  const noRates = buildSiteMenu({ id: 'preston', items: [], categories: [], taxLoaded: false });
  assert.equal(noRates.taxLoaded, false);
  const stored = siteCheckTax(c, noRates);
  assert.equal(stored.source, 'stored');
  assert.equal(stored.totalTax, 0.57);
  assert.equal(stored.subtotal, 11.43);
  assert.deepEqual(stored.breakdown, []);
  // no menu at all (the read failed): the same
  assert.equal(siteCheckTax(c, null).source, 'stored');
});

test('the signed in site keeps the store\'s own tax context, so one site reads as it did', () => {
  const ctx = { taxRates: leeds.taxRates, profilesById: {}, itemProfileIds: {}, categoryProfileIds: {} };
  const home = buildSiteMenu({ id: 'leeds', items: [], categories: [], taxRates: leeds.taxRates, taxCtx: ctx });
  assert.equal(home.taxCtx, ctx);
  assert.equal(home.taxLoaded, true);
  const c = check({ items: [{ qty: 1, price: 12, taxRateId: 'r-leeds-std' }] });
  assert.deepEqual(siteCheckTax(c, home).breakdown, recordedCheckTax(c, ctx).breakdown);
});

test('siteTaxAnalysis gives the Tax report\'s figures per site, rates keyed by what they are', () => {
  const rows = [
    check({ id: 'a', items: [{ itemId: 'm-1_preston', qty: 1, price: 12, taxRateId: 'r-preston-red' }], total: 12, taxAmount: 0.57, orderType: 'takeaway' }),
    check({ id: 'b', items: [{ itemId: 'm-1_preston', qty: 1, price: 6 }], total: 6, taxAmount: 0.29 }),
    check({ id: 'v', status: 'voided', items: [{ qty: 1, price: 100 }], total: 100, taxAmount: 5 }),
  ];
  const a = siteTaxAnalysis(rows, preston);
  assert.equal(a.rateRows.length, 1);
  assert.equal(a.rateRows[0].key, 'reduced rate|0.05|inc');
  assert.equal(a.rateRows[0].items, 2);
  assert.ok(Math.abs(a.rateRows[0].tax - (0.5714 + 0.2857)) < 0.001);
  assert.deepEqual(a.orderTypeRows.map((r) => [r.orderType, r.checks]), [['takeaway', 1], ['dine-in', 1]]);
  assert.equal(a.hasStoredCount, 2);
  assert.equal(a.totalGross, 18);
  assert.ok(Math.abs(a.totalStoredTax - 0.86) < 1e-9);
  assert.equal(a.displayTax, a.totalStoredTax);
  assert.deepEqual(a.sources, { booked: 0, rates: 2, stored: 0 });
  // the same label and rate at two sites is one key; a different rate is not
  assert.equal(rateFamilyKey({ rate: { id: 'x', label: 'Standard Rate', rate: 0.2, type: 'inclusive' } }), rateFamilyKey({ rate: { id: 'y', label: 'standard rate', rate: 0.2, type: 'inclusive' } }));
  assert.notEqual(rateFamilyKey({ rate: { label: 'Standard Rate', rate: 0.2, type: 'inclusive' } }), rateFamilyKey({ rate: { label: 'Standard Rate', rate: 0.2, type: 'exclusive' } }));
  assert.equal(rateFamilyKey({}), '__unrated');
  // the note when the rates were not read
  const noRates = buildSiteMenu({ id: 'preston', items: [], categories: [], taxLoaded: false });
  const b = siteTaxAnalysis(rows, noRates);
  assert.equal(b.sources.stored, 2);
  assert.equal(taxSourceNote('Coffee Boy Preston', noRates, b), 'Coffee Boy Preston: the tax rates could not be read, so 2 checks show the tax stored on the check with no rate breakdown.');
  assert.equal(taxSourceNote('Coffee Boy Preston', preston, a), null);
});

// ── kitchen stations ─────────────────────────────────────────────────────────

test('a station is named from its own site\'s centres, "Site, Station" across sites, keyed by site', () => {
  const leedsCentres = [{ id: 'pc-1', name: 'kds food' }];
  const prestonCentres = [{ id: 'pc-2', name: 'kds food' }];
  assert.equal(siteStationLabel('pc-1', 'Leeds', leedsCentres, true), 'Leeds, kds food');
  assert.equal(siteStationLabel('pc-1', 'Leeds', leedsCentres, false), 'kds food');
  assert.equal(siteStationLabel('pc-1', 'Preston', prestonCentres, true), 'Preston, Removed station (pc-1)');
  assert.equal(siteStationLabel(null, 'Leeds', leedsCentres, true), 'Leeds, No station');
  assert.notEqual(stationKey('leeds', 'pc-1'), stationKey('preston', 'pc-1'));
  assert.equal(stationKey('leeds', null), stationKey('leeds', undefined));
});

test('kitchen stats per site then joined: percentiles over every ticket, hours added up', () => {
  const t = (siteId, centreId, sentAt, ms, status = 'bumped') => ({ siteId, centreId, status, sentAt, bumpedAt: status === 'bumped' ? sentAt + ms : null });
  const noon = Date.parse('2026-10-05T11:00:00Z');   // 12:00 London
  const a = siteKitchenStats([t('leeds', 'pc-1', noon, 60000), t('leeds', 'pc-1', noon, 120000), t('leeds', null, noon, 0, 'pending')], { siteId: 'leeds', timeZone: 'Europe/London', labelOf: (id) => `Leeds, ${id}` });
  const b = siteKitchenStats([t('preston', 'pc-1', noon, 600000)], { siteId: 'preston', timeZone: 'Europe/London', labelOf: (id) => `Preston, ${id}` });
  assert.equal(a.totalCount, 2);
  assert.equal(a.openCount, 1);
  assert.equal(a.avgMs, 90000);
  assert.equal(a.stations[0].label, 'Leeds, pc-1');
  assert.equal(a.countByHour[12], 2);
  const all = joinKitchenStats([a, b]);
  assert.equal(all.totalCount, 3);
  assert.equal(all.openCount, 1);
  assert.equal(all.avgMs, 260000);
  assert.equal(all.p90, 600000);
  assert.equal(all.stations.length, 2);   // the same centre id at two sites stays two stations
  assert.deepEqual(all.stations.map((s) => s.label), ['Leeds, pc-1', 'Preston, pc-1']);
  assert.equal(all.countByHour[12], 3);
  assert.equal(all.avgByHour[12], 260000);
  assert.equal(percentile([], 50), 0);
  assert.equal(percentile([1, 2, 3, 4], 50), 3);
});

// ── the six reports route on the split, and the signed in site reads the store ──────────

import { readFileSync } from 'node:fs';
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

test('pin: each step 4 report renders its one site view when one site is on screen, and that view reads the store for the signed in site', () => {
  const dir = '../backoffice/sections/reports/';
  for (const [file, one] of [
    ['ProductMix.jsx', 'ProductMixOne'], ['ItemTrend.jsx', 'ItemTrendOne'], ['MenuEngineering.jsx', 'MenuEngineeringOne'],
    ['Tax.jsx', 'TaxOne'], ['Tips.jsx', 'TipsOne'], ['KDSPerformance.jsx', 'KDSPerformanceOne'],
  ]) {
    const src = read(dir + file);
    assert.match(src, new RegExp(`return isSplit\\(props\\.sites\\) \\? <\\w+Sites \\{\\.\\.\\.props\\}/> : <${one} \\{\\.\\.\\.props\\}/>;`), file);
  }
  // another site's menu is only read when ONE OTHER site is on screen; the signed in site reads the store
  for (const file of ['ProductMix.jsx', 'ItemTrend.jsx', 'MenuEngineering.jsx']) {
    assert.match(read(dir + file), /other\.other \? \(other\.menu\?\.categories \|\| NONE\) : \(store\.menuCategories \|\| NONE\)/, file);
  }
  const tax = read(dir + 'Tax.jsx');
  assert.match(tax, /const taxCtx = other\.other \? \(other\.menu\?\.taxCtx \|\| null\) : homeCtx;/);
  assert.match(tax, /const taxOf = other\.other \? \(c\) => siteCheckTax\(c, other\.menu\) : \(c\) => recordedCheckTax\(c, taxCtx\);/);
  const hook = read(dir + '_siteMenus.js');
  assert.match(hook, /const site = Array\.isArray\(sites\) && sites\.length === 1 && sites\[0\] && !sites\[0\]\.isHome \? sites\[0\] : null;/);
  // the multi site hook hands the signed in site the store's own tax context
  assert.match(hook, /buildSiteMenu\(\{ id: homePart\.id, items: menuItems, categories: menuCategories, taxRates, taxCtx: homeCtx \}\)/);
});
