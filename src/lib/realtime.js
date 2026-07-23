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
import { applyWaitlistRealtimeEvent } from '../sync/WaitlistSync';
import { reassertSession } from '../sync/SessionSync';
import { isSessionClosed } from '../sync/sessionClosure';
import { playOrderChime } from './orderChime';
import { isHubriseAutoReceipt } from './hubrise';

let channels = [];
let _rtLocation = null;   // the location the current channel set is subscribed to (for idempotency)

// v5.5.311: apply a stock_levels row to the store, keeping dailyCounts AND
// eightySixIds in sync. Previously the POS only updated dailyCounts on a remote
// stock change, but its order grid blocks solely on eightySixIds — so when
// another terminal sold the last unit, this device still let it be ordered
// (oversell). Now a remote remaining<=0 auto-86s the item everywhere, and
// remaining>0 clears a stock-driven 86. (Mirrors the kiosk handler.)
function applyStockRow(s, row) {
  const dailyCounts = { ...s.dailyCounts, [row.item_id]: { par: row.par, remaining: row.remaining } };
  // ADD-only: auto-86 when a remote terminal drives stock to zero. We do NOT
  // remove on remaining>0 here — eightySixIds also holds MANUAL operator 86s,
  // and clearing those on a stock change would wrongly un-86 them. A stock-86
  // is cleared when the operator sets a new daily count (toggle86DB) or via the
  // eighty_six DELETE channel. Add-only is fail-safe (worst case an item stays
  // greyed until refetch/reload — never an oversell).
  if (Number(row.remaining) > 0) {
    return { dailyCounts };
  }
  const ids = new Set(s.eightySixIds || []);
  ids.add(row.item_id);
  return { dailyCounts, eightySixIds: Array.from(ids) };
}

export function startRealtime(store, locationId = LOCATION_ID) {
  if (isMock || !supabase) {
    console.info('[Realtime] Mock mode — using BroadcastChannel only');
    return () => {};
  }

  // Idempotent — App's boot effect AND the waitlist/ops surfaces can both call this for the same
  // location. Re-adding `postgres_changes` callbacks to an already-subscribed channel throws
  // ("cannot add callbacks after subscribe()"). So: already streaming THIS location → keep it;
  // a DIFFERENT location (or leftover channels) → tear down cleanly first, then re-subscribe.
  if (channels.length) {
    if (_rtLocation === locationId) return stopRealtime;
    stopRealtime();
  }
  _rtLocation = locationId;

  console.info('[Realtime] Connecting to location:', locationId);

  // v5.5.561: per-terminal "Order notifications" device-profile flag. Default ON
  // (true unless explicitly false). Prefer the live store value (POSSurface keeps
  // it fresh from the DB) and fall back to the cached localStorage config.
  const orderNotificationsEnabled = () => {
    try {
      const dc = store.getState().deviceConfig;
      if (dc && dc.orderNotifications !== undefined) return dc.orderNotifications !== false;
      const ls = JSON.parse(localStorage.getItem('rpos-device-config') || '{}');
      return ls.orderNotifications !== false;
    } catch { return true; }
  };

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
      // v5.5.279: location guard — Supabase Realtime doesn't support
      // row-level filters on DELETE, so we must check client-side.
      if (row?.location_id && row.location_id !== locationId) return;
      store.setState(s => ({
        eightySixIds: s.eightySixIds.filter(id => id !== row.item_id),
      }));
    })
    .subscribe();

  // ── Stock levels — cross-device daily count sync (v5.5.239) ─────────────────
  const stockChannel = supabase
    .channel(`stock_levels:${locationId}`)
    .on('postgres_changes', {
      event: 'INSERT',
      schema: 'public',
      table: 'stock_levels',
      filter: `location_id=eq.${locationId}`,
    }, ({ new: row }) => {
      if (!row?.item_id) return;
      store.setState(s => applyStockRow(s, row));
    })
    .on('postgres_changes', {
      event: 'UPDATE',
      schema: 'public',
      table: 'stock_levels',
      filter: `location_id=eq.${locationId}`,
    }, ({ new: row }) => {
      if (!row?.item_id) return;
      store.setState(s => applyStockRow(s, row));
    })
    .on('postgres_changes', {
      event: 'DELETE',
      schema: 'public',
      table: 'stock_levels',
      // No row-level filter on DELETE — Supabase doesn't support it
    }, ({ old: row }) => {
      if (row?.location_id && row.location_id !== locationId) return;
      const itemId = row?.item_id;
      if (!itemId) return;
      store.setState(s => {
        const next = { ...s.dailyCounts };
        delete next[itemId];
        return { dailyCounts: next };
      });
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
        // v5.5.311: Auto-apply on UNATTENDED surfaces (KDS / kiosk / orders /
        // MPOS) — nobody is there to click the ConfigSyncBanner, so without
        // this they never pick up new menu items / production-centre changes
        // until a hard refresh. The attended POS counter keeps the manual
        // banner so a cashier mid-sale isn't disrupted.
        //
        // NOTE: the previous v5.5.304 gate read store.appMode, which is NEVER
        // set to these values (it defaults 'pos' and is only ever set to
        // 'backoffice') — so the auto-apply was dead code. We now read the
        // device's persisted surface/mode from localStorage, which is reliable.
        try {
          let surface = '';
          try { surface = JSON.parse(localStorage.getItem('rpos-device-config') || '{}')?.defaultSurface || ''; } catch { /* none */ }
          let devMode = '';
          try { devMode = localStorage.getItem('rpos-device-mode') || ''; } catch { /* none */ }
          const unattended = ['kds', 'kiosk', 'orders', 'mpos'];
          if (unattended.includes(surface) || devMode === 'kiosk' || devMode === 'mpos') {
            store.getState().applyConfigUpdate();
          }
        } catch { /* leave for manual banner */ }
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
      // Ignore a cashed-off ghost re-published by a device that hadn't yet learned of
      // the close — this is a re-add door for a resurrected table (see sessionClosure).
      if (isSessionClosed(row.table_id, row.session)) return;
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
      // A cashed-off ghost UPDATE'd by another device must not repaint the floor.
      if (isSessionClosed(row.table_id, row.session)) return;
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
      const state = store.getState();
      const localTable = (state.tables || []).find(t => t.id === tid);
      // v5.5.283 Guard 1: never clear the table this device is actively editing
      if (tid === state.activeTableId) {
        // v5.5.639: the shared row was deleted out-of-band but we keep our live session — re-publish
        // it so active_sessions reconverges (otherwise the SessionSync _lastSent latch never re-writes
        // it and the table silently vanishes from the waitlist/other devices).
        if (localTable?.session) reassertSession(tid);
        return;
      }
      // v5.5.283 Guard 2: if local session is newer than what was deleted, keep it.
      // Protects re-seated tables from stale DELETE events.
      if (localTable?.session) {
        const localSeated = localTable.session.seatedAt || 0;
        const deletedSeated = row?.session?.seatedAt || 0;
        if (deletedSeated && localSeated > deletedSeated) { reassertSession(tid); return; }
        // Fallback when REPLICA IDENTITY doesn't include session:
        // preserve sessions that have items (active orders)
        if (!deletedSeated && localTable.session.items?.length > 0) { reassertSession(tid); return; }
      }
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
        // Carry the occupation's seatedAt (epoch ms) so isSessionClosed can tombstone
        // the exact session that was paid — this is how the close reaches other devices.
        seatedAt: check.seated_at ? new Date(check.seated_at).getTime() : (check.seatedAt || null),
        status: check.status, refunds: check.refunds || [],
        tableId: check.table_id, tableLabel: check.table_label,
      };
      const current = store.getState().closedChecks || [];
      if (!current.find(c => c.id === normalised.id)) {
        const update = { closedChecks: [normalised, ...current] };
        // Also clear the table from the floor — this is belt-and-suspenders
        // in case the active_sessions DELETE event was missed
        if (normalised.tableId) {
          const curState = store.getState();
          // v5.5.283: don't clear the table this device is actively editing
          if (normalised.tableId !== curState.activeTableId) {
            const tables = curState.tables || [];
            const table = tables.find(t => t.id === normalised.tableId);
            if (table?.session) {
              // v5.5.283: staleness check — only clear if this session belongs
              // to the check that was just closed. If re-seated after close, keep it.
              const sessionSeated = table.session.seatedAt || 0;
              const checkClosed = normalised.closedAt || 0;
              const isStale = !sessionSeated || !checkClosed || sessionSeated <= checkClosed;
              if (isStale) {
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
      // v5.5.850: Cross-device popup clear — another till decided this order: accepted it
      // (status → prep/ready/collected) or rejected/removed it (row DELETE). Take this
      // device's new-order popup down too. 'cancelled' is deliberately excluded: the
      // v5.5.550 block below REPLACES the popup with the red cancel card. kind:'cancel'
      // cards are never auto-cleared (staff must reconcile).
      {
        const alert = store.getState().orderAlert;
        const evRef = payload.new?.ref || payload.old?.ref;
        if (alert && !alert.kind && evRef && alert.ref === evRef) {
          // v5.5.869: dismiss ONLY on a genuine status TRANSITION. Online orders are born
          // 'prep', and the master's kitchen_routed_at claim (~0.4s after the INSERT) is an
          // UPDATE that leaves status unchanged (prep→prep) — that was matching this condition
          // and tearing the just-shown new-order banner down in a split second. Requiring
          // old.status !== new.status (order_queue is REPLICA IDENTITY FULL, so old.status is
          // present) means only a real accept/advance by another till clears it; the banner now
          // runs its full 5s. DELETE (rejected/removed) still clears immediately.
          const decided = payload.eventType === 'DELETE'
            || (payload.eventType === 'UPDATE'
                && ['prep', 'ready', 'collected'].includes(payload.new?.status)
                && payload.old?.status !== payload.new?.status);
          if (decided) store.getState().dismissOrderAlert?.();
        }
      }
      // v5.5.122: every NEW order from a customer surface (kiosk / online /
      // QR table-side) fires the loud chime + a top-of-screen OrderAlert
      // banner that stays for 5s and is dismissable. Online orders are
      // written to order_queue ONLY after Stripe payment succeeds, so the
      // INSERT itself is the moment of truth.
      if (payload.eventType === 'INSERT' && ['kiosk','online','qr','hubrise'].includes(payload.new?.source)) {
        const row = payload.new;
        const src = row.source;
        const ref = row.ref || '';
        // "who" prefers table label for QR, channel name for HubRise, else customer name
        const tableLabel = row.customer?.tableLabel || row.customer?.tableId;
        const who = src === 'qr'
          ? (tableLabel ? `Table ${tableLabel}` : (row.customer?.name || 'QR order'))
          : src === 'hubrise'
          ? (row.customer?.channel || 'Delivery order')
          : (row.customer?.name || (src === 'online' ? 'Online customer' : 'Walk-in'));
        // v5.5.561: per-terminal "Order notifications" toggle (device profile).
        // When OFF this terminal stays silent — no chime, no popup — but it STILL
        // routes & prints (the master auto-route block below is untouched). Prefer
        // the live store value (kept fresh by POSSurface) over the cached localStorage.
        if (orderNotificationsEnabled()) {
          playOrderChime();
          store.getState().showOrderAlert?.({
            source: src, who, ref,
            total: Number(row.total) || 0,
            orderType: row.type || null,
            status: row.status || null,   // lets the popup show Accept/Reject vs View
          });
        }
        // v5.5.139: ONLY the master device fires the realtime auto-route.
        // Reverting v5.5.132's broader gate because the cross-device atomic
        // claim it relied on (kitchen_routed_at IS NULL) doesn't work when
        // the column is missing from the DB — every device proceeded and
        // we got 5 duplicate prints for one order. Master-only is the safe
        // default. Once the SQL `alter table order_queue add column …
        // kitchen_routed_at` is applied on this venue's DB, we could broaden
        // the gate again, but master-only is the minimum-surprise behaviour
        // (matches kiosk-source path that's worked correctly all along).
        let isMaster = false;
        try { isMaster = JSON.parse(localStorage.getItem('rpos-device-config') || '{}').isMaster === true; } catch {}
        // HubRise/channel orders aren't auto-printed on receipt when manual-accept is on —
        // staff Accept them in the Orders Hub (which prints + confirms a prep time back to the
        // channel). When the venue AUTO-accepts, the row arrives already 'prep', so it prints.
        const hubriseAuto = src === 'hubrise' && row.status === 'prep';
        if (isMaster && !row.kitchen_routed_at && (src !== 'hubrise' || hubriseAuto)) {
          store.getState().routeKioskOrderPrints?.({
            ref,
            source: src,                                     // 'kiosk' | 'online' | 'qr' | 'hubrise'
            tableLabel: row.customer?.tableLabel || null,    // QR only
            items: row.items || [],
            customer: row.customer || null,
            collectionTime: row.collection_time || null,
            isASAP: !!row.is_asap,
            sentAt: row.sent_at ? new Date(row.sent_at).getTime() : Date.now(),
          });
          // Auto-accepted HubRise order → also auto-print the dispatch receipt (if enabled).
          if (hubriseAuto && isHubriseAutoReceipt(locationId)) {
            store.getState().printHubriseReceipt?.({
              ref: row.ref, customer: row.customer || null, items: row.items || [],
              total: row.total, collectionTime: row.collection_time || null, isASAP: !!row.is_asap,
            });
          }
        }
      }
      // v5.5.550: a channel-side cancellation (HubRise order.update -> status cancelled,
      // written by hubrise-webhook) must NOT be silent — the kitchen may be mid-prep.
      // Fire the chime + a banner so staff stop and reconcile.
      if (payload.eventType === 'UPDATE'
          && payload.new?.source === 'hubrise'
          && payload.new?.status === 'cancelled'
          && payload.old?.status !== 'cancelled') {
        if (orderNotificationsEnabled()) {
          playOrderChime();
          store.getState().showOrderAlert?.({
            source: 'hubrise',
            kind: 'cancel',
            who: `${payload.new.customer?.channel || 'HubRise'}`,
            ref: payload.new.ref || '',
            total: 0,
            orderType: payload.new.type || null,
            status: 'cancelled',
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

  // ── Tables Ready — live waitlist board across devices ───────────────────────
  const waitlistChannel = supabase
    .channel(`waitlist_entries:${locationId}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'waitlist_entries', filter: `location_id=eq.${locationId}` }, (payload) => {
      if (payload.eventType === 'DELETE' && payload.old?.location_id && payload.old.location_id !== locationId) return;
      applyWaitlistRealtimeEvent(payload);
    })
    .subscribe();

  channels = [kdsChannel, e86Channel, stockChannel, configChannel, taxChannel, sessionsChannel, checksChannel, queueChannel, tabsChannel, waitlistChannel];

  // Backfill: master scans for unrouted customer-surface orders (kiosk / online / qr / hubrise)
  // that arrived while it was offline OR that were scheduled and are now due. routeKioskOrderPrints
  // internally defers if sent_at is still in the future and HOLDS anything >2h stale (boot backstop).
  (async () => {
    try {
      let isMaster = false;
      try { isMaster = JSON.parse(localStorage.getItem('rpos-device-config') || '{}').isMaster === true; } catch {}
      if (!isMaster) return;
      const { data, error } = await supabase
        .from('order_queue')
        .select('ref, source, items, customer, sent_at, status, collection_time, is_asap')
        .eq('location_id', locationId)
        .in('source', ['kiosk', 'online', 'qr', 'hubrise'])
        .is('kitchen_routed_at', null)
        .neq('status', 'collected')
        .limit(100); // bounded backfill — a bigger backlog signals a kitchen issue, not a sync job
      if (error) { console.warn('[Realtime] order backfill query failed', error); return; }
      if (data?.length) {
        console.log(`[Realtime] backfilling ${data.length} unrouted order(s)`);
        for (const row of data) {
          // HubRise on manual-accept arrives as 'received' and must wait for staff Accept in the
          // Orders Hub (which prints + confirms a prep time back to the channel). Only auto-route
          // hubrise rows the venue auto-accepted (already 'prep') — mirrors the live INSERT handler.
          if (row.source === 'hubrise' && row.status !== 'prep') continue;
          await store.getState().routeKioskOrderPrints?.({
            ref: row.ref,
            source: row.source,
            tableLabel: row.customer?.tableLabel || null,
            items: row.items || [],
            customer: row.customer || null,
            collectionTime: row.collection_time || null,
            isASAP: !!row.is_asap,
            sentAt: row.sent_at ? new Date(row.sent_at).getTime() : Date.now(),
          });
        }
      }
    } catch (e) { console.warn('[Realtime] order backfill failed', e?.message); }
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

  // ── Activity feed → toast + chime on the tills for action/urgent items (nudges, alerts, …) ──
  // (The bell/panel UI subscribes separately for the full feed; this is just the live alert.)
  const activityChannel = supabase
    .channel(`activity:${locationId}`)
    .on('postgres_changes', {
      event: 'INSERT', schema: 'public', table: 'activity_events', filter: `location_id=eq.${locationId}`,
    }, ({ new: a }) => {
      try {
        if (a.severity !== 'action' && a.severity !== 'urgent') return;          // info items: feed only, no toast
        if (a.created_at && Date.now() - new Date(a.created_at).getTime() > 60000) return; // ignore backfill on reconnect
        const msg = [a.title, a.body].filter(Boolean).join(' · ');
        store.getState().showToast?.(`${msg}${a.actor_name ? ` — ${a.actor_name}` : ''}`, a.severity === 'urgent' ? 'error' : 'info');
        playOrderChime();
      } catch { /* noop */ }
    })
    .subscribe();
  channels.push(activityChannel);

  // Single teardown path (resets _rtLocation too) so a later startRealtime re-subscribes cleanly.
  return stopRealtime;
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
  _rtLocation = null;
}
