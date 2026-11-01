// The SSR renderer (ARCHITECTURE.md sections 4 and 13 B): one <h1>, menu items with prices,
// JSON-LD that parses with the right @types, sitemap and robots, custom code gated, empty data
// never throws. Uses agent A's sample snapshot when it exists, else our own fixture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderPage, renderBlock, renderSitemap, renderRobots, renderNoSite, renderDocument, buildCtx, fallbackDescription } from './ssr/renderBlocks.js';
import { siteName } from './ssr/jsonld.js';
import { hoursRows, openingHoursSpecification, allDayWindow } from './hours.js';
import { resolveRoute } from './routes.js';
import { BLOCK_TYPES, defaultPropsFor } from './blocks/schema.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const AGENT_A = path.resolve(here, '../../lib/website/fixtures/snapshot.sample.json');
const OURS = path.resolve(here, 'fixtures/snapshot.sample.json');
const snap = () => JSON.parse(fs.readFileSync(OURS, 'utf8'));
const NOW = new Date('2026-10-31T12:00:00Z'); // a Saturday, 12:00 UK: Leeds open, Huddersfield open
const MENU = { currency: 'GBP', menuId: 'm1', categories: [
  { id: 'c1', label: 'Pizza', items: [
    { id: 'i1', name: 'Margherita', description: 'Tomato & mozzarella', price: 9.5, currency: 'GBP', image: null, dietary: ['V'], allergens: ['gluten', 'milk'], sold_out: false, from: false },
    { id: 'i2', name: 'Nduja <hot>', description: '', price: 12, currency: 'GBP', image: 'https://x/n.jpg', dietary: [], allergens: [], sold_out: true, from: false },
  ] },
  { id: 'c2', label: 'Drinks', items: [{ id: 'i3', name: 'Cola', price: 2.5, currency: 'GBP', dietary: ['VG'], allergens: [], sold_out: false, from: true }] },
], specials: [{ id: 'i1', name: 'Margherita', price: 9.5, currency: 'GBP', dietary: ['V'], allergens: [], sold_out: false }] };

const h1Count = (html) => (html.match(/<h1[\s>]/g) || []).length;
const render = (s, p, extra = {}) => renderPage({ snapshot: s, route: resolveRoute(s, p), path: p, host: 'www.mozzpizza.com', menu: MENU, now: NOW, ...extra });

test('every route renders exactly one <h1>, a <nav>, a <main> and a <footer>', () => {
  const s = snap();
  for (const p of ['/', '/menu', '/order', '/find-us', '/blog', '/blog/new-winter-menu', '/locations/mozz-leeds', '/locations/mozz-huddersfield', '/does-not-exist']) {
    const out = render(s, p);
    assert.equal(h1Count(out.body), 1, `${p} h1 count`);
    assert.match(out.body, /<nav id="w-nav"/, p);
    assert.match(out.body, /<main class="w-main"/, p);
    assert.match(out.body, /<footer class="w-footer"/, p);
    assert.match(out.head, /<title>.+<\/title>/, p);
  }
});

test('home: hero headline is the h1, menu items carry real prices, sold out marked, allergens listed, values escaped', () => {
  const out = render(snap(), '/');
  assert.match(out.body, /<h1>Wood fired pizza in Leeds<\/h1>/);
  assert.match(out.body, /Margherita/);
  assert.match(out.body, /£9\.50/);
  assert.match(out.body, /from £2\.50/);
  assert.match(out.body, /Sold out today/);
  assert.match(out.body, /Contains: gluten, milk/);
  assert.match(out.body, /Nduja &lt;hot&gt;/, 'item names are escaped');
  assert.doesNotMatch(out.body, /<hot>/);
  assert.match(out.body, /Open now/, 'hero status from the venue clock');
  // 5.12.7: two venues on this site, so every plain order link asks "which venue?" first.
  assert.match(out.body, /<a class="w-btn w-btn-primary" href="\/order">Order now<\/a>/, 'servos:order goes to the chooser on a multi venue site');
  assert.match(out.body, /href="\/order\/book">Book a table/);
  assert.doesNotMatch(out.body, /href="https:\/\/mozz-leeds\.serv-os\.app\/"/, 'no straight line to one venue from a plain link');
  assert.match(out.body, /href="\/menu"/, 'page:p-menu resolves to the site path');
});

test('channel switches: catering off hides the catering button and nav item, blocks for off channels vanish', () => {
  const s = snap();
  const out = render(s, '/');
  assert.doesNotMatch(out.body, />Catering</);
  assert.match(out.body, />Book a table</);
  s.site.settings.channels.loyalty = false;
  const out2 = render(s, '/');
  assert.doesNotMatch(out2.body, /data-block="LoyaltyJoin"/);
  assert.match(out.body, /data-block="LoyaltyJoin"/);
  const cat = render(s, '/catering');
  assert.equal(cat.noindex, true, 'a page for an off channel is kept out of Google');
});

test('custom code: hidden by default, injected only when the owner allowed it', () => {
  const s = snap();
  const off = render(s, '/');
  assert.doesNotMatch(off.body, /should not show/);
  assert.doesNotMatch(off.head, /alert\(1\)/);
  s.site.settings.allow_custom_code = true;
  const on = render(s, '/');
  assert.match(on.body, /<b>should not show<\/b>/);
  assert.match(on.head, /alert\(1\)/);
});

test('JSON-LD parses, carries the right @types and never invents fields', () => {
  const s = snap();
  const home = render(s, '/');
  const types = home.jsonld.map((o) => o['@type']);
  assert.deepEqual(types, ['Organization', 'WebSite', 'Restaurant', 'Restaurant', 'Menu', 'FAQPage']);
  for (const m of home.head.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) assert.doesNotThrow(() => JSON.parse(m[1]));
  const rest = home.jsonld.find((o) => o['@type'] === 'Restaurant' && o.name === 'Mozz Pizza Leeds');
  assert.equal(rest.telephone, '0113 496 0001');
  assert.deepEqual(rest.geo, { '@type': 'GeoCoordinates', latitude: 53.796, longitude: -1.54 });
  assert.equal(rest.openingHoursSpecification.length, 6, 'Sunday closed = no row');
  assert.equal(rest.acceptsReservations, 'True');
  assert.deepEqual(rest.servesCuisine, ['Pizza']);
  assert.equal(rest.hasMenu, 'https://www.mozzpizza.com/menu');
  const hudds = home.jsonld.find((o) => o['@type'] === 'Restaurant' && o.name === 'Mozz Pizza Huddersfield');
  assert.equal(hudds.acceptsReservations, undefined, 'bookings off there');
  assert.equal(hudds.geo, undefined, 'no coordinates = no geo, never a guess');
  assert.equal(hudds.address.addressLocality, 'Huddersfield');
  const menu = home.jsonld.find((o) => o['@type'] === 'Menu');
  assert.equal(menu.hasMenuSection[0].hasMenuItem[0].offers.price, '9.50');
  assert.equal(menu.hasMenuSection[0].hasMenuItem[0].offers.priceCurrency, 'GBP');
  assert.deepEqual(menu.hasMenuSection[0].hasMenuItem[0].suitableForDiet, ['https://schema.org/VegetarianDiet']);
  const faq = home.jsonld.find((o) => o['@type'] === 'FAQPage');
  assert.equal(faq.mainEntity.length, 2);
  assert.equal(faq.mainEntity[1].acceptedAnswer.text, 'Every pizza can be made on a gluten free base.');
  const post = render(s, '/blog/new-winter-menu');
  assert.deepEqual(post.jsonld.map((o) => o['@type']), ['BlogPosting', 'BreadcrumbList']);
  assert.equal(post.jsonld[0].headline, 'Our new winter menu');
  assert.equal(post.jsonld[1].itemListElement.length, 3);
  const loc = render(s, '/locations/mozz-huddersfield');
  assert.equal(loc.jsonld.filter((o) => o['@type'] === 'Restaurant').length, 1, 'a location page describes that venue only');
});

test('menu cap: the Menu JSON-LD stops at 300 items', () => {
  const big = { currency: 'GBP', categories: Array.from({ length: 10 }, (_, c) => ({ id: `c${c}`, label: `Cat ${c}`, items: Array.from({ length: 50 }, (_, i) => ({ id: `${c}-${i}`, name: `Item ${c}-${i}`, price: 1, currency: 'GBP', dietary: [], allergens: [] })) })) };
  const out = renderPage({ snapshot: snap(), route: resolveRoute(snap(), '/menu'), path: '/menu', host: 'h', menu: big, now: NOW });
  const menu = out.jsonld.find((o) => o['@type'] === 'Menu');
  assert.equal(menu.hasMenuSection.reduce((n, s) => n + s.hasMenuItem.length, 0), 300);
});

test('head: title, description, canonical on the custom domain, og and twitter, robots, verification, fonts, theme vars', () => {
  const out = render(snap(), '/menu');
  assert.match(out.head, /<title>Menu \| Mozz Pizza Leeds<\/title>/);
  assert.match(out.head, /<meta name="description" content="Our full pizza menu with prices\.">/);
  assert.match(out.head, /<link rel="canonical" href="https:\/\/www\.mozzpizza\.com\/menu">/);
  assert.match(out.head, /property="og:title"/);
  assert.match(out.head, /name="twitter:card" content="summary_large_image"/);
  assert.match(out.head, /name="robots" content="index, follow/);
  assert.match(out.head, /name="google-site-verification" content="abc123"/);
  assert.match(out.head, /fonts\.googleapis\.com\/css2\?family=Fraunces/);
  assert.match(out.head, /<style id="w-theme">:root\{--w-bg:#f6f2ec;/);
  assert.match(out.head, /<style id="w-css">/);
  assert.match(out.head, /name="theme-color"/);
  const nf = render(snap(), '/nothing-here');
  assert.equal(nf.noindex, true);
  assert.match(nf.head, /noindex/);
  const offline = render(snap(), '/', { status: 'offline' });
  assert.equal(offline.noindex, true);
});

// 5.12.7 (Peter, 1 Nov): never an iframe, and never straight to one venue when there are several.
test('order page on a multi venue site: a venue chooser, one button per venue to its own ordering, no iframe', () => {
  const out = render(snap(), '/order');
  assert.doesNotMatch(out.body, /<iframe/);
  assert.match(out.body, /data-block="OrderEmbed"/, 'the block keeps its own name');
  assert.match(out.body, /Choose your venue/);
  assert.match(out.body, /<button type="button" class="w-btn w-btn-secondary w-nearest" data-nearest>Find my nearest<\/button>/);
  assert.match(out.body, /<a class="w-btn w-btn-primary" href="https:\/\/mozz-leeds\.serv-os\.app\/">Order here<\/a>/);
  assert.match(out.body, /<a class="w-btn w-btn-primary" href="https:\/\/mozz-huddersfield\.serv-os\.app\/">Order here<\/a>/);
  // The synthesised book chooser: book buttons, no second Book link.
  const book = render(snap(), '/order/book');
  assert.equal(book.noindex, false);
  assert.match(book.body, /<h1>Book a table: pick your venue<\/h1>/);
  assert.match(book.body, /href="https:\/\/mozz-leeds\.serv-os\.app\/book">Book here</);
  assert.doesNotMatch(book.body, />Book<\/a>/);
  // One venue only: straight to it, as a card with one button.
  const s = snap();
  s.locations = s.locations.filter((l) => l.id === 'loc-leeds');
  const one = render(s, '/order');
  assert.doesNotMatch(one.body, /<iframe/);
  assert.match(one.body, /<a class="w-btn w-btn-primary" href="https:\/\/mozz-leeds\.serv-os\.app\/">Order now<\/a>/);
  assert.doesNotMatch(one.body, /Choose your venue/);
  assert.match(render(s, '/').body, /href="https:\/\/mozz-leeds\.serv-os\.app\/" rel="noopener">Order now/, 'one venue: the hero button goes straight there');
});

test('find us: every location with a slug, address text, hours today first, directions, order and book buttons; the dark kitchen is left out', () => {
  const out = render(snap(), '/find-us');
  assert.match(out.body, /12 Call Lane, Leeds, LS1 6DN/);
  assert.match(out.body, /4 Market Street, Huddersfield, HD1 2AA/);
  assert.doesNotMatch(out.body, /Dark kitchen/);
  assert.match(out.body, /maps\/dir\/\?api=1&amp;destination=53\.796%2C-1\.54/);
  assert.match(out.body, /href="https:\/\/mozz-huddersfield\.serv-os\.app\/">Order here/);
  assert.match(out.body, /href="https:\/\/mozz-leeds\.serv-os\.app\/book">Book/);
  assert.doesNotMatch(out.body, /href="https:\/\/mozz-huddersfield\.serv-os\.app\/book"/, 'no bookings at Huddersfield');
  assert.match(out.body, /data-nearest/);
  assert.match(out.body, /<tr class="w-hours-today"><td>Sat<\/td><td>11:30 to 23:00<\/td>/);
});

test('a synthesised location page exists for a venue the designer has not written yet', () => {
  const out = render(snap(), '/locations/mozz-huddersfield');
  assert.match(out.body, /<h1>Mozz Pizza Huddersfield<\/h1>/);
  assert.match(out.body, /data-block="Hours"/);
  assert.match(out.body, /data-block="LiveMenu"/);
  assert.match(out.body, /data-block="OrderEmbed"/);
  assert.match(out.body, /Closed|Open now/);
});

test('sitemap lists every published, indexable page, every location page and every published post', () => {
  const xml = renderSitemap(snap(), 'www.mozzpizza.com');
  for (const u of ['/', '/menu', '/order', '/find-us', '/blog', '/locations/mozz-leeds', '/locations/mozz-huddersfield', '/blog/new-winter-menu']) assert.match(xml, new RegExp(`<loc>https://www\\.mozzpizza\\.com${u.replace(/\//g, '\\/')}</loc>`), u);
  assert.doesNotMatch(xml, /our-story/, 'draft page out');
  assert.doesNotMatch(xml, /secret-draft/, 'draft post out');
  assert.doesNotMatch(xml, /\/catering</, 'off channel page out');
  assert.match(xml, /<lastmod>2026-10-21<\/lastmod>/);
  assert.match(renderRobots('www.mozzpizza.com'), /Disallow: \/preview\nDisallow: \/api\/\nSitemap: https:\/\/www\.mozzpizza\.com\/sitemap\.xml/);
  assert.match(renderRobots('x', { offline: true }), /Disallow: \/\n/);
});

test('empty or broken data never throws: no snapshot, no menu, junk blocks, junk props', () => {
  const empty = { site: {}, pages: [], posts: [], locations: [] };
  assert.doesNotThrow(() => renderPage({ snapshot: empty, route: resolveRoute(empty, '/'), path: '/', host: 'x' }));
  assert.doesNotThrow(() => renderPage({ snapshot: null, path: '/', host: '' }));
  assert.doesNotThrow(() => renderPage({}));
  const ctx = buildCtx({ snapshot: empty, host: 'x', path: '/' });
  for (const type of BLOCK_TYPES) {
    assert.equal(typeof renderBlock(ctx, { type, props: defaultPropsFor(type) }), 'string', type);
    assert.equal(typeof renderBlock(ctx, { type, props: null }), 'string', `${type} null props`);
    assert.equal(typeof renderBlock(ctx, { type, props: { id: 1, location_id: {}, items: 'x', photos: 5, show: 'no' } }), 'string', `${type} junk props`);
  }
  assert.equal(renderBlock(ctx, { type: 'Nope', props: {} }), '');
  assert.equal(renderBlock(ctx, null), '');
  const s = snap();
  s.pages[0].layout = { content: [{ type: 'LiveMenu', props: {} }, 'junk', { type: 'FAQ', props: { items: 'x' } }] };
  const out = renderPage({ snapshot: s, route: resolveRoute(s, '/'), path: '/', host: 'x', menu: null });
  assert.match(out.body, /The menu is being updated/);
  assert.equal(h1Count(out.body), 1);
  assert.match(renderNoSite('<x>'), /&lt;x&gt;/);
  assert.match(renderDocument({ head: '<title>t</title>', body: '<p>b</p>', snapshot: { a: '</script>' }, path: '/' }), /\\u003c\/script>/);
});

test('agent A sample snapshot renders when present', { skip: !fs.existsSync(AGENT_A) }, () => {
  const s = JSON.parse(fs.readFileSync(AGENT_A, 'utf8'));
  for (const p of ['/', '/menu', '/order', '/find-us', '/blog', '/locations/mozz-leeds', '/locations/mozz-huddersfield']) {
    const out = renderPage({ snapshot: s, route: resolveRoute(s, p), path: p, host: 'mozz.sites.serv-os.app', menu: MENU, now: NOW });
    assert.equal(h1Count(out.body), 1, p);
    assert.notEqual(resolveRoute(s, p).kind, 'notfound', p);
  }
  const home = renderPage({ snapshot: s, route: resolveRoute(s, '/'), path: '/', host: 'mozz.sites.serv-os.app', menu: MENU, now: NOW });
  assert.match(home.body, /12 Call Lane/, 'addresses from the admin snapshot shape (slug, lat, lng)');
  assert.match(home.body, /£9\.50/);
  assert.ok(home.jsonld.filter((o) => o['@type'] === 'Restaurant').length >= 2);
  const hudds = home.jsonld.find((o) => o['@type'] === 'Restaurant' && /Huddersfield/.test(o.name));
  assert.ok(hudds && hudds.geo, 'coordinates from settings.geo when the row has none');
  const xml = renderSitemap(s, 'mozz.sites.serv-os.app');
  assert.match(xml, /\/locations\/mozz-leeds</);
  assert.match(xml, /\/blog\//);
  const post = resolveRoute(s, `/blog/${s.posts[0].slug}`);
  assert.equal(post.kind, 'post', 'posts without a status field are live in a published snapshot');
});

test('the site name is the business, never the keyword SEO title: header, footer, og:site_name, JSON-LD names, sub page titles', () => {
  const s = snap();
  s.site.seo.title = 'Mozz Pizza | Wood fired pizza in Leeds';
  for (const l of s.locations) if (l.online_branding) delete l.online_branding.logo_url;
  assert.equal(siteName(s), 'Mozz Pizza', 'company_name first');
  const home = render(s, '/');
  assert.match(home.head, /<title>Mozz Pizza \| Wood fired pizza in Leeds<\/title>/, 'the keyword title is still the home <title>');
  assert.match(home.head, /property="og:site_name" content="Mozz Pizza"/);
  assert.match(home.body, /<span>Mozz Pizza<\/span>/, 'header text when there is no logo image');
  assert.doesNotMatch(home.body, /<span>Mozz Pizza \| Wood fired/);
  assert.equal(home.jsonld.find((o) => o['@type'] === 'Organization').name, 'Mozz Pizza');
  assert.equal(home.jsonld.find((o) => o['@type'] === 'WebSite').name, 'Mozz Pizza');
  assert.match(render(s, '/order').head, /<title>Order \| Mozz Pizza<\/title>/);
  const post = render(s, '/blog/new-winter-menu');
  assert.equal(post.jsonld[0].publisher.name, 'Mozz Pizza');
  assert.match(post.head, /<title>Our new winter menu \| Mozz Pizza<\/title>/);
  // Fallback order when the company name is missing: branding display name, venue name, then the SEO title, then the slug.
  delete s.site.company_name;
  assert.equal(siteName(s), s.locations[0].online_branding.display_name);
  for (const l of s.locations) delete l.online_branding;
  assert.equal(siteName(s), 'Mozz Pizza Leeds');
  s.locations = [];
  assert.equal(siteName(s), 'Mozz Pizza | Wood fired pizza in Leeds');
  s.site.seo = {};
  assert.equal(siteName(s), 'mozz');
  assert.equal(siteName(null), 'Our site');
});

test('canonical, og:url and robots sitemap name the custom domain only once its DNS is live', () => {
  const s = snap();
  s.site.custom_domain = 'www.notlive.com';
  // The free address, domain typed but not pointed yet: every URL stays on the host that answers.
  const pending = renderPage({ snapshot: s, route: resolveRoute(s, '/menu'), path: '/menu', host: 'mozz.sites.serv-os.app', menu: MENU, now: NOW });
  assert.equal(pending.canonical, 'https://mozz.sites.serv-os.app/menu');
  assert.match(pending.head, /property="og:url" content="https:\/\/mozz\.sites\.serv-os\.app\/menu"/);
  assert.doesNotMatch(pending.head, /notlive/);
  // The domain is live: the free host consolidates to it.
  s.site.domain_live = true;
  const live = renderPage({ snapshot: s, route: resolveRoute(s, '/menu'), path: '/menu', host: 'mozz.sites.serv-os.app', menu: MENU, now: NOW });
  assert.equal(live.canonical, 'https://www.notlive.com/menu');
  // A request that already arrived on the domain keeps it even before the flag (the host answered).
  s.site.domain_live = false;
  assert.equal(renderPage({ snapshot: s, route: resolveRoute(s, '/'), path: '/', host: 'www.notlive.com', now: NOW }).canonical, 'https://www.notlive.com/');
});

test('draft previews are noindex (robots meta and the flag api/site.js turns into X-Robots-Tag)', () => {
  const s = snap();
  const draft = renderPage({ snapshot: s, route: resolveRoute(s, '/'), path: '/', host: 'x.sites.serv-os.app', status: 'draft', now: NOW });
  assert.equal(draft.noindex, true);
  assert.equal(draft.preview, true);
  assert.match(draft.head, /name="robots" content="noindex, nofollow"/);
  assert.equal(renderPage({ snapshot: s, route: resolveRoute(s, '/'), path: '/', host: 'x', preview: true, now: NOW }).noindex, true, 'an explicit preview flag');
  const marked = { ...s, preview: true };
  assert.equal(renderPage({ snapshot: marked, route: resolveRoute(marked, '/'), path: '/', host: 'x', now: NOW }).noindex, true, 'a snapshot the draft loader marked');
  const live = renderPage({ snapshot: s, route: resolveRoute(s, '/'), path: '/', host: 'x', status: 'live', now: NOW });
  assert.equal(live.noindex, false);
  assert.equal(live.preview, false);
});

test('every page carries a meta description: hero sub line, else first text block, else a plain sentence', () => {
  const s = snap();
  s.site.seo = {};
  for (const p of s.pages) p.seo = {};
  s.pages[0].layout = { content: [{ type: 'Hero', props: { id: 'h', headline: 'Hi', sub: '  Wood fired pizza, fresh every day.  ' } }] };
  const home = render(s, '/');
  assert.equal(home.description, 'Wood fired pizza, fresh every day.');
  assert.match(home.head, /<meta name="description" content="Wood fired pizza, fresh every day\.">/);
  assert.match(home.head, /property="og:description" content="Wood fired pizza, fresh every day\."/);
  s.pages[0].layout = { content: [{ type: 'Hero', props: { id: 'h', headline: 'Hi' } }, { type: 'Text', props: { id: 't', md: '## About us\n\nWe have made **pizza** in Leeds since the oven arrived.' } }] };
  assert.equal(render(s, '/').description, 'About us We have made pizza in Leeds since the oven arrived.');
  s.pages[0].layout = { content: [] };
  assert.equal(render(s, '/').description, 'Mozz Pizza: menu, opening hours and online ordering.');
  assert.match(render(s, '/').head, /<meta name="description" content="Mozz Pizza: menu, opening hours and online ordering\.">/);
  assert.equal(fallbackDescription(null, 'X'), 'X: menu, opening hours and online ordering.');
  assert.equal(fallbackDescription({ layout: { content: [{ type: 'Hero', props: { sub: 'a'.repeat(200) } }] } }, 'X').length, 155);
  assert.ok(render(s, '/nothing-here').description, 'even the 404 page has one');
});

// 5.12.5: Provo's hours are 00:00 to 00:00 every day (Back Office's "all day"); the site printed
// that literally. Same minute open and close reads as open all day, and schema.org gets 00:00 to 23:59.
test('a window that opens and closes at the same minute is open all day', () => {
  const hours = { weekly: { mon: [{ open: '00:00', close: '00:00' }], tue: [{ open: '11:30', close: '23:00' }], wed: [] } };
  const rows = hoursRows(hours, 'America/Denver', { todayFirst: false, now: new Date('2026-11-02T18:00:00Z') });
  assert.equal(rows[0].text, 'Open 24 hours');
  assert.equal(rows[1].text, '11:30 to 23:00');
  assert.equal(rows[2].text, 'Closed');
  const spec = openingHoursSpecification(hours);
  assert.deepEqual(spec[0], { '@type': 'OpeningHoursSpecification', dayOfWeek: 'Monday', opens: '00:00', closes: '23:59' });
  assert.equal(spec[1].closes, '23:00');
  assert.equal(allDayWindow({ open: '09:00', close: '09:00' }), true);
  assert.equal(allDayWindow({ open: '09:00', close: '17:00' }), false);
  assert.equal(allDayWindow(null), false);
});
