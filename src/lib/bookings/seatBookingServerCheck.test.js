/**
 * seatBookingServerCheck.test.js — seatBooking asks the server before refusing (16 Oct 2026).
 *
 * The bookings host stand held a copy of T1's session after the till had cashed it off, and
 * "Seat now, open POS tab" refused with "Still has an open tab". The slice has no node harness
 * (it is spread into the live Zustand store), so its shape is pinned by source: the server is
 * re-read for the booking's tables before any refusal, a row with no lines is a different
 * refusal (table_seated_empty) that both screens put into words, and after a seat on a host
 * stand the floor's session comes from the server row.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SLICE = readFileSync(new URL('../../store/bookingsSlice.js', import.meta.url), 'utf8');
const seatStart = SLICE.indexOf('seatBooking: async (id) => {');
const seatEnd = SLICE.indexOf('markBookingNoShow: async (id) => {');
assert.ok(seatStart > 0 && seatEnd > seatStart);
const SEAT = SLICE.slice(seatStart, seatEnd);

test('the server is re-read for the booking\'s tables before any refusal', () => {
  assert.ok(SLICE.includes("import { readServerSessions, mergeServerSessions } from '../lib/bookings/standSessionSync.js';"));
  const read = SEAT.indexOf('readServerSessions(supabase, locId, bookingTables)');
  const refuse = SEAT.indexOf("error: 'table_open'");
  assert.ok(read > 0 && refuse > read, 'the read comes before the table_open refusal');
  assert.ok(SEAT.includes("mergeServerSessions(get().tables || [], rows, { tableIds: bookingTables, keepIds, isClosed: isSessionClosed })"),
    'the booking tables are refreshed in the store from the server rows');
  assert.ok(SEAT.includes('const keepIds = !isHostStandMode() && active ? new Set([active]) : null;'),
    'a till keeps the table it is editing; a host stand keeps nothing');
});

test('a row with lines refuses table_open, a row with none refuses table_seated_empty', () => {
  assert.ok(SEAT.includes("(t.session.items || []).some((i) => !i?.voided)"), 'lines are counted without voided ones');
  assert.ok(SEAT.includes("error: 'table_open'"));
  assert.ok(SEAT.includes("error: 'table_seated_empty'"));
  assert.ok(SEAT.includes('is seated with no order yet. Cash it off on the POS, or move this booking.'));
  assert.ok(SEAT.indexOf("error: 'table_open'") < SEAT.indexOf("error: 'table_seated_empty'"));
});

test('after the seat write a host stand takes the booking tables\' session from the server row', () => {
  const flush = SEAT.indexOf('await flushSingleSession(b.primaryTableId);');
  assert.ok(flush > 0, 'the single table flush is awaited');
  const after = SEAT.slice(flush);
  assert.ok(after.includes('if (isHostStandMode() && !isTrainingMode() && !isMock && supabase) {'), 'host stand only');
  assert.ok(after.includes("mergeServerSessions(get().tables || [], rows, { tableIds: bookingTables, clearMissing: false, isClosed: isSessionClosed })"),
    'a table with no row yet keeps its local copy');
});

test('the Diary and Floor screens put the new refusal into words', () => {
  const D = readFileSync(new URL('../../surfaces/bookings/DiaryScreen.jsx', import.meta.url), 'utf8');
  const F = readFileSync(new URL('../../surfaces/bookings/FloorScreen.jsx', import.meta.url), 'utf8');
  assert.ok(D.includes("res.error === 'table_seated_empty'"));
  assert.ok(D.includes("'Seated with no order yet. Cash it off on the POS or move the booking.'"));
  assert.ok(F.includes("seated.error === 'table_seated_empty'"));
  assert.ok(F.includes('is seated with no order yet, booking held on the diary'));
});
