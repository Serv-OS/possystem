/**
 * stuart.test.js — Stuart provider pure helpers (status map + pricing normalisation).
 * Run: `node --test`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mapStuartStatus, normaliseStuartPricing, parseStuartJob } from './stuart.js';

test('mapStuartStatus → ServOS lifecycle', () => {
  assert.equal(mapStuartStatus('new'), 'pending');
  assert.equal(mapStuartStatus('searching'), 'pending');
  assert.equal(mapStuartStatus('picking'), 'pickup');
  assert.equal(mapStuartStatus('waiting_at_pickup'), 'pickup');
  assert.equal(mapStuartStatus('delivering'), 'dropoff');
  assert.equal(mapStuartStatus('delivered'), 'delivered');
  assert.equal(mapStuartStatus('finished'), 'delivered');
  assert.equal(mapStuartStatus('cancelled'), 'canceled');
  assert.equal(mapStuartStatus('voided'), 'canceled');
  assert.equal(mapStuartStatus('returned'), 'returned');
  assert.equal(mapStuartStatus(null), 'pending');
  assert.equal(mapStuartStatus('SomethingNew'), 'pending'); // unknown → safe default
});

test('normaliseStuartPricing: pounds → minor, like the Uber-classic shape', () => {
  assert.deepEqual(normaliseStuartPricing({ amount: 5.5, currency: 'GBP' }), { fee: 550, currency: 'GBP' });
  // tax-included variant + rounding
  assert.deepEqual(normaliseStuartPricing({ amount_tax_included: 6.499, currency: 'gbp' }), { fee: 650, currency: 'GBP' });
  // nested pricing object
  assert.deepEqual(normaliseStuartPricing({ pricing: { amount: 4 }, currency: 'EUR' }), { fee: 400, currency: 'EUR' });
  // unusable
  assert.equal(normaliseStuartPricing({ foo: 1 }), null);
  assert.equal(normaliseStuartPricing(null), null);
});

test('normaliseStuartPricing output feeds normalizeUberQuote unchanged', async () => {
  const { normalizeUberQuote } = await import('./quote.js');
  const raw = normaliseStuartPricing({ amount: 7.25, currency: 'GBP' });
  const q = normalizeUberQuote(raw, 0);
  assert.equal(q.feeMinor, 725);
  assert.equal(q.currency, 'GBP');
});

test('parseStuartJob pulls id / tracking / status / driver', () => {
  const r = parseStuartJob({ id: 12345, status: 'in_progress', deliveries: [{ id: 9, status: 'delivering', tracking_url: 'https://stuart/track/9', driver: { firstname: 'Sam', lastname: 'Rider', phone: '+447700900000', latitude: 51.5, longitude: -0.1 } }] });
  assert.equal(r.id, '12345');
  assert.equal(r.trackingUrl, 'https://stuart/track/9');
  assert.equal(r.rawStatus, 'delivering');      // delivery status preferred over job status
  assert.equal(r.courierName, 'Sam Rider');
  assert.equal(r.courierPhone, '+447700900000');
  assert.equal(r.lat, 51.5);
});
