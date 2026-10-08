// src/lib/orderNextStep.test.js
//
// "in orders hub some orders are just saying advance rather than mark as ready, collected etc"
// (Peter, 2 Oct 2026).
//
// The pay now QR card on the Orders screen had a button with the fixed words "Advance →" since
// v5.5.159. It said the same thing at every status, and it was still there on a finished order,
// where the press did nothing. The same order read "Mark ready →" on every other view.
//
// The rules under test:
//   - the words come from the status of the row the press acts on, in the words every other card uses;
//   - when the press would do nothing there is no step, so the card shows no button;
//   - the last step follows the money, exactly as advance() does: a payment being checked is
//     checked, money still owed is charged, only a paid order is marked collected;
//   - an open tab has no step here (Close and charge, Release hold are its buttons).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { NEXT_STEP_LABEL, nextStepLabel, orderNextStep, qrCardNextStep } from './orderNextStep.js';

const HUB = readFileSync(new URL('../surfaces/OrdersHub.jsx', import.meta.url), 'utf8');
const pounds = (n) => `£${n.toFixed(2)}`;

// The rows as the Orders screen holds them (_kind 'queue'). QR-FAUOB is Peter's Leeds order.
const QR_FAUOB = { _kind: 'queue', ref: 'QR-FAUOB', source: 'qr', status: 'prep', paid: true, total: 5.6, customer: { tableId: 'T6', tableLabel: 'T6', name: 'Petwr' } };
const at = (status, extra = {}) => ({ ...QR_FAUOB, status, ...extra });
const checking = (status) => at(status, { paid: false, customer: { ...QR_FAUOB.customer, payment_state: 'checking', payment_unverified: true } });
const unpaid = (status) => at(status, { paid: false });
const card = (...rows) => ({ key: `paynow:${rows[0]?.ref}`, isOpenTab: false, rows, firstRow: rows[0] });

test('the words are the ones every other card uses', () => {
  assert.deepEqual({ ...NEXT_STEP_LABEL }, { received: 'Mark in prep →', prep: 'Mark ready →', ready: 'Mark collected →' });
  assert.equal(nextStepLabel('received'), 'Mark in prep →');
  assert.equal(nextStepLabel('prep'), 'Mark ready →');
  assert.equal(nextStepLabel('ready'), 'Mark collected →');
});

test('a status with no next step has no words', () => {
  for (const s of ['collected', 'paid', 'cancelled', 'preparing', 'accepted', 'scheduled', 'active', '', 'constructor', '__proto__']) {
    assert.equal(nextStepLabel(s), null, s);
  }
  assert.equal(nextStepLabel(undefined), null);
  assert.equal(nextStepLabel(null), null);
  assert.equal(nextStepLabel(3), null);
});

test('Peter s order: a paid QR order in prep reads "Mark ready", and the press acts on that row', () => {
  const step = qrCardNextStep(card(QR_FAUOB));
  assert.equal(step.label, 'Mark ready →');
  assert.equal(step.kind, 'advance');
  assert.equal(step.row, QR_FAUOB, 'the very row the words came from');
});

test('each status, paid: received, prep, ready', () => {
  assert.equal(qrCardNextStep(card(at('received'))).label, 'Mark in prep →');
  assert.equal(qrCardNextStep(card(at('prep'))).label, 'Mark ready →');
  const ready = qrCardNextStep(card(at('ready')));
  assert.equal(ready.label, 'Mark collected →');
  assert.equal(ready.kind, 'advance');
});

test('a finished or unknown order has no step, so no button', () => {
  for (const s of ['collected', 'paid', 'cancelled', 'preparing', 'accepted', 'scheduled', undefined, null]) {
    assert.equal(qrCardNextStep(card(at(s))), null, String(s));
  }
});

test('ready with the payment being checked: the press checks it, never collects it', () => {
  const row = checking('ready');
  const step = qrCardNextStep(card(row));
  assert.deepEqual(step, { row, kind: 'check', label: 'Check payment →' });
  // before ready the kitchen steps are plain steps, checked or not
  assert.equal(qrCardNextStep(card(checking('received'))).label, 'Mark in prep →');
  assert.equal(qrCardNextStep(card(checking('prep'))).label, 'Mark ready →');
  assert.equal(qrCardNextStep(card(checking('prep'))).kind, 'advance');
});

test('ready with money still owed: the press charges it, never collects it', () => {
  const row = unpaid('ready');
  assert.deepEqual(qrCardNextStep(card(row), { formatMoney: pounds }), { row, kind: 'charge', label: 'Charge £5.60 →' });
  assert.equal(qrCardNextStep(card(unpaid('ready'))).label, 'Charge 5.60 →', 'plain number without a formatter');
  assert.equal(qrCardNextStep(card(at('ready', { paid: false, total: undefined })), { formatMoney: pounds }).label, 'Charge £0.00 →');
  assert.equal(qrCardNextStep(card(unpaid('prep'))).label, 'Mark ready →', 'owing money does not stop the kitchen');
});

test('the caller s own paid and checking tests decide the last step', () => {
  // the Orders screen counts a prepaid channel (ezCater) as paid even with no paid flag
  const row = unpaid('ready');
  assert.equal(qrCardNextStep(card(row), { isPaid: () => true }).label, 'Mark collected →');
  assert.equal(qrCardNextStep(card(at('ready')), { isChecking: () => true }).kind, 'check');
  assert.equal(qrCardNextStep(card(at('ready')), { isPaid: () => false, isChecking: () => false, formatMoney: pounds }).label, 'Charge £5.60 →');
});

test('only a queue order has a step (a table or bar tab card never did)', () => {
  assert.equal(orderNextStep({ ...QR_FAUOB, _kind: 'table' }), null);
  assert.equal(orderNextStep({ ...QR_FAUOB, _kind: 'tab' }), null);
  assert.equal(orderNextStep({ ref: 'QR-1', status: 'prep', paid: true }), null, 'a raw row is not an Orders screen row');
  assert.equal(orderNextStep(null), null);
  assert.equal(orderNextStep(undefined), null);
  assert.equal(orderNextStep('prep'), null);
});

test('missing rows: no card, no rows, no first row', () => {
  assert.equal(qrCardNextStep(null), null);
  assert.equal(qrCardNextStep(undefined), null);
  assert.equal(qrCardNextStep({}), null);
  assert.equal(qrCardNextStep({ isOpenTab: false, rows: [], firstRow: null }), null);
  assert.equal(qrCardNextStep({ isOpenTab: false, rows: null }), null);
  // a card with rows but no firstRow: its first row is the card
  const row = at('ready');
  assert.equal(qrCardNextStep({ isOpenTab: false, rows: [row] }).row, row);
});

test('an open tab has no step here, whatever its rounds say', () => {
  const tab = { key: 'pi_tab', isOpenTab: true, rows: [at('prep'), at('ready')], firstRow: at('prep') };
  assert.equal(qrCardNextStep(tab), null, 'its buttons are Close and charge, Release hold');
});

test('several rounds in mixed statuses: the first row decides, words and press together', () => {
  // A pay now card is keyed by its ref, so it only ever holds one row. Should one ever hold more,
  // the words must still be about the row the press acts on, never about a later round.
  const first = at('prep'), later = at('ready', { ref: 'QR-LATER' });
  const step = qrCardNextStep(card(first, later));
  assert.equal(step.label, 'Mark ready →');
  assert.equal(step.row, first);
  const second = qrCardNextStep(card(at('ready'), at('received', { ref: 'QR-LATER' }), at('collected', { ref: 'QR-DONE' })));
  assert.equal(second.label, 'Mark collected →');
  // first round finished, a later one not: no words about a press that would do nothing
  assert.equal(qrCardNextStep(card(at('collected'), at('prep', { ref: 'QR-LATER' }))), null);
});

test('the rule matches advance() on the Orders screen, case by case', () => {
  // advance() as written in OrdersHub.jsx, in plain terms: what one press does to a row.
  const flow = ['received', 'prep', 'ready', 'collected'];
  const press = (o, isPaid, isChecking) => {
    if (o._kind !== 'queue') return null;
    const idx = flow.indexOf(o.status);
    if (idx < 0 || idx >= flow.length - 1) return null;
    const next = flow[idx + 1];
    if (next === 'collected' && isChecking) return 'check';
    if (next === 'collected' && !isPaid) return 'charge';
    return 'advance';
  };
  for (const status of ['received', 'prep', 'ready', 'collected', 'paid', 'cancelled', 'preparing', undefined]) {
    for (const [isPaid, isChecking] of [[true, false], [false, true], [false, false]]) {
      const row = at(status);
      const step = orderNextStep(row, { isPaid: () => isPaid, isChecking: () => isChecking });
      assert.equal(step ? step.kind : null, press(row, isPaid, isChecking), `${status} paid ${isPaid} checking ${isChecking}`);
      if (step && step.kind === 'advance') assert.equal(step.label, NEXT_STEP_LABEL[status]);
    }
  }
  // and advance() still reads the way this test says it does
  assert.ok(HUB.includes("const flow  = ['received', 'prep', 'ready', 'collected'];"));
  assert.ok(HUB.includes("if (o._kind !== 'queue') return;"));
  const check = HUB.indexOf("if (next === 'collected' && isPaymentChecking(o)) {");
  const charge = HUB.indexOf("if (next === 'collected' && !isOrderPaid(o)) {");
  assert.ok(check > 0 && charge > check, 'checking is asked before owing');
});

test('the Orders screen: the QR card says what its button does, from this rule', () => {
  assert.ok(!HUB.includes('Advance →'), 'the fixed words are gone');
  assert.match(HUB, /import \{ NEXT_STEP_LABEL, qrCardNextStep \} from '\.\.\/lib\/orderNextStep';/);
  const from = HUB.indexOf('function QrTabCard(');
  const to = HUB.indexOf('function Section(');
  assert.ok(from > 0 && to > from);
  const CARD = HUB.slice(from, to);
  // one step: its words on the button, its row in the press, with the screen's own money tests
  assert.ok(CARD.includes('const step = qrCardNextStep(tab, { isPaid: isOrderPaid, isChecking: isPaymentChecking, formatMoney: money });'));
  assert.ok(CARD.includes("{step && step.kind !== 'check' && ("), 'no step, no button; a payment being checked keeps its own Check payment button');
  assert.ok(CARD.includes('<button onClick={() => onAdvance(step.row)}'));
  assert.ok(CARD.includes('{step.label}'));
  // ready with its payment being checked has ONE button, Check payment: it must stay on the card
  assert.ok(CARD.includes('{paymentChecking && onCheckPayment && ('));
  assert.ok(HUB.includes('paymentChecking={!t.isOpenTab && t.rows.some(isPaymentChecking)}'));
  assert.ok(HUB.includes('onCheckPayment={() => { const r = t.rows.find(isPaymentChecking); if (r) setPaymentCheckOrder(r); }}'));
  // the longer words never break inside a button: a narrow pay now card wraps the row instead
  assert.ok(CARD.includes("flexWrap: tab.isOpenTab ? 'nowrap' : 'wrap'"));
  assert.equal(CARD.split("fontSize:12, fontWeight:800, whiteSpace:'nowrap',").length - 1, 2, 'both pay now buttons');
  assert.ok(HUB.includes('onAdvance={(row) => advance(row)}'), 'the press advances the row the card hands it');
  assert.ok(!HUB.includes('advance(t.firstRow)'), 'no second place that picks the row');
  // the other cards read the same words
  assert.ok(HUB.includes('const NEXT = NEXT_STEP_LABEL;'));
  assert.ok(!HUB.includes("const NEXT = { received:'Mark in prep →'"));
});
