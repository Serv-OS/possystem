// supabase/functions/_shared/msmMenus.js
//
// MULTI SITE MENU: SEVERAL MENUS IN ONE GROUP MENU (5.12.116).
//
// Peter, 26 Nov 2026 (Mozz): "each site has multiple menus, they have online, instore, items
// that are not available for take away only dine in, catering menus all with different products
// ... we cant manage this in multi site menus". And on how: "a different menu seems better. I
// like the different menus but need to be able to manage centrally in multi site".
//
// THE MODEL, the venue's own, one level up
//   A venue already holds several menus. A CATEGORY is on a menu (its home menu, menu_id, or a
//   row in menu_category_links), and a product is on a menu because one of its categories is
//   (lib/menuMembership.js). A POS, a kiosk, the online page and catering are each pointed at one
//   menu in that site's Back Office. Nothing about that changes.
//   The group menu gets the same shape:
//     * msm_menus.extra_menus     the group's OTHER menus, beside its first one ("Main"):
//                                 [{ id, name, archived?, sites?: { locationId: venueMenuId | false } }]
//     * msm_categories.menu_keys  which of the group's menus a category is on: 'main' and, or, an
//                                 extra menu's id. null = the main menu only (every category made
//                                 before this, so nothing changes for anyone until a box is ticked).
//   ONE PRODUCT LIST underneath: a product is on a menu through its category, or one of its "Also
//   in" categories (5.12.110). There is no second copy of anything.
//
// AT A SITE
//   Each extra menu is one of that site's own menus:
//     * the one head office matched it to (sites[locationId], by name when the menu is added),
//     * else the one publish made for it there (a fixed id, extraVenueMenuId),
//     * else publish makes it, the first time a category needs it. Never the default menu.
//     * sites[locationId] === false: this site does not have this menu. Nothing is written there.
//   The site's other menus, and which menu a POS or page uses, stay the site's own.
//
// PURE: msmModel only, so node --test, the screens and the edge function share it.

import { hex12, suffixOf, normName } from './msmModel.js';

const listOf = (v) => (Array.isArray(v) ? v : []);
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** The key of the group menu's first menu (the one msm_menu_sites.venue_menu_id points at). */
export const MAIN_MENU = 'main';
export const MAIN_MENU_WORDS = 'Main';
/** How many extra menus a group menu can hold (the database refuses more). */
export const MAX_EXTRA_MENUS = 8;
export const EXTRA_MENU_NAME_MAX = 60;

/** Every extra menu of a group menu, removed ones too, as clean rows. */
export function allExtraMenus(menu) {
  const seen = new Set();
  const out = [];
  for (const m of listOf(menu && menu.extra_menus)) {
    if (!isObj(m) || typeof m.id !== 'string' || !m.id || m.id === MAIN_MENU || seen.has(m.id)) continue;
    seen.add(m.id);
    const name = String(m.name ?? '').trim().slice(0, EXTRA_MENU_NAME_MAX) || 'Menu';
    const sites = {};
    if (isObj(m.sites)) for (const [loc, v] of Object.entries(m.sites)) if (v === false || (typeof v === 'string' && v)) sites[loc] = v;
    out.push({ id: m.id, name, archived: m.archived === true, sites });
  }
  return out;
}

/** The extra menus in use (not removed). */
export const extraMenus = (menu) => allExtraMenus(menu).filter((m) => !m.archived);

/** Does this group menu have more than its one menu? */
export const hasExtraMenus = (menu) => extraMenus(menu).length > 0;

/** Every menu of the group menu, the main one first: [{ key, name, main }]. */
export function groupMenus(menu) {
  return [{ key: MAIN_MENU, name: MAIN_MENU_WORDS, main: true }, ...extraMenus(menu).map((m) => ({ key: m.id, name: m.name, main: false }))];
}

/** The top category of a category (a sub category is on the menus its top category is on). */
export function rootCategory(category, catById) {
  let c = category;
  const seen = new Set();
  while (c && c.parent_id && !seen.has(c.id) && seen.size < 25) {
    seen.add(c.id);
    const p = catById && typeof catById.get === 'function' ? catById.get(c.parent_id) : listOf(catById).find((x) => x && x.id === c.parent_id);
    if (!p) break;
    c = p;
  }
  return c || null;
}

/**
 * The menus a category is on: its top category's menu_keys, known menus only, main first.
 * Nothing saved (null), or a list with nothing the group menu still has: the main menu only.
 */
export function menuKeysOf(category, catById, menu) {
  const root = rootCategory(category, catById);
  const raw = root && Array.isArray(root.menu_keys) ? root.menu_keys : null;
  if (!raw) return [MAIN_MENU];
  const live = new Set(extraMenus(menu).map((m) => m.id));
  const keys = [];
  if (raw.includes(MAIN_MENU)) keys.push(MAIN_MENU);
  for (const m of extraMenus(menu)) if (raw.includes(m.id) && live.has(m.id)) keys.push(m.id);
  return keys.length ? keys : [MAIN_MENU];
}

/** What to save for a category's menus: null for "main only" (the same as never set). */
export function menuKeysValue(keys, menu) {
  const live = new Set(extraMenus(menu).map((m) => m.id));
  const got = new Set(listOf(keys));
  const out = [];
  if (got.has(MAIN_MENU)) out.push(MAIN_MENU);
  for (const m of extraMenus(menu)) if (got.has(m.id) && live.has(m.id)) out.push(m.id);
  if (!out.length || (out.length === 1 && out[0] === MAIN_MENU)) return null;
  return out;
}

/** A category's menus with one ticked or unticked. It always stays on at least one menu. */
export function toggleMenuKey(category, catById, menu, key, on) {
  const now = new Set(menuKeysOf(category, catById, menu));
  if (on) now.add(key); else now.delete(key);
  if (!now.size) return { ok: false, words: 'A category is on at least one menu. To take it off every menu, remove the category.', value: menuKeysValue(menuKeysOf(category, catById, menu), menu) };
  return { ok: true, words: '', value: menuKeysValue([...now], menu) };
}

/** "Main and Catering", for a line about a category. */
export function menuKeysWords(keys, menu) {
  const names = groupMenus(menu).filter((m) => listOf(keys).includes(m.key)).map((m) => m.name);
  if (!names.length) return MAIN_MENU_WORDS;
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** The menus a product is on, through its category and its "Also in" categories: [keys]. */
export function productMenuKeys(product, catById, menu) {
  const ids = [product && product.category_id, ...listOf(product && product.extra_category_ids)].filter(Boolean);
  const got = new Set();
  for (const id of ids) {
    const c = catById && typeof catById.get === 'function' ? catById.get(id) : listOf(catById).find((x) => x && x.id === id);
    if (!c || c.archived) continue;
    for (const k of menuKeysOf(c, catById, menu)) got.add(k);
  }
  return groupMenus(menu).map((m) => m.key).filter((k) => got.has(k));
}

// ── At a site ───────────────────────────────────────────────────────────────

/** The id publish gives the menu it makes for an extra menu at a site (and the long one if taken). */
export const extraVenueMenuId = (extraId, locationId) => `menu-msm-${hex12(extraId)}_${suffixOf(locationId)}`;
export const longExtraVenueMenuId = (extraId, locationId) => `menu-msm-${String(extraId || '').replace(/-/g, '').toLowerCase()}_${suffixOf(locationId)}`;

/**
 * Where an extra menu lives at a site.
 *   extra       one of allExtraMenus(menu)
 *   venueMenus  that site's own menus rows (or a Map by id)
 * Returns { off, id, how }: off = this site does not have the menu; id = the site's menu it is
 * (null when publish has still to make it); how = 'matched' | 'made' | 'new'.
 */
export function extraMenuAt(extra, locationId, venueMenus) {
  const has = (id) => (venueMenus && typeof venueMenus.has === 'function' ? venueMenus.has(id) : listOf(venueMenus).some((m) => m && m.id === id));
  const said = extra && extra.sites ? extra.sites[locationId] : undefined;
  if (said === false) return { off: true, id: null, how: 'off' };
  if (typeof said === 'string' && has(said)) return { off: false, id: said, how: 'matched' };
  for (const id of [extraVenueMenuId(extra && extra.id, locationId), longExtraVenueMenuId(extra && extra.id, locationId)]) {
    if (has(id)) return { off: false, id, how: 'made' };
  }
  return { off: false, id: null, how: 'new' };
}

/**
 * A site's own menu with the same name as a new group menu (so "Catering" takes the Catering menu
 * Sandy already has, and never makes a second one beside it). Never the menu the group menu
 * already writes into, nor one another extra menu took.
 *   venueMenus  [{ id, location_id, name, is_active }] for every site
 *   taken       venue menu ids already in use by the group menu
 * Returns { locationId: venueMenuId } for the sites that have one.
 */
export function matchSiteMenus(name, venueMenus, taken = []) {
  const want = normName(name);
  const used = new Set(listOf(taken).filter(Boolean));
  const out = {};
  if (!want) return out;
  const rows = listOf(venueMenus).filter((m) => m && m.id && m.location_id && m.is_active !== false && !used.has(m.id) && normName(m.name) === want)
    .sort((a, b) => ((Number(a.sort_order) || 0) - (Number(b.sort_order) || 0)) || String(a.id).localeCompare(String(b.id)));
  for (const m of rows) if (!(m.location_id in out)) out[m.location_id] = m.id;
  return out;
}

/** A new extra menu row. */
export function newExtraMenu(id, name, sites = {}) {
  return { id, name: String(name ?? '').trim().slice(0, EXTRA_MENU_NAME_MAX), sites: { ...sites } };
}

/** Why a name cannot be used for a new or renamed menu ('' when it can). */
export function extraMenuNameProblem(menu, name, exceptId = null) {
  const n = String(name ?? '').trim();
  if (!n) return 'Give the menu a name.';
  if (n.length > EXTRA_MENU_NAME_MAX) return `A menu name can be ${EXTRA_MENU_NAME_MAX} letters at most.`;
  const want = normName(n);
  if (want === normName(MAIN_MENU_WORDS)) return 'The group menu already has its Main menu. Pick another name.';
  if (extraMenus(menu).some((m) => m.id !== exceptId && normName(m.name) === want)) return 'The group menu already has a menu with that name.';
  if (!exceptId && extraMenus(menu).length >= MAX_EXTRA_MENUS) return `A group menu can have ${MAX_EXTRA_MENUS} menus beside its main one.`;
  return '';
}

/** The list to save (msm_menus.extra_menus) from clean rows: only what the database keeps. */
export function extraMenusValue(rows) {
  return listOf(rows).filter((m) => m && m.id).map((m) => {
    const out = { id: m.id, name: String(m.name ?? '').trim().slice(0, EXTRA_MENU_NAME_MAX) || 'Menu' };
    if (m.archived === true) out.archived = true;
    if (isObj(m.sites) && Object.keys(m.sites).length) out.sites = { ...m.sites };
    return out;
  });
}

/** Is a staged extra_menus value the shape the database takes? (the trigger checks the same) */
export function extraMenusShapeOk(value) {
  if (!Array.isArray(value) || value.length > MAX_EXTRA_MENUS * 2) return false;
  const ids = new Set();
  for (const m of value) {
    if (!isObj(m) || typeof m.id !== 'string' || !/^[0-9a-f-]{8,40}$/i.test(m.id) || ids.has(m.id)) return false;
    ids.add(m.id);
    if (typeof m.name !== 'string' || !m.name.trim() || m.name.length > EXTRA_MENU_NAME_MAX) return false;
    if (Object.keys(m).some((k) => !['id', 'name', 'archived', 'sites'].includes(k))) return false;
    if ('archived' in m && typeof m.archived !== 'boolean') return false;
    if ('sites' in m) {
      if (!isObj(m.sites)) return false;
      for (const v of Object.values(m.sites)) if (!(v === false || (typeof v === 'string' && v.length > 0 && v.length <= 120))) return false;
    }
  }
  return value.filter((m) => m.archived !== true).length <= MAX_EXTRA_MENUS;
}

/** Is a staged menu_keys value the shape the database takes? null, or a short list of keys. */
export function menuKeysShapeOk(value) {
  if (value === null || value === undefined) return true;
  if (!Array.isArray(value) || !value.length || value.length > MAX_EXTRA_MENUS * 2 + 1) return false;
  return value.every((k) => typeof k === 'string' && (k === MAIN_MENU || /^[0-9a-f-]{8,40}$/i.test(k))) && new Set(value).size === value.length;
}

// ── Words for a draft ───────────────────────────────────────────────────────

/** What a staged change of the list of menus does, as short phrases: ["new menu Catering", ...]. */
export function extraMenusChangeWords(before, after) {
  const was = new Map(allExtraMenus({ extra_menus: before }).map((m) => [m.id, m]));
  const now = new Map(allExtraMenus({ extra_menus: after }).map((m) => [m.id, m]));
  const out = [];
  for (const [id, m] of now) {
    const b = was.get(id);
    if (!b || (b.archived && !m.archived)) { if (!m.archived) out.push(`new menu ${m.name}`); continue; }
    if (m.archived && !b.archived) { out.push(`${b.name} menu removed`); continue; }
    if (m.archived) continue;
    if (b.name !== m.name) out.push(`${b.name} menu renamed to ${m.name}`);
    if (JSON.stringify(b.sites) !== JSON.stringify(m.sites)) out.push(`${m.name}: which menu it is at a site changed`);
  }
  for (const [id, b] of was) if (!now.has(id) && !b.archived) out.push(`${b.name} menu removed`);
  return out;
}

/** "Main and Catering" from saved keys and a Map (or object) of key to name; unknown keys are left out. */
export function menuKeyNames(keys, names) {
  const get = (k) => (k === MAIN_MENU ? MAIN_MENU_WORDS : (names && typeof names.get === 'function' ? names.get(k) : names && names[k]) || null);
  const list = (Array.isArray(keys) && keys.length ? keys : [MAIN_MENU]).map(get).filter(Boolean);
  if (!list.length) return 'other menus';
  return list.length === 1 ? list[0] : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}
