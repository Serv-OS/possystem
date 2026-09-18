// src/lib/stampCategoryGroups.js
//
// Back Office stamp card picker: categories from EVERY site of the company, grouped by name.
//
// Stamp cards are per COMPANY (Peter, 18 Sep 2026) but menu_categories are per SITE, so the
// same "Hot Coffee" has a different id at each site. The picker shows one "Hot Coffee" with how
// many sites have it, and saving it stores every site's id. loyalty-earn also matches by name
// at earn time (supabase/functions/_shared/stampQualify.ts), so sites and menus added later
// earn too. normCategoryName must stay identical to normStampName there (parity test in
// src/lib/stampQualify.test.js).

/** Trim, lower-case and collapse runs of whitespace. '' for anything that is not a name. */
export function normCategoryName(s) {
  if (typeof s !== 'string') return '';
  return s.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * @param {Array<{id:string,label:string,parent_id?:string|null,location_id?:string}>} cats
 * @returns {Array<{groupId:string,key:string,label:string,parentKey:string|null,ids:string[],siteCount:number}>}
 *   in first-seen order. parentKey is the normalised name of the parent category (null = top level).
 */
export function groupCategoriesByName(cats) {
  const list = Array.isArray(cats) ? cats.filter(c => c && c.id) : [];
  const byId = new Map(list.map(c => [c.id, c]));
  const groups = new Map();
  const sites = new Map();
  for (const c of list) {
    const key = normCategoryName(c.label);
    if (!key) continue;
    const parent = c.parent_id ? byId.get(c.parent_id) : null;
    const parentKey = parent ? (normCategoryName(parent.label) || null) : null;
    const groupId = `${parentKey || ''}>${key}`;
    let g = groups.get(groupId);
    if (!g) {
      g = { groupId, key, label: String(c.label).trim().replace(/\s+/g, ' '), parentKey, ids: [], siteCount: 0 };
      groups.set(groupId, g);
      sites.set(groupId, new Set());
    }
    g.ids.push(c.id);
    sites.get(groupId).add(c.location_id || c.id);
  }
  for (const [groupId, g] of groups) g.siteCount = sites.get(groupId).size;
  return [...groups.values()];
}

/** Normalised names of the saved ids that are known in the groups. */
export function selectedNameKeys(selectedIds, groups) {
  const sel = new Set(Array.isArray(selectedIds) ? selectedIds : []);
  const keys = new Set();
  for (const g of groups || []) if (g.ids.some(id => sel.has(id))) keys.add(g.key);
  return keys;
}

/** A group is on when any saved id shares its name (that is what earns at the till). */
export function isGroupSelected(group, selectedIds, groups) {
  return selectedNameKeys(selectedIds, groups).has(group.key);
}

/**
 * Toggle a name group. On: add every site's id for that group. Off: remove every id with that
 * name, so no site keeps earning for it by name.
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

/** How many category NAMES a saved card qualifies (ids not found in any group count once each). */
export function selectedGroupCount(selectedIds, groups) {
  const ids = Array.isArray(selectedIds) ? selectedIds : [];
  const known = new Set();
  for (const g of groups || []) g.ids.forEach(id => known.add(id));
  const unknown = ids.filter(id => !known.has(id)).length;
  return selectedNameKeys(ids, groups).size + unknown;
}
