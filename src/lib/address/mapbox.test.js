/**
 * mapbox.test.js — Mapbox v6 feature normalisation (pure).
 * Run: `node --test`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMapboxFeature } from './mapbox.js';

test('normalizeMapboxFeature: structured address → line1/city/postcode/coords', () => {
  const f = {
    id: 'addr.123',
    geometry: { coordinates: [-0.1276, 51.5074] },   // [lng, lat]
    properties: {
      full_address: '10 Downing Street, London, SW1A 2AA, United Kingdom',
      name: '10 Downing Street',
      context: {
        address: { name: '10 Downing Street', address_number: '10', street_name: 'Downing Street' },
        place: { name: 'London' },
        postcode: { name: 'SW1A 2AA' },
      },
    },
  };
  const a = normalizeMapboxFeature(f);
  assert.equal(a.line1, '10 Downing Street');
  assert.equal(a.city, 'London');
  assert.equal(a.postcode, 'SW1A 2AA');
  assert.equal(a.lat, 51.5074);
  assert.equal(a.lng, -0.1276);
  assert.equal(a.label, '10 Downing Street, London, SW1A 2AA, United Kingdom');
});

test('normalizeMapboxFeature: builds line1 from number+street when name missing, tolerates gaps', () => {
  const a = normalizeMapboxFeature({
    geometry: { coordinates: [-2.0, 53.0] },
    properties: { context: { address: { address_number: '42', street_name: 'High Street' }, locality: { name: 'Huddersfield' }, postcode: { name: 'HD4 7PT' } } },
  });
  assert.equal(a.line1, '42 High Street');
  assert.equal(a.city, 'Huddersfield');
  assert.equal(a.postcode, 'HD4 7PT');
  assert.equal(a.lat, 53.0);
});

test('normalizeMapboxFeature: bad coords → null lat/lng, never throws', () => {
  const a = normalizeMapboxFeature({ properties: { name: 'Somewhere' } });
  assert.equal(a.lat, null);
  assert.equal(a.lng, null);
  assert.equal(a.line1, 'Somewhere');
});
