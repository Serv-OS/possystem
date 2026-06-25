/**
 * hubriseOrder.test.js — ServOS order → HubRise create-order body. Run: `node --test`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildHubriseOrder } from './hubriseOrder.js';

const order = {
  ref: 'R55',
  total: 31.5,
  customer: { name: 'Sam Patel', phone: '07931129015', address: { line1: '1 High St', city: 'Town', postcode: 'AB1 2CD' }, notes: 'ring bell' },
  items: [
    { name: 'Pizza', itemId: 'm-pizza', price: 12.5, qty: 2 },
    { name: 'Coke', itemId: 'm-coke', price: 1.5, qty: 1, voided: true },
  ],
};
const quote = { customerFeeMinor: 480, etaMinutes: 30, dropoff: { line1: '1 High St', city: 'Town', postcode: 'AB1 2CD' } };

test('maps a delivery order to the HubRise order shape', () => {
  const b = buildHubriseOrder({ order, quote, currency: 'GBP' });
  assert.equal(b.service_type, 'delivery');
  assert.equal(b.status, 'new');
  assert.equal(b.private_ref, 'R55');
  assert.equal(b.total, '31.50 GBP');
  // voided item excluded; sku_ref = our item id; HubRise money strings
  assert.equal(b.items.length, 1);
  assert.deepEqual(b.items[0], { product_name: 'Pizza', sku_name: 'Pizza', sku_ref: 'm-pizza', price: '12.50 GBP', quantity: 2 });
});

test('customer split + E.164 phone + address fields', () => {
  const b = buildHubriseOrder({ order, quote });
  assert.equal(b.customer.first_name, 'Sam');
  assert.equal(b.customer.last_name, 'Patel');
  assert.equal(b.customer.phone, '+447931129015');
  assert.equal(b.customer.postal_code, 'AB1 2CD');
  assert.equal(b.customer_notes, 'ring bell');
});

test('delivery fee becomes a HubRise charge line; eta carried', () => {
  const b = buildHubriseOrder({ order, quote, currency: 'GBP' });
  assert.deepEqual(b.charges, [{ name: 'Delivery', price: '4.80 GBP' }]);
  assert.equal(b.expected_time_minutes, 30);
});

test('no fee → no charges line', () => {
  const b = buildHubriseOrder({ order, quote: { customerFeeMinor: 0, dropoff: {} } });
  assert.equal(b.charges, undefined);
});
