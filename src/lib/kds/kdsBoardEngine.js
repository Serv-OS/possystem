// src/lib/kds/kdsBoardEngine.js
//
// 12 Oct 2026, Barnsley: every rule about what a kitchen screen shows and sends lived inside the
// React component, so the incident could only be replayed by cutting lines out of it. This is the
// board's working, with the network, the clock, the timers and storage handed in. KDSSurface.jsx
// feeds it and paints its view; kdsSlowLink.test.js replays 12 Oct on it with a fake network.
//
// No React, no Supabase, no window. Imports only the pure rules beside it.
//
// 12 Oct 2026, review of the build. What was added here, each with the fault it answers beside it:
//   the guard of each change is handed to the write (startSend) · the undo watch and the bump
//   watch (heal, settle, finishRead) · a ticket this screen saw go is not painted from a late
//   live change (liveUpdate) · two overlapping list reads take nothing off the board (finishRead)
//   · a list the board cannot map is a failed read, not a read left open (finishRead) · a spell
//   ends at the last look before a sleep (noticeSleep) · a bump kept across a restart waits for
//   the first list (start).

import {
  emptyLane, tap, retryFailedBump, dueSends, sendStarted, sendEnded, confirmBumpsFromList, confirmBumpFromLive,
  laneCounts, paint, toJournal, fromJournal, newestUnsavedBump, patchEntryRow, releaseRestarted, journalWithout, notBefore,
  SAVING_SHOW_AFTER_MS, WRITE_ATTEMPT_MS, FAST_FAIL_DELAYS_MS, GIVE_UP_MS,
} from './kdsWriteLane.js';
import { noteEvent, pruneEvents, upsertRow, removeRow, mergeList, wentAway, forgetReturned, keepUnlisted } from './kdsBoardRows.js';
import {
  newLink, canStartRead, readStarted, readsToCancel, shouldApply, readOverlapped, readEnded, assess, noteBumpSaved, noteBumpGaveUp,
  takeSpell, spellFromJournal, afterSleep,
  POLL_MS, RETRY_AFTER_FAIL_MS, SLEEP_GAP_MS, SLOW_MS,
} from './kdsLinkHealth.js';

const SAVED_OUTCOMES = new Set(['applied', 'gone', 'skipped']);
const KEPT_OUTCOMES = new Set(['parked', 'queued']);
const instant = (v) => (v ? new Date(v).getTime() : NaN);

/**
 * deps:
 *   now()                          the clock (ms)
 *   setTimer(fn, ms) / clearTimer  one shot timers
 *   makeAbort()                    → { signal, abort() } (an AbortController), or null where there is none
 *   readList({ signal })           → Promise of { data } | { error, server? } | undefined (undefined = "cannot
 *                                    tell": an empty list while the device link is unsure; server: true = ServOS
 *                                    itself answered with an error, so it is not the tablet's network)
 *   writeTicket(id, body, label, signal, guard) → Promise of { error, outcome } (lib/rowWrites.js mustChangeRow
 *                                    outcomes). guard is null or { match, notMatch } (kdsWriteLane.js guardFor):
 *                                    more filters for the same write
 *   mapRow(databaseRow)            → the board's row
 *   centreId                       this board's station, or null
 *   journal { load(), save(text) } unsaved bumps and recalls across a restart (localStorage)
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
  const openWrites = {};           // ticket id → { seq, startedAt, abort, aborted, kind, bumpedAt }
  const openReads = new Map();     // read n → { abort, aborted }
  const extra = new Map();         // other writes in flight (item ticks, notes): key → startedAt
  // The bumps that may be on a ticket's row, as far as this screen knows: its own bumps of the
  // last 20 minutes, and a bump it read from the database to recall. Ticket id → [{ x, at, state }],
  // oldest first. x is the bumped_at. state:
  //   'new'       tapped, no send started yet: nothing of it exists outside this tablet
  //   'floating'  a send was started and no answer says it landed: it may land now, or much later
  //   'landed'    the database answered that it changed the row (or a list or live echo showed it)
  const stamps = new Map();
  // The undo watch: ticket id → { stamps, status, row, until, left, tried }. See act() and heal().
  const undone = new Map();
  // The bump watch. floatingRecalls: ticket id → until, a recall of this screen that was sent and
  // never answered. rebump: ticket id → { x, row, until, left }. See settle() and finishRead().
  const floatingRecalls = new Map();
  const rebump = new Map();
  // Tickets this screen saw go (its own saved bump, a live "bumped"): ticket id → when. Kept far
  // longer than `events` (20 minutes): a live change that arrives late must not paint such a
  // ticket back. Forgotten when staff bring the ticket back here, or a later list shows it waiting.
  const gones = new Map();
  let again = false;
  let retryTimer = null;
  let pollTimer = null;
  let tickTimer = null;
  let running = false;
  let level = 'ok';
  let sure = false;
  let serverFault = false;         // the last failed list read was ServOS answering with an error
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
    const text = toJournal(lane, link.spell ? { spell: link.spell } : null, { behind: busyTickets() });
    if (text === lastJournal) return;
    lastJournal = text;
    call(deps.journal && deps.journal.save, text);
  }

  /** Tickets whose unsaved change waits behind an OLDER change of the ticket that is still on its way, or has an unanswered recall about. */
  function busyTickets() {
    const busy = new Set(Object.keys(openWrites).filter((id) => lane.entries[id] && openWrites[id].seq !== lane.entries[id].seq));
    for (const id of floatingRecalls.keys()) busy.add(id);
    return busy;
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

  /** The one trace of a spell that is over (K9). */
  function flushSpell(t) {
    const sp = takeSpell(link, t);
    link = sp.link;
    if (sp.summary) call(deps.onSpell, sp.summary);
  }

  // ── the undo watch and the bump watch ───────────────────────────────────────
  // Review 12 Oct 2026 (K3): a write the tablet's network gave up on is still delivered when the
  // stalled link lets go, in any order. Staff bumped a ticket, tapped Undo, and the old bump
  // landed AFTER the undo: the order they had brought back left the board again with nothing said.
  // A recall is therefore guarded (it only undoes the very bump it names, kdsWriteLane.js
  // guardFor), and for ten minutes after an Undo or Recall the screen WATCHES when a bump of that
  // ticket may still be on its way or more than one bump may be on the row: when such a bump shows
  // up (its live echo, or a list that no longer holds the ticket) the same guarded recall is sent
  // again, naming each bump this screen knows of in turn. The card stays on the board all the
  // while. A recall that changes nothing for every one of them means the row holds none of this
  // screen's bumps: the ticket is waiting already, or somebody else bumped it (and that stands).
  // The next list read tells which. After `left` such answers the watch for that ticket ends.
  /** Is the last tap on this ticket one that wants it ON the board (a recall, a Hold or Resume not saved yet, the undo watch)? */
  const wantedHere = (id) => undone.has(id) || (!!lane.entries[id] && lane.entries[id].kind !== 'bump');
  /** Did this screen see the ticket go, with nothing since to say it is back? A live change must not paint it. */
  const sawItGo = (id) => (gones.has(id) || wentAway(events, id)) && !wantedHere(id);
  const RANK = { new: 0, floating: 1, landed: 2 };
  function noteStamp(id, x, state) {
    if (!x) return;
    const list = stamps.get(id) || [];
    const known = list.find((e) => e.x === x);
    if (known) { if (RANK[state] > RANK[known.state]) known.state = state; } else list.push({ x, at: now(), state });
    stamps.set(id, list);
  }
  function dropStamp(id, x) {
    const list = (stamps.get(id) || []).filter((e) => e.x !== x);
    if (list.length) stamps.set(id, list); else stamps.delete(id);
  }
  function heal(id, exact = null) {
    const u = undone.get(id);
    if (!u) return false;
    if (now() >= u.until || u.left <= 0) { undone.delete(id); return false; }
    if (lane.entries[id]) return false;      // a newer tap of this ticket is still unsaved: it decides
    lane = tap(lane, { id, kind: 'restore', row: u.row, status: u.status, centreId: deps.centreId || null, now: now(), undoes: exact || u.stamps[0], heal: true });
    return true;
  }
  /** A guarded recall changed nothing: try the next bump this screen knows of, or make sure of the card's status. */
  function afterRefusedRecall(entry, t) {
    const u = undone.get(entry.id);
    const x = entry.guard && entry.guard.match ? entry.guard.match.bumped_at : null;
    if (u && x) { u.stamps = [...u.stamps.filter((s) => s !== x), x]; u.tried += 1; u.left -= 1; }
    if (u && u.left > 0 && u.tried < u.stamps.length && heal(entry.id)) return;
    if (u) { u.tried = 0; if (u.left <= 0) undone.delete(entry.id); }
    // None of the bumps this screen knows of is on the row. The status the card shows is made
    // sure of with a plain Hold or Resume (which a bumped row refuses), and a list read decides.
    if (entry.guard) lane = tap(lane, { id: entry.id, kind: entry.body.status === 'held' ? 'hold' : 'resume', row: server.find((r) => r.id === entry.id) || entry.row, centreId: deps.centreId || null, now: t, keep: true });
  }

  // ── writes ──────────────────────────────────────────────────────────────────
  /** The ticket left the board as far as this screen knows (its saved bump, a live "bumped", a refused Hold). */
  function wentOff(id, t) {
    server = removeRow(server, id);
    events = noteEvent(events, { id, kind: 'gone', at: t });
    gones.set(id, t);
  }
  function paintSaved(entry, t) {
    const base = server.find((r) => r.id === entry.id) || entry.row;
    if (!base) return;
    const row = { ...base, status: entry.body.status, held: entry.body.status === 'held', ...(entry.kind === 'restore' ? { bumpedAt: null } : null) };
    server = upsertRow(server, row);
    events = noteEvent(events, { id: entry.id, kind: 'row', row, at: t });
    gones.delete(entry.id);                 // staff brought it back here (or held it): it is on the board again
  }

  function settle(entry) {
    const t = now();
    if (entry.kind === 'bump') {
      wentOff(entry.id, t);
      if (entry.heal) return;                // the bump watch sending a saved bump again: nothing new happened
      // A bump left in the journal by a page that closed in the tenth of a second its write took,
      // and settled by the first list of a healthy screen, was never late (review 12 Oct 2026: it
      // wrote "was slow for 11 min" on a link that had not been slow).
      const leftover = entry.restarted === true && entry.attempts === 0 && !link.spell;
      if (!leftover) link = noteBumpSaved(link, { tookMs: entry.tookMs, now: t });
      // The bump watch: one of this screen's own recalls of this ticket was sent and never
      // answered. Delivered late, AFTER this bump (with the older bump it names landing late too),
      // it would bring the ticket back with nobody tapping. If a list shows the ticket waiting
      // again while that recall may still be about, this same bump is sent again (finishRead).
      const until = floatingRecalls.get(entry.id);
      if (until && t < until) rebump.set(entry.id, { x: entry.body.bumped_at, row: entry.row, until, left: 3 });
      if (entry.how === 'saved' || entry.how === 'seen') call(deps.onBumpSaved, entry.row, entry.how);
      return;
    }
    if (entry.how === 'gone') {
      // The database changed nothing: the guard of this change refused it (kdsWriteLane.js guardFor).
      if (entry.kind === 'restore') {
        // The row did not hold the bump this recall names: that bump has not landed (it may yet),
        // another bump of this screen is on the row, or the ticket is waiting already. The card
        // STAYS: a ticket that may be waiting is never taken off on a guess.
        paintSaved(entry, t);
        if (!entry.heal) call(deps.onSaved, entry);
        afterRefusedRecall(entry, t);
      } else {
        // A Hold or Resume the database refused: the ticket is bumped (or gone). Off the board,
        // unless this screen is still undoing its own late bump of it.
        wentOff(entry.id, t);
        heal(entry.id);
      }
      load();
      return;
    }
    if (entry.kind === 'restore') {
      const u = undone.get(entry.id);
      if (u) u.tried = 0;
      // The bump this recall names is undone in the database (see liveUpdate, a late echo of it).
      const x = entry.guard && entry.guard.match ? entry.guard.match.bumped_at : null;
      const st = x && entry.how === 'saved' ? (stamps.get(entry.id) || []).find((e) => e.x === x) : null;
      if (st) st.undoneAt = t;
    }
    paintSaved(entry, t);
    if (!entry.heal) call(deps.onSaved, entry);
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
    const answered = !threw && res && !res.error && SAVED_OUTCOMES.has(res.outcome);
    if (!running) {
      // Stopped while this write was on its way (the screen was re pointed, the page is going),
      // and the database has now answered: that one bump leaves the journal, so the next start
      // does not write it a second time. Nothing else of a stopped engine moves.
      if (o.bumpedAt && answered && !o.aborted) {
        try {
          const text = deps.journal && deps.journal.load ? deps.journal.load() : null;
          const next = journalWithout(text, { id, bumpedAt: o.bumpedAt });
          if (next !== text) deps.journal.save(next);
        } catch { /* the next start sends it again: the same body, no harm */ }
      }
      return false;
    }
    const seq = o.seq;
    let result = 'failed';
    if (o.aborted) result = 'timeout';
    else if (answered) result = res.outcome === 'gone' ? 'gone' : 'saved';
    else if (!threw && res && KEPT_OUTCOMES.has(res.outcome)) result = 'kept';
    // What this send says about the bumps and recalls that may still be about (the two watches).
    if (o.bumpedAt && result === 'saved') noteStamp(id, o.bumpedAt, 'landed');
    if (o.kind === 'restore' && result !== 'saved' && result !== 'gone') floatingRecalls.set(id, now() + GIVE_UP_MS);
    const out = sendEnded(lane, { id, seq, result, now: now() });
    lane = out.lane;
    // An older change of this ticket ended while a bump waits behind it: lists sent up to now
    // prove nothing about that bump (kdsWriteLane.js notBefore).
    if (lane.entries[id] && lane.entries[id].seq !== seq) lane = notBefore(lane, { id, at: now() });
    if (out.settled) settle({ ...out.settled, how: result === 'saved' && res.outcome !== 'applied' ? 'quiet' : result });
    if (out.gaveUp) {
      if (out.gaveUp.kind === 'bump') link = noteBumpGaveUp(link, { now: now() });
      call(deps.onGaveUp, out.gaveUp);
    }
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
    const o = {
      seq: entry.seq, startedAt: now(), aborted: false, kind: entry.kind, bumpedAt: entry.kind === 'bump' ? entry.body.bumped_at : null,
      abort: () => { o.aborted = true; try { if (ctl) ctl.abort(); } catch { /* already ended */ } },
    };
    openWrites[entry.id] = o;
    if (o.bumpedAt) noteStamp(entry.id, o.bumpedAt, 'floating');   // from now on a copy of this bump may land, whatever the answer
    lane = sendStarted(lane, { id: entry.id, now: o.startedAt });
    let p;
    try { p = Promise.resolve(deps.writeTicket(entry.id, entry.body, entry.label, ctl ? ctl.signal : undefined, entry.guard || null)); }
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
  // A slow or offline spell that was open ends at the last look before the sleep, and its trace is
  // written now if the sleep was long (afterSleep in kdsLinkHealth.js says why).
  function noticeSleep() {
    const t = now();
    const before = lastLook;
    const slept = before ? t - before : 0;
    lastLook = t;
    if (slept < SLEEP_GAP_MS) return false;
    for (const r of openReads.values()) r.abort();
    openReads.clear();
    link = afterSleep(link, { at: before });
    flushSpell(t);
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
      try {
        // Mapped FIRST: an answer the board cannot map must leave everything as it was and count
        // as a failed read. Review 12 Oct 2026: a throw in here left the read open for ever, and
        // after two of them no list read was ever started again.
        const fresh = ans.data.map((row) => deps.mapRow(row));
        const ids = new Set(ans.data.map((row) => row.id));
        // A ticket with an older change still on its way is not judged by this list (kdsWriteLane.js).
        const busy = new Set(Object.keys(openWrites).filter((id) => lane.entries[id] && openWrites[id].seq !== lane.entries[id].seq));
        const seen = confirmBumpsFromList(lane, { ids, readStartedAt: startedAt, centreId: deps.centreId || null, now: t, busy });
        lane = seen.lane;
        for (const e of seen.settled) settle(e);
        let rows = mergeList({ rows: fresh, readStartedAt: startedAt, events });
        if (readOverlapped(link, startedAt)) {
          // Another list was used while this one was on its way: nothing is taken off the board by
          // it, and a read sent after both settles it at once (kdsBoardRows.js keepUnlisted).
          rows = keepUnlisted(rows, server);
          again = true;
        }
        server = rows;
        events = pruneEvents(forgetReturned(events, { ids, readStartedAt: startedAt }), { now: t });
        for (const [id, at] of gones) if (at < startedAt && ids.has(id)) gones.delete(id);   // waiting again: recalled on another screen
        // The bump watch: a ticket this screen bumped is waiting again while one of its own
        // recalls was still on its way. The same bump goes again; the card is not painted.
        for (const [id, w] of [...rebump]) {
          if (t >= w.until || w.left <= 0) { rebump.delete(id); continue; }
          if (lane.entries[id] || !server.some((row) => row.id === id)) continue;
          w.left -= 1;
          lane = tap(lane, { id, kind: 'bump', row: w.row || server.find((row) => row.id === id), centreId: deps.centreId || null, now: t, stamp: w.x, heal: true });
        }
        // The undo watch: a ticket this screen brought back is not in the list any more.
        for (const id of [...undone.keys()]) if (!server.some((row) => row.id === id)) heal(id);
        // The first list after a restart is in: the kept bumps it did not settle go now.
        lane = releaseRestarted(lane, { now: t });
        saveJournal();
        result = 'applied';
      } catch { result = 'failed'; }
    }
    if (result === 'failed') serverFault = !threw && !(r && r.aborted) && !!(ans && ans.error && ans.server === true);
    else if (result === 'applied') serverFault = false;
    link = readEnded(link, { n, result, now: t });
    if (result === 'applied') pump();
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
    for (const [id, u] of undone) if (t >= u.until) undone.delete(id);
    for (const [id, until] of floatingRecalls) if (t >= until) floatingRecalls.delete(id);
    for (const [id, at] of gones) if (t - at > 2 * GIVE_UP_MS) gones.delete(id);
    for (const [id, w] of rebump) if (t >= w.until) rebump.delete(id);
    for (const [id, list] of stamps) {
      if (lane.entries[id]) continue;
      const kept = list.filter((e) => t - e.at <= 2 * GIVE_UP_MS);
      if (kept.length) stamps.set(id, kept); else stamps.delete(id);
    }
    pump();
    const moved = reassess();
    flushSpell(t);
    saveJournal();   // the open spell rides in the journal, so a restart does not lose the trace
    const c = laneCounts(lane, { now: t });
    // The count in the header appears 3 s after a tap and the view must be told when that moment passes.
    if (moved || c.bumps + c.others + extra.size > 0) changed();
  }

  // ── the screen's actions ────────────────────────────────────────────────────
  function act(kind, { id, row, status }) {
    const t = now();
    const base = row || server.find((r) => r.id === id) || null;
    const prev = lane.entries[id];
    let k = kind;
    let undoes = null;
    rebump.delete(id);                       // a new tap of this ticket: it decides from here on
    // A bump that is replaced before any send of it started never existed outside this tablet.
    if (prev && prev.kind === 'bump' && kind !== 'bump') {
      const st = (stamps.get(id) || []).find((e) => e.x === prev.body.bumped_at);
      if (st && st.state === 'new') dropStamp(id, st.x);
    }
    if (kind === 'restore') {
      // Which bump does this recall undo? A row read from the database as bumped (Recall last,
      // History) names its own; otherwise the newest bump of this screen that ever left the tablet.
      if (base && base.bumpedAt) noteStamp(id, new Date(base.bumpedAt).toISOString(), 'landed');
      const known = stamps.get(id) || [];
      let names = known.map((e) => e.x).reverse();
      if (base && base.bumpedAt) { const x = new Date(base.bumpedAt).toISOString(); names = [x, ...names.filter((n) => n !== x)]; }
      if (!names.length && server.some((r) => r.id === id)) {
        // Nothing of this screen's bump ever left the tablet, so the row is as it was: the Undo
        // is only the status the card had (a plain Hold or Resume, which cannot un bump anything).
        k = status === 'held' ? 'hold' : 'resume';
        undone.delete(id);
      } else {
        undoes = names[0] || null;
        // The undo watch: only when a bump may still be on its way, or more than one may be on the row.
        if (undoes && (names.length > 1 || known.some((e) => e.state === 'floating'))) {
          undone.set(id, { stamps: names, status: status === 'held' ? 'held' : 'pending', row: base, until: t + GIVE_UP_MS, left: names.length + 2, tried: 0 });
        } else undone.delete(id);
      }
    } else if (kind === 'bump') {
      undone.delete(id);                     // the last tap is a bump: nothing of this ticket is brought back any more
    } else if (undone.has(id)) {
      undone.get(id).status = kind === 'hold' ? 'held' : 'pending';
    }
    lane = tap(lane, { id, kind: k, row: base, status, centreId: deps.centreId || null, now: t, undoes });
    if (kind === 'bump') {
      const e = lane.entries[id];
      if (e && e.kind === 'bump') noteStamp(id, e.body.bumped_at, 'new');
    }
    saveJournal();
    pump();
    reassess();
    changed();
  }

  return {
    start() {
      if (running) return;
      running = true;
      const t = now();
      const kept = deps.journal && deps.journal.load ? deps.journal.load() : null;
      // A bump kept from before the restart waits for the first list answer, 5 s at most: a ticket
      // that list no longer holds is in the database already and needs no second write (review 12
      // Oct 2026: a page closed in the tenth of a second a healthy write takes wrote it twice).
      lane = fromJournal(kept, { now: t, sendAfter: t + SLOW_MS });
      for (const e of Object.values(lane.entries)) {
        // Kept across the restart: whether the old page's sends landed is not known.
        if (e.kind === 'bump') noteStamp(e.id, e.body.bumped_at, 'floating');
        else if (e.guard && e.guard.match && e.guard.match.bumped_at) {
          // A kept recall: the bump it undoes may still be on its way.
          noteStamp(e.id, e.guard.match.bumped_at, 'floating');
          undone.set(e.id, { stamps: [e.guard.match.bumped_at], status: e.body.status, row: e.row, until: t + GIVE_UP_MS, left: 3, tried: 0 });
        }
      }
      link = { ...link, spell: spellFromJournal(kept, { now: t }) };
      lastJournal = kept;
      lastLook = t;
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
      // Requests still in flight are left to finish: a bump on its way must still land. When its
      // answer says the database has it, it leaves the journal (closeSend); with no answer the
      // journal sends it again on the next start.
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
      if (!cur) {
        // A card painted from its unsaved recall only (kdsWriteLane.js patchEntryRow).
        const next = patchEntryRow(lane, id, patch);
        if (next === lane) return;
        lane = next;
        saveJournal();
        changed();
        return;
      }
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
      // See liveUpdate: never painted over a ticket this screen saw go.
      if (sawItGo(t.id)) { load(); return; }
      server = upsertRow(server, t);
      events = noteEvent(events, { id: t.id, kind: 'row', row: t, at: now() });
      changed();
    },
    liveUpdate(dbRow) {
      const t = deps.mapRow(dbRow);
      if (!t || !t.id) return;
      if (dbRow.status === 'bumped') {
        // The late echo of a bump this screen has ALREADY undone (its recall of that very bump was
        // answered by the database) says nothing new: the ticket is waiting. Review 12 Oct 2026
        // (a fuzz run): on a slow link the echo of the bump arrived after the Undo was saved and
        // took the card off again until the next list read. With the undo watch up it could also
        // be another copy of that bump landing late, so there the guarded recall goes once more.
        const known = (stamps.get(t.id) || []).find((e) => instant(e.x) === instant(dbRow.bumped_at));
        const mine = lane.entries[t.id];
        if (known && known.undoneAt && !(mine && mine.kind === 'bump') && !gones.has(t.id)) {
          if (undone.has(t.id) && heal(t.id, known.x)) { saveJournal(); pump(); reassess(); changed(); }
          return;
        }
        wentOff(t.id, now());
        if (known) noteStamp(t.id, known.x, 'landed');     // the echo of that very bump: it is in the database
        const seen = confirmBumpFromLive(lane, { id: t.id, bumpedAt: dbRow.bumped_at, now: now() });
        lane = seen.lane;
        if (seen.settled) settle(seen.settled);
        // The undo watch: a bump this screen undid has landed after all. Undo that very bump again.
        const u = undone.get(t.id);
        const late = u ? u.stamps.find((x) => instant(x) === instant(dbRow.bumped_at)) : null;
        if (late) heal(t.id, late);
        saveJournal();
        if (!deps.centreId || t.centreId === deps.centreId) call(deps.onBumpedLive, t);
        pump();
        reassess();
        changed();
        return;
      }
      if (deps.centreId && t.centreId !== deps.centreId) return;
      if (t.status === 'pending' || t.status === 'held') {
        // Review 12 Oct 2026 (K1): the live echo of an OLDER write of this ticket (an item tick, a
        // Hold) carries status pending. Arriving after this screen's bump was saved, it painted the
        // bumped ticket back with nobody tapping, until the next list read. A ticket this screen
        // saw go is not painted from a live change: a list read sent now decides. If another
        // screen really recalled it, it is back within that one read.
        // (Not for a ticket staff have just brought back here: its own recall landing is such a change.)
        if (sawItGo(t.id)) { load(); return; }
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
        serverFault: level === 'offline' && serverFault,
      };
    },
    /** For tests and the trace. */
    debug() { return { lane, link, server, openWrites: Object.keys(openWrites), openReads: [...openReads.keys()], undone: [...undone.keys()], rebump: [...rebump.keys()] }; },
  };
}
