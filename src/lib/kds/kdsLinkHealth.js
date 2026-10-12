// src/lib/kds/kdsLinkHealth.js
//
// 12 Oct 2026, Barnsley: the only warning was a thin pale strip shown while a list read was
// failing; any read that came back, even one that was thrown away, turned it off; and an empty
// board still said "Kitchen clear". Staff were never told the screen was slow.
//
// The rule: the screen is 'ok', 'slow' or 'offline'.
//   slow     a request has been open over 5 s, or a bump has been unsaved over 10 s
//   offline  list reads are failing (two in a row failed, or one has had no answer for 30 s)
//   ok       only after TWO list reads in a row were used and each took under 5 s
// "Kitchen clear" is only said when the screen is sure. One trace is written when a spell ends.
//
// Pure: no React, no Supabase, no timers.

import { LATE_BUMP_MS } from './kdsWriteLane.js';

/** The list poll, unchanged. */
export const POLL_MS = 20000;
/** A request open this long makes the screen slow. A healthy read answers in about 0.1 s. */
export const SLOW_MS = 5000;
/** A second list read may start beside one that has had no answer for this long (the 15 s the old read gave up at). The first is NOT cancelled: a late answer is still used. */
export const READ_SECOND_AFTER_MS = 15000;
/** No answer to a list read for this long: the screen is offline (a read that fails outright says so at once). */
export const READ_OFFLINE_MS = 30000;
/** An unanswered read is cancelled after this (the tablet itself gives up at 60 s). */
export const READ_CANCEL_MS = 45000;
/** Never more than two list reads open at once. */
export const MAX_OPEN_READS = 2;
/** After a read that failed or could not be used, the next one starts this soon, not at the next 20 s poll. */
export const RETRY_AFTER_FAIL_MS = 5000;
/** The warning clears after this many good list reads in a row. */
export const GOOD_READS_TO_CLEAR = 2;
/** No list used for this long: the screen is not sure what is waiting. */
export const STALE_MS = 45000;
/** Two list reads in a row must fail before the screen says offline: one blip (a 503 while the database reloads) only says slow. */
export const FAILS_TO_OFFLINE = 2;
/** A gap this long between two looks at the clock means the tablet slept (its timers stood still). */
export const SLEEP_GAP_MS = 10000;
/** A spell shorter than this, with no late bump and never offline, is not worth a trace. */
export const SPELL_MIN_MS = 60000;
/** A new spell inside this long after the last one is the same spell: one trace, not many. */
export const SPELL_QUIET_MS = 5 * 60 * 1000;

export const newLink = () => ({
  seq: 0, open: [], lastAppliedN: 0, lastAppliedAt: 0, everApplied: false,
  fails: 0, goodRun: 0, warned: false, level: 'ok', spell: null,
});

/** May a list read start now? One at a time, as before; a second only beside one that is overdue. */
export function canStartRead(link, now) {
  if (!link.open.length) return true;
  if (link.open.length >= MAX_OPEN_READS) return false;
  return link.open.every((r) => now - r.startedAt >= READ_SECOND_AFTER_MS);
}

export function readStarted(link, now) {
  const n = link.seq + 1;
  return { link: { ...link, seq: n, open: [...link.open, { n, startedAt: now }] }, n };
}

/** Reads to cancel now (open for READ_CANCEL_MS). */
export const readsToCancel = (link, now) => link.open.filter((r) => now - r.startedAt >= READ_CANCEL_MS).map((r) => r.n);

/** A list answer is used unless a read that started later was already used. */
export const shouldApply = (link, n) => n > link.lastAppliedN;

/**
 * A list read ended.
 *   result  'applied'    its rows were painted
 *           'stale'      a newer read was already painted: nothing to do
 *           'unknown'    an empty list while the device link is unsure (lib/deviceFence.js trustSharedRead): not used
 *           'failed'     an error, or it was cancelled
 * Only 'applied' can clear a warning. One failure says slow; FAILS_TO_OFFLINE in a row say offline.
 */
export function readEnded(link, { n, result, now }) {
  const r = link.open.find((x) => x.n === n);
  const open = link.open.filter((x) => x.n !== n);
  const took = r ? now - r.startedAt : 0;
  if (result === 'applied') {
    return { ...link, open, lastAppliedN: n, lastAppliedAt: now, everApplied: true, fails: 0, goodRun: took < SLOW_MS ? link.goodRun + 1 : 0 };
  }
  if (result === 'stale') return { ...link, open };
  if (result === 'unknown') return { ...link, open, goodRun: 0 };
  return { ...link, open, goodRun: 0, fails: n > link.lastAppliedN ? link.fails + 1 : link.fails };
}

/**
 * The tablet slept (lid shut, auto lock, the night): the reads that were open then are forgotten
 * without counting as failures, so a healthy screen never wakes up to a warning. The engine cancels
 * them and reads the list afresh.
 */
export function afterSleep(link) {
  return { ...link, open: [], fails: 0 };
}

/**
 * Where the screen stands now. Call once a second and after every read or write ends.
 *   oldestOpenWriteMs    how long the oldest write still in flight has been open (0 = none)
 *   oldestUnsavedBumpMs  age of the oldest unsaved bump (0 = none)
 * Returns { link, level, sure }.
 */
export function assess(link, { now, oldestOpenWriteMs = 0, oldestUnsavedBumpMs = 0 } = {}) {
  const fresh = link.open.filter((r) => r.n > link.lastAppliedN);
  const overdue = fresh.some((r) => now - r.startedAt >= READ_OFFLINE_MS);
  const oldestRead = link.open.reduce((m, r) => Math.max(m, now - r.startedAt), 0);
  const failing = link.fails >= FAILS_TO_OFFLINE || overdue;
  const slowNow = link.fails > 0 || oldestRead >= SLOW_MS || oldestOpenWriteMs >= SLOW_MS || oldestUnsavedBumpMs >= LATE_BUMP_MS;
  let level = 'ok';
  if (failing) level = 'offline';
  else if (slowNow) level = 'slow';
  else if (link.warned && link.goodRun < GOOD_READS_TO_CLEAR) level = 'slow';
  // A read that took over 5 s reset goodRun when it ended; the warning was already on while it was open.
  let spell = link.spell;
  if (level !== 'ok') {
    if (!spell) spell = { startedAt: now, endedAt: null, lateBumps: 0, worstLateMs: 0, wentOffline: false };
    else if (spell.endedAt !== null) spell = { ...spell, endedAt: null };
    if (level === 'offline' && !spell.wentOffline) spell = { ...spell, wentOffline: true };
  } else if (spell && spell.endedAt === null) {
    spell = { ...spell, endedAt: now };
  }
  const next = { ...link, level, warned: level !== 'ok', spell, goodRun: level === 'ok' ? link.goodRun : (slowNow || failing ? 0 : link.goodRun) };
  const sure = next.everApplied && level === 'ok' && now - next.lastAppliedAt < STALE_MS;
  return { link: next, level, sure };
}

/** A bump was saved after `tookMs`: over 10 s it is a late bump of the spell. */
export function noteBumpSaved(link, { tookMs, now }) {
  if (!(tookMs >= LATE_BUMP_MS)) return link;
  const spell = link.spell || { startedAt: now - tookMs, endedAt: now, lateBumps: 0, worstLateMs: 0, wentOffline: false };
  return { ...link, spell: { ...spell, lateBumps: spell.lateBumps + 1, worstLateMs: Math.max(spell.worstLateMs, tookMs) } };
}

/**
 * The spell to write down, once it has been over for SPELL_QUIET_MS. Returns { link, summary }.
 * summary is null when nothing is due, or when the spell was too small to be worth a trace.
 */
export function takeSpell(link, now) {
  const s = link.spell;
  if (!s || s.endedAt === null || now - s.endedAt < SPELL_QUIET_MS) return { link, summary: null };
  const durationMs = s.endedAt - s.startedAt;
  const worth = durationMs >= SPELL_MIN_MS || s.lateBumps > 0 || s.wentOffline;
  return { link: { ...link, spell: null }, summary: worth ? { startedAt: s.startedAt, endedAt: s.endedAt, durationMs, lateBumps: s.lateBumps, worstLateMs: s.worstLateMs, wentOffline: s.wentOffline } : null };
}

/** A spell kept across a restart is forgotten after this. */
export const SPELL_KEEP_MS = 6 * 60 * 60 * 1000;

/** The open spell out of the journal text (kdsWriteLane.js toJournal extra), or null. */
export function spellFromJournal(text, { now } = {}) {
  let parsed = null;
  try { parsed = typeof text === 'string' ? JSON.parse(text) : text; } catch { parsed = null; }
  const s = parsed && parsed.spell;
  if (!s || !Number.isFinite(Number(s.startedAt)) || now - Number(s.startedAt) > SPELL_KEEP_MS || Number(s.startedAt) > now) return null;
  return {
    startedAt: Number(s.startedAt),
    // A restart in the middle of a spell: it counts as still running until the new page proves otherwise.
    endedAt: s.endedAt === null || s.endedAt === undefined || !Number.isFinite(Number(s.endedAt)) ? now : Number(s.endedAt),
    lateBumps: Math.max(0, Number(s.lateBumps) || 0), worstLateMs: Math.max(0, Number(s.worstLateMs) || 0), wentOffline: s.wentOffline === true,
  };
}

// ── words ──────────────────────────────────────────────────────────────────────────────────────

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** "45 s", "6 min", "6 min 20 s", "1 h 5 min". */
export function durationWords(ms) {
  const s = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 && m < 10 ? `${m} min ${s % 60} s` : `${m} min`;
  return m % 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${Math.floor(m / 60)} h`;
}

/** On the card of a bump that could not be saved for ten minutes (K1). */
export const BUMP_NOT_SAVED = 'Bump not saved. Tap to try again.';

/** The big banner: null on a healthy screen. */
export function bannerWords({ level, unsavedBumps = 0 } = {}) {
  if (level !== 'slow' && level !== 'offline') return null;
  const tail = unsavedBumps > 0 ? ` ${plural(unsavedBumps, 'bump', 'bumps')} not saved yet.` : '';
  if (level === 'offline') return { tone: 'offline', text: `This screen is offline. New orders are NOT showing. Check the tablet's WiFi.${tail}` };
  return { tone: 'slow', text: `This screen is slow to reach ServOS. New orders may be late.${tail}` };
}

/** The header count: null when there is nothing to say. "3 bumps saving", "1 change saving", "3 bumps and 1 change saving". */
export function savingWords({ bumps = 0, others = 0 } = {}) {
  if (bumps <= 0 && others <= 0) return null;
  const parts = [];
  if (bumps > 0) parts.push(plural(bumps, 'bump', 'bumps'));
  if (others > 0) parts.push(plural(others, 'change', 'changes'));
  return `${parts.join(' and ')} saving`;
}

/** The empty board. "Kitchen clear" only when the screen is sure and nothing is unsaved. */
export function emptyWords({ sure, everApplied, level, unsavedBumps = 0 } = {}) {
  if (sure && unsavedBumps === 0) return { clear: true, title: 'Kitchen clear', sub: 'All orders bumped' };
  if (unsavedBumps > 0) return { clear: false, title: 'No orders showing', sub: `${plural(unsavedBumps, 'bump', 'bumps')} not saved yet.` };
  if (level === 'offline') return { clear: false, title: 'No orders showing', sub: 'This screen is offline, so it cannot tell.' };
  // Not sure yet with nothing wrong: the first list after a start or a wake is on its way.
  if (!everApplied || level === 'ok') return { clear: false, title: 'Loading orders', sub: 'One moment.' };
  return { clear: false, title: 'No orders showing', sub: 'This screen is slow, so new orders may be late.' };
}

/** How many cards start below the bottom of the visible board. tops: each card's top in the same frame as viewBottom. */
export function countBelow(tops, viewBottom, slack = 8) {
  return (tops || []).filter((t) => Number(t) >= Number(viewBottom) - slack).length;
}

/** "5 more orders below". null for none. */
export const belowWords = (n) => (n > 0 ? `${plural(n, 'more order', 'more orders')} below` : null);

/** The one activity feed line for a spell that ended. */
export function traceWords({ name, summary } = {}) {
  const who = name || 'Kitchen screen';
  const kind = summary.wentOffline ? 'slow or offline' : 'slow';
  const title = `${who} was ${kind} for ${durationWords(summary.durationMs)}`;
  const body = summary.lateBumps > 0
    ? `${plural(summary.lateBumps, 'bump', 'bumps')} saved late. Longest wait ${durationWords(summary.worstLateMs)}.`
    : 'No bumps were late.';
  return { title, body };
}
