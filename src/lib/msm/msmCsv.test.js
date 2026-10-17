// Multi site menu: the grid as a spreadsheet, both ways (supabase/functions/_shared/msmCsv.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exportCsv, parseCsv, readCsvChanges } from '../../../supabase/functions/_shared/msmCsv.js';

const central = {
  categories: [{ id: 'hot', label: 'Hot drinks' }, { id: 'cold', label: 'Cold, fizzy' }],
  products: [
    { id: 'p1', name: 'Latte', category_id: 'hot', default_price: 2.8 },
    { id: 'p2', name: 'Large latte', category_id: 'hot', parent_product_id: 'p1', default_price: 3.2 },
    { id: 'p3', name: '=HYPERLINK("x")', category_id: 'cold', default_price: 2 },
    { id: 'p4', name: 'Old', category_id: 'hot', default_price: 1, archived: true },
  ],
  productSites: [
    { product_id: 'p1', location_id: 's1', price: null, active: true },
    { product_id: 'p1', location_id: 's2', price: 3, active: true },
    { product_id: 'p2', location_id: 's1', price: null, active: false },
    { product_id: 'p3', location_id: 's2', price: null, active: true },
  ],
};
const sites = [{ location_id: 's1', name: 'Site One' }, { location_id: 's2', name: 'Site Two' }];

test('export: Excel safe, a byte order mark, plain numbers, the column order the design says', () => {
  const csv = exportCsv(central, sites);
  assert.equal(csv.charCodeAt(0), 0xFEFF);
  const rows = parseCsv(csv);
  assert.deepEqual(rows[0], ['Central id', 'Product', 'Category', 'Size of', 'Default price', 'Site One price', 'Site One active', 'Site Two price', 'Site Two active']);
  assert.deepEqual(rows[1], ['p1', 'Latte', 'Hot drinks', '', '2.80', '', 'Yes', '3.00', 'Yes']);
  assert.deepEqual(rows[2], ['p2', 'Large latte', 'Hot drinks', 'Latte', '3.20', '', 'No', '', '']);
  assert.equal(rows[3][1], `'=HYPERLINK("x")`, 'a formula is never run by Excel');
  assert.equal(rows[3][2], 'Cold, fizzy');
  assert.equal(rows.length, 4, 'archived products are not exported');
});

test('parse: quotes, doubled quotes, commas, CRLF, a byte order mark, blank lines', () => {
  assert.deepEqual(parseCsv('﻿a,"b, c","d ""e"""\r\n\r\n1,2,3\n'), [['a', 'b, c', 'd "e"'], ['1', '2', '3']]);
});

test('import: matched by central id, prices and active only, the same before for the preview', () => {
  const text = 'Central id,Product,Category,Default price,Site One price,Site One active,Site Two price,Site Two active\r\np1,Latte,Hot drinks,2.90,,Yes,3.10,No\r\n';
  const r = readCsvChanges(text, central, sites);
  assert.deepEqual(r.changes, [
    { target: 'product', entity_id: 'p1', location_id: null, op: 'update', after: { default_price: 2.9 }, before: { default_price: 2.8 } },
    { target: 'product_site', entity_id: 'p1', location_id: 's2', op: 'update', after: { price: 3.1, active: false }, before: { price: 3, active: true } },
  ]);
  assert.equal(r.matched, 1);
});

test('import: a blank site price means "follows the default"; a site price equal to the default follows it too', () => {
  const r = readCsvChanges('Central id,Site Two price\np1,\n', central, sites);
  assert.deepEqual(r.changes, [{ target: 'product_site', entity_id: 'p1', location_id: 's2', op: 'update', after: { price: null }, before: { price: 3 } }]);
  const r2 = readCsvChanges('Central id,Site Two price\np1,2.80\n', central, sites);
  assert.deepEqual(r2.changes[0].after, { price: null });
});

test('import: matched by name and category when there is no id; never creates or deletes; errors in words', () => {
  const text = 'Product,Category,Site One active\nlatte,HOT DRINKS,no\nBrand new,Hot drinks,Yes\nLarge latte,Hot drinks,maybe\n';
  const r = readCsvChanges(text, central, sites);
  assert.deepEqual(r.changes, [{ target: 'product_site', entity_id: 'p1', location_id: 's1', op: 'update', after: { active: false }, before: { active: true } }]);
  assert.match(r.ignored[0].words, /not in the group menu \(the file never adds products\)/);
  assert.match(r.errors[0].words, /must be Yes or No/);
  assert.match(r.summary, /1 change from 2 matched rows, 1 ignored, 1 with errors/);
});

test('import: a bad or negative price is an error, never staged', () => {
  const r = readCsvChanges('Central id,Default price,Site One price\np1,abc,1\np2,-1,\n', central, sites);
  assert.equal(r.changes.length, 0);
  assert.equal(r.errors.length, 2);
});

test('import: a comma decimal (2,50) is an error, never read as 250.00', () => {
  const r = readCsvChanges('Central id,Default price,Site One price\np1,"2,50",\np3,"1,250.00",\n', central, sites);
  assert.equal(r.errors.length, 1);
  assert.ok(!r.changes.some((c) => c.entity_id === 'p1'));
  assert.ok(r.changes.some((c) => c.entity_id === 'p3' && c.after.default_price === 1250));
});
