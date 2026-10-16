/**
 * guestManage.test.js: the guest's own change and cancel link, driven end to end through
 * supabase/functions/booking-widget/manage.ts with a small fake PostgREST client (16 Oct 2026).
 * Node strips the TypeScript types, so the Deno file is imported directly; Deno.env and fetch
 * are stubbed.
 */

import { test, before } from 'node:test';
import assert from 'node:assert/strict';

let handleManage;
const fetched = [];
before(async () => {
  globalThis.Deno = globalThis.Deno || { env: { get: () => '' } };
  globalThis.fetch = async (url, init) => {
    fetched.push({ url: String(url), body: JSON.parse(init?.body || '{}') });
    return { ok: true, json: async () => ({ ok: true, results: { sms: { sent: true }, email: { sent: false } } }) };
  };
  ({ handleManage } = await import('../../../supabase/functions/booking-widget/manage.ts'));
});

function fakeDb({ tables = {}, rpc = null } = {}) {
  const calls = [];
  const db = {
    calls,
    tables,
    rpc: async (name, args) => {
      calls.push({ rpc: name, args });
      return rpc ? rpc(name, args, tables) : { data: null, error: { code: 'PGRST202', message: 'Could not find the function' } };
    },
    from(table) {
      const st = { table, op: 'select', filters: [], patch: null, rows: null, single: false, limitN: null };
      const run = () => {
        calls.push({ table, op: st.op, patch: st.patch, rows: st.rows });
        const list = tables[table] || (tables[table] = []);
        if (st.op === 'insert') {
          list.push(...st.rows.map((r) => ({ ...r })));
          return { data: st.rows.map((r) => ({ ...r })), error: null };
        }
        let hits = list.filter((row) => st.filters.every((f) => f(row)));
        if (st.op === 'update') hits.forEach((row) => Object.assign(row, st.patch));
        if (st.op === 'delete') { tables[table] = list.filter((row) => !hits.includes(row)); return { data: null, error: null }; }
        if (st.limitN != null) hits = hits.slice(0, st.limitN);
        if (st.single) return { data: hits[0] ? { ...hits[0] } : null, error: null };
        return { data: hits.map((r) => ({ ...r })), error: null };
      };
      const b = {
        select() { return b; },
        update(p) { st.op = 'update'; st.patch = p; return b; },
        insert(r) { st.op = 'insert'; st.rows = Array.isArray(r) ? r : [r]; return b; },
        delete() { st.op = 'delete'; return b; },
        gt(c, v) { st.filters.push((row) => Number(row[c]) > Number(v)); return b; },
        lt(c, v) { st.filters.push((row) => String(row[c]) < String(v)); return b; },
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
const TOKEN = 'a'.repeat(64);
const TZ = 'Europe/London';
const dayISO = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const json = (b, s = 200) => ({ status: s, body: b });
const venueToday = (tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const venueNowMin = (tz) => {
  const [h, m] = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date()).split(':').map(Number);
  return (h % 24) * 60 + m;
};

const PKG = { id: 'pk1', name: 'Tasting menu', payment_model: 'prepay', price: 60, price_unit: 'per_cover', min_covers: 1, max_covers: 8 };
function setup({ booking = {}, payments = [], rules = {}, rpc = null, pkg = null, requests = [] } = {}) {
  const bk = {
    id: 'bk-1', location_id: LOC, booking_date: dayISO(5), start_time: '19:00:00', turn_minutes: 105, covers: 2,
    status: 'confirmed', source: 'widget', primary_table_id: 'T1', package_id: pkg ? pkg.id : null,
    customer: { name: 'Sam Jones', phone: '+447700900001' }, ...booking,
  };
  const db = fakeDb({
    tables: {
      bookings: [bk],
      booking_manage_tokens: [{ booking_id: 'bk-1', location_id: LOC, token: TOKEN }],
      booking_requests: requests.map((payload) => ({ booking_id: 'bk-1', payload })),
      booking_rules: [{ location_id: LOC, cancellation_window_hours: 24, ...rules }],
      locations: [{ id: LOC, address: '9 New Street, Huddersfield', receipt_branding: { header: { phone: '01484 000000' } } }],
      booking_payments: payments.map((p) => ({ booking_id: 'bk-1', location_id: LOC, ...p })),
      booking_tables: [{ booking_id: 'bk-1', table_id: 'T1' }],
      booking_preorders: [{ booking_id: 'bk-1', seat: 1, display_name: 'Soup' }, { booking_id: 'bk-1', seat: 2, display_name: 'Salad' }],
      packages: pkg ? [pkg] : [],
      activity_events: [],
      active_sessions: [],
    },
    rpc,
  });
  const venue = {
    loc: { id: LOC, name: 'Provo', timezone: TZ, currency: 'GBP' },
    rules: { pacingCap: 30, serviceStart: '12:00', serviceEnd: '23:00', slotMinutes: 15, maxDaysAhead: 90, joinGroups: [], turnBands: { '1-2': 90, '3-4': 105, '5-6': 120, '7+': 150 }, maxJoin: 2, tolerance: 4, noOnlineTables: [], blockedDates: [] },
    tables: [{ id: 'T1', label: 'T1', covers: 4 }, { id: 'T2', label: 'T2', covers: 4 }, { id: 'T3', label: 'T3', covers: 8 }],
    packages: pkg ? [pkg] : [],
  };
  const deps = {
    db, json, loadVenue: async () => venue,
    loadDayBookings: async () => [],
    venueToday, venueNowMin, epochToVenueMin: () => () => 0,
  };
  return { db, deps, bk };
}

test('info: a live booking can be changed or cancelled, with the venue phone and a calendar link', async () => {
  const { deps } = setup();
  const r = (await handleManage('manage_info', { token: TOKEN }, deps)).body;
  assert.equal(r.ok, true);
  assert.equal(r.canCancel, true);
  assert.equal(r.canChange, true);
  assert.equal(r.phone, '01484 000000');
  assert.equal(r.address, '9 New Street, Huddersfield');
  assert.equal(r.guestName, 'Sam');
  assert.match(r.calendar.google, /^https:\/\/calendar\.google\.com\//);
  assert.match(r.calendar.ics, /BEGIN:VEVENT/);
});

test('an unknown or malformed link says so in words', async () => {
  const { deps } = setup();
  assert.equal((await handleManage('manage_info', { token: 'b'.repeat(64) }, deps)).body.error, 'unknown_link');
  assert.equal((await handleManage('manage_info', { token: 'nope' }, deps)).body.error, 'unknown_link');
});

test('cancel in time: cancelled, the paid money flagged owed back with an alert, the guest told', async () => {
  fetched.length = 0;
  const { db, deps } = setup({ payments: [{ id: 'p1', kind: 'prepay', status: 'captured', amount: 120, currency: 'gbp', applied_to_check: false }], pkg: PKG });
  const r = (await handleManage('manage_cancel', { token: TOKEN }, deps)).body;
  assert.equal(r.ok, true);
  assert.equal(r.view, 'cancelled');
  assert.equal(db.tables.bookings[0].status, 'cancelled');
  assert.equal(db.tables.bookings[0].cancel_reason, 'Guest cancelled online');
  assert.equal(db.tables.booking_payments[0].status, 'needs_refund');
  const titles = db.tables.activity_events.map((e) => e.title);
  assert.ok(titles.includes('Online booking payment needs a refund'));
  assert.ok(titles.includes('Guest cancelled online'));
  assert.equal(fetched.at(-1).body.action, 'notify');
  assert.equal(fetched.at(-1).body.kind, 'cancelled');
  assert.deepEqual(r.told, { sms: true, email: false });
  assert.equal(r.paidLine, '£120 paid, to be refunded by the venue');
  const again = (await handleManage('manage_info', { token: TOKEN }, deps)).body;
  assert.equal(again.paidLine, '£120 paid, to be refunded by the venue');
  assert.equal(again.view, 'cancelled');
});

test('inside the cancellation window: refused, with the phone number', async () => {
  const { db, deps } = setup({ booking: { booking_date: dayISO(1), start_time: '19:00:00' }, rules: { cancellation_window_hours: 48 } });
  const r = (await handleManage('manage_cancel', { token: TOKEN }, deps)).body;
  assert.equal(r.ok, false);
  assert.match(r.message, /Online changes close 48 hours before your booking/);
  assert.match(r.message, /01484 000000/);
  assert.equal(db.tables.bookings[0].status, 'confirmed');
});

test('more guests on a paid menu: refused (no online top up yet), nothing written', async () => {
  const { db, deps } = setup({ pkg: PKG, payments: [{ id: 'p1', kind: 'prepay', status: 'captured', amount: 120, currency: 'gbp' }] });
  const r = (await handleManage('manage_change', { token: TOKEN, date: dayISO(5), time: '19:00', party: 3 }, deps)).body;
  assert.equal(r.ok, false);
  assert.equal(r.error, 'needs_top_up');
  assert.match(r.message, /£60 more/);
  assert.equal(db.calls.filter((c) => c.rpc).length, 0);
});

test('fewer guests on a paid menu: changed through edit_booking, the difference stored as owed back', async () => {
  fetched.length = 0;
  const rpc = (name, args, tables) => {
    assert.equal(name, 'edit_booking');
    Object.assign(tables.bookings[0], { covers: args.p_covers, booking_date: args.p_booking_date, start_time: args.p_start_time, customer: args.p_customer });
    return { data: { ok: true, id: args.p_id }, error: null };
  };
  const { db, deps } = setup({ pkg: PKG, rpc, payments: [{ id: 'p1', kind: 'prepay', status: 'captured', amount: 120, currency: 'gbp' }] });
  const r = (await handleManage('manage_change', { token: TOKEN, date: dayISO(5), time: '19:00', party: 1 }, deps)).body;
  assert.equal(r.ok, true);
  assert.equal(r.changed, true);
  const call = db.calls.find((c) => c.rpc === 'edit_booking');
  assert.equal(call.args.p_covers, 1);
  assert.deepEqual(call.args.p_table_ids, ['T1']);   // its own table still fits and is free
  assert.equal(call.args.p_customer.edited_by, 'Guest online');
  assert.equal(db.tables.booking_payments[0].refund_due_minor, 6000);
  assert.deepEqual(db.tables.booking_preorders.map((p) => p.seat), [1], 'the seat that is not coming loses its pre-order');
  assert.match(r.moneyNote, /£60 of what you paid will be refunded/);
  assert.ok(db.tables.activity_events.some((e) => e.title === 'Guest changed their booking online'));
  assert.equal(fetched.at(-1).body.kind, 'changed');
});

test('a time change takes the next table when the first was just taken', async () => {
  let n = 0;
  const rpc = (name, args) => {
    n += 1;
    return n === 1 ? { data: { ok: false, error: 'table_taken' }, error: null } : { data: { ok: true, id: args.p_id }, error: null };
  };
  const { db, deps } = setup({ rpc });
  const r = (await handleManage('manage_change', { token: TOKEN, date: dayISO(6), time: '20:00', party: 2 }, deps)).body;
  assert.equal(r.ok, true);
  assert.equal(db.calls.filter((c) => c.rpc === 'edit_booking').length, 2);
});

test('before migration 20261016c the guest is told to call, never shown an error', async () => {
  const rpc = () => ({ data: { ok: false, error: 'no access' }, error: null });
  const { deps } = setup({ rpc });
  const r = (await handleManage('manage_change', { token: TOKEN, date: dayISO(6), time: '20:00', party: 2 }, deps)).body;
  assert.equal(r.error, 'not_ready');
  assert.match(r.message, /call the venue/);
});

test('slots: the booking\'s own time is marked current, past and full times say why', async () => {
  const { deps } = setup();
  const r = (await handleManage('manage_slots', { token: TOKEN, date: dayISO(5), party: 2 }, deps)).body;
  assert.equal(r.ok, true);
  const cur = r.slots.find((s) => s.current);
  assert.equal(cur.time, '19:00');
  assert.equal(cur.full, false);
  const tooBig = (await handleManage('manage_slots', { token: TOKEN, date: dayISO(5), party: 40 }, deps)).body;
  assert.deepEqual(tooBig.slots, []);
  assert.match(tooBig.message, /please call the venue on 01484 000000/);
});

test('a cancelled booking shows as cancelled with nothing to press', async () => {
  const { deps } = setup({ booking: { status: 'cancelled' } });
  const r = (await handleManage('manage_info', { token: TOKEN }, deps)).body;
  assert.equal(r.view, 'cancelled');
  assert.equal(r.canCancel, false);
  assert.equal(r.canChange, false);
});

// ── review fixes (16 Oct 2026) ───────────────────────────────────────────────

// edit_booking as the fake: writes what it is given, like the real one.
const writeRpc = (name, args, tables) => {
  Object.assign(tables.bookings[0], { covers: args.p_covers, booking_date: args.p_booking_date, start_time: args.p_start_time, customer: args.p_customer });
  return { data: { ok: true, id: args.p_id }, error: null };
};

test('the code is looked up in booking_manage_tokens, never on bookings; before the migration the page says to call', async () => {
  const { db, deps } = setup();
  const r = (await handleManage('manage_info', { token: TOKEN }, deps)).body;
  assert.equal(r.ok, true);
  const missing = setup();
  missing.db.from = ((orig) => (t) => (t === 'booking_manage_tokens'
    ? { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { code: 'PGRST205', message: "Could not find the table 'public.booking_manage_tokens' in the schema cache" } }) }) }) }
    : orig(t)))(missing.db.from.bind(missing.db));
  const r2 = (await handleManage('manage_info', { token: TOKEN }, missing.deps)).body;
  assert.equal(r2.error, 'not_ready');
  assert.ok(!db.calls.some((c) => c.table === 'bookings' && c.op === 'select' && JSON.stringify(c).includes('manage_token')));
});

test('a guest cancel whose refund flag was lost is flagged on the next visit', async () => {
  const { db, deps } = setup({
    booking: { status: 'cancelled', cancel_reason: 'Guest cancelled online' },
    payments: [{ id: 'p1', kind: 'prepay', status: 'captured', amount: 120, currency: 'gbp', applied_to_check: false }],
  });
  const r = (await handleManage('manage_info', { token: TOKEN }, deps)).body;
  assert.equal(db.tables.booking_payments[0].status, 'needs_refund');
  assert.ok(db.tables.activity_events.some((e) => e.title === 'Online booking payment needs a refund'));
  assert.equal(r.paidLine, '£120 paid, to be refunded by the venue');
  // A cancel the team made is never touched.
  const team = setup({ booking: { status: 'cancelled', cancel_reason: 'Duplicate' }, payments: [{ id: 'p1', kind: 'prepay', status: 'captured', amount: 120, currency: 'gbp' }] });
  await handleManage('manage_info', { token: TOKEN }, team.deps);
  assert.equal(team.db.tables.booking_payments[0].status, 'captured');
});

test('owed back is the whole figure now: 6 to 4 stores £40, then back to 6 clears it, 6 to 4 to 5 leaves £20', async () => {
  const PKG20 = { ...PKG, price: 20, max_covers: 8 };
  const pay = [{ id: 'p1', kind: 'prepay', status: 'captured', amount: 120, currency: 'gbp', created_at: '2026-10-01T10:00:00Z' }];
  const s1 = setup({ pkg: PKG20, rpc: writeRpc, payments: pay, booking: { covers: 6 }, requests: [{ party: 6 }] });
  s1.db.tables.booking_tables.push({ booking_id: 'bk-1', table_id: 'T3' });
  let r = (await handleManage('manage_change', { token: TOKEN, date: dayISO(5), time: '19:00', party: 4 }, s1.deps)).body;
  assert.equal(r.ok, true);
  assert.equal(s1.db.tables.booking_payments[0].refund_due_minor, 4000);
  r = (await handleManage('manage_change', { token: TOKEN, date: dayISO(5), time: '19:00', party: 6 }, s1.deps)).body;
  assert.equal(r.ok, true, r.message);
  assert.equal(s1.db.tables.booking_payments[0].refund_due_minor, null, 'back to the party that paid: nothing owed');
  await handleManage('manage_change', { token: TOKEN, date: dayISO(5), time: '19:00', party: 4 }, s1.deps);
  r = (await handleManage('manage_change', { token: TOKEN, date: dayISO(5), time: '19:00', party: 5 }, s1.deps)).body;
  assert.equal(r.ok, true, r.message);
  assert.equal(s1.db.tables.booking_payments[0].refund_due_minor, 2000);
  assert.match(r.moneyNote, /£20 of what you paid/);
});

test('owed back follows what the guest paid, not the price today', async () => {
  // 4 guests paid £80 at £20 each; the menu is now £15.
  const { db, deps } = setup({
    pkg: { ...PKG, price: 15 }, rpc: writeRpc, booking: { covers: 4 }, requests: [{ party: 4 }],
    payments: [{ id: 'p1', kind: 'prepay', status: 'captured', amount: 80, currency: 'gbp' }],
  });
  const r = (await handleManage('manage_change', { token: TOKEN, date: dayISO(5), time: '19:00', party: 3 }, deps)).body;
  assert.equal(r.ok, true, r.message);
  assert.equal(db.tables.booking_payments[0].refund_due_minor, 2000);
});

test('money already part refunded is not counted again (amount_refunded_minor)', async () => {
  const { db, deps } = setup({
    payments: [{ id: 'p1', kind: 'deposit', status: 'captured', amount: 80, amount_refunded_minor: 2000, currency: 'gbp', applied_to_check: false }],
  });
  const info = (await handleManage('manage_info', { token: TOKEN }, deps)).body;
  assert.equal(info.paidLine, '£60 paid');
  const r = (await handleManage('manage_cancel', { token: TOKEN }, deps)).body;
  assert.equal(r.paidLine, '£60 paid, to be refunded by the venue');
  assert.equal(db.tables.booking_payments[0].status, 'needs_refund');
});

test('a host edit to the guest details made during the change is kept (stale, read again, tried once more)', async () => {
  let n = 0;
  const rpc = (name, args, tables) => {
    n += 1;
    if (n === 1) {
      // The host saved an allergy a moment ago.
      tables.bookings[0].customer = { ...tables.bookings[0].customer, allergy: 'nuts', edited_at: '2026-10-16T10:00:00Z', edited_by: 'Jane' };
      return { data: { ok: false, error: 'stale' }, error: null };
    }
    assert.equal(args.p_expected_edited_at, '2026-10-16T10:00:00Z');
    return writeRpc(name, args, tables);
  };
  const { db, deps } = setup({ rpc });
  const r = (await handleManage('manage_change', { token: TOKEN, date: dayISO(6), time: '20:00', party: 2 }, deps)).body;
  assert.equal(r.ok, true, r.message);
  assert.equal(db.tables.bookings[0].customer.allergy, 'nuts');
  assert.equal(db.tables.bookings[0].customer.edited_by, 'Guest online');
});

test('an edit_booking without p_expected_edited_at (older 20261016b) is called without it', async () => {
  const seen = [];
  const rpc = (name, args, tables) => {
    seen.push('p_expected_edited_at' in args);
    if ('p_expected_edited_at' in args) return { data: null, error: { code: 'PGRST202', message: 'Could not find the function public.edit_booking' } };
    return writeRpc(name, args, tables);
  };
  const { deps } = setup({ rpc });
  const r = (await handleManage('manage_change', { token: TOKEN, date: dayISO(6), time: '20:00', party: 2 }, deps)).body;
  assert.equal(r.ok, true, r.message);
  assert.deepEqual(seen, [true, false]);
});
