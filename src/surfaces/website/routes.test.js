// Routing and visibility (ARCHITECTURE.md section 3): the same rule for the server and the SPA.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveRoute, visibleNav, pathForPage, sitemapPaths, blockVisible, channelOn, normalisePath, breadcrumbsFor, layoutHasHero } from './routes.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const snap = () => JSON.parse(fs.readFileSync(path.resolve(here, 'fixtures/snapshot.sample.json'), 'utf8'));

test('paths resolve to pages, posts, locations and not found', () => {
  const s = snap();
  assert.equal(resolveRoute(s, '/').page.id, 'p-home');
  assert.equal(resolveRoute(s, '/menu/').page.id, 'p-menu', 'trailing slash');
  assert.equal(resolveRoute(s, '/menu?x=1#y').page.id, 'p-menu');
  assert.equal(resolveRoute(s, '//menu').page.id, 'p-menu');
  assert.equal(resolveRoute(s, '/blog').page.id, 'p-blog');
  const post = resolveRoute(s, '/blog/new-winter-menu');
  assert.equal(post.kind, 'post');
  assert.equal(post.post.title, 'Our new winter menu');
  assert.equal(resolveRoute(s, '/blog/secret-draft').kind, 'notfound', 'draft post hidden');
  assert.equal(resolveRoute(s, '/our-story').kind, 'notfound', 'draft page hidden');
  const loc = resolveRoute(s, '/locations/mozz-leeds');
  assert.equal(loc.kind, 'location');
  assert.equal(loc.page.id, 'p-loc-leeds', 'the designer page for that venue');
  const synth = resolveRoute(s, '/locations/mozz-huddersfield');
  assert.equal(synth.page.synthesised, true);
  assert.equal(synth.location.id, 'loc-hudds');
  assert.equal(resolveRoute(s, '/locations/nowhere').kind, 'notfound');
  assert.equal(resolveRoute(s, '/leeds').kind, 'notfound', 'location pages live under /locations only');
  assert.equal(resolveRoute({ pages: [{ slug: 'x', title: 'X' }] }, '/').page.slug, 'x', 'no home page = first page stands in');
  assert.equal(resolveRoute(null, '/').kind, 'notfound');
  assert.equal(resolveRoute({ pages: [], posts: [{ slug: 'p', status: 'published', title: 'P' }] }, '/blog').page.synthesised, true, 'blog list without a blog page');
});

test('nav follows site.nav, hides missing pages and off channels, falls back to the page list', () => {
  const s = snap();
  assert.deepEqual(visibleNav(s).map((n) => n.href), ['/', '/menu', '/order', '/find-us', '/blog']);
  s.site.settings.channels.online = false;
  assert.deepEqual(visibleNav(s).map((n) => n.label), ['Home', 'Menu', 'Find us', 'News']);
  s.site.nav = [{ label: 'Gone', kind: 'page', page_id: 'nope' }, { label: 'Insta', href: 'https://instagram.com/x' }];
  assert.deepEqual(visibleNav(s), [{ label: 'Insta', href: 'https://instagram.com/x' }]);
  s.site.nav = [];
  const fallback = visibleNav(s).map((n) => n.label);
  assert.ok(fallback.includes('Menu') && !fallback.includes('Order') && !fallback.includes('Mozz Pizza Leeds'), 'location pages and off channels stay out of the fallback nav');
});

test('pathForPage, sitemap paths, breadcrumbs', () => {
  const s = snap();
  assert.equal(pathForPage(s.pages[0], s), '/');
  assert.equal(pathForPage(s.pages.find((p) => p.id === 'p-loc-leeds'), s), '/locations/mozz-leeds');
  const paths = sitemapPaths(s).map((u) => u.path);
  assert.ok(paths.includes('/locations/mozz-huddersfield') && !paths.includes('/catering') && !paths.includes('/our-story'));
  assert.equal(new Set(paths).size, paths.length, 'no duplicates');
  assert.deepEqual(breadcrumbsFor(resolveRoute(s, '/blog/new-winter-menu'), s).map((c) => c.path), ['/', '/blog', '/blog/new-winter-menu']);
  assert.deepEqual(breadcrumbsFor(resolveRoute(s, '/locations/mozz-leeds'), s).map((c) => c.path), ['/', '/find-us', '/locations/mozz-leeds']);
  assert.equal(breadcrumbsFor(resolveRoute(s, '/'), s).length, 1);
});

test('channel switches and block visibility', () => {
  assert.equal(channelOn({}, 'online'), true);
  assert.equal(channelOn({ channels: { online: false } }, 'online'), false);
  assert.equal(blockVisible({ type: 'GiftCards' }, { channels: { gift: false } }), false);
  assert.equal(blockVisible({ type: 'OrderEmbed', props: { mode: 'catering' } }, { channels: { catering: false, online: true } }), false);
  assert.equal(blockVisible({ type: 'OrderEmbed', props: { mode: 'online' } }, { channels: { catering: false, online: true } }), true);
  assert.equal(blockVisible({ type: 'CustomHtml' }, {}), false);
  assert.equal(blockVisible({ type: 'CustomHtml' }, { allow_custom_code: true }), true);
  assert.equal(blockVisible({ type: 'Text' }, null), true);
  assert.equal(blockVisible(null, {}), false);
  assert.equal(normalisePath('menu'), '/menu');
  assert.equal(normalisePath(''), '/');
  assert.equal(layoutHasHero({ content: [{ type: 'Hero', props: {} }] }), true);
  assert.equal(layoutHasHero(null), false);
});

test('a location page whose venue has no online_slug: out of the sitemap, but its path still answers', () => {
  const s = snap();
  // The designer makes a page for every location, including the dark kitchen (no online_slug).
  s.pages.push({ id: 'p-loc-dark', slug: 'dark-kitchen', title: 'Dark kitchen', kind: 'location', location_id: 'loc-nosite', status: 'published', sort_order: 99, seo: {}, layout: { content: [{ type: 'Hero', props: { id: 'h' } }] } });
  assert.equal(pathForPage(s.pages.at(-1), s), '/locations/dark-kitchen');
  const paths = sitemapPaths(s).map((u) => u.path);
  assert.ok(!paths.includes('/locations/dark-kitchen'), 'never a sitemap entry the venue cannot stand behind');
  assert.ok(paths.includes('/locations/mozz-leeds') && paths.includes('/locations/mozz-huddersfield'));
  const r = resolveRoute(s, '/locations/dark-kitchen');
  assert.equal(r.kind, 'location', 'the path the nav may carry does not 404');
  assert.equal(r.page.id, 'p-loc-dark');
  assert.equal(r.location, null);
  assert.equal(resolveRoute(s, '/locations/nowhere').kind, 'notfound');
  // Removed since publish: same rule.
  s.pages.at(-1).location_id = 'loc-gone';
  assert.ok(!sitemapPaths(s).map((u) => u.path).includes('/locations/dark-kitchen'));
});

// 5.12.7: /order, /order/catering and /order/book answer on every site, as the "which venue?" page
// when the designer made no page of that slug.
test('the choose your venue page is synthesised for /order paths without a page', () => {
  const r = resolveRoute({ pages: [{ slug: '', title: 'Home', status: 'published' }], locations: [] }, '/order');
  assert.equal(r.kind, 'page');
  assert.equal(r.page.synthesised, true);
  assert.equal(r.page.kind, 'order');
  assert.deepEqual(r.page.layout.content.map((b) => b.type), ['Hero', 'FindUs']);
  assert.equal(r.page.layout.content[1].props.cta, 'order');
  assert.equal(resolveRoute({ pages: [] }, '/order/catering').page.layout.content[1].props.cta, 'catering');
  assert.equal(resolveRoute({ pages: [] }, '/order/book').page.title, 'Book a table');
  assert.equal(resolveRoute({ pages: [] }, '/order/nope').kind, 'notfound');
  const own = resolveRoute({ pages: [{ slug: 'order', title: 'Order', kind: 'order', status: 'published', layout: { content: [] } }] }, '/order');
  assert.equal(own.page.synthesised, undefined, 'a real order page wins');
});


// ── 5.12.12 nav dropdowns ───────────────────────────────────────────────────────
test('visibleNav: a locations item opens every published venue page, a group item its visible children, empty dropdowns vanish', () => {
  const s = snap();
  s.site.nav = [
    { label: 'Home', kind: 'page', page_id: '' },
    { label: 'Locations', kind: 'locations' },
    { label: 'More', kind: 'group', children: [{ label: 'Menu', kind: 'page', page_id: 'menu' }, { label: 'News', kind: 'link', href: '/blog' }, { label: 'Gone', kind: 'page', page_id: 'no-such-page' }] },
    { label: 'Empty', kind: 'group', children: [{ label: 'Gone', kind: 'page', page_id: 'no-such-page' }] },
  ];
  const nav = visibleNav(s);
  assert.deepEqual(nav.map((n) => n.label), ['Home', 'Locations', 'More']);
  const locs = nav[1];
  assert.ok(locs.children.length >= 2, 'one child per venue page');
  assert.ok(locs.children.every((c) => c.href.startsWith('/locations/')));
  assert.deepEqual(nav[2].children.map((c) => c.href), ['/menu', '/blog']);
  assert.equal(nav[2].href, '/menu', 'a group item itself points at its first child');
});


// ── 5.12.18: the Find us page item opens the venues by itself ────────────────────────────────
test('visibleNav: a Find us page item carries every venue as a dropdown when the site has more than one; dropdown: false turns it off; one venue = no dropdown', () => {
  const s = snap();
  const findUs = visibleNav(s).find((n) => n.href === '/find-us');
  assert.ok(findUs && Array.isArray(findUs.children) && findUs.children.length === 2, 'two public venues = two children');
  assert.deepEqual(findUs.children.map((c) => c.href), ['/locations/mozz-leeds', '/locations/mozz-huddersfield'], 'every venue under /locations/<online slug>, page or not');
  assert.ok(!visibleNav(s).find((n) => n.href === '/menu').children, 'other pages stay plain');
  s.site.nav = [{ label: 'Shops', kind: 'page', page_id: 'find-us', dropdown: false }];
  assert.equal(visibleNav(s)[0].children, undefined, 'dropdown: false keeps it a plain link');
  s.site.nav = [];
  const fallback = visibleNav(s).find((n) => n.href === '/find-us');
  assert.equal(fallback.children.length, 2, 'the automatic nav gets it too');
  s.locations = s.locations.slice(0, 1);
  s.site.nav = [{ label: 'Find us', kind: 'page', page_id: 'find-us' }];
  assert.equal(visibleNav(s)[0].children, undefined, 'one venue: nothing to drop down');
});
