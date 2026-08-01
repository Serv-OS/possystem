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
 */

import { supabase, getLocationId } from '../lib/supabase';
import { queueWrite, isOnline } from './OfflineQueue';
import { useStore } from '../store';
import { isTrainingMode } from '../lib/trainingMode';

let _locationId = null;
let _debounceTimer = null;
let _lastSentQueue = {};
let _lastSentTab = {};

// Keep FUTURE catering pre-orders out of the live in-memory queue. Catering rows are long-lived
// (open for days/weeks until their event day); loading them all into every device would bloat
// memory and blow the 500-row boot cap. They live in the DB (surfaced by BO → Catering orders)
// and are released into the live flow at their fire time by releaseDueCateringOrders.
// Gate on sent_at (the venue-tz fire INSTANT, a UTC timestamptz) — NOT a local date — so the
// visibility boundary is identical to the fire boundary and immune to per-device clock/tz skew.
const _isFutureCatering = (row) => row?.source === 'catering' && row?.sent_at && new Date(row.sent_at).getTime() > Date.now() && row?.status !== 'collected';

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
    total: o.total ?? 0,
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
    pre_auth_amount: t.preAuthAmount ?? 0,
    // v5.5.967: the HOLD IDENTIFIERS finally persist (migration 20260801b). Until
    // now they lived only in the opening till's Zustand — a reload on another
    // device lost the reference and the hold could never be captured/released
    // from there. Works for every processor (pi_ / ps_ / Adyen pspReference).
    pre_auth_ref: t.preAuthPaymentIntentId || t.preAuthRef || null,
    pre_auth_processor: t.preAuthProcessor || null,
    pre_auth_held_minor: t.preAuthHeldMinor ?? null,
    rounds: t.rounds || [],
    note: t.note || '',
    total: t.total ?? 0,
  };
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
  const state = useStore.getState();
  const queue = state.orderQueue || [];
  const tabs = state.tabs || [];

  // Scale: collect changed rows and fire ONE batched write per table instead of one network
  // round-trip per row (a busy venue / catering wave could otherwise emit hundreds per flush).
  // The durable per-row queueWrite stays (offline safety + per-item replay attribution); only the
  // live direct write is batched. Echo-suppression (_lastSent) is unchanged — it just decides
  // which rows enter the arrays. Both paths are idempotent on the conflict key.
  const online = isOnline();
  const queueUpserts = [], queueDeletes = [], tabUpserts = [], tabDeletes = [];

  const activeQueueRefs = new Set();
  for (const o of queue) {
    if (!o?.ref) continue;
    if (o.status === 'collected') continue;
    activeQueueRefs.add(o.ref);
    const row = queueToRow(o, _locationId);
    const payload = JSON.stringify(row);
    if (_lastSentQueue[o.ref] === payload) continue;
    _lastSentQueue[o.ref] = payload;
    queueWrite({ type: 'upsert', table: 'order_queue', payload: row, onConflict: 'ref' });
    queueUpserts.push(row);
  }
  for (const ref of Object.keys(_lastSentQueue)) {
    if (activeQueueRefs.has(ref)) continue;
    if (_lastSentQueue[ref] === 'cleared') continue;
    _lastSentQueue[ref] = 'cleared';
    queueWrite({ type: 'delete', table: 'order_queue', match: { ref } });
    queueDeletes.push(ref);
  }

  const activeTabIds = new Set();
  for (const t of tabs) {
    if (!t?.id) continue;
    activeTabIds.add(t.id);
    const row = tabToRow(t, _locationId);
    const payload = JSON.stringify(row);
    if (_lastSentTab[t.id] === payload) continue;
    _lastSentTab[t.id] = payload;
    queueWrite({ type: 'upsert', table: 'bar_tabs', payload: row, onConflict: 'id' });
    tabUpserts.push(row);
  }
  for (const id of Object.keys(_lastSentTab)) {
    if (activeTabIds.has(id)) continue;
    if (_lastSentTab[id] === 'cleared') continue;
    _lastSentTab[id] = 'cleared';
    queueWrite({ type: 'delete', table: 'bar_tabs', match: { id } });
    tabDeletes.push(id);
  }

  if (online) {
    if (queueUpserts.length) Promise.resolve(supabase.from('order_queue').upsert(queueUpserts, { onConflict: 'ref' })).catch(e => console.warn('[QueueSync] order_queue batch upsert:', e.message));
    if (queueDeletes.length) Promise.resolve(supabase.from('order_queue').delete().in('ref', queueDeletes)).catch(e => console.warn('[QueueSync] order_queue batch delete:', e.message));
    if (tabUpserts.length) Promise.resolve(supabase.from('bar_tabs').upsert(tabUpserts, { onConflict: 'id' })).catch(e => console.warn('[QueueSync] bar_tabs batch upsert:', e.message));
    if (tabDeletes.length) Promise.resolve(supabase.from('bar_tabs').delete().in('id', tabDeletes)).catch(e => console.warn('[QueueSync] bar_tabs batch delete:', e.message));
  }
}

export function scheduleQueueFlush() {
  clearTimeout(_debounceTimer);
  _debounceTimer = setTimeout(flushQueues, 500);
}

export async function loadQueues() {
  if (!_locationId) _locationId = await getLocationId().catch(() => null);
  if (!_locationId) return;
  if (!supabase) return;
  try {
    // Bounded boot loads — a healthy location never has >500 open orders/tabs;
    // a bigger backlog means an ops cleanup gap, not a sync job. Newest first so
    // the cap keeps the relevant rows. Prevents slow boots + memory blow-up.
    const [qRes, tRes] = await Promise.all([
      supabase.from('order_queue').select('*').eq('location_id', _locationId).neq('status', 'collected').or(`source.is.null,source.neq.catering,sent_at.lte.${new Date().toISOString()}`).order('created_at', { ascending: false }).limit(500),
      supabase.from('bar_tabs').select('*').eq('location_id', _locationId).neq('status', 'closed').order('opened_at', { ascending: false }).limit(500),
    ]);
    const patch = {};
    if (!qRes.error && Array.isArray(qRes.data)) {
      const remote = qRes.data.map(rowToQueue);
      const local = useStore.getState().orderQueue || [];
      const localRefs = new Set(local.map(o => o.ref));
      patch.orderQueue = [...local, ...remote.filter(r => !localRefs.has(r.ref))];
      remote.forEach(r => { _lastSentQueue[r.ref] = JSON.stringify(queueToRow(r, _locationId)); });
    }
    if (!tRes.error && Array.isArray(tRes.data)) {
      const remote = tRes.data.map(rowToTab);
      const local = useStore.getState().tabs || [];
      const localIds = new Set(local.map(t => t.id));
      patch.tabs = [...local, ...remote.filter(r => !localIds.has(r.id))];
      remote.forEach(r => { _lastSentTab[r.id] = JSON.stringify(tabToRow(r, _locationId)); });
    }
    if (Object.keys(patch).length) {
      useStore.setState(patch);
      console.log(`[QueueSync] Loaded ${patch.orderQueue?.length || 0} queued orders, ${patch.tabs?.length || 0} bar tabs from Supabase`);
    }
  } catch (e) { console.warn('[QueueSync] load failed:', e?.message || e); }
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
  const incoming = rowToQueue(row);
  const ourPayload = JSON.stringify(queueToRow(incoming, row.location_id));
  if (_lastSentQueue[row.ref] === ourPayload) return;
  const idx = queue.findIndex(o => o.ref === row.ref);
  if (idx === -1) queue.unshift(incoming);
  else queue[idx] = { ...queue[idx], ...incoming };
  _lastSentQueue[row.ref] = ourPayload;
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
  const incoming = rowToTab(row);
  const ourPayload = JSON.stringify(tabToRow(incoming, row.location_id));
  if (_lastSentTab[row.id] === ourPayload) return;
  const idx = tabs.findIndex(t => t.id === row.id);
  if (idx === -1) tabs.unshift(incoming);
  else tabs[idx] = { ...tabs[idx], ...incoming };
  _lastSentTab[row.id] = ourPayload;
  useStore.setState({ tabs });
}

export function teardownQueueSync() {
  clearTimeout(_debounceTimer);
  _lastSentQueue = {};
  _lastSentTab = {};
  _locationId = null;
}
