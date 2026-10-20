// supabase/functions/_shared/hubriseAutoSync.js: what the HubRise reconcile run (every 2 minutes)
// sends to Deliveroo, Uber Eats and Just Eat by itself (v5.11.81, channel parity round 2).
//
// Peter, 19 Oct 2026: "fix it all please, we need to be bullet proof". Before this, a venue's menu
// reached HubRise only when someone pressed Push menu, so a multi site menu publish or a Menu
// Manager save never got there, and an item sold out by its daily count (an automatic 86) never
// reached the platforms (only a manual 86 tapped on a till did).
//
//   SOLD OUT (86) ITEMS, every connected venue: the run compares the venue's out of stock set
//   (eighty_six plus daily counts at 0, the set resyncInventory sends) with the set it last sent
//   (hubrise_connections.inventory_ids) and sends ONLY THE DIFFERENCE as a PATCH. A PATCH never
//   touches anything else in the HubRise inventory, so a venue whose HubRise catalog is managed
//   somewhere else keeps everything it set there. The FIRST run only records the venue's current
//   set and sends nothing: a venue's old 86 rows are never pushed to the platforms all at once on
//   the day this goes live (a till's 86 tap has always gone at once, and still does). HubRise
//   refusing a change (a 4xx, e.g. refs its catalog does not hold) is recorded and not retried;
//   a network or HubRise failure (5xx) is tried again on the next run.
//
//   THE MENU, only where ServOS already owns the HubRise catalog (Push menu has been pressed at
//   least once: catalog_pushed_at is set) and nobody switched it off (auto_catalog false). A
//   catalog push REPLACES the whole HubRise catalog, so ServOS never pushes one to a venue whose
//   catalog is kept elsewhere. The run takes a cheap fingerprint of the venue's menu rows in the
//   database (hubrise_menu_fingerprint, migration 20261020a); when it changes it waits until the
//   menu has been still for QUIET_MS (a publish or a run of saves is one push, not twenty), then
//   pushes once. The push itself is skipped when the catalog it would send is the same as the last
//   one sent (catalogPayloadKey), so a save that changes nothing HubRise shows sends nothing.
//
// PURE: no imports, so node --test loads it (src/lib/parity/availability.parity.test.js).

export const QUIET_MS = 90_000;          // the menu must be still this long before a push
export const RETRY_MS = 15 * 60_000;     // after a failed automatic push, wait this long
export const MAX_PUSHES_PER_RUN = 2;     // catalog pushes (image uploads) per reconcile run

const ids = (list) => [...new Set((Array.isArray(list) ? list : []).filter((x) => x != null && x !== '').map(String))].sort();

/**
 * The 86 changes to send. prev: the ids last sent (null on the first run), next: the ids out of
 * stock now. { soldOut: ids to mark "0", back: ids to clear }. First run: nothing (the set is
 * recorded as the starting point).
 */
export function inventoryDelta(prev, next) {
  const now = ids(next);
  if (!Array.isArray(prev)) return { soldOut: [], back: [] };
  const was = new Set(ids(prev));
  const nowSet = new Set(now);
  return { soldOut: now.filter((id) => !was.has(id)), back: [...was].filter((id) => !nowSet.has(id)).sort() };
}

/**
 * The PATCH entries for a delta: each id as a product (sku_ref) and as an option (option_ref),
 * as the till's instant 86 push sends them (our catalog uses the item id for both).
 * skuOnly: the fallback when HubRise refuses unknown option refs.
 */
export function inventoryPatchEntries({ soldOut = [], back = [] } = {}, { skuOnly = false } = {}) {
  const sku = [...soldOut.map((id) => ({ sku_ref: id, stock: '0' })), ...back.map((id) => ({ sku_ref: id, stock: null }))];
  if (skuOnly) return sku;
  return [...sku, ...soldOut.map((id) => ({ option_ref: id, stock: '0' })), ...back.map((id) => ({ option_ref: id, stock: null }))];
}

/** After a failed PATCH: keep the set as sent (give up on it) only when HubRise refused it (4xx). */
export function giveUpOnInventoryError(err) {
  const status = Number(err && err.status);
  return Number.isFinite(status) && status >= 400 && status < 500;
}

/** May the run push this venue's menu by itself? Only a catalog ServOS already publishes. */
export function autoCatalogAllowed(conn) {
  return !!(conn && conn.status === 'connected' && conn.access_token && conn.hubrise_catalog_id
    && conn.catalog_pushed_at && conn.auto_catalog !== false
    && Object.prototype.hasOwnProperty.call(conn, 'menu_fingerprint'));
}

/**
 * What the run does with the menu now.
 *   'off'    not allowed (autoCatalogAllowed) or no fingerprint (migration not run)
 *   'note'   the menu changed since the last look: record the fingerprint and its time, wait
 *   'wait'   changed, not still for QUIET_MS yet, or a failed push less than RETRY_MS ago
 *   'push'   still for QUIET_MS and not what was last pushed: push it
 *   'idle'   what HubRise has is this menu
 */
export function catalogSyncStep(conn, fingerprint, nowMs, { quietMs = QUIET_MS, retryMs = RETRY_MS } = {}) {
  if (!autoCatalogAllowed(conn) || !fingerprint) return 'off';
  if (conn.menu_fingerprint !== fingerprint) return 'note';
  if (conn.catalog_fingerprint === fingerprint) return 'idle';
  const since = Date.parse(conn.menu_fingerprint_at || '');
  if (!Number.isFinite(since) || nowMs - since < quietMs) return 'wait';
  const tried = Date.parse(conn.catalog_auto_tried_at || '');
  if (conn.catalog_push_error && Number.isFinite(tried) && nowMs - tried < retryMs) return 'wait';
  return 'push';
}

// FNV-1a over the UTF-16 code units, two seeds, as 16 hex characters. Deterministic everywhere.
function fnv(text, seed) {
  let h = seed >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** A short key for the catalog document a push would send (same document, same key). */
export function catalogPayloadKey(data) {
  const text = JSON.stringify(data ?? null);
  return fnv(text, 0x811c9dc5) + fnv(text, 0x01234567) + ':' + text.length;
}
