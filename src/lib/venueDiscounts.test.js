import { test } from 'node:test';
import assert from 'node:assert/strict';
import { venueDiscountList } from './venueDiscounts.js';

test('a venue with no discounts of its own shows none (no built-in starter set)', () => {
  assert.deepEqual(venueDiscountList([]), []);
  assert.deepEqual(venueDiscountList(null), []);
  assert.deepEqual(venueDiscountList(undefined), []);
  const labels = venueDiscountList([]).map((d) => d.label);
  assert.ok(!labels.includes('Happy hour 20%'));
});

test('shows only active discounts with a value, in Back Office order', () => {
  const list = venueDiscountList([
    { id: 'b', name: 'NHS / Blue Light', type: 'percent', value: '10', sortOrder: 2 },
    { id: 'a', name: 'Staff 50%', type: 'percent', value: 50, sortOrder: 1 },
    { id: 'c', name: 'Old promo', type: 'percent', value: 20, active: false },
    { id: 'd', name: 'Zero', type: 'percent', value: 0 },
    { id: 'e', label: 'Reusable cup', type: 'amount', value: '0.30', requiresManager: false },
    { id: 'f', name: 'Comp', type: 'percent', value: 100, requires_manager: true, category_ids: ['x'], scope: 'category' },
  ]);
  assert.deepEqual(list.map((d) => d.id), ['e', 'f', 'a', 'b']);
  assert.equal(list.find((d) => d.id === 'e').type, 'amount');
  assert.equal(list.find((d) => d.id === 'e').value, 0.3);
  assert.equal(list.find((d) => d.id === 'b').value, 10);
  const comp = list.find((d) => d.id === 'f');
  assert.equal(comp.requiresManager, true);
  assert.deepEqual(comp.categoryIds, ['x']);
  assert.equal(comp.scope, 'category');
});

test('v5.11.90: each discount carries its kind (staff, comp, loyalty or null), from either spelling of the row', () => {
  const list = venueDiscountList([
    { id: 'a', name: 'Staff meal', type: 'percent', value: 50, kind: 'staff', sortOrder: 1 },
    { id: 'b', name: 'Comp', type: 'percent', value: 100, kind: 'comp', sortOrder: 2 },
    { id: 'c', name: 'Loyalty 10%', type: 'percent', value: 10, kind: 'loyalty', sortOrder: 3 },
    { id: 'd', name: 'NHS', type: 'percent', value: 10, sortOrder: 4 },
    { id: 'e', name: 'Odd', type: 'percent', value: 10, kind: 'vip', sortOrder: 5 },
    { id: 'f', name: 'Shouty', type: 'amount', value: 2, kind: ' STAFF ', sortOrder: 6 },
  ]);
  assert.deepEqual(list.map((d) => [d.id, d.kind]), [['a', 'staff'], ['b', 'comp'], ['c', 'loyalty'], ['d', null], ['e', null], ['f', 'staff']]);
  // the shape is the old one plus kind, so every till button reads the same
  assert.deepEqual(Object.keys(list[0]).sort(), ['categoryIds', 'id', 'kind', 'label', 'requiresManager', 'scope', 'type', 'value']);
  assert.deepEqual(list[0], { id: 'a', label: 'Staff meal', type: 'percent', value: 50, requiresManager: false, scope: 'global', categoryIds: [], kind: 'staff' });
});
