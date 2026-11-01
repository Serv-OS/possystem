// Host parsing (ARCHITECTURE.md sections 3 and 13 B): the free address and custom domains are
// website hosts, every host that is ours today keeps doing what it does. Plus the SPA wiring: the
// customerUrl.js branch, the App.jsx branch and the vercel.json rewrites exist as the contract says.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseWebsiteHost, parseWebsiteLocation, isWebsiteTestingHost, canonicalHost, freeSiteSuffixes, ownHostSuffixes, siteQueryFor } from './hostParse.js';
import { parseCustomerLocation } from '../../lib/customerHost.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.resolve(here, rel), 'utf8');

test('free address: <slug>.sites.serv-os.app (and the tier zone) is a free site', () => {
  assert.deepEqual(parseWebsiteHost('mozz.sites.serv-os.app'), { kind: 'free', slug: 'mozz' });
  assert.deepEqual(parseWebsiteHost('MOZZ.Sites.Serv-OS.app:443'), { kind: 'free', slug: 'mozz' });
  assert.deepEqual(parseWebsiteHost('mozz.sites.dev.serv-os.app', 'dev.serv-os.app'), { kind: 'free', slug: 'mozz' });
  assert.equal(parseWebsiteHost('a.b.sites.serv-os.app'), null, 'two labels is not a slug');
  assert.equal(parseWebsiteHost('sites.serv-os.app'), null);
  assert.ok(freeSiteSuffixes('dev.serv-os.app').includes('.sites.dev.serv-os.app'));
});

test('custom domains are website hosts', () => {
  assert.deepEqual(parseWebsiteHost('www.mozzpizza.com'), { kind: 'custom', host: 'www.mozzpizza.com' });
  assert.deepEqual(parseWebsiteHost('mozzpizza.com'), { kind: 'custom', host: 'mozzpizza.com' });
  assert.deepEqual(parseWebsiteHost('order.somepizza.co.uk'), { kind: 'custom', host: 'order.somepizza.co.uk' });
});

test('our own hosts are never website hosts: ordering, operator, previews, local, IPs', () => {
  for (const h of ['mozz.serv-os.app', 'coffee-boy-huddersfield.serv-os.app', 'app.serv-os.app', 'dev.serv-os.app', 'mozz.dev.serv-os.app', 'serv-os.app', 'www.serv-os.app',
    'mozz.wifi.serv-os.app', 'x.servos.app', 'x.pos-up.com', 'possystem-liard.vercel.app', 'possystem-git-main-x.vercel.app', 'localhost', 'localhost:5173', '127.0.0.1', '192.168.1.5:5173', '', null]) {
    assert.equal(parseWebsiteHost(h), null, h);
  }
  assert.ok(ownHostSuffixes().includes('.vercel.app'));
});

test('mozz.serv-os.app stays online ordering in the shared parser', () => {
  const r = parseCustomerLocation({ hostname: 'mozz.serv-os.app', pathname: '/', search: '' }, { customerRoot: 'serv-os.app' });
  assert.equal(r.mode, 'online');
  assert.equal(r.slug, 'mozz');
});

test('canonical host: the custom domain only once it is live (or already asked for), else the free address or the request host', () => {
  assert.equal(canonicalHost({ custom_domain: 'www.mozzpizza.com', slug: 'mozz', domain_live: true }), 'www.mozzpizza.com');
  assert.equal(canonicalHost({ custom_domain: 'www.mozzpizza.com', slug: 'mozz', domain_live: true }, 'mozz.sites.serv-os.app'), 'www.mozzpizza.com', 'live domain wins over the free host');
  assert.equal(canonicalHost({ custom_domain: 'www.mozzpizza.com', slug: 'mozz' }, 'mozz.sites.serv-os.app'), 'mozz.sites.serv-os.app', 'a domain with no DNS yet is never the canonical');
  assert.equal(canonicalHost({ custom_domain: 'www.mozzpizza.com', slug: 'mozz' }, 'www.mozzpizza.com'), 'www.mozzpizza.com', 'a request that arrived on the domain keeps it');
  assert.equal(canonicalHost({ slug: 'mozz' }), 'mozz.sites.serv-os.app');
  assert.equal(canonicalHost({}, 'Whatever.Host'), 'whatever.host');
});

test('?site= is a testing door: never on a venue host, never over a customer surface', () => {
  const at = (hostname, pathname = '/', search = '') => parseWebsiteLocation({ hostname, pathname, search }, { customerRoot: 'serv-os.app' });
  // The WiFi relay sends guests to /wifi?site=<unifi site id> on the venue's wifi host: that is the portal, not a website.
  assert.equal(at('mozz.wifi.serv-os.app', '/wifi', '?site=abc123xy&id=aa:bb&ap=cc:dd'), null);
  assert.equal(parseCustomerLocation({ hostname: 'mozz.wifi.serv-os.app', pathname: '/wifi', search: '?site=abc123xy' }, { customerRoot: 'serv-os.app' }).mode, 'wifi');
  assert.equal(at('mozz.wifi.serv-os.app', '/guest/s/default/', '?site=default'), null);
  // An ordering link that happens to carry ?site= stays online ordering.
  assert.equal(at('coffee-boy.serv-os.app', '/', '?site=default'), null);
  assert.equal(parseCustomerLocation({ hostname: 'coffee-boy.serv-os.app', pathname: '/', search: '?site=default' }, { customerRoot: 'serv-os.app' }).mode, 'online');
  assert.equal(at('mozz.serv-os.app', '/t/5', '?site=mozz'), null);
  // Real website hosts need no door.
  assert.deepEqual(at('mozz.sites.serv-os.app'), { mode: 'website', host: 'mozz.sites.serv-os.app', siteSlug: 'mozz', slug: null, tableId: null, groupSlug: null });
  assert.equal(at('www.mozzpizza.com', '/menu').siteSlug, null);
  assert.equal(at('www.mozzpizza.com', '/menu').mode, 'website');
  // The door opens on testing hosts, for a plain path only.
  assert.deepEqual(at('localhost', '/', '?site=mozz'), { mode: 'website', host: 'localhost', siteSlug: 'mozz', slug: null, tableId: null, groupSlug: null });
  assert.equal(at('localhost', '/menu', '?site=mozz').siteSlug, 'mozz');
  assert.equal(at('127.0.0.1', '/', '?site=mozz').siteSlug, 'mozz');
  assert.equal(at('possystem-git-x.vercel.app', '/', '?site=mozz').siteSlug, 'mozz');
  assert.equal(at('app.serv-os.app', '/', '?site=mozz').siteSlug, 'mozz');
  assert.equal(at('localhost', '/wifi', '?site=mozz'), null, 'the WiFi page on localhost is still the WiFi page');
  assert.equal(at('localhost', '/gift', '?site=mozz'), null);
  assert.equal(at('localhost', '/', '?site=mozz&loc=peters-cafe'), null, '?loc= names a venue: online ordering wins');
  assert.equal(at('localhost', '/', '?site=mozz&surface=kiosk'), null);
  assert.equal(at('localhost', '/', '?site=ab'), null, 'too short');
  assert.equal(at('localhost', '/', '?site=Not%20A%20Slug'), null);
  assert.equal(at('localhost', '/', ''), null);
  assert.equal(at(null), null);
  for (const h of ['localhost', 'localhost:5173', 'app.localhost', '127.0.0.1', '192.168.1.5', 'x.vercel.app', 'app.serv-os.app', 'app.dev.serv-os.app', 'dev.serv-os.app']) assert.equal(isWebsiteTestingHost(h, 'dev.serv-os.app'), true, h);
  for (const h of ['mozz.serv-os.app', 'mozz.wifi.serv-os.app', 'mozz.dev.serv-os.app', 'www.mozzpizza.com', 'mozz.sites.serv-os.app']) assert.equal(isWebsiteTestingHost(h, 'dev.serv-os.app'), false, h);
});

test('wiring: customerUrl.js, App.jsx and vercel.json carry the website branch', () => {
  const cu = read('../../lib/customerUrl.js');
  assert.match(cu, /parseWebsiteLocation\(loc, \{ customerRoot: CUSTOMER_ROOT \}\)/, 'the pure rule in hostParse.js decides, with the tier root');
  assert.doesNotMatch(cu, /params\.get\('site'\)/, 'no second ?site= door in the Vite file (it hijacked the WiFi portal once)');
  assert.match(cu, /return parseCustomerLocation\(loc, \{ customerRoot: CUSTOMER_ROOT, readStoredSlug \}\)/, 'every existing mode still goes through the shared parser');
  const app = read('../../App.jsx');
  assert.match(app, /lazy\(\(\) => import\('\.\/surfaces\/website\/WebsiteSurface\.jsx'\)\)/);
  assert.ok(app.indexOf("customerCtx?.mode === 'website'") < app.indexOf("customerCtx?.mode === 'group'"), 'website branch sits before the other customer modes');
  const vercel = JSON.parse(read('../../../vercel.json'));
  const rw = vercel.rewrites;
  assert.equal(rw[0].source, '/api/(.*)', 'api rewrite stays first');
  assert.equal(rw[rw.length - 1].destination, '/index.html', 'SPA catch all stays last');
  const sites = rw.find((r) => r.has && /sites/.test(r.has[0].value));
  const custom = rw.find((r) => r.has && /\?!/.test(r.has[0].value));
  assert.equal(sites.destination, '/api/site?path=/$1');
  assert.equal(custom.destination, '/api/site?path=/$1');
  assert.match(custom.has[0].value, /vercel\\\.app/);
  assert.match(custom.has[0].value, /localhost/);
  for (const src of ['/assets/(.*)', '/favicon(.*)', '/.well-known/(.*)']) {
    assert.ok(rw.findIndex((r) => r.source === src) < rw.indexOf(sites), `${src} is rewritten to itself before the site rewrites`);
  }
  assert.ok(vercel.headers.some((h) => h.source === '/assets/(.*)'), 'existing headers kept');
});

// 5.12.6: the logo on posup-test.sites.serv-os.app took visitors to "/?site=posup-test". The
// testing query rides along only where it already was.
test('siteQueryFor keeps ?site= only when the address already carries it', () => {
  assert.equal(siteQueryFor('', 'posup-test'), '');
  assert.equal(siteQueryFor('?utm=x', 'posup-test'), '');
  assert.equal(siteQueryFor('?site=mozz', 'mozz'), '?site=mozz');
  assert.equal(siteQueryFor('?site=mozz&x=1', null), '?site=mozz');
  assert.equal(siteQueryFor(undefined, undefined), '');
});
