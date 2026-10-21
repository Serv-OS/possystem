/** itemPageRules.test.js: the company item page rules (multi site stock Drop 1). Run: npm test */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  itemTabs, startTabOf, FIELD_WORDS, conflictRows, sameValue, valueWords, vatWords, vatChoices,
  untickState, untickWords, recipesWords, holdsText, siteRowModel, priceFactor, priceHereFor,
  toPackQty, toBaseQty, parPatchFor, homeSiteOf, canEditItem, detailsDraft, detailsPatch,
  changeWords, whenWords, lastPaidWords, nextPriceWords, onTopRows, cloneSiteKinds, KIND_CHOICES,
} from './itemPageRules.js';
import { savedFirstWords } from './siteScope.js';

// Synthetic fixtures only (public repo): made up sites, items and prices.
const PROVO = 'aaaaaaaa-0000-4000-8000-000000000001';
const L2 = 'aaaaaaaa-0000-4000-8000-000000000002';
const LEEDS = 'aaaaaaaa-0000-4000-8000-000000000003';
const SI_MAIN = 'bbbbbbbb-0000-4000-8000-000000000001';
const SI_ALT = 'bbbbbbbb-0000-4000-8000-000000000002';

// Whole milk: base ml, counted in 2 L bottles, bought in cases of 6 x 2 L at £8.28 (£1.38 a bottle).
const detail = () => ({
  item: { id: 'item-1', name: 'Whole milk', base_unit: 'ml', main_supplier_item_id: SI_MAIN, local_location_id: null, row_version: 4, purchase_vat_rate: 0 },
  row_version: 4,
  count_pack: { id: 'pk-btl', name: 'Bottle', qty_in_base: 2000 },
  packs: [{ id: 'pk-btl', name: 'Bottle', qty_in_base: 2000, is_count_default: true }],
  bridges: [],
  supplier_items: [
    { id: SI_MAIN, supplier_name: 'Freshways', pack_qty: 6, inner_qty: 2, inner_unit: 'l', pack_price: 8.28, unit_price: 8.28 / 12000, currency: 'GBP',
      sites: [{ location_id: PROVO, price_here: null, price: 8.28, unit_price: 8.28 / 12000 }, { location_id: L2, price_here: 8.70, price: 8.70, unit_price: 8.70 / 12000 }] },
    { id: SI_ALT, supplier_name: 'Brakes', pack_qty: 6, inner_qty: 2, inner_unit: 'l', pack_price: 8.70, unit_price: 8.70 / 12000, currency: 'GBP', sites: [] },
  ],
  sites: [
    { location_id: PROVO, name: 'Provo', site_item_id: 'si-p', on_here: true, paused: false, counted_here: true, stop_ordering_at: null,
      on_hand: 62000, current_cost: 8.28 / 12000, par_level: 48000, reorder_point: 20000, min_level: 12000, area_id: 'ar-1', area_name: 'Fridge',
      row_version: 7, price_here: null, unit_price: 8.28 / 12000, supplier_here: null,
      last_paid: { unit_cost: 8.28 / 12000, pack_price: 8.28, pack_label: '6 x 2 L', at: '2026-10-18T08:00:00Z', source: 'INVOICE' },
      why_on: 'Added by Jane Smith', recipes_here: 2, recipe_names_here: ['Latte', 'Flat white'],
      can_order_suppliers: [{ supplier_item_id: SI_MAIN, supplier_name: 'Freshways' }, { supplier_item_id: SI_ALT, supplier_name: 'Brakes' }] },
    { location_id: L2, name: 'Location 2', site_item_id: 'si-l2', on_here: true, paused: true, paused_from: null, paused_until: '2026-11-03', counted_here: false,
      stop_ordering_at: '2026-10-19T10:00:00Z', on_hand: 18000, current_cost: 8.70 / 12000, par_level: 24000, reorder_point: null, min_level: 6000,
      area_id: null, area_name: '', row_version: 3, price_here: 8.70, unit_price: 8.70 / 12000,
      supplier_here: { supplier_item_id: SI_MAIN, supplier_name: 'Freshways' }, last_paid: null, why_on: null, recipes_here: 0, recipe_names_here: [],
      can_order_suppliers: [{ supplier_item_id: SI_MAIN, supplier_name: 'Freshways' }] },
  ],
});

const scopeOf = (level, mine = [PROVO, L2, LEEDS]) => ({
  multi: true, level,
  canEditSite: (id, what) => mine.includes(id) && (what === 'site_facts' || level === 'sites_full' || level === 'all'),
});

test('itemTabs: Details, Packs, Suppliers, Sites, Used in, Changes; no Sites tab for one site', () => {
  assert.deepEqual(itemTabs(true).map((t) => t.label), ['Details', 'Packs', 'Suppliers', 'Sites', 'Used in', 'Changes']);
  assert.deepEqual(itemTabs(false).map((t) => t.label), ['Details', 'Packs', 'Suppliers', 'Used in', 'Changes']);
  assert.equal(startTabOf(itemTabs(true), 'sites'), 'sites');
  assert.equal(startTabOf(itemTabs(false), 'sites'), 'details');
  assert.equal(startTabOf(itemTabs(true), 'nonsense'), 'details');
  for (const t of itemTabs(true)) { assert.equal(t.key, t.value); assert.equal(t.id, t.value, 'stockUi TabBar keys on id'); }
});

test('FIELD_WORDS are plain words with no dash, and every Details field has one', () => {
  for (const k of ['name', 'category_id', 'type', 'base_unit', 'sku', 'barcode', 'purchase_vat_rate', 'shelf_life_days', 'notes',
    'exclude_from_gp', 'key_item', 'returns_to_shelf', 'allergens', 'par_level', 'reorder_point', 'min_level', 'price_here']) {
    assert.ok(FIELD_WORDS[k], `no words for ${k}`);
  }
  for (const v of Object.values(FIELD_WORDS)) assert.doesNotMatch(v, /[\u2013\u2014_]/);
  assert.ok(Object.isFrozen(FIELD_WORDS));
});

test('conflictRows: the differing fields, in words, theirs and mine', () => {
  const mine = { name: 'Whole milk', shelf_life_days: '10', key_item: true, type: 'drink', category_id: 'c1' };
  const theirs = { name: 'Whole milk', shelf_life_days: 7, key_item: true, type: 'food', category_id: 'c2' };
  const rows = conflictRows(mine, theirs, FIELD_WORDS, { names: { c1: 'Dairy', c2: 'Drinks' } });
  assert.deepEqual(rows.map((r) => r.label), ['Category', 'Type', 'Shelf life']);
  const shelf = rows.find((r) => r.key === 'shelf_life_days');
  assert.equal(shelf.theirs, '7 days');
  assert.equal(shelf.mine, '10 days');
  assert.deepEqual(rows.find((r) => r.key === 'category_id'), { key: 'category_id', label: 'Category', theirs: 'Drinks', mine: 'Dairy' });
  assert.deepEqual(conflictRows(mine, { ...mine }, FIELD_WORDS), []);
  assert.deepEqual(conflictRows(null, null), []);
});

test('sameValue: empty text and null, 7 and "7", lists in any order', () => {
  assert.ok(sameValue('', null));
  assert.ok(sameValue(7, '7'));
  assert.ok(sameValue(['milk', 'eggs'], ['eggs', 'milk']));
  assert.ok(!sameValue('7 days', 7));
  assert.ok(!sameValue(true, false));
});

test('valueWords and vatWords read like people talk', () => {
  assert.equal(valueWords('key_item', true), 'Yes');
  assert.equal(valueWords('on_here', false), 'Off');
  assert.equal(valueWords('type', 'drink'), 'Drink');
  assert.equal(valueWords('notes', null), 'None');
  assert.equal(valueWords('allergens', ['milk', '', 'eggs']), 'Milk, Eggs');
  assert.equal(valueWords('allergens', []), 'None');
  assert.equal(valueWords('pack_price', 8.7, { currency: 'GBP' }), '£8.70');
  assert.equal(valueWords('par_level', 24000, { countPack: { name: 'Bottle', qty_in_base: 2000 } }), '12 bottles');
  assert.equal(valueWords('par_level', 2000, { countPack: { name: 'Bottle', qty_in_base: 2000 } }), '1 bottle');
  assert.equal(valueWords('paused_until', '2026-11-03'), '3 Nov');
  assert.equal(vatWords(0.2), '20%');
  assert.equal(vatWords(0.08875), '8.875%');
  assert.equal(vatWords(0), '0% (zero rated)');
  assert.equal(vatWords(null), 'None set');
});

test('vatChoices: one choice per rate, whatever each site calls it, plus the item\'s own', () => {
  const rows = [
    { rate: 0.2, name: 'VAT 20%' }, { rate: '0.2000', name: 'Standard Rate' }, { rate: 0.05, name: 'Reduced' },
    { rate: 0, name: 'Zero' }, { rate: 0.125, name: 'Old rate', active: false }, { rate: null },
  ];
  assert.deepEqual(vatChoices(rows).map((c) => c.label), ['None set', '0% (zero rated)', '5%', '20%']);
  assert.deepEqual(vatChoices(rows, 0.175).map((c) => c.value), [null, 0, 0.05, 0.175, 0.2]);
  assert.deepEqual(vatChoices([], null), [{ value: null, label: 'None set' }]);
});

test('untickState: Remove now only when nothing is held there and no recipe there uses it', () => {
  const clear = untickState({ onHand: 0, unit: 'kg', recipeNames: [], siteName: 'Leeds' });
  assert.equal(clear.blocked, false);
  assert.equal(clear.words, 'Nothing is held there and no recipe there uses it.');
  const both = untickState({ onHand: 3, unit: 'kg', recipeNames: ['Latte'], siteName: 'Leeds' });
  assert.equal(both.blocked, true);
  assert.equal(both.holds, '3 kg');
  assert.equal(both.words, 'Leeds holds 3 kg and Latte uses it. Choose Stop ordering, run out, or write it off first.');
  assert.equal(untickState({ onHand: 2.5, unit: 'bottle', siteName: 'York' }).words, 'York holds 2.5 bottle. Choose Stop ordering, run out, or write it off first.');
  assert.equal(untickState({ onHand: 0, recipeNames: ['Latte', 'Mocha'], siteName: 'York' }).words,
    'Latte and Mocha use it at York. Choose Stop ordering, run out, or write it off first.');
  // below zero is not "held" (the database decides; the words never say "holds -2")
  assert.equal(untickState({ onHand: -2, unit: 'kg', siteName: 'Leeds' }).blocked, false);
  // a recipe count with no names still blocks
  assert.equal(untickState({ onHand: 0, recipeNames: [], recipeCount: 1, siteName: 'Leeds' }).blocked, true);
});

test('untickWords and recipesWords: the parts that apply, never a dash', () => {
  assert.equal(recipesWords(['Latte']), 'Latte');
  assert.equal(recipesWords(['Latte', 'Mocha', 'Flat white']), 'Latte, Mocha and Flat white');
  assert.equal(recipesWords(['Latte', 'Mocha', 'Flat white'], 5), 'Latte, Mocha and 3 more');
  assert.equal(recipesWords(['Latte'], 3), 'Latte and 2 more');
  assert.equal(recipesWords([]), '');
  assert.equal(untickWords({ siteName: 'Leeds', holds: '3 kg', usedBy: ['Latte', 'Mocha', 'Tea'], recipeCount: 4 }),
    'Leeds holds 3 kg and Latte, Mocha and 2 more use it. Choose Stop ordering, run out, or write it off first.');
  assert.doesNotMatch(untickWords({ siteName: 'A', holds: '1 kg', usedBy: ['B'] }), /[\u2013\u2014]/);
  assert.equal(holdsText(3), '3');
  assert.equal(holdsText(0), '');
  assert.equal(holdsText(true), 'some stock');
  assert.equal(holdsText(null), '');
  assert.equal(holdsText(' 3 kg '), '3 kg');
});

test('siteRowModel: Provo follows the company price, shown in the pack people use', () => {
  const m = siteRowModel({ id: PROVO, name: 'Provo', currency: 'GBP' }, detail(), scopeOf('all'));
  assert.equal(m.on, true);
  assert.equal(m.follows, true);
  assert.equal(m.shown, 1.38);
  assert.equal(m.costHere, 1.38);
  assert.equal(m.par, 24);
  assert.equal(m.reorder, 10);
  assert.equal(m.min, 6);
  assert.equal(m.supplierUsedId, SI_MAIN);
  assert.equal(m.supplierHereId, null);
  assert.deepEqual(m.supplierChoices.map((c) => c.name), ['Freshways', 'Brakes']);
  assert.equal(m.why, 'Added by Jane Smith');
  assert.equal(m.recipesHere, 2);
  assert.equal(m.areaName, 'Fridge');
  assert.equal(m.lastPaid.amount, 1.38);
  assert.equal(m.canFacts, true);
  assert.equal(m.canPrice, true);
  assert.ok(Math.abs(m.factor - 6) < 1e-9, 'a case of 6 bottles');
});

test('siteRowModel: Location 2 has its own price, is paused, running out and not counted', () => {
  const m = siteRowModel({ id: L2, name: 'Location 2', currency: 'GBP' }, detail(), scopeOf('all'));
  assert.equal(m.follows, false);
  assert.equal(m.priceHere, 8.7);
  assert.equal(m.shown, 1.45);
  assert.equal(m.paused, true);
  assert.equal(m.pausedUntil, '2026-11-03');
  assert.equal(m.runningOut, true);
  assert.equal(m.countedHere, false);
  assert.equal(m.reorder, null);
  assert.equal(m.lastPaid, null);
  assert.equal(m.supplierHereId, SI_MAIN);
});

test('siteRowModel: a site with no row is Not stocked here; levels grey what the database refuses', () => {
  const m = siteRowModel({ id: LEEDS, name: 'Leeds', currency: 'GBP' }, detail(), scopeOf('sites'));
  assert.equal(m.linked, false);
  assert.equal(m.on, false);
  assert.equal(m.canFacts, true);
  assert.equal(m.canPrice, false, 'Their sites: no price here, no supplier here, no ticks');
  const full = siteRowModel({ id: PROVO, name: 'Provo' }, detail(), scopeOf('sites_full', [PROVO]));
  assert.equal(full.canPrice, true);
  const other = siteRowModel({ id: L2, name: 'Location 2' }, detail(), scopeOf('sites_full', [PROVO]));
  assert.equal(other.canPrice, false, 'full control is only at their own sites');
  assert.equal(other.canFacts, false);
  // no scope (a screen alone): today's rule, everything open
  assert.equal(siteRowModel({ id: PROVO }, detail(), null).canPrice, true);
});

test('price here round trip: typing the shown price stores the supplier pack price exactly', () => {
  const m = siteRowModel({ id: L2, name: 'Location 2', currency: 'GBP' }, detail(), scopeOf('all'));
  assert.equal(priceHereFor('1.45', m), 8.7);
  assert.equal(priceHereFor(1.5, m), 9);
  assert.equal(priceHereFor('', m), null);
  assert.equal(priceHereFor('-1', m), null);
  assert.equal(priceHereFor('abc', m), null);
  assert.equal(priceHereFor('1', { factor: null }), null);
});

test('priceFactor: from the pack sizes when the price is 0, grossed up when the price includes VAT', () => {
  const d = detail();
  const si = d.supplier_items[0];
  const cp = d.count_pack;
  assert.ok(Math.abs(priceFactor({ packNow: 0, shown: 0, si, detail: d, countPack: cp }) - 6) < 1e-9);
  const vat = { ...si, price_includes_tax: true, purchase_vat_rate: 0.2 };
  assert.ok(Math.abs(priceFactor({ packNow: null, shown: null, si: vat, detail: d, countPack: cp }) - 7.2) < 1e-9);
  // a pack the unit engine cannot turn into ml (no bridge from each): no price box
  const each = { ...si, inner_unit: 'each' };
  assert.equal(priceFactor({ si: each, detail: d, countPack: cp }), null);
  // with a bridge (1 each = 2000 ml) it can
  const bridged = { ...d, bridges: [{ from_qty: 1, from_unit: 'each', to_qty: 2000, to_unit: 'ml' }] };
  assert.ok(Math.abs(priceFactor({ si: { ...each, pack_qty: 6, inner_qty: 1 }, detail: bridged, countPack: cp }) - 6) < 1e-9);
});

test('par in packs and back: what is typed in bottles is stored in ml, empty clears it', () => {
  const cp = { name: 'Bottle', qty_in_base: 2000 };
  assert.equal(toPackQty(48000, cp), 24);
  assert.equal(toPackQty(null, cp), null);
  assert.equal(toBaseQty('24', cp), 48000);
  assert.equal(toBaseQty('', cp), null);
  assert.equal(toBaseQty('abc', cp), undefined);
  assert.equal(toBaseQty('-1', cp), undefined);
  const m = siteRowModel({ id: PROVO, name: 'Provo' }, detail(), scopeOf('all'));
  assert.deepEqual(parPatchFor(m, { par: '30' }), { par_level: 60000, reorder_point: 20000, min_level: 12000 });
  assert.deepEqual(parPatchFor(m, { min: '' }), { par_level: 48000, reorder_point: 20000, min_level: null });
  assert.equal(parPatchFor(m, { reorder: 'x' }), undefined);
});

test('homeSiteOf and canEditItem: the local site first; a manager edits only their own local item', () => {
  const d = detail();
  assert.equal(homeSiteOf(d, [L2, PROVO]), L2, 'the first site in the login\'s list where it is on');
  assert.equal(homeSiteOf(d, [PROVO, L2]), PROVO);
  const local = { ...d, item: { ...d.item, local_location_id: LEEDS } };
  assert.equal(homeSiteOf(local, [PROVO, LEEDS]), LEEDS);
  assert.equal(homeSiteOf({ sites: [] }, [], 'home'), 'home');
  assert.equal(canEditItem({ companyEditor: true, item: d.item, siteIds: [] }), true);
  assert.equal(canEditItem({ companyEditor: false, item: d.item, siteIds: [PROVO] }), false);
  assert.equal(canEditItem({ companyEditor: false, item: local.item, siteIds: [LEEDS] }), true);
  assert.equal(canEditItem({ companyEditor: false, item: local.item, siteIds: [PROVO] }), false);
});

test('detailsPatch: only what changed is sent, cleaned; a bad shelf life is refused in words', () => {
  const item = { name: 'Whole milk', category_id: 'c1', type: 'drink', base_unit: 'ml', sku: null, barcode: '50123', purchase_vat_rate: 0,
    shelf_life_days: 10, notes: null, exclude_from_gp: false, key_item: true, returns_to_shelf: false, allergens: ['milk'] };
  const draft = detailsDraft(item);
  assert.deepEqual(detailsPatch(draft, item), { patch: {}, error: null });
  assert.deepEqual(detailsPatch({ ...draft, shelf_life_days: '7', sku: '  FW-1 ', notes: '' }, item).patch, { sku: 'FW-1', shelf_life_days: 7 });
  assert.deepEqual(detailsPatch({ ...draft, purchase_vat_rate: 0.2 }, item).patch, { purchase_vat_rate: 0.2 });
  assert.deepEqual(detailsPatch({ ...draft, allergens: ['milk', 'eggs'] }, item).patch, { allergens: ['milk', 'eggs'] });
  assert.equal(detailsPatch({ ...draft, shelf_life_days: '2.5' }, item).error, 'Shelf life is a whole number of days.');
  assert.equal(detailsPatch({ ...draft, name: '  ' }, item).error, 'Give the item a name.');
});

test('changeWords: When, Who, What, Old, New in plain words', () => {
  const sites = { [PROVO]: { name: 'Provo' }, [L2]: { name: 'Location 2' } };
  const cp = { name: 'Bottle', qty_in_base: 2000 };
  assert.deepEqual(changeWords({ field: 'par_level', before: 60000, after: 72000, location_id: PROVO, who_name: 'Jane Smith' }, sites, { countPack: cp }),
    { who: 'Jane Smith', what: 'Par, Provo', old: '30 bottles', new: '36 bottles' });
  assert.deepEqual(changeWords({ field: 'on_here', before: false, after: true, location_id: L2, who_name: 'Tom Lee' }, sites),
    { who: 'Tom Lee', what: 'Ticked at Location 2', old: 'Off', new: 'On' });
  const cost = changeWords({ kind: 'cost', field: 'current_cost', before: null, after: 1.45 / 2000, location_id: L2, who_name: null, source: 'INVOICE' }, sites, { countPack: cp, currency: 'GBP' });
  assert.deepEqual(cost, { who: 'An invoice', what: 'Cost here, Location 2', old: '', new: '£1.45 a bottle' });
  assert.deepEqual(changeWords({ field: 'name', before: 'Milk', after: 'Whole milk', location_id: null, who_name: 'Jane Smith' }, sites),
    { who: 'Jane Smith', what: 'Name', old: 'Milk', new: 'Whole milk' });
  assert.equal(changeWords({ field: 'some_new_column', before: 1, after: 2 }, sites).what, 'Some new column');
  assert.equal(changeWords({ field: 'name', who_name: '' , source: 'import' }, sites).who, 'An import');
  // siteById may also be a Map or a function (whatever the scope hands over)
  assert.equal(changeWords({ field: 'paused', after: true, location_id: PROVO }, new Map([[PROVO, { name: 'Provo' }]])).what, 'Paused, Provo');
  assert.equal(changeWords({ field: 'paused', after: true, location_id: PROVO }, (id) => (id === PROVO ? 'Provo' : '')).what, 'Paused, Provo');
});

test('whenWords, lastPaidWords and nextPriceWords use the venue clock and the pack people use', () => {
  assert.equal(whenWords('2026-10-18T08:12:00Z', 'Europe/London'), '18 Oct 09:12');
  assert.equal(whenWords('2026-10-18T23:30:00Z', 'Europe/London'), '19 Oct 00:30', 'a UK night after midnight is the next UK day, whatever the browser clock');
  assert.equal(lastPaidWords({ amount: 1.45, at: '2026-10-18T08:00:00Z' }, 'GBP', 'Europe/London'), '£1.45, 18 Oct');
  assert.equal(lastPaidWords(null, 'GBP', 'Europe/London'), 'None');
  assert.equal(nextPriceWords({ price: 8.61, from_day: '2026-11-01' }, 'GBP'), '£8.61 from 1 Nov');
  assert.equal(nextPriceWords({ price: 8.70, from_day: '2026-11-01' }, 'GBP', { name: 'Bottle', qty_in_base: 2000 }, 6), '£1.45 from 1 Nov');
  assert.equal(nextPriceWords(null, 'GBP'), 'None');
});

// ── The screens: one site companies never reach them; house rules hold in every file ──

const ITEM_DIR = new URL('../../backoffice/sections/stock/items/', import.meta.url);
const MINE = ['ItemPage.jsx', 'ItemDetailsTab.jsx', 'ItemPacksTab.jsx', 'UnitsTab.jsx', 'DimensionTab.jsx', 'ItemSuppliersTab.jsx',
  'ItemSitesTab.jsx', 'UntickChoiceModal.jsx', 'StockTab.jsx', 'ItemUsedInTab.jsx', 'ItemChangesTab.jsx', 'CloneItemModal.jsx'];
const readMine = (f) => fs.readFileSync(new URL(f, ITEM_DIR), 'utf8');

test('every item page file exists and keeps the house rules (no dash, no window.confirm, no picker writes)', () => {
  for (const f of MINE) {
    const src = readMine(f);
    assert.doesNotMatch(src, /[\u2013\u2014]/, `${f} has an em or en dash`);
    assert.doesNotMatch(src, /window\.confirm\s*\(/, `${f} uses window.confirm (it shows nothing in the iPad apps)`);
    assert.doesNotMatch(src, new RegExp(`\\b${['str', 'ipe'].join('')}\\b`, 'i'), `${f} names the old card processor`);
    assert.doesNotMatch(src, /rpos-|setResolvedLocationId|localStorage/, `${f} touches the venue picker or browser storage`);
    assert.doesNotMatch(src, /supabase\.from\(\s*'(stock_co_|inventory_items|par_levels|supplier_products|item_packaging_formats|inventory_item_conversions)/,
      `${f} writes or reads a stock table directly: every company change goes through a save function`);
  }
  for (const f of ['../../lib/stock/packPrice.js', '../../lib/stock/itemPageRules.js', './packPrice.test.js', './itemPageRules.test.js']) {
    assert.doesNotMatch(fs.readFileSync(new URL(f, import.meta.url), 'utf8'), /[\u2013\u2014]/, `${f} has an em or en dash`);
  }
});

test('company saves on the item page go through stockApi (the save functions), never data.js', () => {
  for (const f of ['ItemPage.jsx', 'ItemDetailsTab.jsx', 'UnitsTab.jsx', 'DimensionTab.jsx', 'ItemSuppliersTab.jsx', 'ItemSitesTab.jsx', 'CloneItemModal.jsx']) {
    const src = readMine(f);
    assert.match(src, /stockApi\./, `${f} saves through stockApi`);
    assert.doesNotMatch(src, /upsertInventoryItem|upsertPackagingFormat|upsertItemConversion|upsertSupplierProduct|deletePackagingFormat|deleteItemConversion|setUnitDefault/,
      `${f} uses a site row writer from data.js (site versions, not company versions)`);
  }
  const packs = readMine('ItemPacksTab.jsx');
  assert.match(packs, /Packs are company wide, so every site counts in the same packs\./);
  const units = readMine('UnitsTab.jsx');
  assert.match(units, /stockApi\.savePack\(/);
  assert.match(units, /stockApi\.archivePack\(/);
  assert.match(units, /stockApi\.setPackDefault\(/);
  assert.match(units, /used in a recipe/i, 'the "a recipe uses it" refusal words are kept');
  const dims = readMine('DimensionTab.jsx');
  assert.match(dims, /stockApi\.saveBridge\(/);
  assert.match(dims, /stockApi\.archiveBridge\(/);
});

test('the Sites tab says what the mockup says', () => {
  const src = readMine('ItemSitesTab.jsx');
  for (const words of [
    'What this site is charged for the pack. Grey means it follows the company price.',
    "What one pack on this site's shelf is worth in the stock value.",
    'The price on the last invoice posted here.',
    'What the site wants on the shelf after a delivery.',
    "Not stocked here. Tick to add it: the site's row is made at once with on hand 0.",
    'Set par for all ticked sites', 'Add to all sites', 'Copy from a site',
    "Untick a site to see the two choices. Set a price at one site and only that site's cost moves.",
    'Back to the company price at', 'Only ', 'is now at every site.', 'on its count sheet and Order pad at once.',
  ]) assert.ok(src.includes(words), `Sites tab is missing: ${words}`);
  for (const col of ['On', 'Site', 'Supplier here', 'Price here', 'Cost here', 'Last paid', 'Par', 'Reorder at', 'Min', 'On hand', 'Area', 'Counted here', 'Paused']) {
    assert.ok(src.includes(`>${col}<`) || src.includes(`'${col}'`), `Sites tab column ${col}`);
  }
  assert.match(src, /stockApi\.setItemSites\(/);
  assert.match(src, /stockApi\.saveItemSite\(/);
  assert.match(src, /<LockLine[^>]*kind=/);
  const modal = readMine('UntickChoiceModal.jsx');
  for (const words of ['Take ', 'Stop ordering, run out', 'It can no longer be ordered at', 'It stays on the counts until it reaches zero, then archives itself. Recipes there keep working until then.',
    'Remove now', 'Unticked rows are archived, never deleted.']) assert.ok(modal.includes(words), `Untick modal is missing: ${words}`);
  assert.match(modal, /export default function UntickChoiceModal\(\{ itemName, siteName, holds, usedBy = \[\], busy = false, onRunOut, onRemoveNow, onClose \}\)/);
});

test('one site companies keep today\'s screen: the item page is only reached in a multi site company', () => {
  const router = fs.readFileSync(new URL('../../backoffice/sections/StockItems.jsx', import.meta.url), 'utf8');
  const mineRe = /from '\.\/stock\/items\/(ItemPage|ItemDetailsTab|ItemPacksTab|UnitsTab|DimensionTab|ItemSuppliersTab|ItemSitesTab|StockTab|ItemUsedInTab|ItemChangesTab|CloneItemModal)'/;
  if (/useStockScope\(\)/.test(router)) {
    // the Drop 1 router: the one site screen is returned before the item page can render
    const oneSite = router.indexOf('if (!sc.multi) return <StockItemsSplit');
    const page = router.indexOf('<ItemPage');
    assert.ok(oneSite > 0, 'the router returns StockItemsSplit when the company is not multi site');
    assert.ok(page < 0 || oneSite < page, 'nothing of the item page renders before the one site return');
  } else {
    // still today's file (the router lands with web-items): it must not import any item page file
    assert.doesNotMatch(router, mineRe);
  }
  const splitUrl = new URL('../../backoffice/sections/stock/items/StockItemsSplit.jsx', import.meta.url);
  if (fs.existsSync(splitUrl)) {
    const split = fs.readFileSync(splitUrl, 'utf8');
    assert.doesNotMatch(split, /from '\.\/(ItemPage|ItemDetailsTab|ItemPacksTab|UnitsTab|DimensionTab|ItemSuppliersTab|ItemSitesTab|StockTab|ItemUsedInTab|ItemChangesTab|CloneItemModal|UntickChoiceModal)'/,
      'the one site screen imports no company item page file, so no change here can reach it');
    assert.doesNotMatch(split, /from '[^']*(packPrice|itemPageRules)(\.js)?'/, 'one site companies keep today\'s per base unit figures');
  }
  const supSplitUrl = new URL('../../backoffice/sections/stock/suppliers/SuppliersSplit.jsx', import.meta.url);
  if (fs.existsSync(supSplitUrl)) {
    const sup = fs.readFileSync(supSplitUrl, 'utf8');
    assert.doesNotMatch(sup, /from '[^']*(packPrice|itemPageRules)(\.js)?'/, 'the one site Suppliers screen keeps today\'s figures too');
    assert.doesNotMatch(sup, /from '[^']*items\/(ItemPage|ItemSitesTab|UntickChoiceModal)'/);
  }
  // and the item page itself never offers a Sites tab to a one site company
  const page = readMine('ItemPage.jsx');
  assert.match(page, /itemTabs\(sc\.multi\)/);
  // with no scope provider (a one site company's default answer) there is no Sites tab
  assert.equal(itemTabs(false).some((t) => t.id === 'sites'), false);
});

test('onTopRows: only the fields THEY changed that this screen says otherwise; Save mine on top sends what the table calls Yours', () => {
  // I change Notes; Tom saves Shelf life 10 to 7 first
  const loadedItem = { id: 'i', name: 'Whole milk', shelf_life_days: 10, notes: 'old notes', row_version: 4 };
  const freshItem = { ...loadedItem, shelf_life_days: 7, row_version: 5 };
  const draft = { ...detailsDraft(loadedItem), notes: 'new notes' };
  const rows = onTopRows(detailsDraft(loadedItem), draft, detailsDraft(freshItem), FIELD_WORDS);
  assert.deepEqual(rows, [{ key: 'shelf_life_days', label: 'Shelf life', from: '10 days', theirs: '7 days', mine: '10 days' }], 'my own Notes change is never shown as theirs');
  assert.equal(savedFirstWords({ byName: 'Tom Lee', rows }).words, 'Tom Lee changed Shelf life from 10 days to 7 days.', 'one change of theirs, said truly');
  // "Save mine on top" sends this screen against THEIR version: exactly the listed field as Yours, plus my own change
  const { patch } = detailsPatch(draft, freshItem);
  assert.deepEqual(patch, { shelf_life_days: 10, notes: 'new notes' });
  // a field I changed too: the words still say what it was before they changed it
  const both = onTopRows(detailsDraft(loadedItem), { ...draft, shelf_life_days: '12' }, detailsDraft(freshItem), FIELD_WORDS);
  assert.deepEqual(both.map((r) => [r.label, r.from, r.theirs, r.mine]), [['Shelf life', '10 days', '7 days', '12 days']]);
  // nothing of theirs clashes (they changed something this tab does not show, or typed what I typed): no rows
  assert.deepEqual(onTopRows(detailsDraft(loadedItem), draft, detailsDraft({ ...loadedItem, row_version: 6 }), FIELD_WORDS), []);
  assert.deepEqual(onTopRows(detailsDraft(loadedItem), { ...draft, shelf_life_days: '7' }, detailsDraft(freshItem), FIELD_WORDS), []);
  assert.deepEqual(onTopRows(null, null, null), []);
});

test('Purchased or made: the Sites tab reads it per site, and Clone keeps it per site', () => {
  const d = detail();
  d.sites[0].supply_mode = 'bought';
  d.sites[1].supply_mode = 'batches';
  d.sites[1].is_sellable = true;
  const p = siteRowModel({ id: PROVO, name: 'Provo', currency: 'GBP' }, d, scopeOf('all'));
  const l2 = siteRowModel({ id: L2, name: 'Location 2', currency: 'GBP' }, d, scopeOf('all'));
  assert.equal(p.made, false);
  assert.equal(l2.made, true, 'a batch site is Made here');
  assert.equal(l2.sellable, true);
  assert.equal(siteRowModel({ id: LEEDS, name: 'Leeds' }, d, scopeOf('all')).made, false, 'not set up there: nothing to say');
  assert.deepEqual(KIND_CHOICES.map((k) => [k.value, k.label]), [['PURCHASED', 'Purchased'], ['MADE', 'Made here']]);
  assert.deepEqual(cloneSiteKinds(d, [L2, PROVO, LEEDS]), [
    { location_id: L2, kind: 'MADE', is_sellable: true },
    { location_id: PROVO, kind: 'PURCHASED', is_sellable: false },
    { location_id: LEEDS, kind: 'PURCHASED', is_sellable: false },
  ], 'each site as it is; a new site takes what most sites do (one of two make it: Purchased)');
  d.sites[0].supply_mode = 'to_order';
  assert.equal(cloneSiteKinds(d, [LEEDS])[0].kind, 'MADE', 'made at every site: a new site makes it too');
  assert.deepEqual(cloneSiteKinds(null, []), []);
});
