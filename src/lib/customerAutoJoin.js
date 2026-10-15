// src/lib/customerAutoJoin.js
//
// THE TILL JOINS A CUSTOMER BY EMAIL, BY ITSELF (27 Sep 2026). PURE: no Supabase client, no fetch,
// no store, no React, so node tests drive every case (src/lib/customerAutoJoin.test.js). The reads
// and writes are in lib/customerAutoJoinRun.js.
//
// WHY. Coffee Boy imported 8,028 loyalty members from 5Loyalty; 1,357 have an email and NO phone.
// When one of them gives staff their phone and email, the till saved by phone only: a second,
// empty profile appeared, and giving it the email hit the unique email index ("DB error"). Ela
// Stettner and Simon Hughes were fixed by hand. Peter, 27 Sep 2026: "I don't want a merge tool,
// I want it so when someone signs up it auto merges their records, matches them as long as they
// use the same email, it knows the record exists and just adds them together." No question to
// staff. So on Confirm, in the two forms where staff typed the phone and the email:
//   (a) the phone is not on file and the email is on a profile with NO phone: the phone goes on
//       that profile (an empty name is filled from the form) and the order uses it;
//   (b) the phone is on an EMPTY profile (no name, no email, no history: the merge core's blank
//       shell rule) and the email is on a profile with no phone: customer-merge folds the empty
//       one into the email's profile, and the order uses the one kept;
//   (c) any other clash: the profile is saved without the email (the email stays on the order for
//       the receipt) and staff read why, in plain words, never a database error.
//
// SAFEGUARDS (they add no friction):
//   * the email's profile must have no phone (or already this very number, as typed text only):
//     a phone is a loyalty login and is never moved off a profile that holds a different one;
//   * exact email, case aside, same organisation, exactly ONE live profile (% _ and * in an email
//     match only themselves);
//   * only an email TYPED in this form joins (emailIsNew). An order reopened from the Orders Hub
//     or a table's guest brings an email from order_queue or active_sessions, which the public
//     key can write, so that email never joins anything. Order close, the Orders Hub, the
//     customer display and every background save stay phone only (store upsertCustomer);
//   * every join is written on the profile (lib/customerAutoJoinRun.js, the email_join tags) and
//     the email's owner is told once (customer-join-notice);
//   * gift cards are untouched: a card is shown only to the phone proved with the one time code,
//     matched on the card's own recipient phone (18 Sep 2026), never through a profile.

import { isBlankName, samePhone, exactIlike } from '../../supabase/functions/_shared/customerMergePlan.js';
import { phoneLookupValues } from '../../supabase/functions/_shared/phoneKey.js';

/** The customers columns the till's check reads (enough for the shell rule it can see, and the trail). */
export const AUTO_JOIN_COLS = 'id, name, first_name, last_name, phone, phone_raw, email, allergens, tags';

const str = (v) => (v == null ? '' : String(v));
const has = (v) => str(v).trim() !== '';

// ── emails ──────────────────────────────────────────────────────────────────

/** A whole email (so the till looks it up)? */
export function looksLikeEmail(v) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(str(v).trim());
}

/** The same email, case and spaces aside (the unique index is on lower(email)). */
export function sameEmail(a, b) {
  const x = str(a).trim().toLowerCase();
  return x !== '' && x === str(b).trim().toLowerCase();
}

/**
 * An email as an ilike pattern that matches only itself, case aside. % and _ are escaped
 * (exactIlike). PostgREST also reads * as %, and a backslash cannot stop that, so a * becomes the
 * one character wildcard _ and exactEmailRows drops anything that is not this very email.
 * (353 live Coffee Boy emails hold a _ : unescaped, 'a_b@x.com' would also find 'axb@x.com'.)
 */
export function emailSearchPattern(email) {
  return exactIlike(email).replace(/\*/g, '_');
}

/** Of the rows an email search found, only the ones holding exactly this email. */
export function exactEmailRows(rows, email) {
  return (Array.isArray(rows) ? rows : []).filter((r) => r && sameEmail(r.email, email));
}

/**
 * Did staff type this email in THIS form? Only then may it join anything. The form's opening
 * email came from the order or the table (writable with the public key), or from an earlier
 * Confirm that already ran the check; keeping it, or clearing it, joins nothing.
 */
export function emailIsNew(openedWithEmail, typedEmail) {
  if (!looksLikeEmail(typedEmail)) return false;
  return !sameEmail(openedWithEmail, typedEmail);
}

// ── phones ──────────────────────────────────────────────────────────────────

/** A phone as written, without the UK '(0)' that sits between +44 and the number. */
const tidyPhone = (v) => str(v).replace(/\(\s*0\s*\)/g, '');

/**
 * The same number written the ways the till, the imports and older builds store it, for one read:
 * the key first ('+447415748167'), then every stored shape that is provably the same number
 * (phoneLookupValues of the one phone match key, 29 Sep 2026: in a UK venue the national form
 * '07415748167' and '447415748167', and 00 for the + anywhere), for the key and for the number as
 * typed. `region` is the venue's ('GB', 'US' or ''). Only + and digits, so the values are safe
 * inside a PostgREST or() or in() filter.
 */
export function phoneVariants(phoneN, typed = '', region = '') {
  const out = [];
  for (const v of [...phoneLookupValues(phoneN, region), ...phoneLookupValues(typed, region)]) {
    if (!out.includes(v)) out.push(v);
  }
  return out;
}

/**
 * Does the email's profile have a phone?
 *   'none'        no phone and no phone_raw (null, or blank text)
 *   'same'        only phone_raw, and it IS this number (an import kept the cell but not the phone)
 *   'saved'       its phone IS this number, written another way (so the phone read missed it)
 *   'unreadable'  only phone_raw, and it is not a whole number (fewer than 7 digits)
 *   'other'       a different number
 */
export function holderPhone(holder, typedPhone) {
  if (!holder) return 'none';
  if (has(holder.phone)) return samePhone(tidyPhone(holder.phone), typedPhone) ? 'saved' : 'other';
  if (!has(holder.phone_raw)) return 'none';
  if (samePhone(tidyPhone(holder.phone_raw), typedPhone)) return 'same';
  return str(holder.phone_raw).replace(/\D/g, '').length < 7 ? 'unreadable' : 'other';
}

/**
 * The part of the merge core's blank shell rule a till can see: no name ('' or 'Customer'), no
 * first or last name, no email. customer-merge's preview checks the rest (points, stamps,
 * orders, an import), which the till cannot see.
 */
export function rowLooksBlank(row) {
  if (!row) return false;
  return isBlankName(row.name) && !has(row.first_name) && !has(row.last_name) && !has(row.email);
}

// ── the decision ────────────────────────────────────────────────────────────

/**
 * What Confirm does, given what the two reads found.
 *   phoneHit    the live profile whose phone is exactly this number (the one the save would use)
 *   phoneOthers other live profiles holding this number written another way (phone or phone_raw)
 *   emailHits   live profiles holding exactly this email (the unique index allows one)
 *   phone       the number staff typed, normalised
 * Returns
 *   { step: 'save' }                         nothing to join; save as always
 *   { step: 'claim', holder, rawOnly }       (a) put the phone on holder
 *   { step: 'join', source, target }         (b) fold the empty phone profile into the email's
 *   { step: 'apart', reason, holder? }       (c) save without the email and say why
 */
export function decideAutoJoin({ phoneHit = null, phoneOthers = [], emailHits = [], phone = '' } = {}) {
  const hits = Array.isArray(emailHits) ? emailHits.filter(Boolean) : [];
  if (!hits.length) return { step: 'save' };
  if (hits.length > 1) return { step: 'apart', reason: 'several' };
  const holder = hits[0];
  if (phoneHit && String(phoneHit.id) === String(holder.id)) return { step: 'save' };
  const hp = holderPhone(holder, phone);
  if (hp === 'other') return { step: 'apart', reason: 'holder_has_phone', holder };
  if (hp === 'saved') return { step: 'apart', reason: 'holder_phone_format', holder };
  if (hp === 'unreadable') return { step: 'apart', reason: 'holder_phone_unreadable', holder };
  // The number is already on another profile in another format: joining would leave two
  // profiles with one number, so the till does not guess which is the customer.
  const strays = (Array.isArray(phoneOthers) ? phoneOthers : [])
    .filter((r) => r && String(r.id) !== String(holder.id) && (!phoneHit || String(r.id) !== String(phoneHit.id)));
  if (strays.length) return { step: 'apart', reason: 'phone_elsewhere', holder };
  if (!phoneHit) return { step: 'claim', holder, rawOnly: hp === 'same' };
  if (!rowLooksBlank(phoneHit)) return { step: 'apart', reason: 'phone_profile_has_details', holder };
  return { step: 'join', source: phoneHit, target: holder };
}

// ── customer-merge's answers ────────────────────────────────────────────────

/**
 * May the till fold these two together? Only on customer-merge's own preview: it can merge, the
 * profile folded in is an empty shell (counted with its points, stamps and orders, which the till
 * cannot see), and the profile kept is the email's. A till signed in as an owner would pass the
 * server's staff rule for ANY pair, so the till holds itself to the shell rule here as well.
 */
export function joinAllowed(preview, { sourceId, targetId } = {}) {
  const p = preview || {};
  if (p.ok !== true || p.can_merge !== true || p.source_blank !== true || p.swapped === true) return false;
  return String(p.source_id) === String(sourceId) && String(p.target_id) === String(targetId);
}

/**
 * WHY customer-merge would not let the till join them, as a short code (27 Sep 2026: the till's
 * "Link to existing member" shows plain words for each, lib/customerLink.js linkMessage). A
 * refusal answer carries its own code (device_needs_blank_source, not_allowed, read_failed...; a
 * refused merge names the plan's first refusal, e.g. different_phones). A preview that answered
 * but would not do what the till asked: 'not_blank' (the profile folded in has history),
 * 'swapped' (the kept profile would be the other one), or the plan's first refusal.
 */
export function joinRefusalCode(answer, { sourceId, targetId } = {}) {
  const status = Number(answer?.status) || 0;
  const b = answer?.body || {};
  if (!status) return 'no_answer';
  const first = Array.isArray(b.refusals) && b.refusals[0]?.code ? String(b.refusals[0].code) : '';
  if (b.ok !== true) {
    if (b.code === 'refused' && first) return first;
    return String(b.code || 'refused');
  }
  // 27 Sep 2026 (review): the turned round pair is named FIRST. When neither profile has history
  // the server keeps the OLDER one (customerMergePlan chooseSurvivor), so an older empty profile
  // makes the member the one folded in; source_blank then describes the member, and "not_blank"
  // would tell staff the empty profile "already has an order", which is not true.
  const sameIds = String(b.source_id) === String(sourceId) && String(b.target_id) === String(targetId);
  if (b.swapped === true || (b.source_id != null && !sameIds)) return 'swapped';
  if (b.source_blank === false) return 'not_blank';
  if (b.can_merge !== true) return first || 'refused';
  if (!sameIds) return 'swapped';
  return 'refused';
}

/** A merge answer: 'merged', 'retry' (stopped part way, safe to send again) or 'refused'. */
export function mergeOutcome(status, body) {
  const b = body || {};
  if (status === 200 && b.ok === true) return 'merged';
  if (status === 500 && b.code === 'step_failed' && b.retry_safe === true) return 'retry';
  return 'refused';
}

// ── the words ───────────────────────────────────────────────────────────────

/** A name worth showing: not blank or 'Customer', has a letter, is not an email. */
export function realName(name) {
  const n = str(name).trim();
  if (isBlankName(n) || !/\p{L}/u.test(n) || n.includes('@')) return '';
  return n;
}

/** Peter's toast (27 Sep 2026): "Linked to <name>'s loyalty (joined by email)". */
export function linkedToast(profileName, typedName = '') {
  const who = realName(profileName) || realName(typedName);
  return who ? `Linked to ${who}'s loyalty (joined by email)` : 'Linked to the loyalty profile with this email (joined by email)';
}

const SAVED_WITHOUT = 'Saved without the email';

/** (c): why the email was not saved on the profile. Plain words, never the database's own. */
export function apartToast(reason) {
  switch (reason) {
    case 'several': return `${SAVED_WITHOUT}: more than one customer has it.`;
    case 'holder_has_phone': return `${SAVED_WITHOUT}: it is on another customer with a different phone number.`;
    case 'holder_phone_format':
    case 'holder_phone_unreadable':
    case 'phone_elsewhere': return `${SAVED_WITHOUT}: it is on another customer, and this number is saved on a profile in another form.`;
    case 'phone_profile_has_details': return `${SAVED_WITHOUT}: it is on another customer, and this phone already has its own profile.`;
    case 'join_refused': return `${SAVED_WITHOUT}: this phone's profile and the email's could not be joined automatically.`;
    case 'join_unfinished': return `${SAVED_WITHOUT}: joining the two profiles did not finish. Nothing is lost.`;
    case 'changed': return `${SAVED_WITHOUT}: that customer was changed a moment ago.`;
    case 'phone_taken': return `${SAVED_WITHOUT}: this phone was just saved on another customer.`;
    case 'timeout': return `${SAVED_WITHOUT}: the till did not hear back in time.`;
    default: return `${SAVED_WITHOUT}: it could not be linked just now.`;
  }
}

/** Allergy lists joined, never one dropped (first seen order). */
export function unionAllergens(...lists) {
  const out = [];
  for (const l of lists) for (const v of Array.isArray(l) ? l : []) if (v != null && v !== '' && !out.includes(v)) out.push(v);
  return out;
}

/**
 * The customer the form hands on after a join. The order keeps what staff typed (name, phone,
 * email), and takes the profile's allergy list joined with its own: the kitchen must see an
 * allergy the member told us about, and the save replaces a profile's list with the order's, so
 * a list the profile had must travel with the order. No list on either side stays no list.
 */
export function customerAfterJoin(customer, profileAllergens) {
  const c = customer || {};
  const all = unionAllergens(c.allergens, profileAllergens);
  if (!all.length) return { ...c };
  return { ...c, allergens: all };
}
