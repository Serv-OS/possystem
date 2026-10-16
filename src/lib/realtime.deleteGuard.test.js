/**
 * realtime.deleteGuard.test.js — the active_sessions DELETE handler asks the server (16 Oct 2026).
 *
 * Provo demo venue, Peter filming the bookings demo: the till cashed off T1 (its active_sessions
 * row was deleted) and the bookings host stand kept its local copy, so "Seat now, open POS tab"
 * refused with "Still has an open tab" while the till showed nothing open. The handler's old
 * Guard 2 kept the local session whenever the deleted payload carried no seatedAt (the replica
 * identity holds no session jsonb) and the copy had items, and re-published it.
 *
 * realtime.js subscribes to a live Supabase client, so the handler's shape is pinned by source:
 * the server read is there, the item heuristic is gone, Guard 1 (the table a till is editing)
 * stays, and the handler re-checks the store after the read.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('./realtime.js', import.meta.url), 'utf8');

// The DELETE handler of the sessions channel: from its event line to the channel's subscribe.
const start = SRC.indexOf("event: 'DELETE',\n      schema: 'public',\n      table: 'active_sessions'");
assert.ok(start > 0, 'active_sessions DELETE handler present');
const end = SRC.indexOf('.subscribe();', start);
const HANDLER = SRC.slice(start, end);

test('the handler is async and reads this table\'s row from the server once', () => {
  assert.ok(HANDLER.includes('async ({ old: row })'), 'handler is async');
  assert.ok(HANDLER.includes(".from('active_sessions')"), 'reads active_sessions');
  assert.ok(HANDLER.includes(".select('table_id, session')"));
  assert.ok(HANDLER.includes(".eq('location_id', locationId)"));
  assert.ok(HANDLER.includes(".eq('table_id', tid)"));
  assert.ok(HANDLER.includes('.maybeSingle()'));
  assert.equal(HANDLER.split(".from('active_sessions')").length - 1, 1, 'exactly one read');
});

test('no items heuristic and no deleted seatedAt comparison are left', () => {
  assert.ok(!HANDLER.includes('items?.length > 0'), 'the items fallback is gone');
  assert.ok(!HANDLER.includes('deletedSeated'), 'the deleted payload seatedAt comparison is gone');
  assert.ok(!HANDLER.includes('row?.session?.seatedAt'), 'the deleted payload session is not consulted');
});

test('Guard 1 is kept for a till and does not hold on a host stand', () => {
  assert.ok(HANDLER.includes('tid === state.activeTableId && !isHostStandMode()'), 'Guard 1 before the read, till only');
  assert.ok(HANDLER.includes('if (localTable?.session) reassertSession(tid);'), 'a till re-publishes the table it is editing');
  assert.ok(SRC.includes('isHostStandMode } from \'./supabase\'') || SRC.includes('isHostStandMode }'), 'isHostStandMode imported');
});

test('after the read the store is checked again, a row keeps the local copy, no row clears it everywhere', () => {
  const read = HANDLER.indexOf('.maybeSingle()');
  const after = HANDLER.slice(read);
  assert.ok(after.includes('const after = store.getState();'), 're-reads the store after the await');
  assert.ok(after.includes('tid === after.activeTableId && !isHostStandMode()'), 're-checks activeTableId');
  assert.ok(after.includes('if (serverRow?.session) {'), 'a server row keeps the local session');
  assert.ok(after.includes("(localNow.session.seatedAt || 0) > (serverRow.session.seatedAt || 0)) reassertSession(tid)"),
    'a till re-asserts only when its copy is newer by seatedAt');
  assert.ok(after.includes("{ ...t, session: null, status: 'available' }"), 'no row: cleared');
  assert.ok(!after.includes('isHostStandMode()) return;\n      store.setState'), 'the clear is not skipped on a host stand');
  // a failed read changes nothing
  assert.ok(HANDLER.includes('if (error) return;'));
});

test('a host stand never self-heals a row the server dropped (SessionReconciler)', () => {
  const REC = readFileSync(new URL('../sync/SessionReconciler.js', import.meta.url), 'utf8');
  assert.ok(REC.includes('if (healIds.length && !isHostStandMode()) {'), 'self-heal gated off host stands');
  assert.ok(REC.includes('isHostStandMode } from \'../lib/supabase\''));
});

test('both host stands run the 30 second server reconcile once paired', () => {
  const B = readFileSync(new URL('../surfaces/bookings/BookingsSurface.jsx', import.meta.url), 'utf8');
  const W = readFileSync(new URL('../surfaces/waitlist/WaitlistSurface.jsx', import.meta.url), 'utf8');
  for (const [name, src] of [['BookingsSurface', B], ['WaitlistSurface', W]]) {
    assert.ok(src.includes("import { startStandSessionSync } from '../../lib/bookings/standSessionSync.js';"), `${name} imports the sync`);
    assert.ok(src.includes('startStandSessionSync({ store: useStore, client: supabase, locationId: loc, isClosed: isSessionClosed, storage })'), `${name} starts it for the paired venue`);
  }
  assert.ok(B.includes('stopStandSync?.();'), 'bookings stand stops it with the effect');
  assert.ok(W.includes('stopStandSync();'), 'waitlist stand stops it with the effect');
});
