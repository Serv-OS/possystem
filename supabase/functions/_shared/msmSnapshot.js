// supabase/functions/_shared/msmSnapshot.js
//
// MULTI SITE MENU (17 Oct 2026, v5.11.75): the config push a publish sends a venue, so its
// tills refresh exactly as they do after Push to POS. Pure, tested (src/lib/msm/msmSnapshot.test.js).
//
// WHAT IT CARRIES
//   * The menu part: built from the venue's rows with publish's writes applied, through the SAME
//     mappers and menuSnapshotFromRead as Push to POS (venueMenuCore.js), so for the same rows the
//     menu part is the same, key for key.
//   * Product fields with no column (variantLabel, the pizza fields: ITEM_EXTRA_KEYS) copied from
//     the previous push's rows, as Push to POS copies them from the Back Office window.
//   * printRouting and printers READ FROM THE DATABASE (print_routing and printers, the same
//     mapping as Push to POS), never carried from the last push (review: two sources for one key
//     is the drift Peter has been burned by). Only when that read failed do they come from the
//     last push.
//   * Carried from the last push, ONLY keys whose authority lives in the Back Office browser and
//     that have no table: instructionGroupDefs (kiosk, online, catering, HubRise, menu-translate
//     read them from the latest push), locationSections (kiosk table picker), profiles (device
//     profiles), discountPresets, discountRules, packages, bookingRules, takeawayCustomerDetails.
//   * LEFT OUT on purpose (absent is a no-op on a till, store applyConfigUpdate): tables,
//     tableTombstones, tablePlan (an old plan can bring deleted tables back), quickScreenIds,
//     quickScreenMode, quickScreenAuto (the locations row is the authority; Smart Quick Screen
//     rule), changeCount.
//   * pushSource { kind: 'msm', versionId, title, applyWhenIdle }: old tills ignore unknown keys.
//   * A venue with no previous push gets a menu only push (every other key absent).

import { menuSnapshotFromRead, menuReadFromRaw, mapPrinterRow, printRoutingFromRow } from './venueMenuCore.js';

export const CARRY_KEYS = Object.freeze([
  'instructionGroupDefs', 'locationSections', 'profiles', 'discountPresets', 'discountRules',
  'packages', 'bookingRules', 'takeawayCustomerDetails',
]);
export const LEFT_OUT_KEYS = Object.freeze([
  'tables', 'tableTombstones', 'tablePlan', 'quickScreenIds', 'quickScreenMode', 'quickScreenAuto', 'changeCount',
]);

/**
 * Build the snapshot.
 *   raw         the venue (readVenueRaw shape) with publish's writes applied (planSite .applied
 *               merged over the read: use appliedRaw below)
 *   last        the venue's latest config_pushes.snapshot, or null
 *   pushSource  { versionId, title, applyWhenIdle }
 *   pushedBy    words for the push ("Multi site menu: <name>")
 *   now         ms (tests pass a fixed one)
 *   routingRead / printersRead   whether those two reads succeeded
 *   resort      true when the plan inserted rows (they are sorted in with the read's)
 */
export function buildMsmSnapshot({ raw, last = null, pushSource = {}, pushedBy = 'Multi site menu', now = Date.now(), routingRead = true, printersRead = true, resort = false }) {
  // resort: rows were inserted in memory, so put them in the database's order (sort_order, id).
  const read = menuReadFromRaw(raw, { resort });
  const menuPart = menuSnapshotFromRead(read, { extrasFrom: Array.isArray(last?.menuItems) ? last.menuItems : null });
  const snap = {};
  if (last && typeof last === 'object') {
    for (const k of CARRY_KEYS) if (last[k] !== undefined) snap[k] = last[k];
  }
  const routing = routingRead ? printRoutingFromRow(raw.printRouting) : null;
  if (routing) snap.printRouting = routing;
  else if (last?.printRouting) snap.printRouting = last.printRouting;
  if (printersRead && Array.isArray(raw.printers)) snap.printers = raw.printers.map(mapPrinterRow);
  else if (Array.isArray(last?.printers)) snap.printers = last.printers;
  return {
    ...snap,
    version: now,
    pushedAt: new Date(now).toISOString(),
    pushedBy,
    locationId: raw.locationId,
    ...menuPart,
    pushSource: {
      kind: 'msm',
      versionId: pushSource.versionId || null,
      title: pushSource.title || null,
      applyWhenIdle: pushSource.applyWhenIdle !== false,
    },
  };
}

/**
 * The raw venue with a plan's applied rows laid over it (menus, categories, items, groups,
 * printRouting), keeping the parts the planner never changes (tax, printers, location).
 */
export function appliedRaw(raw, plan) {
  const a = plan?.applied || {};
  return {
    ...raw,
    menus: a.menus || raw.menus,
    categories: a.categories || raw.categories,
    items: a.items || raw.items,
    links: a.links || raw.links,
    groups: a.groups || raw.groups,
    printRouting: a.printRouting === undefined ? raw.printRouting : a.printRouting,
  };
}

/** How many bytes the snapshot is as JSON (tills on 5.11.19+ read an over 1 MB push by id). */
export const snapshotBytes = (snap) => {
  try { return new TextEncoder().encode(JSON.stringify(snap)).length; } catch { return 0; }
};
