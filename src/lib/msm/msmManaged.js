// src/lib/msm/msmManaged.js
//
// MULTI SITE MENU (17 Oct 2026, v5.11.75): which venue products AND option groups the group menu
// manages at the venue this Back Office tab is on (public.msm_managed_items and, from round 2,
// public.msm_managed_groups; design 1.8 and 1.10). Empty until it is read, and empty for every
// company that is not switched on, so nothing changes for them.
//
// Readers:
//   * the sharing engine (store scheduleScopedPropagation and scheduleGroupPropagation) never fans
//     a venue's edit of a managed product or group out to the other sites: the group menu owns
//     those values there;
//   * the store's sub item rename cascade never renames options inside a managed group;
//   * Menu Manager says how many of this venue's products the group menu manages (and, builder 3,
//     locks the fields head office owns).
//
// THE TARGET SIDE GATE (round 2, design review blocker 1)
//   The list above is only this tab's own venue, and only once it has loaded. The sharing engine
//   writes at OTHER venues (shareModifierGroupsToLocation, a Global product's copies, a re-send),
//   so before it writes at a venue it asks the database afresh which groups and products the group
//   menu manages THERE (public.msm_managed_at) and skips every one of them, in words. If that read
//   fails while the company is (or may be) switched on, nothing is copied there (fail closed);
//   before the round 2 database file has run, the engine works exactly as before.
// The database stays the guard for publish; this is the screen's knowledge of it.

import { isNotInstalled } from '../../../supabase/functions/_shared/msmAccess.js';

let state = { locationId: null, ids: new Set(), kept: new Map(), groups: new Set(), groupKept: new Map(), groupOptions: new Map() };
// What the last successful read said about the company being switched on: true, false, or null
// (not known yet). A failed gate read only lets the sharing engine through when it is false.
let knownOn = null;
const listeners = new Set();

/**
 * items:  msmData.managedItems(...) (Map venueItemId -> { productId, kept }) or null
 * groups: msmData.managedGroups(...) (Map venueGroupId -> { groupId, kept, optionIds }) or null
 * on:     true / false when known (msm_managed_at), else leave out
 */
export function setMsmManaged(locationId, items, groups = null, on = undefined) {
  state = {
    locationId: locationId || null,
    ids: new Set(items instanceof Map ? items.keys() : []),
    kept: new Map(items instanceof Map ? [...items.entries()].map(([k, v]) => [k, v?.kept || []]) : []),
    groups: new Set(groups instanceof Map ? groups.keys() : []),
    groupKept: new Map(groups instanceof Map ? [...groups.entries()].map(([k, v]) => [k, v?.kept || []]) : []),
    groupOptions: new Map(groups instanceof Map ? [...groups.entries()].map(([k, v]) => [k, new Set(v?.optionIds || [])]) : []),
  };
  if (on === true || on === false) knownOn = on;
  for (const fn of listeners) { try { fn(state); } catch { /* a listener that throws changes nothing */ } }
}
export function isMsmManaged(id) {
  return !!id && state.ids.has(id);
}
export function isMsmManagedGroup(id) {
  return !!id && state.groups.has(id);
}
export function msmManagedState() {
  return state;
}
export function subscribeMsmManaged(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Load the tab venue's lists in one go (Back Office calls it once the feature is installed).
 * isLive: () => boolean, false once the tab moved on (an older answer never replaces a newer one).
 */
export async function loadMsmManaged(api, locationId, isLive = () => true) {
  if (!api || !locationId) return;
  const [items, groups, at] = await Promise.all([
    api.managedItems(locationId),
    api.managedGroups ? api.managedGroups(locationId) : Promise.resolve(null),
    api.managedAt ? api.managedAt([locationId]) : Promise.resolve(null),
  ]);
  if (!isLive()) return;
  setMsmManaged(locationId, items, groups, at && at.ok ? at.on : undefined);
}

// ── The target side gate ────────────────────────────────────────────────────

// The pause before the second ask (tests set it to 0).
let managedRetryMs = 400;
export function setManagedRetryMsForTest(ms) { managedRetryMs = Number(ms) || 0; }


/**
 * Which groups and products the group menu manages at these venues, read afresh.
 *   client       the Ops Supabase client
 *   locationIds  the venues the sharing engine is about to write at
 * Returns { ok, notInstalled, on, groups: Map(loc -> Set(venue group ids)), items: Map(loc -> Set),
 * error }. Never throws.
 */
export async function readManagedAt(client, locationIds) {
  const locs = [...new Set((locationIds || []).filter(Boolean).map(String))];
  const empty = { ok: true, notInstalled: false, on: false, groups: new Map(), items: new Map(), error: null };
  if (!client || !locs.length) return empty;
  const call = async () => { try { return await client.rpc('msm_managed_at', { p_locations: locs }); } catch (e) { return { data: null, error: e }; } };
  let res = await call();
  // A short network blip fails only this check (an rpc POST is never resent by itself), while the
  // copies it gates would have been: ask once more before blocking (17 Oct verification). It is a
  // stable, read only function, so a second call is safe. Still blocked (fail closed) after that.
  if (res?.error && !isNotInstalled(res.error)) {
    await new Promise((r) => setTimeout(r, managedRetryMs));
    res = await call();
  }
  if (res?.error) return { ...empty, ok: false, notInstalled: isNotInstalled(res.error), error: res.error };
  const d = res?.data || {};
  const groups = new Map(), items = new Map();
  for (const r of Array.isArray(d.groups) ? d.groups : []) { if (!groups.has(r.location_id)) groups.set(r.location_id, new Set()); groups.get(r.location_id).add(r.venue_group_id); }
  for (const r of Array.isArray(d.items) ? d.items : []) { if (!items.has(r.location_id)) items.set(r.location_id, new Set()); items.get(r.location_id).add(r.venue_item_id); }
  const on = d.on === true;
  knownOn = on;
  return { ok: true, notInstalled: false, on, groups, items, error: null };
}

/**
 * What the sharing engine may do at one venue, from readManagedAt.
 * Returns { blocked, words, groups: Set, items: Set }.
 *   blocked  the read failed while the company is or may be switched on: copy nothing there
 *   groups / items  the venue ids to skip there (head office owns them)
 */
export function gateFor(read, locationId) {
  const none = { blocked: false, words: '', groups: new Set(), items: new Set() };
  if (!read) return none;
  if (!read.ok) {
    if (read.notInstalled || knownOn === false) return none;      // before 20261017c, or a company that is off
    return { ...none, blocked: true, words: 'could not check which products the group menu manages there, so nothing was copied. Try again in a minute.' };
  }
  return { blocked: false, words: '', groups: read.groups.get(String(locationId)) || new Set(), items: read.items.get(String(locationId)) || new Set() };
}

/** For tests: forget what was learned about the company. */
export function resetMsmManagedForTest() {
  knownOn = null;
  setMsmManaged(null, null, null);
  knownOn = null;
}
