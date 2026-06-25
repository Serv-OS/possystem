/**
 * SessionSync — writes active table sessions to Supabase in real-time
 * so ALL devices (Sunmi, browser, etc.) always see the same open orders.
 *
 * Architecture:
 * - On every meaningful table state change → debounced upsert to active_sessions
 * - On boot → load all active_sessions for this location and apply to store
 * - Supabase Realtime subscription → apply incoming changes from other devices instantly
 */

import { supabase, getLocationId } from '../lib/supabase';
import { queueWrite, isOnline } from './OfflineQueue';
import { useStore } from '../store';

let _locationId = null;
let _debounceTimer = null;
let _realtimeChannel = null;
let _lastSent = {}; // table_id → JSON string, avoid redundant writes
let _clearedAt = {}; // table_id → timestamp when first noticed as available (grace period)
let _graceTimer = null;

// ── Write ─────────────────────────────────────────────────────────────────────
export async function flushSessions() {
  // v4.5.0: log every entry + every short-circuit. Silent failures here cost us a real
  // order on 25 Apr 2026 (active_sessions writes were never firing for hours and we
  // had no visibility because the function returned silently).
  if (!_locationId) {
    try { _locationId = await getLocationId(); }
    catch (e) {
      console.warn('[SessionSync] flushSessions: getLocationId() threw —', e?.message || e);
      return;
    }
  }
  if (!_locationId) {
    console.warn('[SessionSync] flushSessions: no locationId resolved, skipping all writes');
    return;
  }

  const tables = useStore.getState().tables;
  const occupied = tables.filter(t => t.session && t.status !== 'available');
  let writesIssued = 0, skipped = 0;

  // Scale: collect changed sessions and fire ONE batched upsert (and one batched delete below)
  // instead of a network round-trip per table — a 200-table venue otherwise emits ~200 upserts
  // per debounced flush. The durable per-row queueWrite stays (offline replay attribution); the
  // localStorage backup is read once and written once. All guards (echo-suppress, grace period,
  // delete instrumentation) are unchanged. Idempotent on (location_id,table_id).
  let _backup = {};
  try { _backup = JSON.parse(localStorage.getItem('rpos-session-backup') || '{}'); } catch { _backup = {}; }
  let _backupDirty = false;
  const upsertRows = [];

  // Upsert each occupied table (collect — single write issued after the delete pass)
  for (const t of occupied) {
    delete _clearedAt[t.id]; // v5.5.283: clear grace period if table re-occupied
    const payload = JSON.stringify(t.session);
    if (_lastSent[t.id] === payload) { skipped++; continue; } // no change
    _lastSent[t.id] = payload;
    writesIssued++;

    _backup[t.id] = t.session; _backupDirty = true;   // batched backup (written once below)
    const row = { location_id: _locationId, table_id: t.id, session: t.session, updated_at: new Date().toISOString() };
    queueWrite({ type: 'upsert', table: 'active_sessions', payload: row, onConflict: 'location_id,table_id' });
    upsertRows.push(row);
  }

  // Clear sessions for tables that are now available (order complete/cleared)
  const availableIds = tables
    .filter(t => t.status === 'available' || !t.session)
    .map(t => t.id);


  // v4.5.2 INSTRUMENTATION: log every active_sessions delete with stack trace.
  // T2 was lost overnight 25→26 Apr; we need to know which call path triggers
  // status='available' or session=null on a table that previously had an open session.
  if (availableIds.length > 0) {
    const stack = new Error('session-delete-trace').stack;
    const tableInfo = availableIds.map(tid => {
      const t = tables.find(x => x.id === tid);
      return { id: tid, label: t?.label, status: t?.status, hasSession: !!t?.session };
    });
    const willActuallyDelete = availableIds.filter(tid => _lastSent[tid] && _lastSent[tid] !== 'cleared');
    if (willActuallyDelete.length > 0) {
      console.warn('[SessionSync] About to DELETE active_sessions row(s) for tables:', willActuallyDelete.join(', '));
      console.warn('[SessionSync] Table info:', tableInfo);
      console.warn('[SessionSync] Stack trace:', stack);
      try {
        const log = JSON.parse(localStorage.getItem('rpos-session-delete-log') || '[]');
        log.push({
          ts: Date.now(),
          tsISO: new Date().toISOString(),
          tableIds: willActuallyDelete,
          tableInfo,
          stack: (stack || '').split('\n').slice(0, 15).join('\n'),
          docVisible: typeof document !== 'undefined' ? document.visibilityState : '?',
          online: typeof navigator !== 'undefined' ? navigator.onLine : '?',
        });
        localStorage.setItem('rpos-session-delete-log', JSON.stringify(log.slice(-20)));
      } catch {}
    }
  }

  const toDelete = [];
  for (const tid of availableIds) {
    // Only clear a row THIS device actually wrote a session for. _lastSent[tid] is set when we
    // upsert a table's session (and by loadSessions / the realtime handler on a full POS). If it's
    // undefined, this device never owned that table — deleting it would wipe ANOTHER device's live
    // session. This was the cross-device data-loss bug: the waitlist host stand (whose store.tables
    // is just a 30s poll snapshot, _lastSent empty) ran flushSessions on every seat and deleted the
    // POS's occupied tables, so an occupied table vanished from the shared active_sessions table and
    // every other device showed it as open. This now matches the willActuallyDelete instrumentation
    // filter above ('cleared' means we already deleted it).
    const prevSent = _lastSent[tid];
    if (prevSent && prevSent !== 'cleared') {
      // v5.5.283: Grace period — don't delete within 3s of first noticing
      // the table is available. This prevents cascading data loss where a
      // momentary session clear (from a realtime event race) becomes permanent.
      if (!_clearedAt[tid]) _clearedAt[tid] = Date.now();
      if (Date.now() - _clearedAt[tid] < 3000) {
        if (!_graceTimer) {
          _graceTimer = setTimeout(() => { _graceTimer = null; flushSessions(); }, 3500);
        }
        continue;
      }
      delete _clearedAt[tid];
      _lastSent[tid] = 'cleared';
      if (_backup[tid] !== undefined) { delete _backup[tid]; _backupDirty = true; }   // batched backup removal
      queueWrite({ type: 'delete', table: 'active_sessions', match: { location_id: _locationId, table_id: tid } });
      toDelete.push(tid);
    }
  }

  // ── one backup write + one batched upsert + one batched delete (was per-row) ──
  if (_backupDirty) { try { localStorage.setItem('rpos-session-backup', JSON.stringify(_backup)); } catch {} }
  if (isOnline()) {
    if (upsertRows.length) {
      Promise.resolve(supabase.from('active_sessions').upsert(upsertRows, { onConflict: 'location_id,table_id' }))
        .then(res => { if (res?.error) console.warn('[SessionSync] batch upsert error —', res.error.message || res.error);
                       else console.log('[SessionSync] ✓ wrote ' + upsertRows.length + ' session(s) to active_sessions'); })
        .catch(e => console.warn('[SessionSync] batch upsert threw —', e?.message || e));
    }
    if (toDelete.length) {
      Promise.resolve(supabase.from('active_sessions').delete().eq('location_id', _locationId).in('table_id', toDelete))
        .then(res => { if (res?.error) console.warn('[SessionSync] batch delete error —', res.error.message || res.error); })
        .catch(e => console.warn('[SessionSync] batch delete threw —', e?.message || e));
    }
  }
  // v4.5.0: summary line so we can see at a glance whether the flush actually fired
  console.log('[SessionSync] flushSessions done — issued ' + writesIssued + ' write(s), skipped ' + skipped + ' (unchanged), occupied tables: ' + occupied.length);
}

// Debounce writes — don't hammer Supabase on every keystroke
export function scheduleFlush() {
  clearTimeout(_debounceTimer);
  _debounceTimer = setTimeout(flushSessions, 600);
}

// v5.5.639 SELF-HEAL — re-publish a still-occupied table whose active_sessions row was
// removed OUT-OF-BAND (a stale OfflineQueue delete replay, a cross-device delete sweep, or any
// server-side removal). flushSessions' line ~57 skip — `if (_lastSent[t.id] === payload) continue`
// — otherwise NEVER re-writes that row, because this device's in-memory session is byte-identical
// to what it last sent. The row stays absent from the shared active_sessions that the waitlist host
// stand (and every other device) reads, so an occupied table silently disappears from the floor —
// the recurring "tables lost on the waitlist" bug. Dropping the _lastSent key (NOT setting it to
// 'cleared', which would suppress the write) forces the next flush to re-upsert the table.
// Called by SessionReconciler (10s poll) and realtime.js's DELETE handler whenever the DB says a
// table is gone but this device still holds its live session. The CALLERS gate on a genuinely-live
// session, so this never resurrects a legitimately-closed/empty table.
export function reassertSession(tableId) {
  if (!tableId) return;
  delete _lastSent[tableId];
  scheduleFlush();
}

// Persist ONE table's session to active_sessions WITHOUT the full sync sweep.
//
// Used by the waitlist host stand when it seats a party. The host stand renders without SyncBridge
// and its store.tables is a 30s poll snapshot of the floor — so it must NEVER run the global
// flushSessions(), which writes AND deletes EVERY table from that partial/stale view and was wiping
// POS-seated tables (a cross-device "tables never lost" violation). This upserts only the given
// table and never deletes anything, so the host stand can add a seat without ever touching another
// device's tables.
export async function flushSingleSession(tableId) {
  if (!tableId) return;
  if (!_locationId) {
    try { _locationId = await getLocationId(); } catch { return; }
  }
  if (!_locationId) return;
  const t = (useStore.getState().tables || []).find((x) => x.id === tableId);
  if (!t || !t.session) return;

  _lastSent[t.id] = JSON.stringify(t.session);
  try {
    const backup = JSON.parse(localStorage.getItem('rpos-session-backup') || '{}');
    backup[t.id] = t.session;
    localStorage.setItem('rpos-session-backup', JSON.stringify(backup));
  } catch { /* backup best-effort */ }

  const row = { location_id: _locationId, table_id: t.id, session: t.session, updated_at: new Date().toISOString() };
  queueWrite({ type: 'upsert', table: 'active_sessions', payload: row, onConflict: 'location_id,table_id' });
  if (isOnline()) {
    try {
      const { error } = await supabase.from('active_sessions').upsert(row, { onConflict: 'location_id,table_id' });
      if (error) console.warn('[SessionSync] flushSingleSession upsert error —', error.message || error);
      else console.log('[SessionSync] ✓ persisted single session for table', t.label || t.id);
    } catch (e) { console.warn('[SessionSync] flushSingleSession threw —', e?.message || e); }
  }
}

// ── Load on boot ──────────────────────────────────────────────────────────────
export async function loadSessions() {
  if (!_locationId) _locationId = await getLocationId().catch(() => null);
  if (!_locationId) return;

  const { data, error } = await supabase
    .from('active_sessions')
    .select('table_id, session, updated_at')
    .eq('location_id', _locationId);

  if (error || !data?.length) return;

  const store = useStore.getState();
  const tables = [...store.tables];
  let changed = false;

  for (const row of data) {
    const idx = tables.findIndex(t => t.id === row.table_id);
    if (idx === -1) continue;
    // Only apply if the session is newer than what we have
    const existing = tables[idx].session;
    const incomingTime = new Date(row.updated_at).getTime();
    const existingTime = existing?.seatedAt || 0;
    if (!existing || incomingTime > existingTime) {
      tables[idx] = { ...tables[idx], session: row.session, status: 'occupied' };
      _lastSent[row.table_id] = JSON.stringify(row.session);
      changed = true;
    }
  }

  if (changed) {
    useStore.setState({ tables });
    console.log(`[SessionSync] Loaded ${data.length} active session(s) from Supabase`);
  }
}

// ── Realtime subscription ──────────────────────────────────────────────────────
export async function subscribeToSessions() {
  if (!_locationId) _locationId = await getLocationId().catch(() => null);
  if (!_locationId) return;
  if (_realtimeChannel) return; // already subscribed

  _realtimeChannel = supabase
    .channel('active-sessions-sync')
    .on('postgres_changes', {
      event: '*',
      schema: 'public',
      table: 'active_sessions',
      filter: `location_id=eq.${_locationId}`,
    }, (payload) => {
      const store = useStore.getState();
      const tables = [...store.tables];

      if (payload.eventType === 'DELETE') {
        const tid = payload.old?.table_id;
        if (!tid) return;
        const idx = tables.findIndex(t => t.id === tid);
        if (idx === -1) return;
        // Only clear if we didn't originate this (avoid clearing our own active order)
        if (_lastSent[tid] === 'cleared') return;
        // v5.5.283: same guards as realtime.js DELETE handler — never clear
        // the active table or sessions newer than the deleted row
        const curState = useStore.getState();
        // v5.5.639: on every "keep" path the shared row was deleted out-of-band while we still hold
        // a live session — re-publish it (reassertSession drops the _lastSent latch + flushes) so the
        // row reconverges instead of staying absent forever.
        if (tid === curState.activeTableId) { reassertSession(tid); return; }
        const localTable = tables[idx];
        if (localTable?.session) {
          const localSeated = localTable.session.seatedAt || 0;
          const deletedSeated = payload.old?.session?.seatedAt || 0;
          if (deletedSeated && localSeated > deletedSeated) { reassertSession(tid); return; }
          if (!deletedSeated && localTable.session.items?.length > 0) { reassertSession(tid); return; }
        }
        tables[idx] = { ...tables[idx], session: null, status: 'available' };
        useStore.setState({ tables });
      } else {
        // INSERT or UPDATE
        const { table_id, session } = payload.new;
        if (!table_id || !session) return;
        const idx = tables.findIndex(t => t.id === table_id);
        if (idx === -1) return;
        // Don't overwrite our own writes
        if (_lastSent[table_id] === JSON.stringify(session)) return;
        tables[idx] = { ...tables[idx], session, status: 'occupied' };
        _lastSent[table_id] = JSON.stringify(session);
        useStore.setState({ tables });
        console.log(`[SessionSync] Received live update for table ${table_id}`);
      }
    })
    .subscribe();
}

export function teardown() {
  clearTimeout(_debounceTimer);
  clearTimeout(_graceTimer);
  if (_realtimeChannel) { supabase.removeChannel(_realtimeChannel); _realtimeChannel = null; }
  _lastSent = {};
  _clearedAt = {};
  _graceTimer = null;
  _locationId = null;
}
