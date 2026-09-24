// src/lib/loyaltyMenuMatch.js
//
// Which basket lines a FREE ITEM loyalty reward can make free, on every surface.
//
// THE RULE (Peter, 18 Sep 2026): loyalty is per COMPANY, never per site. A stamp card's
// reward_config.eligible_items and a points reward's reward_value.eligible_items hold
// [{ id, name }] picked from a menu, but menu_items are PER SITE: the Latte at Leeds and the
// Latte at Barnsley have different ids. Matching by id alone meant a Free Drink set up at Leeds
// refused with "Add Latte to the order first" at every other site.
//
// NOW a line is eligible when:
//   1. one of its ids (the item, its size, or the size's parent) is a saved id, exactly as
//      before; OR
//   2. one of its LABELS has the same normalised text as a saved name. A label is the item's
//      own name for a plain item, and "<parent> - <size>" (the Back Office picker's format)
//      for a size, plus the parent name alone (a Free Latte saved before the Latte had sizes
//      still covers a Latte of any size, the same as the saved parent id already did on the
//      kiosk). The line's display name is a fallback label when the local menu has no row; OR
//   3. (v5.9.66, Peter 24 Sep 2026: "eligible free items should be categories or products")
//      one of its CATEGORIES is covered by a saved category. reward_config.eligible_categories
//      / reward_value.eligible_categories hold [{ id, name, path }], one entry per site id of
//      a category PATH (the Back Office picker saves every site's id, lib/loyaltyCategoryPicker.js).
//      The decision is lib/stampCategoryGroups.js categoryQualifies, the stamp earn rule: the
//      line's category or one of its ancestors is a saved id, or a saved path (stored with the
//      entry, or read through the site's own category rows) is the line's path or an ancestor
//      of it. A line's categories are its cat / cats, else its menu row's (a size uses its
//      parent's category, as the till does when it adds the line).
//
// Names are normalised exactly like the stamp earn rule (supabase/functions/_shared/
// stampQualify.ts normStampName: trim, lower case, runs of whitespace to one space; parity
// test in src/lib/loyaltyMenuMatch.test.js), and a spaced dash of any kind between parent and
// size counts as one separator, because older saves and the kiosk line name use a long dash.
//
// Every function is pure, never throws, and a reward with no eligible items or categories
// configured keeps its old meaning on each surface (the callers decide what "none configured"
// does). `categories` is always optional: without rows a category still matches by saved id.

import { categoryQualifies, pathKeyOf } from './stampCategoryGroups.js';

/** Trim, lower-case and collapse runs of whitespace. '' for anything that is not a name. */
export function normLoyaltyName(s) {
  if (typeof s !== 'string') return '';
  return s.trim().replace(/\s+/g, ' ').toLowerCase();
}

// Hyphen, the Unicode dash block (U+2010 to U+2015) and the minus sign, with spaces around it.
const SPACED_DASH = new RegExp(' [\\-\\u2010-\\u2015\\u2212] ', 'g');

/** Comparison key for an item label: normalised, with any spaced dash folded to ' - '. */
export function itemLabelKey(s) {
  return normLoyaltyName(s).replace(SPACED_DASH, ' - ');
}

/** The label the Back Office saves for an item: its name, or "<parent> - <size>" for a size. */
export function itemLabel(name, parentName) {
  const n = typeof name === 'string' ? name.trim().replace(/\s+/g, ' ') : '';
  const p = typeof parentName === 'string' ? parentName.trim().replace(/\s+/g, ' ') : '';
  return p && n ? `${p} - ${n}` : (n || p);
}

/** The configured eligible items of a reward value, cleaned ({ id, name } objects only). */
export function eligibleItemsOf(value) {
  const list = value && Array.isArray(value.eligible_items) ? value.eligible_items : [];
  return list.filter(ei => ei && typeof ei === 'object' && (ei.id || ei.name));
}

/** The configured eligible categories, cleaned ({ id, name, path } objects; path = names, root first). */
export function eligibleCategoriesOf(value) {
  const list = value && Array.isArray(value.eligible_categories) ? value.eligible_categories : [];
  return list.filter(ec => ec && typeof ec === 'object' && (ec.id || ec.name || (Array.isArray(ec.path) && ec.path.length)));
}

/** The path key a saved category entry stands for: its saved path, else its name alone. */
export function eligibleCategoryKey(ec) {
  if (!ec || typeof ec !== 'object') return null;
  if (Array.isArray(ec.path) && ec.path.length) return pathKeyOf(ec.path);
  return typeof ec.name === 'string' && ec.name.trim() ? pathKeyOf([ec.name]) : null;
}

/** One name per distinct category path (a category saved for four sites reads once). */
export function eligibleCategoryNames(value) {
  const seen = new Set();
  const out = [];
  for (const ec of eligibleCategoriesOf(value)) {
    const key = eligibleCategoryKey(ec) || `id:${ec.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const n = typeof ec.name === 'string' ? ec.name.trim() : '';
    if (n) out.push(n);
  }
  return out;
}

/**
 * The names to show a guest or staff member, one per distinct label (a reward saved for four
 * sites stores four ids with the same name; it reads "Latte", not "Latte, Latte, Latte, Latte").
 * Categories follow the items as "anything from <category>", so every existing message
 * ("Add X to your order first", "Free X") reads naturally with either.
 */
export function eligibleItemNames(value) {
  const seen = new Set();
  const out = [];
  for (const ei of eligibleItemsOf(value)) {
    const key = itemLabelKey(ei.name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(String(ei.name).trim());
  }
  for (const n of eligibleCategoryNames(value)) out.push(`anything from ${n}`);
  return out;
}

/**
 * A matcher for one reward's eligible items and categories.
 *   configured  true when the reward names at least one eligible item or category
 *   matches({ ids, labels, catIds })  true when any id is a saved id, any label has a saved
 *               name, or any category id is covered by a saved category
 * @param value       reward_value / reward_config
 * @param categories  the site's own category rows (DB or store shape); optional
 */
export function eligibleMatcher(value, categories) {
  const items = eligibleItemsOf(value);
  const cats = eligibleCategoriesOf(value);
  const ids = new Set();
  const keys = new Set();
  for (const ei of items) {
    if (typeof ei.id === 'string' && ei.id) ids.add(ei.id);
    const k = itemLabelKey(ei.name);
    if (k) keys.add(k);
  }
  const catIds = [];
  const catKeys = [];
  for (const ec of cats) {
    if (typeof ec.id === 'string' && ec.id) catIds.push(ec.id);
    const k = eligibleCategoryKey(ec);
    if (k && !catKeys.includes(k)) catKeys.push(k);
  }
  const rows = Array.isArray(categories) ? categories : [];
  return {
    configured: items.length > 0 || cats.length > 0,
    matches(cand) {
      if (!cand) return false;
      for (const id of cand.ids || []) if (id && ids.has(id)) return true;
      if (keys.size) {
        for (const l of cand.labels || []) {
          const k = itemLabelKey(l);
          if (k && keys.has(k)) return true;
        }
      }
      if (catIds.length || catKeys.length) {
        for (const c of cand.catIds || []) if (c && categoryQualifies(c, catIds, rows, catKeys)) return true;
      }
      return false;
    },
  };
}

/** id -> { name, parentId, cat, cats } from a menu list in either shape (store camelCase or DB rows). */
export function menuNameIndex(menuItems) {
  const map = new Map();
  if (!Array.isArray(menuItems)) return map;
  for (const m of menuItems) {
    if (!m || !m.id) continue;
    map.set(m.id, {
      name: typeof m.name === 'string' ? m.name : '',
      parentId: m.parentId || m.parent_id || null,
      cat: typeof m.cat === 'string' ? m.cat : null,
      cats: Array.isArray(m.cats) ? m.cats : [],
    });
  }
  return map;
}

// Labels for an item id resolved through the local menu: its own label and its parent's name.
function labelsFromIndex(itemId, parentId, index) {
  const out = [];
  if (!index || !itemId) return out;
  const row = index.get(itemId);
  if (!row) return out;
  const pid = parentId || row.parentId;
  const parent = pid ? index.get(pid) : null;
  if (parent && parent.name) {
    out.push(itemLabel(row.name, parent.name));
    out.push(parent.name);
  } else if (row.name) {
    out.push(row.name);
  }
  return out;
}

// Distinct category ids from a line and (through the menu) its row and its parent's row.
function categoryIdsOf(line, index) {
  const out = [];
  const push = (c) => { if (typeof c === 'string' && c && !out.includes(c)) out.push(c); };
  push(line.cat);
  for (const c of Array.isArray(line.cats) ? line.cats : []) push(c);
  if (index && line.itemId) {
    const row = index.get(line.itemId);
    if (row) { push(row.cat); row.cats.forEach(push); }
    const pid = line.parentId || row?.parentId;
    const parent = pid ? index.get(pid) : null;
    if (parent) { push(parent.cat); parent.cats.forEach(push); }
  }
  return out;
}

/**
 * Candidates for a till or online order line ({ itemId, parentId, name, cat, cats }).
 * @param index  menuNameIndex of the site's own menu (optional; the display name is the fallback)
 */
export function orderLineCandidates(line, index) {
  if (!line) return { ids: [], labels: [], catIds: [] };
  const ids = [line.itemId, line.parentId].filter(Boolean);
  const labels = labelsFromIndex(line.itemId, line.parentId, index);
  if (typeof line.name === 'string' && line.name) labels.push(line.name);
  return { ids, labels, catIds: categoryIdsOf(line, index) };
}

/**
 * Candidates for a kiosk basket line ({ item, variant }): the kiosk adds a size as its PARENT
 * item with the size on line.variant ({ id, lineName, itemName } from lib/kioskLine.js).
 */
export function kioskLineCandidates(line) {
  if (!line) return { ids: [], labels: [], catIds: [] };
  const item = line.item || {};
  const variant = line.variant || null;
  const ids = [item.id, variant && variant.id].filter(Boolean);
  const labels = [];
  if (variant) {
    if (variant.itemName) labels.push(itemLabel(variant.itemName, item.name));
    if (variant.lineName) labels.push(variant.lineName);
    if (item.name) labels.push(item.name);
  } else {
    if (item.name) labels.push(item.name);
    const menuName = item.menuName || item.menu_name;
    if (menuName) labels.push(menuName);
  }
  const catIds = [];
  const push = (c) => { if (typeof c === 'string' && c && !catIds.includes(c)) catIds.push(c); };
  push(item.cat);
  for (const c of Array.isArray(item.cats) ? item.cats : []) push(c);
  return { ids, labels, catIds };
}

/**
 * The till and online rule in one place: the order lines ({ itemId, parentId, name, voided })
 * a free item reward can make free. [] when the reward names no eligible items or categories
 * (each caller keeps its own "none configured" behaviour) or none of them is on the order.
 * @param value       reward_value / reward_config ({ eligible_items, eligible_categories })
 * @param lines       till session items or online cart lines
 * @param menuItems   the site's own menu (resolves "<parent> - <size>" and a line's category); optional
 * @param categories  the site's own category rows (parent and path rules); optional
 */
export function eligibleOrderLines(value, lines, menuItems, categories) {
  const matcher = eligibleMatcher(value, categories);
  if (!matcher.configured || !Array.isArray(lines)) return [];
  const index = menuNameIndex(menuItems);
  return lines.filter(l => l && !l.voided && matcher.matches(orderLineCandidates(l, index)));
}
