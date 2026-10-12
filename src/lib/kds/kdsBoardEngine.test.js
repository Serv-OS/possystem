// 12 Oct 2026, Coffee Boy Barnsley: the hunters' reproductions, one by one, on the REAL board engine
// (lib/kds/kdsBoardEngine.js) with a fake link and a virtual clock (kdsSlowLinkWorld.js). Each one
// failed on the build of that day: a bumped ticket painted back, a bump lost, a late Hold landing
// after a Bump, new tickets held back, a warning cleared by a read that was thrown away.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeClock, makeWorld, makeAbortFactory, mapTestRow, T, clockText } from './kdsSlowLinkWorld.js';
import { createBoardEngine } from './kdsBoardEngine.js';

const CENTRE = 'pc-drinks';

function rig(spells = [], { patchWorld, cancelledStillArrive = false, centreId = CENTRE } = {}) {
  const clock = makeClock(T('14:00:00'));
  const world = makeWorld(clock, spells, { cancelledStillArrive });
  if (patchWorld) patchWorld(world, clock);
  const storage = { text: null, saves: 0 };
  const seen = [];          // every painted view: { at, ids, level, showSaving }
  const gaveUp = []; const saved = []; const bumpSaved = []; const bumpedLive = []; const spells2 = []; const applied = [];
  let engine;
  let liveTimers = 0;
  const make = () => createBoardEngine({
    now: clock.now,
    setTimer: (fn, ms) => { liveTimers += 1; return clock.setTimer(() => { liveTimers -= 1; fn(); }, ms); },
    clearTimer: (id) => { liveTimers -= 1; clock.clearTimer(id); },
    makeAbort: makeAbortFactory(),
    readList: (o) => world.readList(o), writeTicket: (...a) => world.writeTicket(...a), mapRow: mapTestRow, centreId,
    journal: { load: () => storage.text, save: (t) => { storage.text = t; storage.saves += 1; } },
    onChange: () => {
      const v = engine.view();
      seen.push({ at: clock.now(), ids: v.rows.map((r) => r.id + (r.unsaved ? '!' : '') + (r.held ? '(held)' : '')), level: v.level, showSaving: v.showSaving });
    },
    onApplied: (rows) => applied.push({ at: clock.now(), n: rows.length }),
    onGaveUp: (e) => gaveUp.push(e), onSaved: (e) => saved.push(e), onBumpSaved: (row, how) => bumpSaved.push({ id: row && row.id, how }),
    onBumpedLive: (row) => bumpedLive.push(row.id), onSpell: (s) => spells2.push(s),
  });
  engine = make();
  const ticket = (id, at = clock.now(), extra = {}) => world.insert({ id, centre_id: centreId, sent_at: new Date(at).toISOString(), items: [], ...extra });
  return {
    clock, world, storage, seen, gaveUp, saved, bumpSaved, bumpedLive, applied, spells: spells2, ticket,
    get engine() { return engine; },
    get liveTimers() { return liveTimers; },
    restart() { engine.stop(); engine = make(); engine.start(); },
  };
}
/** Every painted view between two moments that held this ticket WITHOUT the "not saved" mark. */
const shows = (r, id, from, to) => r.seen.filter((s) => s.at >= from && s.at <= to && s.ids.some((x) => x === id || x === `${id}(held)`));
const row = (r, id) => r.engine.view().rows.find((x) => x.id === id);
const landedOf = (r, id) => r.world.landed.filter((w) => w.id === id).map((w) => `${w.body.status}@${clockText(w.at)}`);
const iso = (s) => new Date(T(s)).toISOString();

test('A (K1): a bump that takes 50 s to reach the database is never painted back, and auto ready is judged once', async () => {
  const r = rig([{ from: T('14:00:02'), to: T('14:00:53'), kind: 'slow', readMs: () => 100, writeMs: () => 50000 }]);
  r.ticket('A'); r.ticket('B');
  r.engine.start();
  await r.clock.runTo(T('14:00:03'));
  r.engine.bump(row(r, 'A'));
  assert.equal(row(r, 'A'), undefined, 'gone at the tap');
  await r.clock.runTo(T('14:00:45'));
  // Two list reads (14:00:20, 14:00:40) came back holding A as waiting while the bump was on its way.
  assert.ok(r.world.reads.filter((x) => x.at > T('14:00:03') && x.ids.includes('A')).length >= 2, 'the list really did still hold it');
  assert.equal(r.engine.view().unsavedBumps, 1);
  await r.clock.runTo(T('14:02:00'));
  assert.equal(shows(r, 'A', T('14:00:03') + 1, T('14:02:00')).length, 0, 'A never came back');
  assert.ok(row(r, 'B'), 'the other ticket stayed');
  assert.equal(r.world.db.get('A').status, 'bumped');
  assert.equal(r.world.db.get('A').bumped_at, iso('14:00:03'), 'the time of the tap, not of the landing');
  assert.deepEqual(landedOf(r, 'A'), ['bumped@14:00:52'], 'one write, 50 s after the tap');
  assert.deepEqual(r.bumpSaved, [{ id: 'A', how: 'saved' }], 'auto ready judged once');
  assert.equal(r.engine.view().unsavedBumps, 0);
});

test('F (K1): the live echo of an item tick (status pending) cannot paint a ticket whose bump is unsaved', async () => {
  const r = rig([{ from: T('14:00:02'), to: T('14:01:00'), kind: 'slow', readMs: () => 100, writeMs: () => 40000 }]);
  r.ticket('A'); r.ticket('B');
  r.engine.start();
  await r.clock.runTo(T('14:00:05'));
  r.engine.bump(row(r, 'A'));
  await r.clock.runTo(T('14:00:11'));
  r.engine.liveUpdate({ id: 'A', status: 'pending', centre_id: CENTRE, sent_at: iso('14:00:00'), items: [{ _bumped: true }] });
  r.engine.liveInsert({ id: 'A', status: 'pending', centre_id: CENTRE, sent_at: iso('14:00:00'), items: [] });
  assert.equal(row(r, 'A'), undefined);
  await r.clock.runTo(T('14:01:30'));
  assert.equal(shows(r, 'A', T('14:00:05') + 1, T('14:01:30')).length, 0);
  assert.equal(r.world.db.get('A').status, 'bumped');
});

test('D (K3): Hold, a slow Resume, then Bump land in tap order, with cancelled requests still arriving', async () => {
  const r = rig([{ from: T('14:00:03') + 500, to: T('14:00:40'), kind: 'slow', readMs: () => 100, writeMs: (t) => (t < T('14:00:04') + 500 ? 30000 : 100) }], { cancelledStillArrive: true });
  r.ticket('A');
  r.engine.start();
  await r.clock.runTo(T('14:00:03'));
  r.engine.hold('A');                       // lands at once (before the slow spell)
  assert.equal(row(r, 'A').held, true, 'held on the card at the tap');
  await r.clock.runTo(T('14:00:04'));
  r.engine.resume('A');                     // this send takes 30 s
  assert.equal(row(r, 'A').held, false);
  await r.clock.runTo(T('14:00:05'));
  r.engine.bump(row(r, 'A'));
  assert.equal(row(r, 'A'), undefined);
  await r.clock.runTo(T('14:00:30'));
  assert.deepEqual(r.engine.debug().openWrites, ['A'], 'ONE send of this ticket in flight: the Bump waits for the Resume to end by itself');
  assert.deepEqual(landedOf(r, 'A'), ['held@14:00:03']);
  await r.clock.runTo(T('14:02:00'));
  assert.deepEqual(landedOf(r, 'A'), ['held@14:00:03', 'pending@14:00:33', 'bumped@14:00:34'], 'tap order, each sent once');
  assert.equal(r.world.db.get('A').status, 'bumped');
  assert.equal(r.world.db.get('A').bumped_at, iso('14:00:05'));
  assert.equal(shows(r, 'A', T('14:00:05') + 1, T('14:02:00')).length, 0, 'never painted back');
  assert.deepEqual(r.saved.map((e) => e.kind), ['hold'], 'the Resume was replaced by the Bump before it was confirmed');
});

test('K3: a Hold stuck behind the sign in renewal is never sent after the Bump that replaced it', async () => {
  // No request leaves the tablet from 14:00:02 to 14:03:00.
  const r = rig([{ from: T('14:00:02'), to: T('14:03:00'), kind: 'token' }], { cancelledStillArrive: true });
  r.ticket('A');
  r.engine.start();
  await r.clock.runTo(T('14:00:01'));
  await r.clock.runTo(T('14:00:03'));
  r.engine.hold('A');
  await r.clock.runTo(T('14:00:13'));
  r.engine.bump(row(r, 'A'));
  await r.clock.runTo(T('14:01:17'));
  assert.deepEqual(r.engine.debug().openWrites, ['A']);
  assert.equal(r.engine.debug().lane.entries.A.kind, 'bump');
  assert.equal(r.engine.debug().lane.entries.A.state, 'waiting', 'still behind the Hold send at 74 s');
  await r.clock.runTo(T('14:01:19'));
  assert.equal(r.engine.debug().lane.entries.A.state, 'sending', 'the 75 s valve ended the Hold send; the Bump went');
  await r.clock.runTo(T('14:04:00'));
  assert.deepEqual([...new Set(landedOf(r, 'A').map((x) => x.split('@')[0]))], ['bumped'], 'the Hold never left the tablet');
  assert.equal(r.world.db.get('A').status, 'bumped');
  assert.equal(r.world.db.get('A').bumped_at, iso('14:00:13'));
});

test('K3: through a stuck sign in renewal ONE send of a bump is open at a time, and it lands once', async () => {
  // No request leaves the tablet from 14:00:02 to 14:05:00. Each send is ended by the 75 s valve
  // and the same bump goes again at once. The cancelled send answers a moment AFTER the next one
  // has started: that late answer must not close the new send (it did, and four sends of one bump
  // were open together).
  const sends = [];
  const r = rig([{ from: T('14:00:02'), to: T('14:05:00'), kind: 'token' }], { cancelledStillArrive: true, patchWorld: (world, clock) => {
    const real = world.writeTicket;
    world.writeTicket = (id, body, label, signal) => {
      const rec = { at: clock.now(), body, open: true };
      sends.push(rec);
      return real(id, body, label, signal).then((ans) => { rec.open = false; return ans; });
    };
  } });
  r.ticket('A');
  r.engine.start();
  await r.clock.runTo(T('14:00:01'));
  const a = row(r, 'A');
  await r.clock.runTo(T('14:00:03'));
  r.engine.bump(a);
  let mostOpen = 0;
  for (let t = T('14:00:04'); t <= T('14:04:59'); t += 1000) {
    await r.clock.runTo(t);
    mostOpen = Math.max(mostOpen, sends.filter((x) => x.open).length);
  }
  assert.equal(mostOpen, 1, 'never two sends of one ticket side by side');
  assert.deepEqual(sends.map((x) => clockText(x.at)), ['14:00:03', '14:01:18', '14:02:33', '14:03:48'], 'one send, then the next when the valve ends it');
  for (const x of sends) assert.deepEqual(x.body, { status: 'bumped', bumped_at: iso('14:00:03') }, 'the same body every time');
  assert.equal(r.engine.view().unsavedBumps, 1);
  assert.equal(shows(r, 'A', T('14:00:03') + 1, T('14:04:59')).length, 0, 'hidden all through');
  await r.clock.runTo(T('14:06:00'));
  assert.deepEqual(landedOf(r, 'A'), ['bumped@14:05:00'], 'the renewal landed: the one send still waiting went out, once');
  assert.equal(r.world.db.get('A').bumped_at, iso('14:00:03'));
  assert.deepEqual(r.bumpSaved, [{ id: 'A', how: 'saved' }]);
  assert.equal(r.engine.view().unsavedBumps, 0);
});

test('K3: waking from a short sleep does not send a newer tap beside an older send that is still open', async () => {
  // The Hold's send takes 40 s. The Bump is tapped 2 s later and waits behind it. The tablet's
  // timers then stand still for 15 s. On waking the Hold's send is NOT cancelled to let the Bump
  // go: it had left the tablet, and delivered after the Bump it would leave the ticket held.
  const r = rig([{ from: T('14:00:02'), to: T('14:02:00'), kind: 'slow', readMs: () => 100, writeMs: (t) => (t < T('14:00:04') ? 40000 : 100) }], { cancelledStillArrive: true });
  r.ticket('A');
  r.engine.start();
  await r.clock.runTo(T('14:00:03'));
  r.engine.hold('A');
  await r.clock.runTo(T('14:00:05'));
  r.engine.bump(row(r, 'A'));
  await r.clock.runTo(T('14:00:06'));
  const asleep = r.clock.freeze();
  r.clock.jump(T('14:00:21'));
  r.clock.thaw(asleep);
  await r.clock.runTo(T('14:00:23'));
  assert.deepEqual(r.engine.debug().openWrites, ['A']);
  assert.equal(r.engine.debug().lane.entries.A.kind, 'bump');
  assert.equal(r.engine.debug().lane.entries.A.state, 'waiting', 'the Bump still waits for the Hold to end by itself');
  assert.deepEqual(landedOf(r, 'A'), []);
  await r.clock.runTo(T('14:01:30'));
  const lands = landedOf(r, 'A').map((x) => x.split('@')[0]);
  assert.deepEqual(lands, ['held', 'bumped'], 'tap order');
  assert.equal(r.world.db.get('A').status, 'bumped');
  assert.equal(shows(r, 'A', T('14:00:05') + 1, T('14:01:30')).length, 0, 'never painted back');
});

test('E (K3): Bump then Undo while the bump is on its way: the card is back at the tap and the row ends pending', async () => {
  const r = rig([{ from: T('14:00:02'), to: T('14:02:10'), kind: 'slow', readMs: () => 100, writeMs: (t) => (t < T('14:00:04') ? 50000 : 100) }], { cancelledStillArrive: true });
  r.ticket('A');
  r.engine.start();
  await r.clock.runTo(T('14:00:03'));
  const a = row(r, 'A');
  r.engine.bump(a);
  await r.clock.runTo(T('14:00:05'));
  const viewsBeforeUndo = r.seen.length;    // the views painted up to the tap (the last one is of this same second)
  r.engine.restore(a, 'pending');           // Undo
  assert.ok(row(r, 'A'), 'the card is back at the tap');
  assert.equal(row(r, 'A').status, 'pending');
  await r.clock.runTo(T('14:04:00'));
  assert.deepEqual(landedOf(r, 'A'), ['bumped@14:00:52', 'pending@14:00:53'], 'the restore went only once the bump had ended');
  assert.equal(r.world.db.get('A').status, 'pending');
  assert.equal(r.world.db.get('A').bumped_at, null);
  assert.ok(row(r, 'A'), 'still on the board');
  const after = r.seen.slice(viewsBeforeUndo);
  assert.ok(after.length > 60, 'the board was painted all through the wait');
  assert.equal(after.filter((s) => !s.ids.includes('A')).length, 0, 'on the board in every view after the Undo');
  assert.deepEqual(r.bumpSaved, [], 'an undone bump never runs the auto ready step');
  assert.deepEqual(r.saved.map((e) => e.kind), ['restore'], '"Ticket recalled" is said once, when the database has it');
});

test('K1 Recall last on a slow link: the newest unsaved bump comes back at once, and the row ends pending', async () => {
  // Every write takes 50 s. Staff bump A, then B by mistake, and tap Recall last 8 s later (Undo has gone).
  const r = rig([{ from: T('14:00:02'), to: T('14:03:00'), kind: 'slow', readMs: () => 100, writeMs: () => 50000 }], { cancelledStillArrive: true });
  r.ticket('A'); r.ticket('B'); r.ticket('C');
  r.engine.start();
  await r.clock.runTo(T('14:00:03'));
  assert.equal(r.engine.lastUnsavedBump(), null, 'nothing unsaved: Recall last reads the database, as before');
  r.engine.bump(row(r, 'A'));
  await r.clock.runTo(T('14:00:05'));
  r.engine.bump(row(r, 'B'));
  await r.clock.runTo(T('14:00:13'));
  // The database holds neither as bumped yet, so a read of "the last bumped" could not find B.
  assert.equal(r.world.db.get('A').status, 'pending');
  assert.equal(r.world.db.get('B').status, 'pending');
  const last = r.engine.lastUnsavedBump();
  assert.equal(last.id, 'B');
  r.engine.restore(last);
  assert.ok(row(r, 'B'), 'B is back on the board at the tap');
  assert.equal(row(r, 'A'), undefined, 'A stays bumped');
  assert.equal(r.engine.lastUnsavedBump().id, 'A', 'a second tap would bring back the one before');
  await r.clock.runTo(T('14:03:00'));
  assert.deepEqual(landedOf(r, 'B').map((x) => x.split('@')[0]), ['bumped', 'pending'], 'the restore went once the bump had ended');
  assert.equal(r.world.db.get('B').status, 'pending');
  assert.equal(r.world.db.get('B').bumped_at, null);
  assert.equal(r.world.db.get('A').status, 'bumped');
  assert.ok(row(r, 'B'));
  assert.equal(row(r, 'A'), undefined);
  assert.equal(r.engine.lastUnsavedBump(), null);
  assert.deepEqual(r.saved.map((e) => `${e.kind}:${e.id}`), ['restore:B']);
  assert.deepEqual(r.bumpSaved, [{ id: 'A', how: 'saved' }], 'the recalled bump never ran the auto ready step');
});

test('B (K1, K2): the link is down 12 minutes: hidden, counted, offline, back and marked after 10, one tap saves the FIRST tap', async () => {
  const r = rig([{ from: T('14:00:05'), to: T('14:12:05'), kind: 'dead' }]);
  r.ticket('A'); r.ticket('B');
  r.engine.start();
  await r.clock.runTo(T('14:00:10'));
  r.engine.bump(row(r, 'A'));
  await r.clock.runTo(T('14:00:12'));
  assert.equal(r.engine.view().showSaving, false, 'no header count in the first 3 s');
  await r.clock.runTo(T('14:00:14'));
  assert.equal(r.engine.view().showSaving, true, '"1 bump saving" from 3 s');
  await r.clock.runTo(T('14:09:50'));
  assert.equal(shows(r, 'A', T('14:00:10') + 1, T('14:09:50')).length, 0, 'hidden while it is being tried');
  assert.equal(r.engine.view().unsavedBumps, 1);
  assert.equal(r.engine.view().level, 'offline');
  assert.equal(r.engine.view().sure, false);
  assert.equal(r.gaveUp.length, 0);
  await r.clock.runTo(T('14:11:30'));
  assert.equal(row(r, 'A') && row(r, 'A').unsaved, 'bump', 'back, marked "Bump not saved"');
  assert.equal(r.gaveUp.length, 1);
  assert.equal(r.gaveUp[0].kind, 'bump');
  assert.equal(r.engine.view().failedBumps, 1);
  assert.equal(r.engine.view().unsavedBumps, 0, 'no longer "saving": the card says it');
  await r.clock.runTo(T('14:13:00'));       // the link is back
  r.engine.retryBump('A');                  // the tap on the marked card
  assert.equal(row(r, 'A'), undefined, 'hidden again while the same bump goes');
  await r.clock.runTo(T('14:14:00'));
  assert.equal(r.world.db.get('A').status, 'bumped');
  assert.equal(r.world.db.get('A').bumped_at, iso('14:00:10'), 'the same bump: the first tap time');
  for (const w of r.world.landed) assert.deepEqual(w.body, { status: 'bumped', bumped_at: iso('14:00:10') }, 'every send carried the same body');
  assert.equal(row(r, 'A'), undefined);
  assert.equal(r.engine.view().failedBumps, 0);
});

test('K1 is bounded: a bump that failed and whose ticket another screen bumped is settled by the list, not shown for ever', async () => {
  const r = rig([{ from: T('14:00:05'), to: T('14:12:05'), kind: 'dead' }], { patchWorld: (world) => {
    const real = world.writeTicket;
    // This tablet's writes never land at all (cancelled sends are lost, and so is the rest).
    world.writeTicket = (id, body, label, signal) => (world.block ? new Promise((resolve) => {
      signal.addEventListener('abort', () => resolve({ error: Object.assign(new Error('aborted'), { name: 'AbortError' }), outcome: 'error' }));
    }) : real(id, body, label, signal));
  } });
  r.world.block = true;
  r.ticket('A');
  r.engine.start();
  await r.clock.runTo(T('14:00:02'));
  r.engine.bump(row(r, 'A'));
  await r.clock.runTo(T('14:11:30'));
  assert.equal(row(r, 'A').unsaved, 'bump');
  // The food screen bumps it. The link comes back at 14:12:05 and a list no longer holds it.
  r.world.db.set('A', { ...r.world.db.get('A'), status: 'bumped', bumped_at: iso('14:11:40') });
  await r.clock.runTo(T('14:13:00'));
  assert.equal(row(r, 'A'), undefined);
  assert.equal(r.engine.view().failedBumps, 0);
  assert.deepEqual(r.bumpSaved, [{ id: 'A', how: 'seen' }]);
});

test('K1: a list read sent BEFORE a bump was saved and answered after it cannot paint the ticket back', async () => {
  // reads take 8 s, writes 0.1 s
  const r = rig([{ from: T('14:00:19'), to: T('14:00:40'), kind: 'slow', readMs: () => 8000, writeMs: () => 100 }]);
  r.ticket('A'); r.ticket('B');
  r.engine.start();
  await r.clock.runTo(T('14:00:21'));       // the 14:00:20 poll is in flight (answers 14:00:28)
  r.engine.bump(row(r, 'A'));               // saved at 14:00:21.1
  await r.clock.runTo(T('14:00:22'));
  assert.equal(r.engine.view().unsavedBumps, 0, 'already saved');
  await r.clock.runTo(T('14:01:30'));
  assert.equal(shows(r, 'A', T('14:00:21') + 1, T('14:01:30')).length, 0);
  assert.ok(row(r, 'B'));
});

test('K4: a ticket the live channel added is not wiped by a list read sent before it existed', async () => {
  const r = rig([{ from: T('14:00:19'), to: T('14:00:40'), kind: 'slow', readMs: () => 8000, writeMs: () => 100 }]);
  r.ticket('A');
  r.engine.start();
  await r.clock.runTo(T('14:00:22'));
  // N arrives on the live channel while the 14:00:20 list read is on its way. It is kept out of the
  // fake database until that read has answered, as a list read before the insert would not hold it.
  r.engine.liveInsert({ id: 'N', status: 'pending', centre_id: CENTRE, sent_at: iso('14:00:22'), items: [] });
  assert.ok(row(r, 'N'), 'on the board at once');
  await r.clock.runTo(T('14:00:29'));
  assert.ok(r.world.reads.some((x) => x.at > T('14:00:22') && !x.ids.includes('N')), 'the older list really did come back without N');
  assert.ok(row(r, 'N'), 'N stays after the older list was painted');
  r.ticket('N', T('14:00:22'));
  await r.clock.runTo(T('14:01:30'));
  assert.ok(row(r, 'N'));
});

test('K4: a late list answer is USED, and one from a read that started before a list already used is not', async () => {
  // The 14:00:20 read takes 25 s. The 14:00:40 read (started beside it, the first is 20 s old) takes 0.1 s.
  const r = rig([{ from: T('14:00:19'), to: T('14:00:21'), kind: 'slow', readMs: () => 25000, writeMs: () => 100 }]);
  r.ticket('A');
  r.engine.start();
  await r.clock.runTo(T('14:00:30'));
  assert.equal(r.engine.view().level, 'slow', 'a read open over 5 s');
  r.ticket('N');                            // sent at 14:00:30
  await r.clock.runTo(T('14:00:39'));
  assert.equal(row(r, 'N'), undefined);
  await r.clock.runTo(T('14:00:41'));
  assert.ok(row(r, 'N'), 'on screen by the second read, started while the first was still open');
  // The old read answers at 14:00:45 with a snapshot that does hold N (it reached the database late).
  // Remove N from the database view of that old answer by bumping N here first.
  r.engine.bump(row(r, 'N'));
  await r.clock.runTo(T('14:00:46'));
  assert.equal(r.engine.debug().openReads.length, 0);
  assert.equal(row(r, 'N'), undefined, 'the stale answer did not paint it back');
  assert.ok(row(r, 'A'));

  // One slow read by itself, nothing newer used: its answer IS used though it took 25 s (the old code threw it away at 15 s).
  const one = rig([{ from: T('14:00:19'), to: T('14:00:21'), kind: 'slow', readMs: () => 25000, writeMs: () => 100 }], { patchWorld: (world, clock) => {
    const real = world.readList;
    // The link drops every read sent after 14:00:21, so only the slow one can answer.
    world.readList = (o) => (clock.now() > T('14:00:21') ? Promise.resolve({ error: { message: 'TypeError: Load failed' } }) : real(o));
  } });
  one.engine.start();
  await one.clock.runTo(T('14:00:10'));
  one.ticket('L');
  await one.clock.runTo(T('14:00:44'));
  assert.equal(row(one, 'L'), undefined);
  await one.clock.runTo(T('14:00:46'));
  assert.ok(row(one, 'L'), 'the 25 s old answer put the ticket on the screen');
});

test('K2: the bump reached the database but its answer never came: a later list proves it, and it is not sent for ever', async () => {
  const r = rig([], { patchWorld: (world) => {
    const real = world.writeTicket;
    let first = true;
    world.writeTicket = (id, body, label, signal) => {
      if (!first) return real(id, body, label, signal);
      first = false;
      real(id, body, label, signal);          // it lands
      return new Promise((resolve) => { signal.addEventListener('abort', () => resolve({ error: Object.assign(new Error('aborted'), { name: 'AbortError' }), outcome: 'error' })); });
    };
  } });
  r.ticket('A'); r.ticket('B');
  r.engine.start();
  await r.clock.runTo(T('14:00:03'));
  r.engine.bump(row(r, 'A'));
  await r.clock.runTo(T('14:00:19'));
  assert.equal(r.engine.view().unsavedBumps, 1);
  assert.equal(r.engine.view().level, 'slow', 'a bump unsaved over 10 s');
  await r.clock.runTo(T('14:00:25'));       // the 14:00:20 poll does not hold A
  assert.equal(r.engine.view().unsavedBumps, 0, 'settled by the list');
  await r.clock.runTo(T('14:02:00'));
  assert.equal(r.world.landed.filter((w) => w.id === 'A').length, 1, 'sent once');
  assert.deepEqual(r.bumpSaved, [{ id: 'A', how: 'seen' }]);
  assert.equal(shows(r, 'A', T('14:00:03') + 1, T('14:02:00')).length, 0);
});

test('K2: the live echo of this very bump settles it too, and the Recall last button is told', async () => {
  const r = rig([{ from: T('14:00:02'), to: T('14:05:00'), kind: 'dead' }]);
  r.ticket('A');
  r.engine.start();
  await r.clock.runTo(T('14:00:01'));
  await r.clock.runTo(T('14:00:03'));
  r.engine.bump(row(r, 'A'));
  await r.clock.runTo(T('14:00:08'));
  // Another screen's bump of the same ticket (another instant) does not settle ours, but the ticket stays gone.
  r.engine.liveUpdate({ id: 'A', status: 'bumped', bumped_at: iso('14:00:06'), centre_id: CENTRE, sent_at: iso('14:00:00'), items: [] });
  assert.equal(r.engine.view().unsavedBumps, 1);
  assert.equal(row(r, 'A'), undefined);
  r.engine.liveUpdate({ id: 'A', status: 'bumped', bumped_at: '2026-10-12T14:00:03+00:00', centre_id: CENTRE, sent_at: iso('14:00:00'), items: [] });
  assert.equal(r.engine.view().unsavedBumps, 0);
  assert.deepEqual(r.bumpSaved, [{ id: 'A', how: 'seen' }]);
  assert.deepEqual(r.bumpedLive, ['A', 'A']);
  // A bumped echo for another station is taken off the board but does not light Recall last here.
  r.engine.liveUpdate({ id: 'Z', status: 'bumped', bumped_at: iso('14:00:06'), centre_id: 'pc-food', sent_at: iso('14:00:00'), items: [] });
  assert.deepEqual(r.bumpedLive, ['A', 'A']);
});

test('K2: a write the device link fence kept (parked) is done here; a row that is gone is saved without the auto ready step', async () => {
  const outcomes = { A: 'parked', B: 'queued', C: 'gone', D: 'skipped', E: 'unlinked' };
  const sends = {};
  const r = rig([], { patchWorld: (world) => {
    world.writeTicket = async (id) => { sends[id] = (sends[id] || 0) + 1; return { error: null, outcome: outcomes[id] }; };
  } });
  for (const id of Object.keys(outcomes)) r.ticket(id);
  r.engine.start();
  await r.clock.runTo(T('14:00:01'));
  for (const id of Object.keys(outcomes)) r.engine.bump(row(r, id));
  await r.clock.runTo(T('14:00:02'));
  assert.deepEqual(Object.keys(r.engine.debug().lane.entries), ['E'], 'kept and gone are done; "unlinked" is not saved');
  assert.deepEqual(r.bumpSaved, [], 'only a bump that changed a row runs the auto ready step');
  await r.clock.runTo(T('14:00:30'));
  assert.deepEqual([sends.A, sends.B, sends.C, sends.D], [1, 1, 1, 1], 'never sent twice');
  assert.ok(sends.E >= 4, 'sent again with short waits');
});

test('restart (K1, K2): an unsaved bump is still hidden and still sent after the app restarts', async () => {
  const r = rig([{ from: T('14:00:05'), to: T('14:03:00'), kind: 'dead' }]);
  r.ticket('A'); r.ticket('B');
  r.engine.start();
  await r.clock.runTo(T('14:00:10'));
  r.engine.bump(row(r, 'A'));
  r.engine.hold('B');
  await r.clock.runTo(T('14:01:00'));
  assert.deepEqual(JSON.parse(r.storage.text).entries.map((e) => e.id), ['A'], 'the journal holds the bump, not the hold');
  r.restart();
  assert.equal(r.engine.view().unsavedBumps, 1, 'known again before any list is in');
  await r.clock.runTo(T('14:04:00'));
  assert.equal(shows(r, 'A', T('14:00:10') + 1, T('14:04:00')).length, 0, 'A never came back, before or after the restart');
  assert.equal(r.world.db.get('A').status, 'bumped');
  assert.equal(r.world.db.get('A').bumped_at, iso('14:00:10'));
  assert.deepEqual(JSON.parse(r.storage.text).entries, [], 'forgotten once saved');
});

test('restart: a bump over 10 minutes old at the start comes back on its card; a tap sends the same bump', async () => {
  const r = rig([]);
  r.ticket('A', T('13:40:00'));
  r.storage.text = JSON.stringify({ v: 1, entries: [{
    id: 'A', body: { status: 'bumped', bumped_at: iso('13:45:00') }, at: T('13:45:00'), since: T('13:45:00'), centreId: CENTRE, failed: false,
    row: mapTestRow({ id: 'A', status: 'pending', centre_id: CENTRE, sent_at: iso('13:40:00'), items: [] }),
  }] });
  r.engine.start();
  await r.clock.runTo(T('14:00:02'));
  assert.equal(row(r, 'A').unsaved, 'bump');
  assert.equal(r.world.landed.length, 0, 'not sent by itself');
  r.engine.retryBump('A');
  await r.clock.runTo(T('14:00:03'));
  assert.equal(r.world.db.get('A').bumped_at, iso('13:45:00'));
  assert.equal(row(r, 'A'), undefined);
});

test('K10 healthy link: 15 list reads in 5 minutes, one write per tap, never a banner, never a header count', async () => {
  const r = rig([]);
  r.engine.start();
  assert.equal(r.engine.view().sure, false, 'not sure before the first list');
  assert.equal(r.engine.view().everApplied, false);
  await r.clock.runTo(T('14:00:01'));
  assert.equal(r.engine.view().sure, true);
  r.ticket('A'); r.ticket('B'); r.ticket('C');
  await r.clock.runTo(T('14:00:21'));
  r.engine.bump(row(r, 'A'));
  r.engine.hold('B');
  await r.clock.runTo(T('14:00:41'));
  r.engine.resume('B');
  const c = row(r, 'C');
  r.engine.bump(c);
  await r.clock.runTo(T('14:00:43'));
  r.engine.restore(c, 'pending');            // Undo
  await r.clock.runTo(T('14:05:00'));
  assert.equal(r.world.reads.length, 15, `list reads answered in 5 minutes: ${r.world.reads.length}`);   // 14:00:00, then every 20 s to 14:04:40
  assert.deepEqual(r.world.landed.map((w) => `${w.id}:${w.body.status}`), ['A:bumped', 'B:held', 'B:pending', 'C:bumped', 'C:pending'], 'one write per tap, in order');
  assert.equal(r.seen.filter((s) => s.level !== 'ok').length, 0, 'never a banner');
  assert.equal(r.seen.filter((s) => s.showSaving).length, 0, 'never a header count');
  assert.equal(r.engine.view().showSaving, false);
  assert.equal(r.engine.view().sure, true);
  assert.deepEqual(r.engine.view().rows.map((x) => x.id).sort(), ['B', 'C']);
  assert.deepEqual(r.spells, [], 'no trace on a healthy day');
  assert.deepEqual(r.bumpSaved, [{ id: 'A', how: 'saved' }, { id: 'C', how: 'saved' }]);
  assert.equal(r.applied.length, 15, 'every list was used');
});

test('K10: the rows array is the same object while nothing changed, so cards do not re-render every second', async () => {
  const r = rig([]);
  r.ticket('A');
  r.engine.start();
  await r.clock.runTo(T('14:00:01'));
  const first = r.engine.view().rows;
  await r.clock.runTo(T('14:00:19'));
  assert.equal(r.engine.view().rows, first);
  r.engine.patchRow('A', { items: [{ _bumped: true }] });
  assert.notEqual(r.engine.view().rows, first);
  assert.deepEqual(row(r, 'A').items, [{ _bumped: true }]);
  r.engine.patchRow('nope', { items: [] });
  assert.equal(row(r, 'nope'), undefined, 'a patch never adds a ticket');
});

test('K5: one failed list read says slow, two in a row say offline, and only a list that was USED clears it', async () => {
  const r = rig([], { patchWorld: (world, clock) => {
    const real = world.readList;
    world.readList = (o) => ((clock.now() >= T('14:00:19') && clock.now() < T('14:00:29')) ? Promise.resolve({ error: { message: 'TypeError: Load failed' } }) : real(o));
  } });
  r.ticket('A');
  r.engine.start();
  await r.clock.runTo(T('14:00:19'));
  assert.equal(r.engine.view().level, 'ok');
  await r.clock.runTo(T('14:00:21'));        // the 14:00:20 poll failed
  assert.equal(r.engine.view().level, 'slow');
  await r.clock.runTo(T('14:00:26'));        // asked again 5 s later (14:00:25), not at the next poll: failed again
  assert.equal(r.engine.view().level, 'offline');
  assert.equal(r.engine.view().sure, false);
  assert.ok(row(r, 'A'), 'what is on screen stays');
  await r.clock.runTo(T('14:00:31'));        // 14:00:30: a list is used
  assert.equal(r.engine.view().level, 'slow', 'one good list does not clear it yet');
  await r.clock.runTo(T('14:00:51'));        // the second good list
  assert.equal(r.engine.view().level, 'ok');
});

test('K4, K5: a list answer that cannot be trusted (undefined) is not used, clears no warning, and confirms no bump', async () => {
  let unsure = false;
  const r = rig([], { patchWorld: (world, clock) => {
    const real = world.readList;
    world.readList = (o) => {
      if (clock.now() >= T('14:00:19') && clock.now() < T('14:00:24')) return Promise.resolve({ error: { message: 'TypeError: Load failed' } });
      // An empty list while the device link is unsure: KDSSurface readList answers undefined (lib/deviceFence.js trustSharedRead).
      return unsure ? real(o).then(() => undefined) : real(o);
    };
    const realWrite = world.writeTicket;
    world.writeTicket = (id, body, label, signal) => (unsure ? new Promise(() => {}) : realWrite(id, body, label, signal));
  } });
  r.ticket('A');
  r.engine.start();
  await r.clock.runTo(T('14:00:21'));
  assert.equal(r.engine.view().level, 'slow');
  unsure = true;
  r.engine.bump(row(r, 'A'));
  await r.clock.runTo(T('14:01:21'));
  assert.equal(r.engine.view().level, 'slow', 'reads that came back but were not used cleared nothing');
  assert.equal(r.engine.view().unsavedBumps, 1, 'and they did not "prove" the bump saved');
  assert.equal(r.applied.filter((a) => a.at > T('14:00:21')).length, 0);
  assert.equal(r.engine.view().sure, false);
});

test('K2 give up: a Hold that cannot be saved for 10 minutes is dropped with a message, and the board shows the database', async () => {
  const r = rig([{ from: T('14:00:05'), to: T('14:30:00'), kind: 'dead' }]);
  r.ticket('A');
  r.engine.start();
  await r.clock.runTo(T('14:00:10'));
  r.engine.hold('A');
  assert.equal(row(r, 'A').held, true);
  await r.clock.runTo(T('14:09:00'));
  assert.equal(row(r, 'A').held, true);
  assert.equal(r.engine.view().unsavedOthers, 1);
  await r.clock.runTo(T('14:11:30'));
  assert.deepEqual(r.gaveUp.map((e) => e.kind), ['hold']);
  assert.equal(row(r, 'A').held, false, 'what the database holds');
  assert.equal(r.engine.view().unsavedOthers, 0);
});

test('K2 limitedWrite (item ticks, notes): counted on the board, cancelled at 75 s, the same send up to three times', async () => {
  const r = rig([]);
  r.engine.start();
  await r.clock.runTo(T('14:00:01'));
  const calls = [];
  // Never answers: only the cancel ends it.
  const hang = (signal) => { calls.push({ at: r.clock.now(), signal }); return new Promise(() => {}); };
  let wanted = true;
  let result = null;
  r.engine.limitedWrite('tick:A', hang, { tries: 3, stillWanted: () => wanted }).then((x) => { result = x; });
  await r.clock.runTo(T('14:00:03'));
  assert.equal(r.engine.view().unsavedOthers, 1);
  assert.equal(r.engine.view().showSaving, false);
  await r.clock.runTo(T('14:00:07'));
  assert.equal(r.engine.view().showSaving, true, '"1 change saving" after 3 s');
  assert.equal(r.engine.view().level, 'slow', 'a write open over 5 s');
  await r.clock.runTo(T('14:01:17'));
  assert.equal(calls.length, 2, 'the first send was cancelled at 75 s and the second went at once');
  assert.equal(calls[0].signal.aborted, true);
  assert.equal(calls[1].at, T('14:01:16'));
  wanted = false;                            // a newer tap took over this ticket
  await r.clock.runTo(T('14:02:32'));
  assert.equal(calls.length, 2, 'no third send');
  assert.equal(result.error.code, 'TIMEOUT');
  assert.equal(r.engine.view().unsavedOthers, 0);

  // A fast failure waits 1 s then 2 s; a good answer stops the repeats; a throw is an error, not a crash.
  const fails = [];
  const out = r.engine.limitedWrite('tick:B', async () => { fails.push(r.clock.now()); return fails.length < 3 ? { error: new Error('no'), outcome: 'error' } : { error: null, outcome: 'applied' }; }, { tries: 3 });
  await r.clock.runTo(T('14:02:40'));
  assert.deepEqual(fails.map((t) => t - fails[0]), [0, 1000, 3000]);
  assert.deepEqual(await out, { error: null, outcome: 'applied' });
  const once = r.engine.limitedWrite('note:C', () => { throw new Error('boom'); });
  await r.clock.runTo(T('14:02:41'));
  assert.equal((await once).error.message, 'boom');
});

test('the tablet sleeps for an hour and wakes: no warning on a healthy link, and the list is read at once', async () => {
  const r = rig([]);
  r.ticket('A');
  r.engine.start();
  await r.clock.runTo(T('14:00:30'));
  const before = r.world.reads.length;
  // Asleep: no timer runs. Jump the clock, then the timers all come due at once, as on waking.
  const sleepTimers = r.clock.freeze();
  r.clock.jump(T('15:00:30'));
  r.ticket('B');
  r.clock.thaw(sleepTimers);
  await r.clock.runTo(T('15:00:32'));
  assert.equal(r.seen.filter((s) => s.level !== 'ok').length, 0, 'never a banner');
  assert.ok(r.world.reads.length > before, 'read again on waking');
  assert.ok(row(r, 'B'), 'the ticket sent during the sleep is on the board');
  assert.equal(r.engine.view().sure, true);
});

test('an unsaved bump survives a sleep: the sleep does not count toward giving up, and it is saved with the tap time', async () => {
  const r = rig([{ from: T('14:00:05'), to: T('14:00:40'), kind: 'dead' }]);
  r.ticket('A');
  r.engine.start();
  await r.clock.runTo(T('14:00:10'));
  r.engine.bump(row(r, 'A'));
  await r.clock.runTo(T('14:00:12'));
  const sleepTimers = r.clock.freeze();
  r.clock.jump(T('14:30:00'));
  r.clock.thaw(sleepTimers);
  await r.clock.runTo(T('14:30:05'));
  assert.equal(r.gaveUp.length, 0, 'half an hour asleep is not ten minutes of trying');
  assert.equal(r.world.db.get('A').status, 'bumped');
  assert.equal(r.world.db.get('A').bumped_at, iso('14:00:10'));
  assert.equal(shows(r, 'A', T('14:00:10') + 1, T('14:30:05')).length, 0);
  assert.equal(r.engine.view().unsavedBumps, 0);
});

test('a send that never ends across a long sleep is ended by the valve at the first look, and the bump goes again', async () => {
  let hang = true;
  const sends = [];
  const r = rig([], { patchWorld: (world, clock) => {
    const real = world.writeTicket;
    // The first send never answers and never fails (its connection died while the tablet slept).
    world.writeTicket = (id, body, label, signal) => {
      sends.push(clock.now());
      if (!hang) return real(id, body, label, signal);
      hang = false;
      return new Promise((resolve) => { signal.addEventListener('abort', () => resolve({ error: Object.assign(new Error('aborted'), { name: 'AbortError' }), outcome: 'error' })); });
    };
  } });
  r.ticket('A');
  r.engine.start();
  await r.clock.runTo(T('14:00:10'));
  r.engine.bump(row(r, 'A'));
  await r.clock.runTo(T('14:00:12'));
  // The list still holds the ticket as waiting on the wake, so only the write itself can settle the bump.
  const asleep = r.clock.freeze();
  r.clock.jump(T('14:20:00'));
  r.clock.thaw(asleep);
  await r.clock.runTo(T('14:20:02'));
  assert.deepEqual(sends.map(clockText), ['14:00:10', '14:20:00'], 'sent again at the wake, not ten minutes of waiting');
  assert.equal(r.gaveUp.length, 0);
  assert.equal(r.world.db.get('A').bumped_at, iso('14:00:10'));
  assert.equal(shows(r, 'A', T('14:00:10') + 1, T('14:20:02')).length, 0);
});

test('K9: one trace for one spell, written five minutes after the screen is healthy again', async () => {
  const r = rig([{ from: T('14:00:05'), to: T('14:03:00'), kind: 'dead' }]);
  r.ticket('A');
  r.engine.start();
  await r.clock.runTo(T('14:00:10'));
  r.engine.bump(row(r, 'A'));
  await r.clock.runTo(T('14:08:00'));
  assert.equal(r.engine.view().level, 'ok');
  assert.deepEqual(r.spells, [], 'not yet: a new spell inside five minutes would be the same spell');
  await r.clock.runTo(T('14:20:00'));
  assert.equal(r.spells.length, 1);
  const s = r.spells[0];
  assert.equal(s.wentOffline, true);
  assert.equal(s.lateBumps, 1);
  assert.ok(s.worstLateMs >= 170000 && s.worstLateMs <= 175000, `the bump waited ${s.worstLateMs} ms`);
  assert.ok(s.durationMs >= 170000 && s.durationMs <= 240000, `the spell lasted ${s.durationMs} ms`);
});

test('stop(): no timer is left behind, and an answer that arrives afterwards changes nothing', async () => {
  const r = rig([{ from: T('14:00:02'), to: T('14:01:00'), kind: 'slow', readMs: () => 100, writeMs: () => 30000 }]);
  r.ticket('A');
  r.engine.start();
  await r.clock.runTo(T('14:00:03'));
  r.engine.bump(row(r, 'A'));
  await r.clock.runTo(T('14:00:04'));
  const painted = r.seen.length;
  r.engine.stop();
  assert.equal(r.liveTimers, 0, 'poll, beat and retry timers are all cleared');
  await r.clock.runTo(T('14:02:00'));
  assert.equal(r.liveTimers, 0);
  assert.equal(r.seen.length, painted, 'a stopped engine paints nothing');
  assert.equal(r.world.db.get('A').status, 'bumped', 'the bump already on its way still landed');
  assert.deepEqual(JSON.parse(r.storage.text).entries.map((e) => e.id), ['A'], 'and it is still in the journal for the next start');
  r.engine.bump({ id: 'B' });
  r.engine.load();
  r.engine.tick();
  assert.equal(r.liveTimers, 0);
});
