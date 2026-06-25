// src/lib/loyaltyRedeem.js
//
// Shared loyalty reward redemption: deducts points via the loyalty-redeem edge
// function and computes the resulting order discount. Used by:
//   • CheckoutModal's LoyaltyRewardsEntry (staff picks a reward), and
//   • the auto-apply of a reward the customer tapped on the customer display.
//
// Points are deducted HERE (at redemption time), so callers should only call this
// at checkout — not when the customer merely taps a reward (that just stages it).

import { ensureAuthToken, getActiveLocationSync } from './supabase';
import { isTrainingMode } from './trainingMode';

const FUNCTIONS_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1`;

/**
 * @param {{id:string,label?:string,value?:object,type?:string,pointsCost?:number}} reward
 * @param {{ customerId:string, items?:Array, total?:number }} ctx
 * @returns applied result { reward_id, reward_name, points_deducted, discount_type, discount_value, idempotency_key, balance_after }
 */
export async function redeemLoyaltyReward(reward, { customerId, items = [], total = 0 }) {
  // TRAINING MODE: apply the reward's discount in-memory but NEVER deduct real
  // points (no loyalty-redeem call). Mirrors the discount math below off `reward`.
  if (isTrainingMode()) {
    let discountMinor = 0;
    const rv = reward.value || {};
    const type = reward.type;
    if (type === 'discount_fixed') discountMinor = rv.amount_minor || 0;
    else if (type === 'discount_percent') discountMinor = Math.round(total * 100 * (rv.percent || 0) / 100);
    else if (type === 'free_item') {
      const eligibleIds = new Set((rv.eligible_items || []).map(ei => ei.id));
      const matching = (items || []).filter(i => !i.voided && eligibleIds.has(i.itemId));
      if (matching.length > 0) discountMinor = Math.round(matching.reduce((a, b) => (a.price < b.price ? a : b)).price * 100);
    }
    discountMinor = Math.min(discountMinor, Math.round(total * 100));
    return { reward_id: reward.id, reward_name: reward.label, points_deducted: reward.pointsCost || 0, discount_type: type, discount_value: discountMinor, idempotency_key: null, balance_after: null, training: true };
  }
  const token = await ensureAuthToken();
  if (!token) throw new Error('Not authenticated');
  const res = await fetch(`${FUNCTIONS_URL}/loyalty-redeem`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({
      customer_id: customerId,
      location_id: getActiveLocationSync(),
      reward_id: reward.id,
      channel: 'pos',
    }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);

  let discountMinor = 0;
  const rv = j.reward?.value || reward.value || {};
  const type = j.reward?.type || reward.type;
  if (type === 'discount_fixed') {
    discountMinor = rv.amount_minor || 0;
  } else if (type === 'discount_percent') {
    discountMinor = Math.round(total * 100 * (rv.percent || 0) / 100);
  } else if (type === 'free_item') {
    const eligibleIds = new Set((rv.eligible_items || []).map(ei => ei.id));
    if (eligibleIds.size > 0) {
      const matching = (items || []).filter(i => !i.voided && eligibleIds.has(i.itemId));
      if (matching.length > 0) {
        const cheapest = matching.reduce((a, b) => (a.price < b.price ? a : b));
        discountMinor = Math.round(cheapest.price * 100);
      }
    }
  }
  // free_delivery / custom → no automatic line discount
  discountMinor = Math.min(discountMinor, Math.round(total * 100));

  return {
    reward_id: reward.id,
    reward_name: j.reward?.name || reward.label,
    points_deducted: j.points_deducted || reward.pointsCost,
    discount_type: type,
    discount_value: discountMinor,
    idempotency_key: j.idempotency_key || null,
    balance_after: j.balance,
  };
}
