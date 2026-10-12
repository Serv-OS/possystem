// 12 Oct 2026, Coffee Boy Barnsley: a bump took its card off at the tap, its write hung for up to
// 378 s with nothing on screen, and the 20 s list reload painted the ticket back ("recalling items
// without us touching anything"). These are the rules that stop it (K1, K2, K3): one unsaved change
// per ticket, the same body on every send, one send at a time, and a bump that hides its ticket
// until it is saved or has truly failed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WRITE_ATTEMPT_MS, FAST_FAIL_DELAYS_MS, GIVE_UP_MS, SAVING_SHOW_AFTER_MS, LATE_BUMP_MS, JOURNAL_MAX_AGE_MS, JOURNAL_VERSION, KINDS,
  emptyLane, bodyFor, labelFor, tap, retryFailedBump, dueSends, sendStarted, sendEnded,
  confirmBumpsFromList, confirmBumpFromLive, laneCounts, paintOne, paint, toJournal, fromJournal, newestUnsavedBump,
  guardFor, patchEntryRow, releaseRestarted, journalWithout, notBefore,
} from './kdsWriteLane.js';

const T0 = Date.UTC(2026, 9, 12, 14, 0, 0);
const row = (id, extra = {}) => ({ id, status: 'pending', held: false, centreId: 'pc-drinks', sentAt: T0 - 60000, bumpedAt: null, items: [], ...extra });
const bumped = (id, at = T0) => tap(emptyLane(), { id, kind: 'bump', row: row(id), centreId: 'pc-drinks', now: at });

test('the numbers the spec fixed', () => {
  assert.equal(WRITE_ATTEMPT_MS, 75000);
  assert.deepEqual([...FAST_FAIL_DELAYS_MS], [1000, 2000, 5000, 10000]);
  assert.equal(GIVE_UP_MS, 600000);
  assert.equal(SAVING_SHOW_AFTER_MS, 3000);
  assert.equal(LATE_BUMP_MS, 10000);
  assert.equal(JOURNAL_MAX_AGE_MS, 86400000);
  assert.equal(JOURNAL_VERSION, 1);
  assert.deepEqual([...KINDS], ['bump', 'hold', 'resume', 'restore']);
  assert.deepEqual(emptyLane(), { entries: {}, seq: 0 });
});

test('bodyFor: each body, and a bump carries the time of the tap', () => {
  assert.deepEqual(bodyFor('bump', { now: T0 }), { status: 'bumped', bumped_at: '2026-10-12T14:00:00.000Z' });
  assert.deepEqual(bodyFor('hold', { now: T0 }), { status: 'held' });
  assert.deepEqual(bodyFor('resume', { now: T0 }), { status: 'pending' });
  assert.deepEqual(bodyFor('restore', { now: T0 }), { status: 'pending', bumped_at: null });
  assert.deepEqual(bodyFor('restore', { now: T0, status: 'held' }), { status: 'held', bumped_at: null });
  assert.deepEqual(bodyFor('restore', { now: T0, status: 'bumped' }), { status: 'pending', bumped_at: null }, 'a recall can never write bumped');
  assert.equal(bodyFor('delete', { now: T0 }), null);
  assert.equal(labelFor('bump'), 'Kitchen ticket bumped');
  assert.equal(labelFor('hold'), 'Kitchen ticket held');
  assert.equal(labelFor('resume'), 'Kitchen ticket resumed');
  assert.equal(labelFor('restore'), 'Kitchen ticket recalled');
});

test('tap: the body is built once, and the newest tap replaces an older unsaved change', () => {
  let lane = bumped('A');
  const first = lane.entries.A;
  assert.equal(first.kind, 'bump');
  assert.equal(first.state, 'waiting');
  assert.equal(first.at, T0);
  assert.equal(first.since, T0);
  assert.equal(first.nextAt, T0);
  assert.equal(first.seq, 1);
  assert.equal(first.centreId, 'pc-drinks');
  assert.equal(first.label, 'Kitchen ticket bumped');
  assert.deepEqual(first.body, { status: 'bumped', bumped_at: '2026-10-12T14:00:00.000Z' });

  // A second Bump while the first is unsaved: nothing changes (one bump, one body, one bumped_at).
  const again = tap(lane, { id: 'A', kind: 'bump', row: row('A'), centreId: 'pc-drinks', now: T0 + 4000 });
  assert.equal(again, lane);

  // Undo: the later tap wins and takes a new place in the order.
  lane = tap(lane, { id: 'A', kind: 'restore', row: row('A'), status: 'held', centreId: 'pc-drinks', now: T0 + 5000 });
  assert.equal(lane.entries.A.kind, 'restore');
  assert.deepEqual(lane.entries.A.body, { status: 'held', bumped_at: null });
  assert.equal(lane.entries.A.seq, 2);
  assert.equal(Object.keys(lane.entries).length, 1, 'one ticket holds one unsaved change');
  // The same recall again changes nothing; a recall to another status does.
  assert.equal(tap(lane, { id: 'A', kind: 'restore', row: row('A'), status: 'held', now: T0 + 6000 }), lane);
  assert.equal(tap(lane, { id: 'A', kind: 'restore', row: row('A'), status: 'pending', now: T0 + 6000 }).entries.A.body.status, 'pending');

  // Not a kind this file knows, or no id: nothing.
  assert.equal(tap(lane, { id: 'A', kind: 'delete', now: T0 }), lane);
  assert.equal(tap(lane, { kind: 'bump', now: T0 }), lane);
});

test('tap: a change with no row handed in keeps the row of the change it replaces', () => {
  let lane = tap(emptyLane(), { id: 'A', kind: 'hold', row: row('A', { table: 'T4' }), now: T0 });
  lane = tap(lane, { id: 'A', kind: 'bump', now: T0 + 1000 });
  assert.equal(lane.entries.A.kind, 'bump');
  assert.equal(lane.entries.A.row.table, 'T4');
});

test('review: Hold or Resume on a card whose recall is not saved yet stays a recall, with the new status', () => {
  // The card is painted only from that recall. A Hold used to REPLACE it: the card vanished at the
  // tap and the un bump was never sent.
  const X = '2026-10-12T13:59:00.000Z';
  let lane = tap(emptyLane(), { id: 'A', kind: 'restore', row: row('A', { table: 'T4' }), status: 'pending', undoes: X, now: T0 });
  lane = tap(lane, { id: 'A', kind: 'hold', now: T0 + 1000 });
  assert.equal(lane.entries.A.kind, 'restore');
  assert.deepEqual(lane.entries.A.body, { status: 'held', bumped_at: null }, 'one write un bumps the ticket AND holds it');
  assert.deepEqual(lane.entries.A.guard, { match: { bumped_at: X } }, 'still only the bump it undoes');
  assert.equal(lane.entries.A.row.table, 'T4');
  assert.equal(lane.entries.A.seq, 2);
  assert.deepEqual(paint(lane, []).map((r) => `${r.id}:${r.status}:${r.held}`), ['A:held:true'], 'on the board, on hold');
  // Hold again changes nothing. Resume makes it a plain recall again.
  assert.equal(tap(lane, { id: 'A', kind: 'hold', now: T0 + 2000 }), lane);
  lane = tap(lane, { id: 'A', kind: 'resume', now: T0 + 3000 });
  assert.deepEqual(lane.entries.A.body, { status: 'pending', bumped_at: null });
  assert.deepEqual(lane.entries.A.guard, { match: { bumped_at: X } });
  assert.deepEqual(paint(lane, []).map((r) => `${r.id}:${r.status}`), ['A:pending']);
  // A recall the engine itself sent (the undo watch) stays marked as such.
  let healed = tap(emptyLane(), { id: 'B', kind: 'restore', row: row('B'), undoes: X, heal: true, now: T0 });
  assert.equal(healed.entries.B.heal, true);
  healed = tap(healed, { id: 'B', kind: 'hold', now: T0 + 1 });
  assert.equal(healed.entries.B.heal, true);
  // A Bump on such a card is a bump: the later tap wins.
  assert.equal(tap(lane, { id: 'A', kind: 'bump', now: T0 + 4000 }).entries.A.kind, 'bump');
  // A Hold on a plain card is a hold.
  assert.equal(tap(emptyLane(), { id: 'C', kind: 'hold', row: row('C'), now: T0 }).entries.C.kind, 'hold');
});

test('review (K3): each change carries its guard, so one that lands late cannot undo a newer one', () => {
  assert.deepEqual(guardFor('hold'), { notMatch: { status: 'bumped' } });
  assert.deepEqual(guardFor('resume'), { notMatch: { status: 'bumped' } });
  assert.equal(guardFor('bump'), null, 'a bump always wins');
  assert.deepEqual(guardFor('restore', { undoes: '2026-10-12T14:00:00.000Z' }), { match: { bumped_at: '2026-10-12T14:00:00.000Z' } });
  assert.equal(guardFor('restore'), null, 'no bump named: sent as before');
  assert.equal(guardFor('delete'), null);
  // The guard only uses the two filters a parked copy keeps (lib/rowWriteFence.js parkedWriteItem).
  for (const g of [guardFor('hold'), guardFor('restore', { undoes: 'x' })]) for (const k of Object.keys(g)) assert.ok(['match', 'notMatch'].includes(k));
  let lane = tap(emptyLane(), { id: 'H', kind: 'hold', row: row('H'), now: T0 });
  lane = tap(lane, { id: 'R', kind: 'resume', row: row('R'), now: T0 });
  lane = tap(lane, { id: 'B', kind: 'bump', row: row('B'), now: T0 });
  lane = tap(lane, { id: 'U', kind: 'restore', row: row('U'), undoes: '2026-10-12T13:59:59.000Z', now: T0 });
  lane = tap(lane, { id: 'V', kind: 'restore', row: row('V'), now: T0 });
  assert.deepEqual(lane.entries.H.guard, { notMatch: { status: 'bumped' } });
  assert.deepEqual(lane.entries.R.guard, { notMatch: { status: 'bumped' } });
  assert.equal(lane.entries.B.guard, null);
  assert.deepEqual(lane.entries.U.guard, { match: { bumped_at: '2026-10-12T13:59:59.000Z' } });
  assert.equal(lane.entries.V.guard, null);
  assert.equal(lane.entries.U.heal, false);
  // The body is exactly as before: the guard rides beside it.
  assert.deepEqual(lane.entries.H.body, { status: 'held' });
  assert.deepEqual(lane.entries.U.body, { status: 'pending', bumped_at: null });
  // The same bump tapped again on "Bump not saved" keeps no guard, and an Undo of a bump names that bump.
  const undo = tap(lane, { id: 'B', kind: 'restore', row: row('B'), undoes: lane.entries.B.body.bumped_at, now: T0 + 2000 });
  assert.deepEqual(undo.entries.B.guard, { match: { bumped_at: '2026-10-12T14:00:00.000Z' } });
});

test('review: a write the database answered with nothing changed ("gone") is done here, and the engine is told so', () => {
  const lane = sendStarted(tap(emptyLane(), { id: 'A', kind: 'hold', row: row('A'), now: T0 }), { id: 'A', now: T0 });
  const out = sendEnded(lane, { id: 'A', seq: 1, result: 'gone', now: T0 + 200 });
  assert.deepEqual(out.lane.entries, {});
  assert.equal(out.settled.how, 'gone');
  assert.equal(out.settled.kind, 'hold');
  assert.equal(out.gaveUp, null);
});

test('review: how long a change took runs from the tap on "Bump not saved", not from the first tap', () => {
  let lane = sendStarted(bumped('A'), { id: 'A', now: T0 });
  lane = sendEnded(lane, { id: 'A', seq: 1, result: 'failed', now: T0 + GIVE_UP_MS }).lane;
  assert.equal(lane.entries.A.state, 'failed');
  // Tapped 12 minutes later, on a healthy link.
  const tapAt = T0 + GIVE_UP_MS + 720000;
  lane = retryFailedBump(lane, { id: 'A', now: tapAt });
  assert.deepEqual(laneCounts(lane, { now: tapAt + 100 }), { bumps: 1, others: 0, failedBumps: 0, oldestBumpMs: 100, oldestMs: 100 }, 'no "slow" banner for a bump tapped a tenth of a second ago');
  lane = sendStarted(lane, { id: 'A', now: tapAt });
  const saved = sendEnded(lane, { id: 'A', seq: 2, result: 'saved', now: tapAt + 100 });
  assert.equal(saved.settled.tookMs, 100, 'not "22 min late"');
  assert.equal(saved.settled.body.bumped_at, '2026-10-12T14:00:00.000Z', 'the same bump all the same');
  assert.equal(confirmBumpsFromList(lane, { ids: new Set(), readStartedAt: tapAt + 50, centreId: 'pc-drinks', now: tapAt + 150 }).settled[0].tookMs, 150);
  assert.equal(confirmBumpFromLive(lane, { id: 'A', bumpedAt: '2026-10-12T14:00:00.000Z', now: tapAt + 60 }).settled.tookMs, 60);
});

test('review: a tick on a card painted from its unsaved recall only is kept on that card', () => {
  let lane = tap(emptyLane(), { id: 'A', kind: 'restore', row: row('A', { items: [{ name: 'Latte', _bumped: false }] }), now: T0 });
  const next = patchEntryRow(lane, 'A', { items: [{ name: 'Latte', _bumped: true }] });
  assert.notEqual(next, lane);
  assert.deepEqual(paint(next, [])[0].items, [{ name: 'Latte', _bumped: true }]);
  assert.equal(next.entries.A.seq, lane.entries.A.seq, 'the write itself is the same one');
  assert.equal(patchEntryRow(lane, 'nope', { items: [] }), lane, 'never adds a ticket');
  lane = tap(emptyLane(), { id: 'H', kind: 'hold', now: T0 });
  assert.equal(patchEntryRow(lane, 'H', { items: [] }), lane, 'a change that holds no row has nothing to patch');
});

test('dueSends: one send per ticket, never beside an open send, cancelled only at 75 s', () => {
  let lane = bumped('A');
  lane = tap(lane, { id: 'B', kind: 'hold', row: row('B'), now: T0 + 10 });
  let due = dueSends(lane, { now: T0 + 20, open: {} });
  assert.deepEqual(due.send.map((e) => e.id), ['A', 'B'], 'in tap order');
  assert.deepEqual(due.cancel, []);

  // A is in flight: only B may go. A newer tap for A waits too.
  lane = sendStarted(lane, { id: 'A', now: T0 + 20 });
  assert.equal(lane.entries.A.state, 'sending');
  assert.equal(lane.entries.A.attempts, 1);
  const open = { A: { seq: 1, startedAt: T0 + 20 } };
  due = dueSends(lane, { now: T0 + 30, open });
  assert.deepEqual(due.send.map((e) => e.id), ['B']);
  lane = tap(lane, { id: 'A', kind: 'restore', row: row('A'), now: T0 + 3000 });
  due = dueSends(lane, { now: T0 + 3000, open });
  assert.deepEqual(due.send.map((e) => e.id), ['B'], 'the Undo waits for the bump send to end by itself');
  assert.deepEqual(due.cancel, []);

  // The safety valve: not at 74.9 s, yes at 75 s.
  assert.deepEqual(dueSends(lane, { now: T0 + 20 + WRITE_ATTEMPT_MS - 1, open }).cancel, []);
  assert.deepEqual(dueSends(lane, { now: T0 + 20 + WRITE_ATTEMPT_MS, open }).cancel, ['A']);

  // A wait that has not passed keeps the entry back.
  const later = { ...lane, entries: { ...lane.entries, B: { ...lane.entries.B, nextAt: T0 + 9000 } } };
  assert.deepEqual(dueSends(later, { now: T0 + 8999, open: {} }).send.map((e) => e.id), ['A']);
  assert.deepEqual(dueSends(later, { now: T0 + 9000, open: {} }).send.map((e) => e.id), ['B', 'A']);
});

test('sendEnded: saved and kept are done, and say how long the change took', () => {
  const lane = sendStarted(bumped('A'), { id: 'A', now: T0 });
  const saved = sendEnded(lane, { id: 'A', seq: 1, result: 'saved', now: T0 + 38000 });
  assert.deepEqual(saved.lane.entries, {});
  assert.equal(saved.settled.id, 'A');
  assert.equal(saved.settled.how, 'saved');
  assert.equal(saved.settled.savedAt, T0 + 38000);
  assert.equal(saved.settled.tookMs, 38000);
  assert.equal(saved.gaveUp, null);
  const kept = sendEnded(lane, { id: 'A', seq: 1, result: 'kept', now: T0 + 200 });
  assert.deepEqual(kept.lane.entries, {});
  assert.equal(kept.settled.how, 'kept');
});

test('sendEnded: a send the valve ended goes again at once; a fast failure waits 1, 2, 5, 10, 10 s', () => {
  let lane = sendStarted(bumped('A'), { id: 'A', now: T0 });
  const body = lane.entries.A.body;
  let out = sendEnded(lane, { id: 'A', seq: 1, result: 'timeout', now: T0 + 75000 });
  assert.equal(out.settled, null);
  assert.equal(out.lane.entries.A.state, 'waiting');
  assert.equal(out.lane.entries.A.nextAt, T0 + 75000, 'again at once');
  assert.equal(out.lane.entries.A.fails, 0);
  assert.equal(out.lane.entries.A.body, body, 'the SAME body, the same bumped_at');

  let now = T0;
  const waits = [];
  lane = bumped('A');
  const sameBody = lane.entries.A.body;
  for (let i = 0; i < 6; i += 1) {
    lane = sendStarted(lane, { id: 'A', now });
    out = sendEnded(lane, { id: 'A', seq: 1, result: 'failed', now });
    lane = out.lane;
    waits.push(lane.entries.A.nextAt - now);
    now = lane.entries.A.nextAt;
    assert.equal(lane.entries.A.body, sameBody, 'never rebuilt');
  }
  assert.deepEqual(waits, [1000, 2000, 5000, 10000, 10000, 10000]);
  assert.equal(lane.entries.A.attempts, 6);
  // A timeout in between starts the short waits again.
  out = sendEnded(sendStarted(lane, { id: 'A', now }), { id: 'A', seq: 1, result: 'timeout', now });
  out = sendEnded(sendStarted(out.lane, { id: 'A', now }), { id: 'A', seq: 1, result: 'failed', now });
  assert.equal(out.lane.entries.A.nextAt - now, 1000);
});

test('sendEnded: after 10 minutes a bump stays as failed, any other change is dropped', () => {
  let lane = sendStarted(bumped('A'), { id: 'A', now: T0 });
  let out = sendEnded(lane, { id: 'A', seq: 1, result: 'failed', now: T0 + GIVE_UP_MS - 1 });
  assert.equal(out.gaveUp, null, 'not yet');
  out = sendEnded(lane, { id: 'A', seq: 1, result: 'timeout', now: T0 + GIVE_UP_MS });
  assert.equal(out.gaveUp.id, 'A');
  assert.equal(out.lane.entries.A.state, 'failed');
  assert.equal(out.lane.entries.A.body.bumped_at, '2026-10-12T14:00:00.000Z');
  assert.deepEqual(dueSends(out.lane, { now: T0 + GIVE_UP_MS + 60000, open: {} }).send, [], 'a failed bump is not sent until it is tapped');
  // Saved on the very send that passed ten minutes: saved wins.
  assert.equal(sendEnded(lane, { id: 'A', seq: 1, result: 'saved', now: T0 + GIVE_UP_MS + 5 }).settled.how, 'saved');

  lane = sendStarted(tap(emptyLane(), { id: 'H', kind: 'hold', row: row('H'), now: T0 }), { id: 'H', now: T0 });
  out = sendEnded(lane, { id: 'H', seq: 1, result: 'failed', now: T0 + GIVE_UP_MS });
  assert.equal(out.gaveUp.kind, 'hold');
  assert.deepEqual(out.lane.entries, {}, 'the board shows what the database holds');
});

test('sendEnded: a result for a change that was since replaced changes nothing', () => {
  let lane = sendStarted(bumped('A'), { id: 'A', now: T0 });
  lane = tap(lane, { id: 'A', kind: 'restore', row: row('A'), now: T0 + 2000 });   // Undo, seq 2
  const out = sendEnded(lane, { id: 'A', seq: 1, result: 'saved', now: T0 + 50000 });
  assert.equal(out.lane, lane);
  assert.equal(out.settled, null);
  assert.equal(out.gaveUp, null);
  assert.equal(sendEnded(lane, { id: 'Z', seq: 1, result: 'saved', now: T0 }).lane, lane, 'an unknown ticket too');
});

test('retryFailedBump: the SAME bump goes again with a fresh ten minutes', () => {
  let lane = sendStarted(bumped('A'), { id: 'A', now: T0 });
  lane = sendEnded(lane, { id: 'A', seq: 1, result: 'failed', now: T0 + GIVE_UP_MS }).lane;
  const again = retryFailedBump(lane, { id: 'A', now: T0 + 700000 });
  assert.equal(again.entries.A.state, 'waiting');
  assert.equal(again.entries.A.since, T0 + 700000);
  assert.equal(again.entries.A.at, T0, 'still the first tap');
  assert.equal(again.entries.A.body.bumped_at, '2026-10-12T14:00:00.000Z');
  assert.equal(again.entries.A.attempts, 0);
  assert.equal(again.entries.A.seq, 2);
  assert.deepEqual(dueSends(again, { now: T0 + 700000, open: {} }).send.map((e) => e.id), ['A']);
  // Only a failed bump: a bump still being tried, a hold and an unknown id are left alone.
  const trying = bumped('B');
  assert.equal(retryFailedBump(trying, { id: 'B', now: T0 }), trying);
  assert.equal(retryFailedBump(trying, { id: 'nope', now: T0 }), trying);
});

test('confirmBumpsFromList: only a read SENT after the tap, the same station, bumps only', () => {
  let lane = bumped('A', T0);
  lane = tap(lane, { id: 'B', kind: 'bump', row: row('B'), centreId: 'pc-drinks', now: T0 + 10000 });
  lane = tap(lane, { id: 'H', kind: 'hold', row: row('H'), centreId: 'pc-drinks', now: T0 });
  lane = tap(lane, { id: 'F', kind: 'bump', row: row('F', { centreId: 'pc-food' }), centreId: 'pc-food', now: T0 });
  const ids = new Set(['X']);   // the list holds none of them

  // Sent before A was tapped: proves nothing (its snapshot could be older than the bump).
  let out = confirmBumpsFromList(lane, { ids, readStartedAt: T0, centreId: 'pc-drinks', now: T0 + 20000 });
  assert.equal(out.lane, lane);
  assert.deepEqual(out.settled, []);

  // Sent after A, before B: A is in the database. B, the hold and the other station's bump stay.
  out = confirmBumpsFromList(lane, { ids, readStartedAt: T0 + 5000, centreId: 'pc-drinks', now: T0 + 20000 });
  assert.deepEqual(out.settled.map((e) => `${e.id}:${e.how}:${e.tookMs}`), ['A:seen:20000']);
  assert.deepEqual(Object.keys(out.lane.entries).sort(), ['B', 'F', 'H']);

  // The list still holds the ticket as waiting: not saved yet.
  out = confirmBumpsFromList(lane, { ids: new Set(['A', 'B']), readStartedAt: T0 + 15000, centreId: 'pc-drinks', now: T0 + 20000 });
  assert.deepEqual(out.settled, []);

  // A board with no station only settles bumps it made with no station.
  out = confirmBumpsFromList(lane, { ids, readStartedAt: T0 + 15000, centreId: null, now: T0 + 20000 });
  assert.deepEqual(out.settled, []);
});

test('confirmBumpFromLive: only the echo of this very bump (the same bumped_at)', () => {
  const lane = bumped('A', T0);
  let out = confirmBumpFromLive(lane, { id: 'A', bumpedAt: '2026-10-12T14:00:00+00:00', now: T0 + 30000 });
  assert.deepEqual(out.lane.entries, {});
  assert.equal(out.settled.how, 'seen');
  assert.equal(out.settled.tookMs, 30000);
  // Another screen bumped it at another moment: ours is still sent (same end state, and we know it landed).
  out = confirmBumpFromLive(lane, { id: 'A', bumpedAt: '2026-10-12T14:00:07.000Z', now: T0 + 30000 });
  assert.equal(out.lane, lane);
  assert.equal(out.settled, null);
  assert.equal(confirmBumpFromLive(lane, { id: 'A', bumpedAt: null, now: T0 }).settled, null);
  assert.equal(confirmBumpFromLive(lane, { id: 'B', bumpedAt: '2026-10-12T14:00:00.000Z', now: T0 }).settled, null);
  const held = tap(emptyLane(), { id: 'A', kind: 'hold', row: row('A'), now: T0 });
  assert.equal(confirmBumpFromLive(held, { id: 'A', bumpedAt: '2026-10-12T14:00:00.000Z', now: T0 }).settled, null);
});

test('paint (K1): an unsaved bump is never painted; a failed one is, and says so', () => {
  let lane = bumped('A');
  const rows = [row('A'), row('B'), row('C')];
  assert.deepEqual(paint(lane, rows).map((r) => r.id), ['B', 'C']);
  assert.equal(paintOne(lane, row('A')), null);
  assert.equal(paintOne(lane, rows[1]), rows[1], 'an untouched row is handed back as it is');
  assert.equal(paintOne(lane, null), null);
  // While it is being sent, and while it waits between sends: still hidden.
  lane = sendStarted(lane, { id: 'A', now: T0 });
  assert.deepEqual(paint(lane, rows).map((r) => r.id), ['B', 'C']);
  lane = sendEnded(lane, { id: 'A', seq: 1, result: 'failed', now: T0 + 1000 }).lane;
  assert.deepEqual(paint(lane, rows).map((r) => r.id), ['B', 'C']);
  // Ten minutes: back, with the mark the card reads.
  lane = sendEnded(sendStarted(lane, { id: 'A', now: T0 + 2000 }), { id: 'A', seq: 1, result: 'failed', now: T0 + GIVE_UP_MS }).lane;
  const back = paint(lane, rows);
  assert.deepEqual(back.map((r) => `${r.id}${r.unsaved ? `!${r.unsaved}` : ''}`), ['A!bump', 'B', 'C']);
  assert.equal(back[0].status, 'pending');
});

test('paint: hold and resume show at once, a recall shows its card at once', () => {
  let lane = tap(emptyLane(), { id: 'A', kind: 'hold', row: row('A'), now: T0 });
  lane = tap(lane, { id: 'B', kind: 'resume', row: row('B', { status: 'held', held: true }), now: T0 });
  lane = tap(lane, { id: 'R', kind: 'restore', row: row('R', { status: 'bumped', bumpedAt: T0 - 5000 }), now: T0 });
  lane = tap(lane, { id: 'S', kind: 'restore', row: row('S', { status: 'bumped', bumpedAt: T0 - 5000 }), status: 'held', now: T0 });
  const out = paint(lane, [row('A'), row('B', { status: 'held', held: true }), row('C')]);
  const by = Object.fromEntries(out.map((r) => [r.id, r]));
  assert.deepEqual([by.A.status, by.A.held], ['held', true]);
  assert.deepEqual([by.B.status, by.B.held], ['pending', false]);
  assert.deepEqual([by.R.status, by.R.held, by.R.bumpedAt], ['pending', false, null], 'not in the list yet: painted from the row kept at the tap');
  assert.deepEqual([by.S.status, by.S.held, by.S.bumpedAt], ['held', true, null]);
  assert.equal(out.length, 5);
  // Once the list holds the recalled ticket it is painted once, not twice.
  const once = paint(lane, [row('R', { status: 'bumped', bumpedAt: T0 - 5000 })]);
  assert.deepEqual(once.filter((r) => r.id === 'R').map((r) => [r.status, r.bumpedAt]), [['pending', null]]);
  assert.deepEqual(paint(emptyLane(), null), []);
});

test('newestUnsavedBump (Recall last): the last bump tapped that is still unsaved, never a failed one or another kind', () => {
  assert.equal(newestUnsavedBump(emptyLane()), null);
  let lane = tap(emptyLane(), { id: 'A', kind: 'bump', row: row('A'), now: T0 });
  lane = tap(lane, { id: 'B', kind: 'bump', row: row('B'), now: T0 + 4000 });
  lane = tap(lane, { id: 'C', kind: 'hold', row: row('C'), now: T0 + 9000 });
  assert.equal(newestUnsavedBump(lane).id, 'B', 'the newest BUMP, whatever was tapped after it');
  assert.deepEqual(newestUnsavedBump(lane).row, row('B'), 'with the ticket as it was at the tap');
  // B is recalled (its bump is replaced by the restore): the next one back is A.
  lane = tap(lane, { id: 'B', kind: 'restore', row: row('B'), now: T0 + 12000 });
  assert.equal(newestUnsavedBump(lane).id, 'A');
  // A bump that has failed is already back on the board with its mark: not "the last bumped".
  lane = sendStarted(lane, { id: 'A', now: T0 + 13000 });
  lane = sendEnded(lane, { id: 'A', seq: lane.entries.A.seq, result: 'failed', now: T0 + GIVE_UP_MS + 1 }).lane;
  assert.equal(lane.entries.A.state, 'failed');
  assert.equal(newestUnsavedBump(lane), null);
  // Two taps in the same millisecond: the later tap.
  let same = tap(emptyLane(), { id: 'X', kind: 'bump', row: row('X'), now: T0 });
  same = tap(same, { id: 'Y', kind: 'bump', row: row('Y'), now: T0 });
  assert.equal(newestUnsavedBump(same).id, 'Y');
});

test('laneCounts: what the header and the banner count', () => {
  let lane = bumped('A', T0);
  lane = tap(lane, { id: 'B', kind: 'bump', row: row('B'), now: T0 + 4000 });
  lane = tap(lane, { id: 'H', kind: 'hold', row: row('H'), now: T0 - 2000 });
  let c = laneCounts(lane, { now: T0 + 12000 });
  assert.deepEqual(c, { bumps: 2, others: 1, failedBumps: 0, oldestBumpMs: 12000, oldestMs: 14000 });
  // A bump that has truly failed is on its card again: it is no longer "saving".
  lane = sendEnded(sendStarted(lane, { id: 'A', now: T0 }), { id: 'A', seq: 1, result: 'failed', now: T0 + GIVE_UP_MS }).lane;
  c = laneCounts(lane, { now: T0 + GIVE_UP_MS });
  assert.equal(c.bumps, 1);
  assert.equal(c.failedBumps, 1);
  assert.equal(c.oldestBumpMs, GIVE_UP_MS - 4000);
  assert.deepEqual(laneCounts(emptyLane(), { now: T0 }), { bumps: 0, others: 0, failedBumps: 0, oldestBumpMs: 0, oldestMs: 0 });
});

test('the journal keeps bumps and recalls, in tap order, and lets extra ride along', () => {
  let lane = tap(emptyLane(), { id: 'H', kind: 'hold', row: row('H'), now: T0 });
  lane = tap(lane, { id: 'B', kind: 'bump', row: row('B'), centreId: 'pc-drinks', now: T0 + 1000 });
  lane = tap(lane, { id: 'R', kind: 'restore', row: row('R'), now: T0 + 2000 });
  lane = tap(lane, { id: 'A', kind: 'bump', row: row('A'), centreId: 'pc-drinks', now: T0 + 3000 });
  const text = toJournal(lane, { spell: { startedAt: T0 } });
  const parsed = JSON.parse(text);
  assert.equal(parsed.v, 1);
  assert.deepEqual(parsed.entries.map((e) => `${e.id}:${e.kind || 'bump'}`), ['B:bump', 'R:restore', 'A:bump'], 'a Hold is not kept: a restart shows what the database holds');
  assert.deepEqual(parsed.spell, { startedAt: T0 });
  assert.deepEqual(parsed.entries[0].body, { status: 'bumped', bumped_at: '2026-10-12T14:00:01.000Z' });
  assert.equal(JSON.parse(toJournal(emptyLane())).entries.length, 0);

  // A restart 30 s later: both bumps are still hidden and still to send, with the SAME body.
  const back = fromJournal(text, { now: T0 + 30000 });
  assert.deepEqual(Object.keys(back.entries).sort(), ['A', 'B', 'R']);
  assert.equal(back.entries.B.state, 'waiting');
  assert.equal(back.entries.B.at, T0 + 1000);
  assert.equal(back.entries.B.centreId, 'pc-drinks');
  assert.equal(back.entries.B.body.bumped_at, '2026-10-12T14:00:01.000Z');
  assert.deepEqual(dueSends(back, { now: T0 + 30000, open: {} }).send.map((e) => e.id), ['B', 'R', 'A']);
  assert.deepEqual(paint(back, [row('A'), row('B'), row('C')]).map((r) => r.id), ['C', 'R'], 'the bumps stay hidden, the recalled card stays on the board');
  assert.equal(back.entries.B.restarted, true);
});

test('review: a recall kept across a restart keeps its guard and its status; one over ten minutes old is dropped', () => {
  // Staff bumped, tapped Undo and restarted the slow app: the old bump is still on the network.
  const X = '2026-10-12T13:59:30.000Z';
  let lane = tap(emptyLane(), { id: 'U', kind: 'restore', row: row('U', { table: 'T7' }), status: 'held', undoes: X, centreId: 'pc-drinks', now: T0 });
  lane = tap(lane, { id: 'W', kind: 'restore', row: row('W'), undoes: X, heal: true, now: T0 + 10 });
  const text = toJournal(lane);
  const kept = JSON.parse(text).entries;
  assert.deepEqual(kept[0].guard, { match: { bumped_at: X } });
  assert.equal(kept[0].kind, 'restore');
  const back = fromJournal(text, { now: T0 + 60000, sendAfter: T0 + 65000 });
  assert.equal(back.entries.U.kind, 'restore');
  assert.deepEqual(back.entries.U.body, { status: 'held', bumped_at: null });
  assert.deepEqual(back.entries.U.guard, { match: { bumped_at: X } });
  assert.equal(back.entries.U.label, 'Kitchen ticket recalled');
  assert.equal(back.entries.U.state, 'waiting');
  assert.equal(back.entries.U.nextAt, T0 + 60000, 'a recall is sent at once: only a kept BUMP waits for the first list');
  assert.equal(back.entries.U.row.table, 'T7');
  assert.equal(back.entries.U.restarted, true);
  assert.equal(back.entries.W.heal, true);
  assert.deepEqual(paint(back, []).map((r) => `${r.id}:${r.status}`), ['U:held', 'W:pending'], 'on the board straight after the restart');
  assert.deepEqual(fromJournal(text, { now: T0 + GIVE_UP_MS + 10 }).entries, {}, 'ten minutes on, the board shows what the database holds');
  assert.deepEqual(Object.keys(fromJournal(text, { now: T0 + GIVE_UP_MS - 1 }).entries), ['U', 'W']);
  // Rubbish is not a recall: no row, a body that is not a recall, a guard that is not a time.
  const mixed = JSON.stringify({ v: 1, entries: [
    { id: 'A', kind: 'restore', body: { status: 'pending', bumped_at: null }, at: T0 },
    { id: 'B', kind: 'restore', body: { status: 'bumped', bumped_at: null }, at: T0, row: row('B') },
    { id: 'C', kind: 'restore', body: { status: 'pending', bumped_at: 'x' }, at: T0, row: row('C') },
    { id: 'D', kind: 'restore', body: { status: 'pending', bumped_at: null }, at: T0, row: row('D'), guard: { match: { bumped_at: 5 } } },
  ] });
  const read = fromJournal(mixed, { now: T0 + 1000 });
  assert.deepEqual(Object.keys(read.entries), ['D']);
  assert.equal(read.entries.D.guard, null);
});

test('review: a bump kept across a restart waits for the first list, and goes when that list is in', () => {
  const text = toJournal(bumped('A', T0));
  const back = fromJournal(text, { now: T0 + 30000, sendAfter: T0 + 35000 });
  assert.equal(back.entries.A.nextAt, T0 + 35000);
  assert.deepEqual(dueSends(back, { now: T0 + 30000, open: {} }).send, [], 'not sent with the first paint');
  assert.deepEqual(dueSends(back, { now: T0 + 35000, open: {} }).send.map((e) => e.id), ['A'], 'with no list answer it still goes, 5 s later');
  const released = releaseRestarted(back, { now: T0 + 30100 });
  assert.deepEqual(dueSends(released, { now: T0 + 30100, open: {} }).send.map((e) => e.id), ['A'], 'the first list is in and still holds it: sent now');
  assert.equal(releaseRestarted(released, { now: T0 + 30200 }), released, 'nothing left to release');
  // Not a bump of this page, not one already tried, not one that has failed.
  const fresh = bumped('B', T0);
  assert.equal(releaseRestarted(fresh, { now: T0 }), fresh);
  const tried = sendStarted(back, { id: 'A', now: T0 + 35000 });
  assert.equal(releaseRestarted(tried, { now: T0 + 30100 }), tried);
  // Left out, a kept bump may go at once (as before).
  assert.equal(fromJournal(text, { now: T0 + 30000 }).entries.A.nextAt, T0 + 30000);
});

test('review: one answered bump is taken out of the journal text, and nothing else is', () => {
  let lane = bumped('A', T0);
  lane = tap(lane, { id: 'B', kind: 'bump', row: row('B'), now: T0 + 1000 });
  lane = tap(lane, { id: 'R', kind: 'restore', row: row('R'), undoes: '2026-10-12T14:00:00.000Z', now: T0 + 2000 });
  const text = toJournal(lane, { spell: { startedAt: T0 } });
  const out = journalWithout(text, { id: 'A', bumpedAt: '2026-10-12T14:00:00.000Z' });
  assert.deepEqual(JSON.parse(out).entries.map((e) => e.id), ['B', 'R']);
  assert.deepEqual(JSON.parse(out).spell, { startedAt: T0 }, 'what rides along stays');
  assert.equal(journalWithout(text, { id: 'A', bumpedAt: '2026-10-12T14:00:09.000Z' }), text, 'another bump of that ticket (tapped again since) stays');
  assert.equal(journalWithout(text, { id: 'R', bumpedAt: null }), text, 'never a recall');
  assert.equal(journalWithout(text, { id: 'Z', bumpedAt: 'x' }), text);
  for (const bad of [null, '', 'not json', '{"v":1}']) assert.equal(journalWithout(bad, { id: 'A', bumpedAt: 'x' }), bad);
});

test('the journal after a restart: over 10 minutes comes back as failed, over 24 hours is forgotten', () => {
  const lane = bumped('A', T0);
  const text = toJournal(lane);
  const late = fromJournal(text, { now: T0 + GIVE_UP_MS });
  assert.equal(late.entries.A.state, 'failed');
  assert.deepEqual(paint(late, [row('A')]).map((r) => r.unsaved), ['bump']);
  assert.deepEqual(Object.keys(fromJournal(text, { now: T0 + JOURNAL_MAX_AGE_MS }).entries), ['A'], 'exactly a day is still kept');
  assert.deepEqual(fromJournal(text, { now: T0 + JOURNAL_MAX_AGE_MS + 1 }).entries, {});

  // A bump that had already failed before the restart is still failed after it.
  const failed = sendEnded(sendStarted(lane, { id: 'A', now: T0 }), { id: 'A', seq: 1, result: 'failed', now: T0 + GIVE_UP_MS }).lane;
  assert.equal(JSON.parse(toJournal(failed)).entries[0].failed, true);
  assert.equal(fromJournal(toJournal(failed), { now: T0 + GIVE_UP_MS + 5 }).entries.A.state, 'failed');
});

test('the journal reads nothing from rubbish, another version, or a body that is not a bump', () => {
  for (const bad of [null, undefined, '', 'not json', '{"v":2,"entries":[{"id":"A"}]}', '{"v":1}', '[]', 42]) {
    assert.deepEqual(fromJournal(bad, { now: T0 }).entries, {}, String(bad));
  }
  const mixed = JSON.stringify({ v: 1, entries: [
    null,
    { id: 'A', body: { status: 'held' }, at: T0 },
    { id: 'B', body: { status: 'bumped' }, at: T0 },
    { body: { status: 'bumped', bumped_at: '2026-10-12T14:00:00.000Z' }, at: T0 },
    { id: 'C', body: { status: 'bumped', bumped_at: '2026-10-12T14:00:00.000Z' }, at: 'soon' },
    { id: 'D', body: { status: 'bumped', bumped_at: '2026-10-12T14:00:00.000Z' }, at: T0 },
  ] });
  assert.deepEqual(Object.keys(fromJournal(mixed, { now: T0 + 1000 }).entries), ['D']);
});

test('the "not saved" mark is never stored in a kept row', () => {
  // The card that says "Bump not saved" is tapped: the row handed in carries the mark.
  let lane = tap(emptyLane(), { id: 'A', kind: 'restore', row: { ...row('A'), unsaved: 'bump' }, now: T0 });
  assert.equal('unsaved' in lane.entries.A.row, false);
  lane = tap(emptyLane(), { id: 'A', kind: 'bump', row: { ...row('A'), unsaved: 'bump' }, now: T0 });
  assert.equal('unsaved' in lane.entries.A.row, false);
  assert.equal(JSON.parse(toJournal(lane)).entries[0].row.unsaved, undefined);
  // And a recalled card painted from the kept row carries no mark.
  const recalled = tap(emptyLane(), { id: 'A', kind: 'restore', row: { ...row('A'), unsaved: 'bump' }, now: T0 });
  assert.equal(paint(recalled, [])[0].unsaved, undefined);
});

// ── what the board engine's two watches need from this file (review 12 Oct 2026) ────────────────

test('review: the engine can send an earlier bump again (the same time), and such a send is marked as its own', () => {
  const lane = tap(emptyLane(), { id: 'A', kind: 'bump', row: row('A'), stamp: '2026-10-12T13:58:00.000Z', heal: true, now: T0 });
  assert.deepEqual(lane.entries.A.body, { status: 'bumped', bumped_at: '2026-10-12T13:58:00.000Z' }, 'the time of the bump it repeats, not of this send');
  assert.equal(lane.entries.A.heal, true);
  assert.equal(lane.entries.A.at, T0, 'its ten minutes and its age run from now');
  assert.equal(paintOne(lane, row('A')), null, 'the card stays off');
  // A tapped bump is not marked, and a stamp on anything else is ignored.
  assert.equal(bumped('B').entries.B.heal, false);
  assert.deepEqual(tap(emptyLane(), { id: 'C', kind: 'hold', row: row('C'), stamp: 'x', now: T0 }).entries.C.body, { status: 'held' });
});

test('review: a Hold or Resume the engine sends after a refused recall keeps its card on the board', () => {
  // The ticket was brought back by staff. A late "bumped" echo takes it out of the database's rows;
  // the card must not go with it.
  let lane = tap(emptyLane(), { id: 'A', kind: 'resume', row: row('A', { table: 'T4' }), keep: true, now: T0 });
  assert.equal(lane.entries.A.keep, true);
  assert.deepEqual(paint(lane, []).map((r) => `${r.id}:${r.status}:${r.table}`), ['A:pending:T4'], 'painted from its own row');
  assert.deepEqual(paint(lane, [row('A', { status: 'held', held: true })]).map((r) => `${r.id}:${r.status}`), ['A:pending'], 'and once only when the rows hold it too');
  // A Hold tapped on that card inherits it; a Bump does not.
  lane = tap(lane, { id: 'A', kind: 'hold', now: T0 + 1000 });
  assert.equal(lane.entries.A.keep, true);
  assert.deepEqual(paint(lane, []).map((r) => `${r.id}:${r.status}:${r.held}`), ['A:held:true']);
  assert.equal(tap(lane, { id: 'A', kind: 'bump', now: T0 + 2000 }).entries.A.keep, false);
  // A plain Hold is painted only over a row the database holds, as before.
  const plain = tap(emptyLane(), { id: 'B', kind: 'hold', row: row('B'), now: T0 });
  assert.equal(plain.entries.B.keep, false);
  assert.deepEqual(paint(plain, []), []);
});

test('review: a list proves nothing about a bump that waits behind an older change of its ticket', () => {
  const lane = bumped('A', T0);
  const args = { ids: new Set(), readStartedAt: T0 + 5000, centreId: 'pc-drinks', now: T0 + 6000 };
  assert.equal(confirmBumpsFromList(lane, args).settled.length, 1, 'normally: a list sent after the tap without the ticket');
  // An older change of the ticket is still on its way (the engine hands in the busy tickets).
  assert.deepEqual(confirmBumpsFromList(lane, { ...args, busy: new Set(['A']) }).settled, []);
  assert.equal(confirmBumpsFromList(lane, { ...args, busy: new Set(['Z']) }).settled.length, 1);
  // The older change ended at T0 + 7 s: only a list SENT after that counts.
  const held = notBefore(lane, { id: 'A', at: T0 + 7000 });
  assert.equal(held.entries.A.clearAt, T0 + 7000);
  assert.deepEqual(confirmBumpsFromList(held, args).settled, [], 'sent before the older change ended');
  assert.deepEqual(confirmBumpsFromList(held, { ...args, readStartedAt: T0 + 7000 }).settled, []);
  assert.equal(confirmBumpsFromList(held, { ...args, readStartedAt: T0 + 7001 }).settled.length, 1);
  assert.equal(notBefore(held, { id: 'A', at: T0 + 3000 }).entries.A.clearAt, T0 + 7000, 'never moved back');
  assert.equal(notBefore(lane, { id: 'nope', at: T0 }), lane);
  const hold = tap(emptyLane(), { id: 'H', kind: 'hold', row: row('H'), now: T0 });
  assert.equal(notBefore(hold, { id: 'H', at: T0 + 1 }), hold, 'only a bump is judged by lists');
});

test('review: that fact is kept across a restart, and such a bump is sent at once instead of waiting for the first list', () => {
  let lane = bumped('A', T0);
  lane = tap(lane, { id: 'B', kind: 'bump', row: row('B'), centreId: 'pc-drinks', now: T0 + 10 });
  const text = toJournal(lane, null, { behind: new Set(['A']) });
  const kept = JSON.parse(text).entries;
  assert.equal(kept[0].behind, true);
  assert.equal('behind' in kept[1], false);
  const back = fromJournal(text, { now: T0 + 2000, sendAfter: T0 + 7000 });
  assert.equal(back.entries.A.behind, true);
  assert.equal(back.entries.A.nextAt, T0 + 2000, 'sent at once: the first list could prove nothing about it');
  assert.equal(back.entries.B.nextAt, T0 + 7000, 'an ordinary kept bump waits for the first list');
  const args = { ids: new Set(), readStartedAt: T0 + 2100, centreId: 'pc-drinks', now: T0 + 2200 };
  assert.deepEqual(confirmBumpsFromList(back, args).settled.map((e) => e.id), ['B'], 'the first list settles B, not A');
  const sent = sendStarted(back, { id: 'A', now: T0 + 2000 });
  assert.deepEqual(confirmBumpsFromList(sent, args).settled.map((e) => e.id).sort(), ['A', 'B'], 'once its own send has started a list may settle it');
});

test('review: the age the banner counts is not shortened by a sleep, and is kept across a restart', () => {
  let lane = bumped('A', T0);
  // The tablet slept six minutes: the engine moves `since` on (the ten minutes to give up do not
  // run while it sleeps). The bump has still been unsaved for six minutes, and the banner says so.
  lane = { ...lane, entries: { A: { ...lane.entries.A, since: T0 + 360000 } } };
  assert.equal(laneCounts(lane, { now: T0 + 361000 }).oldestBumpMs, 361000);
  const back = fromJournal(toJournal(lane), { now: T0 + 362000 });
  assert.equal(back.entries.A.tapAt, T0);
  assert.equal(laneCounts(back, { now: T0 + 362000 }).oldestBumpMs, 362000);
  // A journal written before this field existed: the first tap.
  const old = JSON.stringify({ v: 1, entries: [{ id: 'A', body: { status: 'bumped', bumped_at: '2026-10-12T14:00:00.000Z' }, at: T0, since: T0 + 5000, centreId: null, failed: false, row: row('A') }] });
  assert.equal(fromJournal(old, { now: T0 + 6000 }).entries.A.tapAt, T0);
});
