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
      event: 'UPDATE',
      schema: 'public',
      table: 'active_sessions',
      filter: `location_id=eq.${locationId}`,
    }, ({ new: row }) => {
      // v5.5.68: voids / discounts / item edits inside an open session weren't
      // propagating because we only listened for INSERT (table opened) and
      // DELETE (table closed). Now: UPDATE merges the latest session jsonb
      // back into the matching local table. Same echo-back guards as the
      // INSERT handler — skip if this is the currently active table on this
      // device, or if our local session is newer than the incoming one.
      if (!row?.table_id) return;
      const state = store.getState();
      if (row.table_id === state.activeTableId) return;
      const existing = (state.tables || []).find(t => t.id === row.table_id);
      const localUpdated = existing?.session?.lastUpdated || existing?.session?.seatedAt || 0;
      const incomingUpdated = row.session?.lastUpdated || row.session?.seatedAt || 0;
      if (localUpdated > incomingUpdated) return;
      store.setState(s => ({
        tables: s.tables.map(t =>
          t.id === row.table_id
            ? { ...t, session: row.session, status: row.session ? 'occupied' : 'available' }
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
  // INSERT  → a check was paid on another device, prepend it to local state.
  // UPDATE  → a refund / status change happened elsewhere — merge it in so the
  //           refund history view + closed-orders list stay consistent across
  //           every POS / MPOS at the location.
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
    .on('postgres_changes', {
      event: 'UPDATE',
      schema: 'public',
      table: 'closed_checks',
      filter: `location_id=eq.${locationId}`,
    }, ({ new: check }) => {
      if (!check?.id) return;
      // Refund / status change from another device — merge the updated fields
      // (refunds[], status) into the matching local row. We don't replace the
      // whole row because the local row's camelCase shape is richer than the
      // snake_case Supabase shape; we just patch the bits the desktop POS UI
      // reads from. If the row isn't in local state yet (rare), append it.
      store.setState(s => {
        const existing = (s.closedChecks || []).find(c => c.id === check.id);
        if (existing) {
          return {
            closedChecks: s.closedChecks.map(c => c.id === check.id ? {
              ...c,
              refunds: check.refunds || [],
              status: check.status || c.status,
            } : c),
          };
        }
        // Not in local state — append a normalised row (same shape as INSERT branch)
        return {
          closedChecks: [{
            id: check.id, ref: check.ref, server: check.server, covers: check.covers,
            orderType: check.order_type, customer: check.customer,
            items: check.items || [], discounts: check.discounts || [],
            subtotal: check.subtotal, service: check.service, tip: check.tip, total: check.total,
            method: check.method,
            closedAt: check.closed_at ? new Date(check.closed_at).getTime() : null,
            status: check.status, refunds: check.refunds || [],
            tableId: check.table_id, tableLabel: check.table_label,
          }, ...s.closedChecks],
        };
      });
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
      // ── v5.5.120: ONLINE order arrives ─────────────────────────────────
      // Online orders are pre-written as status='awaiting_payment' and only
      // promoted to 'received' AFTER Stripe confirms payment. We chime/toast
      // on the UPDATE that flips status away from awaiting_payment — that's
      // the moment the order is real and the kitchen should fire it.
      if (payload.eventType === 'UPDATE' && payload.new?.source === 'online' &&
          payload.old?.status === 'awaiting_payment' &&
          payload.new?.status && payload.new.status !== 'awaiting_payment') {
        const row = payload.new;
        const ref = row.ref || '';
        const name = row.customer?.name || 'Online';
        const type = row.type || 'collection';
        playOrderChime();
        store.getState().showToast?.(`Online order ${ref} — ${name} (${type})`, 'info');
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

  // ── Menu items — live propagation of BO renames / price changes ────────────
  // Without this, a rename in Back Office only reaches other devices when they
  // reboot the app or trigger a "Push to POS". Servers see the old name on
  // MPOS and the kitchen prints stale tickets. Now any UPDATE flows through to
  // every device's menuItems store within ~500ms, with the same camelCase
  // mapping SyncBridge / useSupabaseInit use so parentId etc don't get lost.
  const menuItemsChannel = supabase
    .channel(`menu_items:${locationId}`)
    .on('postgres_changes', {
      event: '*',
      schema: 'public',
      table: 'menu_items',
      filter: `location_id=eq.${locationId}`,
    }, ({ eventType, new: row, old }) => {
      if (eventType === 'DELETE') {
        const id = old?.id;
        if (!id) return;
        store.setState(s => ({ menuItems: (s.menuItems || []).filter(m => m.id !== id) }));
        return;
      }
      if (!row?.id) return;
      const mapped = mapMenuItemRow(row);
      store.setState(s => {
        const list = s.menuItems || [];
        const idx = list.findIndex(m => m.id === mapped.id);
        if (idx === -1) return { menuItems: [...list, mapped] };
        const next = list.slice();
        next[idx] = { ...next[idx], ...mapped };
        return { menuItems: next };
      });
    })
    .subscribe();
  channels.push(menuItemsChannel);

  return () => {
    channels.forEach(ch => supabase.removeChannel(ch));
    channels = [];
  };
}

// Mirrors SyncBridge's snake→camel mapping for a single menu_items row.
// Single-source-of-truth would be cleaner long-term; this stays in lockstep
// with useSupabaseInit + SyncBridge for now.
function mapMenuItemRow(item) {
  return {
    ...item,
    price:        item.pricing?.base ?? item.price ?? 0,
    menuName:     item.menu_name    ?? item.menuName    ?? item.name ?? 'Item',
    receiptName:  item.receipt_name ?? item.receiptName ?? item.name,
    kitchenName:  item.kitchen_name ?? item.kitchenName ?? item.name,
    sortOrder:    item.sort_order   ?? item.sortOrder   ?? 0,
    parentId:     item.parent_id    ?? item.parentId    ?? null,
    soldAlone:    item.sold_alone   ?? item.soldAlone,
    centreId:     item.centre_id    ?? item.centreId    ?? null,
    taxRateId:    item.tax_rate_id  ?? item.taxRateId   ?? null,
    taxOverrides: item.tax_overrides ?? item.taxOverrides ?? {},
    assignedModifierGroups:    item.assigned_modifier_groups    ?? item.assignedModifierGroups    ?? [],
    assignedInstructionGroups: item.assigned_instruction_groups ?? item.assignedInstructionGroups ?? [],
    image: item.image ?? null,
  };
}

export function stopRealtime() {
  if (!supabase) return;
  channels.forEach(ch => supabase.removeChannel(ch));
  channels = [];
}
