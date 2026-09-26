// src/lib/localSessions.js
//
// THE VENUE FENCE FOR TABLE SESSIONS (v5.9.71, Peter 26 Sep 2026: "we cannot have data leak").
//
// What happened: Provo's four demo tables (T1 to T4, ORD-1003 and friends, seated in August)
// turned up as open orders at Coffee Boy Leeds, Barnsley and Barnsley Train Station. The
// carrier was one browser whose device record no longer existed, following the Back Office
// venue switch: switching venue wipes the location scoped localStorage keys (the tenant
// fence), but a POS tab still running with the OLD venue's tables in memory re-wrote
// rpos-session-backup afterwards, and on its next boot at the NEW venue the tag matched, the
// backup was restored and flushed, and the old venue's orders were published under the new
// venue's location_id. Every reader of the local stores took whatever was there.
//
// Three rules, all here so every reader and writer agrees:
//   1. The local stores carry their OWNER: rpos-session-loc holds the venue whose sessions
//      rpos-session-backup and rpos-session-snapshot hold. Every writer stamps it; a reader
//      for another venue gets nothing and the stores are cleared. A store from before this
//      release (no owner) is trusted only for tables on THIS venue's floor plan.
//   2. Every session carries its VENUE: session._loc, set once when the session is created
//      (or when it is read back from this venue's active_sessions rows), never overwritten.
//      A session tagged for another venue is never restored and never published.
//   3. A till publishes only for the venue it BOOTED for (store.bootLocationId): if the venue
//      resolves differently later (a Back Office switch in the same browser), SessionSync
//      refuses every write until the tab reloads at the new venue.
// The database side (migration 20260926a_OPS_active_sessions_venue_fence.sql, Peter's to run)
// refuses a row whose session._loc is not its location_id.
//
// Pure functions take the storage as an argument (node:test passes a fake); the defaults read
// the browser's localStorage.

export const BACKUP_KEY = 'rpos-session-backup';
export const SNAPSHOT_KEY = 'rpos-session-snapshot';
export const LOC_KEY = 'rpos-session-loc';

const browserStore = () => { try { return globalThis.localStorage || null; } catch { return null; } };
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** The session with its venue, set once. An existing tag is never changed. */
export function tagSession(session, locationId) {
  if (!isObj(session) || !locationId) return session;
  if (typeof session._loc === 'string' && session._loc) return session;
  return { ...session, _loc: String(locationId) };
}

/** May this session live at this venue? Untagged = yes (older sessions); tagged = only its own venue. */
export function sessionVenueOk(session, locationId) {
  if (!isObj(session)) return false;
  if (typeof session._loc !== 'string' || !session._loc) return true;
  return !!locationId && session._loc === String(locationId);
}

/** { kept, dropped } of a { tableId: session } map for one venue. */
export function keepVenueSessions(map, locationId, knownTableIds = null) {
  const kept = {};
  let dropped = 0;
  for (const [tid, sess] of Object.entries(isObj(map) ? map : {})) {
    if (!sess) continue;
    const tagged = typeof sess._loc === 'string' && sess._loc;
    const ok = tagged ? sess._loc === String(locationId) : (knownTableIds ? knownTableIds.has(tid) : false);
    if (ok) kept[tid] = sess; else dropped += 1;
  }
  return { kept, dropped };
}

export function localSessionsOwner(store = browserStore()) {
  try { return store ? (store.getItem(LOC_KEY) || null) : null; } catch { return null; }
}

/** Every writer of the local stores calls this with the venue the sessions belong to. */
export function stampLocalSessionsFor(locationId, store = browserStore()) {
  if (!store || !locationId) return;
  try { store.setItem(LOC_KEY, String(locationId)); } catch { /* storage full or blocked: the fence still holds at read time */ }
}

export function clearLocalSessions(store = browserStore()) {
  if (!store) return;
  for (const k of [BACKUP_KEY, SNAPSHOT_KEY, LOC_KEY]) { try { store.removeItem(k); } catch { /* best effort */ } }
}

/**
 * The device's local sessions FOR THIS VENUE: { backup, snapshot, foreign, owner, dropped }.
 *   owner == this venue     both stores, minus any session tagged for another venue
 *   owner == another venue  nothing, and the stores are cleared (rule 1)
 *   no owner (pre release)  untagged sessions only for tables in knownTableIds (this venue's
 *                           floor plan); nothing when the plan is unknown
 */
export function readLocalSessions(locationId, { knownTableIds = null, store = browserStore() } = {}) {
  const empty = { backup: {}, snapshot: {}, foreign: false, owner: null, dropped: 0 };
  if (!store || !locationId) return empty;
  const owner = localSessionsOwner(store);
  if (owner && owner !== String(locationId)) {
    clearLocalSessions(store);
    return { ...empty, foreign: true, owner };
  }
  let backup = {};
  let snapshot = {};
  try { backup = JSON.parse(store.getItem(BACKUP_KEY) || '{}') || {}; } catch { backup = {}; }
  try { const s = JSON.parse(store.getItem(SNAPSHOT_KEY) || '{}'); snapshot = (s && isObj(s.sessions)) ? s.sessions : {}; } catch { snapshot = {}; }
  // With an owner, an untagged session is this venue's (the owner says so); without one, only
  // a table on this venue's plan vouches for it.
  const vouch = owner ? new Set(Object.keys({ ...backup, ...snapshot })) : knownTableIds;
  const b = keepVenueSessions(backup, locationId, vouch);
  const sn = keepVenueSessions(snapshot, locationId, vouch);
  return { backup: b.kept, snapshot: sn.kept, foreign: false, owner: owner || null, dropped: b.dropped + sn.dropped };
}
