/**
 * readerTip.test.js - a tip added on the card machine is never lost
 * (supabase/functions/_shared/readerTip.js, v5.11.16).
 *
 * THE INCIDENT (29 Sep 2026, Coffee Boy Huddersfield, R3618, job 53ae162a): the
 * Adyen reader took 7.97 on a 7.25 bill (TipAmount 72). The one write recording
 * the tip hit "connection reset", the code settled anyway, the RPC parked the job
 * "amount mismatch: processor 797 vs server 725" and the till booked 7.25 with no
 * tip. The fixtures below are that job and Adyen's ledger row, read live.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  TIP_WRITE_RETRY_DELAYS_MS, TIP_HEAL_MAX_PCT, TIP_HEAL_FLOOR_MINOR, HEAL_MAX_AGE_MS,
  STRANDED_MIN_DISPATCH_AGE_MS, STRANDED_MIN_LEDGER_AGE_MS, STRANDED_PARK_AFTER_MS,
  HEAL_WAIT_ALERT_AFTER_MS, PENDING_CHECK_MAX_AGE_MS, TIP_NOTE_PREFIX, AMOUNT_MISMATCH_LIKE, PENDING_NOTE_LIKE,
  QUIET_REFUSALS,
  tipAskedOnReader, tipHealCapMinor, ledgerAuthAmount, pickLedgerRow, isDefinitiveDbRefusal,
  tipWriteOutcome, planLedgerSettle, parseAmountMismatch, planTipHeal, amountEvidence,
  healNote, healNoteState, jobIdFromMerchantReference, money, reasonText, healActivity, mismatchAlert,
  REVERSAL_EVENT_CODES, ledgerApproval, verifiedAuthorisation, activityIdFor, alertKey, healActivityKey, ledgerShowsApproval,
  tipEvidenceKey, readerTipFromEvidence, lateConfirmationFacts,
} from '../../../supabase/functions/_shared/readerTip.js';

const JOB_ID = '53ae162a-4c8e-4699-a694-3ef53b3ca60e';
const PSP = 'G8837M7KC3TTTQR9';
const TX = `TwkU001790675787051.${PSP}`;

// terminal_jobs 53ae162a as it is parked now (read-only SQL, 29 Sep 2026).
const r3618Job = (over = {}) => ({
  id: JOB_ID,
  processor: 'adyen',
  simulated: false,
  training: false,
  status: 'approved',
  needs_human: true,
  last_error: 'amount mismatch: processor 797 vs server 725',
  tip_minor: null,
  charge_minor: 725,
  due_minor: 725,
  tip_basis_minor: 725,
  reported_minor: null,
  currency: 'GBP',
  tip_config: {
    enabled: true, allowNoTip: true, allowCustom: true, allow_custom: true,
    percentBands: [5, 10, 15], tip_percentages: [5, 10, 15], tipping_enabled: true, smartThresholdMinor: 0,
  },
  capture_mode: null,
  payment_session_id: PSP,
  transaction_id: TX,
  closed_check_id: 'chk-1790675785198-b44c71',
  location_id: '5435c88e-6a58-4ebf-b2a0-b5ed5c9bdaa9',
  check_draft: { source: 'pos_send_to_terminal' },
  settled_at: '2026-09-29T09:56:38.078Z',
  ...over,
});

// platform adyen_payments G8837M7KC3TTTQR9 (read-only SQL, 29 Sep 2026).
const r3618Ledger = (over = {}) => ({
  psp_reference: PSP,
  merchant_reference: `tj-${JOB_ID}`,
  success: true,
  amount_minor: 797,
  currency: 'GBP',
  last_event_code: 'AUTHORISATION',
  card: { aid: null, cvm: null, brand: 'visa', last4: '3814', authCode: '091258', readMethod: null, fundingSource: null, applicationName: null },
  raw: { region: 'UK', authorisation: { amount: { value: 797, currency: 'GBP' }, eventCode: 'AUTHORISATION', success: 'true' } },
  created_at: '2026-09-29T09:56:43.455Z',
  ...over,
});

// ── constants ────────────────────────────────────────────────────────────────

test('retry schedule: three attempts, under 1.5 s in total, the first at once', () => {
  assert.equal(TIP_WRITE_RETRY_DELAYS_MS.length, 3);
  assert.equal(TIP_WRITE_RETRY_DELAYS_MS[0], 0);
  const total = TIP_WRITE_RETRY_DELAYS_MS.reduce((s, d) => s + d, 0);
  assert.ok(total < 1500, `total ${total}`);
  assert.ok(Object.isFrozen(TIP_WRITE_RETRY_DELAYS_MS));
});

test('bounds and windows are what the design says', () => {
  assert.equal(TIP_HEAL_MAX_PCT, 50);
  assert.equal(TIP_HEAL_FLOOR_MINOR, 500);
  assert.equal(HEAL_MAX_AGE_MS, 7 * 24 * 3600 * 1000);
  assert.equal(STRANDED_MIN_DISPATCH_AGE_MS, 60_000);
  assert.equal(STRANDED_MIN_LEDGER_AGE_MS, 30_000);
  assert.equal(STRANDED_PARK_AFTER_MS, 5 * 60_000);
  assert.equal(HEAL_WAIT_ALERT_AFTER_MS, 5 * 60_000);
  assert.equal(PENDING_CHECK_MAX_AGE_MS, 3 * 24 * 3600 * 1000);
  assert.equal(TIP_NOTE_PREFIX, 'tip added from the card machine');
});

test('the sweep LIKE patterns match the RPC park text and the pending note, and nothing else', () => {
  const like = (pattern, text) => new RegExp('^' + pattern.split('%').map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$').test(text);
  assert.ok(like(AMOUNT_MISMATCH_LIKE, 'amount mismatch: processor 797 vs server 725'));
  assert.ok(!like(AMOUNT_MISMATCH_LIKE, 'payment session mismatch: job holds A, settle cited B / amount mismatch: processor 797 vs server 725'));
  const pending = healNote({ tipMinor: 72, psp: PSP, amountMinor: 797, billMinor: 725, sale: { state: 'pending' } });
  assert.ok(like(PENDING_NOTE_LIKE, pending));
  const done = healNote({ tipMinor: 72, psp: PSP, amountMinor: 797, billMinor: 725, sale: { state: 'corrected', ref: 'R3618', fromMinor: 725, toMinor: 797 } });
  assert.ok(!like(PENDING_NOTE_LIKE, done));
  assert.ok(!like(AMOUNT_MISMATCH_LIKE, pending));
});

// ── tipAskedOnReader ─────────────────────────────────────────────────────────

test('tipAskedOnReader: the frozen tip_config is the proof AskGratuity went out', () => {
  assert.equal(tipAskedOnReader(r3618Job()), true);
  assert.equal(tipAskedOnReader(r3618Job({ tip_config: { enabled: false } })), false);
  assert.equal(tipAskedOnReader(r3618Job({ tip_config: null })), false);
  assert.equal(tipAskedOnReader(r3618Job({ tip_config: {} })), false);
  assert.equal(tipAskedOnReader(r3618Job({ tip_config: { enabled: 'true' } })), false, 'only the boolean the charge fn reads');
  // Manual capture (US tip on receipt) forces AskGratuity OFF on the reader.
  assert.equal(tipAskedOnReader(r3618Job({ capture_mode: 'manual' })), false);
  assert.equal(tipAskedOnReader(null), false);
});

test('the charge fn still sends AskGratuity from exactly this expression', () => {
  const src = readFileSync(new URL('../../../supabase/functions/adyen-terminal-charge/index.ts', import.meta.url), 'utf8');
  assert.match(src, /askGratuity: job\.capture_mode === 'manual'\s*\?\s*false\s*:\s*\(job\.tip_config as \{ enabled\?: boolean \} \| null\)\?\.enabled === true/);
});

// ── cap ──────────────────────────────────────────────────────────────────────

test('cap: max(50% of the bill, 5.00)', () => {
  assert.equal(tipHealCapMinor(r3618Job()), 500, '725 gives the 5.00 floor');
  assert.equal(tipHealCapMinor(r3618Job({ tip_basis_minor: 2000, due_minor: 2000 })), 1000);
  assert.equal(tipHealCapMinor(r3618Job({ tip_basis_minor: 1001, due_minor: 1001 })), 500);
  assert.equal(tipHealCapMinor(r3618Job({ tip_basis_minor: 1003, due_minor: 1003 })), 501, 'floored');
  assert.equal(tipHealCapMinor(r3618Job({ tip_basis_minor: null, due_minor: 3000 })), 1500, 'no basis falls back to due');
  assert.equal(tipHealCapMinor(r3618Job({ tip_basis_minor: 0, due_minor: 4000 })), 2000, 'a zero basis falls back to due');
  assert.equal(tipHealCapMinor({}), 500);
});

// ── ledger rows ──────────────────────────────────────────────────────────────

test('ledgerAuthAmount: the AUTHORISATION amount, else the row amount', () => {
  assert.equal(ledgerAuthAmount(r3618Ledger()), 797);
  assert.equal(ledgerAuthAmount(r3618Ledger({ raw: {} })), 797);
  assert.equal(ledgerAuthAmount(r3618Ledger({ raw: { authorisation: { amount: { value: 800 } } } })), 800);
  assert.equal(ledgerAuthAmount(r3618Ledger({ raw: {}, amount_minor: null })), null);
  assert.equal(ledgerAuthAmount(r3618Ledger({ raw: { authorisation: { amount: { value: 7.97 } } }, amount_minor: 797 })), 797, 'a non integer is not an amount');
});

test('pickLedgerRow: none, one success, success plus refusal, refusals only, two successes', () => {
  assert.deepEqual(pickLedgerRow([]), { row: null, ambiguous: false });
  assert.deepEqual(pickLedgerRow(null), { row: null, ambiguous: false });
  const ok = r3618Ledger();
  assert.equal(pickLedgerRow([ok]).row, ok);
  const refused = r3618Ledger({ psp_reference: 'REFUSED1', success: false, created_at: '2026-09-29T09:56:50Z' });
  assert.equal(pickLedgerRow([refused, ok]).row, ok, 'a success wins over a newer refusal');
  const older = r3618Ledger({ psp_reference: 'OLD', success: false, created_at: '2026-09-29T09:50:00Z' });
  assert.equal(pickLedgerRow([older, refused]).row, refused, 'no success: the newest refusal');
  const two = pickLedgerRow([ok, r3618Ledger({ psp_reference: 'SECOND' })]);
  assert.equal(two.ambiguous, true);
  assert.equal(two.row, null);
});

// ── the verify step ──────────────────────────────────────────────────────────

test('tipWriteOutcome: all five classes', () => {
  const p = { tipMinor: 72, authorizedMinor: 797, chargeMinor: 725 };
  // The write landed but its reply was lost (the incident's other half).
  assert.equal(tipWriteOutcome({ tip_minor: 72, charge_minor: 797, status: 'charging' }, p), 'recorded');
  // Another path recorded it and settled already.
  assert.equal(tipWriteOutcome({ tip_minor: 72, charge_minor: 797, status: 'approved' }, p), 'recorded');
  // Untouched and still in flight.
  assert.equal(tipWriteOutcome({ tip_minor: null, charge_minor: 725, status: 'charging' }, p), 'retry');
  assert.equal(tipWriteOutcome({ tip_minor: null, charge_minor: 725, status: 'unknown' }, p), 'retry');
  // The read itself failed.
  assert.equal(tipWriteOutcome(null, p), 'retry');
  // Settled without our tip (another path settled first).
  assert.equal(tipWriteOutcome({ tip_minor: null, charge_minor: 725, status: 'approved' }, p), 'settled_elsewhere');
  assert.equal(tipWriteOutcome({ tip_minor: null, charge_minor: 725, status: 'reconciled' }, p), 'settled_elsewhere');
  // Something else wrote a different tip, or the job left the in-flight states.
  assert.equal(tipWriteOutcome({ tip_minor: 50, charge_minor: 775, status: 'charging' }, p), 'conflict');
  assert.equal(tipWriteOutcome({ tip_minor: null, charge_minor: 725, status: 'charging_unsent' }, p), 'conflict');
});

test('isDefinitiveDbRefusal: constraint, data and our RPC exceptions only; a connection reset is retried', () => {
  assert.equal(isDefinitiveDbRefusal({ code: '23514', message: 'violates check constraint "tj_charge_identity"' }), true);
  assert.equal(isDefinitiveDbRefusal({ code: '22P02' }), true);
  assert.equal(isDefinitiveDbRefusal({ code: '42703' }), true);
  assert.equal(isDefinitiveDbRefusal({ code: 'P0001', message: 'job not found' }), true);
  // The incident's error, exactly as supabase-js returned it.
  assert.equal(isDefinitiveDbRefusal({ code: '', message: 'TypeError: error sending request for url (https://x/rest/v1/terminal_jobs?id=eq.53ae162a&tip_minor=is.null): client error (SendRequest): connection error: connection reset' }), false);
  assert.equal(isDefinitiveDbRefusal({ code: '57014' }), false, 'statement timeout is worth a retry');
  assert.equal(isDefinitiveDbRefusal({ code: 'PGRST000' }), false);
  assert.equal(isDefinitiveDbRefusal(new TypeError('fetch failed')), false);
  assert.equal(isDefinitiveDbRefusal(null), false);
});

// ── planLedgerSettle ─────────────────────────────────────────────────────────

const inflight = (over = {}) => r3618Job({ status: 'charging', needs_human: false, last_error: null, ...over });

test('planLedgerSettle: the amount equals the charge', () => {
  const plan = planLedgerSettle(inflight(), r3618Ledger({ amount_minor: 725, raw: { authorisation: { amount: { value: 725 } } } }));
  assert.equal(plan.action, 'approve');
  assert.equal(plan.tipMinor, null);
  assert.equal(plan.amountMinor, 725);
  assert.equal(plan.psp, PSP);
});

test('planLedgerSettle: R3618 still in flight settles WITH the 72p tip', () => {
  const plan = planLedgerSettle(inflight(), r3618Ledger());
  assert.deepEqual({ action: plan.action, tipMinor: plan.tipMinor, amountMinor: plan.amountMinor }, { action: 'approve', tipMinor: 72, amountMinor: 797 });
});

test('planLedgerSettle: over the cap parks only when allowed', () => {
  const big = r3618Ledger({ amount_minor: 1300, raw: { authorisation: { amount: { value: 1300 } } } });  // +575 > 500
  assert.equal(planLedgerSettle(inflight(), big).action, 'skip');
  assert.equal(planLedgerSettle(inflight(), big, { allowPark: false }).reason, 'unexplained_amount');
  const parked = planLedgerSettle(inflight(), big, { allowPark: true });
  assert.equal(parked.action, 'approve_park');
  assert.equal(parked.amountMinor, 1300);
  assert.equal(parked.tipMinor, null);
});

test('planLedgerSettle: less than the bill, a reader not asked, a tip already set: never a tip', () => {
  const less = r3618Ledger({ amount_minor: 700, raw: { authorisation: { amount: { value: 700 } } } });
  assert.equal(planLedgerSettle(inflight(), less).action, 'skip');
  assert.equal(planLedgerSettle(inflight(), less, { allowPark: true }).action, 'approve_park');
  assert.equal(planLedgerSettle(inflight({ tip_config: { enabled: false } }), r3618Ledger()).action, 'skip');
  assert.equal(planLedgerSettle(inflight({ capture_mode: 'manual' }), r3618Ledger()).action, 'skip');
  assert.equal(planLedgerSettle(inflight({ tip_minor: 0 }), r3618Ledger()).action, 'skip');
});

test('planLedgerSettle: a different currency is never settled from the ledger', () => {
  const plan = planLedgerSettle(inflight(), r3618Ledger({ currency: 'USD' }), { allowPark: true });
  assert.equal(plan.action, 'skip');
  assert.equal(plan.reason, 'currency');
});

test('planLedgerSettle: a refusal declines with Adyen\'s own reason', () => {
  const refused = r3618Ledger({ success: false, raw: { authorisation: { reason: 'Refused', additionalData: { refusalReason: 'Not enough balance' } } } });
  assert.deepEqual(planLedgerSettle(inflight(), refused), { action: 'decline', psp: PSP, declineReason: 'Not enough balance' });
  const bare = r3618Ledger({ success: false, raw: { authorisation: { reason: 'Refused' } } });
  assert.equal(planLedgerSettle(inflight(), bare).declineReason, 'Refused');
  assert.equal(planLedgerSettle(inflight(), r3618Ledger({ success: false, raw: {} })).declineReason, 'declined');
  assert.equal(planLedgerSettle(inflight(), null).action, 'skip');
});

// ── a success row whose money did not stay is never a paid sale ──────────────

test('ledgerApproval: only AUTHORISATION or CAPTURE with nothing refunded is approved', () => {
  assert.equal(ledgerApproval(r3618Ledger()), 'approved');
  assert.equal(ledgerApproval(r3618Ledger({ last_event_code: 'CAPTURE' })), 'approved');
  assert.equal(ledgerApproval(r3618Ledger({ amount_refunded_minor: 0 })), 'approved');
  assert.equal(ledgerApproval(r3618Ledger({ success: false })), 'refused');
  // adyen-webhook keeps success=true on every modification: only the code and the refunded sum move.
  for (const code of REVERSAL_EVENT_CODES) assert.equal(ledgerApproval(r3618Ledger({ last_event_code: code })), 'reversed', code);
  assert.equal(ledgerApproval(r3618Ledger({ amount_refunded_minor: 300 })), 'reversed', 'partly refunded');
  assert.equal(ledgerApproval(r3618Ledger({ last_event_code: 'AUTHORISATION', amount_refunded_minor: '797' })), 'reversed');
  for (const code of ['REFUND_FAILED', 'CAPTURE_FAILED', 'CANCELLATION_FAILED', 'AUTHORISATION_ADJUSTMENT', null, '']) {
    assert.equal(ledgerApproval(r3618Ledger({ last_event_code: code })), 'changed', String(code));
  }
  assert.equal(ledgerApproval(null), 'changed');
});

test('planLedgerSettle: a payment Adyen approved and then saw refunded, cancelled or changed is NEVER approved', () => {
  for (const allowPark of [false, true]) {
    for (const [over, reason] of [
      [{ last_event_code: 'REFUND' }, 'reversed'],
      [{ last_event_code: 'CANCELLATION' }, 'reversed'],
      [{ last_event_code: 'CANCEL_OR_REFUND' }, 'reversed'],
      [{ last_event_code: 'CHARGEBACK' }, 'reversed'],
      [{ amount_refunded_minor: 200 }, 'reversed'],
      [{ last_event_code: 'REFUND_FAILED' }, 'event_code'],
      [{ last_event_code: null }, 'event_code'],
    ]) {
      // The amount equals the charge: exactly the row that used to book a paid sale.
      const row = r3618Ledger({ amount_minor: 725, raw: { authorisation: { amount: { value: 725 } } }, ...over });
      assert.deepEqual(planLedgerSettle(inflight(), row, { allowPark }), { action: 'skip', reason, psp: PSP }, JSON.stringify(over));
    }
  }
  // A refusal still declines (success false is the authorisation itself).
  assert.equal(planLedgerSettle(inflight(), r3618Ledger({ success: false, last_event_code: 'AUTHORISATION' })).action, 'decline');
});

test('planLedgerSettle: the reader\'s own TipAmount (deferred settle evidence) explains an over cap tip exactly', () => {
  // Pay at table: a 4.00 bill, a 6.00 custom tip. The cap is max(200, 500) = 500, so the heal rule alone parks it.
  const job = inflight({ charge_minor: 400, due_minor: 400, tip_basis_minor: 400 });
  const row = r3618Ledger({ amount_minor: 1000, raw: { authorisation: { amount: { value: 1000 } } } });
  assert.equal(planLedgerSettle(job, row).reason, 'unexplained_amount');
  assert.deepEqual(planLedgerSettle(job, row, { readerTipMinor: 600 }), { action: 'approve', amountMinor: 1000, tipMinor: 600, psp: PSP, reason: 'reader_tip' });
  // Evidence that does not explain it exactly changes nothing.
  assert.equal(planLedgerSettle(job, row, { readerTipMinor: 599 }).action, 'skip');
  assert.equal(planLedgerSettle(job, row, { readerTipMinor: 599, allowPark: true }).action, 'approve_park');
  assert.equal(planLedgerSettle(inflight({ ...job, tip_minor: 0 }), row, { readerTipMinor: 600 }).action, 'skip', 'a tip already set');
  // And a reversed row is refused whatever the evidence says.
  assert.equal(planLedgerSettle(job, r3618Ledger({ amount_minor: 1000, last_event_code: 'REFUND' }), { readerTipMinor: 600 }).action, 'skip');
});

test('ledgerShowsApproval: a NotFound never reverts a job Adyen approved (the over cap tip case)', () => {
  // A 3.50 sale with a 6.00 custom tip: over the cap, so the ledger settle skips and 'result' asks the reader.
  const overCap = { verdict: 'charged', row: r3618Ledger({ amount_minor: 950, raw: { authorisation: { amount: { value: 950 } } } }) };
  assert.equal(planLedgerSettle(inflight({ charge_minor: 350, due_minor: 350, tip_basis_minor: 350 }), overCap.row).action, 'skip');
  assert.equal(ledgerShowsApproval(overCap), true, 'so the reader\'s NotFound must not reset it to charging_unsent');
  // Then it is settled and PARKED with both amounts instead.
  assert.equal(planLedgerSettle(inflight({ charge_minor: 350, due_minor: 350, tip_basis_minor: 350 }), overCap.row, { allowPark: true }).action, 'approve_park');
  assert.equal(ledgerShowsApproval({ verdict: 'charged', row: r3618Ledger({ last_event_code: 'REFUND' }) }), true, 'a reversed approval still proves the reader saw it');
  assert.equal(ledgerShowsApproval({ verdict: 'too_soon', ambiguous: true }), true, 'two approvals');
  assert.equal(ledgerShowsApproval({ verdict: 'charged', row: r3618Ledger({ success: false }) }), false, 'a refusal: a retry is safe');
  assert.equal(ledgerShowsApproval({ verdict: 'nothing' }), false);
  assert.equal(ledgerShowsApproval({ verdict: 'too_soon' }), false);
  assert.equal(ledgerShowsApproval(null), false);
});

test('readerTipFromEvidence: only the exact figures for THIS job and THIS amount', () => {
  const ev = { source: 'charge_sync', chargeMinor: 400, tipMinor: 600, authorizedMinor: 1000 };
  assert.equal(tipEvidenceKey(JOB_ID), `tip-unrecorded:${JOB_ID}`);
  assert.equal(readerTipFromEvidence(ev, { amountMinor: 1000, chargeMinor: 400 }), 600);
  assert.equal(readerTipFromEvidence(ev, { amountMinor: 1001, chargeMinor: 400 }), null, 'Adyen took something else');
  assert.equal(readerTipFromEvidence(ev, { amountMinor: 1000, chargeMinor: 450 }), null, 'the job changed since');
  assert.equal(readerTipFromEvidence({ ...ev, tipMinor: 0 }, { amountMinor: 1000, chargeMinor: 400 }), null);
  assert.equal(readerTipFromEvidence({ ...ev, tipMinor: 500 }, { amountMinor: 1000, chargeMinor: 400 }), null, 'does not add up');
  assert.equal(readerTipFromEvidence(null, { amountMinor: 1000, chargeMinor: 400 }), null);
});

test('verifiedAuthorisation: an HMAC verified AUTHORISATION for this job and psp, nothing else', () => {
  const ev = (over = {}) => ({ event_code: 'AUTHORISATION', psp_reference: PSP, merchant_reference: `tj-${JOB_ID}`, success: true, hmac_valid: true, live: true, ...over });
  const row = r3618Ledger({ live: true });
  assert.equal(verifiedAuthorisation([ev()], row, JOB_ID), true);
  assert.equal(verifiedAuthorisation([ev({ hmac_valid: null })], row, JOB_ID), false, 'unsigned');
  assert.equal(verifiedAuthorisation([ev({ hmac_valid: false })], row, JOB_ID), false, 'bad signature');
  assert.equal(verifiedAuthorisation([ev({ merchant_reference: 'tj-someone-else' })], row, JOB_ID), false);
  assert.equal(verifiedAuthorisation([ev({ psp_reference: 'OTHER' })], row, JOB_ID), false);
  assert.equal(verifiedAuthorisation([ev({ event_code: 'REFUND' })], row, JOB_ID), false);
  assert.equal(verifiedAuthorisation([ev({ success: false })], row, JOB_ID), false, 'a verified refusal does not prove an approval');
  assert.equal(verifiedAuthorisation([ev({ live: false })], row, JOB_ID), false, 'a test event never proves a live row');
  assert.equal(verifiedAuthorisation([ev({ hmac_valid: null }), ev()], row, JOB_ID), true, 'a verified redelivery counts');
  assert.equal(verifiedAuthorisation([], row, JOB_ID), false);
  assert.equal(verifiedAuthorisation(null, row, JOB_ID), false);
  assert.equal(verifiedAuthorisation([ev({ success: false })], r3618Ledger({ success: false }), JOB_ID), true, 'a verified refusal proves a refusal');
});

// ── exactly once, by id ──────────────────────────────────────────────────────

test('activityIdFor: the same key is always the same uuid, different keys differ', async () => {
  const a = await activityIdFor(`amount-alert:${JOB_ID}`);
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(await activityIdFor(`amount-alert:${JOB_ID}`), a);
  assert.notEqual(await activityIdFor(`amount-alert:${JOB_ID}:wait`), a);
  assert.notEqual(await activityIdFor(healActivityKey(JOB_ID)), a);
});

test('alertKey: one subject per key, so a later alert is never swallowed by an earlier one', () => {
  assert.equal(alertKey(JOB_ID, 'refuse'), `amount-alert:${JOB_ID}`);
  assert.equal(alertKey(JOB_ID, 'ambiguous'), `amount-alert:${JOB_ID}`);
  assert.equal(alertKey(JOB_ID, 'wait'), `amount-alert:${JOB_ID}:wait`);
  assert.equal(alertKey(JOB_ID, 'sale_not_corrected'), `amount-alert:${JOB_ID}:sale`);
  assert.equal(alertKey(JOB_ID, 'sale_never_recorded'), `amount-alert:${JOB_ID}:sale`);
  assert.equal(alertKey(JOB_ID, 'reversed'), `amount-alert:${JOB_ID}:reversed`);
  assert.equal(alertKey(JOB_ID, 'confirmed_late'), `amount-alert:${JOB_ID}:late`);
  assert.equal(healActivityKey(JOB_ID), `tip-heal-activity:${JOB_ID}`);
});

test('lateConfirmationFacts: what Adyen took, the bill, and a tip only when proven', () => {
  const unknown = r3618Job({ status: 'unknown', needs_human: true, last_error: 'dispatched but no result received' });
  assert.deepEqual(lateConfirmationFacts(unknown, r3618Ledger()), { reportedMinor: 797, chargeMinor: 725, tipMinor: 72 });
  assert.deepEqual(lateConfirmationFacts(unknown, r3618Ledger({ amount_minor: 725, raw: { authorisation: { amount: { value: 725 } } } })), { reportedMinor: 725, chargeMinor: 725, tipMinor: null });
  const big = r3618Ledger({ amount_minor: 1300, raw: { authorisation: { amount: { value: 1300 } } } });
  assert.equal(lateConfirmationFacts(unknown, big).tipMinor, null, 'over the cap and no evidence');
  assert.equal(lateConfirmationFacts(unknown, big, { chargeMinor: 725, tipMinor: 575, authorizedMinor: 1300 }).tipMinor, 575, "the reader's own TipAmount");
  assert.equal(lateConfirmationFacts(r3618Job({ status: 'unknown', tip_config: { enabled: false } }), r3618Ledger()).tipMinor, null, 'not asked');
});

// ── parseAmountMismatch ──────────────────────────────────────────────────────

test('parseAmountMismatch: the exact R3618 text, and nothing looser', () => {
  assert.deepEqual(parseAmountMismatch('amount mismatch: processor 797 vs server 725'), { processorMinor: 797, serverMinor: 725 });
  assert.equal(parseAmountMismatch('payment session mismatch: job holds A, settle cited B / amount mismatch: processor 797 vs server 725'), null);
  assert.equal(parseAmountMismatch('amount mismatch: processor 797 vs server 725 (acknowledged)'), null);
  assert.equal(parseAmountMismatch(' amount mismatch: processor 797 vs server 725'), null);
  assert.equal(parseAmountMismatch('amount mismatch: processor -1 vs server 725'), null);
  assert.equal(parseAmountMismatch('dispatched but no result received'), null);
  assert.equal(parseAmountMismatch(null), null);
  assert.equal(parseAmountMismatch(797), null);
});

// ── planTipHeal ──────────────────────────────────────────────────────────────

test('planTipHeal: the real R3618 job and ledger heal 72p to 797 on G8837M7KC3TTTQR9', () => {
  assert.deepEqual(planTipHeal(r3618Job(), [r3618Ledger()]), {
    outcome: 'heal', tipMinor: 72, amountMinor: 797, psp: PSP, currency: 'GBP',
  });
});

test('planTipHeal: Adyen\'s record not arrived yet is a wait, never a heal from the text', () => {
  assert.deepEqual(planTipHeal(r3618Job(), []), { outcome: 'wait', reason: 'no_ledger_row' });
  assert.deepEqual(planTipHeal(r3618Job(), null), { outcome: 'wait', reason: 'no_ledger_row' });
});

test('planTipHeal: every ledger guard refuses', () => {
  const refuse = (row, reason) => assert.deepEqual(planTipHeal(r3618Job(), [row]), { outcome: 'refuse', reason }, reason);
  refuse(r3618Ledger({ psp_reference: 'SOMEONEELSE' }), 'psp_mismatch');
  refuse(r3618Ledger({ success: false }), 'not_success');
  refuse(r3618Ledger({ last_event_code: 'REFUND' }), 'event_code');
  refuse(r3618Ledger({ last_event_code: 'CANCELLATION' }), 'event_code');
  refuse(r3618Ledger({ amount_minor: 900 }), 'auth_amount_differs');   // a capture moved it since
  refuse(r3618Ledger({ currency: 'USD' }), 'currency');
  refuse(r3618Ledger({ currency: null }), 'currency');
  // The ledger and the park text disagree: the text is corroboration, never the source.
  refuse(r3618Ledger({ amount_minor: 800, raw: { authorisation: { amount: { value: 800 } } } }), 'text_differs_from_ledger');
  assert.deepEqual(planTipHeal(r3618Job(), [r3618Ledger(), r3618Ledger({ psp_reference: 'TWO' })]), { outcome: 'refuse', reason: 'ambiguous_ledger' });
  // CAPTURE is still Adyen's own approved payment.
  assert.equal(planTipHeal(r3618Job(), [r3618Ledger({ last_event_code: 'CAPTURE' })]).outcome, 'heal');
});

test('planTipHeal: every tip guard refuses', () => {
  const at = (amount) => r3618Ledger({ amount_minor: amount, raw: { authorisation: { amount: { value: amount } } } });
  const text = (amount) => `amount mismatch: processor ${amount} vs server 725`;
  assert.deepEqual(planTipHeal(r3618Job({ last_error: text(1300) }), [at(1300)]), { outcome: 'refuse', reason: 'over_cap' });
  assert.equal(planTipHeal(r3618Job({ last_error: text(1225) }), [at(1225)]).outcome, 'heal', 'exactly the 5.00 cap heals');
  assert.deepEqual(planTipHeal(r3618Job({ last_error: text(700) }), [at(700)]), { outcome: 'refuse', reason: 'not_a_tip' });
  assert.deepEqual(planTipHeal(r3618Job({ tip_config: { enabled: false } }), [r3618Ledger()]), { outcome: 'refuse', reason: 'not_asked' });
  assert.deepEqual(planTipHeal(r3618Job({ capture_mode: 'manual' }), [r3618Ledger()]), { outcome: 'refuse', reason: 'manual_capture' });
});

test('planTipHeal: only a parked adyen job is ever looked at', () => {
  const np = (over) => planTipHeal(r3618Job(over), [r3618Ledger()]).outcome;
  assert.equal(np({ simulated: true }), 'not_parked');
  assert.equal(np({ training: true }), 'not_parked');
  assert.equal(np({ status: 'reconciled' }), 'not_parked');
  assert.equal(np({ status: 'charging' }), 'not_parked');
  assert.equal(np({ needs_human: false }), 'not_parked', 'a manager acknowledged it: never overridden');
  assert.equal(np({ processor: 'ryft' }), 'not_parked');
  assert.equal(planTipHeal(null, []).outcome, 'not_parked');
});

test('planTipHeal: the job must be exactly as the RPC parked it', () => {
  assert.deepEqual(planTipHeal(r3618Job({ tip_minor: 0 }), [r3618Ledger()]), { outcome: 'refuse', reason: 'tip_already_set' });
  assert.deepEqual(planTipHeal(r3618Job({ charge_minor: 730 }), [r3618Ledger()]), { outcome: 'refuse', reason: 'charge_not_due' });
  assert.deepEqual(planTipHeal(r3618Job({ due_minor: 700 }), [r3618Ledger()]), { outcome: 'refuse', reason: 'charge_not_due' });
  assert.deepEqual(planTipHeal(r3618Job({ last_error: 'amount mismatch: processor 797 vs server 700' }), [r3618Ledger()]), { outcome: 'refuse', reason: 'charge_not_due' });
  // A session mismatch is a wiring fault: never healed, and raised.
  assert.deepEqual(planTipHeal(r3618Job({ last_error: `payment session mismatch: job holds X, settle cited ${PSP} / amount mismatch: processor 797 vs server 725` }), [r3618Ledger()]), { outcome: 'refuse', reason: 'wiring_fault' });
  // Parked for some other reason entirely: not ours, and quiet (it is already in Back Office).
  const other = planTipHeal(r3618Job({ last_error: 'stale: live bill changed' }), [r3618Ledger()]);
  assert.deepEqual(other, { outcome: 'refuse', reason: 'not_amount_mismatch' });
  assert.ok(QUIET_REFUSALS.includes(other.reason));
  assert.ok(!QUIET_REFUSALS.includes('over_cap'));
});

test('idempotency: a healed job is never healed twice', () => {
  const note = healNote({ tipMinor: 72, psp: PSP, amountMinor: 797, billMinor: 725, sale: { state: 'pending' } });
  const healed = r3618Job({ tip_minor: 72, charge_minor: 797, reported_minor: 797, needs_human: false, last_error: note });
  assert.equal(planTipHeal(healed, [r3618Ledger()]).outcome, 'not_parked');
  assert.equal(parseAmountMismatch(note), null);
  // Even if someone set needs_human again, the note is not a mismatch and the tip is set.
  assert.equal(planTipHeal({ ...healed, needs_human: true }, [r3618Ledger()]).outcome, 'refuse');
});

// ── notes ────────────────────────────────────────────────────────────────────

test('healNote: every sale state, and healNoteState reads each back', () => {
  const base = { tipMinor: 72, psp: PSP, amountMinor: 797, billMinor: 725 };
  const pending = healNote({ ...base, sale: { state: 'pending' } });
  assert.equal(pending, `tip added from the card machine: +72 (Adyen ${PSP} took 797, bill 725); sale not booked yet`);
  assert.equal(healNoteState(pending), 'pending');
  assert.equal(healNote(base), pending, 'no sale = pending');

  const corrected = healNote({ ...base, sale: { state: 'corrected', ref: 'R3618', fromMinor: 725, toMinor: 797 } });
  assert.equal(corrected, `tip added from the card machine: +72 (Adyen ${PSP} took 797, bill 725); sale R3618 corrected from 725 to 797`);
  assert.equal(healNoteState(corrected), 'corrected');

  const right = healNote({ ...base, sale: { state: 'right', ref: 'R3618' } });
  assert.ok(right.endsWith('; sale R3618 already right'));
  assert.equal(healNoteState(right), 'corrected');

  const not = healNote({ ...base, sale: { state: 'not_corrected', ref: 'R3618', reason: 'refunded' } });
  assert.ok(not.endsWith('; sale R3618 NOT corrected (refunded)'));
  assert.equal(healNoteState(not), 'not_corrected');

  assert.equal(healNoteState('amount mismatch: processor 797 vs server 725'), null);
  assert.equal(healNoteState(null), null);
  assert.equal(healNoteState('tip added from the card machine: something else'), null);
});

test('healNote: bounded, single line, whatever it is handed', () => {
  const long = 'x'.repeat(5000);
  const n = healNote({ tipMinor: 72, psp: long, amountMinor: 797, billMinor: 725, sale: { state: 'not_corrected', ref: long, reason: `${long}\nmore` } });
  assert.ok(n.length < 300, `length ${n.length}`);
  assert.ok(!n.includes('\n'));
  assert.equal(healNoteState(n), 'not_corrected');
});

// ── evidence, refs, money ────────────────────────────────────────────────────

test('amountEvidence keeps the amounts and drops every card detail', () => {
  const parsed = {
    result: 'Success', serviceId: 'u4oxt4raie', poiid: 'AMS1-000168253677412',
    pspReference: PSP, poiTransactionId: TX, authorizedMinor: 797, tipMinor: 72,
    card: { brand: 'visa', last4: '3814', authCode: '091258', aid: 'A000', applicationName: 'VISA', cvm: 'x', readMethod: 'CLESS' },
    additional: {
      posAmountGratuityValue: '72', posOriginalAmountValue: '725', posAuthAmountValue: '797',
      cardSummary: '3814', authCode: '091258', cardBin: '412345', shopperEmail: 'a@b.c', expiryDate: '03/2029',
    },
  };
  const e = amountEvidence(parsed);
  assert.deepEqual(e, {
    result: 'Success', authorizedMinor: 797, tipMinor: 72, pspReference: PSP, poiTransactionId: TX,
    additional: { posAmountGratuityValue: '72', posOriginalAmountValue: '725', posAuthAmountValue: '797' },
  });
  const text = JSON.stringify(e);
  for (const leak of ['3814', '091258', '412345', 'a@b.c', '03/2029', 'visa']) assert.ok(!text.includes(leak), leak);
  assert.deepEqual(amountEvidence(null).additional, {});
});

test('jobIdFromMerchantReference: tj-<uuid> only', () => {
  assert.equal(jobIdFromMerchantReference(`tj-${JOB_ID}`), JOB_ID);
  assert.equal(jobIdFromMerchantReference('tj-not-a-uuid'), null);
  assert.equal(jobIdFromMerchantReference(`tabhold-${JOB_ID}`), null);
  assert.equal(jobIdFromMerchantReference(`bkpay-${JOB_ID}-deposit`), null);
  assert.equal(jobIdFromMerchantReference(`tj-${JOB_ID}x`), null);
  assert.equal(jobIdFromMerchantReference(undefined), null);
});

test('money: £, $, € and anything else by code', () => {
  assert.equal(money(797, 'GBP'), '£7.97');
  assert.equal(money(72, 'gbp'), '£0.72');
  assert.equal(money(797, 'USD'), '$7.97');
  assert.equal(money(500, 'EUR'), '€5.00');
  assert.equal(money(1234, 'CAD'), '12.34 CAD');
  assert.equal(money(-72, 'GBP'), '-£0.72');
  assert.equal(money(null), '£0.00');
});

// ── copy ─────────────────────────────────────────────────────────────────────

const noDashes = (s) => assert.ok(!/[–—]/.test(s) && !/ - /.test(s), `dash in: ${s}`);

test('healActivity: the tip, both totals, and the Z report advice only when corrected', () => {
  const a = healActivity({ ref: 'R3618', tipMinor: 72, fromMinor: 725, toMinor: 797, currency: 'GBP', corrected: true });
  assert.equal(a.title, 'Tip added from the card machine: R3618');
  assert.equal(a.severity, 'info');
  for (const bit of ['£0.72', '£7.25', '£7.97', 'Z report']) assert.ok(a.body.includes(bit), bit);
  noDashes(a.title); noDashes(a.body);
  const right = healActivity({ ref: 'R3618', tipMinor: 72, fromMinor: 797, toMinor: 797, currency: 'USD', corrected: false });
  assert.ok(right.body.includes('$0.72') && right.body.includes('$7.97'));
  assert.ok(!right.body.includes('Z report'));
  noDashes(right.body);
});

test('mismatchAlert: both amounts, the reason, where to look, no dashes', () => {
  const a = mismatchAlert({ kind: 'refuse', reason: 'over_cap', ref: 'R3618', reportedMinor: 1300, chargeMinor: 725, currency: 'GBP' });
  assert.equal(a.severity, 'action');
  assert.equal(a.title, 'Card amount differs: R3618');
  for (const bit of ['£13.00', '£7.25', reasonText('over_cap'), 'Payments that need checking']) assert.ok(a.body.includes(bit), bit);
  noDashes(a.title); noDashes(a.body);

  const us = mismatchAlert({ kind: 'wait', ref: null, reportedMinor: 1300, chargeMinor: 1000, currency: 'USD' });
  assert.ok(us.body.includes('$13.00') && us.body.includes('$10.00'));
  assert.ok(us.body.includes('Adyen has not confirmed this payment yet'));
  noDashes(us.body);

  const sale = mismatchAlert({ kind: 'sale_not_corrected', reason: 'refunded', ref: 'R3618', tipMinor: 72, currency: 'GBP' });
  assert.ok(sale.body.includes('£0.72') && sale.body.includes('refunded') && sale.body.includes('R3618'));
  noDashes(sale.title); noDashes(sale.body);

  const never = mismatchAlert({ kind: 'sale_never_recorded', ref: null, tipMinor: 72 });
  assert.ok(never.body.includes('never recorded'));
  noDashes(never.body);

  const amb = mismatchAlert({ kind: 'ambiguous', ref: 'R1' });
  assert.ok(amb.body.includes('more than one approved payment'));
  noDashes(amb.body);

  const rev = mismatchAlert({ kind: 'reversed', reason: 'reversed', ref: 'R11232' });
  assert.equal(rev.title, 'Check this card payment: R11232');
  assert.ok(rev.body.includes('refunded or cancelled') && rev.body.includes('Payments that need checking'));
  noDashes(rev.title); noDashes(rev.body);

  const late = mismatchAlert({ kind: 'confirmed_late', ref: 'R3618', reportedMinor: 797, chargeMinor: 725, tipMinor: 72 });
  assert.equal(late.title, 'Card payment confirmed later: R3618');
  for (const bit of ['£7.97', '£7.25', '£0.72 tip', 'Customer was charged and add the £0.72 tip', 'refund one of the two payments', 'not recorded automatically']) {
    assert.ok(late.body.includes(bit), bit);
  }
  noDashes(late.title); noDashes(late.body);
  const plain = mismatchAlert({ kind: 'confirmed_late', ref: null, reportedMinor: 785, chargeMinor: 785, tipMinor: null });
  assert.ok(plain.body.includes('took £7.85.') && !plain.body.includes('tip') && !plain.body.includes('The bill was'));
  noDashes(plain.body);

  // Every machine reason has words, and none of them carries a dash.
  for (const r of ['over_cap', 'not_asked', 'manual_capture', 'psp_mismatch', 'not_success', 'event_code', 'auth_amount_differs',
    'currency', 'text_differs_from_ledger', 'not_a_tip', 'tip_already_set', 'charge_not_due', 'ambiguous_ledger', 'wiring_fault',
    'no_ledger_row', 'write_refused', 'sale_never_recorded', 'no_matching_tender', 'refunded', 'voided', 'not_paid',
    'amount_differs', 'check_has_more_tip', 'ambiguous_final_leg', 'no_tip_on_job', 'reversed', 'unverified']) {
    const t = reasonText(r);
    assert.ok(t && !t.includes('_'), r);
    noDashes(t);
  }
});
