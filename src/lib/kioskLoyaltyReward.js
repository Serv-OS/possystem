// src/lib/kioskLoyaltyReward.js
//
// The money a kiosk loyalty reward takes off, as pure functions so the numbers can be tested.
//
// The bug this fixes (14 Sep 2026, kiosk redesign finding F4): loyalty-otp verify sent
// rewards_available WITHOUT reward_value, so every points reward reached the kiosk with an
// empty value. A fixed or percent reward staged 0p off, and submitOrder still committed the
// redemption, so the customer lost their points and got nothing. Two rules now hold:
//
//   1. The discount is worked out from the reward's type + value against the CURRENT basket,
//      every render, not frozen at the tap. A guest can go back to the basket after tapping
//      a reward; a frozen figure then kept a percent of the old basket, or kept a free item's
//      price after the item was removed.
//   2. A reward that takes nothing off is never committed. The kiosk refuses to apply it,
//      and submitOrder only redeems when the live credit is above zero.
//
// Units: the basket (cart lines) is in MAJOR units like the rest of KioskApp; everything this
// module returns is an integer in MINOR units (pence / cents).

function toMinor(major) {
  const n = Number(major);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

function lineMatches(line, eligibleIds) {
  const ids = [line?.item?.id, line?.variant?.id].filter(Boolean);
  return ids.some(id => eligibleIds.has(id));
}

// Eligible item ids configured on a free_item reward (empty set when none are configured).
function eligibleIdSet(value) {
  return new Set((value?.eligible_items || []).map(ei => ei?.id).filter(Boolean));
}

/**
 * For a free_item reward with eligible items configured and none of them in the basket, the
 * names to tell the guest to add ('' when the items have no names). null when nothing is missing.
 */
export function kioskRewardMissingItems(type, value, cart = []) {
  if (type !== 'free_item') return null;
  const ids = eligibleIdSet(value);
  if (ids.size === 0) return null;
  if ((cart || []).some(l => lineMatches(l, ids))) return null;
  return (value?.eligible_items || []).map(ei => ei?.name).filter(Boolean).join(', ');
}

/**
 * Minor units a reward takes off the goods, capped at the goods.
 *   discount_fixed   → value.amount_minor
 *   discount_percent → round(goods × value.percent / 100)
 *   free_item        → one unit of the cheapest eligible line in the basket
 *   anything else    → 0 (free_delivery / custom have no automatic money off)
 * @param {string} type    reward_type
 * @param {object} value   reward_value (points) or reward_config (stamp card)
 * @param {{cart?:Array, goodsMinor?:number}} ctx  goodsMinor = basket after auto-discounts, before tax + tip
 */
export function kioskRewardDiscountMinor(type, value, { cart = [], goodsMinor = 0 } = {}) {
  const goods = Math.max(0, Math.round(Number(goodsMinor) || 0));
  const rv = value || {};
  let off = 0;
  if (type === 'discount_fixed') {
    off = Math.round(Number(rv.amount_minor) || 0);
  } else if (type === 'discount_percent') {
    const pct = Math.min(100, Math.max(0, Number(rv.percent) || 0));
    off = Math.round(goods * pct / 100);
  } else if (type === 'free_item') {
    const ids = eligibleIdSet(rv);
    const matching = ids.size ? (cart || []).filter(l => lineMatches(l, ids) && (l.qty || 0) > 0) : [];
    if (matching.length) off = Math.min(...matching.map(l => toMinor(l.linePrice)));
  }
  return Math.max(0, Math.min(off, goods));
}

/**
 * The live loyalty credit (minor) for a staged kiosk redemption. Capped at what is still due
 * after a staged gift card, so a reward tapped AFTER a gift card already covering the order
 * cannot push the gift-only path into debiting the card for money the reward also took off.
 * 0 means the reward is not used: nothing is shown off and nothing is committed.
 * @param {object|null} redemption  staged object from ScreenLoyalty (reward_type + reward_value)
 * @param {{cart?:Array, goodsMinor?:number, dueMinor?:number, giftMinor?:number}} ctx
 */
export function kioskLoyaltyCreditMinor(redemption, { cart = [], goodsMinor = 0, dueMinor = 0, giftMinor = 0 } = {}) {
  if (!redemption) return 0;
  const off = kioskRewardDiscountMinor(redemption.reward_type, redemption.reward_value, { cart, goodsMinor });
  const room = Math.max(0, Math.round(Number(dueMinor) || 0) - Math.max(0, Math.round(Number(giftMinor) || 0)));
  return Math.min(off, room);
}

/**
 * The check the kiosk runs when a guest TAPS a reward, using the same gift cap as the live
 * credit above so the tap and the pay screen can never disagree. Returns
 * { discountMinor, error }: error is a guest-facing message and the reward must NOT be staged.
 *
 * Refused when:
 *   - a free_item reward's eligible items are not in the basket;
 *   - the reward takes nothing off the goods (empty basket, no kiosk money off);
 *   - a staged gift card leaves less still due than the reward's full value. Staging it would
 *     either do nothing (gift already covers the order) or spend the whole points / stamp cost
 *     for part of the reward while the gift card is debited for more than it needed to be.
 * @param {string} type
 * @param {object} value
 * @param {{cart?:Array, goodsMinor?:number, dueMinor?:number, giftMinor?:number}} ctx
 */
export function kioskRewardTapCheck(type, value, { cart = [], goodsMinor = 0, dueMinor = 0, giftMinor = 0 } = {}) {
  const missing = kioskRewardMissingItems(type, value, cart);
  if (missing !== null) {
    return {
      discountMinor: 0,
      error: missing
        ? `Add ${missing} to your order first — the reward makes it free.`
        : 'Add the eligible item to your order first.',
    };
  }
  const goods = Math.max(0, Math.round(Number(goodsMinor) || 0));
  const full = kioskRewardDiscountMinor(type, value, { cart, goodsMinor: goods });
  if (full <= 0) {
    return {
      discountMinor: 0,
      error: goods <= 0
        ? 'Add items to your order first, then use your reward.'
        : 'This reward cannot be used on the kiosk. Please ask a member of staff.',
    };
  }
  const gift = Math.max(0, Math.round(Number(giftMinor) || 0));
  if (gift > 0) {
    const live = kioskLoyaltyCreditMinor({ reward_type: type, reward_value: value }, { cart, goodsMinor: goods, dueMinor, giftMinor: gift });
    if (live < full) {
      return { discountMinor: 0, error: 'Remove the gift card first to use your reward.' };
    }
  }
  return { discountMinor: full, error: null };
}
