// bookingsReleaseFixes.test.js: the 5.11.69 release review fixes (16 Oct 2026).
// dayRefreshAction is pure and tested directly. The slice, the data layer, the till's Tables
// screen and the migration have no node harness here, so their shape is pinned by source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dayRefreshAction } from './bookingsCatchUp.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const SLICE = read('../../store/bookingsSlice.js');
const DATA = read('./bookingsData.js');
const TABLES = read('../../surfaces/TablesSurface.jsx');
const MIG = read('../../../supabase/migrations/20261016b_OPS_bookings_core.sql');
const between = (src, a, b) => { const i = src.indexOf(a); const j = src.indexOf(b, i + 1); assert.ok(i >= 0 && j > i, a); return src.slice(i, j); };

test('a day reload that started before a change is never applied over it', () => {
  const rows = [{ id: 'b1', status: 'confirmed' }];
  const before = [{ id: 'b1', status: 'confirmed' }];
  const after = [{ id: 'b1', status: 'dining' }];
  assert.equal(dayRefreshAction({ data: rows, dateAtStart: 'd', dateNow: 'd', before, after: before }), 'apply');
  assert.equal(dayRefreshAction({ data: rows, dateAtStart: 'd', dateNow: 'd', before, after }), 'retry');
  assert.equal(dayRefreshAction({ data: rows, dateAtStart: 'd', dateNow: 'd', before, after, retried: true }), 'skip');
  assert.equal(dayRefreshAction({ data: rows, dateAtStart: 'd', dateNow: 'e', before, after: before }), 'skip');
  assert.equal(dayRefreshAction({ data: rows, error: 'tables read failed', dateAtStart: 'd', dateNow: 'd', before, after: before }), 'skip');
  assert.equal(dayRefreshAction({ data: null, dateAtStart: 'd', dateNow: 'd', before, after: before }), 'skip');
});

test('refreshBookingsDay snapshots the day before the read and retries once', () => {
  const fn = between(SLICE, 'refreshBookingsDay: async (', 'suggestBookingTables:');
  assert.ok(fn.indexOf('const before = get().bookings;') < fn.indexOf('await loadBookings('));
  assert.match(fn, /dayRefreshAction\(/);
  assert.match(fn, /refreshBookingsDay\?\.\('retry', \{ retried: true \}\)/);
});

test('a failed booking_tables read comes back as an error, not as a good read', () => {
  const fn = between(DATA, 'export async function loadBookings(', 'export async function');
  assert.match(fn, /tablesError = btErr\.message \|\| 'tables read failed';/);
  assert.match(fn, /\.\.\.\(tablesError \? \{ error: tablesError, partial: true \} : \{\}\)/);
  const edit = between(SLICE, 'editBooking: async (', 'seatBooking: async (');
  assert.match(edit, /if \(!error && Array\.isArray\(data\)\) others = data;/);
});

test('editBooking always re reads the tables, sends tables only when named, and sends the stamp', () => {
  const edit = between(SLICE, 'editBooking: async (', 'seatBooking: async (');
  assert.match(edit, /const ids = await loadBookingTables\(id\);\n\s+if \(ids && ids\.length\) entry = \{ \.\.\.entry, primaryTableId: primary, tables: mergeBookingTables\(primary, ids\) \};/);
  assert.doesNotMatch(edit, /if \(fresh\.primaryTableId && fresh\.primaryTableId !== cached\.primaryTableId\) \{\n\s+const ids/);
  assert.match(edit, /tables: tablesNamed \? next\.tables : null/);
  assert.match(edit, /expectedEditedAt: expectedEditedAt === undefined \? null : \(expectedEditedAt \|\| ''\)/);
  assert.match(edit, /if \(atomic\.error === 'stale'\) return refuse\(staleWords\(atomic\.editedAt, atomic\.editedBy\), \{ stale: true \}\);/);
  const rpc = between(DATA, 'export async function editBookingAtomic(', 'export async function');
  assert.match(rpc, /p_table_ids: next\.tables \?\? null,/);
  assert.match(rpc, /p_expected_edited_at: next\.expectedEditedAt \?\? null,/);
});

test('seatBooking settles the booking money read before the open tab check', () => {
  const seat = between(SLICE, 'seatBooking: async (id) => {', 'markBookingNoShow: async (id');
  const started = seat.indexOf('const creditP = isTrainingMode()');
  const settled = seat.indexOf('const creditRead = await creditP;');
  const local = seat.indexOf('const local = get().tables || [];');
  const seatCall = seat.indexOf('seatTableWithItems');
  assert.ok(started > 0 && started < seat.indexOf('readServerSessions('), 'started before the sessions read');
  assert.ok(settled > 0 && settled < local, 'settled before the till copy is read');
  assert.ok(!/await loadBookingCredit\(/.test(seat.slice(local, seatCall)), 'no credit read between the check and the seat');
});

test('the till: Edit reservation sends its stamp, the card shows Total, the join outline uses the venue clock', () => {
  assert.match(TABLES, /expectedEditedAt: editBooking\.customer\?\.edited_at \|\| null/);
  assert.match(TABLES, /<span style=\{\{ color:'var\(--t2\)' \}\}>Total<\/span>\n\s+<span style=\{\{ fontFamily:'DM Mono,monospace' \}\}>\{money\(billTotal\)\}<\/span>/);
  const outline = between(TABLES, 'dashed amber join outline', 'key={`join-${b.id}`}');
  assert.doesNotMatch(outline, /getHours\(\)|toLocaleDateString/);
  assert.match(outline, /buildScheduleCtx\(useStore\.getState\(\)\.locationConfig\?\.timezone\)/);
});

test('migration: the PAX list shows the balance, edit_booking re checks the stamp and keeps tables when none are sent', () => {
  const list = between(MIG, 'create or replace function public.terminal_open_tables()', 'end; $function$;');
  assert.match(list, /\(a\.total_minor - bc\.credit_minor\)::bigint/);
  assert.match(list, /and a\.total_minor - bc\.credit_minor > 0/);
  assert.match(list, /_booking_credit_for_session\(a\.location_id, a\.session, a\.total_minor::bigint\)/);
  assert.match(MIG, /grant execute on function public\.terminal_open_tables\(\) to anon, authenticated, service_role;/);
  const edit = between(MIG, 'create or replace function public.edit_booking(', 'end $function$;');
  assert.match(edit, /p_expected_edited_at text default null\)/);
  assert.match(edit, /coalesce\(v_bk\.customer ->> 'edited_at', ''\) is distinct from p_expected_edited_at/);
  assert.ok(edit.indexOf("'error', 'stale'") > edit.indexOf('for update'), 'the stamp is checked under the row lock');
  assert.match(edit, /if p_table_ids is null then\n\s+select array_agg\(bt\.table_id/);
  assert.match(MIG, /as open_tables_has_credit/);
  assert.match(MIG, /as edit_has_stamp_check/);
  assert.match(MIG, /drop function if exists public\.edit_booking\(text, uuid, date, time without time zone, integer, integer, text\[\], text, text, jsonb\);/);
});
