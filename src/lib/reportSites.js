// src/lib/reportSites.js
//
// The READS behind the report scope (src/lib/reportScope.js keeps the rules, this file only
// asks). Three small requests when Reports opens, none of them per row:
//   1. accessible_location_ids()  what the database lets this login read: the same function
//      the closed_checks_read policy uses, so the Sites control can never offer a site whose
//      sales the database would then refuse (or hide one it would allow: one Coffee Boy
//      owner saw 5 of 6 through the user_locations path).
//   2. Ops locations              id, name, org_id, currency: the company and the currency.
//   3. Platform locations         each site's own clock, by ops_location_id (9 of 13 sites
//      have a different id on Platform, so never by id alone).
// Anything that fails leaves the scope at the signed in site alone. Reports never wait on a
// failure here and never widen on a guess.

import { supabase, platformSupabase, isMock } from './supabase';
import { fetchReportDaySums } from './reportDaySums.js';

const firstValue = (r) => (r && typeof r === 'object' ? Object.values(r)[0] : r);

/** What the database lets this login read, as Ops location ids; null when it could not be asked. */
export async function fetchReadableSiteIds() {
  if (isMock || !supabase) return null;
  try {
    const { data, error } = await supabase.rpc('accessible_location_ids');
    if (error || !Array.isArray(data)) return null;
    return data.map(firstValue).filter(Boolean).map(String);
  } catch { return null; }
}

/** Each site's own clock from Platform, keyed by OPS id. A site with no row is left out. */
export async function fetchSiteClocks(opsIds) {
  const out = {};
  if (!platformSupabase || !opsIds?.length) return out;
  const select = 'id, ops_location_id, timezone, business_day_start, shifts, currency';
  const put = (key, row) => {
    out[key] = { timezone: row.timezone || null, businessDayStart: row.business_day_start || null, shifts: row.shifts || [], currency: row.currency || null };
  };
  try {
    const { data } = await platformSupabase.from('locations').select(select).in('ops_location_id', opsIds);
    for (const row of data || []) if (row.ops_location_id) put(String(row.ops_location_id), row);
    // Legacy rows where the Platform id IS the Ops id (getVenueClock's second look).
    const missing = opsIds.filter((id) => !out[id]);
    if (missing.length) {
      const { data: legacy } = await platformSupabase.from('locations').select(select).in('id', missing);
      for (const row of legacy || []) if (!row.ops_location_id || String(row.ops_location_id) === String(row.id)) put(String(row.id), row);
    }
  } catch (e) { console.warn('[reportSites] site clocks failed:', e?.message); }
  return out;
}

/**
 * Everything buildReportScope needs for the signed in site: { userId, locations, readableIds,
 * clocks }. Never throws.
 */
export async function fetchReportScopeData(homeId) {
  const none = { userId: null, locations: [], readableIds: null, clocks: {} };
  if (isMock || !supabase || !homeId || homeId === 'loc-demo') return none;
  try {
    const [{ data: sess }, readableIds, homeRow] = await Promise.all([
      supabase.auth.getSession(),
      fetchReadableSiteIds(),
      supabase.from('locations').select('id, name, org_id, currency').eq('id', homeId).maybeSingle(),
    ]);
    const userId = sess?.session?.user?.id || null;
    const home = homeRow?.data || null;
    if (!home) return { ...none, userId, readableIds };
    let locations = [home];
    if (home.org_id && readableIds && readableIds.length > 1) {
      const { data } = await supabase.from('locations').select('id, name, org_id, currency').eq('org_id', home.org_id).order('name');
      if (Array.isArray(data) && data.length) locations = data;
    }
    const ids = locations.filter((l) => String(l.id) !== String(homeId)).map((l) => String(l.id));
    const clocks = ids.length ? await fetchSiteClocks(ids) : {};
    return { userId, locations, readableIds, clocks };
  } catch (e) {
    console.warn('[reportSites] scope read failed:', e?.message);
    return none;
  }
}

// Asked once a visit: is the day sums function in the database yet (migration 20261005b)?
let _daySumsProbe = null;
/** { available: true } or { available: false, reason }. One tiny call (one site, one day). */
export function probeDaySums(site, day) {
  if (isMock || !supabase || !site?.clockKnown) return Promise.resolve({ available: false, reason: 'not_asked' });
  if (!_daySumsProbe) {
    _daySumsProbe = fetchReportDaySums({ client: supabase, sites: [site], fromDay: day, toDay: day })
      .then((r) => ({ available: !!r.available, reason: r.available ? null : r.reason }))
      .catch(() => ({ available: false, reason: 'error' }))
      // "Not there" is an answer and is kept. "Could not ask" is not: it is asked again.
      .then((r) => { if (!r.available && r.reason !== 'not_installed') _daySumsProbe = null; return r; });
  }
  return _daySumsProbe;
}
