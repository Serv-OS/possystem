/**
 * manifest.test.js — order → Uber manifest (declared value, items, E.164 phone). Run: `node --test`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildManifest, toE164 } from './manifest.js';

test('toE164: UK 07 → +44, keeps +, tolerates spaces', () => {
  assert.equal(toE164('07931 129015'), '+447931129015');
  assert.equal(toE164('+447911123456'), '+447911123456');
  assert.equal(toE164('44 7911 123456'), '+447911123456');
  assert.equal(toE164(''), '');
});

test('buildManifest: declared value = sum of non-voided line totals (pennies)', () => {
  const order = {
    ref: 'R12',
    customer: { name: 'Sam', phone: '07931129015', address: { line1: '1 High St', postcode: 'AB1 2CD' } },
    items: [
      { name: 'Pizza', price: 12.5, qty: 2 },
      { name: 'Coke', price: 1.5, qty: 1, voided: true }, // excluded
      { name: 'Garlic bread', price: 4, qty: 1 },
    ],
  };
  const quote = { quoteId: 'qt1', currency: 'GBP', dropoff: { line1: '1 High St', postcode: 'AB1 2CD', lat: 51.5, lng: -0.1 } };
  const pickup = { address: { line1: '9 Venue Rd', postcode: 'ZZ9 9ZZ' }, contact: { name: 'Kitchen', phone: '02012345678' } };

  const m = buildManifest({ order, quote, pickup });
  assert.equal(m.quote_id, 'qt1');
  assert.equal(m.manifest_reference, 'R12');
  assert.equal(m.manifest_total_value, 2500 + 400); // 2×£12.50 + £4.00, Coke voided
  assert.equal(m.currency, 'GBP');
  assert.equal(m.dropoff.name, 'Sam');
  assert.equal(m.dropoff.phone, '+447931129015');
  assert.equal(m.dropoff.address.postcode, 'AB1 2CD');
  assert.equal(m.pickup.name, 'Kitchen');
  assert.equal(m.pickup.phone, '+442012345678');
  assert.deepEqual(m.items, [{ name: 'Pizza', quantity: 2 }, { name: 'Garlic bread', quantity: 1 }]);
});

test('buildManifest: tolerates string address + missing fields', () => {
  const m = buildManifest({ order: { ref: 'R1', customer: { name: 'A', phone: '', address: '5 Some Road' }, items: [] }, quote: {}, pickup: {} });
  assert.equal(m.dropoff.address.line1, '5 Some Road');
  assert.equal(m.manifest_total_value, 0);
  assert.equal(m.items.length, 0);
  assert.equal(m.pickup.name, 'Restaurant');
});
