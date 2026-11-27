// src/lib/menuRename.js
//
// 5.12.121 (Peter, 27 Nov 2026, building the Mozz menus: "how do i rename a menu?"). A site's own
// menu could be made, scheduled, given a priority, made the default and deleted in Menu manager,
// but nothing changed its NAME. The "Edit menu settings" panel now has a Menu name box
// (backoffice/sections/MenuNameBox.jsx); the rules it keeps are here, pure, so node --test pins them.
//
// WHY A RENAME IS SAFE (read 27 Nov 2026, develop 5.12.120)
//   * The save is the store's updateMenu(id, { name }): only the name column is written, compare
//     and set on the row's updated_at (lib/menuWriters.js, MENU_COLUMNS).
//   * A POS, a kiosk, the online page, catering, delivery partners and menu boards hold a menu by
//     its ID (menu_id, online_menu_id, menu_ids, pricing.menus[menuId]). None looks it up by name.
//   * The Multi site menu links a site's menu by ID too (msm_menu_sites.venue_menu_id, the extra
//     menus' sites map, or the fixed id publish made: _shared/msmMenus.js extraMenuAt). The NAME is
//     only read when head office ADDS a menu to the group menu (matchSiteMenus, foundSiteMenus),
//     and a menu already linked is skipped there by its id. So a rename never unlinks a menu and
//     publish never makes a second one because of it (menuRename.test.js pins both).
//   * One thing head office can still do: with "use this name at every site" on, a publish that
//     changes the group menu's name writes that name on the site's main menu (msmPlan step 2).
//   * Sharing a product with a timed menu price to another site finds that site's menu by NAME
//     (db.js _peerIdMaps menuIdFor). A menu with no same named menu there is reported, never guessed.
//
// THE RULES
//   * A blank name is refused.
//   * A name another menu at this site already has is refused: trimmed, any spacing, any letter
//     case ("  catering " is "Catering"). Every menu in the site's list counts, a switched off one
//     too: two cards with one name in the list is the muddle this stops.
//   * 60 letters at most, the Multi site menu's own limit for a menu name (EXTRA_MENU_NAME_MAX),
//     so head office can always find and add a site's menu.

export const MENU_NAME_MAX = 60;

/** A name as it is compared: trimmed, single spaced, lower case. */
export const menuNameKey = (name) => String(name ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

/** A name as it is saved: trimmed, single spaced. */
export const cleanMenuName = (name) => String(name ?? '').trim().replace(/\s+/g, ' ');

/**
 * Why a menu cannot take this name ('' when it can).
 *   menus  the site's menus (the store's list)
 *   id     the menu being renamed (never compared with itself)
 */
export function menuNameProblem(menus, id, name) {
  const clean = cleanMenuName(name);
  if (!clean) return 'Give the menu a name. A menu cannot have a blank name.';
  if (clean.length > MENU_NAME_MAX) return `A menu name can be ${MENU_NAME_MAX} letters at most. This one is ${clean.length}.`;
  const want = menuNameKey(clean);
  const other = (Array.isArray(menus) ? menus : []).find((m) => m && m.id !== id && menuNameKey(m.name) === want);
  if (other) return `This site already has a menu called "${String(other.name).trim()}". Pick another name.`;
  return '';
}

/**
 * Rename a menu through the store's own save.
 *   deps  { updateMenu(id, patch), markBOChange() }
 * Returns { ok: true, name, changed } or { ok: false, words }. Nothing is saved when it is refused,
 * and nothing is written when the name is the one it has.
 */
export function renameMenu(menus, id, typed, deps = {}) {
  const menu = (Array.isArray(menus) ? menus : []).find((m) => m && m.id === id);
  if (!menu) return { ok: false, words: 'That menu is not at this site any more. Reload to see the latest.' };
  const words = menuNameProblem(menus, id, typed);
  if (words) return { ok: false, words };
  const name = cleanMenuName(typed);
  if (name === String(menu.name ?? '')) return { ok: true, name, changed: false };
  const saved = deps.updateMenu ? deps.updateMenu(id, { name }) : null;
  if (deps.markBOChange) deps.markBOChange();
  return { ok: true, name, changed: true, was: String(menu.name ?? ''), saved };
}
