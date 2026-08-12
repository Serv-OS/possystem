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

import { supabase, isMock } from '../supabase';

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
    pacingOverrideBy: r.pacing_override_by || null,
    seatedSessionRef: r.seated_session_ref || null,
    seatedAt: r.seated_at ? new Date(r.seated_at).getTime() : null,
    departedAt: r.departed_at ? new Date(r.departed_at).getTime() : null,
    cancelledAt: r.cancelled_at ? new Date(r.cancelled_at).getTime() : null,
    cancelReason: r.cancel_reason || null,
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
    if (ids.length) {
      const { data: bt, error: btErr } = await supabase
        .from('booking_tables').select('booking_id, table_id, is_primary').in('booking_id', ids);
      if (!btErr) {
        membership = (bt || []).reduce((m, row) => {
          const arr = m.get(row.booking_id) || [];
          if (row.is_primary) arr.unshift(row.table_id); else arr.push(row.table_id);
          m.set(row.booking_id, arr);
          return m;
        }, new Map());
      }
    }
    return { data: (data || []).map((r) => rowToBooking({ ...r, _tables: membership.get(r.id) || [r.primary_table_id] })).filter(Boolean) };
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
