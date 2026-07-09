/**
 * ReservationSync — cross-device table reservations via a DEDICATED table (table_reservations).
 *
 * Deliberately ISOLATED from active_sessions / SessionSync: reservations live in their own table and
 * their own realtime channel, and the apply logic below NEVER touches a table that has a live order
 * (`t.session`). So a reservation can never downgrade, wipe, or be mistaken for a live order — the
 * "tables MUST never be lost" invariant is untouched by anything here.
 *
 * A reservation only ever moves a table between `available` <-> `reserved`. Seating (which creates a
 * session) and clearing are handled by SessionSync; here we just delete the reservation row when the
 * table stops being reserved.
 */

import { supabase, getLocationId } from '../lib/supabase';
import { useStore } from '../store';
import { isTrainingMode } from '../lib/trainingMode';

let _locationId = null;
let _debounceTimer = null;
let _channel = null;
let _pollTimer = null;
let _lastSent = {}; // table_id -> JSON string of the reservation we last wrote (or 'deleted')

async function _resolveLoc() {
  if (!_locationId) { try { _locationId = await getLocationId(); } catch { _locationId = null; } }
  return (_locationId && _locationId !== 'loc-demo') ? _locationId : null;
}

// Apply an incoming reservation WITHOUT ever overriding a live order or a newer local reservation.
function _applyReservation(tableId, reservation) {
  useStore.setState(s => ({
    tables: s.tables.map(t => {
      if (t.id !== tableId) return t;
      if (t.session) return t;                                   // occupied — a live order ALWAYS wins
      const localAt = t.reservation?.reservedAt || 0;
      const incomingAt = reservation?.reservedAt || 0;
      if (t.reservation && localAt > incomingAt) return t;       // our local reservation is newer
      return { ...t, reservation, status: 'reserved' };
    }),
  }));
}

function _clearReservation(tableId) {
  useStore.setState(s => ({
    tables: s.tables.map(t => {
      if (t.id !== tableId) return t;
      if (t.session) return t;                                   // occupied — leave it be
      if (t.status !== 'reserved' && !t.reservation) return t;   // nothing to clear
      return { ...t, reservation: null, status: 'available' };
    }),
  }));
}

// Boot / reconnect / periodic: RECONCILE this location's reservations against the DB. Apply every
// row, and clear any reservation we PREVIOUSLY synced that has since vanished from the DB (cancelled
// or seated on another device while we missed the realtime DELETE — realtime can drop events on a
// WS reconnect / sleep, exactly as SessionReconciler exists to cover for sessions). A fresh LOCAL
// reservation we haven't synced yet, or one we've edited since, is never cleared here.
export async function loadReservations() {
  if (isTrainingMode()) return;
  const loc = await _resolveLoc();
  if (!loc) return;
  const { data, error } = await supabase
    .from('table_reservations')
    .select('table_id, reservation')
    .eq('location_id', loc);
  if (error) return;
  const rows = data || [];
  const dbIds = new Set();
  for (const row of rows) {
    if (row.table_id && row.reservation) {
      dbIds.add(row.table_id);
      _lastSent[row.table_id] = JSON.stringify(row.reservation);
      _applyReservation(row.table_id, row.reservation);
    }
  }
  for (const tid of Object.keys(_lastSent)) {
    if (_lastSent[tid] === 'deleted' || dbIds.has(tid)) continue;
    const localT = useStore.getState().tables.find(t => t.id === tid);
    const localPayload = localT?.reservation ? JSON.stringify(localT.reservation) : null;
    if (localPayload && localPayload !== _lastSent[tid]) continue;   // local has an unflushed edit — leave it to flush
    _lastSent[tid] = 'deleted';
    _clearReservation(tid);
  }
}

// Push local reservation changes to the DB: upsert reserved tables, delete ones no longer reserved.
// _lastSent is latched ONLY after a confirmed write (supabase-js returns {error} instead of throwing
// on PostgREST/RLS errors), so a failed flush is retried on the next change / periodic reconcile
// instead of being silently dropped.
export async function flushReservations() {
  if (isTrainingMode()) return;
  const loc = await _resolveLoc();
  if (!loc) return;
  const tables = useStore.getState().tables;
  const reserved = tables.filter(t => t.reservation && !t.session && t.status === 'reserved');
  const reservedIds = new Set(reserved.map(t => t.id));

  const upserts = [];   // { tid, payload, row }
  for (const t of reserved) {
    const payload = JSON.stringify(t.reservation);
    if (_lastSent[t.id] === payload) continue;   // unchanged since our last confirmed write
    upserts.push({ tid: t.id, payload, row: { location_id: loc, table_id: t.id, reservation: t.reservation, updated_at: new Date().toISOString() } });
  }
  // Anything we previously wrote that is no longer reserved (seated or cancelled) → delete its row.
  const toDelete = Object.keys(_lastSent).filter(tid => !reservedIds.has(tid) && _lastSent[tid] !== 'deleted');

  try {
    if (upserts.length) {
      const { error } = await supabase.from('table_reservations').upsert(upserts.map(u => u.row), { onConflict: 'location_id,table_id' });
      if (error) console.warn('[ReservationSync] upsert error —', error.message);
      else upserts.forEach(u => { _lastSent[u.tid] = u.payload; });   // latch only on success
    }
    if (toDelete.length) {
      const { error } = await supabase.from('table_reservations').delete().eq('location_id', loc).in('table_id', toDelete);
      if (error) console.warn('[ReservationSync] delete error —', error.message);
      else toDelete.forEach(tid => { _lastSent[tid] = 'deleted'; });   // latch only on success
    }
  } catch (e) { console.warn('[ReservationSync] flush error —', e?.message || e); }
}

export function scheduleReservationFlush() {
  clearTimeout(_debounceTimer);
  _debounceTimer = setTimeout(flushReservations, 500);
}

// Live: apply reservations made / cancelled on other devices.
export async function subscribeToReservations() {
  const loc = await _resolveLoc();
  if (!loc || _channel) return;
  _channel = supabase
    .channel(`reservations:${loc}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'table_reservations', filter: `location_id=eq.${loc}` }, (payload) => {
      if (payload.eventType === 'DELETE') {
        const tid = payload.old?.table_id;
        if (!tid) return;
        _lastSent[tid] = 'deleted';
        _clearReservation(tid);
      } else {
        const tid = payload.new?.table_id;
        const reservation = payload.new?.reservation;
        if (!tid || !reservation) return;
        if (_lastSent[tid] === JSON.stringify(reservation)) return;   // echo of our own write
        _lastSent[tid] = JSON.stringify(reservation);
        _applyReservation(tid, reservation);
      }
    })
    .subscribe();

  // Self-heal net: realtime can miss events on a WS reconnect / device sleep (the same reason
  // sessions have SessionReconciler). A light periodic reconcile re-reads the DB (clearing anything
  // cancelled/seated elsewhere) and retries any write that previously failed. 30s — reservations
  // aren't latency-critical.
  if (!_pollTimer) {
    _pollTimer = setInterval(() => {
      loadReservations().catch(() => {});
      flushReservations().catch(() => {});
    }, 30000);
  }
}

export function teardownReservations() {
  clearTimeout(_debounceTimer);
  if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
  if (_channel) { try { supabase.removeChannel(_channel); } catch { /* best-effort */ } _channel = null; }
  _lastSent = {};
  _locationId = null;
}
