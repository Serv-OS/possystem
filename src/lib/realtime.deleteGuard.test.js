/**
 * realtime.deleteGuard.test.js — the active_sessions DELETE handler asks the server (16 Oct 2026).
 *
 * Provo demo venue, Peter filming the bookings demo: the till cashed off T1 (its active_sessions
 * row was deleted) and the bookings host stand kept its local copy, so "Seat now, open POS tab"
 * refused with "Still has an open tab" while the till showed nothing open. The handler's old
 * Guard 2 kept the local session whenever the deleted payload carried no seatedAt (the replica
 * identity holds no session jsonb) and the copy had items, and re-published it.
 *
 * realtime.js subscribes to a live Supabase client, so the handler itself is pinned thinly by
 * source: it reads this table's row once and hands the decision to decideOnDelete. Every case of
 * that decision is a behaviour test in lib/bookings/standSessionSync.test.js.
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

test('the handler reads this table\'s row from the server once', () => {
  assert.ok(HANDLER.includes('async ({ old: row })'), 'handler is async');
  assert.ok(HANDLER.includes(".from('active_sessions')"), 'reads active_sessions');
  assert.ok(HANDLER.includes(".eq('table_id', tid)"));
  assert.ok(HANDLER.includes('.maybeSingle()'));
  assert.equal(HANDLER.split(".from('active_sessions')").length - 1, 1, 'exactly one read');
});

test('the handler hands the decision to decideOnDelete and acts on its answer', () => {
  assert.ok(SRC.includes("import { decideOnDelete, sessionHeldElsewhere } from './bookings/standSessionSync.js';"), 'decideOnDelete imported');
  assert.ok(HANDLER.includes('decideOnDelete({'), 'the handler calls it');
  assert.ok(HANDLER.includes("if (decision === 'reassert') { reassertSession(tid); return; }"));
  assert.ok(HANDLER.includes("if (decision !== 'clear') return;"));
  // the old item heuristic and literal graces are gone
  assert.ok(!HANDLER.includes('items?.length > 0'));
  assert.ok(!HANDLER.includes('deletedSeated'));
  assert.ok(!/\b20000\b|20 \* 1000/.test(HANDLER), 'no literal grace in the handler');
});

test('a till re publishes only its own unsent write, never a moved session (16 Oct review)', () => {
  assert.ok(SRC.includes("import { reassertSession, hasUnsentSession } from '../sync/SessionSync';"));
  // asked before the read and after it: the read can overtake this till's own upsert
  assert.ok(HANDLER.includes('const unsentBefore = !hostStand && hasUnsentSession(tid);'));
  assert.ok(HANDLER.includes('ownUnflushed: !hostStand && (unsentBefore || hasUnsentSession(tid)),'));
  assert.ok(HANDLER.includes('movedElsewhere: sessionHeldElsewhere(after.tables, tid, localNow?.session),'));
  // the no read branch passes both too
  assert.ok(HANDLER.includes('ownUnflushed: !hostStand && hasUnsentSession(tid),'));
  assert.ok(HANDLER.includes('movedElsewhere: sessionHeldElsewhere(state.tables, tid, localTable?.session),'));
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
