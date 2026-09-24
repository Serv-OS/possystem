// src/lib/stampCategoryGroups.js
//
// Back Office stamp card picker: categories from EVERY site of the company, grouped by PATH.
//
// Stamp cards are per COMPANY (Peter, 18 Sep 2026) but menu_categories are per SITE, so the
// same "Hot Coffee" has a different id at each site. The picker shows one chip per category
// PATH (parent names down to the category) with how many sites have it, and saving it stores
// every site's id. Grouping by path, not by name alone, keeps "Drinks / Coffee" and
// "Retail / Coffee" (bags of beans) apart.
//
// THE CATEGORY PATH RULE, identical to loyalty-earn (supabase/functions/_shared/stampQualify.ts
// pathCovers): a saved category covers a line's category when their normalised paths are equal
// or the saved path is an ancestor of the line's path. So ticking "Coffee" also earns for
// "Coffee / Hot Coffee" and "Coffee / Iced Coffee" at every site, and the picker shows those
// children as included. normCategoryName and pathCovers must stay identical to normStampName
// and pathCovers there (parity tests in src/lib/stampQualify.test.js).

/** Trim, lower-case and collapse runs of whitespace. '' for anything that is not a name. */
export function normCategoryName(s) {
  if (typeof s !== 'string') return '';
  return s.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Joins the levels of a path key (same control character as the server). */
export const PATH_SEP = '\u001f';
const MAX_DEPTH = 8;

/** A path key from names, root first: pathKeyOf(['Drinks', 'Coffee']). */
export function pathKeyOf(names) {
  const parts = (Array.isArray(names) ? names : []).map(normCategoryName);
  return parts.length && parts.every(Boolean) ? parts.join(PATH_SEP) : null;
}

/** THE CATEGORY PATH RULE: equal paths, or the saved path is an ancestor of the line's path. */
export function pathCovers(savedKey, lineKey) {
  if (!savedKey || !lineKey) return false;
  return lineKey === savedKey || lineKey.startsWith(savedKey + PATH_SEP);
}

/**
 * The same decision loyalty-earn makes for one line's category, from a list of category rows
 * (every site). True when the line's category or an ancestor is a saved id, or a saved
 * category's path covers the line's path. Used by the parity test.
 */
export function categoryQualifies(lineCatId, savedIds, cats, savedKeys = []) {
  const saved = new Set(Array.isArray(savedIds) ? savedIds : []);
  const keys = Array.isArray(savedKeys) ? savedKeys.filter(Boolean) : [];
  if (!lineCatId) return false;
  if (saved.has(lineCatId)) return true;
  const byId = rowsById(cats);
  let cur = lineCatId;
  const seen = new Set();
  while (cur && !seen.has(cur) && seen.size < MAX_DEPTH) {
    seen.add(cur);
    if (saved.has(cur)) return true;
    cur = parentOf(byId.get(cur));
  }
  const lineKey = pathKeyFor(lineCatId, byId);
  if (!lineKey) return false;
  for (const id of saved) if (pathCovers(pathKeyFor(id, byId), lineKey)) return true;
  // v5.9.66: paths saved WITH a reward (reward_config.eligible_categories[].path), so a category
  // ticked at one site covers the same path at a site that did not exist when it was saved.
  for (const k of keys) if (pathCovers(k, lineKey)) return true;
  return false;
}

/** The path key of one category id through the loaded rows (null when a level is missing). */
export function categoryPathKey(id, cats) {
  return pathKeyFor(id, rowsById(cats));
}

// Rows arrive as DB rows (parent_id, label) or store rows (parentId; label, or name on older
// snapshots). Every reader below goes through these two.
function parentOf(row) {
  return row ? (row.parent_id ?? row.parentId ?? null) : null;
}
function labelOf(row) {
  const l = row ? (row.label ?? row.name) : '';
  return typeof l === 'string' ? l : '';
}

function rowsById(cats) {
  const list = Array.isArray(cats) ? cats.filter(c => c && c.id) : [];
  return new Map(list.map(c => [c.id, c]));
}

// Path key of a category id through the loaded rows; null when any level is missing or loops.
function pathKeyFor(id, byId) {
  const names = [];
  const seen = new Set();
  let cur = id;
  while (cur) {
    if (seen.has(cur) || seen.size >= MAX_DEPTH) return null;
    seen.add(cur);
    const row = byId.get(cur);
    if (!row) return null;
    names.unshift(labelOf(row));
    cur = parentOf(row);
  }
  return pathKeyOf(names);
}

/**
 * @param {Array<{id:string,label:string,parent_id?:string|null,location_id?:string}>} cats
 * @returns {Array<{groupId:string,key:string,label:string,parentKey:string|null,depth:number,ids:string[],siteCount:number}>}
 *   in first-seen order. key is the category's path key, parentKey its parent's (null = top level).
 */
export function groupCategoriesByPath(cats) {
  const byId = rowsById(cats);
  const groups = new Map();
  const sites = new Map();
  for (const c of byId.values()) {
    const key = pathKeyFor(c.id, byId);
    if (!key) continue;
    const cut = key.lastIndexOf(PATH_SEP);
    const parentKey = cut >= 0 ? key.slice(0, cut) : null;
    let g = groups.get(key);
    if (!g) {
      g = {
        groupId: key, key, label: labelOf(c).trim().replace(/\s+/g, ' '), parentKey,
        depth: key.split(PATH_SEP).length - 1, ids: [], siteCount: 0,
      };
      groups.set(key, g);
      sites.set(key, new Set());
    }
    g.ids.push(c.id);
    sites.get(key).add(c.location_id || c.id);
  }
  for (const [key, g] of groups) g.siteCount = sites.get(key).size;
  return [...groups.values()];
}

/** Earlier name for groupCategoriesByPath (the branch grouped by name first). */
export const groupCategoriesByName = groupCategoriesByPath;

/** Path keys of the saved ids that are known in the groups. */
export function selectedPathKeys(selectedIds, groups) {
  const sel = new Set(Array.isArray(selectedIds) ? selectedIds : []);
  const keys = new Set();
  for (const g of groups || []) if (g.ids.some(id => sel.has(id))) keys.add(g.key);
  return keys;
}

/** A group is on when any saved id has its path (that is what earns at the till). */
export function isGroupSelected(group, selectedIds, groups) {
  return selectedPathKeys(selectedIds, groups).has(group.key);
}

/** A group is covered (earns without being ticked) when a ticked ancestor's path covers it. */
export function isGroupCovered(group, selectedIds, groups) {
  for (const k of selectedPathKeys(selectedIds, groups)) {
    if (k !== group.key && pathCovers(k, group.key)) return true;
  }
  return false;
}

/**
 * Toggle a path group. On: add every site's id for that path. Off: remove every id with that
 * path, so no site keeps earning for it.
 */
export function toggleGroup(group, selectedIds, groups) {
  const current = Array.isArray(selectedIds) ? selectedIds : [];
  if (isGroupSelected(group, current, groups)) {
    const drop = new Set();
    for (const g of groups || []) if (g.key === group.key) g.ids.forEach(id => drop.add(id));
    return current.filter(id => !drop.has(id));
  }
  const next = [...current];
  for (const id of group.ids) if (!next.includes(id)) next.push(id);
  return next;
}

/** How many category PATHS a saved card qualifies (ids not found in any group count once each). */
export function selectedGroupCount(selectedIds, groups) {
  const ids = Array.isArray(selectedIds) ? selectedIds : [];
  const known = new Set();
  for (const g of groups || []) g.ids.forEach(id => known.add(id));
  const unknown = ids.filter(id => !known.has(id)).length;
  return selectedPathKeys(ids, groups).size + unknown;
}

/**
 * The saved categories that no longer exist at any site of the company (deleted or rebuilt).
 *   { saved, missing, allMissing }: allMissing is true when the card limits its categories and
 *   NONE of them resolves, so it silently earns nothing until the categories are picked again.
 * @param cats    the company's menu_categories rows (every site)
 * @param loaded  false while (or when) the categories could not be loaded: never warn then
 */
export function missingCategoryState(selectedIds, cats, loaded = true) {
  const ids = Array.isArray(selectedIds) ? selectedIds.filter(Boolean) : [];
  if (!loaded || ids.length === 0) return { saved: ids.length, missing: 0, allMissing: false };
  const known = rowsById(cats);
  const missing = ids.filter(id => !known.has(id)).length;
  return { saved: ids.length, missing, allMissing: missing === ids.length };
}
