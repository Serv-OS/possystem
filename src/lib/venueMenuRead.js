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
//   3. offers to save, insert only, anything made on this screen whose first save failed,
//   4. sends the tills exactly what the database holds (plus the product fields that have no
//      column, from this screen: withItemExtras), and shows the same on screen.
// It never writes a menu row as a side effect. The tables have worked this way since v5.9.4.
//
// Pure: the Supabase client is passed in (node:test drives it with a fake).

import {
  mapMenuItemRow, mapCategoryRow, mapMenuRow, mapModifierGroupRow, mapTaxRateRow,
  assembleTaxProfiles, srvAtOf,
} from './rowMapping.js';
import { ITEM_EXTRA_KEYS } from './menuItemWrite.js';
import { ownVenueRates, taggedVenueRows } from './venueTaxRates.js';

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
    // 27 Sep 2026 (tax root cause port): the venue this read is for, so the snapshot built from
    // it carries only that venue's rates (menuSnapshotFromRead).
    locationId: locationId || null,
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

/** The venue a row says it belongs to, or null when it does not say. */
export const rowVenue = (r) => r?.location_id ?? r?.locationId ?? null;

/**
 * The product fields that have no database column (lib/menuItemWrite.js ITEM_EXTRA_KEYS:
 * variantLabel, the pizza fields, ...) carried onto `rows` from the row with the same id in
 * `from` (27 Sep 2026). A key is copied only where the row lacks it (undefined), so nothing a
 * row already holds is ever replaced. Returns `rows` itself when nothing was copied.
 * Before this branch these fields reached the tills because the push snapshot was built from
 * the Back Office's rows; now the snapshot is the database read, which has none of them.
 */
export function withItemExtras(rows, from, keys = ITEM_EXTRA_KEYS) {
  if (!Array.isArray(rows) || !Array.isArray(from) || !from.length) return rows;
  const byId = new Map(from.filter((r) => r && r.id != null).map((r) => [r.id, r]));
  let changed = false;
  const out = rows.map((r) => {
    const src = r ? byId.get(r.id) : null;
    if (!src || src === r) return r;
    let next = r;
    for (const k of keys) {
      if (src[k] === undefined || next[k] !== undefined) continue;
      if (next === r) next = { ...r };
      next[k] = src[k];
    }
    if (next !== r) changed = true;
    return next;
  });
  return changed ? out : rows;
}

/**
 * A fresh read laid over the rows a tab holds. The database wins, except:
 *   keep          rows this tab must keep its own copy of: a save still on its way (the
 *                 person's edit must not flicker back, and its compare and set token must
 *                 stay the one the save was made against), or a save that landed AFTER the
 *                 read began (the read cannot have seen it). The caller works this out from
 *                 its write clock, never from times: no device clock is compared.
 *   keepArchived  archived rows the Archived view loaded stay (the read has live rows only)
 *   extras        keys with no database column (products: ITEM_EXTRA_KEYS) that a read row
 *                 takes from the screen's row with the same id (withItemExtras): the read
 *                 cannot have them, and dropping them lost them from the next Push to POS
 *   locationId    the venue the read is for. 27 Sep 2026 (review round 3): a row kept or
 *                 archived that says it belongs to ANOTHER venue is dropped, so a save that
 *                 was on its way when the person switched venue never follows them into the
 *                 next one. Rows created in this tab carry their venue from birth (store
 *                 addMenuItem, addCategory, addMenu, addModifierGroupDef).
 * Rows the read does not have are dropped unless kept or archived.
 */
export function mergeReadRows(current, read, { keep = new Set(), keepArchived = false, locationId = null, extras = null } = {}) {
  const here = (r) => !locationId || !rowVenue(r) || rowVenue(r) === locationId;
  const have = new Map((current || []).map((r) => [r?.id, r]));
  const seen = new Set();
  const out = [];
  for (const r of read || []) {
    seen.add(r.id);
    const local = have.get(r.id);
    if (local && keep.has(r.id) && here(local)) out.push(local);
    else out.push(local && extras && here(local) ? withItemExtras([r], [local], extras)[0] : r);
  }
  for (const l of current || []) {
    if (!l || seen.has(l.id) || !here(l)) continue;
    if (keep.has(l.id) || (keepArchived && l.archived)) out.push(l);
  }
  return out;
}

/**
 * Is an EMPTY product read suspect? 27 Sep 2026 (review round 3). A read that row level security
 * narrows answers with no rows and NO error, and laying that over the screen would wipe the
 * menu (and a push would send the tills no products). TaxManager refuses an empty tax read the
 * same way. Suspect when all of these hold:
 *   * the read of live products came back empty, and so did the read of every product id
 *     (archived included: a venue whose products were all archived elsewhere is not suspect),
 *   * this screen holds at least one product the database was seen to have at THIS venue
 *     (it carries this venue and a database time, srvAt).
 * Not suspect: a new venue with no products (nothing of that venue on screen), a product
 * created here whose first save failed (no database time), and a product in `keep` (its save
 * is on its way, or landed after the read began, so the read cannot have seen it).
 */
export function emptyItemsReadSuspect(state, read, locationId, { keep = null } = {}) {
  if (!locationId || !read || !Array.isArray(read.menuItems) || read.menuItems.length) return false;
  if (read.itemIds instanceof Set && read.itemIds.size) return false;
  return (state?.menuItems || []).some((r) => r && rowVenue(r) === locationId && srvAtOf(r) && !(keep && keep.has(r.id)));
}

/** How many products of `locationId` this screen holds (for the words of a suspect read). */
export const venueItemCount = (state, locationId) =>
  (state?.menuItems || []).filter((r) => r && rowVenue(r) === locationId).length;

/** The words when an empty product read is not applied (the Back Office load). */
export const suspectReadWords = (n) =>
  `The database sent back NO products for this venue, but this screen has ${n}. That usually means the read was blocked (sign in or access), so the menu on screen was kept. Check you are signed in, then reload the page.`;

/**
 * The store patch for a fresh read (the Back Office load, and Push to POS once it has sent).
 * Only the parts that read are applied; a part that failed leaves the store as it was.
 *   keep         { items, categories, menus, groups }: Sets of ids whose local copy stays (above)
 *   locationId   the venue read: rows kept from another venue are dropped (mergeReadRows)
 * Tax rates take the read AS IT IS, an empty list included. 27 Sep 2026: Leeds had no rates of
 * its own, every loader skipped the empty read and kept Train Station's (from the last push),
 * and "Apply to all" wrote Train Station's rate ids into 430 Leeds products.
 * A suspect empty product read (emptyItemsReadSuspect) is not applied AT ALL: a read that was
 * narrowed shows no categories or menus either, so the whole menu on screen stays as it was
 * (and Push to POS stops before it sends anything).
 */
export function menuPatchFromRead(state, read, { keep = {}, locationId = null } = {}) {
  const patch = {};
  if (!read) return patch;
  const k = (name) => (keep && keep[name]) || new Set();
  if (emptyItemsReadSuspect(state, read, locationId, { keep: k('items') })) return patch;
  if (Array.isArray(read.menus)) patch.menus = mergeReadRows(state?.menus, read.menus, { keep: k('menus'), locationId });
  if (Array.isArray(read.menuCategories)) patch.menuCategories = mergeReadRows(state?.menuCategories, read.menuCategories, { keep: k('categories'), locationId });
  if (Array.isArray(read.menuItems)) patch.menuItems = mergeReadRows(state?.menuItems, read.menuItems, { keep: k('items'), keepArchived: true, locationId, extras: ITEM_EXTRA_KEYS });
  if (Array.isArray(read.modifierGroupDefs)) patch.modifierGroupDefs = mergeReadRows(state?.modifierGroupDefs, read.modifierGroupDefs, { keep: k('groups'), locationId });
  if (Array.isArray(read.taxRates)) patch.taxRates = read.taxRates;
  else if (locationId && Array.isArray(state?.taxRates)) {
    // 27 Sep 2026 (tax root cause port): the tax read failed. This venue's rates stay; another
    // venue's never do (lib/venueTaxRates.js ratesAfterRead: a failed read keeps only this venue's).
    const own = ownVenueRates(state.taxRates, locationId);
    if (own.length !== state.taxRates.length) patch.taxRates = own;
  }
  if (Array.isArray(read.taxProfiles)) patch.taxProfiles = read.taxProfiles;
  if (read.venueDefaultTaxProfileId !== undefined) patch.venueDefaultTaxProfileId = read.venueDefaultTaxProfileId;
  // The venue this store's menu was last read for. A push snapshot applied after this (the
  // boot fetch of the last push) must not put an older menu back over it (store
  // applyConfigUpdate, Back Office only).
  if (locationId && read.ok) patch.menuReadLocationId = locationId;
  return patch;
}

/**
 * The ids of one kind of row a read found in the database ('items' | 'categories' | 'menus' |
 * 'groups'), or null when that part of the read failed. Products are every id at the venue,
 * archived included (read.itemIds).
 */
export function readIdsOf(read, kind) {
  if (!read) return null;
  if (kind === 'items') {
    if (read.itemIds instanceof Set) return read.itemIds;
    return Array.isArray(read.menuItems) ? new Set(read.menuItems.map((i) => i?.id)) : null;
  }
  const list = { categories: read.menuCategories, menus: read.menus, groups: read.modifierGroupDefs }[kind];
  return Array.isArray(list) ? new Set(list.map((r) => r?.id)) : null;
}

/**
 * What is on this tab's screen but NOT in the database because its FIRST save failed in this
 * window. Push to POS lists them and saves them insert only, or stops; it never sends them to
 * the tills silently. An archived product is not listed (nothing to sell), and a product the
 * database has archived is in `itemIds`, so it is never mistaken for an unsaved one.
 *   locationId   the venue being pushed. Only rows that SAY they belong to it are offered
 *                (27 Sep 2026, review round 3): a row of another venue, or one that does not
 *                say (left in memory from an old push), could copy another venue's product
 *                into this one. Rows created in this tab carry their venue from birth.
 *   failed       { menus, categories, items, groups }: Sets (or arrays) of the ids made in this
 *                window whose FIRST save failed (store failedCreateIds, from the menu writers
 *                and the modifier group saves). 27 Sep 2026: only those are offered, for every
 *                kind, as modifier groups already were. A row that is on screen but not in the
 *                read for any other reason was deleted in another window, and must not come back.
 */
export function unsavedMenuRows(store, read, locationId = null, { failed = null } = {}) {
  const idsIn = (kind) => readIdsOf(read, kind) || new Set();
  const failedOf = (kind) => {
    const v = failed ? failed[kind] : null;
    return v instanceof Set ? v : new Set(v || []);
  };
  const menuIds = idsIn('menus');
  const catIds = idsIn('categories');
  const itemIds = idsIn('items');
  const groupIds = idsIn('groups');
  const fMenus = failedOf('menus');
  const fCats = failedOf('categories');
  const fItems = failedOf('items');
  const fGroups = failedOf('groups');
  const ours = (r) => !locationId || rowVenue(r) === locationId;
  const menus = (store.menus || []).filter((m) => m?.id && fMenus.has(m.id) && ours(m) && !menuIds.has(m.id));
  const menuCategories = (store.menuCategories || []).filter((c) => c?.id && fCats.has(c.id) && ours(c) && !catIds.has(c.id));
  const menuItems = (store.menuItems || []).filter((i) => i?.id && fItems.has(i.id) && ours(i) && !i.archived && !itemIds.has(i.id) && !String(i.id).startsWith('demo-'));
  const modifierGroupDefs = (store.modifierGroupDefs || []).filter((g) => g?.id && fGroups.has(g.id) && ours(g) && !groupIds.has(g.id));
  return {
    menus, menuCategories, menuItems, modifierGroupDefs,
    total: menus.length + menuCategories.length + menuItems.length + modifierGroupDefs.length,
  };
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
  const groups = unsaved.modifierGroupDefs || [];
  if (groups.length) parts.push(`${groups.length} modifier group${groups.length === 1 ? '' : 's'} (${names(groups, (g) => g.name)})`);
  return `These were made on this screen but their first save FAILED, so they are NOT in the database:\n\n${parts.join('\n')}\n\nOK saves them now (new rows only, nothing already saved is changed) and then pushes.\nCancel stops the push: nothing is sent. Reload the page to see the menu as it is saved.`;
}

/**
 * The menu part of a Push to POS snapshot, from a fresh read ONLY. taxProfiles and the venue
 * default ride only when they were read (absent is a no-op on a till).
 *   extrasFrom   this window's products (27 Sep 2026): the fields with no database column
 *                (ITEM_EXTRA_KEYS: variantLabel, the pizza fields, ...) are copied from the row
 *                with the same id, as the snapshot built from the store always carried them.
 *                Every column still comes from the read.
 * 27 Sep 2026 (tax root cause port): the rates are the read venue's own and nothing else
 * (read.locationId, lib/venueTaxRates.js taggedVenueRows). Every Leeds push from 26 Sep 06:47
 * carried Train Station's rates because the snapshot copied whatever the page held.
 */
export function menuSnapshotFromRead(read, { extrasFrom = null } = {}) {
  return {
    menus: read.menus || [],
    menuItems: withItemExtras(read.menuItems || [], extrasFrom),
    menuCategories: read.menuCategories || [],
    modifierGroupDefs: read.modifierGroupDefs || [],
    taxRates: read.locationId ? taggedVenueRows(read.taxRates || [], read.locationId) : (read.taxRates || []),
    ...(Array.isArray(read.taxProfiles) ? { taxProfiles: read.taxProfiles } : {}),
    ...(read.venueDefaultTaxProfileId !== undefined ? { venueDefaultTaxProfileId: read.venueDefaultTaxProfileId } : {}),
  };
}
