// src/lib/orderCustomerLoyalty.js
//
// THE ORDER'S CUSTOMER AND THEIR LOYALTY: ON THE CUSTOMER DISPLAY, AND AT CHECKOUT (28 Sep 2026).
// PURE: no Supabase client, no store, no React, so node tests drive every rule
// (src/lib/orderCustomerLoyalty.test.js; the wiring is pinned in orderCustomerLoyaltyWiring.test.js).
//
// Peter, Coffee Boy Leeds, 28 Sep 2026 (stamps only venue, Sunmi tills with a customer display):
//
// 1. "If you search for the customer and add them to the order, it doesn't show up on the customer
//    display." The display's member panel follows ONE thing: the till's 'loyalty' broadcast
//    (lib/customerDisplay.js publishLoyalty). Two paths sent it: the customer typing their number on
//    the display (POSSurface onCustomerPhone) and Link to existing member (applyMemberLink). The
//    customer form (CustomerModal: search, pick, Confirm) only set the order's customer, so the
//    display never heard of them and the chip showed no stamps. Live: 10:17 UTC, the form attached
//    a member and the display stayed on its keypad until the customer typed the number too.
//    Now the form's customer is looked up the way the display join looks one up (read only: nobody
//    is created here, payment does that) and the display greets them with their stamps.
//
// 2. "When you go to checkout and pay, where the loyalty loads so you can redeem, it's not loading."
//    It did load: loyalty-balance answered 200 every time the checkout opened for that member
//    (10:17:45, 10:17:57, 10:18:11 UTC). But the checkout drew its loyalty line only when there was
//    something to spend (points above 0, or a reward). Coffee Boy runs stamps only, and that member
//    was at 5 of 10 with their one free drink already redeemed on 27 Sep (R4993), so the checkout
//    showed nothing at all while the display showed the card. It also read `points_enabled`, which
//    fetchCustomerByPhone never returns (it returns `pointsEnabled`), so a stamps venue was treated
//    as a points venue ("0 points available" on the rewards screen). The line now shows for every
//    loyalty member the lookup found: points where the venue runs points, each stamp card where it
//    runs stamps, and either the rewards to redeem or "Nothing to redeem yet".

import { stampSummary } from './stampSummary.js';

const str = (v) => (v == null ? '' : String(v));
const digitCount = (v) => str(v).replace(/\D/g, '').length;

// ── the customer form → the customer display ────────────────────────────────

/** The phone to look the order's customer up by, as it is on the order: '' under seven digits. */
export function lookupPhoneOf(customer) {
  const p = str(customer?.phone).trim();
  return digitCount(p) >= 7 ? p : '';
}

/**
 * Is the order's customer still the one that was looked up? The lookup takes a moment; staff may
 * have removed the customer, picked another, or the customer may have typed a number on the display
 * meanwhile. Compared as written on the order, so a different spelling of the same number is also
 * "moved on" (the display join then already told the display).
 */
export function stillOrderCustomer(current, phone) {
  const p = str(phone).trim();
  return !!p && !!current && typeof current === 'object' && str(current.phone).trim() === p;
}

/**
 * What the customer display shows for a customer the till looked up (lib/customerLookup.js
 * fetchCustomerByPhone), in the shape the display join and Link to existing member send:
 *   { known: true, name, points, rewards, customerId, stamps, pointsEnabled, stampsEnabled }
 * null when the lookup found nobody (a number new to the venue): the display then shows nothing,
 * never "Welcome back". A profile that is not a loyalty member yet is still greeted ("You're earning
 * stamps on this order"): it joins when the order is paid.
 */
export function displayLoyaltyOf(lookup, { name = '' } = {}) {
  if (!lookup || typeof lookup !== 'object' || lookup.knownCustomer !== true) return null;
  const stampsEnabled = lookup.stampsEnabled !== false;
  return {
    known: true,
    name: str(lookup.name).trim() || str(name).trim(),
    points: Number(lookup.credit) || 0,
    rewards: Array.isArray(lookup.rewards) ? lookup.rewards : [],
    customerId: lookup.customerId || null,
    stamps: stampsEnabled ? stampSummary(lookup.stampCards) : [],
    pointsEnabled: lookup.pointsEnabled !== false,
    stampsEnabled,
  };
}

/**
 * The order's customer with the looked up stamps for the chip ("☕ 5/10"), or null when nothing
 * would change (no stamps either side, or the same stamps), so the till does not set the customer
 * again for nothing (setCustomer repeats the allergy warning).
 */
export function customerWithStamps(customer, stamps) {
  if (!customer || typeof customer !== 'object') return null;
  const next = Array.isArray(stamps) ? stamps : [];
  const had = Array.isArray(customer.stampSummary) ? customer.stampSummary : [];
  if (!next.length && !had.length) return null;
  if (JSON.stringify(next) === JSON.stringify(had)) return null;
  return { ...customer, stampSummary: next };
}

/**
 * The customer form attached `customer` to the order: tell the customer display who they are.
 * Everything it touches is given (POSSurface passes fetchCustomerByPhone, the store and
 * publishLoyalty), so node tests run it against fakes.
 *   displayOn  this till drives a customer display (displayUsesScreen)
 *   lookup     (phone) => fetchCustomerByPhone's answer; READ ONLY, nobody is created here
 *   current    () => the order's customer NOW (after the lookup)
 *   apply      (customer) => set the order's customer (the chip's stamps); called only on a change
 *   publish    (loyalty) => the display's 'loyalty' broadcast
 * Returns { sent: true, loyalty } or { sent: false, why } with why one of 'no_phone', 'no_display',
 * 'moved_on' (the order's customer changed while it looked), 'not_found' (a number new to the
 * venue). Never throws: a failed lookup is 'not_found', a failed broadcast still counts as sent.
 */
export async function announceOrderCustomer({ customer, displayOn = false, lookup, current, apply, publish } = {}) {
  const phone = lookupPhoneOf(customer);
  if (!phone) return { sent: false, why: 'no_phone' };
  if (!displayOn || typeof lookup !== 'function') return { sent: false, why: 'no_display' };
  let found = null;
  try { found = await lookup(phone); } catch { found = null; }
  let cur = null;
  try { cur = typeof current === 'function' ? current() : null; } catch { cur = null; }
  if (!stillOrderCustomer(cur, phone)) return { sent: false, why: 'moved_on' };
  const loyalty = displayLoyaltyOf(found, { name: cur.name });
  if (!loyalty) return { sent: false, why: 'not_found' };
  const next = customerWithStamps(cur, loyalty.stamps);
  if (next && typeof apply === 'function') {
    try { apply(next); } catch { /* the chip is best effort */ }
  }
  try { if (typeof publish === 'function') publish(loyalty); } catch { /* the display is best effort */ }
  return { sent: true, loyalty };
}

// ── checkout ────────────────────────────────────────────────────────────────

/**
 * The checkout's loyalty line for the order's customer (`data` = fetchCustomerByPhone's answer), or
 * null when there is none to show: no answer, or a profile that is not a loyalty member (no member
 * code, no stamp card, no points, no reward; it joins when the order is paid).
 *   { pointsOn, stampsOn, points, stamps, rewardCount, line }
 * `line` is what staff read under the member's name, for example
 *   stamps venue:  "☕ Free Drink 5/10 · Nothing to redeem yet"
 *   with a card:   "☕ Free Drink 10/10 · 1 reward to redeem"
 *   points venue:  "120 points · 2 rewards to redeem"
 * Either spelling of the venue's switches counts (the lookup says pointsEnabled, loyalty-balance
 * says points_enabled); only an explicit false turns a half off.
 */
export function checkoutLoyaltyView(data) {
  if (!data || typeof data !== 'object' || data.knownCustomer !== true) return null;
  const pointsOn = data.pointsEnabled !== false && data.points_enabled !== false;
  const stampsOn = data.stampsEnabled !== false && data.stamps_enabled !== false;
  const points = Math.max(0, Number(data.credit) || 0);
  const rewardCount = Array.isArray(data.rewards) ? data.rewards.length : 0;
  const stamps = stampsOn ? stampSummary(data.stampCards) : [];
  const member = str(data.memberCode).trim() !== '' || stamps.length > 0 || points > 0 || rewardCount > 0;
  if (!member) return null;
  const parts = [];
  if (pointsOn) parts.push(`${points} point${points === 1 ? '' : 's'}`);
  for (const s of stamps) parts.push(`${s.icon} ${s.name} ${s.have}/${s.need}`);
  parts.push(rewardCount > 0 ? `${rewardCount} reward${rewardCount === 1 ? '' : 's'} to redeem` : 'Nothing to redeem yet');
  return { pointsOn, stampsOn, points, stamps, rewardCount, line: parts.join(' · ') };
}
