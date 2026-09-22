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
  SIGNALS, PAGE, WARN, REMINDER_HOURS,
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

test('a wrong query is OUR bug, never reported as an outage', () => {
  // Caught on this script's first live run: it asked for order_queue.id, a
  // column that does not exist, and announced "the database is not answering".
  // That is the exact class of bug the watchdog exists to catch, so it must not
  // commit it itself.
  const run = read('../../scripts/watchdog/run.mjs');
  assert.match(run, /class WatchdogBug extends Error/);
  assert.match(run, /class Unreachable extends Error/);
  assert.match(run, /!\[401, 403, 408, 429\]\.includes\(res\.status\)/, '4xx is ours, 5xx and timeouts are theirs');
  assert.match(run, /THE WATCHDOG ITSELF IS BROKEN/);
});

test('a long-open order only counts if it is from TODAY', () => {
  // The first live run flagged six venues, every one of them orders abandoned
  // weeks ago. Permanent wallpaper is how an alert list gets ignored.
  const run = read('../../scripts/watchdog/run.mjs');
  assert.match(run, /created_at=gt\.\$\{ago\(24 \* 60\)\}/);
});

test('it works with no Twilio configured, because it has to', () => {
  const run = read('../../scripts/watchdog/run.mjs');
  assert.match(run, /if \(!sid \|\| !token \|\| !from \|\| !to\) return false;/,
    'no SMS credentials is not an error: the GitHub issue still opens');
});

test('the thresholds are the measured ones, and they are written down', () => {
  assert.equal(SIGNALS.card_stranded.minutes, 10);
  assert.equal(SIGNALS.print_stuck.minutes, 10);
  assert.equal(SIGNALS.orders_open.minutes, 45);
  const src = read('../../scripts/watchdog/checks.mjs');
  assert.match(src, /0 in 30 days/, 'the evidence for each threshold is in the file');
  assert.match(src, /14 in 30 days/);
});
