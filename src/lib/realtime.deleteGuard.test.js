/**
 * realtime.deleteGuard.test.js: the active_sessions DELETE handler (16 Oct 2026).
 *
 * Provo demo venue, Peter filming the bookings demo: the till cashed off T1 (its active_sessions
 * row was deleted) and the bookings host stand kept its local copy, so "Seat now, open POS tab"
 * refused with "Still has an open tab" while the till showed nothing open. The handler's old
 * Guard 2 kept the local session whenever the deleted payload carried no seatedAt (the replica
 * identity holds no session jsonb) and the copy had items, and re published it.
 *
 * Only the HOST STAND changes: it reads the table's row once and hands the decision to
 * decideOnDelete (behaviour tests in lib/bookings/standSessionSync.test.js). A till runs the
 * handler exactly as before. The live handlers are exercised in sync/standRealtime.test.js.
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
const STAND = SRC.slice(SRC.indexOf('const standDelete = async (tid) => {'), SRC.indexOf('const sessionsChannel = supabase'));

test('a host stand hands the delete to its own branch; a till never reaches it', () => {
  assert.ok(HANDLER.includes('if (isHostStandMode()) { standDelete(tid); return; }'));
  // the handler itself stays synchronous, as on main
  assert.ok(HANDLER.includes('}, ({ old: row }) => {'), 'not async');
});

test('the stand branch reads this table\'s row once and asks decideOnDelete', () => {
  assert.ok(STAND.length > 0, 'standDelete present');
  assert.ok(STAND.includes(".from('active_sessions')"));
  assert.ok(STAND.includes(".eq('table_id', tid)"));
  assert.ok(STAND.includes('.maybeSingle()'));
  assert.equal(STAND.split(".from('active_sessions')").length - 1, 1, 'exactly one read');
  assert.ok(SRC.includes("import { decideOnDelete } from './bookings/standSessionSync.js';"));
  assert.ok(STAND.includes('decideOnDelete({ localSession: localNow?.session || null, serverRow, readFailed, now: Date.now() })'));
  assert.ok(STAND.includes("if (decision !== 'clear') return;"));
  assert.ok(!STAND.includes('reassertSession'), 'a stand never re publishes');
});

test('the till branch is the handler as it was on main (Guard 1 and Guard 2)', () => {
  for (const line of [
    'if (tid === state.activeTableId) {',
    'if (localTable?.session) reassertSession(tid);',
    'const deletedSeated = row?.session?.seatedAt || 0;',
    'if (deletedSeated && localSeated > deletedSeated) { reassertSession(tid); return; }',
    'if (!deletedSeated && localTable.session.items?.length > 0) { reassertSession(tid); return; }',
  ]) assert.ok(HANDLER.includes(line), line);
});

test('INSERT and UPDATE: a till keeps its guards, a host stand takes the server row', () => {
  assert.ok(SRC.includes('if (!hostStand && row.table_id === state.activeTableId) return;'));
  assert.ok(SRC.includes('if (!hostStand && localUpdated > incomingUpdated) { reassertSession(row.table_id); return; }'));
  assert.ok(SRC.includes('if (!hostStand && existing?.session?.seatedAt && row.session?.seatedAt &&'));
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
