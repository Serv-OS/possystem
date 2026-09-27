// src/lib/customerMerge.js
//
// The screen side of the customer-merge edge function (26 Sep 2026). Pure: no Supabase client,
// no fetch, so node tests hold the body it builds against what the function reads.
//
// WHY. Ela Stettner's imported profile (email, 2 stamps) and the blank one the customer portal
// made from her phone could not be joined, and every save that tried to give one of them the
// other's email failed on the unique index with a raw "DB error". Peter: "it should have matched
// the profile together". Back Office now offers a merge instead of the raw error, and the till
// can use the same helpers.
//
// The rules live in supabase/functions/_shared/customerMergePlan.js (the function and the screens
// run the same code, so the button and the server can never disagree about who may merge).

import { isBlankName } from '../../supabase/functions/_shared/customerMergePlan.js';

export {
  uniqueClashOf, maskPhone, maskEmail, canStaffMerge, isBlankName, exactIlike,
} from '../../supabase/functions/_shared/customerMergePlan.js';

/** The edge function's name. */
export const CUSTOMER_MERGE_FN = 'customer-merge';

/**
 * The body customer-merge reads (validateMergeRequest), key for key. The screens build it here
 * and nowhere else; src/lib/customerMerge.test.js pins it against the function.
 */
export function mergeRequestBody({ action, targetId, sourceId, locationId, phoneChoice = null }) {
  const body = { action, target_id: targetId, source_id: sourceId, location_id: locationId };
  if (phoneChoice === 'target' || phoneChoice === 'source') body.phone_choice = phoneChoice;
  return body;
}

/** "This email is already on Ela Stettner. Merge them?" */
export function clashText(field, holder) {
  const what = field === 'phone' ? 'phone number' : 'email';
  if (!holder) return `This ${what} is already on another customer.`;
  const name = isBlankName(holder.name) ? 'another customer with no name' : String(holder.name).trim();
  return `This ${what} is already on ${name}. Merge them?`;
}

// exactIlike (an email as an ilike pattern that matches only itself) lives with the merge rules
// since 27 Sep 2026: the merge's own "who holds this email now" read uses it too.

/** Of the rows a clash lookup found, the one that really holds the value (or null). */
export function clashHolder(field, value, rows = [], excludeId = null) {
  const v = String(value ?? '').trim();
  if (!v) return null;
  const hit = (rows || []).find((r) => {
    if (!r || (excludeId && String(r.id) === String(excludeId))) return false;
    if (field === 'email') return String(r.email ?? '').trim().toLowerCase() === v.toLowerCase();
    return String(r.phone ?? '').trim() === v || String(r.phone_raw ?? '').trim() === v;
  });
  return hit || null;
}

/** Plain words for the "what moves" list: "3 orders, 1 consent record". Unknown counts say "some". */
export function movesText(moves = []) {
  const parts = [];
  for (const m of moves || []) {
    if (!m || m.rows === 0) continue;
    parts.push(m.rows == null ? `some ${m.label}` : `${m.rows} ${m.rows === 1 ? (m.one || m.label) : m.label}`);
  }
  return parts.join(', ');
}

/** The profile card's stamp line: "2/10 Free Drink" (plus completed cards). */
export function stampLine(s) {
  if (!s) return '';
  const of = s.stamps_required ? `/${s.stamps_required}` : '';
  const done = s.completed_count ? `, ${s.completed_count} completed` : '';
  return `${s.stamps_collected || 0}${of} ${s.name || 'stamps'}${done}`;
}
