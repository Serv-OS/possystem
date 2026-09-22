// watchdog.test.js — the thing that watches while Peter sleeps.
//
// Peter, 22 Sep 2026: "what happens if something goes wrong when I am asleep".
// He is 8 hours behind the UK, so venues trade overnight, and every fault so far
// has been found by a customer at a counter rather than by us.
//
// The two things that make an alarm worth having are tested here: it must not
// cry wolf, and it must never wake somebody for something they cannot act on.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  evaluate, pages, alertDecision, resolved, smsText, runSummary,
  SIGNALS, WINDOWS, PAGE, WARN, REMINDER_HOURS,
} from '../../scripts/watchdog/checks.mjs';

const read = (rel) => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

// ── silence when nothing is wrong ───────────────────────────────────────────

test('a healthy system says nothing at all', () => {
  const findings = evaluate({ reachable: true, cardStranded: [], ticketsLost: [], printStuck: [], ordersOpen: [] });
  assert.deepEqual(findings, []);
  assert.equal(runSummary(findings, 0), 'All clear.');
});

test('zero counts are not findings', () => {
  // The queries return a venue with 0 when nothing is wrong there; that is not
  // news, and reporting it is how an alert becomes wallpaper.
  const findings = evaluate({ reachable: true, cardStranded: [{ venue: 'Provo', count: 0 }] });
  assert.deepEqual(findings, []);
});

// ── the case it exists for ──────────────────────────────────────────────────

test('an unreachable database is the loudest thing it can say', () => {
  const findings = evaluate({ reachable: false });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].signal, 'db_unreachable');
  assert.equal(findings[0].severity, PAGE);
  assert.match(findings[0].body, /cannot take card payments/i);
  assert.match(findings[0].fix, /status\.supabase\.com/);
});

test('when the database is unreachable it reports NOTHING else', () => {
  // Because nothing else could be measured. "0 stranded payments" read off a
  // failed query is a lie, and it is the lie that makes people trust a dead
  // dashboard (22 Sep: the health endpoint said ACTIVE_HEALTHY through most of
  // the brownout).
  const findings = evaluate({ reachable: false, cardStranded: [{ venue: 'Provo', count: 3 }] });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].signal, 'db_unreachable');
});

// ── what wakes somebody, and what does not ──────────────────────────────────

test('money and tickets wake somebody; a slow order does not', () => {
  const findings = evaluate({
    reachable: true,
    cardStranded: [{ venue: 'Provo', count: 1 }],
    ticketsLost: [{ venue: 'Coffee Boy Leeds', count: 2 }],
    printStuck: [{ venue: 'Provo', count: 4 }],
    ordersOpen: [{ venue: 'Provo', count: 3 }],
  });
  assert.equal(findings.length, 4);
  assert.deepEqual(pages(findings).map((f) => f.signal).sort(), ['card_stranded', 'print_stuck', 'ticket_lost']);
  const slow = findings.find((f) => f.signal === 'orders_open');
  assert.equal(slow.severity, WARN, 'an order left open is a morning job, not a 3am one');
  assert.match(slow.fix, /not worth getting up for/i);
});

test('every finding names the venue and says what to do', () => {
  // The rule: if we cannot say what to do about it, it is not a page.
  const findings = evaluate({
    reachable: true,
    cardStranded: [{ venue: 'Provo', count: 1 }],
    ticketsLost: [{ venue: 'Huddersfield', count: 1 }],
  });
  for (const f of findings) {
    assert.ok(f.venue && f.venue !== 'a venue', 'names the venue: ' + f.signal);
    assert.ok(f.fix.length > 20, 'says what to do: ' + f.signal);
    assert.match(f.title, new RegExp(f.venue.split(' ')[0]));
  }
});

test('the words match the number: one payment, not 1 payments', () => {
  const one = evaluate({ reachable: true, cardStranded: [{ venue: 'Provo', count: 1 }] })[0];
  const many = evaluate({ reachable: true, cardStranded: [{ venue: 'Provo', count: 3 }] })[0];
  assert.match(one.body, /A card payment has been/);
  assert.match(many.body, /3 card payments have been/);
});

// ── never cry wolf ──────────────────────────────────────────────────────────

test('the same trouble at the same venue is ONE alert, not one every 5 minutes', () => {
  const finding = evaluate({ reachable: true, cardStranded: [{ venue: 'Provo', count: 1 }] })[0];
  assert.equal(alertDecision({ finding, openIssue: null }).alert, true, 'the first time, yes');
  const justSaid = { lastAlertedAt: new Date(Date.now() - 5 * 60_000).toISOString() };
  assert.equal(alertDecision({ finding, openIssue: justSaid }).alert, false, 'five minutes later, no');
});

test('but a fault nobody has fixed nags again after six hours', () => {
  const finding = evaluate({ reachable: true, cardStranded: [{ venue: 'Provo', count: 1 }] })[0];
  const old = { lastAlertedAt: new Date(Date.now() - (REMINDER_HOURS + 0.5) * 3_600_000).toISOString() };
  const d = alertDecision({ finding, openIssue: old });
  assert.equal(d.alert, true);
  assert.match(d.reason, /still broken/);
});

test('a warning never wakes anybody, however long it lasts', () => {
  const finding = evaluate({ reachable: true, ordersOpen: [{ venue: 'Provo', count: 9 }] })[0];
  assert.equal(alertDecision({ finding, openIssue: null }).alert, false);
  const ancient = { lastAlertedAt: new Date(Date.now() - 48 * 3_600_000).toISOString() };
  assert.equal(alertDecision({ finding, openIssue: ancient }).alert, false);
});

test('an issue opened but never actually announced is announced', () => {
  const finding = evaluate({ reachable: true, ticketsLost: [{ venue: 'Provo', count: 1 }] })[0];
  assert.equal(alertDecision({ finding, openIssue: { lastAlertedAt: null } }).alert, true);
});

// ── it tidies up after itself ───────────────────────────────────────────────

test('a fault that clears closes its own issue', () => {
  const findings = evaluate({ reachable: true, cardStranded: [{ venue: 'Provo', count: 1 }] });
  const openKeys = ['card_stranded:Provo', 'ticket_lost:Huddersfield'];
  assert.deepEqual(resolved(findings, openKeys), ['ticket_lost:Huddersfield']);
  assert.deepEqual(resolved([], openKeys), openKeys, 'all clear closes everything');
});

// ── the message on a lock screen ────────────────────────────────────────────

test('the SMS is short and says the venue and the trouble', () => {
  const finding = evaluate({ reachable: true, ticketsLost: [{ venue: 'Coffee Boy Leeds', count: 2 }] })[0];
  const text = smsText(finding);
  assert.ok(text.length <= 300, 'fits a lock screen');
  assert.match(text, /^ServOS: /);
  assert.match(text, /Coffee Boy Leeds/);
  assert.match(text, /kitchen has not seen/);
});

test('the run says what it did, in its own log', () => {
  const findings = evaluate({
    reachable: true,
    cardStranded: [{ venue: 'Provo', count: 1 }],
    ordersOpen: [{ venue: 'Provo', count: 2 }],
  });
  assert.match(runSummary(findings, 1), /1 urgent/);
  assert.match(runSummary(findings, 1), /1 for the morning/);
  assert.match(runSummary(findings, 0), /nothing new to send/);
});

// ── it must live outside the thing it watches ───────────────────────────────

test('the watchdog runs on GitHub, not inside the database', () => {
  // The 22 Sep outage killed the database AND its own scheduled jobs, including
  // the two sweeps that rescue stranded card payments. Anything watching from
  // in there would have died with it.
  const wf = read('../../.github/workflows/watchdog.yml');
  assert.match(wf, /schedule:/);
  assert.match(wf, /cron: '\*\/5 \* \* \* \*'/);
  assert.match(wf, /issues: write/, 'it opens and closes its own issues');
  assert.match(wf, /concurrency:/, 'a slow run never overlaps the next');
  const run = read('../../scripts/watchdog/run.mjs');
  assert.doesNotMatch(run, /\.(insert|update|upsert|delete)\(/, 'it reads, it never writes to the venue database');
});

test('a broken watchdog says it is broken, NEVER that the venues are down', () => {
  // The whole reason this signal exists. On its first live run the watchdog had
  // no key, got a 401, and opened an issue saying the venues could not take
  // card payments. It knew nothing of the sort.
  const findings = evaluate({ watchdogBroken: 'no WATCHDOG_TOKEN' });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].signal, 'watchdog_broken');
  assert.doesNotMatch(findings[0].body, /card payment/i, 'it must not claim anything about the venues');
  assert.match(findings[0].body, /nobody is watching/i, 'but it must say nothing is being watched');
  assert.match(findings[0].body, /no WATCHDOG_TOKEN/, 'and say why, so it can be fixed');
});

test('a broken watchdog does not wake anybody, because nobody can fix it at 3am', () => {
  const f = evaluate({ watchdogBroken: 'whatever' })[0];
  assert.equal(f.severity, WARN);
  assert.equal(alertDecision({ finding: f, openIssue: null }).alert, false);
});

test('a run that measured NOTHING never closes anybody else\'s issue', () => {
  // A failed run knows nothing. Closing a real fault's issue because we could
  // not look would be the worst thing this script could do.
  const run = read('../../scripts/watchdog/run.mjs');
  assert.match(run, /measured\.reachable === true/, 'closing is gated on having actually measured');
});

test('our own bad request is OUR bug, an outage is theirs', () => {
  const run = read('../../scripts/watchdog/run.mjs');
  assert.match(run, /class WatchdogBug extends Error/);
  assert.match(run, /class Unreachable extends Error/);
  assert.match(run, /res\.status >= 400 && res\.status < 500 && !\[408, 429\]\.includes\(res\.status\)/,
    '4xx is ours (bad token, never deployed), 5xx and silence are theirs');
  assert.match(run, /THE WATCHDOG ITSELF IS BROKEN/);
});

test('the words and the queries use the SAME thresholds', () => {
  // A message saying "over 10 minutes" above a query asking for 45 is a lie
  // told by a machine.
  assert.equal(WINDOWS.card_stranded.olderThan, SIGNALS.card_stranded.minutes);
  assert.equal(WINDOWS.print_stuck.olderThan, SIGNALS.print_stuck.minutes);
  assert.equal(WINDOWS.orders_open.olderThan, SIGNALS.orders_open.minutes);
});

test('a long-open order only counts if it is from TODAY', () => {
  // The first live run flagged six venues, every one of them orders abandoned
  // weeks ago. Permanent wallpaper is how an alert list gets ignored.
  assert.equal(WINDOWS.orders_open.within, 24 * 60);
  // And a permanent print failure from last week is history, not news.
  assert.equal(WINDOWS.ticket_lost.within, 60);
});

test('GitHub holds a narrow token, NEVER a service-role key', () => {
  // A service-role key in a repo secret can read and rewrite every venue's
  // data, and would sit there forever for a job that needs four counts.
  const wf = read('../../.github/workflows/watchdog.yml');
  assert.match(wf, /WATCHDOG_TOKEN: \$\{\{ secrets\.WATCHDOG_TOKEN \}\}/);
  assert.doesNotMatch(wf, /SERVICE_KEY|SERVICE_ROLE/, 'no service-role key goes to GitHub');
  const run = read('../../scripts/watchdog/run.mjs');
  assert.doesNotMatch(run, /SERVICE_KEY|SERVICE_ROLE/);
  assert.match(run, /x-watchdog-token/);
});

test('the one function it may ask is gated, read-only and says which failure is whose', () => {
  const fn = read('../../supabase/functions/watchdog-status/index.ts');
  assert.match(fn, /sameSecret\(req\.headers\.get\('x-watchdog-token'\)/, 'every call proves the token');
  assert.match(fn, /'bad token'/);
  assert.doesNotMatch(fn, /\.(insert|update|upsert|delete)\(/, 'it reads, it never writes');
  assert.doesNotMatch(fn, /select\('\*'\)/, 'it never hands back whole rows');
  // 401 means WE are wrong; only a database that did not answer gets a 503.
  assert.match(fn, /reason: 'db'[\s\S]*?503/);
});

test('it works with no Twilio configured, because it has to', () => {
  const run = read('../../scripts/watchdog/run.mjs');
  assert.match(run, /if \(missing\.length\) return \{ sent: false, detail: 'not configured: '/,
    'no SMS credentials is not an error: the GitHub issue still opens');
  assert.match(run, /Texting is the extra mile, not the only road/);
});

test('a phone number under either name still works', () => {
  // The rest of ServOS has called it TWILIO_FROM_NUMBER since May; this script
  // first asked for TWILIO_FROM. A secret typed under the other spelling would
  // mean no alarm at all, discovered the morning after.
  const run = read('../../scripts/watchdog/run.mjs');
  assert.match(run, /process\.env\.TWILIO_FROM \|\| process\.env\.TWILIO_FROM_NUMBER/);
  const wf = read('../../.github/workflows/watchdog.yml');
  assert.match(wf, /TWILIO_FROM: /);
  assert.match(wf, /TWILIO_FROM_NUMBER: /);
});

test('one trigger keeps watching, because GitHub drops most schedules', () => {
  // Measured 22 Sep 2026: GitHub honoured ONE of the */5 schedules in the first
  // three hours. A run that looked once and exited would leave the night
  // unwatched, which is the entire thing this was built to prevent.
  const run = read('../../scripts/watchdog/run.mjs');
  assert.match(run, /const BEAT_MS = 5 \* 60_000;/);
  assert.match(run, /WATCH_MINUTES.*\|\| 50/, 'a triggered run covers most of an hour');
  assert.match(run, /while \(true\)/);
  assert.match(run, /if \(Date\.now\(\) \+ BEAT_MS >= until\) break;/, 'it stops before the job timeout, not after');

  const wf = read('../../.github/workflows/watchdog.yml');
  assert.match(wf, /--watch/, 'the scheduled run watches; only the test-text run does not');
  assert.match(wf, /timeout-minutes: 55/, 'the job must outlive the watch window');
  assert.match(wf, /cancel-in-progress: true/, 'a new trigger replaces the watcher instead of queueing behind it');
});

test('one failed look never ends the watch', () => {
  // An hour of silence caused by a transient GitHub API hiccup would be exactly
  // the failure this file exists to prevent.
  const run = read('../../scripts/watchdog/run.mjs');
  assert.match(run, /a look failed, carrying on/);
  assert.match(run, /catch \(e\) \{\s*console\.error\('\[watchdog\] a look failed/);
});

test('a long watch does not turn the run red hours after the fact', () => {
  // Real faults already speak through their own issue and text. A red tick 50
  // minutes later is a stale second alarm; a broken watchdog is not.
  const run = read('../../scripts/watchdog/run.mjs');
  assert.match(run, /if \(brokenEver\) process\.exitCode = 1;/);
});

test('the alarm can be tested without waiting for a real fault', () => {
  // An alert path nobody has ever tested is not an alert path.
  const run = read('../../scripts/watchdog/run.mjs');
  assert.match(run, /if \(TEST_SMS\) \{ return \{ broken: !\(await testText\(\)\) \}; \}/,
    'the test sends and stops: it must never open, comment on or close an issue');
  assert.match(run, /if \(TEST_SMS\) \{ const r = await oneCycle\(\); process\.exitCode = r\.broken \? 1 : 0; return; \}/,
    'and a test text never starts the hour-long watch');
  assert.match(run, /Twilio refused it: /, 'and it repeats what Twilio actually said');
  const wf = read('../../.github/workflows/watchdog.yml');
  assert.match(wf, /test_sms:/);
  assert.match(wf, /--test-sms/);
});

test('the thresholds are the measured ones, and they are written down', () => {
  assert.equal(SIGNALS.card_stranded.minutes, 10);
  assert.equal(SIGNALS.print_stuck.minutes, 10);
  assert.equal(SIGNALS.orders_open.minutes, 45);
  const src = read('../../scripts/watchdog/checks.mjs');
  assert.match(src, /0 in 30 days/, 'the evidence for each threshold is in the file');
  assert.match(src, /14 in 30 days/);
});
