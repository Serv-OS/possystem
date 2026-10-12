// 12 Oct 2026, Coffee Boy Barnsley (K4, K5, K9): the only warning was a thin pale strip, shown while
// a list read was failing; any read that came back, even one that was thrown away, turned it off;
// and an empty board still said "Kitchen clear". These are the rules for when the screen says it is
// slow or offline, when it may stop saying so, and the words it uses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  POLL_MS, SLOW_MS, READ_SECOND_AFTER_MS, READ_OFFLINE_MS, READ_CANCEL_MS, MAX_OPEN_READS, RETRY_AFTER_FAIL_MS,
  GOOD_READS_TO_CLEAR, STALE_MS, FAILS_TO_OFFLINE, SLEEP_GAP_MS, SPELL_MIN_MS, SPELL_QUIET_MS, SPELL_KEEP_MS, BUMP_NOT_SAVED,
  newLink, canStartRead, readStarted, readsToCancel, shouldApply, readEnded, afterSleep, assess,
  noteBumpSaved, takeSpell, spellFromJournal,
  durationWords, bannerWords, savingWords, emptyWords, countBelow, belowWords, traceWords,
} from './kdsLinkHealth.js';

const T0 = Date.UTC(2026, 9, 12, 14, 0, 0);
/** One whole list read: started at `at`, ended `took` ms later with `result`. Returns the link after assess. */
function read(link, at, took, result) {
  const s = readStarted(link, at);
  const ended = readEnded(s.link, { n: s.n, result, now: at + took });
  return assess(ended, { now: at + took }).link;
}

test('the numbers the spec fixed', () => {
  assert.deepEqual(
    [POLL_MS, SLOW_MS, READ_SECOND_AFTER_MS, READ_OFFLINE_MS, READ_CANCEL_MS, MAX_OPEN_READS, RETRY_AFTER_FAIL_MS],
    [20000, 5000, 15000, 30000, 45000, 2, 5000],
  );
  assert.deepEqual(
    [GOOD_READS_TO_CLEAR, STALE_MS, FAILS_TO_OFFLINE, SLEEP_GAP_MS, SPELL_MIN_MS, SPELL_QUIET_MS, SPELL_KEEP_MS],
    [2, 45000, 2, 10000, 60000, 300000, 21600000],
  );
  assert.equal(BUMP_NOT_SAVED, 'Bump not saved. Tap to try again.');
});

test('list reads: one at a time, a second only beside one that has been open 15 s, never more than two', () => {
  let link = newLink();
  assert.equal(canStartRead(link, T0), true);
  const a = readStarted(link, T0);
  link = a.link;
  assert.equal(a.n, 1);
  assert.equal(canStartRead(link, T0 + 14999), false, 'the first is not overdue yet');
  assert.equal(canStartRead(link, T0 + 15000), true);
  const b = readStarted(link, T0 + 20000);
  link = b.link;
  assert.equal(b.n, 2);
  assert.deepEqual(link.open.map((r) => r.n), [1, 2], 'the first is NOT cancelled: its late answer is still used');
  assert.equal(canStartRead(link, T0 + 44000), false, 'never more than two');
  // When the first ends, a third may start only once the second is 15 s old as well.
  link = readEnded(link, { n: 1, result: 'failed', now: T0 + 30000 });
  assert.equal(canStartRead(link, T0 + 30000), false);
  assert.equal(canStartRead(link, T0 + 35000), true);
});

test('an unanswered read is cancelled at 45 s, not before', () => {
  const link = readStarted(readStarted(newLink(), T0).link, T0 + 20000).link;
  assert.deepEqual(readsToCancel(link, T0 + 44999), []);
  assert.deepEqual(readsToCancel(link, T0 + 45000), [1]);
  assert.deepEqual(readsToCancel(link, T0 + 65000), [1, 2]);
});

test('K4: a list answer is used whenever no read that STARTED later was already used', () => {
  let link = newLink();
  const a = readStarted(link, T0);
  const b = readStarted(a.link, T0 + 20000);
  link = b.link;
  // The second comes back first and is used. The first, 30 s late, is then stale.
  assert.equal(shouldApply(link, b.n), true);
  link = readEnded(link, { n: b.n, result: 'applied', now: T0 + 21000 });
  assert.equal(shouldApply(link, a.n), false);
  link = readEnded(link, { n: a.n, result: 'stale', now: T0 + 30000 });
  assert.deepEqual(link.open, []);
  assert.equal(link.lastAppliedN, 2);
  assert.equal(link.lastAppliedAt, T0 + 21000, 'a stale answer does not count as a list used');
  // The other way round: the first comes back late but FIRST. It is used, and so is the second after it.
  let two = readStarted(readStarted(newLink(), T0).link, T0 + 20000).link;
  assert.equal(shouldApply(two, 1), true, 'late, and still used');
  two = readEnded(two, { n: 1, result: 'applied', now: T0 + 25000 });
  assert.equal(shouldApply(two, 2), true);
});

test('one failed read says slow, two in a row say offline', () => {
  let link = read(newLink(), T0, 100, 'applied');
  assert.equal(link.level, 'ok');
  link = read(link, T0 + 20000, 100, 'failed');
  assert.equal(link.level, 'slow', 'one blip (a 503 while the database reloads) is not "offline"');
  link = read(link, T0 + 25000, 100, 'failed');
  assert.equal(link.level, 'offline');
  assert.equal(link.fails, 2);
});

test('K4: ONLY a list that was used can clear a warning, and it takes two good ones in a row', () => {
  let link = read(newLink(), T0, 100, 'applied');
  link = read(link, T0 + 20000, 100, 'failed');
  link = read(link, T0 + 25000, 100, 'failed');
  assert.equal(link.level, 'offline');
  // A read that came back but could not be used (an empty list while the device link is unsure),
  // and a stale one: on 12 Oct a thrown away read turned the warning off. Not any more.
  link = read(link, T0 + 30000, 100, 'unknown');
  assert.equal(link.level, 'offline');
  link = read(link, T0 + 35000, 100, 'stale');
  assert.equal(link.level, 'offline');
  // One good list: no longer offline, but still slow.
  link = read(link, T0 + 40000, 100, 'applied');
  assert.equal(link.level, 'slow');
  // A list that was used but took 6 s does not count as good, and starts the count again.
  link = read(link, T0 + 60000, 6000, 'applied');
  assert.equal(link.level, 'slow');
  link = read(link, T0 + 80000, 100, 'applied');
  assert.equal(link.level, 'slow', 'one good');
  link = read(link, T0 + 100000, 100, 'applied');
  assert.equal(link.level, 'ok', 'two good in a row');
});

test('a read with no answer: slow at 5 s, offline at 30 s', () => {
  let link = read(newLink(), T0, 100, 'applied');
  link = readStarted(link, T0 + 20000).link;
  assert.equal(assess(link, { now: T0 + 24999 }).level, 'ok');
  assert.equal(assess(link, { now: T0 + 25000 }).level, 'slow');
  assert.equal(assess(link, { now: T0 + 49999 }).level, 'slow');
  assert.equal(assess(link, { now: T0 + 50000 }).level, 'offline');
  // An OLDER read still open after a newer one was used does not say offline (its answer no longer matters).
  let two = readStarted(readStarted(newLink(), T0).link, T0 + 20000).link;
  two = readEnded(two, { n: 2, result: 'applied', now: T0 + 20100 });
  assert.equal(assess(two, { now: T0 + 31000 }).level, 'slow');
});

test('slow when a write has been open 5 s, or a bump unsaved 10 s', () => {
  const link = read(newLink(), T0, 100, 'applied');
  const at = T0 + 1000;
  assert.equal(assess(link, { now: at, oldestOpenWriteMs: 4999 }).level, 'ok');
  assert.equal(assess(link, { now: at, oldestOpenWriteMs: 5000 }).level, 'slow');
  assert.equal(assess(link, { now: at, oldestUnsavedBumpMs: 9999 }).level, 'ok');
  assert.equal(assess(link, { now: at, oldestUnsavedBumpMs: 10000 }).level, 'slow');
  // While the bump is still unsaved good lists do not clear it; after it is saved it takes two.
  let l = assess(link, { now: at, oldestUnsavedBumpMs: 10000 }).link;
  let s = readStarted(l, T0 + 20000);
  l = assess(readEnded(s.link, { n: s.n, result: 'applied', now: T0 + 20100 }), { now: T0 + 20100, oldestUnsavedBumpMs: 29000 }).link;
  s = readStarted(l, T0 + 40000);
  l = assess(readEnded(s.link, { n: s.n, result: 'applied', now: T0 + 40100 }), { now: T0 + 40100, oldestUnsavedBumpMs: 49000 }).link;
  assert.equal(l.level, 'slow', 'two good lists, but the bump is still not saved');
  l = read(l, T0 + 60000, 100, 'applied');
  assert.equal(l.level, 'slow');
  l = read(l, T0 + 80000, 100, 'applied');
  assert.equal(l.level, 'ok');
});

test('sure ("Kitchen clear" may be said): a list was used in the last 45 s and the level is ok', () => {
  let link = newLink();
  assert.equal(assess(link, { now: T0 }).sure, false, 'not before the first list');
  link = read(link, T0, 100, 'applied');
  assert.equal(assess(link, { now: T0 + 1000 }).sure, true);
  assert.equal(assess(link, { now: T0 + 100 + 44999 }).sure, true);
  assert.equal(assess(link, { now: T0 + 100 + 45000 }).sure, false, 'the list is too old to be sure');
  assert.equal(assess(link, { now: T0 + 1000, oldestOpenWriteMs: 6000 }).sure, false, 'never sure while slow');
});

test('the tablet slept: open reads are forgotten without counting as failures', () => {
  let link = read(newLink(), T0, 100, 'applied');
  link = readStarted(link, T0 + 20000).link;
  link = { ...link, fails: 1 };
  const woke = afterSleep(link);
  assert.deepEqual(woke.open, []);
  assert.equal(woke.fails, 0);
  assert.equal(canStartRead(woke, T0 + 3600000), true, 'the list is read at once on waking');
  assert.equal(assess(woke, { now: T0 + 3600000 }).level, 'ok', 'a healthy screen never wakes up to a warning');
  assert.equal(assess(woke, { now: T0 + 3600000 }).sure, false, 'but it is not sure until the new list is in');
});

test('K9 spell: opens when the screen leaves ok, ends when it is back, joins a new one inside 5 minutes', () => {
  let link = read(newLink(), T0, 100, 'applied');
  assert.equal(link.spell, null);
  link = read(link, T0 + 20000, 100, 'failed');                 // slow from 14:00:20.1
  assert.deepEqual(link.spell, { startedAt: T0 + 20100, endedAt: null, lateBumps: 0, worstLateMs: 0, wentOffline: false });
  link = read(link, T0 + 25000, 100, 'failed');                 // offline
  assert.equal(link.spell.wentOffline, true);
  link = read(link, T0 + 40000, 100, 'applied');
  link = read(link, T0 + 60000, 100, 'applied');                // ok at 14:01:00.1
  assert.equal(link.level, 'ok');
  assert.equal(link.spell.endedAt, T0 + 60100);
  assert.equal(takeSpell(link, T0 + 60100 + SPELL_QUIET_MS - 1).summary, null, 'not written until it has been quiet for 5 minutes');

  // Trouble again 2 minutes later: the SAME spell goes on (one trace, not many).
  link = read(link, T0 + 180000, 100, 'failed');
  assert.equal(link.spell.startedAt, T0 + 20100);
  assert.equal(link.spell.endedAt, null);
  link = noteBumpSaved(link, { tookMs: 9999, now: T0 + 181000 });
  assert.equal(link.spell.lateBumps, 0, 'under 10 s is not late');
  link = noteBumpSaved(link, { tookMs: 38000, now: T0 + 182000 });
  link = noteBumpSaved(link, { tookMs: 343000, now: T0 + 183000 });
  link = noteBumpSaved(link, { tookMs: 12000, now: T0 + 184000 });
  assert.deepEqual([link.spell.lateBumps, link.spell.worstLateMs], [3, 343000]);
  link = read(link, T0 + 200000, 100, 'applied');
  link = read(link, T0 + 220000, 100, 'applied');
  assert.equal(link.spell.endedAt, T0 + 220100);

  const taken = takeSpell(link, T0 + 220100 + SPELL_QUIET_MS);
  assert.deepEqual(taken.summary, {
    startedAt: T0 + 20100, endedAt: T0 + 220100, durationMs: 200000, lateBumps: 3, worstLateMs: 343000, wentOffline: true,
  });
  assert.equal(taken.link.spell, null, 'taken once');
  assert.equal(takeSpell(taken.link, T0 + 900000).summary, null);
});

test('K9 spell: written only when it is worth a line', () => {
  // 20 s of slow, never offline, no late bump: dropped without a trace.
  let link = read(newLink(), T0, 100, 'applied');
  link = read(link, T0 + 20000, 100, 'failed');
  link = read(link, T0 + 25000, 100, 'applied');
  link = read(link, T0 + 40000, 100, 'applied');
  assert.equal(link.level, 'ok');
  let taken = takeSpell(link, T0 + 40100 + SPELL_QUIET_MS);
  assert.equal(taken.summary, null);
  assert.equal(taken.link.spell, null, 'and it is forgotten, not kept for ever');

  // The same 20 s with one late bump: worth it.
  link = read(newLink(), T0, 100, 'applied');
  link = read(link, T0 + 20000, 100, 'failed');
  link = noteBumpSaved(link, { tookMs: 15000, now: T0 + 22000 });
  link = read(link, T0 + 25000, 100, 'applied');
  link = read(link, T0 + 40000, 100, 'applied');
  taken = takeSpell(link, T0 + 40100 + SPELL_QUIET_MS);
  assert.deepEqual([taken.summary.lateBumps, taken.summary.worstLateMs, taken.summary.wentOffline], [1, 15000, false]);

  // A late bump saved with no spell open (the level never left ok) still leaves a trace.
  link = noteBumpSaved(read(newLink(), T0, 100, 'applied'), { tookMs: 11000, now: T0 + 30000 });
  assert.deepEqual(link.spell, { startedAt: T0 + 19000, endedAt: T0 + 30000, lateBumps: 1, worstLateMs: 11000, wentOffline: false });

  // 60 s of slow with nothing late: worth it by its length alone.
  link = read(newLink(), T0, 100, 'applied');
  link = read(link, T0 + 20000, 100, 'failed');
  link = read(link, T0 + 60000, 100, 'applied');
  link = read(link, T0 + 80100, 0, 'applied');
  assert.equal(takeSpell(link, T0 + 80100 + SPELL_QUIET_MS).summary.durationMs, 60000);
});

test('K9 spell across a restart: kept in the journal, forgotten after 6 hours', () => {
  const open = JSON.stringify({ v: 1, entries: [], spell: { startedAt: T0, endedAt: null, lateBumps: 4, worstLateMs: 90000, wentOffline: true } });
  // Restarted in the middle of it: it counts as ended at the restart until the new page says otherwise.
  assert.deepEqual(spellFromJournal(open, { now: T0 + 120000 }), { startedAt: T0, endedAt: T0 + 120000, lateBumps: 4, worstLateMs: 90000, wentOffline: true });
  const ended = JSON.stringify({ v: 1, entries: [], spell: { startedAt: T0, endedAt: T0 + 50000, lateBumps: 0, worstLateMs: 0, wentOffline: false } });
  assert.equal(spellFromJournal(ended, { now: T0 + 120000 }).endedAt, T0 + 50000);
  assert.equal(spellFromJournal(open, { now: T0 + SPELL_KEEP_MS + 1 }), null);
  assert.equal(spellFromJournal(open, { now: T0 - 1 }), null, 'a spell from the future (the clock was changed) is dropped');
  for (const bad of [null, '', 'nope', '{"v":1,"entries":[]}', '{"spell":{"startedAt":"x"}}']) assert.equal(spellFromJournal(bad, { now: T0 }), null);
  // And the new page carries on from it: still not ok, so the spell is open again, same start.
  const link = assess({ ...newLink(), spell: spellFromJournal(open, { now: T0 + 120000 }), fails: 2 }, { now: T0 + 121000 }).link;
  assert.deepEqual([link.spell.startedAt, link.spell.endedAt, link.spell.lateBumps], [T0, null, 4]);
});

test('words: durations', () => {
  assert.equal(durationWords(45000), '45 s');
  assert.equal(durationWords(38000), '38 s');
  assert.equal(durationWords(380000), '6 min 20 s');
  assert.equal(durationWords(343000), '5 min 43 s');
  assert.equal(durationWords(360000), '6 min');
  assert.equal(durationWords(720000), '12 min');
  assert.equal(durationWords(750000), '12 min', 'ten minutes and over: no seconds');
  assert.equal(durationWords(96 * 60000), '1 h 36 min');
  assert.equal(durationWords(120 * 60000), '2 h');
  assert.equal(durationWords(0), '0 s');
  assert.equal(durationWords(-5), '0 s');
  assert.equal(durationWords(undefined), '0 s');
});

test('words: the banner (K5), singular and plural', () => {
  assert.equal(bannerWords({ level: 'ok', unsavedBumps: 3 }), null);
  assert.equal(bannerWords(), null);
  assert.deepEqual(bannerWords({ level: 'slow' }), { tone: 'slow', text: 'This screen is slow to reach ServOS. New orders may be late.' });
  assert.equal(bannerWords({ level: 'slow', unsavedBumps: 1 }).text, 'This screen is slow to reach ServOS. New orders may be late. 1 bump not saved yet.');
  assert.equal(bannerWords({ level: 'slow', unsavedBumps: 3 }).text, 'This screen is slow to reach ServOS. New orders may be late. 3 bumps not saved yet.');
  assert.deepEqual(bannerWords({ level: 'offline' }), { tone: 'offline', text: "This screen is offline. New orders are NOT showing. Check the tablet's WiFi." });
  assert.equal(bannerWords({ level: 'offline', unsavedBumps: 1 }).text, "This screen is offline. New orders are NOT showing. Check the tablet's WiFi. 1 bump not saved yet.");
  assert.equal(bannerWords({ level: 'offline', unsavedBumps: 13 }).text, "This screen is offline. New orders are NOT showing. Check the tablet's WiFi. 13 bumps not saved yet.");
});

test('words: the header count (K2)', () => {
  assert.equal(savingWords(), null);
  assert.equal(savingWords({ bumps: 0, others: 0 }), null);
  assert.equal(savingWords({ bumps: 1 }), '1 bump saving');
  assert.equal(savingWords({ bumps: 3 }), '3 bumps saving');
  assert.equal(savingWords({ others: 1 }), '1 change saving');
  assert.equal(savingWords({ others: 2 }), '2 changes saving');
  assert.equal(savingWords({ bumps: 3, others: 1 }), '3 bumps and 1 change saving');
  assert.equal(savingWords({ bumps: 1, others: 2 }), '1 bump and 2 changes saving');
});

test('words: the empty board never says "Kitchen clear" while it is unsure (K5)', () => {
  assert.deepEqual(emptyWords({ sure: true, everApplied: true, level: 'ok', unsavedBumps: 0 }), { clear: true, title: 'Kitchen clear', sub: 'All orders bumped' });
  assert.deepEqual(emptyWords({ sure: false, everApplied: false, level: 'ok', unsavedBumps: 0 }), { clear: false, title: 'Loading orders', sub: 'One moment.' });
  assert.deepEqual(emptyWords({ sure: false, everApplied: true, level: 'ok', unsavedBumps: 0 }), { clear: false, title: 'Loading orders', sub: 'One moment.' }, 'just woken: the new list is on its way');
  assert.deepEqual(emptyWords({ sure: true, everApplied: true, level: 'ok', unsavedBumps: 1 }), { clear: false, title: 'No orders showing', sub: '1 bump not saved yet.' });
  assert.deepEqual(emptyWords({ sure: false, everApplied: true, level: 'offline', unsavedBumps: 3 }), { clear: false, title: 'No orders showing', sub: '3 bumps not saved yet.' });
  assert.deepEqual(emptyWords({ sure: false, everApplied: true, level: 'offline', unsavedBumps: 0 }), { clear: false, title: 'No orders showing', sub: 'This screen is offline, so it cannot tell.' });
  assert.deepEqual(emptyWords({ sure: false, everApplied: false, level: 'offline', unsavedBumps: 0 }), { clear: false, title: 'No orders showing', sub: 'This screen is offline, so it cannot tell.' });
  assert.deepEqual(emptyWords({ sure: false, everApplied: true, level: 'slow', unsavedBumps: 0 }), { clear: false, title: 'No orders showing', sub: 'This screen is slow, so new orders may be late.' });
  assert.deepEqual(emptyWords({ sure: false, everApplied: false, level: 'slow', unsavedBumps: 0 }), { clear: false, title: 'Loading orders', sub: 'One moment.' });
  for (const level of ['slow', 'offline']) for (const everApplied of [true, false]) for (const unsavedBumps of [0, 2]) {
    assert.equal(emptyWords({ sure: false, everApplied, level, unsavedBumps }).clear, false);
  }
});

test('words: how many orders are below the fold', () => {
  // Cards start at these tops; the visible board ends at 600.
  assert.equal(countBelow([20, 300, 580, 600, 880, 1160], 600), 3);
  assert.equal(countBelow([20, 300, 592, 600], 600), 2, 'a card that starts in the last 8 px shows nothing of itself');
  assert.equal(countBelow([20, 300, 591], 600), 0);
  assert.equal(countBelow([20, 300, 580], 600, 30), 1);
  assert.equal(countBelow([], 600), 0);
  assert.equal(countBelow(null, 600), 0);
  assert.equal(belowWords(0), null);
  assert.equal(belowWords(-1), null);
  assert.equal(belowWords(1), '1 more order below');
  assert.equal(belowWords(5), '5 more orders below');
});

test('words: the one activity feed line for a spell (K9)', () => {
  const base = { startedAt: T0, endedAt: T0 + 5760000, durationMs: 96 * 60000, lateBumps: 51, worstLateMs: 343000, wentOffline: true };
  assert.deepEqual(traceWords({ name: 'drinks kds', summary: base }), {
    title: 'drinks kds was slow or offline for 1 h 36 min', body: '51 bumps saved late. Longest wait 5 min 43 s.',
  });
  assert.deepEqual(traceWords({ name: 'drinks kds', summary: { ...base, durationMs: 360000, lateBumps: 1, worstLateMs: 38000, wentOffline: false } }), {
    title: 'drinks kds was slow for 6 min', body: '1 bump saved late. Longest wait 38 s.',
  });
  assert.equal(traceWords({ name: 'drinks kds', summary: { ...base, lateBumps: 0, worstLateMs: 0 } }).body, 'No bumps were late.');
  assert.equal(traceWords({ name: '', summary: { ...base, wentOffline: false, durationMs: 61000 } }).title, 'Kitchen screen was slow for 1 min 1 s');
});

test('no dash and no "N/A" in anything the screen can say', () => {
  const said = [
    BUMP_NOT_SAVED,
    bannerWords({ level: 'slow', unsavedBumps: 2 }).text, bannerWords({ level: 'offline', unsavedBumps: 1 }).text,
    savingWords({ bumps: 2, others: 1 }), belowWords(4), durationWords(96 * 60000),
    ...['ok', 'slow', 'offline'].flatMap((level) => [true, false].flatMap((everApplied) => [0, 1].map((unsavedBumps) => {
      const w = emptyWords({ sure: level === 'ok' && everApplied, everApplied, level, unsavedBumps });
      return `${w.title} ${w.sub}`;
    }))),
    ...Object.values(traceWords({ name: 'drinks kds', summary: { durationMs: 400000, lateBumps: 2, worstLateMs: 20000, wentOffline: true } })),
  ];
  for (const text of said) {
    assert.doesNotMatch(text, /[\u2013\u2014]/, text);   // en dash, em dash
    assert.doesNotMatch(text, /N\/A/i, text);
  }
});
