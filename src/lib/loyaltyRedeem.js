// src/lib/loyaltyRedeem.js
//
// Shared loyalty reward APPLICATION. Used by:
//   • CheckoutModal's LoyaltyRewardsEntry (staff picks a reward), and
//   • the auto-apply of a reward the customer tapped on the customer display.
//
// v5.5.896: APPLY-ONLY. Tapping a reward now just computes + stages the discount —
// NOTHING is consumed server-side. The real redemption (points deduction / stamp-card
// consumption) fires when the check COMMITS, via store.redeemLoyaltyAtCommit — exactly
// the promo-code pattern. Owner-reported bug this fixes: staff tapped a free-item reward
// with no eligible item in the basket → the stamp card was consumed server-side for a
// £0 discount. Now that tap is BLOCKED with a clear message, and an abandoned checkout
// can never burn a reward. Training mode needs no special casing here (nothing hits the
// server at apply time); the commit-time call is training-gated in the store.

/**
 * @param {{id:string,label?:string,value?:object,type?:string,pointsCost?:number,stamp?:boolean,stampProgramId?:string}} reward
 * @param {{ customerId:string, items?:Array, total?:number }} ctx
 * @returns staged result { reward_id|stampProgramId, customer_id, reward_name, points_deducted,
 *          discount_type, discount_value, pending_commit:true }
 * @throws when a free-item reward has no eligible item in the basket (apply refused).
 */
export async function redeemLoyaltyReward(reward, { customerId, items = [], total = 0 }) {
  const rv = reward.value || {};
  const type = reward.type;
  let discountMinor = 0;
  if (type === 'discount_fixed') {
    discountMinor = rv.amount_minor || 0;
  } else if (type === 'discount_percent') {
    discountMinor = Math.round(total * 100 * (rv.percent || 0) / 100);
  } else if (type === 'free_item') {
    const eligibleIds = new Set((rv.eligible_items || []).map(ei => ei.id));
    const matching = (items || []).filter(i => !i.voided && eligibleIds.has(i.itemId));
    if (eligibleIds.size > 0 && matching.length === 0) {
      const names = (rv.eligible_items || []).map(ei => ei.name).filter(Boolean).join(', ');
      throw new Error(names
        ? `Add ${names} to the order first — the reward makes it free.`
        : 'Add the eligible item to the order first.');
    }
    if (matching.length > 0) {
      const cheapest = matching.reduce((a, b) => (a.price < b.price ? a : b));
      discountMinor = Math.round(cheapest.price * 100);
    }
  }
  // free_delivery / custom → no automatic line discount
  discountMinor = Math.min(discountMinor, Math.round(total * 100));

  return {
    reward_id: reward.stamp ? null : reward.id,
    stampProgramId: reward.stamp ? (reward.stampProgramId || String(reward.id).replace(/^stamp:/, '')) : null,
    customer_id: customerId || null,
    reward_name: reward.label,
    points_deducted: reward.stamp ? 0 : (reward.pointsCost || 0),
    discount_type: type,
    discount_value: discountMinor,
    idempotency_key: null,
    balance_after: null,
    pending_commit: true,
  };
}
