// src/surfaces/website/resolveHref.js
//
// Every href on the public site goes through resolveHref (ARCHITECTURE.md section 6):
//   page:<id>                       → that page's site path ('/' for home)
//   servos:<surface>[:<location>]   → the venue's existing customer URL (ordering, catering,
//                                     loyalty, gift, book, waitlist), for the named location or the
//                                     site's default location
//   anything else                   → as is (site paths, https links, mailto, tel)
// Plain JS, no Vite env: the customer root (serv-os.app, dev.serv-os.app) is passed in the ctx so
// api/site.js can build the same links in Node. The React side passes CUSTOMER_ROOT from lib/env.js.

export const SERVOS_PATHS = Object.freeze({
  order: '/', catering: '/catering', loyalty: '/account', gift: '/gift', book: '/book', waitlist: '/waitlist',
  gift_balance: '/gift/balance',
});

export const DEFAULT_CUSTOMER_ROOT = 'serv-os.app';

/** The site pages that ask "which venue?" before a per venue surface opens. */
export const CHOOSE_PATHS = Object.freeze({ order: '/order', catering: '/order/catering', book: '/order/book' });

/** True when a servos: link names one venue (an id or slug), not 'default' or 'all'. */
export function explicitLocation(locId) {
  return !!locId && locId !== 'default' && locId !== 'all';
}

/**
 * 5.12.8: the venue a menu block shows. A block pinned to a venue shows that venue. A block on
 * 'default' or 'all' follows the visitor's pick (ctx.menuVenue, from ?venue=<slug> or the venue
 * switch above the menu) when that names one of the site's venues, else the site default.
 */
export function menuLocation(ctx, locationId) {
  // 5.12.9 (Peter, 1 Nov): a block's venue is the STARTING venue ("show menu A first"); the visitor's
  // pick still wins everywhere except on a venue's own page, which is that venue and nothing else.
  if (onVenuePage(ctx)) return pickLocation(ctx, locationId);
  const want = ctx && ctx.menuVenue ? String(ctx.menuVenue) : '';
  if (want) {
    const list = Array.isArray(ctx.locations) ? ctx.locations : [];
    const hit = list.find((l) => l && (l.online_slug === want || l.id === want || l.ops_location_id === want));
    if (hit) return hit;
  }
  // No pick: the block's own venue ('default' and 'all' resolve to the site default).
  return pickLocation(ctx, locationId);
}

/** True on a venue's own page (kind 'location'): no venue switch, no pick, straight to that venue. */
export function onVenuePage(ctx) { return !!(ctx && ctx.pageKind === 'location'); }

/**
 * 5.12.9: where a menu item's Order button goes. A visitor who has not said which venue yet is
 * asked first (the choose your venue page on a group site); once they picked, or on a venue's
 * own page, straight to that venue's ordering. A one venue site resolves straight anyway.
 */
export function menuOrderHref(ctx, loc) {
  if (!loc) return '';
  const chosen = onVenuePage(ctx) || !!(ctx && ctx.menuVenue);
  return resolveHref(ctx, chosen ? `servos:order:${loc.id}` : 'servos:order');
}

/** The venues a visitor can switch a menu between: every venue with an online slug, by name. */
export function menuVenues(ctx) {
  const list = Array.isArray(ctx && ctx.locations) ? ctx.locations : [];
  return list.filter((l) => l && l.online_slug && l.ops_location_id).slice().sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
}

/** True when the site has more than one venue a visitor can order from. */
export function multiVenue(ctx) {
  const list = Array.isArray(ctx && ctx.locations) ? ctx.locations : [];
  return list.filter((l) => l && l.online_slug).length > 1;
}

/** The venue's customer origin for a slug: https://<slug>.<customerRoot>. '' without a slug. */
export function customerOrigin(slug, customerRoot = DEFAULT_CUSTOMER_ROOT) {
  if (!slug) return '';
  return `https://${slug}.${customerRoot || DEFAULT_CUSTOMER_ROOT}`;
}

/** The venue's customer URL for a path, same rule as lib/env.js customerUrl without the window. */
export function venueUrl(slug, path = '/', customerRoot) {
  const o = customerOrigin(slug, customerRoot);
  return o ? `${o}${path || '/'}` : '';
}

/** The snapshot location a block or link means: by id, else the default, else the first. */
export function pickLocation(ctx, locationId) {
  const list = Array.isArray(ctx && ctx.locations) ? ctx.locations : [];
  if (!list.length) return null;
  if (locationId && locationId !== 'default' && locationId !== 'all') {
    const hit = list.find((l) => l && (l.id === locationId || l.ops_location_id === locationId || l.online_slug === locationId));
    if (hit) return hit;
  }
  const def = ctx && ctx.settings && ctx.settings.default_location_id;
  return list.find((l) => l && l.id === def) || list.find((l) => l && l.online_slug) || list[0];
}

/** Site path for a page row: '/' for home (slug ''), else '/<slug>'. */
export function pagePath(page) {
  if (!page) return '/';
  const slug = String(page.slug || '').replace(/^\/+/, '');
  return slug ? `/${slug}` : '/';
}

/**
 * resolveHref(ctx, href) → a usable href string ('' when nothing sensible exists).
 * ctx: { pages, locations, settings, customerRoot }
 */
export function resolveHref(ctx, href) {
  const h = String(href == null ? '' : href).trim();
  if (!h) return '';
  if (h.startsWith('page:')) {
    const id = h.slice(5);
    const pages = Array.isArray(ctx && ctx.pages) ? ctx.pages : [];
    const page = pages.find((p) => p && (p.id === id || p.slug === id));
    return page ? pagePath(page) : '';
  }
  if (h.startsWith('servos:')) {
    const [, surface, locId] = h.split(':');
    const path = SERVOS_PATHS[surface];
    if (!path) return '';
    // 5.12.7 (Peter, 1 Nov): a company with several venues never sends a visitor straight to one
    // venue's ordering. Order, catering and book links with no venue of their own go to the site's
    // choose your venue page first; a link that names a venue still goes straight there.
    if (CHOOSE_PATHS[surface] && !explicitLocation(locId) && multiVenue(ctx)) return CHOOSE_PATHS[surface];
    const loc = pickLocation(ctx, locId);
    return venueUrl(loc && loc.online_slug, path, ctx && ctx.customerRoot);
  }
  if (/^(https?:\/\/|mailto:|tel:|\/|#)/i.test(h)) return h;
  // a bare word like 'menu' means the site page of that slug
  if (/^[a-z0-9][a-z0-9/-]*$/i.test(h)) return `/${h}`;
  return '';
}

/** True when a resolved href stays on this site (client side routing applies). */
export function isInternalHref(href) {
  const h = String(href || '');
  return h.startsWith('/') && !h.startsWith('//');
}
