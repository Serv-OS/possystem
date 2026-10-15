// src/lib/wifiPortal.js
//
// The WiFi FRONT DOOR (29 Sep 2026, Coffee Boy Huddersfield). PURE: no Vite env, no window, so
// node:test can import it.
//
// Why: UniFi's hotspot "External Portal Server" takes one IPv4 and its pre-auth allow-list matches
// IPs. <slug>.serv-os.app (Vercel) resolves to rotating anycast addresses (216.150.1.x and
// 216.150.16.x, different per resolver), so UniFi blocked some of them: iOS showed "Cannot verify
// server identity", and after allowing whole /24s nothing popped up at all. The captive portal now
// lives on a host that ALWAYS resolves to the fixed IPv4 of our Fly app servos-wifi-relay
// (wifi-relay/relay.mjs):
//
//   <slug>.wifi.serv-os.app       → proxied to https://<slug>.serv-os.app       (prod)
//   <slug>.wifi.dev.serv-os.app   → proxied to https://<slug>.dev.serv-os.app   (dev tier)
//
// and both Supabase projects are reached through the same host, under /_sb/ops and /_sb/plat, so a
// guest's phone needs exactly one address allowed before it signs in. On every other host nothing
// here changes anything.

// The relay's dedicated IPv4 (fly ips list -a servos-wifi-relay). The ONE address UniFi needs.
export const WIFI_FRONT_DOOR_IP = '37.16.1.154';

// UniFi → Hotspot → Pre-Authorization Allowances. The front door carries the page AND both
// Supabase projects, so only the fonts the page asks Google for are left (index.html, globals.css).
export const WIFI_PREAUTH_ALLOWANCES = Object.freeze([WIFI_FRONT_DOOR_IP, 'fonts.googleapis.com', 'fonts.gstatic.com']);

// Longest first, so ".wifi.dev.serv-os.app" is tried before ".wifi.serv-os.app". (They are disjoint
// anyway, but nobody should have to check that.) Mirrors PORTAL_TIERS in wifi-relay/portal.mjs.
export const WIFI_PORTAL_SUFFIXES = Object.freeze(['.wifi.dev.serv-os.app', '.wifi.serv-os.app']);

// Where the relay sends each Supabase project. Mirrors routePortalRequest in wifi-relay/portal.mjs.
export const PORTAL_SUPABASE_PREFIX = Object.freeze({ ops: '/_sb/ops', plat: '/_sb/plat' });

const SLUG_RE = /^[a-z0-9-]{1,63}$/;

function cleanHost(hostname) {
  return String(hostname || '').trim().toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
}

// "coffee-boy-huddersfield.wifi.serv-os.app" → "coffee-boy-huddersfield"; any other host → null.
export function wifiPortalSlug(hostname) {
  const h = cleanHost(hostname);
  for (const suffix of WIFI_PORTAL_SUFFIXES) {
    if (h.endsWith(suffix)) {
      const slug = h.slice(0, -suffix.length);
      return SLUG_RE.test(slug) ? slug : null;
    }
  }
  return null;
}

export function isWifiPortalHost(hostname) {
  return wifiPortalSlug(hostname) !== null;
}

// Is the DEV front door (*.wifi.dev.serv-os.app) reachable? NOT YET (checked 29 Sep 2026): there is
// no `*.wifi.dev` A record, so those names still fall through the `*.dev` wildcard to Vercel's
// rotating IPs, and no Fly certificate covers them (TLS fails). Dev and prod share the Supabase
// projects, so real venues show up in the dev Back Office; handing their UniFi a dev Domain today
// would bring back exactly the "Cannot verify server identity" / blank page this front door fixes.
// Flip to true only once `dig +short A x.wifi.dev.serv-os.app` prints WIFI_FRONT_DOOR_IP and
// `fly certs show '*.wifi.dev.serv-os.app' -a servos-wifi-relay` says Issued (wifi-relay/README.md).
export const WIFI_DEV_FRONT_DOOR_READY = false;

// The zone a venue's portal host lives under, for a ServOS tier.
//   dev tier, once its DNS + cert exist → wifi.dev.serv-os.app
//   every other case                     → wifi.serv-os.app (the live front door: the relay only
//                                          serves these two, and a real venue's guests belong there)
export function wifiPortalZone(appTier, { devReady = WIFI_DEV_FRONT_DOOR_READY } = {}) {
  return appTier === 'dev' && devReady ? 'wifi.dev.serv-os.app' : 'wifi.serv-os.app';
}

// The Domain UniFi should redirect guests to, for a venue slug. The Back Office guide shows it.
export function wifiPortalDomain(slug, appTier, opts) {
  const s = String(slug || '').trim().toLowerCase();
  if (!SLUG_RE.test(s)) return null;
  return `${s}.${wifiPortalZone(appTier, opts)}`;
}

function trimOrigin(origin) {
  return String(origin || '').replace(/\/+$/, '');
}

// The base URLs lib/supabase.js creates its clients with.
//   On a portal host: <page origin>/_sb/ops and <page origin>/_sb/plat (same origin, via the relay).
//   Anywhere else:    the baked VITE_ URLs, unchanged.
// A blank baked URL stays blank (mock mode / no platform project): the portal must not turn a
// client that is switched off into one that is switched on.
export function supabaseBaseUrls({ hostname, origin, opsUrl = '', platformUrl = '' } = {}) {
  const o = trimOrigin(origin);
  if (!isWifiPortalHost(hostname) || !/^https?:\/\/[^/]+$/i.test(o)) {
    return { opsUrl, platformUrl, viaPortal: false };
  }
  return {
    opsUrl: opsUrl ? `${o}${PORTAL_SUPABASE_PREFIX.ops}` : opsUrl,
    platformUrl: platformUrl ? `${o}${PORTAL_SUPABASE_PREFIX.plat}` : platformUrl,
    viaPortal: true,
  };
}

function originOf(url) {
  try { return new URL(String(url || '')).origin.toLowerCase(); } catch { return null; }
}

// An absolute URL on one of our Supabase projects (a storage image: the WiFi page's logo and
// background) → the same path through the front door, on a portal host. Anything else is returned
// untouched (another site's image stays direct; it simply will not load before the guest is online
// unless the venue allows that host too).
export function portalAssetUrl(url, { hostname, origin, opsUrl = '', platformUrl = '' } = {}) {
  if (!url || typeof url !== 'string') return url;
  const o = trimOrigin(origin);
  if (!isWifiPortalHost(hostname) || !o) return url;
  let u;
  try { u = new URL(url); } catch { return url; }
  const from = u.origin.toLowerCase();
  const map = [[originOf(opsUrl), PORTAL_SUPABASE_PREFIX.ops], [originOf(platformUrl), PORTAL_SUPABASE_PREFIX.plat]];
  for (const [base, prefix] of map) {
    if (base && from === base) return `${o}${prefix}${u.pathname}${u.search}${u.hash}`;
  }
  return url;
}
