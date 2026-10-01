// src/lib/loyaltyMultiRedeem.js
//
// MORE THAN ONE LOYALTY REWARD ON ONE ORDER (Peter, Coffee Boy, 30 Sep 2026: "be able to redeem
// multiple stamp cards on the same order"). PURE: no store, no React, no Supabase, so node tests
// drive every rule (src/lib/loyaltyMultiRedeem.test.js).
//
// Before this the till held ONE staged reward (CheckoutModal loyaltyApplied, one object), so a
// member with two free drinks ready, buying two coffees, had to be rung through twice. Now:
//
//   1. Staff PICK rewards. A pick is one reward applied to one UNIT of one basket line (two
//      lattes on one line are two units, so two free drink rewards can cover both). A fixed or
//      percent reward has no item; its pick has no unit. The same unit is never given away twice.
//   2. Each reward has a number of USES: a stamp card reward as many as the member has completed
//      cards not yet redeemed (loyalty-balance `available`); a points reward once, and only while
//      the points picked so far can pay for it.
//   3. Eligibility is the one rule everything else uses (lib/loyaltyMenuMatch.js eligibleOrderLines:
//      saved id, then the item's name across the company, then its category). Nothing new here.
//   4. The staged result keeps the shape the rest of the till already reads (taxBasis reads
//      discount_value, the store reads pending_commit, stampProgramId and reward_id) as the
//      AGGREGATE, plus `rewards`, one entry per pick. The store commits each entry on its own
//      (loyalty-redeem once per reward, with a slot number so two rewards of the same programme
//      on one check get two ledger rows), so a failure of one never hides the others.
//
// Units: basket prices are in MAJOR units (item.price); discount_value is MINOR, as it always was.

import { eligibleMatcher, eligibleItemNames, eligibleOrderLines } from './loyaltyMenuMatch.js';

const toMinor = (major) => {
  const n = Number(major);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};

const rewardKey = (reward) => String(reward?.id ?? '');

/** How many times this reward may be used on one order. */
export function rewardUses(reward) {
  if (!reward) return 0;
  if (reward.stamp) return Math.max(0, Math.floor(Number(reward.available) || 0));
  return 1;
}

/**
 * The basket units a free item reward can make free: one per unit of each eligible line
 * ({ key, lineIndex, unit, name, priceMinor }). [] for a reward that is not a free item, or when
 * none of its items is on the order.
 * @param reward  { type, value }
 * @param ctx     { items, menuItems, categories }  items = the till's session lines
 */
export function rewardUnits(reward, { items = [], menuItems = [], categories = [] } = {}) {
  if (!reward || reward.type !== 'free_item') return [];
  const lines = Array.isArray(items) ? items : [];
  const eligible = new Set(eligibleOrderLines(reward.value || {}, lines, menuItems, categories));
  const out = [];
  lines.forEach((line, lineIndex) => {
    if (!eligible.has(line)) return;
    const qty = Math.max(0, Math.floor(Number(line.qty) || 0));
    for (let unit = 0; unit < qty; unit++) {
      out.push({ key: `${lineIndex}:${unit}`, lineIndex, unit, name: String(line.name || 'Item'), priceMinor: toMinor(line.price) });
    }
  });
  return out.sort((a, b) => a.priceMinor - b.priceMinor || a.lineIndex - b.lineIndex || a.unit - b.unit);
}

/** Every unit already given to a pick, whatever the reward. */
export function takenUnits(picks) {
  return new Set((Array.isArray(picks) ? picks : []).map((p) => p?.unitKey).filter(Boolean));
}

/** How many picks a reward has. */
export function usesOf(picks, reward) {
  const k = rewardKey(reward);
  return (Array.isArray(picks) ? picks : []).filter((p) => p && String(p.rewardId) === k).length;
}

/** Points the picked points rewards cost together. */
export function pointsPicked(picks, rewards) {
  const byId = new Map((rewards || []).map((r) => [rewardKey(r), r]));
  let total = 0;
  for (const p of Array.isArray(picks) ? picks : []) {
    const r = byId.get(String(p?.rewardId));
    if (r && !r.stamp) total += Math.max(0, Number(r.pointsCost) || 0);
  }
  return total;
}

/**
 * Why this reward cannot be picked again right now, or null when it can.
 *   'used_up'      every use is taken (stamp cards: no more completed cards)
 *   'no_points'    a points reward the balance (after the other picks) cannot pay for
 *   'no_item'      a free item reward with no eligible unit left on the order
 */
export function pickBlock(picks, reward, rewards, { items = [], menuItems = [], categories = [], credit = 0 } = {}) {
  if (!reward) return 'used_up';
  if (usesOf(picks, reward) >= rewardUses(reward)) return 'used_up';
  if (!reward.stamp && pointsPicked(picks, rewards) + (Number(reward.pointsCost) || 0) > (Number(credit) || 0)) return 'no_points';
  if (reward.type === 'free_item') {
    const configured = eligibleMatcher(reward.value || {}, categories).configured;
    if (configured) {
      const taken = takenUnits(picks);
      const free = rewardUnits(reward, { items, menuItems, categories }).filter((u) => !taken.has(u.key));
      if (!free.length) return 'no_item';
    }
  }
  return null;
}

/** The message staff read for a block. */
export function pickBlockText(block, reward) {
  if (block === 'no_item') {
    const names = eligibleItemNames(reward?.value || {}).join(', ');
    return names ? `Add ${names} to the order first. The reward makes it free.` : 'Add the eligible item to the order first.';
  }
  if (block === 'no_points') return 'Not enough points left for this reward.';
  if (block === 'used_up') return reward?.stamp ? 'Every completed card is already used on this order.' : 'This reward is already on the order.';
  return '';
}

/**
 * Add one more use of a reward: the cheapest eligible unit nobody else has, or no unit for a
 * fixed or percent reward. Returns { picks, error }; picks unchanged when refused.
 */
export function pickNext(picks, reward, rewards, ctx = {}) {
  const cur = Array.isArray(picks) ? picks : [];
  const block = pickBlock(cur, reward, rewards, ctx);
  if (block) return { picks: cur, error: pickBlockText(block, reward) };
  let unitKey = null;
  if (reward.type === 'free_item') {
    const taken = takenUnits(cur);
    const free = rewardUnits(reward, ctx).filter((u) => !taken.has(u.key));
    unitKey = free.length ? free[0].key : null;
  }
  return { picks: [...cur, { rewardId: rewardKey(reward), unitKey }], error: null };
}

/**
 * Tick or untick one basket unit for a free item reward. Unticking removes that pick; ticking a
 * unit another reward holds is refused; ticking past the reward's uses is refused.
 */
export function toggleUnit(picks, reward, unitKey, rewards, ctx = {}) {
  const cur = Array.isArray(picks) ? picks : [];
  const k = rewardKey(reward);
  const mine = cur.findIndex((p) => p && String(p.rewardId) === k && p.unitKey === unitKey);
  if (mine >= 0) return { picks: cur.filter((_, i) => i !== mine), error: null };
  if (takenUnits(cur).has(unitKey)) return { picks: cur, error: 'That item is already covered by another reward.' };
  if (usesOf(cur, reward) >= rewardUses(reward)) return { picks: cur, error: pickBlockText('used_up', reward) };
  if (!reward.stamp && pointsPicked(cur, rewards) + (Number(reward.pointsCost) || 0) > (Number(ctx.credit) || 0)) {
    return { picks: cur, error: pickBlockText('no_points', reward) };
  }
  if (!rewardUnits(reward, ctx).some((u) => u.key === unitKey)) return { picks: cur, error: 'That item is not eligible for this reward.' };
  return { picks: [...cur, { rewardId: k, unitKey }], error: null };
}

/** Take the last use of a reward off again. */
export function removeLastPick(picks, reward) {
  const cur = Array.isArray(picks) ? picks : [];
  const k = rewardKey(reward);
  for (let i = cur.length - 1; i >= 0; i--) {
    if (cur[i] && String(cur[i].rewardId) === k) return cur.filter((_, j) => j !== i);
  }
  return cur;
}

/**
 * Turn the picks into staged redemptions, one per pick, the shape lib/loyaltyRedeem.js stages
 * (reward_id | stampProgramId, reward_name, points_deducted, discount_type, discount_value,
 * pending_commit) plus item_name and unit_key. The total is capped at the goods, in pick order,
 * so a later reward never takes off money that is not there.
 * @param ctx  { items, total (major, the bill), menuItems, categories, customerId }
 * @returns { redemptions, discountMinor, error }
 */
export function planRedemptions(picks, rewards, { items = [], total = 0, menuItems = [], categories = [], customerId = null } = {}) {
  const byId = new Map((rewards || []).map((r) => [rewardKey(r), r]));
  const ctx = { items, menuItems, categories };
  const unitsByReward = new Map();
  const totalMinor = Math.max(0, toMinor(total));
  let left = totalMinor;
  const redemptions = [];
  for (const p of Array.isArray(picks) ? picks : []) {
    const reward = byId.get(String(p?.rewardId));
    if (!reward) return { redemptions: [], discountMinor: 0, error: 'A picked reward is no longer available.' };
    const rv = reward.value || {};
    let off = 0;
    let itemName = null;
    if (reward.type === 'discount_fixed') {
      off = Math.max(0, Math.round(Number(rv.amount_minor) || 0));
    } else if (reward.type === 'discount_percent') {
      const pct = Math.min(100, Math.max(0, Number(rv.percent) || 0));
      off = Math.round(totalMinor * pct / 100);
    } else if (reward.type === 'free_item') {
      if (!unitsByReward.has(reward)) unitsByReward.set(reward, rewardUnits(reward, ctx));
      const unit = unitsByReward.get(reward).find((u) => u.key === p.unitKey);
      if (p.unitKey && !unit) return { redemptions: [], discountMinor: 0, error: `${reward.label || 'The reward'}: that item is no longer on the order.` };
      if (unit) { off = unit.priceMinor; itemName = unit.name; }
    }
    // free_delivery / custom: no automatic money off, as before
    off = Math.max(0, Math.min(off, left));
    left -= off;
    redemptions.push({
      reward_id: reward.stamp ? null : reward.id,
      stampProgramId: reward.stamp ? (reward.stampProgramId || String(reward.id).replace(/^stamp:/, '')) : null,
      customer_id: customerId || null,
      reward_name: reward.label,
      points_deducted: reward.stamp ? 0 : (Number(reward.pointsCost) || 0),
      discount_type: reward.type,
      discount_value: off,
      item_name: itemName,
      unit_key: p.unitKey || null,
      idempotency_key: null,
      balance_after: null,
      pending_commit: true,
    });
  }
  return { redemptions, discountMinor: totalMinor - left, error: null };
}

/**
 * One staged object for the checkout, the store and the record (the aggregate the rest of the
 * till reads) with every reward inside it. null for no redemptions.
 */
export function combineRedemptions(redemptions, { customerId = null } = {}) {
  const list = (Array.isArray(redemptions) ? redemptions : []).filter(Boolean);
  if (!list.length) return null;
  const first = list[0];
  const names = [];
  for (const r of list) {
    const n = String(r.reward_name || 'Reward');
    const at = names.findIndex((x) => x.name === n);
    if (at >= 0) names[at].count += 1; else names.push({ name: n, count: 1 });
  }
  return {
    reward_id: list.find((r) => r.reward_id)?.reward_id || null,
    stampProgramId: list.find((r) => r.stampProgramId)?.stampProgramId || null,
    customer_id: customerId || first.customer_id || null,
    reward_name: names.map((x) => (x.count > 1 ? `${x.name} x${x.count}` : x.name)).join(', '),
    points_deducted: list.reduce((s, r) => s + (Number(r.points_deducted) || 0), 0),
    discount_type: list.every((r) => r.discount_type === first.discount_type) ? first.discount_type : 'multi',
    discount_value: list.reduce((s, r) => s + (Number(r.discount_value) || 0), 0),
    idempotency_key: null,
    balance_after: null,
    pending_commit: true,
    rewards: list.length === 1 && !first.rewards ? [first] : list,
  };
}

/**
 * The redemptions a staged loyalty object holds: its `rewards`, or itself when it was staged the
 * old way (one reward, lib/loyaltyRedeem.js or the customer display's pick). [] for nothing.
 */
export function redemptionsOf(loy) {
  if (!loy || typeof loy !== 'object') return [];
  if (Array.isArray(loy.rewards) && loy.rewards.length) return loy.rewards.filter(Boolean);
  return (loy.stampProgramId || loy.reward_id) ? [loy] : [];
}

/**
 * The commit list with a SLOT per redemption: the n-th reward of the same stamp programme (or
 * the same points reward) on one check is slot n. loyalty-redeem keys its ledger row on
 * check + programme, so without the slot the second free drink would collide with the first and
 * come back 'already_processed' having moved nothing. Slot 1 keeps the old key exactly.
 */
export function withSlots(redemptions) {
  const seen = new Map();
  return (Array.isArray(redemptions) ? redemptions : []).filter(Boolean).map((r) => {
    const target = r.stampProgramId ? `stamp:${r.stampProgramId}` : `reward:${r.reward_id}`;
    const slot = (seen.get(target) || 0) + 1;
    seen.set(target, slot);
    return { ...r, slot };
  });
}

/** How many rewards the member could use on this order at most. */
export function rewardCapacity(rewards, { credit = 0 } = {}) {
  let n = 0;
  for (const r of Array.isArray(rewards) ? rewards : []) {
    if (!r) continue;
    if (r.stamp) n += rewardUses(r);
    else if ((Number(r.pointsCost) || 0) <= (Number(credit) || 0)) n += 1;
  }
  return n;
}

/** "2 of 3 rewards used" */
export function rewardsUsedLabel(used, capacity) {
  const u = Math.max(0, Math.floor(Number(used) || 0));
  const c = Math.max(u, Math.floor(Number(capacity) || 0));
  return `${u} of ${c} reward${c === 1 ? '' : 's'} used`;
}

/**
 * The reward lines a receipt, History and the review screen print: one per redemption,
 * { label, amount } with amount in MAJOR units. "Free Drink (Latte)" when the reward covered an
 * item. [] when nothing was redeemed.
 */
export function receiptRewardLines(loy) {
  return redemptionsOf(loy)
    .map((r) => ({
      label: `Reward: ${String(r.reward_name || 'Loyalty reward')}${r.item_name ? ` (${r.item_name})` : ''}`,
      amount: Math.max(0, Math.round(Number(r.discount_value) || 0)) / 100,
      points: Math.max(0, Number(r.points_deducted) || 0),
    }));
}

/**
 * What the closed check keeps of the rewards (closed_checks.tenders, on the loyalty tender), so
 * a reprint or History loaded from the database still shows each one: [{ name, item, amount }].
 */
export function rewardsRecord(loy) {
  const list = redemptionsOf(loy);
  if (!list.length) return null;
  return list.map((r) => ({
    name: String(r.reward_name || 'Loyalty reward'),
    item: r.item_name || null,
    amount: Math.max(0, Math.round(Number(r.discount_value) || 0)) / 100,
    ...(r.stampProgramId ? { stamp_program_id: r.stampProgramId } : {}),
    ...(r.reward_id ? { reward_id: r.reward_id } : {}),
  }));
}

// ── Did the server honour the slot? ────────────────────────────────────────
// The till can be promoted before loyalty-redeem is redeployed. The OLD function ignores
// redeem_slot, builds the slot 1 key for slot 2, hits the UNIQUE index and answers 200
// { status: 'already_processed' } with no error in the body, which commitRedemptions scores as a
// deduction. The member keeps a completed card they already used, and nobody is told. Both
// functions (old and new) answer with the idempotency_key they used, so the till checks it: the
// n-th reward's key must end in ":n". Slot 1 asks nothing new, so nothing changes for it.
export const SLOT_NOT_HONOURED = 'The loyalty service needs updating (loyalty-redeem). This reward was not deducted.';

/** The slot a call carried, 1 when it carried none. */
export function slotOf(body) {
  return Math.max(1, Math.trunc(Number(body?.redeem_slot) || 1));
}

/**
 * True when a 200 reply proves the server keyed THIS slot: slot 1 always; slot n only when the
 * reply's idempotency_key ends with ":n". A missing key on slot > 1 is not proof.
 */
export function slotHonoured(body, reply) {
  const slot = slotOf(body);
  if (slot <= 1) return true;
  const key = String(reply?.idempotency_key || '');
  return key.endsWith(`:${slot}`);
}
