/**
 * useSupabaseInit — loads shared state from Supabase on app start.
 *
 * In mock mode: does nothing (BroadcastChannel + localStorage handles it).
 * In production: fetches the current state from DB and hydrates the store.
 *
 * Called once from App.jsx on mount.
 */

import { useEffect } from 'react';
import { useStore } from '../store';
import { supabase, isMock, getLocationId, ensureAuthToken, claimPairedDeviceOnBoot } from './supabase';
import {
  fetchMenuItems, fetchFloorPlan, fetch86List,
  fetchKDSTickets, fetchClosedChecks, fetchLatestConfigPush,
} from './db';
import { getLocationConfig, getBusinessDayStart } from './locationTime';

export default function useSupabaseInit() {
  const { menuItems, setMenuItems } = useStore.getState?.() || {};

  useEffect(() => {
    if (isMock) return;

    async function init() {
      const store = useStore.getState();

      // v5.5.184: POS devices (paired via pairing code) have no Supabase Auth
      // session. With RLS enabled on tables like cash_drawers, cash_movements,
      // closed_checks, etc., the anon key (role='anon') gets blocked. Ensure we
      // have an authenticated session BEFORE any data fetching — uses existing
      // BO session if present, otherwise falls back to signInAnonymously().
      try { await ensureAuthToken(); } catch (e) {
        console.warn('[useSupabaseInit] ensureAuthToken failed:', e.message);
      }
      // v5.5.758: (re)bind an already-paired POS-family device to its location server-side
      // so the RLS cutover link survives without a manual re-pair. Best-effort, non-blocking.
      claimPairedDeviceOnBoot();

      // Load location config first — needed for timezone-correct reporting
      const locConfig = await getLocationConfig();
      const todayStart = getBusinessDayStart(locConfig);

      // Store config in Zustand so components can access it
      useStore.setState({ locationConfig: locConfig });

      // CRITICAL: resolve locationId up-front. fetchClosedChecks (and other
      // location-scoped fetches below) MUST receive a real location id —
      // calling them with undefined falls through the `.eq('location_id', null)`
      // filter which returns 0 rows. If we then setState({ closedChecks: [] })
      // we wipe live data that the realtime channel had already populated.
      const locId = await getLocationId().catch(() => null);

      // Menu items — REGRESSION FIX (v5.5.86): the previous mapping here
      // dropped most snake_case→camelCase aliases (parent_id, sort_order,
      // kitchen_name, etc), so once this hook fired on MPOS it overwrote
      // SyncBridge's correctly-mapped menuItems with rows where parentId
      // was undefined. Effect: variant parents (Latte) lost their children
      // and variant children (Half / Pint) lost their parent — children
      // were no longer hidden in the menu list and parents no longer
      // opened a size picker. Mapping below mirrors SyncBridge.jsx exactly.
      const { data: items } = await fetchMenuItems();
      if (items?.length) {
        useStore.setState({ menuItems: items.map(item => ({
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
        })) });
      }

      // Floor plan + sections
      const { data: fp } = await fetchFloorPlan();
      if (fp?.tables?.length) {
        const current = useStore.getState().tables;
        const merged = fp.tables.map(dbT => {
          const live = current.find(t => t.id === dbT.id);
          // v5.5.2: preserve location_id on every hydrated table so upsertFloorTable's
          // cross-location guard can refuse silent moves between locations.
          return live
            ? { ...live, label:dbT.label, x:dbT.x, y:dbT.y, w:dbT.w, h:dbT.h, shape:dbT.shape, maxCovers:dbT.max_covers, section:dbT.section_id, locationId:dbT.location_id }
            : { id:dbT.id, label:dbT.label, x:dbT.x, y:dbT.y, w:dbT.w, h:dbT.h, shape:dbT.shape, maxCovers:dbT.max_covers, section:dbT.section_id, locationId:dbT.location_id, status:'available', session:null };
        });
        useStore.setState({ tables: merged });
      }
      if (fp?.sections?.length) {
        useStore.setState({
          locationSections: fp.sections.map(s => ({ id:s.id, label:s.label, color:s.color, icon:s.icon }))
        });
      }

      // 86 list
      const { data: e86 } = await fetch86List();
      if (e86) {
        useStore.setState({ eightySixIds: e86.map(r => r.item_id) });
      }

      // Active KDS tickets — pass locId explicitly (fetchKDSTickets also
      // self-resolves, but we already have the value; avoids a wasted round trip).
      const { data: tickets } = await fetchKDSTickets(locId);
      if (tickets) {
        useStore.setState({ kdsTickets: tickets });
      }

      // Today's closed checks — scoped to business day start in location timezone.
      // Pass locId explicitly. NEVER overwrite local state with an empty array —
      // realtime may have already prepended fresh checks, and a wiped-then-empty
      // fetch (RLS denial, transient network glitch, locId still resolving) would
      // erase them. Merge with existing instead, dedup by id.
      if (locId) {
        const { data: checks } = await fetchClosedChecks(locId, 500, todayStart);
        if (Array.isArray(checks) && checks.length) {
          const existing = useStore.getState().closedChecks || [];
          const byId = new Map();
          for (const c of existing) byId.set(c.id, c);
          for (const c of checks) byId.set(c.id, c);
          const merged = Array.from(byId.values()).sort((a, b) => (b.closedAt || 0) - (a.closedAt || 0));
          useStore.setState({ closedChecks: merged });
        }
      }

      // v4.6.33: hydrate printers from Supabase so POS devices see back-office
      // changes (including the cashDrawerAttached flag) on app load. Previously
      // the POS only ever saw printers if it was the same browser as the back
      // office — a cross-device install (Sunmi terminal + separate laptop for
      // back office) would never hydrate its own rpos-printers cache.
      if (locId && supabase) {
        try {
          // v5.5.835: deterministic order. Without it Postgres may return the
          // venue's printers in any order, so two tills resolving a printer by
          // role could pick different ones from the same list.
          const { data: prows } = await supabase
            .from('printers')
            .select('*')
            .eq('location_id', locId)
            .order('created_at');
          if (Array.isArray(prows)) {
            const shaped = prows.map(r => ({
              id: r.id,
              name: r.name,
              model: r.meta?.model || 'sunmi-nt311',
              connectionType: r.connection || 'network',
              address: r.ip || '',
              port: r.port ?? 9100,
              paperWidth: r.paper_width ?? 80,
              roles: Array.isArray(r.meta?.roles) ? r.meta.roles : ['receipt'],
              location: r.meta?.location || '',
              status: r.meta?.status || 'unknown',
              addedAt: r.meta?.addedAt || Date.now(),
              cashDrawerAttached: !!r.meta?.cashDrawerAttached,
            }));
            localStorage.setItem('rpos-printers', JSON.stringify(shaped));
            // Fire the same event the back-office PrinterRegistry dispatches so
            // any subscribed code picks up the new list.
            window.dispatchEvent(new Event('rpos-printers-updated'));
          }
        } catch (err) {
          console.warn('[useSupabaseInit] printers hydration failed:', err?.message || err);
        }
      }

      // v5.5.835: hydrate THIS device's receipt-printer assignment. devices.receipt_printer_id
      // has been writable in Back Office → Devices since it was added, but nothing ever READ it
      // at print time — printer.js picked the first printer carrying the 'receipt' role from the
      // whole venue list. That is why an MPOS handheld with no printer set still printed to the
      // counter. Cached to localStorage because printer.js resolves synchronously.
      // Lives here (not App.jsx) deliberately: MPOS returns before ValidatedPOSApp mounts, so
      // useSupabaseInit is the only hook that runs on BOTH the desktop POS and MPOS.
      if (locId && supabase) {
        try {
          const dev = JSON.parse(localStorage.getItem('rpos-device') || 'null');
          if (dev?.id && dev.id !== 'admin' && !dev.adminMode) {
            const { data: drow } = await supabase
              .from('devices')
              .select('receipt_printer_id')
              .eq('id', dev.id)
              .maybeSingle();
            localStorage.setItem('rpos-receipt-target', JSON.stringify({
              deviceId: dev.id,
              printerId: drow?.receipt_printer_id || null,
            }));
            window.dispatchEvent(new Event('rpos-receipt-target-updated'));
          }
        } catch (err) {
          console.warn('[useSupabaseInit] receipt target hydration failed:', err?.message || err);
        }
      }

      // v5.5.835: venue default receipt printer — used ONLY for receipts with no
      // originating device (online / delivery / HubRise, fired from the Orders Hub).
      // Set in Back office → Production printing. Cached to localStorage so printer.js
      // can resolve it synchronously.
      if (locId && supabase) {
        try {
          const { data: locRow } = await supabase
            .from('locations')
            .select('pos_settings')
            .eq('id', locId)
            .maybeSingle();
          const venuePrinterId = locRow?.pos_settings?.default_receipt_printer_id || null;
          if (venuePrinterId) localStorage.setItem('rpos-venue-receipt-printer', venuePrinterId);
          else localStorage.removeItem('rpos-venue-receipt-printer');
        } catch (err) {
          console.warn('[useSupabaseInit] venue receipt printer hydration failed:', err?.message || err);
        }
      }

      // v4.6.35: hydrate cash drawers from Supabase
      try {
        await useStore.getState().loadCashDrawers?.();
      } catch (err) {
        console.warn('[useSupabaseInit] cashDrawers hydration failed:', err?.message || err);
      }

      // v4.6.37: reconcile shift lifecycle. Creates/auto-closes as needed
      // so every subsequent cash sale + movement carries a shift_id.
      try {
        await useStore.getState().reconcileShiftOnMount?.();
        await useStore.getState().loadShiftHistory?.();
      } catch (err) {
        console.warn('[useSupabaseInit] shift reconcile failed:', err?.message || err);
      }

      // v4.6.40: load the currently open drawer session (if any) for this POS.
      // Used by needsCashIn() and the sign-in gate in POSSurface.
      try {
        await useStore.getState().loadCurrentDrawerSession?.();
      } catch (err) {
        console.warn('[useSupabaseInit] drawer session load failed:', err?.message || err);
      }

      // Tax rates for this location
      if (locId && supabase) {
        const { data: rates } = await supabase
          .from('tax_rates')
          .select('*')
          .eq('location_id', locId)
          .eq('active', true)
          .order('rate', { ascending: false });
        if (rates?.length) useStore.setState({ taxRates: rates.map(r => ({
          id: r.id, name: r.name, code: r.code,
          rate: parseFloat(r.rate), type: r.type,
          appliesTo: r.applies_to || ['all'],
          isDefault: r.is_default, active: r.active,
        })) });
      }

      // Latest config push
      const { data: push } = await fetchLatestConfigPush(locId);
      if (push?.snapshot) {
        const currentVersion = parseInt(sessionStorage.getItem('rpos-config-version') || '0');
        if (push.snapshot.version > currentVersion) {
          useStore.getState().setConfigUpdate(push.snapshot);
        }
      }

      console.info('[Supabase] Initialised — data loaded from DB');
    }

    init().catch(err => console.warn('[Supabase] Init failed:', err));
  }, []);
}
