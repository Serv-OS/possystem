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
    seatedSessionRef: r.seated_session_ref || null,
    seatedAt: r.seated_at ? new Date(r.seated_at).getTime() : null,
    departedAt: r.departed_at ? new Date(r.departed_at).getTime() : null,
    cancelledAt: r.cancelled_at ? new Date(r.cancelled_at).getTime() : null,
    cancelReason: r.cancel_reason || null,
    preorderCount: r._preorderCount ?? 0,
    createdBy: r.created_by || null,
    updatedAt: r.updated_at ? new Date(r.updated_at).getTime() : null,
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
    if (error) { if (!warnAbsentOr(error, 'loadBookings')) console.warn('[bookingsData] loadBookings:', error.message); return { data: [] }; }
    const ids = (data || []).map((b) => b.id);
    let membership = new Map();
    const preCounts = new Map();
    // v5.7.21: captured money per booking (booking_payments is readable by
    // paired devices from migration 20260824). Missing map entry = ledger not
    // visible (pre-migration RLS / error) → paidMinor stays null = "unknown".
    const paid = new Map(); // booking_id → { total, prepay, deposit } minor
    if (ids.length) {
      const [{ data: bt, error: btErr }, { data: po }, { data: pay, error: payErr }] = await Promise.all([
        supabase.from('booking_tables').select('booking_id, table_id, is_primary').in('booking_id', ids),
        supabase.from('booking_preorders').select('booking_id').in('booking_id', ids),
        supabase.from('booking_payments').select('booking_id, kind, amount, status').in('booking_id', ids).eq('status', 'captured'),
      ]);
      if (!btErr) {
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
    })).filter(Boolean) };
  } catch (e) {
    if (!warnAbsentOr(e, 'loadBookings')) console.warn('[bookingsData] loadBookings threw:', e?.message || e);
    return { data: [] };
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
    return { ok: !!data?.ok, error: data?.error || null, tableId: data?.table_id || null, conflictBookingId: data?.booking_id && !data?.ok ? data.booking_id : null };
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
    const { error } = await supabase.from('bookings').update(row).eq('id', id).eq('location_id', locationId);
    if (error) { if (!warnAbsentOr(error, 'updateBooking')) console.warn('[bookingsData] updateBooking:', error.message); return { ok: false, error: error.message }; }
    return { ok: true };
  } catch (e) { return { ok: false, error: e?.message }; }
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
    const { data, error } = await supabase
      .from('bookings').select('*')
      .eq('location_id', locationId)
      .gte('booking_date', fromISO).lte('booking_date', toISO)
      .order('booking_date').order('start_time');
    if (error) { warnAbsentOr(error, 'loadBookingsRange'); return { data: [] }; }
    return { data: (data || []).map((r) => rowToBooking(r)).filter(Boolean) };
  } catch (e) { warnAbsentOr(e, 'loadBookingsRange'); return { data: [] }; }
}

// ── per-seat pre-orders ───────────────────────────────────────────────────────
export const rowToPreorder = (r) => (r ? {
  id: r.id, bookingId: r.booking_id, seat: r.seat ?? null, guestName: r.guest_name || '',
  itemId: r.item_id || null, displayName: r.display_name || '', course: r.course ?? 0, notes: r.notes || '',
} : null);

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
// these rows). rows: [{seat, guestName, itemId, displayName, course, notes}]
export async function saveBookingPreorders(bookingId, locationId, rows) {
  if (isMock || !supabase || !isRealLoc(locationId) || !bookingId) return { ok: true };
  try {
    const { error: delErr } = await supabase.from('booking_preorders').delete().eq('booking_id', bookingId);
    if (delErr) return { ok: false, error: delErr.message };
    const ins = (rows || []).filter((r) => r.displayName || r.itemId).map((r) => ({
      location_id: locationId,
      booking_id: bookingId,
      seat: r.seat ?? null,
      guest_name: r.guestName || null,
      item_id: r.itemId || null,
      display_name: r.displayName || 'Item',
      course: r.course ?? 0,
      notes: r.notes || '',
    }));
    if (ins.length) {
      const { error: insErr } = await supabase.from('booking_preorders').insert(ins);
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

// Money ledger for one booking. From migration 20260824 a paired host-stand
// device can read this too (the "paired device read" policy) — but a stand on
// a pre-migration DB still gets [], so callers must treat empty as "not
// visible", never "unpaid".
export async function loadBookingPayments(bookingId) {
  if (isMock || !supabase) return [];
  try {
    const { data, error } = await supabase.from('booking_payments')
      .select('id, kind, status, amount, currency, card_last4, card_brand, applied_to_check, captured_at, authorised_at')
      .eq('booking_id', bookingId).order('created_at', { ascending: true });
    if (error) { warnAbsentOr(error, 'loadBookingPayments'); return []; }
    return data || [];
  } catch (e) { warnAbsentOr(e, 'loadBookingPayments'); return []; }
}

// v5.7.21 — the credit a seated booking carries onto its POS session: CAPTURED,
// not-yet-applied money, summed by kind in MINOR units (booking_payments.amount
// is pounds — converted once, here, at the edge). 'hold' rows are authorised,
// never captured, so they can never become credit through this sum.
export async function loadBookingCredit(bookingId) {
  if (isMock || !supabase || !bookingId) return { prepayMinor: 0, depositMinor: 0 };
  try {
    const { data, error } = await supabase.from('booking_payments')
      .select('kind, amount, status, applied_to_check')
      .eq('booking_id', bookingId).eq('status', 'captured').eq('applied_to_check', false);
    if (error) { warnAbsentOr(error, 'loadBookingCredit'); return { prepayMinor: 0, depositMinor: 0 }; }
    let prepayMinor = 0, depositMinor = 0;
    for (const r of data || []) {
      const minor = Math.round((Number(r.amount) || 0) * 100);
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

export async function countUpcomingBookingsForPackage(packageId) {
  if (isMock || !supabase || !packageId) return 0;
  try {
    const today = new Date().toISOString().slice(0, 10);
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
    if (error) { if (!warnAbsentOr(error, 'saveBookingRules')) console.warn('[bookingsData] saveBookingRules:', error.message); return { ok: false, error: error.message }; }
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
