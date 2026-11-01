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
import { BLOCK_TYPES, defaultPropsFor, walkBlocks } from './blocks/schema.js';
import { isDarkHex } from './theme.js';
import { menuBlockOf } from '../../../api/_lib/website/menuForPage.js';

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
  // 5.12.8: the hero and order bar (plain links) still ask first; the menu item Order buttons go to
  // the venue whose menu is on the page (Leeds, the default), which is the one straight line allowed.
  const beforeMenu = out.body.slice(0, out.body.indexOf('data-block="LiveMenu"'));
  assert.doesNotMatch(beforeMenu, /href="https:\/\/mozz-leeds\.serv-os\.app\/"/, 'no straight line to one venue from a plain link');
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

// 5.12.8 (Peter, 1 Nov): "show menu A on the home page, then buttons or a drop down to say
// location 1 or location 2 menu"; and the header options from Back Office.
test('venue switch: buttons above an unpinned menu on a group site, the shown venue marked, order buttons go to that venue', () => {
  const s = snap();
  const out = render(s, '/');
  assert.match(out.body, /<nav class="w-venue-switch" aria-label="Choose a venue">/);
  assert.match(out.body, /<a class="w-venue-btn" href="\/\?venue=mozz-huddersfield">Mozz Pizza Huddersfield menu<\/a>/);
  assert.match(out.body, /<a class="w-venue-btn" href="\/\?venue=mozz-leeds" aria-current="true">Mozz Pizza Leeds menu<\/a>/, 'the default venue is the one shown');
  assert.doesNotMatch(out.body, /Dark kitchen menu/, 'a venue with no online slug cannot be picked');
  const picked = render(s, '/', { menuVenue: 'mozz-huddersfield' });
  assert.match(picked.body, /href="\/\?venue=mozz-huddersfield" aria-current="true"/);
  assert.doesNotMatch(picked.body, /href="\/\?venue=mozz-leeds" aria-current="true"/);
});

test('venue switch: dropdown is a plain GET form; none hides it; a venue page and a one venue site never show it, a pinned block still does', () => {
  const s = snap();
  const menuBlock = (page) => page.layout.content.find((b) => b.type === 'LiveMenu');
  menuBlock(s.pages[0]).props.venue_switch = 'dropdown';
  const dd = render(s, '/');
  assert.match(dd.body, /<form class="w-venue-form" method="get" action="\/"><label>Menu for <select name="venue" aria-label="Choose a venue">/);
  assert.match(dd.body, /<option value="mozz-leeds" selected>Mozz Pizza Leeds menu<\/option>/);
  assert.match(dd.body, /<button type="submit" class="w-btn w-btn-secondary">Show<\/button>/);
  menuBlock(s.pages[0]).props.venue_switch = 'none';
  assert.doesNotMatch(render(s, '/').body, /w-venue-/);
  const t = snap();
  menuBlock(t.pages[0]).props.location_id = 'loc-hudds';
  const pinned = render(t, '/');
  assert.match(pinned.body, /href="\/\?venue=mozz-huddersfield" aria-current="true"/, '5.12.9: a block that names a venue starts on it and still offers the switch');
  const picked = render(t, '/', { menuVenue: 'mozz-leeds' });
  assert.match(picked.body, /href="\/\?venue=mozz-leeds" aria-current="true"/, 'the visitor pick wins over the starting venue');
  assert.doesNotMatch(render(t, '/locations/mozz-huddersfield', { menuVenue: 'mozz-leeds' }).body, /w-venue-/, 'a venue page: no switch');
  const one = snap();
  one.locations = one.locations.filter((l) => l.id === 'loc-leeds');
  assert.doesNotMatch(render(one, '/').body, /w-venue-/, 'one venue: nothing to switch');
});

test('live menu order buttons: ask which venue until the visitor picked one, then straight to that venue; a venue page goes straight', () => {
  const s = snap();
  s.pages[0].layout.content.find((b) => b.type === 'LiveMenu').props.show = { prices: true, add_button: true };
  const none = render(s, '/').body;
  const menuPart = none.slice(none.indexOf('data-block="LiveMenu"'));
  assert.match(menuPart, /class="w-btn w-btn-secondary" href="\/order">Order<\/a>/, '5.12.9: no pick yet = the choose your venue page');
  assert.doesNotMatch(menuPart, /href="https:\/\/mozz-leeds\.serv-os\.app\/">Order/, 'never straight to a venue the visitor did not choose');
  const picked = render(s, '/', { menuVenue: 'mozz-huddersfield' });
  assert.match(picked.body, /data-block="LiveMenu"[\s\S]*href="https:\/\/mozz-huddersfield\.serv-os\.app\/">Order/, 'picked: straight to that venue');
  s.pages.find((p) => p.id === 'p-loc-leeds').layout.content.find((b) => b.type === 'LiveMenu').props.show = { prices: true, add_button: true };
  const venuePage = render(s, '/locations/mozz-leeds', { menuVenue: 'mozz-huddersfield' }).body;
  assert.match(venuePage, /data-block="LiveMenu"[\s\S]*href="https:\/\/mozz-leeds\.serv-os\.app\/">Order/, 'a venue page orders at that venue, whatever the pick says');
  assert.doesNotMatch(venuePage, /w-venue-btn/, 'and shows no switch');
  const one = snap();
  one.locations = one.locations.filter((l) => l.id === 'loc-leeds');
  one.pages[0].layout.content.find((b) => b.type === 'LiveMenu').props.show = { prices: true, add_button: true };
  assert.match(render(one, '/').body, /data-block="LiveMenu"[\s\S]*href="https:\/\/mozz-leeds\.serv-os\.app\/">Order/, 'one venue: straight there');
});

test('header options: brand mark, header button and sticky follow settings.header; defaults keep the old header', () => {
  const s = snap();
  const base = render(s, '/').body;
  assert.match(base, /<header class="w-header"><div class="w-inner"><a class="w-logo" href="\/" aria-label="Mozz Pizza home"><img /);
  assert.doesNotMatch(base, /w-header-cta/);
  s.site.settings.header = { brand: 'name', cta: 'order', sticky: false };
  const out = render(s, '/').body;
  assert.match(out, /<header class="w-header" data-sticky="false">/);
  assert.match(out, /<a class="w-logo" href="\/" aria-label="Mozz Pizza home"><span>Mozz Pizza<\/span><\/a>/, 'name only, no img');
  assert.match(out, /<a class="w-nav-link w-header-cta" href="\/order">Order now<\/a><\/nav>/, 'group site: the button goes to the venue chooser');
  s.site.settings.header = { brand: 'both', cta: 'book' };
  const both = render(s, '/').body;
  assert.match(both, /<a class="w-logo" href="\/" aria-label="Mozz Pizza home"><img [^>]*><span>Mozz Pizza<\/span><\/a>/);
  // 5.12.15 (Peter: "you should be able to change the logo size in the header"): logo_size is a
  // header attribute the CSS sizes the mark by; normal (the default) adds nothing.
  assert.doesNotMatch(both, /data-logo=/);
  s.site.settings.header = { logo_size: 'xlarge' };
  assert.match(render(s, '/').body, /<header class="w-header" data-logo="xlarge">/);
  s.site.settings.header = { logo_size: 'huge' };
  assert.doesNotMatch(render(s, '/').body, /data-logo=/, 'an unknown size falls back to normal');
  assert.match(both, /w-header-cta" href="\/order\/book">Book a table<\/a>/);
  s.site.settings.header = { brand: 'nonsense', cta: 'nope', sticky: 'maybe' };
  assert.equal(render(s, '/').body.includes('w-header-cta'), false, 'odd values fall back to the defaults, never a throw');
});

test('5.12.9 menu cards are buttons that open the item sheet: role, tabindex and haspopup on the server markup too', () => {
  const s = snap();
  const out = render(s, '/menu').body;
  assert.match(out, /<article class="w-menu-item" data-item="i1" role="button" tabindex="0" aria-haspopup="dialog"><div><h4 class="w-menu-name">Margherita<\/h4>/, 'LiveMenu card, attribute order as React paints it');
  const ctx = buildCtx({ snapshot: s, host: 'www.mozzpizza.com', path: '/menu', menu: MENU, now: NOW });
  const shown = renderBlock(ctx, { type: 'LiveMenu', props: { ...defaultPropsFor('LiveMenu'), id: 'm-all', show: { prices: true, add_button: true, hide_sold_out: false } } });
  assert.match(shown, /<article class="w-menu-item w-menu-item-soldout" data-item="i2" role="button" tabindex="0" aria-haspopup="dialog">/, 'a sold out card (when shown) is still tappable');
  assert.match(shown, /data-item="i1"[^>]*aria-haspopup="dialog">[\s\S]*?<a class="w-btn w-btn-secondary" href="\/order">Order<\/a><\/div><\/article>/, 'the card keeps its own Order link (no venue picked on a group site: the chooser)');
  const home = render(s, '/').body;
  assert.match(home, /data-block="Specials"[\s\S]*<article class="w-menu-item" data-item="i1" role="button" tabindex="0" aria-haspopup="dialog">/, 'Specials card');
  assert.doesNotMatch(out, /w-sheet/, 'the server renders no sheet: it opens on a tap');
  assert.doesNotMatch(out, /role="dialog"/);
});

// ── Row block (5.12.9) ───────────────────────────────────────────────────────
const rowCtx = (s = snap()) => buildCtx({ snapshot: s, host: 'www.mozzpizza.com', path: '/', menu: MENU, now: NOW });
const rowBlock = (props) => ({ type: 'Row', props: { id: 'row1', ...props } });

test('Row: two columns holding a Text and a LiveMenu paint the grid, the data attributes, the style variables and nested blocks', () => {
  const html = renderBlock(rowCtx(), rowBlock({
    columns: '2', full_width: true,
    background: { color: '#1b1b1b', image: 'https://x/bg.jpg', darken: true, tone: 'auto' },
    col_bg: { col2: '#ffffff' },
    col1: [{ type: 'Text', props: { id: 't1', md: 'Hello **there**' } }],
    col2: [{ type: 'LiveMenu', props: { id: 'm1', layout: 'list' } }],
  }));
  assert.match(html, /^<section class="w-block w-row" data-block="Row" data-id="row1" data-cols="2" data-full="true" data-width="page" data-colpad="normal" data-tone="light"/);
  assert.match(html, /data-darken="true"/);
  assert.match(html, /style="--w-row-cols:2;--w-row-bg:#1b1b1b;--w-row-img:url\(&quot;https:\/\/x\/bg\.jpg&quot;\)"/);
  assert.match(html, /<div class="w-inner w-row-grid">/);
  assert.equal((html.match(/<div class="w-row-col"/g) || []).length, 2, 'only the columns that exist');
  assert.match(html, /<div class="w-row-col" data-col="2" data-bg="true" style="--w-col-bg:#ffffff">/);
  assert.match(html, /<section class="w-block w-text" data-block="Text" data-id="t1" data-nested="true" data-inset="normal">/, 'a nested block is marked nested and, for text, inset');
  assert.match(html, /<strong>there<\/strong>/);
  assert.match(html, /data-block="LiveMenu" data-id="m1" data-nested="true"/);
  assert.match(html, /Margherita/, 'the nested menu renders the live items');
  assert.doesNotMatch(html, /<script/);
});

test('Row: tone follows the background; one column for columns 1; junk slots, junk colours and junk photo URLs are ignored; a Row in a Row paints nothing', () => {
  const ctx = rowCtx();
  const plain = renderBlock(ctx, rowBlock({ columns: '1', col1: [{ type: 'Text', props: { id: 't', md: 'x' } }] }));
  assert.match(plain, /data-cols="1" data-full="false"/);
  assert.doesNotMatch(plain, /data-tone/, 'no background = inherit the page tone');
  assert.equal((plain.match(/<div class="w-row-col"/g) || []).length, 1);
  assert.match(plain, /style="--w-row-cols:1"/);
  const light = renderBlock(ctx, rowBlock({ background: { color: '#f6f2ec' } }));
  assert.doesNotMatch(light, /data-tone/, 'a light colour inherits');
  const forced = renderBlock(ctx, rowBlock({ background: { color: '#f6f2ec', tone: 'dark' } }));
  assert.match(forced, /data-tone="dark"/);
  const dark = renderBlock(ctx, rowBlock({ background: { color: '#102030' } }));
  assert.match(dark, /data-tone="light"/, 'light text on a dark row colour');
  const junk = renderBlock(ctx, rowBlock({ columns: 'nine', col1: 'junk', col2: [null, 7, { type: 'Nope', props: {} }, { type: 'Row', props: { id: 'inner', col1: [{ type: 'Text', props: { md: 'deep' } }] } }, { type: 'Text', props: { id: 't', md: 'ok' } }], background: { color: 'red', image: 'javascript:alert(1)' }, col_bg: { col1: 'url(x)' } }));
  assert.match(junk, /data-cols="2"/, 'a junk column count falls back to the default');
  assert.doesNotMatch(junk, /--w-row-bg|--w-row-img|--w-col-bg|javascript|url\(x\)/, 'junk colours and URLs never reach the style attribute');
  assert.doesNotMatch(junk, /data-id="inner"|deep/, 'a Row inside a Row paints nothing');
  assert.match(junk, /data-id="t" data-nested="true"/, 'the valid block still renders');
  assert.equal(renderBlock(ctx, rowBlock({ columns: '3' })).match(/<div class="w-row-col"/g).length, 3, 'empty columns still paint');
  for (const bad of [{}, { col1: 1 }, { background: 'x' }, { col_bg: [] }, null]) assert.doesNotThrow(() => renderBlock(ctx, { type: 'Row', props: bad }));
});

test('Row on a page: the nested LiveMenu drives the page menu read (menuBlockOf), the Menu JSON-LD and the meta description', () => {
  const s = snap();
  const page = s.pages.find((p) => p.id === 'p-story');
  page.status = 'published'; // the fixture keeps this page as a draft
  page.seo = {}; // no owner description, so the fallback has to find the Text inside the Row
  page.layout = { root: { props: {} }, content: [rowBlock({
    col1: [{ type: 'Text', props: { id: 't', md: 'Our pizza is made with love in Leeds.' } }],
    col2: [{ type: 'LiveMenu', props: { id: 'm', location_id: 'loc-leeds', venue_switch: 'none' } }],
  })] };
  const found = menuBlockOf(page);
  assert.equal(found && found.type, 'LiveMenu');
  assert.equal(found.props.location_id, 'loc-leeds');
  assert.deepEqual(walkBlocks(page.layout).map((b) => b.type), ['Row', 'Text', 'LiveMenu']);
  const out = render(s, '/our-story');
  assert.match(out.body, /data-block="Row"/);
  assert.match(out.body, /data-block="LiveMenu" data-id="m" data-nested="true"/);
  assert.equal(h1Count(out.body), 1);
  assert.ok(out.jsonld.some((ld) => ld && ld['@type'] === 'Menu'), 'Menu JSON-LD for a nested LiveMenu');
  // The site's own seo.description wins on the page; the fallback (a page with none, on a site with none) reads into the Row.
  assert.match(fallbackDescription(page, 'Mozz Pizza'), /Our pizza is made with love in Leeds/, 'the first Text inside the Row gives the description');
});

test('isDarkHex: white text reads better on these; invalid input is never dark', () => {
  for (const hex of ['#000000', '#102030', '#1b1b1b', '#c8493b', '#333', '7a1f1f']) assert.equal(isDarkHex(hex), true, hex);
  for (const hex of ['#ffffff', '#f6f2ec', '#ffd166', '#fff', '#15C26A']) assert.equal(isDarkHex(hex), false, hex);
  for (const junk of ['', null, undefined, 'red', '#12345', '#gggggg', 'url(x)', 12]) assert.equal(isDarkHex(junk), false, String(junk));
});

// ── 5.12.10: Image, Heading, width, hero slideshow ──────────────────────────────
test('Image: paints the photo with fit, height, width and rounded data attributes, a caption and an optional link; no photo paints nothing', () => {
  const ctx = rowCtx();
  const html = renderBlock(ctx, { type: 'Image', props: { id: 'img1', url: 'https://x/p.jpg', alt: 'A <pizza>', caption: 'Our oven', fit: 'contain', height: 'tall', width: 'full', rounded: false, href: '/menu' } });
  assert.match(html, /^<section class="w-block w-image" data-block="Image" data-id="img1" data-fit="contain" data-height="tall" data-width="full" data-rounded="false">/);
  assert.match(html, /<a href="\/menu"><img src="https:\/\/x\/p\.jpg" alt="A &lt;pizza&gt;" loading="lazy"><\/a>/);
  assert.match(html, /<p class="w-image-caption">Our oven<\/p>/);
  const plain = renderBlock(ctx, { type: 'Image', props: { id: 'img2', url: 'https://x/p.jpg' } });
  assert.match(plain, /data-fit="cover" data-height="natural" data-width="page" data-rounded="true"/);
  assert.doesNotMatch(plain, /<a /);
  assert.equal(renderBlock(ctx, { type: 'Image', props: { id: 'img3', url: 'javascript:alert(1)' } }), '');
  assert.equal(renderBlock(ctx, { type: 'Image', props: { id: 'img4', url: '' } }), '');
});

test('Heading: h2 by default, h3 on level 3, align and sub line; empty text paints nothing', () => {
  const ctx = rowCtx();
  assert.match(renderBlock(ctx, { type: 'Heading', props: { id: 'hd1', text: 'Our <story>', sub: 'Since 2012' } }), /^<section class="w-block w-heading" data-block="Heading" data-id="hd1" data-align="left"><div class="w-inner"><h2 class="w-h2">Our &lt;story&gt;<\/h2><p class="w-heading-sub">Since 2012<\/p><\/div><\/section>$/);
  assert.match(renderBlock(ctx, { type: 'Heading', props: { id: 'hd2', text: 'Small', level: '3', align: 'center' } }), /data-align="center".*<h3 class="w-h2">Small<\/h3>/);
  assert.equal(renderBlock(ctx, { type: 'Heading', props: { id: 'hd3', text: '   ' } }), '');
});

test('Row: content width is page by default, wide or full when asked, junk is page; an Image in each column is nested', () => {
  const ctx = rowCtx();
  assert.match(renderBlock(ctx, rowBlock({ columns: '2' })), /data-full="false" data-width="page"/);
  assert.match(renderBlock(ctx, rowBlock({ columns: '2', width: 'full' })), /data-width="full"/);
  assert.match(renderBlock(ctx, rowBlock({ columns: '2', width: 'wide' })), /data-width="wide"/);
  assert.match(renderBlock(ctx, rowBlock({ columns: '2', width: 'huge' })), /data-width="page"/);
  const html = renderBlock(ctx, rowBlock({
    columns: '4',
    col1: [{ type: 'Image', props: { id: 'a', url: 'https://x/1.jpg' } }], col2: [{ type: 'Image', props: { id: 'b', url: 'https://x/2.jpg' } }],
    col3: [{ type: 'Image', props: { id: 'c', url: 'https://x/3.jpg' } }], col4: [{ type: 'Heading', props: { id: 'd', text: 'Four' } }],
  }));
  assert.equal((html.match(/data-block="Image" data-id="[abc]" data-nested="true"/g) || []).length, 3);
  assert.match(html, /data-block="Heading" data-id="d" data-nested="true"/);
});

test('Hero slideshow: one slide keeps the old markup; more slides paint layers (slide 1 active, others hidden), dots and the timing; still one h1', () => {
  const s = snap();
  const ctx = rowCtx(s);
  const single = renderBlock(ctx, { type: 'Hero', props: { id: 'h', headline: 'Hi', slides: [] } });
  assert.match(single, /^<section class="w-block w-hero w-hero-tall" data-block="Hero"/);
  assert.doesNotMatch(single, /w-hero-slide/);
  const ctx2 = rowCtx(s);
  const show = renderBlock(ctx2, { type: 'Hero', props: { id: 'h', headline: 'Hi', photo_url: 'https://x/1.jpg', slide_seconds: '8', slides: [
    { photo_url: 'https://x/2.jpg', headline: 'Two', sub: 'Second', button_label: 'Book', button_href: 'servos:book' },
    { headline: 'Three' },
  ] } });
  assert.match(show, /^<section class="w-block w-hero w-hero-slides w-hero-tall" data-block="Hero" data-id="h" data-photo="true" data-slides="3" data-seconds="8">/);
  assert.match(show, /<div class="w-hero-slide" data-slide="0" data-active="true" data-photo="true" style="background-image:url\(&quot;https:\/\/x\/1\.jpg&quot;\)"><div class="w-hero-body">(<div class="w-hero-status[^>]*>[^<]*<\/div>)?<h1>Hi<\/h1>/);
  assert.match(show, /<div class="w-hero-slide" data-slide="1" data-active="false" data-photo="true" style="[^"]+" aria-hidden="true"><div class="w-hero-body"><h2>Two<\/h2><p>Second<\/p>/);
  assert.match(show, /data-slide="2" data-active="false" data-photo="false" aria-hidden="true"/);
  assert.equal(h1Count(show), 1);
  assert.equal((show.match(/class="w-hero-dot"/g) || []).length, 3);
  assert.match(show, /aria-selected="true" aria-label="Slide 1" data-go="0"/);
  assert.match(show, /Book/);
});


// ── 5.12.12: column padding, hero colour, book switch, buttons, brand loyalty card, nav dropdown ──
test('Row: column padding is normal unless the owner picks one (5.12.15: at page width too)', () => {
  const ctx = rowCtx();
  assert.match(renderBlock(ctx, rowBlock({ columns: '2' })), /data-colpad="normal"/);
  assert.match(renderBlock(ctx, rowBlock({ columns: '2', width: 'full' })), /data-colpad="normal"/);
  assert.match(renderBlock(ctx, rowBlock({ columns: '2', width: 'full', col_padding: 'none' })), /data-colpad="none"/);
  assert.match(renderBlock(ctx, rowBlock({ columns: '2', col_padding: 'large' })), /data-colpad="large"/);
  assert.match(renderBlock(ctx, rowBlock({ columns: '2', col_padding: 'huge' })), /data-colpad="normal"/);
});

test('Hero: Show a photo off paints the background colour with a light tone on a dark colour; a colour alone is used when no photo exists', () => {
  const s = snap();
  const dark = renderBlock(rowCtx(s), { type: 'Hero', props: { id: 'h', headline: 'Hi', use_photo: false, bg_color: '#141414' } });
  assert.match(dark, /data-photo="false" data-tone="light" style="background-color:#141414"/);
  assert.doesNotMatch(dark, /background-image/);
  const light = renderBlock(rowCtx(s), { type: 'Hero', props: { id: 'h', headline: 'Hi', use_photo: false, bg_color: '#f6f6f6' } });
  assert.match(light, /data-tone="dark" style="background-color:#f6f6f6"/);
  const junk = renderBlock(rowCtx(s), { type: 'Hero', props: { id: 'h', headline: 'Hi', use_photo: false, bg_color: 'red' } });
  assert.doesNotMatch(junk, /data-tone|background-color/);
  const slides = renderBlock(rowCtx(s), { type: 'Hero', props: { id: 'h', headline: 'Hi', use_photo: false, bg_color: '#141414', slides: [{ headline: 'Two' }] } });
  assert.equal((slides.match(/data-tone="light" style="background-color:#141414"/g) || []).length, 2, 'both slides take the colour');
});

test('FindUs: the Book button can be switched off; Specials and LiveMenu paint the button under the items and Find my local store', () => {
  const s = snap();
  const on = renderBlock(rowCtx(s), { type: 'FindUs', props: { id: 'f', location_id: 'all', show_order_buttons: true } });
  const off = renderBlock(rowCtx(s), { type: 'FindUs', props: { id: 'f', location_id: 'all', show_order_buttons: true, show_book: false } });
  assert.ok(on.includes('>Book</a>') ? !off.includes('>Book</a>') : true, 'show_book false removes every Book button');
  assert.doesNotMatch(off, />Book<\/a>/);
  const sp = renderBlock(rowCtx(s), { type: 'Specials', props: { id: 'sp', title: 'Specials', button: { label: 'View full menu', href: '/menu' } } });
  assert.match(sp, /<div class="w-menu-more"><a class="w-btn w-btn-secondary" href="\/menu">View full menu<\/a><\/div><\/div><\/section>$/);
  const spNone = renderBlock(rowCtx(s), { type: 'Specials', props: { id: 'sp', title: 'Specials', button: { label: '', href: '/menu' } } });
  assert.doesNotMatch(spNone, /w-menu-more/);
  const lm = renderBlock(rowCtx(s), { type: 'LiveMenu', props: { id: 'm', show: { store_finder: true }, button: { label: 'See everything', href: '/menu' } } });
  assert.match(lm, /<div class="w-menu-more"><a class="w-btn w-btn-secondary" href="\/menu">See everything<\/a><a class="w-btn w-btn-secondary" href="[^"]+">Find my local store<\/a><\/div>/);
  const lmNone = renderBlock(rowCtx(s), { type: 'LiveMenu', props: { id: 'm' } });
  assert.doesNotMatch(lmNone, /w-menu-more/);
});

test('LoyaltyJoin: the card carries the site name, never one venue; header paints a dropdown for a nav item with children', () => {
  const s = snap();
  const html = renderBlock(rowCtx(s), { type: 'LoyaltyJoin', props: { id: 'l', headline: 'Join', show_card_preview: true, location_id: 'default' } });
  assert.match(html, new RegExp(`<div class="w-loyalty-card"><span>${siteName(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</span>`));
  s.site.nav = [{ label: 'Home', kind: 'page', page_id: '' }, { label: 'Locations', kind: 'locations' }];
  const out = render(s, '/');
  assert.match(out.body, /<div class="w-nav-item"><button type="button" class="w-nav-link w-nav-drop" aria-haspopup="true" aria-expanded="false">Locations<\/button><div class="w-nav-sub"><a class="w-nav-link" href="\/locations\//);
});


// ── 5.12.16: space left and right for text in a column ─────────────────────────────────────
test('Text, Heading and Button in a column carry data-inset (auto = normal); on the page they do not', () => {
  const ctx = rowCtx();
  const col = (block) => renderBlock(ctx, rowBlock({ columns: '1', col1: [block] }));
  assert.match(col({ type: 'Text', props: { id: 't1', md: 'Hi' } }), /data-block="Text"[^>]*data-inset="normal"/);
  assert.match(col({ type: 'Text', props: { id: 't1', md: 'Hi', pad: 'none' } }), /data-block="Text"[^>]*data-inset="none"/);
  assert.match(col({ type: 'Heading', props: { id: 'h1', text: 'Drink', pad: 'large' } }), /data-block="Heading"[^>]*data-inset="large"/);
  assert.match(col({ type: 'Button', props: { id: 'b1', label: 'View menu', href: '/menu', pad: 'small' } }), /data-block="Button"[^>]*data-inset="small"/);
  assert.match(col({ type: 'Text', props: { id: 't1', md: 'Hi', pad: 'huge' } }), /data-inset="normal"/, 'an unknown value is auto');
  assert.doesNotMatch(col({ type: 'Image', props: { id: 'i1', url: 'https://x/a.jpg' } }), /data-inset=/, 'a photo keeps the plain gutter');
  assert.doesNotMatch(renderBlock(ctx, { type: 'Text', props: { id: 't2', md: 'Page level' } }), /data-inset=/, 'on the page the gutter already gives space');
});
