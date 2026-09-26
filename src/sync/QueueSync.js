/**
 * QueueSync — writes walk-in orderQueue entries and bar tabs to Supabase in
 * real-time so every device sees the same open orders regardless of which
 * terminal placed them.
 *
 * Mirrors SessionSync.js (which handles active table sessions).
 *
 * v4.6.5 addresses Bug #4 from last session: previously orderQueue + tabs were
 * only broadcast over BroadcastChannel (same browser) and persisted to
 * localStorage (same device). Nothing crossed devices.
 *
 * v5.8.86: every row the server has confirmed carries `_sync` { hash, at } (the row as sent,
 * the server's updated_at). Boot no longer unions the saved list with the server's: it runs
 * lib/queueReconcile.js (a row the server removed is dropped, a row never confirmed is kept
 * and published, the server's copy wins when it changed), and QueueReconciler.js keeps running
 * that rule every 15 s. The echo latch (_lastSentQueue) is seeded from the stamps at boot, so
 * a restart never re-uploads rows the server already has (the old zombie path).
 */

import { supabase, getLocationId, getDeviceMode } from '../lib/supabase';
import { queueWrite, isOnline, bufferedUpsertKeys } from './OfflineQueue';
import { reportWriteRefused } from '../lib/deviceLink';
import { useStore } from '../store';
import { isTrainingMode } from '../lib/trainingMode';
import { reconcileList, syncStamp, canonicalJson, digest, stampedKeys } from '../lib/queueReconcile';

// Bounded boot and reconcile reads: a healthy venue never has this many open rows.
export const QUEUE_ROW_CAP = 500;
// A key this till deleted or dropped is not re-adopted from a stale read for this long.
const RECENT_CLEAR_MS = 30_000;
// A row the server never confirmed is published again at most this often (a refused row
// must not drive a publish, flush, replay loop every second).
const PUBLISH_RETRY_MS = 60_000;
// An unstamped row that was already in the saved list when this till booted, has no buffered
// offline write and is older than this is an old copy (saved by an older build), not an order
// in flight. A row created during this session is never judged by this rule.
export const STALE_UNCONFIRMED_MS = 10 * 60_000;

let _locationId = null;
let _debounceTimer = null;
let _lastSentQueue = {};
let _lastSentTab = {};
// Keys this till deleted (flush) or dropped (reconcile), with when: the replay guard never
// re-sends a buffered write for one of these, and the reconciler waits RECENT_CLEAR_MS before
// it would adopt the key again from the server.
const _finishedQueue = new Map();
const _finishedTab = new Map();
// Resolves when the boot read has been reconciled (bounded): the reconciler's first pass waits
// for it. Flushes do NOT wait: the latch is primed inside every flush, confirmed rows are
// updated not re inserted, and saved unstamped rows are held until judged, so a flush during
// the boot read can only send rows created since boot (which must reach disk at once).
let _bootGate = null;
let _releaseBoot = null;
// True once a full, uncapped server read has been reconciled this session. Until then the
// flush does not send old unstamped rows (they are judged first: dropped if the server no
// longer has them, sent if it never had them).
let _judged = false;
const _publishedQueue = new Map();
const _publishedTab = new Map();
// The unstamped rows found in the saved list at boot (key -> age in ms AT BOOT): the only
// candidates for "old copy". The age is frozen at boot so a row that was young when the till
// came up can never age into an old copy while it waits for its first full read.
const _bootUnstampedQ = new Map();
const _bootUnstampedT = new Map();
let _bootCaptured = false;

// Keep FUTURE catering pre-orders out of the live in-memory queue. Catering rows are long-lived
// (open for days/weeks until their event day); loading them all into every device would bloat
// memory and blow the 500-row boot cap. They live in the DB (surfaced by BO → Catering orders)
// and are released into the live flow at their fire time by releaseDueCateringOrders.
// Gate on sent_at (the venue-tz fire INSTANT, a UTC timestamptz) — NOT a local date — so the
// visibility boundary is identical to the fire boundary and immune to per-device clock/tz skew.
const _isFutureCatering = (row) => row?.source === 'catering' && row?.sent_at && new Date(row.sent_at).getTime() > Date.now() && row?.status !== 'collected';

// numeric(10,2) columns: round here so the row we hash is the row the server echoes back
// (a float such as 35.199999 would otherwise never match its own echo).
const money2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

function queueToRow(o, locationId) {
  // v5.5.132: dropped `paid` and `payment_method` from the upsert payload.
  // Migration v5.5.57 added them but they're not applied on every venue's
  // DB. Including them in upsert() causes "could not find the 'paid'
  // column" errors that silently fail every status update — and that's
  // the root cause of "customer tracker never updates when I advance the
  // order on POS". The columns are optional on the row anyway. Re-introduce
  // when the migration is universally applied + the schema-cache miss is
  // resolved on every venue.
  return {
    ref: o.ref,
    location_id: locationId,
    type: o.type || 'dine-in',
    customer: o.customer || {},
    items: o.items || [],
    total: money2(o.total),
    status: o.status || 'received',
    staff: o.staff || null,
    created_at: o.createdAt ? new Date(o.createdAt).toISOString() : new Date().toISOString(),
    sent_at: o.sentAt ? new Date(o.sentAt).toISOString() : null,
    collection_time: o.collectionTime || null,
    is_asap: !!o.isASAP,
    source: o.source || 'pos',
  };
}

function rowToQueue(row) {
  return {
    ref: row.ref,
    type: row.type,
    customer: row.customer || null,
    items: row.items || [],
    total: Number(row.total) || 0,
    status: row.status,
    staff: row.staff,
    createdAt: row.created_at ? new Date(row.created_at).getTime() : Date.now(),
    sentAt: row.sent_at ? new Date(row.sent_at).getTime() : null,
    collectionTime: row.collection_time,
    isASAP: !!row.is_asap,
    source: row.source || 'pos',
    paid: !!row.paid,
    paymentMethod: row.payment_method || null,
  };
}

function tabToRow(t, locationId) {
  return {
    id: t.id,
    location_id: locationId,
    ref: t.ref || null,
    name: t.name,
    seat_id: t.seatId || null,
    table_id: t.tableId || null,
    opened_by: t.openedBy || null,
    opened_at: t.openedAt ? new Date(t.openedAt).toISOString() : new Date().toISOString(),
    status: t.status || 'open',
    pre_auth: !!t.preAuth,
    pre_auth_amount: money2(t.preAuthAmount),
    // v5.5.967: the HOLD IDENTIFIERS finally persist (migration 20260801b). Until
    // now they lived only in the opening till's Zustand — a reload on another
    // device lost the reference and the hold could never be captured/released
    // from there. Works for every processor (pi_ / ps_ / Adyen pspReference).
    pre_auth_ref: t.preAuthPaymentIntentId || t.preAuthRef || null,
    pre_auth_processor: t.preAuthProcessor || null,
    pre_auth_held_minor: t.preAuthHeldMinor ?? null,
    // v968: Stripe holds also need the connected-account id to be captured or
    // released from another till (review finding — ref alone 400s at Stripe).
    pre_auth_account: t.preAuthStripeAccount || t.preAuthAccount || null,
    rounds: t.rounds || [],
    note: t.note || '',
    total: money2(t.total),
  };
}

/**
 * The sync hash: a digest of the row exactly as the flush sends it, in canonical JSON (keys
 * sorted at every level) so the same row hashes the same whether built here or echoed back
 * through jsonb.
 */
const rowHash = (row) => digest(canonicalJson(row));
export const payloadHash = rowHash;
export function queueHash(o, loc = _locationId) { return rowHash(queueToRow(o, loc)); }
export function tabHash(t, loc = _locationId) { return rowHash(tabToRow(t, loc)); }

export function queueAgeMs(o) { const t = o?.createdAt ? new Date(o.createdAt).getTime() : 0; return t ? Date.now() - t : Infinity; }
export function tabAgeMs(t) { const at = t?.openedAt ? new Date(t.openedAt).getTime() : 0; return at ? Date.now() - at : Infinity; }
/**
 * The rule that tells an old copy from an order in flight: only a row that was already
 * unstamped in the saved list at boot, has no buffered write (buffered = null means the
 * buffer could not be read: judge nothing) and is older than STALE_UNCONFIRMED_MS.
 */
export function staleUnconfirmedRule(kind, buffered) {
  if (!buffered) return () => false;
  const boot = kind === 'tab' ? _bootUnstampedT : _bootUnstampedQ;
  const keyOf = kind === 'tab' ? (t) => t?.id : (o) => o?.ref;
  return (row) => { const k = String(keyOf(row)); return boot.has(k) && !buffered.has(k) && boot.get(k) > STALE_UNCONFIRMED_MS; };
}
/**
 * When the buffered writes could not be read (buffered = null), a saved unstamped row can be
 * neither published (it may be an old copy: the zombie path) nor dropped (it may be an unsent
 * order): it is held as it is until a pass can read the evidence.
 */
export function holdUnknownRule(kind, buffered) {
  if (buffered) return () => false;
  const boot = kind === 'tab' ? _bootUnstampedT : _bootUnstampedQ;
  const keyOf = kind === 'tab' ? (t) => t?.id : (o) => o?.ref;
  return (row) => boot.has(String(keyOf(row)));
}
export function markQueuesJudged() { _judged = true; }
/**
 * Called by SyncBridge right after the saved list is applied at boot: remembers which rows
 * were unstamped then, with their age at that moment. Idempotent (a remount does not
 * re-capture, so rows born in this session are never mistaken for old copies).
 */
export function captureQueueBoot() {
  if (_bootCaptured) return;
  _bootCaptured = true;
  const st = useStore.getState();
  for (const o of (st.orderQueue || [])) if (o?.ref && !o._sync?.hash) _bootUnstampedQ.set(String(o.ref), queueAgeMs(o));
  for (const t of (st.tabs || [])) if (t?.id && !t._sync?.hash) _bootUnstampedT.set(String(t.id), tabAgeMs(t));
}
/**
 * Orders the server has already finished (a closed check exists for the ref at this venue).
 * Used before a PASS re-publishes an unstamped row: an order whose first upsert landed but
 * whose confirmation and echo were both lost, and which another till has since collected,
 * must not be re-created. Returns null when the check could not be made.
 */
export async function finishedRefsOnServer(rows) {
  const list = (rows || []).filter(r => r && r.ref != null);
  if (!list.length || !supabase || !_locationId) return new Set();
  // Order numbers are re used over time, so a closed check counts only when it was closed
  // AFTER this copy of the order was created (an older check with the same number is a
  // different order).
  const createdAt = new Map(list.map(r => [String(r.ref), r.createdAt ? new Date(r.createdAt).getTime() : 0]));
  const earliest = Math.min(...createdAt.values());
  try {
    let q = supabase.from('closed_checks').select('ref, closed_at').eq('location_id', _locationId).in('ref', list.map(r => r.ref)).limit(list.length * 4);
    if (earliest > 0) q = q.gte('closed_at', new Date(earliest).toISOString());
    const { data, error } = await q;
    if (error) return null;
    const out = new Set();
    for (const c of (data || [])) {
      const at = c.closed_at ? new Date(c.closed_at).getTime() : 0;
      if (at >= (createdAt.get(String(c.ref)) || 0)) out.add(String(c.ref));
    }
    return out;
  } catch { return null; }
}
/** Any row in next without a stamp that was not in prev: a new order or tab, flushed at once. */
export function hasNewUnsentRows(prevQ, nextQ, prevT, nextT) {
  const fresh = (prev, next, keyOf) => {
    if (!Array.isArray(next) || prev === next) return false;
    const had = new Set((prev || []).map(keyOf));
    return next.some(r => r && !r._sync?.hash && !had.has(keyOf(r)));
  };
  return fresh(prevQ, nextQ, o => o?.ref) || fresh(prevT, nextT, t => t?.id);
}

/** A server row as a local row, stamped as confirmed at the server's updated_at. */
export function queueFromRow(row) {
  const o = rowToQueue(row);
  const at = row.updated_at ? new Date(row.updated_at).getTime() : (row.created_at ? new Date(row.created_at).getTime() : Date.now());
  return { ...o, _sync: syncStamp(queueHash(o, row.location_id || _locationId), at) };
}
export function tabFromRow(row) {
  const t = rowToTab(row);
  const at = row.updated_at ? new Date(row.updated_at).getTime() : (row.opened_at ? new Date(row.opened_at).getTime() : Date.now());
  return { ...t, _sync: syncStamp(tabHash(t, row.location_id || _locationId), at) };
}

/**
 * Set the location and seed both echo latches from the saved stamps. Idempotent. Called at the
 * top of loadQueues and by the reconciler before its first pass, so a hash is never computed
 * with no location and a remount never starts from an empty latch.
 */
export function primeQueueSync(locationId) {
  if (locationId) _locationId = locationId;
  const st = useStore.getState();
  for (const o of (st.orderQueue || [])) if (o?.ref && o._sync?.hash && _lastSentQueue[o.ref] === undefined) _lastSentQueue[o.ref] = o._sync.hash;
  for (const t of (st.tabs || [])) if (t?.id && t._sync?.hash && _lastSentTab[t.id] === undefined) _lastSentTab[t.id] = t._sync.hash;
}

/** Resolves when the boot read has settled (at once when none is running). */
export function whenQueueBootSettled() { return _bootGate || Promise.resolve(); }

/** The server's open rows for a venue: the same shape every reader uses (boot, reconciler). */
export function openQueueQuery(locationId, columns = '*') {
  return supabase.from('order_queue').select(columns).eq('location_id', locationId).neq('status', 'collected').or(`source.is.null,source.neq.catering,sent_at.lte.${new Date().toISOString()}`).order('created_at', { ascending: false });
}
export function openTabQuery(locationId, columns = '*') {
  return supabase.from('bar_tabs').select(columns).eq('location_id', locationId).neq('status', 'closed').order('opened_at', { ascending: false });
}

/**
 * Keys this till deleted or dropped in the last RECENT_CLEAR_MS: the reconciler must not adopt
 * them back from a read that predates the delete. After that window a key that is genuinely on
 * the server again is adopted like any other (the old marker never expired, which could split
 * the counts for a whole session).
 */
export function clearedKeys(kind) {
  const fin = kind === 'tab' ? _finishedTab : _finishedQueue;
  const since = Date.now() - RECENT_CLEAR_MS;
  const out = new Set();
  for (const [k, v] of fin) if (v.finishedAt >= since && !(v.adoptedAt > v.finishedAt)) out.add(k);
  return out;
}
/**
 * True when this till deleted or dropped the key AFTER the write in question was buffered
 * (replay guard). A write buffered after the row came back (adopted again) replays; a write
 * buffered before the finish is stale even if the row came back since.
 */
export function isFinishedAfter(kind, key, ts) {
  const v = (kind === 'tab' ? _finishedTab : _finishedQueue).get(String(key));
  if (!v) return false;
  const at = Number(ts) || 0;
  if (v.adoptedAt !== undefined && at >= v.adoptedAt) return false;
  return v.finishedAt > at;
}
/** The row came back (adopted from the server): remembered, so later writes replay again. */
export function noteAdopted(kind, key) {
  const fin = kind === 'tab' ? _finishedTab : _finishedQueue;
  const v = fin.get(String(key));
  if (v) v.adoptedAt = Date.now();
}
function finishedRecently(kind, key) {
  const v = (kind === 'tab' ? _finishedTab : _finishedQueue).get(String(key));
  return !!v && Date.now() - v.finishedAt < RECENT_CLEAR_MS && !(v.adoptedAt > v.finishedAt);
}
/** A row the server no longer has was dropped here: no delete needs sending for it. */
export function markQueueDropped(ref) { _lastSentQueue[ref] = 'cleared'; _finishedQueue.set(String(ref), { finishedAt: Date.now() }); }
export function markTabDropped(id) { _lastSentTab[id] = 'cleared'; _finishedTab.set(String(id), { finishedAt: Date.now() }); }
/**
 * Rows that left the store (paid off, cleared, removed by a realtime delete) are recorded as
 * finished the moment they leave, not when the flush sends the delete 500 ms later: a
 * reconcile in that window must not adopt the row back from the server.
 */
export function noteQueueRemovals(prev, next) { return noteRemovals(prev, next, o => o?.ref, _finishedQueue); }
export function noteTabRemovals(prev, next) { return noteRemovals(prev, next, t => t?.id, _finishedTab); }
function noteRemovals(prev, next, keyOf, fin) {
  if (!Array.isArray(prev) || !Array.isArray(next) || prev === next) return 0;
  const have = new Set();
  for (const r of next) { const k = keyOf(r); if (k != null) have.add(String(k)); }
  const now = Date.now();
  let n = 0;
  for (const r of prev) { const k = keyOf(r); if (k != null && !have.has(String(k))) { fin.set(String(k), { finishedAt: now }); n++; } }
  return n;
}
/** Rows the server never confirmed: forget the latch so the next flush sends them (at most once a minute per row). */
export function publishQueueRows(refs) { const due = duePublish(refs, _publishedQueue); if (!due.length) return; for (const r of due) delete _lastSentQueue[r]; scheduleQueueFlush(); }
export function publishTabRows(ids) { const due = duePublish(ids, _publishedTab); if (!due.length) return; for (const id of due) delete _lastSentTab[id]; scheduleQueueFlush(); }
function duePublish(keys, marks) {
  const now = Date.now();
  const due = [];
  for (const k of keys || []) {
    const at = marks.get(k);
    if (at !== undefined && now - at < PUBLISH_RETRY_MS) continue;
    marks.set(k, now);
    due.push(k);
  }
  return due;
}
/**
 * Rows that are now the server's copy (adopted, updated, or confirmed): latch them so the next
 * flush does not send them back. Without this an adopted row was upserted again, and if another
 * till had collected it in that half second the upsert re-created it (a zombie). Pending rows
 * (a local change the server has not seen) are left alone: the flush must send those.
 */
export function latchQueueRows(rows) { for (const o of rows || []) if (o?.ref && o._sync?.hash && !isPendingLocal(o, queueHash)) _lastSentQueue[o.ref] = o._sync.hash; }
export function latchTabRows(rows) { for (const t of rows || []) if (t?.id && t._sync?.hash && !isPendingLocal(t, tabHash)) _lastSentTab[t.id] = t._sync.hash; }

/** Stamp rows the server just confirmed, when their payload is still what was sent. */
function stampConfirmed(stateKey, keyOf, hashOf, sent, confirmedAt) {
  if (!sent.size) return;
  useStore.setState(s => {
    let touched = false;
    const next = (s[stateKey] || []).map(row => {
      const k = keyOf(row);
      const payload = sent.get(k);
      if (payload === undefined) return row;
      if (hashOf(row) !== payload) return row;   // edited again since: the next flush confirms that one
      if (!confirmedAt.has(k)) return row;       // the server did not return it (an update of a row it no longer has)
      const at = confirmedAt.get(k) || Date.now();
      if (row._sync && row._sync.hash === payload && row._sync.at >= at) return row;
      touched = true;
      return { ...row, _sync: syncStamp(payload, at) };
    });
    return touched ? { [stateKey]: next } : {};
  });
}

function rowToTab(row) {
  return {
    id: row.id,
    ref: row.ref,
    name: row.name,
    seatId: row.seat_id,
    tableId: row.table_id,
    openedBy: row.opened_by,
    openedAt: row.opened_at ? new Date(row.opened_at).getTime() : Date.now(),
    status: row.status,
    preAuth: !!row.pre_auth,
    preAuthAmount: Number(row.pre_auth_amount) || 0,
    // v5.5.967: hydrate the persisted hold identifiers (see tabToRow)
    preAuthPaymentIntentId: row.pre_auth_ref || null,
    preAuthRef: row.pre_auth_ref || null,
    preAuthProcessor: row.pre_auth_processor || null,
    preAuthHeldMinor: row.pre_auth_held_minor != null ? Number(row.pre_auth_held_minor) : null,
    preAuthStripeAccount: row.pre_auth_account || null,
    preAuthAccount: row.pre_auth_account || null,
    rounds: row.rounds || [],
    note: row.note || '',
    total: Number(row.total) || 0,
  };
}

export async function flushQueues() {
  // TRAINING MODE: never publish walk-in orders / bar tabs to order_queue / bar_tabs.
  if (isTrainingMode()) return;
  if (!_locationId) _locationId = await getLocationId().catch(() => null);
  if (!_locationId) return;
  primeQueueSync(_locationId);   // whichever path resolved the location, never flush against an empty latch
  const state = useStore.getState();
  const queue = state.orderQueue || [];
  // v5.9.72: a kitchen screen never publishes bar tabs (it only reads them); see SessionSync.
  const tabs = getDeviceMode() === 'kds' ? [] : (state.tabs || []);

  // Scale: collect changed rows and fire ONE batched write per table instead of one network
  // round-trip per row (a busy venue / catering wave could otherwise emit hundreds per flush).
  // The durable per-row queueWrite stays (offline safety + per-item replay attribution); only the
  // live direct write is batched. Echo-suppression (_lastSent) is unchanged — it just decides
  // which rows enter the arrays. Both paths are idempotent on the conflict key.
  const online = isOnline();
  const queueUpserts = [], queueUpdates = [], queueDeletes = [], tabUpserts = [], tabUpdates = [], tabDeletes = [];

  const activeQueueRefs = new Set();
  for (const o of queue) {
    if (!o?.ref) continue;
    // TRAINING MODE: an entry created while training (addToQueue stamps training:true) is
    // never published, even after training is switched off. Without this, the next flush
    // once the device profile turned training off upserted the trainee's orders to live.
    if (o.training === true) continue;
    if (o.status === 'collected') continue;
    activeQueueRefs.add(o.ref);
    // A copy from before this boot waits for the first full read to judge it (old copy or unsent).
    if (!_judged && !o._sync && _bootUnstampedQ.has(String(o.ref))) continue;
    const row = queueToRow(o, _locationId);
    const payload = rowHash(row);
    if (_lastSentQueue[o.ref] === payload) continue;
    _lastSentQueue[o.ref] = payload;
    if (o._sync?.hash) {
      // The server has confirmed this row: UPDATE it. An update of a row another till has since
      // removed touches nothing, so an edit here can never re-create a collected order.
      queueWrite({ type: 'update', table: 'order_queue', payload: row, match: { location_id: _locationId, ref: o.ref } });
      queueUpdates.push(row);
    } else {
      // order_queue is keyed (location_id, ref), not ref alone, see the batch write below.
      queueWrite({ type: 'upsert', table: 'order_queue', payload: row, onConflict: 'location_id,ref' });
      queueUpserts.push(row);
    }
  }
  for (const ref of Object.keys(_lastSentQueue)) {
    if (activeQueueRefs.has(ref)) continue;
    if (_lastSentQueue[ref] === 'cleared') continue;
    _lastSentQueue[ref] = 'cleared';
    _finishedQueue.set(String(ref), { finishedAt: Date.now() });
    queueWrite({ type: 'delete', table: 'order_queue', match: { location_id: _locationId, ref } });
    queueDeletes.push(ref);
  }

  const activeTabIds = new Set();
  for (const t of tabs) {
    if (!t?.id) continue;
    activeTabIds.add(t.id);
    if (!_judged && !t._sync && _bootUnstampedT.has(String(t.id))) continue;
    const row = tabToRow(t, _locationId);
    const payload = rowHash(row);
    if (_lastSentTab[t.id] === payload) continue;
    _lastSentTab[t.id] = payload;
    if (t._sync?.hash) {
      // A closed tab on the server stays closed: an edit from a till that missed the close
      // touches nothing (the pass then keeps the edit here, flagged, for staff to settle).
      queueWrite({ type: 'update', table: 'bar_tabs', payload: row, match: { id: t.id }, notMatch: { status: 'closed' } });
      tabUpdates.push(row);
    } else {
      queueWrite({ type: 'upsert', table: 'bar_tabs', payload: row, onConflict: 'id' });
      tabUpserts.push(row);
    }
  }
  for (const id of Object.keys(_lastSentTab)) {
    if (activeTabIds.has(id)) continue;
    if (_lastSentTab[id] === 'cleared') continue;
    _lastSentTab[id] = 'cleared';
    _finishedTab.set(String(id), { finishedAt: Date.now() });
    queueWrite({ type: 'delete', table: 'bar_tabs', match: { id } });
    tabDeletes.push(id);
  }

  if (online) {
    // Database fence stage 1, fix round 2 (the zero row blocker): every update and delete below was
    // queued in the durable OfflineQueue FIRST (queueWrite above). These live calls are only the
    // fast path and never mark anything as sent: the queue's replay, a second later, counts the
    // rows it changed (lib/rowWriteFence.js). On a till that lost its link, row level security
    // hides the row and the write changes nothing without an error; the replay then KEEPS it
    // (parked) until the till is linked again, instead of counting it as done.
    // order_queue is keyed (location_id, ref). A ref alone is one global namespace
    // shared by every venue, so both statements MUST carry the location: an upsert
    // on 'ref' would land this venue's order on top of another venue's live order,
    // and a delete on 'ref' would remove theirs when this venue clears its own.
    // v5.8.86: the upsert returns the server's updated_at, which stamps each row as
    // confirmed (`_sync`), so a restart never re-uploads it and the reconciler knows it
    // reached the server. The durable queueWrite above still replays it if this call fails.
    if (queueUpserts.length) {
      const sent = new Map(queueUpserts.map(r => [r.ref, rowHash(r)]));
      Promise.resolve(supabase.from('order_queue').upsert(queueUpserts, { onConflict: 'location_id,ref' }).select('ref, updated_at'))
        .then(({ data, error }) => {
          if (error) { reportWriteRefused(error); console.warn('[QueueSync] order_queue batch upsert:', error.message); return; }
          const at = new Map((data || []).map(r => [r.ref, r.updated_at ? new Date(r.updated_at).getTime() : Date.now()]));
          stampConfirmed('orderQueue', o => o.ref, queueHash, sent, at);
        })
        .catch(e => console.warn('[QueueSync] order_queue batch upsert:', e.message));
    }
    for (const row of queueUpdates) {
      Promise.resolve(supabase.from('order_queue').update(row).eq('location_id', _locationId).eq('ref', row.ref).select('ref, updated_at'))
        .then(({ data, error }) => {
          if (error) { reportWriteRefused(error); console.warn('[QueueSync] order_queue update:', error.message); return; }
          const at = new Map((data || []).map(r => [r.ref, r.updated_at ? new Date(r.updated_at).getTime() : Date.now()]));
          stampConfirmed('orderQueue', o => o.ref, queueHash, new Map([[row.ref, rowHash(row)]]), at);
        })
        .catch(e => console.warn('[QueueSync] order_queue update:', e.message));
    }
    if (queueDeletes.length) Promise.resolve(supabase.from('order_queue').delete().eq('location_id', _locationId).in('ref', queueDeletes)).catch(e => console.warn('[QueueSync] order_queue batch delete:', e.message));
    if (tabUpserts.length) {
      const sent = new Map(tabUpserts.map(r => [r.id, rowHash(r)]));
      Promise.resolve(supabase.from('bar_tabs').upsert(tabUpserts, { onConflict: 'id' }).select('id, updated_at'))
        .then(({ data, error }) => {
          if (error) { reportWriteRefused(error); console.warn('[QueueSync] bar_tabs batch upsert:', error.message); return; }
          const at = new Map((data || []).map(r => [r.id, r.updated_at ? new Date(r.updated_at).getTime() : Date.now()]));
          stampConfirmed('tabs', t => t.id, tabHash, sent, at);
        })
        .catch(e => console.warn('[QueueSync] bar_tabs batch upsert:', e.message));
    }
    for (const row of tabUpdates) {
      Promise.resolve(supabase.from('bar_tabs').update(row).eq('id', row.id).neq('status', 'closed').select('id, updated_at'))
        .then(({ data, error }) => {
          if (error) { reportWriteRefused(error); console.warn('[QueueSync] bar_tabs update:', error.message); return; }
          const at = new Map((data || []).map(r => [r.id, r.updated_at ? new Date(r.updated_at).getTime() : Date.now()]));
          stampConfirmed('tabs', t => t.id, tabHash, new Map([[row.id, rowHash(row)]]), at);
        })
        .catch(e => console.warn('[QueueSync] bar_tabs update:', e.message));
    }
    if (tabDeletes.length) Promise.resolve(supabase.from('bar_tabs').delete().in('id', tabDeletes)).catch(e => console.warn('[QueueSync] bar_tabs batch delete:', e.message));
  }
}

export function scheduleQueueFlush(immediate = false) {
  clearTimeout(_debounceTimer);
  // A brand new order or tab is flushed (and so written to disk) at once, not after the
  // debounce and never behind the boot read: a till killed in that window must still find
  // the write on disk.
  if (immediate) { _debounceTimer = null; flushQueues(); return; }
  _debounceTimer = setTimeout(flushQueues, 500);
}

export async function loadQueues() {
  // The gate opens synchronously so the reconciler and any flush scheduled from now on wait
  // for this read (bounded to 15 s so a dead network never holds an order back).
  if (!_bootGate) {
    _bootGate = new Promise(r => { _releaseBoot = r; });
    setTimeout(() => { const rel = _releaseBoot; _releaseBoot = null; _bootGate = null; rel?.(); }, 15_000);
  }
  if (!_locationId) _locationId = await getLocationId().catch(() => null);
  if (!_locationId || !supabase) { const rel = _releaseBoot; _releaseBoot = null; _bootGate = null; rel?.(); return; }
  try {
    // Bounded boot loads — a healthy location never has >500 open orders/tabs;
    // a bigger backlog means an ops cleanup gap, not a sync job. Newest first so
    // the cap keeps the relevant rows. Prevents slow boots + memory blow-up.
    // v5.8.86: seed the echo latch from the saved stamps BEFORE any await, so a flush woken
    // during the read never re-uploads rows the server already confirmed (the old union re-sent
    // every saved row after a restart, which is how cleared orders came back on every till).
    captureQueueBoot();   // normally already done by SyncBridge right after the saved list was applied
    primeQueueSync(_locationId);
    // Only rows already confirmed when this read begins may be dropped by it: a row confirmed
    // while the read is in flight is simply not in it.
    const droppableQ = stampedKeys(useStore.getState().orderQueue, o => o.ref);
    const droppableT = stampedKeys(useStore.getState().tabs, t => t.id);
    const [qRes, tRes, bufQ, bufT] = await Promise.all([
      openQueueQuery(_locationId).limit(QUEUE_ROW_CAP),
      openTabQuery(_locationId).limit(QUEUE_ROW_CAP),
      bufferedUpsertKeys('order_queue'),
      bufferedUpsertKeys('bar_tabs'),
    ]);

    const patch = {};
    const report = [];
    // A read that returns nothing while this till holds confirmed rows is not trusted on its
    // own (a lost device session reads as empty under the tenant fence): the reconciler's
    // passes decide, once the emptiness repeats.
    const qCapped = qRes.data ? (qRes.data.length >= QUEUE_ROW_CAP || (qRes.data.length === 0 && droppableQ.size > 0)) : true;
    const tCapped = tRes.data ? (tRes.data.length >= QUEUE_ROW_CAP || (tRes.data.length === 0 && droppableT.size > 0)) : true;
    if (!qRes.error && Array.isArray(qRes.data)) {
      const remote = qRes.data.map(queueFromRow);
      const local = useStore.getState().orderQueue || [];
      const r = reconcileList({
        local, remote, keyOf: o => o.ref, hashOf: queueHash,
        isDone: o => o?.status === 'collected', isTraining: o => o?.training === true,
        skipAdopt: clearedKeys('queue'), capped: qCapped,
        unconfirmedIsStale: staleUnconfirmedRule('queue', bufQ), canDrop: o => droppableQ.has(String(o.ref)),
        hold: holdUnknownRule('queue', bufQ),
      });
      patch.orderQueue = r.next;
      latchQueueRows(r.next);
      r.dropped.forEach(markQueueDropped);
      r.adopted.forEach(k => noteAdopted('queue', k));
      // Rows the server never confirmed are NOT sent blind from boot: they are latched as they
      // are, and the first pass publishes them after the closed check test (an order paid
      // elsewhere while this till was off must not come back).
      const byRefQ = new Map(r.next.map(o => [String(o?.ref), o]));
      for (const ref of r.publish) { const o = byRefQ.get(String(ref)); if (o) _lastSentQueue[ref] = queueHash(o); }
      report.push(`${r.next.length} orders (${r.adopted.length} from server, ${r.dropped.length} dropped, ${r.publish.length} to publish)`);
    }
    if (!tRes.error && Array.isArray(tRes.data)) {
      const remote = tRes.data.map(tabFromRow);
      const local = useStore.getState().tabs || [];
      const r = reconcileList({
        local, remote, keyOf: t => t.id, hashOf: tabHash,
        isDone: t => t?.status === 'closed', isTraining: () => false,
        skipAdopt: clearedKeys('tab'), capped: tCapped,
        unconfirmedIsStale: staleUnconfirmedRule('tab', bufT), canDrop: t => droppableT.has(String(t.id)),
        keepIfPending: () => true,   // a tab with unsent rounds is money: kept and flagged, never dropped
        hold: holdUnknownRule('tab', bufT),
      });
      patch.tabs = r.next;
      latchTabRows(r.next);
      r.dropped.forEach(markTabDropped);
      r.adopted.forEach(k => noteAdopted('tab', k));
      if (r.orphaned.length) console.warn('[QueueSync] bar tabs closed elsewhere with unsent changes here (kept, flagged):', r.orphaned.join(', '));
      const byIdT = new Map(r.next.map(t => [String(t?.id), t]));
      for (const id of r.publish) { const t = byIdT.get(String(id)); if (t) _lastSentTab[id] = tabHash(t); }
      report.push(`${r.next.length} bar tabs (${r.adopted.length} from server, ${r.dropped.length} dropped, ${r.publish.length} to publish)`);
    }
    if (Object.keys(patch).length) {
      useStore.setState(patch);
      console.log(`[QueueSync] Boot reconcile: ${report.join('; ')}`);
      scheduleQueueFlush();   // sends anything the server never confirmed
    }
    if (!qRes.error && !tRes.error && !qCapped && !tCapped && bufQ && bufT) markQueuesJudged();
  } catch (e) { console.warn('[QueueSync] load failed:', e?.message || e); }
  finally { const rel = _releaseBoot; _releaseBoot = null; _bootGate = null; rel?.(); }
}

// A row with a change the server has not confirmed (no stamp, or edited since).
function isPendingLocal(row, hashOf) {
  return !row?._sync || typeof row._sync.hash !== 'string' || row._sync.hash !== hashOf(row);
}

export function applyQueueRealtimeEvent(payload) {
  const state = useStore.getState();
  const queue = [...(state.orderQueue || [])];
  if (payload.eventType === 'DELETE') {
    const ref = payload.old?.ref;
    if (!ref) return;
    if (_lastSentQueue[ref] === 'cleared') return;
    const next = queue.filter(o => o.ref !== ref);
    if (next.length !== queue.length) useStore.setState({ orderQueue: next });
    return;
  }
  const row = payload.new;
  if (!row?.ref) return;
  // Don't pull a FUTURE catering pre-order into the live queue (it's released on its event day).
  // If one is lingering from a prior state, evict it.
  if (_isFutureCatering(row)) {
    const next = queue.filter(o => o.ref !== row.ref);
    if (next.length !== queue.length) useStore.setState({ orderQueue: next });
    return;
  }
  const incoming = queueFromRow(row);
  const ourPayload = incoming._sync.hash;
  const idx = queue.findIndex(o => o.ref === row.ref);
  if (_lastSentQueue[row.ref] === ourPayload) {
    // Our own write echoed back: only the stamp is new (the server's updated_at). The time is
    // refreshed too, so the reconciler does not fetch the row again for a move it made itself.
    // The stamp is the payload we sent (the echo proves the server holds exactly that), not
    // the previous stamp: a row confirmed only by the offline replay would stay pending for ever.
    if (idx !== -1 && (queue[idx]._sync?.hash !== ourPayload || incoming._sync.at > (Number(queue[idx]._sync.at) || 0))) {
      queue[idx] = { ...queue[idx], _sync: syncStamp(ourPayload, Math.max(incoming._sync.at, Number(queue[idx]._sync?.at) || 0)) };
      useStore.setState({ orderQueue: queue });
    }
    return;
  }
  // A late echo of a write this till made just before it deleted the row: ignore it, or the
  // collected order would come back and be re-sent. If the server really still has the row,
  // the reconciler adopts it once the key is no longer recent.
  if (idx === -1 && finishedRecently('queue', row.ref)) return;
  if (idx === -1) { queue.unshift(incoming); noteAdopted('queue', row.ref); _lastSentQueue[row.ref] = ourPayload; }
  else if (isPendingLocal(queue[idx], queueHash)) return;   // unsent changes here win, the flush sends them (the reconcile rule)
  else { queue[idx] = { ...queue[idx], ...incoming }; _lastSentQueue[row.ref] = ourPayload; }
  useStore.setState({ orderQueue: queue });
}

export function applyTabRealtimeEvent(payload) {
  const state = useStore.getState();
  const tabs = [...(state.tabs || [])];
  if (payload.eventType === 'DELETE') {
    const id = payload.old?.id;
    if (!id) return;
    if (_lastSentTab[id] === 'cleared') return;
    const next = tabs.filter(t => t.id !== id);
    if (next.length !== tabs.length) useStore.setState({ tabs: next });
    return;
  }
  const row = payload.new;
  if (!row?.id) return;
  const incoming = tabFromRow(row);
  const ourPayload = incoming._sync.hash;
  const idx = tabs.findIndex(t => t.id === row.id);
  if (_lastSentTab[row.id] === ourPayload) {
    if (idx !== -1 && (tabs[idx]._sync?.hash !== ourPayload || incoming._sync.at > (Number(tabs[idx]._sync.at) || 0))) {
      tabs[idx] = { ...tabs[idx], _sync: syncStamp(ourPayload, Math.max(incoming._sync.at, Number(tabs[idx]._sync?.at) || 0)) };
      useStore.setState({ tabs });
    }
    return;
  }
  if (idx === -1 && finishedRecently('tab', row.id)) return;
  if (idx === -1) { tabs.unshift(incoming); noteAdopted('tab', row.id); _lastSentTab[row.id] = ourPayload; }
  else if (isPendingLocal(tabs[idx], tabHash)) {
    // Unsent changes here win (the flush sends them). A close from another till is never
    // merged over an unsent round: the tab is kept and flagged for staff to settle.
    if (incoming.status === 'closed' && tabs[idx].status !== 'closed' && !tabs[idx]._orphan) {
      tabs[idx] = { ...tabs[idx], _orphan: true };
      try { useStore.getState().showToast?.('A bar tab closed on another till still has unsent changes here. Check before charging.', 'warning'); } catch {}
    } else return;
  }
  else { tabs[idx] = { ...tabs[idx], ...incoming }; _lastSentTab[row.id] = ourPayload; }
  useStore.setState({ tabs });
}

export function teardownQueueSync() {
  clearTimeout(_debounceTimer);
  _lastSentQueue = {};
  _lastSentTab = {};
  _locationId = null;
  // The finished maps are kept on purpose: a remount must still refuse to replay a buffered
  // write for a row this till already deleted or dropped.
  const rel = _releaseBoot; _releaseBoot = null; _bootGate = null; rel?.();
}
