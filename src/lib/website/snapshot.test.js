// node --test: the publish snapshot (contract section 2) built by website-admin has the shape the
// public reader (api/site.js, agent B) and the designer (agent D) rely on. The fixture
// fixtures/snapshot.sample.json is that shape, written out in full.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildSnapshot, snapshotPaths, publicLocation } from '../../../supabase/functions/_shared/websiteSnapshot.js';

const sample = JSON.parse(fs.readFileSync(new URL('./fixtures/snapshot.sample.json', import.meta.url), 'utf8'));
const keys = (o) => Object.keys(o).sort();

/** The Platform rows a publish reads, derived from the sample so the two can never drift. */
function rows() {
  const site = { ...sample.site, company_id: 'c0000000-0000-4000-8000-000000000001', published_version_id: null, published_at: null, domain_status: {}, created_at: 'x', updated_at: 'y' };
  const pages = sample.pages.map((p) => ({ ...p, site_id: site.id, status: 'published', updated_at: 'z' }));
  const posts = sample.posts.map((p) => ({ ...p, site_id: site.id, status: 'published', updated_at: 'z' }));
  // Platform `locations` rows: latitude/longitude columns, online_slug, no sort_order column.
  const locations = sample.locations.map((l) => ({
    id: l.id, company_id: site.company_id, ops_location_id: l.ops_location_id, name: l.name, address: l.address, phone: l.phone,
    timezone: l.timezone, currency: l.currency, opening_hours: l.opening_hours, online_slug: l.slug, online_branding: l.online_branding,
    online_enabled: l.online_enabled, online_delivery_enabled: l.online_delivery_enabled, qr_enabled: l.qr_enabled,
    latitude: l.id.endsWith('2') ? null : l.lat, longitude: l.id.endsWith('2') ? null : l.lng,   // Huddersfield comes from settings.geo
    payment_processor: 'adyen', challenge_21_counter: 3, ops_db_url: 'https://secret.example',   // never copied out
  }));
  return { site, pages, posts, locations };
}

test('buildSnapshot has exactly the fixture shape, top level and per item', () => {
  const snap = buildSnapshot({ ...rows(), now: new Date(sample.generated_at) });
  assert.deepEqual(keys(snap), keys(sample));
  assert.deepEqual(keys(snap.site), keys(sample.site));
  assert.deepEqual(keys(snap.pages[0]), keys(sample.pages[0]));
  assert.deepEqual(keys(snap.posts[0]), keys(sample.posts[0]));
  assert.deepEqual(keys(snap.locations[0]), keys(sample.locations[0]));
  assert.equal(snap.generated_at, sample.generated_at);
  assert.deepEqual(snap, sample);
});

test('the sample names every field the contract lists', () => {
  for (const k of ['theme', 'nav', 'footer', 'seo', 'settings', 'slug', 'custom_domain']) assert.ok(k in sample.site, k);
  for (const k of ['allow_custom_code', 'custom_head_html', 'nearest_store', 'default_location_id', 'order_mode']) assert.ok(k in sample.site.settings, k);
  for (const k of ['layout', 'type', 'buttons', 'mood', 'brand_color']) assert.ok(k in sample.site.theme, k);
  for (const k of ['title', 'description', 'og_image_url', 'google_site_verification', 'locale', 'keywords']) assert.ok(k in sample.site.seo, k);
  for (const k of ['text', 'links', 'show_powered_by', 'instagram', 'facebook', 'email', 'phone']) assert.ok(k in sample.site.footer, k);
  for (const p of sample.pages) { assert.ok('root' in p.layout && 'content' in p.layout); for (const b of p.layout.content) assert.ok(typeof b.props.id === 'string'); }
  assert.equal(sample.locations.length, 2);
  assert.ok(sample.pages.some((p) => p.kind === 'location' && p.location_id === sample.locations[1].id));
});

test('drafts never reach the snapshot, whatever the caller passed', () => {
  const r = rows();
  r.pages.push({ id: 'd1', site_id: r.site.id, slug: 'our-story', title: 'Our story', kind: 'custom', layout: { root: { props: {} }, content: [] }, seo: {}, sort_order: 99, status: 'draft' });
  r.posts.push({ id: 'd2', site_id: r.site.id, slug: 'secret', title: 'Secret', body_md: '', status: 'draft', tags: [] });
  const snap = buildSnapshot(r);
  assert.ok(!snap.pages.some((p) => p.slug === 'our-story'));
  assert.ok(!snap.posts.some((p) => p.slug === 'secret'));
});

test('private location columns are left out and the default location comes first', () => {
  const r = rows();
  r.locations.reverse();   // Huddersfield first in the query, Leeds is the default
  const snap = buildSnapshot(r);
  assert.equal(snap.locations[0].id, sample.site.settings.default_location_id);
  for (const l of snap.locations) {
    assert.equal('ops_db_url' in l, false);
    assert.equal('payment_processor' in l, false);
    assert.equal('challenge_21_counter' in l, false);
  }
  // Huddersfield has no latitude column value: the cached geocode fills lat/lng.
  const hudds = snap.locations.find((l) => l.name.includes('Huddersfield'));
  assert.equal(hudds.lat, 53.6458);
  assert.equal(hudds.lng, -1.785);
});

test('publicLocation never throws on thin rows', () => {
  assert.equal(publicLocation(null), null);
  const thin = publicLocation({ id: 'x', name: 'Only a name' });
  assert.equal(thin.slug, null);
  assert.equal(thin.lat, null);
  assert.equal(thin.timezone, 'Europe/London');
  assert.equal(thin.currency, 'GBP');
  assert.deepEqual(thin.online_branding, {});
  assert.equal(thin.online_enabled, false);
  const strCoords = publicLocation({ id: 'y', name: 'Str', latitude: '53.1', longitude: '-1.2' });
  assert.equal(strCoords.lat, 53.1);
});

test('buildSnapshot with nothing gives an empty, readable site', () => {
  const snap = buildSnapshot({});
  assert.deepEqual(snap.pages, []);
  assert.deepEqual(snap.posts, []);
  assert.deepEqual(snap.locations, []);
  assert.deepEqual(snap.site.theme, {});
  assert.deepEqual(snap.site.nav, []);
  assert.ok(typeof snap.generated_at === 'string');
  const alsoFine = buildSnapshot({ site: 'nonsense', pages: 'nope', posts: null, locations: 3 });
  assert.deepEqual(alsoFine.pages, []);
});

test('posts are newest first, pages in sort order', () => {
  const snap = buildSnapshot(rows());
  assert.equal(snap.posts[0].slug, 'why-72-hour-dough');
  assert.deepEqual(snap.pages.map((p) => p.sort_order), [0, 1, 2, 3, 4, 5, 6, 7]);
});

test('snapshotPaths lists home, pages, blog, posts and location pages once each', () => {
  const paths = snapshotPaths(sample);
  assert.equal(paths[0], '/');
  for (const p of ['/menu', '/order', '/find-us', '/blog', '/blog/why-72-hour-dough', '/locations/mozz-leeds', '/locations/mozz-huddersfield']) assert.ok(paths.includes(p), p);
  assert.equal(new Set(paths).size, paths.length);
  assert.deepEqual(snapshotPaths(null), ['/']);
});
