// supabase/functions/_shared/stampAdjust.js
//
// ADJUST A CUSTOMER'S STAMPS BY HAND (Peter, Coffee Boy, 30 Sep 2026: "need to be able to adjust
// stamps on the back office for a customer that is registered"). PURE: no database, no clock, no
// imports beyond the merge role rule, so node tests drive every rule
// (src/lib/stampAdjust.test.js) and Back Office imports the same file through src/lib/stampAdjust.js.
//
// WHY IT LIVES BEHIND AN EDGE FUNCTION. A stamp balance is two numbers on the Platform card
// (customer_stamp_cards.stamps_collected, completed_count) and the redeem rows in the Ops ledger
// (stamp_transactions type='redeem'): rewards available = completed_count minus redeem rows.
// Only loyalty-earn and loyalty-redeem write those today, and every change they make leaves a
// ledger row. A hand adjustment must do the same, so it is an ACTION of loyalty-earn
// (action: 'adjust_stamps') and never a direct update from the browser: the ledger row is
// written FIRST as the claim (a retry of the same request_id is a no-op), then the card moves.
//
// WHAT STAFF MAY DO, on one programme's card:
//   stamps_delta   add or remove stamps. Adding past the card's length completes a card, exactly
//                  as an order would (loyalty-earn's roll over). Removing more than the card holds
//                  is refused: a completed card is taken off with rewards_delta, on purpose.
//   rewards_delta  add or remove whole completed cards (rewards available). Removing below the
//                  number still available (completed minus redeemed) is refused, so a reward the
//                  customer already took is never made negative.
//   reason         required, shown in the ledger note, so the report says who did what and why.
// WHO: an owner or a manager of the venue, the organisation's owner, a company owner, admin or
// manager, or a super admin (the same rule as merging customers, customerMergePlan.js
// staffMergeRole). A till or a member token never passes. The customer must belong to the
// venue's organisation.

import { staffMergeRole } from './customerMergePlan.js';

export const STAMP_ADJUST_ACTION = 'adjust_stamps';
export const STAMP_ADJUST_MAX = 500;
export const STAMP_ADJUST_TYPE = 'adjust';   // the stamp_transactions.type an adjustment writes

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v.trim());
const intOr = (v, dflt) => {
  if (v === undefined || v === null || v === '') return dflt;
  const n = Number(v);
  return Number.isInteger(n) ? n : NaN;
};

/**
 * Read and check the body of an adjust_stamps call. { ok: true, ... } with the cleaned values, or
 * { ok: false, error } in plain English for the screen.
 */
export function validateStampAdjust(body) {
  const b = body && typeof body === 'object' ? body : {};
  if (b.action !== STAMP_ADJUST_ACTION) return { ok: false, error: 'Not a stamp adjustment.' };
  if (!isUuid(b.customer_id)) return { ok: false, error: 'customer_id required' };
  if (!isUuid(b.location_id)) return { ok: false, error: 'location_id required' };
  if (!isUuid(b.stamp_program_id)) return { ok: false, error: 'stamp_program_id required' };
  const stampsDelta = intOr(b.stamps_delta, 0);
  const rewardsDelta = intOr(b.rewards_delta, 0);
  if (Number.isNaN(stampsDelta) || Number.isNaN(rewardsDelta)) return { ok: false, error: 'Stamps and rewards must be whole numbers.' };
  if (Math.abs(stampsDelta) > STAMP_ADJUST_MAX || Math.abs(rewardsDelta) > STAMP_ADJUST_MAX) {
    return { ok: false, error: `No more than ${STAMP_ADJUST_MAX} at a time.` };
  }
  if (stampsDelta === 0 && rewardsDelta === 0) return { ok: false, error: 'Nothing to change: add or remove at least one stamp or reward.' };
  const reason = typeof b.reason === 'string' ? b.reason.trim().replace(/\s+/g, ' ') : '';
  if (reason.length < 3) return { ok: false, error: 'Give a reason (at least 3 characters).' };
  if (reason.length > 200) return { ok: false, error: 'Keep the reason under 200 characters.' };
  const requestId = typeof b.request_id === 'string' ? b.request_id.trim() : '';
  if (requestId.length < 8 || requestId.length > 80 || !/^[A-Za-z0-9._:-]+$/.test(requestId)) {
    return { ok: false, error: 'request_id required (8 to 80 letters, digits, dot, dash, underscore or colon).' };
  }
  return {
    ok: true,
    customerId: b.customer_id.trim(), locationId: b.location_id.trim(), programId: b.stamp_program_id.trim(),
    stampsDelta, rewardsDelta, reason, requestId,
  };
}

/** The ledger key of one adjustment: a retry of the same request changes nothing. */
export function stampAdjustKey(requestId) {
  return `stampadjust:${String(requestId || '').trim()}`;
}

/** Rewards available on a card: completed cards minus redeem rows, never below zero. */
export function rewardsAvailable(card, redeemed) {
  const completed = Math.max(0, Math.floor(Number(card?.completed_count) || 0));
  const used = Math.max(0, Math.floor(Number(redeemed) || 0));
  return Math.max(0, completed - used);
}

/** Redeem rows grouped by programme: { [program_id]: count }. */
export function redeemedByProgram(rows) {
  const out = {};
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || r.type !== 'redeem' || !r.program_id) continue;
    out[r.program_id] = (out[r.program_id] || 0) + 1;
  }
  return out;
}

/**
 * The card after an adjustment. Stamps roll over into completed cards the way loyalty-earn does;
 * a remove that would go below zero is refused with what IS there.
 * @param card       { stamps_collected, completed_count }
 * @param redeemed   redeem rows this customer has on this programme
 * @param change     { stampsDelta, rewardsDelta, stampsRequired }
 * @returns { ok: true, stamps_collected, completed_count, rolled, rewards_available }
 *        | { ok: false, error }
 */
export function applyStampAdjust(card, redeemed, { stampsDelta = 0, rewardsDelta = 0, stampsRequired } = {}) {
  const need = Math.floor(Number(stampsRequired) || 0);
  if (need <= 0) return { ok: false, error: 'This stamp card has no length set.' };
  const collected = Math.max(0, Math.floor(Number(card?.stamps_collected) || 0));
  let completed = Math.max(0, Math.floor(Number(card?.completed_count) || 0));
  const used = Math.max(0, Math.floor(Number(redeemed) || 0));
  const sd = Math.trunc(Number(stampsDelta) || 0);
  const rd = Math.trunc(Number(rewardsDelta) || 0);

  let stamps = collected + sd;
  if (stamps < 0) {
    return { ok: false, error: collected === 0 ? 'No stamps on this card to remove.' : `Only ${collected} stamp${collected === 1 ? '' : 's'} on this card to remove. Take a completed card off with the rewards control instead.` };
  }
  let rolled = 0;
  while (stamps >= need) { stamps -= need; completed += 1; rolled += 1; }

  completed += rd;
  const available = completed - used;
  if (available < 0) {
    const have = Math.max(0, completed - rd - used);
    return { ok: false, error: have === 0 ? 'No rewards available to remove.' : `Only ${have} reward${have === 1 ? '' : 's'} available to remove.` };
  }
  return { ok: true, stamps_collected: stamps, completed_count: completed, rolled, rewards_available: available };
}

/** The ledger note: "+2 stamps (card completed), +1 reward. Reason: lost card. By owner@venue" */
export function stampAdjustNote({ stampsDelta = 0, rewardsDelta = 0, rolled = 0, reason = '', actor = '' } = {}) {
  const parts = [];
  const sd = Math.trunc(Number(stampsDelta) || 0);
  const rd = Math.trunc(Number(rewardsDelta) || 0);
  if (sd) parts.push(`${sd > 0 ? '+' : ''}${sd} stamp${Math.abs(sd) === 1 ? '' : 's'}${rolled > 0 ? ` (${rolled === 1 ? 'card completed' : `${rolled} cards completed`})` : ''}`);
  if (rd) parts.push(`${rd > 0 ? '+' : ''}${rd} reward${Math.abs(rd) === 1 ? '' : 's'}`);
  const who = String(actor || '').trim();
  return `Adjusted by staff: ${parts.join(', ')}. Reason: ${String(reason || '').trim()}${who ? `. By ${who}` : ''}`.slice(0, 500);
}

/**
 * Who may adjust: the customer merge rule (owner or manager of the venue, the organisation's
 * owner, a company owner/admin/manager, a super admin). Never anonymous, never a device.
 * Same facts as customerMergePlan.staffMergeRole; the name says what it is used for here.
 */
export function stampAdjustRole(facts) {
  return staffMergeRole(facts);
}

/** Back Office: may this user adjust stamps? The screen's gate, the same rule the function applies. */
export function canAdjustStamps(facts) {
  return stampAdjustRole({ ...facts, user: facts?.user || { id: 'me', is_anonymous: false } }) !== null;
}

/**
 * The body loyalty-earn reads for an adjustment, key for key (validateStampAdjust). Built here
 * and nowhere else.
 */
export function stampAdjustBody({ customerId, locationId, programId, stampsDelta = 0, rewardsDelta = 0, reason, requestId }) {
  return {
    action: STAMP_ADJUST_ACTION,
    customer_id: customerId,
    location_id: locationId,
    stamp_program_id: programId,
    stamps_delta: Math.trunc(Number(stampsDelta) || 0),
    rewards_delta: Math.trunc(Number(rewardsDelta) || 0),
    reason: String(reason || '').trim(),
    request_id: String(requestId || ''),
  };
}
