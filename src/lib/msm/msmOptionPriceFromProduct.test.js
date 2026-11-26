// Multi site menu, 5.12.111. Peter, 26 Nov 2026: "when you are adding sub items to a new option
// group in multi site menu manager from existing products its populating as zero rather than
// inheriting from the product".
//
// "From an existing product" on the option group sheet put 0.00 in the price box, whatever the
// product cost. Menu Manager gives the option the sub item's own price. The same here now.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { optionPriceFromProduct, newOptionForm } from './msmGroupView.js';

const here = dirname(fileURLToPath(import.meta.url));
const sheet = readFileSync(join(here, '../../backoffice/sections/msm/MsmGroupSheet.jsx'), 'utf8');

test('an option made from a product starts at the product\'s own price, to two decimals', () => {
  assert.equal(optionPriceFromProduct({ default_price: 2 }), '2.00');
  assert.equal(optionPriceFromProduct({ default_price: '0.75' }), '0.75');
  assert.equal(optionPriceFromProduct({ default_price: 1.5 }), '1.50');
  // The numeric column comes back as text from the database.
  assert.equal(optionPriceFromProduct({ default_price: '5.00' }), '5.00');
});

test('no price, a free product or a bad value starts at 0.00, never blank or minus', () => {
  for (const p of [null, undefined, {}, { default_price: null }, { default_price: 0 }, { default_price: '' }, { default_price: 'abc' }, { default_price: -1 }]) {
    assert.equal(optionPriceFromProduct(p), '0.00');
  }
});

test('the option line carries that price and points at the product', () => {
  const central = { sites: [{ location_id: 'a' }, { location_id: 'b' }] };
  const pesto = { id: 'p-pesto', name: 'ADD Pesto', type: 'subitem', default_price: 2 };
  const o = newOptionForm(central, { id: 'o1', name: pesto.name, price: optionPriceFromProduct(pesto), product_id: pesto.id });
  assert.equal(o.price, '2.00');
  assert.equal(o.product_id, 'p-pesto');
  assert.deepEqual(o.sites, { a: { active: true, own: '' }, b: { active: true, own: '' } }, 'every site follows that price');
});

test('the sheet\'s picker uses the rule and no longer writes 0.00 for a picked product', () => {
  assert.match(sheet, /onPick=\{\(p\) => addOpt\(newOptionForm\(eff, \{ id: newId\(\), name: p\.menu_name \|\| p\.name, price: optionPriceFromProduct\(p\), product_id: p\.id \}\)\)\}/);
  assert.doesNotMatch(sheet, /price: '0\.00', product_id: p\.id/);
});
