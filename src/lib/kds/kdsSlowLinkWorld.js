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

/** How far apart the requests of one burst may reach the database when the burst is scrambled. */
export const BURST_SPREAD_MS = 300;
/** The client's own repeats of a request that never completed (lib/netRetry.js RETRY_DELAYS_MS). */
const CLIENT_REPEAT_DELAYS_MS = [400, 1200];

/** Does a write's guard (kdsWriteLane.js guardFor) let it change this row? The fake database's WHERE. */
const guardLets = (row, guard) => {
  if (!guard) return true;
  for (const [k, v] of Object.entries(guard.match || {})) if (row[k] !== v) return false;
  for (const [k, v] of Object.entries(guard.notMatch || {})) if (row[k] === v) return false;
  return true;
};

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
 *
 * Review 12 Oct 2026 added three things this world could not do, each of which hid a fault:
 *   scramble      the requests a stalled link held reach the database in ANY order when it lets go
 *                 (the API log of 12 Oct: bursts landed scrambled). A number is the seed of a
 *                 shuffle; 'reverse' delivers what was sent later first (for short tests). Left out,
 *                 a burst arrives in the order it was sent, as before.
 *   listBackMs    a list answer takes this much longer to come back than a write's answer, so a
 *                 list read served BEFORE a bump of the same burst reaches the tablet AFTER that
 *                 bump's answer (the 12 Oct burst shape).
 *   clientRepeat  the client sends a write that never completed again by itself, 0.4 s and then
 *                 1.2 s later (lib/netRetry.js), so the screen's 75 s valve cancels a copy that has
 *                 left the tablet. With cancelledStillArrive that copy still lands (lateCancelled).
 * Writes carry their guard (kdsWriteLane.js guardFor); a write its guard refuses changes nothing
 * and answers 'gone', as the database does (refused).
 */
export function makeWorld(clock, spells = [], { cancelledStillArrive = false, scramble = null, listBackMs = 0, clientRepeat = false } = {}) {
  const db = new Map();            // id → row
  const landed = [];               // every write that changed a row: { at, id, body }
  const refused = [];              // every write its guard refused: { at, id, body, guard }
  const lateCancelled = [];        // writes that changed a row AFTER the screen had cancelled them
  const reads = [];                // every list answer that reached the tablet: { at, snapshotAt, ids }
  const spellAt = (t) => spells.find((s) => t >= s.from && t < s.to) || null;
  let seed = typeof scramble === 'number' ? scramble : 1;
  let held = 0;
  /** Extra ms before a request the link HELD reaches the database: what makes a burst land out of order. */
  const spread = () => {
    if (scramble === null || scramble === undefined || scramble === false) return 0;
    held += 1;
    if (scramble === 'reverse') return Math.max(0, BURST_SPREAD_MS - held);
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return Math.floor((seed / 2147483648) * BURST_SPREAD_MS);
  };

  function plan(sentAt, isWrite) {
    let leaveAt = sentAt;
    const back = isWrite ? 0 : listBackMs;
    const tok = spells.find((s) => s.kind === 'token' && sentAt >= s.from && sentAt < s.to);
    if (tok) leaveAt = tok.to;
    const s = spellAt(leaveAt);
    if (!s || s.kind === 'token') {
      const arriveAt = leaveAt + 50 + (tok ? spread() : 0);
      return { leaveAt, arriveAt, answerAt: arriveAt + 50 + back };
    }
    if (s.kind === 'dead') { const arriveAt = s.to + 20 + spread(); return { leaveAt, arriveAt, answerAt: arriveAt + 100 + back }; }
    if (s.kind === 'slow') {
      const ms = isWrite ? s.writeMs(leaveAt) : s.readMs(leaveAt);
      return { leaveAt, arriveAt: leaveAt + ms - 50, answerAt: leaveAt + ms + back };
    }
    // windows
    const since = (leaveAt - s.from) % s.every;
    const inOpening = since < s.open;
    const arriveAt = inOpening ? leaveAt + 50 : leaveAt + (s.every - since) + 20 + spread();
    if (arriveAt >= s.to) { const at = s.to + 20 + spread(); return { leaveAt, arriveAt: at, answerAt: at + 100 + back }; }
    const openEnds = arriveAt - ((arriveAt - s.from) % s.every) + s.open;
    const answerAt = arriveAt + 100 + back;
    return { leaveAt, arriveAt, answerAt: answerAt <= openEnds ? answerAt : null };
  }

  /** One request. `effect(at, copy)` runs when a copy of it reaches the database and returns the answer body. */
  function request(isWrite, signal, effect) {
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) { reject(abortError()); return; }
      let done = false;
      const copies = [];           // every copy of this request the client put on the link
      let giveUpTimer = null;
      const send = (attempt) => {
        const p = plan(clock.now(), isWrite);
        const copy = { leaveAt: p.leaveAt, arrived: false, cancelled: false, arriveTimer: null, answerTimer: null };
        copies.push(copy);
        let answer;
        copy.arriveTimer = clock.setTimer(() => { copy.arrived = true; answer = effect(clock.now(), copy); }, p.arriveAt - clock.now());
        copy.answerTimer = p.answerAt === null ? null : clock.setTimer(() => {
          if (done || copies[copies.length - 1] !== copy) return;
          done = true;
          resolve(answer);
        }, p.answerAt - clock.now());
        // No answer for 60 s on the network: the tablet's own network gives up. The request itself may
        // still be delivered. The 60 s run from the moment the request LEAVES the tablet: one still
        // waiting for the sign in token is not on the network yet, so nothing but the screen's own
        // limit ends it (12 Oct: bump 33 waited 3 min 37 s behind the renewal and then went out once).
        giveUpTimer = clock.setTimer(() => {
          if (done) return;
          if (clientRepeat && isWrite && attempt < CLIENT_REPEAT_DELAYS_MS.length) {
            clock.setTimer(() => { if (!done) send(attempt + 1); }, CLIENT_REPEAT_DELAYS_MS[attempt]);
            return;
          }
          done = true;
          reject(new TypeError('Load failed'));
        }, Math.max(0, p.leaveAt - clock.now()) + 60000);
      };
      send(0);
      if (signal) signal.addEventListener('abort', () => {
        if (done) return;
        done = true;
        for (const copy of copies) {
          if (copy.answerTimer !== null) clock.clearTimer(copy.answerTimer);
          if (copy.arrived) continue;
          // Cancelled before it left the tablet (still waiting for the sign in token): it never reaches
          // the database. Cancelled after it left: lost too, unless cancelledStillArrive.
          const left = clock.now() >= copy.leaveAt;
          if (!left || !cancelledStillArrive) clock.clearTimer(copy.arriveTimer);
          else copy.cancelled = true;
        }
        clock.clearTimer(giveUpTimer);
        reject(abortError());
      });
    });
  }

  return {
    db, landed, refused, lateCancelled, reads,
    /** The till sends a ticket (it reaches the database at once: on 12 Oct the till was never slow). */
    insert(row) { db.set(row.id, { status: 'pending', bumped_at: null, ...row }); },
    /** The board's list read: the pending and held rows, as lib/kds/kdsBoardEngine.js readList resolves them. */
    readList: ({ signal } = {}) => request(false, signal, (at) => {
      const data = [...db.values()].filter((r) => r.status === 'pending' || r.status === 'held').map((r) => ({ ...r }));
      return { data, snapshotAt: at };
    }).then((ans) => { reads.push({ at: clock.now(), snapshotAt: ans.snapshotAt, ids: ans.data.map((r) => r.id) }); return { data: ans.data }; }, (e) => ({ error: e })),
    /** The board's ticket write, in the shape lib/rowWrites.js mustChangeRow resolves. */
    writeTicket: (id, body, label, signal, guard = null) => request(true, signal, (at, copy) => {
      const row = db.get(id);
      if (!row) return { outcome: 'gone' };
      if (!guardLets(row, guard)) { refused.push({ at, id, body: { ...body }, guard }); return { outcome: 'gone' }; }
      db.set(id, { ...row, ...body });
      landed.push({ at, id, body: { ...body } });
      if (copy && copy.cancelled) lateCancelled.push({ at, id, body: { ...body } });
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
