// src/lib/msm/msmManaged.js
//
// MULTI SITE MENU (17 Oct 2026, v5.11.75): which venue products the group menu manages at the
// venue this Back Office tab is on (public.msm_managed_items, design 1.8). Empty until it is read,
// and empty for every company that is not switched on, so nothing changes for them.
//
// Two readers:
//   * the sharing engine (store scheduleScopedPropagation) never fans a venue's edit of a managed
//     product out to the other sites: the group menu owns those values there, and a Global share
//     would otherwise spread one venue's edit over what head office published everywhere;
//   * Menu Manager says how many of this venue's products the group menu manages.
// The database stays the guard; this is the screen's knowledge of it.

let state = { locationId: null, ids: new Set() };
const listeners = new Set();

/** map: msmData.managedItems(...) (Map venueItemId -> {...}) or null (not read / not switched on). */
export function setMsmManaged(locationId, map) {
  state = { locationId: locationId || null, ids: new Set(map instanceof Map ? map.keys() : []) };
  for (const fn of listeners) { try { fn(state); } catch { /* a listener that throws changes nothing */ } }
}
export function isMsmManaged(id) {
  return !!id && state.ids.has(id);
}
export function msmManagedState() {
  return state;
}
export function subscribeMsmManaged(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
