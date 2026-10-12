// src/lib/kds/kdsBoardEngine.js
//
// 12 Oct 2026, Barnsley: every rule about what a kitchen screen shows and sends lived inside the
// React component, so the incident could only be replayed by cutting lines out of it. This is the
// board's working, with the network, the clock, the timers and storage handed in. KDSSurface.jsx
// feeds it and paints its view; kdsSlowLink.test.js replays 12 Oct on it with a fake network.
//
// No React, no Supabase, no window. Imports only the pure rules beside it.

import {
  emptyLane, tap, retryFailedBump, dueSends, sendStarted, sendEnded, confirmBumpsFromList, confirmBumpFromLive,
  laneCounts, paint, toJournal, fromJournal, newestUnsavedBump, SAVING_SHOW_AFTER_MS, WRITE_ATTEMPT_MS, FAST_FAIL_DELAYS_MS,
} from './kdsWriteLane.js';
import { noteEvent, pruneEvents, upsertRow, removeRow, mergeList } from './kdsBoardRows.js';
import {
  newLink, canStartRead, readStarted, readsToCancel, shouldApply, readEnded, assess, noteBumpSaved, takeSpell, spellFromJournal, afterSleep,
  POLL_MS, RETRY_AFTER_FAIL_MS, SLEEP_GAP_MS,
} from './kdsLinkHealth.js';

const SAVED_OUTCOMES = new Set(['applied', 'gone', 'skipped']);
const KEPT_OUTCOMES = new Set(['parked', 'queued']);

/**
 * deps:
 *   now()                          the clock (ms)
 *   setTimer(fn, ms) / clearTimer  one shot timers
 *   makeAbort()                    → { signal, abort() } (an AbortController), or null where there is none
 *   readList({ signal })           → Promise of { data } | { error } | undefined (undefined = "cannot tell": an
 *                                    empty list while the device link is unsure)
 *   writeTicket(id, body, label, signal) → Promise of { error, outcome } (lib/rowWrites.js mustChangeRow outcomes)
 *   mapRow(databaseRow)            → the board's row
 *   centreId                       this board's station, or null
 *   journal { load(), save(text) } unsaved bumps across a restart (localStorage)
 *   onChange()                     the view changed: paint again
 *   onApplied(rows)                a list was used (the screen reads "last bumped" after it)
 *   onBumpSaved(row, how)          a bump is in the database ('saved' by its answer with a row changed, 'seen' by a list or live)
 *   onSaved(entry)                 a hold, resume or recall was saved
 *   onGaveUp(entry)                a change passed 10 minutes unsaved
 *   onBumpedLive(row)              a live "bumped" arrived for this station
 *   onSpell(summary)               a slow or offline spell ended: write the one trace
 */
export function createBoardEngine(deps) {
  const now = () => deps.now();
  let lane = emptyLane();
  let link = newLink();
  let server = [];                 // the database's pending and held rows, as this screen last knew them
  let events = new Map();          // what it learned since (see kdsBoardRows.js)
  const openWrites = {};           // ticket id → { seq, startedAt, abort, aborted }
  const openReads = new Map();     // read n → { abort, aborted }
  const extra = new Map();         // other writes in flight (item ticks, notes): key → startedAt
  let again = false;
  let retryTimer = null;
  let pollTimer = null;
  let tickTimer = null;
  let running = false;
  let level = 'ok';
  let sure = false;
  let lastJournal = null;
  let painted = { lane: null, server: null, rows: [] };   // the same array while nothing changed, so cards do not re-render every second
  let lastLook = 0;                // the last time the engine looked at the clock (to notice that the tablet slept)

  const changed = () => { try { deps.onChange && deps.onChange(); } catch { /* the view */ } };
  const call = (fn, ...args) => { try { if (fn) fn(...args); } catch { /* a callback must never stop the board */ } };

  let savedLane = null;
  let savedSpell = null;
  function saveJournal() {
    // Nothing moved since the last save (the lane and the spell are replaced, never changed in place): no work.
    if (lane === savedLane && link.spell === savedSpell) return;
    savedLane = lane; savedSpell = link.spell;
    const text = toJournal(lane, link.spell ? { spell: link.spell } : null);
    if (text === lastJournal) return;
    lastJournal = text;
    call(deps.journal && deps.journal.save, text);
  }

  function oldestOpenWriteMs() {
    let oldest = 0;
    const t = now();
    for (const o of Object.values(openWrites)) oldest = Math.max(oldest, t - o.startedAt);
    for (const at of extra.values()) oldest = Math.max(oldest, t - at);
    return oldest;
  }

  function reassess() {
    const c = laneCounts(lane, { now: now() });
    const a = assess(link, { now: now(), oldestOpenWriteMs: oldestOpenWriteMs(), oldestUnsavedBumpMs: c.oldestBumpMs });
    link = a.link;
    const moved = a.level !== level || a.sure !== sure;
    level = a.level; sure = a.sure;
    return moved;
  }

  // ── writes ──────────────────────────────────────────────────────────────────
  function settle(entry) {
    const t = now();
    if (entry.kind === 'bump') {
      server = removeRow(server, entry.id);
      events = noteEvent(events, { id: entry.id, kind: 'gone', at: t });
      link = noteBumpSaved(link, { tookMs: entry.tookMs, now: t });
      if (entry.how !== 'kept' && entry.how !== 'quiet') call(deps.onBumpSaved, entry.row, entry.how);
    } else {
      const base = server.find((r) => r.id === entry.id) || entry.row;
      if (base) {
        const row = { ...base, status: entry.body.status, held: entry.body.status === 'held', ...(entry.kind === 'restore' ? { bumpedAt: null } : null) };
        server = upsertRow(server, row);
        events = noteEvent(events, { id: entry.id, kind: 'row', row, at: t });
      }
      call(deps.onSaved, entry);
    }
  }

  /**
   * One send is over (answered, failed, or cancelled here). False when it was already closed.
   * `o` is that very send's own record, not only its ticket and change: a send the safety valve
   * cancelled answers a moment later, AFTER the next send of the same change has started, and that
   * late answer must not close the new send (12 Oct 2026, found on the replay of the renewal stall:
   * it did, the new send was then "failed" and sent again a second later, and four sends of one
   * bump were open at once).
   */
  function closeSend(id, o, res, threw) {
    if (!o || openWrites[id] !== o) return false;
    delete openWrites[id];
    if (!running) return false;
    const seq = o.seq;
    let result = 'failed';
    if (o.aborted) result = 'timeout';
    else if (!threw && res && !res.error && SAVED_OUTCOMES.has(res.outcome)) result = 'saved';
    else if (!threw && res && KEPT_OUTCOMES.has(res.outcome)) result = 'kept';
    const out = sendEnded(lane, { id, seq, result, now: now() });
    lane = out.lane;
    if (out.settled) settle({ ...out.settled, how: result === 'kept' ? 'kept' : (res && res.outcome === 'applied' ? 'saved' : 'quiet') });
    if (out.gaveUp) call(deps.onGaveUp, out.gaveUp);
    saveJournal();
    return true;
  }

  function endSend(id, o, res, threw) {
    if (!closeSend(id, o, res, threw)) return;
    pump();
    reassess();
    changed();
  }

  function startSend(entry) {
    const ctl = (deps.makeAbort && deps.makeAbort()) || null;
    const o = { seq: entry.seq, startedAt: now(), aborted: false, abort: () => { o.aborted = true; try { if (ctl) ctl.abort(); } catch { /* already ended */ } } };
    openWrites[entry.id] = o;
    lane = sendStarted(lane, { id: entry.id, now: o.startedAt });
    let p;
    try { p = Promise.resolve(deps.writeTicket(entry.id, entry.body, entry.label, ctl ? ctl.signal : undefined)); }
    catch (e) { p = Promise.reject(e); }
    p.then((res) => endSend(entry.id, o, res, false), () => endSend(entry.id, o, null, true));
  }

  function pump() {
    if (!running) return;
    for (let round = 0; round < 4; round += 1) {
      const due = dueSends(lane, { now: now(), open: openWrites });
      let closed = false;
      for (const id of due.cancel) {
        const o = openWrites[id];
        if (!o) continue;
        // The safety valve (kdsWriteLane.js WRITE_ATTEMPT_MS): this send never ended. Cancel it and
        // stop waiting for it, so the ticket's next send (the same body again, or a newer tap) can go.
        o.abort();
        if (closeSend(id, o, null, true)) closed = true;
      }
      if (closed) continue;            // decide again with those sends out of the way
      for (const e of due.send) {
        const cur = lane.entries[e.id];
        if (!openWrites[e.id] && cur && cur.seq === e.seq) startSend(e);
      }
      return;
    }
  }

  // The tablet slept (its timers stood still for over 10 s): a list read open since before the
  // sleep says nothing about the link now. The open reads are forgotten without counting as
  // failures, and unsaved changes get their full ten minutes from the wake.
  // A WRITE that was open is NOT cancelled here. It may already have left the tablet, and a newer
  // tap of the same ticket sent beside it could be overtaken by it (K3). It is left to end by
  // itself like any other send; if it never does, the safety valve ends it (its 75 s ran through
  // the sleep, so after a real sleep that is at the first look).
  function noticeSleep() {
    const t = now();
    const slept = lastLook ? t - lastLook : 0;
    lastLook = t;
    if (slept < SLEEP_GAP_MS) return false;
    for (const r of openReads.values()) r.abort();
    openReads.clear();
    link = afterSleep(link);
    const entries = {};
    for (const e of Object.values(lane.entries)) entries[e.id] = e.state === 'failed' ? e : { ...e, since: e.since + slept, nextAt: Math.min(e.nextAt, t) };
    lane = { ...lane, entries };
    return true;
  }

  // ── list reads ──────────────────────────────────────────────────────────────
  function scheduleRetry() {
    if (retryTimer !== null || !running) return;
    retryTimer = deps.setTimer(() => { retryTimer = null; load(); }, RETRY_AFTER_FAIL_MS);
  }

  function finishRead(n, startedAt, ans, threw) {
    const r = openReads.get(n);
    if (!r) return;                    // already closed (cancelled at 45 s): a later answer is not used
    openReads.delete(n);
    if (!running) return;
    const t = now();
    let result = 'failed';
    if (threw || (ans && ans.error) || (r && r.aborted)) result = 'failed';
    else if (!ans || !Array.isArray(ans.data)) result = 'unknown';
    else if (!shouldApply(link, n)) result = 'stale';
    else {
      result = 'applied';
      const ids = new Set(ans.data.map((row) => row.id));
      const seen = confirmBumpsFromList(lane, { ids, readStartedAt: startedAt, centreId: deps.centreId || null, now: t });
      lane = seen.lane;
      for (const e of seen.settled) settle(e);
      const fresh = ans.data.map((row) => deps.mapRow(row));
      server = mergeList({ rows: fresh, readStartedAt: startedAt, events });
      events = pruneEvents(events, { now: t });
      saveJournal();
    }
    link = readEnded(link, { n, result, now: t });
    reassess();
    if (result === 'applied') call(deps.onApplied, server);
    changed();
    // A failed read is asked again in 5 s, not at the next 20 s poll. A read that cannot be trusted
    // (the device link is unsure) waits for the poll: the link check has to answer first.
    if (result === 'failed') scheduleRetry();
    if (again) { again = false; load(); }
  }

  function load() {
    if (!running) return;
    noticeSleep();
    const t = now();
    if (!canStartRead(link, t)) { again = true; return; }
    const started = readStarted(link, t);
    link = started.link;
    const n = started.n;
    const ctl = (deps.makeAbort && deps.makeAbort()) || null;
    const rec = { startedAt: t, aborted: false, abort: () => { rec.aborted = true; try { if (ctl) ctl.abort(); } catch { /* ended */ } } };
    openReads.set(n, rec);
    let p;
    try { p = Promise.resolve(deps.readList({ signal: ctl ? ctl.signal : undefined })); }
    catch (e) { p = Promise.reject(e); }
    p.then((ans) => finishRead(n, t, ans, false), () => finishRead(n, t, null, true));
  }

  function tick() {
    if (!running) return;
    if (noticeSleep()) load();
    const t = now();
    for (const n of readsToCancel(link, t)) {
      const r = openReads.get(n);
      if (!r) continue;
      r.abort();
      finishRead(n, r.startedAt, null, true);    // cancelled and closed now, whatever the request itself does
    }
    pump();
    const moved = reassess();
    const sp = takeSpell(link, t);
    link = sp.link;
    if (sp.summary) call(deps.onSpell, sp.summary);
    saveJournal();   // the open spell rides in the journal, so a restart does not lose the trace
    const c = laneCounts(lane, { now: t });
    // The count in the header appears 3 s after a tap and the view must be told when that moment passes.
    if (moved || c.bumps + c.others + extra.size > 0) changed();
  }

  // ── the screen's actions ────────────────────────────────────────────────────
  function act(kind, { id, row, status }) {
    lane = tap(lane, { id, kind, row: row || server.find((r) => r.id === id) || null, status, centreId: deps.centreId || null, now: now() });
    saveJournal();
    pump();
    reassess();
    changed();
  }

  return {
    start() {
      if (running) return;
      running = true;
      const kept = deps.journal && deps.journal.load ? deps.journal.load() : null;
      lane = fromJournal(kept, { now: now() });
      link = { ...link, spell: spellFromJournal(kept, { now: now() }) };
      lastJournal = kept;
      lastLook = now();
      load();
      // Armed again only while running: a stop() in the middle of a round must not leave a timer behind.
      const poll = () => { pollTimer = deps.setTimer(() => { pollTimer = null; load(); if (running) poll(); }, POLL_MS); };
      const beat = () => { tickTimer = deps.setTimer(() => { tickTimer = null; tick(); if (running) beat(); }, 1000); };
      poll(); beat();
      pump();
    },
    stop() {
      running = false;
      if (pollTimer !== null) deps.clearTimer(pollTimer);
      if (tickTimer !== null) deps.clearTimer(tickTimer);
      if (retryTimer !== null) deps.clearTimer(retryTimer);
      pollTimer = tickTimer = retryTimer = null;
      // Requests still in flight are left to finish: a bump on its way must still land. Its answer is ignored here;
      // the journal sends it again on the next start if the database never showed it.
    },
    load,
    tick,
    bump(row) { if (row && row.id) act('bump', { id: row.id, row }); },
    retryBump(id) { lane = retryFailedBump(lane, { id, now: now() }); saveJournal(); pump(); reassess(); changed(); },
    hold(id) { act('hold', { id }); },
    resume(id) { act('resume', { id }); },
    restore(row, status = 'pending') { if (row && row.id) act('restore', { id: row.id, row, status }); },
    /** The board's row of the newest bump not saved yet, or null (Recall last brings it back with no read). */
    lastUnsavedBump() { const e = newestUnsavedBump(lane); return e ? e.row : null; },
    /** A local change to a row this screen holds (an item tick, a saved note). */
    patchRow(id, patch) {
      const cur = server.find((r) => r.id === id);
      if (!cur) return;
      const row = { ...cur, ...patch };
      server = upsertRow(server, row);
      events = noteEvent(events, { id, kind: 'row', row, at: now() });
      changed();
    },
    liveInsert(dbRow) {
      const t = deps.mapRow(dbRow);
      if (!t || !t.id) return;
      if (deps.centreId && t.centreId !== deps.centreId) return;
      if (t.status !== 'pending' && t.status !== 'held') return;
      server = upsertRow(server, t);
      events = noteEvent(events, { id: t.id, kind: 'row', row: t, at: now() });
      changed();
    },
    liveUpdate(dbRow) {
      const t = deps.mapRow(dbRow);
      if (!t || !t.id) return;
      if (dbRow.status === 'bumped') {
        server = removeRow(server, t.id);
        events = noteEvent(events, { id: t.id, kind: 'gone', at: now() });
        const seen = confirmBumpFromLive(lane, { id: t.id, bumpedAt: dbRow.bumped_at, now: now() });
        lane = seen.lane;
        if (seen.settled) { settle(seen.settled); saveJournal(); }
        if (!deps.centreId || t.centreId === deps.centreId) call(deps.onBumpedLive, t);
        reassess();
        changed();
        return;
      }
      if (deps.centreId && t.centreId !== deps.centreId) return;
      if (t.status === 'pending' || t.status === 'held') {
        server = upsertRow(server, t);
        events = noteEvent(events, { id: t.id, kind: 'row', row: t, at: now() });
      } else {
        server = server.map((r) => (r.id === t.id ? t : r));
      }
      changed();
    },
    /**
     * One write that is not a status change (an item tick, a note): a time limit on every send, up to
     * `tries` sends, counted in the header while it runs. Resolves { error, outcome } like ticketWrite.
     *   fn(signal)     starts the write
     *   stillWanted()  false stops before the next send (a newer tap took over, the ticket left)
     */
    async limitedWrite(key, fn, { tries = 1, stillWanted = null } = {}) {
      const k = `${key}#${now()}#${Math.random()}`;
      extra.set(k, now());
      let last = { error: new Error('not sent'), outcome: 'error' };
      try {
        for (let i = 0; i < tries; i += 1) {
          if (i > 0 && stillWanted && !stillWanted()) break;
          const ctl = (deps.makeAbort && deps.makeAbort()) || null;
          let timer = null;
          let timedOut = false;
          const limit = new Promise((resolve) => { timer = deps.setTimer(() => { timedOut = true; try { if (ctl) ctl.abort(); } catch { /* ended */ } resolve({ error: Object.assign(new Error('Kitchen write timed out'), { code: 'TIMEOUT' }), outcome: 'error' }); }, WRITE_ATTEMPT_MS); });
          let p;
          try { p = Promise.resolve(fn(ctl ? ctl.signal : undefined)).catch((e) => ({ error: e, outcome: 'error' })); }
          catch (e) { p = Promise.resolve({ error: e, outcome: 'error' }); }
          last = await Promise.race([p, limit]);
          if (timer !== null) deps.clearTimer(timer);
          if (last && !last.error) return last;
          if (i < tries - 1 && !timedOut) await new Promise((resolve) => deps.setTimer(resolve, FAST_FAIL_DELAYS_MS[Math.min(i, FAST_FAIL_DELAYS_MS.length - 1)]));
        }
        return last;
      } finally {
        extra.delete(k);
        reassess();
        changed();
      }
    },
    /** What the board paints and says. */
    view() {
      const t = now();
      const c = laneCounts(lane, { now: t });
      let others = c.others;
      let oldest = c.oldestMs;
      for (const at of extra.values()) { others += 1; oldest = Math.max(oldest, t - at); }
      if (painted.lane !== lane || painted.server !== server) painted = { lane, server, rows: paint(lane, server) };
      return {
        rows: painted.rows,
        level, sure, everApplied: link.everApplied,
        unsavedBumps: c.bumps, unsavedOthers: others, failedBumps: c.failedBumps,
        showSaving: (c.bumps + others) > 0 && oldest >= SAVING_SHOW_AFTER_MS,
      };
    },
    /** For tests and the trace. */
    debug() { return { lane, link, server, openWrites: Object.keys(openWrites), openReads: [...openReads.keys()] }; },
  };
}
