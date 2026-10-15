import { test } from 'node:test';
import assert from 'node:assert/strict';
import { brandScore, pickBrandVenue, groupBodyBg, GROUP_PAGE_BG } from './groupBrand.js';

const hero = 'https://x/hero.jpg', logo = 'https://x/logo.png';
const full = { brand_color: '#000000', logo_url: logo, hero_url: hero, background: '#ffffff' };
const noHero = { brand_color: '#000000', logo_url: logo, background: '#ffffff' };

test('brandScore: header photo outweighs logo outweighs colour', () => {
  assert.equal(brandScore(full), 7);
  assert.equal(brandScore(noHero), 3);
  assert.equal(brandScore({ brand_color: '#000' }), 1);
  assert.equal(brandScore({}), 0);
  assert.equal(brandScore(null), 0);
  assert.equal(brandScore({ hero_url: '   ' }), 0);
});

test('the venue with the header photo dresses the page, not the first by name (Coffee Boy, 7 Oct 2026)', () => {
  const venues = [
    { id: 'head', name: 'Coffee Boy  - Headingly', online_enabled: true, online_slug: 'h', online_branding: noHero },
    { id: 'stn', name: 'Coffee Boy - Barnsley Train Station', online_enabled: true, online_slug: 's', online_branding: full },
    { id: 'leeds', name: 'Coffee Boy Leeds', online_enabled: true, online_slug: 'l', online_branding: full },
  ];
  const v = pickBrandVenue(venues, ['head', 'stn', 'leeds']);
  assert.equal(v.id, 'stn', 'first venue with the fullest look, in page order');
});

test('ties go to a venue the page can send people to, then online enabled, then page order', () => {
  const venues = [
    { id: 'a', online_enabled: false, online_slug: null, online_branding: full },
    { id: 'b', online_enabled: true, online_slug: 'b', online_branding: full },
  ];
  assert.equal(pickBrandVenue(venues, ['b']).id, 'b');
  assert.equal(pickBrandVenue(venues, []).id, 'b', 'online enabled beats not');
  assert.equal(pickBrandVenue([{ id: 'x', online_branding: full }, { id: 'y', online_branding: full }], []).id, 'x');
});

test('no venue with a look = null; an empty or junk branding row is not a look', () => {
  assert.equal(pickBrandVenue([{ id: 'a', online_branding: {} }, { id: 'b', online_branding: null }], []), null);
  assert.equal(pickBrandVenue([{ id: 'a', online_branding: [] }], []), null);
  assert.equal(pickBrandVenue(null, null), null);
});

test('groupBodyBg: a light storefront background is honoured, dark or missing falls back to the cream', () => {
  assert.equal(groupBodyBg('#ffffff'), '#ffffff');
  assert.equal(groupBodyBg('f6f2ec'), '#f6f2ec');
  assert.equal(groupBodyBg('#111111'), GROUP_PAGE_BG);
  assert.equal(groupBodyBg(null), GROUP_PAGE_BG);
  assert.equal(groupBodyBg('red'), GROUP_PAGE_BG);
});
