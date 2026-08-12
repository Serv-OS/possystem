// src/store/bookingsSlice.js
//
// Table Bookings — the store adapter (Phase 1+2 of the handoff build). A
// factory spread into the single Zustand store, exactly like waitlistSlice:
// ALL pure logic lives in src/lib/bookings/optimiser.js (unit-tested), ALL
// DB I/O + snake_case mapping in src/lib/bookings/bookingsData.js
// (table-absent-safe). This file owns ONLY wiring: optimistic state, the
// atomic-create flow, and the optimiser bridge onto live store data.
//
// THE WRITE RULE (OPTIMISER.md race): createBooking is NEVER optimistic. The
// create_booking RPC re-runs the free check inside the transaction; on
// 'table_taken' the caller shows fresh alternatives. Only after ok:true does
// the row enter the store.
//
// Training Mode: bookings COMMIT to the diary (they are venue reality, not a
// sale) — but isTrainingMode() still gates them out of the DB like every other
// write, so a training till cannot pollute a live diary.

import {
  suggestTables, paceAt, turnFor, toMin, toOptimiserBooking,
  DEFAULT_TURN_BANDS, DEFAULT_RULES,
} from '../lib/bookings/optimiser.js';
import {
  loadBookings, createBookingAtomic, updateBookingRow,
  loadBookingRules, saveBookingRules, loadPackages,
} from '../lib/bookings/bookingsData.js';
import { getActiveLocationSync, getLocationId } from '../lib/supabase.js';
import { isTrainingMode } from '../lib/trainingMode.js';

const isRealLoc = (id) => !!id && id !== 'loc-demo';
async function resolveLocationId() {
  const sync = getActiveLocationSync();
  if (isRealLoc(sync)) return sync;
  const resolved = await getLocationId().catch(() => null);
  return isRealLoc(resolved) ? resolved : null;
}

const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export const mintBookingId = () => `bk-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

// Store tables → optimiser tables. Excludes merged split-check children
// (parentId) exactly like the waitlist's tablesView.
const optimiserTables = (tables = []) =>
  (tables || []).filter((t) => !t.parentId).map((t) => ({
    id: t.id, label: t.label || t.id, covers: t.maxCovers || 2, section: t.section || null,
  }));

// ── the slice ─────────────────────────────────────────────────────────────────
export function bookingsSlice(set, get) {
  return {
    // state
    bookings: [],                 // the loaded service day, camelCase
    bookingsDate: todayISO(),     // 'YYYY-MM-DD' the diary is showing
    bookingRules: null,           // camelCase rules incl. turnBands + joinGroups (null until loaded)
    packages: [],

    // ── boot / day switch ─────────────────────────────────────────────────────
    loadBookingsFromDB: async (locationId, dateISO) => {
      const locId = isRealLoc(locationId) ? locationId : await resolveLocationId();
      if (!locId) return;
      const date = dateISO || get().bookingsDate || todayISO();
      const [{ data: bookings }, { data: rules }, { data: packages }] = await Promise.all([
        loadBookings(locId, date),
        loadBookingRules(locId),
        loadPackages(locId),
      ]);
      set({
        bookings: bookings || [],
        bookingsDate: date,
        ...(rules ? { bookingRules: rules } : {}),
        ...(packages?.length ? { packages } : {}),
      });
    },

    setBookingsDate: async (dateISO) => {
      set({ bookingsDate: dateISO });
      const locId = await resolveLocationId();
      if (!locId) return;
      const { data } = await loadBookings(locId, dateISO);
      // Only apply if the operator hasn't switched days again mid-flight.
      if (get().bookingsDate === dateISO) set({ bookings: data || [] });
    },

    // ── the optimiser bridge (pure module ↔ live store data) ──────────────────
    // Returns ranked candidates for the CURRENT diary date. Callers pass the
    // party + 'HH:MM'; packageId (with its own turn) overrides the band.
    suggestBookingTables: ({ party, time, packageId = null, skipBookingId = null, limit = 3 }) => {
      const rules = get().bookingRules;
      const pkg = packageId ? (get().packages || []).find((p) => p.id === packageId) : null;
      return suggestTables({
        party,
        time,
        tables: optimiserTables(get().tables),
        bookings: (get().bookings || []).map(toOptimiserBooking),
        joinGroups: rules?.joinGroups || [],
        turnBands: rules?.turnBands || DEFAULT_TURN_BANDS,
        rules: rules || DEFAULT_RULES,
        turnMinutes: pkg?.turnMinutes || null,
        skipBookingId,
        limit,
      });
    },

    // Covers arriving within ±7 min of 'HH:MM' vs the pacing cap.
    bookingPaceAt: (time) => {
      const cap = get().bookingRules?.pacingCap ?? DEFAULT_RULES.pacingCap;
      const load = paceAt(toMin(time), (get().bookings || []).map(toOptimiserBooking));
      return { load, cap, full: load >= cap };
    },

    // ── create (atomic, never optimistic) ─────────────────────────────────────
    // b: { covers, time 'HH:MM', tables:[…], primaryTableId?, customerId?,
    //      customer?, packageId?, note?, source?, pacingOverrideBy? }
    // → { ok:true, booking } | { ok:false, error, tableId? }
    createBooking: async (b) => {
      const locId = await resolveLocationId();
      if (!locId) return { ok: false, error: 'No venue resolved — cannot save the booking' };
      const rules = get().bookingRules;
      const pkg = b.packageId ? (get().packages || []).find((p) => p.id === b.packageId) : null;
      const booking = {
        id: b.id || mintBookingId(),
        date: b.date || get().bookingsDate || todayISO(),
        startTime: b.time || b.startTime,
        turnMinutes: pkg?.turnMinutes || b.turnMinutes || turnFor(b.covers, rules?.turnBands || DEFAULT_TURN_BANDS),
        covers: b.covers,
        tables: b.tables,
        primaryTableId: b.primaryTableId || (b.tables || [])[0],
        customerId: b.customerId || null,
        customer: b.customer || null,
        status: b.status || 'confirmed',
        source: b.source || 'host',
        packageId: b.packageId || null,
        note: b.note || '',
        createdBy: b.createdBy || get().staff?.name || null,
        pacingOverrideBy: b.pacingOverrideBy || null,
      };
      if (!booking.startTime || !booking.covers || !booking.tables?.length) {
        return { ok: false, error: 'Booking needs a time, covers and at least one table' };
      }

      if (isTrainingMode()) {
        // Training till: show it locally, never write. Matches the gate-every-
        // commit-path invariant.
        set((s) => ({ bookings: [...(s.bookings || []), booking] }));
        return { ok: true, booking, training: true };
      }

      const res = await createBookingAtomic(booking, locId);
      if (!res.ok) {
        return { ok: false, error: res.error || 'Could not save the booking', tableId: res.tableId || null };
      }
      if (booking.date === (get().bookingsDate || todayISO())) {
        set((s) => ({ bookings: [...(s.bookings || []).filter((x) => x.id !== booking.id), booking] }));
      }
      return { ok: true, booking };
    },

    // ── patch / cancel ────────────────────────────────────────────────────────
    updateBooking: async (id, patch) => {
      const entry = (get().bookings || []).find((x) => x.id === id);
      if (!entry) return { ok: false, error: 'unknown booking' };
      const updated = { ...entry, ...patch };
      set((s) => ({ bookings: (s.bookings || []).map((x) => (x.id === id ? updated : x)) }));
      if (isTrainingMode()) return { ok: true };
      const locId = await resolveLocationId();
      const res = await updateBookingRow(id, patch, locId);
      if (!res.ok) console.warn('[bookings] updateBooking persist failed:', res.error);
      return res;
    },

    cancelBooking: async (id, { reason = '' } = {}) => {
      return get().updateBooking(id, { status: 'cancelled', cancelledAt: Date.now(), cancelReason: reason });
    },

    // ── rules ─────────────────────────────────────────────────────────────────
    updateBookingRules: async (patch) => {
      const current = get().bookingRules || {};
      set({ bookingRules: { ...current, ...patch } });
      if (isTrainingMode()) return { ok: true };
      const locId = await resolveLocationId();
      if (!locId) return { ok: false, error: 'no location' };
      const res = await saveBookingRules(locId, patch);
      if (!res.ok) console.warn('[bookings] saveBookingRules failed:', res.error);
      return res;
    },

    // ── realtime (wired in realtime.js; location guard lives in the caller) ───
    applyBookingsRealtime: (payload) => {
      if (!payload) return;
      const date = get().bookingsDate || todayISO();
      if (payload.eventType === 'DELETE') {
        const id = payload.old?.id;
        if (id) set((s) => ({ bookings: (s.bookings || []).filter((b) => b.id !== id) }));
        return;
      }
      const row = payload.new;
      if (!row?.id || row.booking_date !== date) return;
      set((s) => {
        const list = s.bookings || [];
        const existing = list.find((b) => b.id === row.id);
        const merged = {
          ...(existing || {}),
          id: row.id,
          locationId: row.location_id,
          customerId: row.customer_id || null,
          customer: row.customer || existing?.customer || null,
          date: row.booking_date,
          startTime: String(row.start_time || '').slice(0, 5),
          turnMinutes: row.turn_minutes,
          covers: row.covers,
          primaryTableId: row.primary_table_id,
          // membership rows arrive on their own channel event; keep what we have
          tables: existing?.tables?.length ? existing.tables : [row.primary_table_id],
          status: row.status,
          source: row.source,
          packageId: row.package_id || null,
          note: row.note || '',
          seatedAt: row.seated_at ? new Date(row.seated_at).getTime() : null,
        };
        return { bookings: existing ? list.map((b) => (b.id === row.id ? merged : b)) : [...list, merged] };
      });
    },

    applyBookingTablesRealtime: (payload) => {
      const row = payload?.new;
      if (!row?.booking_id) return;
      set((s) => ({
        bookings: (s.bookings || []).map((b) => {
          if (b.id !== row.booking_id) return b;
          const tables = b.tables?.includes(row.table_id) ? b.tables : [...(b.tables || []), row.table_id];
          return { ...b, tables };
        }),
      }));
    },
  };
}
