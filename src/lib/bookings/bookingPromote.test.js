/**
 * bookingPromote.test.js — the ONE server door to confirmed or prepaid
 * (supabase/functions/_shared/bookingPromote.ts, 10 Sep 2026 review).
 *
 * Until migration 20260910 is applied every booking_pay, booking_pay_details
 * and webhook promotion runs the fallback branch, so a regression here would
 * confirm an unpaid booking or never confirm a paid one. Node strips the
 * TypeScript types, so the Deno file is imported directly and driven with a
 * small fake PostgREST client.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  promotePaidBooking, markPaymentNeedsRefund, loadBookingDue,
  isMissingColumnError, isMissingFunctionError, venueTodayFor,
} from '../../../supabase/functions/_shared/bookingPromote.ts';

// In-memory tables behind the builder chain the file uses:
// from().select().eq().in().order().limit().maybeSingle(), update(), insert(), rpc().
// errors: { 'table.op': error | (state) => error | null }
function fakeDb({ tables = {}, rpc = null, errors = {} } = {}) {
  const calls = [];
  const db = {
    calls,
    tables,
    rpc: async (name, args) => {
      calls.push({ rpc: name, args });
      if (rpc) return rpc(name, args);
      return { data: null, error: { code: 'PGRST202', message: 'Could not find the function public.promote_paid_booking' } };
    },
    from(table) {
      const st = { table, op: 'select', cols: '', filters: [], patch: null, rows: null, single: false, limitN: null };
      const run = () => {
        calls.push({ table, op: st.op, cols: st.cols, patch: st.patch, rows: st.rows });
        const errSpec = errors[`${table}.${st.op}`];
        const err = typeof errSpec === 'function' ? errSpec(st) : errSpec;
        if (err) return { data: null, error: err };
        const list = tables[table] || (tables[table] = []);
        if (st.op === 'insert') {
          list.push(...st.rows.map((r) => ({ ...r })));
          return { data: st.rows.map((r) => ({ ...r })), error: null };
        }
        let hits = list.filter((row) => st.filters.every((f) => f(row)));
        if (st.op === 'update') hits.forEach((row) => Object.assign(row, st.patch));
        if (st.limitN != null) hits = hits.slice(0, st.limitN);
        if (st.single) return { data: hits[0] ? { ...hits[0] } : null, error: null };
        return { data: hits.map((r) => ({ ...r })), error: null };
      };
      const b = {
        select(cols = '') { if (st.op === 'select') st.cols = cols; return b; },
        update(p) { st.op = 'update'; st.patch = p; return b; },
        insert(r) { st.op = 'insert'; st.rows = Array.isArray(r) ? r : [r]; return b; },
        eq(c, v) { st.filters.push((row) => String(row[c]) === String(v)); return b; },
        in(c, vs) { const set = (vs || []).map(String); st.filters.push((row) => set.includes(String(row[c]))); return b; },
        order() { return b; },
        limit(n) { st.limitN = n; return b; },
        maybeSingle() { st.single = true; return b; },
        then(resolve, reject) { return Promise.resolve().then(run).then(resolve, reject); },
      };
      return b;
    },
  };
  return db;
}

const LOC = '7218c716-eeb4-4f96-b284-f3500823595c';
const booking = (over = {}) => ({
  id: 'bk-1', location_id: LOC, booking_date: '2030-01-05', start_time: '19:00:00', turn_minutes: 120,
  status: 'pending_payment', primary_table_id: 'T5', covers: 2, package_id: null, source: 'widget', ...over,
});

test('fallback: a pending_payment prepay booking becomes prepaid', async () => {
  const db = fakeDb({ tables: { bookings: [booking()] } });
  const r = await promotePaidBooking(db, 'bk-1', 'prepay');
  assert.deepEqual(r, { ok: true, promoted: true, status: 'prepaid' });
  assert.equal(db.tables.bookings[0].status, 'prepaid');
});

test('fallback: cancelled, dining and no_show never promote', async () => {
  for (const status of ['cancelled', 'dining', 'no_show', 'departed']) {
    const db = fakeDb({ tables: { bookings: [booking({ status })] } });
    const r = await promotePaidBooking(db, 'bk-1', 'deposit');
    assert.equal(r.ok, false, status);
    assert.equal(r.error, 'not_promotable', status);
    assert.equal(db.tables.bookings[0].status, status);
  }
});

test('fallback: expired with its table still free becomes confirmed', async () => {
  const db = fakeDb({ tables: {
    bookings: [booking({ status: 'expired' })],
    booking_tables: [{ booking_id: 'bk-1', table_id: 'T5' }],
    locations: [{ id: LOC, timezone: 'Europe/London' }],
    active_sessions: [],
  } });
  const r = await promotePaidBooking(db, 'bk-1', 'hold');
  assert.deepEqual(r, { ok: true, promoted: true, status: 'confirmed' });
});

test('fallback: expired with its table booked again gives table_taken and stays expired', async () => {
  const db = fakeDb({ tables: {
    bookings: [booking({ status: 'expired' }), booking({ id: 'bk-2', status: 'confirmed', start_time: '20:00:00', turn_minutes: 90 })],
    booking_tables: [{ booking_id: 'bk-1', table_id: 'T5' }, { booking_id: 'bk-2', table_id: 'T5' }],
    locations: [{ id: LOC, timezone: 'Europe/London' }],
  } });
  const r = await promotePaidBooking(db, 'bk-1', 'prepay');
  assert.equal(r.error, 'table_taken');
  assert.equal(db.tables.bookings[0].status, 'expired');
});

test('an expired booking TODAY whose table has a live till tab gives table_taken before either door', async () => {
  const today = venueTodayFor('Europe/London');
  const db = fakeDb({
    tables: {
      bookings: [booking({ status: 'expired', booking_date: today })],
      booking_tables: [{ booking_id: 'bk-1', table_id: 'T5' }],
      locations: [{ id: LOC, timezone: 'Europe/London' }],
      active_sessions: [{ location_id: LOC, table_id: 'T5', session: { seatedAt: Date.now(), items: [] } }],
    },
    rpc: async () => ({ data: { ok: true, promoted: true, status: 'confirmed' }, error: null }),
  });
  const r = await promotePaidBooking(db, 'bk-1', 'hold');
  assert.equal(r.error, 'table_taken');
  assert.equal(db.calls.some((c) => c.rpc), false, 'the RPC is never called');
  assert.equal(db.tables.bookings[0].status, 'expired');
});

test('the RPC answer is used when the function exists; a real RPC error is promote_failed', async () => {
  const ok = fakeDb({ tables: { bookings: [booking()] }, rpc: async () => ({ data: { ok: true, promoted: true, status: 'prepaid' }, error: null }) });
  assert.deepEqual(await promotePaidBooking(ok, 'bk-1', 'prepay'), { ok: true, promoted: true, status: 'prepaid' });
  const bad = fakeDb({ tables: { bookings: [booking()] }, rpc: async () => ({ data: null, error: { code: '40001', message: 'serialization failure' } }) });
  const r = await promotePaidBooking(bad, 'bk-1', 'prepay');
  assert.equal(r.error, 'promote_failed');
  assert.equal(bad.tables.bookings[0].status, 'pending_payment');
});

test('a booking that is gone is unknown_booking, never a success', async () => {
  const db = fakeDb({ tables: { bookings: [] } });
  assert.equal((await promotePaidBooking(db, 'bk-x', 'prepay')).error, 'unknown_booking');
});

test('markPaymentNeedsRefund: before the migration the status is kept and the reason says NEEDS REFUND; money raises an alert', async () => {
  const db = fakeDb({
    tables: {
      booking_payments: [
        { id: 'p1', location_id: LOC, booking_id: 'bk-1', kind: 'prepay', amount: 240, currency: 'gbp', status: 'captured', refusal_reason: null },
        { id: 'h1', location_id: LOC, booking_id: 'bk-1', kind: 'hold', amount: 40, currency: 'gbp', status: 'authorised', refusal_reason: null },
      ],
      activity_events: [],
    },
    errors: { 'booking_payments.update': (st) => (st.patch?.status === 'needs_refund' ? { code: '23514', message: 'violates check constraint' } : null) },
  });
  await markPaymentNeedsRefund(db, ['p1', 'h1'], 'the party was seated before the payment arrived', { guestName: 'Ana', time: '19:00:00' });
  assert.equal(db.tables.booking_payments[0].status, 'captured');
  assert.equal(db.tables.booking_payments[0].refusal_reason, 'NEEDS REFUND: the party was seated before the payment arrived');
  assert.equal(db.tables.activity_events.length, 1, 'one alert, for the money only');
  const alert = db.tables.activity_events[0];
  assert.equal(alert.severity, 'urgent');
  assert.equal(alert.ref_id, 'bk-1');
  assert.equal(alert.body, '£240.00 was paid online for Ana at 19:00, but the party was seated before the payment arrived. Refund the guest in Adyen.');
  assert.ok(!/bk-1/.test(alert.body), 'no ids inside the sentence');
});

test('markPaymentNeedsRefund: after the migration the status becomes needs_refund', async () => {
  const db = fakeDb({ tables: { booking_payments: [{ id: 'p1', location_id: LOC, booking_id: 'bk-1', kind: 'deposit', amount: 20, currency: 'gbp', status: 'captured' }] } });
  await markPaymentNeedsRefund(db, ['p1'], 'the booking was cancelled');
  assert.equal(db.tables.booking_payments[0].status, 'needs_refund');
  assert.equal(db.tables.activity_events.length, 1);
});

const PROVO_PKG = { id: 'pk-1786580494031-hd32', payment_model: 'prepay', price: 120, price_unit: 'per_cover' };
const PROVO_RULES_ROW = { location_id: LOC, card_capture_enabled: true, hold_per_cover: 20, card_capture_min_covers: 2 };

test('loadBookingDue: a stored hold of 0 on the Provo prepay package is refused', async () => {
  const db = fakeDb({ tables: {
    bookings: [booking({ package_id: PROVO_PKG.id, payment_kind: 'hold', payment_due_minor: 0, payment_currency: 'GBP' })],
    booking_rules: [PROVO_RULES_ROW], booking_requests: [], packages: [PROVO_PKG],
  } });
  const r = await loadBookingDue(db, 'bk-1');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'due_mismatch');
});

test('loadBookingDue: package_id nulled in a browser still charges the package in the audit row, at the larger party', async () => {
  const db = fakeDb({ tables: {
    bookings: [booking({ package_id: null, covers: 1 })],
    booking_rules: [PROVO_RULES_ROW],
    booking_requests: [{ booking_id: 'bk-1', payload: { package_id: PROVO_PKG.id, party: 2 } }],
    packages: [PROVO_PKG],
  } });
  const r = await loadBookingDue(db, 'bk-1');
  assert.equal(r.ok, true);
  assert.deepEqual(r.due, { kind: 'prepay', amountMinor: 24000, currency: null });
});

test('loadBookingDue: before the migration the payment columns are absent and the read retries without them', async () => {
  const db = fakeDb({
    tables: { bookings: [booking({ covers: 2 })], booking_rules: [PROVO_RULES_ROW], booking_requests: [] },
    errors: { 'bookings.select': (st) => (st.cols.includes('payment_kind') ? { code: '42703', message: 'column bookings.payment_kind does not exist' } : null) },
  });
  const r = await loadBookingDue(db, 'bk-1');
  assert.equal(r.ok, true);
  assert.deepEqual(r.due, { kind: 'hold', amountMinor: 4000, currency: null });
});

test('isMissingColumnError and isMissingFunctionError read both PostgREST shapes', () => {
  assert.equal(isMissingColumnError({ code: '42703', message: 'column bookings.payment_kind does not exist' }), true);
  assert.equal(isMissingColumnError({ code: 'PGRST204', message: "Could not find the 'mods' column of 'booking_preorders' in the schema cache" }), true);
  assert.equal(isMissingColumnError({ code: 'PGRST204', message: "Could not find the 'mods' column" }, 'mods'), true);
  assert.equal(isMissingColumnError({ code: 'PGRST204', message: "Could not find the 'mods' column" }, 'variant_name'), false);
  assert.equal(isMissingColumnError({ code: '23505', message: 'duplicate key' }), false);
  assert.equal(isMissingColumnError(null), false);
  assert.equal(isMissingFunctionError({ code: 'PGRST202', message: 'x' }), true);
  assert.equal(isMissingFunctionError({ code: '42883', message: 'x' }), true);
  assert.equal(isMissingFunctionError({ code: '40001', message: 'x' }), false);
});
