// src/lib/kds/kdsSlowLinkWorld.js
//
// TEST SUPPORT ONLY (no screen imports this). 12 Oct 2026, Coffee Boy Barnsley: the drinks tablet's
// link hung requests for 30 to 380 seconds, let them out in bursts about a minute apart, and for
// 3.5 minutes its sign in renewal held every request back. Nothing in the repo could replay that,
// so the faults could only be shown by cutting lines out of the React component.
//
// This file is the world those tests run in: a virtual clock (hours pass in milliseconds), a fake
// database that records every write that reached it, and a fake link described as a list of spells.
// kdsBoardEngine.test.js and kdsSlowLink.test.js drive the REAL board engine through it.

/** A clock whose timers only run when the test says so. */
export function makeClock(start = Date.UTC(2026, 9, 12, 13, 40, 0)) {
  let t = start;
  let seq = 0;
  const timers = new Map();
  const flush = async () => { for (let i = 0; i < 40; i += 1) await Promise.resolve(); };
  return {
    now: () => t,
    setTimer: (fn, ms) => { seq += 1; const id = seq; timers.set(id, { at: t + Math.max(0, ms), fn, id }); return id; },
    clearTimer: (id) => { timers.delete(id); },
    flush,
    /** The tablet sleeps: every timer stands still. freeze() takes them out, jump() moves the clock, thaw() puts them back, all due at once. */
    freeze() { const held = [...timers.values()]; timers.clear(); return held; },
    jump(to) { t = Math.max(t, to); },
    thaw(held) { for (const x of held) timers.set(x.id, { ...x, at: Math.max(x.at, t) }); },
    /** Run every timer due up to `until`, in time order, letting promises settle between them. */
    async runTo(until) {
      await flush();
      for (;;) {
        let next = null;
        for (const x of timers.values()) if (x.at <= until && (!next || x.at < next.at || (x.at === next.at && x.id < next.id))) next = x;
        if (!next) break;
        timers.delete(next.id);
        t = Math.max(t, next.at);
        next.fn();
        await flush();
      }
      t = Math.max(t, until);
      await flush();
    },
  };
}

/** 'hh:mm:ss' on 12 Oct 2026 (UTC) as a time in ms. */
export const T = (s) => Date.UTC(2026, 9, 12, ...s.split(':').map(Number));
/** A time in ms as 'hh:mm:ss' (UTC), for messages. */
export const clockText = (ms) => new Date(ms).toISOString().slice(11, 19);

const abortError = () => { const e = new Error('The operation was aborted.'); e.name = 'AbortError'; return e; };

/**
 * The tablet's link, as a list of spells. Outside every spell a request takes 0.1 s.
 *   { from, to, kind: 'dead' }                    nothing arrives; a request still open at `to` arrives then and is answered
 *   { from, to, kind: 'windows', every, open }    the 12 Oct shape: the link lets requests through for `open` ms every
 *                                                 `every` ms; a request arrives at the next opening; its answer is lost
 *                                                 unless it comes back inside the same opening
 *   { from, to, kind: 'slow', readMs, writeMs }   every read takes readMs(t) and every write lands after writeMs(t)
 *   { from, to, kind: 'token' }                   the sign in renewal is stuck: no request even leaves the tablet until `to`
 *
 * cancelledStillArrive: a request the screen cancelled AFTER it left the tablet is still delivered
 * (it sat in the network buffer). That is the hard case for the order of writes, and what the API
 * log of 12 Oct showed: the same bump landed two and three times.
 * A request with no answer fails by itself 60 s after it left the tablet, as the iPad's own network
 * does, and such a request is still delivered when the link lets go.
 */
export function makeWorld(clock, spells = [], { cancelledStillArrive = false } = {}) {
  const db = new Map();            // id → row
  const landed = [];               // every write that reached the database: { at, id, body }
  const reads = [];                // every list answer that reached the tablet: { at, snapshotAt, ids }
  const spellAt = (t) => spells.find((s) => t >= s.from && t < s.to) || null;

  function plan(sentAt, isWrite) {
    let leaveAt = sentAt;
    const tok = spells.find((s) => s.kind === 'token' && sentAt >= s.from && sentAt < s.to);
    if (tok) leaveAt = tok.to;
    const s = spellAt(leaveAt);
    if (!s || s.kind === 'token') return { leaveAt, arriveAt: leaveAt + 50, answerAt: leaveAt + 100 };
    if (s.kind === 'dead') return { leaveAt, arriveAt: s.to + 20, answerAt: s.to + 120 };
    if (s.kind === 'slow') {
      const ms = isWrite ? s.writeMs(leaveAt) : s.readMs(leaveAt);
      return { leaveAt, arriveAt: leaveAt + ms - 50, answerAt: leaveAt + ms };
    }
    // windows
    const since = (leaveAt - s.from) % s.every;
    const inOpening = since < s.open;
    const arriveAt = inOpening ? leaveAt + 50 : leaveAt + (s.every - since) + 20;
    if (arriveAt >= s.to) return { leaveAt, arriveAt: s.to + 20, answerAt: s.to + 120 };
    const openEnds = arriveAt - ((arriveAt - s.from) % s.every) + s.open;
    const answerAt = arriveAt + 100;
    return { leaveAt, arriveAt, answerAt: answerAt <= openEnds ? answerAt : null };
  }

  /** One request. `effect()` runs when it reaches the database and returns the answer body. */
  function request(isWrite, signal, effect) {
    return new Promise((resolve, reject) => {
      const p = plan(clock.now(), isWrite);
      let done = false;
      if (signal && signal.aborted) { reject(abortError()); return; }
      let answer;
      let arrived = false;
      const arriveTimer = clock.setTimer(() => { arrived = true; answer = effect(clock.now()); }, p.arriveAt - clock.now());
      const answerTimer = p.answerAt === null ? null : clock.setTimer(() => { if (!done) { done = true; resolve(answer); } }, p.answerAt - clock.now());
      // No answer for 60 s on the network: the tablet's own network gives up. The request itself may
      // still be delivered. The 60 s run from the moment the request LEAVES the tablet: one still
      // waiting for the sign in token is not on the network yet, so nothing but the screen's own
      // limit ends it (12 Oct: bump 33 waited 3 min 37 s behind the renewal and then went out once).
      const giveUpTimer = clock.setTimer(() => { if (!done) { done = true; reject(new TypeError('Load failed')); } }, Math.max(0, p.leaveAt - clock.now()) + 60000);
      if (signal) signal.addEventListener('abort', () => {
        if (done) return;
        done = true;
        // Cancelled before it left the tablet (still waiting for the sign in token): it never reaches
        // the database. Cancelled after it left: lost too, unless cancelledStillArrive.
        const left = clock.now() >= p.leaveAt;
        if (!arrived && (!left || !cancelledStillArrive)) clock.clearTimer(arriveTimer);
        if (answerTimer !== null) clock.clearTimer(answerTimer);
        clock.clearTimer(giveUpTimer);
        reject(abortError());
      });
    });
  }

  return {
    db, landed, reads,
    /** The till sends a ticket (it reaches the database at once: on 12 Oct the till was never slow). */
    insert(row) { db.set(row.id, { status: 'pending', bumped_at: null, ...row }); },
    /** The board's list read: the pending and held rows, as lib/kds/kdsBoardEngine.js readList resolves them. */
    readList: ({ signal } = {}) => request(false, signal, (at) => {
      const data = [...db.values()].filter((r) => r.status === 'pending' || r.status === 'held').map((r) => ({ ...r }));
      return { data, snapshotAt: at };
    }).then((ans) => { reads.push({ at: clock.now(), snapshotAt: ans.snapshotAt, ids: ans.data.map((r) => r.id) }); return { data: ans.data }; }, (e) => ({ error: e })),
    /** The board's ticket write, in the shape lib/rowWrites.js mustChangeRow resolves. */
    writeTicket: (id, body, label, signal) => request(true, signal, (at) => {
      const row = db.get(id);
      if (!row) return { outcome: 'gone' };
      db.set(id, { ...row, ...body });
      landed.push({ at, id, body: { ...body } });
      return { outcome: 'applied' };
    }).then((ans) => ({ error: null, outcome: ans.outcome }), (e) => ({ error: e, outcome: 'error' })),
  };
}

/** The same thing KDSSurface hands the engine: a fresh AbortController per request. */
export function makeAbortFactory() {
  return () => { const c = new AbortController(); return { signal: c.signal, abort: () => c.abort() }; };
}

/** A kds_tickets row → the board's row, cut down to what the engine itself reads. */
export const mapTestRow = (r) => ({
  id: r.id, status: r.status || 'pending', held: r.status === 'held', centreId: r.centre_id || null,
  sentAt: new Date(r.sent_at).getTime(), bumpedAt: r.bumped_at ? new Date(r.bumped_at).getTime() : null, items: r.items || [],
});
