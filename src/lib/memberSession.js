// src/lib/memberSession.js
//
// The loyalty member signed in on THIS screen right now (kiosk), and their session token.
//
// WHY (18 Sep 2026). loyalty-earn, loyalty-redeem and gift-redeem (by card_id) now ask who the
// caller is. A kiosk whose device link is missing has one other proof when a member signed in at
// it: the session token loyalty-otp minted after the one time code. But the kiosk's submitOrder,
// where earn, the reward redemption and the gift card debit are fired, is frozen by the card path
// guard (kioskCardPathGuard.test.js, owner rule), so the token cannot be threaded through it. The
// kiosk publishes the signed in member here instead (KioskApp, from verifiedLoyalty, cleared when
// the session resets) and the shared senders read it:
//   * commitRedemptions buildCall      -> member_token, only when the reward is for THIS member
//   * store.attributeOrderToCustomer   -> loyalty-earn member_token, only for THIS member
//   * giftCommit.commitGiftCard        -> member_token (the server only lets it unlock cards
//                                         addressed to the member's own proven phone)
// A token never authorises anything for somebody else. It is still matched on the customer id
// wherever there is one, and cleared on every reset.
//
// GRACE: loyalty-earn is sent after the order is written and the customer is resolved, which can
// finish after a quick "start a new order" reset. So for MEMBER_GRACE_MS after a clear, the last
// member's token is still returned by memberTokenFor, and only for that same customer id.
// activeMemberToken (gift cards, debited before the order is written) has no grace.
//
// PURE module state, no imports: node tests load it.

export const MEMBER_GRACE_MS = 2 * 60 * 1000;

let current = null; // { token, customerId }
let recent = null;  // { token, customerId, until }

/** Publish (or clear, with null) the signed in member. */
export function setActiveMemberSession(session, now = Date.now()) {
  const token = session && typeof session.token === 'string' && session.token ? session.token : null;
  if (token) {
    current = { token, customerId: session.customerId ? String(session.customerId) : null };
    recent = null;
    return;
  }
  if (current) recent = { ...current, until: now + MEMBER_GRACE_MS };
  current = null;
}

/** The token of the signed in member when it is THIS customer, else null. */
export function memberTokenFor(customerId, now = Date.now()) {
  if (!customerId) return null;
  const id = String(customerId);
  if (current && current.customerId === id) return current.token;
  if (!current && recent && recent.customerId === id && now <= recent.until) return recent.token;
  return null;
}

/** The signed in member's token, whoever they are, or null. No grace. */
export function activeMemberToken() {
  return current ? current.token : null;
}
