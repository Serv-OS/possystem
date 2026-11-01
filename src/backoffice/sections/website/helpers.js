// src/backoffice/sections/website/helpers.js
//
// Pure helpers for the Website builder Back Office screens. No React, no DOM, no network,
// so node:test can pin them (contract section 13 C). Everything that decides an order, a
// count or a checklist lives here, the .jsx files only draw.

export const FREE_SITE_ROOT = 'sites.serv-os.app';

export const PAGE_KINDS = [
  ['home', 'Home'], ['menu', 'Menu'], ['order', 'Order'], ['catering', 'Catering'],
  ['loyalty', 'Loyalty'], ['gift', 'Gift cards'], ['findus', 'Find us'], ['blog', 'Blog'],
  ['location', 'Location'], ['custom', 'Page'],
];

// Kinds sort in the order a visitor expects them in the nav. Custom pages come last,
// then the sort_order and title decide between pages of the same kind.
const KIND_RANK = { home: 0, menu: 1, order: 2, catering: 3, loyalty: 4, gift: 5, findus: 6, location: 7, blog: 8, custom: 9 };

export const LAYOUTS = [
  ['ember', 'Ember', 'Big photo hero, warm and bold.'],
  ['ledger', 'Ledger', 'Clean columns, menu first.'],
  ['marquee', 'Marquee', 'Classic, centred, roomy.'],
];
export const TYPE_PAIRINGS = [
  ['warm-serif', 'Warm serif', 'Fraunces + Hanken'],
  ['clean-sans', 'Clean sans', 'Space Grotesk + Inter'],
  ['classic', 'Classic', 'Playfair + Source Sans 3'],
];
export const BUTTON_SHAPES = [['pill', 'Pill'], ['rounded', 'Rounded'], ['square', 'Square']];
export const MOODS = [['light', 'Light'], ['dark', 'Dark'], ['brand', 'Brand']];

// Channel switches on the Overview. The key is what settings.channels stores, the
// label is what the owner reads. Off hides the matching blocks and nav items everywhere.
export const CHANNELS = [
  ['order', 'Online ordering'],
  ['catering', 'Catering'],
  ['loyalty', 'Loyalty'],
  ['gift', 'Gift cards'],
  ['book', 'Table bookings'],
  ['waitlist', 'Waitlist'],
  ['blog', 'Blog'],
];

export function orderPages(pages) {
  const list = Array.isArray(pages) ? pages.filter(Boolean) : [];
  return [...list].sort((a, b) => {
    const ra = KIND_RANK[a.kind] ?? 9; const rb = KIND_RANK[b.kind] ?? 9;
    if (ra !== rb) return ra - rb;
    const sa = Number(a.sort_order ?? 0); const sb = Number(b.sort_order ?? 0);
    if (sa !== sb) return sa - sb;
    return String(a.title || '').localeCompare(String(b.title || ''));
  });
}

export function slugify(text) {
  return String(text ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

export function isValidSlug(slug) { return /^[a-z0-9-]{1,60}$/.test(String(slug ?? '')); }

// A page slug the designer already uses for a ServOS kind keeps that kind, anything
// else is a custom page. Used when the owner types a title in Add page.
export function kindForSlug(slug) {
  const s = String(slug ?? '');
  if (s === '') return 'home';
  const map = { menu: 'menu', order: 'order', catering: 'catering', loyalty: 'loyalty', 'gift-cards': 'gift', gift: 'gift', 'find-us': 'findus', blog: 'blog' };
  return map[s] || 'custom';
}

export function freeHost(slug) { return slug ? `https://${slug}.${FREE_SITE_ROOT}` : ''; }

// Where "View live site" goes: the custom domain once it is live, else the free address.
export function siteUrl(site) {
  if (!site) return '';
  const st = site.domain_status?.state;
  if (site.custom_domain && st === 'live') return `https://${site.custom_domain}`;
  return freeHost(site.slug);
}

export function pagePath(page) {
  if (!page) return '/';
  if (page.kind === 'location' && page.slug) return `/locations/${page.slug}`;
  return page.slug ? `/${page.slug}` : '/';
}

// The records a venue adds at their registrar. Shown before the first check, then the
// edge function's own list (with ok flags) replaces it.
export function expectedRecords(domain) {
  const d = String(domain ?? '').trim().toLowerCase();
  if (!d) return [];
  const www = d.startsWith('www.');
  const apex = www ? d.slice(4) : d;
  const recs = [];
  if (www) recs.push({ type: 'CNAME', name: 'www', value: FREE_SITE_ROOT, ok: null });
  recs.push({ type: 'A', name: '@', value: '76.76.21.21', ok: null });
  return recs.map((r) => ({ ...r, host: apex }));
}

export function normaliseDomain(input) {
  return String(input ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/\.$/, '');
}

export function isValidDomain(d) {
  return /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/.test(String(d ?? ''));
}

export function recordsMailto(domain, records) {
  const lines = (records || []).map((r) => `${r.type}  ${r.name}  ->  ${r.value}`);
  const body = [
    `Please add these DNS records for ${domain}:`, '',
    ...lines, '',
    'Then reply so we can press Check in ServOS. SSL is issued on its own once the records are live.',
  ].join('\n');
  return `mailto:?subject=${encodeURIComponent(`DNS records for ${domain}`)}&body=${encodeURIComponent(body)}`;
}

// Draft changes = anything edited after the last publish. Never published = every row.
export function draftChanges(site, pages, posts) {
  const since = site?.published_at ? Date.parse(site.published_at) : null;
  const later = (row) => {
    if (!row) return false;
    if (since == null) return true;
    const t = Date.parse(row.updated_at || '');
    return Number.isFinite(t) && t > since;
  };
  const changedPages = (pages || []).filter(later).map((p) => p.id);
  const changedPosts = (posts || []).filter(later).map((p) => p.id);
  const siteChanged = !!site && later(site) && since != null;
  return { pages: changedPages, posts: changedPosts, site: siteChanged, count: changedPages.length + changedPosts.length + (siteChanged ? 1 : 0) };
}

function pageHasPhoto(page) {
  const content = Array.isArray(page?.layout?.content) ? page.layout.content : [];
  return content.some((b) => b?.type === 'Hero' && b.props?.photo_url) || content.some((b) => b?.type === 'Gallery' && (b.props?.photos || []).length > 0);
}

// Site health. Each item is {id, label, ok, words}. ok: true | false | null (not applicable).
export function healthChecklist({ site, pages, branding } = {}) {
  const st = site?.domain_status || {};
  const hasDomain = !!site?.custom_domain;
  const home = (pages || []).find((p) => p.kind === 'home');
  const heroPhoto = !!branding?.hero_url || (home ? pageHasPhoto(home) : false);
  const pagesWithoutPhoto = (pages || []).filter((p) => ['home', 'location', 'our-story'].includes(p.kind) || p.slug === 'our-story').filter((p) => !pageHasPhoto(p) && !branding?.hero_url);
  return [
    { id: 'domain', label: 'Your own domain', ok: hasDomain ? (st.state === 'live' || st.state === 'verified') : false, words: hasDomain ? (st.state === 'live' ? `${site.custom_domain} is live` : `${site.custom_domain}: ${st.state || 'pending'}`) : 'Using the free address. Add your domain under Branding and domain.' },
    { id: 'ssl', label: 'Secure (https)', ok: hasDomain ? st.ssl === 'active' : true, words: hasDomain ? (st.ssl === 'active' ? 'Certificate active' : 'Certificate is issued once the records are live') : 'The free address is always https' },
    { id: 'phone', label: 'Phone layout', ok: (pages || []).length > 0, words: (pages || []).length ? 'Every page is built for phones first' : 'No pages yet' },
    { id: 'google', label: 'Google listing', ok: !!site?.seo?.google_site_verification, words: site?.seo?.google_site_verification ? 'Site verification code set' : 'Add your Google verification code so Search Console can see the site' },
    { id: 'share', label: 'Share image', ok: !!site?.seo?.og_image_url, words: site?.seo?.og_image_url ? 'Shows when the link is shared' : 'Upload a share image, links look bare without one' },
    { id: 'photos', label: 'Photos', ok: heroPhoto && pagesWithoutPhoto.length === 0, words: heroPhoto ? (pagesWithoutPhoto.length ? `${pagesWithoutPhoto.length} page(s) have no photo` : 'Hero photo set') : 'Add a header photo in Storefront, sites with photos get more orders' },
  ];
}

export function channelOn(settings, key) {
  const ch = settings?.channels;
  if (!ch || typeof ch !== 'object') return true; // no switch saved yet = everything connected
  return ch[key] !== false;
}

export function formatWhen(iso) {
  if (!iso) return 'never';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 'never';
  const diff = Date.now() - t;
  const m = Math.round(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 14) return `${d} day${d === 1 ? '' : 's'} ago`;
  try { return new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }); } catch { return 'earlier'; }
}

// Facts the designer gets when the owner presses "Build me a website" with nothing typed.
export function buildBrief({ name, locations } = {}) {
  const n = name || 'our venue';
  const count = Array.isArray(locations) ? locations.length : 0;
  const where = count > 1 ? `${count} locations` : 'one location';
  return `Build me a website for ${n} with ${where}. Use our live menu, ordering, loyalty and gift cards where they are switched on, a Find us page, and a blog with two starter posts.`;
}

// Puck's grey scale runs 12 (lightest) to 01 (darkest). The Back Office skin can be dark or
// light, so map Puck's variables to the BO tokens and the editor follows whichever skin is on.
export const PUCK_THEME_VARS = {
  '--puck-color-white': 'var(--bg1)',
  '--puck-color-black': 'var(--t1)',
  '--puck-color-grey-12': 'var(--bg1)',
  '--puck-color-grey-11': 'var(--bg2)',
  '--puck-color-grey-10': 'var(--bg3)',
  '--puck-color-grey-09': 'var(--bdr)',
  '--puck-color-grey-08': 'var(--bdr2)',
  '--puck-color-grey-07': 'var(--t4)',
  '--puck-color-grey-06': 'var(--t3)',
  '--puck-color-grey-05': 'var(--t3)',
  '--puck-color-grey-04': 'var(--t2)',
  '--puck-color-grey-03': 'var(--t2)',
  '--puck-color-grey-02': 'var(--t1)',
  '--puck-color-grey-01': 'var(--t1)',
  '--puck-color-azure-04': 'var(--acc)',
  '--puck-color-azure-05': 'var(--acc)',
  '--puck-color-azure-06': 'var(--acc-b, var(--acc))',
  '--puck-color-azure-07': 'var(--acc-b, var(--acc))',
  '--puck-color-azure-08': 'var(--acc-d, var(--bg3))',
  '--puck-color-azure-09': 'var(--acc-d, var(--bg3))',
  '--puck-color-azure-10': 'var(--acc-d, var(--bg3))',
  '--puck-color-azure-11': 'var(--bg2)',
  '--puck-color-azure-12': 'var(--bg2)',
  '--puck-font-family': 'inherit',
  '--puck-font-family-monospaced': 'ui-monospace, SFMono-Regular, Menlo, monospace',
};

export const VIEWPORTS = { desktop: { width: 1280, height: 'auto', label: 'Desktop' }, phone: { width: 390, height: 'auto', label: 'Phone' } };


/**
 * 5.12.13 (Peter, 1 Nov: "where will we set coordinates, it needs to do this from the address"):
 * venues the website still cannot place on a map. A venue is placed when its row has latitude and
 * longitude, or when the site's settings.geo has a cached fix for it. Only venues with an address
 * count, since nothing can be looked up without one.
 */
export function venuesNeedingGeocode(site, locations) {
  const geo = site && site.settings && site.settings.geo && typeof site.settings.geo === 'object' ? site.settings.geo : {};
  const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
  return (Array.isArray(locations) ? locations : []).filter((l) => {
    if (!l || !l.id) return false;
    if (typeof l.address !== 'string' || !l.address.trim()) return false;
    const lat = num(l.latitude), lng = num(l.longitude);
    if (Number.isFinite(lat) && Number.isFinite(lng)) return false;
    const g = geo[l.id];
    return !(g && Number.isFinite(Number(g.lat)) && Number.isFinite(Number(g.lng)));
  });
}
