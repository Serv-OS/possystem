// resolveActiveMenu (MPOS shim). The real resolver now lives in
// src/lib/menus/resolveActiveMenu.js and is shared by the till, the kiosk, the
// phone and the online storefront. This file only maps the OLD MPOS signature
// ({ menus, deviceConfig, timezone }) onto the shared one so any caller that
// was missed keeps working, and gains the till's hardening (string days, empty
// days, unparsable windows, empty menu skip, pinned off schedule falls to the
// default, default breaks priority ties) in the process.
//
// Import the shared lib directly in new code:
//   import { resolveActiveMenu } from '../menus/resolveActiveMenu';

import { resolveActiveMenu as resolveShared } from '../menus/resolveActiveMenu.js';

export { isMenuActiveNow, buildMenuScheduleCtx } from '../menus/resolveActiveMenu.js';

export function resolveActiveMenu({ menus, deviceConfig, timezone, categories, links, pinnedMenuId, now } = {}) {
  return resolveShared({
    menus,
    categories,
    links,
    pinnedMenuId: pinnedMenuId ?? deviceConfig?.menuId ?? null,
    timezone,
    now,
  });
}
