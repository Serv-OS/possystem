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
// of one ticket reach the database in tap order. A bump hides its ticket until it is saved or has
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
 * ticket's next send goes. The tablet's own network gives up on a request at about 60 s, so the
 * valve mostly ends a request that had not left the tablet. A healthy write answers in about 0.1 s.
 * What this cannot rule out: a request the network gave up on, or one the valve cancelled after it
 * had left (the client sends a failed request once more by itself, lib/netRetry.js, and the valve
 * can end that second try), may still be delivered when a stalled link lets go. The same body
 * again does no harm. An older change landing after a newer one needs a guard in the database.
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

/**
 * A tap. The newest tap for a ticket replaces any older unsaved change of it (the later tap always
 * wins). A second Bump while the first is still unsaved changes nothing: one bump, one body.
 *   row       the board's copy of the ticket at the tap (a recall shows it at once; a restart needs it)
 *   centreId  the board's station at the tap (a list for another station proves nothing about it)
 */
export function tap(lane, { id, kind, row = null, status, centreId = null, now = Date.now() } = {}) {
  if (!id || !KINDS.includes(kind)) return lane;
  const prev = lane.entries[id];
  if (prev && prev.kind === kind && prev.state !== 'failed' && (kind !== 'restore' || prev.body.status === bodyFor('restore', { status }).status)) return lane;
  const seq = lane.seq + 1;
  const entry = {
    id, kind, body: bodyFor(kind, { now, status }), label: labelFor(kind),
    at: now, since: now, attempts: 0, fails: 0, state: 'waiting', nextAt: now,
    row: plainRow(row) || (prev ? prev.row : null), centreId: centreId || null, seq,
  };
  return { ...withEntry(lane, entry), seq };
}

/** "Bump not saved. Tap to try again.": the SAME bump (same body, same bumped_at) goes again. */
export function retryFailedBump(lane, { id, now = Date.now() } = {}) {
  const e = lane.entries[id];
  if (!e || e.kind !== 'bump' || e.state !== 'failed') return lane;
  const seq = lane.seq + 1;
  return { ...withEntry(lane, { ...e, state: 'waiting', since: now, nextAt: now, attempts: 0, fails: 0, seq }), seq };
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
 *   result  'saved'    the database answered: done
 *           'kept'     the device link fence parked it in the offline queue (lib/rowWriteFence.js): done here
 *           'timeout'  no end inside WRITE_ATTEMPT_MS (cancelled by the valve): sent again at once
 *           'failed'   the network or the database said no: sent again after a short wait
 * Returns { lane, settled, gaveUp }: settled is the saved entry (with how and tookMs), gaveUp the
 * entry that passed GIVE_UP_MS. A result for a change that was since replaced changes nothing.
 */
export function sendEnded(lane, { id, seq, result, now = Date.now() } = {}) {
  const e = lane.entries[id];
  if (!e || e.seq !== seq) return { lane, settled: null, gaveUp: null };
  if (result === 'saved' || result === 'kept') {
    return { lane: without(lane, id), settled: { ...e, how: result, savedAt: now, tookMs: now - e.at }, gaveUp: null };
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
 */
export function confirmBumpsFromList(lane, { ids, readStartedAt, centreId = null, now = Date.now() } = {}) {
  let out = lane;
  const settled = [];
  for (const e of Object.values(lane.entries)) {
    if (e.kind !== 'bump' || !(e.at < readStartedAt) || ids.has(e.id)) continue;
    if ((e.centreId || null) !== (centreId || null)) continue;
    out = without(out, e.id);
    settled.push({ ...e, how: 'seen', savedAt: now, tookMs: now - e.at });
  }
  return { lane: out, settled };
}

/** The live echo of this screen's own bump (same bumped_at): saved. */
export function confirmBumpFromLive(lane, { id, bumpedAt, now = Date.now() } = {}) {
  const e = lane.entries[id];
  if (!e || e.kind !== 'bump') return { lane, settled: null };
  const mine = new Date(e.body.bumped_at).getTime();
  const theirs = bumpedAt ? new Date(bumpedAt).getTime() : NaN;
  if (!Number.isFinite(theirs) || theirs !== mine) return { lane, settled: null };
  return { lane: without(lane, id), settled: { ...e, how: 'seen', savedAt: now, tookMs: now - e.at } };
}

/** Counts for the header and the banner. */
export function laneCounts(lane, { now = Date.now() } = {}) {
  let bumps = 0, others = 0, failedBumps = 0, oldestBumpAt = null, oldestAt = null;
  for (const e of Object.values(lane.entries)) {
    if (e.kind === 'bump' && e.state === 'failed') { failedBumps += 1; continue; }
    if (e.kind === 'bump') { bumps += 1; if (oldestBumpAt === null || e.at < oldestBumpAt) oldestBumpAt = e.at; }
    else others += 1;
    if (oldestAt === null || e.at < oldestAt) oldestAt = e.at;
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
    if (e.kind !== 'restore' || seen.has(e.id) || !e.row) continue;
    out.push({ ...e.row, status: e.body.status, held: e.body.status === 'held', bumpedAt: null });
  }
  return out;
}

/** Unsaved bumps, to keep across a restart of the app (the other kinds are not kept: a restart shows what the database holds). */
export function toJournal(lane, extra = null) {
  const entries = Object.values(lane.entries).filter((e) => e.kind === 'bump')
    .sort((a, b) => a.seq - b.seq)
    .map((e) => ({ id: e.id, body: e.body, at: e.at, since: e.since, centreId: e.centreId, failed: e.state === 'failed', row: e.row }));
  // `extra` rides along untouched (the engine keeps the open slow spell there, kdsLinkHealth.js).
  return JSON.stringify({ v: JOURNAL_VERSION, entries, ...(extra && typeof extra === 'object' ? extra : null) });
}

/** The lane after a restart. A bump past GIVE_UP_MS comes back as failed (its card says so). */
export function fromJournal(text, { now = Date.now() } = {}) {
  let parsed = null;
  try { parsed = typeof text === 'string' ? JSON.parse(text) : text; } catch { parsed = null; }
  let lane = emptyLane();
  const list = parsed && parsed.v === JOURNAL_VERSION && Array.isArray(parsed.entries) ? parsed.entries : [];
  for (const j of list) {
    if (!j || !j.id || !j.body || j.body.status !== 'bumped' || !j.body.bumped_at) continue;
    const at = Number(j.at);
    if (!Number.isFinite(at) || now - at > JOURNAL_MAX_AGE_MS) continue;
    const since = Number.isFinite(Number(j.since)) ? Number(j.since) : at;
    const seq = lane.seq + 1;
    const failed = j.failed === true || now - since >= GIVE_UP_MS;
    lane = { ...withEntry(lane, {
      id: j.id, kind: 'bump', body: j.body, label: labelFor('bump'), at, since, attempts: 0, fails: 0,
      state: failed ? 'failed' : 'waiting', nextAt: now, row: j.row || null, centreId: j.centreId || null, seq,
    }), seq };
  }
  return lane;
}
