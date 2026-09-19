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
  PAYMENT_CHECKING_LABEL,
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
  assert.ok(src.includes("const isOrderPaid = (o) => orderPaymentState(o) === 'paid';"));
  const adv = src.indexOf("if (next === 'collected' && isPaymentChecking(o)) {");
  const charge = src.indexOf("if (next === 'collected' && !isOrderPaid(o)) {");
  assert.ok(adv > 0 && charge > adv, 'the checking branch runs before the "take payment" branch');
  assert.ok(src.slice(adv, charge).includes('setPaymentCheckOrder(o);') && !src.slice(adv, charge).includes('openOrder(o)'), 'it opens Check payment, never the pay flow');
  assert.ok(src.includes("['online', 'kiosk'].includes(o.source) || isPaymentChecking(o)) { setViewOrder(o); }"), 'opening it is read-only');
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
