// src/lib/menuBoardSections.js
//
// What a MENU BOARD lists, in one place for the TV (surfaces/MenuBoardSurface.jsx) and the
// Back Office builder and its preview (backoffice/sections/MenuBoards.jsx).
//
// v5.9.67, Peter 24 Sep 2026: "you can't add subcategories, only main categories, and that adds
// all the modifiers with no control. We need to add subcategories to the menu boards without
// the parents, and it should never show sub items unless they are set as sold alone."
//
//   1. A block may be ANY category that is not special, a SUBCATEGORY included. A subcategory
//      block lists that subcategory's own items under its own heading (or the heading typed on
//      the block); the parent need not be on the board. A parent block lists the items placed
//      directly in the parent, exactly as before.
//   2. A sub item that is not sold alone is an OPTION (Oat milk, No ice), never a product on a
//      board: lib/menuRules.js isOptionOnlyItem, the one rule the till, kiosk and online read.
//   3. Sizes (rows whose parent_id points at a listed item) nest under their parent as _variants.
//
// Pure, no React, so node:test can load it (menuBoardSections.test.js).

import { isOptionOnlyItem } from './menuRules.js';

const bySort = (a, b) => (a.sort_order || 0) - (b.sort_order || 0);
const sortCats = (a, b) => bySort(a, b) || String(a.label || '').localeCompare(String(b.label || ''));

/** May this row be a product line on a board? (rule 2, plus archived and the kiosk visibility switch) */
export function boardVisibleItem(it) {
  if (!it || it.archived) return false;
  if (it.visibility && it.visibility.kiosk === false) return false;
  if (isOptionOnlyItem(it)) return false;
  return true;
}

/**
 * { [categoryId]: items } for every category id an item carries (cat and cats), in menu order,
 * each item with its sizes nested as _variants (rule 3). A size row is never a line of its own.
 */
export function boardItemsByCategory(items) {
  const vis = (Array.isArray(items) ? items : []).filter(boardVisibleItem);
  const byId = Object.fromEntries(vis.map(i => [i.id, i]));
  const kids = {};
  for (const it of vis) if (it.parent_id && byId[it.parent_id]) (kids[it.parent_id] ||= []).push(it);
  for (const k in kids) kids[k].sort(bySort);
  const out = {};
  for (const it of vis) {
    if (it.parent_id && byId[it.parent_id]) continue;   // a size: shown under its parent
    const ids = new Set([it.cat, ...(Array.isArray(it.cats) ? it.cats : [])].filter(Boolean));
    for (const cid of ids) (out[cid] ||= []).push({ ...it, _variants: kids[it.id] || [] });
  }
  for (const k in out) out[k].sort(bySort);
  return out;
}

/**
 * Every category a board may show (rule 1), in tree order: a parent, then its subcategories,
 * each with `depth` and a `path` label ("Coffee › Iced") for the builder. Special categories
 * are left out, as they are on every screen. A category whose parent is missing is a root.
 */
export function boardCategoryChoices(cats) {
  const list = (Array.isArray(cats) ? cats : []).filter(c => c && c.id && !c.is_special);
  const byId = Object.fromEntries(list.map(c => [c.id, c]));
  const kidsOf = {};
  for (const c of list) {
    const p = c.parent_id && byId[c.parent_id] ? c.parent_id : null;
    (kidsOf[p] ||= []).push(c);
  }
  for (const k in kidsOf) kidsOf[k].sort(sortCats);
  const out = [];
  const seen = new Set();
  const walk = (parentId, depth, prefix) => {
    for (const c of kidsOf[parentId] || []) {
      if (seen.has(c.id) || depth > 6) continue;   // a cycle in parent_id must not loop
      seen.add(c.id);
      const path = prefix ? `${prefix} › ${c.label ?? ''}` : String(c.label ?? '');
      out.push({ ...c, depth, path });
      walk(c.id, depth + 1, path);
    }
  };
  walk(null, 0, '');
  return out;
}

/** The heading a block shows on the TV: the heading typed on the block, else the category's own label. */
export function boardSectionTitle(block, cat) {
  const t = typeof block?.title === 'string' ? block.title.trim() : '';
  return t || String(cat?.label ?? '');
}

/**
 * Ordered, non empty sections for a board.
 *   blocks      board.layout.blocks [{ categoryId, span?, title? }]. Empty or missing = every
 *               TOP LEVEL category in menu order (the board's default since day one).
 *   cats        the venue's menu_categories rows
 *   itemsByCat  boardItemsByCategory(items)
 * → [{ id, cat, title, span, items }]. A block whose category is gone is skipped.
 */
export function boardSections({ blocks, cats, itemsByCat } = {}) {
  const all = (Array.isArray(cats) ? cats : []).filter(c => c && c.id && !c.is_special);
  const byId = Object.fromEntries(all.map(c => [c.id, c]));
  const list = Array.isArray(blocks) && blocks.length
    ? blocks.map(b => ({ block: b || {}, cat: byId[b?.categoryId] })).filter(x => x.cat)
    : all.filter(c => !c.parent_id).sort(sortCats).map(c => ({ block: { categoryId: c.id }, cat: c }));
  return list
    .map(({ block, cat }) => ({
      id: cat.id, cat, title: boardSectionTitle(block, cat), span: block.span,
      items: (itemsByCat && itemsByCat[cat.id]) || [],
    }))
    .filter(s => s.items.length > 0);
}
