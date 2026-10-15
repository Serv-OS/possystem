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
