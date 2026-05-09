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

let _locationId = null;
let _debounceTimer = null;
let _lastSentQueue = {};
let _lastSentTab = {};

function queueToRow(o, locationId) {
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
    paid: !!o.paid,
    payment_method: o.paymentMethod || null,
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
    rounds: row.rounds || [],
    note: row.note || '',
    total: Number(row.total) || 0,
  };
}

export async function flushQueues() {
  if (!_locationId) _locationId = await getLocationId().catch(() => null);
  if (!_locationId) return;
  const state = useStore.getState();
  const queue = state.orderQueue || [];
  const tabs = state.tabs || [];

  const activeQueueRefs = new Set();
  for (const o of queue) {
    if (!o?.ref) continue;
    if (o.status === 'collected') continue;
    activeQueueRefs.add(o.ref);
    const row = queueToRow(o, _locationId);
    const payload = JSON.stringify(row);
    if (_lastSentQueue[o.ref] === payload) continue;
    _lastSentQueue[o.ref] = payload;
    queueWrite({ type: 'upsert', table: 'order_queue', payload: row, onConflict: 'ref' }).then(() => {
      if (isOnline()) {
        Promise.resolve(supabase.from('order_queue').upsert(row, { onConflict: 'ref' })).catch(e => console.warn('[QueueSync] order_queue upsert:', e.message));
      }
    });
  }
  for (const ref of Object.keys(_lastSentQueue)) {
    if (activeQueueRefs.has(ref)) continue;
    if (_lastSentQueue[ref] === 'cleared') continue;
    _lastSentQueue[ref] = 'cleared';
    queueWrite({ type: 'delete', table: 'order_queue', match: { ref } });
    if (isOnline()) {
      Promise.resolve(supabase.from('order_queue').delete().eq('ref', ref)).catch(e => console.warn('[QueueSync] order_queue delete:', e.message));
    }
  }

  const activeTabIds = new Set();
  for (const t of tabs) {
    if (!t?.id) continue;
    activeTabIds.add(t.id);
    const row = tabToRow(t, _locationId);
    const payload = JSON.stringify(row);
    if (_lastSentTab[t.id] === payload) continue;
    _lastSentTab[t.id] = payload;
    queueWrite({ type: 'upsert', table: 'bar_tabs', payload: row, onConflict: 'id' }).then(() => {
      if (isOnline()) {
        Promise.resolve(supabase.from('bar_tabs').upsert(row, { onConflict: 'id' })).catch(e => console.warn('[QueueSync] bar_tabs upsert:', e.message));
      }
    });
  }
  for (const id of Object.keys(_lastSentTab)) {
    if (activeTabIds.has(id)) continue;
    if (_lastSentTab[id] === 'cleared') continue;
    _lastSentTab[id] = 'cleared';
    queueWrite({ type: 'delete', table: 'bar_tabs', match: { id } });
    if (isOnline()) {
      Promise.resolve(supabase.from('bar_tabs').delete().eq('id', id)).catch(e => console.warn('[QueueSync] bar_tabs delete:', e.message));
    }
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
    const [qRes, tRes] = await Promise.all([
      supabase.from('order_queue').select('*').eq('location_id', _locationId).neq('status', 'collected'),
      supabase.from('bar_tabs').select('*').eq('location_id', _locationId).neq('status', 'closed'),
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
