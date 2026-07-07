import { test } from 'node:test';
import assert from 'node:assert/strict';
import { operatorSwitchPatch, logoutPatch, parkCart, hasHoldableCart } from './cartHold.js';

const A = { id: 'a', name: 'Alice' };
const B = { id: 'b', name: 'Bob' };
const cart = (n) => ({ id: 'ORD-1', items: Array.from({ length: n }, (_, i) => ({ uid: `u${i}`, price: 2, qty: 1 })) });
const NOW = 1000;

const base = (over = {}) => ({
  staff: null, walkInOrder: null, customer: null, orderType: 'dine-in',
  pendingLoyaltyReward: null, deliveryQuote: null, activeTableId: null, heldOrders: {}, ...over,
});

// ── the core scenario ─────────────────────────────────────────────────────────
test('A adds items, B signs in via card-swap → B gets an EMPTY cart, A is parked', () => {
  const state = base({ staff: A, walkInOrder: cart(2), customer: { name: 'Guest' } });
  const { patch, restored } = operatorSwitchPatch(state, B, NOW);
  assert.equal(patch.staff, B);
  assert.equal(patch.walkInOrder, null);              // B starts clean
  assert.equal(patch.customer, null);
  assert.equal(patch.activeTableId, null);
  assert.equal(restored, null);                        // B had nothing held
  assert.ok(patch.heldOrders.a, 'A cart parked under A');
  assert.equal(patch.heldOrders.a.walkInOrder.items.length, 2);
});

test('A signs back in → their parked order comes back, and the hold is consumed', () => {
  const held = { a: { walkInOrder: cart(2), customer: { name: 'Guest' }, orderType: 'dine-in', parkedAt: NOW } };
  const state = base({ staff: B, walkInOrder: null, heldOrders: held });
  const { patch, restored } = operatorSwitchPatch(state, A, NOW);
  assert.equal(patch.staff, A);
  assert.equal(patch.walkInOrder.items.length, 2);
  assert.deepEqual(patch.customer, { name: 'Guest' });
  assert.deepEqual(restored, { count: 2 });
  assert.equal(patch.heldOrders.a, undefined, 'hold consumed on restore');
});

test('B never inherits A cart even across a logout→login (PIN path)', () => {
  // A logs out: parks A, clears the live cart.
  const afterLogout = logoutPatch(base({ staff: A, walkInOrder: cart(3) }), NOW);
  assert.equal(afterLogout.staff, null);
  assert.equal(afterLogout.walkInOrder, null);         // live cart cleared (old bug: it lingered)
  assert.equal(afterLogout.heldOrders.a.walkInOrder.items.length, 3);
  // B signs in on the PIN screen from that state.
  const { patch } = operatorSwitchPatch({ ...base(), ...afterLogout }, B, NOW);
  assert.equal(patch.walkInOrder, null);               // B clean
  assert.ok(patch.heldOrders.a, 'A still parked');
});

// ── same operator ──────────────────────────────────────────────────────────────
test('same operator re-scanning their own card keeps their cart untouched', () => {
  const state = base({ staff: A, walkInOrder: cart(2) });
  const { patch, restored } = operatorSwitchPatch(state, { id: 'a', name: 'Alice II' }, NOW);
  assert.deepEqual(Object.keys(patch), ['staff']);     // ONLY staff changes
  assert.equal(restored, null);
});

test('same operator id compared as string vs number', () => {
  const state = base({ staff: { id: 7 }, walkInOrder: cart(1) });
  const { patch } = operatorSwitchPatch(state, { id: '7' }, NOW);
  assert.deepEqual(Object.keys(patch), ['staff']);
});

// ── table safety (memory: tables must never be lost) ─────────────────────────────
test('an active table is NOT parked as a counter cart (table order stays on the table)', () => {
  const state = base({ staff: A, activeTableId: 't5', walkInOrder: null });
  const { patch } = operatorSwitchPatch(state, B, NOW);
  assert.equal(patch.heldOrders.a, undefined);         // nothing counter to hold
  assert.equal(patch.activeTableId, null);             // B deselects the table (it persists in tables[])
});

test('a counter cart populated behind an open table IS still parked (not lost on switch)', () => {
  // Tapping a table does not clear walkInOrder — those counter items belong to the operator and
  // must survive an operator switch, even though a table is currently selected.
  const state = base({ staff: A, activeTableId: 't5', walkInOrder: cart(2) });
  assert.equal(hasHoldableCart(state), true);
  const held = parkCart({}, state, 'a', NOW);
  assert.equal(held.a.walkInOrder.items.length, 2);
  const { patch } = operatorSwitchPatch(state, B, NOW);
  assert.equal(patch.walkInOrder, null);          // B clean
  assert.ok(patch.heldOrders.a, 'A counter cart parked despite the open table');
});

// ── no-loss / empty-cart hygiene ────────────────────────────────────────────────
test('switching with an empty cart parks nothing and clears any stale hold', () => {
  const state = base({ staff: A, walkInOrder: { id: 'x', items: [] }, heldOrders: { a: { walkInOrder: cart(1) } } });
  const held = parkCart(state.heldOrders, state, 'a', NOW);
  assert.equal(held.a, undefined, 'stale hold dropped when current cart is empty');
});

test('B keeps their OWN held order when A switches to B', () => {
  const held = { b: { walkInOrder: cart(4), orderType: 'takeaway', parkedAt: 1 } };
  const state = base({ staff: A, walkInOrder: cart(2), heldOrders: held });
  const { patch, restored } = operatorSwitchPatch(state, B, NOW);
  assert.equal(patch.walkInOrder.items.length, 4);     // B's own order restored
  assert.equal(patch.orderType, 'takeaway');
  assert.deepEqual(restored, { count: 4 });
  assert.ok(patch.heldOrders.a, 'A now parked');
  assert.equal(patch.heldOrders.b, undefined, 'B hold consumed');
});

// ── context fields carried through ───────────────────────────────────────────────
test('orderType / customer / pendingLoyaltyReward / deliveryQuote are all held + restored', () => {
  const state = base({
    staff: A, walkInOrder: cart(1), customer: { id: 'c1' }, orderType: 'delivery',
    pendingLoyaltyReward: { id: 'r1' }, deliveryQuote: { fee: 3 },
  });
  const parked = operatorSwitchPatch(state, B, NOW).patch.heldOrders.a;
  assert.equal(parked.orderType, 'delivery');
  assert.deepEqual(parked.customer, { id: 'c1' });
  assert.deepEqual(parked.pendingLoyaltyReward, { id: 'r1' });
  assert.deepEqual(parked.deliveryQuote, { fee: 3 });
  // restore for A
  const back = operatorSwitchPatch(base({ staff: B, heldOrders: { a: parked } }), A, NOW).patch;
  assert.equal(back.orderType, 'delivery');
  assert.deepEqual(back.customer, { id: 'c1' });
  assert.deepEqual(back.deliveryQuote, { fee: 3 });
});

// ── first login (no current operator) ────────────────────────────────────────────
test('first login with nobody signed in and no hold → empty cart', () => {
  const { patch, restored } = operatorSwitchPatch(base(), A, NOW);
  assert.equal(patch.staff, A);
  assert.equal(patch.walkInOrder, null);
  assert.equal(restored, null);
});

test('logout with no staff is a no-op-ish clean state (no crash)', () => {
  const patch = logoutPatch(base(), NOW);
  assert.equal(patch.staff, null);
  assert.deepEqual(patch.heldOrders, {});
});

test('a SENT-but-unpaid order is NOT parked (it lives in the Orders Hub, never double-held)', () => {
  const sent = { id: 'ORD-9', ref: 'A-9', sentAt: 5, items: [{ uid: 'u', price: 4, qty: 1, status: 'sent' }] };
  const patch = logoutPatch(base({ staff: A, walkInOrder: sent }), NOW);
  assert.equal(patch.heldOrders.a, undefined, 'sent order not parked (would double-record with Orders Hub)');
  assert.equal(patch.walkInOrder, null);          // live cart still cleared on logout
});

test('an order with a ref but no sentAt is still treated as sent (not parked)', () => {
  const state = base({ staff: A, walkInOrder: { id: 'ORD-1', ref: 'A-1', items: [{ uid: 'u', price: 2, qty: 1 }] } });
  assert.equal(hasHoldableCart(state), false);
});
