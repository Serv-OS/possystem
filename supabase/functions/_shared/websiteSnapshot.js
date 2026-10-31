// supabase/functions/_shared/websiteSnapshot.js
//
// WEBSITE BUILDER (v5.12.0): the published snapshot, built the same way everywhere.
// The snapshot is what the public reads (web_sites_public.snapshot, api/site.js, the SPA).
// It is built ONCE at publish time by website-admin and kept per version, so a later edit
// to a page never changes what is live until the owner presses Publish again.
//
// Shape (contract section 2, web_site_versions.snapshot):
//   { site:{ id, slug, custom_domain, apex_domain, status, theme, nav, footer, seo, settings },
//     pages:[{ id, slug, title, kind, layout, seo, sort_order, location_id }],   published only
//     posts:[{ id, slug, title, excerpt, body_md, cover_url, author, tags, published_at }],  published only
//     locations:[{ id, ops_location_id, name, slug, address, phone, timezone, currency, opening_hours,
//                  online_branding, online_enabled, online_delivery_enabled, qr_enabled, lat, lng, sort_order }],
//     generated_at }
// A realistic sample lives in src/lib/website/fixtures/snapshot.sample.json.
//
// Pure: no database, no Deno, no browser globals. Never throws on odd input: a missing list
// becomes [] (customer facing never fails, and the server render reads this directly).

import { isPlainObject } from './websiteRules.js';

const SITE_KEYS = ['id', 'slug', 'custom_domain', 'apex_domain', 'status', 'theme', 'nav', 'footer', 'seo', 'settings'];
const PAGE_KEYS = ['id', 'slug', 'title', 'kind', 'layout', 'seo', 'sort_order', 'location_id'];
const POST_KEYS = ['id', 'slug', 'title', 'excerpt', 'body_md', 'cover_url', 'author', 'tags', 'published_at'];

const pick = (row, keys) => {
  const out = {};
  for (const k of keys) out[k] = row?.[k] === undefined ? null : row[k];
  return out;
};

/**
 * One public location from a Platform `locations` row (select * so a column missing on an
 * older database never breaks the publish). Coordinates come from latitude/longitude, or from
 * the cached geocode in settings.geo[location id] (contract section 8).
 */
export function publicLocation(row, geo = {}) {
  if (!isPlainObject(row)) return null;
  const cached = isPlainObject(geo) && isPlainObject(geo[row.id]) ? geo[row.id] : null;
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null));
  const lat = num(row.latitude) ?? num(row.lat) ?? num(cached?.lat);
  const lng = num(row.longitude) ?? num(row.lng) ?? num(cached?.lng);
  const branding = isPlainObject(row.online_branding) ? row.online_branding : {};
  return {
    id: row.id ?? null,
    ops_location_id: row.ops_location_id ?? null,
    name: typeof row.name === 'string' ? row.name : '',
    slug: row.online_slug ?? null,
    address: typeof row.address === 'string' ? row.address : (row.address ? String(row.address) : null),
    phone: typeof row.phone === 'string' ? row.phone : (typeof branding.phone === 'string' ? branding.phone : null),
    timezone: row.timezone || 'Europe/London',
    currency: row.currency || 'GBP',
    opening_hours: isPlainObject(row.opening_hours) ? row.opening_hours : null,
    online_branding: branding,
    online_enabled: row.online_enabled === true,
    online_delivery_enabled: row.online_delivery_enabled === true,
    qr_enabled: row.qr_enabled === true,
    lat,
    lng,
    sort_order: Number.isInteger(row.sort_order) ? row.sort_order : 0,
  };
}

/**
 * Build the snapshot. Pages and posts are filtered to published here as well as in the
 * query, so a caller that forgot the filter cannot leak a draft to the public.
 */
export function buildSnapshot({ site, pages = [], posts = [], locations = [], now = new Date() } = {}) {
  const s = isPlainObject(site) ? site : {};
  const settings = isPlainObject(s.settings) ? s.settings : {};
  const geo = isPlainObject(settings.geo) ? settings.geo : {};
  const pub = (list, status = 'published') => (Array.isArray(list) ? list.filter((r) => isPlainObject(r) && r.status === status) : []);
  const bySort = (a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || String(a.slug ?? '').localeCompare(String(b.slug ?? ''));
  const locs = (Array.isArray(locations) ? locations : []).map((r) => publicLocation(r, geo)).filter(Boolean);
  // The default location comes first so every reader's "first location" fallback agrees.
  const def = settings.default_location_id;
  locs.sort((a, b) => (a.id === def ? -1 : b.id === def ? 1 : 0) || a.sort_order - b.sort_order || a.name.localeCompare(b.name));
  // Platform rows carry no sort column: the published order IS the sort order, so every reader agrees.
  locs.forEach((l, i) => { l.sort_order = i; });
  return {
    site: {
      ...pick(s, SITE_KEYS),
      theme: isPlainObject(s.theme) ? s.theme : {},
      nav: Array.isArray(s.nav) ? s.nav : [],
      footer: isPlainObject(s.footer) ? s.footer : {},
      seo: isPlainObject(s.seo) ? s.seo : {},
      settings,
    },
    pages: pub(pages).map((p) => ({ ...pick(p, PAGE_KEYS), layout: isPlainObject(p.layout) ? p.layout : { content: [], root: { props: {} } }, seo: isPlainObject(p.seo) ? p.seo : {} })).sort(bySort),
    posts: pub(posts).map((p) => ({ ...pick(p, POST_KEYS), tags: Array.isArray(p.tags) ? p.tags : [] }))
      .sort((a, b) => String(b.published_at ?? '').localeCompare(String(a.published_at ?? ''))),
    locations: locs,
    generated_at: (now instanceof Date ? now : new Date(now)).toISOString(),
  };
}

/** Which of the snapshot's pages (and the blog) a site visitor can reach: for sitemaps and nav. */
export function snapshotPaths(snapshot) {
  const out = ['/'];
  if (!isPlainObject(snapshot)) return out;
  for (const p of Array.isArray(snapshot.pages) ? snapshot.pages : []) {
    if (p?.slug && p.slug !== '' && !p.seo?.noindex) out.push(`/${p.slug}`);
  }
  if (Array.isArray(snapshot.posts) && snapshot.posts.length) {
    out.push('/blog');
    for (const post of snapshot.posts) if (post?.slug) out.push(`/blog/${post.slug}`);
  }
  for (const l of Array.isArray(snapshot.locations) ? snapshot.locations : []) {
    if (l?.slug) out.push(`/locations/${l.slug}`);
  }
  return [...new Set(out)];
}
