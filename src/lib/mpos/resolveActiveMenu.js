// resolveActiveMenu — same priority chain as the desktop POSSurface uses for
// deviceMenuId, ported to MPOS so phone surfaces honour the same per-menu
// scheduling and device-pinning rules.
//
// Priority (matches POSSurface.jsx:164-198):
//   1. Device profile pinned menu, IF that menu is active right now
//   2. Highest-priority menu currently active by schedule
//   3. Default-flagged menu
//   4. Device profile pinned menu (even if its schedule says inactive)
//   5. null — show all categories (legacy behaviour)
//
// Returns the menu id or null.

import { buildScheduleCtx } from '../locationTime';

export function resolveActiveMenu({ menus, deviceConfig, timezone }) {
  if (!Array.isArray(menus) || menus.length === 0) return deviceConfig?.menuId || null;
  // v5.7.22 — schedules run on the VENUE's clock, never the phone's (same fix
  // as the desktop resolver in v5.7.20: a device on the wrong OS timezone was
  // evaluating the venue's menu windows hours out).
  const ctx = buildScheduleCtx(timezone || 'Europe/London');
  const day = ctx.isoDay || (new Date().getDay() || 7); // ISO Mon=1..Sun=7
  const time = ctx.nowMinutes;

  const isActive = (m) => {
    if (!m.schedule) return true;
    const s = m.schedule;
    if (s.days && Array.isArray(s.days) && !s.days.includes(day)) return false;
    if (s.from && s.to) {
      const [fh, fm] = s.from.split(':').map(Number);
      const [th, tm] = s.to.split(':').map(Number);
      const fromMin = fh * 60 + fm;
      const toMin = th * 60 + tm;
      if (fromMin <= toMin) return time >= fromMin && time <= toMin;
      // crosses midnight (e.g. 22:00–02:00)
      return time >= fromMin || time <= toMin;
    }
    return true;
  };

  const allMenus = menus.filter(m => m.isActive !== false && m.is_active !== false);
  const activeNow = allMenus.filter(isActive);
  const preferred = deviceConfig?.menuId;

  // 1. Device pinned + currently active
  if (preferred && activeNow.some(m => m.id === preferred)) return preferred;
  // 2. Highest-priority active
  if (activeNow.length > 0) {
    return activeNow.slice().sort((a, b) => (b.priority || 0) - (a.priority || 0))[0].id;
  }
  // 3. Default-flagged
  const def = allMenus.find(m => m.isDefault || m.is_default);
  if (def) return def.id;
  // 4. Device pinned even if inactive
  if (preferred) return preferred;
  // 5. Nothing matches
  return null;
}
