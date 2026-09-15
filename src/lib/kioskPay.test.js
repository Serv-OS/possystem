// New kiosk design card screen rules (lib/kioskPay.js). The card screen is today's
// ScreenPay; these rules only decide what the customer sees and which of ScreenPay's own
// handlers a button may call. The key promise: once a charge might exist, no button can
// start a second one.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  kioskCardPhase, nextReachedReader, kioskCardCopy, kioskStaffReference, kioskStaffAlert,
  nextCardIncident, kioskIncidentTime, kioskPayTotal,
} from './kioskPay.js';

const actionIds = (phase, cause) => kioskCardCopy(phase, cause).actions.map(a => a.id);

test('kioskCardPhase: the reader states map to the customer phases', () => {
  assert.deepEqual(kioskCardPhase({ cardState: 'idle', total: 12 }), { phase: 'connecting', cause: null });
  assert.deepEqual(kioskCardPhase({ cardState: 'processing', total: 12 }), { phase: 'connecting', cause: null });
  assert.deepEqual(kioskCardPhase({ cardState: 'collecting', total: 12 }), { phase: 'waiting', cause: null });
  assert.deepEqual(kioskCardPhase({ cardState: 'success', total: 12 }), { phase: 'saving', cause: null });
  assert.deepEqual(kioskCardPhase({ cardState: 'success', total: 12, submitting: true }), { phase: 'saving', cause: null });
  assert.deepEqual(kioskCardPhase({ cardState: 'declined', total: 12 }), { phase: 'declined', cause: null });
});

test('kioskCardPhase: an error asks for staff, and whether the reader was reached decides the cause', () => {
  assert.deepEqual(kioskCardPhase({ cardState: 'error', total: 12, reachedReader: false }), { phase: 'askStaff', cause: 'unreachable' });
  assert.deepEqual(kioskCardPhase({ cardState: 'error', total: 12, reachedReader: true }), { phase: 'askStaff', cause: 'unconfirmed' });
});

test('kioskCardPhase: a charge that went through but did not save asks for staff', () => {
  assert.deepEqual(
    kioskCardPhase({ cardState: 'success', total: 12, submitError: 'insert failed' }),
    { phase: 'askStaff', cause: 'notSaved' },
  );
});

test('kioskCardPhase: nothing to charge is covered, then saving, then staff when the save fails', () => {
  assert.deepEqual(kioskCardPhase({ cardState: 'idle', total: 0 }), { phase: 'covered', cause: null });
  assert.deepEqual(kioskCardPhase({ cardState: 'idle', total: -1 }), { phase: 'covered', cause: null });
  assert.deepEqual(kioskCardPhase({ cardState: 'idle', total: 0, submitting: true }), { phase: 'saving', cause: 'covered' });
  // Nothing was charged, so the saving screen never says "Payment approved".
  assert.equal(kioskCardCopy('saving', 'covered').titleKey, 'k2.card.saving');
  assert.equal(kioskCardCopy('saving').titleKey, 'k2.card.approved');
  assert.deepEqual(kioskCardPhase({ cardState: 'idle', total: 0, submitError: 'boom' }), { phase: 'askStaff', cause: 'notSaved' });
  // A missing or junk total is never charged.
  assert.equal(kioskCardPhase({ cardState: 'idle', total: 'x' }).phase, 'covered');
});

test('kioskCardPhase: a total that reads 0 while a charge exists is never covered (no Place order, no Back)', () => {
  // The Pay race: the reader is live for the review total, then a late code makes grandTotal 0.
  assert.deepEqual(kioskCardPhase({ cardState: 'processing', total: 0 }), { phase: 'connecting', cause: null });
  assert.deepEqual(kioskCardPhase({ cardState: 'collecting', total: 0, reachedReader: true }), { phase: 'waiting', cause: null });
  assert.deepEqual(kioskCardPhase({ cardState: 'success', total: 0, submitting: true }), { phase: 'saving', cause: null });
  assert.deepEqual(kioskCardPhase({ cardState: 'success', total: 0, submitError: 'x' }), { phase: 'askStaff', cause: 'notSaved' });
  assert.deepEqual(kioskCardPhase({ cardState: 'error', total: 0, reachedReader: true }), { phase: 'askStaff', cause: 'unconfirmed' });
  assert.deepEqual(kioskCardPhase({ cardState: 'declined', total: 0 }), { phase: 'declined', cause: null });
  // Every state x total x saving x error: while the reader is live no Place order and no Back.
  for (const cardState of ['idle', 'processing', 'collecting', 'success', 'error', 'declined']) {
    for (const total of [0, -1, 12.5]) for (const submitting of [false, true]) for (const submitError of [null, 'x']) for (const reachedReader of [false, true]) {
      const { phase, cause } = kioskCardPhase({ cardState, total, submitting, submitError, reachedReader });
      const copy = kioskCardCopy(phase, cause);
      const ids = copy.actions.map(a => a.id);
      if (cardState !== 'idle') assert.ok(!ids.includes('placeOrder'), `${cardState} ${total}: no Place order once a charge exists`);
      if (cardState === 'processing' || cardState === 'collecting') {
        assert.ok(!ids.includes('back') && !copy.showBack, `${cardState} ${total}: no Back while the reader is live`);
      }
    }
  }
});

test('kioskPayTotal: the card screen amount is fixed when it opens and freed when it closes', () => {
  let fixed = null;
  fixed = kioskPayTotal(fixed, false, 18.05);
  assert.equal(fixed, null);                          // Review and pay: nothing fixed
  fixed = kioskPayTotal(fixed, true, 18.05);
  assert.equal(fixed, 18.05);                         // the card screen opens at the review total
  fixed = kioskPayTotal(fixed, true, 0);
  assert.equal(fixed, 18.05);                         // a late change cannot move it (or make it covered)
  fixed = kioskPayTotal(fixed, false, 0);
  assert.equal(fixed, null);                          // back to Review and pay
  assert.equal(kioskPayTotal(null, true, 0), 0);      // a covered order opens covered
  assert.equal(kioskPayTotal(null, true, 'x'), 0);
});

test('kioskCardCopy: an error never offers Try again or Back; a decline offers both', () => {
  for (const cause of ['unreachable', 'unconfirmed', 'notSaved']) {
    const copy = kioskCardCopy('askStaff', cause);
    assert.deepEqual(actionIds('askStaff', cause), ['newOrder']);
    assert.equal(copy.showBack, false);
    assert.equal(copy.showCancel, false);
    assert.equal(copy.titleKey, 'k2.card.askStaff');
  }
  assert.equal(kioskCardCopy('askStaff', 'unreachable').subKey, 'k2.card.unreachable');
  assert.equal(kioskCardCopy('askStaff', 'unconfirmed').subKey, 'k2.card.unconfirmed');
  assert.equal(kioskCardCopy('askStaff', 'notSaved').subKey, 'k2.card.notSaved');

  assert.deepEqual(actionIds('declined'), ['retry', 'back']);
  assert.equal(kioskCardCopy('declined').showBack, true);
  assert.equal(kioskCardCopy('declined').showCancel, true);
});

test('kioskCardCopy: the reader and saving phases show no buttons; saving hides Cancel', () => {
  assert.deepEqual(actionIds('connecting'), []);
  assert.deepEqual(actionIds('waiting'), []);
  assert.deepEqual(actionIds('saving'), []);
  // No Cancel while the reader start call is in flight (nothing to cancel yet).
  assert.equal(kioskCardCopy('connecting').showCancel, false);
  assert.equal(kioskCardCopy('waiting').showCancel, true);
  assert.equal(kioskCardCopy('saving').showCancel, false);
  assert.equal(kioskCardCopy('waiting').visual, 'readerPulse');
  assert.deepEqual(actionIds('covered'), ['placeOrder', 'back']);
  // Unknown phases show the connecting copy.
  assert.equal(kioskCardCopy('nope').titleKey, 'k2.card.connecting');
});

test('nextReachedReader: collecting marks the reader reached; a new attempt starts again', () => {
  let r = false;
  for (const s of ['idle', 'processing', 'collecting', 'error']) r = nextReachedReader(r, s);
  assert.equal(r, true);
  // Declined, then Try again, then the reader cannot be reached.
  r = nextReachedReader(true, 'declined');
  assert.equal(r, true);
  for (const s of ['idle', 'processing', 'error']) r = nextReachedReader(r, s);
  assert.equal(r, false);
});

test('kioskStaffReference: from a uuid, another id, or the time', () => {
  assert.equal(kioskStaffReference({ checkId: '3f9a2cde-1111-4222-8333-444455556666' }), 'K3F9A2C');
  assert.equal(kioskStaffReference({ checkId: 'cc-1726330000123' }), 'K000123');
  const at = 1726330000123;
  const ref = kioskStaffReference({ checkId: null, now: at });
  assert.match(ref, /^K[0-9A-Z]{6}$/);
  assert.equal(kioskStaffReference({ now: at }), ref);
  assert.match(kioskStaffReference(), /^K0{6}$/);
});

test('kioskStaffAlert: an urgent ops event with the device, amount, reference and cause', () => {
  const a = kioskStaffAlert({ deviceName: 'Front kiosk', amountText: '£12.50', reference: 'K3F9A2C', cause: 'unconfirmed', raw: 'Timed out' });
  assert.equal(a.kind, 'ops');
  assert.equal(a.severity, 'urgent');
  assert.equal(a.title, 'Kiosk payment needs staff');
  assert.equal(a.body, 'Front kiosk · £12.50 · Ref K3F9A2C · unconfirmed: Timed out');
  assert.equal(a.refType, 'kiosk_payment');
  assert.equal(a.refId, 'K3F9A2C');
  assert.equal(kioskStaffAlert({ amountText: '£1.00', reference: 'K1', cause: 'x' }).body, 'Kiosk · £1.00 · Ref K1 · x: no details');
});

test('nextCardIncident: one incident per visit, fixed reference, cleared when the screen closes', () => {
  const report = { phase: 'askStaff', cause: 'unconfirmed', raw: 'Timed out', total: 12.5 };
  const first = nextCardIncident(null, report, { now: 1726330000123, checkId: null });
  assert.equal(first.cause, 'unconfirmed');
  assert.equal(first.total, 12.5);
  assert.equal(first.raw, 'Timed out');
  assert.match(first.reference, /^K[0-9A-Z]{6}$/);
  // The same report later keeps the same object (no second alert).
  assert.equal(nextCardIncident(first, { ...report, raw: 'other' }, { now: 1726330999999 }), first);
  // A different cause keeps the reference and time.
  const moved = nextCardIncident(first, { ...report, cause: 'notSaved' }, { now: 1726330999999 });
  assert.equal(moved.reference, first.reference);
  assert.equal(moved.at, first.at);
  assert.equal(moved.cause, 'notSaved');
  // A check id wins for the reference.
  assert.equal(nextCardIncident(null, report, { now: 5, checkId: '3f9a2cde-1111-4222-8333-444455556666' }).reference, 'K3F9A2C');
  // Any other phase, or the screen closing, clears it.
  assert.equal(nextCardIncident(first, { phase: 'declined' }, { now: 1 }), null);
  assert.equal(nextCardIncident(first, null, { now: 1 }), null);
});

test('kioskIncidentTime: 24 hour time in the venue zone, empty for no time', () => {
  const at = Date.UTC(2026, 8, 14, 13, 5);
  assert.equal(kioskIncidentTime(at, 'Europe/London'), '14:05');
  assert.equal(kioskIncidentTime(at, 'America/New_York'), '09:05');
  assert.match(kioskIncidentTime(at, 'Not/AZone'), /^\d\d:\d\d$/);
  assert.equal(kioskIncidentTime(0, 'Europe/London'), '');
  assert.equal(kioskIncidentTime(null), '');
});
