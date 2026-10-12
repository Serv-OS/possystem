// 12 Oct 2026, Coffee Boy Barnsley, drinks screen: the afternoon, replayed on the REAL board engine
// (lib/kds/kdsBoardEngine.js) with a virtual clock and a fake link (kdsSlowLinkWorld.js).
//
// What the tablet's link did that day, from the bump times in the database and the API log:
//   from 13:48     every request took 3 to 20 s
//   from 14:17:30  requests sat on the tablet and left in bursts about a minute apart
//   from 14:44     nothing at all, until staff restarted the app at 14:50:48 with bumps unsaved
//   14:53 to 14:56:56  the hourly sign in renewal was stuck and no request left the tablet
//   from 15:24     healthy again
// On the build of that day tickets staff had bumped were painted back by the list reload, bumps
// landed up to 378 s late with nothing on screen, and the only warning was a thin pale strip.
//
// The replay runs twice: with requests the screen cancelled being lost, and with them still being
// delivered late (what the API log showed: the same bump landed two and three times).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeClock, makeWorld, makeAbortFactory, mapTestRow, T, clockText } from './kdsSlowLinkWorld.js';
import { createBoardEngine } from './kdsBoardEngine.js';
import { bannerWords, traceWords, POLL_MS } from './kdsLinkHealth.js';
import { LATE_BUMP_MS } from './kdsWriteLane.js';

const CENTRE = 'pc-drinks';
const SLOWEST_READ_MS = 20000;
// Staff: a card is bumped once it has been up two minutes; every eighth is put on Hold after one.
const BUMP_AFTER_MS = 120000;
const HOLD_AFTER_MS = 60000;

async function replay({ cancelledStillArrive }) {
  // The same "random" delays on every run.
  const rnd = (() => { let s = 12345; return () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; }; })();
  const clock = makeClock(T('13:40:00'));
  const world = makeWorld(clock, [
    { from: T('13:48:00'), to: T('14:17:30'), kind: 'slow', readMs: () => 3000 + Math.floor(rnd() * 17000), writeMs: () => 3000 + Math.floor(rnd() * 17000) },
    { from: T('14:17:30'), to: T('14:44:00'), kind: 'windows', every: 60000, open: 2000 },
    { from: T('14:44:00'), to: T('14:50:48'), kind: 'dead' },
    { from: T('14:50:48'), to: T('14:53:00'), kind: 'windows', every: 60000, open: 2000 },
    { from: T('14:53:00'), to: T('14:56:56'), kind: 'token' },
    { from: T('14:56:56'), to: T('15:24:00'), kind: 'windows', every: 60000, open: 2000 },
  ], { cancelledStillArrive });

  const storage = { text: null };
  const out = {
    world, sentAt: new Map(), bumpTaps: new Map(), holdTaps: new Map(), firstSeen: new Map(),
    cameBack: [], marked: [], levels: [], traces: [], bumpSaved: [], gaveUp: [], probes: {},
    unsavedAtRestart: 0, mostSendsOpen: 0, savingShown: 0,
  };

  // Every ticket write, to count the sends of ONE ticket open at the same time on one page. A send
  // is over once it has answered or failed, or once the screen has cancelled it (the safety valve).
  let page = 0;
  const sends = [];
  const writeTicket = (id, body, label, signal) => {
    const rec = { key: `${page}|${id}`, signal, done: false };
    sends.push(rec);
    const open = sends.filter((x) => x.key === rec.key && !x.done && !(x.signal && x.signal.aborted)).length;
    out.mostSendsOpen = Math.max(out.mostSendsOpen, open);
    return world.writeTicket(id, body, label, signal).then((ans) => { rec.done = true; return ans; });
  };

  let engine = null;
  let level = 'ok';
  const observe = () => {
    if (!engine) return;
    const v = engine.view();
    for (const r of v.rows) {
      if (!out.firstSeen.has(r.id)) out.firstSeen.set(r.id, clock.now());
      if (!out.bumpTaps.has(r.id)) continue;
      if (r.unsaved === 'bump') out.marked.push({ id: r.id, at: clock.now() });
      else out.cameBack.push({ id: r.id, at: clock.now(), tappedAt: out.bumpTaps.get(r.id) });
    }
    if (v.showSaving) out.savingShown += 1;
    if (v.level !== level) {
      level = v.level;
      out.levels.push({ at: clock.now(), level, words: bannerWords({ level, unsavedBumps: v.unsavedBumps }) });
    }
  };
  const boot = () => {
    page += 1;
    engine = createBoardEngine({
      now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, makeAbort: makeAbortFactory(),
      readList: world.readList, writeTicket, mapRow: mapTestRow, centreId: CENTRE,
      journal: { load: () => storage.text, save: (text) => { storage.text = text; } },
      onChange: observe,
      onBumpSaved: (row, how) => out.bumpSaved.push({ id: row && row.id, how, at: clock.now() }),
      onGaveUp: (e) => out.gaveUp.push(e),
      onSpell: (s) => out.traces.push({ at: clock.now(), summary: s, words: traceWords({ name: 'drinks kds', summary: s }) }),
    });
    engine.start();
    observe();
  };
  boot();

  // The till: one ticket every 100 s (it was never slow that day).
  let n = 0;
  for (let t = T('13:40:30'); t < T('15:30:00'); t += 100000) {
    n += 1;
    const id = `kds-${t}-${CENTRE}-${String(n).padStart(3, '0')}`;
    clock.setTimer(() => {
      world.insert({ id, centre_id: CENTRE, sent_at: new Date(clock.now()).toISOString(), items: [{ name: 'Latte', qty: 1 }] });
      out.sentAt.set(id, clock.now());
    }, t - clock.now());
  }
  // Staff keep working through the trouble: every 5 s they look at the board. The oldest card that
  // has been up two minutes is bumped. Every eighth ticket is put on Hold first, a minute after it showed.
  const everyEighth = (id) => Number(id.slice(-3)) % 8 === 0;
  const staff = () => {
    clock.setTimer(() => {
      if (engine) {
        const rows = engine.view().rows.filter((r) => !r.unsaved).sort((a, b) => a.sentAt - b.sentAt);
        const up = (r) => clock.now() - (out.firstSeen.get(r.id) || clock.now());
        const toHold = rows.find((r) => everyEighth(r.id) && !r.held && !out.holdTaps.has(r.id) && up(r) >= HOLD_AFTER_MS && up(r) < BUMP_AFTER_MS);
        if (toHold) { out.holdTaps.set(toHold.id, clock.now()); engine.hold(toHold.id); }
        const due = rows.find((r) => up(r) >= BUMP_AFTER_MS);
        if (due) { out.bumpTaps.set(due.id, clock.now()); engine.bump(due); }
      }
      staff();
    }, 5000);
  };
  staff();

  const probe = (label, at) => clock.setTimer(() => {
    const v = engine.view();
    out.probes[label] = { level: v.level, sure: v.sure, unsavedBumps: v.unsavedBumps, showSaving: v.showSaving, words: bannerWords({ level: v.level, unsavedBumps: v.unsavedBumps }) };
  }, at - clock.now());
  probe('13:45', T('13:45:00'));
  probe('14:47', T('14:47:00'));
  probe('14:53:40', T('14:53:40'));
  probe('15:30', T('15:30:00'));

  // 14:50:48: the page is reloaded with bumps unsaved (staff restarted the app).
  clock.setTimer(() => {
    out.unsavedAtRestart = engine.view().unsavedBumps;
    engine.stop();
    engine = null;
    level = 'ok';
    boot();
  }, T('14:50:48') - clock.now());

  await clock.runTo(T('15:40:00'));
  engine.stop();
  return out;
}

for (const hard of [false, true]) {
  const name = hard ? 'requests the screen cancelled are still delivered late' : 'requests the screen cancelled are lost';
  test(`12 Oct replayed on the real board engine (${name})`, async (t) => {
    const r = await replay({ cancelledStillArrive: hard });
    const { world } = r;
    const secs = (ms) => Math.round(ms / 1000);

    // Staff did work through it.
    assert.ok(r.sentAt.size >= 60, `tickets sent: ${r.sentAt.size}`);
    assert.ok(r.bumpTaps.size >= 55, `tickets bumped: ${r.bumpTaps.size}`);
    assert.ok(r.holdTaps.size >= 5, `tickets held first: ${r.holdTaps.size}`);
    assert.ok(r.unsavedAtRestart >= 1, 'the app was restarted with bumps unsaved');

    // K1: a bumped ticket never comes back by itself. (Nothing took ten minutes that day, so no
    // card came back with the "Bump not saved" mark either.)
    assert.deepEqual(r.cameBack.slice(0, 3).map((c) => `${c.id.slice(-3)} at ${clockText(c.at)}`), [], 'bumped tickets painted back without a mark');
    assert.equal(r.marked.length, 0);
    assert.equal(r.gaveUp.length, 0);

    // K2: every bump reached the database, each send with the body of the tap, and the row ends on it.
    const lateness = [];
    for (const [id, tapped] of r.bumpTaps) {
      const body = { status: 'bumped', bumped_at: new Date(tapped).toISOString() };
      const lands = world.landed.filter((w) => w.id === id);
      const bumps = lands.filter((w) => w.body.status === 'bumped');
      assert.ok(bumps.length >= 1, `the bump of ${id} never reached the database`);
      for (const w of bumps) assert.deepEqual(w.body, body, `${id}: every send carries the bumped_at of the tap`);
      assert.equal(world.db.get(id).status, 'bumped', `${id} ends bumped`);
      assert.equal(world.db.get(id).bumped_at, body.bumped_at, `${id}: the row holds the tap time`);
      // K3: nothing older lands after the bump (a Hold tapped before it).
      const firstBump = lands.findIndex((w) => w.body.status === 'bumped');
      assert.deepEqual(lands.slice(firstBump).filter((w) => w.body.status !== 'bumped'), [], `${id}: no older write landed after the bump`);
      lateness.push(bumps[0].at - tapped);
    }
    assert.equal(r.mostSendsOpen, 1, 'K3: never two sends of one ticket open side by side');
    // Saved exactly once: the auto ready step is judged once per bump, however often it was sent.
    assert.equal(r.bumpSaved.length, r.bumpTaps.size, 'onBumpSaved fires for every bump');
    assert.equal(new Set(r.bumpSaved.map((b) => b.id)).size, r.bumpSaved.length, 'and once only');

    // The day was as bad as 12 Oct: bumps landed up to about 380 s after the tap.
    lateness.sort((a, b) => a - b);
    const late = lateness.filter((ms) => ms > LATE_BUMP_MS);
    const worst = lateness[lateness.length - 1];
    assert.ok(late.length >= 40, `bumps over 10 s late: ${late.length}`);
    assert.ok(late.some((ms) => ms >= 30000 && ms <= 60000), 'some landed 30 to 60 s late');
    assert.ok(worst >= 360000 && worst <= 400000, `the worst bump landed ${secs(worst)} s after the tap`);
    assert.ok(r.savingShown > 0, 'the header count showed while bumps were unsaved');

    // K4: every ticket was shown, and within one poll of the first list answer that held it.
    const neverShown = [...r.sentAt.keys()].filter((id) => !r.firstSeen.has(id) && r.sentAt.get(id) < T('15:25:00'));
    assert.deepEqual(neverShown, [], 'tickets never shown');
    let worstShow = 0;
    for (const [id, sent] of r.sentAt) {
      const shown = r.firstSeen.get(id);
      const firstAnswer = world.reads.find((x) => x.snapshotAt >= sent && x.ids.includes(id));
      if (shown && firstAnswer) worstShow = Math.max(worstShow, shown - firstAnswer.at);
    }
    assert.ok(worstShow <= POLL_MS + SLOWEST_READ_MS, `a ticket in a list answer that reached the tablet waited ${worstShow} ms to be shown`);

    // K5: the warnings, on and off at the right moments.
    assert.deepEqual(r.probes['13:45'], { level: 'ok', sure: true, unsavedBumps: 0, showSaving: false, words: null });
    assert.equal(r.probes['14:47'].level, 'offline', 'nothing at all since 14:44');
    assert.equal(r.probes['14:47'].sure, false);
    assert.ok(r.probes['14:47'].words.text.startsWith('This screen is offline. New orders are NOT showing.'));
    assert.equal(r.probes['14:53:40'].level, 'offline', 'the renewal is stuck');
    assert.deepEqual(r.probes['15:30'], { level: 'ok', sure: true, unsavedBumps: 0, showSaving: false, words: null });
    const firstWarning = r.levels.find((l) => l.level !== 'ok');
    assert.ok(firstWarning.at >= T('13:48:00') && firstWarning.at <= T('13:49:30'), `the first warning came at ${clockText(firstWarning.at)}`);
    assert.equal(firstWarning.words.text.startsWith('This screen is slow to reach ServOS. New orders may be late.'), true);
    const lastClear = r.levels[r.levels.length - 1];
    assert.equal(lastClear.level, 'ok');
    assert.ok(lastClear.at >= T('15:24:00') && lastClear.at <= T('15:26:00'), `the warning cleared at ${clockText(lastClear.at)}`);
    assert.deepEqual(r.levels.filter((l) => l.level === 'ok' && l.at > T('14:44:15') && l.at < T('14:50:48')), [], 'never "ok" while nothing got through');
    assert.ok(r.levels.some((l) => l.level === 'offline' && l.words.text.includes('not saved yet.')), 'the banner counted the unsaved bumps');

    // K9: ONE trace for the whole afternoon, written after it was over.
    assert.equal(r.traces.length, 1);
    const trace = r.traces[0];
    assert.ok(trace.at >= lastClear.at + 5 * 60 * 1000 && trace.at <= lastClear.at + 5 * 60 * 1000 + 2000, 'five minutes after the screen was healthy again');
    assert.equal(trace.summary.wentOffline, true);
    assert.ok(trace.summary.durationMs >= 90 * 60 * 1000, `the spell lasted ${secs(trace.summary.durationMs)} s`);
    assert.ok(trace.summary.lateBumps >= late.length - 2 && trace.summary.lateBumps <= r.bumpTaps.size, `late bumps in the trace: ${trace.summary.lateBumps}`);
    assert.ok(trace.summary.worstLateMs >= worst && trace.summary.worstLateMs < 600000, `worst in the trace: ${secs(trace.summary.worstLateMs)} s`);
    assert.match(trace.words.title, /^drinks kds was slow or offline for 1 h \d+ min$/);
    assert.match(trace.words.body, /^\d+ bumps saved late\. Longest wait \d min( \d+ s)?\.$/);

    t.diagnostic(`tickets ${r.sentAt.size}, bumped ${r.bumpTaps.size}, held first ${r.holdTaps.size}, unsaved at the restart ${r.unsavedAtRestart}`);
    t.diagnostic(`bump writes that reached the database ${world.landed.filter((w) => w.body.status === 'bumped').length}; over 10 s late ${late.length}; worst ${secs(worst)} s`);
    t.diagnostic(`worst wait from a list answer to the ticket on screen ${worstShow} ms`);
    t.diagnostic(`warning on ${clockText(firstWarning.at)}, off ${clockText(lastClear.at)}; trace: ${trace.words.title}. ${trace.words.body}`);
  });
}
