// supabase/functions/_shared/portalEmailJoin.js
//
// THE PORTAL JOINS A MEMBER TO THEIR OLD PROFILE BY EMAIL, BY ITSELF (27 Sep 2026).
//
// WHY. 1,357 Coffee Boy members came in from 5Loyalty with an email and NO phone. When one of
// them signs up in the customer portal, loyalty-otp finds nobody with that phone (it matches on
// the phone only, on purpose) and makes a blank profile. Saving their email on it then clashed
// with the imported profile on the unique email index, so their stamps and points stayed out of
// reach. Ela Stettner and Simon Hughes were joined by hand that day. Peter, 27 Sep 2026: "I don't
// want a merge tool, I want it so when someone signs up it auto merges their records, matches
// them as long as they use the same email, it knows the record exists and just adds them
// together."
//
// So when a signed in member (phone proven with the one time code) saves an email that is on
// ANOTHER profile of the business with no phone, loyalty-otp update_profile folds the two
// together with the merge core (customerMergePlan.js decides, customerMergeRun.js does it; the
// profile with the history is kept, normally the imported one), moves the proven phone onto it
// and signs the member in to the joined account.
//
// THE SAFEGUARDS (none of them asks the member for anything):
//   1. Only INTO a profile with no phone, or with this very phone. A profile holding a different
//      phone is never joined: a phone is how a member signs in.
//   2. The exact email, case aside, in the same business, on exactly one live profile. The ilike
//      escapes % and _ (exactIlike): 353 live Coffee Boy emails hold one, and both are wildcards.
//   3. One short notice to the email's owner once the join is done ("If this wasn't you ..."),
//      claimed by a tag so a retry does not send it again. A failed send never undoes the join.
//   4. Gift cards stay on the phone proven with the code (18 Sep 2026). The joined session carries
//      that same phone, so the join adds no other way to see a gift card code.
//   5. The core's tags record the join on both profiles (merged_into:, merged:, merge_phone:),
//      and JOIN_TAG.VIA on the folded in profile says the portal signed a member in to the joined
//      account (JOIN_TAG.NOTICE that the notice went), so it can be traced and undone by hand.
//   6. One automatic join per account. A profile that already had another profile folded into it
//      (a merged: tag) is not joined again by typing yet another email: without this, one proven
//      phone could gather every phoneless member whose email somebody knows, one save at a time.
//      A real second join still happens in Back Office (customer-merge), by staff.
//
// Pure decisions at the top, so node tests drive every rule. runPortalJoin at the bottom takes
// the two service clients (never HTTP: the service role runs the core directly), so
// src/lib/portalEmailJoin.test.js runs it against the in memory databases.

import {
  samePhone, isBlankName, exactIlike, union, mergedIntoOf, MERGE_TAG, planMerge,
} from './customerMergePlan.js';
import { readMergeFacts, applyMerge } from './customerMergeRun.js';

// ── small pure helpers ──────────────────────────────────────────────────────

const str = (v) => (v == null ? '' : String(v));
const clean = (v) => str(v).trim();
const has = (v) => clean(v) !== '';
const lower = (v) => clean(v).toLowerCase();
const arr = (v) => (Array.isArray(v) ? v : []);
/** A venue name for a sentence: one space between words, "Coffee Boy - Leeds" as "Coffee Boy Leeds" (welcomeLink.js does the same). */
const venueWords = (v) => str(v).replace(/\s+/g, ' ').replace(/\s+-\s+/g, ' ').trim();

/** Good enough to be somebody's address; anything else is saved as typed, never joined on. */
const LOOKS_LIKE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The customers columns the join reads for the member and for whoever holds the email. */
export const JOIN_MEMBER_COLS = 'id, org_id, name, email, phone, phone_raw, birthday, marketing_opt_in, tags, deleted_at';

/** Tags this join adds to the folded in profile, next to the core's own. */
export const JOIN_TAG = Object.freeze({
  VIA: 'merge_via:portal_email',   // the portal signed a member in to this joined account
  NOTICE: 'merge_notice_sent',     // the email's owner has been sent the notice (claimed before sending)
});

/** What the portal shows, in plain words. The other details the member typed are always saved. */
export const JOIN_MESSAGES = Object.freeze({
  joined: 'We found your stamps and points under that email and added them to this account.',
  email_in_use: 'That email is already on another loyalty account with a different phone number, so it was not added here. Your other details are saved. If both accounts are yours, ask staff to join them.',
  several_owners: 'That email is on more than one loyalty account here, so it was not added. Your other details are saved. Ask staff to join them.',
  already_joined: 'That email is on another loyalty account. This account has already been joined with one, so ask staff to join that one too. Your other details are saved.',
  sign_in_again: 'Please sign in again with your phone to add that email. Your other details are saved.',
  not_linked: 'That email is on another loyalty account that could not be joined to this one here. Your other details are saved. Ask staff to help.',
  join_incomplete: 'We found your account for that email but could not finish joining it just now. Your other details are saved. Press Save again in a moment.',
  email_not_saved: 'That email could not be saved just now. Your other details are saved. Press Save again in a moment.',
  signed_out: 'Please sign in again with your phone number.',
});

/** The words for a code (JOIN_MESSAGES), or the fallback's words for a code it does not know. */
export function joinMessage(code, fallback = 'not_linked') {
  const m = /** @type {Record<string, string>} */ (JOIN_MESSAGES);
  return m[String(code)] || m[fallback] || m.not_linked;
}

/** Has another profile been folded into this one (the core's merged:<id> tag)? */
export function hasJoinedBefore(tags) {
  return arr(tags).some((t) => String(t).startsWith(MERGE_TAG.FROM));
}

/** Does this profile hold the proven phone (its phone, or its raw form when it has no phone)? */
export function holdsPhone(c, provenPhone) {
  if (!c || !has(provenPhone)) return false;
  const mine = has(c.phone) ? c.phone : c.phone_raw;
  return has(mine) && samePhone(mine, provenPhone);
}

/**
 * The profile a signed in member's own profile was folded into, or null. The session still names
 * the folded in profile when a join stopped part way (or staff merged it in Back Office); the next
 * save finishes that join and moves the session instead of writing to a deleted row.
 */
export function foldedInto(member) {
  if (!member?.deleted_at) return null;
  return mergedIntoOf(member.tags);
}

/** The live customers of the business holding this email, exactly (case aside). */
export function emailOwnersQuery(ops, orgId, email) {
  return ops.from('customers').select(JOIN_MEMBER_COLS)
    .eq('org_id', orgId).is('deleted_at', null).ilike('email', exactIlike(email)).limit(5);
}

// ── the decision ────────────────────────────────────────────────────────────

/**
 * What update_profile does with a typed email.
 *   'save'   the email is the member's own, free, or not an email: saved on the member as typed;
 *   'join'   it is on exactly one other live profile of the business with no phone (or this
 *            phone): fold the two together (ownerId is that profile);
 *   'refuse' it stays off this account (code says why, JOIN_MESSAGES says it in words); the
 *            member's other details are still saved.
 * @param {{ member: object|null, provenPhone: string|null, email: unknown, owners?: object[] }} f
 *   member: the signed in member's customers row (JOIN_MEMBER_COLS); owners: live rows of the
 *   member's organisation holding the email (emailOwnersQuery).
 * @returns {{ action: 'save'|'join'|'refuse', code: string, ownerId?: string }}
 */
export function decideEmailJoin({ member, provenPhone, email, owners = [] }) {
  const want = lower(email);
  if (!want || !LOOKS_LIKE_EMAIL.test(want)) return { action: 'save', code: 'not_an_email' };
  if (!member?.id) return { action: 'save', code: 'no_member' };
  if (lower(member.email) === want) return { action: 'save', code: 'own_email' };
  const others = arr(owners).filter((o) => o?.id
    && String(o.id) !== String(member.id)
    && !o.deleted_at
    && lower(o.email) === want
    && has(member.org_id) && String(o.org_id) === String(member.org_id));
  if (others.length === 0) return { action: 'save', code: 'free' };
  if (others.length > 1) return { action: 'refuse', code: 'several_owners' };
  const owner = others[0];
  // Safeguard 1: a profile holding another phone is somebody else's login. Every phone form it
  // holds must be this one.
  const ownerPhones = [owner.phone, owner.phone_raw].filter(has);
  if (ownerPhones.some((p) => !samePhone(p, provenPhone))) return { action: 'refuse', code: 'email_in_use' };
  // The member must be signed in with a proven phone, and their own profile must still hold it
  // (the phone is what moves onto the joined profile, and what the new session carries).
  const memberPhones = [member.phone, member.phone_raw].filter(has);
  if (!has(provenPhone) || member.deleted_at || !memberPhones.length || memberPhones.some((p) => !samePhone(p, provenPhone))) {
    return { action: 'refuse', code: 'sign_in_again' };
  }
  if (hasJoinedBefore(member.tags)) return { action: 'refuse', code: 'already_joined' };
  return { action: 'join', code: 'join', ownerId: String(owner.id) };
}

// ── after the join: the details the member typed, where the kept profile has none ──

/**
 * The member's typed name, birthday and marketing yes, onto the kept profile only where it is
 * empty. An imported name is never replaced (not even by a longer one: the core keeps the
 * survivor's name, and so does this); a blank one takes the typed name. A typed "no" to marketing
 * never switches off a "yes" the kept profile already had.
 */
export function fillBlanksPatch(survivor, typed = {}) {
  const patch = {};
  if (!survivor) return patch;
  const name = typeof typed.name === 'string' ? typed.name.trim() : '';
  if (!isBlankName(name) && isBlankName(survivor.name)) patch.name = name;
  if (typeof typed.birthday === 'string' && has(typed.birthday) && !has(survivor.birthday)) patch.birthday = typed.birthday;
  if (typed.marketing_opt_in === true && !survivor.marketing_opt_in) patch.marketing_opt_in = true;
  return patch;
}

/**
 * The typed email onto the kept profile, or null to leave it. Normally the kept profile already
 * has it (it is the one the email was found on). When the member's OWN profile is kept (it had
 * history and is older) and held another email, the core keeps that one; the member typed this one
 * to replace it, exactly as a plain save would.
 */
export function emailAfterJoin(survivor, typedEmail, { memberIsSurvivor = false } = {}) {
  const want = clean(typedEmail);
  if (!survivor || !want || !LOOKS_LIKE_EMAIL.test(want.toLowerCase())) return null;
  if (lower(survivor.email) === want.toLowerCase()) return null;
  if (!has(survivor.email) || memberIsSurvivor) return want;
  return null;
}

// ── the notice to the email's owner ─────────────────────────────────────────

/** '+447415748167' -> '8167' ('' when there are not four digits). */
export function phoneEnding(phone) {
  const d = str(phone).replace(/\D/g, '');
  return d.length >= 4 ? d.slice(-4) : '';
}

const escapeHtml = (s) => str(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * The one notice (safeguard 3), in Peter's words (27 Sep 2026): "Your <venue> stamps and points
 * are now linked to your phone ending 8167. If this wasn't you, reply to this email or tell staff."
 * Only the last four digits: the email may not be the member's. The HTML is the plain branded
 * card the welcome uses (Ink header, the venue's name), with every value escaped.
 */
export function joinNotice({ venueName, provenPhone }) {
  const venue = venueWords(venueName);
  const ending = phoneEnding(provenPhone);
  const whose = venue ? `Your ${venue} stamps and points` : 'Your loyalty stamps and points';
  const phoneWords = ending ? `your phone ending ${ending}` : 'a phone number';
  const text = `${whose} are now linked to ${phoneWords}. If this wasn't you, reply to this email or tell staff.`;
  const subject = venue ? `Your ${venue} loyalty account is now linked to your phone` : 'Your loyalty account is now linked to your phone';
  const header = venue
    ? `<tr><td style="background:#0F1211;padding:24px;text-align:center;"><div style="color:#E9ECEA;font-size:18px;font-weight:700;">${escapeHtml(venue)}</div></td></tr>`
    : '';
  const html = '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>'
    + '<body style="margin:0;padding:0;background:#F5F7F4;font-family:\'Space Grotesk\',system-ui,-apple-system,sans-serif;">'
    + '<table width="100%" cellpadding="0" cellspacing="0" style="background:#F5F7F4;padding:40px 20px;"><tr><td align="center">'
    + '<table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#fff;border-radius:14px;overflow:hidden;border:1px solid rgba(15,18,17,0.08);">'
    + header
    + `<tr><td style="padding:28px 24px;"><p style="margin:0;color:#0F1211;font-size:15px;line-height:1.6;">${escapeHtml(text)}</p></td></tr>`
    + '</table></td></tr></table></body></html>';
  return { subject, text, html };
}

/**
 * The provider request for one email, exactly as send-welcome and send-receipt make it
 * (RECEIPT_EMAIL_PROVIDER: resend or postmark; anything else, or no key, sends nothing: 'log').
 * Returns null when nothing is to be sent. `sender` is resolveSenderForOrg's { from, replyTo }.
 */
export function providerEmailRequest({ provider, resendKey, postmarkKey, sender, to, subject, html, text }) {
  const p = lower(provider);
  if (!has(to) || !sender?.from) return null;
  if (p === 'resend' && has(resendKey)) {
    return {
      url: 'https://api.resend.com/emails',
      headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
      body: { from: sender.from, to: [to], subject, html, text, ...(sender.replyTo ? { reply_to: sender.replyTo } : {}) },
    };
  }
  if (p === 'postmark' && has(postmarkKey)) {
    return {
      url: 'https://api.postmarkapp.com/email',
      headers: { 'X-Postmark-Server-Token': postmarkKey, 'Content-Type': 'application/json' },
      body: { From: sender.from, To: to, Subject: subject, HtmlBody: html, TextBody: text, ...(sender.replyTo ? { ReplyTo: sender.replyTo } : {}) },
    };
  }
  return null;
}

// ── which venue the member is on ────────────────────────────────────────────

/**
 * The venue for the notice and the welcome: the portal's own venue when it belongs to the
 * member's company (Platform locations rows: id, name, ops_location_id), else the company's first
 * venue. A location the member names from another company is ignored, never trusted.
 * @returns {{ opsLocationId: string|null, platformName: string }}
 */
export function pickPortalVenue(rows, requested) {
  const list = arr(rows).filter((r) => r && has(r.ops_location_id));
  const want = clean(requested);
  const pick = (want && list.find((r) => String(r.ops_location_id) === want || String(r.id) === want)) || list[0] || null;
  return { opsLocationId: pick ? String(pick.ops_location_id) : null, platformName: pick ? venueWords(pick.name) : '' };
}

/** The venue name in the notice: the Ops name, else the Platform name, else nothing. */
export function portalVenueName(opsName, platformName) {
  return venueWords(opsName) || venueWords(platformName);
}

// ── the join itself ─────────────────────────────────────────────────────────

/**
 * Fold the member's profile and the email's owner together, then fill the kept profile's blanks
 * from what the member typed and claim the notice. Safe to run again: the core resumes a join
 * that stopped part way and never counts a stamp or a point twice; the fill only fills what is
 * still empty; the notice is claimed once.
 *
 * The session is only handed to the kept profile when it HOLDS the proven phone afterwards
 * (ok true). If the phone could not move (somebody else took it meanwhile), ok is false.
 * `memberFolded` then says whether the member's own profile was folded in (the session names a
 * deleted row, so the member signs in again) or is still theirs.
 *
 * @param {{ ops: any, platform: any }} clients service role clients
 * @param {{ memberId: string, ownerId: string, provenPhone: string|null, typed?: any, now: string }} args
 *   ownerId: the email's owner, or (finishing a join) the profile the member's was folded into.
 */
export async function runPortalJoin(clients, { memberId, ownerId, provenPhone, typed = {}, now }) {
  const { ops } = clients;
  let facts;
  try {
    // The owner is named as the one kept; the plan still decides (the profile with history).
    facts = await readMergeFacts(clients, { targetId: ownerId, sourceId: memberId });
  } catch (e) {
    return { ok: false, code: 'join_incomplete', step: e?.step || 'read' };
  }
  const plan = planMerge({ ...facts, now, phoneChoice: null });
  if (!plan.ok) return { ok: false, code: 'not_linked', refusals: plan.refusals, memberFolded: false };
  const owner = facts.a;   // readMergeFacts: a is the targetId row, the email's owner
  const memberFolded = String(plan.source_id) === String(memberId);

  let applied;
  try {
    applied = await applyMerge(clients, plan);
  } catch (e) {
    return { ok: false, code: 'join_incomplete', step: e?.step || 'apply', done: e?.done || [] };
  }

  const read = await ops.from('customers').select(JOIN_MEMBER_COLS).eq('id', plan.target_id).maybeSingle();
  if (read?.error || !read?.data) return { ok: false, code: 'join_incomplete', step: 'read_survivor' };
  let survivor = read.data;
  if (survivor.deleted_at || !holdsPhone(survivor, provenPhone)) {
    return { ok: false, code: 'not_linked', warnings: plan.warnings, survivorId: String(survivor.id), memberFolded };
  }

  const patch = fillBlanksPatch(survivor, typed);
  if (Object.keys(patch).length) {
    const up = await ops.from('customers').update({ ...patch, updated_at: now }).eq('id', survivor.id).is('deleted_at', null);
    if (!up?.error) survivor = { ...survivor, ...patch };
  }
  // Written on its own: a clash on the email index must not lose the name and birthday above.
  const email = emailAfterJoin(survivor, typed.email, { memberIsSurvivor: String(survivor.id) === String(memberId) });
  if (email) {
    const up = await ops.from('customers').update({ email, updated_at: now }).eq('id', survivor.id).is('deleted_at', null);
    if (!up?.error) survivor = { ...survivor, email };
  }

  // Claim the notice on the folded in profile before it is sent: a retry finds the tag and sends
  // nothing. A claim that cannot be read still sends (the owner hearing twice beats never
  // hearing). VIA says the portal signed a member in to this joined account; it is written with
  // the claim by whichever call finishes the join (a join that stopped part way is finished by a
  // resume, and must still say so). The core's own tags remain the record of what moved.
  let notify = true;
  const src = await ops.from('customers').select('id, tags').eq('id', plan.source_id).maybeSingle();
  if (!src?.error && src?.data) {
    const tags = arr(src.data.tags);
    notify = !tags.includes(JOIN_TAG.NOTICE);
    const add = [JOIN_TAG.VIA, JOIN_TAG.NOTICE].filter((t) => !tags.includes(t));
    if (add.length) await ops.from('customers').update({ tags: union(tags, add) }).eq('id', plan.source_id);
  }

  return {
    ok: true,
    mode: plan.mode,
    survivorId: String(plan.target_id),
    sourceId: String(plan.source_id),
    survivor,
    warnings: plan.warnings,
    steps: applied.steps,
    stayed: applied.stayed,
    notify,
    noticeTo: has(owner?.email) ? clean(owner.email) : null,
  };
}

// ── update_profile, start to finish ─────────────────────────────────────────

/**
 * What loyalty-otp update_profile does with a signed in member's save, with the service clients
 * (it calls exactly this, so src/lib/portalEmailJoin.test.js drives the real order of writes):
 *   1. the member's profile was folded into another (a join that stopped part way, or staff merged
 *      it): finish that join and hand the session over; never write to the deleted row;
 *   2. everything but the email is saved on the member, always;
 *   3. the email: saved, joined (the member's profile and the email's owner become one), or kept
 *      off the account with a reason. The email never fails the whole save.
 *
 * @param {{ ops: any, platform: any }} clients service role clients
 * @param {{ sessionCustomerId: string, provenPhone: string|null, updates?: Record<string, any>, typedEmail?: string|null, now: string }} args
 *   updates: name, birthday, marketing_opt_in as update_profile read them; typedEmail: the trimmed
 *   email box ('' clears it), or null when the save did not send one.
 * @returns {Promise<{ kind: 'joined'|'saved'|'signed_out'|'failed', join?: any, emailCode?: string|null, error?: any, member?: any }>}
 *   joined: join is runPortalJoin's answer (ok); saved: emailCode says why the email stayed off
 *   (null when it was saved or not sent); signed_out: the session names a profile that is gone;
 *   failed: the other details could not be saved (error).
 */
export async function saveMemberProfile(clients, { sessionCustomerId, provenPhone, updates = {}, typedEmail = null, now }) {
  const { ops } = clients;
  const typed = { ...updates, email: typedEmail };
  const read = await ops.from('customers').select(JOIN_MEMBER_COLS).eq('id', sessionCustomerId).maybeSingle();
  const member = read?.error ? null : (read?.data ?? null);

  const join = async (memberId, ownerId) => {
    const joined = await runPortalJoin(clients, { memberId, ownerId, provenPhone, typed, now });
    if (joined.ok) return { kind: 'joined', join: joined, member };
    // Folded in, but the phone could not follow (somebody else holds it now): the session names a
    // deleted profile, so the member signs in again and verify finds whoever holds the phone. A
    // join that stopped part way finishes on the next save instead (step 1 above).
    if (joined.code !== 'join_incomplete') {
      const after = await ops.from('customers').select('deleted_at').eq('id', memberId).maybeSingle();
      if (after?.data?.deleted_at) return { kind: 'signed_out', join: joined, member };
    }
    return { kind: 'saved', emailCode: joined.code, join: joined, member };
  };

  // 1. A session whose profile was folded into another one. Without a proven phone nothing can move.
  if (member?.deleted_at) {
    const into = foldedInto(member);
    if (into && has(provenPhone)) return join(String(member.id), into);
    return { kind: 'signed_out', member };
  }

  // 2. Everything but the email, always saved.
  if (Object.keys(updates).length) {
    const up = await ops.from('customers').update(updates).eq('id', sessionCustomerId);
    if (up?.error) return { kind: 'failed', error: up.error, member };
  }

  // 3. The email.
  if (typedEmail === null || typedEmail === undefined) return { kind: 'saved', emailCode: null, member };
  let decision = { action: 'save', code: 'cleared' };
  if (clean(typedEmail)) {
    const owners = has(member?.org_id) ? await emailOwnersQuery(ops, member.org_id, typedEmail) : { data: [], error: null };
    // A failed read is never "nobody has it": the email waits for the next save.
    decision = owners?.error
      ? { action: 'refuse', code: 'email_not_saved' }
      : decideEmailJoin({ member, provenPhone, email: typedEmail, owners: owners?.data || [] });
  }
  if (decision.action === 'join') return join(String(member.id), decision.ownerId);
  if (decision.action === 'refuse') return { kind: 'saved', emailCode: decision.code, member };
  if (decision.code === 'own_email' && typedEmail === member?.email) return { kind: 'saved', emailCode: null, member };
  const em = await ops.from('customers').update({ email: clean(typedEmail) || null }).eq('id', sessionCustomerId);
  // Taken between the check and the save (the unique email index): the next save sees the owner
  // and decides again.
  if (em?.error) return { kind: 'saved', emailCode: 'email_not_saved', error: em.error, member };
  return { kind: 'saved', emailCode: null, member };
}
