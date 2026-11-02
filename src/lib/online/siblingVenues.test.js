/**
 * siblingVenues.test.js: the Change location sheet's venues, address line and link (5.12.34).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { venueAddressLine, siblingVenues, cartResetWords, siblingVenueUrl, loadSiblingVenues } from './siblingVenues.js';

test('venueAddressLine: platform address, else ops address, else receipt lines, else empty (never null)', () => {
  assert.equal(venueAddressLine({ address: ' 1 Main St ' }, { address: 'x' }), '1 Main St');
  assert.equal(venueAddressLine({ address: null }, { address: '9a New Street, Huddersfield' }), '9a New Street, Huddersfield');
  assert.equal(venueAddressLine({}, { address: '', receipt_branding: { header: { address_lines: ['1426 Shoal Drive', '', 'San Mateo', null, '94404'] } } }), '1426 Shoal Drive, San Mateo, 94404');
  assert.equal(venueAddressLine({}, {}), '');
  assert.equal(venueAddressLine(null, null), '');
});

const rows = [
  { id: 'b', name: 'Zed', online_slug: 'zed', online_enabled: true },
  { id: 'me', name: 'Me', online_slug: 'me', online_enabled: true },
  { id: 'c', name: 'Off', online_slug: 'off', online_enabled: false },
  { id: 'd', name: 'No slug', online_slug: '', online_enabled: true },
  { id: 'a', name: 'Alpha', online_slug: 'alpha', online_enabled: true },
];

test('siblingVenues: other venues with online ordering on and a slug, by name', () => {
  assert.deepEqual(siblingVenues(rows, 'me').map((r) => r.id), ['a', 'b']);
  assert.deepEqual(siblingVenues(null, 'me'), []);
  assert.deepEqual(siblingVenues([{ id: 'me', online_slug: 'me', online_enabled: true }], 'me'), []);
});

test('cartResetWords: empty basket says nothing, otherwise the count and the venue', () => {
  assert.equal(cartResetWords(0, 'Daybreak'), '');
  assert.equal(cartResetWords(1, 'Daybreak'), 'Your basket (1 item) will start again at Daybreak.');
  assert.equal(cartResetWords(3, 'Daybreak'), 'Your basket (3 items) will start again at Daybreak.');
  assert.ok(!/[–—]/.test(cartResetWords(3, 'Daybreak')));
});

test('siblingVenueUrl: a ?loc= page keeps its origin, path and surface; otherwise the customer URL', () => {
  const here = { origin: 'https://app.serv-os.app', pathname: '/', search: '?loc=location1&surface=online' };
  assert.equal(siblingVenueUrl('location-2', here, () => 'nope'), 'https://app.serv-os.app/?loc=location-2&surface=online');
  const qr = { origin: 'https://app.serv-os.app', pathname: '/', search: '?loc=location1&surface=qr&t=T5' };
  assert.equal(siblingVenueUrl('location-2', qr, () => 'nope'), 'https://app.serv-os.app/?loc=location-2&surface=qr');
  const sub = { origin: 'https://location1.serv-os.app', pathname: '/', search: '' };
  assert.equal(siblingVenueUrl('location-2', sub, (slug) => `https://${slug}.serv-os.app`), 'https://location-2.serv-os.app');
  assert.equal(siblingVenueUrl('', here, () => 'x'), '');
});

function fakeClient(table, rows, { error = null, calls = [] } = {}) {
  const q = {
    _ops: [],
    select(s) { q._ops.push(['select', s]); return q; },
    eq(k, v) { q._ops.push(['eq', k, v]); return q; },
    in(k, v) { q._ops.push(['in', k, v]); return q; },
    order(k) { q._ops.push(['order', k]); return q; },
    then(res) { calls.push([table, q._ops]); return Promise.resolve({ data: error ? null : rows, error }).then(res); },
  };
  return { from(t) { assert.equal(t, table); return q; } };
}

test('loadSiblingVenues: reads the company rows as the group page does and lays the ops address over', async () => {
  const calls = [];
  const platform = fakeClient('locations', [
    { id: 'p1', ops_location_id: 'o1', name: 'Provo', address: null, online_slug: 'location1', online_enabled: true },
    { id: 'p2', ops_location_id: 'o2', name: 'Location 2', address: null, online_slug: 'location-2', online_enabled: true },
    { id: 'p3', ops_location_id: 'o3', name: 'Shut', address: null, online_slug: 'shut', online_enabled: false },
  ], { calls });
  const ops = fakeClient('locations', [{ id: 'o2', address: '1426 Shoal Drive', receipt_branding: null }], { calls });
  const out = await loadSiblingVenues({ platformSupabase: platform, supabase: ops, companyId: 'co', currentId: 'p1' });
  assert.deepEqual(out, [{ id: 'p2', ops_location_id: 'o2', name: 'Location 2', online_slug: 'location-2', address: '1426 Shoal Drive' }]);
  assert.deepEqual(calls[0][1].find((o) => o[0] === 'eq'), ['eq', 'company_id', 'co']);
  assert.deepEqual(calls[1][1].find((o) => o[0] === 'in'), ['in', 'id', ['o2']]);
});

test('loadSiblingVenues: no company, no client, a read error, or a thrown read all give []', async () => {
  assert.deepEqual(await loadSiblingVenues({ platformSupabase: null, supabase: null, companyId: 'co', currentId: 'p1' }), []);
  assert.deepEqual(await loadSiblingVenues({ platformSupabase: fakeClient('locations', []), supabase: null, companyId: null, currentId: 'p1' }), []);
  assert.deepEqual(await loadSiblingVenues({ platformSupabase: fakeClient('locations', null, { error: { message: 'x' } }), supabase: null, companyId: 'co', currentId: 'p1' }), []);
  const boom = { from() { throw new Error('down'); } };
  assert.deepEqual(await loadSiblingVenues({ platformSupabase: boom, supabase: null, companyId: 'co', currentId: 'p1' }), []);
});

test('loadSiblingVenues: a failed ops read still lists the venue, with an empty address line', async () => {
  const platform = fakeClient('locations', [
    { id: 'p2', ops_location_id: 'o2', name: 'Location 2', address: null, online_slug: 'location-2', online_enabled: true },
  ]);
  const ops = { from() { throw new Error('down'); } };
  const out = await loadSiblingVenues({ platformSupabase: platform, supabase: ops, companyId: 'co', currentId: 'p1' });
  assert.equal(out.length, 1);
  assert.equal(out[0].address, '');
});
