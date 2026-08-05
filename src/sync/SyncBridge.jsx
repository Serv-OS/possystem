import { useEffect, useRef } from 'react';
import { useStore } from '../store';
import { subscribeToSessions, scheduleFlush, flushSessions, teardown as teardownSessions } from './SessionSync';
import { loadReservations, scheduleReservationFlush, subscribeToReservations, teardownReservations } from './ReservationSync';
import { loadQueues, scheduleQueueFlush, teardownQueueSync } from './QueueSync';
import { loadWaitlistSync, scheduleWaitlistFlush, teardownWaitlistSync } from './WaitlistSync';
import { initOfflineQueue } from './OfflineQueue';
import { isMock, supabase, getActiveLocationSync, ensureAuthToken } from '../lib/supabase';
import { retryPendingRedemptions } from '../lib/commitRedemptions';
import { startSessionReconciler, stopSessionReconciler } from './SessionReconciler';
import { startTerminalJobReconciler, stopTerminalJobReconciler } from './TerminalJobReconciler';
// v4.6.27: static import per ADR-008. Dynamic imports inside callbacks silently
// fail in production bundles and have caused multiple data-loss bugs.
import { reconcilePendingChecks, onReconnect, periodicSync } from './DataSafe.js';
import { getShowItemImages } from '../lib/locationTime';

const OPS_URL = import.meta.env.VITE_SUPABASE_URL;

export const CHANNEL_NAME = 'rpos-sync';
export const STORAGE_KEY  = 'rpos-shared-state';
export const TAB_ID       = Math.random().toString(36).slice(2, 10);

// Operational state — syncs in real-time across all terminals
const OPERATIONAL_KEYS = [
  'kdsTickets', 'eightySixIds', 'dailyCounts',
  'closedChecks', 'orderQueue', 'tabs', 'printJobs',
  'pettyCashEntries', // v4.6.30
];

// Table status/session sync (operational part only — layout comes via CONFIG_PUSH)
// We sync the whole tables array but the POS only applies non-layout fields from broadcasts
// Layout (x,y,w,h,label,section,shape) only changes via CONFIG_PUSH
const SHARED_KEYS = [...OPERATIONAL_KEYS, 'tables', 'showItemImages', 'takeawayCustomerDetails'];

let channelInstance = null;
export function getChannel() { return channelInstance; }

function getSharedState() {
  const s = useStore.getState();
  const r = {};
  for (const k of SHARED_KEYS) r[k] = s[k];
  return r;
}

export default function SyncBridge({ onSyncPulse }) {
  const isApplyingRef = useRef(false);

  useEffect(() => {
    // Load persisted operational state on mount
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        isApplyingRef.current = true;
        const parsed = JSON.parse(saved);
        // In real Supabase mode, strip menu/product data — loaded from DB instead
        if (!isMock) {
          delete parsed.menus;
          delete parsed.menuCategories;
          delete parsed.menuItems;
          // v5.5.833: there is deliberately no `delete parsed.modifierGroupDefs` here.
          // Menu data is never persisted to localStorage in real mode — SHARED_KEYS
          // (see top of file) carries operational state only, so getSharedState() never
          // writes any menu slice. The deletes above are belt-and-braces for legacy
          // payloads written by older builds with a wider SHARED_KEYS.
          delete parsed.itemVariants;
          delete parsed.staff;
          delete parsed.tables;
          delete parsed.sections;
          delete parsed.eightySix;
          delete parsed.tabs;          // bar tabs are session-only in real mode
          // NOTE: quickScreenIds is kept — it's config pushed from back office
          // NOTE: closedChecks are kept from localStorage as fast fallback
        }
        useStore.setState(parsed);
        isApplyingRef.current = false;
      }
    } catch {}

    // Apply config snapshot on mount
    // In mock mode: read from localStorage snapshot
    // In real mode: fetch latest push from Supabase for this location
    //
    // v5.5.962: the boot config-push apply is captured as a promise so the
    // location-settings loader below can run strictly AFTER it. The last push
    // snapshot goes stale by design (quick-screen saves write locations
    // directly, no new push), so the fresh locations read must always land
    // last or a reboot could revert quick screen / mode to last-push values.
    let bootConfigLoad = Promise.resolve();
    if (isMock) {
      try {
        const snap = localStorage.getItem('rpos-config-snapshot');
        if (snap) {
          const parsed = JSON.parse(snap);
          useStore.getState().setConfigUpdate(parsed);
          useStore.getState().applyConfigUpdate();
        }
      } catch {}
    } else {
      // Load latest config push from Supabase for this location
      bootConfigLoad = (async () => {
        try {
          // v5.5.235: respect rpos-bo-location override BEFORE rpos-device.
          // Previously this read rpos-device.locationId directly, skipping the BO
          // override. When the same browser was paired as POS at Loc A then used
          // as BO for Loc B, SyncBridge loaded Loc A's menus — causing menu bleed.
          //
          // v5.5.237: use getActiveLocationSync() instead of async getLocationId().
          // getLocationId() calls supabase.auth.getUser() which is a network
          // round-trip that hangs on POS/MPOS devices without an auth session,
          // causing menus and tables to never load. getActiveLocationSync() is
          // synchronous (reads localStorage only) and has the same priority chain:
          // rpos-bo-location first, then rpos-device.locationId.
          const locationId = getActiveLocationSync();
          if (!locationId || locationId === 'loc-demo') return;

          // v5.5.238: Location integrity guard — if the store has data from a
          // DIFFERENT location (e.g. browser was used for Location A then switched
          // to Location B without a full reload), purge stale menu/table data
          // BEFORE loading fresh data. This prevents cross-location bleed even if
          // the tenant fence missed a transition.
          const prevDataLoc = useStore.getState()._dataLocationId;
          if (prevDataLoc && prevDataLoc !== locationId) {
            console.warn('[SyncBridge] v5.5.238: location changed', prevDataLoc, '→', locationId, '— purging stale data');
            useStore.setState({
              menuItems: [],
              menuCategories: [],
              menus: [],
              modifierGroupDefs: [],
              tables: [],
              sections: [],
              closedChecks: [],
              _dataLocationId: null,
            });
          }

          // v5.5.893: CACHE-FIRST boot. Real-mode devices had NO local snapshot cache (only mock
          // did) — every boot blocked the menu on a network fetch, and an offline boot had no menu
          // at all. Apply the last snapshot for THIS location instantly, then let the network
          // fetch below re-apply the fresh one when it lands (same idempotent path a live config
          // push uses). Keyed by location so the v5.5.238 cross-location purge stays honoured —
          // offline-fallback caching in localStorage is the sanctioned exception (CLAUDE.md).
          try {
            const cachedRaw = localStorage.getItem('rpos-config-cache');
            if (cachedRaw) {
              const cached = JSON.parse(cachedRaw);
              if (cached?.locationId === locationId && cached?.snapshot) {
                useStore.getState().setConfigUpdate(cached.snapshot);
                useStore.getState().applyConfigUpdate();
                console.log('[SyncBridge] applied cached config snapshot (instant boot) — network refresh follows');
              }
            }
          } catch { /* cache is best-effort */ }

          const { fetchLatestConfigPush, fetchFloorPlan, fetchMenuItems, fetchMenuCategories, fetchMenus, fetch86List, fetchStockLevels } = await import('../lib/db.js');
          const { supabase: sb2 } = await import('../lib/supabase.js');

          // Load config push (menus, layout, sections)
          const { data } = await fetchLatestConfigPush(locationId);
          if (data?.snapshot) {
            useStore.getState().setConfigUpdate(data.snapshot);
            useStore.getState().applyConfigUpdate();
            try { localStorage.setItem('rpos-config-cache', JSON.stringify({ locationId, snapshot: data.snapshot, at: Date.now() })); } catch {}
          }

          // v5.5.734: the pushed config snapshot is the AUTHORITATIVE cache for menu data. Below we
          // ALSO fetch menu items/categories/menus/modifier-groups straight from the DB — but if the
          // snapshot already provided them we must NOT re-apply the DB copy, because SyncBridge
          // remounts on every login (it's rendered in both the PIN-screen and signed-in branches),
          // so re-writing the menu with a DB-ordered copy made the category bar visibly reflow
          // ("move then move back") on every sign-in. The snapshot wins; the DB read is a fallback
          // only when nothing was pushed (fresh install). A new Push to POS refreshes it via realtime.
          const snap = data?.snapshot || null;
          const snapHas = (k) => Array.isArray(snap?.[k]) && snap[k].length > 0;

          // Load floor plan + active sessions atomically — never set session:null then restore
          const { supabase: sb, getLocationId } = await import('../lib/supabase.js');
          // v5.5.834: allSettled, NOT all. Promise.all rejects on the first failing leg,
          // so one thrown fetch (a dropped connection mid-boot) discarded the ENTIRE boot
          // patch — no tables, no menu, no modifier groups — instead of just that slice.
          // unwrap() puts every leg back into the familiar { data, error } shape, so a
          // rejected leg reads as `data: null` and is skipped by the same guards below
          // that already skip an empty read. Nothing downstream changes shape.
          const [floorSt, itemsSt, catsSt, menusSt, sessionsSt, profilesSt, modGroupsSt, e86St, stockSt] = await Promise.allSettled([
            fetchFloorPlan(locationId),
            fetchMenuItems(locationId),
            fetchMenuCategories(locationId),
            fetchMenus(locationId),
            sb ? sb.from('active_sessions').select('table_id,session').eq('location_id', locationId) : Promise.resolve({ data: [] }),
            sb2 ? sb2.from('device_profiles').select('*').eq('location_id', locationId) : Promise.resolve({ data: [] }),
            // v5.5.834: `data: null` (not []) when there's no client — "no read happened",
            // which the authoritative-empty-read guard below must NOT mistake for "no groups".
            sb ? sb.from('modifier_groups').select('*').eq('location_id', locationId).order('sort_order') : Promise.resolve({ data: null }),
            fetch86List(locationId),                                  // v5.5.142: hydrate eightySixIds on boot
            fetchStockLevels(locationId),                             // v5.5.239: hydrate stock counts on boot
          ]);
          const unwrap = (r) => (r.status === 'fulfilled' && r.value) ? r.value : { data: null, error: r.reason || new Error('boot fetch failed') };
          const floorRes    = unwrap(floorSt);
          const itemsRes    = unwrap(itemsSt);
          const catsRes     = unwrap(catsSt);
          const menusRes    = unwrap(menusSt);
          const sessionsRes = unwrap(sessionsSt);
          const profilesRes = unwrap(profilesSt);
          const modGroupsRes = unwrap(modGroupsSt);
          const e86Res      = unwrap(e86St);
          const stockRes    = unwrap(stockSt);
          [floorSt, itemsSt, catsSt, menusSt, sessionsSt, profilesSt, modGroupsSt, e86St, stockSt]
            .filter(r => r.status === 'rejected')
            .forEach(r => console.warn('[SyncBridge] boot fetch leg failed (other slices still applied):', r.reason?.message || r.reason));
          // v5.5.142: write fetched 86 list into the store immediately so
          // any items already 86'd at boot show OUT OF STOCK on Kiosk / MPOS
          // / POS without waiting for a realtime event that won't fire
          // (realtime only delivers INSERT / DELETE going forward, not
          // existing rows). Merge with whatever's already in the store so
          // we don't clobber an in-flight local toggle.
          if (e86Res?.data?.length) {
            const remoteIds = e86Res.data.map(r => r.item_id).filter(Boolean);
            useStore.setState(s => ({
              eightySixIds: [...new Set([...(s.eightySixIds || []), ...remoteIds])],
            }));
          }
          // v5.5.239: hydrate dailyCounts from stock_levels so every device sees
          // the current stock on boot — not just the device that set it.
          if (stockRes?.data?.length) {
            const dbCounts = {};
            stockRes.data.forEach(r => {
              dbCounts[r.item_id] = { par: r.par, remaining: r.remaining };
            });
            useStore.setState(s => ({
              dailyCounts: { ...s.dailyCounts, ...dbCounts },
            }));
          }
          // Cache profiles to localStorage so they survive offline
          if (profilesRes?.data?.length) {
            const mapped = profilesRes.data.map(p => ({
              id: p.id, name: p.name, color: p.color,
              defaultSurface: p.default_surface, enabledOrderTypes: p.enabled_order_types || ['dine-in'],
              assignedSection: p.assigned_section, hiddenFeatures: p.hidden_features || [],
              tableServiceEnabled: p.table_service_enabled !== false,
              quickScreenEnabled: p.quick_screen_enabled !== false,
              menuId: p.menu_id,
              serviceCharge: p.service_charge || null,
            }));
            try { localStorage.setItem('rpos-device-profiles', JSON.stringify(mapped)); } catch {}
          }
          const patch = {};
          if (floorRes.data?.tables?.length) {
            // Build a session map from Supabase active_sessions
            const sessionMap = {};
            (sessionsRes?.data || []).forEach(row => {
              if (row.table_id && row.session) sessionMap[row.table_id] = row.session;
            });
            // Also check localStorage backup for any sessions not yet written to Supabase
            try {
              const lsBackup = JSON.parse(localStorage.getItem('rpos-session-backup') || '{}');
              Object.entries(lsBackup).forEach(([tid, sess]) => {
                if (!sessionMap[tid]) sessionMap[tid] = sess;
              });
            } catch {}
            // v4.5.0: ALSO check the synchronous emergency snapshot (written from
            // SyncBridge's subscribe handler on every meaningful change). This bypasses
            // the SessionSync write path entirely and survives wake-from-sleep even if
            // the active_sessions table write was silently failing.
            try {
              const snap = JSON.parse(localStorage.getItem('rpos-session-snapshot') || '{}');
              if (snap?.sessions) {
                Object.entries(snap.sessions).forEach(([tid, sess]) => {
                  if (!sessionMap[tid]) {
                    sessionMap[tid] = sess;
                    console.log('[SyncBridge] v4.5.0: rescued session for table', tid, 'from emergency snapshot');
                  }
                });
              }
            } catch {}
            // v4.5.0: PRESERVE in-memory sessions when DB + backup are silent.
            // Mac wake / page re-init was wiping live sessions because active_sessions
            // writes weren't reaching DB and the boot rebuild trusted (DB || backup || null).
            // Now: also fall back to whatever is already in the live Zustand store before
            // declaring a table empty. closedChecks already does this kind of additive merge.
            const existingTablesInStore = useStore.getState().tables || [];
            const existingById = Object.fromEntries(existingTablesInStore.map(t => [t.id, t]));
            // Build tables with sessions already applied — never flash as empty
            const tables = floorRes.data.tables.map(t => {
              const inMemory = existingById[t.id];
              const session = sessionMap[t.id] || inMemory?.session || null;
              if (!sessionMap[t.id] && inMemory?.session) {
                console.warn('[SyncBridge] v4.5.0: preserving in-memory session for table', t.label || t.id, '— DB + backup were silent. Items:', inMemory.session.items?.length);
              }
              // v4.6.5 Bug 6: floor_tables uses snake_case (max_covers, sort_order) but every
              // TablesSurface read expects camelCase (maxCovers). Rename on hydration.
              // v5.5.2: also preserve location_id so the cross-location guard in upsertFloorTable
              // can refuse silent moves when the read/write paths disagree about location.
              return {
                ...t,
                maxCovers: t.max_covers ?? t.maxCovers ?? 4,
                sortOrder: t.sort_order ?? t.sortOrder ?? 0,
                locationId: t.location_id ?? t.locationId ?? locationId,
                status: session ? 'occupied' : 'available',
                session,
                firedCourses: session?.firedCourses || inMemory?.firedCourses || [],
                sentAt: session?.sentAt || inMemory?.sentAt || null,
              };
            });
            patch.tables = tables;
          }
          if (itemsRes.data?.length && !snapHas('menuItems')) patch.menuItems = itemsRes.data.map(item => ({
            ...item,
            price: item.pricing?.base ?? item.price ?? 0,
            menuName: item.menu_name ?? item.menuName ?? item.name ?? 'Item',
            receiptName: item.receipt_name ?? item.receiptName ?? item.name,
            kitchenName: item.kitchen_name ?? item.kitchenName ?? item.name,
            sortOrder: item.sort_order ?? item.sortOrder ?? 0,
            parentId: item.parent_id ?? item.parentId ?? null,
            soldAlone: item.sold_alone ?? item.soldAlone,
            centreId: item.centre_id ?? item.centreId ?? null,
            taxRateId: item.tax_rate_id ?? item.taxRateId ?? null,
            taxOverrides: item.tax_overrides ?? item.taxOverrides ?? {},
            // Must map snake_case → camelCase for modifier and instruction groups
            assignedModifierGroups: item.assigned_modifier_groups ?? item.assignedModifierGroups ?? [],
            assignedInstructionGroups: item.assigned_instruction_groups ?? item.assignedInstructionGroups ?? [],
            optionGroupOrder: item.option_group_order ?? item.optionGroupOrder ?? null,   // v5.5.948 combined flow order
            image: item.image ?? null,
            tags: Array.isArray(item.tags) ? item.tags : [],   // dietary tags (V/VG/GF/DF)
          }));

          // Sync any local-only items that failed to save previously (e.g. before schema was ready)
          // This ensures items created offline or before column fixes are never lost.
          //
          // v4.6.12 Bug: the remoteIds set MUST include archived rows as well, not just
          // what itemsRes.data returns (which is filtered to archived=false). Otherwise an
          // archived item whose local state briefly shows archived=false — e.g. right after
          // hydration when a stale config snapshot predates the archive — looks like an
          // "orphan" and gets re-uploaded with archived=false, resurrecting it in DB.
          // Fetch a lightweight id-only list without the archived filter for the comparison.
          if (sb && locationId && itemsRes.data?.length) {
            try {
              const { upsertMenuItem } = await import('../lib/db.js');
              const { data: allRows } = await sb.from('menu_items').select('id').eq('location_id', locationId);
              const remoteIds = new Set((allRows || []).map(i => i.id));
              const localItems = useStore.getState().menuItems || [];
              const localOnly = localItems.filter(i =>
                !remoteIds.has(i.id) && !i.archived && i.id && !i.id.startsWith('demo-')
              );
              if (localOnly.length > 0) {
                console.log(`[SyncBridge] Syncing ${localOnly.length} local-only items to Supabase`);
                localOnly.forEach(item => upsertMenuItem({ ...item, location_id: locationId }));
              }
            } catch (e) { console.warn('[SyncBridge] local-only sync failed', e); }
          }

          // Load tax rates directly from Supabase (source of truth)
          if (sb && locationId) {
            try {
              const { data: taxData } = await sb.from('tax_rates').select('*').eq('location_id', locationId).eq('active', true).order('rate', { ascending: false });
              if (taxData?.length) patch.taxRates = taxData.map(r => ({
                id: r.id, name: r.name, code: r.code,
                rate: parseFloat(r.rate), type: r.type,
                appliesTo: r.applies_to || ['all'],
                isDefault: r.is_default, active: r.active,
              }));
            } catch {}
          }

          // Load discount presets + auto-discount rules
          if (sb && locationId) {
            try {
              const [discRes, rulesRes] = await Promise.all([
                sb.from('discounts').select('*').eq('location_id', locationId).eq('active', true).order('sort_order'),
                sb.from('discount_rules').select('*').eq('location_id', locationId).eq('active', true).order('priority', { ascending: false }),
              ]);
              if (discRes.data?.length) patch.discountPresets = discRes.data.map(d => ({
                id: d.id, name: d.name, label: d.name,
                type: d.type, value: parseFloat(d.value),
                scope: d.scope,
                categoryIds: d.category_ids || [],
                requiresManager: d.requires_manager ?? false,
                active: d.active, sortOrder: d.sort_order ?? 0,
              }));
              if (rulesRes.data?.length) patch.discountRules = rulesRes.data.map(r => ({
                id: r.id, name: r.name, active: r.active,
                triggerType: r.trigger_type, triggerCategoryIds: r.trigger_category_ids || [],
                triggerQty: r.trigger_qty,
                triggerGroups: r.trigger_groups || null,
                rewardType: r.reward_type, rewardValue: parseFloat(r.reward_value),
                rewardQty: r.reward_qty,
                rewardCategoryIds: r.reward_category_ids || [],
                channels: r.channels || { pos: true, online: true, qr: true, kiosk: true },
                schedule: r.schedule || null,   // day/time-window/expiry gate (discountEngine.isRuleActiveNow)
                priority: r.priority ?? 0, sortOrder: r.sort_order ?? 0,
              }));
            } catch (e) { console.warn('[SyncBridge] discount load error:', e?.message); }
          }
          if (catsRes.data?.length && !snapHas('menuCategories')) patch.menuCategories = catsRes.data.map(cat => ({
            ...cat,
            parentId: cat.parent_id ?? cat.parentId ?? null,
            menuId: cat.menu_id ?? cat.menuId,
            sortOrder: cat.sort_order ?? cat.sortOrder ?? 0,
            accountingGroup: cat.accounting_group ?? cat.accountingGroup ?? '',
            label: cat.label ?? cat.name ?? 'Category',
            icon: cat.icon ?? '🍽',
            color: cat.color ?? '#3b82f6',
            defaultCourse: cat.default_course ?? cat.defaultCourse ?? 1,
            spacerSlots: cat.spacer_slots ?? cat.spacerSlots ?? [],
            isSpecial: cat.is_special ?? cat.isSpecial ?? false,  // v5.5.316: map so POS/bar/inventory hide special cats
          }));
          if (menusRes.data?.length && !snapHas('menus')) patch.menus = menusRes.data;
          // v5.5.834: a SUCCESSFUL read wins for this slice — INCLUDING an empty array.
          // Modifier groups are written straight to modifier_groups and are never authored
          // by the config push, so "snapshot wins" (the v5.5.734 guard) was always wrong
          // here: a stale snapshot re-hydrated groups the operator had just deleted.
          // `data: []` with no error is authoritative (there really are no groups);
          // `data: null` means the read failed, so we leave the store alone.
          // Pairs with v5.5.833's empty-array skip in applyConfigUpdate — without BOTH,
          // deleting your LAST group makes it immortal on every till.
          // Do NOT copy this to menuItems / menus / menuCategories: the snapHas guard
          // there is the deliberate v5.5.734 anti-reflow fix.
          if (modGroupsRes.data) patch.modifierGroupDefs = modGroupsRes.data.map(g => ({
            id: g.id, name: g.name,
            min: g.min ?? 0, max: g.max ?? 1,
            selectionType: g.selection_type ?? 'single',
            options: g.options ?? [],
            sortOrder: g.sort_order ?? 0,
          }));

          // Load today's closed checks from Supabase — CRITICAL for sales history
          try {
            const { fetchClosedChecks } = await import('../lib/db.js');
            const checksRes = await fetchClosedChecks(locationId, 500);
            if (checksRes.data?.length) {
              // Merge with any localStorage checks not yet written to Supabase
              // v5.5.279: location filter on localStorage checks — prevents cross-location
              // bleed when a browser was previously used for a different location.
              const supabaseIds = new Set(checksRes.data.map(c => c.id));
              const lsChecks = (() => {
                try {
                  const s = JSON.parse(localStorage.getItem('rpos-shared-state') || '{}');
                  return (s.closedChecks || []).filter(c =>
                    !supabaseIds.has(c.id) &&
                    (!c.locationId || c.locationId === locationId)
                  );
                } catch { return []; }
              })();
              patch.closedChecks = [...checksRes.data, ...lsChecks]
                .sort((a, b) => (b.closedAt || 0) - (a.closedAt || 0));
            }
          } catch(e) { console.warn('[SyncBridge] closed checks load error:', e.message); }

          if (Object.keys(patch).length) useStore.setState(patch);

          // v5.5.238: Stamp the store with the location this data belongs to,
          // and validate that no cross-location items snuck in.
          useStore.setState({ _dataLocationId: locationId });
          const loadedItems = useStore.getState().menuItems || [];
          const foreignItems = loadedItems.filter(i => i.location_id && i.location_id !== locationId);
          if (foreignItems.length > 0) {
            console.error('[SyncBridge] v5.5.238: CROSS-LOCATION DATA DETECTED —', foreignItems.length, 'items from wrong location. Purging.');
            useStore.setState({ menuItems: loadedItems.filter(i => !i.location_id || i.location_id === locationId) });
          }

          // Reconcile any pending checks that didn't make it to Supabase
          // (e.g. payment taken while offline, page reloaded before sync)
          try {
            // v4.6.27: static import above (ADR-008)
            await reconcilePendingChecks();
          } catch {}

          // v5.5.740: load this location's table reservations now that the floor plan is in the store.
          try { await loadReservations(); } catch { /* best-effort */ }

        } catch(e) { console.warn('[SyncBridge] boot load error:', e.message); }
      })();
    }

    if (!('BroadcastChannel' in window)) return;

    // Init offline queue for durable writes
    if (!isMock) initOfflineQueue(supabase);

    // Session reconciler — polls active_sessions every 10s
    // This is the reliable fix for cross-device close sync
    // Realtime DELETE events are unreliable; polling guarantees consistency
    if (!isMock) startSessionReconciler();
    if (!isMock) startTerminalJobReconciler();   // v5.5.846 — close tables paid on the PAX

    // v5.5.740: table reservations sync via their own dedicated table + realtime channel, isolated
    // from the active_sessions / order-sync path (a reservation never touches a table with a live order).
    if (!isMock) subscribeToReservations();

    // Load location-level settings from Supabase on boot
    if (!isMock) {
      (async () => {
        try {
          // v5.5.962: wait for the boot config-push apply so the fresh locations
          // read below deterministically WINS over a stale snapshot (see note at
          // the bootConfigLoad declaration). The IIFE try/catches, so this always
          // settles; belt-and-braces catch anyway.
          await bootConfigLoad.catch(() => {});
          const { getLocationId } = await import('../lib/supabase.js');
          const locId = await getLocationId().catch(() => null);
          if (locId && supabase) {
            // Load image display setting
            const show = await getShowItemImages(supabase, locId);
            useStore.getState().setShowItemImages(show);
            // Load quick screen directly — single source of truth
            const { data: locData } = await supabase
              .from('locations')
              .select('quick_screen_ids, quick_screen_mode, quick_screen_auto, pos_settings')
              .eq('id', locId)
              .single();
            if (locData?.quick_screen_ids?.length) {
              useStore.getState().setQuickScreenIds(locData.quick_screen_ids);
            }
            // v5.5.962 Smart Quick Screen: mode + precomputed best-seller lists
            if (['manual','auto','hybrid'].includes(locData?.quick_screen_mode)) {
              useStore.getState().setQuickScreenMode(locData.quick_screen_mode);
            }
            if (locData?.quick_screen_auto?.lists) {
              useStore.getState().setQuickScreenAuto(locData.quick_screen_auto);
            }
            // v5.5.799: takeaway customer-details level (setter sanitises to 'full')
            useStore.getState().setTakeawayCustomerDetails(locData?.pos_settings?.takeaway_customer_details);
          }
        } catch (e) { console.warn('[SyncBridge] settings load failed:', e.message); }
      })();
    }

    // Drain loyalty/promo deductions parked by lib/commitRedemptions. OfflineQueue's own replay
    // engine only speaks Supabase table ops and cannot POST to an edge function, so without this
    // the ONLY thing that ever retries a lost deduction is the next successful redemption on the
    // same device. ensureAuthToken() returns null in back-office mode and retryPendingRedemptions
    // no-ops without a token, so this can't fire un-authenticated.
    const flushRedemptions = async () => {
      try {
        const token = await ensureAuthToken().catch(() => null);
        if (!token) return;
        await retryPendingRedemptions({ functionsUrl: `${OPS_URL}/functions/v1`, token });
      } catch { /* best-effort */ }
    };
    if (!isMock) flushRedemptions();

    // On reconnect — replay pending data
    if (!isMock) {
      window.addEventListener('online', async () => {
        try {
          // v4.6.27: static import above (ADR-008)
          await onReconnect();
          await loadReservations();   // v5.5.740: realtime can miss reservation events while offline — reconcile on reconnect
          await flushRedemptions();
        } catch {}
      });
    }

    // Periodic background sync every 60s — catch any missed writes
    if (!isMock) {
      const periodicTimer = setInterval(async () => {
        try {
          // v4.6.27: static import above (ADR-008)
          await periodicSync();
        } catch {}
        try {
          // v4.6.29: fire any scheduled collection orders whose fire time
          // has been reached. Piggy-backs on the existing 60s cadence so we
          // don't spin up a second timer.
          useStore.getState().tickScheduledOrders?.();
        } catch {}
        try {
          // Release catering pre-orders whose event-day fire time has arrived
          // (master-only, throttled inside). They're held in the DB, not the
          // live queue, so this scales to thousands of future bookings.
          useStore.getState().releaseDueCateringOrders?.();
        } catch {}
      }, 60_000);
      // Store timer for cleanup
      window._rposPeriodicTimer = periodicTimer;
    }

    // Note: active_sessions realtime is handled by startRealtime() in realtime.js (sessionsChannel)
    // which has INSERT/UPDATE/DELETE with REPLICA IDENTITY FULL for correct cross-device sync

    channelInstance = new BroadcastChannel(CHANNEL_NAME);

    // v4.6.27: Safe merge for incoming broadcast data. Previously this was a blind
    // useStore.setState(msg.data), which replaced the whole `tables` array with the
    // sender's view — wiping items the local operator was actively adding. Now:
    //   - The currently-edited table (activeTableId) is protected: its session is
    //     never overwritten from a broadcast. Local edits always win for it.
    //   - For other tables we merge per-row, keeping the sender's operational state
    //     (status, session, covers, reservation) but the receiver's layout fields
    //     (x/y/w/h/label/section/shape). Layout only changes via CONFIG_PUSH.
    //   - Tables the receiver has but the sender doesn't are preserved (can't shrink
    //     the floor plan via a stale broadcast).
    const LAYOUT_FIELDS = ['x','y','w','h','label','section','shape','seats','area'];
    function mergeTablesSafely(localTables, incomingTables, activeId) {
      if (!Array.isArray(incomingTables)) return localTables;
      const byId = new Map(incomingTables.map(t => [t.id, t]));
      const merged = (localTables || []).map(local => {
        if (local.id === activeId) return local;
        const incoming = byId.get(local.id);
        if (!incoming) return local;

        // v4.5.3 STOP-BLEED: never let incoming overwrite local with FEWER items
        // OR destroy a session that the local operator is actively building.
        // Caught 26 Apr 2026 by v4.5.2 forensic logging — cross-tab BroadcastChannel
        // races were wiping in-progress orders (e.g. T1 with 3 items wiped to 0
        // while user was actively at the POS).
        const localItems = local.session?.items?.length || 0;
        const incomingItems = incoming.session?.items?.length || 0;
        if (local.session && (!incoming.session || incomingItems < localItems)) {
          console.warn('[SyncBridge] mergeTablesSafely: refusing incoming for', local.label || local.id, '— would lose data (local=' + localItems + ' items, incoming=' + incomingItems + ' items)');
          return local;
        }
        // v4.5.3 timestamp tiebreaker: if local.session is newer than incoming, keep local.
        // updatedAt is stamped on every store mutation that touches the session.
        if (local.session?.updatedAt && incoming.session?.updatedAt
            && local.session.updatedAt > incoming.session.updatedAt) {
          return local;
        }

        const keepLocalLayout = {};
        for (const f of LAYOUT_FIELDS) if (f in local) keepLocalLayout[f] = local[f];
        return { ...incoming, ...keepLocalLayout };
      });
      const localIds = new Set((localTables || []).map(t => t.id));
      for (const t of incomingTables) if (!localIds.has(t.id)) merged.push(t);
      return merged;
    }
    function safeApplyIncoming(data) {
      if (!data || typeof data !== 'object') return;
      const cur = useStore.getState();
      const patch = { ...data };
      if ('tables' in patch) {
        patch.tables = mergeTablesSafely(cur.tables, patch.tables, cur.activeTableId);
      }
      useStore.setState(patch);
    }

    channelInstance.onmessage = ({ data: msg }) => {
      if (msg.from === TAB_ID) return;
      // v5.5.6: BroadcastChannel cross-tenant guard. Two tabs in the same browser
      // can be at different locations (e.g., owner with multiple sites monitoring
      // both). Without this filter, a CONFIG_PUSH or STATE_UPDATE from Loc 1's
      // tab would be applied to Loc 2's tab, polluting state across locations.
      // Reject if either side has a known location and they don't match. If
      // sender is null (legacy/pre-v5.5.6) accept — preserves backwards compat.
      const myLoc = getActiveLocationSync();
      if (msg.locationId && myLoc && msg.locationId !== myLoc) {
        console.warn('[SyncBridge] dropping cross-location broadcast:', msg.type, 'from', msg.locationId, '— this tab is at', myLoc);
        return;
      }

      if (msg.type === 'STATE_UPDATE') {
        // Real-time operational sync
        isApplyingRef.current = true;
        safeApplyIncoming(msg.data); // v4.6.27: protects activeTableId + layout
        isApplyingRef.current = false;
        onSyncPulse?.();
      }

      if (msg.type === 'CONFIG_PUSH') {
        // Back Office pushed a config update — store snapshot, show banner on POS
        useStore.getState().setConfigUpdate(msg.snapshot);
        onSyncPulse?.();
      }

      if (msg.type === 'PING') {
        channelInstance.postMessage({ from:TAB_ID, locationId: getActiveLocationSync(), type:'PONG', data:getSharedState() });
      }
      if (msg.type === 'PONG') {
        isApplyingRef.current = true;
        safeApplyIncoming(msg.data); // v4.6.27: protects activeTableId + layout
        isApplyingRef.current = false;
      }
    };

    channelInstance.postMessage({ from:TAB_ID, locationId: getActiveLocationSync(), type:'PING' });

    let timer = null;
    let pending = {};

    // Write table session changes to Supabase for cross-device sync
    const unsubSessions = !isMock ? useStore.subscribe((state, prev) => {
      if (state.tables === prev.tables) return;
      const meaningful = state.tables.some((t, i) => {
        const p = prev.tables[i];
        if (t === p) return false; // v5.5.890: untouched table (ref-equal) — skip deep compare
        if (!p) return true;
        if ((t.session == null) !== (p.session == null)) return true; // open/close
        if (t.session?.covers !== p.session?.covers) return true;     // covers
        // Item count changed (add or remove) — must sync so other devices see it
        const tCount = (t.session?.items || []).length;
        const pCount = (p.session?.items || []).length;
        if (tCount !== pCount) return true;
        // Item sent to kitchen (status pending→sent)
        const tSent = (t.session?.items || []).filter(i => i.status === 'sent').length;
        const pSent = (p.session?.items || []).filter(i => i.status === 'sent').length;
        if (tSent !== pSent) return true;
        // v5.5.283: catch voids, discounts, price edits, and other modifications
        // that don't change item count. Subtotal is the cheapest single check that
        // catches virtually all real-world edits without triggering on keystrokes.
        if (t.session?.subtotal !== p.session?.subtotal) return true;
        // Void count changed (item voided without removing from array)
        const tVoid = (t.session?.items || []).filter(x => x.voided).length;
        const pVoid = (p.session?.items || []).filter(x => x.voided).length;
        if (tVoid !== pVoid) return true;
        // Fired courses changed
        const tFired = (t.session?.firedCourses || []).length;
        const pFired = (p.session?.firedCourses || []).length;
        if (tFired !== pFired) return true;
        // Notes changed
        if (t.session?.note !== p.session?.note) return true;
        if (t.session?.orderNote !== p.session?.orderNote) return true;
        // v5.5.317: per-item note / seat / course edits and service-charge waive
        // don't change count/subtotal/sent, so without this they only propagated
        // via the 10s reconciler poll (stale on other terminals, wrong course/
        // seat/note on a kitchen ticket fired from another device in that window).
        if (t.session?.serviceChargeWaived !== p.session?.serviceChargeWaived) return true;
        const itemSig = (s) => (s?.items || []).map(i => `${i.uid||i.id}:${i.notes||''}:${i.seat ?? ''}:${i.course ?? ''}`).join('|');
        if (itemSig(t.session) !== itemSig(p.session)) return true;
        return false;
      });
      if (meaningful) {
        // v4.5.2 INSTRUMENTATION: detect mass-wipe events BEFORE we overwrite the snapshot.
        // T2 was lost overnight on 25→26 Apr because the previous snapshot logic blindly
        // mirrored whatever in-memory was — when something else cleared the store,
        // the snapshot was overwritten with empty and the rescue path had nothing to restore.
        // This pass logs every shrink with a stack trace so we can find the wipe trigger.
        try {
          const newSessionCount = state.tables.filter(t => t.session).length;
          const prevSessionCount = prev.tables.filter(t => t.session).length;
          const lostTables = prev.tables.filter(p => p.session && !state.tables.find(t => t.id === p.id && t.session));
          if (lostTables.length > 0) {
            const stack = new Error('session-loss-trace').stack;
            const forensicEntry = {
              ts: Date.now(),
              tsISO: new Date().toISOString(),
              prevCount: prevSessionCount,
              newCount: newSessionCount,
              lost: lostTables.map(t => ({
                id: t.id,
                label: t.label,
                items: t.session?.items?.length,
                seatedAt: t.session?.seatedAt,
              })),
              stack: (stack || '').split('\n').slice(0, 12).join('\n'),
              docVisible: typeof document !== 'undefined' ? document.visibilityState : '?',
              online: typeof navigator !== 'undefined' ? navigator.onLine : '?',
            };
            console.error('[SyncBridge] ⚠️  SESSION LOSS DETECTED — ' + lostTables.length + ' table(s) had session, now do not. Lost:', lostTables.map(t => t.label || t.id).join(', '));
            console.error('[SyncBridge] Stack trace of wipe:', stack);
            console.error('[SyncBridge] Full forensic entry:', forensicEntry);
            try {
              const log = JSON.parse(localStorage.getItem('rpos-session-loss-log') || '[]');
              log.push(forensicEntry);
              // Cap at last 20 entries to bound localStorage size
              localStorage.setItem('rpos-session-loss-log', JSON.stringify(log.slice(-20)));
            } catch {}
          }
        } catch (e) {
          console.warn('[SyncBridge] v4.5.2 forensic detector errored:', e?.message || e);
        }
        // Snapshot write — UNCHANGED behaviour from v4.5.0 (still mirrors current in-memory).
        // Will be replaced with non-shrinking variant in v4.5.3 once we know the wipe source.
        try {
          const snapshot = {};
          for (const t of state.tables) {
            if (t.session) snapshot[t.id] = t.session;
          }
          localStorage.setItem('rpos-session-snapshot', JSON.stringify({
            v: '4.5.2',
            ts: Date.now(),
            sessions: snapshot,
          }));
        } catch (e) {
          console.warn('[SyncBridge] v4.5.2 emergency snapshot failed:', e?.message || e);
        }
        // v5.5.871: when an item was just SENT to the kitchen (pending→sent), flush IMMEDIATELY
        // rather than on the 600ms debounce. A single sent item was being lost: the send often
        // de-activates the table (auto-signout / leaving), and the debounced flush lost the race
        // to the recency-blind reconciler, which then overwrote the live item with the stale empty
        // seat-time DB row. An immediate flush lands the sent session in active_sessions before the
        // table can be handed to any overwrite. Every other change stays on the debounce.
        const sawSend = state.tables.some((t, i) => {
          const p = prev.tables[i];
          if (t === p) return false; // v5.5.890: ref-equal — nothing changed here
          if (!p || !t.session) return false;
          const tSent = (t.session.items || []).filter(x => x.status === 'sent').length;
          const pSent = (p.session?.items || []).filter(x => x.status === 'sent').length;
          return tSent > pSent;
        });
        if (sawSend) flushSessions(); else scheduleFlush();
      }
    }) : () => {};

    // v4.6.5 Bug 4: Write walk-in orderQueue and bar tabs to Supabase too, so they
    // sync across devices the same way table sessions already do.
    const unsubQueues = !isMock ? useStore.subscribe((state, prev) => {
      if (state.orderQueue !== prev.orderQueue || state.tabs !== prev.tabs) {
        scheduleQueueFlush();
      }
    }) : () => {};

    if (!isMock) loadQueues();

    // Tables Ready — live waitlist board syncs across devices the same way the order queue does.
    const unsubWaitlist = !isMock ? useStore.subscribe((state, prev) => {
      if (state.waitlist !== prev.waitlist) scheduleWaitlistFlush();
    }) : () => {};
    if (!isMock) loadWaitlistSync();

    // v5.5.740: reservation set / edited / cleared / seated → push to the dedicated table_reservations
    // sync. The signature tracks reservedAt (reserve+edit) and whether a live order now exists (seat),
    // so both an upsert and a delete are triggered at the right moments.
    const unsubReservations = !isMock ? useStore.subscribe((state, prev) => {
      if (state.tables === prev.tables) return;
      if (isApplyingRef.current) return;   // don't re-publish a change we just applied from a broadcast/realtime
      const sig = (ts) => ts.map(t => `${t.id}:${t.reservation?.reservedAt || ''}:${t.session ? 1 : 0}`).join('|');
      if (sig(state.tables) !== sig(prev.tables)) scheduleReservationFlush();
    }) : () => {};

    const unsub = useStore.subscribe((state, prev) => {
      if (isApplyingRef.current) return;
      const changed = {};
      for (const k of SHARED_KEYS) {
        if (state[k] !== prev[k]) changed[k] = state[k];
      }
      if (!Object.keys(changed).length) return;

      // If the only change is tables and it's qty-only (no item count change, no session open/close)
      // skip localStorage write and BroadcastChannel — it's just a local UI update
      const onlyTables = Object.keys(changed).length === 1 && changed.tables;
      if (onlyTables) {
        const qtyOnly = !state.tables.some((t, i) => {
          const p = prev.tables[i];
          if (t === p) return false; // v5.5.890: ref-equal — no structural change
          if (!p) return true;
          if ((t.session == null) !== (p.session == null)) return true;
          const tCount = (t.session?.items || []).filter(i => !i.voided).length;
          const pCount = (p.session?.items || []).filter(i => !i.voided).length;
          if (tCount !== pCount) return true;
          return false;
        });
        if (qtyOnly) return; // skip broadcast for qty changes — no cross-device value
      }

      pending = { ...pending, ...changed };
      clearTimeout(timer);
      timer = setTimeout(() => {
        const toSend = pending;
        pending = {};
        channelInstance?.postMessage({ from:TAB_ID, locationId: getActiveLocationSync(), type:'STATE_UPDATE', data:toSend });
        try {
          const cur = JSON.parse(localStorage.getItem(STORAGE_KEY)||'{}');
          localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...cur, ...toSend }));
        } catch {}
        onSyncPulse?.();
      }, 80);
    });

    return () => { clearTimeout(timer); channelInstance?.close(); channelInstance = null; unsub(); unsubSessions(); unsubQueues(); unsubWaitlist(); unsubReservations(); stopSessionReconciler(); stopTerminalJobReconciler(); if (!isMock) { teardownSessions(); teardownQueueSync(); teardownWaitlistSync(); teardownReservations(); } };
  }, []);

  return null;
}

// Call this from Back Office to push a config snapshot to all POS terminals
export function broadcastConfigPush(snapshot) {
  if (!channelInstance) return;
  // v5.5.6: tag with locationId so receivers in tabs at OTHER locations drop it
  // (see the BroadcastChannel onmessage handler). Snapshot.locationId is set
  // by handlePush in BackOfficeApp; fall back to the current sync resolver.
  const locId = snapshot?.locationId || getActiveLocationSync();
  channelInstance.postMessage({ from:TAB_ID, locationId: locId, type:'CONFIG_PUSH', snapshot });
}
