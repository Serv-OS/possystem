// src/surfaces/website/hostParse.js
//
// Which site does a hostname name? (ARCHITECTURE.md section 3)
//   <slug>.sites.serv-os.app  (and <slug>.sites.<tier root>)  → { kind: 'free', slug }
//   a host that ends with none of our own suffixes             → { kind: 'custom', host }
//   our own hosts (<slug>.serv-os.app ordering, app., dev., vercel.app, localhost, IPs) → null
// Pure, shared by lib/customerUrl.js (the SPA) and api/_lib/website (Node). The known suffix list
// is lib/customerHost.js rootDomainSuffixes, so a new customer root is recognised in one place.

import { rootDomainSuffixes, parseCustomerLocation } from '../../lib/customerHost.js';

export const FREE_SITE_ZONE = 'sites';
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$/;
const IP_RE = /^(\d{1,3}\.){3}\d{1,3}$|^\[?[0-9a-f:]+\]?$/i;

/** Hosts that are ours and never a venue website: operator app, previews, local dev. */
export function ownHostSuffixes(customerRoot = 'serv-os.app') {
  return [...rootDomainSuffixes(customerRoot), '.vercel.app', 'localhost', '.localhost', '.local'];
}

/** The free site suffixes: '.sites.serv-os.app' plus '.sites.<customerRoot>' on dev tiers. */
export function freeSiteSuffixes(customerRoot = 'serv-os.app') {
  const out = [`.${FREE_SITE_ZONE}.serv-os.app`];
  const tier = `.${FREE_SITE_ZONE}.${customerRoot}`;
  if (customerRoot && !out.includes(tier)) out.push(tier);
  return out;
}

/**
 * parseWebsiteHost(hostname, customerRoot?) → { kind:'free', slug } | { kind:'custom', host } | null.
 */
export function parseWebsiteHost(hostname, customerRoot = 'serv-os.app') {
  const h = String(hostname || '').toLowerCase().trim().replace(/\.$/, '').replace(/:\d+$/, '');
  if (!h || h === 'localhost' || IP_RE.test(h) || !h.includes('.')) return null;
  for (const suffix of freeSiteSuffixes(customerRoot)) {
    if (h.endsWith(suffix)) {
      const slug = h.slice(0, -suffix.length);
      return SLUG_RE.test(slug) ? { kind: 'free', slug } : null;
    }
  }
  const bare = ['serv-os.app', 'servos.app', 'pos-up.com', customerRoot].filter(Boolean);
  if (bare.includes(h)) return null;
  for (const suffix of ownHostSuffixes(customerRoot)) {
    if (h.endsWith(suffix)) return null;
  }
  return { kind: 'custom', host: h };
}

const LOCAL_HOST_RE = /^(localhost|127\.0\.0\.1|\[?::1\]?|\d{1,3}(\.\d{1,3}){3})$/;

/**
 * Hosts where ?site=<slug> may open a website for local testing: localhost, IPs, Vercel previews
 * and the operator app host. No customer is ever served by hostname on these, so the door cannot
 * take a customer page away. Every venue host (<slug>.serv-os.app, <slug>.wifi.serv-os.app) is
 * NOT one: the WiFi relay sends guests to /wifi?site=<unifi site id> and that must stay the portal.
 */
export function isWebsiteTestingHost(hostname, customerRoot = 'serv-os.app') {
  const h = String(hostname || '').toLowerCase().trim().replace(/:\d+$/, '');
  if (!h || LOCAL_HOST_RE.test(h) || h.endsWith('.localhost') || h.endsWith('.vercel.app')) return true;
  return ['serv-os.app', 'app.serv-os.app', customerRoot, `app.${customerRoot}`].filter(Boolean).includes(h);
}

/**
 * The SPA's website check for a window.location like object: the hostname first (parseWebsiteHost),
 * then the ?site= testing door, which only opens on a testing host AND when the path and query name
 * no customer surface (so /wifi, /t/<table>, /gift, ?surface= and ?loc= always win).
 * Returns { mode:'website', host, siteSlug, slug:null, tableId:null, groupSlug:null } or null.
 */
export function parseWebsiteLocation(loc, { customerRoot = 'serv-os.app' } = {}) {
  if (!loc) return null;
  const hostname = String(loc.hostname || '').toLowerCase();
  const site = parseWebsiteHost(hostname, customerRoot);
  if (site) return { mode: 'website', host: hostname, siteSlug: site.kind === 'free' ? site.slug : null, slug: null, tableId: null, groupSlug: null };
  if (!isWebsiteTestingHost(hostname, customerRoot)) return null;
  const siteParam = String(new URLSearchParams(loc.search || '').get('site') || '').toLowerCase();
  if (!SLUG_RE.test(siteParam) || siteParam.length < 3) return null;
  // No stored preview slug here on purpose: only the path and the query can name a customer page.
  const base = parseCustomerLocation({ hostname, pathname: loc.pathname || '/', search: loc.search || '' }, { customerRoot });
  if (base && base.mode) return null;
  return { mode: 'website', host: hostname, siteSlug: siteParam, slug: null, tableId: null, groupSlug: null };
}

/**
 * The canonical public host of a site: the custom domain once its DNS is live (domain_live) or when
 * the request already arrived on it, else the free address, else the request host. A domain the
 * owner has typed but not pointed yet must never be the canonical: Google would consolidate to a
 * host that does not answer and drop the free address pages.
 */
export function canonicalHost(site, requestHost) {
  const req = String(requestHost || '').toLowerCase().replace(/:\d+$/, '');
  const custom = site && site.custom_domain ? String(site.custom_domain).toLowerCase() : '';
  if (custom && (site.domain_live === true || req === custom)) return custom;
  const slug = site && site.slug ? String(site.slug).toLowerCase() : '';
  if (slug && !req) return `${slug}.${FREE_SITE_ZONE}.serv-os.app`;
  return req || (slug ? `${slug}.${FREE_SITE_ZONE}.serv-os.app` : '');
}

/**
 * 5.12.6: the query a client side navigation keeps. The ?site= testing door only exists on a
 * testing host, so it is carried over only when the address already has it; on a venue's own
 * host (free or custom) links stay clean ("/" not "/?site=mozz").
 */
export function siteQueryFor(search, siteSlug) {
  const current = String(new URLSearchParams(String(search || '')).get('site') || '');
  if (!current) return '';
  const slug = String(siteSlug || current);
  return `?site=${encodeURIComponent(slug)}`;
}
