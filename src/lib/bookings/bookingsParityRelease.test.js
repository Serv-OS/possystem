/**
 * bookingsParityRelease.test.js: the v5.11.70 release joins four bookings tracks (guest link,
 * host tools, service periods, no show charge and reports). These tests pin the places where
 * the tracks meet:
 *   - the guest's change page follows the service periods and says edit_booking's refusals
 *   - one money rule (what is left of a payment after refunds) for every track
 *   - a no show charge is refunded from its check, never from the Refund panel
 *   - the reports never count a refund twice and read a hold's figure from hold_minor
 *   - the migrations patch edit_booking by its real id and keep each other's changes
 */

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { paymentNetMinor, refundedMinorFor } from './bookingPayment.js';
import { moneyOnBooking, owedBackOnBooking } from './bookingGuest.js';
import { refundCheck, REFUNDABLE_KINDS, creditMinorOf } from '../../../supabase/functions/_shared/bookingHost.js';
import { paymentLines, paymentTotals, moneyByBooking, owedBackMinor } from './bookingReports.js';
import { noShowFee } from './noShowCharge.js';
import { isoWeekday, addDaysISO } from './optimiser.js';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const migration = (name) => readFileSync(here(`../../../supabase/migrations/${name}`), 'utf8');

// ── the guest's change page, through manage.ts ──────────────────────────────────────────────

let handleManage;
before(async () => {
  globalThis.Deno = globalThis.Deno || { env: { get: () => '' } };
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: true, results: {} }) });
  ({ handleManage } = await import('../../../supabase/functions/booking-widget/manage.ts'));
});

function fakeDb(tables, rpc) {
  const calls = [];
  return {
    calls,
    rpc: async (name, args) => { calls.push({ rpc: name, args }); return rpc(name, args); },
    from(table) {
      const st = { op: 'select', filters: [], patch: null, rows: null, single: false };
      const run = () => {
        const list = tables[table] || (tables[table] = []);
        if (st.op === 'insert') { list.push(...st.rows); return { data: st.rows, error: null }; }
        const hits = list.filter((row) => st.filters.every((f) => f(row)));
        if (st.op === 'update') hits.forEach((row) => Object.assign(row, st.patch));
        if (st.single) return { data: hits[0] ? { ...hits[0] } : null, error: null };
        return { data: hits.map((r) => ({ ...r })), error: null };
      };
      const b = {
        select() { return b; },
        update(p) { st.op = 'update'; st.patch = p; return b; },
        insert(r) { st.op = 'insert'; st.rows = Array.isArray(r) ? r : [r]; return b; },
        delete() { st.op = 'delete'; return b; },
        eq(c, v) { st.filters.push((row) => String(row[c]) === String(v)); return b; },
        in(c, vs) { const s = (vs || []).map(String); st.filters.push((row) => s.includes(String(row[c]))); return b; },
        gt() { return b; }, lt() { return b; }, order() { return b; }, limit() { return b; },
        maybeSingle() { st.single = true; return b; },
        then(resolve, reject) { return Promise.resolve().then(run).then(resolve, reject); },
      };
      return b;
    },
  };
}

const LOC = '7218c716-eeb4-4f96-b284-f3500823595c';
const TOKEN = 'b'.repeat(64);
const TZ = 'Europe/London';
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
// The next given ISO weekday at least a week away (inside the 90 days ahead, outside any notice).
function nextWeekday(wd) {
  let d = addDaysISO(today(), 7);
  while (isoWeekday(d) !== wd) d = addDaysISO(d, 1);
  return d;
}
const TUESDAY = nextWeekday(2);
const MONDAY = nextWeekday(1);

const PERIODS = [
  { id: 'l', name: 'Lunch', days: [1, 2, 3, 4, 5, 6, 7], start: '12:00', end: '15:00', lastSeating: '14:30' },
  { id: 'd', name: 'Dinner', days: [1, 2, 3, 4, 5, 6, 7], start: '17:00', end: '22:00', lastSeating: '21:00' },
];

function setup({ rpc = async () => ({ data: { ok: true }, error: null }), rules = {} } = {}) {
  const tables = {
    bookings: [{
      id: 'bk-1', location_id: LOC, booking_date: TUESDAY, start_time: '19:00:00', turn_minutes: 90, covers: 2,
      status: 'confirmed', source: 'widget', primary_table_id: 'T1', package_id: null,
      customer: { name: 'Sam Jones', phone: '+447700900001' },
    }],
    booking_manage_tokens: [{ booking_id: 'bk-1', location_id: LOC, token: TOKEN }],
    booking_rules: [{ location_id: LOC, cancellation_window_hours: 2 }],
    locations: [{ id: LOC, address: '9 New Street', receipt_branding: { header: { phone: '01484 000000' } } }],
    booking_payments: [], booking_tables: [{ booking_id: 'bk-1', table_id: 'T1' }],
    booking_requests: [], booking_preorders: [], packages: [], activity_events: [], active_sessions: [],
  };
  const db = fakeDb(tables, rpc);
  const venue = {
    loc: { id: LOC, name: 'Provo', timezone: TZ, currency: 'GBP' },
    rules: {
      pacingCap: 30, serviceStart: '12:00', serviceEnd: '23:00', slotMinutes: 30, maxDaysAhead: 90, joinGroups: [],
      turnBands: { '1-2': 90, '3-4': 105, '5-6': 120, '7+': 150 }, noOnlineTables: [], blockedDates: [],
      servicePeriods: PERIODS, closedWeekdays: [1], dateBlocks: [], minNoticeMinutes: 0, ...rules,
    },
    tables: [{ id: 'T1', label: 'T1', covers: 4 }, { id: 'T2', label: 'T2', covers: 4 }],
    packages: [],
  };
  const nowMin = () => {
    const [h, m] = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date()).split(':').map(Number);
    return (h % 24) * 60 + m;
  };
  const deps = {
    db, json: (b, s = 200) => ({ status: s, body: b }), loadVenue: async () => venue, loadDayBookings: async () => [],
    venueToday: () => today(), venueNowMin: nowMin, epochToVenueMin: () => () => 0,
  };
  return { db, deps };
}

test('guest page: the times follow the service periods (lunch and dinner, last seating), not the old single window', async () => {
  const { deps } = setup();
  const r = (await handleManage('manage_slots', { token: TOKEN, date: TUESDAY, party: 2 }, deps)).body;
  assert.equal(r.ok, true);
  const times = r.slots.map((s) => s.time);
  assert.ok(times.includes('12:00') && times.includes('14:30') && times.includes('21:00'), times.join(' '));
  assert.ok(!times.includes('15:30') && !times.includes('16:00') && !times.includes('21:30') && !times.includes('22:30'), times.join(' '));
  assert.ok(r.slots.find((s) => s.time === '19:00').current, 'the booking own time is marked current');
});

test('guest page: a closed day says so in words and offers no times', async () => {
  const { deps } = setup();
  const r = (await handleManage('manage_slots', { token: TOKEN, date: MONDAY, party: 2 }, deps)).body;
  assert.equal(r.ok, true);
  assert.deepEqual(r.slots, []);
  assert.equal(r.message, 'The venue is closed on Mondays. Pick another day.');
});

test('guest page: a change to a time outside service is refused in words before edit_booking is called', async () => {
  const { deps, db } = setup();
  const r = (await handleManage('manage_change', { token: TOKEN, date: TUESDAY, time: '16:00', party: 2 }, deps)).body;
  assert.equal(r.ok, false);
  assert.equal(r.error, 'outside_service');
  assert.match(r.message, /16:00 is outside service hours\. Open 12:00 to 15:00 \(last seating 14:30\) and 17:00 to 22:00 \(last seating 21:00\)/);
  assert.equal(db.calls.filter((c) => c.rpc === 'edit_booking').length, 0);
});

test('guest page: edit_booking refusals from 20261016e are said in words, a block never shows its private reason', async () => {
  for (const [code, message, expect] of [
    ['too_soon', 'Online bookings need 2 hours notice. Pick a later time, or call the venue.', /2 hours notice/],
    ['closed_day', 'The venue is closed on Tuesdays. Pick another day.', /closed on Tuesdays/],
    ['outside_service', '20:00 is outside service hours. Pick another time.', /outside service hours/],
    ['blocked', '18:00 to 21:00 on Tue is blocked (Smith wedding). Pick another time.', /isn't taking online bookings then/],
  ]) {
    const { deps } = setup({ rpc: async () => ({ data: { ok: false, error: code, message }, error: null }) });
    const r = (await handleManage('manage_change', { token: TOKEN, date: TUESDAY, time: '20:00', party: 2 }, deps)).body;
    assert.equal(r.ok, false, code);
    assert.equal(r.error, code);
    assert.match(r.message, expect, code);
    assert.doesNotMatch(r.message, /Smith wedding/);
  }
});

// ── one money rule ───────────────────────────────────────────────────────────────────────────

const PAY = 'a1b2c3d4-0000-4000-8000-000000000001';
test('money rule: a refund still on its way is never money on the booking (guest cancel cannot flag it again)', () => {
  const rows = [
    { id: PAY, kind: 'prepay', status: 'captured', amount: 60, currency: 'gbp', applied_to_check: false },
    { id: 'r1', kind: 'refund', status: 'pending', amount: 20, merchant_reference: `bkrf-${PAY}-1` },
  ];
  assert.equal(refundedMinorFor(rows[0], rows), 2000);
  assert.equal(paymentNetMinor(rows[0], rows), 4000);
  assert.equal(paymentNetMinor(rows[0]), 6000, 'without the rows only the column counts, as the database helper does');
  assert.equal(moneyOnBooking(rows).capturedMinor, 4000);
  assert.equal(creditMinorOf(rows[0], rows), 4000);
  // after 20261016d the column says it on its own
  assert.equal(paymentNetMinor({ ...rows[0], amount_refunded_minor: 2500 }), 3500);
  const owed = [{ id: PAY, kind: 'prepay', status: 'needs_refund', amount: 60, amount_refunded_minor: 6000 }];
  assert.equal(owedBackOnBooking(owed).owedBackMinor, 0);
  assert.equal(owedBackMinor(owed[0]), 0);
});

test('refunds: a no show charge is refunded from its own check, never from the Refund panel', () => {
  assert.deepEqual(REFUNDABLE_KINDS, ['prepay', 'deposit']);
  const r = refundCheck({ parent: { id: PAY, kind: 'no_show_charge', status: 'captured', amount: 40 }, rows: [], amountMinor: 4000 });
  assert.equal(r.ok, false);
  assert.match(r.error, /own check.*History on the till/);
});

test('reports: a refund is counted once, on the payment it gives back, and a hold reads hold_minor', () => {
  const payments = [
    { id: PAY, booking_id: 'b1', kind: 'prepay', status: 'refunded', amount: 60, currency: 'gbp', created_at: '2026-10-16T10:00:00Z' },
    { id: 'r1', booking_id: 'b1', kind: 'refund', status: 'refunded', amount: 60, currency: 'gbp', refund_of: PAY, created_at: '2026-10-16T11:00:00Z' },
    { id: 'p2', booking_id: 'b2', kind: 'deposit', status: 'captured', amount: 50, currency: 'gbp', amount_refunded_minor: 1000, created_at: '2026-10-16T10:00:00Z' },
    { id: 'h1', booking_id: 'b3', kind: 'hold', status: 'authorised', amount: 0, hold_minor: 4000, currency: 'gbp', created_at: '2026-10-16T10:00:00Z' },
  ];
  const lines = paymentLines({ payments });
  const t = paymentTotals(lines).GBP;
  assert.equal(t.refunded, 6000 + 1000);
  assert.equal(lines.find((l) => l.id === 'h1').holdMinor, 4000);
  assert.equal(lines.find((l) => l.id === 'h1').amountMinor, 0);
  assert.equal(moneyByBooking(payments).b2.GBP.deposit, 4000, 'money from bookings is net of a part refund');
});

test('no show fee: a hold row stored at 0 (20261016d) charges the figure in hold_minor', () => {
  const fee = noShowFee({ booking: { covers: 2 }, holdRow: { kind: 'hold', amount: 0, hold_minor: 4000 }, rules: { hold_per_cover: 5 } });
  assert.equal(fee.amountMinor, 4000);
  assert.equal(fee.source, 'hold');
  assert.equal(noShowFee({ booking: { covers: 2 }, holdRow: { kind: 'hold', amount: 30 } }).amountMinor, 3000);
});

// ── the migrations, read as text ────────────────────────────────────────────────────────────

const C = migration('20261016c_OPS_booking_guest_manage.sql');
const D = migration('20261016d_OPS_booking_host_tools.sql');
const E = migration('20261016e_OPS_booking_service_periods.sql');
const F = migration('20261016f_OPS_booking_noshow_reports.sql');
const WRITTEN_EDIT_SIG = /function public\.edit_booking\(text,/i;

test('migrations: c and e patch edit_booking in place and grant it by its own id (live has 11 arguments)', () => {
  for (const [name, sql] of [['c', C], ['e', E]]) {
    assert.doesNotMatch(sql, WRITTEN_EDIT_SIG, `${name} names edit_booking by a written argument list`);
    assert.doesNotMatch(sql, /create or replace function public\.edit_booking/i, `${name} replaces edit_booking wholesale (it would undo the other file)`);
    assert.match(sql, /p\.oid::regprocedure/, `${name} grants by the function id`);
  }
  assert.doesNotMatch(E, /pg_get_function_identity_arguments\(p\.oid\) =/, 'e must find edit_booking by name, not by an argument list');
  assert.match(E, /edit_keeps_stamp_check/);
  assert.match(C, /service_role/);
  assert.match(E, /_booking_time_refusal/);
});

test('migrations: d and f never touch edit_booking or create_booking; only e replaces create_booking', () => {
  for (const sql of [C, D, F]) assert.doesNotMatch(sql, /function public\.create_booking/i);
  for (const sql of [D, F]) assert.doesNotMatch(sql, /edit_booking/i);
  assert.match(E, /create or replace function public\.create_booking/i);
  assert.match(E, /unknown_table/, 'e keeps the floor plan check 20261016b added to create_booking');
});

test('migrations: the give back words use character codes for the pound and euro signs', () => {
  assert.match(D, /when 'GBP' then chr\(163\)/);
  assert.match(D, /when 'EUR' then chr\(8364\)/);
  assert.match(D, /apply_pound_sign_ok/);
});
