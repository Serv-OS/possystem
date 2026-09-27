// src/lib/customerLink.js
//
// "LINK TO EXISTING MEMBER" ON THE ORDER CHIP (27 Sep 2026). PURE: no Supabase client, no fetch,
// no store, no React, so node tests drive every rule (src/lib/customerLink.test.js). The reads and
// writes are in lib/customerLinkRun.js.
//
// WHY. Peter, 27 Sep 2026: "if a customer adds their number and then a staff member can link that
// to a profile that currently has no number". Coffee Boy imported 8,028 members; 1,357 have an
// email and NO phone. The email join (lib/customerAutoJoin.js) only runs when staff type the phone
// AND the email in the customer form, and Coffee Boy Leeds runs takeaway and collection with the
// customer details setting reduced (pos_settings.takeaway_customer_details, CustomerModal nameOnly):
// "we have details disabled so only the phone number is there for takeaway and collection so
// nowhere to type those details in". The customer types their number on the customer display,
// which makes an EMPTY profile, and the member they already are is never found.
//
// So when the order's customer is a new, empty one (just a phone), the chip offers "Link to
// existing member": staff search by name or email, only profiles with NO phone are offered, and
// tapping one links at once. Peter's standing decision: automatic, no extra question; only
// phoneless profiles are claimed (a phone is a loyalty login, never moved off anyone); the
// email's owner gets the one notice; order close never joins. It works whatever the details
// setting is, because it never needs the form.
//
// LINK BEFORE PAYMENT. The empty profile folds into the member through customer-merge, whose rule
// for a till is that only an EMPTY SHELL may be folded in (no name, email, points, stamps, orders
// or ledger rows). An open order's customer is still a shell: order history is written when the
// order is paid (store attributeOrderToCustomer). After payment the server refuses a till
// (device_needs_blank_source) and the chip says, in plain words, that a manager can join them in
// Back Office.

import { isBlankName, maskEmail } from '../../supabase/functions/_shared/customerMergePlan.js';
import { holderPhone, rowLooksBlank, realName, unionAllergens } from './customerAutoJoin.js';

const str = (v) => (v == null ? '' : String(v));
const has = (v) => str(v).trim() !== '';
const digits = (v) => str(v).replace(/\D/g, '');

// ── the chip ────────────────────────────────────────────────────────────────

/**
 * Does the order chip offer "Link to existing member"? The order's customer has a phone (at least
 * seven digits), no email, is not already linked, and is new: no name ('' or 'Customer', any
 * case), or the customer display has just made an empty profile for the number (blankProfile, set
 * when staff typed a name for the order in the name only form and the customer typed the number).
 * The run checks the profile itself; this only decides whether the button shows.
 */
export function canOfferLink(customer) {
  const c = customer;
  if (!c || typeof c !== 'object') return false;
  if (c.memberLinked === true) return false;
  if (digits(c.phone).length < 7) return false;
  if (has(c.email)) return false;
  return isBlankName(c.name) || c.blankProfile === true;
}

/**
 * Did the customer display's lookup leave an EMPTY profile on this number? A number it has just
 * made a profile for, or one it found with no name. (The display never sees an email, and the run
 * checks the profile before it links anything.)
 */
export function displayProfileLooksBlank(res) {
  if (!res || res.ok !== true) return false;
  return res.known === false || isBlankName(res.name);
}

// ── the search ──────────────────────────────────────────────────────────────

/** Neither a phone nor a raw phone on the profile: the only kind the link may give a phone to. */
export function hasNoPhone(row) {
  return !!row && !has(row.phone) && !has(row.phone_raw);
}

/**
 * The text staff typed, safe inside a PostgREST or() filter: the characters that would end or
 * widen the filter (, ( ) % * \ " ') are dropped. '' until there are three characters.
 */
export function linkSearchTerm(q) {
  const t = str(q).replace(/[,()%*\\"']/g, '').replace(/\s+/g, ' ').trim();
  return t.length >= 3 ? t : '';
}

/** Of the rows a search found, the phoneless ones, once each, at most `limit`. */
export function phonelessResults(rows, limit = 10) {
  const seen = new Set();
  const out = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || !has(r.id) || !hasNoPhone(r) || seen.has(String(r.id))) continue;
    seen.add(String(r.id));
    out.push(r);
    if (out.length >= limit) break;
  }
  return out;
}

/** One search result as the list shows it: the name (or "No name"), the email masked, "no phone". */
export function memberCard(row) {
  const n = str(row?.name).trim();
  return {
    id: str(row?.id),
    name: isBlankName(n) ? 'No name' : n,
    email: maskEmail(row?.email),
    noPhone: hasNoPhone(row),
  };
}

// ── the decision ────────────────────────────────────────────────────────────

/**
 * What the link does, given what the reads found.
 *   member      the picked profile as it is NOW (null: gone, or another organisation)
 *   phoneHit    the live profile whose phone is exactly this number (the display's empty profile)
 *   phoneOthers other live profiles holding this number written another way
 *   phone       the order's number, normalised
 * Returns
 *   { step: 'join', source }          fold the empty profile into the member (customer-merge)
 *   { step: 'claim', rawOnly }        no profile has the number yet: it goes on the member
 *   { step: 'already' }               the member already has this number (linked a moment ago)
 *   { step: 'refuse', code }          anything else; nothing is written
 *
 * 27 Sep 2026 (review): 'already' only when the profile holding EXACTLY this number (the one
 * payment and the stamp lookup find) is the member, and no other profile holds it another way.
 * A member whose phone is this number written differently ('07762955142' while the display's
 * empty profile holds '+447762955142') used to answer 'already': the till said "Linked" while
 * payment and the stamps went to the empty profile. That is now a refusal, like the email join's.
 */
export function decideLink({ member = null, phoneHit = null, phoneOthers = [], phone = '' } = {}) {
  if (!member) return { step: 'refuse', code: 'member_gone' };
  const mid = String(member.id);
  const strays = (Array.isArray(phoneOthers) ? phoneOthers : [])
    .filter((r) => r && String(r.id) !== mid && (!phoneHit || String(r.id) !== String(phoneHit.id)));
  if (phoneHit && String(phoneHit.id) === mid) {
    return strays.length ? { step: 'refuse', code: 'phone_elsewhere' } : { step: 'already' };
  }
  const hp = holderPhone(member, phone);
  if (hp === 'saved') return { step: 'refuse', code: (phoneHit || strays.length) ? 'phone_elsewhere' : 'member_phone_format' };
  if (hp === 'other' || hp === 'unreadable') return { step: 'refuse', code: 'member_has_phone' };
  if (strays.length) return { step: 'refuse', code: 'phone_elsewhere' };
  if (!phoneHit) return { step: 'claim', rawOnly: hp === 'same' };
  if (!rowLooksBlank(phoneHit)) return { step: 'refuse', code: 'phone_profile_has_details' };
  return { step: 'join', source: phoneHit };
}

/**
 * The refusal the chip shows when customer-merge would not fold the empty profile in.
 * 27 Sep 2026 (review): when neither profile has history the server keeps the OLDER one
 * (customerMergePlan chooseSurvivor). So an empty profile made BEFORE the member (a display
 * number from an earlier unpaid order, a member added later in Back Office) turns the pair round,
 * and a till hears device_needs_blank_source although the empty profile has no order. When the
 * empty profile is the older one the till cannot tell which it was, so it does not claim an order
 * it cannot see: 'swapped' says only that they could not be linked here. Otherwise the code stands.
 */
export function joinRefusalShown(code, { source = null, member = null } = {}) {
  if (code !== 'device_needs_blank_source' && code !== 'not_blank') return code;
  const s = Date.parse(str(source?.created_at));
  const m = Date.parse(str(member?.created_at));
  return Number.isFinite(s) && Number.isFinite(m) && s < m ? 'swapped' : code;
}

// ── the words ───────────────────────────────────────────────────────────────

const MANAGER = 'A manager can join them in Back Office > Customers.';

/** Why it did not link, in plain words. Never a database error. */
export function linkMessage(code) {
  switch (code) {
    case 'device_needs_blank_source':
    case 'not_blank': return `This customer already has an order. ${MANAGER}`;
    case 'member_has_phone':
    case 'different_phones': return 'That member already has a different phone number, so it was not linked.';
    case 'phone_profile_has_details': return `This number is already on a customer with a name or email. ${MANAGER}`;
    case 'phone_elsewhere': return `This number is also saved on another customer. ${MANAGER}`;
    case 'member_phone_format': return 'That member already has this number, written another way, so it was not linked. A manager can correct it in Back Office > Customers.';
    case 'swapped': return `These two could not be linked here. ${MANAGER}`;
    case 'member_gone':
    case 'not_found': return 'That member could not be found. Search again.';
    case 'changed': return 'That member was changed a moment ago. Search again.';
    case 'phone_taken': return 'This number was just saved on another customer. Search again.';
    case 'read_failed':
    case 'no_answer': return 'Could not reach the customer records just now. Nothing was changed. Try again.';
    case 'timeout': return 'The till did not hear back in time. Tap the member again to finish.';
    case 'join_unfinished':
    case 'step_failed': return 'Linking did not finish. Nothing is lost: tap the member again to finish.';
    case 'not_allowed':
    case 'sign_in': return `This till could not link them just now. ${MANAGER}`;
    case 'training': return 'Linking is off in training mode.';
    case 'not_new_customer': return 'Only a new customer with just a phone number can be linked.';
    case 'no_phone': return "This order's customer has no phone number to link.";
    case 'offline':
    case 'no_venue':
    case 'failed': return 'This till could not link them just now. Try again.';
    default: return `These two could not be linked here. ${MANAGER}`;
  }
}

/** Peter's toast (27 Sep 2026): "Linked to <name>'s loyalty". */
export function linkedToast(name) {
  const who = realName(name);
  return who ? `Linked to ${who}'s loyalty` : "Linked to the member's loyalty";
}

/**
 * The order's customer after the link: the member's name (the name staff typed stays when the
 * member has none), the phone as typed, the member's allergy list joined with the order's (the
 * kitchen must see it; no list on either side stays no list), the member's stamps for the chip
 * ("2/9") when the lookup found them, and memberLinked so the chip stops offering the link. The
 * member's email is NOT copied onto the order: the customer gave only a phone at the counter, and
 * the order travels on shared queues.
 */
export function customerAfterLink(customer, { name = '', allergens = null, stamps = null } = {}) {
  const c = { ...(customer || {}) };
  delete c.blankProfile;
  const out = { ...c, name: realName(name) || str(c.name), memberLinked: true };
  const all = unionAllergens(c.allergens, allergens);
  if (all.length) out.allergens = all;
  if (Array.isArray(stamps)) out.stampSummary = stamps;
  return out;
}
