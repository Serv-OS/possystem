/**
 * onlineMenuTree.js: which items sit in a section of the online and QR storefront.
 *
 * Pure, NO imports, so node:test can load it (onlineMenuTree.test.js).
 *
 * WHY (2 Oct 2026, Coffee Boy Leeds, Peter: "online the menu is not right, for example
 * coffee: anything in sub categories is not showing on the online menu"). The storefront
 * draws one section per TOP LEVEL category, and since v5.5.108 it only took an item whose
 * cat or cats named that exact category. Latte lives in Coffee, a sub category of Hot/Iced
 * Coffee, with nothing in cats, so it matched no section. Hot/Iced Coffee itself only holds
 * option rows (Oat Milk, Extra Shot), so the whole section was dropped as empty. 24 products
 * at Leeds were missing this way (Coffee, Iced Coffee, Teas, Iced Teas, one donut). Bottles,
 * Cans, Smoothies and the rest only showed because each item also had the parent ticked.
 *
 * The till's rule (POSSurface catItems): a top level category shows its own items plus the
 * items of its sub categories, and sub categories follow their parent onto a menu
 * (lib/menuMembership.js allowedCategoryIds). The storefront now uses the same rule.
 *
 * Rows are the raw DB rows the storefront reads (parent_id, sold_alone); the store's camel
 * spelling (parentId) is read too.
 *
 * NOT used by the catering storefront yet, on purpose (review, 2 Oct 2026). CateringSurface
 * keeps the old top level only match, and its card filter has no sold alone test. Checked on
 * the live rows of the one venue with catering on (Provo): this rule alone would add no
 * product there, only five free option rows (Hot, Cold, Whole Milk) as cards. Catering needs
 * the option row test first, then this rule. Its own change, not during service.
 */

const parentOf = (c) => c?.parent_id ?? c?.parentId ?? null;

/**
 * The category id followed by the id of every category under it, at any depth.
 *   allCategories  every category at the venue, NOT only the ones on the live menu: a sub
 *                  category follows its parent, as on the till.
 */
export function categoryTreeIds(rootId, allCategories) {
  if (rootId == null) return [];
  const kids = new Map();
  for (const c of (Array.isArray(allCategories) ? allCategories : [])) {
    const p = parentOf(c);
    if (!c || p == null) continue;
    if (!kids.has(p)) kids.set(p, []);
    kids.get(p).push(c.id);
  }
  const out = [];
  const seen = new Set();
  const walk = (id) => {
    if (seen.has(id)) return;   // defensive against a cyclic parent_id
    seen.add(id);
    out.push(id);
    for (const k of (kids.get(id) || [])) walk(k);
  };
  walk(rootId);
  return out;
}

/**
 * One tree per storefront section: Map of top level category id to the Set of ids under it
 * (itself included). Built once per render, not once per item.
 */
export function onlineSectionTrees(topCategories, allCategories) {
  const out = new Map();
  for (const c of (Array.isArray(topCategories) ? topCategories : [])) {
    if (!c) continue;
    out.set(c.id, new Set(categoryTreeIds(c.id, allCategories)));
  }
  return out;
}

/**
 * Does this item sit in the section? True when its cat, or any of its cats, is the section's
 * category or one of its sub categories.
 *   treeIds  the Set from onlineSectionTrees; a bare category id works too
 * Membership only. What counts as a product card (not a size row, not archived, sold alone,
 * the allergy filter) stays in the storefront's own filter (OnlineSurface itemsForCat), which
 * publicOrderValueFence.test.js pins against the server's rule.
 */
export function itemInSection(item, treeIds) {
  if (!item || treeIds == null) return false;
  const ids = treeIds instanceof Set ? treeIds : new Set([].concat(treeIds));
  if (item.cat != null && ids.has(item.cat)) return true;
  return Array.isArray(item.cats) && item.cats.some((id) => ids.has(id));
}
