// src/lib/bookings/bookingMoneyData.js
//
// Reads for the Back Office booking reports and the Booking payments tab (16 Oct 2026). Every
// read of a range goes in pages of 1,000 (lib/pagedRead.js), because the API answers 1,000 rows
// at most and a long range would silently lose rows; reads by id go in chunks so a long list never
// builds an over long URL. A failed read says so ({ error }), it is never an empty list.
//
// booking_payments is readable by a Back Office login for its own sites ("bo read", 20260811b),
// on the columns granted to logins (20260825f, plus 20261016b's three new ones once that runs:
// read without them before). The processor ids and the stored card token are never read here.

import { supabase, isMock } from '../supabase';
import { readAllPagesResult } from '../pagedRead.js';
import { rowToBooking } from './bookingsData.js';

const PAY_BASE = 'id, location_id, booking_id, kind, amount, currency, status, card_last4, card_brand, refusal_reason, applied_to_check, applied_check_id, authorised_at, captured_at, released_at, created_at';
const PAY_NEW = 'applied_minor, refund_due_minor, refund_reason';
const CHUNK = 150;

const refusedColumn = (e) => {
  const m = String(e?.message || e?.cause?.message || '');
  const code = String(e?.code || e?.cause?.code || '');
  return code === '42703' || code === '42501' || /does not exist|permission denied|schema cache|Could not find the/i.test(m);
};
const absentTable = (e) => /relation .* does not exist|booking_payments.*does not exist/i.test(String(e?.message || e?.cause?.message || ''));

/**
 * Every booking payment of one site paid (created) inside [fromIso, toIso], oldest first.
 * -> { data, error, tooMany }
 */
export async function loadBookingPaymentsRange(locationId, fromIso, toIso, opts = {}) {
  if (isMock || !supabase || !locationId) return { data: [] };
  const read = (cols) => readAllPagesResult('booking payments', (first) => supabase
    .from('booking_payments').select(cols, first ? { count: 'exact' } : undefined)
    .eq('location_id', locationId)
    .gte('created_at', fromIso).lte('created_at', toIso)
    .order('created_at').order('id'), opts);
  let res = await read(`${PAY_BASE}, ${PAY_NEW}`);
  if (res.error && refusedColumn(res.error)) res = await read(PAY_BASE);
  if (res.error) {
    if (absentTable(res.error)) return { data: [] };
    return { data: [], error: res.error, tooMany: !!res.tooMany };
  }
  return { data: res.data || [] };
}

/** The payments of a list of bookings (the Bookings report's money). -> { data, error } */
export async function loadPaymentsForBookings(bookingIds = []) {
  const ids = [...new Set((bookingIds || []).filter(Boolean))];
  if (isMock || !supabase || !ids.length) return { data: [] };
  const out = [];
  let cols = `${PAY_BASE}, ${PAY_NEW}`;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const part = ids.slice(i, i + CHUNK);
    let { data, error } = await supabase.from('booking_payments').select(cols).in('booking_id', part);
    if (error && refusedColumn(error) && cols !== PAY_BASE) {
      cols = PAY_BASE;
      ({ data, error } = await supabase.from('booking_payments').select(cols).in('booking_id', part));
    }
    if (error) return absentTable(error) ? { data: [] } : { data: [], error };
    out.push(...(data || []));
  }
  return { data: out };
}

/** Bookings by id with their tables, camelCase. -> { data: Map, error } */
export async function loadBookingsByIds(bookingIds = []) {
  const ids = [...new Set((bookingIds || []).filter(Boolean))];
  const map = new Map();
  if (isMock || !supabase || !ids.length) return { data: map };
  for (let i = 0; i < ids.length; i += CHUNK) {
    const part = ids.slice(i, i + CHUNK);
    const [{ data, error }, { data: bt }] = await Promise.all([
      supabase.from('bookings').select('*').in('id', part),
      supabase.from('booking_tables').select('booking_id, table_id, is_primary').in('booking_id', part),
    ]);
    if (error) return { data: map, error };
    const tables = new Map();
    for (const r of bt || []) {
      const arr = tables.get(r.booking_id) || [];
      if (r.is_primary) arr.unshift(r.table_id); else arr.push(r.table_id);
      tables.set(r.booking_id, arr);
    }
    for (const r of data || []) {
      const b = rowToBooking({ ...r, _tables: tables.get(r.id) || (r.primary_table_id ? [r.primary_table_id] : []) });
      if (b) map.set(b.id, b);
    }
  }
  return { data: map };
}

/** A site's table names: Map id -> label. Best effort (an id shows when it cannot be read). */
export async function loadTableLabels(locationId) {
  const map = new Map();
  if (isMock || !supabase || !locationId) return map;
  try {
    const { data } = await supabase.from('floor_tables').select('id, label').eq('location_id', locationId);
    for (const t of data || []) map.set(t.id, t.label || t.id);
  } catch { /* labels are a nicety: the id shows instead */ }
  return map;
}
