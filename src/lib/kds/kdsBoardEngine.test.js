// 12 Oct 2026, Coffee Boy Barnsley: the hunters' reproductions, one by one, on the REAL board engine
// (lib/kds/kdsBoardEngine.js) with a fake link and a virtual clock (kdsSlowLinkWorld.js). Each one
// failed on the build of that day: a bumped ticket painted back, a bump lost, a late Hold landing
// after a Bump, new tickets held back, a warning cleared by a read that was thrown away.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeClock, makeWorld, makeAbortFactory, mapTestRow, T, clockText } from './kdsSlowLinkWorld.js';
import { createBoardEngine } from './kdsBoardEngine.js';

const CENTRE = 'pc-drinks';

function rig(spells = [], { patchWorld, centreId = CENTRE, ...link } = {}) {
  const clock = makeClock(T('14:00:00'));
  // link: cancelledStillArrive, scramble, listBackMs, clientRepeat (kdsSlowLinkWorld.js makeWorld)
  const world = makeWorld(clock, spells, link);
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
  // Review 12 Oct 2026: its answer said the database has it, so it left the journal. Kept there, the
  // next start wrote the same bump a second time (and bumped again a ticket recalled in between).
  assert.deepEqual(JSON.parse(r.storage.text).entries.map((e) => e.id), [], 'answered: no longer in the journal for the next start');
  r.engine.bump({ id: 'B' });
  r.engine.load();
  r.engine.tick();
  assert.equal(r.liveTimers, 0);
});

// ── review of the build, 12 Oct 2026 ────────────────────────────────────────────────────────────
// Three reviewers ran the real engine with links the first tests did not have: a burst that lands
// out of order, a live echo that arrives late, two list reads that overlap, a row the board cannot
// map, a restart in the middle of an Undo. Each test below failed on the build as first written.

const DEAD = [{ from: T('14:01:00'), to: T('14:05:00'), kind: 'dead' }];
const holdThenBump = async (r) => {
  r.ticket('X', T('13:59:00'));
  r.engine.start();
  await r.clock.runTo(T('14:01:05'));
  r.engine.hold('X');
  await r.clock.runTo(T('14:02:25'));
  r.engine.bump(row(r, 'X'));
  await r.clock.runTo(T('14:08:00'));
};
const bumpThenUndo = async (r) => {
  r.ticket('X', T('13:59:00'));
  r.engine.start();
  await r.clock.runTo(T('14:01:05'));
  const x = row(r, 'X');
  r.engine.bump(x);
  await r.clock.runTo(T('14:01:08'));
  r.engine.restore(x, 'pending');
  await r.clock.runTo(T('14:08:00'));
};

test('K3 scrambled burst: a Hold the network gave up on lands AFTER the Bump and changes nothing', async () => {
  // Nothing gets through from 14:01 to 14:05. Every request sent in that time (also the ones the
  // tablet's network gave up on after 60 s) is delivered together at 14:05, the newest first.
  const r = rig(DEAD, { scramble: 'reverse' });
  await holdThenBump(r);
  const order = r.world.landed.concat(r.world.refused).filter((w) => w.id === 'X').sort((a, b) => a.at - b.at).map((w) => w.body.status);
  assert.equal(order[0], 'bumped', 'the bump reached the database first');
  assert.ok(order.lastIndexOf('held') > order.indexOf('bumped'), 'and a Hold reached it afterwards');
  assert.ok(r.world.refused.some((w) => w.body.status === 'held'), 'the late Hold was refused by its guard');
  assert.equal(r.world.db.get('X').status, 'bumped', 'the last tap wins');
  assert.equal(r.world.db.get('X').bumped_at, iso('14:02:25'));
  assert.equal(shows(r, 'X', T('14:02:25') + 1, T('14:08:00')).length, 0, 'never painted back, held or not');
});

test('K3 scrambled burst: an Undo that lands BEFORE its bump is sent again when that bump shows up, and the card never leaves', async () => {
  const r = rig(DEAD, { scramble: 'reverse' });
  await bumpThenUndo(r);
  const lands = landedOf(r, 'X').map((x) => x.split('@')[0]);
  assert.equal(lands[0], 'bumped', 'the recalls reached the database before the bump and changed nothing');
  assert.ok(r.world.refused.some((w) => w.body.bumped_at === null), 'refused: the row did not hold that bump yet');
  assert.equal(lands[lands.length - 1], 'pending', 'then the bump landed, and the same recall undid it');
  assert.equal(r.world.db.get('X').status, 'pending', 'the last tap wins');
  assert.equal(r.world.db.get('X').bumped_at, null);
  const after = r.seen.filter((s) => s.at > T('14:01:08'));
  assert.ok(after.length > 100);
  assert.equal(after.filter((s) => !s.ids.includes('X')).length, 0, 'on the board in every view after the Undo');
  assert.deepEqual(r.bumpSaved, [], 'an undone bump never runs the auto ready step');
  assert.equal(r.saved.filter((e) => e.kind === 'restore').length, 1, '"Ticket recalled" is said once, not again for the watch');
});

test('K3 scrambled burst, 60 different orders: the last tap always wins', async () => {
  for (let seed = 1; seed <= 60; seed += 1) {
    const a = rig(DEAD, { scramble: seed, cancelledStillArrive: true });
    await holdThenBump(a);
    assert.equal(a.world.db.get('X').status, 'bumped', `Hold then Bump, order ${seed}: ${landedOf(a, 'X')}`);
    assert.equal(shows(a, 'X', T('14:02:25') + 1, T('14:08:00')).length, 0, `Hold then Bump, order ${seed}: painted back`);
    const b = rig(DEAD, { scramble: seed, cancelledStillArrive: true });
    await bumpThenUndo(b);
    assert.equal(b.world.db.get('X').status, 'pending', `Bump then Undo, order ${seed}: ${landedOf(b, 'X')}`);
    assert.ok(row(b, 'X'), `Bump then Undo, order ${seed}: the card is on the board at the end`);
    assert.equal(b.seen.filter((s) => s.at > T('14:01:08') && !s.ids.includes('X')).length, 0, `Bump then Undo, order ${seed}: the card left the board`);
  }
});

test('K3: an Undo that lands after a NEWER bump of the same ticket changes nothing', async () => {
  // Bump, Undo, Bump again, all inside the stall. Delivered newest first: the second bump, then the
  // Undo of the FIRST bump. Its guard names the first bump, so it cannot un bump the second.
  const r = rig(DEAD, { scramble: 'reverse' });
  r.ticket('X', T('13:59:00'));
  r.engine.start();
  await r.clock.runTo(T('14:01:05'));
  const x = row(r, 'X');
  r.engine.bump(x);
  await r.clock.runTo(T('14:01:08'));
  r.engine.restore(x, 'pending');
  await r.clock.runTo(T('14:02:30'));
  r.engine.bump(row(r, 'X'));
  await r.clock.runTo(T('14:08:00'));
  assert.equal(r.world.db.get('X').status, 'bumped');
  assert.equal(shows(r, 'X', T('14:02:30') + 1, T('14:08:00')).length, 0, 'never painted back after the last Bump');
  assert.deepEqual(r.engine.debug().undone, [], 'the last tap is a bump: nothing of this ticket is brought back any more');
});

test('the guards: Hold and Resume never touch a bumped ticket, a recall only undoes the bump it names', async () => {
  const guards = [];
  const r = rig([], { patchWorld: (world) => {
    const real = world.writeTicket;
    world.writeTicket = (id, body, label, signal, guard) => { guards.push({ id, body, guard }); return real(id, body, label, signal, guard); };
  } });
  r.ticket('A'); r.ticket('B'); r.ticket('C');
  r.engine.start();
  await r.clock.runTo(T('14:00:01'));
  r.engine.hold('A');
  await r.clock.runTo(T('14:00:02'));
  r.engine.resume('A');
  const b = row(r, 'B');
  r.engine.bump(b);
  await r.clock.runTo(T('14:00:03'));
  r.engine.restore(b, 'pending');                        // Undo of this screen's own bump
  await r.clock.runTo(T('14:00:04'));
  // Recall last / History: a row read from the database as bumped by another screen.
  r.world.db.set('C', { ...r.world.db.get('C'), status: 'bumped', bumped_at: iso('13:59:30') });
  r.engine.restore(mapTestRow(r.world.db.get('C')), 'pending');
  await r.clock.runTo(T('14:00:05'));
  assert.deepEqual(guards.map((g) => `${g.id} ${g.body.status} ${JSON.stringify(g.guard)}`), [
    'A held {"notMatch":{"status":"bumped"}}',
    'A pending {"notMatch":{"status":"bumped"}}',
    'B bumped null',
    `B pending {"match":{"bumped_at":"${iso('14:00:02')}"}}`,
    `C pending {"match":{"bumped_at":"${iso('13:59:30')}"}}`,
  ]);
  assert.equal(r.world.refused.length, 0, 'on a healthy link every guard lets its write through');
  assert.equal(r.world.db.get('B').status, 'pending');
  assert.equal(r.world.db.get('C').status, 'pending');
  assert.deepEqual(r.engine.debug().undone, [], 'no watch on a healthy link: every bump was answered');
});

test('a Hold the database refuses (another screen bumped the ticket) takes the card off, and a recall of another screen\'s newer bump stands down', async () => {
  const r = rig([]);
  r.ticket('A'); r.ticket('B');
  r.engine.start();
  await r.clock.runTo(T('14:00:01'));
  // The food screen bumps A; this screen's live channel is down, so it still shows A.
  r.world.db.set('A', { ...r.world.db.get('A'), status: 'bumped', bumped_at: iso('14:00:01') });
  r.engine.hold('A');
  assert.equal(row(r, 'A').held, true, 'held on the card at the tap');
  await r.clock.runTo(T('14:00:02'));
  assert.equal(row(r, 'A'), undefined, 'the database said it is bumped: off the board');
  assert.equal(r.world.db.get('A').status, 'bumped', 'never un bumped by a Hold');
  // This screen bumps B (saved); another screen then bumps it again at another instant; Undo here.
  const b = row(r, 'B');
  r.engine.bump(b);
  await r.clock.runTo(T('14:00:03'));
  r.world.db.set('B', { ...r.world.db.get('B'), bumped_at: new Date(T('14:00:02') + 700).toISOString() });
  r.engine.restore(b, 'pending');
  await r.clock.runTo(T('14:00:30'));
  assert.equal(r.world.db.get('B').status, 'bumped', 'the other screen\'s bump stands');
  assert.equal(row(r, 'B'), undefined, 'and the next list took the card off again');
});

test('K1: a bump that is SAVED is not painted back by the late live echo of an older write of the ticket', async () => {
  const reads0 = [];
  const r = rig([], { patchWorld: (world) => { const real = world.readList; world.readList = (o) => { reads0.push(1); return real(o); }; } });
  r.ticket('A'); r.ticket('B');
  r.engine.start();
  await r.clock.runTo(T('14:00:05'));
  const tickEcho = { ...r.world.db.get('A'), items: [{ name: 'Latte', _bumped: true }] };   // the row as an item tick left it: pending
  r.engine.bump(row(r, 'A'));
  await r.clock.runTo(T('14:00:06'));
  assert.equal(r.engine.view().unsavedBumps, 0, 'the bump is saved');
  const before = reads0.length;
  r.engine.liveUpdate(tickEcho);                          // the tick's echo arrives after the bump's answer
  r.engine.liveInsert(tickEcho);                          // and so does a late INSERT echo
  assert.equal(row(r, 'A'), undefined, 'not painted');
  await r.clock.runTo(T('14:00:07'));
  assert.ok(reads0.length > before, 'a list read sent now decides instead');
  await r.clock.runTo(T('14:00:45'));
  assert.equal(shows(r, 'A', T('14:00:05') + 1, T('14:00:45')).length, 0, 'A never came back');
  assert.ok(row(r, 'B'));
  // A REAL recall on another screen: its echo is not painted either, the list it asks for is.
  r.world.db.set('A', { ...r.world.db.get('A'), status: 'pending', bumped_at: null });
  r.engine.liveUpdate({ ...r.world.db.get('A') });
  assert.equal(row(r, 'A'), undefined);
  await r.clock.runTo(T('14:00:46'));
  assert.ok(row(r, 'A'), 'back within one list read');
  // From then on the ticket is live again: a later change of it paints at once.
  r.engine.liveUpdate({ ...r.world.db.get('A'), status: 'held' });
  assert.equal(row(r, 'A').held, true);
});

test('K4: two list reads overlap and the older snapshot answers last: no order leaves the screen, and a fresh read settles it at once', async () => {
  // Read 2 (sent 14:00:20) sits on the tablet 26 s and is then answered at once: the NEWER snapshot.
  // Read 3 (sent 14:00:40, beside it) reaches the database at once and its answer comes back 10 s
  // later: the OLDER snapshot, used last.
  const clock = makeClock(T('14:00:00'));
  const db = new Map();
  const snap = () => [...db.values()].filter((x) => x.status === 'pending').map((x) => ({ ...x }));
  const add = (id) => db.set(id, { id, status: 'pending', bumped_at: null, centre_id: CENTRE, sent_at: new Date(clock.now()).toISOString(), items: [] });
  const plan = [
    { reach: T('14:00:00') + 50, answer: T('14:00:00') + 100 },
    { reach: T('14:00:46'), answer: T('14:00:46') + 100 },
    { reach: T('14:00:40') + 50, answer: T('14:00:50') },
  ];
  let k = 0;
  const started = [];
  const readList = () => new Promise((resolve) => {
    const p = plan[k] || { reach: clock.now() + 50, answer: clock.now() + 100 };
    k += 1;
    started.push(clock.now());
    let data = null;
    clock.setTimer(() => { data = snap(); }, p.reach - clock.now());
    clock.setTimer(() => resolve({ data }), p.answer - clock.now());
  });
  const paints = [];
  let engine = null;
  engine = createBoardEngine({
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, makeAbort: makeAbortFactory(),
    readList, writeTicket: async () => ({ error: null, outcome: 'applied' }), mapRow: mapTestRow, centreId: CENTRE,
    journal: { load: () => null, save: () => {} },
    onChange: () => paints.push({ at: clock.now(), ids: engine.view().rows.map((x) => x.id).sort().join('') }),
  });
  add('A');
  engine.start();
  clock.setTimer(() => add('B'), 5000);
  // 14:00:44: the till sends C and another screen bumps A (this screen's live channel is down).
  clock.setTimer(() => { add('C'); db.set('A', { ...db.get('A'), status: 'bumped' }); }, 44000);
  await clock.runTo(T('14:01:10'));
  engine.stop();
  const at = (hms) => paints.filter((p) => p.at <= T(hms)).pop().ids;
  assert.equal(at('14:00:47'), 'BC', 'read 2: the newer snapshot');
  assert.ok(at('14:00:50').includes('C'), 'read 3 is older, but the new order C stays on the screen');
  assert.ok(started.some((t) => t >= T('14:00:50') && t < T('14:00:51')), 'a fresh read starts at once, not at the next poll');
  assert.equal(at('14:00:51'), 'BC', 'and it settles the board a tenth of a second later');
  assert.equal(paints.filter((p) => p.at > T('14:00:47') && !p.ids.includes('C')).length, 0, 'C never left the screen');
});

test('a card recalled but not saved yet: Hold keeps it on the board and the un bump is not lost, and a tick on it shows', async () => {
  // Writes take 50 s from 14:00:20 to 14:02:00.
  const r = rig([{ from: T('14:00:20'), to: T('14:02:00'), kind: 'slow', readMs: () => 100, writeMs: () => 50000 }]);
  r.ticket('X');
  r.engine.start();
  await r.clock.runTo(T('14:00:10'));
  const x = row(r, 'X');
  r.engine.bump(x);                                     // saved at once
  await r.clock.runTo(T('14:00:30'));
  r.engine.restore({ ...x, bumpedAt: T('14:00:10') }, 'pending');    // Recall last on the slow link: the card is back at the tap
  await r.clock.runTo(T('14:00:40'));
  r.engine.hold('X');                                   // staff put the recalled card on Hold
  assert.equal(row(r, 'X') && row(r, 'X').held, true, 'still on the board, and held');
  r.engine.patchRow('X', { items: [{ name: 'Latte', _bumped: true }] });
  assert.deepEqual(row(r, 'X').items, [{ name: 'Latte', _bumped: true }], 'an item tick on that card is painted');
  await r.clock.runTo(T('14:03:30'));
  const after = r.seen.filter((s) => s.at >= T('14:00:30'));
  assert.equal(after.filter((s) => !s.ids.some((id) => id.startsWith('X'))).length, 0, 'the card never left the board');
  assert.equal(after.filter((s) => s.at > T('14:00:40') && !s.ids.includes('X(held)')).length, 0, 'and it read ON HOLD from the tap on');
  assert.equal(r.world.db.get('X').status, 'held');
  assert.equal(r.world.db.get('X').bumped_at, null, 'the un bump was not lost');
  assert.equal(r.gaveUp.length, 0);
});

test('Undo then Hold while the bump is still on its way: ONE write un bumps the ticket and holds it', async () => {
  const r = rig([{ from: T('14:00:02'), to: T('14:02:10'), kind: 'slow', readMs: () => 100, writeMs: (t) => (t < T('14:00:04') ? 50000 : 100) }]);
  r.ticket('X');
  r.engine.start();
  await r.clock.runTo(T('14:00:03'));
  const x = row(r, 'X');
  r.engine.bump(x);                                     // this send takes 50 s
  await r.clock.runTo(T('14:00:05'));
  r.engine.restore(x, 'pending');                       // Undo: waits for the bump's send to end
  await r.clock.runTo(T('14:00:08'));
  r.engine.hold('X');                                   // Hold on the card that is back
  assert.equal(row(r, 'X').held, true);
  await r.clock.runTo(T('14:02:00'));
  assert.deepEqual(r.world.landed.map((w) => w.body), [{ status: 'bumped', bumped_at: iso('14:00:03') }, { status: 'held', bumped_at: null }]);
  assert.equal(r.world.refused.length, 0);
  assert.equal(r.world.db.get('X').status, 'held');
  assert.equal(r.seen.filter((s) => s.at > T('14:00:08') && !s.ids.includes('X(held)')).length, 0, 'ON HOLD on the board from the tap on');
  // Resume on it before it is saved goes back to a plain recall.
  const s = rig([{ from: T('14:00:02'), to: T('14:02:10'), kind: 'slow', readMs: () => 100, writeMs: (t) => (t < T('14:00:04') ? 50000 : 100) }]);
  s.ticket('X');
  s.engine.start();
  await s.clock.runTo(T('14:00:03'));
  const y = row(s, 'X');
  s.engine.bump(y);
  await s.clock.runTo(T('14:00:05'));
  s.engine.restore(y, 'held');                          // Undo of a bump on a card that was on hold
  s.engine.resume('X');
  await s.clock.runTo(T('14:02:00'));
  assert.deepEqual(s.world.landed.map((w) => w.body), [{ status: 'bumped', bumped_at: iso('14:00:03') }, { status: 'pending', bumped_at: null }]);
});

test('one list answer the board cannot map counts as a failed read and is asked again; the reads never stop', async () => {
  let bad = true;
  const clock = makeClock(T('14:00:00'));
  const world = makeWorld(clock, []);
  let started = 0;
  let engine = null;
  const levels = [];
  engine = createBoardEngine({
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, makeAbort: makeAbortFactory(),
    readList: (o) => { started += 1; return world.readList(o); }, writeTicket: world.writeTicket, centreId: CENTRE,
    mapRow: (x) => { if (bad && x.id === 'BAD') throw new TypeError("null is not an object (evaluating 'i._bumped')"); return mapTestRow(x); },
    journal: { load: () => null, save: () => {} },
    onChange: () => levels.push(engine.view().level),
  });
  world.insert({ id: 'X', centre_id: CENTRE, sent_at: iso('14:00:00'), items: [] });
  engine.start();
  await clock.runTo(T('14:00:30'));
  world.insert({ id: 'BAD', centre_id: CENTRE, sent_at: iso('14:00:30'), items: [null] });
  await clock.runTo(T('14:01:30'));
  assert.equal(engine.view().level, 'offline', 'two reads in a row could not be used');
  assert.deepEqual(engine.view().rows.map((x) => x.id), ['X'], 'what was on screen stays');
  assert.deepEqual(engine.debug().link.open, [], 'no read is left open');
  const while1 = started;
  await clock.runTo(T('14:01:50'));
  assert.ok(started >= while1 + 3, 'asked again every 5 s, as for any failed read');
  bad = false;
  world.db.delete('BAD');
  world.insert({ id: 'NEW', centre_id: CENTRE, sent_at: iso('14:01:50'), items: [] });
  await clock.runTo(T('14:02:40'));
  engine.stop();
  assert.ok(engine.view().rows.some((x) => x.id === 'NEW'), 'the new order is on the screen');
  assert.equal(engine.view().level, 'ok');
});

test('K9: the tablet sleeps through the night with the banner on: the trace is the two minutes before the sleep, not nine hours', async () => {
  let down = false;
  const r = rig([], { patchWorld: (world) => {
    const real = world.readList;
    world.readList = (o) => (down ? Promise.resolve({ error: new TypeError('Load failed') }) : real(o));
  } });
  r.ticket('X');
  r.engine.start();
  await r.clock.runTo(T('14:01:00'));
  down = true;                                          // closing time: the router is switched off
  await r.clock.runTo(T('14:03:00'));
  assert.equal(r.engine.view().level, 'offline');
  const asleep = r.clock.freeze();                      // the tablet is locked for the night
  down = false;
  r.clock.jump(T('14:03:00') + 9 * 3600 * 1000);
  r.clock.thaw(asleep);
  const wake = r.clock.now();
  await r.clock.runTo(wake + 10 * 60 * 1000);
  assert.equal(r.spells.length, 1);
  assert.ok(r.spells[0].durationMs >= 100000 && r.spells[0].durationMs <= 125000, `the spell lasted ${r.spells[0].durationMs} ms`);
  assert.equal(r.spells[0].wentOffline, true);
  assert.equal(r.seen.filter((s) => s.at >= wake && s.level !== 'ok').length, 0, 'no warning on waking to a healthy link');
});

test('K9: a bump that gave up is counted in the trace, and tapping "Bump not saved" later is not a second incident', async () => {
  // The link is down for 12 minutes and nothing sent in that time is ever delivered.
  let down = false;
  const r = rig([], { patchWorld: (world, clock) => {
    const failSoon = (answer) => new Promise((resolve) => { clock.setTimer(() => resolve(answer), 50); });
    const realRead = world.readList; const realWrite = world.writeTicket;
    world.readList = (o) => (down ? failSoon({ error: new TypeError('Load failed') }) : realRead(o));
    world.writeTicket = (...a) => (down ? failSoon({ error: new TypeError('Load failed'), outcome: 'error' }) : realWrite(...a));
  } });
  r.ticket('X'); r.ticket('Y');
  r.engine.start();
  await r.clock.runTo(T('14:01:00'));
  down = true;
  await r.clock.runTo(T('14:01:10'));
  r.engine.bump(row(r, 'X'));
  await r.clock.runTo(T('14:13:00'));
  down = false;
  await r.clock.runTo(T('14:25:00'));
  assert.equal(row(r, 'X').unsaved, 'bump');
  assert.equal(r.spells.length, 1, 'the spell of 12 minutes is written');
  assert.equal(r.spells[0].notSaved, 1, 'with the bump that was never saved in it');
  assert.equal(r.spells[0].lateBumps, 0);
  r.engine.retryBump('X');                              // staff tap the mark 12 minutes after the link came back
  await r.clock.runTo(T('14:25:02'));
  assert.equal(r.world.db.get('X').status, 'bumped');
  assert.equal(r.world.db.get('X').bumped_at, iso('14:01:10'), 'the same bump');
  await r.clock.runTo(T('14:40:00'));
  assert.equal(r.seen.filter((s) => s.at >= T('14:25:00') && s.level !== 'ok').length, 0, 'no banner for a write that took a tenth of a second');
  assert.equal(r.seen.filter((s) => s.at >= T('14:25:00') && s.showSaving).length, 0);
  assert.equal(r.spells.length, 1, 'and no second trace');
});

test('restart (K2): an Undo that is not saved yet is kept, the card stays on the board, and the row ends as staff left it', async () => {
  // Staff bump, tap Undo, and restart the slow app. The old bump is already on the network.
  const r = rig([{ from: T('14:00:05'), to: T('14:03:00'), kind: 'dead' }]);
  r.ticket('A'); r.ticket('B');
  r.engine.start();
  await r.clock.runTo(T('14:00:10'));
  const a = row(r, 'A');
  r.engine.bump(a);
  await r.clock.runTo(T('14:00:15'));
  r.engine.restore(a, 'pending');
  r.engine.hold('B');
  await r.clock.runTo(T('14:01:00'));
  const kept = JSON.parse(r.storage.text).entries;
  assert.deepEqual(kept.map((e) => `${e.id}:${e.kind || 'bump'}`), ['A:restore'], 'the recall is in the journal; the Hold is not');
  assert.deepEqual(kept[0].guard, { match: { bumped_at: iso('14:00:10') } });
  r.restart();
  assert.ok(row(r, 'A'), 'on the board straight after the restart, before any list is in');
  await r.clock.runTo(T('14:06:00'));
  assert.equal(r.seen.filter((s) => s.at >= T('14:01:00') && !s.ids.includes('A')).length, 0, 'the card never left the board');
  assert.ok(landedOf(r, 'A').some((x) => x.startsWith('bumped@14:03')), 'the old bump did land');
  assert.equal(r.world.db.get('A').status, 'pending', 'and the kept Undo undid it');
  assert.equal(r.world.db.get('A').bumped_at, null);
  assert.deepEqual(JSON.parse(r.storage.text).entries, [], 'forgotten once saved');
});

test('restart on a healthy link with a bump left in the journal: settled by the first list, not written twice, no trace', async () => {
  // The page closed in the tenth of a second the write took, and was opened again six minutes
  // later: the database has the bump, the journal still does too.
  const journalRow = mapTestRow({ id: 'A', status: 'pending', centre_id: CENTRE, sent_at: iso('13:53:00'), items: [] });
  const journal = () => JSON.stringify({ v: 1, entries: [{ id: 'A', body: { status: 'bumped', bumped_at: iso('13:54:00') }, at: T('13:54:00'), since: T('13:54:00'), centreId: CENTRE, failed: false, row: journalRow }] });
  const r = rig([]);
  r.ticket('A', T('13:53:00')); r.ticket('B', T('13:59:00'));
  r.world.db.set('A', { ...r.world.db.get('A'), status: 'bumped', bumped_at: iso('13:54:00') });
  r.storage.text = journal();
  r.engine.start();
  await r.clock.runTo(T('14:00:01'));
  assert.equal(r.engine.view().unsavedBumps, 0, 'the first list no longer holds it: saved');
  assert.deepEqual(r.bumpSaved, [{ id: 'A', how: 'seen' }]);
  await r.clock.runTo(T('14:10:00'));
  assert.equal(r.world.landed.length, 0, 'no second write of that bump');
  assert.equal(r.seen.filter((s) => s.level !== 'ok').length, 0, 'never a banner');
  assert.deepEqual(r.spells, [], 'and no "was slow for 6 min, 1 bump saved late" trace on a link that was never slow');

  // The same journal, but the bump never reached the database: the first list still holds the
  // ticket, so the bump is sent, once, with its first tap time.
  const s = rig([]);
  s.ticket('A', T('13:53:00'));
  s.storage.text = journal();
  s.engine.start();
  assert.equal(row(s, 'A'), undefined, 'hidden from the first paint');
  await s.clock.runTo(T('14:00:02'));
  assert.deepEqual(landedOf(s, 'A'), ['bumped@14:00:00'], 'sent as soon as the first list was in, not 5 s later');
  assert.equal(s.world.db.get('A').bumped_at, iso('13:54:00'));
  // And with no list answer at all the kept bump still goes, 5 s after the start.
  const d = rig([{ from: T('14:00:00'), to: T('14:00:30'), kind: 'dead' }]);
  const sent = [];
  d.ticket('A', T('13:53:00'));
  d.storage.text = journal();
  const realWrite = d.world.writeTicket;
  d.world.writeTicket = (...a) => { sent.push(d.clock.now()); return realWrite(...a); };
  d.engine.start();
  await d.clock.runTo(T('14:00:10'));
  assert.deepEqual(sent.map(clockText), ['14:00:05']);
});

test('K1: a list read the database answered BEFORE a bump landed, and whose answer reaches the tablet AFTER the bump\'s answer, cannot paint the ticket back', async () => {
  // The 12 Oct burst shape: a list answer takes 3 s longer to come back than a write's answer.
  const r = rig([], { listBackMs: 3000 });
  r.ticket('A'); r.ticket('B');
  r.engine.start();
  await r.clock.runTo(T('14:00:20') + 60);              // the 14:00:20 poll has reached the database: it holds A
  r.engine.bump(row(r, 'A'));                           // lands at 14:00:20.11, answered 14:00:20.16
  await r.clock.runTo(T('14:00:21'));
  assert.equal(r.engine.view().unsavedBumps, 0, 'the bump is saved before the list answer is back');
  await r.clock.runTo(T('14:00:24'));
  const old = r.world.reads.find((x) => x.at > T('14:00:21') && x.snapshotAt < T('14:00:20') + 100);
  assert.ok(old && old.ids.includes('A'), 'the older list really did come back holding A');
  await r.clock.runTo(T('14:01:30'));
  assert.equal(shows(r, 'A', T('14:00:20') + 61, T('14:01:30')).length, 0, 'A never came back');
  assert.ok(row(r, 'B'));
});

test('what the screen learned after a list read was sent wins over that read: a saved recall, a live bump, a live change and a tick', async () => {
  const r = rig([], { listBackMs: 3000 });
  r.ticket('A'); r.ticket('B'); r.ticket('C'); r.ticket('D');
  r.engine.start();
  await r.clock.runTo(T('14:00:10'));
  const a = row(r, 'A');
  r.engine.bump(a);
  await r.clock.runTo(T('14:00:20') + 60);              // the 14:00:20 poll has been served: A bumped, B C D waiting
  r.engine.restore({ ...a, bumpedAt: T('14:00:10') }, 'pending');    // a recall, saved a tenth of a second later
  r.engine.liveUpdate({ ...r.world.db.get('B'), status: 'bumped', bumped_at: iso('14:00:20') });   // another screen bumps B
  r.engine.liveUpdate({ ...r.world.db.get('C'), status: 'held' });   // another screen holds C
  r.engine.patchRow('D', { items: [{ name: 'Tea', _bumped: true }] });   // an item tick here
  await r.clock.runTo(T('14:00:21'));
  assert.deepEqual(r.saved.map((e) => e.kind), ['restore']);
  await r.clock.runTo(T('14:00:24'));                   // the older list is back: no A, B waiting, C not held, D unticked
  const old = r.world.reads.find((x) => x.at > T('14:00:21') && x.snapshotAt < T('14:00:20') + 100);
  assert.ok(old && !old.ids.includes('A') && old.ids.includes('B'), 'the older list really was older');
  assert.ok(row(r, 'A'), 'the recalled card stays');
  assert.equal(row(r, 'B'), undefined, 'the ticket bumped on another screen stays off');
  assert.equal(row(r, 'C').held, true, 'the hold from another screen stays');
  assert.deepEqual(row(r, 'D').items, [{ name: 'Tea', _bumped: true }], 'the tick stays');
  const from = T('14:00:20') + 61;
  assert.equal(r.seen.filter((s) => s.at >= from && s.at <= T('14:00:39') && (!s.ids.includes('A') || s.ids.includes('B') || !s.ids.includes('C(held)'))).length, 0, 'in every view until the next poll');
});

test('a ticket of another station is never painted from a live change, and its "bumped" does not light Recall last', async () => {
  // v5.5.913: both Leeds screens showed every station's tickets. The guard now lives here.
  const r = rig([]);
  r.ticket('A');
  r.engine.start();
  await r.clock.runTo(T('14:00:01'));
  r.engine.liveInsert({ id: 'F1', status: 'pending', centre_id: 'pc-food', sent_at: iso('14:00:01'), items: [] });
  r.engine.liveUpdate({ id: 'F2', status: 'pending', centre_id: 'pc-food', sent_at: iso('14:00:01'), items: [] });
  r.engine.liveUpdate({ id: 'F3', status: 'held', centre_id: 'pc-food', sent_at: iso('14:00:01'), items: [] });
  assert.deepEqual(r.engine.view().rows.map((x) => x.id), ['A']);
  r.engine.liveUpdate({ id: 'F1', status: 'bumped', bumped_at: iso('14:00:02'), centre_id: 'pc-food', sent_at: iso('14:00:01'), items: [] });
  assert.deepEqual(r.bumpedLive, []);
  // A screen tied to no station shows every ticket.
  const all = rig([], { centreId: null });
  all.engine.start();
  await all.clock.runTo(T('14:00:01'));
  all.engine.liveInsert({ id: 'F1', status: 'pending', centre_id: 'pc-food', sent_at: iso('14:00:01'), items: [] });
  assert.deepEqual(all.engine.view().rows.map((x) => x.id), ['F1']);
});

test('K5: the list reads reach ServOS and it answers with an error: the view says so, and a read that gets through clears it', async () => {
  let mode = 'ok';
  const r = rig([], { patchWorld: (world) => {
    const real = world.readList;
    world.readList = (o) => {
      if (mode === 'server') return Promise.resolve({ error: { message: 'Service Unavailable' }, server: true });
      if (mode === 'network') return Promise.resolve({ error: new TypeError('Load failed') });
      return real(o);
    };
  } });
  r.ticket('A');
  r.engine.start();
  await r.clock.runTo(T('14:00:10'));
  assert.equal(r.engine.view().serverFault, false);
  mode = 'server';
  await r.clock.runTo(T('14:00:21'));
  assert.equal(r.engine.view().level, 'slow');
  assert.equal(r.engine.view().serverFault, false, 'only said with the red banner');
  await r.clock.runTo(T('14:00:26'));
  assert.equal(r.engine.view().level, 'offline');
  assert.equal(r.engine.view().serverFault, true);
  mode = 'network';
  await r.clock.runTo(T('14:00:32'));
  assert.equal(r.engine.view().level, 'offline');
  assert.equal(r.engine.view().serverFault, false, 'the next read did not get an answer at all: the WiFi words again');
  mode = 'ok';
  await r.clock.runTo(T('14:01:20'));
  assert.equal(r.engine.view().level, 'ok');
  assert.equal(r.engine.view().serverFault, false);
});

// ── the two watches, and what a list may prove (review 12 Oct 2026, found by fuzz runs) ──────────
// A rig whose ticket writes do nothing until the test lands them, in any order it likes: `land()`
// puts one on the database (honouring its guard) and answers it, `land({ answer: false })` is a
// copy the tablet had already given up on, `fail()` is the network giving up on it.
function manual(opts = {}) {
  const sent = [];
  const reads = { hold: false, waiting: [] };
  const r = rig([], { ...opts, patchWorld: (world, clock) => {
    world.writeTicket = (id, body, label, signal, guard = null) => new Promise((resolve) => {
      const w = { id, body, guard, at: clock.now(), open: true };
      const end = (answer) => { if (!w.open) return; w.open = false; resolve(answer); };
      w.land = ({ answer = true } = {}) => {
        const row = world.db.get(id);
        const lets = !!row && Object.entries((guard && guard.match) || {}).every(([k, v]) => row[k] === v) && Object.entries((guard && guard.notMatch) || {}).every(([k, v]) => row[k] !== v);
        if (lets) { world.db.set(id, { ...row, ...body }); world.landed.push({ at: clock.now(), id, body: { ...body } }); }
        else if (row) world.refused.push({ at: clock.now(), id, body: { ...body }, guard });
        if (answer) end({ error: null, outcome: lets ? 'applied' : 'gone' });
        return lets;
      };
      w.fail = () => end({ error: new TypeError('Load failed'), outcome: 'error' });
      if (signal) signal.addEventListener('abort', () => end({ error: Object.assign(new Error('aborted'), { name: 'AbortError' }), outcome: 'error' }));
      sent.push(w);
    });
    // A list read is answered at once, unless the test holds it: then `take()` is the moment the
    // database answers it and `answer()` the moment that answer reaches the tablet.
    world.readList = () => new Promise((resolve) => {
      const snap = () => [...world.db.values()].filter((x) => x.status === 'pending' || x.status === 'held').map((x) => ({ ...x }));
      if (!reads.hold) { clock.setTimer(() => resolve({ data: snap() }), 50); return; }
      const rd = { data: null, take() { rd.data = snap(); }, answer() { resolve({ data: rd.data }); } };
      reads.waiting.push(rd);
    });
  } });
  r.sent = sent;
  r.reads = reads;
  return r;
}
const bodies = (r) => r.sent.map((w) => `${w.body.status}${w.guard && w.guard.match ? ` undoes ${w.guard.match.bumped_at.slice(11, 19)}` : ''}`);

test('the undo watch: Bump, Recall, Bump, Recall. The recall names the bump that really left the tablet, not the one that never did', async () => {
  const r = manual();
  r.ticket('X');
  r.engine.start();
  await r.clock.runTo(T('14:00:10'));
  r.engine.bump(row(r, 'X'));                           // its write is on its way
  await r.clock.runTo(T('14:00:15'));
  r.engine.restore(r.engine.lastUnsavedBump());         // Recall last: waits behind that write
  await r.clock.runTo(T('14:00:20'));
  r.engine.bump(row(r, 'X'));                           // a second bump: never sent, it waits too
  await r.clock.runTo(T('14:00:25'));
  r.engine.restore(r.engine.lastUnsavedBump());         // Recall last again
  assert.ok(row(r, 'X'), 'the card is back');
  assert.equal(r.sent.length, 1, 'only the first bump has left the tablet');
  r.sent[0].land();                                     // the first bump lands and is answered
  await r.clock.runTo(T('14:00:26'));
  assert.deepEqual(bodies(r), ['bumped', 'pending undoes 14:00:10'], 'the recall undoes the bump of 14:00:10, the one that is in the database');
  r.sent[1].land();
  await r.clock.runTo(T('14:01:30'));
  assert.equal(r.world.db.get('X').status, 'pending', 'the last tap wins');
  assert.equal(r.seen.filter((s) => s.at > T('14:00:25') && !s.ids.includes('X')).length, 0, 'and the card never left the board');
  assert.equal(r.sent.length, 2, 'nothing more was sent');
});

test('the undo watch: two bumps of one ticket left the tablet; the recall undoes whichever of them is on the row', async () => {
  const r = manual();
  r.ticket('X');
  r.engine.start();
  await r.clock.runTo(T('14:00:10'));
  r.engine.bump(row(r, 'X'));                           // bump 1
  await r.clock.runTo(T('14:00:12'));
  r.sent[0].fail();                                     // the network gave up on it: it may still land
  await r.clock.runTo(T('14:00:14'));                   // sent again (the same bump)
  r.engine.restore(r.engine.lastUnsavedBump());         // Recall last
  r.sent[1].fail();
  await r.clock.runTo(T('14:00:16'));                   // the recall of bump 1 is on its way
  r.sent[2].fail();
  r.engine.bump(row(r, 'X'));                           // bump 2
  await r.clock.runTo(T('14:00:18'));
  r.sent[r.sent.length - 1].fail();
  r.engine.restore(r.engine.lastUnsavedBump());         // Recall last again: it names bump 2
  await r.clock.runTo(T('14:00:21'));
  const recall2 = r.sent[r.sent.length - 1];
  assert.equal(recall2.guard.match.bumped_at, iso('14:00:16'));
  // The stalled link lets go. Bump 2 never arrives; a copy of bump 1 does, after the recall of bump 2.
  recall2.land();                                       // refused: the row holds no bump at all yet
  await r.clock.runTo(T('14:00:22'));
  const recall1 = r.sent[r.sent.length - 1];
  assert.equal(recall1.guard.match.bumped_at, iso('14:00:10'), 'refused for bump 2, the recall goes again at once naming bump 1');
  r.sent[0].land({ answer: false });                    // bump 1 lands late: the row is bumped
  assert.equal(r.world.db.get('X').status, 'bumped');
  recall1.land();                                       // and the recall naming it undoes it
  await r.clock.runTo(T('14:01:30'));
  for (const w of r.sent.filter((x) => x.open)) w.land();
  await r.clock.runTo(T('14:04:00'));
  assert.equal(r.world.db.get('X').status, 'pending', 'the last tap wins');
  assert.equal(r.seen.filter((s) => s.at > T('14:00:18') && !s.ids.includes('X')).length, 0, 'the card never left the board');
});

test('what a list may prove: a bump that waits behind an older change of its ticket is not "saved" by a list', async () => {
  // Bump (saved), Undo (its write still on its way), Bump again. The database still holds the
  // FIRST bump, so a list no longer holds the ticket. The second bump was counted as saved on that
  // list and never sent; the Undo then landed and the ticket came back with nobody tapping.
  const r = manual();
  r.ticket('X'); r.ticket('Y');
  r.engine.start();
  await r.clock.runTo(T('14:00:10'));
  const x = row(r, 'X');
  r.engine.bump(x);
  r.sent[0].land();
  await r.clock.runTo(T('14:00:12'));
  r.engine.restore(x, 'pending');                       // Undo: sent, not landed yet
  await r.clock.runTo(T('14:00:14'));
  r.engine.bump(row(r, 'X'));                           // the second bump waits behind the Undo
  await r.clock.runTo(T('14:00:45'));                   // two list reads have come back without X
  assert.equal(r.engine.view().unsavedBumps, 1, 'still unsaved: those lists proved nothing about it');
  assert.equal(r.sent.length, 2);
  r.sent[1].land();                                     // the Undo lands
  await r.clock.runTo(T('14:00:46'));
  assert.equal(r.sent.length, 3, 'and now the second bump goes');
  r.sent[2].land();
  await r.clock.runTo(T('14:02:00'));
  assert.equal(r.world.db.get('X').status, 'bumped');
  assert.equal(r.world.db.get('X').bumped_at, iso('14:00:14'));
  assert.equal(shows(r, 'X', T('14:00:14') + 1, T('14:02:00')).length, 0, 'never painted back');
});

test('what a list may prove: a list the database answered BEFORE the older change landed proves nothing either', async () => {
  const r = manual();
  r.ticket('X'); r.ticket('Y');
  r.engine.start();
  await r.clock.runTo(T('14:00:10'));
  const x = row(r, 'X');
  r.engine.bump(x);
  r.sent[0].land();
  await r.clock.runTo(T('14:00:12'));
  r.engine.restore(x, 'pending');                       // Undo: on its way
  await r.clock.runTo(T('14:00:14'));
  r.engine.bump(row(r, 'X'));                           // waits behind it
  r.reads.hold = true;
  r.engine.load();
  await r.clock.runTo(T('14:00:15'));
  const read = r.reads.waiting[0];
  read.take();                                          // the database answers the list: X is bumped (the first bump), so not in it
  r.sent[1].land();                                     // then the Undo lands and is answered; the second bump is sent
  await r.clock.runTo(T('14:00:16'));
  assert.equal(r.sent.length, 3);
  read.answer();                                        // and only now the list answer reaches the tablet
  r.reads.hold = false;
  await r.clock.runTo(T('14:00:17'));
  assert.equal(r.engine.view().unsavedBumps, 1, 'that list was sent before the Undo had ended: the bump is NOT saved by it');
  r.sent[2].fail();                                     // its first send is lost
  await r.clock.runTo(T('14:00:19'));
  assert.equal(r.sent.length, 4, 'so it is sent again');
  r.sent[3].land();
  await r.clock.runTo(T('14:01:30'));
  assert.equal(r.world.db.get('X').status, 'bumped');
  assert.equal(shows(r, 'X', T('14:00:14') + 1, T('14:01:30')).length, 0, 'never painted back');
});

test('the bump watch: this screen\'s own late recall brings a bumped ticket back, and the same bump goes again without the card being painted', async () => {
  const r = manual();
  r.ticket('X'); r.ticket('Y');
  r.engine.start();
  await r.clock.runTo(T('14:00:10'));
  const x = row(r, 'X');
  r.engine.bump(x);                                     // bump 1: on its way
  await r.clock.runTo(T('14:00:12'));
  r.engine.restore(x, 'pending');                       // Undo
  r.sent[0].fail();                                     // the network gave up on bump 1 (it may still land)
  await r.clock.runTo(T('14:00:13'));
  assert.equal(bodies(r)[1], 'pending undoes 14:00:10');
  r.sent[1].fail();                                     // and on the Undo (it may still land too)
  r.engine.bump(row(r, 'X'));                           // bump 2
  await r.clock.runTo(T('14:00:15'));
  const bump2 = r.sent[r.sent.length - 1];
  assert.deepEqual(bump2.body, { status: 'bumped', bumped_at: iso('14:00:13') });
  bump2.land();                                         // bump 2 is saved
  await r.clock.runTo(T('14:00:16'));
  assert.deepEqual(r.bumpSaved, [{ id: 'X', how: 'saved' }]);
  assert.deepEqual(r.engine.debug().rebump, ['X'], 'a recall of this ticket was sent and never answered: the screen watches');
  // The stalled link lets go of the two old requests, the worst way round.
  r.sent[0].land({ answer: false });                    // bump 1 lands (the row now holds bump 1)
  r.sent[1].land({ answer: false });                    // the Undo of bump 1 lands: the ticket is waiting again
  assert.equal(r.world.db.get('X').status, 'pending');
  await r.clock.runTo(T('14:00:21'));                   // the 14:00:20 list shows it waiting
  const again = r.sent[r.sent.length - 1];
  assert.deepEqual(again.body, bump2.body, 'the same bump is sent again');
  assert.ok(again.at >= T('14:00:20'));
  again.land();
  await r.clock.runTo(T('14:02:00'));
  assert.equal(r.world.db.get('X').status, 'bumped');
  assert.equal(shows(r, 'X', T('14:00:13') + 1, T('14:02:00')).length, 0, 'the card never came back');
  assert.deepEqual(r.bumpSaved, [{ id: 'X', how: 'saved' }], 'and the auto ready step is not judged a second time');
  // With no recall of its own about, a ticket that is waiting again was recalled by somebody else: it shows.
  r.world.db.set('Y', { ...r.world.db.get('Y'), status: 'bumped', bumped_at: iso('14:02:00') });
  await r.clock.runTo(T('14:02:21'));
  r.world.db.set('Y', { ...r.world.db.get('Y'), status: 'pending', bumped_at: null });
  await r.clock.runTo(T('14:02:41'));
  assert.ok(row(r, 'Y'));
});

test('the late echo of a bump this screen has already undone does not take the card off again', async () => {
  // A slow link: Bump (saved), Undo (saved 4 s later), and only then the live echoes arrive, in
  // order: "bumped", then "pending". The first one used to take the card off until the next list.
  const r = rig([]);
  r.ticket('X'); r.ticket('Y');
  r.engine.start();
  await r.clock.runTo(T('14:00:10'));
  const x = row(r, 'X');
  r.engine.bump(x);
  await r.clock.runTo(T('14:00:11'));
  r.engine.restore(x, 'pending');
  await r.clock.runTo(T('14:00:12'));
  assert.equal(r.world.db.get('X').status, 'pending');
  const before = r.seen.length;
  r.engine.liveUpdate({ id: 'X', status: 'bumped', bumped_at: iso('14:00:10'), centre_id: CENTRE, sent_at: iso('14:00:00'), items: [] });
  assert.ok(row(r, 'X'), 'still on the board');
  r.engine.liveUpdate({ id: 'X', status: 'pending', bumped_at: null, centre_id: CENTRE, sent_at: iso('14:00:00'), items: [] });
  assert.ok(row(r, 'X'));
  assert.equal(r.seen.slice(before).filter((s) => !s.ids.includes('X')).length, 0);
  assert.deepEqual(r.bumpedLive, [], 'and it does not light Recall last');
  // A bump of that ticket by ANOTHER screen (another moment) does take it off.
  r.engine.liveUpdate({ id: 'X', status: 'bumped', bumped_at: iso('14:00:13'), centre_id: CENTRE, sent_at: iso('14:00:00'), items: [] });
  assert.equal(row(r, 'X'), undefined);
});

test('K1: a live change that arrives minutes late cannot paint back a ticket this screen bumped', async () => {
  // The list forgets "what I learned since" after two minutes (longer than any read lives). What
  // this screen saw GO is remembered for twenty.
  const r = rig([]);
  r.ticket('X'); r.ticket('Y');
  r.engine.start();
  await r.clock.runTo(T('14:00:10'));
  r.engine.bump(row(r, 'X'));
  await r.clock.runTo(T('14:05:10'));
  r.engine.liveUpdate({ id: 'X', status: 'held', bumped_at: null, centre_id: CENTRE, sent_at: iso('14:00:00'), items: [] });
  r.engine.liveInsert({ id: 'X', status: 'pending', bumped_at: null, centre_id: CENTRE, sent_at: iso('14:00:00'), items: [] });
  assert.equal(row(r, 'X'), undefined);
  await r.clock.runTo(T('14:06:00'));
  assert.equal(shows(r, 'X', T('14:00:10') + 1, T('14:06:00')).length, 0);
  // Recalled for real on another screen: within one list read it is back, and live changes paint it again.
  r.world.db.set('X', { ...r.world.db.get('X'), status: 'pending', bumped_at: null });
  r.engine.liveUpdate({ ...r.world.db.get('X') });
  await r.clock.runTo(T('14:06:01'));
  assert.ok(row(r, 'X'));
  r.engine.liveUpdate({ ...r.world.db.get('X'), status: 'held' });
  assert.equal(row(r, 'X').held, true);
});

test('Undo of a bump that never left the tablet sends no recall at all: only the status the card had', async () => {
  const r = manual();
  r.ticket('X');
  r.engine.start();
  await r.clock.runTo(T('14:00:10'));
  r.engine.hold('X');                                   // on its way
  await r.clock.runTo(T('14:00:12'));
  const x = row(r, 'X');
  r.engine.bump(x);                                     // waits behind the Hold: never sent
  await r.clock.runTo(T('14:00:14'));
  r.engine.restore(x, 'held');                          // Undo
  assert.equal(row(r, 'X').held, true, 'back on the board, on hold as it was');
  r.sent[0].land();
  await r.clock.runTo(T('14:01:00'));
  for (const w of r.sent.filter((s) => s.open)) w.land();
  await r.clock.runTo(T('14:02:00'));
  assert.deepEqual(r.sent.map((w) => w.body), [{ status: 'held' }, { status: 'held' }], 'no bump and no recall ever left the tablet');
  assert.equal(r.world.db.get('X').status, 'held');
  assert.deepEqual(r.engine.debug().undone, []);
});

test('restart: a bump kept while an older change of its ticket was on its way is sent, not "saved" by the first list', async () => {
  // Bump (saved), Undo (on its way), Bump again, and the app is restarted. The new page cannot see
  // the Undo that is still on its way; its first list shows the ticket gone (the first bump).
  const r = manual();
  r.ticket('X');
  r.engine.start();
  await r.clock.runTo(T('14:00:10'));
  const x = row(r, 'X');
  r.engine.bump(x);
  r.sent[0].land();
  await r.clock.runTo(T('14:00:12'));
  r.engine.restore(x, 'pending');
  await r.clock.runTo(T('14:00:14'));
  r.engine.bump(row(r, 'X'));
  assert.equal(JSON.parse(r.storage.text).entries[0].behind, true, 'kept with that fact');
  r.restart();
  await r.clock.runTo(T('14:00:15'));
  assert.equal(r.engine.view().unsavedBumps, 1, 'the first list did not settle it');
  const again = r.sent[r.sent.length - 1];
  assert.deepEqual(again.body, { status: 'bumped', bumped_at: iso('14:00:14') }, 'it was sent at once (no wait for the list, which could prove nothing)');
  r.sent[1].land({ answer: false });                    // the old page's Undo lands
  again.land();
  await r.clock.runTo(T('14:01:30'));
  assert.equal(r.world.db.get('X').status, 'bumped');
  assert.equal(shows(r, 'X', T('14:00:14') + 1, T('14:01:30')).length, 0);
});
