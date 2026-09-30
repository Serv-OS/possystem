/**
 * closedCheckTip.test.js - adding a tip to a sale that is already booked
 * (supabase/functions/_shared/closedCheckTip.js, v5.11.16).
 *
 * Two things are pinned here:
 *   1. the reader tip heal corrects R3618 exactly as the investigation's hand
 *      correction said (tip 0 to 0.72, total 7.25 to 7.97, tender tip 0.72,
 *      tender amount, subtotal and tax untouched), and converges on a replay;
 *   2. PARITY: the tip on receipt callers (legFlag, no tenderRef) get exactly
 *      the patch applyTipToClosedCheck built before v5.11.16. legacyPatch below
 *      is that code, copied from origin/main supabase/functions/_shared/
 *      tip_capture.ts, so the move cannot change a byte of their writes.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { findCardTender, planCheckTipCorrection, closedCheckTipPatch, findFinalLeg } from '../../../supabase/functions/_shared/closedCheckTip.js';
import { tendersTotalMinor } from '../accounting/tenders.js';

const PSP = 'G8837M7KC3TTTQR9';
const TX = `TwkU001790675787051.${PSP}`;
const MARK = '2026-09-30T08:00:00.000Z';

// closed_checks chk-1790675785198-b44c71 (R3618) as booked (read-only SQL, 29 Sep 2026).
const r3618Check = (over = {}) => ({
  id: 'chk-1790675785198-b44c71',
  ref: 'R3618',
  tip: 0,
  total: 7.25,
  subtotal: 7.25,
  tax_amount: 1.21,
  tenders: [{ tip: 0, amount: 7.25, method: 'card', psp_ref: TX, processor: 'adyen' }],
  payment_intents: null,
  status: 'paid',
  voided: false,
  refunds: [],
  ...over,
});

// The job after the heal: tip 72, charge 797.
const healedJob = (over = {}) => ({
  id: '53ae162a-4c8e-4699-a694-3ef53b3ca60e',
  tip_minor: 72,
  charge_minor: 797,
  due_minor: 725,
  transaction_id: TX,
  payment_session_id: PSP,
  check_draft: { source: 'pos_send_to_terminal' },
  ...over,
});

const applyPatch = (check, patch) => ({ ...check, ...patch });

// ── R3618 ────────────────────────────────────────────────────────────────────

test('R3618: the healed job corrects the booked sale by 72p, guarded on its tip and total', () => {
  const plan = planCheckTipCorrection(r3618Check(), healedJob());
  assert.deepEqual(plan, { action: 'apply', deltaMinor: 72, tenderIndex: 0, expect: { tip: 0, total: 7.25 } });

  const r = closedCheckTipPatch(r3618Check(), {
    tipMinor: plan.deltaMinor, captureId: null, psp: TX, tenderRef: { transactionId: TX, psp: PSP }, markAt: MARK,
  });
  assert.equal(r.tenderMatched, true);
  assert.equal(r.legMatched, false, 'R3618 has no payment_intents');
  assert.deepEqual(r.patch, {
    tip: 0.72,
    total: 7.97,
    tenders: [{ tip: 0.72, amount: 7.25, method: 'card', psp_ref: TX, processor: 'adyen', tip_added_at: MARK }],
  });
  const after = applyPatch(r3618Check(), r.patch);
  assert.equal(after.subtotal, 7.25, 'subtotal untouched');
  assert.equal(after.tax_amount, 1.21, 'VAT untouched: a tip is not a sale');
  assert.equal(after.tenders[0].amount, 7.25, 'tender amount untouched');
  assert.equal(tendersTotalMinor(after.tenders), 797, 'tenders now add up to what Adyen took');
  assert.ok(!('payment_intents' in r.patch));
});

test('R3618: re-planning the corrected sale is a no-op (convergent)', () => {
  const plan = planCheckTipCorrection(r3618Check(), healedJob());
  const r = closedCheckTipPatch(r3618Check(), { tipMinor: plan.deltaMinor, captureId: null, psp: TX, tenderRef: TX, markAt: MARK });
  const after = applyPatch(r3618Check(), r.patch);
  // healedBefore: the tender carries the heal's own marker, so a pass whose
  // write landed with its reply lost still knows the sale WAS corrected.
  assert.deepEqual(planCheckTipCorrection(after, healedJob()), { action: 'noop', healedBefore: true, tenderIndex: 0 });
});

test('a sale the till booked from the HEALED job needs nothing, and was never corrected', () => {
  const booked = r3618Check({ tip: 0.72, total: 7.97, tenders: [{ tip: 0.72, amount: 7.25, method: 'card', psp_ref: TX, processor: 'adyen' }] });
  assert.deepEqual(planCheckTipCorrection(booked, healedJob()), { action: 'noop', healedBefore: false, tenderIndex: 0 });
});

test('no sale booked yet is a wait', () => {
  assert.deepEqual(planCheckTipCorrection(null, healedJob()), { action: 'wait', reason: 'no_check' });
});

// ── a PARTIAL pay-at-table leg: its sale is the FINAL leg's check ────────────

const LEG1 = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const LEG2 = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const TX1 = 'POI1.LEG1PSP';
const partialLeg = (over = {}) => healedJob({
  id: LEG1, location_id: 'loc', transaction_id: TX1, payment_session_id: 'LEG1PSP',
  check_draft: { source: 'adyen_pay_at_table', partial: true }, closed_check_id: 'chk-leg1', ...over,
});
const finalLeg = (priorTip, priorCharge, over = {}) => ({
  id: LEG2, location_id: 'loc', status: 'reconciled', closed_check_id: 'chk-final',
  check_draft: { source: 'adyen_pay_at_table', priorLegs: [{ jobId: LEG1, transactionId: TX1, dueMinor: 725, tipMinor: priorTip, chargeMinor: priorCharge }] },
  ...over,
});
// closeApprovedTerminalJob's split check: this leg's tender, then each prior leg as
// tender('card', (chargeMinor - tipMinor)/100, tipMinor/100, psp_ref transactionId).
const finalCheck = (priorTip) => ({
  id: 'chk-final', ref: 'R9001', status: 'paid', voided: false, refunds: [],
  tip: priorTip / 100, total: 7.25 + 5 + priorTip / 100,
  tenders: [{ method: 'card', amount: 5, tip: 0, psp_ref: 'POI2.LEG2PSP' }, { method: 'card', amount: 7.25, tip: priorTip / 100, psp_ref: TX1 }],
  payment_intents: [{ id: 'POI2.LEG2PSP', amountMinor: 500 }, { id: TX1, amountMinor: 725 + priorTip }],
});

test('findFinalLeg: the final leg whose priorLegs name this leg; none yet is a wait; two is refused', () => {
  assert.deepEqual(findFinalLeg(partialLeg(), [partialLeg(), finalLeg(0, 725)]), { action: 'use', finalJob: finalLeg(0, 725) });
  assert.deepEqual(findFinalLeg(partialLeg(), [partialLeg()]), { action: 'wait', reason: 'final_leg_not_booked' });
  assert.deepEqual(findFinalLeg(partialLeg(), null), { action: 'wait', reason: 'final_leg_not_booked' });
  // Still charging, or no check id: not booked yet.
  assert.equal(findFinalLeg(partialLeg(), [finalLeg(0, 725, { status: 'charging' })]).action, 'wait');
  assert.equal(findFinalLeg(partialLeg(), [finalLeg(0, 725, { closed_check_id: null })]).action, 'wait');
  // Another partial leg, another venue, a final leg for a different party: never this leg's sale.
  assert.equal(findFinalLeg(partialLeg(), [finalLeg(0, 725, { check_draft: { partial: true, priorLegs: [{ jobId: LEG1 }] } })]).action, 'wait');
  assert.equal(findFinalLeg(partialLeg(), [finalLeg(0, 725, { location_id: 'other' })]).action, 'wait');
  assert.equal(findFinalLeg(partialLeg(), [finalLeg(0, 725, { check_draft: { priorLegs: [{ jobId: 'someone' }] } })]).action, 'wait');
  assert.deepEqual(findFinalLeg(partialLeg(), [finalLeg(0, 725), finalLeg(0, 725, { id: 'third' })]), { action: 'refuse', reason: 'ambiguous_final_leg' });
});

test('a split leg healed BEFORE the final leg started: its snapshot already carries the tip, nothing to add (no double credit)', () => {
  assert.deepEqual(planCheckTipCorrection(finalCheck(72), partialLeg()), { action: 'noop', healedBefore: false, tenderIndex: 1 });
});

test('a split leg healed AFTER the final leg started: the final check gets exactly the missing 72p on that leg', () => {
  const plan = planCheckTipCorrection(finalCheck(0), partialLeg());
  assert.deepEqual(plan, { action: 'apply', deltaMinor: 72, tenderIndex: 1, expect: { tip: 0, total: 12.25 } });
  const r = closedCheckTipPatch(finalCheck(0), { tipMinor: 72, captureId: null, psp: TX1, tenderRef: { transactionId: TX1, psp: 'LEG1PSP' }, markAt: MARK });
  assert.equal(r.patch.tip, 0.72);
  assert.equal(r.patch.total, 12.97);
  assert.equal(r.patch.tenders[0].tip, 0, "the final leg's own tender is untouched");
  assert.equal(r.patch.tenders[1].tip, 0.72);
  assert.deepEqual(r.patch.payment_intents, [{ id: 'POI2.LEG2PSP', amountMinor: 500 }, { id: TX1, amountMinor: 797 }]);
});

test('the heal never touches a payment leg that is not the card: a booking deposit keeps its amount', () => {
  const deposit = { id: null, amountMinor: 1000, method: 'booking_deposit' };
  const check = r3618Check({ total: 17.25, payment_intents: [deposit] });
  const r = closedCheckTipPatch(check, { tipMinor: 72, captureId: null, psp: TX, tenderRef: { transactionId: TX, psp: PSP }, markAt: MARK });
  assert.equal(r.legMatched, false);
  assert.ok(!('payment_intents' in r.patch), 'the deposit leg is never written');
  assert.equal(r.patch.tip, 0.72);
  assert.equal(r.patch.total, 17.97);
  assert.equal(r.patch.tenders[0].tip, 0.72);
  // A single leg that is some OTHER payment is not the card either.
  const other = closedCheckTipPatch(r3618Check({ payment_intents: [{ id: 'SOMEONE.ELSE', amountMinor: 725 }] }), { tipMinor: 72, captureId: null, psp: TX, tenderRef: TX, markAt: MARK });
  assert.equal(other.legMatched, false);
  // Tip on receipt (legFlag) keeps its single leg fallback: parity below.
  assert.equal(closedCheckTipPatch(check, { tipMinor: 72, captureId: 'cap', psp: null, legFlag: 'captured' }).legMatched, true);
});

test('refunded, voided, not paid, a different amount, more tip already: refused', () => {
  const refuse = (check, reason, job = healedJob()) => assert.deepEqual(planCheckTipCorrection(check, job), { action: 'refuse', reason }, reason);
  refuse(r3618Check({ refunds: [{ amount: 1 }] }), 'refunded');
  refuse(r3618Check({ status: 'refunded', refunds: [{ amount: 7.25 }] }), 'not_paid');
  refuse(r3618Check({ voided: true }), 'voided');
  refuse(r3618Check({ tenders: [{ tip: 0, amount: 7.00, method: 'card', psp_ref: TX }] }), 'amount_differs');
  refuse(r3618Check({ tip: 1, total: 8.25, tenders: [{ tip: 1, amount: 7.25, method: 'card', psp_ref: TX }] }), 'check_has_more_tip');
  refuse(r3618Check(), 'no_tip_on_job', healedJob({ tip_minor: null }));
  refuse(r3618Check({ tenders: [{ tip: 0, amount: 7.25, method: 'cash' }] }), 'no_matching_tender');
  // refunds null (older rows) is not a refund.
  assert.equal(planCheckTipCorrection(r3618Check({ refunds: null }), healedJob()).action, 'apply');
});

// ── tender matching ──────────────────────────────────────────────────────────

test('findCardTender: exact transaction id, psp suffix, a single unlabelled card', () => {
  const gift = { method: 'gift_card', amount: 2, tip: 0, gift_card_id: 'g1' };
  assert.deepEqual(findCardTender({ tenders: [gift, { method: 'card', amount: 7.25, tip: 0, psp_ref: TX }] }, { transactionId: TX, psp: PSP }), { ok: true, index: 1 });
  assert.deepEqual(findCardTender({ tenders: [{ method: 'card', amount: 7.25, tip: 0, psp_ref: `OTHERPOI.${PSP}` }] }, { transactionId: TX, psp: PSP }), { ok: true, index: 0 });
  assert.deepEqual(findCardTender({ tenders: [{ method: 'card', amount: 7.25, tip: 0, psp_ref: PSP }] }, { transactionId: TX, psp: PSP }), { ok: true, index: 0 });
  assert.deepEqual(findCardTender({ tenders: [gift, { method: 'card', amount: 7.25, tip: 0 }] }, { transactionId: TX, psp: PSP }), { ok: true, index: 1 });
  assert.deepEqual(findCardTender({ tenders: [{ method: 'Card', amount: 7.25, tip: 0 }] }, { transactionId: TX }), { ok: true, index: 0 });
});

test('findCardTender: anything ambiguous or labelled for another payment is refused', () => {
  const two = [{ method: 'card', amount: 3, tip: 0 }, { method: 'card', amount: 4.25, tip: 0 }];
  assert.deepEqual(findCardTender({ tenders: two }, { transactionId: TX, psp: PSP }), { ok: false, reason: 'no_matching_tender' });
  const dup = [{ method: 'card', amount: 3, tip: 0, psp_ref: TX }, { method: 'card', amount: 4.25, tip: 0, psp_ref: TX }];
  assert.deepEqual(findCardTender({ tenders: dup }, { transactionId: TX }), { ok: false, reason: 'no_matching_tender' });
  const other = [{ method: 'card', amount: 7.25, tip: 0, psp_ref: 'SOMEONE.ELSE' }];
  assert.deepEqual(findCardTender({ tenders: other }, { transactionId: TX, psp: PSP }), { ok: false, reason: 'no_matching_tender' });
  assert.deepEqual(findCardTender({ tenders: null }, { transactionId: TX }), { ok: false, reason: 'no_matching_tender' });
  // A split check: prior reader leg plus this leg, each with its own reference.
  const split = [{ method: 'card', amount: 10, tip: 1, psp_ref: 'POI.PRIOR' }, { method: 'card', amount: 7.25, tip: 0, psp_ref: TX }];
  assert.deepEqual(findCardTender({ tenders: split }, { transactionId: TX, psp: PSP }), { ok: true, index: 1 });
});

test('a payment_intents leg with the transaction id gets amountMinor += delta and NO capture flag', () => {
  const check = r3618Check({ payment_intents: [{ id: TX, amountMinor: 725, card: { brand: 'visa' } }] });
  const r = closedCheckTipPatch(check, { tipMinor: 72, captureId: null, psp: TX, tenderRef: TX, markAt: MARK });
  assert.equal(r.legMatched, true);
  assert.deepEqual(r.patch.payment_intents, [{ id: TX, amountMinor: 797, card: { brand: 'visa' } }]);
  assert.ok(!('capture' in r.patch.payment_intents[0]), 'the heal never opens a tip window in History');
  assert.ok(!('captureId' in r.patch.payment_intents[0]));
});

test('a tenderRef that matches nothing writes nothing at all', () => {
  const r = closedCheckTipPatch(r3618Check({ tenders: [{ method: 'cash', amount: 7.25, tip: 0 }] }), { tipMinor: 72, captureId: null, psp: TX, tenderRef: TX, markAt: MARK });
  assert.equal(r.patch, null);
  assert.equal(r.reason, 'no_matching_tender');
});

test('float maths stays on the penny', () => {
  const a = closedCheckTipPatch({ tip: 0.1, total: 0.2, tenders: [{ method: 'card', amount: 0.1, tip: 0.1 }] }, { tipMinor: 20, tenderRef: 'x', markAt: MARK });
  assert.equal(a.patch.tip, 0.3);
  assert.equal(a.patch.total, 0.4);
  assert.equal(a.patch.tenders[0].tip, 0.3);
  const b = closedCheckTipPatch({ tip: '12.34', total: '98765.43', payment_intents: null }, { tipMinor: 1, captureId: 'c', psp: null, legFlag: 'captured' });
  assert.equal(b.patch.tip, 12.35);
  assert.equal(b.patch.total, 98765.44);
  // numeric columns arrive as strings over some paths: 0 + 0.72 still 0.72
  const c = planCheckTipCorrection(r3618Check({ tip: '0', total: '7.25', tenders: [{ tip: '0', amount: '7.25', method: 'card', psp_ref: TX }] }), healedJob());
  assert.deepEqual(c, { action: 'apply', deltaMinor: 72, tenderIndex: 0, expect: { tip: '0', total: '7.25' } });
});

// ── PARITY with the pre v5.11.16 writer ──────────────────────────────────────

// The body of applyTipToClosedCheck on origin/main before v5.11.16, verbatim
// apart from returning the patch instead of writing it.
function legacyPatch(check, o) {
  const tipPounds = o.tipMinor / 100;
  const patch = {};
  if (o.tipMinor !== 0) {
    patch.tip = +((Number(check.tip) || 0) + tipPounds).toFixed(2);
    patch.total = +((Number(check.total) || 0) + tipPounds).toFixed(2);
  }
  const legs = Array.isArray(check.payment_intents) ? check.payment_intents : [];
  let matched = false;
  const next = legs.map((leg) => {
    if (matched || !leg || typeof leg !== 'object') return leg;
    const hit = (leg.captureId && leg.captureId === o.captureId)
      || (o.psp && leg.id && leg.id === o.psp)
      || (legs.length === 1);
    if (!hit) return leg;
    matched = true;
    const out = { ...leg, capture: o.legFlag, captureId: leg.captureId ?? o.captureId };
    if (o.tipMinor !== 0 && Number.isFinite(Number(leg.amountMinor))) {
      out.amountMinor = Number(leg.amountMinor) + o.tipMinor;
    }
    if (o.tipError) out.tipError = o.tipError; else delete out.tipError;
    return out;
  });
  if (matched) patch.payment_intents = next;
  else if (o.tipMinor === 0) return null;
  return patch;
}

const legA = { id: 'PSP_A', amountMinor: 2000, capture: 'pending', captureId: 'cap-a' };
const legB = { id: 'PSP_B', amountMinor: 1500, capture: 'pending', captureId: 'cap-b', tipError: 'old' };
const shapes = [
  ['captureId match', { tip: 1, total: 36, payment_intents: [legA, legB], tenders: [{ method: 'card', amount: 35, tip: 1 }] }, { closedCheckId: 'c', captureId: 'cap-b', psp: 'nope', tipMinor: 300, legFlag: 'captured' }],
  ['psp match', { tip: 0, total: 35, payment_intents: [legA, { id: 'PSP_B', amountMinor: 1500 }] }, { closedCheckId: 'c', captureId: 'cap-x', psp: 'PSP_B', tipMinor: 250, legFlag: 'capturing' }],
  ['single leg', { tip: 0, total: 20, payment_intents: [{ id: 'other', amountMinor: 2000 }] }, { closedCheckId: 'c', captureId: 'cap-z', psp: null, tipMinor: 400, legFlag: 'adjusting' }],
  ['tip 0 flag only', { tip: 2, total: 22, payment_intents: [legA] }, { closedCheckId: 'c', captureId: 'cap-a', psp: 'PSP_A', tipMinor: 0, legFlag: 'captured' }],
  ['tip 0 nothing matched', { tip: 2, total: 22, payment_intents: [legA, legB] }, { closedCheckId: 'c', captureId: 'none', psp: 'none', tipMinor: 0, legFlag: 'captured' }],
  ['tipError set', { tip: 0, total: 20, payment_intents: [legA] }, { closedCheckId: 'c', captureId: 'cap-a', psp: null, tipMinor: 0, legFlag: 'failed', tipError: 'Refused by issuer' }],
  ['tipError cleared', { tip: 0, total: 15, payment_intents: [legB] }, { closedCheckId: 'c', captureId: 'cap-b', psp: null, tipMinor: 100, legFlag: 'captured', tipError: null }],
  ['revert (negative)', { tip: 3, total: 38, payment_intents: [{ ...legA, amountMinor: 2300 }] }, { closedCheckId: 'c', captureId: 'cap-a', psp: null, tipMinor: -300, legFlag: 'failed', tipError: 'capture failed' }],
  ['no legs, tip moves', { tip: 0, total: 10, payment_intents: null, tenders: [{ method: 'card', amount: 10, tip: 0 }] }, { closedCheckId: 'c', captureId: 'cap-q', psp: 'P', tipMinor: 150, legFlag: 'captured' }],
  ['leg without amountMinor', { tip: 0, total: 10, payment_intents: [{ id: 'P', captureId: 'cap-p' }] }, { closedCheckId: 'c', captureId: 'cap-p', psp: 'P', tipMinor: 150, legFlag: 'captured' }],
];

for (const [name, check, o] of shapes) {
  test(`parity: ${name}`, () => {
    const legacy = legacyPatch(structuredClone(check), o);
    const now = closedCheckTipPatch(structuredClone(check), o);
    assert.deepEqual(now.patch, legacy);
    if (now.patch) assert.ok(!('tenders' in now.patch), 'tip on receipt never touches tenders');
  });
}

test('parity: every tip on receipt caller still passes legFlag and no tenderRef or expect', () => {
  for (const fn of ['adyen-webhook', 'adyen-modify', 'adyen-capture-sweep']) {
    const src = readFileSync(new URL(`../../../supabase/functions/${fn}/index.ts`, import.meta.url), 'utf8');
    const calls = src.split('applyTipToClosedCheck(').slice(1).map((c) => c.slice(0, c.indexOf('});')));
    assert.ok(calls.length >= 5, `${fn}: ${calls.length} calls`);
    for (const c of calls) {
      assert.match(c, /legFlag:/, `${fn} call without legFlag`);
      assert.ok(!/tenderRef|expect:/.test(c), `${fn} call opted into the heal's options`);
    }
  }
});

test('the writer keeps the old query and write for those callers', () => {
  const src = readFileSync(new URL('../../../supabase/functions/_shared/tip_capture.ts', import.meta.url), 'utf8');
  assert.match(src, /import \{ closedCheckTipPatch \} from '\.\/closedCheckTip\.js'/);
  assert.match(src, /o\.tenderRef \? 'id, tip, total, payment_intents, tenders' : 'id, tip, total, payment_intents'/);
  // compare-and-set only when asked for
  assert.match(src, /if \(o\.expect\) \{/);
});
