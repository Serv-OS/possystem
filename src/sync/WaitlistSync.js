/**
 * WaitlistSync — writes "Tables Ready" waitlist entries to Supabase in real-time
 * so every host stand / POS / BO insights screen sees the same live queue
 * regardless of which device added or advanced a party.
 *
 * Direct clone of QueueSync.js (which handles the walk-in order queue + bar tabs).
 * Same shape:
 *   - optimistic debounced flush of the in-memory `waitlist` array
 *   - a `_lastSent` echo-suppression map keyed by entry id + updated_at signature
 *   - OfflineQueue.queueWrite (durable) + a parallel direct upsert through
 *     waitlistData.upsertWaitlistEntry (fast path while online)
 *   - a boot `loadWaitlistSync` that hydrates the store via a setter
 *   - a Supabase realtime apply (`applyWaitlistRealtimeEvent`) that mutates the
 *     store, with the same echo-suppress + DELETE-location-guard pattern.
 *
 * EVERYTHING here tolerates a missing relation: the Tables Ready migration
 * (20260623t_tables_ready_waitlist.sql) may not be applied yet on a given venue.
 * waitlistData.* already swallows table-absent / mock errors and returns
 * empty/null, so this module never throws at boot.
 */

import { getLocationId, isMock } from '../lib/supabase';
import { queueWrite, isOnline } from './OfflineQueue';
import { useStore } from '../store';
import { isTrainingMode } from '../lib/trainingMode';
import { waitlistToRow, isActive, STATUS } from '../lib/waitlist/waitlist';
import {
  loadWaitlist,
  upsertWaitlistEntries,
} from '../lib/waitlist/waitlistData';

let _locationId = null;
let _orgId = null;
let _debounceTimer = null;
// echo-suppress map: entry.id -> the payload signature we last sent, OR 'cleared'
// once the entry has left the live in-memory board (so a late realtime event for
// a now-dropped entry doesn't resurrect it).
let _lastSent = {};

// Terminal statuses are dropped from the live board (mirrors waitlistData.loadWaitlist's
// filter). We still PERSIST the terminal status (so the DB ledger is complete) on the
// flush that transitions into it, but afterwards the entry is no longer in the
// in-memory `waitlist`, so we mark its id 'cleared' and stop echoing it.
const _isLive = (e) => !!e && isActive(e.status);

// Stable signature for echo-suppression. We key on id + updated-ish fields rather
// than JSON.stringify of the whole row, because waitlistToRow includes added_at etc.
// that never change — but quoted/status/stamps DO, and those are the fields a remote
// device legitimately needs to apply. Stringifying the mapped row is the simplest
// faithful clone of QueueSync's approach and is exact (same row in → same string).
function sig(entry) {
  return JSON.stringify(waitlistToRow(entry, _locationId, _orgId));
}

async function _resolveOrg() {
  // org_id is best-effort: the row is location-scoped and RLS keys on location_id,
  // so a null org_id is acceptable. Pull it off any entry the store already linked,
  // else leave null. (waitlistToRow tolerates null org.)
  if (_orgId) return _orgId;
  try {
    const wl = useStore.getState().waitlist || [];
    const withOrg = wl.find((e) => e?.orgId);
    if (withOrg?.orgId) _orgId = withOrg.orgId;
  } catch { /* leave null */ }
  return _orgId;
}

// ── optimistic debounced flush ──────────────────────────────────────────────
export async function flushWaitlist() {
  if (isMock) return;
  // TRAINING MODE: don't write training waitlist parties to the shared queue.
  if (isTrainingMode()) return;
  if (!_locationId) _locationId = await getLocationId().catch(() => null);
  if (!_locationId || _locationId === 'loc-demo') return;
  await _resolveOrg();

  const state = useStore.getState();
  const waitlist = state.waitlist || [];

  const liveIds = new Set();
  const dirty = [];   // entries changed since last flush — batched into one upsert below
  for (const e of waitlist) {
    if (!e?.id) continue;
    // Persist every entry currently held in memory. The store keeps an entry in
    // `waitlist` only while it's relevant (active, or just transitioned), so this
    // naturally bounds what we write. A terminal-status entry that's still briefly
    // in memory gets one final persist, then drops out next render.
    liveIds.add(e.id);
    const payload = sig(e);
    if (_lastSent[e.id] === payload) continue;
    _lastSent[e.id] = payload;
    // Durable path stays per-row (offline replay attribution); the live network write is batched.
    queueWrite({
      type: 'upsert',
      table: 'waitlist_entries',
      payload: waitlistToRow(e, _locationId, _orgId),
      onConflict: 'id',
      kind: 'waitlist_entry',
      label: `Waitlist: ${e.name || 'Guest'} (party ${e.size || 1})`,
    });
    dirty.push(e);
  }
  // One batched upsert for every changed entry (was one round-trip per entry). table-absent-safe.
  if (isOnline() && dirty.length) {
    Promise.resolve(upsertWaitlistEntries(dirty, _locationId, _orgId))
      .then((res) => { if (res?.error) console.warn('[WaitlistSync] batch upsert:', res.error.message || res.error); })
      .catch((err) => console.warn('[WaitlistSync] batch upsert threw:', err?.message || err));
  }

  // Entries that have left the in-memory board: mark 'cleared' so a stale realtime
  // echo can't re-add them. We do NOT delete the DB row — terminal entries are the
  // historical ledger that Insights + quote-accuracy learning read from. (This is
  // the key divergence from QueueSync, which deletes collected orders.)
  for (const id of Object.keys(_lastSent)) {
    if (liveIds.has(id)) continue;
    _lastSent[id] = 'cleared';
  }
}

export function scheduleWaitlistFlush() {
  if (isMock) return;
  clearTimeout(_debounceTimer);
  _debounceTimer = setTimeout(flushWaitlist, 500);
}

// ── boot hydrate ────────────────────────────────────────────────────────────
export async function loadWaitlistSync() {
  if (isMock) return;
  if (!_locationId) _locationId = await getLocationId().catch(() => null);
  if (!_locationId || _locationId === 'loc-demo') return;
  await _resolveOrg();
  try {
    // waitlistData.loadWaitlist is table-absent-safe: returns { data: [] } if the
    // relation is missing. It already filters to live statuses, caps 500, orders
    // added_at asc.
    const { data } = await loadWaitlist(_locationId);
    const remote = Array.isArray(data) ? data : [];
    if (!remote.length) return;

    const local = useStore.getState().waitlist || [];
    const localIds = new Set(local.map((e) => e.id));
    const merged = [...local, ...remote.filter((r) => !localIds.has(r.id))];

    // Seed the echo-suppress map so our own boot-loaded rows don't immediately
    // round-trip back through the realtime handler as "new".
    remote.forEach((r) => { if (_isLive(r)) _lastSent[r.id] = sig(r); });

    // Hydrate via the store setter (the slice owns the merge semantics; falling
    // back to a raw setState keeps this resilient if the action name shifts).
    const setter = useStore.getState().hydrateWaitlist;
    if (typeof setter === 'function') setter(merged);
    else useStore.setState({ waitlist: merged });

    console.log(`[WaitlistSync] Loaded ${remote.length} waitlist entr${remote.length === 1 ? 'y' : 'ies'} from Supabase`);
  } catch (e) {
    console.warn('[WaitlistSync] load failed:', e?.message || e);
  }
}

// ── realtime apply (called by realtime.js for table waitlist_entries) ─────────
// payload: { eventType: 'INSERT'|'UPDATE'|'DELETE', new, old } — Supabase shape.
export function applyWaitlistRealtimeEvent(payload) {
  if (!payload) return;

  // DELETE: rare (terminal entries are kept, not deleted) but supported. Supabase
  // does not support row-level filters on DELETE, so location-guard client-side.
  if (payload.eventType === 'DELETE') {
    const old = payload.old || {};
    if (old.location_id && _locationId && old.location_id !== _locationId) return;
    const id = old.id;
    if (!id) return;
    if (_lastSent[id] === 'cleared') return;
    const state = useStore.getState();
    const wl = state.waitlist || [];
    const next = wl.filter((e) => e.id !== id);
    if (next.length !== wl.length) {
      _lastSent[id] = 'cleared';
      // Prefer the slice's apply (it may do bookkeeping); else raw setState.
      const apply = state.applyWaitlistRealtime;
      if (typeof apply === 'function') apply(payload);
      else useStore.setState({ waitlist: next });
    }
    return;
  }

  const row = payload.new;
  if (!row?.id) return;
  if (row.location_id && _locationId && row.location_id !== _locationId) return;

  // Echo-suppress: if this row is exactly what we last wrote, ignore it.
  // We can't call sig() on the raw snake_case row, so compare against the
  // round-tripped signature via the store's mapper inside applyWaitlistRealtime.
  // Here we do a cheap pre-check on updated_at to short-circuit the common echo.
  const incomingSig = row.updated_at ? `${row.id}@${row.updated_at}` : null;
  if (incomingSig && _lastSentStamp[row.id] === incomingSig) return;
  if (incomingSig) _lastSentStamp[row.id] = incomingSig;

  // A terminal-status row arriving from another device should drop the entry off
  // the live board (mirrors the load filter), not add it back.
  const state = useStore.getState();
  const apply = state.applyWaitlistRealtime;
  if (typeof apply === 'function') {
    // The slice's applyWaitlistRealtime owns rowToWaitlist + merge + the
    // active/terminal partition. We've already done location + stamp echo-guard.
    apply(payload);
    return;
  }

  // Fallback (slice not present): do a minimal merge ourselves so the board still
  // updates. Keep it import-light by reading the mapper lazily from the lib.
  _fallbackMerge(row);
}

// Separate stamp map purely for the realtime cheap-echo check (id -> id@updated_at).
let _lastSentStamp = {};

function _fallbackMerge(row) {
  // Minimal snake->camel for the board. Mirrors rowToWaitlist's essentials.
  const incoming = {
    id: row.id,
    locationId: row.location_id,
    customerId: row.customer_id || null,
    customer: row.customer || null,
    name: row.party_name,
    phone: row.phone || null,
    size: row.party_size,
    quoted: row.quoted_wait_min ?? null,
    firstQuote: row.first_quote_min ?? row.quoted_wait_min ?? null,
    status: row.status || STATUS.WAITING,
    sectionPref: row.section_pref || null,
    notes: row.notes || '',
    seatedTableId: row.seated_table_id || null,
    source: row.source || 'host',
    returning: !!row.customer_id,
    addedAt: row.added_at ? new Date(row.added_at).getTime() : null,
    notifiedAt: row.notified_at ? new Date(row.notified_at).getTime() : null,
    readyAt: row.ready_at ? new Date(row.ready_at).getTime() : null,
    seatedAt: row.seated_at ? new Date(row.seated_at).getTime() : null,
  };
  const state = useStore.getState();
  const wl = [...(state.waitlist || [])];
  const idx = wl.findIndex((e) => e.id === incoming.id);
  if (!_isLive(incoming)) {
    // Terminal status → remove from the live board.
    if (idx !== -1) { wl.splice(idx, 1); useStore.setState({ waitlist: wl }); }
    return;
  }
  if (idx === -1) wl.push(incoming);
  else wl[idx] = { ...wl[idx], ...incoming };
  useStore.setState({ waitlist: wl });
}

// ── teardown ────────────────────────────────────────────────────────────────
export function teardownWaitlistSync() {
  clearTimeout(_debounceTimer);
  _lastSent = {};
  _lastSentStamp = {};
  _locationId = null;
  _orgId = null;
}
