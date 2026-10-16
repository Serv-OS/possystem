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
  suggestTables, paceAt, paceFull, turnFor, toMin, toHM, toOptimiserBooking,
  DEFAULT_TURN_BANDS, DEFAULT_RULES,
sessionsToBlocks } from '../lib/bookings/optimiser.js';
import {
  loadBookings, createBookingAtomic, updateBookingRow, rowToBooking, loadBookingTables,
  loadBookingRules, saveBookingRules, loadPackages,
  upsertPackageRow, deletePackageRow, moveBookingTables, editBookingAtomic,
  loadBookingPreorders, saveBookingPreorders, loadBookingCredit, loadBookingRow,
} from '../lib/bookings/bookingsData.js';
import { packageItemsFor } from '../lib/bookings/packagePricing.js';
import { optimiserTables } from '../lib/bookings/optimiserTables.js';
import { validateEdit, conflictsFor, paymentAfterEdit, stampEdit, hasGuest, describeChanges, editRefusal, MOVE_NON_BLOCKING, bookingRefusalWords, standTimeRefusal } from '../lib/bookings/editRules.js';
import { logActivity } from '../lib/activity.js';
import { buildScheduleCtx, minutesInTz } from '../lib/locationTime.js';
import { supabase, isMock, getActiveLocationSync, getLocationId, isHostStandMode } from '../lib/supabase.js';
import { isTrainingMode } from '../lib/trainingMode.js';
import { flushSingleSession, markStandOwned } from '../sync/SessionSync.js';
import { isSessionClosed } from '../sync/sessionClosure.js';
import { readServerSessions, mergeServerSessions } from '../lib/bookings/standSessionSync.js';

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

// Member tables whose booking_tables event beat its bookings event here. Held until
// the booking lands, then merged in. Entries are pruned so a membership row for a
// booking that never arrives (another date, another venue) cannot accumulate.
const PENDING_TABLES_TTL_MS = 5 * 60 * 1000;
const pendingBookingTables = new Map(); // booking_id -> { ids: Set, at: epochMs }
// 16 Oct 2026: one settling read of booking_tables per edited booking (resyncBookingTables).
const RESYNC_DELAY_MS = 1500;
const pendingResync = new Map(); // booking_id -> timer
// 16 Oct 2026: the "server check not switched on yet" note shows once per page load.
let _warnedNoEditGuard = false;

function bufferBookingTable(bookingId, tableId) {
  const now = Date.now();
  for (const [k, v] of pendingBookingTables) {
    if (now - v.at > PENDING_TABLES_TTL_MS) pendingBookingTables.delete(k);
  }
  const entry = pendingBookingTables.get(bookingId) || { ids: new Set(), at: now };
  entry.ids.add(tableId);
  entry.at = now;
  pendingBookingTables.set(bookingId, entry);
}

// Primary stays FIRST, matching the order loadBookings builds (it unshifts the
// primary), because primaryTableId is what seating and the POS handover key on.
function mergeBookingTables(primaryTableId, ...lists) {
  const out = [];
  const seen = new Set();
  for (const id of [primaryTableId, ...lists.flat()]) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

// Store tables → optimiser tables: lib/bookings/optimiserTables.js (16 Oct 2026, tested).

// ── the slice ─────────────────────────────────────────────────────────────────
export function bookingsSlice(set, get) {
  return {
    // state
    bookings: [],                 // the loaded service day, camelCase
    bookingsDate: todayISO(),     // 'YYYY-MM-DD' the diary is showing
    bookingRules: null,           // camelCase rules incl. turnBands + joinGroups (null until loaded)
    packages: [],
    // 16 Oct 2026: who is logged in at the host stand (PIN login). The stand has no
    // POS staff record, so edits are stamped from here. { id, name, role } or null.
    bookingsOperator: null,
    setBookingsOperator: (op) => set({ bookingsOperator: op || null }),

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
    // 16 Oct 2026 (bookings audit item 14): the party being added counts. Full means this party
    // would take the slot OVER the cap (cap 12, 10 booked: a 2 fits, an 8 needs a manager).
    bookingPaceAt: (time, party = 0) => {
      const cap = get().bookingRules?.pacingCap ?? DEFAULT_RULES.pacingCap;
      const load = paceAt(toMin(time), (get().bookings || []).map(toOptimiserBooking));
      return { load, cap, full: paceFull(load, party, cap) };
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
      // 16 Oct 2026 (bookings audit section 3 item 6): service periods, closed days and date
      // blocks, so a stand says why before the database does (standTimeRefusal, tested; walk
      // ins are never held to them).
      const why = standTimeRefusal(booking, rules);
      if (why) return { ok: false, error: why.code, message: why.message };

      if (isTrainingMode()) {
        // Training till: show it locally, never write. Matches the gate-every-
        // commit-path invariant.
        set((s) => ({ bookings: [...(s.bookings || []), booking] }));
        return { ok: true, booking, training: true };
      }

      const res = await createBookingAtomic(booking, locId);
      if (!res.ok) {
        // 16 Oct 2026: the code stays in error (BookScreen offers alternatives on table_taken);
        // message is the same refusal in words.
        const label = res.tableId ? ((get().tables || []).find((t) => t.id === res.tableId)?.label || null) : null;
        return {
          ok: false, error: res.error || 'Could not save the booking', tableId: res.tableId || null,
          message: bookingRefusalWords({ error: res.error, tableLabel: label, message: res.message }),
        };
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
      if (!res.ok) {
        // 10 Sep 2026 review: a refused write (the payment gate trigger, RLS,
        // the network) used to leave the stand showing a status the database
        // never took, with no realtime event to correct it. Put back the fields
        // this patch touched and say so.
        set((s) => ({
          bookings: (s.bookings || []).map((x) => {
            if (x.id !== id) return x;
            const back = { ...x };
            for (const k of Object.keys(patch || {})) back[k] = entry[k];
            return back;
          }),
        }));
        console.warn('[bookings] updateBooking persist failed, change put back:', res.error);
        get().showToast?.('Booking NOT updated. The change was put back.', 'error');
      }
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

    // ── edit (16 Oct 2026) ───────────────────────────────────────────────────
    // Peter: "why can't I edit a booking, that is basic". One action for date,
    // start time, covers, guest name, phone, email, allergens, note and tables
    // (primary first, then joined). Source and package never change here.
    // patch: { date?, startTime?, covers?, tables?, primaryTableId?, note?,
    //          customer? ({ name, phone, email, allergens } merged over the snapshot) }
    // The rules (editRules.js, tested) decide and say why not in words:
    //   refused for dining, departed, cancelled, no show, expired
    //   date not in the past, time inside service hours, covers fit the tables
    //   turn minutes recomputed from the band for the new covers (package turn wins)
    //   the new tables and window against every other live booking that day
    // Writes: the bookings row first (date, time, turn, covers, note, customer
    // with the edit stamp), then move_booking for the tables, which re-checks
    // the tables under the venue lock at the NEW time (it reads the row it just
    // updated) and rewrites booking_tables delete and insert. A refused move
    // puts the row back. Never optimistic: the store changes after the writes.
    // Returns { ok:true, booking, payment } or { ok:false, error, errors?, conflicts? }.
    editBooking: async (id, patch = {}, { editedBy = null, expectedEditedAt } = {}) => {
      const notHere = 'This booking is not on the diary any more. Reload and try again.';
      const refuse = (msg, extra = {}) => ({ ok: false, error: msg, errors: [msg], ...extra });
      const cached = (get().bookings || []).find((x) => x.id === id);
      if (!cached) return refuse(notHere);
      const rules = get().bookingRules || {};
      const tz = get().locationConfig?.timezone;
      const pkg = cached.packageId ? (get().packages || []).find((p) => p.id === cached.packageId) : null;
      const ctx = buildScheduleCtx(tz);
      const storeTables = (get().tables || []).filter((t) => !t.parentId);
      const tablesForRules = storeTables.map((t) => ({ id: t.id, label: t.label || t.id, covers: t.maxCovers || 2 }));
      const locId = await resolveLocationId();
      const live = !!(locId && !isTrainingMode() && !isMock && supabase);

      // 16 Oct 2026 review: read this booking's row fresh. The store copy can be
      // stale (Back Office has no bookings realtime, and another stand may have
      // seated the party a moment ago), so the status and the edit stamp are
      // checked against what the database holds now. Tables and money stay
      // from the store; the tables are re read only if the primary moved.
      let entry = cached;
      if (live) {
        const fresh = await loadBookingRow(id, locId);
        if (fresh) {
          const why = editRefusal(fresh);
          if (why) return refuse(why);
          if (expectedEditedAt !== undefined && (fresh.customer?.edited_at || null) !== (expectedEditedAt || null)) {
            // Bring this device's copy up to date first, so reopening the sheet
            // shows the other device's change instead of refusing again.
            set((s) => {
              const list = s.bookings || [];
              if (fresh.date !== (s.bookingsDate || todayISO())) return { bookings: list.filter((x) => x.id !== id) };
              return {
                bookings: list.map((x) => (x.id === id ? {
                  ...x, status: fresh.status, date: fresh.date, startTime: fresh.startTime, covers: fresh.covers,
                  turnMinutes: fresh.turnMinutes, note: fresh.note, customer: fresh.customer,
                } : x)),
              };
            });
            if (fresh.primaryTableId !== cached.primaryTableId) get().resyncBookingTables?.(id);
            const at = fresh.customer?.edited_at ? toHM(minutesInTz(fresh.customer.edited_at, tz) ?? 0) : null;
            const who = fresh.customer?.edited_by ? ` by ${fresh.customer.edited_by}` : '';
            return refuse(`This booking was changed on another device${at ? ` at ${at}` : ''}${who}. Close and reopen to see it.`, { stale: true });
          }
          entry = {
            ...cached,
            status: fresh.status, date: fresh.date, startTime: fresh.startTime, covers: fresh.covers,
            turnMinutes: fresh.turnMinutes, note: fresh.note, customer: fresh.customer,
          };
          if (fresh.primaryTableId && fresh.primaryTableId !== cached.primaryTableId) {
            const ids = await loadBookingTables(id);
            entry = { ...entry, primaryTableId: fresh.primaryTableId, tables: ids && ids.length ? mergeBookingTables(fresh.primaryTableId, ids) : [fresh.primaryTableId] };
          }
        }
      }

      // Guest fields merge over the existing snapshot so nothing else on it is lost.
      const customer = patch.customer !== undefined
        ? { ...(entry.customer || {}), ...(patch.customer || {}) }
        : entry.customer;
      const by = editedBy || get().bookingsOperator?.name || get().staff?.name || null;
      const stamped = stampEdit(customer, by);

      const v = validateEdit({
        booking: entry,
        patch: { ...patch, customer: stamped },
        // 16 Oct 2026: the whole rules object, so service periods, closed days and blocks count.
        rules: { ...rules, serviceStart: rules.serviceStart || '17:00', serviceEnd: rules.serviceEnd || '23:00', turnBands: rules.turnBands || DEFAULT_TURN_BANDS },
        tables: tablesForRules,
        today: ctx.ymd,
        pkg,
      });
      if (!v.ok) return { ok: false, error: v.errors[0], errors: v.errors };
      const next = v.next;
      const slotChanged = v.changed.slot;

      // Only a change of when or where the table is held needs the conflict
      // check. A name, phone, allergen, note or covers fix never does, so an
      // open tab running over on the party's table cannot refuse it.
      if (slotChanged) {
        // The other bookings on the target day, read fresh so a booking another
        // device just took is seen. If the read fails it comes back empty, which
        // is why every slot change ALSO goes through move_booking below.
        let others = (get().bookings || []);
        if (live) {
          const { data } = await loadBookings(locId, next.date);
          if (Array.isArray(data)) others = data;
        } else if (next.date !== (get().bookingsDate || todayISO())) {
          others = [];
        }
        // Open till tabs block their tables like a seated party, today only,
        // except a tab on this booking's own current tables (the party itself,
        // or a walk in the host is already working around), so the till's Edit
        // reservation can move the time on a table with an open tab.
        const ownTables = new Set(entry.tables || []);
        const blocks = next.date === ctx.ymd
          ? sessionsToBlocks(get().tables, others, rules.turnBands || DEFAULT_TURN_BANDS, ctx.nowMinutes, epochToVenueMin(tz))
            .filter((blk) => !(blk.tables || []).some((t) => ownTables.has(t)))
          : [];
        const conflicts = conflictsFor({ booking: next, others: [...others, ...blocks], tables: tablesForRules, nonBlocking: MOVE_NON_BLOCKING });
        if (conflicts.length) {
          return { ok: false, error: conflicts[0].text, errors: conflicts.map((c) => c.text), conflicts };
        }
      }

      const payment = paymentAfterEdit({ pkg, covers: next.covers, capturedMinor: cached.paidMinor ?? null });

      // Never optimistic, and never the whole stale snapshot: only the edited
      // fields go onto the row as it is in the store NOW, so a status change
      // that arrived by realtime during the writes is kept.
      const edited = {
        date: next.date, startTime: next.startTime, covers: next.covers, turnMinutes: next.turnMinutes,
        note: next.note, customer: next.customer, tables: next.tables, primaryTableId: next.primaryTableId,
      };
      const apply = () => set((s) => {
        const viewing = s.bookingsDate || todayISO();
        const list = s.bookings || [];
        // A booking moved to another day leaves this day's diary.
        if (next.date !== viewing) return { bookings: list.filter((x) => x.id !== id) };
        return { bookings: list.map((x) => (x.id === id ? { ...x, ...edited } : x)) };
      });
      const logEdit = () => {
        // One line on the activity feed. Best effort, never blocks the edit.
        try {
          const name = next.customer?.name || `Party of ${next.covers}`;
          const words = describeChanges(entry, next, tablesForRules);
          logActivity(locId, {
            kind: 'ops', severity: 'info', title: 'Booking edited',
            body: `${name}: ${words || 'no field changed'}`, refType: 'booking', refId: id, actorName: by,
          }).catch(() => {});
        } catch { /* the booking is saved either way */ }
      };

      if (isTrainingMode()) { apply(); return { ok: true, booking: next, payment, training: true }; }
      if (!locId) return refuse('No venue resolved, so the booking cannot be saved.');

      // 16 Oct 2026 (bookings audit item 10): ONE guarded write when the
      // database has it. edit_booking re checks the window, the seats, the
      // floor plan and an online payment still landing under the venue lock,
      // and writes the row and the tables in one transaction, so one call
      // covers the slot and the tables. Unchanged fields go as this device just
      // read them from the database (entry is the fresh row), the note and the
      // guest only when they changed (null keeps what is there), so nothing a
      // stamp check passed is written back over. Before migration 20261016b the
      // function is missing: the writes below (only the changed fields, then
      // move_booking for any slot change) run instead, and the stand says once
      // that only this device checked the diary.
      const noteChanged = next.note !== (entry.note || '');
      const atomic = await editBookingAtomic(id, {
        date: next.date, startTime: next.startTime, turnMinutes: next.turnMinutes, covers: next.covers,
        tables: next.tables, primaryTableId: next.primaryTableId,
        note: noteChanged ? next.note : null,
        customer: stamped,
      }, locId);
      if (atomic.ok) {
        apply();
        logEdit();
        return { ok: true, booking: next, payment, serverGuard: true };
      }
      if (!atomic.missing) {
        // A dropped connection can hide an edit that DID land. The function is
        // one transaction and the stamp is this edit's own, so the row carrying
        // it means everything landed. Look before saying it failed.
        if (!atomic.refused) {
          const after = await loadBookingRow(id, locId);
          if (after && (after.customer?.edited_at || null) === stamped.edited_at) {
            apply();
            logEdit();
            return { ok: true, booking: next, payment, serverGuard: true };
          }
        }
        const label = atomic.tableId ? (tablesForRules.find((t) => t.id === atomic.tableId)?.label || null) : null;
        let msg;
        if (/payment_gate|waiting for payment/i.test(String(atomic.error || ''))) msg = 'This booking is waiting for payment, so its covers cannot change.';
        else if (atomic.error === 'table_taken') msg = `${label || 'That table'} is held by another booking at that time. Nothing was changed.`;
        else if (atomic.refused) msg = bookingRefusalWords({ error: atomic.error, tableLabel: label, seats: atomic.seats, status: atomic.status, message: atomic.message });
        else msg = `Booking NOT saved: ${atomic.error || 'the database refused the change'}.`;
        return refuse(msg);
      }

      // Only what changed, plus the guest snapshot with the stamp.
      const rowPatch = { customer: stamped };
      const undo = { customer: entry.customer ?? null };
      if (v.changed.date) { rowPatch.date = next.date; undo.date = entry.date; }
      if (v.changed.time) { rowPatch.startTime = next.startTime; undo.startTime = entry.startTime; }
      if (v.changed.turn) { rowPatch.turnMinutes = next.turnMinutes; undo.turnMinutes = entry.turnMinutes; }
      if (v.changed.covers) { rowPatch.covers = next.covers; undo.covers = entry.covers; }
      if (next.note !== (entry.note || '')) { rowPatch.note = next.note; undo.note = entry.note || ''; }

      const r1 = await updateBookingRow(id, rowPatch, locId);
      if (!r1.ok) {
        const msg = /payment_gate|waiting for payment/i.test(String(r1.error || ''))
          ? 'This booking is waiting for payment, so its covers cannot change.'
          : `Booking NOT saved: ${r1.error || 'the database refused the change'}.`;
        return refuse(msg);
      }
      // 16 Oct 2026 review: EVERY change of date, time, turn or tables goes
      // through move_booking, even with the same tables. It re reads the row
      // just written and checks those tables at the NEW time under the venue
      // lock, so a time only change or a sideways Timeline drag is checked on
      // the server too (before, only a table change was).
      if (slotChanged) {
        const r2 = await moveBookingTables(id, next.tables, next.primaryTableId, locId);
        if (!r2.ok) {
          // A timeout can hide a move that DID land. Look before undoing it.
          if (r2.error !== 'table_taken') {
            const now = await loadBookingTables(id);
            if (now && now.join(',') === (next.tables || []).join(',')) {
              apply(); logEdit();
              return { ok: true, booking: next, payment, serverGuard: false };
            }
          }
          const back = await updateBookingRow(id, undo, locId);
          if (!back.ok) {
            get().setBookingsDate?.(get().bookingsDate || todayISO());
            return refuse('The time was saved but the table was NOT moved, and it could not be put back. Reload the diary and check this booking.');
          }
          const msg = r2.error === 'table_taken'
            ? `${tablesForRules.find((t) => t.id === r2.tableId)?.label || 'That table'} is held by another booking at that time. Nothing was changed.`
            : `Table NOT moved: ${r2.error || 'the database refused the move'}. Nothing was changed.`;
          return refuse(msg);
        }
      }
      if (!_warnedNoEditGuard) {
        _warnedNoEditGuard = true;
        get().showToast?.('Booking saved. The server double booking check is not switched on yet, so only this device checked the diary.', 'info');
      }
      apply();
      logEdit();
      return { ok: true, booking: next, payment, serverGuard: false };
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
      const bookingTables = (b.tables?.length ? b.tables : [b.primaryTableId]).filter(Boolean);
      // 16 Oct 2026 (Provo demo, T1): the local copy is not the truth. The till had cashed T1 off
      // (its active_sessions row was gone) and the host stand still held the session, so this
      // refused with "Still has an open tab" while the till showed nothing open. And the other
      // way: a stand that has not yet heard of a check a till opened moments ago (the INSERT not
      // delivered, realtime down) would seat over it and the live check's lines would be gone.
      // So every seat reads the server for the booking's tables (one indexed query) and decides
      // from the merged tables. Only a host stand writes the merge into its store: a till owns
      // its sessions (the SessionReconciler arbitrates for it, and the merge has no lastUpdated
      // arbitration), and a till keeps the table it is editing (unsent lines live only in its
      // memory). A failed read decides from the local copy. On a till its own copy also counts as
      // open: a session the server does not hold yet (an offline till whose writes are still
      // queued) must refuse, never be seated over.
      let merged = null;
      if (!isTrainingMode() && !isMock && supabase) {
        const locId = await resolveLocationId();
        // At most 3 seconds: a slow network falls back to the local copy, as a failed read does.
        const rows = locId ? await Promise.race([
          readServerSessions(supabase, locId, bookingTables),
          new Promise((resolve) => setTimeout(() => resolve(null), 3000)),
        ]) : null;
        if (rows) {
          const active = get().activeTableId;
          const keepIds = !isHostStandMode() && active ? new Set([active]) : null;
          merged = mergeServerSessions(get().tables || [], rows, { tableIds: bookingTables, keepIds, isClosed: isSessionClosed });
          if (isHostStandMode() && merged !== get().tables) set({ tables: merged });
        }
      }
      // The till's own copy is read AFTER the server read: a check opened or a line rung in on
      // this till while the read was in flight must still refuse the seat.
      const local = get().tables || [];
      if (!merged) merged = local;
      const openOn = bookingTables
        .map((tid) => {
          const m = merged.find((t) => t.id === tid);
          if (m?.session) return m;
          if (isHostStandMode()) return null;
          const l = local.find((t) => t.id === tid);
          return l?.session ? l : null;
        })
        .filter((t) => t?.session);
      if (openOn.length) {
        const labels = openOn.map((t) => t.label || t.id).join(', ');
        // A row with lines on it is a live check. A row with none is a seated but empty check
        // (seated from a stand or a till, nothing rung in yet): a different refusal, so the
        // screen can say so.
        const withItems = openOn.filter((t) => (t.session.items || []).some((i) => !i?.voided));
        if (withItems.length) {
          get().showToast?.(`${labels} still has an open tab. Cash it off, or move this booking first.`, 'error');
          return { ok: false, error: 'table_open' };
        }
        get().showToast?.(`${labels} is seated with no order yet. Cash it off on the POS, or move this booking.`, 'error');
        return { ok: false, error: 'table_seated_empty' };
      }
      // hasGuest, not a bare truthy check: an edited walk in carries an edit stamp
      // on its snapshot with no name or phone, and that is not a guest to attach.
      // A CRM linked booking always attaches, and allergens alone count as a guest.
      const seatCustomer = (hasGuest(b.customer) || b.customerId) ? {
        customerId: b.customerId || null,
        name: b.customer?.name || 'Guest',
        phone: b.customer?.phone || null,
        allergens: b.customer?.allergens || [],
      } : null;
      try {
        // ── v5.7.21: the booking's money rides onto the session ──────────────
        // Captured, not-yet-applied booking_payments (prepay/deposit) become
        // the session's booking credit: visible from seating ("Package X PAID"
        // / "Deposit applied at close") and auto-applied by CheckoutModal as a
        // tender leg. Training tills carry the label but never real credit.
        const pkg = b.packageId ? (get().packages || []).find((p) => p.id === b.packageId) : null;
        let credit = { prepayMinor: 0, depositMinor: 0 };
        // 16 Oct 2026: every booking, not only package ones, so a rule based deposit is on the
        // session too and the till takes off what the reader and PAX take off (they read the
        // same ledger). No captured money: 0, exactly as before.
        if (!isTrainingMode()) {
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
          // 10 Sep 2026: options a guest chose on the booking page arrive on the
          // line already. Take their linked daily counts now, the same maths as
          // configureLineOptions, so a later till edit (which restores the old
          // mods' counts) never gives back stock that was never taken.
          for (const line of pkgItems) {
            if (!line?.fromPreorder || !Array.isArray(line.mods) || !line.mods.length) continue;
            for (const mod of line.mods) {
              if (mod?.itemId) get().decrementDailyCount?.(mod.itemId, (mod.qty || 1) * (line.qty || 1));
            }
          }
        } else {
          get().seatTable?.(b.primaryTableId, { covers: b.covers, server: get().staff?.name, customer: seatCustomer, booking: bookingRef });
        }
        // seatTable and seatTableWithItems make the seated table active. A till clears that when
        // it leaves the POS; a host stand never does, and an active table is skipped by the
        // realtime INSERT and UPDATE handlers and by the SessionReconciler, so the stand would not
        // see the till's lines on that table until the 30 second reconcile. A stand edits no check.
        // A host stand publishes only a table it seated (SessionSync markStandOwned).
        if (isHostStandMode()) { markStandOwned(b.primaryTableId); set({ activeTableId: null }); }
        // Persist just this table's session immediately (the waitlist lesson:
        // a host stand's floor poll can flip the table back before the flush).
        // A till keeps main's timing (the flush runs in the background); only a host stand waits for it.
        try {
          const flushing = flushSingleSession(b.primaryTableId);
          if (isHostStandMode()) await flushing; else flushing.catch(() => {});
        } catch { /* best-effort */ }
        // 16 Oct 2026 (Provo demo, 17:06 UK): the stand seated T1, the server row appeared at
        // once, and the stand still drew T1 as "booking active, no session". On a host stand the
        // floor's session for the booking's tables is set from the server row after the seat
        // write, so the colour follows (light blue seated, orange once lines are rung in). A
        // table with no row yet keeps its local copy (the write may still be queued).
        if (isHostStandMode() && !isTrainingMode() && !isMock && supabase) {
          try {
            const locId = await resolveLocationId();
            const rows = locId ? await readServerSessions(supabase, locId, bookingTables) : null;
            if (rows) {
              const next = mergeServerSessions(get().tables || [], rows, { tableIds: bookingTables, clearMissing: false, isClosed: isSessionClosed });
              if (next !== get().tables) set({ tables: next });
            }
          } catch { /* the 30 second stand reconcile heals it */ }
        }
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
      // The values this patch replaces, so a refused save can put them back
      // (10 Sep 2026: the Card capture switch could read ON while the database
      // said OFF, because a failed save only logged).
      const previous = {};
      for (const k of Object.keys(patch || {})) previous[k] = current[k];
      set({ bookingRules: { ...current, ...patch } });
      if (isTrainingMode()) return { ok: true };
      const revert = (error, words = null) => {
        // Only the keys this save touched, on top of whatever is there NOW.
        set({ bookingRules: { ...(get().bookingRules || {}), ...previous } });
        // 16 Oct 2026: words when the data layer has them (service periods before 20261016e).
        get().showToast?.(words || 'Booking rules NOT saved', 'error');
        console.warn('[bookings] saveBookingRules failed:', error);
      };
      const locId = await resolveLocationId();
      if (!locId) { revert('no location'); return { ok: false, error: 'no location' }; }
      const res = await saveBookingRules(locId, patch);
      if (!res.ok) revert(res.error, res.words);
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
      if (!row?.id) return;
      if (row.booking_date !== date) {
        // 16 Oct 2026: an edit moved this booking to another day. It leaves this
        // day's diary on every device; before, only the editing device dropped it.
        if ((get().bookings || []).some((b) => b.id === row.id)) {
          set((s) => ({ bookings: (s.bookings || []).filter((b) => b.id !== row.id) }));
        }
        return;
      }
      set((s) => {
        const list = s.bookings || [];
        const existing = list.find((b) => b.id === row.id);
        // 16 Oct 2026: a new primary table means the tables were rewritten (an edit
        // or a move). The old members must not be kept, so start again from the new
        // primary plus anything buffered, and settle the join from the database.
        const retabled = !!existing && existing.primaryTableId !== row.primary_table_id;
        // Map through rowToBooking, the SAME mapper loadBookings uses, instead of
        // a hand-listed copy. The hand-listed one silently omitted departedAt,
        // cancelledAt, cancelReason and createdBy, and every column added to the
        // mapper in future would have gone missing here too.
        const mapped = rowToBooking(row);
        const merged = {
          ...(existing || {}),
          ...mapped,
          // Membership rows arrive on their own channel. Fold in any that got here
          // FIRST, so a joined booking does not land holding only its primary table.
          tables: mergeBookingTables(
            row.primary_table_id,
            retabled ? [] : (existing?.tables || []),
            mapped.tables || [],
            [...(pendingBookingTables.get(row.id)?.ids || [])],
          ),
          customer: mapped.customer || existing?.customer || null,
          preorderToken: mapped.preorderToken || existing?.preorderToken || null,
          // the paid* totals come from loadBookings' join and are NOT on a realtime
          // row, so keep the last known figures rather than nulling money to null.
          paidMinor: existing?.paidMinor ?? mapped.paidMinor,
          paidPrepayMinor: existing?.paidPrepayMinor ?? mapped.paidPrepayMinor,
          paidDepositMinor: existing?.paidDepositMinor ?? mapped.paidDepositMinor,
          preorderCount: existing?.preorderCount ?? mapped.preorderCount,
        };
        pendingBookingTables.delete(row.id); // folded in above
        // First sight of this booking on this device: settle its join from the DB
        // rather than trusting that the membership stream got here first. Buffering
        // above wins the race when both events arrive; this covers the case where
        // the membership events were missed entirely, which is what left a joined
        // party showing one table until someone reloaded (Peter, 25 Aug).
        if (!existing) get().refreshBookingTables?.(row.id);
        // 16 Oct 2026 review: booking_tables has RLS on, so a realtime DELETE
        // carries only the row id, never which booking or table left. Any UPDATE
        // of a booking we already show (an edit writes the row, then move_booking
        // writes primary_table_id) therefore re reads its tables once, debounced,
        // so a table dropped from a join comes off every stand.
        if (existing) get().resyncBookingTables?.(row.id);
        return { bookings: existing ? list.map((b) => (b.id === row.id ? merged : b)) : [...list, merged] };
      });
    },

    // 16 Oct 2026: after an edit rewrote a booking's tables, the membership events
    // (DELETE old rows, INSERT new rows) and the bookings UPDATE arrive on two
    // streams in any order. Whatever order they land in, one read of booking_tables
    // a moment later REPLACES the list with the database's truth. Debounced per
    // booking so a burst of events costs one read.
    resyncBookingTables: (bookingId) => {
      if (!bookingId) return;
      const pending = pendingResync.get(bookingId);
      if (pending) clearTimeout(pending);
      pendingResync.set(bookingId, setTimeout(async () => {
        pendingResync.delete(bookingId);
        const ids = await loadBookingTables(bookingId);
        if (!ids || !ids.length) return;
        set((s) => ({
          bookings: (s.bookings || []).map((b) => {
            if (b.id !== bookingId) return b;
            const primary = ids.includes(b.primaryTableId) ? b.primaryTableId : ids[0];
            return { ...b, tables: mergeBookingTables(primary, ids), primaryTableId: primary };
          }),
        }));
      }, RESYNC_DELAY_MS));
    },

    // A table that is a MEMBER of a SEATED join, not the primary. The party has one
    // check, on the primary table, so a member carries no session of its own and
    // would otherwise read as free on the floor, inviting a second tab for a party
    // that already has one (Peter, 25 Aug: ten covers across T5 and T7, and T7 sat
    // there looking empty).
    joinedPartyForTable: (tableId) => {
      if (!tableId) return null;
      const b = (get().bookings || []).find((x) => x.status === 'dining'
        && x.primaryTableId && x.primaryTableId !== tableId
        && (x.tables || []).includes(tableId));
      if (!b) return null;
      const primary = (get().tables || []).find((t) => t.id === b.primaryTableId);
      return { booking: b, primaryTableId: b.primaryTableId, primaryLabel: primary?.label || null };
    },

    // Re-read one booking's join from the DB and merge it in. Never shrinks the
    // list: a membership row that has not replicated yet must not drop a table we
    // already know about.
    refreshBookingTables: async (bookingId) => {
      const ids = await loadBookingTables(bookingId);
      if (!ids || !ids.length) return;
      set((s) => ({
        bookings: (s.bookings || []).map((b) => (b.id === bookingId
          ? { ...b, tables: mergeBookingTables(b.primaryTableId, b.tables || [], ids) }
          : b)),
      }));
    },

    applyBookingTablesRealtime: (payload) => {
      // 16 Oct 2026: a DELETE is a table leaving a booking (an edit or move rewrote
      // the membership). It used to be ignored, so the old table stayed on every
      // other device's diary beside the new one. The primary never comes off here:
      // the bookings row says what the primary is.
      if (payload?.eventType === 'DELETE') {
        // With RLS on booking_tables the old record holds only the id, so this
        // usually returns here; the bookings UPDATE resync above does the work.
        const old = payload.old;
        if (!old?.booking_id || !old?.table_id) return;
        if (!(get().bookings || []).some((b) => b.id === old.booking_id)) return;
        set((s) => ({
          bookings: (s.bookings || []).map((b) => {
            if (b.id !== old.booking_id || old.table_id === b.primaryTableId) return b;
            return { ...b, tables: (b.tables || []).filter((t) => t !== old.table_id) };
          }),
        }));
        get().resyncBookingTables?.(old.booking_id);
        return;
      }
      const row = payload?.new;
      if (!row?.booking_id || !row?.table_id) return;
      // create_booking writes the booking and its member tables in ONE transaction,
      // but they arrive on TWO independent realtime streams with no ordering promise
      // between them. A membership event for a booking this device has not seen yet
      // used to be dropped by the map below, and the bookings event that followed
      // then fell back to the primary table alone. A party joined across T5 and T7
      // therefore highlighted only T5, with no join outline (Peter, 25 Aug).
      const known = (get().bookings || []).some((b) => b.id === row.booking_id);
      if (!known) { bufferBookingTable(row.booking_id, row.table_id); return; }
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
