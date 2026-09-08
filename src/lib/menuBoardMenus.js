// src/lib/menuBoardMenus.js
//
// "Follow timed menus" for the digital menu board. Shared by the TV surface
// (src/surfaces/MenuBoardSurface.jsx) and the Back Office live preview
// (src/backoffice/sections/MenuBoards.jsx) so the two can never disagree about
// which categories a board is showing right now.
//
// The flag lives at menu_boards.layout.followMenus (jsonb, default false, no
// DDL). Off, or missing on an old row: the board is exactly its arranged
// blocks, as it always was. On: the arranged blocks are narrowed to the
// categories on the menu that is live on the VENUE clock, resolved by the one
// shared resolver (src/lib/menus/resolveActiveMenu.js, the same chain as the
// till, kiosk, phone and online), and prices read that menu's tier.
//
// Never blank: if the narrowing would leave nothing with items, the full
// arranged board is shown instead. A TV must never sit on "Menu coming soon"
// because a schedule and a board disagree, or because the menus read failed.
//
// Pure: no supabase import, so node --test can load it.

import { resolveActiveMenu } from './menus/resolveActiveMenu.js';
import { allowedCategoryIds } from './menuMembership.js';

const DEFAULT_TZ = 'Europe/London';

// Does this board row ask to follow timed menus? Tolerant of null rows and of
// rows saved before the flag existed (no layout, or no followMenus key).
export const boardFollowsMenus = (board) => !!(board && board.layout && board.layout.followMenus === true);

/**
 * The menu the board should follow right now, or null.
 * Null means "show the arranged board, no tier": flag off, no menus known
 * (a failed or fenced read degrades here), or the resolver found nothing.
 * @param {object} args
 * @param {object} args.board       menu_boards row (layout.followMenus)
 * @param {Array}  args.menus       raw public.menus rows for the venue
 * @param {Array}  [args.categories] raw menu_categories rows (empty menus skipped)
 * @param {Array}  [args.links]     menu_category_links rows
 * @param {string} [args.timezone]  venue timezone; defaults to Europe/London
 * @param {Date}   [args.now]       tests only
 */
export function resolveBoardMenu({ board, menus, categories, links, timezone, now } = {}) {
  if (!boardFollowsMenus(board)) return null;
  if (!Array.isArray(menus) || menus.length === 0) return null;
  try {
    return resolveActiveMenu({
      menus,
      categories: Array.isArray(categories) ? categories : undefined,
      links: Array.isArray(links) ? links : [],
      pinnedMenuId: null,
      timezone: timezone || DEFAULT_TZ,
      now,
    }) || null;
  } catch {
    return null;
  }
}

/**
 * Narrow ordered board sections to the categories on `activeMenuId`.
 * A category is on the menu when it is its primary home (menu_id), is linked
 * via menu_category_links, or is a sub category whose parent is on it
 * (allowedCategoryIds). Order is preserved. When nothing with items would
 * survive, the sections are returned untouched (never blank).
 *
 * Section shapes differ between callers, so the accessors are injectable:
 *   categoryIdOf(section) defaults to section.cat.id, else section.id
 *   itemsOf(section)      defaults to section.items
 */
export function applyMenuToSections(sections, { categories, links, activeMenuId, categoryIdOf, itemsOf } = {}) {
  const list = Array.isArray(sections) ? sections : [];
  if (!activeMenuId) return list;
  const allowed = allowedCategoryIds(Array.isArray(categories) ? categories : [], activeMenuId, Array.isArray(links) ? links : []);
  if (!allowed) return list;
  const idOf = typeof categoryIdOf === 'function' ? categoryIdOf : (s) => (s && s.cat ? s.cat.id : (s ? s.id : undefined));
  const items = typeof itemsOf === 'function' ? itemsOf : (s) => (s && Array.isArray(s.items) ? s.items : []);
  const kept = list.filter((s) => allowed.has(idOf(s)));
  return kept.some((s) => (items(s) || []).length > 0) ? kept : list;
}
