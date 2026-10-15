// ServOS WiFi front door: the PURE routing decisions (no sockets, no I/O), so they can be tested
// without starting a server. relay.mjs does the networking.
//
// Why (29 Sep 2026, Coffee Boy Huddersfield): UniFi's "External Portal Server" takes an IPv4 only,
// and its pre-auth allow-list matches IPs. The venue host (<slug>.serv-os.app, Vercel) resolves to
// rotating anycast addresses, so the allow-list blocked some of them and phones either showed
// "Cannot verify server identity" or nothing at all. The portal now lives on a host that ALWAYS
// resolves to this relay's dedicated IPv4:
//
//   <slug>.wifi.serv-os.app       → proxied to https://<slug>.serv-os.app       (prod)
//   <slug>.wifi.dev.serv-os.app   → proxied to https://<slug>.dev.serv-os.app   (dev tier)
//
// and the two Supabase projects are reached through the same host (/_sb/ops, /_sb/plat), so the
// guest's phone needs exactly one IP allowed before it signs in.
//
// Open proxy guard: an upstream is only ever one of the two Supabase projects or
// <slug>.serv-os.app / <slug>.dev.serv-os.app with slug matching SLUG_RE. Nothing from the request
// (path, query, headers) can choose any other host.

export const SLUG_RE = /^[a-z0-9-]{1,63}$/;

// Longest first. The two are disjoint anyway (x.wifi.dev.serv-os.app does not end with
// ".wifi.serv-os.app"), but keeping the more specific one first means nobody has to check that.
export const PORTAL_TIERS = Object.freeze([
  Object.freeze({ suffix: '.wifi.dev.serv-os.app', tier: 'dev', upstreamRoot: 'dev.serv-os.app' }),
  Object.freeze({ suffix: '.wifi.serv-os.app', tier: 'prod', upstreamRoot: 'serv-os.app' }),
]);

// Subdomains of serv-os.app that are operator or infrastructure hosts, never venues. A portal
// host must never become a way to reach them (app.wifi.serv-os.app → app.serv-os.app).
// Mirrors NON_SLUG_SUBDOMAINS in src/lib/customerHost.js (src/lib/wifiRelayPortal.test.js checks).
export const RESERVED_SLUGS = Object.freeze(new Set([
  'www', 'de', 'app', 'bo', 'admin', 'api', 'staging', 'stage', 'dev', 'test', 'preview', 'order', 'cater', 'wifi',
]));

// Supabase projects the portal may reach. Overridable (OPS_SUPABASE_URL / PLAT_SUPABASE_URL) so
// the relay follows the SPA if the projects ever move, but only ever to an https *.supabase.co host.
export const DEFAULT_SUPABASE = Object.freeze({
  ops: 'https://tbetcegmszzotrwdtqhi.supabase.co',
  plat: 'https://yhzjgyrkyjabvhblqxzu.supabase.co',
});

export function supabaseUpstreams(env = {}) {
  const pick = (v, fallback) => {
    try {
      const u = new URL(String(v || ''));
      if (u.protocol === 'https:' && /^[a-z0-9]+\.supabase\.co$/i.test(u.hostname)) return u.origin;
    } catch { /* not a URL */ }
    return fallback;
  };
  return Object.freeze({ ops: pick(env.OPS_SUPABASE_URL, DEFAULT_SUPABASE.ops), plat: pick(env.PLAT_SUPABASE_URL, DEFAULT_SUPABASE.plat) });
}

// "Coffee-Boy.wifi.serv-os.app:443." → "coffee-boy.wifi.serv-os.app"
export function normaliseHost(host) {
  let h = String(host || '').trim().toLowerCase();
  if (h.startsWith('[')) return h;                 // IPv6 literal: never a portal host
  h = h.replace(/:\d+$/, '').replace(/\.$/, '');
  return h;
}

export function isValidSlug(slug) {
  return typeof slug === 'string' && SLUG_RE.test(slug) && !RESERVED_SLUGS.has(slug);
}

// Host header → { slug, tier, upstreamHost } for a portal host, else null.
export function parsePortalHost(host) {
  const h = normaliseHost(host);
  for (const t of PORTAL_TIERS) {
    if (h.endsWith(t.suffix)) {
      const slug = h.slice(0, -t.suffix.length);
      if (!isValidSlug(slug)) return null;
      return { slug, tier: t.tier, upstreamHost: `${slug}.${t.upstreamRoot}` };
    }
  }
  return null;
}

// The ?to=<slug> fallback (any host). Always the prod tier.
export function portalFromSlug(slug) {
  const s = String(slug || '').trim().toLowerCase();
  if (!isValidSlug(s)) return null;
  return { slug: s, tier: 'prod', upstreamHost: `${s}.serv-os.app` };
}

export const FALLBACK_COOKIE = 'sv_portal';

function readCookie(header, name) {
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

// Which portal (if any) does this request belong to?
//   1. a portal Host header wins;
//   2. else ?to=<slug> on any host (sets the fallback cookie so the page's own asset requests,
//      which carry no ?to=, reach the same venue);
//   3. else that cookie.
// Returns { portal, via: 'host' | 'to' | 'cookie' } or null.
export function resolvePortal({ host, url, cookie } = {}) {
  const byHost = parsePortalHost(host);
  if (byHost) return { portal: byHost, via: 'host' };
  const { searchParams } = splitUrl(url);
  const to = searchParams.get('to');
  if (to) {
    const p = portalFromSlug(to);
    return p ? { portal: p, via: 'to' } : null;
  }
  const c = portalFromSlug(readCookie(cookie, FALLBACK_COOKIE));
  return c ? { portal: c, via: 'cookie' } : null;
}

// Only the path and query of req.url are ever used. An absolute-form request line
// ("GET http://evil.example/x") keeps its path; its host is thrown away.
export function splitUrl(rawUrl) {
  let u;
  try { u = new URL(String(rawUrl || '/'), 'http://relay.invalid'); } catch { u = new URL('http://relay.invalid/'); }
  return { pathname: u.pathname || '/', search: u.search || '', searchParams: u.searchParams };
}

// A path for our own Location header. URL parsing can leave a pathname starting "//" (from
// "/.//evil.com"), which a browser would read as another host; collapse leading slashes to one.
function localPath(pathname) {
  return `/${String(pathname || '').replace(/^\/+/, '')}`;
}

// What to do with a request on a portal:
//   { kind: 'redirect', location }                  UniFi's /guest/... → /wifi?... on the same host
//                                                   or a ?to= page request → the same + &loc=<slug>
//   { kind: 'proxy', upstreamOrigin, upstreamHost, path, prefix }
// prefix is the path we stripped (/_sb/ops, /_sb/plat) so Location headers can be mapped back.
export function routePortalRequest({ portal, url, via = 'host', method = 'GET', supabase = DEFAULT_SUPABASE }) {
  const { pathname, search, searchParams } = splitUrl(url);

  if (pathname === '/guest' || pathname.startsWith('/guest/')) {
    // UniFi: /guest/s/<site>/?id=<clientMAC>&ap=<apMAC>&t=<ts>&url=<orig>&ssid=<ssid>
    // Keep every UniFi parameter (the WiFi page reads id, ap, ssid, url) and add the site.
    const out = new URLSearchParams(searchParams);
    const m = pathname.match(/^\/guest\/s\/([^/]+)/);
    if (m && !out.has('site')) {
      let site = m[1];
      try { site = decodeURIComponent(site); } catch { /* keep as sent */ }
      out.set('site', site);
    }
    if (via !== 'host') {
      // Off a portal host the page cannot read the venue from its hostname: carry the slug in
      // ?to= (for this relay) and ?loc= (the SPA's own slug fallback).
      out.set('to', portal.slug);
      out.set('loc', portal.slug);
    }
    const qs = out.toString();
    return { kind: 'redirect', status: 302, location: `/wifi${qs ? `?${qs}` : ''}` };
  }

  for (const [prefix, key] of [['/_sb/ops', 'ops'], ['/_sb/plat', 'plat']]) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
      const origin = supabase[key];
      const rest = pathname.slice(prefix.length) || '/';
      return { kind: 'proxy', upstreamOrigin: origin, upstreamHost: new URL(origin).host, path: `${rest}${search}`, prefix };
    }
  }

  // ?to=<slug> chose the venue, but the page itself (the SPA) never reads ?to=: it takes the venue
  // from its hostname, ?loc= or a saved slug. Off a portal host there is no venue hostname, so
  // /wifi?to=<slug> would load with no venue and show the device picker. Send the browser to the
  // same address with loc=<slug> added (the /guest branch above already does). GET/HEAD only (a
  // 302 would turn a POST into a GET), and only when ?to= is in THIS request (the page's own files
  // ride the cookie and must never be redirected).
  const verb = String(method || 'GET').toUpperCase();
  if (via === 'to' && (verb === 'GET' || verb === 'HEAD') && !searchParams.has('loc')) {
    const out = new URLSearchParams(searchParams);
    out.set('loc', portal.slug);
    return { kind: 'redirect', status: 302, location: `${localPath(pathname)}?${out.toString()}` };
  }

  return {
    kind: 'proxy',
    upstreamOrigin: `https://${portal.upstreamHost}`,
    upstreamHost: portal.upstreamHost,
    path: `${pathname}${search}`,
    prefix: '',
  };
}

// Hop-by-hop headers (RFC 9110 §7.6.1) plus the ones this relay must set itself.
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-connection', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'trailers', 'transfer-encoding', 'upgrade',
]);
// Added by Fly's edge, or describing THIS hop. Never sent on: a forwarded Host would let the
// caller steer Vercel's routing, and the fly-* headers are noise upstream.
const DROP_UPSTREAM = new Set(['host', 'via', 'x-forwarded-host', 'x-forwarded-port', 'x-forwarded-proto', 'x-forwarded-ssl', 'x-request-start', 'forwarded']);

function connectionTokens(headers) {
  const c = headers.connection;
  const list = Array.isArray(c) ? c.join(',') : String(c || '');
  return new Set(list.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
}

// Request headers (Node's lower-cased object) → headers for the upstream request.
export function upstreamRequestHeaders(headers = {}, upstreamHost) {
  const extra = connectionTokens(headers);
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    const key = k.toLowerCase();
    if (HOP_BY_HOP.has(key) || extra.has(key) || DROP_UPSTREAM.has(key) || key.startsWith('fly-')) continue;
    if (v === undefined) continue;
    out[key] = v;
  }
  out.host = upstreamHost;
  return out;
}

// Describe the UPSTREAM's own connection, not ours: alt-svc would tell the phone to try HTTP/3 on
// the portal host, which the relay does not speak (a wasted round trip on a captive network).
const DROP_DOWNSTREAM = new Set(['alt-svc']);

// Upstream response headers → headers for the guest's browser (hop-by-hop removed, Location mapped).
export function downstreamResponseHeaders(headers = {}, ctx) {
  const extra = connectionTokens(headers);
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    const key = k.toLowerCase();
    if (HOP_BY_HOP.has(key) || extra.has(key) || DROP_DOWNSTREAM.has(key)) continue;
    if (v === undefined) continue;
    out[key] = v;
  }
  if (typeof out.location === 'string') out.location = rewriteLocation(out.location, ctx);
  return out;
}

// A redirect from upstream must keep the guest on the portal host (the only host their phone may
// reach before signing in). Absolute URLs on the upstream host come back to the portal host with
// the stripped prefix restored; a root-relative Location from a /_sb upstream gets its prefix
// back. Any other Location (another site) is left alone.
export function rewriteLocation(location, { upstreamOrigin, portalOrigin, prefix = '' } = {}) {
  const loc = String(location || '');
  if (!loc || !upstreamOrigin || !portalOrigin) return loc;
  const absolute = /^[a-z][a-z0-9+.-]*:/i.test(loc) || loc.startsWith('//');
  if (!absolute) {
    // "/x" is relative to the upstream's root, which on a /_sb upstream is our prefix.
    // "x" or "?x" is relative to the current URL, whose path we kept intact, so it already works.
    return loc.startsWith('/') && prefix ? `${prefix}${loc}` : loc;
  }
  let u;
  try { u = new URL(loc, `${upstreamOrigin}/`); } catch { return loc; }
  const up = new URL(upstreamOrigin);
  if (u.host.toLowerCase() !== up.host.toLowerCase()) return loc;
  return `${portalOrigin}${prefix}${u.pathname}${u.search}${u.hash}`;
}

// The portal origin the browser is on. Fly terminates TLS and says so in X-Forwarded-Proto; a
// portal host is only ever served over https, so https is the default.
export function portalOrigin(host, forwardedProto) {
  const proto = String(forwardedProto || '').split(',')[0].trim().toLowerCase() === 'http' ? 'http' : 'https';
  return `${proto}://${String(host || '').trim().toLowerCase().replace(/\.$/, '')}`;
}

export function fallbackCookie(slug) {
  return `${FALLBACK_COOKIE}=${slug}; Path=/; Max-Age=3600; HttpOnly; Secure; SameSite=Lax`;
}

// ── The whole decision for one request ────────────────────────────────────────────────────────
// Off a portal host the relay's original routes win, exactly as before the front door existed:
//   GET /  and  GET /health  → { kind: 'health' }     (the same JSON as always)
//   /forward                 → { kind: 'forward' }    (relay.mjs keeps it POST-only + token-guarded)
// then ?to=<slug> (or the cookie it sets) makes any other request a portal request (a GET page
// request with ?to= and no loc= is first sent back with loc=<slug> added, so the SPA finds the
// venue), and anything else is the old 404. On a portal host EVERYTHING is a portal request (its /health is the venue's).
// Result: { kind: 'health' | 'forward' | 'not_found' } or routePortalRequest's { kind: 'redirect' |
// 'proxy', ... } plus { portal, via, setCookie } (setCookie only when ?to= chose the venue).
export function decideRequest({ method = 'GET', host, url = '/', cookie, supabase = DEFAULT_SUPABASE } = {}) {
  const m = String(method || 'GET').toUpperCase();
  const raw = String(url || '/');
  if (!parsePortalHost(host)) {
    if (m === 'GET' && (raw === '/health' || raw === '/')) return { kind: 'health' };
    if (raw === '/forward') return { kind: 'forward' };
    if (raw === '/health') return { kind: 'not_found' };
  }
  const r = resolvePortal({ host, url: raw, cookie });
  if (!r) {
    const { pathname } = splitUrl(raw);
    // UniFi sent a guest here without a Domain set, so nothing says which venue this is.
    if (pathname === '/guest' || pathname.startsWith('/guest/')) return { kind: 'not_found', hint: 'no_venue' };
    return { kind: 'not_found' };
  }
  const route = routePortalRequest({ portal: r.portal, url: raw, via: r.via, method: m, supabase });
  return { ...route, portal: r.portal, via: r.via, setCookie: r.via === 'to' ? fallbackCookie(r.portal.slug) : null };
}
