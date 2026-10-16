// src/lib/bookings/bookingsData.js
//
// Table Bookings — the data layer. Owns ALL snake_case ↔ camelCase mapping and
// every Supabase call, mirroring src/lib/waitlist/waitlistData.js: every
// function is table-absent-safe (a venue whose DB hasn't had the migration
// returns empty, never throws at boot) and refuses loc-demo.
//
// The WRITE for a new booking is create_booking (SECURITY DEFINER RPC): the
// free check and the insert are atomic under a per-location advisory lock, so
// two host stands offered the same candidate cannot both win. A refusal comes
// back as { ok:false, error:'table_taken', tableId, bookingId } — the UI shows
// alternatives, it never optimistically writes.

import { supabase, isMock, platformSupabase } from '../supabase';
import { CUSTOMER_ROOT } from '../env';
import { readAllPagesResult } from '../pagedRead.js';
import { rowToPreorder, preorderInsertRows, withoutChoiceColumns, missingColumn } from './preorderRows.js';
import { isMissingFunction } from './applyBookingPayment.js';
// 16 Oct 2026: the guest's confirmation goes the moment the stand, the till or Back Office books.
import { nudgeConfirmation } from './guestMessages.js';
import { serviceRulesFromRow, SERVICE_RULE_COLUMNS, SERVICE_RULES_MISSING, touchesServiceRules } from './serviceRulesRow.js';

const isRealLoc = (l) => !!l && l !== 'loc-demo';

const absent = (e) => {
  const m = String(e?.message || e || '');
  return m.includes('does not exist') || m.includes('schema cache') || m.includes('relation');
};
const warnAbsentOr = (e, fn) => {
  if (absent(e)) { console.warn(`[bookingsData] ${fn}: bookings tables not present yet (migration 20260811b)`); return true; }
  return false;
};

// ── row mappers ───────────────────────────────────────────────────────────────
export function rowToBooking(r) {
  if (!r) return null;
  return {
    id: r.id,
    locationId: r.location_id,
    customerId: r.customer_id || null,
    customer: r.customer || null,
    date: r.booking_date,                       // 'YYYY-MM-DD'
    startTime: String(r.start_time || '').slice(0, 5),   // 'HH:MM'
    turnMinutes: r.turn_minutes,
    covers: r.covers,
    primaryTableId: r.primary_table_id,
    tables: Array.isArray(r._tables) ? r._tables : (r.primary_table_id ? [r.primary_table_id] : []),
    status: r.status,
    source: r.source,
    packageId: r.package_id || null,
    note: r.note || '',
    // v5.7.21 link-first: the token is minted at create for EVERY
    // requires_preorder booking — the Inspector's Copy link builds from it.
    preorderToken: r.preorder_token || null,
    // v5.7.21: captured booking_payments money, summed by loadBookings.
    // null/undefined = NOT VISIBLE here (pre-migration RLS or the join
    // failed) — never "unpaid". A number is the truth in minor units.
    paidMinor: r._paidMinor ?? null,
    paidPrepayMinor: r._paidPrepayMinor ?? null,
    paidDepositMinor: r._paidDepositMinor ?? null,
    pacingOverrideBy: r.pacing_override_by || null,
    // 10 Sep 2026 payment gate: what the widget said was due at book time
    // (migration 20260910). undefined = column not there yet, null = nothing
    // was due. Only booking-widget writes these (service role).
    paymentKind: r.payment_kind === undefined ? undefined : (r.payment_kind || null),
    paymentDueMinor: r.payment_due_minor === undefined ? undefined : (r.payment_due_minor ?? null),
    paymentCurrency: r.payment_currency === undefined ? undefined : (r.payment_currency || null),
    seatedSessionRef: r.seated_session_ref || null,
    seatedAt: r.seated_at ? new Date(r.seated_at).getTime() : null,
    departedAt: r.departed_at ? new Date(r.departed_at).getTime() : null,
    cancelledAt: r.cancelled_at ? new Date(r.cancelled_at).getTime() : null,
    cancelReason: r.cancel_reason || null,
    preorderCount: r._preorderCount ?? 0,
    createdBy: r.created_by || null,
    updatedAt: r.updated_at ? new Date(r.updated_at).getTime() : null,
    // 16 Oct 2026 (host tools): a pay link from the stand keeps the booking waiting until this.
    payLinkUntil: r.pay_link_until ? new Date(r.pay_link_until).getTime() : null,
  };
}

export function rowToRules(r) {
  if (!r) return null;
  return {
    locationId: r.location_id,
    turnBands: { '1-2': r.turn_1_2, '3-4': r.turn_3_4, '5-6': r.turn_5_6, '7+': r.turn_7_plus },
    maxJoin: r.max_join,
    tolerance: r.waste_tolerance,
    pacingCap: r.pacing_cap,
    protectLargeTables: !!r.protect_large_tables,
    pacingOverrideRequiresPin: r.pacing_override_requires_pin !== false,
    holdPerCover: Number(r.hold_per_cover) || 0,
    cancellationWindowHours: r.cancellation_window_hours,
    depositThresholdCovers: r.deposit_threshold_covers,
    serviceStart: String(r.service_start || '17:00').slice(0, 5),
    serviceEnd: String(r.service_end || '23:00').slice(0, 5),
    slotMinutes: r.slot_minutes || 15,
    joinGroups: Array.isArray(r.join_groups) ? r.join_groups : [],
    widgetEnabled: !!r.widget_enabled,
    widgetMaxDaysAhead: r.widget_max_days_ahead,
    cardCaptureEnabled: !!r.card_capture_enabled,
    cardCaptureMinCovers: r.card_capture_min_covers ?? 0,
    bookingTerms: r.booking_terms || '',
    blockedDates: Array.isArray(r.blocked_dates) ? r.blocked_dates : [],
    noOnlineTables: Array.isArray(r.no_online_tables) ? r.no_online_tables : [],
    // 16 Oct 2026 (host tools, migration 20261016d). undefined = the column is not there yet
    // (the settings say so), null = not set (the defaults apply).
    widgetMinParty: r.widget_min_party === undefined ? undefined : (r.widget_min_party ?? null),
    widgetMaxParty: r.widget_max_party === undefined ? undefined : (r.widget_max_party ?? null),
    lateReleaseMinutes: r.late_release_minutes === undefined ? undefined : (r.late_release_minutes ?? null),
    privacyUrl: r.privacy_url === undefined ? undefined : (r.privacy_url || ''),
    // 16 Oct 2026: service periods, closed days, date blocks, notice (migration 20261016e).
    ...serviceRulesFromRow(r),
  };
}

const RULES_TO_ROW = {
  maxJoin: 'max_join', tolerance: 'waste_tolerance', pacingCap: 'pacing_cap',
  protectLargeTables: 'protect_large_tables', pacingOverrideRequiresPin: 'pacing_override_requires_pin',
  holdPerCover: 'hold_per_cover', cancellationWindowHours: 'cancellation_window_hours',
  depositThresholdCovers: 'deposit_threshold_covers', serviceStart: 'service_start',
  serviceEnd: 'service_end', slotMinutes: 'slot_minutes', joinGroups: 'join_groups',
  widgetEnabled: 'widget_enabled', widgetMaxDaysAhead: 'widget_max_days_ahead',
  cardCaptureEnabled: 'card_capture_enabled',
  cardCaptureMinCovers: 'card_capture_min_covers',
  bookingTerms: 'booking_terms',
  blockedDates: 'blocked_dates', noOnlineTables: 'no_online_tables',
  // 16 Oct 2026 (host tools, migration 20261016d)
  widgetMinParty: 'widget_min_party', widgetMaxParty: 'widget_max_party',
  lateReleaseMinutes: 'late_release_minutes', privacyUrl: 'privacy_url',
  ...SERVICE_RULE_COLUMNS,
};

export function rowToPackage(r) {
  if (!r) return null;
  return {
    id: r.id,
    locationId: r.location_id,
    name: r.name,
    description: r.description || '',
    price: Number(r.price) || 0,
    priceUnit: r.price_unit,
    paymentModel: r.payment_model,
    depositPerCover: Number(r.deposit_per_cover) || 0,
    turnMinutes: r.turn_minutes || null,
    availableFrom: r.available_from || null,
    availableTo: r.available_to || null,
    availableDays: r.available_days || [],
    availableStart: r.available_start ? String(r.available_start).slice(0, 5) : null,
    availableEnd: r.available_end ? String(r.available_end).slice(0, 5) : null,
    minCovers: r.min_covers || 1,
    maxCovers: r.max_covers || null,
    maxPerService: r.max_per_service || null,
    sections: r.sections || [],
    requiresPreorder: !!r.requires_preorder,
    preorderDaysBefore: r.preorder_days_before ?? 0,
    terms: r.terms || '',
    isActive: r.is_active !== false,
    sortOrder: r.sort_order || 0,
    lines: Array.isArray(r._lines) ? r._lines : [],
  };
}

export const rowToPackageLine = (r) => (r ? {
  id: r.id, packageId: r.package_id, itemId: r.item_id || null,
  displayName: r.display_name, qtyPerCover: Number(r.qty_per_cover) || 1,
  course: r.course ?? 0, priceOverride: r.price_override == null ? null : Number(r.price_override),
  isPreorderChoice: !!r.is_preorder_choice, sortOrder: r.sort_order || 0,
} : null);

// ── bookings ──────────────────────────────────────────────────────────────────

// Load a service day: bookings + their table membership in two queries.
export async function loadBookings(locationId, dateISO) {
  if (isMock || !supabase || !isRealLoc(locationId) || !dateISO) return { data: [] };
  try {
    const { data, error } = await supabase
      .from('bookings').select('*')
      .eq('location_id', locationId).eq('booking_date', dateISO)
      .order('start_time', { ascending: true });
    // 16 Oct 2026: a failed read says so ({ error }), so a catch up reload can keep
    // the diary on screen instead of replacing it with an empty day.
    if (error) { if (warnAbsentOr(error, 'loadBookings')) return { data: [] }; console.warn('[bookingsData] loadBookings:', error.message); return { data: [], error: error.message || 'read failed' }; }
    const ids = (data || []).map((b) => b.id);
    let membership = new Map();
    const preCounts = new Map();
    // v5.7.21: captured money per booking (booking_payments is readable by
    // paired devices from migration 20260824). Missing map entry = ledger not
    // visible (pre-migration RLS / error) → paidMinor stays null = "unknown".
    const paid = new Map(); // booking_id → { total, prepay, deposit } minor
    // 16 Oct 2026 review: a failed booking_tables read is NOT a good read. The rows still come
    // back (each on its primary table, the boot fallback), but with { error, partial }, so the
    // catch up reload keeps the diary on screen instead of shrinking every joined party to one
    // table and showing its other tables as free.
    let tablesError = null;
    if (ids.length) {
      const [{ data: bt, error: btErr }, { data: po }, { data: pay, error: payErr }] = await Promise.all([
        supabase.from('booking_tables').select('booking_id, table_id, is_primary').in('booking_id', ids),
        supabase.from('booking_preorders').select('booking_id').in('booking_id', ids),
        supabase.from('booking_payments').select('booking_id, kind, amount, status').in('booking_id', ids).eq('status', 'captured'),
      ]);
      if (btErr) {
        console.warn('[bookingsData] loadBookings tables:', btErr.message);
        tablesError = btErr.message || 'tables read failed';
      } else {
        membership = (bt || []).reduce((m, row) => {
          const arr = m.get(row.booking_id) || [];
          if (row.is_primary) arr.unshift(row.table_id); else arr.push(row.table_id);
          m.set(row.booking_id, arr);
          return m;
        }, new Map());
      }
      for (const r of po || []) preCounts.set(r.booking_id, (preCounts.get(r.booking_id) || 0) + 1);
      // Only bookings WITH visible rows get a sum. A booking with none stays
      // null = UNKNOWN — an RLS-filtered read (paired stand on a pre-migration
      // DB) returns zero rows with NO error, indistinguishable from "unpaid",
      // so absence must never be read as "no money".
      if (!payErr) {
        for (const r of pay || []) {
          if (r.kind === 'refund') continue;
          // 16 Oct 2026: a no show or late cancel fee is the venue's revenue, never money paid
          // with the booking (it would badge the booking prepaid and count as credit).
          if (r.kind === 'no_show_charge') continue;
          const p = paid.get(r.booking_id) || { total: 0, prepay: 0, deposit: 0 };
          const minor = Math.round((Number(r.amount) || 0) * 100); // amount is POUNDS
          p.total += minor;
          if (r.kind === 'prepay') p.prepay += minor;
          if (r.kind === 'deposit') p.deposit += minor;
          paid.set(r.booking_id, p);
        }
      }
    }
    return { data: (data || []).map((r) => rowToBooking({
      ...r,
      _tables: membership.get(r.id) || [r.primary_table_id],
      _preorderCount: preCounts.get(r.id) || 0,
      _paidMinor: paid.get(r.id)?.total ?? null,
      _paidPrepayMinor: paid.get(r.id)?.prepay ?? null,
      _paidDepositMinor: paid.get(r.id)?.deposit ?? null,
    })).filter(Boolean), ...(tablesError ? { error: tablesError, partial: true } : {}) };
  } catch (e) {
    if (warnAbsentOr(e, 'loadBookings')) return { data: [] };
    console.warn('[bookingsData] loadBookings threw:', e?.message || e);
    return { data: [], error: e?.message || 'read failed' };
  }
}

// The atomic create — server-side free check, never optimistic.
export async function createBookingAtomic(b, locationId) {
  if (isMock || !supabase) return { ok: true, simulated: true };
  if (!isRealLoc(locationId)) return { ok: false, error: 'no location' };
  try {
    const { data, error } = await supabase.rpc('create_booking', {
      p_id: b.id,
      p_location_id: locationId,
      p_booking_date: b.date,
      p_start_time: b.startTime,
      p_turn_minutes: b.turnMinutes,
      p_covers: b.covers,
      p_table_ids: b.tables,
      p_primary_table_id: b.primaryTableId,
      p_customer_id: b.customerId || null,
      p_customer: b.customer || null,
      p_status: b.status || 'confirmed',
      p_source: b.source || 'host',
      p_package_id: b.packageId || null,
      p_note: b.note || '',
      p_created_by: b.createdBy || null,
      p_pacing_override_by: b.pacingOverrideBy || null,
    });
    if (error) { if (!warnAbsentOr(error, 'createBooking')) console.warn('[bookingsData] createBooking:', error.message); return { ok: false, error: error.message }; }
    // 16 Oct 2026: tell the guest (confirmation by text and email, with their change and cancel
    // link). Fire and forget; a walk in or a booking with no phone or email sends nothing.
    if (data?.ok) nudgeConfirmation(b);
    return { ok: !!data?.ok, error: data?.error || null, tableId: data?.table_id || null, conflictBookingId: data?.booking_id && !data?.ok ? data.booking_id : null, message: data?.message || null };
  } catch (e) {
    return { ok: false, error: e?.message || 'write failed' };
  }
}

// Patch an existing booking (status transitions, seat/depart stamps, notes…).
// v5.5.971 rule: PostgREST returns { error } RESOLVED — always check it.
export async function updateBookingRow(id, patch, locationId) {
  if (isMock || !supabase || !isRealLoc(locationId)) return { ok: true };
  const row = {};
  if (patch.status !== undefined) row.status = patch.status;
  if (patch.note !== undefined) row.note = patch.note;
  if (patch.covers !== undefined) row.covers = patch.covers;
  if (patch.startTime !== undefined) row.start_time = patch.startTime;
  if (patch.date !== undefined) row.booking_date = patch.date;
  if (patch.turnMinutes !== undefined) row.turn_minutes = patch.turnMinutes;
  if (patch.packageId !== undefined) row.package_id = patch.packageId;
  if (patch.customerId !== undefined) row.customer_id = patch.customerId;
  if (patch.customer !== undefined) row.customer = patch.customer;
  if (patch.seatedSessionRef !== undefined) row.seated_session_ref = patch.seatedSessionRef;
  if (patch.seatedAt !== undefined) row.seated_at = patch.seatedAt ? new Date(patch.seatedAt).toISOString() : null;
  if (patch.departedAt !== undefined) row.departed_at = patch.departedAt ? new Date(patch.departedAt).toISOString() : null;
  if (patch.cancelledAt !== undefined) row.cancelled_at = patch.cancelledAt ? new Date(patch.cancelledAt).toISOString() : null;
  if (patch.cancelReason !== undefined) row.cancel_reason = patch.cancelReason;
  if (!Object.keys(row).length) return { ok: true };
  try {
    // 16 Oct 2026 (bookings audit item 10): read back the id. A write the database matched to no
    // row (a policy, another venue, a booking removed meanwhile) answers with no error and no
    // row, and used to be reported as saved.
    const { data, error } = await supabase.from('bookings').update(row).eq('id', id).eq('location_id', locationId).select('id');
    if (error) { if (!warnAbsentOr(error, 'updateBooking')) console.warn('[bookingsData] updateBooking:', error.message); return { ok: false, error: error.message }; }
    if (Array.isArray(data) && data.length === 0) {
      console.warn('[bookingsData] updateBooking: no row changed for', id);
      return { ok: false, refused: true, error: NO_ROW_CHANGED };
    }
    return { ok: true };
  } catch (e) { return { ok: false, error: e?.message }; }
}

// 16 Oct 2026 (audit item 4): a cashed off table departs its booking. The write
// is CONDITIONAL on the row still being dining, so the closing till and every
// device that hears the closed check can all send it and only the first lands;
// a booking re seated, undone or already departed is never touched.
// { ok, changed }: changed is false when the row was not dining any more.
export async function departBookingIfDining(id, locationId, departedAtMs = Date.now()) {
  if (isMock || !supabase || !id || !isRealLoc(locationId)) return { ok: true, changed: false };
  try {
    const { data, error } = await supabase.from('bookings')
      .update({ status: 'departed', departed_at: new Date(departedAtMs).toISOString() })
      .eq('id', id).eq('location_id', locationId).eq('status', 'dining')
      .select('id');
    if (error) { if (!warnAbsentOr(error, 'departBookingIfDining')) console.warn('[bookingsData] departBookingIfDining:', error.message); return { ok: false, error: error.message }; }
    return { ok: true, changed: Array.isArray(data) && data.length > 0 };
  } catch (e) { return { ok: false, error: e?.message || 'write failed' }; }
}

// 16 Oct 2026 (audit item 22): Reports sums money actually TAKEN, not package
// prices. Captured booking_payments per booking, minor units, refunds and rows
// flagged for refund left out. ids are read in chunks so a long week never
// builds an over long URL. null = the ledger could not be read (say so, never 0).
export async function loadCapturedMinorByBooking(bookingIds = []) {
  const ids = [...new Set((bookingIds || []).filter(Boolean))];
  if (isMock || !supabase || !ids.length) return new Map();
  const out = new Map();
  try {
    for (let i = 0; i < ids.length; i += 150) {
      const { data, error } = await supabase.from('booking_payments')
        .select('booking_id, kind, amount, status, refusal_reason')
        .in('booking_id', ids.slice(i, i + 150)).eq('status', 'captured');
      if (error) { warnAbsentOr(error, 'loadCapturedMinorByBooking'); return null; }
      for (const r of data || []) {
        if (r.kind === 'refund' || r.kind === 'hold') continue;
        if (/^needs refund/i.test(String(r.refusal_reason || ''))) continue;
        const minor = Math.round((Number(r.amount) || 0) * 100);
        const p = out.get(r.booking_id) || { total: 0, prepay: 0, deposit: 0 };
        p.total += minor;
        if (r.kind === 'prepay') p.prepay += minor;
        if (r.kind === 'deposit') p.deposit += minor;
        out.set(r.booking_id, p);
      }
    }
    return out;
  } catch (e) { warnAbsentOr(e, 'loadCapturedMinorByBooking'); return null; }
}

export const NO_ROW_CHANGED = 'the database changed no booking row (it may have been removed, or this device is not allowed to change it)';


// 16 Oct 2026 (bookings audit item 10): THE guarded edit. edit_booking (migration 20261016b)
// re checks the window, the covers against the seats and the floor plan under the venue lock,
// then writes the row and the tables in one transaction.
// -> { ok:true, retabled } | { ok:false, error, tableId?, seats?, status? } | { ok:false, missing:true }
// missing = the function is not on the database yet: the caller falls back to the old writes.
export async function editBookingAtomic(id, next, locationId) {
  if (isMock || !supabase) return { ok: true, simulated: true };
  if (!isRealLoc(locationId)) return { ok: false, error: 'no location' };
  try {
    const { data, error } = await supabase.rpc('edit_booking', {
      p_id: id,
      p_location_id: locationId,
      p_booking_date: next.date,
      p_start_time: next.startTime,
      p_turn_minutes: next.turnMinutes,
      p_covers: next.covers,
      p_table_ids: next.tables ?? null,
      p_primary_table_id: next.tables ? next.primaryTableId : null,
      p_note: next.note ?? null,
      p_customer: next.customer ?? null,
      // 16 Oct 2026 review: the stamp the edit was based on, checked again under the lock
      // ('' = never edited, null = no check). Tables null = keep the booking's tables as they are.
      p_expected_edited_at: next.expectedEditedAt ?? null,
    });
    if (error) {
      if (isMissingFunction(error)) return { ok: false, missing: true, error: error.message };
      console.warn('[bookingsData] editBooking:', error.message);
      return { ok: false, error: error.message };
    }
    // refused: the function answered and said no (a code such as table_taken). Without it the
    // call itself failed (a dropped connection), and the edit may still have landed.
    return {
      ok: !!data?.ok, error: data?.error || null, tableId: data?.table_id || null,
      seats: data?.seats ?? null, status: data?.status || null, retabled: !!data?.retabled,
      editedAt: data?.edited_at || null, editedBy: data?.edited_by || null,
      refused: !data?.ok, message: data?.message || null,
    };
  } catch (e) { return { ok: false, error: e?.message || 'edit failed' }; }
}

// Manually re-table a booking. Atomic server-side (move_booking RPC): the
// availability check excludes the booking's own footprint and runs under the
// per-location lock, so a move can never land on someone else's tables.
export async function moveBookingTables(id, tableIds, primaryTableId, locationId) {
  if (isMock || !supabase) return { ok: true, simulated: true };
  if (!isRealLoc(locationId)) return { ok: false, error: 'no location' };
  try {
    const { data, error } = await supabase.rpc('move_booking', {
      p_id: id,
      p_location_id: locationId,
      p_table_ids: tableIds,
      p_primary_table_id: primaryTableId,
    });
    if (error) { if (!warnAbsentOr(error, 'moveBooking')) console.warn('[bookingsData] moveBooking:', error.message); return { ok: false, error: error.message }; }
    return { ok: !!data?.ok, error: data?.error || null, tableId: data?.table_id || null };
  } catch (e) { return { ok: false, error: e?.message || 'move failed' }; }
}

// A date range of bookings for Reports (id-level rows, no membership join —
// primary_table_id is enough for utilisation maths).
export async function loadBookingsRange(locationId, fromISO, toISO) {
  if (isMock || !supabase || !isRealLoc(locationId)) return { data: [] };
  try {
    // 5 Oct 2026: read in pages of 1,000 (lib/pagedRead.js); it had no limit and the API
    // answers 1,000 rows at most, so a long range would have lost its LATEST bookings.
    const { data, error, tooMany } = await readAllPagesResult('bookings', (first) => supabase
      .from('bookings').select('*', first ? { count: 'exact' } : undefined)
      .eq('location_id', locationId)
      .gte('booking_date', fromISO).lte('booking_date', toISO)
      .order('booking_date').order('start_time').order('id'));
    // A venue without the bookings tables has no bookings: that stays an empty list. Any
    // other fault (a failed page, the ceiling) goes back as { error, tooMany } so the
    // report can say so; it used to come back as "no bookings", zero covers.
    if (error) {
      if (warnAbsentOr(error.cause || error, 'loadBookingsRange')) return { data: [] };
      console.warn('[bookingsData] loadBookingsRange:', error.message);
      return { data: [], error, tooMany: !!tooMany };
    }
    return { data: (data || []).map((r) => rowToBooking(r)).filter(Boolean) };
  } catch (e) {
    if (warnAbsentOr(e, 'loadBookingsRange')) return { data: [] };
    return { data: [], error: e, tooMany: false };
  }
}

// ── per-seat pre-orders ───────────────────────────────────────────────────────
// 10 Sep 2026: a guest's size and options ride the row (mods, variant_item_id,
// variant_name; migration 20260910). Before the migration they read as none.
// The mapping is pure and tested in preorderRows.js.
export { rowToPreorder };

export async function loadBookingPreorders(bookingId) {
  if (isMock || !supabase || !bookingId) return { data: [] };
  try {
    const { data, error } = await supabase
      .from('booking_preorders').select('*').eq('booking_id', bookingId)
      .order('seat').order('created_at');
    if (error) { warnAbsentOr(error, 'loadBookingPreorders'); return { data: [] }; }
    return { data: (data || []).map(rowToPreorder).filter(Boolean) };
  } catch (e) { warnAbsentOr(e, 'loadBookingPreorders'); return { data: [] }; }
}

// Replace a booking's pre-orders wholesale (delete+insert — nothing FKs onto
// these rows). rows: [{seat, guestName, itemId, displayName, course, notes,
// mods, variantItemId, variantName}]
// 10 Sep 2026: the guest's size and options are written back with every row,
// so a staff save never wipes them. Before migration 20260910 those columns do
// not exist, so the insert retries without them.
export async function saveBookingPreorders(bookingId, locationId, rows) {
  if (isMock || !supabase || !isRealLoc(locationId) || !bookingId) return { ok: true };
  try {
    const { error: delErr } = await supabase.from('booking_preorders').delete().eq('booking_id', bookingId);
    if (delErr) return { ok: false, error: delErr.message };
    // preorderInsertRows / withoutChoiceColumns: tested in preorderRows.test.js.
    const ins = preorderInsertRows(bookingId, locationId, rows);
    if (ins.length) {
      let { error: insErr } = await supabase.from('booking_preorders').insert(ins);
      if (insErr && missingColumn(insErr)) {
        ({ error: insErr } = await supabase.from('booking_preorders').insert(withoutChoiceColumns(ins)));
      }
      if (insErr) return { ok: false, error: insErr.message };
    }
    return { ok: true };
  } catch (e) { return { ok: false, error: e?.message }; }
}

// The tables ONE booking occupies, straight from the source. A booking and its
// booking_tables rows are written in a single transaction but travel to other
// devices on two independent realtime streams with no ordering promise, so a
// booking that arrives by realtime cannot be trusted to know its own join. This
// settles it with one query instead of hoping the other stream arrived first.
// Primary first, matching how loadBookings builds the same list.
export async function loadBookingTables(bookingId) {
  if (isMock || !supabase || !bookingId) return null;
  try {
    const { data, error } = await supabase.from('booking_tables')
      .select('table_id, is_primary').eq('booking_id', bookingId);
    if (error) { warnAbsentOr(error, 'loadBookingTables'); return null; }
    const arr = [];
    for (const r of data || []) {
      if (r.is_primary) arr.unshift(r.table_id); else arr.push(r.table_id);
    }
    return arr.length ? arr : null;
  } catch (e) { warnAbsentOr(e, 'loadBookingTables'); return null; }
}

// 16 Oct 2026: one booking's row, read fresh, so an edit checks the status and
// the edit stamp the database holds now rather than a cached copy. No tables
// or money here (the caller keeps those). null when it cannot be read.
export async function loadBookingRow(id, locationId) {
  if (isMock || !supabase || !isRealLoc(locationId) || !id) return null;
  try {
    const { data, error } = await supabase.from('bookings').select('*')
      .eq('id', id).eq('location_id', locationId).maybeSingle();
    if (error) { warnAbsentOr(error, 'loadBookingRow'); return null; }
    return data ? rowToBooking(data) : null;
  } catch (e) { warnAbsentOr(e, 'loadBookingRow'); return null; }
}

// Money ledger for one booking. From migration 20260824 a paired host-stand
// device can read this too (the "paired device read" policy) — but a stand on
// a pre-migration DB still gets [], so callers must treat empty as "not
// visible", never "unpaid".
// 10 Sep 2026 review: a FAILED read returns null, never []. An empty list means
// "no payment", and Undo no-show used to write expired on a paid booking whose
// ledger simply had not loaded. [] stays for mock mode and for a database
// without the table yet (nothing can have been paid there).
export async function loadBookingPayments(bookingId) {
  if (isMock || !supabase) return [];
  try {
    const BASE = 'id, kind, status, amount, currency, card_last4, card_brand, applied_to_check, captured_at, authorised_at, refusal_reason';
    // 16 Oct 2026: what the check used and what goes back (migration 20261016b). Before the
    // migration the columns are not there: read without them.
    const read = (cols) => supabase.from('booking_payments').select(cols)
      .eq('booking_id', bookingId).order('created_at', { ascending: true });
    let { data, error } = await read(`${BASE}, applied_minor, refund_due_minor, refund_reason`);
    // Also read without them when this login may not read them (42501): booking_payments has
    // column scoped grants (20260825f), and the migration grants the three new columns. A read
    // refused for them must never blank the whole ledger.
    if (error && (missingColumn(error) || String(error.code || '') === '42501' || /permission denied/i.test(String(error.message || '')))) {
      ({ data, error } = await read(BASE));
    }
    if (error) return warnAbsentOr(error, 'loadBookingPayments') ? [] : null;
    return data || [];
  } catch (e) { return warnAbsentOr(e, 'loadBookingPayments') ? [] : null; }
}

// v5.7.21 — the credit a seated booking carries onto its POS session: CAPTURED,
// not-yet-applied money, summed by kind in MINOR units (booking_payments.amount
// is pounds — converted once, here, at the edge). 'hold' rows are authorised,
// never captured, so they can never become credit through this sum.
export async function loadBookingCredit(bookingId) {
  if (isMock || !supabase || !bookingId) return { prepayMinor: 0, depositMinor: 0 };
  try {
    // 16 Oct 2026 (host tools): what was refunded is not credit (amount_refunded_minor, migration
    // 20261016d, the same subtraction as _booking_credit_for_session). Before the migration the
    // column is not there and only a full refund can be made, which the status already covers.
    const read = (cols) => supabase.from('booking_payments').select(cols)
      .eq('booking_id', bookingId).eq('status', 'captured').eq('applied_to_check', false);
    const BASE = 'kind, amount, status, applied_to_check, refusal_reason';
    let { data, error } = await read(`${BASE}, amount_refunded_minor`);
    if (error && (missingColumn(error) || String(error.code || '') === '42501' || /permission denied/i.test(String(error.message || '')))) {
      ({ data, error } = await read(BASE));
    }
    if (error) { warnAbsentOr(error, 'loadBookingCredit'); return { prepayMinor: 0, depositMinor: 0 }; }
    let prepayMinor = 0, depositMinor = 0;
    for (const r of data || []) {
      // 16 Oct 2026: a row flagged NEEDS REFUND is owed back, never credit on the bill (the
      // reader's _booking_credit_for_session leaves it out too, so the till and reader agree).
      if (/^needs refund/i.test(String(r.refusal_reason || ''))) continue;
      const minor = Math.max(0, Math.round((Number(r.amount) || 0) * 100) - Math.max(0, Math.round(Number(r.amount_refunded_minor) || 0)));
      if (r.kind === 'prepay') prepayMinor += minor;
      else if (r.kind === 'deposit') depositMinor += minor;
    }
    return { prepayMinor, depositMinor };
  } catch (e) { warnAbsentOr(e, 'loadBookingCredit'); return { prepayMinor: 0, depositMinor: 0 }; }
}

// v5.7.21 — the guest link base for the Inspector's Copy link, mirroring
// booking-reminders' venueMeta: platform locations.ops_location_id (fallback:
// id) → online_slug → https://<slug>.<CUSTOMER_ROOT>. null = no slug / no
// platform reach; the caller says so instead of copying a dead link.
export async function lookupPreorderLinkBase(opsLocationId) {
  if (!opsLocationId || !platformSupabase) return null;
  try {
    const select = 'id, online_slug';
    let r = (await platformSupabase.from('locations').select(select).eq('ops_location_id', opsLocationId).maybeSingle()).data;
    if (!r) r = (await platformSupabase.from('locations').select(select).eq('id', opsLocationId).maybeSingle()).data;
    return r?.online_slug ? `https://${r.online_slug}.${CUSTOMER_ROOT}` : null;
  } catch { return null; }
}

// How many live future bookings still reference a package (delete warning).

// 16 Oct 2026: from the VENUE's today (pass it in); the UTC date was wrong for
// a California venue after 17:00 and for a UK one after 23:00 in summer.
export async function countUpcomingBookingsForPackage(packageId, venueYmd = null) {
  if (isMock || !supabase || !packageId) return 0;
  try {
    const today = venueYmd || new Date().toISOString().slice(0, 10);
    const { count, error } = await supabase
      .from('bookings').select('id', { count: 'exact', head: true })
      .eq('package_id', packageId).gte('booking_date', today)
      .not('status', 'in', '(cancelled,no_show,departed)');
    if (error) return 0;
    return count || 0;
  } catch { return 0; }
}

// ── rules ─────────────────────────────────────────────────────────────────────
export async function loadBookingRules(locationId) {
  if (isMock || !supabase || !isRealLoc(locationId)) return { data: null };
  try {
    const { data, error } = await supabase.from('booking_rules').select('*').eq('location_id', locationId).maybeSingle();
    if (error) { warnAbsentOr(error, 'loadBookingRules'); return { data: null }; }
    return { data: rowToRules(data) };
  } catch (e) { warnAbsentOr(e, 'loadBookingRules'); return { data: null }; }
}

export async function saveBookingRules(locationId, patch) {
  if (isMock || !supabase || !isRealLoc(locationId)) return { ok: true };
  const row = { location_id: locationId };
  if (patch.turnBands) {
    row.turn_1_2 = patch.turnBands['1-2']; row.turn_3_4 = patch.turnBands['3-4'];
    row.turn_5_6 = patch.turnBands['5-6']; row.turn_7_plus = patch.turnBands['7+'];
  }
  for (const [camel, snake] of Object.entries(RULES_TO_ROW)) {
    if (patch[camel] !== undefined) row[snake] = patch[camel];
  }
  try {
    const { error } = await supabase.from('booking_rules').upsert(row, { onConflict: 'location_id' });
    if (error) {
      // 16 Oct 2026: a service period write before migration 20261016e names a column the
      // database does not have yet. Say that in words; nothing was saved.
      if (touchesServiceRules(patch) && missingColumn(error)) return { ok: false, error: error.message, words: SERVICE_RULES_MISSING };
      if (!warnAbsentOr(error, 'saveBookingRules')) console.warn('[bookingsData] saveBookingRules:', error.message);
      return { ok: false, error: error.message };
    }
    return { ok: true };
  } catch (e) { return { ok: false, error: e?.message }; }
}

// ── package writers ───────────────────────────────────────────────────────────
// Lines are replaced wholesale per save (delete-then-insert). Safe here because
// nothing holds a FK onto package_lines — unlike po_lines, where this pattern
// is a trap. If anything ever references line ids, revisit.
export async function upsertPackageRow(pkg, locationId) {
  if (isMock || !supabase || !isRealLoc(locationId)) return { ok: true };
  const row = {
    id: pkg.id,
    location_id: locationId,
    name: pkg.name || 'New package',
    description: pkg.description || '',
    price: pkg.price ?? 0,
    price_unit: pkg.priceUnit || 'per_cover',
    payment_model: pkg.paymentModel || 'deposit',
    deposit_per_cover: pkg.depositPerCover ?? 0,
    turn_minutes: pkg.turnMinutes || null,
    available_from: pkg.availableFrom || null,
    available_to: pkg.availableTo || null,
    available_days: pkg.availableDays || [],
    available_start: pkg.availableStart || null,
    available_end: pkg.availableEnd || null,
    min_covers: pkg.minCovers ?? 1,
    max_covers: pkg.maxCovers || null,
    max_per_service: pkg.maxPerService || null,
    sections: pkg.sections || [],
    requires_preorder: !!pkg.requiresPreorder,
    preorder_days_before: pkg.preorderDaysBefore ?? 0,
    terms: pkg.terms || '',
    is_active: pkg.isActive !== false,
    sort_order: pkg.sortOrder ?? 0,
  };
  try {
    const { error } = await supabase.from('packages').upsert(row, { onConflict: 'id' });
    if (error) { if (!warnAbsentOr(error, 'upsertPackage')) console.warn('[bookingsData] upsertPackage:', error.message); return { ok: false, error: error.message }; }
    const { error: delErr } = await supabase.from('package_lines').delete().eq('package_id', pkg.id).eq('location_id', locationId);
    if (delErr) return { ok: false, error: delErr.message };
    const lines = (pkg.lines || []).map((l, i) => ({
      location_id: locationId,
      package_id: pkg.id,
      item_id: l.itemId || null,
      display_name: l.displayName || 'Item',
      qty_per_cover: l.qtyPerCover ?? 1,
      course: l.course ?? 0,
      price_override: l.priceOverride == null ? null : l.priceOverride,
      is_preorder_choice: !!l.isPreorderChoice,
      sort_order: l.sortOrder ?? i,
    }));
    if (lines.length) {
      const { error: insErr } = await supabase.from('package_lines').insert(lines);
      if (insErr) return { ok: false, error: insErr.message };
    }
    return { ok: true };
  } catch (e) { return { ok: false, error: e?.message }; }
}

export async function deletePackageRow(id, locationId) {
  if (isMock || !supabase || !isRealLoc(locationId)) return { ok: true };
  try {
    const { error } = await supabase.from('packages').delete().eq('id', id).eq('location_id', locationId);
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (e) { return { ok: false, error: e?.message }; }
}

// ── packages ──────────────────────────────────────────────────────────────────
export async function loadPackages(locationId) {
  if (isMock || !supabase || !isRealLoc(locationId)) return { data: [] };
  try {
    const [{ data: pkgs, error: pErr }, { data: lines, error: lErr }] = await Promise.all([
      supabase.from('packages').select('*').eq('location_id', locationId).order('sort_order'),
      supabase.from('package_lines').select('*').eq('location_id', locationId).order('sort_order'),
    ]);
    if (pErr) { warnAbsentOr(pErr, 'loadPackages'); return { data: [] }; }
    const byPkg = new Map();
    if (!lErr) for (const l of lines || []) {
      const arr = byPkg.get(l.package_id) || [];
      arr.push(rowToPackageLine(l));
      byPkg.set(l.package_id, arr);
    }
    return { data: (pkgs || []).map((r) => rowToPackage({ ...r, _lines: byPkg.get(r.id) || [] })).filter(Boolean) };
  } catch (e) { warnAbsentOr(e, 'loadPackages'); return { data: [] }; }
}
