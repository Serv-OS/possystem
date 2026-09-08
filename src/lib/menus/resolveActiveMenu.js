// src/lib/menus/resolveActiveMenu.js. ONE resolver for "which menu is live right
// now", shared by the till (POSSurface), the kiosk, the phone (MMenu) and the
// online storefront. Before this file there were five copies of the chain and
// only the till's carried the v5.6.97 / v5.7.10 / v5.7.12 hardening, so the
// same schedule could resolve one way on the till and another on the kiosk.
//
// The chain below IS the POSSurface reference chain, verbatim in behaviour:
//   live menus (isActive / is_active !== false)
//   -> prefer menus with at least one top level category (when categories are
//      supplied; a links-only menu counts, see menusWithCategories)
//   -> pinned menu that is on schedule now
//   -> pinned menu off schedule falls to the default flagged menu, else stays
//      pinned (never the priority race, the Provo "only donuts" incident)
//   -> highest priority menu on now, the default menu breaks ties
//   -> default flagged menu
//   -> highest priority non empty live menu (the grid is never blank)
//   -> null (legacy: show every category)
//
// Venue-clock invariant: every schedule check goes through buildScheduleCtx
// with the venue's timezone. The device clock is never read for the decision.
// `now` exists ONLY so node --test can pin an instant; production callers omit it.
//
// Row shapes: menus arrive as normalised store rows (both spellings) on the
// till and phone, and as raw snake rows on the kiosk and online. Categories are
// camel on the till and phone, snake on kiosk and online. Every read below
// accepts both. Link rows are always snake ({ menu_id, category_id }).
//
// Window bounds are INCLUSIVE (<=), matching the till. discountEngine uses
// half-open windows for its own rules; do not "align" this one to it.

import { buildScheduleCtx } from '../scheduleCtx.js';
import { menusWithCategories } from '../menuMembership.js';

const DEFAULT_TZ = 'Europe/London';

/**
 * Build the schedule context the resolver evaluates against.
 * Returns { nowMinutes, isoDay, ymd, day } in the venue's timezone, where
 * `day` is the ISO day (Mon=1 .. Sun=7) with the same fallback the till used
 * when Intl could not name the weekday.
 */
export function buildMenuScheduleCtx(timezone, now) {
  const at = (now instanceof Date && !Number.isNaN(now.getTime())) ? now : new Date();
  const ctx = buildScheduleCtx(timezone || DEFAULT_TZ, at);
  return { ...ctx, day: ctx.isoDay || (at.getDay() || 7) };
}

/**
 * Is this menu on schedule at `ctx`? ctx comes from buildMenuScheduleCtx (or
 * any { nowMinutes, isoDay } shaped object, e.g. a test fixture).
 *   - no schedule: always on
 *   - days: coerced to numbers; an EMPTY array means every day (v5.7.10)
 *   - from/to: 'HH:MM'; an unparsable window keeps the menu visible; a window
 *     whose from is after its to crosses midnight; bounds are inclusive
 */
export function isMenuActiveNow(menu, ctx) {
  if (!menu) return false;
  const s = menu.schedule;
  if (!s || typeof s !== 'object') return true;
  const day = (ctx && (ctx.day || ctx.isoDay)) || (new Date().getDay() || 7);
  const time = ctx && Number.isFinite(ctx.nowMinutes) ? ctx.nowMinutes : buildMenuScheduleCtx().nowMinutes;
  if (s.days && Array.isArray(s.days) && s.days.length && !s.days.map(Number).includes(day)) return false;
  if (s.from && s.to) {
    const [fh, fm] = String(s.from).split(':').map(Number);
    const [th, tm] = String(s.to).split(':').map(Number);
    const fromMin = fh * 60 + fm;
    const toMin = th * 60 + tm;
    if (!Number.isFinite(fromMin) || !Number.isFinite(toMin)) return true; // unparsable window = never hide the menu
    if (fromMin <= toMin) return time >= fromMin && time <= toMin;
    // crosses midnight (e.g. 22:00 to 02:00)
    return time >= fromMin || time <= toMin;
  }
  return true;
}

const isDefault = (m) => !!(m && (m.isDefault || m.is_default));
const prio = (m) => (m && m.priority) || 0;

/**
 * Resolve the live menu id.
 * @param {object} args
 * @param {Array}  args.menus         menu rows (store normalised or raw snake)
 * @param {Array}  [args.categories]  category rows; when supplied, menus with no
 *                                    top level category are skipped (never-blank)
 * @param {Array}  [args.links]       menu_category_links rows (snake)
 * @param {string} [args.pinnedMenuId] device profile / preset pin
 * @param {string} [args.timezone]    venue timezone (locations.timezone)
 * @param {Date}   [args.now]         tests only; evaluate at this instant
 * @returns {string|null} menu id, or null meaning "show every category"
 */
export function resolveActiveMenu({ menus, categories, links, pinnedMenuId, timezone, now } = {}) {
  const ctx = buildMenuScheduleCtx(timezone, now);
  const liveMenus = (Array.isArray(menus) ? menus : []).filter(
    m => m && m.isActive !== false && m.is_active !== false
  );
  // Never resolve to a menu that has no categories. An empty menu (a half built
  // "New Test" menu that is still active) would otherwise win the schedule or
  // priority race and blank the grid. Only applied when the caller supplied
  // categories; a links-only menu counts as non empty (v5.6.97).
  let allMenus = liveMenus;
  if (Array.isArray(categories)) {
    const withCatsSet = menusWithCategories(categories, links || []);
    const withCats = liveMenus.filter(m => withCatsSet.has(m.id));
    allMenus = withCats.length ? withCats : liveMenus;
  }
  const activeNow = allMenus.filter(m => isMenuActiveNow(m, ctx));
  const preferred = pinnedMenuId || null;
  const preferredOk = !!preferred && allMenus.some(m => m.id === preferred); // the pin must itself be live and non empty

  // 1. Pinned to a live, non empty menu that is on schedule now: honour it.
  if (preferredOk && activeNow.some(m => m.id === preferred)) return preferred;
  // 1b. Pinned but off schedule: the pin is an operator statement of intent, so
  // fall to the venue's default menu if one is flagged, otherwise keep the pin.
  // Never the priority race (v5.7.10).
  if (preferredOk) {
    const defForPinned = allMenus.find(isDefault);
    return defForPinned ? defForPinned.id : preferred;
  }
  // 2. Highest priority menu on now; the default menu breaks ties so equal
  // priority always-on menus do not depend on load order (v5.7.12).
  if (activeNow.length > 0) {
    return activeNow.slice().sort((a, b) =>
      (prio(b) - prio(a)) || ((isDefault(b) ? 1 : 0) - (isDefault(a) ? 1 : 0))
    )[0].id;
  }
  // 3. Nothing on schedule: the default flagged menu.
  const def = allMenus.find(isDefault);
  if (def) return def.id;
  // 4. Any live (non empty when known) menu, highest priority, so the surface
  // is never blank when items exist.
  if (allMenus.length) return allMenus.slice().sort((a, b) => prio(b) - prio(a))[0].id;
  // 5. Nothing at all: show every category (legacy behaviour).
  return null;
}
