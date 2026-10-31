// src/surfaces/website/ssr/jsonld.js
//
// JSON-LD builders for the server rendered site (ARCHITECTURE.md section 4 step 4). Everything
// comes from the published snapshot and the live menu, never invented: a field the venue has not
// filled in is left out rather than guessed. Google reads these to show the venue, its hours,
// its menu and its posts in search. Plain JS, Node and browser.

import { openingHoursSpecification } from '../hours.js';
import { postalAddress, locationCoords } from '../geo.js';
import { markdownToText } from '../markdown.js';
import { venueUrl } from '../resolveHref.js';
import { locationChannelOn } from '../routes.js';

const DIET_SCHEMA = { V: 'https://schema.org/VegetarianDiet', VG: 'https://schema.org/VeganDiet', GF: 'https://schema.org/GlutenFreeDiet', DF: 'https://schema.org/LowLactoseDiet' };
export const MENU_LD_CAP = 300;

const clean = (o) => {
  const out = {};
  for (const [k, v] of Object.entries(o)) {
    if (v == null || v === '' || (Array.isArray(v) && !v.length)) continue;
    out[k] = v;
  }
  return out;
};

/**
 * The BUSINESS name: header text, footer, og:site_name, Organization and WebSite names, the
 * "| name" suffix of every sub page title. seo.title is a keyword line the designer writes for the
 * home <title> ("Mozz Pizza | Wood fired pizza in Leeds"), so it is the last resort here, never the
 * first: Google's Organization name must be the business, not a keyword line.
 */
export function siteName(snapshot) {
  const s = snapshot && snapshot.site ? snapshot.site : {};
  const loc = (snapshot && Array.isArray(snapshot.locations) && snapshot.locations[0]) || null;
  const branding = (loc && loc.online_branding) || {};
  return s.company_name || s.name || branding.display_name || (loc && loc.name) || (s.seo && s.seo.title) || (s.slug ? s.slug : 'Our site');
}

export function originFor(host) {
  return host ? `https://${String(host).replace(/^https?:\/\//, '').replace(/\/$/, '')}` : '';
}

/** Restaurant per location. `channels` says what is on, so acceptsReservations is honest. */
export function restaurantLd(loc, { snapshot, host, customerRoot } = {}) {
  if (!loc) return null;
  const site = (snapshot && snapshot.site) || {};
  const settings = site.settings || {};
  const coords = locationCoords(loc, settings);
  const branding = loc.online_branding || {};
  const origin = originFor(host);
  const servesCuisine = settings.cuisine || settings.serves_cuisine || (site.seo && site.seo.cuisine) || null;
  return clean({
    '@context': 'https://schema.org',
    '@type': 'Restaurant',
    '@id': origin ? `${origin}/locations/${loc.online_slug || loc.id}#restaurant` : undefined,
    name: loc.name || branding.display_name,
    image: branding.hero_url || branding.logo_url || undefined,
    url: origin ? `${origin}/locations/${loc.online_slug || loc.id}` : undefined,
    telephone: loc.phone || undefined,
    address: postalAddress(loc) || undefined,
    geo: coords ? { '@type': 'GeoCoordinates', latitude: coords.lat, longitude: coords.lng } : undefined,
    openingHoursSpecification: openingHoursSpecification(loc.opening_hours),
    servesCuisine: Array.isArray(servesCuisine) ? servesCuisine : (servesCuisine ? [String(servesCuisine)] : undefined),
    acceptsReservations: locationChannelOn(loc, settings, 'bookings') ? 'True' : undefined,
    hasMenu: origin ? `${origin}/menu` : undefined,
    priceRange: settings.price_range || undefined,
    currenciesAccepted: loc.currency || undefined,
    potentialAction: locationChannelOn(loc, settings, 'online') && loc.online_slug ? { '@type': 'OrderAction', target: venueUrl(loc.online_slug, '/', customerRoot) } : undefined,
  });
}

/** Menu → MenuSection → MenuItem from the live menu, capped at MENU_LD_CAP items. */
export function menuLd(menu, { host, name } = {}) {
  const cats = menu && Array.isArray(menu.categories) ? menu.categories : [];
  if (!cats.length) return null;
  const origin = originFor(host);
  let used = 0;
  const sections = [];
  for (const c of cats) {
    if (used >= MENU_LD_CAP) break;
    const items = [];
    for (const it of c.items || []) {
      if (used >= MENU_LD_CAP) break;
      if (!it || !it.name) continue;
      items.push(clean({
        '@type': 'MenuItem',
        name: it.name,
        description: it.description || undefined,
        image: it.image || undefined,
        offers: it.price > 0 ? { '@type': 'Offer', price: Number(it.price).toFixed(2), priceCurrency: it.currency || menu.currency || 'GBP' } : undefined,
        suitableForDiet: (it.dietary || []).map((d) => DIET_SCHEMA[d]).filter(Boolean),
      }));
      used++;
    }
    if (items.length) sections.push({ '@type': 'MenuSection', name: c.label, hasMenuItem: items });
  }
  if (!sections.length) return null;
  return clean({
    '@context': 'https://schema.org',
    '@type': 'Menu',
    name: name || 'Menu',
    url: origin ? `${origin}/menu` : undefined,
    inLanguage: 'en',
    hasMenuSection: sections,
  });
}

export function organizationLd(snapshot, host) {
  const site = (snapshot && snapshot.site) || {};
  const loc = (Array.isArray(snapshot && snapshot.locations) && snapshot.locations[0]) || {};
  const branding = loc.online_branding || {};
  const origin = originFor(host);
  const footer = site.footer || {};
  const sameAs = [footer.instagram && `https://www.instagram.com/${String(footer.instagram).replace(/^@/, '')}`, footer.facebook].filter(Boolean);
  return clean({
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: siteName(snapshot),
    url: origin || undefined,
    logo: branding.logo_url || undefined,
    sameAs,
    email: footer.email || undefined,
    telephone: footer.phone || loc.phone || undefined,
  });
}

export function webSiteLd(snapshot, host) {
  const origin = originFor(host);
  return clean({
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: siteName(snapshot),
    url: origin || undefined,
    inLanguage: ((snapshot && snapshot.site && snapshot.site.seo && snapshot.site.seo.locale) || 'en').replace('_', '-'),
  });
}

/** crumbs: [{name, path}] from home to the current page. */
export function breadcrumbLd(crumbs, host) {
  const origin = originFor(host);
  if (!Array.isArray(crumbs) || crumbs.length < 2) return null;
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: crumbs.map((c, i) => clean({ '@type': 'ListItem', position: i + 1, name: c.name, item: origin ? `${origin}${c.path}` : undefined })),
  };
}

export function blogPostingLd(post, snapshot, host) {
  if (!post) return null;
  const origin = originFor(host);
  return clean({
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: post.title,
    description: post.excerpt || markdownToText(post.body_md, 160) || undefined,
    image: post.cover_url || undefined,
    author: post.author ? { '@type': 'Person', name: post.author } : { '@type': 'Organization', name: siteName(snapshot) },
    publisher: { '@type': 'Organization', name: siteName(snapshot) },
    datePublished: post.published_at || undefined,
    dateModified: post.updated_at || post.published_at || undefined,
    keywords: Array.isArray(post.tags) && post.tags.length ? post.tags.join(', ') : undefined,
    mainEntityOfPage: origin ? `${origin}/blog/${post.slug}` : undefined,
  });
}

export function faqLd(items) {
  const qs = (Array.isArray(items) ? items : []).filter((i) => i && i.q && i.a);
  if (!qs.length) return null;
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: qs.map((i) => ({ '@type': 'Question', name: String(i.q), acceptedAnswer: { '@type': 'Answer', text: markdownToText(i.a, 2000) } })),
  };
}
