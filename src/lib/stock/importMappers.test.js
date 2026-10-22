// node --test: reading import files (src/lib/stock/importMappers.js, multi site stock Drop 1).
// The sample files are small and made up: neutral names, made up prices, no real supplier or
// venue (the repo is public). Real Nory and MarketMan exports should be tried before a go live
// (contract decision 13); these pin the headings the mappers start from.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  parseCsv, chunk, ratePercent, parseRatePercent, CSV_COLUMNS, IMPORT_KINDS, STAGE_KIND, ALIASES, FIELD_WORDS, headKey,
  detectSource, fileKinds, rowsFor, csvRowsFor, mapNory, mapMarketMan, mapFile, missingWords, unusedWords,
  unitOf, numberOf, moneyOf, vatRateOf, yesNoOf, timeOf, daysOf, packOf, typeOf, allergensOf, siteLookup, sitesOf,
  recipeKindOf, foodKindOf, pctOf, orderTypesOf,
  KIND_BLOCK, fileRowOf, toStageRows, stageFile,
} from './importMappers.js';

const N1 = '10000000-0000-4000-8000-000000000001';
const N2 = '10000000-0000-4000-8000-000000000002';
const SITES = [{ id: N1, name: 'North Site' }, { id: N2, name: 'South Site' }];

// the contract's staged data shapes (contract 3.5): every staged row carries exactly these keys
const SHAPES = {
  item: ['name', 'category', 'base_unit', 'type', 'sku', 'barcode', 'purchase_vat_rate', 'allergens', 'shelf_life_days', 'count_pack'],
  supplier: ['name', 'email', 'phone', 'contact_name', 'payment_terms_days', 'account_number', 'min_order_value', 'delivery_days', 'cutoff_time'],
  supplier_item: ['supplier', 'item', 'item_sku', 'supplier_sku', 'supplier_product_name', 'pack_description', 'pack_qty', 'inner_qty', 'inner_unit',
    'pack_price', 'currency', 'purchase_vat_rate', 'price_includes_tax', 'site'],
  par: ['item', 'item_sku', 'site', 'par_level', 'reorder_point', 'min_level'],
  recipe: ['name', 'kind', 'food_kind', 'yield_qty', 'yield_unit', 'output_item', 'lines', 'sites', 'till_product'],
};
const LINE_KEYS = ['item', 'item_sku', 'qty', 'unit', 'usable_pct', 'order_types'];
const sameKeys = (row) => assert.deepEqual(Object.keys(row.data).sort(), [...SHAPES[row.kind]].sort(), `${row.kind} row ${row.row_no}`);

// -- the sample files ------------------------------------------------------------------------

const SERVOS_ITEMS = [
  'Name,Category,Base unit,Type,SKU,Barcode,Purchase VAT,Allergens,Shelf life (days),Count pack,Count pack size,Sites',
  'Oat drink 1L,Dairy & alt,ml,Drink,OAT-1,5000000000017,20%,"Oats; gluten",30,Carton,1 L,All',
  'Plain flour,Dry goods,g,Food,FL-16,,0,Gluten,180,Bag,16 kg,North Site',
  '"Sea salt, fine",Dry goods,kg,food,SALT-1,,,,365,,,North Site; South Site',
  'Paper cups 12oz,Packaging,each,Packaging,CUP-12,,20,,,Sleeve,50,',
  'Oat drink 1L,,ml,,OAT-1,,,,,,,',
  '',
].join('\r\n');

const SERVOS_SUPPLIERS = [
  'Name,Order email,Phone,Contact,Payment terms (days),Account number,Minimum order,Delivery days,Order by time,Can order',
  'Sample Dairy,orders@dairy.example,0100 000 0001,Pat Lee,30 days,AC-100,"£150.00","Mon, Wed, Fri",2pm,All',
  'Test Bakery,bread@bakery.example,,,14,,,Mon-Sat,14:30,North Site',
  'Demo Drinks,,,,,,,,,',
].join('\n');

const SERVOS_PRICES = [
  'Supplier,Item,Supplier SKU,Their name,Pack,Packs per case,Each pack holds,Unit of the pack,Price,Currency,VAT,Price includes VAT,Site',
  'Sample Dairy,Oat drink 1L,SD-OAT,Barista oat 1L,Case 6 x 1L,6,1,l,9.30,GBP,20%,No,',
  'Sample Dairy,Oat drink 1L,SD-OAT,Barista oat 1L,Case 6 x 1L,6,1,l,9.60,GBP,20%,No,South Site',
  'Test Bakery,Plain flour,TB-FL,Flour 16kg,16kg bag,1,16,kg,"£12.40",,0,,',
].join('\n');

const SERVOS_PARS = [
  'Item,Site,Par,Reorder at,Min',
  'Oat drink 1L,North Site,24,12,6',
  'Oat drink 1L,South Site,18,,',
  'Plain flour,Far Site,2,1,0',
].join('\n');

// A Nory style item list (the item screen's words: Name, Category, Type, Supplier, Supplier code,
// Pack size, Price, Storage area, Unit, plus a Location and Par level per row).
const NORY_FILE = [
  'Name,Category,Type,Unit,Supplier,Supplier code,Pack size,Price,Storage area,Location,Par level',
  'Oat drink 1L,Dairy & alt,Drinks,ml,Sample Dairy,SD-OAT,6 x 1L,9.30,Fridge,North Site,24',
  'Oat drink 1L,Dairy & alt,Drinks,ml,Sample Dairy,SD-OAT,6 x 1L,9.30,Fridge,South Site,18',
  'Plain flour,Dry goods,Food,g,Test Bakery,TB-FL,16kg,12.40,Dry store,North Site,2',
  'Lemons,Fresh produce,Food,each,Demo Greens,DG-LEM,Box of 50,8.00,Fridge,South Site,',
].join('\n');

// A MarketMan style chain export (its API names, one row per buyer and purchase item).
const MARKETMAN_FILE = [
  'Item Name,Category Name,UOM Name,Par Level,Min On Hand,Vendor Name,Product Code,Pack Qty,Packs Per Case,Price,Price With VAT,Tax Value,Scan Barcode,Buyer Name,BOM Price',
  'Whole milk 2L,Dairy,LT,20,8,Sample Dairy,SD-MILK2,2,6,10.20,12.24,20,5000000000024,North Site,0.85',
  'Whole milk 2L,Dairy,LT,16,6,Sample Dairy,SD-MILK2,2,6,10.20,12.24,20,5000000000024,South Site,0.85',
  'Coffee beans 1kg,Coffee,KG,6,2,Demo Roasters,DR-BEAN,1,,18.50,,0,,North Site,18.5',
].join('\n');

// A ServOS recipe file (Drop 2): one ingredient a line; the recipe's own fields ride on any of its
// lines; a line with no recipe name belongs to the recipe above it.
const RECIPES_FILE = [
  'Recipe name,Kind,Type,Ingredient,Qty,Unit,Usable %,Order types,Yield,Yield unit,Made item,Sites,Till product',
  'Flat white,Dish,Drink,Whole milk 2L,180,ml,,,1,portion,,North Site; South Site,Flat White',
  ',,,Coffee beans 1kg,18,g,,takeaway; dine-in,,,,,',
  'Tomato sauce,Batch,Food,Plum tomatoes,2.5,kg,92%,,2,l,Tomato sauce,All,',
  'Tomato sauce,,,Olive oil,100,ML,,,,,,,',
  'Tomato sauce,,,Basil,x,g,,,,,,,',
].join('\n');
const NORY_RECIPES = [
  'Recipe name,Recipe type,Ingredient,Quantity,UOM,Portions',
  'House granola,Sub recipe,Rolled oats,1.2,KG,10',
  'House granola,Sub recipe,Honey,200,g,10',
].join('\n');
const MARKETMAN_RECIPES = [
  'Menu Item,Ingredient,Quantity,UOM Name,Portions',
  'Americano,Coffee beans 1kg,18,GR,1',
  'Americano,Paper cups 12oz,1,EA,1',
].join('\n');

// -- reading the file --------------------------------------------------------------------------

test('parseCsv: quotes, doubled quotes, line breaks inside quotes, CR LF, a byte order mark, blank lines', () => {
  assert.deepEqual(parseCsv('﻿a,b\r\n"x, y","say ""hi"""\r\n\r\n"two\nlines",z\n'), [['a', 'b'], ['x, y', 'say "hi"'], ['two\nlines', 'z']]);
  assert.deepEqual(parseCsv('a;b;c\n1;"2;3";4'), [['a', 'b', 'c'], ['1', '2;3', '4']], 'a file saved with ;');
  assert.deepEqual(parseCsv('a\tb\n1\t2'), [['a', 'b'], ['1', '2']], 'a file saved with tabs');
  assert.deepEqual(parseCsv('a,b\n1,2', { delimiter: ';' }), [['a,b'], ['1,2']], 'the separator can be named');
  assert.deepEqual(parseCsv(''), []);
  assert.deepEqual(parseCsv(null), []);
  assert.deepEqual(parseCsv(' , \n,\nx'), [['x']], 'rows of blanks are left out');
});

test('the Phase 1 helpers: chunks of 2,000, VAT as a percent and back', () => {
  const rows = Array.from({ length: 4500 }, (_, i) => i);
  assert.deepEqual(chunk(rows).map((c) => c.length), [2000, 2000, 500]);
  assert.deepEqual(chunk(rows, 1000).length, 5);
  assert.deepEqual(chunk([]), []);
  assert.deepEqual(chunk(null), []);
  assert.equal(ratePercent(0.2), '20%');
  assert.equal(ratePercent(0.125), '12.5%');
  assert.equal(ratePercent(null), '');
  assert.equal(parseRatePercent('20'), 0.2);
  assert.equal(parseRatePercent('12.5%'), 0.125);
  assert.equal(parseRatePercent(''), null);
  assert.ok(Number.isNaN(parseRatePercent('lots')));
  assert.ok(Number.isNaN(parseRatePercent('100')));
});

test('the kinds and their fields: items, suppliers, supplier items, pars and (Drop 2) recipes for real', () => {
  assert.deepEqual([...IMPORT_KINDS], ['items', 'suppliers', 'supplier_items', 'pars', 'recipes']);
  assert.deepEqual({ ...STAGE_KIND }, { items: 'item', suppliers: 'supplier', supplier_items: 'supplier_item', pars: 'par', recipes: 'recipe' });
  assert.equal(CSV_COLUMNS.recipes.skip, undefined, 'recipes are no longer skipped');
  assert.deepEqual([...CSV_COLUMNS.recipes.required], ['name', 'ingredient', 'qty', 'unit']);
  assert.deepEqual([...CSV_COLUMNS.recipes.fields], ['name', 'kind', 'type', 'ingredient', 'item_sku', 'qty', 'unit', 'usable_pct', 'order_types', 'yield_qty', 'yield_unit', 'made_item', 'sites', 'till_product']);
  for (const src of ['csv', 'nory', 'marketman']) for (const f of ['name', 'ingredient', 'qty', 'unit', 'yield_qty']) assert.ok(ALIASES[src].recipes[f]?.length, `${src} recipes ${f}`);
  assert.ok(ALIASES.nory.recipes.qty.includes('quantity') && ALIASES.nory.recipes.unit.includes('uom') && ALIASES.nory.recipes.yield_qty.includes('portions'));
  assert.ok(ALIASES.marketman.recipes.name.includes('recipe name') && ALIASES.marketman.recipes.ingredient.includes('ingredient'));
  for (const k of IMPORT_KINDS) {
    for (const f of CSV_COLUMNS[k].fields) assert.ok(FIELD_WORDS[f], `${k}.${f} has plain words`);
    for (const f of CSV_COLUMNS[k].required) assert.ok(CSV_COLUMNS[k].fields.includes(f));
    for (const src of ['csv', 'nory', 'marketman']) for (const f of Object.keys(ALIASES[src][k] || {})) assert.ok(CSV_COLUMNS[k].fields.includes(f), `${src}.${k}.${f}`);
  }
  assert.equal(headKey(' UOM Name '), 'uomname');
  assert.equal(headKey('uom_name'), 'uomname');
  assert.equal(headKey('VAT (%)'), 'vat%');
  assert.equal(headKey('Account #'), 'account#');
  assert.equal(missingWords(['supplier', ['pack_price', 'price_with_vat']]), 'These columns are missing: Supplier, Price or Price with VAT.');
  assert.equal(missingWords([]), '');
  assert.equal(unusedWords(['Storage area', '', 'BOM Price']), 'These columns were not used: Storage area, BOM Price.');
  assert.equal(unusedWords([]), '');
});

test('where a file came from, by its headings', () => {
  assert.equal(detectSource(parseCsv(NORY_FILE)[0]), 'nory');
  assert.equal(detectSource(parseCsv(MARKETMAN_FILE)[0]), 'marketman');
  assert.equal(detectSource(parseCsv(SERVOS_ITEMS)[0]), 'csv');
  assert.equal(detectSource(parseCsv(SERVOS_PRICES)[0]), 'csv', 'our own price list, even with a pack column');
  assert.equal(detectSource(['Name', 'Price']), 'csv', 'too little to tell: ours');
  assert.equal(detectSource(null), 'csv');
});

test('which kinds a file feeds: an item list, a supplier list, a price list, a par list, an export, recipes', () => {
  const head = (t) => parseCsv(t)[0];
  assert.deepEqual(fileKinds('csv', head(SERVOS_ITEMS)), ['items']);
  assert.deepEqual(fileKinds('csv', head(SERVOS_SUPPLIERS)), ['suppliers']);
  assert.deepEqual(fileKinds('csv', head(SERVOS_PRICES)), ['suppliers', 'supplier_items'], 'a price list never makes items from its SKU column');
  assert.deepEqual(fileKinds('csv', head(SERVOS_PARS)), ['pars']);
  assert.deepEqual(fileKinds('nory', head(NORY_FILE)), ['items', 'suppliers', 'supplier_items', 'pars']);
  assert.deepEqual(fileKinds('marketman', head(MARKETMAN_FILE)), ['items', 'suppliers', 'supplier_items', 'pars']);
  assert.deepEqual(fileKinds('csv', head(RECIPES_FILE)), ['recipes']);
  assert.deepEqual(fileKinds('csv', ['Name']), ['items'], 'a list of names is an item list');
  assert.deepEqual(fileKinds('csv', ['Colour', 'Size']), []);
});

// -- a ServOS CSV of each kind ------------------------------------------------------------------

test('a ServOS item list: headings matched, repeated rows folded, values read, the contract shape staged', () => {
  const table = parseCsv(SERVOS_ITEMS);
  const r = csvRowsFor('items', table);
  assert.deepEqual(r.missing, []);
  assert.deepEqual(r.unknown, []);
  assert.equal(r.merged, 1, 'Oat drink 1L twice with the same unit and SKU is one item');
  assert.deepEqual(r.rows.map((x) => [x._row, x.name]), [[2, 'Oat drink 1L'], [3, 'Plain flour'], [4, 'Sea salt, fine'], [5, 'Paper cups 12oz']]);
  const problems = [];
  const staged = toStageRows('items', r.rows, { siteIdByName: SITES, problems });
  staged.forEach(sameKeys);
  assert.deepEqual(staged[0], {
    row_no: 2, kind: 'item', sites: [N1, N2],
    data: { name: 'Oat drink 1L', category: 'Dairy & alt', base_unit: 'ml', type: 'drink', sku: 'OAT-1', barcode: '5000000000017',
      purchase_vat_rate: 0.2, allergens: ['gluten'], shelf_life_days: 30, count_pack: { name: 'Carton', qty_in_base: 1000 } },
  });
  assert.deepEqual(staged[1].data.count_pack, { name: 'Bag', qty_in_base: 16000 }, '16 kg in grams');
  assert.equal(staged[1].data.purchase_vat_rate, 0);
  assert.deepEqual(staged[1].sites, [N1]);
  assert.deepEqual(staged[2].sites, [N1, N2], 'names split by ;');
  assert.equal(staged[2].data.type, 'food');
  assert.equal(staged[3].data.type, 'other');
  assert.deepEqual(staged[3].data.count_pack, { name: 'Sleeve', qty_in_base: 50 });
  assert.equal(staged[3].sites, null, 'no sites named: the sites ticked on the check screen');
  assert.deepEqual(problems.map((p) => p.words), ['Row 2: "Oats" is not one of the 14 allergens. Left out.']);
});

test('a ServOS supplier list: days, times, money and terms read; sites by name', () => {
  const r = csvRowsFor('suppliers', parseCsv(SERVOS_SUPPLIERS));
  assert.deepEqual(r.missing, []);
  assert.deepEqual(r.unknown, []);
  const problems = [];
  const staged = toStageRows('suppliers', r.rows, { siteIdByName: SITES, problems });
  staged.forEach(sameKeys);
  assert.deepEqual(staged[0], {
    row_no: 2, kind: 'supplier', sites: [N1, N2],
    data: { name: 'Sample Dairy', email: 'orders@dairy.example', phone: '0100 000 0001', contact_name: 'Pat Lee', payment_terms_days: 30,
      account_number: 'AC-100', min_order_value: 150, delivery_days: ['mon', 'wed', 'fri'], cutoff_time: '14:00' },
  });
  assert.deepEqual(staged[1].data.delivery_days, ['mon', 'tue', 'wed', 'thu', 'fri', 'sat']);
  assert.equal(staged[1].data.cutoff_time, '14:30');
  assert.equal(staged[1].data.payment_terms_days, 14);
  assert.deepEqual(staged[1].sites, [N1]);
  assert.deepEqual(staged[2].data, { name: 'Demo Drinks', email: null, phone: null, contact_name: null, payment_terms_days: null, account_number: null,
    min_order_value: null, delivery_days: [], cutoff_time: null });
  assert.deepEqual(problems, []);
});

test('a ServOS price list: the pack from its columns, a price at one site kept apart, prices with a symbol', () => {
  const r = csvRowsFor('supplier_items', parseCsv(SERVOS_PRICES));
  assert.deepEqual(r.missing, []);
  assert.deepEqual(r.unknown, []);
  assert.equal(r.rows.length, 3, 'the South Site price is its own row');
  const staged = toStageRows('supplier_items', r.rows, { siteIdByName: SITES });
  staged.forEach(sameKeys);
  assert.deepEqual(staged[0].data, {
    supplier: 'Sample Dairy', item: 'Oat drink 1L', item_sku: null, supplier_sku: 'SD-OAT', supplier_product_name: 'Barista oat 1L',
    pack_description: 'Case 6 x 1L', pack_qty: 6, inner_qty: 1, inner_unit: 'l', pack_price: 9.3, currency: 'GBP',
    purchase_vat_rate: 0.2, price_includes_tax: false, site: null,
  });
  assert.equal(staged[1].data.site, 'South Site');
  assert.equal(staged[1].data.pack_price, 9.6);
  assert.deepEqual([staged[2].data.pack_qty, staged[2].data.inner_qty, staged[2].data.inner_unit, staged[2].data.pack_price, staged[2].data.currency],
    [1, 16, 'kg', 12.4, 'GBP'], 'the pound sign says GBP');
  assert.ok(staged.every((s) => s.sites === null));
});

test('a ServOS par list: numbers read, an empty value stays empty, a site that does not exist is said', () => {
  const r = csvRowsFor('pars', parseCsv(SERVOS_PARS));
  assert.deepEqual(r.missing, []);
  const problems = [];
  const staged = toStageRows('pars', r.rows, { siteIdByName: SITES, problems });
  staged.forEach(sameKeys);
  assert.deepEqual(staged.map((s) => s.data), [
    { item: 'Oat drink 1L', item_sku: null, site: 'North Site', par_level: 24, reorder_point: 12, min_level: 6 },
    { item: 'Oat drink 1L', item_sku: null, site: 'South Site', par_level: 18, reorder_point: null, min_level: null },
    { item: 'Plain flour', item_sku: null, site: 'Far Site', par_level: 2, reorder_point: 1, min_level: 0 },
  ]);
  assert.deepEqual(problems.map((p) => p.words), ['Row 4: no site called "Far Site".']);
});

test('a file without a required column says which, in plain words', () => {
  const r = csvRowsFor('supplier_items', parseCsv('Supplier,Pack\nSample Dairy,6 x 1L'));
  assert.deepEqual(r.missing, ['item', ['pack_price', 'price_with_vat']]);
  assert.equal(missingWords(r.missing), 'These columns are missing: Item, Price or Price with VAT.');
  assert.deepEqual(csvRowsFor('pars', parseCsv('Item,Site\nx,y')).missing, [['par_level', 'reorder_point', 'min_level']]);
  assert.deepEqual(csvRowsFor('items', []).missing, ['name']);
  assert.deepEqual(csvRowsFor('nothing', parseCsv(SERVOS_ITEMS)), { rows: [], missing: [], unknown: [], merged: 0 });
});

// -- Nory and MarketMan --------------------------------------------------------------------------

test('a Nory list: items once each (ticked where their rows are), suppliers once each, packs read, pars per site', () => {
  const table = parseCsv(NORY_FILE);
  const items = mapNory('items', table);
  assert.deepEqual(items.rows.map((r) => [r.name, r._sites]), [['Oat drink 1L', ['North Site', 'South Site']], ['Plain flour', ['North Site']], ['Lemons', ['South Site']]]);
  const m = mapFile(table);
  assert.equal(m.source, 'nory');
  assert.deepEqual(m.order, ['items', 'suppliers', 'supplier_items', 'pars']);
  assert.deepEqual(m.unknown, ['Storage area']);
  const { rows, problems, counts } = stageFile(m, { siteIdByName: SITES });
  rows.forEach(sameKeys);
  assert.deepEqual(counts, { item: 3, supplier: 3, supplier_item: 3, par: 3 });
  assert.deepEqual(problems, []);
  const item = rows.find((r) => r.kind === 'item' && r.data.name === 'Oat drink 1L');
  assert.deepEqual([item.data.type, item.data.base_unit, item.data.category, item.sites], ['drink', 'ml', 'Dairy & alt', [N1, N2]]);
  assert.deepEqual(rows.filter((r) => r.kind === 'supplier').map((r) => r.data.name), ['Sample Dairy', 'Test Bakery', 'Demo Greens']);
  const oat = rows.find((r) => r.kind === 'supplier_item' && r.data.supplier_sku === 'SD-OAT');
  assert.deepEqual([oat.data.pack_qty, oat.data.inner_qty, oat.data.inner_unit, oat.data.pack_price, oat.data.pack_description], [6, 1, 'l', 9.3, '6 x 1L']);
  const flour = rows.find((r) => r.kind === 'supplier_item' && r.data.supplier_sku === 'TB-FL');
  assert.deepEqual([flour.data.pack_qty, flour.data.inner_qty, flour.data.inner_unit], [1, 16, 'kg']);
  const lemons = rows.find((r) => r.kind === 'supplier_item' && r.data.supplier_sku === 'DG-LEM');
  assert.deepEqual([lemons.data.pack_qty, lemons.data.inner_qty, lemons.data.inner_unit], [50, 1, 'each'], 'Box of 50, in the item unit');
  assert.deepEqual(rows.filter((r) => r.kind === 'par').map((r) => [r.data.item, r.data.site, r.data.par_level]),
    [['Oat drink 1L', 'North Site', 24], ['Oat drink 1L', 'South Site', 18], ['Plain flour', 'North Site', 2]], 'a row with no par makes no par');
});

test('a MarketMan export: UOM codes, pack qty and packs per case, the buyer as the site, BOM price not used', () => {
  const table = parseCsv(MARKETMAN_FILE);
  const m = mapFile(table);
  assert.equal(m.source, 'marketman');
  assert.deepEqual(m.unknown, ['BOM Price']);
  const { rows, problems, counts } = stageFile(m, { siteIdByName: SITES });
  rows.forEach(sameKeys);
  assert.deepEqual(problems, []);
  assert.deepEqual(counts, { item: 2, supplier: 2, supplier_item: 2, par: 3 });
  const milk = rows.find((r) => r.kind === 'item' && r.data.name === 'Whole milk 2L');
  assert.deepEqual([milk.data.base_unit, milk.data.category, milk.data.barcode, milk.data.purchase_vat_rate, milk.sites], ['l', 'Dairy', '5000000000024', 0.2, [N1, N2]]);
  const pack = rows.find((r) => r.kind === 'supplier_item' && r.data.supplier_sku === 'SD-MILK2');
  assert.deepEqual([pack.data.pack_qty, pack.data.inner_qty, pack.data.inner_unit, pack.data.pack_price, pack.data.price_includes_tax], [6, 2, 'l', 10.2, false]);
  const beans = rows.find((r) => r.kind === 'supplier_item' && r.data.supplier_sku === 'DR-BEAN');
  assert.deepEqual([beans.data.pack_qty, beans.data.inner_qty, beans.data.inner_unit, beans.data.purchase_vat_rate], [1, 1, 'kg', 0]);
  assert.deepEqual(rows.filter((r) => r.kind === 'par').map((r) => [r.data.site, r.data.par_level, r.data.min_level]),
    [['North Site', 20, 8], ['South Site', 16, 6], ['North Site', 6, 2]]);
  // only the price with VAT: read as including VAT
  const inc = toStageRows('supplier_items', mapMarketMan('supplier_items', parseCsv('Vendor Name,Item Name,UOM Name,Price With VAT\nSample Dairy,Whole milk 2L,LT,12.24')).rows);
  assert.deepEqual([inc[0].data.pack_price, inc[0].data.price_includes_tax], [12.24, true]);
});

test('an export with one row per site: one company price, and a site\'s own price only where it differs', () => {
  const file = [
    'Vendor Name,Item Name,UOM Name,Product Code,Pack Qty,Packs Per Case,Price,Buyer Name',
    'Sample Dairy,Whole milk 2L,LT,SD-MILK2,2,6,10.20,North Site',
    'Sample Dairy,Whole milk 2L,LT,SD-MILK2,2,6,10.50,South Site',
    'Sample Dairy,Whole milk 2L,LT,SD-MILK2,2,6,10.20,West Site',
  ].join('\n');
  const r = mapMarketMan('supplier_items', parseCsv(file));
  assert.deepEqual(r.rows.map((x) => [x._row, x.site ?? null, x.pack_price]), [[2, null, '10.20'], [3, 'South Site', '10.50']]);
  assert.equal(r.merged, 1, 'West Site pays the company price: it follows it');
  // the same rows in a ServOS file: each Site row is that site's price, as written
  const ours = csvRowsFor('supplier_items', parseCsv(file.replace('Vendor Name', 'Supplier').replace('Item Name', 'Item').replace('Buyer Name', 'Site')));
  assert.deepEqual(ours.rows.map((x) => x.site), ['North Site', 'South Site', 'West Site']);
});

test('a ServOS recipe file: one ingredient a line, the name filled down, ONE staged row per recipe with its lines (Drop 2)', () => {
  const m = mapFile(parseCsv(RECIPES_FILE));
  assert.deepEqual(m.order, ['recipes']);
  assert.deepEqual(m.unknown, []);
  const read = csvRowsFor('recipes', parseCsv(RECIPES_FILE));
  assert.equal(read.rows.length, 5, 'every ingredient line stays: nothing is folded');
  assert.equal(read.merged, 0);
  assert.equal(read.rows[1].name, 'Flat white', 'a line with no name belongs to the recipe above it');
  assert.deepEqual(read.missing, []);
  const problems = [];
  const rows = toStageRows('recipes', read.rows, { siteIdByName: SITES, problems });
  assert.equal(rows.length, 2, 'one staged row per recipe');
  for (const r of rows) { sameKeys(r); for (const l of r.data.lines) assert.deepEqual(Object.keys(l).sort(), [...LINE_KEYS].sort()); }
  const [fw, ts] = rows;
  assert.equal(fw.row_no, 2, 'the recipe\'s first line in the file');
  assert.equal(fw.kind, 'recipe');
  assert.deepEqual(fw.data, {
    name: 'Flat white', kind: 'dish', food_kind: 'drink', yield_qty: 1, yield_unit: 'each', output_item: null, till_product: 'Flat White',
    lines: [
      { item: 'Whole milk 2L', item_sku: null, qty: 180, unit: 'ml', usable_pct: null, order_types: [] },
      { item: 'Coffee beans 1kg', item_sku: null, qty: 18, unit: 'g', usable_pct: null, order_types: ['takeaway', 'dine-in'] },
    ],
    sites: ['North Site', 'South Site'],
  });
  assert.deepEqual(fw.sites, [N1, N2], 'the sites it names, as ids');
  assert.equal(ts.row_no, 4);
  assert.deepEqual(ts.data, {
    name: 'Tomato sauce', kind: 'batch', food_kind: 'food', yield_qty: 2, yield_unit: 'l', output_item: 'Tomato sauce', till_product: null,
    lines: [
      { item: 'Plum tomatoes', item_sku: null, qty: 2.5, unit: 'kg', usable_pct: 92, order_types: [] },
      { item: 'Olive oil', item_sku: null, qty: 100, unit: 'ml', usable_pct: null, order_types: [] },
      { item: 'Basil', item_sku: null, qty: null, unit: 'g', usable_pct: null, order_types: [] },
    ],
    sites: ['All'],
  });
  assert.deepEqual(ts.sites, [N1, N2], 'All = every site');
  assert.deepEqual(problems.map((p) => p.words), ['Row 6: "x" is not an amount. Left empty.']);
  // the whole file: its own block of row numbers, and a count the check screen can show
  const staged = stageFile(m, { siteIdByName: SITES });
  assert.deepEqual(staged.counts, { recipe: 2 });
  assert.deepEqual(staged.rows.map((r) => r.row_no), [KIND_BLOCK.recipe + 2, KIND_BLOCK.recipe + 4]);
  assert.equal(staged.problems.length, 1);
  // a recipe file without a unit column says so in plain words
  assert.equal(missingWords(csvRowsFor('recipes', parseCsv('Recipe,Ingredient,Qty\nSoup,Onion,2')).missing), 'These columns are missing: Unit.');
  // a 'Type' column that says Batch or Prep is the kind, not food or drink
  const typed = toStageRows('recipes', csvRowsFor('recipes', parseCsv('Recipe name,Type,Ingredient,Qty,Unit\nStock,Prep,Bones,2,kg')).rows, { problems: [] });
  assert.equal(typed[0].data.kind, 'prep');
  assert.equal(typed[0].data.food_kind, null);
  // a unit ServOS does not know goes as typed, so the database can say so (or match a pack name)
  const odd = toStageRows('recipes', csvRowsFor('recipes', parseCsv('Recipe name,Ingredient,Qty,Unit\nLatte,Oat drink 1L,1,carton')).rows, {});
  assert.equal(odd[0].data.lines[0].unit, 'carton');
  // a site that does not exist, a kind or a yield that cannot be read: said, and left empty
  const said = [];
  const bad = toStageRows('recipes', csvRowsFor('recipes', parseCsv('Recipe name,Kind,Ingredient,Qty,Unit,Yield,Sites\nSoup,Starter,Onion,2,kg,lots,Far Site')).rows, { siteIdByName: SITES, problems: said });
  assert.equal(bad[0].data.kind, 'dish');
  assert.equal(bad[0].data.yield_qty, null);
  assert.deepEqual(bad[0].data.sites, ['Far Site']);
  assert.deepEqual(bad[0].sites, [], 'no known site: an empty list, as every other kind (the problem line names it)');
  assert.equal(toStageRows('recipes', csvRowsFor('recipes', parseCsv('Recipe name,Ingredient,Qty,Unit\nSoup,Onion,2,kg')).rows, { siteIdByName: SITES })[0].sites, null, 'no sites column: the job\'s ticked sites apply');
  assert.deepEqual(said.map((p) => p.words), ['Row 2: kind "Starter" is not Dish, Batch or Prep. Read as Dish.', 'Row 2: "lots" is not a yield. Left empty.', 'Row 2: no site called "Far Site".']);
});

test('Nory and MarketMan recipe exports: recipe name, ingredient, quantity, uom and portions', () => {
  const nory = mapNory('recipes', parseCsv(NORY_RECIPES));
  assert.deepEqual(nory.missing, []);
  const n = toStageRows('recipes', nory.rows, {});
  assert.equal(n.length, 1);
  assert.equal(n[0].data.name, 'House granola');
  assert.equal(n[0].data.kind, 'prep', 'Sub recipe is a prep');
  assert.equal(n[0].data.yield_qty, 10, 'Portions is the yield');
  assert.deepEqual(n[0].data.lines.map((l) => [l.item, l.qty, l.unit]), [['Rolled oats', 1.2, 'kg'], ['Honey', 200, 'g']]);
  const mm = mapMarketMan('recipes', parseCsv(MARKETMAN_RECIPES));
  assert.deepEqual(mm.missing, []);
  const m = toStageRows('recipes', mm.rows, {});
  assert.equal(m[0].data.name, 'Americano', 'Menu Item is the recipe name');
  assert.equal(m[0].data.kind, 'dish');
  assert.deepEqual(m[0].data.lines.map((l) => [l.item, l.qty, l.unit]), [['Coffee beans 1kg', 18, 'g'], ['Paper cups 12oz', 1, 'each']]);
  assert.deepEqual(fileKinds('marketman', parseCsv(MARKETMAN_RECIPES)[0]), ['recipes']);
  assert.deepEqual(fileKinds('nory', parseCsv(NORY_RECIPES)[0]), ['recipes']);
});

test('recipe values as people type them: kind, type, percent, order types', () => {
  assert.equal(recipeKindOf('Dish'), 'dish');
  assert.equal(recipeKindOf('menu item'), 'dish');
  assert.equal(recipeKindOf('BATCH'), 'batch');
  assert.equal(recipeKindOf('Sub-recipe'), 'prep');
  assert.equal(recipeKindOf('prep'), 'prep');
  assert.equal(recipeKindOf(''), null);
  assert.equal(recipeKindOf('Starter'), undefined);
  assert.equal(foodKindOf('Food'), 'food');
  assert.equal(foodKindOf('Beverage'), 'drink');
  assert.equal(foodKindOf('Meal deal'), 'meal_deal');
  assert.equal(foodKindOf('combo'), 'meal_deal');
  assert.equal(foodKindOf(null), null);
  assert.equal(foodKindOf('Packaging'), undefined);
  assert.equal(pctOf('92%'), 92);
  assert.equal(pctOf(' 0 '), 0);
  assert.equal(pctOf(''), null);
  assert.ok(Number.isNaN(pctOf('120')));
  assert.ok(Number.isNaN(pctOf('lots')));
  assert.deepEqual(orderTypesOf('Takeaway; Dine-in, takeaway'), ['takeaway', 'dine-in']);
  assert.deepEqual(orderTypesOf(''), []);
  assert.deepEqual(orderTypesOf('delivery and collection'), ['delivery', 'collection']);
});

test('a file of several kinds stages every item before the supplier items and pars that name it', () => {
  const { rows } = stageFile(mapFile(parseCsv(NORY_FILE)), { siteIdByName: SITES });
  const order = ['item', 'supplier', 'supplier_item', 'par'];
  const sorted = [...rows].sort((a, b) => a.row_no - b.row_no);
  for (let i = 1; i < sorted.length; i++) assert.ok(order.indexOf(sorted[i - 1].kind) <= order.indexOf(sorted[i].kind), 'kinds in order');
  assert.equal(new Set(rows.map((r) => r.row_no)).size, rows.length, 'row numbers never repeat');
  for (const r of rows) assert.ok(fileRowOf(r.row_no) >= 2 && fileRowOf(r.row_no) <= 5, 'the line in the file comes back');
  assert.equal(fileRowOf(3000004), 4);
  assert.equal(fileRowOf(7), 7, 'one kind: the row number is the line');
  assert.equal(fileRowOf('x'), null);
  assert.ok(Object.values(KIND_BLOCK).every((b) => b + 999999 < 2147483647), 'fits the integer row_no column');
  // a file with only one kind keeps plain line numbers
  assert.deepEqual(toStageRows('pars', csvRowsFor('pars', parseCsv(SERVOS_PARS)).rows).map((r) => r.row_no), [2, 3, 4]);
});

test('a value that cannot be read is said, and left empty: the row still goes to the check screen', () => {
  const problems = [];
  const staged = toStageRows('items', [{ _row: 7, name: 'Odd thing', base_unit: 'box', type: 'Bakery', purchase_vat: 'lots', shelf_life_days: 'soon', sites: 'North Site; Lost Site' }],
    { siteIdByName: SITES, problems });
  assert.deepEqual(staged[0].data, { name: 'Odd thing', category: null, base_unit: null, type: null, sku: null, barcode: null, purchase_vat_rate: null,
    allergens: [], shelf_life_days: null, count_pack: null });
  assert.deepEqual(staged[0].sites, [N1]);
  assert.deepEqual(problems.map((p) => p.words), [
    'Row 7: "box" is not a unit we know (each, g, kg, ml, l and so on). Left empty.',
    'Row 7: type "Bakery" is not Food, Drink or Other. Left empty.',
    'Row 7: "lots" is not a VAT rate. Left empty.',
    'Row 7: "soon" is not a number of days. Left empty.',
    'Row 7: no site called "Lost Site".',
  ]);
  const p2 = [];
  toStageRows('supplier_items', [{ _row: 3, supplier: 'S', item: 'I', pack_size: 'a few', pack_price: 'free', includes_vat: 'maybe', currency: 'pounds' }], { problems: p2 });
  assert.deepEqual(p2.map((p) => p.words), [
    'Row 3: could not read the pack size "a few".',
    'Row 3: "maybe" is not yes or no. Read as no.',
    'Row 3: "free" is not a price.',
    'Row 3: "pounds" is not a currency such as GBP. Left empty.',
  ]);
  const p3 = [];
  toStageRows('suppliers', [{ _row: 2, name: 'S', delivery_days: 'Mon; Funday', cutoff_time: 'late', min_order_value: 'lots', payment_terms_days: 'monthly' }], { problems: p3 });
  assert.equal(p3.length, 4);
  for (const p of [...problems, ...p2, ...p3]) assert.doesNotMatch(p.words, /[\u2013\u2014]/);
});

// -- values ------------------------------------------------------------------------------------

test('units as people type them', () => {
  assert.equal(unitOf('KG'), 'kg');
  assert.equal(unitOf('Litre'), 'l');
  assert.equal(unitOf('LT'), 'l');
  assert.equal(unitOf('EA'), 'each');
  assert.equal(unitOf('btl'), 'each');
  assert.equal(unitOf('fl oz'), 'floz');
  assert.equal(unitOf('grams'), 'g');
  assert.equal(unitOf('ml.'), 'ml');
  assert.equal(unitOf('dozen'), 'dozen');
  assert.equal(unitOf(''), null);
  assert.equal(unitOf('box'), undefined);
});

test('numbers, prices, VAT, yes or no', () => {
  assert.equal(numberOf(' 12 '), 12);
  assert.equal(numberOf('1,250.5'), 1250.5);
  assert.equal(numberOf(''), null);
  assert.ok(Number.isNaN(numberOf('ten')));
  assert.deepEqual(moneyOf('£1.38'), { amount: 1.38, currency: 'GBP' });
  assert.deepEqual(moneyOf('USD 3.35'), { amount: 3.35, currency: 'USD' });
  assert.deepEqual(moneyOf('2.50 eur'), { amount: 2.5, currency: 'EUR' });
  assert.deepEqual(moneyOf('$1,234.50'), { amount: 1234.5, currency: 'USD' });
  assert.deepEqual(moneyOf(''), { amount: null, currency: null });
  assert.ok(Number.isNaN(moneyOf('-2').amount), 'a price is never below 0');
  assert.ok(Number.isNaN(moneyOf('abc').amount));
  assert.ok(Number.isNaN(moneyOf('£').amount));
  assert.equal(vatRateOf('20%'), 0.2);
  assert.equal(vatRateOf('20'), 0.2);
  assert.equal(vatRateOf('0.2'), 0.2);
  assert.equal(vatRateOf('Standard rate 20%'), 0.2);
  assert.equal(vatRateOf('12.5'), 0.125);
  assert.equal(vatRateOf('0.5%'), 0.005);
  assert.equal(vatRateOf('zero'), 0);
  assert.equal(vatRateOf('Exempt'), 0);
  assert.equal(vatRateOf(''), null);
  assert.ok(Number.isNaN(vatRateOf('lots')));
  assert.ok(Number.isNaN(vatRateOf('150')));
  assert.equal(yesNoOf('Yes'), true);
  assert.equal(yesNoOf('inc VAT'), true);
  assert.equal(yesNoOf('0'), false);
  assert.equal(yesNoOf('ex'), false);
  assert.equal(yesNoOf(''), null);
  assert.equal(yesNoOf('maybe'), undefined);
});

test('times, delivery days, packs, types, allergens', () => {
  assert.equal(timeOf('14:00'), '14:00');
  assert.equal(timeOf('9.30'), '09:30');
  assert.equal(timeOf('1400'), '14:00');
  assert.equal(timeOf('2pm'), '14:00');
  assert.equal(timeOf('2:30 PM'), '14:30');
  assert.equal(timeOf('12am'), '00:00');
  assert.equal(timeOf('12pm'), '12:00');
  assert.equal(timeOf('14:00:00'), '14:00');
  assert.equal(timeOf(''), null);
  assert.equal(timeOf('24:00'), undefined);
  assert.equal(timeOf('late'), undefined);
  assert.deepEqual(daysOf('Fri; Mon, wed'), { days: ['mon', 'wed', 'fri'], bad: [] }, 'week order');
  assert.deepEqual(daysOf('Monday Thursday').days, ['mon', 'thu']);
  assert.deepEqual(daysOf('Mon to Wed and Sat').days, ['mon', 'tue', 'wed', 'sat']);
  assert.deepEqual(daysOf('Fri-Mon').days, ['mon', 'fri', 'sat', 'sun'], 'a range over the weekend');
  assert.deepEqual(daysOf('Daily').days, ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
  assert.deepEqual(daysOf('Weekdays').days, ['mon', 'tue', 'wed', 'thu', 'fri']);
  assert.deepEqual(daysOf('1, 7').days, ['mon', 'sun'], 'ISO numbers');
  assert.deepEqual(daysOf('Mon; Funday'), { days: ['mon'], bad: ['funday'] });
  assert.deepEqual(daysOf(''), { days: [], bad: [] });
  assert.deepEqual(packOf('6 x 1L'), { pack_qty: 6, inner_qty: 1, inner_unit: 'l' });
  assert.deepEqual(packOf('12x330 ml'), { pack_qty: 12, inner_qty: 330, inner_unit: 'ml' });
  assert.deepEqual(packOf('2 × 2.5kg'), { pack_qty: 2, inner_qty: 2.5, inner_unit: 'kg' });
  assert.deepEqual(packOf('5kg'), { pack_qty: 1, inner_qty: 5, inner_unit: 'kg' });
  assert.deepEqual(packOf('Case of 12'), { pack_qty: 12, inner_qty: 1, inner_unit: null });
  assert.deepEqual(packOf('24'), { pack_qty: 1, inner_qty: 24, inner_unit: null });
  assert.deepEqual(packOf('1 X 12 EA'), { pack_qty: 1, inner_qty: 12, inner_unit: 'each' });
  assert.equal(packOf(''), null);
  assert.equal(packOf('a few'), undefined);
  assert.equal(packOf('6 x 1 crate'), undefined);
  assert.equal(typeOf('Beverage'), 'drink');
  assert.equal(typeOf('FOOD'), 'food');
  assert.equal(typeOf('Packaging'), 'other');
  assert.equal(typeOf(''), null);
  assert.equal(typeOf('Bakery'), undefined);
  assert.deepEqual(allergensOf('Milk; Gluten, soya and tree nuts'), { ids: ['milk', 'gluten', 'soy', 'nuts'], bad: [] });
  assert.deepEqual(allergensOf('Dairy, dairy'), { ids: ['milk'], bad: [] });
  assert.deepEqual(allergensOf('None'), { ids: [], bad: [] });
  assert.deepEqual(allergensOf('celery; glitter'), { ids: ['celery'], bad: ['glitter'] });
});

test('sites: All, names split by ;, case blind, by id too; an empty cell means the job\'s sites', () => {
  const look = siteLookup(SITES);
  assert.deepEqual(sitesOf('All', look), { ids: [N1, N2], unknown: [] });
  assert.deepEqual(sitesOf('all sites', look).ids, [N1, N2]);
  assert.deepEqual(sitesOf('south site; NORTH SITE', look), { ids: [N2, N1], unknown: [] });
  assert.deepEqual(sitesOf(`${N2}`, look), { ids: [N2], unknown: [] });
  assert.deepEqual(sitesOf('North Site; Moon Base', look), { ids: [N1], unknown: ['Moon Base'] });
  assert.deepEqual(sitesOf('', look), { ids: null, unknown: [] });
  assert.deepEqual(sitesOf(['North Site', ''], look).ids, [N1]);
  assert.deepEqual([...siteLookup(new Map([['North Site', N1]]))], [['north site', N1]]);
  assert.deepEqual([...siteLookup({ 'South Site': N2 })], [['south site', N2]]);
  assert.equal(siteLookup(null).size, 0);
});

test('the module is plain words, no long dashes, no payment provider names (house rules)', () => {
  const src = fs.readFileSync(new URL('./importMappers.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /[\u2013\u2014]/);
  assert.doesNotMatch(src, new RegExp(['s', 'tripe'].join(''), 'i'), 'no payment provider name (never written out in new code)');
  assert.doesNotMatch(src, /from '\.\.\/supabase|from '\.\/data|fetch\(/, 'pure: no database, no network');
  assert.equal(rowsFor('csv', 'items', parseCsv(SERVOS_ITEMS)).rows.length, csvRowsFor('items', parseCsv(SERVOS_ITEMS)).rows.length);
});
