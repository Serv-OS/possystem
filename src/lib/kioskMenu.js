/**
 * kioskMenu.js: menu screen rules for the new kiosk design.
 *
 * Pure: imports only other pure lib files, so node:test can load it (kioskMenu.test.js).
 *
 *   kioskRailRoots     the rail shows top level categories only (decision 19)
 *   kioskActiveRoot    which rail tile is selected
 *   kioskMenuSections  sub categories become headings in the item list (decision 19)
 *   kioskItemSoldOut   today's sold out rule for a card
 *   kioskAddMode       one tap add, or open the sheet ("items with a required choice open
 *                      the sheet"; decision 10: sizes always open the sheet)
 *   kioskCardButton    what the card's button says
 *   kioskGroupIds      every modifier group id the menu uses (for the rules read)
 *   kioskCardEligible  which rows are product cards, for BOTH kiosk designs (sub items that
 *                      are only sold as an option are never cards, like the till)
 */
import { variantChildren } from './menuPricing.js';
import {
  modifierAssignments, groupRequired, instructionAssignmentRequired, instructionAssignmentId,
} from './kioskGroupRules.js';
import { isUnsafe } from './kioskAllergens.js';
import { isOptionOnlyItem } from './menuRules.js';

const parentOf = (c) => c?.parent_id ?? c?.parentId ?? null;
const orderOf = (c) => Number(c?.sort_order ?? c?.sortOrder ?? 0) || 0;

/**
 * A sub item that is not sold alone: the option row behind a modifier group ("No Ice" in
 * Soft Drinks Options), never a product. The till hides these from every menu
 * (POSSurface: type === 'subitem' && !soldAlone). Reads both the raw row (sold_alone) and
 * the store shape (soldAlone). Only type 'subitem' counts: a 'simple' or 'variants' item is
 * never hidden by this rule, whatever its sold alone flag says.
 */
export function kioskOptionOnlySubitem(item) {
  return isOptionOnlyItem(item);   // lib/menuRules.js rule 1, the till's rule
}

/**
 * A menu item that belongs on a kiosk card list: not a size row, not hidden from the kiosk,
 * and not a sub item that is only sold as an option. Both kiosk designs use this one rule
 * (the new design's rail and item list here, today's KioskApp visibleItems).
 */
export function kioskCardEligible(item) {
  return !!item && !item.parent_id && item.visibility?.kiosk !== false && !kioskOptionOnlySubitem(item);
}

/**
 * Today's kiosk (design off) side list: a category is left out only when it holds rows the
 * old list would have drawn as cards (not size rows, not hidden from the kiosk) and every one
 * of them is a sub item that is only sold as an option. Those categories showed nothing but
 * option rows, so they are empty now. Every other category stays exactly as before,
 * including one that was already empty.
 */
export function kioskLegacyCategoryShown(categoryId, items) {
  let rows = 0;
  for (const it of (Array.isArray(items) ? items : [])) {
    if (!it || it.parent_id || it.visibility?.kiosk === false || !itemInCategory(it, categoryId)) continue;
    if (kioskCardEligible(it)) return true;
    rows++;
  }
  return rows === 0;
}

/** True when the item sits in the category through cat or cats. */
export function itemInCategory(item, categoryId) {
  if (!item || categoryId == null) return false;
  return item.cat === categoryId || (Array.isArray(item.cats) && item.cats.includes(categoryId));
}

/**
 * The rail tiles: top level categories, in order. A category whose parent is not in the
 * list counts as top level, so it never disappears. When items is an array, a top level
 * category with no kiosk item anywhere under it is left out (an empty tile helps nobody).
 * With no items (the photo mode check) every top level category is returned.
 */
export function kioskRailRoots(categories, items) {
  const list = (Array.isArray(categories) ? categories : []).filter(Boolean);
  const ids = new Set(list.map(c => c.id));
  const roots = list.filter(c => !parentOf(c) || !ids.has(parentOf(c)));
  if (!Array.isArray(items)) return roots;
  const eligible = items.filter(kioskCardEligible);
  return roots.filter(root => {
    const tree = subtreeIds(root.id, list);
    return eligible.some(it => tree.some(id => itemInCategory(it, id)));
  });
}

// The root id followed by every category under it, depth first in Back Office order.
function subtreeIds(rootId, list) {
  const kids = new Map();
  for (const c of list) {
    const p = parentOf(c);
    if (p == null) continue;
    if (!kids.has(p)) kids.set(p, []);
    kids.get(p).push(c);
  }
  kids.forEach(arr => arr.sort((a, b) => orderOf(a) - orderOf(b)));
  const out = [];
  const seen = new Set();
  const walk = (id) => {
    if (seen.has(id)) return;   // defensive against a cyclic parent_id
    seen.add(id);
    out.push(id);
    for (const c of (kids.get(id) || [])) walk(c.id);
  };
  walk(rootId);
  return out;
}

/**
 * The rail tile to show as selected. The selected category itself when it is a tile, its
 * top level category when it is a sub category, otherwise the first tile. null when the
 * rail is empty.
 */
export function kioskActiveRoot(roots, categories, selectedId) {
  const rail = Array.isArray(roots) ? roots : [];
  if (!rail.length) return null;
  const railIds = new Set(rail.map(r => r.id));
  const byId = new Map((Array.isArray(categories) ? categories : []).filter(Boolean).map(c => [c.id, c]));
  let id = selectedId;
  const seen = new Set();
  while (id != null && !seen.has(id)) {
    if (railIds.has(id)) return id;
    seen.add(id);
    id = parentOf(byId.get(id));
  }
  return rail[0].id;
}

/**
 * The item list for one rail tile: [{ category, heading, items }].
 * First the tile's own items with no heading, then each sub category (depth first, Back
 * Office order) with its name as the heading. An item shows once, in the first section it
 * appears in. Sections with no items are dropped. Items are sorted by sort_order.
 */
export function kioskMenuSections({ rootId, visibleCategories, items } = {}) {
  const cats = (Array.isArray(visibleCategories) ? visibleCategories : []).filter(Boolean);
  const byId = new Map(cats.map(c => [c.id, c]));
  if (rootId == null || !byId.has(rootId)) return [];
  const eligible = (Array.isArray(items) ? items : []).filter(kioskCardEligible);
  const shown = new Set();
  const sections = [];
  for (const catId of subtreeIds(rootId, cats)) {
    const inCat = eligible
      .filter(it => itemInCategory(it, catId) && !shown.has(it.id))
      .sort((a, b) => orderOf(a) - orderOf(b));
    if (!inCat.length) continue;
    inCat.forEach(it => shown.add(it.id));
    const category = byId.get(catId);
    sections.push({ category, heading: catId === rootId ? null : (category.label || category.name || ''), items: inCat });
  }
  return sections;
}

/** The number of item cards across all sections. */
export function kioskSectionItemCount(sections) {
  return (Array.isArray(sections) ? sections : []).reduce((n, s) => n + (s.items?.length || 0), 0);
}

function stockOut(id, dailyCounts) {
  const stock = dailyCounts?.[id];
  return !!stock && Number(stock.remaining) <= 0;
}

/**
 * Today's card rule: sold out when the item or its parent is 86'd, or its daily count has
 * run out.
 */
export function kioskItemSoldOut(item, eightySixIds, dailyCounts) {
  if (!item) return true;
  const banned = Array.isArray(eightySixIds) ? eightySixIds : [];
  return banned.includes(item.id)
    || (!!item.parent_id && banned.includes(item.parent_id))
    || stockOut(item.id, dailyCounts);
}

/** The sizes the sheet will offer: live children that are not 86'd or sold out. */
export function kioskAvailableSizes(item, items, eightySixIds, dailyCounts) {
  const banned = Array.isArray(eightySixIds) ? eightySixIds : [];
  return variantChildren(item, items).filter(c => !banned.includes(c.id) && !stockOut(c.id, dailyCounts));
}

/**
 * Today's low stock badge: a count is set, some are left, and 40% of par or fewer remain.
 * Returns the number left, or null for no badge.
 */
export function kioskLowStock(item, dailyCounts) {
  const stock = item ? dailyCounts?.[item.id] : null;
  if (!stock) return null;
  const rem = Number(stock.remaining);
  if (!(rem > 0)) return null;
  return rem / stock.par <= 0.4 ? rem : null;
}

/**
 * What the card's button does.
 *   { mode: 'soldout' }
 *   { mode: 'sheet', reason: 'sizes' | 'unsafe' | 'required' | 'unknown' }
 *   { mode: 'quick', hasExtras }
 * ctx:
 *   items            every menu row (size rows included)
 *   eightySixIds     86'd ids
 *   dailyCounts      { [id]: { remaining, par } }
 *   allergenFilter   the customer's allergen picks (Set or array)
 *   instructionDefs  the store's instructionGroupDefs
 *   groupRules       Map of modifier group id to its row (id, min, max, min_select,
 *                    max_select, selection_type), or null while not loaded or after a
 *                    failed read (then any item with modifier groups opens the sheet)
 *
 * The checks mirror what KioskProductModal would block: a quick add must never add an item
 * the sheet would refuse.
 */
export function kioskAddMode(item, ctx = {}) {
  const { items = [], eightySixIds = [], dailyCounts = {}, allergenFilter = null, instructionDefs = [], groupRules = null } = ctx;
  if (!item || kioskItemSoldOut(item, eightySixIds, dailyCounts)) return { mode: 'soldout' };

  if (variantChildren(item, items).length > 0) {
    // Every size gone: never add the parent on its own (it is priced 0).
    if (kioskAvailableSizes(item, items, eightySixIds, dailyCounts).length === 0) return { mode: 'soldout' };
    return { mode: 'sheet', reason: 'sizes' };
  }

  if (isUnsafe(item, allergenFilter)) return { mode: 'sheet', reason: 'unsafe' };

  const defs = Array.isArray(instructionDefs) ? instructionDefs : [];
  const instr = Array.isArray(item.assigned_instruction_groups) ? item.assigned_instruction_groups : [];
  for (const a of instr) {
    const id = instructionAssignmentId(a);
    if (!defs.some(d => d && d.id === id)) continue;   // the sheet skips a missing definition too
    if (instructionAssignmentRequired(a, defs.find(d => d && d.id === id))) return { mode: 'sheet', reason: 'required' };
  }

  const assignments = modifierAssignments(item.assigned_modifier_groups);
  if (assignments.length > 0) {
    if (!(groupRules instanceof Map)) return { mode: 'sheet', reason: 'unknown' };
    for (const a of assignments) {
      const row = groupRules.get(a.id);
      if (!row) continue;   // the sheet skips a group row that is not found
      if (groupRequired(row)) return { mode: 'sheet', reason: 'required' };
    }
    return { mode: 'quick', hasExtras: true };
  }

  return { mode: 'quick', hasExtras: false };
}

/**
 * What the card button says: 'soldOut', 'chooseSize', 'add' (with a plus) or 'choose'.
 * An unsafe item opens the sheet so the allergen warning is seen, but its button still
 * says what the item needs: Add when there is nothing to choose, Choose options when there
 * is. baseMode is kioskAddMode for the same item with no allergen picks.
 */
export function kioskCardButton(addMode, baseMode = null) {
  const mode = addMode?.mode;
  if (mode === 'soldout') return 'soldOut';
  if (addMode?.reason === 'sizes') return 'chooseSize';
  if (mode === 'quick') return 'add';
  if (addMode?.reason === 'unsafe') return baseMode?.mode === 'quick' ? 'add' : 'choose';
  return 'choose';
}

/** Every modifier group id assigned to any item, without repeats. */
export function kioskGroupIds(items) {
  const out = new Set();
  for (const it of (Array.isArray(items) ? items : [])) {
    for (const a of modifierAssignments(it?.assigned_modifier_groups)) out.add(a.id);
  }
  return Array.from(out);
}
