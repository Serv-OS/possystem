// orderPayment.test.js: "Payment being checked" is a THIRD state on the till (database fence
// stage 1, fix round, docs/FENCE_STAGE_1_APP.md section 11, S3).
//
// The rules under test:
//   - an order the server could not prove yet is neither paid nor unpaid, and is never charged;
//   - a paid flag always wins over an older copy of the customer block;
//   - "Check payment" asks payment-proof then verify_public_order_payment; "Confirm payment"
//     needs a note; both settle the local copy so the badge goes at once;
//   - every place that could charge an order (Orders Hub charge step and pay flow, MPOS, the
//     checkout modal) and the kitchen ticket respect it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  orderPaymentState, isOrderPaid, isPaymentChecking, mayChargeOrder, paymentCheckRequest,
  readPaymentAnswer, checkOrderPayment, confirmOrderPayment, markOrderPaymentSettled,
  PAYMENT_CHECKING_LABEL, PAYMENT_SHORT_LABEL, paymentShortInfo, paymentStatusLabel, paymentShortLine,
  confirmAmountMinor, qrTabShortInfo, qrTabShortLine, shortTabClosedCheck,
} from './orderPayment.js';
import { isMissingRpc } from './deviceFence.js';

const read = (rel) => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const LOC = '7218c716-eeb4-4f96-b284-f3500823595c';

// The order rows place_public_order writes (20260919a): unproven = paid false plus
// customer.payment_state 'checking', payment_ref and payment_processor.
const qrChecking = { ref: 'QR-AB12C', source: 'qr', paid: false, total: 23.5, customer: { name: 'Sam', payment_state: 'checking', payment_unverified: true, payment_ref: 'pi_123', payment_processor: 'stripe' } };
const onlineChecking = { ...qrChecking, ref: 'OL-XY98Z', source: 'online' };
const cateringChecking = { ...qrChecking, ref: 'CA-11AA2', source: 'catering', customer: { ...qrChecking.customer, payment_processor: 'adyen', payment_ref: 'PSP77' } };

test('the three states: paid, checking, unpaid', () => {
  assert.equal(orderPaymentState(qrChecking), 'checking', 'an unverified QR order no longer looks unpaid (it invited a second charge)');
  assert.equal(orderPaymentState(onlineChecking), 'checking', 'an unverified online order no longer looks paid (it never got its closed check)');
  assert.equal(orderPaymentState(cateringChecking), 'checking');
  assert.equal(orderPaymentState({ source: 'online', paid: false, customer: {} }), 'paid', 'online is prepaid by channel (v5.5.659)');
  assert.equal(orderPaymentState({ source: 'kiosk' }), 'paid');
  assert.equal(orderPaymentState({ source: 'catering', paid: false, customer: {} }), 'unpaid', 'catering pay later still owes money');
  assert.equal(orderPaymentState({ source: 'pos', customer: { paid: true } }), 'paid', 'customer.paid survives a reload');
  assert.equal(orderPaymentState({ source: 'hubrise' }), 'unpaid');
  assert.equal(orderPaymentState(null), 'unpaid');
  // Once the server verified it (or staff confirmed), paid wins over any older copy.
  assert.equal(orderPaymentState({ ...qrChecking, paid: true }), 'paid');
  assert.equal(orderPaymentState({ ...qrChecking, customer: { ...qrChecking.customer, paid: true } }), 'paid');
  assert.equal(orderPaymentState({ ...qrChecking, customer: { payment_state: 'verified' } }), 'unpaid', 'a verified QR without a paid flag is a normal QR (never happens: verify sets paid)');
});

test('only a truly unpaid order may be charged', () => {
  assert.equal(mayChargeOrder(qrChecking), false);
  assert.equal(mayChargeOrder(onlineChecking), false);
  assert.equal(mayChargeOrder({ source: 'catering', customer: {} }), true);
  assert.equal(isOrderPaid(qrChecking), false);
  assert.equal(isPaymentChecking(qrChecking), true);
  assert.equal(PAYMENT_CHECKING_LABEL, 'Payment being checked');
});

test('Check payment asks for the card payment the server recorded on the order', () => {
  assert.deepEqual(paymentCheckRequest(qrChecking), { processor: 'stripe', kind: 'card', paymentRef: 'pi_123' });
  assert.deepEqual(paymentCheckRequest(cateringChecking), { processor: 'adyen', kind: 'card', paymentRef: 'PSP77' });
  assert.equal(paymentCheckRequest({ customer: { payment_state: 'checking' } }), null, 'a gift or promo only order: a manager confirms it');
  assert.equal(paymentCheckRequest({ customer: { payment_ref: 'x', payment_processor: 'gift' } }), null);
});

test('Check payment: proof, then verify; an unproven answer never charges anything', async () => {
  const calls = [];
  const rpc = async (name, args) => { calls.push([name, args]); return { data: { ok: true, paid: true, check_id: 'chk-1' }, error: null }; };
  const r = await checkOrderPayment({ requestProof: async (req) => { calls.push(['proof', req]); return { proofId: 'p1' }; }, rpc, locationId: LOC, order: qrChecking, isMissingRpc });
  assert.deepEqual(r, { status: 'paid', checkId: 'chk-1', already: false });
  assert.deepEqual(calls, [
    ['proof', { processor: 'stripe', kind: 'card', paymentRef: 'pi_123' }],
    ['verify_public_order_payment', { p_location_id: LOC, p_ref: 'QR-AB12C', p_proof_ids: ['p1'] }],
  ]);

  const slow = await checkOrderPayment({
    requestProof: async () => ({ failed: true, reason: 'not_seen' }),
    rpc: async () => ({ data: { ok: true, paid: false, due_minor: 2350, proven_minor: 0 }, error: null }),
    locationId: LOC, order: qrChecking, isMissingRpc,
  });
  assert.equal(slow.status, 'unproven');
  assert.match(slow.message, /manager can confirm/);

  const thrown = await checkOrderPayment({ requestProof: async () => { throw new Error('offline'); }, rpc: async () => ({ data: { ok: true, paid: true }, error: null }), locationId: LOC, order: qrChecking, isMissingRpc });
  assert.equal(thrown.status, 'paid', 'the server may already hold a proof for the payment the check names');
});

test('verify and confirm answers in plain words', () => {
  assert.equal(readPaymentAnswer({ data: { ok: false, reason: 'no_check' } }).status, 'no_check');
  assert.equal(readPaymentAnswer({ data: { ok: false, reason: 'not_found' } }).status, 'not_found');
  assert.equal(readPaymentAnswer({ data: { ok: true, paid: true, already: true } }).already, true);
  assert.equal(readPaymentAnswer({ error: { code: 'PGRST202', message: 'Could not find the function' } }, { isMissingRpc }).status, 'unsupported');
  assert.equal(readPaymentAnswer({ error: { code: '42501', message: 'Only staff of this venue can confirm a payment' } }, { isMissingRpc }).status, 'error');
});

test('Confirm payment (manager) needs a note and calls confirm_public_order_payment', async () => {
  const calls = [];
  const rpc = async (name, args) => { calls.push([name, args]); return { data: { ok: true, paid: true, check_id: 'chk-2' }, error: null }; };
  const none = await confirmOrderPayment({ rpc, locationId: LOC, order: qrChecking, note: '  ' });
  assert.equal(none.status, 'error');
  assert.equal(calls.length, 0, 'nothing is confirmed without saying what was checked');
  const ok = await confirmOrderPayment({ rpc, locationId: LOC, order: qrChecking, note: 'seen in Stripe (manager: Jo)' });
  assert.equal(ok.status, 'paid');
  assert.deepEqual(calls[0], ['confirm_public_order_payment', { p_location_id: LOC, p_ref: 'QR-AB12C', p_note: 'seen in Stripe (manager: Jo)' }]);
});

test('the local copy settles at once (paid, and no longer checking)', () => {
  const v = markOrderPaymentSettled(qrChecking);
  assert.equal(v.paid, true);
  assert.equal(v.customer.payment_state, 'verified');
  assert.equal('payment_unverified' in v.customer, false);
  assert.equal(orderPaymentState(v), 'paid');
  assert.equal(markOrderPaymentSettled(qrChecking, { byStaff: true }).customer.payment_state, 'confirmed_by_staff');
  assert.equal(qrChecking.customer.payment_state, 'checking', 'the original is not mutated');
});

test('Orders Hub: a payment being checked is never charged, opens read-only, and shows the badge', () => {
  const src = read('../surfaces/OrdersHub.jsx');
  // v5.9.9 sits beside it: an ezCater order was paid through ezCater, so it is paid here too.
  assert.ok(src.includes("const isOrderPaid = (o) => orderPaymentState(o) === 'paid' || isPrepaidByChannel(o);"));
  assert.ok(src.includes("const isPaymentChecking = (o) => !isPrepaidByChannel(o) && orderPaymentState(o) === 'checking';"));
  const adv = src.indexOf("if (next === 'collected' && isPaymentChecking(o)) {");
  const charge = src.indexOf("if (next === 'collected' && !isOrderPaid(o)) {");
  assert.ok(adv > 0 && charge > adv, 'the checking branch runs before the "take payment" branch');
  assert.ok(src.slice(adv, charge).includes('setPaymentCheckOrder(o);') && !src.slice(adv, charge).includes('openOrder(o)'), 'it opens Check payment, never the pay flow');
  assert.ok(src.includes("['online', 'kiosk'].includes(o.source) || isPrepaidByChannel(o) || isPaymentChecking(o)) { setViewOrder(o); }"), 'opening it is read-only');
  assert.ok(src.includes("if (order.status === 'ready' && isPaymentChecking(order)) {"), 'no Charge button on the card');
  assert.ok(src.includes('<PaymentCheckModal'));
  assert.ok(src.includes('paymentChecking={!t.isOpenTab && t.rows.some(isPaymentChecking)}'), 'a QR pay now card no longer says PAID while it is being checked');
});

test('MPOS, the checkout modal and the kitchen ticket respect "being checked"', () => {
  const m = read('../surfaces/mpos/MQueueDetail.jsx');
  assert.ok(m.includes("if (next === 'collected' && checking) {"));
  const c = read('../surfaces/CheckoutModal.jsx');
  assert.ok(c.includes("customer?.payment_state === 'checking' || customer?.payment_unverified === true"), 'any path that loads it into checkout closes again');
  const store = read('../store/index.js');
  assert.ok(store.includes("paymentChecking: (order.customer?.payment_state === 'checking' || order.customer?.payment_unverified === true) && order.paid !== true,"));
  assert.ok(read('./printDoc.js').includes("delivery.paymentChecking ? 'PAYMENT BEING CHECKED, DO NOT CHARGE'"), 'never "UNPAID, COLLECT" at the pass');
  const modal = read('../components/PaymentCheckModal.jsx');
  assert.ok(modal.includes('checkOrderPayment({') && modal.includes('confirmOrderPayment({'));
  assert.ok(modal.includes("setStep(manager ? 'note' : 'pin')"), 'confirm needs a manager (PIN unless a manager is signed in)');
});

// ── Fix round 2 (S5): "Payment short" ────────────────────────────────────────────────────────────

// place_public_order (fix round 2) prices the order itself; paid less than that price arrives
// payment_state 'short' with payment_unverified and the amounts in customer.order_pricing.
const olShort = {
  ref: 'OL-SH0RT', source: 'online', paid: false, total: 30,
  customer: { name: 'Ali', payment_state: 'short', payment_unverified: true, payment_ref: 'pi_9', payment_processor: 'stripe',
    order_pricing: { due_minor: 3000, proven_minor: 2400, unknown_lines: 0 } },
};

test('S5: "Payment short" is never charged in full: it reads as checking everywhere a charge could start', () => {
  assert.equal(orderPaymentState(olShort), 'checking');
  assert.equal(mayChargeOrder(olShort), false);
  // Even without payment_unverified (an older copy of the block), short alone blocks the charge.
  const bare = { ...olShort, customer: { ...olShort.customer, payment_unverified: undefined } };
  assert.equal(mayChargeOrder(bare), false);
  assert.deepEqual(paymentShortInfo(olShort), { provenMinor: 2400, dueMinor: 3000, shortMinor: 600, unknownLines: 0, tabClose: false });
  assert.equal(paymentStatusLabel(olShort), PAYMENT_SHORT_LABEL);
  assert.equal(paymentStatusLabel(qrChecking), PAYMENT_CHECKING_LABEL);
  assert.equal(paymentShortLine(olShort, (n) => `£${n.toFixed(2)}`), 'Paid £24.00 of £30.00');
  const unknown = { ...olShort, customer: { ...olShort.customer, order_pricing: { due_minor: 3000, proven_minor: 3000, unknown_lines: 2 } } };
  assert.equal(paymentShortLine(unknown, (n) => n.toFixed(2)), 'Paid 30.00 of 30.00 · 2 items not on the menu');
  assert.equal(paymentShortInfo(qrChecking), null, 'only being checked: no short line');
  assert.equal(paymentShortInfo({ ...olShort, paid: true }), null, 'paid wins');
});

test('S5: a manager Confirm books only what the online payment took (never the same money twice)', async () => {
  assert.equal(confirmAmountMinor(olShort), 2400);
  assert.equal(confirmAmountMinor(qrChecking), null, 'being checked: the server books what the order needed');
  const calls = [];
  const rpc = async (name, args) => { calls.push([name, args]); return { data: { ok: true, paid: true, check_id: 'chk-x' }, error: null }; };
  await confirmOrderPayment({ rpc, locationId: LOC, order: olShort, note: 'took £6 on till 2', isMissingRpc });
  assert.equal(calls[0][0], 'confirm_public_order_payment');
  assert.equal(calls[0][1].p_amount_minor, 2400);
  calls.length = 0;
  await confirmOrderPayment({ rpc, locationId: LOC, order: qrChecking, note: 'seen in Stripe', isMissingRpc });
  assert.equal('p_amount_minor' in calls[0][1], false);
  // Check payment while still short says so in plain words, and never "charge again".
  const a = readPaymentAnswer({ data: { ok: true, paid: false, due_minor: 3000, proven_minor: 2400 } });
  assert.equal(a.status, 'unproven');
  assert.match(a.message, /short of the menu price/);
  assert.match(a.message, /Never charge the full amount again/);
  const u = readPaymentAnswer({ data: { ok: true, paid: false, due_minor: 3000, proven_minor: 3000, unknown_lines: 1 } });
  assert.match(u.message, /not on the menu/);
});

test('S5: a QR tab whose close came up short is closed on the till WITHOUT charging the card again', () => {
  const rounds = [
    { ref: 'QR-R1', location_id: LOC, customer: { tab_open: true, tab_ref: 'QR-R1', payment_intent_id: 'pi_hold', processor: 'stripe', tip: 2, payment_state: 'short', payment_unverified: true, tab_close_short: { paid_minor: 5000, due_minor: 6200 } } },
    { ref: 'QR-R2', location_id: LOC, customer: { tab_open: true, tab_ref: 'QR-R1', payment_intent_id: 'pi_hold', processor: 'stripe', tip: 0, payment_state: 'short', payment_unverified: true, tab_close_short: { paid_minor: 5000, due_minor: 6200 } } },
  ];
  assert.deepEqual(qrTabShortInfo(rounds), { paidMinor: 5000, dueMinor: 6200, restMinor: 1200 });
  assert.equal(qrTabShortInfo([{ customer: { tab_open: true } }]), null);
  assert.equal(qrTabShortLine(rounds, (n) => `£${n.toFixed(2)}`), 'Paid £50.00 of £62.00');
  const tab = { rows: rounds, firstRow: rounds[0], allItems: [{ name: 'IPA', qty: 2, price: 6 }], payment_intent_id: 'pi_hold', processor: 'stripe', tableId: 'T4', tableLabel: '4.1' };
  const check = shortTabClosedCheck(tab, qrTabShortInfo(rounds), { nowIso: '2026-09-19T20:00:00.000Z' });
  assert.equal(check.id, 'chk-qrshort-pi_hold', 'one id per hold: Close pressed twice can never book twice');
  assert.equal(check.total, 50, 'books ONLY what the capture took');
  assert.equal(check.tip, 2);
  assert.equal(check.subtotal, 48);
  assert.deepEqual(check.payment_intents, [{ id: 'pi_hold', amountMinor: 5000 }]);
  assert.equal(check.stripe_payment_intent_id, 'pi_hold');
  assert.equal(check.status, 'paid');
  assert.equal(check.source, 'qr');
  assert.equal(check.customer.shortfall_minor, 1200);
  assert.equal('tab_join_code' in check.customer, false);
  assert.deepEqual(check.items, [{ name: 'IPA', qty: 2, price: 6, voided: false }]);
  const ryft = shortTabClosedCheck({ ...tab, processor: 'ryft', payment_session_id: 'ps_1' }, qrTabShortInfo(rounds));
  assert.deepEqual(ryft.payment_intents, [{ id: 'ps_1', amountMinor: 5000 }]);
  assert.equal(ryft.stripe_payment_intent_id, null);
  assert.equal(shortTabClosedCheck(tab, null), null);
  // The Orders Hub never captures or charges a short tab again.
  const oh = read('../surfaces/OrdersHub.jsx');
  const fn = oh.indexOf('const forceCloseQrTab = async (tab) => {');
  const shortAt = oh.indexOf('if (shortTab) { await closeShortQrTab(tab, shortTab); return; }', fn);
  const capture = oh.indexOf("await fetch('/api/stripe-capture', {", fn);
  assert.ok(shortAt > fn && capture > shortAt, 'the short path returns before any capture');
  const close = oh.slice(oh.indexOf('const closeShortQrTab = async (tab, short) => {'), fn);
  assert.ok(!/stripe-capture|stripe-charge-overage|ryftTab\(|adyenTab\(/.test(close), 'closing a short tab never touches the card');
  assert.ok(close.includes("String(ccErr.code || '') !== '23505'"), 'a second press is a duplicate, not an error');
  assert.ok(oh.includes("{shortLine ? (closingTab ? 'Closing…' : 'Close (already charged)')"));
});

test('S5: the kitchen ticket, MPOS and the Orders Hub say "Payment short" by name', () => {
  const store = read('../store/index.js');
  assert.ok(store.includes("paymentShort: order.customer?.payment_state === 'short' && order.paid !== true,"));
  assert.ok(read('./printDoc.js').includes("delivery.paymentShort ? 'PAYMENT SHORT, DO NOT CHARGE IN FULL' : delivery.paymentChecking ? 'PAYMENT BEING CHECKED, DO NOT CHARGE'"));
  const m = read('../surfaces/mpos/MQueueDetail.jsx');
  assert.ok(m.includes('const checkingLabel = paymentStatusLabel(live);'));
  const oh = read('../surfaces/OrdersHub.jsx');
  assert.ok(oh.includes('{paymentStatusLabel(order).toUpperCase()}'));
  assert.ok(read('../components/PaymentCheckModal.jsx').includes('{short ? PAYMENT_SHORT_HELP : PAYMENT_CHECKING_HELP}'));
});
