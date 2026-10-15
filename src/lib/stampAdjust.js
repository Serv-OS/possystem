// src/lib/stampAdjust.js
//
// The screen side of adjusting a customer's stamps by hand (Peter, Coffee Boy, 30 Sep 2026). The
// rules live in supabase/functions/_shared/stampAdjust.js, so Back Office and loyalty-earn run
// the same code and can never disagree about who may adjust or what a change does. Pure: no
// Supabase client, no fetch.

export {
  STAMP_ADJUST_ACTION, STAMP_ADJUST_MAX, STAMP_ADJUST_TYPE,
  validateStampAdjust, applyStampAdjust, stampAdjustNote, stampAdjustKey,
  rewardsAvailable, redeemedByProgram, canAdjustStamps, stampAdjustBody,
} from '../../supabase/functions/_shared/stampAdjust.js';

/** The edge function the adjustment is an action of. */
export const STAMP_ADJUST_FN = 'loyalty-earn';

/** A request id for one press of Save: a retry with the same id changes nothing twice. */
export function newAdjustRequestId() {
  try { if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID(); } catch { /* fall through */ }
  return `adj-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * The card row Back Office keeps after the function answered ({ card } from loyalty-earn
 * adjust_stamps), merged into the list it already holds for the customer.
 */
export function mergeAdjustedCard(cards, customerId, companyId, card) {
  const list = Array.isArray(cards) ? cards.filter(Boolean) : [];
  if (!card || !card.program_id) return list;
  const row = {
    id: card.id || null, customer_id: customerId, company_id: companyId || null, program_id: card.program_id,
    stamps_collected: Math.max(0, Number(card.stamps_collected) || 0),
    completed_count: Math.max(0, Number(card.completed_count) || 0),
    last_stamp_at: card.last_stamp_at || null,
  };
  const at = list.findIndex((c) => c.program_id === card.program_id);
  if (at < 0) return [...list, row];
  return list.map((c, i) => (i === at ? { ...c, ...row, id: row.id || c.id, last_stamp_at: row.last_stamp_at || c.last_stamp_at } : c));
}

/** "3 rewards available" / "1 reward available" / "No reward yet" */
export function rewardsAvailableText(n) {
  const k = Math.max(0, Math.floor(Number(n) || 0));
  if (!k) return 'No reward yet';
  return `${k} reward${k === 1 ? '' : 's'} available`;
}

/**
 * What the Adjust form shows for a refusal. Every refusal the NEW loyalty-earn writes carries a
 * `code` (bad_request, refused, changed, not_allowed...); a 400 with NO code is the OLD function,
 * which never heard of the action and insists on a check ('closed_check_id required'). Until it
 * is redeployed nothing is written, so say that in plain English instead of the raw text.
 */
export const STAMP_ADJUST_NEEDS_DEPLOY = 'The loyalty service needs an update before stamps can be adjusted. Nothing was changed. Contact ServOS support.';
export function adjustErrorText(status, body) {
  const j = body && typeof body === 'object' ? body : {};
  if (Number(status) === 400 && !j.code) return STAMP_ADJUST_NEEDS_DEPLOY;
  return j.error || `The loyalty service answered ${status}.`;
}
