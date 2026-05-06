/**
 * realtime.js — Supabase Realtime subscriptions
 *
 * In mock mode (no Supabase configured): does nothing, BroadcastChannel handles sync.
 * In production: subscribes to Postgres changes and updates the Zustand store.
 *
 * One subscription per table, scoped to the current location_id.
 * Each change event calls the appropriate store action to update state.
 */

import { supabase, isMock, LOCATION_ID } from './supabase';
import { applyQueueRealtimeEvent, applyTabRealtimeEvent } from '../sync/QueueSync';
import { playOrderChime } from './orderChime';

let channels = [];

export function startRealtime(store, locationId = LOCATION_ID) {
  if (isMock || !supabase) {
    console.info('[Realtime] Mock mode — using BroadcastChannel only');
    return () => {};
  }

  console.info('[Realtime] Connecting to location:', locationId);

  // ── KDS tickets ────────────────────────────────────────────────────────────
  const kdsChannel = supabase
    .channel(`kds:${locationId}`)
    .on('postgres_changes', {
      event: 'INSERT',
      schema: 'public',
      table: 'kds_tickets',
      filter: `location_id=eq.${locationId}`,
    }, ({ new: ticket }) => {
      store.setState(s => ({
        kdsTickets: [ticket, ...s.kdsTickets.filter(t => t.id !== ticket.id)],
      }));
    })
    .on('postgres_changes', {
      event: 'UPDATE',
      schema: 'public',
      table: 'kds_tickets',
      filter: `location_id=eq.${locationId}`,
    }, ({ new: ticket }) => {
      store.setState(s => ({
        kdsTickets: ticket.status === 'bumped'
          ? s.kdsTickets.filter(t => t.id !== ticket.id)
          : s.kdsTickets.map(t => t.id === ticket.id ? ticket : t),
      }));
    })
    .subscribe();

  // ── 86 list ────────────────────────────────────────────────────────────────
  const e86Channel = supabase
    .channel(`eighty_six:${locationId}`)
    .on('postgres_changes', {
      event: 'INSERT',
      schema: 'public',
      table: 'eighty_six',
      filter: `location_id=eq.${locationId}`,
    }, ({ new: row }) => {
      store.setState(s => ({
        eightySixIds: [...new Set([...s.eightySixIds, row.item_id])],
      }));
    })
    .on('postgres_changes', {
      event: 'DELETE',
      schema: 'public',
      table: 'eighty_six',
    }, ({ old: row }) => {
      store.setState(s => ({
        eightySixIds: s.eightySixIds.filter(id => id !== row.item_id),
      }));
    })
    .subscribe();

  // ── Config pushes ──────────────────────────────────────────────────────────
  const configChannel = supabase
    .channel(`config:${locationId}`)
    .on('postgres_changes', {
      event: 'INSERT',
      schema: 'public',
      table: 'config_pushes',
      filter: `location_id=eq.${locationId}`,
    }, ({ new: push }) => {
      if (push.snapshot) {
        store.getState().setConfigUpdate(push.snapshot);
      }
    })
    .subscribe();

  // ── Tax rates — live sync when names/rates change ──────────────────────────
  const taxChannel = supabase
    .channel(`tax:${locationId}`)
    .on('postgres_changes', {
      event: '*',
      schema: 'public',
      table: 'tax_rates',
      filter: `location_id=eq.${locationId}`,
    }, async () => {
      // Re-fetch all rates for this location when any change happens
      const { data } = await supabase
        .from('tax_rates').select('*')
        .eq('location_id', locationId)
        .eq('active', true)
        .order('rate', { ascending: false });
      if (data) store.setState({ taxRates: data.map(r => ({
        id: r.id, name: r.name, code: r.code,
        rate: parseFloat(r.rate), type: r.type,
        appliesTo: r.applies_to || ['all'],
        isDefault: r.is_default, active: r.active,
      })) });
    })
    .subscribe();

  // ── Active sessions — table open/update/close from any device ────────────────
  // REQUIRES: ALTER TABLE active_sessions REPLICA IDENTITY FULL;
  // (so DELETE events carry the full row, not just PK)
  const sessionsChannel = supabase
    .channel(`sessions:${locationId}`)
    .on('postgres_changes', {
      event: 'INSERT',
      schema: 'public',
      table: 'active_sessions',
      filter: `location_id=eq.${locationId}`,
    }, ({ new: row }) => {
      if (!row?.table_id) return;
      const state = store.getState();
      // Skip echo-back: when we open a table, flushSessions writes to Supabase.
      // The INSERT echo arrives AFTER we've added the first item, overwriting it.
      // Guard 1: never overwrite the currently active table
      if (row.table_id === state.activeTableId) return;
      // Guard 2: skip if local session is already newer (we originated this write)
      const existing = (state.tables || []).find(t => t.id === row.table_id);
      if (existing?.session?.seatedAt && row.session?.seatedAt &&
          existing.session.seatedAt >= row.session.seatedAt) return;
      store.setState(s => ({
        tables: s.tables.map(t =>
          t.id === row.table_id
            ? { ...t, session: row.session, status: 'occupied' }
            : t
        ),
      }));
    })
    .on('postgres_changes', {
      event: 'DELETE',
      schema: 'public',
      table: 'active_sessions',
      // Note: Supabase Realtime does not support row-level filters on DELETE events
      // We receive all deletes and filter by location_id in the handler
    }, ({ old: row }) => {
      if (row?.location_id && row.location_id !== locationId) return;
      const tid = row?.table_id;
      if (!tid) return;
      store.setState(s => ({
        tables: s.tables.map(t =>
          t.id === tid
            ? { ...t, session: null, status: 'available' }
            : t
        ),
      }));
    })
    .subscribe();

  // ── Closed checks — live sync across all devices ──────────────────────────
  const checksChannel = supabase
    .channel(`checks:${locationId}`)
    .on('postgres_changes', {
      event: 'INSERT',
      schema: 'public',
      table: 'closed_checks',
      filter: `location_id=eq.${locationId}`,
    }, ({ new: check }) => {
      if (!check) return;
      const normalised = {
        id: check.id, ref: check.ref, server: check.server, covers: check.covers,
        orderType: check.order_type, customer: check.customer,
        items: check.items || [], discounts: check.discounts || [],
        subtotal: check.subtotal, service: check.service, tip: check.tip, total: check.total,
        method: check.method,
        closedAt: check.closed_at ? new Date(check.closed_at).getTime() : null,
        status: check.status, refunds: check.refunds || [],
        tableId: check.table_id, tableLabel: check.table_label,
      };
      const current = store.getState().closedChecks || [];
      if (!current.find(c => c.id === normalised.id)) {
        const update = { closedChecks: [normalised, ...current] };
        // Also clear the table from the floor — this is belt-and-suspenders
        // in case the active_sessions DELETE event was missed
        if (normalised.tableId) {
          const tables = store.getState().tables || [];
          const table = tables.find(t => t.id === normalised.tableId);
          if (table?.session) {
            update.tables = tables.map(t =>
              t.id === normalised.tableId
                ? { ...t, session: null, status: 'available' }
                : t
            );
            // Clear from session backup too
            try {
              const backup = JSON.parse(localStorage.getItem('rpos-session-backup') || '{}');
              delete backup[normalised.tableId];
              localStorage.setItem('rpos-session-backup', JSON.stringify(backup));
            } catch {}
          }
        }
        store.setState(update);
      }
    })
    .subscribe();

  // ── v4.6.5 Bug 4: Walk-in / takeaway / delivery orders — cross-device sync ──
  const queueChannel = supabase
    .channel(`order_queue:${locationId}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'order_queue', filter: `location_id=eq.${locationId}` }, (payload) => {
      if (payload.eventType === 'DELETE' && payload.old?.location_id && payload.old.location_id !== locationId) return;
      applyQueueRealtimeEvent(payload);
      if (payload.eventType === 'INSERT' && payload.new?.source === 'kiosk') {
        const row = payload.new;
        const ref = row.ref || '';
        const name = row.customer?.name || 'Kiosk';
        const type = row.type || 'takeaway';
        playOrderChime();
        store.getState().showToast?.(`Kiosk order ${ref} — ${name} (${type})`, 'info');
        // Master device routes prints to production centres (idempotent — only one device claims)
        let isMaster = false;
        try { isMaster = JSON.parse(localStorage.getItem('rpos-device-config') || '{}').isMaster === true; } catch {}
        if (isMaster && !row.kitchen_routed_at) {
          store.getState().routeKioskOrderPrints?.({
            ref,
            items: row.items || [],
            customer: row.customer || null,
            sentAt: row.sent_at ? new Date(row.sent_at).getTime() : Date.now(),
          });
        }
      }
    })
    .subscribe();

  // ── v4.6.5 Bug 4: Bar tabs — cross-device sync ──────────────────────────────
  const tabsChannel = supabase
    .channel(`bar_tabs:${locationId}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'bar_tabs', filter: `location_id=eq.${locationId}` }, (payload) => {
      if (payload.eventType === 'DELETE' && payload.old?.location_id && payload.old.location_id !== locationId) return;
      applyTabRealtimeEvent(payload);
    })
    .subscribe();

  channels = [kdsChannel, e86Channel, configChannel, taxChannel, sessionsChannel, checksChannel, queueChannel, tabsChannel];

  // Backfill: master scans for unrouted kiosk orders that arrived while it was offline
  (async () => {
    try {
      let isMaster = false;
      try { isMaster = JSON.parse(localStorage.getItem('rpos-device-config') || '{}').isMaster === true; } catch {}
      if (!isMaster) return;
      const { data, error } = await supabase
        .from('order_queue')
        .select('ref, items, customer, sent_at')
        .eq('location_id', locationId)
        .eq('source', 'kiosk')
        .is('kitchen_routed_at', null)
        .neq('status', 'collected');
      if (error) { console.warn('[Realtime] kiosk backfill query failed', error); return; }
      if (data?.length) {
        console.log(`[Realtime] backfilling ${data.length} unrouted kiosk order(s)`);
        for (const row of data) {
          await store.getState().routeKioskOrderPrints?.({
            ref: row.ref,
            items: row.items || [],
            customer: row.customer || null,
            sentAt: row.sent_at ? new Date(row.sent_at).getTime() : Date.now(),
          });
        }
      }
    } catch (e) { console.warn('[Realtime] kiosk backfill failed', e?.message); }
  })();

  return () => {
    channels.forEach(ch => supabase.removeChannel(ch));
    channels = [];
  };
}

export function stopRealtime() {
  if (!supabase) return;
  channels.forEach(ch => supabase.removeChannel(ch));
  channels = [];
}
