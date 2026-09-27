// supabase/functions/_shared/customerMergePlan.js
//
// FOLD TWO CUSTOMER PROFILES INTO ONE. What survives, what adds up, what we refuse. PURE.
//
// WHY (26 Sep 2026, Coffee Boy Leeds). 8,028 loyalty members came in from 5Loyalty that
// morning, 1,358 of them with an email and NO phone. Ela Stettner was one: an imported profile
// with her email and 2 stamps. She signed up in the customer portal with her phone. loyalty-otp
// matches on the PHONE only (on purpose: an email typed into the portal is never verified, 18 Sep
// rule), so it made a second, blank profile with a new empty membership. Then saving her name and
// email on that blank profile hit the unique email index and failed, and staff trying to add her
// at the till hit the same index: "DB error". Peter: "it should have matched the profile
// together". Nothing could, because nothing in the product could put two profiles together.
//
// This file decides a merge; customerMergeRun.js carries it out; customer-merge/index.ts is the
// door (who may ask). No database, no clock of its own, no imports, so node tests drive every
// rule, and Back Office imports the helpers through src/lib/customerMerge.js.
//
// THE RULES, all of them somebody's loyalty account:
//   1. THE PROFILE WITH HISTORY SURVIVES (the TARGET). History is an import, points, stamps,
//      orders or ledger rows. When both or neither have history the OLDER profile survives. The
//      other one (the SOURCE) is folded in and soft deleted. Whichever way round the caller named
//      them, the plan says which is kept (swapped true when it turned them round).
//   2. FILL BLANKS, NEVER OVERWRITE. The target keeps its own name, email and birthday; a blank
//      one is filled from the source. Marketing is yes when either said yes, unless the newest
//      consent record says no. Allergens, sources and tags are unions. No shows add up.
//   3. TWO DIFFERENT PHONES IS A REFUSAL until a person chooses which one to keep (staff pass
//      phone_choice). A phone is the loyalty login, so we never guess whose phone it is.
//   4. BALANCES ADD UP, EXACTLY ONCE. Membership points, totals, visits and spend are summed, the
//      earlier enrolled_at is kept, and the target's member code is kept. Stamp cards are summed
//      per programme (a full card rolls into a completed one, as loyalty-earn does). The sum is
//      written in ONE statement that also zeroes the source row (see customerMergeRun.js), so a
//      retry after a crash adds zero, never the same stamps twice.
//   5. EVERY STEP CAN RUN AGAIN. The source row carries `merged_into:<target>` once it is folded,
//      and the phone and email it handed over, so a merge that stopped half way is finished by
//      asking again (mode 'resume'), never refused as "already deleted".
//   6. A RESUME NEVER REWRITES THE SURVIVOR (27 Sep 2026, first review). The first cut rebuilt the
//      survivor from the folded in row on every resume, so pressing Merge again after a finished
//      merge put back a phone staff had since changed and switched marketing on again. Now a
//      resume writes none of the survivor's profile fields. It only hands over a phone or email
//      the folded in profile let go of, into a survivor field that is STILL empty, when no other
//      live customer holds that value now, and never after the merge was marked finished
//      (merge_done): a phone is a loyalty login, so it is never attached twice by a double tap.
//      A resume also needs BOTH halves of the trail (merged_into on the source, merged: on the
//      survivor, written by one statement), so a stray tag alone can never hand a phone over.
//
// Verified live (read only, 26 Sep 2026) rather than assumed:
//   Ops customers: name NOT NULL (no default), sources NOT NULL, tags unused anywhere (0 rows),
//     UNIQUE (org_id, phone) and (org_id, lower(email)), both where deleted_at is null. No
//     triggers.
//   Ops customer_locations: PRIMARY KEY (customer_id, location_id).
//   Ops campaign_sends UNIQUE (campaign_id, customer_id, dedupe_key); workflow_enrollments
//     UNIQUE (workflow_id, customer_id). Every other customer_id column has no per customer key.
//   Platform customer_loyalty UNIQUE (customer_id, company_id), member_code, referral_code;
//     referred_by references customer_loyalty(id) ON DELETE SET NULL.
//   Platform customer_stamp_cards UNIQUE (customer_id, program_id, company_id).

// ── the tables that name a customer ─────────────────────────────────────────

/**
 * Every Ops table with a customer_id column (information_schema, 26 Sep 2026), and how its rows
 * move to the survivor. `unique` names the other columns of a unique key that includes
 * customer_id: a source row whose key the target already holds stays where it is (named in the
 * result). `sum` rows are added into the target's row for the same key. A table added later is
 * NOT moved until it is listed here (src/lib/customerMergePlan.test.js pins the list).
 * The view customer_rfm is derived and needs nothing.
 */
export const MERGE_TABLES = Object.freeze([
  { table: 'customer_orders', label: 'orders', one: 'order' },
  { table: 'closed_checks', label: 'receipts', one: 'receipt' },
  { table: 'loyalty_transactions', label: 'points history rows', one: 'points history row' },
  { table: 'stamp_transactions', label: 'stamp history rows', one: 'stamp history row' },
  { table: 'customer_consents', label: 'consent records', one: 'consent record' },
  { table: 'bookings', label: 'bookings', one: 'booking' },
  { table: 'waitlist_entries', label: 'waitlist entries', one: 'waitlist entry' },
  { table: 'wifi_captures', label: 'WiFi sign ins', one: 'WiFi sign in' },
  { table: 'marketing_messages', label: 'marketing messages', one: 'marketing message' },
  { table: 'marketing_suppressions', label: 'unsubscribes', one: 'unsubscribe' },
  { table: 'promo_codes', label: 'promo codes', one: 'promo code' },
  { table: 'promo_redemptions', label: 'promo redemptions', one: 'promo redemption' },
  { table: 'review_feedback', label: 'review feedback', one: 'review feedback' },
  { table: 'workflow_step_sends', label: 'automation sends', one: 'automation send' },
  { table: 'campaign_sends', label: 'campaign sends', one: 'campaign send', unique: ['campaign_id', 'dedupe_key'] },
  { table: 'workflow_enrollments', label: 'automation enrolments', one: 'automation enrolment', unique: ['workflow_id'] },
  { table: 'customer_locations', label: 'venue visit records', one: 'venue visit record', sum: true },
]);

/** The customers columns a merge reads (deleted rows included: a half done merge is resumed). */
export const CUSTOMER_MERGE_COLS = 'id, org_id, name, first_name, last_name, phone, phone_raw, email, birthday, notes, allergens, marketing_opt_in, marketing_opt_in_at, sources, source, tags, no_shows, welcome_sent_at, is_local, shopper_reference, stored_payment_method_id, created_at, updated_at, deleted_at';

/** The customers columns written by the one statement that folds the two rows (same keys on both). */
export const CUSTOMER_UPSERT_COLUMNS = Object.freeze([
  'id', 'org_id', 'name', 'first_name', 'last_name', 'phone', 'phone_raw', 'email', 'birthday', 'notes',
  'allergens', 'marketing_opt_in', 'marketing_opt_in_at', 'sources', 'source', 'tags', 'no_shows',
  'welcome_sent_at', 'is_local', 'shopper_reference', 'stored_payment_method_id', 'deleted_at', 'updated_at',
]);

/** What the screens get back for the survivor. */
export const SURVIVOR_COLS = 'id, org_id, name, first_name, last_name, phone, phone_raw, email, birthday, notes, allergens, marketing_opt_in, marketing_opt_in_at, sources, tags, created_at, updated_at, deleted_at';

export const MEMBERSHIP_COLS = 'id, customer_id, company_id, points_balance, points_earned_total, points_redeemed_total, points_expired_total, tier_id, tier_qualified_at, visit_count, lifetime_spend_minor, member_code, referral_code, referred_by, birthday, wallet_pass_serial, enrolled_at, last_earn_at, last_redeem_at, points_expire_at';

export const MEMBERSHIP_UPSERT_COLUMNS = Object.freeze([
  'id', 'customer_id', 'company_id', 'points_balance', 'points_earned_total', 'points_redeemed_total',
  'points_expired_total', 'visit_count', 'lifetime_spend_minor', 'tier_id', 'tier_qualified_at',
  'referred_by', 'birthday', 'enrolled_at', 'last_earn_at', 'last_redeem_at', 'points_expire_at',
]);

/** The membership numbers that add up. */
export const MEMBERSHIP_SUM_FIELDS = Object.freeze([
  'points_balance', 'points_earned_total', 'points_redeemed_total', 'points_expired_total',
  'visit_count', 'lifetime_spend_minor',
]);

export const CARD_COLS = 'id, customer_id, program_id, company_id, stamps_collected, completed_count, last_stamp_at, created_at';

export const CARD_UPSERT_COLUMNS = Object.freeze([
  'id', 'customer_id', 'program_id', 'company_id', 'stamps_collected', 'completed_count', 'last_stamp_at',
]);

export const LOCATION_COLS = 'customer_id, location_id, first_visit_at, last_visit_at, visit_count, lifetime_revenue, notes';

export const LOCATION_UPSERT_COLUMNS = Object.freeze([
  'customer_id', 'location_id', 'first_visit_at', 'last_visit_at', 'visit_count', 'lifetime_revenue', 'notes',
]);

// ── the trail a merge leaves in customers.tags ─────────────────────────────
//
// tags is unused by every screen (0 rows had one on 26 Sep 2026), so it carries the trail without
// showing on a till. The source (soft deleted) row keeps where it went and exactly what it handed
// over, which is what lets a merge that stopped between steps be finished later.

export const MERGE_TAG = Object.freeze({
  INTO: 'merged_into:',              // on the folded in profile: the survivor's id
  FROM: 'merged:',                   // on the survivor: the id of each profile folded into it
  PHONE: 'merge_phone:',             // on the folded in profile: the phone handed to the survivor
  PHONE_RAW: 'merge_phone_raw:',
  EMAIL: 'merge_email:',
  DROPPED_PHONE: 'merge_dropped_phone:',   // a phone that was NOT kept (staff chose the other)
  DROPPED_EMAIL: 'merge_dropped_email:',   // an email that was not kept (the survivor had its own)
  // 27 Sep 2026: on the folded in profile once the hand over step has run. After it a resume
  // hands over nothing, even into a field staff have since emptied on purpose.
  DONE: 'merge_done',
});

const SOURCE_ONLY_TAGS = [
  MERGE_TAG.INTO, MERGE_TAG.PHONE, MERGE_TAG.PHONE_RAW, MERGE_TAG.EMAIL, MERGE_TAG.DROPPED_PHONE, MERGE_TAG.DROPPED_EMAIL,
  MERGE_TAG.DONE,
];

// ── small pure helpers ──────────────────────────────────────────────────────

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** @param {unknown} v */
export const isUuid = (v) => typeof v === 'string' && UUID.test(v);

const str = (v) => (v == null ? '' : String(v));
const clean = (v) => str(v).trim();
const has = (v) => clean(v) !== '';
const orNull = (v) => (has(v) ? clean(v) : null);
const int = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.trunc(n) : 0; };
const arr = (v) => (Array.isArray(v) ? v.filter((x) => x != null && x !== '') : []);

/** Two decimal amounts added without float dust (customer_locations.lifetime_revenue is numeric). */
export function addDecimal(a, b) {
  return Math.round((Number(a) || 0) * 10000 + (Number(b) || 0) * 10000) / 10000;
}

const time = (v) => { const t = v ? Date.parse(String(v)) : NaN; return Number.isNaN(t) ? null : t; };

/** The earlier of two timestamps, as given (null when neither is a date). */
export function earlier(a, b) {
  const ta = time(a); const tb = time(b);
  if (ta == null) return tb == null ? null : b;
  if (tb == null) return a;
  return tb < ta ? b : a;
}

/** The later of two timestamps, as given. */
export function later(a, b) {
  const ta = time(a); const tb = time(b);
  if (ta == null) return tb == null ? null : b;
  if (tb == null) return a;
  return tb > ta ? b : a;
}

/** A union that keeps first seen order. */
export function union(...lists) {
  const out = [];
  const seen = new Set();
  for (const list of lists) for (const v of arr(list)) {
    const k = String(v);
    if (!seen.has(k)) { seen.add(k); out.push(v); }
  }
  return out;
}

const pick = (row, cols) => { const o = {}; for (const c of cols) o[c] = row?.[c] === undefined ? null : row[c]; return o; };

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Did any of these columns change? */
export function changedAny(next, prev, cols) {
  return cols.some((c) => !same(next?.[c], prev?.[c]));
}

/** '' and 'Customer' are what the till and the portal store when nobody typed a name. */
export function isBlankName(name) {
  const n = clean(name).toLowerCase();
  return n === '' || n === 'customer';
}

const phoneParts = (v) => {
  const s = clean(v);
  let d = s.replace(/\D/g, '');
  let intl = s.startsWith('+');
  if (!intl && d.startsWith('00')) { d = d.slice(2); intl = true; }
  return { d, intl };
};

/**
 * The same phone written two ways? ('+447415748167' and '07415748167' are one number.)
 * 27 Sep 2026 (first review): this used to compare the last nine digits, so '+447415748167' and
 * '+17415748167', two people in two countries, counted as one number and the second was dropped
 * without a word. Now two full international numbers must match digit for digit; a national form
 * ('07415 748167') matches an international one only when it is that number minus a country code
 * of one to three digits and the leading 0.
 */
export function samePhone(a, b) {
  const A = phoneParts(a);
  const B = phoneParts(b);
  if (!A.d || !B.d) return false;
  if (A.d === B.d) return true;
  if (A.intl && B.intl) return false;
  if (A.d.length < 7 || B.d.length < 7) return false;
  const national = (x) => (x.d.startsWith('0') ? x.d.slice(1) : x.d);
  if (!A.intl && !B.intl && national(A) === national(B)) return true;
  const [long, short] = A.d.length >= B.d.length ? [A, B] : [B, A];
  if (short.intl) return false;
  const tail = national(short);
  const code = long.d.length - tail.length;
  return code >= 1 && code <= 3 && long.d.endsWith(tail);
}

/** '+447415748167' -> '••••••••8167'. */
export function maskPhone(p) {
  const d = str(p).replace(/\D/g, '');
  if (!d) return '';
  if (d.length <= 4) return '•'.repeat(d.length);
  return '•'.repeat(d.length - 4) + d.slice(-4);
}

/** 'elastettner@hotmail.com' -> 'e•••@hotmail.com'. */
export function maskEmail(e) {
  const s = clean(e);
  if (!s) return '';
  const at = s.lastIndexOf('@');
  if (at < 1) return '•••';
  return s[0] + '•••' + s.slice(at);
}

/** The value of the first tag starting with prefix, or null. */
export function tagValue(tags, prefix) {
  for (const t of arr(tags)) {
    const s = String(t);
    if (s.startsWith(prefix)) return s.slice(prefix.length) || null;
  }
  return null;
}

/** Where a folded in profile went (its merged_into tag), or null. */
export function mergedIntoOf(tags) {
  const v = tagValue(tags, MERGE_TAG.INTO);
  return isUuid(v) ? v : null;
}

/** Does the survivor carry the other half of the trail (merged:<sourceId>)? */
export function carriesMergeFrom(tags, sourceId) {
  return arr(tags).some((t) => String(t) === MERGE_TAG.FROM + String(sourceId));
}

/** Has this folded in profile's hand over step already run? */
export function isMergeDone(tags) {
  return arr(tags).some((t) => String(t) === MERGE_TAG.DONE);
}

/**
 * An email as an ilike pattern that matches only itself (case aside): % and _ are wildcards in
 * ilike and both are legal in an email address. (Moved here 27 Sep 2026 so the merge's own
 * "who holds this email now" read uses the same rule as the Back Office clash lookup.)
 */
export function exactIlike(value) {
  return String(value ?? '').trim().replace(/[\\%_]/g, (c) => `\\${c}`);
}

// ── history and blank shells ───────────────────────────────────────────────

/**
 * What one profile has done. memberships and cards are that customer's own rows; activity holds
 * the Ops counts the run read (orders, and ledger = loyalty_transactions + stamp_transactions).
 */
export function historyOf(customer, memberships = [], cards = [], activity = {}) {
  const imported = clean(customer?.source) === 'import' || arr(customer?.sources).some((s) => String(s) === 'import' || String(s).startsWith('import:'));
  let points = 0; let visits = 0;
  for (const m of memberships) {
    points += Math.abs(int(m.points_balance)) + int(m.points_earned_total) + int(m.points_redeemed_total);
    visits += int(m.visit_count);
  }
  let stamps = 0;
  for (const c of cards) stamps += int(c.stamps_collected) + int(c.completed_count);
  const orders = int(activity?.orders);
  const ledger = int(activity?.ledger);
  return { imported, points, visits, stamps, orders, ledger, any: imported || points > 0 || visits > 0 || stamps > 0 || orders > 0 || ledger > 0 };
}

/**
 * An EMPTY profile: no name ('' or 'Customer'), no email, no import, no points, no stamps, no
 * orders, no ledger rows. The only kind a till may fold in (the till case: the portal or the till
 * made it from a phone alone). A phone is allowed: handing it to the survivor is the point.
 */
export function isBlankShell(customer, history) {
  if (!customer) return false;
  if (!isBlankName(customer.name)) return false;
  if (has(customer.first_name) || has(customer.last_name)) return false;
  if (has(customer.email)) return false;
  const h = history || historyOf(customer);
  return !h.imported && h.points === 0 && h.visits === 0 && h.stamps === 0 && h.orders === 0 && h.ledger === 0;
}

/**
 * Which one survives. `a` is the one the caller named as the target. The one with history wins;
 * when both or neither have history, the older one wins; a tie keeps the caller's order.
 */
export function chooseSurvivor(a, b, histA, histB) {
  if (histA?.any && !histB?.any) return { target: a, source: b, swapped: false };
  if (histB?.any && !histA?.any) return { target: b, source: a, swapped: true };
  const ta = time(a?.created_at); const tb = time(b?.created_at);
  if (ta != null && tb != null && tb < ta) return { target: b, source: a, swapped: true };
  return { target: a, source: b, swapped: false };
}

// ── the profile fields ──────────────────────────────────────────────────────

const lowerOrNull = (v) => (has(v) ? clean(v).toLowerCase() : null);

/**
 * RESUME: what is left to hand over to the survivor, and nothing else (27 Sep 2026, first
 * review: a resume used to rebuild the survivor from the folded in row, reverting a phone changed
 * since and switching marketing back on). The ONE statement that soft deleted the source also
 * wrote the survivor, so no profile field of the survivor is written again. The source's tags say
 * what it let go of; each value is handed over only
 *   * while the merge is not marked done (merge_done: after the hand over nothing is re added,
 *     not even into a field staff emptied on purpose);
 *   * into a survivor field that is STILL empty (a phone or email the survivor has now wins);
 *   * when no other live customer holds that value now (a new sign up may have taken it).
 * `holders` are live customers of the organisation that hold a value the trail names
 * (customerMergeRun.js readMergeFacts reads them).
 * @returns {{ move: object, warnings: object[], done: boolean }}
 */
export function resumeHandOver(t, s, holders = []) {
  const move = {};
  const warnings = [];
  if (isMergeDone(s?.tags)) return { move, warnings, done: true };
  const others = arr(holders).filter((h) => h && !h.deleted_at && String(h.id) !== String(t.id) && String(h.id) !== String(s.id));

  const p = orNull(tagValue(s.tags, MERGE_TAG.PHONE));
  const pr = orNull(tagValue(s.tags, MERGE_TAG.PHONE_RAW));
  const want = p || pr;
  if (want) {
    const tPhone = orNull(t.phone);
    const tRaw = orNull(t.phone_raw);
    const mine = tPhone || tRaw;
    const taken = others.some((h) => samePhone(h.phone, want) || samePhone(h.phone_raw, want));
    if (mine && !(!tPhone && samePhone(tRaw, want))) {
      // The survivor has a phone. The same number is the hand over already done; another is a
      // number somebody chose since, and it stays.
      if (!samePhone(mine, want)) {
        warnings.push({ code: 'phone_kept', message: `The kept profile has its own phone ${maskPhone(mine)} now, so ${maskPhone(want)} is not added.` });
      }
    } else if (taken) {
      warnings.push({ code: 'phone_taken', message: `The phone ${maskPhone(want)} is on another customer now, so it is not added. Merge that one too if it is the same person.` });
    } else {
      if (p) move.phone = p;
      if (pr && !tRaw) move.phone_raw = pr;
    }
  }

  const e = orNull(tagValue(s.tags, MERGE_TAG.EMAIL));
  if (e) {
    const tEmail = orNull(t.email);
    if (tEmail) {
      if (tEmail.toLowerCase() !== e.toLowerCase()) {
        warnings.push({ code: 'email_kept', message: `The kept profile has its own email ${maskEmail(tEmail)} now, so ${maskEmail(e)} is not added.` });
      }
    } else if (others.some((h) => lowerOrNull(h.email) === e.toLowerCase())) {
      warnings.push({ code: 'email_taken', message: `The email ${maskEmail(e)} is on another customer now, so it is not added. Merge that one too if it is the same person.` });
    } else {
      move.email = e;
    }
  }
  return { move, warnings, done: false };
}

/**
 * The two customers rows as the ONE statement writes them, and what moves to the survivor after
 * the source has let go of it (the phone and email unique indexes). In a resume there are no
 * rows to write (target and source are null): only the guarded hand over (resumeHandOver).
 * `finish` is the source's tags with merge_done, written after the hand over (null when there
 * is nothing to hand over, because then the fold statement already carries merge_done).
 *
 * @param {object} t target customers row
 * @param {object} s source customers row
 * @param {{ phoneChoice?: 'target'|'source'|null, latestConsent?: boolean|null, now: string, resume?: boolean, holders?: object[] }} opts
 */
export function mergeCustomerFields(t, s, opts) {
  if (opts.resume) {
    const r = resumeHandOver(t, s, opts.holders || []);
    return {
      target: null, source: null, move: r.move, refusals: [], warnings: r.warnings,
      finish: r.done ? null : { tags: union(s.tags, [MERGE_TAG.DONE]) },
    };
  }
  const now = opts.now;
  const refusals = [];
  const warnings = [];
  const move = {};
  const sourceTags = [];

  // ── phone ──
  const tPhone = orNull(t.phone);
  const tAny = tPhone || orNull(t.phone_raw);
  const sPhone = orNull(s.phone);
  const sRaw = orNull(s.phone_raw);
  const sAny = sPhone || sRaw;
  let targetLetsGoOfPhone = false;
  if (sAny) {
    if (!tAny) {
      if (sPhone) move.phone = sPhone;
      if (sRaw) move.phone_raw = sRaw;
    } else if (samePhone(tAny, sAny)) {
      // One number written twice. The survivor keeps its own; only a missing key is filled.
      if (!tPhone && sPhone) move.phone = sPhone;
    } else if (opts.phoneChoice === 'source') {
      // 27 Sep 2026 (first review): the survivor lets go of BOTH its phone keys in the fold
      // statement and then takes the source's like a profile with no phone. Before, a source
      // with only a raw form left the survivor its OLD phone next to the new raw form (two
      // numbers on one profile), and a resume could not tell the chosen number from the old.
      targetLetsGoOfPhone = true;
      if (sPhone) move.phone = sPhone;
      if (sRaw) move.phone_raw = sRaw;
      sourceTags.push(MERGE_TAG.DROPPED_PHONE + tAny);
      warnings.push({ code: 'phone_replaced', message: `The kept profile's phone ${maskPhone(tAny)} is replaced by ${maskPhone(sAny)}, as chosen.` });
    } else if (opts.phoneChoice === 'target') {
      sourceTags.push(MERGE_TAG.DROPPED_PHONE + sAny);
      warnings.push({ code: 'phone_dropped', message: `The phone ${maskPhone(sAny)} is not kept, as chosen.` });
    } else {
      refusals.push({
        code: 'different_phones',
        message: `The two profiles have different phone numbers (${maskPhone(tAny)} and ${maskPhone(sAny)}). A phone is how a member signs in, so choose which one to keep.`,
      });
    }
  }
  if (move.phone) sourceTags.push(MERGE_TAG.PHONE + move.phone);
  if (move.phone_raw) sourceTags.push(MERGE_TAG.PHONE_RAW + move.phone_raw);

  // ── email ──
  const tEmail = orNull(t.email);
  const sEmail = orNull(s.email);
  if (sEmail) {
    if (!tEmail) move.email = sEmail;
    else if (tEmail.toLowerCase() !== sEmail.toLowerCase()) {
      sourceTags.push(MERGE_TAG.DROPPED_EMAIL + sEmail);
      warnings.push({ code: 'email_dropped', message: `The email ${maskEmail(sEmail)} is not kept: the kept profile has its own (${maskEmail(tEmail)}).` });
    }
  }
  if (move.email) sourceTags.push(MERGE_TAG.EMAIL + move.email);

  // ── name ──
  const tReal = !isBlankName(t.name);
  const sReal = !isBlankName(s.name);
  const nameFromSource = !tReal && sReal;
  const name = nameFromSource ? clean(s.name) : str(t.name);
  if (tReal && sReal && clean(t.name).toLowerCase() !== clean(s.name).toLowerCase()) {
    warnings.push({ code: 'name_differs', message: `The name "${clean(s.name)}" is not kept: the kept profile is "${clean(t.name)}".` });
  }
  // First and last names only travel with a name that matches, or into a profile with no name.
  const namesAgree = !tReal || !sReal || clean(t.name).toLowerCase() === clean(s.name).toLowerCase();
  const first = has(t.first_name) ? t.first_name : (namesAgree && has(s.first_name) ? s.first_name : (t.first_name ?? null));
  const last = has(t.last_name) ? t.last_name : (namesAgree && has(s.last_name) ? s.last_name : (t.last_name ?? null));

  // ── birthday ──
  const birthday = t.birthday || s.birthday || null;
  if (t.birthday && s.birthday && String(t.birthday) !== String(s.birthday)) {
    warnings.push({ code: 'birthday_differs', message: `The birthday ${s.birthday} is not kept: the kept profile says ${t.birthday}.` });
  }

  // ── marketing: yes if either said yes, unless the newest consent record says no ──
  const eitherYes = !!t.marketing_opt_in || !!s.marketing_opt_in;
  const optIn = eitherYes && opts.latestConsent !== false;
  if (eitherYes && opts.latestConsent === false) {
    warnings.push({ code: 'marketing_off', message: 'Marketing stays off: the newest consent record says no.' });
  }
  const optInAt = optIn
    ? (earlier(t.marketing_opt_in ? t.marketing_opt_in_at : null, s.marketing_opt_in ? s.marketing_opt_in_at : null) || now)
    : (t.marketing_opt_in_at ?? null);

  // ── notes: both kept, never the same text twice ──
  const tNotes = str(t.notes);
  const sNotes = clean(s.notes);
  const notes = !sNotes || tNotes.includes(sNotes) ? (t.notes ?? null) : (has(tNotes) ? `${tNotes}\n${sNotes}` : sNotes);

  // ── the stored card (a pair: never one half from each) ──
  const cardFromSource = !has(t.shopper_reference) && has(s.shopper_reference);

  const sourceOwnTags = arr(s.tags).filter((x) => !SOURCE_ONLY_TAGS.some((p) => String(x).startsWith(p)));
  const target = {
    ...pick(t, CUSTOMER_UPSERT_COLUMNS),
    name,
    first_name: first ?? null,
    last_name: last ?? null,
    birthday,
    notes,
    allergens: union(t.allergens, s.allergens),
    marketing_opt_in: optIn,
    marketing_opt_in_at: optInAt,
    sources: union(t.sources, s.sources),
    source: t.source ?? s.source ?? null,
    tags: union(t.tags, sourceOwnTags, [MERGE_TAG.FROM + s.id]),
    no_shows: int(t.no_shows) + int(s.no_shows),
    welcome_sent_at: earlier(t.welcome_sent_at, s.welcome_sent_at),
    is_local: t.is_local ?? s.is_local ?? null,
    shopper_reference: cardFromSource ? s.shopper_reference : (t.shopper_reference ?? null),
    stored_payment_method_id: cardFromSource ? (s.stored_payment_method_id ?? null) : (t.stored_payment_method_id ?? null),
    // The survivor's phone and email stay as they are in this statement: the source still holds
    // its own until the same statement clears it, and the move comes after (customerMergeRun.js).
    // An empty one is written as null: the hand over only ever fills a field that IS null.
    phone: targetLetsGoOfPhone || !has(t.phone) ? null : t.phone,
    phone_raw: targetLetsGoOfPhone || !has(t.phone_raw) ? null : t.phone_raw,
    email: has(t.email) ? t.email : null,
    deleted_at: null,
    updated_at: now,
  };
  const handsOver = Object.keys(move).length > 0;
  const source = {
    ...pick(s, CUSTOMER_UPSERT_COLUMNS),
    name: str(s.name),                  // NOT NULL: the folded in profile keeps its (blank) name
    sources: arr(s.sources),
    phone: null,
    phone_raw: null,
    email: null,
    no_shows: 0,
    // Nothing to hand over: the merge is done the moment this statement lands.
    tags: union(s.tags, [MERGE_TAG.INTO + t.id], sourceTags, handsOver ? [] : [MERGE_TAG.DONE]),
    deleted_at: s.deleted_at || now,
    updated_at: now,
  };
  const finish = handsOver ? { tags: union(source.tags, [MERGE_TAG.DONE]) } : null;
  return { target, source, move, refusals, warnings, finish };
}

// ── memberships ─────────────────────────────────────────────────────────────

function zeroed(row, sumFields) {
  const z = { ...row };
  for (const f of sumFields) z[f] = 0;
  return z;
}

function isZero(row, sumFields) {
  return sumFields.every((f) => int(row?.[f]) === 0);
}

/**
 * One membership per company survives. A company only the source belongs to is MOVED (its row
 * changes customer, one update, safe to repeat). A company both belong to is FOLDED: the target
 * row gets the sums and the source row is zeroed in the SAME statement, then the source row is
 * deleted. A zeroed source adds nothing on a retry.
 */
export function planMemberships(targetId, sourceId, tList = [], sList = []) {
  const out = { moves: [], upserts: [], referrals: [], deletes: [], kept_codes: [], dropped_codes: [] };
  const tByCompany = new Map(tList.map((m) => [String(m.company_id), m]));
  for (const t of tList) if (t.member_code) out.kept_codes.push(t.member_code);
  for (const s of sList) {
    const t = tByCompany.get(String(s.company_id));
    if (!t) {
      out.moves.push({ id: s.id, company_id: s.company_id, member_code: s.member_code ?? null });
      if (s.member_code) out.kept_codes.push(s.member_code);
      continue;
    }
    const next = pick(t, MEMBERSHIP_UPSERT_COLUMNS);
    for (const f of MEMBERSHIP_SUM_FIELDS) next[f] = int(t[f]) + int(s[f]);
    next.enrolled_at = earlier(t.enrolled_at, s.enrolled_at);
    next.last_earn_at = later(t.last_earn_at, s.last_earn_at);
    next.last_redeem_at = later(t.last_redeem_at, s.last_redeem_at);
    next.points_expire_at = later(t.points_expire_at, s.points_expire_at);
    if (!t.tier_id && s.tier_id) { next.tier_id = s.tier_id; next.tier_qualified_at = s.tier_qualified_at ?? null; }
    next.birthday = t.birthday ?? s.birthday ?? null;
    // Who referred them: the target's own referrer first, never either of the two memberships.
    next.referred_by = [t.referred_by, s.referred_by]
      .find((ref) => ref && String(ref) !== String(t.id) && String(ref) !== String(s.id)) ?? null;
    const sZero = zeroed(pick(s, MEMBERSHIP_UPSERT_COLUMNS), MEMBERSHIP_SUM_FIELDS);
    if (changedAny(next, t, MEMBERSHIP_UPSERT_COLUMNS) || !isZero(s, MEMBERSHIP_SUM_FIELDS)) out.upserts.push(sZero, next);
    out.referrals.push({ from: s.id, to: t.id });
    out.deletes.push({ id: s.id });
    if (s.member_code) out.dropped_codes.push(s.member_code);
  }
  return out;
}

// ── stamp cards ─────────────────────────────────────────────────────────────

/**
 * One card per programme survives, the same way as memberships. Sums past a full card roll into
 * completed_count, exactly as loyalty-earn does, so a card never reads 12/10.
 * @param {Array<{id:string, stamps_required?:number, name?:string}>} programs
 */
export function planStampCards(targetId, sourceId, tCards = [], sCards = [], programs = []) {
  const out = { moves: [], upserts: [], deletes: [], rolled: [] };
  const need = new Map(programs.map((p) => [String(p.id), int(p.stamps_required)]));
  const key = (c) => `${c.company_id}|${c.program_id}`;
  const tByKey = new Map(tCards.map((c) => [key(c), c]));
  for (const s of sCards) {
    const t = tByKey.get(key(s));
    if (!t) { out.moves.push({ id: s.id, program_id: s.program_id }); continue; }
    let collected = int(t.stamps_collected) + int(s.stamps_collected);
    let completed = int(t.completed_count) + int(s.completed_count);
    const required = need.get(String(s.program_id)) || 0;
    let rolled = 0;
    if (required > 0) while (collected >= required) { collected -= required; completed += 1; rolled += 1; }
    if (rolled) out.rolled.push({ program_id: s.program_id, cards: rolled });
    const next = { ...pick(t, CARD_UPSERT_COLUMNS), stamps_collected: collected, completed_count: completed, last_stamp_at: later(t.last_stamp_at, s.last_stamp_at) };
    const sZero = { ...pick(s, CARD_UPSERT_COLUMNS), stamps_collected: 0, completed_count: 0 };
    if (changedAny(next, t, CARD_UPSERT_COLUMNS) || int(s.stamps_collected) !== 0 || int(s.completed_count) !== 0) out.upserts.push(sZero, next);
    out.deletes.push({ id: s.id });
  }
  return out;
}

// ── venue visit records (customer_locations, primary key customer_id + location_id) ──

export function planCustomerLocations(targetId, sourceId, tRows = [], sRows = []) {
  const out = { moves: [], upserts: [], deletes: [] };
  const tByLoc = new Map(tRows.map((r) => [String(r.location_id), r]));
  for (const s of sRows) {
    const t = tByLoc.get(String(s.location_id));
    if (!t) { out.moves.push({ location_id: s.location_id }); continue; }
    const sNotes = clean(s.notes);
    const tNotes = str(t.notes);
    const next = {
      ...pick(t, LOCATION_UPSERT_COLUMNS),
      first_visit_at: earlier(t.first_visit_at, s.first_visit_at),
      last_visit_at: later(t.last_visit_at, s.last_visit_at),
      visit_count: int(t.visit_count) + int(s.visit_count),
      lifetime_revenue: addDecimal(t.lifetime_revenue, s.lifetime_revenue),
      notes: !sNotes || tNotes.includes(sNotes) ? (t.notes ?? null) : (has(tNotes) ? `${tNotes}\n${sNotes}` : sNotes),
    };
    const sZero = { ...pick(s, LOCATION_UPSERT_COLUMNS), visit_count: 0, lifetime_revenue: 0, notes: null };
    const sEmpty = int(s.visit_count) === 0 && (Number(s.lifetime_revenue) || 0) === 0 && !sNotes;
    if (changedAny(next, t, LOCATION_UPSERT_COLUMNS) || !sEmpty) out.upserts.push(sZero, next);
    out.deletes.push({ location_id: s.location_id });
  }
  return out;
}

/**
 * Rows of a table whose unique key includes customer_id: those the target does not already hold
 * move, the rest stay on the folded in profile. A NULL in the key never clashes (Postgres unique
 * indexes treat NULLs as distinct).
 */
export function partitionClashes(sRows = [], tRows = [], keyCols = []) {
  const k = (r) => (keyCols.some((c) => r?.[c] == null) ? null : keyCols.map((c) => String(r[c])).join('|'));
  const taken = new Set(tRows.map(k).filter((x) => x != null));
  const move = []; const stay = [];
  for (const r of sRows) {
    const key = k(r);
    if (key != null && taken.has(key)) stay.push(r.id); else move.push(r.id);
  }
  return { move, stay };
}

// ── the whole plan ──────────────────────────────────────────────────────────

const refusal = (code, message) => ({ code, message });

function displayName(c) {
  return isBlankName(c?.name) ? 'No name' : clean(c.name);
}

/** A profile in a sentence: its name, or "the profile with no name" (capitalised to start one). */
function called(c, start = false) {
  if (!isBlankName(c?.name)) return clean(c.name);
  return start ? 'The profile with no name' : 'the profile with no name';
}

/**
 * The plan for folding two profiles. `a` is the profile the caller named as the target, `b` the
 * one named as the source (both read with deleted rows included). Nothing here is a write.
 *
 * @param {{
 *   a: object|null, b: object|null,
 *   memberships?: object[], cards?: object[], programs?: object[],
 *   activity?: Record<string, {orders?: number, ledger?: number}>,
 *   latestConsent?: boolean|null,
 *   phoneChoice?: 'target'|'source'|null,
 *   holders?: object[],   // live customers holding a phone or email a resume would hand over
 *   now: string,
 * }} input
 */
export function planMerge(input) {
  const { a, b, now } = input;
  const plan = {
    ok: false, mode: 'fresh', target_id: null, source_id: null, swapped: false,
    refusals: [], warnings: [], source_blank: false,
    target_history: null, source_history: null,
    customers: null, memberships: null, stamp_cards: null, summary: [],
  };
  if (!a || !b) {
    plan.refusals.push(refusal('not_found', 'One of the two customers could not be found.'));
    return plan;
  }
  if (String(a.id) === String(b.id)) {
    plan.refusals.push(refusal('same_customer', 'That is the same customer twice.'));
    return plan;
  }
  if (!a.org_id || String(a.org_id) !== String(b.org_id)) {
    plan.refusals.push(refusal('different_org', 'These two customers belong to different businesses, so they cannot be merged.'));
    return plan;
  }

  const memberships = input.memberships || [];
  const cards = input.cards || [];
  const programs = input.programs || [];
  const act = input.activity || {};
  const mine = (list, id) => list.filter((r) => String(r.customer_id) === String(id));
  const histA = historyOf(a, mine(memberships, a.id), mine(cards, a.id), act[a.id]);
  const histB = historyOf(b, mine(memberships, b.id), mine(cards, b.id), act[b.id]);

  // ── a merge that stopped half way is finished, not refused ──
  const foldedInto = (src, tgt) => !!src.deleted_at && mergedIntoOf(src.tags) === String(tgt.id);
  let target; let source; let swapped = false; let resume = false;
  if (foldedInto(b, a)) { target = a; source = b; resume = true; }
  else if (foldedInto(a, b)) { target = b; source = a; swapped = true; resume = true; }
  else {
    for (const c of [a, b]) {
      if (!c.deleted_at) continue;
      const into = mergedIntoOf(c.tags);
      plan.refusals.push(into
        ? refusal('merged_elsewhere', `${called(c, true)} was already merged into another profile (${into}). Merge with that one instead.`)
        : refusal('deleted', `${called(c, true)} was deleted, so it cannot be merged.`));
    }
    if (plan.refusals.length) return plan;
    ({ target, source, swapped } = chooseSurvivor(a, b, histA, histB));
  }
  if (target.deleted_at) {
    plan.refusals.push(refusal('deleted', `${called(target, true)} was deleted, so it cannot be merged into.`));
    return plan;
  }
  // 27 Sep 2026 (first review): the fold statement writes merged_into on the source AND merged:
  // on the survivor, together. One half alone is not a merge this code made, so it never hands
  // a phone or an email over.
  if (resume && !carriesMergeFrom(target.tags, source.id)) {
    plan.refusals.push(refusal('merge_trail_broken', `${called(source, true)} is marked as merged into ${called(target)}, but ${called(target)} has no record of that merge, so it cannot be finished here. Nothing was changed.`));
    return plan;
  }

  plan.mode = resume ? 'resume' : 'fresh';
  plan.target_id = target.id;
  plan.source_id = source.id;
  plan.swapped = swapped;
  plan.target_history = target === a ? histA : histB;
  plan.source_history = source === a ? histA : histB;
  plan.source_blank = isBlankShell(source, plan.source_history);

  const fields = mergeCustomerFields(target, source, {
    phoneChoice: input.phoneChoice ?? null,
    latestConsent: input.latestConsent ?? null,
    now,
    resume,
    holders: input.holders || [],
  });
  plan.customers = { target: fields.target, source: fields.source, move: fields.move, finish: fields.finish };
  plan.refusals.push(...fields.refusals);
  plan.warnings.push(...fields.warnings);

  plan.memberships = planMemberships(target.id, source.id, mine(memberships, target.id), mine(memberships, source.id));
  plan.stamp_cards = planStampCards(target.id, source.id, mine(cards, target.id), mine(cards, source.id), programs);

  for (const code of plan.memberships.dropped_codes) {
    plan.warnings.push({ code: 'member_code_retired', message: `Member code ${code} stops working; ${plan.memberships.kept_codes[0] || 'the kept code'} is kept.` });
  }
  for (const r of plan.stamp_cards.rolled) {
    const p = programs.find((x) => String(x.id) === String(r.program_id));
    plan.warnings.push({ code: 'stamps_rolled_over', message: `Together the ${p?.name || 'stamp'} cards fill ${r.cards} more card${r.cards === 1 ? '' : 's'}, so ${r.cards === 1 ? 'it becomes a reward' : 'they become rewards'}.` });
  }

  plan.summary = summaryLines(plan, target, source, memberships, cards, programs);
  plan.ok = plan.refusals.length === 0;
  return plan;
}

/** The plan in plain English, for the preview screens. */
export function summaryLines(plan, target, source, memberships = [], cards = [], programs = []) {
  const lines = [];
  const tName = called(target, true);
  const mv = plan.customers?.move || {};
  if (plan.mode === 'resume') {
    const pending = !!plan.customers?.finish || Object.keys(mv).length > 0
      || !!plan.memberships?.moves?.length || !!plan.memberships?.deletes?.length
      || !!plan.stamp_cards?.moves?.length || !!plan.stamp_cards?.deletes?.length;
    lines.push(pending
      ? `${called(source, true)} was already folded into ${called(target)}; this finishes the job.`
      : `${called(source, true)} is already merged into ${called(target)}. Nothing on ${called(target)} is changed.`);
  } else lines.push(`${tName} is kept. ${called(source, true)} is folded into it and removed from the customer list.`);
  if (mv.phone || mv.phone_raw) lines.push(`${tName} gets the phone ${maskPhone(mv.phone || mv.phone_raw)}.`);
  if (mv.email) lines.push(`${tName} gets the email ${maskEmail(mv.email)}.`);
  if (plan.customers?.target && plan.customers.target.name !== str(target.name)) lines.push(`${tName} gets the name ${plan.customers.target.name}.`);
  const sM = memberships.filter((m) => String(m.customer_id) === String(source.id));
  const pts = sM.reduce((n, m) => n + int(m.points_balance), 0);
  if (pts) lines.push(`${pts} points are added.`);
  const sC = cards.filter((c) => String(c.customer_id) === String(source.id));
  for (const c of sC) {
    const st = int(c.stamps_collected); const done = int(c.completed_count);
    if (!st && !done) continue;
    const p = programs.find((x) => String(x.id) === String(c.program_id));
    lines.push(`${st} ${p?.name ? `${p.name} ` : ''}stamp${st === 1 ? '' : 's'}${done ? ` and ${done} completed card${done === 1 ? '' : 's'}` : ''} are added.`);
  }
  return lines;
}

// ── who may ask ─────────────────────────────────────────────────────────────

/** Roles on a venue link (user_locations.role) that may merge. */
export const MERGE_VENUE_ROLES = Object.freeze(['owner', 'manager']);
/** Platform user_company_roles.role values that may merge (live values 26 Sep 2026: owner, admin). */
export const MERGE_COMPANY_ROLES = Object.freeze(['owner', 'admin', 'manager']);

/**
 * Is this Back Office login an owner or manager of the venue (or a super admin)? Never an
 * anonymous session: the kiosk, online and QR pages hold one whose profile row says 'owner'.
 * @returns {null|'super_admin'|'venue_role'|'owner_org'|'company_role'}
 */
export function staffMergeRole(f) {
  if (!f || !f.user || f.user.is_anonymous || !f.user.id) return null;
  if (f.profileRole === 'super_admin') return 'super_admin';
  if (f.linkRole && MERGE_VENUE_ROLES.includes(String(f.linkRole))) return 'venue_role';
  // The owner of the organisation holds every venue in it (venueWriter.js, 21 Sep 2026).
  if (f.profileRole === 'owner' && f.profileOrgId && f.venueOrgId && String(f.profileOrgId) === String(f.venueOrgId)) return 'owner_org';
  if (f.companyRole && MERGE_COMPANY_ROLES.includes(String(f.companyRole))) return 'company_role';
  return null;
}

/** The Back Office button's gate: the same rule the function applies. */
export function canStaffMerge(f) {
  return staffMergeRole({ ...f, user: f?.user || { id: 'me', is_anonymous: false } }) !== null;
}

/**
 * The decision for one call. 18 Sep 2026: any JWT is not authority. Exactly one of:
 *   * the service role (another edge function);
 *   * an owner or manager of the venue named by location_id, or a super admin (staffMergeRole);
 *   * a till BOUND to that venue (the device arm of pos_can_access), and ONLY when the profile
 *     being folded in is an empty shell (the till case: it can hand a phone to the real profile,
 *     never pour one real customer's stamps into another's).
 * The venue must belong to the customers' organisation, whoever asks.
 */
export function decideMergeCaller(f) {
  if (!f?.service && (!f?.user || !f.user.id)) return { ok: false, status: 401, code: 'sign_in', error: 'Sign in first.' };
  if (!f.venueOrgId || !f.customersOrgId || String(f.venueOrgId) !== String(f.customersOrgId)) {
    return { ok: false, status: 403, code: 'other_org', error: 'These customers belong to another business.' };
  }
  if (f.service) return { ok: true, as: 'service', via: 'service_role' };
  const staff = staffMergeRole(f);
  if (staff) return { ok: true, as: 'staff', via: staff };
  if (f.device) {
    if (f.sourceBlank) return { ok: true, as: 'device', via: 'device' };
    return {
      ok: false, status: 403, code: 'device_needs_blank_source',
      error: 'A till can only fold in an empty profile (no name, email, points, stamps or orders). Ask a manager to merge these two in Back Office.',
    };
  }
  return { ok: false, status: 403, code: 'not_allowed', error: 'Only an owner or a manager can merge customers.' };
}

// ── the request ─────────────────────────────────────────────────────────────

export const MERGE_ACTIONS = Object.freeze(['preview', 'merge']);

/**
 * The ONLY reader of the request body (customer-merge/index.ts). Keys:
 *   action 'preview' | 'merge', target_id, source_id, location_id (uuids),
 *   phone_choice 'target' | 'source' (optional; staff only).
 */
export function validateMergeRequest(body) {
  const b = body && typeof body === 'object' ? body : {};
  const action = String(b.action || '');
  if (!MERGE_ACTIONS.includes(action)) return { ok: false, error: "action must be 'preview' or 'merge'" };
  if (!isUuid(b.target_id) || !isUuid(b.source_id)) return { ok: false, error: 'target_id and source_id must be customer ids' };
  if (!isUuid(b.location_id)) return { ok: false, error: 'location_id must be the venue the call is made from' };
  const pc = b.phone_choice == null || b.phone_choice === '' ? null : String(b.phone_choice);
  if (pc !== null && pc !== 'target' && pc !== 'source') return { ok: false, error: "phone_choice must be 'target' or 'source'" };
  return { ok: true, action, targetId: b.target_id, sourceId: b.source_id, locationId: b.location_id, phoneChoice: pc };
}

/**
 * A customers save refused by a unique index: 'phone' or 'email', or null for any other error.
 * The Back Office and the till show "already on <name>. Merge them?" instead of the raw error.
 */
export function uniqueClashOf(err) {
  if (!err) return null;
  const code = String(err.code || '');
  const text = `${err.message || ''} ${err.details || ''} ${err.hint || ''}`;
  if (code !== '23505' && !/duplicate key value/i.test(text)) return null;
  if (/idx_customers_org_email|lower\(email\)/i.test(text)) return 'email';
  if (/idx_customers_org_phone|\(org_id, phone\)/i.test(text)) return 'phone';
  return null;
}

/**
 * The survivor as this caller may see it. 27 Sep 2026: a till got the whole customers row back
 * (notes, tags, sources, the merge trail), which the customer fence (20260921) never gives a
 * till. A till gets what its screen shows; staff and the service role get the row.
 */
export function survivorForCaller(customer, as) {
  if (!customer) return null;
  if (as !== 'device') return customer;
  return {
    id: customer.id,
    name: customer.name ?? '',
    phone: customer.phone ?? null,
    email: customer.email ?? null,
    marketing_opt_in: !!customer.marketing_opt_in,
    allergens: Array.isArray(customer.allergens) ? customer.allergens : [],
  };
}

/** The preview card for one profile: masked contact, never the full phone or email. */
export function profileCard(c, history, memberships = [], cards = [], programs = []) {
  if (!c) return null;
  const mine = (list) => list.filter((r) => String(r.customer_id) === String(c.id));
  const ms = mine(memberships);
  return {
    id: c.id,
    name: displayName(c),
    phone: maskPhone(c.phone || c.phone_raw || tagValue(c.tags, MERGE_TAG.PHONE)),
    email: maskEmail(c.email || tagValue(c.tags, MERGE_TAG.EMAIL)),
    created_at: c.created_at ?? null,
    deleted: !!c.deleted_at,
    imported: !!history?.imported,
    orders: int(history?.orders),
    points: ms.reduce((n, m) => n + int(m.points_balance), 0),
    member_codes: ms.map((m) => m.member_code).filter(Boolean),
    stamps: mine(cards).map((card) => {
      const p = programs.find((x) => String(x.id) === String(card.program_id));
      return {
        program_id: card.program_id,
        name: p?.name ?? null,
        stamps_required: p ? int(p.stamps_required) : null,
        stamps_collected: int(card.stamps_collected),
        completed_count: int(card.completed_count),
      };
    }),
  };
}
