// src/lib/venueMenuRead.js: ONE fresh read of a venue's menu, used by the Back Office load
// (BackOfficeApp.loadLocationData, on sign in and every time the tab comes back to the front)
// and by Push to POS.
//
// 27 Sep 2026, Peter: "I archived choc babychino but its still on the menu board". Push to POS
// built the tills' snapshot from the tab's MEMORY (a render time copy of the menu, 432 products
// on another venue's tax rate and one archived product the database had live again) and then
// wrote that memory over the database. Now the push:
//   1. waits for this tab's own saves to land,
//   2. reads the menu FRESH from the database (this module),
//   3. offers to save, insert only, anything on screen the database never received,
//   4. sends the tills exactly what the database holds, and shows the same on screen.
// It never writes a menu row as a side effect. The tables have worked this way since v5.9.4.
//
// Pure: the Supabase client is passed in (node:test drives it with a fake).

import {
  mapMenuItemRow, mapCategoryRow, mapMenuRow, mapModifierGroupRow, mapTaxRateRow,
  assembleTaxProfiles,
} from './rowMapping.js';

export const PAGE = 1000;   // the Data API's row cap per request; bigger menus are paged

// Every row of a query, page by page. `make()` builds a fresh query each time (a Supabase
// query can only run once). Returns { rows, error }: rows null when any page failed.
export async function readAllRows(make, { page = PAGE, max = 50 } = {}) {
  const rows = [];
  for (let i = 0; i < max; i++) {
    let res;
    try { res = await make().range(i * page, i * page + page - 1); }
    catch (e) { return { rows: null, error: e }; }
    if (res?.error) return { rows: null, error: res.error };
    const data = Array.isArray(res?.data) ? res.data : null;
    if (!data) return { rows: null, error: new Error('no rows came back') };
    rows.push(...data);
    if (data.length < page) return { rows, error: null };
  }
  return { rows: null, error: new Error('too many rows to read') };
}

/**
 * The venue's menu as the database holds it now, through the one set of mappers.
 * Resolves:
 *   ok                 true when menus, categories, items, modifier groups and tax rates all
 *                      read (a push sends nothing unless this is true)
 *   failed             the names of the reads that failed
 *   menus, menuCategories, menuItems (live only), modifierGroupDefs, taxRates
 *   taxProfiles        null when the profile tables could not be read (not sent, not applied)
 *   venueDefaultTaxProfileId  undefined when the venue row could not be read
 *   itemIds            EVERY menu_items id at the venue, archived included (so a product
 *                      archived elsewhere is never mistaken for one this tab never saved)
 */
export async function readVenueMenu(client, locationId) {
  const out = {
    ok: false, failed: [], error: null,
    menus: null, menuCategories: null, menuItems: null, modifierGroupDefs: null, taxRates: null,
    taxProfiles: null, venueDefaultTaxProfileId: undefined, itemIds: null,
  };
  if (!client) { out.failed.push('database'); out.error = new Error('No database'); return out; }
  if (!locationId || locationId === 'loc-demo') { out.failed.push('location'); out.error = new Error('No location'); return out; }
  const from = (t) => client.from(t);
  const [menus, cats, items, ids, groups, rates] = await Promise.all([
    readAllRows(() => from('menus').select('*').eq('location_id', locationId).order('sort_order').order('id')),
    // v5.5.950: deterministic tie break, or equal sort orders shuffle between reads.
    readAllRows(() => from('menu_categories').select('*').eq('location_id', locationId).order('sort_order').order('label').order('id')),
    readAllRows(() => from('menu_items').select('*').eq('location_id', locationId).eq('archived', false).order('sort_order').order('id')),
    readAllRows(() => from('menu_items').select('id').eq('location_id', locationId).order('id')),
    readAllRows(() => from('modifier_groups').select('*').eq('location_id', locationId).order('sort_order').order('id')),
    readAllRows(() => from('tax_rates').select('*').eq('location_id', locationId).eq('active', true).order('rate', { ascending: false }).order('id')),
  ]);
  const legs = { menus, categories: cats, items, 'item ids': ids, 'modifier groups': groups, 'tax rates': rates };
  for (const [name, r] of Object.entries(legs)) if (!r.rows) { out.failed.push(name); out.error = out.error || r.error; }
  if (menus.rows) out.menus = menus.rows.map(mapMenuRow);
  if (cats.rows) out.menuCategories = cats.rows.map(mapCategoryRow);
  if (items.rows) out.menuItems = items.rows.map(mapMenuItemRow);
  if (ids.rows) out.itemIds = new Set(ids.rows.map((r) => r.id));
  if (groups.rows) out.modifierGroupDefs = groups.rows.map(mapModifierGroupRow);
  if (rates.rows) out.taxRates = rates.rows.map(mapTaxRateRow);
  // v5.7.33: tax profiles and the venue default. Optional: a push that cannot read them leaves
  // them out (a till keeps its own; absent is a no-op there), it never sends a guess.
  try {
    const [prof, lines, loc] = await Promise.all([
      readAllRows(() => from('tax_profiles').select('*').eq('location_id', locationId).order('sort_order').order('id')),
      readAllRows(() => from('tax_profile_lines').select('*').eq('location_id', locationId).order('sort_order').order('id')),
      Promise.resolve(from('locations').select('default_tax_profile_id').eq('id', locationId).maybeSingle()).catch((e) => ({ error: e })),
    ]);
    if (prof.rows && lines.rows) out.taxProfiles = assembleTaxProfiles(prof.rows, lines.rows);
    if (loc && !loc.error && loc.data) out.venueDefaultTaxProfileId = loc.data.default_tax_profile_id || null;
  } catch { /* optional */ }
  out.ok = out.failed.length === 0;
  return out;
}

/**
 * A fresh read laid over the rows a tab holds. The database wins, except:
 *   keep          rows this tab must keep its own copy of: a save still on its way (the
 *                 person's edit must not flicker back, and its compare and set token must
 *                 stay the one the save was made against), or a save that landed AFTER the
 *                 read began (the read cannot have seen it). The caller works this out from
 *                 its write clock, never from times: no device clock is compared.
 *   keepArchived  archived rows the Archived view loaded stay (the read has live rows only)
 * Rows the read does not have are dropped unless kept or archived.
 */
export function mergeReadRows(current, read, { keep = new Set(), keepArchived = false } = {}) {
  const have = new Map((current || []).map((r) => [r?.id, r]));
  const seen = new Set();
  const out = [];
  for (const r of read || []) {
    seen.add(r.id);
    const local = have.get(r.id);
    out.push(local && keep.has(r.id) ? local : r);
  }
  for (const l of current || []) {
    if (!l || seen.has(l.id)) continue;
    if (keep.has(l.id) || (keepArchived && l.archived)) out.push(l);
  }
  return out;
}

/**
 * The store patch for a fresh read (the Back Office load, and Push to POS once it has sent).
 * Only the parts that read are applied; a part that failed leaves the store as it was.
 *   keep  { items, categories, menus, groups }: Sets of ids whose local copy stays (above)
 * Tax rates take the read AS IT IS, an empty list included. 27 Sep 2026: Leeds had no rates of
 * its own, every loader skipped the empty read and kept Train Station's (from the last push),
 * and "Apply to all" wrote Train Station's rate ids into 430 Leeds products.
 */
export function menuPatchFromRead(state, read, { keep = {}, locationId = null } = {}) {
  const patch = {};
  if (!read) return patch;
  const k = (name) => (keep && keep[name]) || new Set();
  if (Array.isArray(read.menus)) patch.menus = mergeReadRows(state?.menus, read.menus, { keep: k('menus') });
  if (Array.isArray(read.menuCategories)) patch.menuCategories = mergeReadRows(state?.menuCategories, read.menuCategories, { keep: k('categories') });
  if (Array.isArray(read.menuItems)) patch.menuItems = mergeReadRows(state?.menuItems, read.menuItems, { keep: k('items'), keepArchived: true });
  if (Array.isArray(read.modifierGroupDefs)) patch.modifierGroupDefs = mergeReadRows(state?.modifierGroupDefs, read.modifierGroupDefs, { keep: k('groups') });
  if (Array.isArray(read.taxRates)) patch.taxRates = read.taxRates;
  if (Array.isArray(read.taxProfiles)) patch.taxProfiles = read.taxProfiles;
  if (read.venueDefaultTaxProfileId !== undefined) patch.venueDefaultTaxProfileId = read.venueDefaultTaxProfileId;
  // The venue this store's menu was last read for. A push snapshot applied after this (the
  // boot fetch of the last push) must not put an older menu back over it (store
  // applyConfigUpdate, Back Office only).
  if (locationId && read.ok) patch.menuReadLocationId = locationId;
  return patch;
}

/**
 * What is on this tab's screen but NOT in the database: creations whose first save never
 * landed. Push to POS lists them and saves them insert only, or stops; it never sends them to
 * the tills silently. An archived product is not listed (nothing to sell), and a product the
 * database has archived is in `itemIds`, so it is never mistaken for an unsaved one.
 */
export function unsavedMenuRows(store, read, locationId = null) {
  const menuIds = new Set((read.menus || []).map((m) => m.id));
  const catIds = new Set((read.menuCategories || []).map((c) => c.id));
  const itemIds = read.itemIds || new Set((read.menuItems || []).map((i) => i.id));
  // A row that says it belongs to ANOTHER venue (left in memory from an old push) is never
  // offered: saving it here would copy another venue's product into this one.
  const ours = (r) => {
    const loc = r?.location_id ?? r?.locationId ?? null;
    return !locationId || !loc || loc === locationId;
  };
  const menus = (store.menus || []).filter((m) => m?.id && ours(m) && !menuIds.has(m.id));
  const menuCategories = (store.menuCategories || []).filter((c) => c?.id && ours(c) && !catIds.has(c.id));
  const menuItems = (store.menuItems || []).filter((i) => i?.id && ours(i) && !i.archived && !itemIds.has(i.id) && !String(i.id).startsWith('demo-'));
  return { menus, menuCategories, menuItems, total: menus.length + menuCategories.length + menuItems.length };
}

// Parents before children, so a sub category's parent row is there first.
export function parentsFirst(cats) {
  const byId = new Map((cats || []).map((c) => [c.id, c]));
  const out = [];
  const done = new Set();
  const visit = (c, depth = 0) => {
    if (!c || done.has(c.id) || depth > 20) return;
    const pid = c.parentId ?? c.parent_id ?? null;
    if (pid && byId.has(pid)) visit(byId.get(pid), depth + 1);
    done.add(c.id);
    out.push(c);
  };
  for (const c of cats || []) visit(c);
  return out;
}

/** Plain words for the confirm: what was never saved, a few names each. */
export function unsavedWords(unsaved) {
  const names = (rows, pick) => {
    const n = rows.map(pick).filter(Boolean);
    return n.slice(0, 6).join(', ') + (n.length > 6 ? ` and ${n.length - 6} more` : '');
  };
  const parts = [];
  if (unsaved.menuItems.length) parts.push(`${unsaved.menuItems.length} product${unsaved.menuItems.length === 1 ? '' : 's'} (${names(unsaved.menuItems, (i) => i.menuName || i.name)})`);
  if (unsaved.menuCategories.length) parts.push(`${unsaved.menuCategories.length} categor${unsaved.menuCategories.length === 1 ? 'y' : 'ies'} (${names(unsaved.menuCategories, (c) => c.label || c.name)})`);
  if (unsaved.menus.length) parts.push(`${unsaved.menus.length} menu${unsaved.menus.length === 1 ? '' : 's'} (${names(unsaved.menus, (m) => m.name)})`);
  return `These are on this screen but NOT in the database (never saved, or deleted in another window):\n\n${parts.join('\n')}\n\nOK saves them now (new rows only, nothing already saved is changed) and then pushes.\nCancel stops the push: nothing is sent. Reload the page to see the menu as it is saved.`;
}

/**
 * The menu part of a Push to POS snapshot, from a fresh read ONLY. taxProfiles and the venue
 * default ride only when they were read (absent is a no-op on a till).
 */
export function menuSnapshotFromRead(read) {
  return {
    menus: read.menus || [],
    menuItems: read.menuItems || [],
    menuCategories: read.menuCategories || [],
    modifierGroupDefs: read.modifierGroupDefs || [],
    taxRates: read.taxRates || [],
    ...(Array.isArray(read.taxProfiles) ? { taxProfiles: read.taxProfiles } : {}),
    ...(read.venueDefaultTaxProfileId !== undefined ? { venueDefaultTaxProfileId: read.venueDefaultTaxProfileId } : {}),
  };
}
