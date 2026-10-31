// api/_lib/website/resolveSite.js
//
// Which published site does a host name? (ARCHITECTURE.md sections 2 and 4 step 1)
// The Platform RPC web_resolve_host(p_host) (SECURITY DEFINER, anon) answers with the public row
// { slug, custom_domain, apex_domain, published_version_id, snapshot, domain_live }. While that function is not
// deployed yet, the anon view web_sites_public is read directly with the same match. A draft
// preview reads the draft through the service role, only after the token verified (preview.js).
// Pure apart from the clients passed in, so node:test drives it with fakes. Never throws.

export const RESOLVE_TIMEOUT_MS = 6000;

function isMissingFunction(error) {
  const code = String((error && error.code) || '');
  const msg = String((error && error.message) || '');
  return code === 'PGRST202' || code === '42883' || /function .*web_resolve_host|schema cache/i.test(msg);
}

function withTimeout(p, ms, label) {
  let t;
  const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${label} timed out`)), ms); });
  return Promise.race([Promise.resolve(p), timeout]).finally(() => clearTimeout(t));
}

/** The free slug for a host, when the host is the free address. */
export function freeSlugOf(host) {
  const m = /^([a-z0-9-]+)\.sites\.(?:[a-z0-9-]+\.)?serv-os\.app$/.exec(String(host || '').toLowerCase());
  return m ? m[1] : null;
}

/**
 * resolveSite(platformClient, host, { slug }) → { site, error } where site is the public row with
 * `snapshot` (object) or null when nothing is live for that host. `slug` forces a lookup by slug
 * (the ?site=<slug> local testing door).
 */
export async function resolveSite(platformClient, host, { slug = null, timeoutMs = RESOLVE_TIMEOUT_MS } = {}) {
  if (!platformClient) return { site: null, error: new Error('no platform client') };
  const h = String(host || '').toLowerCase().replace(/:\d+$/, '');
  try {
    if (!slug) {
      const rpc = await withTimeout(platformClient.rpc('web_resolve_host', { p_host: h }), timeoutMs, 'web_resolve_host');
      if (!rpc.error) {
        const row = Array.isArray(rpc.data) ? rpc.data[0] : rpc.data;
        return { site: normaliseRow(row), error: null };
      }
      if (!isMissingFunction(rpc.error)) return { site: null, error: rpc.error };
    }
    // Fallback: the anon view, matched the way the RPC matches.
    const want = slug || freeSlugOf(h);
    // select * so domain_live rides along once the SQL adds it and its absence never breaks a site.
    let q = platformClient.from('web_sites_public').select('*');
    q = want ? q.eq('slug', want) : q.or(`custom_domain.eq.${h},apex_domain.eq.${h}`);
    const res = await withTimeout(q.limit(1).maybeSingle(), timeoutMs, 'web_sites_public');
    if (res.error) return { site: null, error: res.error };
    return { site: normaliseRow(res.data), error: null };
  } catch (e) {
    return { site: null, error: e instanceof Error ? e : new Error(String(e)) };
  }
}

function normaliseRow(row) {
  if (!row || typeof row !== 'object') return null;
  let snapshot = row.snapshot;
  if (typeof snapshot === 'string') { try { snapshot = JSON.parse(snapshot); } catch { snapshot = null; } }
  if (!snapshot || typeof snapshot !== 'object') return null;
  snapshot.site = snapshot.site && typeof snapshot.site === 'object' ? snapshot.site : {};
  // The row's address fields win over the snapshot's copy (a domain can change after a publish).
  if (row.slug) snapshot.site.slug = row.slug;
  if (row.custom_domain !== undefined) snapshot.site.custom_domain = row.custom_domain || null;
  if (row.apex_domain !== undefined) snapshot.site.apex_domain = row.apex_domain || null;
  if (row.status) snapshot.site.status = row.status;
  // Is the custom domain answering yet? Only then may canonical, sitemap and robots name it. The
  // view says so (domain_live); a row without the column (SQL not run yet) means not yet.
  const domainLive = row.domain_live === true || (row.domain_status && typeof row.domain_status === 'object' && row.domain_status.state === 'live');
  snapshot.site.domain_live = !!(snapshot.site.custom_domain && domainLive);
  return { slug: row.slug || snapshot.site.slug || null, custom_domain: row.custom_domain || null, apex_domain: row.apex_domain || null, published_version_id: row.published_version_id || null, status: row.status || snapshot.site.status || 'live', domain_live: snapshot.site.domain_live, snapshot };
}

/**
 * The draft of a site as a snapshot, through the service role, for /preview. Tries the Platform
 * RPC web_preview_snapshot(p_site_id) first (agent A may ship it); else builds the shape from the
 * tables (section 2). Returns { snapshot, error }.
 */
export async function loadDraftSnapshot(serviceClient, siteId, { timeoutMs = RESOLVE_TIMEOUT_MS } = {}) {
  if (!serviceClient || !siteId) return { snapshot: null, error: new Error('no client or site') };
  try {
    const rpc = await withTimeout(serviceClient.rpc('web_preview_snapshot', { p_site_id: siteId }), timeoutMs, 'web_preview_snapshot').catch((e) => ({ error: e }));
    if (rpc && !rpc.error && rpc.data) {
      const n = normaliseRow({ snapshot: rpc.data, status: 'draft' });
      if (n) return { snapshot: n.snapshot, error: null };
    }
    const [siteRes, pagesRes, postsRes] = await withTimeout(Promise.all([
      serviceClient.from('web_sites').select('*').eq('id', siteId).maybeSingle(),
      serviceClient.from('web_pages').select('*').eq('site_id', siteId).order('sort_order'),
      serviceClient.from('web_posts').select('*').eq('site_id', siteId).order('published_at', { ascending: false }),
    ]), timeoutMs, 'draft read');
    if (siteRes.error || !siteRes.data) return { snapshot: null, error: siteRes.error || new Error('site not found') };
    const site = siteRes.data;
    let locations = [];
    if (site.company_id) {
      const locRes = await withTimeout(serviceClient.from('locations').select('*').eq('company_id', site.company_id).order('name'), timeoutMs, 'locations read').catch(() => ({ data: null }));
      locations = (locRes && Array.isArray(locRes.data) ? locRes.data : []).map(shapeLocation);
    }
    const snapshot = {
      site: { id: site.id, slug: site.slug, custom_domain: site.custom_domain, apex_domain: site.apex_domain, domain_live: !!(site.custom_domain && site.domain_status && site.domain_status.state === 'live'), status: 'draft', theme: site.theme || {}, nav: site.nav || [], footer: site.footer || {}, seo: site.seo || {}, settings: site.settings || {} },
      // A preview shows draft pages and posts too: that is what the owner is checking.
      pages: (Array.isArray(pagesRes.data) ? pagesRes.data : []).map((p) => ({ ...p, status: 'published' })),
      posts: (Array.isArray(postsRes.data) ? postsRes.data : []).map((p) => ({ ...p, status: 'published' })),
      locations,
      generated_at: new Date().toISOString(),
      preview: true,
    };
    return { snapshot, error: null };
  } catch (e) {
    return { snapshot: null, error: e instanceof Error ? e : new Error(String(e)) };
  }
}

/** A platform locations row → the snapshot location shape the renderers read. */
export function shapeLocation(row) {
  if (!row) return null;
  return {
    id: row.id, ops_location_id: row.ops_location_id || null, name: row.name || '', online_slug: row.online_slug || null,
    timezone: row.timezone || 'Europe/London', currency: row.currency || 'GBP', sort_order: row.sort_order || 0,
    address: row.address || row.address_line1 || null, phone: row.phone || row.telephone || null,
    latitude: row.latitude ?? null, longitude: row.longitude ?? null,
    opening_hours: row.opening_hours || null, online_branding: row.online_branding || null,
    online_menu_id: row.online_menu_id || null,
    channels: {
      online: row.online_enabled !== false,
      catering: row.catering_enabled === true,
      loyalty: row.loyalty_enabled === true,
      gift: row.gift_cards_enabled === true || row.gift_enabled === true,
      bookings: row.bookings_enabled === true,
      waitlist: row.waitlist_enabled === true,
    },
  };
}
