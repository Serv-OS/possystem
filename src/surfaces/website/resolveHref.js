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
