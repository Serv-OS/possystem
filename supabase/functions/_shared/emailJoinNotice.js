// supabase/functions/_shared/emailJoinNotice.js
//
// THE TRAIL AN AUTOMATIC EMAIL JOIN LEAVES, AND THE ONE NOTICE IT SENDS. PURE: no database, no
// clock of its own, so node tests drive every rule (src/lib/emailJoinNotice.test.js), the till
// imports the tag helpers (src/lib/customerAutoJoinRun.js) and customer-join-notice/index.ts
// imports the notice rules.
//
// WHY (27 Sep 2026). 1,357 imported Coffee Boy members have an email and no phone. When one of
// them gives the till their phone and email, the till now joins them by itself: the phone goes on
// the imported profile, or the empty profile the portal made from the phone is folded into it.
// Peter: "I don't want a merge tool, I want it so when someone signs up it auto merges their
// records, matches them as long as they use the same email, it knows the record exists and just
// adds them together." An email is never verified, so two things make an automatic join safe to
// live with:
//   1. THE TRAIL. The profile says which phone an email match linked and when
//      (`email_join:<phone>`, `email_join_at:<time>`), next to the merge core's own trail
//      (`merged:` / `merged_into:` in customerMergePlan.js). Anyone can see what happened and undo
//      it by hand: take the phone off, or split the profile.
//   2. THE NOTICE. ONE short email to the address on the profile: "Your <venue> stamps and points
//      are now linked to your phone ending 8167. If this wasn't you, reply to this email or tell
//      staff." Sent once per phone (`join_notice:<phone>`), only for a profile that carries a join
//      trail for its CURRENT phone, and it never holds up the join (the till does not wait).
//
// Gift cards are not touched by any of this (18 Sep 2026 rule): a card is shown only to the phone
// proved with the one time code, matched against the card's own recipient phone, never through a
// customer profile. A join changes no gift card row and adds no way to see a code.

import {
  MERGE_TAG, isUuid, samePhone, tagValue, mergedIntoOf, union,
} from './customerMergePlan.js';

/** The tags an automatic join writes on the profile that took the phone. */
export const EMAIL_JOIN_TAG = Object.freeze({
  PHONE: 'email_join:',       // the phone an email match linked to this profile
  AT: 'email_join_at:',       // when (ISO time)
  NOTICE: 'join_notice:',     // the notice for this phone was sent (written by customer-join-notice)
});

/** The customers columns the notice reads for the profile that took the phone. */
export const NOTICE_CUSTOMER_COLS = 'id, org_id, name, email, phone, phone_raw, tags, updated_at, deleted_at';

/** ...and for the empty profile folded into it (a join made by the merge core). */
export const NOTICE_SOURCE_COLS = 'id, org_id, tags, deleted_at';

const str = (v) => (v == null ? '' : String(v));
const has = (v) => str(v).trim() !== '';
const list = (v) => (Array.isArray(v) ? v.filter((x) => x != null && x !== '') : []);

/** The profile's tags with this join added (first seen order kept, nothing dropped). */
export function emailJoinTags(tags, phone, now) {
  const add = [];
  if (has(phone)) add.push(EMAIL_JOIN_TAG.PHONE + str(phone).trim());
  if (has(now)) add.push(EMAIL_JOIN_TAG.AT + str(now).trim());
  return union(list(tags), add);
}

/** Every phone this profile's tags say an email match linked. */
export function emailJoinPhones(tags) {
  return list(tags).map(String).filter((t) => t.startsWith(EMAIL_JOIN_TAG.PHONE)).map((t) => t.slice(EMAIL_JOIN_TAG.PHONE.length)).filter(Boolean);
}

/** The tag that says the notice went out for this phone. */
export function joinNoticeTag(phone) {
  return EMAIL_JOIN_TAG.NOTICE + str(phone).trim();
}

/** Has the notice for this phone been sent already? (Any way of writing the same number.) */
export function noticeSentFor(tags, phone) {
  return list(tags).map(String).some((t) => t.startsWith(EMAIL_JOIN_TAG.NOTICE) && samePhone(t.slice(EMAIL_JOIN_TAG.NOTICE.length), phone));
}

/** '+447415748167' -> '8167'. '' when there are fewer than 4 digits. */
export function lastFour(phone) {
  const d = str(phone).replace(/\D/g, '');
  return d.length >= 4 ? d.slice(-4) : '';
}

/**
 * The ONLY reader of customer-join-notice's body. customer_id is the profile that took the phone;
 * source_id (optional) is the empty profile the merge core folded into it; location_id is the
 * venue the till is at.
 */
export function validateNoticeRequest(body) {
  const b = body && typeof body === 'object' ? body : {};
  if (!isUuid(b.customer_id)) return { ok: false, error: 'customer_id must be a customer id' };
  if (!isUuid(b.location_id)) return { ok: false, error: 'location_id must be the venue the call is made from' };
  const src = b.source_id == null || b.source_id === '' ? null : b.source_id;
  if (src !== null && !isUuid(src)) return { ok: false, error: 'source_id must be a customer id' };
  return { ok: true, customerId: b.customer_id, locationId: b.location_id, sourceId: src };
}

/**
 * May the notice go? Only for a live profile of the venue's organisation, with an email to write
 * to and a phone, whose tags show an automatic join for THAT phone, and only once per phone.
 * The join is proved by data a join writes, never by the caller's word:
 *   * the till's own trail on the profile (`email_join:<phone>`), or
 *   * the merge core's trail: the folded in profile (source) points at this one (`merged_into:`),
 *     is soft deleted, and handed over this very phone (`merge_phone:`).
 * @returns {{ ok: true, phone: string, tag: string } | { ok: false, code: string }}
 */
export function decideJoinNotice({ customer, source = null, venueOrgId = null } = {}) {
  const c = customer;
  if (!c || c.deleted_at) return { ok: false, code: 'not_found' };
  if (!venueOrgId || String(c.org_id) !== String(venueOrgId)) return { ok: false, code: 'other_org' };
  if (!has(c.email)) return { ok: false, code: 'no_email' };
  const phone = has(c.phone) ? str(c.phone).trim() : '';
  if (!phone) return { ok: false, code: 'no_phone' };
  const byTill = emailJoinPhones(c.tags).some((p) => samePhone(p, phone));
  const byMerge = !!source
    && !!source.deleted_at
    && String(source.org_id) === String(c.org_id)
    && mergedIntoOf(source.tags) === String(c.id)
    && samePhone(tagValue(source.tags, MERGE_TAG.PHONE), phone);
  if (!byTill && !byMerge) return { ok: false, code: 'not_joined' };
  if (noticeSentFor(c.tags, phone)) return { ok: false, code: 'already_sent' };
  return { ok: true, phone, tag: joinNoticeTag(phone) };
}

/** The venue's name for a sentence: spaces squeezed, '' when there is none. */
export function noticeVenueName(opsName, platformName) {
  const clean = (v) => str(v).replace(/\s+/g, ' ').trim();
  return clean(opsName) || clean(platformName) || '';
}

/**
 * Peter's words (27 Sep 2026): "Your <venue> stamps and points are now linked to your phone ending
 * 8167. If this wasn't you, reply to this email or tell staff."
 */
export function joinNoticeMessage({ venueName = '', phone = '' } = {}) {
  const venue = str(venueName).trim();
  const four = lastFour(phone);
  const whose = venue ? `Your ${venue} stamps and points` : 'Your stamps and points';
  const ending = four ? `your phone ending ${four}` : 'your phone';
  return {
    subject: venue ? `Your ${venue} loyalty is now linked to your phone` : 'Your loyalty is now linked to your phone',
    text: `${whose} are now linked to ${ending}. If this wasn't you, reply to this email or tell staff.`,
  };
}

/** Text made safe to put inside HTML. */
export function escapeHtml(s) {
  return str(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

