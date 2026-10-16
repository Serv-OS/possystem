// src/lib/bookings/standSessionSync.js
//
// THE SERVER DECIDES WHAT IS OPEN ON A HOST STAND (16 Oct 2026, Peter filming the bookings
// demo at the Provo demo venue).
//
// The till cashed off T1: its active_sessions row was deleted. The bookings host stand kept
// its own copy of T1's session, so "Seat now, open POS tab" refused with "Still has an open
// tab" while the till showed nothing open, and only a reload of the stand cleared it. Later
// the same stand seated a booking on T1, the row appeared on the server at once, and the
// stand still drew T1 as "booking active, no session".
//
// A host stand (Table Bookings, Tables Ready) is an anonymous paired device. It never owns a
// session: it seats a table and publishes that one row, then the till owns the check. So a
// stand has no reason to keep a local copy the server does not hold, and every 30 seconds it
// replaces tables[].session for EVERY floor table from active_sessions (null where no row).
// Tills do NOT run this: a till owns the table it is editing (unsent lines live only in its
// memory) and the SessionReconciler arbitrates for it.
//
// mergeServerSessions is pure (node tested). The I/O takes the client and the closed check
// predicate as arguments, so this file imports nothing and the test needs no browser.

export const STAND_SESSION_SYNC_MS = 30 * 1000;

// A seat this device made moments ago may not have landed on the server yet (the upsert is in
// flight). Within this window a local session with no server row is kept; after it, a session
// the server does not hold is gone (the write failed or the till cashed it off).
export const WRITE_GRACE_MS = 20 * 1000;

/**
 * True while a session seated at session.seatedAt is inside the write grace. A seatedAt in the
 * future (stamped by a device whose clock runs ahead) is never inside it: the grace would
 * otherwise last as long as that clock is ahead.
 */
export function withinWriteGrace(session, now = Date.now(), graceMs = WRITE_GRACE_MS) {
  const seatedAt = Number(session?.seatedAt) || 0;
  const age = now - seatedAt;
  return !!seatedAt && graceMs > 0 && age >= 0 && age < graceMs;
}

const sameJson = (a, b) => {
  if (a === b) return true;
  if (!a || !b) return false;
  try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
};

/**
 * The store's tables with each session replaced by the server's row.
 *
 *   tables   the store's tables (every floor table, split children included)
 *   rows     active_sessions rows for the venue: [{ table_id, session }]
 *   opts.tableIds      only these tables are touched (null = every table)
 *   opts.keepIds       tables never touched (a till's active table), Set or null
 *   opts.clearMissing  false = a table with no server row keeps its local copy (used right
 *                      after a seat, when this device's own write may still be queued)
 *   opts.isClosed      (tableId, session) => true for a cashed off ghost row; such a row counts
 *                      as no row
 *   opts.graceMs / opts.now   the write grace above
 *
 * Returns the SAME array when nothing changed, so a caller can skip the store write.
 */
export function mergeServerSessions(tables, rows, {
  tableIds = null, keepIds = null, clearMissing = true, isClosed = null,
  graceMs = WRITE_GRACE_MS, now = Date.now(),
} = {}) {
  const list = Array.isArray(tables) ? tables : [];
  const only = tableIds ? new Set(tableIds) : null;
  const server = new Map();
  for (const r of (Array.isArray(rows) ? rows : [])) {
    if (!r?.table_id || !r.session) continue;
    if (typeof isClosed === 'function' && isClosed(r.table_id, r.session)) continue;
    server.set(r.table_id, r.session);
  }
  let changed = false;
  const next = list.map((t) => {
    if (!t?.id) return t;
    if (only && !only.has(t.id)) return t;
    if (keepIds && keepIds.has(t.id)) return t;
    const srv = server.get(t.id) || null;
    if (srv) {
      if (sameJson(t.session, srv)) {
        if (t.status !== 'available') return t;
        changed = true;
        return { ...t, status: 'occupied' };       // same session, the colour was wrong
      }
      changed = true;
      return { ...t, session: srv, status: 'occupied' };
    }
    if (!t.session) return t;
    if (!clearMissing) return t;
    if (withinWriteGrace(t.session, now, graceMs)) return t;   // our own write may be in flight
    changed = true;
    return { ...t, session: null, status: 'available' };
  });
  return changed ? next : list;
}

/**
 * What a HOST STAND does with its copy of a table when an active_sessions DELETE arrives
 * (lib/realtime.js). Tills do not use this: they keep the delete handler as it was. Pure, so
 * every case is node tested.
 *
 *   localSession   the stand's copy of the table's session (null = none)
 *   serverRow      the table's row read back from the server ({ table_id, session }), null when
 *                  there is no row
 *   readFailed     true when the read errored: change nothing, the 30 second reconcile decides
 *   now            the clock, for the write grace
 *
 * Returns 'keep' (leave the local copy) or 'clear'. Never 'reassert': a stand never puts a
 * table back. A row keeps the copy; no row clears it, except a seat the stand made inside the
 * write grace (its own upsert may still be in flight), kept exactly as mergeServerSessions
 * keeps it.
 */
export function decideOnDelete({ localSession = null, serverRow = null, readFailed = false, now = Date.now() } = {}) {
  if (readFailed) return 'keep';
  if (!localSession) return 'clear';
  if (serverRow?.session) return 'keep';
  return withinWriteGrace(localSession, now) ? 'keep' : 'clear';
}

/** The venue's active_sessions rows (table_id, session), or null when they could not be read. */
export async function readServerSessions(client, locationId, tableIds = null) {
  if (!client || !locationId) return null;
  try {
    let q = client.from('active_sessions').select('table_id, session').eq('location_id', locationId);
    if (Array.isArray(tableIds) && tableIds.length) q = q.in('table_id', tableIds);
    const { data, error } = await q;
    if (error || !Array.isArray(data)) return null;
    return data;
  } catch { return null; }
}

// The device local stores (rpos-session-backup, rpos-session-snapshot) are read back by the
// Tables Ready floor poll. A table the server no longer holds comes out of them too, or the
// poll puts the ghost back 30 seconds later and the two readers fight.
function dropLocalCopies(tableIds, storage) {
  if (!storage || !tableIds.length) return;
  try {
    const backup = JSON.parse(storage.getItem('rpos-session-backup') || '{}') || {};
    let dirty = false;
    for (const id of tableIds) { if (backup[id] !== undefined) { delete backup[id]; dirty = true; } }
    if (dirty) storage.setItem('rpos-session-backup', JSON.stringify(backup));
  } catch { /* best effort */ }
  try {
    const snap = JSON.parse(storage.getItem('rpos-session-snapshot') || 'null');
    if (snap && snap.sessions && typeof snap.sessions === 'object') {
      let dirty = false;
      for (const id of tableIds) { if (snap.sessions[id] !== undefined) { delete snap.sessions[id]; dirty = true; } }
      if (dirty) storage.setItem('rpos-session-snapshot', JSON.stringify(snap));
    }
  } catch { /* best effort */ }
}

/** One pass: read the venue's rows, replace every floor table's session. True when a read happened. */
export async function reconcileStandSessions({ store, client, locationId, isClosed = null, storage = null } = {}) {
  if (!store || !locationId) return false;
  const rows = await readServerSessions(client, locationId);
  if (!rows) return false;
  const s = store.getState();
  const before = s.tables || [];
  const next = mergeServerSessions(before, rows, { isClosed });
  if (next !== before) {
    store.setState({ tables: next });
    const cleared = next.filter((t, i) => !t.session && before[i]?.session).map((t) => t.id);
    dropLocalCopies(cleared, storage);
  }
  return true;
}

/** Start the 30 second reconcile on a host stand. Returns the stop function. */
export function startStandSessionSync({ store, client, locationId, isClosed = null, storage = null, intervalMs = STAND_SESSION_SYNC_MS } = {}) {
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    reconcileStandSessions({ store, client, locationId, isClosed, storage }).catch(() => {});
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  return () => { stopped = true; clearInterval(timer); };
}
