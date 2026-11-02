// src/lib/online/siblingVenues.js
//
// CHANGE LOCATION on the online menu page (5.12.34). PURE apart from the loader, which takes
// its clients as arguments; tested in siblingVenues.test.js.
//
// The company's other venues with online ordering on, read exactly as the group landing page
// (src/surfaces/GroupOrderSurface.jsx) reads them: the platform locations rows of the company
// through the customer's own platform client, and the address fallback chain through the ops
// client. Never a service key: both clients are the anon ones the page already holds.

/** One address line, never null: platform address, else the ops address column, else the
 *  receipt header address lines joined, else ''. The same chain as the group landing page. */
export function venueAddressLine(platformRow, opsRow) {
  const p = platformRow && typeof platformRow.address === 'string' ? platformRow.address.trim() : '';
  if (p) return p;
  const o = opsRow && typeof opsRow.address === 'string' ? opsRow.address.trim() : '';
  if (o) return o;
  const lines = opsRow?.receipt_branding?.header?.address_lines;
  const rb = Array.isArray(lines) ? lines.map((l) => String(l ?? '').trim()).filter(Boolean).join(', ') : '';
  return rb;
}

/** The company's OTHER venues a customer can switch to: online ordering on, with a slug,
 *  not this one, sorted by name. */
export function siblingVenues(rows, currentId) {
  return (Array.isArray(rows) ? rows : [])
    .filter((r) => r && r.id && r.id !== currentId && r.online_enabled === true && typeof r.online_slug === 'string' && r.online_slug.trim())
    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
}

/** The words shown above Continue when the basket is not empty. */
export function cartResetWords(cartCount, venueName) {
  const n = Math.max(0, Number(cartCount) || 0);
  if (!n) return '';
  const items = n === 1 ? '1 item' : `${n} items`;
  return `Your basket (${items}) will start again at ${String(venueName || 'the other venue').trim()}.`;
}

/**
 * The URL of a sibling venue's online page.
 *   - On a page reached by ?loc=<slug> (app host, testing), the same origin, path and query with
 *     the slug swapped, so ?surface=online and friends survive.
 *   - Otherwise the venue's own customer URL (customerUrl: the subdomain on the customer domain).
 * `here` is window.location (or a test object); customerUrl is injected.
 */
export function siblingVenueUrl(slug, here, customerUrl) {
  const s = String(slug || '').trim();
  if (!s) return '';
  const search = here?.search || '';
  if (search && new URLSearchParams(search).has('loc')) {
    const params = new URLSearchParams(search);
    params.set('loc', s);
    params.delete('t');
    return `${here.origin || ''}${here.pathname || '/'}?${params.toString()}`;
  }
  return typeof customerUrl === 'function' ? customerUrl(s, '') : '';
}

/**
 * Read the company's venues for the Change location sheet.
 * @param {{ platformSupabase: object|null, supabase: object|null, companyId: string|null, currentId: string }}
 * @returns {Promise<{ id, ops_location_id, name, online_slug, address }[]>}  [] on any failure
 */
export async function loadSiblingVenues({ platformSupabase, supabase, companyId, currentId }) {
  if (!platformSupabase || !companyId) return [];
  try {
    const { data: locs, error } = await platformSupabase
      .from('locations')
      .select('id, ops_location_id, name, address, online_slug, online_enabled')
      .eq('company_id', companyId)
      .order('name');
    if (error || !Array.isArray(locs)) return [];
    const siblings = siblingVenues(locs, currentId);
    if (!siblings.length) return [];
    const opsById = {};
    if (supabase) {
      try {
        const opsIds = [...new Set(siblings.map((v) => v.ops_location_id || v.id))];
        const { data: opsLocs } = await supabase.from('locations').select('id, address, receipt_branding').in('id', opsIds);
        (opsLocs || []).forEach((r) => { if (r?.id) opsById[r.id] = r; });
      } catch { /* the address line just will not render */ }
    }
    return siblings.map((v) => ({
      id: v.id, ops_location_id: v.ops_location_id || v.id, name: v.name || '', online_slug: v.online_slug,
      address: venueAddressLine(v, opsById[v.ops_location_id || v.id]),
    }));
  } catch {
    return [];
  }
}
