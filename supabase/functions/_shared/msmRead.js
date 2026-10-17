// supabase/functions/_shared/msmRead.js
//
// MULTI SITE MENU (17 Oct 2026, v5.11.75): reading the central menu, PAGED past the 1,000 row cap
// (both Supabase projects cut every read at 1,000 rows, silently: reference_postgrest_max_rows_cap).
// The first company alone has about 600 products and 3,600 product site rows. Used by the msm-publish
// function (service role) and by the screens (src/lib/msm/msmData.js, as the signed in person,
// where row level security decides what comes back). Pure: the client is passed in; tested with
// a fake that enforces the cap (src/lib/msm/msmRead.test.js).
//
// A failed page is a failed read (rows null), never "no rows".

import { readAllRows } from './venueMenuCore.js';

const strip = (rows, key) => rows.map((r) => { const { [key]: _drop, ...rest } = r; return rest; });

/**
 * The whole central menu: { ok, failed, error, menu, sites, categories, catSites, groups,
 * groupSites, products, productSites, siteGroups }.
 */
export async function readCentral(client, menuId) {
  const out = { ok: false, failed: [], error: null };
  if (!client || !menuId) { out.failed.push('menu'); out.error = new Error('No group menu'); return out; }
  const from = (t) => client.from(t);
  const [menu, sites, cats, catSites, groups, groupSites, products, productSites, siteGroups] = await Promise.all([
    readAllRows(() => from('msm_menus').select('*').eq('id', menuId).order('id')),
    readAllRows(() => from('msm_menu_sites').select('*').eq('menu_id', menuId).order('location_id')),
    readAllRows(() => from('msm_categories').select('*').eq('menu_id', menuId).order('sort_order').order('id')),
    readAllRows(() => from('msm_category_sites').select('*, msm_categories!inner(menu_id)').eq('msm_categories.menu_id', menuId).order('category_id').order('location_id')),
    readAllRows(() => from('msm_modifier_groups').select('*').eq('menu_id', menuId).order('sort_order').order('id')),
    readAllRows(() => from('msm_modifier_group_sites').select('*, msm_modifier_groups!inner(menu_id)').eq('msm_modifier_groups.menu_id', menuId).order('group_id').order('location_id')),
    readAllRows(() => from('msm_products').select('*').eq('menu_id', menuId).order('sort_order').order('id')),
    readAllRows(() => from('msm_product_sites').select('*, msm_products!inner(menu_id)').eq('msm_products.menu_id', menuId).order('product_id').order('location_id')),
    readAllRows(() => from('msm_site_groups').select('*').eq('menu_id', menuId).order('name').order('id')),
  ]);
  const legs = { menu, sites, categories: cats, 'category sites': catSites, 'modifier groups': groups, 'modifier group sites': groupSites, products, 'product sites': productSites, 'site groups': siteGroups };
  for (const [name, r] of Object.entries(legs)) if (!r.rows) { out.failed.push(name); out.error = out.error || r.error; }
  if (menu.rows && !menu.rows.length) { out.failed.push('menu'); out.error = out.error || new Error('No such group menu'); }
  out.menu = menu.rows ? menu.rows[0] || null : null;
  out.sites = sites.rows;
  out.categories = cats.rows;
  out.catSites = catSites.rows ? strip(catSites.rows, 'msm_categories') : null;
  out.groups = groups.rows;
  out.groupSites = groupSites.rows ? strip(groupSites.rows, 'msm_modifier_groups') : null;
  out.products = products.rows;
  out.productSites = productSites.rows ? strip(productSites.rows, 'msm_products') : null;
  out.siteGroups = siteGroups.rows;
  out.ok = out.failed.length === 0;
  return out;
}

/** A set's staged changes, oldest first. { rows, error }. */
export function readChanges(client, changeSetId) {
  return readAllRows(() => client.from('msm_changes').select('*').eq('change_set_id', changeSetId).order('created_at').order('id'));
}

/** The company's live group menu row (or null), and whether the tables exist. */
export async function readLiveMenu(client, orgId) {
  try {
    const res = await client.from('msm_menus').select('*').eq('org_id', orgId).eq('status', 'live').limit(1).maybeSingle();
    return { menu: res.data || null, error: res.error || null };
  } catch (e) { return { menu: null, error: e }; }
}

/** Versions newest first, with their sites (paged). */
export async function readHistory(client, menuId, { limit = 50 } = {}) {
  const v = await client.from('msm_versions').select('*').eq('menu_id', menuId).order('created_at', { ascending: false }).limit(Math.min(limit, 200));
  if (v.error) return { rows: null, error: v.error };
  const ids = (v.data || []).map((x) => x.id);
  if (!ids.length) return { rows: [], error: null };
  const s = await readAllRows(() => client.from('msm_version_sites').select('version_id,location_id,status,due_at,started_at,finished_at,attempts,push_id,error,counts,precheck_at,precheck_ok,precheck_words,late_at').in('version_id', ids).order('version_id').order('location_id'));
  if (!s.rows) return { rows: null, error: s.error };
  const by = new Map();
  for (const r of s.rows) { if (!by.has(r.version_id)) by.set(r.version_id, []); by.get(r.version_id).push(r); }
  return { rows: (v.data || []).map((x) => ({ ...x, sites: by.get(x.id) || [] })), error: null };
}
