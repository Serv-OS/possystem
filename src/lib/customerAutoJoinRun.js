// src/lib/customerAutoJoinRun.js
//
// THE TILL'S CUSTOMER READS AND WRITES (27 Sep 2026). lib/customerAutoJoin.js decides; this file
// talks to the database through the Supabase client it is GIVEN (the store passes its own), to
// customer-merge through the function it is given, and to customer-join-notice through another.
// No client import, no import.meta, no store, so node tests run every path against a fake
// database with the live unique indexes (src/lib/customerAutoJoinRun.test.js).
//
// TWO KINDS OF WRITE, kept apart on purpose:
//   * upsertCustomerRow: EVERY save (the forms, order close, allergens, bookings, the Orders Hub).
//     PHONE ONLY, as it always was: an email never finds a profile here. New: an email another
//     profile holds is left off and the rest is saved, so a clash never loses the name, the
//     allergy list or the visit (Ela Stettner's "DB error", 26 Sep 2026).
//   * autoJoinCustomer: ONLY the two interactive forms where staff typed the phone and the email
//     (components/CustomerModal.jsx, surfaces/mpos/MCustomerCapture.jsx), with an email typed in
//     that form. Peter, 27 Sep 2026: "when someone signs up it auto merges their records, matches
//     them as long as they use the same email". No question to staff.

import { withTimeout } from './withTimeout.js';
import { uniqueClashOf, mergeRequestBody } from './customerMerge.js';
import {
  AUTO_JOIN_COLS, looksLikeEmail, emailSearchPattern, exactEmailRows, emailIsNew, phoneVariants,
  decideAutoJoin, joinAllowed, mergeOutcome, linkedToast, apartToast, customerAfterJoin, realName,
} from './customerAutoJoin.js';
import { isBlankName } from '../../supabase/functions/_shared/customerMergePlan.js';
import { emailJoinTags } from '../../supabase/functions/_shared/emailJoinNotice.js';

/** How long Confirm waits for the check (two reads). A slow check is no join, never a held order. */
export const CHECK_TIMEOUT_MS = 6000;
/** How long Confirm waits for a join (the phone written, or customer-merge's preview and merge). */
export const WRITE_TIMEOUT_MS = 20000;

const str = (v) => (v == null ? '' : String(v));
const stamp = (now) => now || new Date().toISOString();
const isTimeout = (e) => e?.code === 'TIMEOUT' || e?.name === 'TimeoutError';

// ── every save: phone only ──────────────────────────────────────────────────

/** The live profile holding this phone, or null. */
async function phoneOwnerId(db, orgId, phoneN) {
  const { data } = await db.from('customers').select('id')
    .eq('org_id', orgId).eq('phone', phoneN).is('deleted_at', null).maybeSingle();
  return data?.id || null;
}

/**
 * Persist a customer by PHONE. Returns the profile's id (or null). The phone wins on conflict; a
 * name or email the profile already has stands (only blanks are filled); an allergy list passed
 * in replaces the profile's (staff chose the exact set, v4.6.67).
 *
 * 27 Sep 2026: an email another profile holds (the unique index on lower(email)) used to fail the
 * WHOLE write: an update lost the name and allergy list with it, and an insert returned null, so
 * the order was never counted. Now the email is left off and everything else is saved. This never
 * looks the email up to find a profile; only autoJoinCustomer below does, and only for the forms.
 * A new profile that lost a race for its phone (another till made it a moment ago) is that
 * profile, so its id comes back instead of null.
 */
export async function upsertCustomerRow({ db, orgId, c, phoneN, now = null }) {
  const at = stamp(now);
  const row = {
    org_id: orgId,
    phone: phoneN,
    phone_raw: c.phone || phoneN,
    email: c.email || null,
    name: c.name || 'Customer',
    notes: c.notes || null,
    marketing_opt_in: !!c.marketingOptIn,
    marketing_opt_in_at: c.marketingOptIn ? at : null,
    // v4.6.67: allergens carried through. Caller decides whether to include them.
    allergens: Array.isArray(c.allergens) ? c.allergens : undefined,
    updated_at: at,
  };
  const { data: existing, error: lookupErr } = await db.from('customers')
    .select('id, name, email, marketing_opt_in, allergens')
    .eq('org_id', orgId).eq('phone', phoneN).is('deleted_at', null).maybeSingle();
  if (lookupErr) {
    console.warn('[upsertCustomer] lookup failed:', lookupErr.message, '(may be RLS: check customers SELECT policy)');
  }
  if (existing?.id) {
    const patch = { updated_at: row.updated_at };
    if (!existing.name && row.name) patch.name = row.name;
    if (!existing.email && row.email) patch.email = row.email;
    if (row.marketing_opt_in && !existing.marketing_opt_in) {
      patch.marketing_opt_in = true;
      patch.marketing_opt_in_at = row.marketing_opt_in_at;
    }
    // v4.6.67: replace allergens array if caller passed one (explicit save
    // from the toast / detail page). Don't merge: operator decides exact set.
    if (Array.isArray(row.allergens)) patch.allergens = row.allergens;
    if (Object.keys(patch).length > 1) {
      const { error: updErr } = await db.from('customers').update(patch).eq('id', existing.id);
      if (updErr && 'email' in patch && uniqueClashOf(updErr) === 'email') {
        const rest = { ...patch };
        delete rest.email;
        console.info('[upsertCustomer] that email is on another profile: saved without it');
        if (Object.keys(rest).length > 1) {
          const { error: again } = await db.from('customers').update(rest).eq('id', existing.id);
          if (again) console.warn('[upsertCustomer] update without the email failed:', again.message);
        }
      } else if (updErr) {
        console.warn('[upsertCustomer] update existing failed:', updErr.message);
      }
    }
    return existing.id;
  }
  const { data: created, error } = await db.from('customers').insert(row).select('id').single();
  if (!error) return created?.id || null;
  const field = uniqueClashOf(error);
  if (field === 'email' && row.email) {
    console.info('[upsertCustomer] that email is on another profile: saved without it');
    const { data: alone, error: again } = await db.from('customers').insert({ ...row, email: null }).select('id').single();
    if (!again) return alone?.id || null;
    if (uniqueClashOf(again) === 'phone') return phoneOwnerId(db, orgId, phoneN);
    console.warn('[upsertCustomer] insert without the email failed:', again.message);
    return null;
  }
  if (field === 'phone') return phoneOwnerId(db, orgId, phoneN);
  console.warn('[upsertCustomer] insert failed:', error.message, '(may be RLS: check customers INSERT policy)');
  return null;
}

// ── the forms only: the check ───────────────────────────────────────────────

/**
 * READS ONLY. The live profiles holding this number (any of the ways it is stored) and the ones
 * holding exactly this email. { ok: false } when either read fails: the form then saves phone
 * only, which leaves a clashing email off by itself.
 */
export async function readAutoJoinFacts({ db, orgId, phoneN, typedPhone = '', email }) {
  const e = str(email).trim();
  if (!orgId || !phoneN || !looksLikeEmail(e)) return { ok: false, code: 'nothing_to_check' };
  const variants = phoneVariants(phoneN, typedPhone);
  if (!variants.length) return { ok: false, code: 'nothing_to_check' };
  const orPhone = variants.flatMap((v) => [`phone.eq.${v}`, `phone_raw.eq.${v}`]).join(',');
  const [p, m] = await Promise.all([
    db.from('customers').select(AUTO_JOIN_COLS).eq('org_id', orgId).is('deleted_at', null).or(orPhone).limit(10),
    db.from('customers').select(AUTO_JOIN_COLS).eq('org_id', orgId).is('deleted_at', null).ilike('email', emailSearchPattern(e)).limit(5),
  ]);
  if (p?.error || m?.error) {
    console.warn('[customer join] read failed:', p?.error?.message || m?.error?.message);
    return { ok: false, code: 'read_failed' };
  }
  const phoneRows = Array.isArray(p.data) ? p.data : [];
  const phoneHit = phoneRows.find((r) => str(r.phone) === phoneN) || null;
  return {
    ok: true,
    phoneHit,
    phoneOthers: phoneRows.filter((r) => r !== phoneHit),
    emailHits: exactEmailRows(m.data, e),
  };
}

// ── the forms only: (a) the phone goes on the email's profile ───────────────

/**
 * Gives the profile found by email this phone, and only while it is exactly as the check read it
 * (phone and phone_raw as seen, which the decision found empty, the same email, the same name
 * when an empty one is filled): a phone is a loyalty login, so one is never overwritten, not
 * even by a second till at the same moment. The same statement writes the join's trail
 * (email_join tags) so it can be traced and undone by hand.
 * Returns { ok, outcome: 'claimed' | 'changed' | 'phone_taken' | 'failed' }.
 */
export async function claimPhoneForProfile({ db, orgId, holder, phoneN, phoneRaw = null, rawOnly = false, typedName = '', now = null }) {
  const blank = (v) => v == null || str(v).trim() === '';
  if (!orgId || !holder?.id || !phoneN) return { ok: false, outcome: 'failed' };
  if (!blank(holder.phone)) return { ok: false, outcome: 'changed' };
  if (!rawOnly && !blank(holder.phone_raw)) return { ok: false, outcome: 'changed' };
  const at = stamp(now);
  const patch = rawOnly ? { phone: phoneN } : { phone: phoneN, phone_raw: str(phoneRaw).trim() || phoneN };
  patch.tags = emailJoinTags(holder.tags, phoneN, at);
  patch.updated_at = at;
  const fill = isBlankName(holder.name) ? realName(typedName) : '';
  if (fill) patch.name = fill;
  const exactly = (q, col, v) => (v == null ? q.is(col, null) : q.eq(col, v));
  let q = db.from('customers').update(patch).eq('id', holder.id).eq('org_id', orgId).is('deleted_at', null);
  q = exactly(q, 'phone', holder.phone ?? null);
  q = exactly(q, 'phone_raw', holder.phone_raw ?? null);
  q = exactly(q, 'email', holder.email ?? null);
  if (fill) q = exactly(q, 'name', holder.name ?? null);
  const { data, error } = await q.select('id');
  if (error) {
    if (uniqueClashOf(error) === 'phone') return { ok: false, outcome: 'phone_taken' };
    console.warn('[customer join] adding the phone failed:', error.code, error.message);
    return { ok: false, outcome: 'failed' };
  }
  if (!Array.isArray(data) || !data.length) return { ok: false, outcome: 'changed' };
  return { ok: true, outcome: 'claimed', id: holder.id };
}

// ── the forms only: (b) the empty phone profile is folded into the email's ──

/**
 * customer-merge decides (a till may only fold in an empty profile, and that rule is the one that
 * counts). The till asks for the preview first and goes on only when it says the empty profile is
 * folded into the EMAIL's profile. Stopped part way: the same request is sent once more; a merge
 * resumes and never counts twice.
 * Returns { ok, outcome: 'merged' | 'retry' | 'refused', survivor, survivorId }.
 */
export async function joinShellIntoProfile({ postMerge, locId, sourceId, targetId }) {
  const ids = { sourceId, targetId };
  const pv = await postMerge(mergeRequestBody({ action: 'preview', targetId, sourceId, locationId: locId }));
  if (!joinAllowed(pv?.body, ids)) {
    console.warn('[customer join] customer-merge preview did not allow the join:', pv?.status || 0, pv?.body?.code || '', pv?.body?.error || '');
    return { ok: false, outcome: 'refused', survivor: null, survivorId: null };
  }
  const body = mergeRequestBody({ action: 'merge', targetId, sourceId, locationId: locId });
  let r = await postMerge(body);
  if (mergeOutcome(r?.status, r?.body) === 'retry') r = await postMerge(body);
  const outcome = mergeOutcome(r?.status, r?.body);
  if (outcome !== 'merged') {
    console.warn('[customer join] customer-merge did not join them:', r?.status || 0, r?.body?.code || '', r?.body?.error || '');
  }
  return {
    ok: outcome === 'merged',
    outcome,
    survivor: r?.body?.survivor || null,
    survivorId: r?.body?.survivor_id || null,
  };
}

/**
 * After customer-merge joined them: the kept profile carries the email_join trail too (the core's
 * own merged: tag says what was folded in; this says it was an email match at a till), and an
 * empty name is filled from the form. Best effort: the join is done whatever this does.
 */
export async function markEmailJoin({ db, orgId, id, phoneN, typedName = '', now = null }) {
  const { data: row, error } = await db.from('customers').select('id, name, tags')
    .eq('id', id).eq('org_id', orgId).is('deleted_at', null).maybeSingle();
  if (error || !row) return false;
  const at = stamp(now);
  const patch = { tags: emailJoinTags(row.tags, phoneN, at), updated_at: at };
  const fill = isBlankName(row.name) ? realName(typedName) : '';
  if (fill) patch.name = fill;
  let q = db.from('customers').update(patch).eq('id', id).eq('org_id', orgId).is('deleted_at', null);
  if (fill) q = row.name == null ? q.is('name', null) : q.eq('name', row.name);
  const { error: e2 } = await q;
  if (e2) console.warn('[customer join] recording the join failed:', e2.message);
  return !e2;
}

// ── the forms only: the whole of Confirm's join ─────────────────────────────

/** The one notice (customer-join-notice). Never awaited, never throws: it never holds the order. */
function notify(sendNotice, body) {
  if (typeof sendNotice !== 'function') return;
  try {
    Promise.resolve(sendNotice(body)).catch((e) => console.warn('[customer join] notice failed:', e?.message || e));
  } catch (e) {
    console.warn('[customer join] notice failed:', e?.message || e);
  }
}

const apart = (c, reason) => ({ kind: 'apart', reason, customer: c, toast: apartToast(reason) });

/**
 * What Confirm does before it saves, when staff typed a phone and an email.
 *   { kind: 'none', customer }                         nothing joined: save as always
 *   { kind: 'linked', how, profileId, customer, toast } (a) or (b) done: the order uses that profile
 *   { kind: 'apart', reason, customer, toast }         (c) the save leaves the email off; say why
 * `customer` is what the form hands on (the email stays on the order for the receipt).
 * `openedWithEmail` is the email the form opened with: only a NEW email joins (emailIsNew).
 * A check that fails or is slow is 'none': a slow network never holds an order.
 */
export async function autoJoinCustomer({
  customer, openedWithEmail = '', phoneN, db, orgId, locId = null, postMerge = null, sendNotice = null,
  now = null, timeout = withTimeout, checkMs = CHECK_TIMEOUT_MS, writeMs = WRITE_TIMEOUT_MS,
}) {
  const c = customer || {};
  const none = { kind: 'none', customer: c };
  if (!phoneN || !db || !orgId || !emailIsNew(openedWithEmail, c.email)) return none;
  // A phone is a loyalty login: a few digits typed by mistake never go on a member's profile
  // (the same seven digit floor as the customer_by_phone lookup).
  if (str(phoneN).replace(/\D/g, '').length < 7) return none;

  let facts = null;
  try {
    facts = await timeout(readAutoJoinFacts({ db, orgId, phoneN, typedPhone: c.phone, email: c.email }), checkMs, 'Customer check');
  } catch (e) {
    console.warn('[customer join] check:', e?.message || e);
    return none;
  }
  if (!facts?.ok) return none;
  const d = decideAutoJoin({ phoneHit: facts.phoneHit, phoneOthers: facts.phoneOthers, emailHits: facts.emailHits, phone: phoneN });
  if (d.step === 'save') return none;
  if (d.step === 'apart') return apart(c, d.reason);

  if (d.step === 'claim') {
    let r = null;
    try {
      r = await timeout(claimPhoneForProfile({
        db, orgId, holder: d.holder, phoneN, phoneRaw: c.phone, rawOnly: !!d.rawOnly, typedName: c.name, now,
      }), writeMs, 'Linking the phone');
    } catch (e) {
      console.warn('[customer join] claim:', e?.message || e);
      // It may still land: the notice checks the profile itself and sends only if it did.
      if (isTimeout(e)) notify(sendNotice, { customer_id: d.holder.id });
      return apart(c, isTimeout(e) ? 'timeout' : 'failed');
    }
    if (!r?.ok) return apart(c, r?.outcome);
    notify(sendNotice, { customer_id: d.holder.id });
    return {
      kind: 'linked', how: 'phone_added', profileId: d.holder.id,
      customer: customerAfterJoin(c, d.holder.allergens), toast: linkedToast(d.holder.name, c.name),
    };
  }

  if (d.step === 'join') {
    if (typeof postMerge !== 'function' || !locId) return apart(c, 'join_refused');
    let r = null;
    try {
      r = await timeout(joinShellIntoProfile({ postMerge, locId, sourceId: d.source.id, targetId: d.target.id }), writeMs, 'Joining the profiles');
    } catch (e) {
      console.warn('[customer join] join:', e?.message || e);
      if (isTimeout(e)) notify(sendNotice, { customer_id: d.target.id, source_id: d.source.id });
      return apart(c, isTimeout(e) ? 'timeout' : 'join_unfinished');
    }
    if (!r?.ok) return apart(c, r?.outcome === 'retry' ? 'join_unfinished' : 'join_refused');
    const survivorId = r.survivorId || d.target.id;
    try {
      await timeout(markEmailJoin({ db, orgId, id: survivorId, phoneN, typedName: c.name, now }), checkMs, 'Recording the join');
    } catch (e) {
      console.warn('[customer join] recording the join:', e?.message || e);
    }
    notify(sendNotice, { customer_id: survivorId, source_id: d.source.id });
    const name = r.survivor?.name ?? d.target.name;
    return {
      kind: 'linked', how: 'joined', profileId: survivorId,
      customer: customerAfterJoin(c, Array.isArray(r.survivor?.allergens) ? r.survivor.allergens : d.target.allergens),
      toast: linkedToast(name, c.name),
    };
  }
  return none;
}
