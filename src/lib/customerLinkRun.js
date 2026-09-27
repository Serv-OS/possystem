// src/lib/customerLinkRun.js
//
// THE READS AND WRITES OF "LINK TO EXISTING MEMBER" (27 Sep 2026). lib/customerLink.js decides;
// this file talks to the database through the Supabase client it is GIVEN (the store passes its
// own), to customer-merge and customer-join-notice through the functions it is given, and to the
// loyalty lookup the customer display uses through another. No client import, no import.meta, no
// store, so node tests run every path against a fake database (src/lib/customerLinkRun.test.js).
//
// Peter, 27 Sep 2026: "if a customer adds their number and then a staff member can link that to a
// profile that currently has no number". Automatic, no extra question: a tap on the member links.
// The two writes are the ones the email join already makes, with the same guards:
//   * the empty profile the customer display (or the till) made from the phone is folded into the
//     member by customer-merge (joinShellIntoProfile: preview first, and on only when the server
//     says the folded in profile is an empty shell and the member is the one kept; the server's
//     own rule for a till is the authority);
//   * when no profile holds the number yet, the phone goes on the member, and only while the
//     member's phone is still empty as read (claimPhoneForProfile).
// A phone is a loyalty login, so a member who has one is never offered and never written.

import { withTimeout } from './withTimeout.js';
import { AUTO_JOIN_COLS, phoneVariants } from './customerAutoJoin.js';
import { claimPhoneForProfile, joinShellIntoProfile, CHECK_TIMEOUT_MS, WRITE_TIMEOUT_MS } from './customerAutoJoinRun.js';
import { stampSummary } from './stampSummary.js';
import {
  canOfferLink, linkSearchTerm, phonelessResults, decideLink, joinRefusalShown, linkMessage, linkedToast, customerAfterLink,
} from './customerLink.js';

/** The columns the search list needs (enough to show and to pick). */
export const LINK_SEARCH_COLS = 'id, name, phone, phone_raw, email';
/**
 * The columns the check reads: the email join's, and created_at (27 Sep 2026, review), so a
 * refusal from customer-merge is not put down to an order when the server may only have kept the
 * older profile (lib/customerLink.js joinRefusalShown).
 */
export const LINK_FACT_COLS = `${AUTO_JOIN_COLS}, created_at`;
/** How many members the search shows. Staff type more to narrow it. */
export const LINK_SEARCH_LIMIT = 10;

const str = (v) => (v == null ? '' : String(v));
const isTimeout = (e) => e?.code === 'TIMEOUT' || e?.name === 'TimeoutError';

/** A refusal the chip shows as it is: { ok: false, code, message }. */
export const linkRefused = (code) => ({ ok: false, code, message: linkMessage(code) });

// ── the search ──────────────────────────────────────────────────────────────

/**
 * READ ONLY. Live profiles of this organisation with NO phone whose name or email holds the text
 * staff typed. The phone filter is in the query, so a busy name ("Sam") is not crowded out by the
 * members who already have a phone; phonelessResults also drops a profile with only a raw phone.
 * Returns { ok, rows }; a failed read is { ok: false, rows: [] }, never an error on screen.
 */
export async function searchPhonelessMembers({ db, orgId, q, limit = LINK_SEARCH_LIMIT }) {
  const term = linkSearchTerm(q);
  if (!db || !orgId || !term) return { ok: true, rows: [] };
  const { data, error } = await db.from('customers').select(LINK_SEARCH_COLS)
    .eq('org_id', orgId).is('deleted_at', null).is('phone', null)
    .or(`name.ilike.%${term}%,email.ilike.%${term}%`)
    .limit(limit);
  if (error) {
    console.warn('[link member] search failed:', error.message);
    return { ok: false, rows: [] };
  }
  return { ok: true, rows: phonelessResults(data, limit) };
}

// ── the check ───────────────────────────────────────────────────────────────

/**
 * READS ONLY. The live profiles holding the order's number (any of the ways it is stored), and the
 * picked member as it is NOW (same organisation, not deleted). { ok: false } when a read fails.
 */
export async function readLinkFacts({ db, orgId, phoneN, typedPhone = '', memberId }) {
  const variants = phoneVariants(phoneN, typedPhone);
  if (!db || !orgId || !memberId || !variants.length) return { ok: false, code: 'nothing_to_check' };
  const orPhone = variants.flatMap((v) => [`phone.eq.${v}`, `phone_raw.eq.${v}`]).join(',');
  const [p, m] = await Promise.all([
    db.from('customers').select(LINK_FACT_COLS).eq('org_id', orgId).is('deleted_at', null).or(orPhone).limit(10),
    db.from('customers').select(LINK_FACT_COLS).eq('id', memberId).eq('org_id', orgId).is('deleted_at', null).maybeSingle(),
  ]);
  if (p?.error || m?.error) {
    console.warn('[link member] read failed:', p?.error?.message || m?.error?.message);
    return { ok: false, code: 'read_failed' };
  }
  const rows = Array.isArray(p.data) ? p.data : [];
  const phoneHit = rows.find((r) => str(r.phone) === phoneN) || null;
  return { ok: true, member: m.data || null, phoneHit, phoneOthers: rows.filter((r) => r !== phoneHit) };
}

// ── the link ────────────────────────────────────────────────────────────────

/** The one notice (customer-join-notice). Never awaited, never throws: the order never waits for it. */
function notify(sendNotice, body) {
  if (typeof sendNotice !== 'function') return;
  try {
    Promise.resolve(sendNotice(body)).catch((e) => console.warn('[link member] notice failed:', e?.message || e));
  } catch (e) {
    console.warn('[link member] notice failed:', e?.message || e);
  }
}

/**
 * Link the order's new customer to the picked member.
 *   customer  the order's customer (phone as typed; must pass canOfferLink)
 *   member    the picked search row ({ id } is all that is trusted: it is read again)
 *   phoneN    the order's number, normalised
 *   lookup    (phone) => the customer display's loyalty lookup (fetchCustomerByPhone), for stamps
 * Returns
 *   { ok: true, how: 'joined' | 'phone_added' | 'already', profileId, customer, toast, loyalty }
 *   { ok: false, code, message }     plain words for the chip; nothing half done is left behind
 * `customer` is the order's customer after the link (customerAfterLink); `loyalty` is what the
 * customer display shows for a known member (or null when the lookup did not answer).
 */
export async function linkOrderCustomer({
  customer, member, phoneN, db, orgId, locId = null, postMerge = null, sendNotice = null, lookup = null,
  now = null, timeout = withTimeout, checkMs = CHECK_TIMEOUT_MS, writeMs = WRITE_TIMEOUT_MS,
}) {
  const c = customer || {};
  if (!canOfferLink(c)) return linkRefused('not_new_customer');
  if (!member || !str(member.id).trim()) return linkRefused('member_gone');
  if (str(phoneN).replace(/\D/g, '').length < 7) return linkRefused('no_phone');
  if (!db || !orgId) return linkRefused('failed');

  let facts = null;
  try {
    facts = await timeout(readLinkFacts({ db, orgId, phoneN, typedPhone: c.phone, memberId: member.id }), checkMs, 'Customer check');
  } catch (e) {
    console.warn('[link member] check:', e?.message || e);
    return linkRefused('read_failed');
  }
  if (!facts?.ok) return linkRefused('read_failed');
  const d = decideLink({ member: facts.member, phoneHit: facts.phoneHit, phoneOthers: facts.phoneOthers, phone: phoneN });
  if (d.step === 'refuse') return linkRefused(d.code);
  const m = facts.member;

  let how = 'already';
  let profileId = m.id;
  let survivor = null;
  if (d.step === 'join') {
    if (typeof postMerge !== 'function' || !locId) return linkRefused('failed');
    let r = null;
    try {
      r = await timeout(joinShellIntoProfile({ postMerge, locId, sourceId: d.source.id, targetId: m.id }), writeMs, 'Linking the profiles');
    } catch (e) {
      console.warn('[link member] join:', e?.message || e);
      // It may still land: the notice checks the profiles itself and sends only if it did.
      if (isTimeout(e)) notify(sendNotice, { customer_id: m.id, source_id: d.source.id });
      return linkRefused(isTimeout(e) ? 'timeout' : 'join_unfinished');
    }
    if (!r?.ok) return linkRefused(r?.outcome === 'retry' ? 'join_unfinished' : joinRefusalShown(r?.code || 'refused', { source: d.source, member: m }));
    profileId = r.survivorId || m.id;
    survivor = r.survivor || null;
    how = 'joined';
    notify(sendNotice, { customer_id: profileId, source_id: d.source.id });
  } else if (d.step === 'claim') {
    let r = null;
    try {
      r = await timeout(claimPhoneForProfile({
        db, orgId, holder: m, phoneN, phoneRaw: c.phone, rawOnly: !!d.rawOnly, typedName: '', now,
      }), writeMs, 'Linking the phone');
    } catch (e) {
      console.warn('[link member] claim:', e?.message || e);
      if (isTimeout(e)) notify(sendNotice, { customer_id: m.id });
      return linkRefused(isTimeout(e) ? 'timeout' : 'failed');
    }
    if (!r?.ok) return linkRefused(r?.outcome || 'failed');
    how = 'phone_added';
    notify(sendNotice, { customer_id: m.id });
  }

  // The member's stamps for the chip ("2/9") and the display, through the same lookup the customer
  // display uses. Best effort: the link is done whatever this answers.
  const name = survivor?.name ?? m.name;
  const allergens = Array.isArray(survivor?.allergens) ? survivor.allergens : m.allergens;
  let stamps = null;
  let loyalty = null;
  if (typeof lookup === 'function') {
    try {
      const l = await timeout(Promise.resolve(lookup(c.phone || phoneN)), checkMs, 'Loyalty lookup');
      if (l && l.knownCustomer) {
        stamps = l.stampsEnabled === false ? [] : stampSummary(l.stampCards);
        loyalty = {
          known: true,
          name: str(l.name).trim() || str(name).trim(),
          points: Number(l.credit) || 0,
          rewards: Array.isArray(l.rewards) ? l.rewards : [],
          customerId: l.customerId || profileId,
          stamps,
          pointsEnabled: l.pointsEnabled !== false,
          stampsEnabled: l.stampsEnabled !== false,
        };
      }
    } catch (e) {
      console.warn('[link member] loyalty lookup:', e?.message || e);
    }
  }
  return {
    ok: true, how, profileId,
    customer: customerAfterLink(c, { name, allergens, stamps }),
    toast: linkedToast(name),
    loyalty,
  };
}
