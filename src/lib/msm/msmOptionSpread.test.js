// Multi site menu round 2: the Price check for options (src/lib/msm/msmOptionSpread.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { optionSpreadRows, optionSpreadSummary } from './msmOptionSpread.js';

const central = {
  groups: [{ id: 'g1', name: 'Milk' }, { id: 'g2', name: 'Old', archived: true }],
  options: [
    { id: 'o1', group_id: 'g1', name: 'Oat milk', price: 0.4 },
    { id: 'o2', group_id: 'g1', name: 'Coconut milk', price: 0.5 },
    { id: 'o3', group_id: 'g2', name: 'Gone', price: 1 },
  ],
  optionSites: [
    { option_id: 'o1', location_id: 'a', active: true, price: null },
    { option_id: 'o1', location_id: 'b', active: true, price: 0.6 },
    { option_id: 'o1', location_id: 'c', active: true, price: null },
    { option_id: 'o2', location_id: 'a', active: true, price: null },
    { option_id: 'o2', location_id: 'b', active: true, price: 0 },
    { option_id: 'o2', location_id: 'c', active: false, price: null },
    { option_id: 'o3', location_id: 'a', active: true }, { option_id: 'o3', location_id: 'b', active: true },
  ],
};

test('option prices across sites: own price else the default, off sites left out, widest first', () => {
  const rows = optionSpreadRows(central, ['a', 'b', 'c']);
  assert.deepEqual(rows.map((r) => r.product.name), ['Coconut milk (Milk)', 'Oat milk (Milk)']);
  const oat = rows.find((r) => r.product.id === 'o1');
  assert.deepEqual([oat.min, oat.max, oat.spread, oat.median], [0.4, 0.6, 0.2, 0.4]);
  assert.deepEqual([...oat.outliers], ['b'], 'b is more than 15% off the usual price');
  const coco = rows.find((r) => r.product.id === 'o2');
  assert.equal(coco.prices.length, 2, 'site c has it off');
  assert.equal(coco.pct, null, 'a free option has no percent');
});

test('the option spread in one line', () => {
  assert.equal(optionSpreadSummary(optionSpreadRows(central, ['a', 'b', 'c'])), '2 of 2 options are priced differently between sites; the widest is Coconut milk (Milk), 0.50.');
  assert.equal(optionSpreadSummary([]), 'Every option costs the same at every site.');
});
