// menuMembership.js — ONE truth for "does this category/item belong to menu M".
//
// A menu owns a category two ways (see db.js, v4.6.0 migration):
//   - PRIMARY home:   category.menuId (menu_id) === M
//   - LINKED:         a row in menu_category_links with (menu_id=M, category_id=cat.id)
//
// v5.6.97: extracted from BarSurface's inline filter so the staff POS, bar tabs
// and any future surface share one membership mechanism. Before this the POS
// had its own copy that fed the menu resolver a PRIMARY-ONLY view — a device
// profile pinned to a menu whose categories were all attached via links was
// treated as "empty" and silently overridden by the default menu (the
// "restricted the terminal to Bar but the POS still shows everything" bug).
//
// Conventions:
//   - menuId == null / undefined  ⇒ NO restriction (helpers return null / true).
//     Profiles without an assigned menu must keep showing everything.
//   - Rows may arrive snake_case (DB) or camelCase (store) — read both.

// Set of category ids linked to `menuId` via menu_category_links rows.
export function linkedCategoryIdSet(links, menuId) {
  const out = new Set();
  if (!menuId) return out;
  for (const l of links || []) {
    if (l && l.menu_id === menuId) out.add(l.category_id);
  }
  return out;
}

// Rail filter: should this category show when the device is pinned to `menuId`?
// Pass the Set from linkedCategoryIdSet. No menuId ⇒ everything shows.
export function categoryVisibleInMenu(cat, menuId, linkedSet) {
  if (!menuId) return true;
  if (!cat) return false;
  if ((cat.menuId || cat.menu_id) === menuId) return true;
  return !!(linkedSet && linkedSet.has(cat.id));
}

// Which menus own at least one REAL top-level category (primary OR linked)?
// Used by the POS active-menu resolver so a links-only menu is not mistaken
// for an empty one and skipped.
export function menusWithCategories(categories, links) {
  const topLevel = new Set();
  const out = new Set();
  for (const c of categories || []) {
    // Kiosk and online feed raw snake rows (is_special), the store feeds camel.
    if (!c || c.parentId || c.parent_id || c.isSpecial || c.is_special) continue;
    topLevel.add(c.id);
    const home = c.menuId || c.menu_id;
    if (home) out.add(home);
  }
  for (const l of links || []) {
    if (l && topLevel.has(l.category_id)) out.add(l.menu_id);
  }
  return out;
}

// Full set of category ids belonging to `menuId`: primary-home cats, linked
// cats, and the sub-categories of any allowed parent (children follow their
// parent, matching how the POS drills into sub-categories without re-checking
// the menu). Returns null when menuId is falsy ⇒ no restriction.
export function allowedCategoryIds(categories, menuId, links) {
  if (!menuId) return null;
  const linked = linkedCategoryIdSet(links, menuId);
  const out = new Set();
  for (const c of categories || []) {
    if (!c) continue;
    if ((c.menuId || c.menu_id) === menuId || linked.has(c.id)) out.add(c.id);
  }
  // Children of an allowed parent are allowed too (one level of nesting is the
  // product model; loop until stable anyway so deeper trees never leak out).
  let grew = true;
  while (grew) {
    grew = false;
    for (const c of categories || []) {
      if (!c || out.has(c.id)) continue;
      const parent = c.parentId || c.parent_id;
      if (parent && out.has(parent)) { out.add(c.id); grew = true; }
    }
  }
  return out;
}

// Grid predicate: does this sellable item live in one of the allowed
// categories? `allowed` is the Set from allowedCategoryIds (null ⇒ show all).
export function itemInAllowedCats(item, allowed) {
  if (!allowed) return true;
  if (!item) return false;
  if (item.cat && allowed.has(item.cat)) return true;
  const cats = item.cats;
  return Array.isArray(cats) && cats.some((id) => allowed.has(id));
}

// v5.8.73 (Coffee Boy Barnsley, 15 Sep 2026): a category with NO menu (no menu_id and no link) is
// on no menu. Tills with a menu picked never showed it, but Back Office listed it under EVERY
// menu, so a shared category at a venue with no menu looked like it was on all of them. Back
// Office now uses categoryVisibleInMenu like the tills, and lists these separately.
/** Top level categories that are on no menu at all (no menu_id and no link row). */
export function categoriesOnNoMenu(categories, links) {
  const linked = new Set((links || []).filter(Boolean).map((l) => l.category_id));
  return (categories || []).filter((c) => c && !(c.parentId || c.parent_id) && !(c.isSpecial || c.is_special)
    && !(c.menuId || c.menu_id) && !linked.has(c.id));
}

/**
 * Which menu a SHARED category joins at another venue (lib/db.js setMenuCategoryScope).
 *   peerMenus       that venue's menus rows (id, is_default, sort_order)
 *   sourceMenuName  the name of the menu the category came from, when known
 * Returns { useId } for the venue's default menu (else its first), or, when the venue has no
 * menu at all, { create: { name } } named like the menu it came from (else "Main menu").
 */
export function peerMenuPlan(peerMenus, sourceMenuName) {
  const list = (Array.isArray(peerMenus) ? peerMenus : []).filter((x) => x && x.id);
  if (list.length) {
    const sorted = list.slice().sort((a, b) => (Number(a.sort_order ?? a.sortOrder ?? 0) - Number(b.sort_order ?? b.sortOrder ?? 0)));
    const def = sorted.find((x) => x.is_default === true || x.isDefault === true);
    return { useId: (def || sorted[0]).id };
  }
  const name = String(sourceMenuName || '').trim();
  return { create: { name: name || 'Main menu' } };
}
