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
import { readAllPages } from './pagedRead.js';
import { mapMenuItemRow, mapCategoryRow, mapTaxRateRow, assembleTaxProfiles } from './rowMapping.js';
import { buildSiteMenu } from './reportSiteMenu.js';

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

// ── another site's menu, rates and stations (step 4, 5 Oct 2026) ─────────────
//
// Product mix, Item sales trend, Menu engineering and Tax read a check line's product,
// category and tax rate from the signed in site's memory. For ANOTHER ticked site those are
// read here, named columns only, in pages through the one report gate, and kept for a few
// minutes so switching between the four reports does not read six menus again.
// The rules for what is read are in src/lib/reportSiteMenu.js.

const SITE_MENU_LIFE_MS = 10 * 60 * 1000;
const _siteMenus = new Map();   // siteId -> { at, promise }

const cols = {
  items: 'id, name, menu_name, kitchen_name, receipt_name, cat, parent_id, master_id, scope, tax_rate_id, tax_profile_id, tax_overrides, archived',
  categories: 'id, label, master_id, scope, tax_profile_id, parent_id, sort_order, accounting_group',
  rates: 'id, name, code, rate, type, applies_to, is_default, active, location_id',
};

/**
 * One site's live products, categories, active tax rates, tax profiles and default profile,
 * as a reportSiteMenu (buildSiteMenu). The menu legs must all read (else { ok: false }); the
 * tax legs are optional: when they fail the site's checks fall back to the tax stored on
 * each check and the report says so (taxLoaded false). Never throws.
 */
export async function fetchSiteMenu(siteId, { force = false } = {}) {
  const id = siteId != null ? String(siteId) : null;
  if (isMock || !supabase || !id || id === 'loc-demo') return { ok: false, menu: null, error: new Error('No site') };
  const hit = _siteMenus.get(id);
  if (!force && hit && Date.now() - hit.at < SITE_MENU_LIFE_MS) return hit.promise;
  const promise = (async () => {
    const from = (t) => supabase.from(t);
    const read = (what, build, keyOf) => readAllPages(what, build, { keyOf }).then((rows) => ({ rows }), (error) => ({ rows: null, error }));
    const [items, cats, rates] = await Promise.all([
      read('products', () => from('menu_items').select(cols.items).eq('location_id', id).eq('archived', false).order('id')),
      read('categories', () => from('menu_categories').select(cols.categories).eq('location_id', id).order('id')),
      read('tax rates', () => from('tax_rates').select(cols.rates).eq('location_id', id).eq('active', true).order('id')),
    ]);
    if (!items.rows || !cats.rows) {
      const error = items.error || cats.error || new Error('menu read failed');
      console.warn('[reportSites] site menu failed:', id, error?.message);
      return { ok: false, menu: null, error };
    }
    let taxProfiles = [], defaultProfileId = null, taxLoaded = !!rates.rows;
    if (taxLoaded) {
      try {
        const [prof, lines, loc] = await Promise.all([
          read('tax profiles', () => from('tax_profiles').select('*').eq('location_id', id).order('id')),
          read('tax profile lines', () => from('tax_profile_lines').select('*').eq('location_id', id).order('id')),
          Promise.resolve(from('locations').select('default_tax_profile_id').eq('id', id).maybeSingle()).catch((e) => ({ error: e })),
        ]);
        if (!prof.rows || !lines.rows || loc?.error) taxLoaded = false;
        else { taxProfiles = assembleTaxProfiles(prof.rows, lines.rows); defaultProfileId = loc?.data?.default_tax_profile_id || null; }
      } catch { taxLoaded = false; }
    }
    const menu = buildSiteMenu({
      id,
      items: items.rows.map(mapMenuItemRow),
      categories: cats.rows.map(mapCategoryRow),
      taxRates: taxLoaded ? rates.rows.map(mapTaxRateRow) : [],
      taxProfiles, defaultProfileId, taxLoaded,
    });
    return { ok: true, menu, error: null };
  })();
  _siteMenus.set(id, { at: Date.now(), promise });
  // A failed read is not kept: the next report asks again.
  promise.then((r) => { if (!r.ok) _siteMenus.delete(id); });
  return promise;
}

/** Forget what was read (tests, or a menu saved in this tab). */
export function forgetSiteMenus() { _siteMenus.clear(); }

/**
 * Each site's own production centres (print_routing.centres), by site id, for the station
 * names of Kitchen performance. A site with no row is left out; a failed read is {}.
 */
export async function fetchSiteCentres(siteIds) {
  const ids = (siteIds || []).map(String).filter((id) => id && id !== 'loc-demo');
  const out = {};
  if (isMock || !supabase || !ids.length) return out;
  try {
    const rows = await readAllPages('production centres', () => supabase.from('print_routing').select('location_id, centres').in('location_id', ids).order('location_id'), { keyOf: (r) => r?.location_id });
    for (const r of rows || []) if (r?.location_id && Array.isArray(r.centres)) out[String(r.location_id)] = r.centres;
  } catch (e) { console.warn('[reportSites] production centres failed:', e?.message); }
  return out;
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
