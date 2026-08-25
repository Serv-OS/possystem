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
sessionsToBlocks } from '../lib/bookings/optimiser.js';
import {
  loadBookings, createBookingAtomic, updateBookingRow, rowToBooking,
  loadBookingRules, saveBookingRules, loadPackages,
  upsertPackageRow, deletePackageRow, moveBookingTables,
  loadBookingPreorders, saveBookingPreorders, loadBookingCredit,
} from '../lib/bookings/bookingsData.js';
import { packageItemsFor } from '../lib/bookings/packagePricing.js';
import { buildScheduleCtx } from '../lib/locationTime.js';
import { supabase, isMock, getActiveLocationSync, getLocationId } from '../lib/supabase.js';
import { isTrainingMode } from '../lib/trainingMode.js';
import { flushSingleSession } from '../sync/SessionSync.js';

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

// v5.7.23 - epoch ms → minute-of-day on the VENUE's wall clock. Passed into
// sessionsToBlocks so a session's seatedAt converts in the venue timezone
// (the optimiser stays pure and parity-copied; the clock comes from callers).
const epochToVenueMin = (tz) => (epochMs) => {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz || 'Europe/London', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(epochMs));
    const [h, m] = parts.split(':').map(Number);
    return ((h === 24 ? 0 : h) || 0) * 60 + (m || 0);
  } catch {
    const d = new Date(epochMs);
    return d.getHours() * 60 + d.getMinutes();
  }
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
      // A live POS tab blocks its table like a dining booking — but only when
      // suggesting for TODAY (a lunch tab must not block a dinner booking).
      // v5.7.23 - the VENUE clock decides "today" and now-minutes, never the
      // device clock (the v5.7.20 rule: this gates a business decision).
      const ctx = buildScheduleCtx(get().locationConfig?.timezone);
      const isToday = !get().bookingsDate || get().bookingsDate === ctx.ymd;
      const nowMin = ctx.nowMinutes;
      const blocks = isToday
        ? sessionsToBlocks(get().tables, get().bookings, rules?.turnBands || DEFAULT_TURN_BANDS, nowMin,
            epochToVenueMin(get().locationConfig?.timezone))
        : [];
      return suggestTables({
        party,
        time,
        tables: optimiserTables(get().tables),
        bookings: [...(get().bookings || []).map(toOptimiserBooking), ...blocks],
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

    // ── manual re-table (Peter, 12 Aug) ──────────────────────────────────────
    // NEVER optimistic: move_booking re-checks availability atomically
    // excluding this booking's own footprint. Only after ok does the store
    // move; a 'table_taken' comes back with the blocking table for the UI.
    moveBooking: async (id, tableIds, primaryTableId = null) => {
      const entry = (get().bookings || []).find((x) => x.id === id);
      if (!entry) return { ok: false, error: 'unknown booking' };
      const primary = primaryTableId || tableIds[0];
      if (isTrainingMode()) {
        set((s) => ({ bookings: (s.bookings || []).map((x) => (x.id === id ? { ...x, tables: tableIds, primaryTableId: primary } : x)) }));
        return { ok: true, training: true };
      }
      const locId = await resolveLocationId();
      if (!locId) return { ok: false, error: 'no location' };
      const res = await moveBookingTables(id, tableIds, primary, locId);
      if (!res.ok) return res;
      set((s) => ({ bookings: (s.bookings || []).map((x) => (x.id === id ? { ...x, tables: tableIds, primaryTableId: primary } : x)) }));
      return { ok: true };
    },

    // ── the POS Tables bridge (v5.6.27 — bookings replace thin reservations) ──
    // The next live booking claiming this table today, shown as the "reserved"
    // state on the Tables screen. DISPLAY-DERIVED, never a persisted status —
    // six writers re-derive table status from session presence, so a stored
    // 'reserved'/'joined' flag would be wiped on the next boot or echo.
    upcomingBookingForTable: (tableId, { lookaheadMin = 180 } = {}) => {
      // v5.7.23 - the VENUE clock, never the device clock, decides whether a
      // table reads "reserved" (the v5.7.20 rule: this gates a business
      // decision).
      const ctx = buildScheduleCtx(get().locationConfig?.timezone);
      const today = ctx.ymd;
      const nowMin = ctx.nowMinutes;
      const live = (get().bookings || []).filter((b) =>
        b.date === today &&
        // pending_payment (v5.7.21) still HOLDS its table — the guest is mid-
        // payment; the 20-minute sweep frees it by flipping it to 'expired'.
        ['confirmed', 'prepaid', 'due', 'late', 'pending_payment'].includes(b.status) &&
        (b.tables || []).includes(tableId) &&
        toMin(b.startTime) + (b.turnMinutes || 90) > nowMin &&
        toMin(b.startTime) <= nowMin + lookaheadMin
      ).sort((a, b) => toMin(a.startTime) - toMin(b.startTime));
      return live[0] || null;
    },

    // Materialise a package into ordinary order lines for `covers` guests.
    // course ints ride each line so the KDS fires in order — this is exactly
    // the catering flow; nothing downstream changes. ALL pricing rules live in
    // lib/bookings/packagePricing.js (v5.7.21, unit-tested): prepay packages
    // land at 0.00 unless price_override > 0 (the money arrives as a tender
    // leg at close), deposit packages at real prices; choice lines never
    // auto-materialise — only actual booking_preorders picks land.
    // v5.7.23: prepayCaptured gates the 0.00 pricing. A prepay booking with
    // NO captured credit on the ledger prices like deposit (real prices).
    packageLinesToItems: (packageId, covers, preorders = [], { prepayCaptured = true } = {}) => {
      const pkg = (get().packages || []).find((p) => p.id === packageId);
      if (!pkg) return [];
      return packageItemsFor({ pkg, covers, preorders, menuItems: get().menuItems || [], prepayCaptured });
    },

    // ── per-seat pre-orders (Phase 4) ────────────────────────────────────────
    loadPreorders: async (bookingId) => {
      const { data } = await loadBookingPreorders(bookingId);
      return data || [];
    },

    savePreorders: async (bookingId, rows) => {
      if (isTrainingMode()) return { ok: true };
      const locId = await resolveLocationId();
      if (!locId) return { ok: false, error: 'no location' };
      const res = await saveBookingPreorders(bookingId, locId, rows);
      if (!res.ok) get().showToast?.(`Pre-orders NOT saved — ${res.error || 'write refused'}`, 'error');
      else set((s2) => ({ bookings: (s2.bookings || []).map((b) => (b.id === bookingId ? { ...b, preorderCount: (rows || []).length } : b)) }));
      return res;
    },

    // ── seat: the POS handover (Phase 3) ──────────────────────────────────────
    // Opens the session on the PRIMARY table only (INTEGRATION.md resolution —
    // active_sessions stays one row per table). Member tables never get a
    // status: the floor derives "joined" from booking_tables live. Carries the
    // guest across so dine-in checkout gets loyalty/allergens (seatTable
    // already auto-applies customer allergens with a toast).
    seatBooking: async (id) => {
      const b = (get().bookings || []).find((x) => x.id === id);
      if (!b) return { ok: false, error: 'unknown booking' };
      // An open POS tab on any of the booking's tables means no one can be
      // seated there yet — refuse loudly instead of silently overwriting the
      // live session (which is real money on a real check).
      const openOn = (b.tables?.length ? b.tables : [b.primaryTableId])
        .map((tid) => (get().tables || []).find((t) => t.id === tid))
        .filter((t) => t?.session);
      if (openOn.length) {
        const labels = openOn.map((t) => t.label || t.id).join(', ');
        get().showToast?.(`${labels} still has an open tab. Cash it off, or move this booking first.`, 'error');
        return { ok: false, error: 'table_open' };
      }
      const seatCustomer = b.customer ? {
        customerId: b.customerId || null,
        name: b.customer.name || 'Guest',
        phone: b.customer.phone || null,
        allergens: b.customer.allergens || [],
      } : null;
      try {
        // ── v5.7.21: the booking's money rides onto the session ──────────────
        // Captured, not-yet-applied booking_payments (prepay/deposit) become
        // the session's booking credit: visible from seating ("Package X PAID"
        // / "Deposit applied at close") and auto-applied by CheckoutModal as a
        // tender leg. Training tills carry the label but never real credit.
        const pkg = b.packageId ? (get().packages || []).find((p) => p.id === b.packageId) : null;
        let credit = { prepayMinor: 0, depositMinor: 0 };
        if (b.packageId && !isTrainingMode()) {
          try { credit = await loadBookingCredit(b.id); } catch { /* stays 0 — honest fallback */ }
        }
        // v5.7.23 - free food is EARNED: the prepay 0.00 pricing only applies
        // when captured, un-applied prepay money is actually on the ledger. An
        // unpaid prepay booking (pending_payment, expired, legacy unpaid
        // 'prepaid') seats at REAL prices and the POS chip says so. No seat
        // blocking - the party still sits. Training tills demo the paid flow
        // (they commit nothing).
        const prepayCaptured = pkg?.paymentModel !== 'prepay'
          || isTrainingMode()
          || (credit.prepayMinor || 0) > 0;
        // A package pre-loads the tab: its lines become ordinary order items
        // with course ints (the catering flow) via seatTableWithItems. Per-seat
        // pre-orders (if taken at booking) become the choice lines, each
        // carrying "Seat N · Name" so the kitchen knows whose plate it is.
        const preorders = b.packageId ? await get().loadPreorders?.(b.id) : [];
        const pkgItems = b.packageId ? get().packageLinesToItems?.(b.packageId, b.covers, preorders || [], { prepayCaptured }) : [];
        const bookingRef = {
          bookingId: b.id,
          packageId: b.packageId || null,
          packageName: pkg?.name || null,
          paymentModel: pkg?.paymentModel || null,
          prepaidMinor: credit.prepayMinor || 0,
          depositMinor: credit.depositMinor || 0,
          // The POS seating chip keys "Package unpaid, full prices apply" on
          // this, not on prepaidMinor (training carries the label, no credit).
          prepayUnpaid: !prepayCaptured,
        };
        if (pkgItems?.length) {
          get().seatTableWithItems?.(b.primaryTableId, pkgItems, { covers: b.covers, server: get().staff?.name, customer: seatCustomer, booking: bookingRef });
        } else {
          get().seatTable?.(b.primaryTableId, { covers: b.covers, server: get().staff?.name, customer: seatCustomer, booking: bookingRef });
        }
        // Persist just this table's session immediately (the waitlist lesson:
        // a host stand's floor poll can flip the table back before the flush).
        try { flushSingleSession(b.primaryTableId); } catch { /* best-effort */ }
      } catch (e) {
        console.warn('[bookings] seatTable failed:', e?.message || e);
      }
      const ref = get().tables?.find((t) => t.id === b.primaryTableId)?.session?.id || null;
      return get().updateBooking(id, { status: 'dining', seatedAt: Date.now(), seatedSessionRef: ref });
    },

    markBookingNoShow: async (id) => {
      const b = (get().bookings || []).find((x) => x.id === id);
      if (!b) return { ok: false, error: 'unknown booking' };
      const res = await get().updateBooking(id, { status: 'no_show' });
      // Lifetime no-show count on the unified CRM record — drives the
      // card-hold prompt at the next booking. Best-effort, never blocks.
      if (res.ok && b.customerId && !isMock && supabase && !isTrainingMode()) {
        try {
          const { data } = await supabase.from('customers').select('no_shows').eq('id', b.customerId).maybeSingle();
          await supabase.from('customers').update({ no_shows: (data?.no_shows || 0) + 1 }).eq('id', b.customerId);
        } catch (e) {
          console.warn('[bookings] no_shows bump failed:', e?.message || e);
        }
      }
      return res;
    },

    // ── packages (Phase 4 — BO PackageBuilder writes through here) ────────────
    upsertPackage: async (pkg) => {
      const id = pkg.id || `pk-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const full = { ...pkg, id };
      set((s) => ({ packages: [...(s.packages || []).filter((p) => p.id !== id), full].sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0)) }));
      if (isTrainingMode()) return { ok: true, package: full };
      const locId = await resolveLocationId();
      if (!locId) return { ok: false, error: 'no location' };
      const res = await upsertPackageRow(full, locId);
      if (!res.ok) {
        console.warn('[bookings] upsertPackage failed:', res.error);
        get().showToast?.(`Package NOT saved — ${res.error || 'write refused'}`, 'error');
      }
      return { ...res, package: full };
    },

    deletePackage: async (id) => {
      set((s) => ({ packages: (s.packages || []).filter((p) => p.id !== id) }));
      if (isTrainingMode()) return { ok: true };
      const locId = await resolveLocationId();
      if (!locId) return { ok: false, error: 'no location' };
      const res = await deletePackageRow(id, locId);
      if (!res.ok) get().showToast?.(`Package NOT deleted — ${res.error || 'write refused'}`, 'error');
      return res;
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
        // Map through rowToBooking, the SAME mapper loadBookings uses, instead of
        // a hand-listed copy. The hand-listed one silently omitted departedAt,
        // cancelledAt, cancelReason and createdBy, and every column added to the
        // mapper in future would have gone missing here too.
        const mapped = rowToBooking(row);
        const merged = {
          ...(existing || {}),
          ...mapped,
          // membership rows arrive on their own channel event; keep what we have
          tables: existing?.tables?.length ? existing.tables : (row.primary_table_id ? [row.primary_table_id] : []),
          customer: mapped.customer || existing?.customer || null,
          preorderToken: mapped.preorderToken || existing?.preorderToken || null,
          // the paid* totals come from loadBookings' join and are NOT on a realtime
          // row, so keep the last known figures rather than nulling money to null.
          paidMinor: existing?.paidMinor ?? mapped.paidMinor,
          paidPrepayMinor: existing?.paidPrepayMinor ?? mapped.paidPrepayMinor,
          paidDepositMinor: existing?.paidDepositMinor ?? mapped.paidDepositMinor,
          preorderCount: existing?.preorderCount ?? mapped.preorderCount,
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
