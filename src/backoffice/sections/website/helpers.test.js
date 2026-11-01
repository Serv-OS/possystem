// src/backoffice/sections/website/helpers.test.js
// Contract section 13 C: page ordering, health checklist, draft diff, and the SECTIONS list
// in MenuAppearance.jsx has 5 entries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  orderPages, healthChecklist, draftChanges, slugify, kindForSlug, expectedRecords, normaliseDomain,
  isValidDomain, isValidSlug, siteUrl, pagePath, recordsMailto, channelOn, buildBrief, PUCK_THEME_VARS,
} from './helpers.js';

test('MenuAppearance SECTIONS has five entries and the fifth is the website builder', () => {
  const src = readFileSync(new URL('../MenuAppearance.jsx', import.meta.url), 'utf8');
  const block = /const SECTIONS = \[([\s\S]*?)\];/.exec(src);
  assert.ok(block, 'SECTIONS list found');
  const entries = block[1].split('\n').map((l) => l.trim()).filter((l) => l.startsWith('['));
  assert.equal(entries.length, 5);
  assert.match(entries[4], /\['website', '🌐', 'Website builder'\]/);
  assert.match(src, /WebsiteBuilder/);
});

test('orderPages: home, menu, order first, custom last, then sort_order then title', () => {
  const pages = [
    { id: 'c', kind: 'custom', title: 'Zeta', sort_order: 0 },
    { id: 'm', kind: 'menu', title: 'Menu' },
    { id: 'h', kind: 'home', title: 'Home' },
    { id: 'b', kind: 'custom', title: 'Alpha', sort_order: 0 },
    { id: 'l2', kind: 'location', title: 'Leeds', sort_order: 2 },
    { id: 'l1', kind: 'location', title: 'York', sort_order: 1 },
    null,
  ];
  assert.deepEqual(orderPages(pages).map((p) => p.id), ['h', 'm', 'l1', 'l2', 'b', 'c']);
  assert.deepEqual(orderPages(undefined), []);
});

test('slugs: slugify, validity and kind mapping', () => {
  assert.equal(slugify('Our Story & Team!'), 'our-story-and-team');
  assert.equal(slugify('  Café   Menu '), 'cafe-menu');
  assert.ok(isValidSlug('find-us'));
  assert.ok(!isValidSlug('Find Us'));
  assert.ok(!isValidSlug(''));
  assert.equal(kindForSlug(''), 'home');
  assert.equal(kindForSlug('gift-cards'), 'gift');
  assert.equal(kindForSlug('find-us'), 'findus');
  assert.equal(kindForSlug('team'), 'custom');
});

test('draftChanges counts rows edited after the last publish, everything when never published', () => {
  const pages = [{ id: 'a', updated_at: '2026-10-30T10:00:00Z' }, { id: 'b', updated_at: '2026-10-31T10:00:00Z' }];
  const posts = [{ id: 'p', updated_at: '2026-10-31T11:00:00Z' }];
  const never = draftChanges({ published_at: null }, pages, posts);
  assert.equal(never.count, 3);
  const after = draftChanges({ published_at: '2026-10-30T12:00:00Z', updated_at: '2026-10-30T09:00:00Z' }, pages, posts);
  assert.deepEqual(after.pages, ['b']);
  assert.deepEqual(after.posts, ['p']);
  assert.equal(after.site, false);
  assert.equal(after.count, 2);
  const siteToo = draftChanges({ published_at: '2026-10-30T12:00:00Z', updated_at: '2026-10-31T09:00:00Z' }, [], []);
  assert.equal(siteToo.count, 1);
  assert.equal(draftChanges(null, null, null).count, 0);
});

test('healthChecklist: six items, free address is secure, missing seo flagged', () => {
  const items = healthChecklist({ site: { slug: 'mozz', seo: {}, domain_status: {} }, pages: [{ kind: 'home', layout: { content: [] } }], branding: {} });
  assert.equal(items.length, 6);
  const by = Object.fromEntries(items.map((i) => [i.id, i]));
  assert.equal(by.domain.ok, false);
  assert.equal(by.ssl.ok, true);
  assert.equal(by.phone.ok, true);
  assert.equal(by.google.ok, false);
  assert.equal(by.share.ok, false);
  assert.equal(by.photos.ok, false);
  const good = healthChecklist({
    site: { slug: 'mozz', custom_domain: 'www.mozz.com', domain_status: { state: 'live', ssl: 'active' }, seo: { google_site_verification: 'abc', og_image_url: 'https://x/og.png' } },
    pages: [{ kind: 'home', layout: { content: [{ type: 'Hero', props: { photo_url: 'https://x/h.jpg' } }] } }],
    branding: { hero_url: 'https://x/h.jpg' },
  });
  assert.ok(good.every((i) => i.ok === true), JSON.stringify(good));
  assert.equal(healthChecklist().length, 6, 'empty input never throws');
});

test('domain helpers: records, normalise, validate, mailto', () => {
  assert.deepEqual(expectedRecords('www.mozzpizza.com').map((r) => [r.type, r.name, r.value]), [['CNAME', 'www', 'sites.serv-os.app'], ['A', '@', '76.76.21.21']]);
  assert.deepEqual(expectedRecords('mozzpizza.com').map((r) => r.type), ['A']);
  assert.deepEqual(expectedRecords(''), []);
  assert.equal(normaliseDomain(' https://WWW.Mozz.com/menu '), 'www.mozz.com');
  assert.ok(isValidDomain('www.mozzpizza.com'));
  assert.ok(!isValidDomain('mozz'));
  assert.ok(!isValidDomain('bad_domain.com'));
  const m = recordsMailto('www.mozz.com', expectedRecords('www.mozz.com'));
  assert.ok(m.startsWith('mailto:?subject='));
  assert.ok(decodeURIComponent(m).includes('CNAME  www  ->  sites.serv-os.app'));
});

test('urls: live custom domain wins, else free address; location pages under /locations', () => {
  assert.equal(siteUrl({ slug: 'mozz' }), 'https://mozz.sites.serv-os.app');
  assert.equal(siteUrl({ slug: 'mozz', custom_domain: 'www.mozz.com', domain_status: { state: 'pending' } }), 'https://mozz.sites.serv-os.app');
  assert.equal(siteUrl({ slug: 'mozz', custom_domain: 'www.mozz.com', domain_status: { state: 'live' } }), 'https://www.mozz.com');
  assert.equal(siteUrl(null), '');
  assert.equal(pagePath({ kind: 'home', slug: '' }), '/');
  assert.equal(pagePath({ kind: 'location', slug: 'leeds' }), '/locations/leeds');
  assert.equal(pagePath({ kind: 'custom', slug: 'team' }), '/team');
});

test('channels default on; brief names the venue; puck theme only uses BO tokens', () => {
  assert.equal(channelOn({}, 'order'), true);
  assert.equal(channelOn({ channels: { order: false } }, 'order'), false);
  assert.equal(channelOn({ channels: { order: false } }, 'gift'), true);
  assert.match(buildBrief({ name: 'Mozz Pizza', locations: [1, 2] }), /Mozz Pizza with 2 locations/);
  for (const v of Object.values(PUCK_THEME_VARS)) assert.ok(/^(var\(--|inherit|ui-monospace)/.test(v), v);
});


// ── 5.12.13 automatic geocoding ─────────────────────────────────────────────────
import { venuesNeedingGeocode } from './helpers.js';
test('venuesNeedingGeocode: venues with an address but no coordinates on the row or in settings.geo', () => {
  const site = { settings: { geo: { c: { lat: 53.8, lng: -1.5 }, d: { lat: 'x' } } } };
  const locs = [
    { id: 'a', address: '45 Fishergate, Preston', latitude: null, longitude: null },
    { id: 'b', address: 'The Light, Leeds', latitude: 53.79, longitude: -1.54 },
    { id: 'c', address: 'Cached', latitude: null, longitude: null },
    { id: 'd', address: 'Bad cache', latitude: null, longitude: null },
    { id: 'e', address: '   ', latitude: null, longitude: null },
    { id: 'f', latitude: null, longitude: null },
    null,
  ];
  assert.deepEqual(venuesNeedingGeocode(site, locs).map((l) => l.id), ['a', 'd']);
  assert.deepEqual(venuesNeedingGeocode(null, locs).map((l) => l.id), ['a', 'c', 'd']);
  assert.deepEqual(venuesNeedingGeocode(site, null), []);
});
