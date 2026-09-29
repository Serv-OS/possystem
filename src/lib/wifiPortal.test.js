// The SPA side of the WiFi front door (lib/wifiPortal.js, lib/customerHost.js) and its wiring.
// 29 Sep 2026: guests land on <slug>.wifi.serv-os.app (the Fly relay, one fixed IPv4); on that host
// the page must reach Supabase through the relay, and on EVERY other host nothing may change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  wifiPortalSlug, isWifiPortalHost, wifiPortalDomain, wifiPortalZone, supabaseBaseUrls, portalAssetUrl,
  WIFI_FRONT_DOOR_IP, WIFI_PREAUTH_ALLOWANCES, WIFI_DEV_FRONT_DOOR_READY,
} from './wifiPortal.js';
import { parseCustomerLocation, slugFromHostname, rootDomainSuffixes } from './customerHost.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.resolve(here, rel), 'utf8');

const HUD = 'coffee-boy-huddersfield';
const OPS = 'https://tbetcegmszzotrwdtqhi.supabase.co';
const PLAT = 'https://yhzjgyrkyjabvhblqxzu.supabase.co';
const PORTAL_ORIGIN = `https://${HUD}.wifi.serv-os.app`;

// ── portal host ────────────────────────────────────────────────────────────────────────────────
test('portal hosts (prod and dev tier) give the venue slug; nothing else does', () => {
  assert.equal(wifiPortalSlug(`${HUD}.wifi.serv-os.app`), HUD);
  assert.equal(wifiPortalSlug(`${HUD}.wifi.dev.serv-os.app`), HUD);
  assert.equal(wifiPortalSlug(`${HUD.toUpperCase()}.WIFI.SERV-OS.APP`), HUD);
  for (const h of [`${HUD}.serv-os.app`, `${HUD}.dev.serv-os.app`, 'wifi.serv-os.app', 'app.serv-os.app', 'localhost',
    'possystem-liard.vercel.app', `a.b.wifi.serv-os.app`, `${HUD}.wifi.serv-os.app.evil.com`, '', null]) {
    assert.equal(wifiPortalSlug(h), null, String(h));
    assert.equal(isWifiPortalHost(h), false, String(h));
  }
});

test('the Domain UniFi is given: the LIVE front door on every tier until the dev one has DNS and a cert', () => {
  // 29 Sep review: *.wifi.dev.serv-os.app still resolved to Vercel's rotating IPs and failed TLS,
  // and real venues show in the dev Back Office, so a dev Domain would have broken a live venue.
  assert.equal(WIFI_DEV_FRONT_DOOR_READY, false, 'flip only once dig prints the front door IP and the cert is Issued');
  assert.equal(wifiPortalDomain(HUD, 'prod'), `${HUD}.wifi.serv-os.app`);
  assert.equal(wifiPortalDomain(HUD, 'dev'), `${HUD}.wifi.serv-os.app`);
  assert.equal(wifiPortalDomain(HUD, 'stage'), `${HUD}.wifi.serv-os.app`);
  assert.equal(wifiPortalZone('dev'), 'wifi.serv-os.app');
  // Once the dev records exist, the dev tier gets its own front door (and only the dev tier).
  assert.equal(wifiPortalDomain(HUD, 'dev', { devReady: true }), `${HUD}.wifi.dev.serv-os.app`);
  assert.equal(wifiPortalDomain(HUD, 'prod', { devReady: true }), `${HUD}.wifi.serv-os.app`);
  assert.equal(wifiPortalDomain(HUD, 'stage', { devReady: true }), `${HUD}.wifi.serv-os.app`);
  for (const tier of ['prod', 'dev', 'stage']) {
    for (const devReady of [false, true]) {
      assert.equal(wifiPortalSlug(wifiPortalDomain(HUD, tier, { devReady })), HUD, 'every Domain shown is one the page and the relay know');
    }
  }
  assert.equal(wifiPortalDomain(null, 'prod'), null);
  assert.equal(wifiPortalDomain('not a slug', 'prod'), null);
});

test('UniFi pre-auth allowances are the front door IP and Google Fonts, nothing else', () => {
  assert.equal(WIFI_FRONT_DOOR_IP, '37.16.1.154');
  assert.deepEqual([...WIFI_PREAUTH_ALLOWANCES], ['37.16.1.154', 'fonts.googleapis.com', 'fonts.gstatic.com']);
});

// ── Supabase base URLs ─────────────────────────────────────────────────────────────────────────
test('on a portal host both clients go through the relay, same origin', () => {
  assert.deepEqual(
    supabaseBaseUrls({ hostname: `${HUD}.wifi.serv-os.app`, origin: PORTAL_ORIGIN, opsUrl: OPS, platformUrl: PLAT }),
    { opsUrl: `${PORTAL_ORIGIN}/_sb/ops`, platformUrl: `${PORTAL_ORIGIN}/_sb/plat`, viaPortal: true },
  );
  const dev = supabaseBaseUrls({ hostname: `${HUD}.wifi.dev.serv-os.app`, origin: `https://${HUD}.wifi.dev.serv-os.app/`, opsUrl: OPS, platformUrl: PLAT });
  assert.equal(dev.opsUrl, `https://${HUD}.wifi.dev.serv-os.app/_sb/ops`);
});

test('on every other host the baked URLs are returned untouched', () => {
  for (const [hostname, origin] of [
    [`${HUD}.serv-os.app`, `https://${HUD}.serv-os.app`], ['app.serv-os.app', 'https://app.serv-os.app'],
    ['localhost', 'http://localhost:5173'], ['possystem-liard.vercel.app', 'https://possystem-liard.vercel.app'],
    ['servos-wifi-relay.fly.dev', 'https://servos-wifi-relay.fly.dev'], ['', ''], [undefined, undefined],
  ]) {
    assert.deepEqual(supabaseBaseUrls({ hostname, origin, opsUrl: OPS, platformUrl: PLAT }), { opsUrl: OPS, platformUrl: PLAT, viaPortal: false }, String(hostname));
  }
  assert.deepEqual(supabaseBaseUrls(), { opsUrl: '', platformUrl: '', viaPortal: false });
});

test('a switched-off client stays switched off on a portal host (mock mode, no platform project)', () => {
  assert.deepEqual(supabaseBaseUrls({ hostname: `${HUD}.wifi.serv-os.app`, origin: PORTAL_ORIGIN, opsUrl: '', platformUrl: '' }),
    { opsUrl: '', platformUrl: '', viaPortal: true });
});

test('a portal hostname with a junk origin does not produce a junk base URL', () => {
  assert.equal(supabaseBaseUrls({ hostname: `${HUD}.wifi.serv-os.app`, origin: 'null', opsUrl: OPS, platformUrl: PLAT }).opsUrl, OPS);
});

// ── storage images ─────────────────────────────────────────────────────────────────────────────
test('storage images on either project come through the front door on a portal host', () => {
  const ctx = { hostname: `${HUD}.wifi.serv-os.app`, origin: PORTAL_ORIGIN, opsUrl: OPS, platformUrl: PLAT };
  assert.equal(portalAssetUrl(`${OPS}/storage/v1/object/public/wifi-assets/loc/logo.png?v=2`, ctx),
    `${PORTAL_ORIGIN}/_sb/ops/storage/v1/object/public/wifi-assets/loc/logo.png?v=2`);
  assert.equal(portalAssetUrl(`${PLAT}/storage/v1/object/public/branding/a%20b.jpg`, ctx),
    `${PORTAL_ORIGIN}/_sb/plat/storage/v1/object/public/branding/a%20b.jpg`);
  assert.equal(portalAssetUrl('https://cdn.example.com/logo.png', ctx), 'https://cdn.example.com/logo.png', 'another site stays direct');
  assert.equal(portalAssetUrl('data:image/png;base64,AAAA', ctx), 'data:image/png;base64,AAAA');
  assert.equal(portalAssetUrl('/local.png', ctx), '/local.png');
  assert.equal(portalAssetUrl(null, ctx), null);
});

test('storage images are untouched on any other host', () => {
  const url = `${OPS}/storage/v1/object/public/wifi-assets/logo.png`;
  assert.equal(portalAssetUrl(url, { hostname: `${HUD}.serv-os.app`, origin: `https://${HUD}.serv-os.app`, opsUrl: OPS, platformUrl: PLAT }), url);
});

// ── customer URL parsing ───────────────────────────────────────────────────────────────────────
const at = (href, customerRoot = 'serv-os.app', readStoredSlug) => {
  const u = new URL(href);
  return parseCustomerLocation({ hostname: u.hostname, pathname: u.pathname, search: u.search }, { customerRoot, readStoredSlug });
};

test('portal hosts parse to the SAME slug as the venue host, on a prod and a dev build', () => {
  for (const root of ['serv-os.app', 'dev.serv-os.app', 'stage.serv-os.app']) {
    assert.equal(at(`https://${HUD}.wifi.serv-os.app/wifi`, root).slug, HUD, root);
    assert.equal(at(`https://${HUD}.wifi.dev.serv-os.app/wifi`, root).slug, HUD, root);
    assert.equal(slugFromHostname(`${HUD}.wifi.dev.serv-os.app`, root), HUD, root);
  }
});

test('the portal suffixes are tried before the tier root and .serv-os.app (else the slug would be "<slug>.wifi")', () => {
  const s = rootDomainSuffixes('dev.serv-os.app');
  assert.ok(s.indexOf('.wifi.dev.serv-os.app') < s.indexOf('.dev.serv-os.app'));
  assert.ok(s.indexOf('.wifi.serv-os.app') < s.indexOf('.serv-os.app'));
});

test('on a portal host the mode is by path exactly as on the venue host', () => {
  const cases = [
    ['/wifi?id=aa:bb&ap=cc&ssid=Guest&url=http%3A%2F%2Fcaptive.apple.com', 'wifi'],
    ['/guest/s/default/?id=aa', 'wifi'],
    ['/', 'online'],
    ['/gift', 'gift'],
    ['/account', 'account'],
    ['/t/5', 'qr'],
  ];
  for (const [p, mode] of cases) {
    for (const host of [`${HUD}.wifi.serv-os.app`, `${HUD}.serv-os.app`]) {
      const r = at(`https://${host}${p}`);
      assert.equal(r.mode, mode, `${host}${p}`);
      assert.equal(r.slug, HUD, `${host}${p}`);
    }
  }
});

test('existing hosts still parse as before', () => {
  assert.deepEqual(at(`https://${HUD}.serv-os.app/wifi`), { mode: 'wifi', slug: HUD, tableId: null, groupSlug: null });
  assert.deepEqual(at(`https://${HUD}.dev.serv-os.app/`, 'dev.serv-os.app'), { mode: 'online', slug: HUD, tableId: null, groupSlug: null });
  assert.equal(at('https://app.serv-os.app/').slug, null);
  assert.equal(at('https://dev.serv-os.app/', 'dev.serv-os.app').slug, null);
  assert.equal(at('https://peters.pos-up.com/').slug, 'peters');
  assert.deepEqual(at('https://possystem-liard.vercel.app/wifi?loc=Peters-Cafe'), { mode: 'wifi', slug: 'peters-cafe', tableId: null, groupSlug: null });
  assert.equal(at('https://possystem-liard.vercel.app/', 'serv-os.app', () => 'saved').slug, 'saved');
  assert.equal(at('https://possystem-liard.vercel.app/', 'serv-os.app', () => { throw new Error('blocked'); }).slug, null);
  assert.deepEqual(at('https://app.serv-os.app/order/coffee-boy'), { mode: 'group', slug: null, tableId: null, groupSlug: 'coffee-boy' });
  assert.equal(at('https://wifi.serv-os.app/').slug, null, 'the front door zone itself is never a venue');
});

// ── wiring ─────────────────────────────────────────────────────────────────────────────────────
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

test('customerUrl.js delegates to customerHost.js with the tier root and the saved slug', () => {
  const src = code(read('./customerUrl.js'));
  assert.match(src, /import \{ parseCustomerLocation \} from '\.\/customerHost';/);
  assert.match(src, /return parseCustomerLocation\(loc, \{ customerRoot: CUSTOMER_ROOT, readStoredSlug \}\);/);
  assert.doesNotMatch(src, /ROOT_DOMAIN_SUFFIXES|NON_SLUG_SUBDOMAINS/, 'one copy of the host rules, in customerHost.js');
});

test('supabase.js builds BOTH clients from supabaseBaseUrls, never from the raw VITE_ URLs', () => {
  const src = code(read('./supabase.js'));
  assert.match(src, /import \{ supabaseBaseUrls, portalAssetUrl \} from '\.\/wifiPortal';/);
  assert.match(src, /const SUPABASE_BASES = supabaseBaseUrls\(\{/);
  assert.match(src, /const SUPABASE_URL\s+= SUPABASE_BASES\.opsUrl;/);
  assert.match(src, /const PLATFORM_URL\s+= SUPABASE_BASES\.platformUrl;/);
  assert.equal((src.match(/import\.meta\.env\.VITE_SUPABASE_URL/g) || []).length, 1, 'read once, into BAKED_SUPABASE_URL');
  assert.equal((src.match(/import\.meta\.env\.VITE_PLATFORM_SUPABASE_URL/g) || []).length, 1, 'read once, into BAKED_PLATFORM_URL');
  assert.equal((src.match(/createClient\(SUPABASE_URL, SUPABASE_ANON/g) || []).length, 2, 'ops and staff');
  assert.equal((src.match(/createClient\(PLATFORM_URL, PLATFORM_ANON/g) || []).length, 1, 'platform');
});

test('the WiFi page loads its logo and background through the front door', () => {
  const src = code(read('../surfaces/WifiSurface.jsx'));
  assert.match(src, /import \{ supabase, viaWifiPortal \} from '\.\.\/lib\/supabase';/);
  assert.match(src, /const logo = viaWifiPortal\(cfg\?\.logo_url \|\| brand\.logo_url \|\| null\);/);
  assert.match(src, /const bg = viaWifiPortal\(cfg\?\.bg_image_url \|\| null\);/);
  assert.match(src, /supabase\.functions\.invoke\('wifi-capture'/, 'the one edge function call rides the ops client (→ /_sb/ops)');
});

test('the Back Office guide gives UniFi the front door, not the Vercel or Supabase addresses', () => {
  const src = code(read('../backoffice/sections/wifi/WifiSetup.jsx'));
  assert.match(src, /import \{ WIFI_FRONT_DOOR_IP, WIFI_PREAUTH_ALLOWANCES, wifiPortalDomain, wifiPortalZone \} from '\.\.\/\.\.\/\.\.\/lib\/wifiPortal';/);
  assert.match(src, /wifiPortalDomain\(slug, APP_TIER\) \|\| `<your-venue>\.\$\{wifiPortalZone\(APP_TIER\)\}`/);
  assert.doesNotMatch(src, /'<your-venue>\.wifi\.dev\.serv-os\.app'/, 'no hard-coded dev Domain: the zone decides');
  assert.match(src, /<Copy text=\{FRONT_DOOR_IP\} \/>/);
  assert.match(src, /<Copy text=\{portalHost\} \/>/);
  assert.match(src, /\{PREAUTH_HOSTS\.map\(\(h\) => <Copy key=\{h\} text=\{h\} \/>\)\}/);
  assert.doesNotMatch(src, /'216\.150\.\d|'[a-z]{20}\.supabase\.co'/, 'no Vercel addresses or Supabase hosts left to type in');
  assert.match(src, /Post-Authorization Restrictions/, 'the warning about the blocking list stays');
  assert.match(src, /Console ID/);
  assert.match(src, /as the owner/);
});
