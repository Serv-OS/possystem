// The WiFi front door's routing (wifi-relay/portal.mjs), tested without a server.
// 29 Sep 2026, Coffee Boy Huddersfield: UniFi's External Portal Server takes one IPv4, and the
// venue host (Vercel) resolved to rotating addresses UniFi blocked. Guests now land on
// <slug>.wifi.serv-os.app → the Fly relay (37.16.1.154), which serves the page and Supabase.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parsePortalHost, portalFromSlug, resolvePortal, routePortalRequest, decideRequest,
  upstreamRequestHeaders, downstreamResponseHeaders, rewriteLocation, portalOrigin,
  supabaseUpstreams, splitUrl, isValidSlug, RESERVED_SLUGS, PORTAL_TIERS, DEFAULT_SUPABASE, FALLBACK_COOKIE,
} from '../../wifi-relay/portal.mjs';
import { NON_SLUG_SUBDOMAINS, parseCustomerLocation } from './customerHost.js';
import { WIFI_PORTAL_SUFFIXES, PORTAL_SUPABASE_PREFIX } from './wifiPortal.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const RELAY = path.resolve(here, '../../wifi-relay');

const HUD = 'coffee-boy-huddersfield';
const OPS = 'https://tbetcegmszzotrwdtqhi.supabase.co';
const PLAT = 'https://yhzjgyrkyjabvhblqxzu.supabase.co';

// ── slug from host ─────────────────────────────────────────────────────────────────────────────
test('a prod portal host names the venue and its upstream', () => {
  assert.deepEqual(parsePortalHost(`${HUD}.wifi.serv-os.app`), { slug: HUD, tier: 'prod', upstreamHost: `${HUD}.serv-os.app` });
});

test('a dev tier portal host gives the SAME slug and the dev upstream', () => {
  assert.deepEqual(parsePortalHost(`${HUD}.wifi.dev.serv-os.app`), { slug: HUD, tier: 'dev', upstreamHost: `${HUD}.dev.serv-os.app` });
});

test('Host header noise is ignored: case, port, trailing dot', () => {
  assert.equal(parsePortalHost('Coffee-Boy-Huddersfield.WIFI.serv-os.app:443').slug, HUD);
  assert.equal(parsePortalHost(`${HUD}.wifi.serv-os.app.`).slug, HUD);
});

test('not a portal host: venue host, apex, other sites, nested labels, IPs, empty', () => {
  for (const h of [`${HUD}.serv-os.app`, 'wifi.serv-os.app', 'servos-wifi-relay.fly.dev', '37.16.1.154',
    '[::1]:8080', `a.${HUD}.wifi.serv-os.app`, `${HUD}.wifi.serv-os.app.evil.com`, `${HUD}wifi.serv-os.app`, '', undefined]) {
    assert.equal(parsePortalHost(h), null, String(h));
  }
});

test('operator and infrastructure names can never be reached through a portal host', () => {
  for (const s of ['app', 'www', 'admin', 'api', 'dev', 'stage', 'wifi', 'order', 'cater']) {
    assert.equal(parsePortalHost(`${s}.wifi.serv-os.app`), null, s);
    assert.equal(portalFromSlug(s), null, s);
  }
});

test('slug shape: a-z 0-9 and hyphen, 1 to 63 characters', () => {
  assert.equal(isValidSlug('a'), true);
  assert.equal(isValidSlug('x'.repeat(63)), true);
  assert.equal(isValidSlug('x'.repeat(64)), false);
  for (const bad of ['', 'a_b', 'a.b', 'A', 'a b', 'a/b', '..', null, 7]) assert.equal(isValidSlug(bad), false, String(bad));
});

test('every reserved word the relay knows is reserved in the SPA too', () => {
  for (const s of RESERVED_SLUGS) assert.ok(NON_SLUG_SUBDOMAINS.has(s), s);
});

test('the relay and the SPA agree on the portal host suffixes and the /_sb prefixes', () => {
  assert.deepEqual(PORTAL_TIERS.map((t) => t.suffix), [...WIFI_PORTAL_SUFFIXES]);
  const r = (p) => routePortalRequest({ portal: parsePortalHost(`${HUD}.wifi.serv-os.app`), url: `${p}/rest/v1/x` });
  assert.equal(r(PORTAL_SUPABASE_PREFIX.ops).upstreamOrigin, OPS);
  assert.equal(r(PORTAL_SUPABASE_PREFIX.plat).upstreamOrigin, PLAT);
});

// ── ?to= fallback ──────────────────────────────────────────────────────────────────────────────
test('?to=<slug> picks the venue on any host, and the cookie carries it to the page assets', () => {
  assert.deepEqual(resolvePortal({ host: 'servos-wifi-relay.fly.dev', url: `/guest/s/default/?to=${HUD}` }),
    { portal: { slug: HUD, tier: 'prod', upstreamHost: `${HUD}.serv-os.app` }, via: 'to' });
  assert.equal(resolvePortal({ host: 'servos-wifi-relay.fly.dev', url: '/assets/i.js', cookie: `a=1; ${FALLBACK_COOKIE}=${HUD}` }).via, 'cookie');
  assert.equal(resolvePortal({ host: 'servos-wifi-relay.fly.dev', url: '/?to=app' }), null, 'reserved');
  assert.equal(resolvePortal({ host: 'servos-wifi-relay.fly.dev', url: '/?to=evil.com' }), null, 'not a slug');
  assert.equal(resolvePortal({ host: 'servos-wifi-relay.fly.dev', url: '/x' }), null);
});

test('a portal Host wins over ?to=', () => {
  const r = resolvePortal({ host: `${HUD}.wifi.dev.serv-os.app`, url: '/?to=other-venue' });
  assert.equal(r.via, 'host');
  assert.equal(r.portal.upstreamHost, `${HUD}.dev.serv-os.app`);
});

// ── path routing ───────────────────────────────────────────────────────────────────────────────
const PORTAL = parsePortalHost(`${HUD}.wifi.serv-os.app`);

test("UniFi's /guest redirect becomes /wifi on the same host with every UniFi parameter kept", () => {
  const url = `/guest/s/default/?id=aa:bb:cc:dd:ee:ff&ap=11:22:33:44:55:66&t=1759140000&url=http%3A%2F%2Fcaptive.apple.com%2Fhotspot-detect.html&ssid=Coffee%20Boy%20Guest`;
  const r = routePortalRequest({ portal: PORTAL, url });
  assert.equal(r.kind, 'redirect');
  assert.equal(r.status, 302);
  assert.ok(r.location.startsWith('/wifi?'), 'relative, so it stays on the portal host');
  const q = new URLSearchParams(r.location.slice('/wifi?'.length));
  assert.equal(q.get('id'), 'aa:bb:cc:dd:ee:ff');
  assert.equal(q.get('ap'), '11:22:33:44:55:66');
  assert.equal(q.get('ssid'), 'Coffee Boy Guest');
  assert.equal(q.get('t'), '1759140000');
  assert.equal(q.get('url'), 'http://captive.apple.com/hotspot-detect.html');
  assert.equal(q.get('site'), 'default');
  assert.equal(q.get('to'), null, 'a portal host needs no ?to');
});

test('/guest variants: bare, no query, a named site', () => {
  assert.equal(routePortalRequest({ portal: PORTAL, url: '/guest' }).location, '/wifi');
  assert.equal(routePortalRequest({ portal: PORTAL, url: '/guest/s/abc123xy/' }).location, '/wifi?site=abc123xy');
  assert.equal(routePortalRequest({ portal: PORTAL, url: '/guestbook' }).kind, 'proxy', 'only the /guest path itself');
});

test('/guest reached through ?to= carries the slug on, for the relay (to) and the page (loc)', () => {
  const r = routePortalRequest({ portal: portalFromSlug(HUD), url: `/guest/s/default/?id=aa&to=${HUD}`, via: 'to' });
  const q = new URLSearchParams(r.location.split('?')[1]);
  assert.equal(q.get('to'), HUD);
  assert.equal(q.get('loc'), HUD);
  assert.equal(q.get('id'), 'aa');
});

test('/_sb/ops and /_sb/plat go to the two Supabase projects with the prefix stripped', () => {
  const ops = routePortalRequest({ portal: PORTAL, url: '/_sb/ops/functions/v1/wifi-capture' });
  assert.deepEqual(ops, { kind: 'proxy', upstreamOrigin: OPS, upstreamHost: 'tbetcegmszzotrwdtqhi.supabase.co', path: '/functions/v1/wifi-capture', prefix: '/_sb/ops' });
  const plat = routePortalRequest({ portal: PORTAL, url: '/_sb/plat/rest/v1/locations?select=id&online_slug=eq.x' });
  assert.equal(plat.upstreamHost, 'yhzjgyrkyjabvhblqxzu.supabase.co');
  assert.equal(plat.path, '/rest/v1/locations?select=id&online_slug=eq.x');
  assert.equal(routePortalRequest({ portal: PORTAL, url: '/_sb/ops' }).path, '/');
  assert.equal(routePortalRequest({ portal: PORTAL, url: '/_sb/opsx/y' }).upstreamHost, `${HUD}.serv-os.app`, 'prefix must be a whole segment');
});

test('everything else goes to the venue host, path and query intact', () => {
  assert.deepEqual(routePortalRequest({ portal: PORTAL, url: '/assets/index-abc.js?v=1' }),
    { kind: 'proxy', upstreamOrigin: `https://${HUD}.serv-os.app`, upstreamHost: `${HUD}.serv-os.app`, path: '/assets/index-abc.js?v=1', prefix: '' });
  const dev = routePortalRequest({ portal: parsePortalHost(`${HUD}.wifi.dev.serv-os.app`), url: '/wifi?id=aa' });
  assert.equal(dev.upstreamOrigin, `https://${HUD}.dev.serv-os.app`);
});

test('open proxy guard: nothing in the request line can choose the upstream host', () => {
  for (const url of ['http://evil.example/x', '//evil.example/x', '/../../x', '/%2e%2e/x', '/_sb/ops/../../x']) {
    const r = routePortalRequest({ portal: PORTAL, url });
    assert.ok([`${HUD}.serv-os.app`, 'tbetcegmszzotrwdtqhi.supabase.co'].includes(r.upstreamHost), `${url} → ${r.upstreamHost}`);
    assert.ok(r.path.startsWith('/'), url);
    assert.ok(!r.path.startsWith('//'), url);
  }
  assert.equal(splitUrl('http://evil.example/a?b=1').pathname, '/a');
});

test('Supabase upstreams can be moved by env, but only to another https *.supabase.co project', () => {
  assert.deepEqual(supabaseUpstreams({}), DEFAULT_SUPABASE);
  assert.equal(supabaseUpstreams({ OPS_SUPABASE_URL: 'https://abcdefghijklmnop.supabase.co/' }).ops, 'https://abcdefghijklmnop.supabase.co');
  for (const bad of ['http://abc.supabase.co', 'https://evil.com', 'https://abc.supabase.co.evil.com', 'https://a.b.supabase.co', 'nope']) {
    assert.equal(supabaseUpstreams({ OPS_SUPABASE_URL: bad }).ops, DEFAULT_SUPABASE.ops, bad);
  }
});

// ── the whole decision ─────────────────────────────────────────────────────────────────────────
test('off a portal host the old routes are exactly as they were', () => {
  const fly = 'servos-wifi-relay.fly.dev';
  assert.deepEqual(decideRequest({ method: 'GET', host: fly, url: '/health' }), { kind: 'health' });
  assert.deepEqual(decideRequest({ method: 'GET', host: fly, url: '/' }), { kind: 'health' });
  assert.deepEqual(decideRequest({ method: 'POST', host: fly, url: '/forward' }), { kind: 'forward' });
  assert.deepEqual(decideRequest({ method: 'GET', host: fly, url: '/forward' }), { kind: 'forward' }, 'relay.mjs answers non-POST with 404 as before');
  assert.equal(decideRequest({ method: 'POST', host: fly, url: '/health' }).kind, 'not_found');
  assert.equal(decideRequest({ method: 'GET', host: fly, url: '/anything' }).kind, 'not_found');
  assert.equal(decideRequest({ method: 'GET', host: '37.16.1.154', url: '/health' }).kind, 'health');
  assert.equal(decideRequest({ method: 'GET', host: fly, url: '/', cookie: `${FALLBACK_COOKIE}=${HUD}` }).kind, 'health', 'the cookie never takes over /');
});

test('UniFi without a Domain (raw IP host) gets a 404 that says why', () => {
  assert.deepEqual(decideRequest({ method: 'GET', host: '37.16.1.154', url: '/guest/s/default/?id=aa' }), { kind: 'not_found', hint: 'no_venue' });
});

test('on a portal host even /health, / and /forward belong to the venue', () => {
  const host = `${HUD}.wifi.serv-os.app`;
  for (const url of ['/health', '/', '/forward']) {
    const d = decideRequest({ method: url === '/forward' ? 'POST' : 'GET', host, url });
    assert.equal(d.kind, 'proxy', url);
    assert.equal(d.upstreamHost, `${HUD}.serv-os.app`, url);
    assert.equal(d.setCookie, null);
  }
});

test('?to= on the fly.dev host: the page request gains loc= (the SPA never reads ?to=), then proxies with the cookie', () => {
  // 29 Sep review: /wifi?to=<slug> was proxied as it was, the page found no venue (no portal
  // hostname, no ?loc=) and showed the device picker instead of the WiFi page.
  const fly = 'servos-wifi-relay.fly.dev';
  const first = decideRequest({ method: 'GET', host: fly, url: `/wifi?to=${HUD}` });
  assert.equal(first.kind, 'redirect');
  assert.equal(first.location, `/wifi?to=${HUD}&loc=${HUD}`);
  assert.match(first.setCookie, new RegExp(`^${FALLBACK_COOKIE}=${HUD}; Path=/;.*HttpOnly; Secure; SameSite=Lax$`));
  const d = decideRequest({ method: 'GET', host: fly, url: first.location });
  assert.equal(d.kind, 'proxy');
  assert.equal(d.upstreamHost, `${HUD}.serv-os.app`);
  assert.equal(d.path, `/wifi?to=${HUD}&loc=${HUD}`);
  assert.match(d.setCookie, new RegExp(`^${FALLBACK_COOKIE}=${HUD};`));
  const r = decideRequest({ method: 'GET', host: fly, url: `/guest/s/default/?id=aa&to=${HUD}` });
  assert.equal(r.kind, 'redirect');
  assert.ok(r.setCookie);
});

test('the SPA reads the venue from the loc= the relay adds', () => {
  const fly = 'servos-wifi-relay.fly.dev';
  const { location } = decideRequest({ method: 'GET', host: fly, url: `/wifi?to=${HUD}` });
  const [pathname, search] = location.split('?');
  assert.deepEqual(parseCustomerLocation({ hostname: fly, pathname, search: `?${search}` }, { customerRoot: 'serv-os.app', readStoredSlug: () => null }),
    { mode: 'wifi', slug: HUD, tableId: null, groupSlug: null });
});

test('the ?to= loc redirect: GET/HEAD page requests only, never twice, never on a portal host or /_sb, never off-site', () => {
  const fly = 'servos-wifi-relay.fly.dev';
  assert.equal(decideRequest({ method: 'HEAD', host: fly, url: `/wifi?to=${HUD}` }).kind, 'redirect');
  assert.equal(decideRequest({ method: 'POST', host: fly, url: `/wifi?to=${HUD}` }).kind, 'proxy', 'a 302 would turn a POST into a GET');
  assert.equal(decideRequest({ method: 'GET', host: fly, url: `/wifi?to=${HUD}&loc=other` }).kind, 'proxy', 'loc= already there: left as sent');
  assert.equal(decideRequest({ method: 'GET', host: fly, url: '/assets/index-abc.js', cookie: `${FALLBACK_COOKIE}=${HUD}` }).kind, 'proxy', 'the page files ride the cookie');
  assert.equal(decideRequest({ method: 'GET', host: fly, url: `/_sb/ops/rest/v1/x?to=${HUD}` }).kind, 'proxy', 'PostgREST would read loc= as a filter');
  assert.equal(decideRequest({ method: 'GET', host: `${HUD}.wifi.serv-os.app`, url: '/wifi?to=other-venue' }).kind, 'proxy', 'a portal host needs no loc=');
  const odd = decideRequest({ method: 'GET', host: fly, url: `/.//evil.example/x?to=${HUD}` });
  assert.equal(odd.kind, 'redirect');
  assert.ok(odd.location.startsWith('/') && !odd.location.startsWith('//'), odd.location);
  assert.equal(odd.location, `/evil.example/x?to=${HUD}&loc=${HUD}`);
});

// ── headers ────────────────────────────────────────────────────────────────────────────────────
test('request headers: hop-by-hop, Connection-listed, Fly and forwarding-of-this-hop headers go; Host is the upstream', () => {
  const out = upstreamRequestHeaders({
    host: `${HUD}.wifi.serv-os.app`, connection: 'keep-alive, x-secret', 'keep-alive': 'timeout=5', 'x-secret': '1',
    'transfer-encoding': 'chunked', upgrade: 'h2c', te: 'trailers', 'proxy-authorization': 'x',
    'fly-client-ip': '1.2.3.4', 'fly-request-id': 'r', via: '1.1 fly.io', 'x-forwarded-host': 'evil', 'x-forwarded-proto': 'https', forwarded: 'for=1',
    apikey: 'anon', authorization: 'Bearer t', 'content-type': 'application/json', 'content-length': '12',
    'x-forwarded-for': '81.2.3.4', accept: '*/*', 'x-client-info': 'supabase-js-web/2',
  }, 'tbetcegmszzotrwdtqhi.supabase.co');
  assert.deepEqual(out, {
    host: 'tbetcegmszzotrwdtqhi.supabase.co', apikey: 'anon', authorization: 'Bearer t', 'content-type': 'application/json',
    'content-length': '12', 'x-forwarded-for': '81.2.3.4', accept: '*/*', 'x-client-info': 'supabase-js-web/2',
  });
});

test('response headers: hop-by-hop and alt-svc go, status-carrying headers stay, Location maps back', () => {
  const out = downstreamResponseHeaders({
    connection: 'keep-alive', 'keep-alive': 'timeout=5', 'transfer-encoding': 'chunked', 'alt-svc': 'h3=":443"',
    'content-type': 'text/html', 'content-encoding': 'br', 'cache-control': 'no-store', 'set-cookie': ['a=1', 'b=2'],
    location: `https://${HUD}.serv-os.app/wifi?id=aa`,
  }, { upstreamOrigin: `https://${HUD}.serv-os.app`, portalOrigin: `https://${HUD}.wifi.serv-os.app`, prefix: '' });
  assert.deepEqual(out, {
    'content-type': 'text/html', 'content-encoding': 'br', 'cache-control': 'no-store', 'set-cookie': ['a=1', 'b=2'],
    location: `https://${HUD}.wifi.serv-os.app/wifi?id=aa`,
  });
});

test('Location rewrite keeps the guest on the portal host', () => {
  const venue = { upstreamOrigin: `https://${HUD}.serv-os.app`, portalOrigin: `https://${HUD}.wifi.serv-os.app`, prefix: '' };
  const sb = { upstreamOrigin: OPS, portalOrigin: `https://${HUD}.wifi.serv-os.app`, prefix: '/_sb/ops' };
  assert.equal(rewriteLocation(`https://${HUD}.serv-os.app/a?b=1#c`, venue), `https://${HUD}.wifi.serv-os.app/a?b=1#c`);
  assert.equal(rewriteLocation(`http://${HUD.toUpperCase()}.serv-os.app/`, venue), `https://${HUD}.wifi.serv-os.app/`, 'scheme and case');
  assert.equal(rewriteLocation(`//${HUD}.serv-os.app/x`, venue), `https://${HUD}.wifi.serv-os.app/x`, 'protocol-relative');
  assert.equal(rewriteLocation('/wifi', venue), '/wifi', 'root-relative on the venue is already right');
  assert.equal(rewriteLocation('next?x=1', venue), 'next?x=1');
  assert.equal(rewriteLocation(`${OPS}/auth/v1/verify?t=1`, sb), `https://${HUD}.wifi.serv-os.app/_sb/ops/auth/v1/verify?t=1`);
  assert.equal(rewriteLocation('/auth/v1/callback', sb), '/_sb/ops/auth/v1/callback', 'root-relative from Supabase gets its prefix back');
  assert.equal(rewriteLocation('https://unifi.ui.com/x', venue), 'https://unifi.ui.com/x', 'another site is left alone');
  assert.equal(rewriteLocation(`https://${HUD}.serv-os.app.evil.com/`, venue), `https://${HUD}.serv-os.app.evil.com/`);
  assert.equal(rewriteLocation('', venue), '');
});

test('portal origin: https unless Fly says the hop was plain http', () => {
  assert.equal(portalOrigin(`${HUD}.wifi.serv-os.app`, 'https'), `https://${HUD}.wifi.serv-os.app`);
  assert.equal(portalOrigin(`${HUD}.wifi.serv-os.app`, undefined), `https://${HUD}.wifi.serv-os.app`);
  assert.equal(portalOrigin('localhost:8080', 'http'), 'http://localhost:8080');
});

// ── wiring ─────────────────────────────────────────────────────────────────────────────────────
test('the image ships portal.mjs next to relay.mjs, and relay.mjs routes through decideRequest', () => {
  const docker = fs.readFileSync(path.join(RELAY, 'Dockerfile'), 'utf8');
  assert.match(docker, /COPY relay\.mjs portal\.mjs \.\//);
  const relay = fs.readFileSync(path.join(RELAY, 'relay.mjs'), 'utf8');
  assert.match(relay, /from '\.\/portal\.mjs'/);
  assert.match(relay, /decideRequest\(\{ method: req\.method, host: req\.headers\.host, url: req\.url/);
  assert.match(relay, /redirect: 'manual'/, 'the forwarder still never follows redirects');
  assert.match(relay, /ALLOWED_HOST = \/\(\^\|\\\.\)ui\\\.com\$\/i/, 'the forwarder still only reaches *.ui.com');
  assert.doesNotMatch(relay, /\bfetch\(d\./, 'the portal proxy streams with https.request, it never uses fetch (which would decompress bodies)');
});
