// src/lib/loyaltyCategoryPicker.js
//
// Back Office loyalty pickers, the CATEGORY side (v5.9.66, Peter 24 Sep 2026: "eligible free
// items should be categories or products, and qualifying too"). Pure helpers for
// src/backoffice/sections/LoyaltyManager.jsx ScopePicker; the product side is
// lib/loyaltyItemPicker.js and the path groups come from lib/stampCategoryGroups.js.
//
// Two saved shapes, because two readers:
//
//   ENTRIES  reward_config.eligible_categories / reward_value.eligible_categories =
//            [{ id, name, path }], one per site id of a ticked category PATH (path = the
//            normalised names, root first). Read on the till, kiosk and online by
//            lib/loyaltyMenuMatch.js, which matches a line's category by saved id, by an
//            ancestor id, or by the saved PATH, so a site added after the save still redeems.
//
//   IDS      stamp_card_programs.qualifying_category_ids (string[]) and qualifying_item_ids
//            (string[]), exactly as loyalty-earn already reads them: the server resolves the
//            saved ids' names and paths itself (supabase/functions/_shared/stampQualify.ts).
//            The picker shows ids through their path group; an id no group knows is "missing".

import { PATH_SEP, pathCovers, pathKeyOf } from './stampCategoryGroups.js';
import { eligibleCategoryKey, itemLabel } from './loyaltyMenuMatch.js';

const list = (v) => (Array.isArray(v) ? v.filter(Boolean) : []);

/** The entries a path group stands for: one per site id, with the group's label and path. */
export function categoryEntriesFor(group) {
  const path = String(group?.key || '').split(PATH_SEP).filter(Boolean);
  const name = typeof group?.label === 'string' ? group.label : '';
  return list(group?.ids).map(id => ({ id, name, path }));
}

/** A group is selected when a saved entry has one of its ids or its path. */
export function catEntrySelected(group, entries) {
  const ids = new Set(list(group?.ids));
  for (const e of list(entries)) {
    if (e.id && ids.has(e.id)) return true;
    if (group?.key && eligibleCategoryKey(e) === group.key) return true;
  }
  return false;
}

// Path keys of the saved entries: their own path, else the group their id belongs to.
function entryKeys(entries, groups) {
  const byId = new Map();
  for (const g of list(groups)) for (const id of list(g.ids)) byId.set(id, g.key);
  const keys = new Set();
  for (const e of list(entries)) {
    const k = eligibleCategoryKey(e) || (e.id ? byId.get(e.id) : null);
    if (k) keys.add(k);
  }
  return keys;
}

/** Covered = not selected itself, but a selected ancestor path already includes it (the till's rule). */
export function catEntryCovered(group, entries, groups) {
  if (!group?.key || catEntrySelected(group, entries)) return false;
  for (const k of entryKeys(entries, groups)) if (k !== group.key && pathCovers(k, group.key)) return true;
  return false;
}

/**
 * Toggle a path group. On: add an entry for every site's id under the group's label and path.
 * Off: remove every entry with one of its ids or its path, so no site keeps matching it.
 */
export function toggleCatEntry(group, entries, groups) {
  const current = list(entries);
  if (catEntrySelected(group, current)) {
    const drop = new Set(list(group.ids));
    for (const g of list(groups)) if (g.key === group.key) list(g.ids).forEach(id => drop.add(id));
    return current.filter(e => !(e.id && drop.has(e.id)) && eligibleCategoryKey(e) !== group.key);
  }
  const have = new Set(current.map(e => e.id));
  const next = [...current];
  for (const e of categoryEntriesFor(group)) if (!have.has(e.id)) next.push(e);
  return next;
}

/** Saved entries as one chip per category path: [{ key, name, count }] (count = sites). */
export function categoryChips(entries) {
  const chips = new Map();
  for (const e of list(entries)) {
    const key = eligibleCategoryKey(e) || `id:${e.id}`;
    const c = chips.get(key);
    if (c) c.count += 1;
    else chips.set(key, { key, name: (typeof e.name === 'string' && e.name.trim()) || 'Category', count: 1 });
  }
  return [...chips.values()];
}

/** Remove a chip: every entry with that path (or that lone id). */
export function removeCategoryChip(key, entries) {
  return list(entries).filter(e => (eligibleCategoryKey(e) || `id:${e.id}`) !== key);
}

/** Chip key for saved ids that no path group knows (deleted or rebuilt categories). */
export const MISSING_CHIP = '__missing__';

/**
 * An ID-ONLY selection (qualifying_category_ids) as chips: one per known path group, plus one
 * "no longer exist" chip for ids no group knows, so stale ids can be cleared from the picker.
 */
export function categoryIdChips(selectedIds, groups) {
  const sel = new Set(list(selectedIds));
  const chips = [];
  const known = new Set();
  for (const g of list(groups)) {
    if (!list(g.ids).some(id => sel.has(id))) continue;
    chips.push({ key: g.key, name: g.label, count: g.siteCount || list(g.ids).length });
    list(g.ids).forEach(id => known.add(id));
  }
  const missing = [...sel].filter(id => !known.has(id)).length;
  if (missing > 0) chips.push({ key: MISSING_CHIP, name: `${missing} no longer exist${missing === 1 ? 's' : ''}`, count: 1, missing: true });
  return chips;
}

/** Remove an id chip: every id with that path, or (MISSING_CHIP) every id no group knows. */
export function removeCategoryIdChip(key, selectedIds, groups) {
  const ids = list(selectedIds);
  if (key === MISSING_CHIP) {
    const known = new Set();
    for (const g of list(groups)) list(g.ids).forEach(id => known.add(id));
    return ids.filter(id => known.has(id));
  }
  const drop = new Set();
  for (const g of list(groups)) if (g.key === key) list(g.ids).forEach(id => drop.add(id));
  return ids.filter(id => !drop.has(id));
}

/**
 * Qualifying ITEMS for the product picker: the card stores ids, the picker works with
 * { id, name } entries (lib/loyaltyItemPicker.js). Names resolve through the loaded items
 * ("<parent> - <size>" for a size); an id not on any menu keeps an empty name.
 */
export function itemEntriesFromIds(ids, items) {
  const byId = new Map(list(items).filter(i => i.id).map(i => [i.id, i]));
  return list(ids).filter(id => typeof id === 'string' && id).map(id => {
    const row = byId.get(id);
    if (!row) return { id, name: '' };
    const pid = row.parent_id || row.parentId || null;
    const parent = pid ? byId.get(pid) : null;
    return { id, name: parent ? itemLabel(row.name, parent.name) : (typeof row.name === 'string' ? row.name : '') };
  });
}

/** The ids to save from picker entries, each once. */
export function itemIdsFromEntries(entries) {
  const out = [];
  for (const e of list(entries)) if (typeof e.id === 'string' && e.id && !out.includes(e.id)) out.push(e.id);
  return out;
}

/** Re-exported so the picker can build a path key the same way the matcher reads it. */
export { pathKeyOf };
