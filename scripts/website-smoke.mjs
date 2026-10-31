#!/usr/bin/env node
// scripts/website-smoke.mjs
//
// Website builder smoke check, no network, no database. Loads the sample snapshot, renders the
// pages a crawler cares about with the SAME renderer api/site.js uses, and checks the SEO basics:
// one <h1>, JSON-LD that parses, a sitemap with every page, robots with the Sitemap line.
// Run: node scripts/website-smoke.mjs   (prints OK, exit 0; prints the failures, exit 1)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveRoute, sitemapPaths } from '../src/surfaces/website/routes.js';
import { renderPage, renderSitemap, renderRobots } from '../src/surfaces/website/ssr/renderBlocks.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, '..', 'src', 'lib', 'website', 'fixtures', 'snapshot.sample.json');
const snapshot = JSON.parse(fs.readFileSync(fixture, 'utf8'));
const host = `${snapshot.site.slug}.sites.serv-os.app`;

const failures = [];
const check = (ok, what) => { if (!ok) failures.push(what); };

// A small menu so the menu page and its JSON-LD have real items without a database.
const menu = {
  categories: [{ id: 'c1', label: 'Pizza', items: [
    { id: 'i1', name: 'Margherita', description: 'Tomato, fior di latte, basil', price: 9.5, currency: 'GBP', image: '', dietary: ['V'], allergens: ['gluten', 'milk'], sold_out: false },
    { id: 'i2', name: 'Diavola', description: 'Spicy salami', price: 12, currency: 'GBP', image: '', dietary: [], allergens: ['gluten', 'milk'], sold_out: true },
  ] }],
  specials: [],
};

const pages = snapshot.pages || [];
const menuPage = pages.find((p) => p.kind === 'menu');
const loc = (snapshot.locations || [])[0];
const post = (snapshot.posts || [])[0];
const targets = [
  { name: 'home', path: '/' },
  { name: 'menu', path: menuPage ? `/${menuPage.slug}` : '/menu', menu },
  { name: 'location', path: loc ? `/locations/${loc.slug || loc.online_slug}` : '/locations/x' },
  { name: 'blog list', path: '/blog' },
  { name: 'post', path: post ? `/blog/${post.slug}` : '/blog/x' },
];

for (const t of targets) {
  let out;
  try {
    const route = resolveRoute(snapshot, t.path);
    check(route.kind !== 'notfound', `${t.name}: ${t.path} resolved to not found`);
    out = renderPage({ snapshot, route, path: t.path, host, menu: t.menu || null, customerRoot: 'serv-os.app', status: 'live' });
  } catch (e) {
    failures.push(`${t.name}: renderPage threw ${e && e.message}`);
    continue;
  }
  const h1s = (out.body.match(/<h1[\s>]/g) || []).length;
  check(h1s === 1, `${t.name}: expected one <h1>, found ${h1s}`);
  check(/<title>[^<]+<\/title>/.test(out.head), `${t.name}: no <title>`);
  check(/<meta name="description"/.test(out.head), `${t.name}: no meta description`);
  check(/<link rel="canonical"/.test(out.head), `${t.name}: no canonical link`);
  const scripts = [...out.head.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  check(scripts.length > 0, `${t.name}: no JSON-LD`);
  for (const s of scripts) {
    try {
      const ld = JSON.parse(s);
      const types = [].concat(ld['@graph'] || ld).map((x) => x && x['@type']).filter(Boolean);
      check(types.length > 0, `${t.name}: JSON-LD has no @type`);
    } catch (e) { failures.push(`${t.name}: JSON-LD does not parse (${e.message})`); }
  }
  if (t.menu) check(/Margherita/.test(out.body) && /9\.50/.test(out.body), 'menu: item name and price missing from the HTML');
  if (t.menu) check(/"@type":\s*"Menu"/.test(out.head), 'menu: no Menu JSON-LD');
  if (t.name === 'post') check(/"@type":\s*"BlogPosting"/.test(out.head), 'post: no BlogPosting JSON-LD');
  if (t.name === 'location') check(/"@type":\s*"(Restaurant|FoodEstablishment)"/.test(out.head), 'location: no Restaurant JSON-LD');
}

// Sitemap: every published page path and every post.
const sitemap = renderSitemap(snapshot, host);
check(/<urlset/.test(sitemap), 'sitemap: no <urlset>');
for (const p of sitemapPaths(snapshot)) {
  check(sitemap.includes(`https://${host}${p.path}`), `sitemap: missing ${p.path}`);
}
for (const p of pages.filter((x) => x.kind !== 'location' && x.status !== 'draft')) {
  const expected = p.slug ? `/${p.slug}` : '/';
  check(sitemap.includes(`https://${host}${expected}</loc>`) || sitemap.includes(`https://${host}${expected}<`), `sitemap: page ${expected} missing`);
}

// Robots.
const robots = renderRobots(host);
check(/^Sitemap: https:\/\//m.test(robots), 'robots: no Sitemap line');
check(/Disallow: \/preview/.test(robots), 'robots: /preview not disallowed');

// Empty data never throws.
try {
  const r = renderPage({ snapshot: { site: {}, pages: [], posts: [], locations: [] }, route: resolveRoute({ site: {}, pages: [] }, '/'), path: '/', host: 'x.sites.serv-os.app' });
  check(typeof r.body === 'string', 'empty snapshot: no body');
} catch (e) { failures.push(`empty snapshot threw ${e && e.message}`); }

if (failures.length) {
  console.error('Website smoke FAILED');
  for (const f of failures) console.error(' - ' + f);
  process.exit(1);
}
console.log('OK');
