// src/lib/payments/cardSendLock.js
//
// THE BILL DOES NOT CHANGE ONCE THE CARD MACHINE HAS BEEN ASKED FOR IT. PURE: no store, no
// React, no Supabase, so node tests drive every rule (cardSendLock.test.js).
//
// 25 Nov 2026 (Peter, Coffee Boy Castleford: the reader took 8.75 more than the till recorded
// on two loyalty orders; 6 orders across 4 sites since 1 Oct, 23.55 in all). What happened, read
// off terminal_jobs and closed_checks for all six:
//
//   1. The customer tapped Free Drink on the customer display. That only stores the reward
//      (store.pendingLoyaltyReward); the checkout takes it off the bill once its own loyalty
//      lookup has answered (customerLookup.fetchCustomerByPhone, several network calls).
//   2. Staff opened the checkout and pressed Card before that lookup answered. The card job
//      went to the reader for the FULL bill (due_minor = the check total, no reward in the
//      job's draft).
//   3. The lookup answered while the customer was paying. The checkout took the reward off
//      the bill on screen, behind the card screen.
//   4. The reader approved the full amount. The checkout booked the sale from the bill as it
//      now stood: a loyalty tender plus a card tender of (total minus reward), and used the
//      stamp card. The customer paid for the free drink and lost the stamps.
//
// Two rules close it, and CheckoutModal reads both from here:
//
//   cardSendLocked        while a send is out, or a card screen is up, nothing may be taken
//                         off (or put back on) the bill. A reward that arrives then is left
//                         waiting: the card is charged what it was asked for, the sale is
//                         booked as charged, and the customer keeps the reward.
//   holdCardForReward     the Card button waits (a few seconds at most) for a reward the
//                         customer has already chosen, so the reader is asked for the right
//                         amount in the first place.
//
// Money in MINOR units wherever a figure is compared.

/** The screens on which a card payment is in the customer's hand. */
export const CARD_SCREENS = Object.freeze(['pax_terminal', 'card_terminal']);

/** The longest the Card button waits for a chosen reward, from the checkout opening. */
export const REWARD_WAIT_MS = 5000;

/**
 * May nothing be taken off, or put back on, this bill right now?
 * @param s.sending  the send to the card machine is out (pressed, not yet answered)
 * @param s.screen   the checkout screen showing
 * @returns {boolean}
 */
export function cardSendLocked({ sending = false, screen = 'review' } = {}) {
  return !!sending || CARD_SCREENS.includes(screen);
}

/**
 * What to do with the reward the customer chose on the display.
 *   'none'    nothing chosen, one is already on the bill, or this one could not be applied
 *             (no eligible item on the order: staff apply a reward by hand)
 *   'wait'    the member's loyalty has not loaded yet
 *   'refuse'  a card payment is out for this bill: leave the reward waiting, charge nothing less
 *   'apply'   take it off the bill
 * @returns {'none'|'wait'|'refuse'|'apply'}
 */
export function pendingRewardAction({ pending = null, applied = null, haveLoyalty = false, locked = false, applyFailed = false } = {}) {
  if (!pending || applied || applyFailed) return 'none';
  if (!haveLoyalty) return 'wait';
  return locked ? 'refuse' : 'apply';
}

/**
 * Should the Card button wait for the reward the customer chose?
 * Never for longer than REWARD_WAIT_MS (waitedOut), never once the lookup has ended with no
 * member, and never for a reward that could not be applied (staff apply it by hand).
 * @returns {boolean}
 */
export function holdCardForReward({
  pending = null, applied = null, lookupDone = false, haveLoyalty = false, applyFailed = false, waitedOut = false,
} = {}) {
  if (!pending || applied) return false;
  if (waitedOut || applyFailed) return false;
  if (lookupDone && !haveLoyalty) return false;
  return true;
}

/**
 * The invariant, as a check: does the card leg a close is about to book DIFFER from what the
 * reader was asked for? Both before any tip. True only when both figures are known and they
 * are not the same; a figure that is missing is not proof of anything, so it never alarms.
 * @returns {boolean}
 */
export function cardLegDiffersFromSend({ sentDueMinor, bookedCardMinor } = {}) {
  if (sentDueMinor == null || bookedCardMinor == null) return false;
  const sent = Math.round(Number(sentDueMinor));
  const booked = Math.round(Number(bookedCardMinor));
  if (!Number.isFinite(sent) || !Number.isFinite(booked)) return false;
  return sent !== booked;
}

/** The words staff see when a reward arrived too late for this card payment. */
export function lateRewardMessage(reward) {
  const name = String(reward?.label || reward?.reward_name || reward?.name || 'The reward').trim() || 'The reward';
  return `${name} is not on this bill: the card payment was already sent. Cancel the card payment to use it now, or the customer keeps it for next time.`;
}
