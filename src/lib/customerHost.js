// src/lib/customerHost.js
//
// The PURE half of lib/customerUrl.js's parseCustomerUrl (no Vite env, no window), so node:test
// can import it. customerUrl.js passes in the tier's customer root and the saved preview slug.
// Moved here unchanged on 29 Sep 2026, when the WiFi front door added two host shapes:
//
//   <slug>.wifi.serv-os.app       (prod)
//   <slug>.wifi.dev.serv-os.app   (dev tier)
//
// Both give the SAME slug as <slug>.serv-os.app and behave exactly like the venue host (mode by
// path; /guest/* and /wifi → the WiFi page). They are checked FIRST: ".serv-os.app" (or
// ".dev.serv-os.app" on the dev tier) also matches them and would read the slug as "<slug>.wifi".

import { WIFI_PORTAL_SUFFIXES } from './wifiPortal.js';

// Subdomains reserved for operator / infra surfaces — never customer slugs.
// "app" is the prod operator host; "dev", "stage" are tier hosts.
// If anyone tries to register a slug that collides with this list, the BO
// validator should also block it (TODO when we wire onboarding).
// wifi-relay/portal.mjs RESERVED_SLUGS mirrors the real words here.
export const NON_SLUG_SUBDOMAINS = new Set([
  '', 'www', 'localhost', 'possystem-liard',
  'de', 'app', 'bo', 'admin', 'api', 'staging', 'stage', 'dev', 'test', 'preview',
  'order', // reserved for the multi-site group landing page (/order/<groupSlug>)
  'cater', // reserved for the multi-site group CATERING picker (/cater/<groupSlug>)
  'wifi',  // the WiFi front door's own zone (wifi.serv-os.app)
]);

// Domains we treat as the customer-facing root. The first match wins.
// Built from the tier's customer root so all tiers are recognised, plus the WiFi front door
// (first, see above) and legacy domains for backward compat during migration.
export function rootDomainSuffixes(customerRoot) {
  return [
    ...WIFI_PORTAL_SUFFIXES,   // .wifi.dev.serv-os.app, .wifi.serv-os.app
    `.${customerRoot}`,        // e.g. .dev.serv-os.app (current tier)
    '.serv-os.app',            // prod / catch-all
    '.servos.app',             // typo-friendly fallback
    '.pos-up.com',             // legacy operating domain
  ];
}

// hostname → venue slug, or null.
export function slugFromHostname(hostname, customerRoot) {
  const h = String(hostname || '').toLowerCase();
  for (const suffix of rootDomainSuffixes(customerRoot)) {
    if (h.endsWith(suffix)) {
      const sub = h.slice(0, -suffix.length);
      return (sub && !NON_SLUG_SUBDOMAINS.has(sub)) ? sub : null;
    }
  }
  return null;
}

// loc: { hostname, pathname, search } (window.location or a test object).
// readStoredSlug: () => string|null, the sticky preview slug (localStorage 'rpos-online-slug').
export function parseCustomerLocation(loc, { customerRoot, readStoredSlug } = {}) {
  if (!loc) return { mode: null, slug: null, tableId: null, groupSlug: null };
  const hostname = (loc.hostname || '').toLowerCase();
  const pathname = loc.pathname || '/';
  const params = new URLSearchParams(loc.search || '');

  // Multi-site group landing pages — resolved against platform `companies.slug`,
  // NOT a venue slug — checked before venue parsing so a group link works on any
  // host that serves this app (operator domain, Vercel preview, or a venue
  // subdomain). Two separate faces of the business, two separate pickers:
  //   /order/<groupSlug>  (or ?group=)  → online-ordering venue picker
  //   /cater/<groupSlug>  (or ?cater=)  → catering venue picker
  const caterMatch = pathname.match(/^\/cater\/([^/?#]+)/);
  const caterParam = params.get('cater');
  if (caterMatch || caterParam) {
    const groupSlug = (caterMatch ? decodeURIComponent(caterMatch[1]) : caterParam).toLowerCase();
    return { mode: 'group_catering', slug: null, tableId: null, groupSlug };
  }
  const groupMatch = pathname.match(/^\/order\/([^/?#]+)/);
  const groupParam = params.get('group');
  if (groupMatch || groupParam) {
    const groupSlug = (groupMatch ? decodeURIComponent(groupMatch[1]) : groupParam).toLowerCase();
    return { mode: 'group', slug: null, tableId: null, groupSlug };
  }

  // 1. Slug — try subdomain first, fall back to ?loc query
  let slug = slugFromHostname(hostname, customerRoot);
  if (!slug) {
    const q = params.get('loc');
    if (q) slug = q.toLowerCase();
  }
  if (!slug && typeof readStoredSlug === 'function') {
    try {
      const stored = readStoredSlug();
      if (stored) slug = String(stored).toLowerCase();
    } catch { /* no storage */ }
  }

  // 2. Mode — path takes precedence, then ?surface, then default
  // /t/<id>           → qr
  // /k                → kiosk
  // /gift             → gift (purchase page)
  // /gift/balance     → gift_balance (balance check)
  // /gift/success     → gift_success (post-purchase confirmation)
  // anything else with a slug → online
  let mode = null;
  let tableId = null;
  const tableMatch = pathname.match(/^\/t\/([^/?#]+)/);
  if (tableMatch) {
    mode = 'qr';
    tableId = decodeURIComponent(tableMatch[1]);
  } else if (pathname.startsWith('/gift/balance')) {
    mode = 'gift_balance';
  } else if (pathname.startsWith('/gift/success')) {
    mode = 'gift_success';
  } else if (pathname === '/gift' || pathname.startsWith('/gift/')) {
    mode = 'gift';
  } else if (pathname === '/account' || pathname.startsWith('/account/')) {
    mode = 'account';
  } else if (pathname === '/book' || pathname.startsWith('/book/')) {
    // Phase 5 bookings: public guest booking widget (BookingWidget via CustomerBoot).
    mode = 'book';
  } else if (pathname === '/review' || pathname.startsWith('/review/')) {
    mode = 'review';
  } else if (pathname === '/wifi' || pathname.startsWith('/wifi/')) {
    mode = 'wifi';
  } else if (pathname === '/catering' || pathname.startsWith('/catering/')) {
    mode = 'catering';
  } else if (pathname === '/waitlist/status' || pathname.startsWith('/waitlist/status')) {
    // F2: guest live status page (deep-linked via the token in the surface) — must come
    // BEFORE the bare /waitlist branch so the more specific path wins.
    mode = 'waitlist_status';
  } else if (pathname === '/waitlist' || pathname.startsWith('/waitlist/')) {
    mode = 'waitlist';
  } else if (pathname.startsWith('/guest')) {
    // UniFi's external captive portal redirects to <host>/guest/s/<site>/?id=&ap=&ssid=…
    // The WiFi front door (wifi-relay) turns that into /wifi?… itself; this branch keeps a
    // /guest/… that reaches the page directly working too.
    mode = 'wifi';
  } else if (pathname.startsWith('/k')) {
    mode = 'kiosk';
  } else {
    const surface = params.get('surface');
    if (surface === 'qr')           { mode = 'qr';     tableId = params.get('t'); }
    else if (surface === 'kiosk')     mode = 'kiosk';
    else if (surface === 'gift')      mode = 'gift';
    else if (surface === 'gift_balance') mode = 'gift_balance';
    else if (surface === 'review')    mode = 'review';
    else if (surface === 'wifi')      mode = 'wifi';
    else if (surface === 'catering')  mode = 'catering';
    else if (surface === 'waitlist_status') mode = 'waitlist_status';
    else if (surface === 'waitlist')  mode = 'waitlist';
    else if (surface === 'book')      mode = 'book';
    else if (surface === 'online')    mode = 'online';
    else if (slug) mode = 'online'; // having a slug implies online by default
  }

  return { mode, slug, tableId, groupSlug: null };
}
