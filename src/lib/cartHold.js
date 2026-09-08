// Per-operator counter checkout on a shared till — PURE state transitions (unit-tested in
// cartHold.test.js; the store's login/logout just apply these patches).
//
// The problem: a shared POS keeps ONE counter cart (walkInOrder). If user A rings up items and
// walks away without sending/paying, and user B signs in, B used to inherit A's cart. We want B to
// get a CLEAN checkout, A's in-progress order PARKED under A's staff id, and A's order handed back
// when A signs in again.
//
// Scope: only the counter cart (walkInOrder + its context). TABLE orders are never touched here —
// they live on the table (tables[].session), independent of the operator.

// The fields that together make up "the counter checkout" for one operator.
const EMPTY_CART = Object.freeze({ walkInOrder: null, customer: null, orderType: 'dine-in', pendingLoyaltyReward: null });

// A genuine, holdable counter cart = an UNSENT counter order with at least one line item.
//  - We do NOT gate on activeTableId: a counter cart can sit populated in the background while a
//    table is selected (tapping a table doesn't clear walkInOrder), and that cart must still be
//    held for its owner — otherwise a switch-with-a-table-open silently loses it.
//  - We DO exclude an already-SENT order (has ref / sentAt): once fired it lives in the order queue
//    / Orders Hub, recoverable by anyone. Parking it too would create a second payable copy → the
//    same order could be recorded (and stock-depleted) twice.
export function hasHoldableCart(state) {
  const wi = state?.walkInOrder;
  if (!wi || !Array.isArray(wi.items) || wi.items.length === 0) return false;
  if (wi.sentAt || wi.ref) return false;
  return true;
}

// Return a NEW heldOrders map with `staffId`'s current counter cart parked from `state`. When there
// is nothing holdable, any stale hold for that id is dropped (so an emptied cart can't resurrect).
export function parkCart(heldOrders, state, staffId, now) {
  const next = { ...(heldOrders || {}) };
  if (!staffId) return next;
  if (hasHoldableCart(state)) {
    next[staffId] = {
      walkInOrder: state.walkInOrder,
      customer: state.customer || null,
      orderType: state.orderType || 'dine-in',
      pendingLoyaltyReward: state.pendingLoyaltyReward || null,
      deliveryQuote: state.deliveryQuote || null,
      parkedAt: now,
    };
  } else {
    delete next[staffId];
  }
  return next;
}

// Full state patch for switching operator A→B (also handles first sign-in when state.staff is null).
// Returns { patch, restored } where restored = { count } when B had a parked order handed back
// (for a confirmation toast), else null. Guarantees a single atomic set → B never flashes A's cart.
export function operatorSwitchPatch(state, newStaff, now) {
  const cur = state?.staff;

  // Same operator re-authenticating (e.g. re-scan of their own card) — leave the cart exactly as is.
  if (cur && newStaff && String(cur.id) === String(newStaff.id)) {
    return { patch: { staff: newStaff }, restored: null };
  }

  // Park the outgoing operator's cart (direct card-swap path; on the PIN path logout already did this).
  let heldOrders = state?.heldOrders || {};
  if (cur && cur.id) heldOrders = parkCart(heldOrders, state, cur.id, now);

  // Hand the incoming operator their parked cart, or a clean empty checkout.
  const held = newStaff && newStaff.id ? heldOrders[newStaff.id] : null;
  let cart;
  let restored = null;
  if (held) {
    heldOrders = { ...heldOrders };
    delete heldOrders[newStaff.id];
    cart = {
      walkInOrder: held.walkInOrder,
      customer: held.customer || null,
      orderType: held.orderType || 'dine-in',
      pendingLoyaltyReward: held.pendingLoyaltyReward || null,
      deliveryQuote: held.deliveryQuote || null,
    };
    restored = { count: held.walkInOrder?.items?.length || 0 };
  } else {
    cart = { ...EMPTY_CART };
  }

  return { patch: { staff: newStaff, activeTableId: null, heldOrders, ...cart }, restored };
}

// State patch for logout: park the current operator's counter cart, then clear staff + the live cart
// (the old logout left walkInOrder behind, which is what let the next user inherit it).
export function logoutPatch(state, now) {
  const cur = state?.staff;
  let heldOrders = state?.heldOrders || {};
  if (cur && cur.id) heldOrders = parkCart(heldOrders, state, cur.id, now);
  return {
    staff: null, activeTableId: null,
    walkInOrder: null, customer: null, orderType: 'dine-in', pendingLoyaltyReward: null,
    heldOrders,
  };
}
