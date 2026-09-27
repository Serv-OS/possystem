// boVenueBoot.js: a Back Office page holds ONE venue's data, the venue it resolved.
//
// Peter, 27 Sep 2026: "for some reason every products tax rate has been removed
// but they where there earlier ... please chase". Part of what the chase found:
// in Back Office mode SyncBridge boots at page load for getActiveLocationSync()
// (rpos-bo-location, else the venue this browser is paired to as a till), and
// applies THAT venue's last push: tax rates, discount presets, auto discount
// rules, packages. BackOfficeApp then resolves its own venue (the stored choice,
// else the signed in person's profile venue) and reads only its menu and tax
// set up over the top (store loadVenueMenu); the discounts and packages stayed
// the other venue's. Sign out removes rpos-bo-location, so a browser paired at Train Station
// and signed in for Leeds held Train Station's rates and discounts (and Provo's
// rules and packages, from another organisation) as if they were Leeds', and
// every Leeds push from 26 Sep 06:47 carried them to the Leeds tills.
//
// The rule: when the venue Back Office resolves is not the one SyncBridge
// booted for, the page reloads ONCE with the resolved venue stored, so the boot
// runs for the right venue (the same thing the venue switcher does). If it
// still differs after that one reload, nothing loops: the other venue's slices
// are cleared instead and Back Office loads its own.
//
// Pure: the storage is passed in, so node:test proves it.

export const BO_VENUE_RELOAD_KEY = 'rpos-bo-venue-reload';

const same = (a, b) => a != null && b != null && String(a) === String(b);

/**
 * What Back Office must do once it knows its venue.
 * @returns {'none'|'reload'|'purge'}
 */
export function boVenueBootAction({ bootedFor, venue, reloadedFor }) {
  if (!venue || !bootedFor || same(bootedFor, venue)) return 'none';
  if (same(reloadedFor, venue)) return 'purge';
  return 'reload';
}

/**
 * Rows of a slice that may belong to `venue`: those tagged with it, or with no
 * tag at all (older rows). Packages carry their venue (locationId), and every
 * Leeds push from 26 Sep 06:47 carried Provo's two packages (another
 * organisation) tagged with Provo's venue id; they are dropped here, both when
 * a push is built and when a till takes one. Without a venue, nothing is dropped.
 */
export function venueRowsOnly(rows, venue) {
  if (!Array.isArray(rows)) return [];
  if (!venue) return rows;
  return rows.filter((r) => r && (r.locationId == null || same(r.locationId, venue)) && (r.location_id == null || same(r.location_id, venue)));
}

/** The slices a push from another venue leaves behind that Back Office does not reload itself. */
export function foreignVenueSlices() {
  return {
    taxRates: [],
    taxProfiles: [],
    venueDefaultTaxProfileId: null,
    discountPresets: [],
    discountRules: [],
    packages: [],
  };
}

/**
 * Decide, remember and say what to do. `storage` is sessionStorage (or a fake):
 * the one reload is remembered per tab, so it can never loop.
 */
export function settleBoVenue({ bootedFor, venue, storage }) {
  let reloadedFor = null;
  try { reloadedFor = storage?.getItem(BO_VENUE_RELOAD_KEY) || null; } catch { reloadedFor = null; }
  const action = boVenueBootAction({ bootedFor, venue, reloadedFor });
  if (action === 'reload') {
    // Reload only when the marker is really kept: a tab that cannot remember it would reload
    // forever, so it clears the other venue's slices instead.
    try {
      storage.setItem(BO_VENUE_RELOAD_KEY, String(venue));
      if (storage.getItem(BO_VENUE_RELOAD_KEY) === String(venue)) return 'reload';
    } catch { /* fall through */ }
    return 'purge';
  }
  if (action === 'none') { try { storage?.removeItem(BO_VENUE_RELOAD_KEY); } catch { /* nothing to forget */ } }
  return action;
}
