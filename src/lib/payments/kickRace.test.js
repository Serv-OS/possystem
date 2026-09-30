// kickRace.test.js (30 Sep 2026): the till no longer waits for the whole card payment on its own
// Adyen 'start' kick. Huddersfield 30 Sep: the checkout sat on "Sending…" for the entire tender,
// staff closed it, the sale was booked in the background and rung again (R5737/R5739).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { raceKick, settleKick, classifyKickOutcome, KICK_WAIT_MS } from './kickRace.js';

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const httpError = (message, status, extra = {}) => Object.assign(new Error(message), { status, ...extra });

test('the default wait is 3 s', () => {
  assert.equal(KICK_WAIT_MS, 3000);
});

test('a slow kick (the customer is still paying) comes back pending after the wait, and is NOT aborted', async () => {
  let settledLate = false;
  let resolveKick;
  const kickCall = new Promise((res) => { resolveKick = res; });
  const outcome = settleKick(kickCall);
  outcome.then(() => { settledLate = true; });

  const t0 = Date.now();
  const raced = await raceKick(outcome, 40);
  assert.deepEqual(raced, { pending: true });
  assert.ok(Date.now() - t0 >= 35, 'waited the whole window');
  assert.equal(settledLate, false, 'the kick is still running');

  // 45 s later the reader approves and the sync call answers: the same promise settles, untouched.
  resolveKick({ ok: true });
  const late = await outcome;
  assert.deepEqual(late, { kickError: null, kickAnswered: false });
  assert.equal(settledLate, true);
});

test('a fast refusal the fn answered (503 not configured, 409 not paired) comes back as kickError, answered', async () => {
  const outcome = settleKick(Promise.reject(httpError('terminal_not_linked', 409, { code: 'TERMINAL_NOT_LINKED' })));
  const raced = await raceKick(outcome, 3000);
  assert.equal(raced.pending, false);
  assert.equal(raced.kickError, 'terminal_not_linked');
  assert.equal(raced.kickAnswered, true, 'the server\'s own kick hits the same wall: not "the server is sending it instead"');
  assert.equal(raced.status, 409);
});

test('a fast transport failure (no HTTP status) comes back as kickError, NOT answered', async () => {
  const outcome = settleKick(Promise.reject(new Error('Failed to fetch')));
  const raced = await raceKick(outcome, 3000);
  assert.equal(raced.pending, false);
  assert.equal(raced.kickError, 'Failed to fetch');
  assert.equal(raced.kickAnswered, false, 'the server\'s scheduled kick can still reach the reader');
});

test('IN_FLIGHT (the server\'s kick or another till won the claim) comes back as null: not an error', async () => {
  for (const e of [
    httpError('in_flight', 409, { code: 'IN_FLIGHT' }),
    httpError('in_flight', 409),                               // a fn not yet redeployed with the code
  ]) {
    const raced = await raceKick(settleKick(Promise.reject(e)), 3000);
    assert.deepEqual(raced, { pending: false, kickError: null, kickAnswered: false });
  }
  assert.deepEqual(classifyKickOutcome({ code: 'IN_FLIGHT', message: 'anything' }), { kickError: null, kickAnswered: false });
});

test('an accepted kick comes back clean', async () => {
  const raced = await raceKick(settleKick(Promise.resolve({ ok: true })), 3000);
  assert.deepEqual(raced, { pending: false, kickError: null, kickAnswered: false });
  assert.deepEqual(classifyKickOutcome(null), { kickError: null, kickAnswered: false });
  assert.deepEqual(classifyKickOutcome(undefined), { kickError: null, kickAnswered: false });
});

test('the fn\'s structured detail rides on the outcome (for the busy and repeat payloads)', () => {
  const o = classifyKickOutcome(httpError('TERMINAL_BUSY', 409, { detail: { job_id: 'j1', amount_minor: 1165 } }));
  assert.equal(o.kickError, 'TERMINAL_BUSY');
  assert.equal(o.kickAnswered, true);
  assert.deepEqual(o.detail, { job_id: 'j1', amount_minor: 1165 });
});

test('raceKick never rejects, even if handed a promise that does', async () => {
  const raced = await raceKick(Promise.reject(httpError('boom', 500)), 3000);
  assert.deepEqual(raced, { pending: false, kickError: 'boom', kickAnswered: true, status: 500, detail: null });
  const bare = await raceKick(Promise.reject('x'), 3000);
  assert.equal(bare.kickError, 'x');
});

test('a zero or bad wait still races (settles at once as pending unless the kick is already settled)', async () => {
  const p = settleKick(Promise.resolve());
  await wait(0);
  const r = await raceKick(p, 0);
  // Both are acceptable here (a 0 ms timer versus an already settled promise); it must simply not hang or throw.
  assert.ok(typeof r.pending === 'boolean');
  const r2 = await raceKick(new Promise(() => {}), 'not a number');
  assert.deepEqual(r2, { pending: true });
});

test('the race timer is cleared when the kick answers first (no stray timer)', async () => {
  let cleared = 0;
  const timers = {
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (t) => { cleared++; globalThis.clearTimeout(t); },
  };
  await raceKick(settleKick(Promise.resolve()), 5000, timers);
  assert.equal(cleared, 1);
});

// ── wiring: the send ──────────────────────────────────────────────────────────

test('wiring: sendTerminalJob races the kick only when kickWaitMs is passed, holds payment busy while it is out, and never aborts it', () => {
  const tj = read('./terminalJobs.js');
  assert.match(tj, /import \{ withPaymentBusy \} from '\.\.\/paymentBusy';/);
  assert.match(tj, /import \{ holdPaymentBusy \} from '\.\.\/paymentBusy';/);
  assert.match(tj, /import \{ raceKick, settleKick \} from '\.\/kickRace';/);
  const send = tj.slice(tj.indexOf('  async function send(useJobId, useClosedCheckId) {'), tj.indexOf('export async function fetchJobCapture('));
  // The old await of the whole tender is gone.
  assert.ok(!send.includes("kickError = await callFn('adyen-terminal-charge', { action: 'start'"), 'the send no longer awaits the tender');
  assert.match(send, /const outcome = settleKick\(callFn\('adyen-terminal-charge', \{ action: 'start', job_id: useJobId \}\)\)/);
  assert.match(send, /const waitMs = Number\(p\.kickWaitMs\) \|\| 0;/);
  assert.match(send, /const raced = waitMs > 0 \? await raceKick\(outcome, waitMs\) : \{ pending: false, \.\.\.\(await outcome\) \};/, 'no kickWaitMs = wait for the kick as before (kiosk, MPOS)');
  assert.match(send, /const releaseBusy = holdPaymentBusy\('card machine kick'\);\s+outcome\.finally\(releaseBusy\);/);
  assert.ok(!/AbortController|\.abort\(\)/.test(send), 'the kick fetch is never aborted');
  assert.match(send, /return \{ job: j\.job, existing: !!j\.existing, kickError, serverKick, kickPending, kick, repeatWarning: j\.repeat_warning \?\? null \};/);
  // The IN_FLIGHT and transport/answered split lives in kickRace now, and still feeds serverKick.
  assert.match(send, /const serverKick = j\.kick_scheduled === true && !kickAnswered;/);
  // The fn's detail reaches the error.
  assert.match(tj, /err\.detail = j\?\.detail \?\? null;/);
});

test('wiring: only the till checkout and the split bill opt in; kiosk and MPOS keep the old wait', () => {
  const optIn = (p) => /kickWaitMs: KICK_WAIT_MS/.test(read(p));
  assert.equal(optIn('../../surfaces/CheckoutModal.jsx'), true);
  assert.equal(optIn('../../components/SplitModal.jsx'), true);
  assert.equal(optIn('../../surfaces/KioskApp.jsx'), false, 'kiosk unchanged until reviewed');
  assert.equal(optIn('../../surfaces/mpos/MCardFlow.jsx'), false, 'MPOS unchanged until reviewed');
  assert.ok(!/kickWaitMs/.test(read('../../surfaces/KioskApp.jsx')));
  assert.ok(!/kickWaitMs/.test(read('../../surfaces/mpos/MCardFlow.jsx')));
});
