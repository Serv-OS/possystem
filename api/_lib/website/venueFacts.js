// api/_lib/website/venueFacts.js: the venue facts the AI designer writes from, assembled SERVER side
// (ARCHITECTURE.md section 11). The browser never sends facts: a client could describe another
// company's venue and have the designer write it onto this site. Every query here is fenced by the
// company id the function resolved from the caller's own access, and every read is wrapped so a
// missing table or a slow database gives an empty fact, never a failed build.
//
// Tables and columns are the ones the live surfaces read today (grepped, not guessed):
//   Platform: companies(id,name,slug), locations(... online_branding, opening_hours, online_slug,
//             online_enabled, qr_enabled, online_delivery_enabled, online_menu_id, currency, timezone,
//             latitude, longitude, ops_location_id), loyalty_config(company_id, enabled, points_enabled,
//             stamps_enabled), stamp_card_programs(company_id, active), gift_brand_config(company_id, enabled),
//             web_sites / web_pages / web_posts / web_ai_messages (section 2).
//   Ops:      menu_items(location_id text, cat, cats, parent_id, image, visibility, tags, archived),
//             menu_categories(location_id, label, menu_id, parent_id), menus, menu_category_links,
//             catering_site_settings(location_id uuid, enabled), booking_rules(location_id),
//             waitlist_config(location_id).
// Ops location ids are platform locations.ops_location_id (menu_items.location_id is text).

const FACTS_TIMEOUT_MS = 8000;
const MAX_ROWS = 1000;              // Peter's scale rule: never an unbounded read
const SAMPLE_ITEMS_PER_CATEGORY = 5;

/** One PostgREST GET. Returns rows or [] (never throws): facts are best effort. */
export async function restSelect({ url, key, token }, path, { fetchImpl, timeoutMs = FACTS_TIMEOUT_MS } = {}) {
  const f = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  if (!f || !url || !key) return [];
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const t = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
  try {
    const res = await f(`${String(url).replace(/\/$/, '')}/rest/v1/${path}`, {
      method: 'GET',
      headers: { apikey: key, authorization: `Bearer ${token || key}`, accept: 'application/json' },
      ...(ctl ? { signal: ctl.signal } : {}),
    });
    if (!res.ok) return [];
    const body = await res.json();
    return Array.isArray(body) ? body : [];
  } catch {
    return [];
  } finally {
    if (t) clearTimeout(t);
  }
}

const inList = (ids) => `in.(${ids.map((x) => `"${String(x).replace(/"/g, '')}"`).join(',')})`;

/** UK or US copy rules from the money the venue takes. */
export function spellingFor(currency) {
  return String(currency || '').toUpperCase() === 'USD' ? 'us' : 'uk';
}

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

/** Opening hours jsonb ({weekly:{mon:[{open,close}]}}) to short plain lines the model can read. */
export function hoursSummary(opening_hours) {
  const weekly = opening_hours?.weekly;
  if (!weekly || typeof weekly !== 'object') return [];
  return DAYS.map((d) => {
    const w = Array.isArray(weekly[d]) ? weekly[d] : [];
    const spans = w.filter((x) => x && x.open && x.close).map((x) => `${x.open} to ${x.close}`);
    return `${d}: ${spans.length ? spans.join(', ') : 'closed'}`;
  });
}

function visibleOnline(item) {
  const v = item?.visibility;
  if (!v || typeof v !== 'object') return true;
  return v.online !== false;
}

/**
 * Menu summary for one Ops location: categories with sample item names, counts, photo coverage.
 * Pure once the rows are in (tested with fixtures). A pinned online menu narrows categories to its
 * links, like OnlineSurface does; else every top level category of the location.
 */
export function summariseMenu({ categories = [], items = [], menus = [], links = [], pinnedMenuId = null } = {}) {
  const live = items.filter((it) => it && it.archived !== true && !it.parent_id && visibleOnline(it));
  let cats = categories.filter((c) => c && !c.parent_id);
  if (pinnedMenuId) {
    const linked = new Set(links.filter((l) => l.menu_id === pinnedMenuId).map((l) => l.category_id));
    const own = cats.filter((c) => linked.has(c.id) || c.menu_id === pinnedMenuId);
    if (own.length) cats = own;
  }
  cats = [...cats].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
  const byCat = new Map();
  for (const it of live) {
    const ids = new Set([it.cat, ...(Array.isArray(it.cats) ? it.cats : [])].filter(Boolean));
    for (const id of ids) {
      if (!byCat.has(id)) byCat.set(id, []);
      byCat.get(id).push(it);
    }
  }
  const out = cats.map((c) => {
    const list = byCat.get(c.id) || [];
    return {
      id: c.id,
      label: c.label,
      count: list.length,
      sample: list.slice(0, SAMPLE_ITEMS_PER_CATEGORY).map((it) => it.name).filter(Boolean),
    };
  }).filter((c) => c.count > 0);
  const withPhoto = live.filter((it) => typeof it.image === 'string' && it.image.trim()).length;
  return {
    categories: out,
    item_count: live.length,
    photo_count: withPhoto,
    photo_coverage_pct: live.length ? Math.round((withPhoto / live.length) * 100) : 0,
    menus: menus.filter((m) => m && m.is_active !== false).map((m) => ({ id: m.id, name: m.name, is_default: !!m.is_default })),
  };
}

/** Loyalty type from the config row and the live stamp programmes. */
export function loyaltyType(config, programs = []) {
  if (!config || config.enabled === false) return { on: false, type: 'none', programs: [] };
  const stamps = config.stamps_enabled !== false && programs.length > 0;
  const points = config.points_enabled !== false;
  const type = stamps && points ? 'both' : stamps ? 'stamps' : points ? 'points' : 'none';
  return {
    on: type !== 'none',
    type,
    programs: programs.slice(0, 5).map((p) => ({ name: p.name, stamps_required: p.stamps_required, reward: p.reward_description || '' })),
  };
}

/**
 * Assemble the facts for one company and its site.
 *   platform: { url, key } service role of the Platform DB
 *   ops:      { url, key } the Ops DB (service role when the server has it, else the public key:
 *             the menu tables are anon readable for online ordering already)
 * Never throws. Every field has an empty default.
 */
export async function assembleVenueFacts({ platform, ops, companyId, siteId, fetchImpl, now = new Date() } = {}) {
  const P = (path) => restSelect(platform, path, { fetchImpl });
  const O = (path) => restSelect(ops, path, { fetchImpl });
  const empty = emptyFacts();
  if (!companyId) return empty;

  const [companies, locations, loyaltyCfg, programs, giftCfg, sites, pages, posts, messages] = await Promise.all([
    P(`companies?id=eq.${companyId}&select=id,name,slug`),
    P(`locations?company_id=eq.${companyId}&select=id,ops_location_id,name,address,timezone,currency,online_slug,online_enabled,qr_enabled,online_delivery_enabled,opening_hours,online_branding,online_menu_id,latitude,longitude,created_at&order=created_at.asc&limit=${MAX_ROWS}`),
    P(`loyalty_config?company_id=eq.${companyId}&select=enabled,points_enabled,stamps_enabled`),
    P(`stamp_card_programs?company_id=eq.${companyId}&active=is.true&select=id,name,stamps_required,reward_description&limit=20`),
    P(`gift_brand_config?company_id=eq.${companyId}&select=enabled`),
    siteId ? P(`web_sites?id=eq.${siteId}&company_id=eq.${companyId}&select=id,slug,custom_domain,status,theme,nav,footer,seo,settings`) : Promise.resolve([]),
    siteId ? P(`web_pages?site_id=eq.${siteId}&select=id,slug,title,kind,status,location_id,seo,layout&order=sort_order.asc&limit=100`) : Promise.resolve([]),
    siteId ? P(`web_posts?site_id=eq.${siteId}&select=id,slug,title,status,excerpt,tags&order=updated_at.desc&limit=50`) : Promise.resolve([]),
    siteId ? P(`web_ai_messages?site_id=eq.${siteId}&select=role,content,created_at&order=created_at.desc&limit=20`) : Promise.resolve([]),
  ]);

  const company = companies[0] || null;
  const site = sites[0] || null;
  const locs = locations.filter((l) => l && l.company_id !== undefined ? l.company_id === companyId : true);
  const defaultId = site?.settings?.default_location_id || null;
  const defaultLoc = locs.find((l) => l.id === defaultId) || locs[0] || null;
  const currency = defaultLoc?.currency || 'GBP';
  const branding = defaultLoc?.online_branding || {};

  // Ops facts, fenced to this company's Ops location ids.
  const opsIds = locs.map((l) => l.ops_location_id || l.id).filter(Boolean);
  const defaultOps = defaultLoc ? (defaultLoc.ops_location_id || defaultLoc.id) : null;
  const [categories, items, menus, catering, bookings, waitlist] = await Promise.all([
    defaultOps ? O(`menu_categories?location_id=eq.${defaultOps}&select=id,label,menu_id,parent_id,sort_order&order=sort_order.asc&limit=${MAX_ROWS}`) : [],
    defaultOps ? O(`menu_items?location_id=eq.${defaultOps}&archived=eq.false&select=id,name,cat,cats,parent_id,image,visibility,tags&limit=${MAX_ROWS}`) : [],
    defaultOps ? O(`menus?location_id=eq.${defaultOps}&select=id,name,is_active,is_default&limit=50`) : [],
    opsIds.length ? O(`catering_site_settings?location_id=${inList(opsIds)}&select=location_id,enabled,slug`) : [],
    opsIds.length ? O(`booking_rules?location_id=${inList(opsIds)}&select=location_id`) : [],
    opsIds.length ? O(`waitlist_config?location_id=${inList(opsIds)}&select=location_id`) : [],
  ]);
  const menuIds = menus.map((m) => m.id).filter(Boolean);
  const links = menuIds.length ? await O(`menu_category_links?menu_id=${inList(menuIds)}&select=menu_id,category_id,sort_order&limit=${MAX_ROWS}`) : [];

  const menu = summariseMenu({ categories, items, menus, links, pinnedMenuId: defaultLoc?.online_menu_id || null });
  const cateringOn = catering.some((c) => c && c.enabled === true);
  const bookingsOn = bookings.length > 0;
  const waitlistOn = waitlist.length > 0;
  const loyalty = loyaltyType(loyaltyCfg[0] || null, programs);

  return {
    generated_at: now.toISOString(),
    company: {
      id: companyId,
      name: company?.name || branding.display_name || defaultLoc?.name || '',
      slug: company?.slug || '',
      currency,
      country: spellingFor(currency) === 'us' ? 'US' : 'UK',
      spelling: spellingFor(currency),
    },
    branding: {
      display_name: branding.display_name || company?.name || defaultLoc?.name || '',
      logo_url: branding.logo_url || '',
      hero_url: branding.hero_url || '',
      brand_color: branding.brand_color || branding.accent_color || '',
      tagline: branding.tagline || '',
    },
    locations: locs.map((l) => ({
      id: l.id,
      ops_location_id: l.ops_location_id || null,
      name: l.name,
      address: l.address || '',
      timezone: l.timezone || 'Europe/London',
      currency: l.currency || currency,
      online_slug: l.online_slug || '',
      online_enabled: !!l.online_enabled,
      qr_enabled: !!l.qr_enabled,
      delivery_enabled: !!l.online_delivery_enabled,
      hours: hoursSummary(l.opening_hours),
      has_coordinates: Number.isFinite(l.latitude) && Number.isFinite(l.longitude),
      is_default: defaultLoc ? l.id === defaultLoc.id : false,
    })),
    channels: {
      online: locs.some((l) => l.online_enabled),
      qr: locs.some((l) => l.qr_enabled),
      delivery: locs.some((l) => l.online_delivery_enabled),
      catering: cateringOn,
      loyalty,
      gift: !!(giftCfg[0] && giftCfg[0].enabled === true),
      bookings: bookingsOn,
      waitlist: waitlistOn,
    },
    menu,
    site: site ? {
      id: site.id,
      slug: site.slug,
      custom_domain: site.custom_domain || null,
      status: site.status,
      theme: site.theme || {},
      nav: site.nav || [],
      footer: site.footer || {},
      seo: site.seo || {},
      pages: pages.map((p) => ({ id: p.id, slug: p.slug, title: p.title, kind: p.kind, status: p.status, location_id: p.location_id || null, blocks: Array.isArray(p.layout?.content) ? p.layout.content.map((b) => b?.type).filter(Boolean) : [] })),
      posts: posts.map((p) => ({ id: p.id, slug: p.slug, title: p.title, status: p.status, tags: p.tags || [] })),
    } : null,
    recent_messages: [...messages].sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || ''))).map((m) => ({ role: m.role, content: String(m.content || '').slice(0, 4000) })),
  };
}

export function emptyFacts() {
  return {
    generated_at: new Date().toISOString(),
    company: { id: null, name: '', slug: '', currency: 'GBP', country: 'UK', spelling: 'uk' },
    branding: { display_name: '', logo_url: '', hero_url: '', brand_color: '', tagline: '' },
    locations: [],
    channels: { online: false, qr: false, delivery: false, catering: false, loyalty: { on: false, type: 'none', programs: [] }, gift: false, bookings: false, waitlist: false },
    menu: { categories: [], item_count: 0, photo_count: 0, photo_coverage_pct: 0, menus: [] },
    site: null,
    recent_messages: [],
  };
}

/** Short lines for the Designer's "what I read" list (no ids, no messages). */
export function factsSummaryLines(facts) {
  const f = facts || emptyFacts();
  const lines = [];
  if (f.company.name) lines.push(`Venue: ${f.company.name} (${f.company.country}, ${f.company.currency})`);
  lines.push(`Locations: ${f.locations.length}${f.locations.length ? ', ' + f.locations.map((l) => l.name).join(', ') : ''}`);
  lines.push(`Menu: ${f.menu.item_count} items in ${f.menu.categories.length} categories, ${f.menu.photo_coverage_pct}% with photos`);
  const on = Object.entries(f.channels).filter(([k, v]) => (k === 'loyalty' ? v.on : v === true)).map(([k, v]) => (k === 'loyalty' ? `loyalty (${v.type})` : k));
  lines.push(`Channels on: ${on.length ? on.join(', ') : 'none yet'}`);
  if (f.branding.logo_url) lines.push('Logo: from Appearance branding');
  if (f.branding.hero_url) lines.push('Hero photo: from Appearance branding');
  if (f.branding.brand_color) lines.push(`Brand colour: ${f.branding.brand_color}`);
  if (f.site) lines.push(`Site: ${f.site.pages.length} pages, ${f.site.posts.length} posts, status ${f.site.status}`);
  return lines;
}
