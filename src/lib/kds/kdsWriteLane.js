// src/lib/kds/kdsWriteLane.js
//
// 12 Oct 2026, Coffee Boy Barnsley, drinks screen: the tablet's link hung requests for 30 to 380
// seconds. A bump took the card off at the tap, its write had no time limit and no visible state,
// and the 20 second list reload painted the ticket back while the write was still on its way
// ("recalling items without us touching anything"). A bump that failed outright was dropped after
// a 2.8 second message. A late Hold or Resume could land after a newer Bump.
//
// This file is the rule for every status change a kitchen screen makes to a ticket (bump, hold,
// resume, recall or undo). One ticket holds ONE unsaved change at a time: the newest tap. It is
// sent with a time limit, sent again with the SAME body until the database answers, and counted on
// the board while it is unsaved. A newer tap waits for the older send to end by itself, so writes
// of one ticket leave the tablet in tap order. A bump hides its ticket until it is saved or has
// truly failed; then the card comes back and SAYS so.
//
// Pure: no React, no Supabase, no timers, no storage. The board engine (kdsBoardEngine.js) owns
// the sends; this file only decides.

/**
 * ONE send per ticket is in flight at a time, and it is left to end by itself: answered, or failed
 * by the network. Only then does the next send of that ticket go (the same body again, or a newer
 * tap), so two writes of one ticket are never on their way side by side. Sent side by side, an old
 * and a new write would race in the database (12 Oct: the bursts landed in scrambled order, and
 * the same bump landed three times).
 * This limit is the safety valve for a send that would never end (one still waiting for the sign
 * in token, a network stack with no limit of its own): it is cancelled after this long and the
 * ticket's next send goes. The tablet's own network gives up on a request at about 60 s. A healthy
 * write answers in about 0.1 s.
 * What one send at a time cannot rule out: a request the network gave up on, or one the valve
 * cancelled after it had left (the client sends a failed request once more by itself,
 * lib/netRetry.js, and the valve can end that second try), is STILL delivered when a stalled link
 * lets go, in any order. The same body again does no harm. An older change landing after a newer
 * one is stopped by the guard each change carries (guardFor, below).
 */
export const WRITE_ATTEMPT_MS = 75000;
/** Waits after a send that failed FAST (the network said no at once). A send that ended at the limit goes again at once, so one is always waiting when a stalled link lets requests through. */
export const FAST_FAIL_DELAYS_MS = Object.freeze([1000, 2000, 5000, 10000]);
/** An unsaved change older than this has truly failed. 12 Oct: the worst bump took 378 s and the screen was cut off for 7 minutes; 10 minutes covers both. */
export const GIVE_UP_MS = 10 * 60 * 1000;
/** The header only counts changes that have been unsaved this long, so a healthy screen never flickers a count. */
export const SAVING_SHOW_AFTER_MS = 3000;
/** A bump unsaved this long makes the screen "slow" (the banner) and counts as a late bump in the trace. */
export const LATE_BUMP_MS = 10000;
/** Unsaved bumps kept across a restart are dropped after a day. */
export const JOURNAL_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const JOURNAL_VERSION = 1;

export const KINDS = Object.freeze(['bump', 'hold', 'resume', 'restore']);

const LABELS = Object.freeze({
  bump: 'Kitchen ticket bumped', hold: 'Kitchen ticket held', resume: 'Kitchen ticket resumed', restore: 'Kitchen ticket recalled',
});

export const emptyLane = () => ({ entries: {}, seq: 0 });

/** The exact body one tap sends, built ONCE at the tap and never rebuilt (same bumped_at on every send). */
export function bodyFor(kind, { now = Date.now(), status = 'pending' } = {}) {
  if (kind === 'bump') return { status: 'bumped', bumped_at: new Date(now).toISOString() };
  if (kind === 'hold') return { status: 'held' };
  if (kind === 'resume') return { status: 'pending' };
  if (kind === 'restore') return { status: status === 'held' ? 'held' : 'pending', bumped_at: null };
  return null;
}

export const labelFor = (kind) => LABELS[kind] || 'Kitchen ticket changed';

/**
 * 12 Oct 2026, review of this build (two reviewers, each on the real engine): with a burst
 * delivered out of order, a Hold the network had given up on landed AFTER the Bump that replaced
 * it and the ticket came back on hold with nothing said; an Undo landed BEFORE the bump it undid
 * and the ticket staff had brought back left the board again.
 * So a change carries a GUARD that is part of the write itself (plain filters, no schema change):
 *   hold, resume  only a ticket that is not bumped. Landing late, after a Bump, it changes nothing.
 *   restore       only the very bump it undoes (the same bumped_at). Landing after a NEWER bump it
 *                 changes nothing. Landing before its own bump it changes nothing either, and the
 *                 engine sends it again when that bump shows up (kdsBoardEngine.js, the undo watch).
 *   bump          none: a bump always wins, and the same bump twice is the same bump.
 * `undoes` is the bumped_at of the bump a recall undoes, when it is known.
 * The guard is { match } (equal) and { notMatch } (not equal), the two filters a copy parked by the
 * device link fence keeps (lib/rowWriteFence.js parkedWriteItem), so a parked copy is guarded too.
 * Live rows on 12 Oct 2026: every bumped_at in 30 days is a whole millisecond and no row has an
 * empty status, so both filters match exactly what the board shows.
 */
export function guardFor(kind, { undoes = null } = {}) {
  if (kind === 'hold' || kind === 'resume') return { notMatch: { status: 'bumped' } };
  if (kind === 'restore' && undoes) return { match: { bumped_at: undoes } };
  return null;
}

const withEntry = (lane, entry) => ({ ...lane, entries: { ...lane.entries, [entry.id]: entry } });
/** The board's row without this file's own "not saved" mark (a card tapped while it says "Bump not saved"). */
const plainRow = (row) => {
  if (!row || !('unsaved' in row)) return row || null;
  const copy = { ...row };
  delete copy.unsaved;
  return copy;
};
const without = (lane, id) => {
  if (!lane.entries[id]) return lane;
  const entries = { ...lane.entries };
  delete entries[id];
  return { ...lane, entries };
};
const undoesOf = (entry) => (entry && entry.guard && entry.guard.match ? entry.guard.match.bumped_at || null : null);

/**
 * A tap. The newest tap for a ticket replaces any older unsaved change of it (the later tap always
 * wins). A second Bump while the first is still unsaved changes nothing: one bump, one body.
 *   row       the board's copy of the ticket at the tap (a recall shows it at once; a restart needs it)
 *   centreId  the board's station at the tap (a list for another station proves nothing about it)
 *   undoes    restore only: the bumped_at of the bump it undoes (its guard)
 *   stamp     bump only: the bumped_at to send, when the engine sends an earlier bump of this
 *             screen again (the same bump, so the same time). Left out: the time of the tap.
 *   heal      sent by the engine itself, not tapped (kdsBoardEngine.js, the undo and bump watches)
 *   keep      hold and resume only: the card is painted from `row` even when the database's rows
 *             do not hold the ticket (the engine's Hold or Resume after a recall the database
 *             refused: the ticket was brought back by staff and must not leave on a late echo)
 *
 * Hold or Resume on a card whose recall is NOT saved yet stays a recall, with the new status: one
 * write that both un bumps the ticket and holds it. (Review 12 Oct 2026: a Hold used to REPLACE the
 * unsaved recall. The card, painted only from that recall, vanished at the tap, and the un bump was
 * never sent.)
 */
export function tap(lane, { id, kind, row = null, status, centreId = null, now = Date.now(), undoes = null, stamp = null, heal = false, keep = false } = {}) {
  if (!id || !KINDS.includes(kind)) return lane;
  const prev = lane.entries[id];
  let k = kind; let st = status; let x = undoes; let h = heal === true;
  if (prev && prev.kind === 'restore' && (kind === 'hold' || kind === 'resume')) {
    k = 'restore'; st = kind === 'hold' ? 'held' : 'pending'; x = undoesOf(prev); h = prev.heal === true;
  }
  if (prev && prev.kind === k && prev.state !== 'failed' && (k !== 'restore' || prev.body.status === bodyFor('restore', { status: st }).status)) return lane;
  const seq = lane.seq + 1;
  const entry = {
    id, kind: k, body: k === 'bump' && stamp ? { status: 'bumped', bumped_at: stamp } : bodyFor(k, { now, status: st }), label: labelFor(k),
    at: now, since: now, tapAt: now, attempts: 0, fails: 0, state: 'waiting', nextAt: now,
    row: plainRow(row) || (prev ? prev.row : null), centreId: centreId || null, seq,
    guard: guardFor(k, { undoes: x }), heal: (k === 'restore' || k === 'bump') && h,
    keep: (k === 'hold' || k === 'resume') && (keep === true || !!(prev && prev.keep)),
  };
  return { ...withEntry(lane, entry), seq };
}

/** "Bump not saved. Tap to try again.": the SAME bump (same body, same bumped_at) goes again. */
export function retryFailedBump(lane, { id, now = Date.now() } = {}) {
  const e = lane.entries[id];
  if (!e || e.kind !== 'bump' || e.state !== 'failed') return lane;
  const seq = lane.seq + 1;
  return { ...withEntry(lane, { ...e, state: 'waiting', since: now, tapAt: now, nextAt: now, attempts: 0, fails: 0, seq }), seq };
}

/**
 * What the engine should do now.
 *   open  { [ticketId]: { seq, startedAt } }  the sends still in flight (one per ticket at most)
 * Returns { send: [entry], cancel: [ticketId] }.
 *   send    entries whose turn it is and whose ticket has nothing in flight
 *   cancel  sends that passed WRITE_ATTEMPT_MS with no end (the safety valve)
 */
export function dueSends(lane, { now = Date.now(), open = {} } = {}) {
  const send = [];
  const cancel = [];
  for (const [id, o] of Object.entries(open)) if (now - o.startedAt >= WRITE_ATTEMPT_MS) cancel.push(id);
  for (const e of Object.values(lane.entries)) {
    if (e.state !== 'waiting' || e.nextAt > now || open[e.id]) continue;
    send.push(e);
  }
  send.sort((a, b) => a.seq - b.seq);
  return { send, cancel };
}

export function sendStarted(lane, { id, now = Date.now() } = {}) {
  const e = lane.entries[id];
  if (!e) return lane;
  return withEntry(lane, { ...e, state: 'sending', attempts: e.attempts + 1, sendStartedAt: now });
}

function giveUp(lane, e) {
  // A bump that truly failed stays in the lane as 'failed': its card comes back and says so.
  // Any other change is dropped: the board shows what the database holds and a message says so.
  if (e.kind === 'bump') return withEntry(lane, { ...e, state: 'failed' });
  return without(lane, e.id);
}

/**
 * A send ended.
 *   result  'saved'    the database answered and changed the row: done
 *           'gone'     the database answered and changed nothing: the row is gone, or the guard of
 *                      this change refused it (guardFor). Done here; the engine decides what it means
 *           'kept'     the device link fence parked it in the offline queue (lib/rowWriteFence.js): done here
 *           'timeout'  no end inside WRITE_ATTEMPT_MS (cancelled by the valve): sent again at once
 *           'failed'   the network or the database said no: sent again after a short wait
 * Returns { lane, settled, gaveUp }: settled is the saved entry (with how and tookMs), gaveUp the
 * entry that passed GIVE_UP_MS. A result for a change that was since replaced changes nothing.
 * tookMs runs from `since`: the tap, moved on by a sleep of the tablet and by a tap on "Bump not
 * saved" (review 12 Oct 2026: measured from the first tap, a retried bump read as "23 min late"
 * and wrote a second trace for one incident).
 */
export function sendEnded(lane, { id, seq, result, now = Date.now() } = {}) {
  const e = lane.entries[id];
  if (!e || e.seq !== seq) return { lane, settled: null, gaveUp: null };
  if (result === 'saved' || result === 'kept' || result === 'gone') {
    return { lane: without(lane, id), settled: { ...e, how: result, savedAt: now, tookMs: now - e.since }, gaveUp: null };
  }
  if (now - e.since >= GIVE_UP_MS) return { lane: giveUp(lane, e), settled: null, gaveUp: e };
  const fails = result === 'timeout' ? 0 : e.fails + 1;
  const wait = result === 'timeout' ? 0 : FAST_FAIL_DELAYS_MS[Math.min(fails - 1, FAST_FAIL_DELAYS_MS.length - 1)];
  return { lane: withEntry(lane, { ...e, state: 'waiting', fails, nextAt: now + wait }), settled: null, gaveUp: null };
}

/**
 * A list read that STARTED after a bump was tapped and does not hold the ticket proves the
 * database has it bumped (the answer to the write was lost, or another screen bumped it): saved.
 * Only bumps are judged this way; hold, resume and recall wait for their own answer.
 *   ids            Set of ticket ids in the list (pending and held rows of this board's station)
 *   readStartedAt  when that read was sent
 *   busy           Set of ticket ids with an OLDER change still on its way (its send is open). Such
 *                  a ticket is not judged. Review 12 Oct 2026 (found by a fuzz run): Bump, Undo,
 *                  Bump again while the Undo's write was in flight. A list showed the ticket gone
 *                  (the FIRST bump), the second bump was counted as saved without ever being sent,
 *                  the Undo then landed, and the ticket came back with nobody tapping.
 */
export function confirmBumpsFromList(lane, { ids, readStartedAt, centreId = null, now = Date.now(), busy = null } = {}) {
  let out = lane;
  const settled = [];
  for (const e of Object.values(lane.entries)) {
    // Only a list SENT after the tap, and after the last older change of the ticket ended (notBefore).
    if (e.kind !== 'bump' || !(Math.max(e.at, e.clearAt || 0) < readStartedAt) || ids.has(e.id)) continue;
    if (busy && busy.has(e.id)) continue;
    // The same across a restart: this bump was kept while an older change of its ticket was still
    // on its way (toJournal `behind`), and the new page cannot see that send. Until this bump's own
    // send has started, a list proves nothing about it.
    if (e.behind && e.attempts === 0) continue;
    if ((e.centreId || null) !== (centreId || null)) continue;
    out = without(out, e.id);
    settled.push({ ...e, how: 'seen', savedAt: now, tookMs: now - e.since });
  }
  return { lane: out, settled };
}

/**
 * An OLDER change of this ticket has just ended (its send was answered or gave up) while a bump
 * waits behind it. A list read sent before this moment may have been answered by the database
 * before that older change landed, so it proves nothing about the bump (review 12 Oct 2026, a fuzz
 * run: Bump, Undo, Bump. A list read just before the Undo landed showed the ticket gone, the second
 * bump was counted as saved and never sent, and the Undo brought the ticket back).
 */
export function notBefore(lane, { id, at } = {}) {
  const e = lane.entries[id];
  if (!e || e.kind !== 'bump') return lane;
  return withEntry(lane, { ...e, clearAt: Math.max(e.clearAt || 0, at) });
}

/** The live echo of this screen's own bump (same bumped_at): saved. */
export function confirmBumpFromLive(lane, { id, bumpedAt, now = Date.now() } = {}) {
  const e = lane.entries[id];
  if (!e || e.kind !== 'bump') return { lane, settled: null };
  const mine = new Date(e.body.bumped_at).getTime();
  const theirs = bumpedAt ? new Date(bumpedAt).getTime() : NaN;
  if (!Number.isFinite(theirs) || theirs !== mine) return { lane, settled: null };
  return { lane: without(lane, id), settled: { ...e, how: 'seen', savedAt: now, tookMs: now - e.since } };
}

/**
 * Counts for the header and the banner. Ages run from the last TAP of the change (`tapAt`): the
 * first tap, or the tap on "Bump not saved" (review 12 Oct 2026: measured from the first tap, a
 * bump tapped again 12 minutes after an outage put the amber banner up on a healthy link). A sleep
 * of the tablet does NOT shorten them: a bump that has been unsaved all night says so on waking.
 */
export function laneCounts(lane, { now = Date.now() } = {}) {
  let bumps = 0, others = 0, failedBumps = 0, oldestBumpAt = null, oldestAt = null;
  for (const e of Object.values(lane.entries)) {
    if (e.kind === 'bump' && e.state === 'failed') { failedBumps += 1; continue; }
    const from = Number.isFinite(e.tapAt) ? e.tapAt : e.at;
    if (e.kind === 'bump') { bumps += 1; if (oldestBumpAt === null || from < oldestBumpAt) oldestBumpAt = from; }
    else others += 1;
    if (oldestAt === null || from < oldestAt) oldestAt = from;
  }
  return {
    bumps, others, failedBumps,
    oldestBumpMs: oldestBumpAt === null ? 0 : Math.max(0, now - oldestBumpAt),
    oldestMs: oldestAt === null ? 0 : Math.max(0, now - oldestAt),
  };
}

/**
 * The newest bump this screen has not saved yet (its ticket is hidden), or null. Recall last asks
 * for it first: such a ticket is not in the database as bumped yet, so a read of "the last bumped"
 * cannot find it and would bring back an OLDER ticket instead. A bump that has failed is not
 * counted: its card is already back on the board.
 */
export function newestUnsavedBump(lane) {
  let last = null;
  for (const e of Object.values(lane.entries)) {
    if (e.kind !== 'bump' || e.state === 'failed' || !e.row) continue;
    if (!last || e.at > last.at || (e.at === last.at && e.seq > last.seq)) last = e;
  }
  return last;
}

/** One row from the database (list or live) as the board may paint it: null = do not paint. */
export function paintOne(lane, row) {
  if (!row) return null;
  const e = lane.entries[row.id];
  if (!e) return row;
  if (e.kind === 'bump') return e.state === 'failed' ? { ...row, unsaved: 'bump' } : null;
  if (e.kind === 'hold') return { ...row, status: 'held', held: true };
  if (e.kind === 'resume') return { ...row, status: 'pending', held: false };
  return { ...row, status: e.body.status, held: e.body.status === 'held', bumpedAt: null };
}

/**
 * What the board paints: the database's rows with this screen's unsaved changes on top.
 * K1: a ticket with an unsaved bump is never painted. A recall shows its card at once.
 */
export function paint(lane, rows) {
  const out = [];
  const seen = new Set();
  for (const r of rows || []) {
    seen.add(r.id);
    const p = paintOne(lane, r);
    if (p) out.push(p);
  }
  for (const e of Object.values(lane.entries)) {
    if ((e.kind !== 'restore' && !e.keep) || seen.has(e.id) || !e.row) continue;
    out.push({ ...e.row, status: e.body.status, held: e.body.status === 'held', bumpedAt: null });
  }
  return out;
}

/**
 * A local change (an item tick, a saved note) to a card that is painted from its unsaved recall
 * only: the database's rows do not hold it yet. Review 12 Oct 2026: such a tick was not painted,
 * so a second tap toggled it straight back off.
 */
export function patchEntryRow(lane, id, patch) {
  const e = lane.entries[id];
  if (!e || !e.row) return lane;
  return withEntry(lane, { ...e, row: { ...e.row, ...patch } });
}

/**
 * Unsaved bumps AND unsaved recalls, to keep across a restart of the app. Review 12 Oct 2026: only
 * bumps were kept, so staff who restarted a slow app (they did, at 14:50:48) lost an Undo or a
 * Recall with nothing said: the old bump, already on the network, landed and the order they had
 * brought back was gone. Hold and Resume are not kept: a restart shows what the database holds.
 */
export function toJournal(lane, extra = null, { behind = null } = {}) {
  const entries = Object.values(lane.entries).filter((e) => e.kind === 'bump' || e.kind === 'restore')
    .sort((a, b) => a.seq - b.seq)
    .map((e) => ({
      id: e.id, body: e.body, at: e.at, since: e.since, tapAt: e.tapAt, centreId: e.centreId, failed: e.state === 'failed', row: e.row,
      ...(e.kind === 'restore' ? { kind: 'restore', guard: e.guard || null, heal: e.heal === true } : null),
      // behind: Set of ticket ids whose bump waits behind an older change of the ticket that is
      // still on its way (see confirmBumpsFromList).
      ...(e.kind === 'bump' && behind && behind.has(e.id) ? { behind: true } : null),
    }));
  // `extra` rides along untouched (the engine keeps the open slow spell there, kdsLinkHealth.js).
  return JSON.stringify({ v: JOURNAL_VERSION, entries, ...(extra && typeof extra === 'object' ? extra : null) });
}

/**
 * The lane after a restart. A bump past GIVE_UP_MS comes back as failed (its card says so); a
 * recall that old is dropped (the board shows what the database holds).
 *   sendAfter  when a kept bump may first be sent (the engine lets the first list answer in before
 *              that, so a bump the database already holds is not written a second time)
 * Entries carry restarted: true.
 */
export function fromJournal(text, { now = Date.now(), sendAfter = now } = {}) {
  let parsed = null;
  try { parsed = typeof text === 'string' ? JSON.parse(text) : text; } catch { parsed = null; }
  let lane = emptyLane();
  const list = parsed && parsed.v === JOURNAL_VERSION && Array.isArray(parsed.entries) ? parsed.entries : [];
  for (const j of list) {
    if (!j || !j.id || !j.body) continue;
    const kind = j.kind === 'restore' ? 'restore' : 'bump';
    if (kind === 'bump' && (j.body.status !== 'bumped' || !j.body.bumped_at)) continue;
    if (kind === 'restore' && ((j.body.status !== 'pending' && j.body.status !== 'held') || j.body.bumped_at !== null || !j.row)) continue;
    const at = Number(j.at);
    if (!Number.isFinite(at) || now - at > JOURNAL_MAX_AGE_MS) continue;
    const since = Number.isFinite(Number(j.since)) ? Number(j.since) : at;
    const old = now - since >= GIVE_UP_MS;
    if (kind === 'restore' && old) continue;
    const seq = lane.seq + 1;
    const failed = kind === 'bump' && (j.failed === true || old);
    const undoes = kind === 'restore' && j.guard && j.guard.match && typeof j.guard.match.bumped_at === 'string' ? j.guard.match.bumped_at : null;
    const behind = kind === 'bump' && j.behind === true;
    lane = { ...withEntry(lane, {
      id: j.id, kind, body: j.body, label: labelFor(kind), at, since, tapAt: Number.isFinite(Number(j.tapAt)) ? Number(j.tapAt) : at, attempts: 0, fails: 0,
      // A kept bump waits for the first list, unless a list could prove nothing about it (behind).
      state: failed ? 'failed' : 'waiting', nextAt: kind === 'bump' && !failed && !behind ? Math.max(now, sendAfter) : now,
      row: j.row || null, centreId: j.centreId || null, seq,
      guard: guardFor(kind, { undoes }), heal: kind === 'restore' && j.heal === true, restarted: true, behind,
    }), seq };
  }
  return lane;
}

/** The first list after a restart is in (or could not tell in time): kept bumps that are still unsaved go now. */
export function releaseRestarted(lane, { now = Date.now() } = {}) {
  let out = lane;
  for (const e of Object.values(lane.entries)) {
    if (!e.restarted || e.state !== 'waiting' || e.attempts > 0 || e.nextAt <= now) continue;
    out = withEntry(out, { ...e, nextAt: now });
  }
  return out;
}

/**
 * The journal text without one bump (same ticket, same bumped_at). For an engine that was stopped
 * while that bump's write was on its way and then saw it answered: the database has it, so the next
 * start must not send it again. Read, change and written in one go, because a NEW engine may
 * already own the journal. Returns the same text when there is nothing to take out.
 */
export function journalWithout(text, { id, bumpedAt } = {}) {
  let parsed = null;
  try { parsed = typeof text === 'string' ? JSON.parse(text) : null; } catch { parsed = null; }
  if (!parsed || !Array.isArray(parsed.entries)) return text;
  const entries = parsed.entries.filter((j) => !(j && j.id === id && j.kind !== 'restore' && j.body && j.body.bumped_at === bumpedAt));
  if (entries.length === parsed.entries.length) return text;
  return JSON.stringify({ ...parsed, entries });
}
