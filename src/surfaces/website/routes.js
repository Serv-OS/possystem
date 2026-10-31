// src/surfaces/website/routes.js
//
// The one routing rule for a venue site, shared by api/site.js (server) and WebsiteSurface (client)
// so a path means the same page on both sides (ARCHITECTURE.md section 3):
//   /                    home page (slug '')
//   /<slug>              a page
//   /blog                the post list (the 'blog' page when one exists, else a synthesised one)
//   /blog/<slug>         a published post
//   /locations/<slug>    the kind='location' page for that venue (synthesised when the designer has
//                        not made one yet, so every venue has a local SEO page from day one)
// Also the visibility rules: the site's "Connected to your ServOS" switches (settings.channels)
// hide blocks and nav items for channels the venue turned off.

import { defaultPropsFor, layoutBlocks } from './blocks/schema.js';

/** True when the layout holds a Hero (the page then takes its h1 from it). */
export function layoutHasHero(layout) {
  return layoutBlocks(layout).some((b) => b.type === 'Hero');
}

export const BLOCK_CHANNEL = Object.freeze({
  OrderBar: 'online', OrderEmbed: 'online', LoyaltyJoin: 'loyalty', GiftCards: 'gift', BookTable: 'bookings', Waitlist: 'waitlist', Specials: 'online',
});
export const PAGE_KIND_CHANNEL = Object.freeze({ order: 'online', catering: 'catering', loyalty: 'loyalty', gift: 'gift' });

// Two spellings are in use for two switches (the admin writes order/book, the blocks say
// online/bookings); both are read so neither side has to change.
const CHANNEL_ALIASES = Object.freeze({ online: ['online', 'order'], order: ['online', 'order'], bookings: ['bookings', 'book'], book: ['bookings', 'book'] });

/** A channel switch; everything is on unless the venue turned it off. */
export function channelOn(settings, key) {
  const ch = settings && settings.channels && typeof settings.channels === 'object' ? settings.channels : {};
  return (CHANNEL_ALIASES[key] || [key]).every((k) => ch[k] !== false);
}

/**
 * Is a channel on at one venue? The location's own flag when the snapshot carries one, else the
 * site switch. Used for the per venue Order and Book buttons and the Restaurant JSON-LD.
 */
export function locationChannelOn(loc, settings, key) {
  const own = loc && loc.channels && typeof loc.channels === 'object' ? loc.channels : {};
  for (const k of CHANNEL_ALIASES[key] || [key]) if (typeof own[k] === 'boolean') return own[k] && channelOn(settings, key);
  return channelOn(settings, key);
}

/** One location row as the renderers read it: `online_slug` (the admin snapshot writes `slug`), flags folded into `channels`. */
export function normaliseLocation(l) {
  if (!l || typeof l !== 'object') return null;
  const channels = l.channels && typeof l.channels === 'object' ? { ...l.channels } : {};
  if (typeof l.online_enabled === 'boolean' && channels.online === undefined) channels.online = l.online_enabled;
  for (const [flag, key] of [['catering_enabled', 'catering'], ['loyalty_enabled', 'loyalty'], ['gift_cards_enabled', 'gift'], ['gift_enabled', 'gift'], ['bookings_enabled', 'bookings'], ['waitlist_enabled', 'waitlist']]) {
    if (typeof l[flag] === 'boolean' && channels[key] === undefined) channels[key] = l[flag];
  }
  return { ...l, online_slug: l.online_slug || l.slug || null, channels };
}

/** Is this block shown given the site's switches and the custom code setting? */
export function blockVisible(block, settings) {
  if (!block || !block.type) return false;
  if (block.type === 'CustomHtml') return !!(settings && settings.allow_custom_code === true);
  if (block.type === 'OrderEmbed' && block.props && block.props.mode === 'catering') return channelOn(settings, 'catering');
  const ch = BLOCK_CHANNEL[block.type];
  return ch ? channelOn(settings, ch) : true;
}

export function normalisePath(path) {
  let p = String(path || '/').split('?')[0].split('#')[0];
  try { p = decodeURIComponent(p); } catch { /* keep as is */ }
  p = p.replace(/\/{2,}/g, '/');
  if (p.length > 1) p = p.replace(/\/+$/, '');
  return p.startsWith('/') ? p : `/${p}`;
}

const published = (p) => p && p.status !== 'draft';
const sortPages = (pages) => (Array.isArray(pages) ? pages.filter(Boolean) : []).slice().sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
const slugOf = (p) => String((p && p.slug) || '').replace(/^\/+|\/+$/g, '');

export function publishedPages(snapshot) { return sortPages(snapshot && snapshot.pages).filter(published); }
export function publishedPosts(snapshot) {
  return (Array.isArray(snapshot && snapshot.posts) ? snapshot.posts : [])
    // The published snapshot may omit status (everything in it is live); only an explicit draft hides.
    .filter((p) => p && p.status !== 'draft' && p.slug)
    .slice().sort((a, b) => String(b.published_at || '').localeCompare(String(a.published_at || '')));
}
export function siteLocations(snapshot) {
  return (Array.isArray(snapshot && snapshot.locations) ? snapshot.locations : [])
    .map(normaliseLocation)
    .filter((l) => l && l.online_slug)
    .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
}

/** The site path of a page row (location pages live under /locations/). */
export function pathForPage(page, snapshot) {
  if (!page) return '/';
  const slug = slugOf(page);
  if (page.kind === 'location') {
    const loc = siteLocations(snapshot).find((l) => l.id === page.location_id);
    const ls = (loc && loc.online_slug) || slug.replace(/^locations\//, '');
    return `/locations/${ls}`;
  }
  return slug ? `/${slug}` : '/';
}

function locationPageFor(snapshot, loc) {
  return publishedPages(snapshot).find((p) => p.kind === 'location' && (p.location_id === loc.id || slugOf(p) === loc.online_slug || slugOf(p) === `locations/${loc.online_slug}`)) || null;
}

/** A page the designer has not made yet: the standard local SEO layout for one venue. */
export function synthesiseLocationPage(loc, snapshot) {
  // The venue's own name, not the brand's display name: a chain's location pages must differ.
  const name = loc.name || (loc.online_branding && loc.online_branding.display_name) || 'Our venue';
  const siteSlugTitle = (snapshot && snapshot.site && snapshot.site.seo && snapshot.site.seo.title) || '';
  const mk = (type, props) => ({ type, props: { ...defaultPropsFor(type), ...props, id: `${type}-${loc.id}` } });
  return {
    id: `synth-location-${loc.id}`, slug: `locations/${loc.online_slug}`, kind: 'location', location_id: loc.id, status: 'published',
    title: name,
    seo: { title: `${name}${siteSlugTitle ? ` | ${siteSlugTitle}` : ''}`.slice(0, 70), description: `${name}: opening hours, address, menu and online ordering.` },
    layout: { root: { props: {} }, content: [
      mk('Hero', { headline: name, sub: '', height: 'short', primary: { label: 'Order now', href: `servos:order:${loc.id}` }, secondary: { label: 'Directions', href: '' } }),
      mk('Hours', { location_id: loc.id, title: 'Opening hours' }),
      mk('FindUs', { location_id: loc.id, show_nearest: false, title: 'Where to find us' }),
      mk('LiveMenu', { location_id: loc.id, title: 'Menu' }),
      mk('OrderEmbed', { location_id: loc.id }),
    ] },
    synthesised: true,
  };
}

/** The blog list when no 'blog' page exists. */
export function synthesiseBlogPage() {
  return {
    id: 'synth-blog', slug: 'blog', kind: 'blog', status: 'published', title: 'News',
    seo: { description: 'News and updates.' },
    layout: { root: { props: {} }, content: [{ type: 'BlogList', props: { ...defaultPropsFor('BlogList'), id: 'BlogList-all', count: 50, title: 'News' } }] },
    synthesised: true,
  };
}

/**
 * resolveRoute(snapshot, path) →
 *   { kind:'page', page, path } | { kind:'post', post, page, path } | { kind:'location', page, location, path }
 *   | { kind:'notfound', path }
 */
export function resolveRoute(snapshot, rawPath) {
  const path = normalisePath(rawPath);
  const pages = publishedPages(snapshot);
  const seg = path.split('/').filter(Boolean);

  if (seg[0] === 'blog') {
    if (seg.length === 1) {
      const page = pages.find((p) => slugOf(p) === 'blog' || p.kind === 'blog') || synthesiseBlogPage();
      return { kind: 'page', page, path };
    }
    if (seg.length === 2) {
      const post = publishedPosts(snapshot).find((p) => p.slug === seg[1]);
      if (post) return { kind: 'post', post, page: pages.find((p) => p.kind === 'blog') || synthesiseBlogPage(), path };
    }
    return { kind: 'notfound', path };
  }
  if (seg[0] === 'locations' && seg.length === 2) {
    const loc = siteLocations(snapshot).find((l) => l.online_slug === seg[1] || l.id === seg[1]);
    if (loc) return { kind: 'location', page: locationPageFor(snapshot, loc) || synthesiseLocationPage(loc, snapshot), location: loc, path };
    // A published location page whose venue has no online_slug (or was removed since publish):
    // pathForPage and the nav still name /locations/<page slug>, so it must answer, not 404.
    const orphan = pages.find((p) => p.kind === 'location' && (slugOf(p) === seg[1] || slugOf(p) === `locations/${seg[1]}`));
    if (orphan) return { kind: 'location', page: orphan, location: null, path };
    return { kind: 'notfound', path };
  }
  const slug = seg.join('/');
  const page = pages.find((p) => slugOf(p) === slug && p.kind !== 'location');
  if (page) {
    if (page.kind === 'location') {
      const loc = siteLocations(snapshot).find((l) => l.id === page.location_id);
      return { kind: 'location', page, location: loc || null, path };
    }
    return { kind: 'page', page, path };
  }
  if (!slug) {
    // No home page saved yet: the first published page stands in, so the site is never blank.
    const first = pages[0];
    if (first) return { kind: 'page', page: first, path };
  }
  return { kind: 'notfound', path };
}

/** Nav items the visitor should see: site.nav with channel switches and missing pages applied. */
export function visibleNav(snapshot) {
  const site = (snapshot && snapshot.site) || {};
  const settings = site.settings || {};
  const pages = publishedPages(snapshot);
  const nav = Array.isArray(site.nav) ? site.nav : [];
  const out = [];
  for (const item of nav) {
    if (!item || !item.label) continue;
    if (item.kind === 'page' || item.page_id) {
      const page = pages.find((p) => p.id === item.page_id || slugOf(p) === item.page_id);
      if (!page) continue;
      const ch = PAGE_KIND_CHANNEL[page.kind];
      if (ch && !channelOn(settings, ch)) continue;
      out.push({ label: String(item.label), href: pathForPage(page, snapshot) });
    } else if (item.href) {
      out.push({ label: String(item.label), href: String(item.href) });
    }
  }
  if (!out.length) {
    // No nav saved: every published page except location pages, in order.
    for (const p of pages) {
      if (p.kind === 'location') continue;
      const ch = PAGE_KIND_CHANNEL[p.kind];
      if (ch && !channelOn(settings, ch)) continue;
      out.push({ label: String(p.title || p.slug || 'Home'), href: pathForPage(p, snapshot) });
    }
  }
  return out;
}

/** Breadcrumbs [{name, path}] for a route (home first). */
export function breadcrumbsFor(route, snapshot) {
  const home = { name: 'Home', path: '/' };
  if (!route || route.kind === 'notfound') return [home];
  if (route.kind === 'post') return [home, { name: 'News', path: '/blog' }, { name: route.post.title, path: route.path }];
  if (route.kind === 'location') return [home, { name: 'Find us', path: findUsPath(snapshot) }, { name: route.page.title, path: route.path }];
  if (route.path === '/') return [home];
  return [home, { name: route.page.title || route.page.slug, path: route.path }];
}
function findUsPath(snapshot) {
  const p = publishedPages(snapshot).find((x) => x.kind === 'findus');
  return p ? pathForPage(p, snapshot) : '/';
}

/** Every indexable URL path of the site, for the sitemap. */
export function sitemapPaths(snapshot) {
  const out = [];
  const site = (snapshot && snapshot.site) || {};
  const settings = site.settings || {};
  const locs = siteLocations(snapshot);
  for (const p of publishedPages(snapshot)) {
    if (p.seo && p.seo.noindex) continue;
    const ch = PAGE_KIND_CHANNEL[p.kind];
    if (ch && !channelOn(settings, ch)) continue;
    // A location page for a venue with no public ordering address (no online_slug, or gone since
    // publish) stays out: Search Console would report it from day one, and the venue is not public.
    if (p.kind === 'location' && !locs.some((l) => l.id === p.location_id || slugOf(p) === l.online_slug || slugOf(p) === `locations/${l.online_slug}`)) continue;
    out.push({ path: pathForPage(p, snapshot), lastmod: p.updated_at || null });
  }
  for (const l of locs) {
    const path = `/locations/${l.online_slug}`;
    if (!out.some((o) => o.path === path)) out.push({ path, lastmod: null });
  }
  const posts = publishedPosts(snapshot);
  if (posts.length && !out.some((o) => o.path === '/blog')) out.push({ path: '/blog', lastmod: null });
  for (const post of posts) out.push({ path: `/blog/${post.slug}`, lastmod: post.updated_at || post.published_at || null });
  return out;
}
