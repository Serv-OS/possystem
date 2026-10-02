// supabase/functions/_shared/repeatCharge.js
//
// IS THIS CARD PAYMENT A REPEAT OF ONE THIS TILL JUST TOOK?
//
// Pure decisions only. No I/O, no Deno, no Supabase: imported by terminal-job-create
// (the check before the insert) and by adyen-terminal-charge (the same card, same
// amount alert after an approved settle), and unit tested from
// src/lib/payments/repeatCharge.test.js under plain node. Keep it that way.
//
// THE INCIDENT THIS EXISTS FOR (Coffee Boy Huddersfield, 30 Sep 2026, till ff1b5fb8,
// reader a264a739). 12:42:49 job 97c6176c, £11.65, sent to the reader. The checkout
// sat on "Sending…" (it awaited its own Adyen 'start' call, which is the whole
// tender) with × still live, so staff closed it at about 17 s. 12:43:29 approved,
// Visa 9810. 12:43:31 R5737 booked in the background by the till's reconciler: no
// kitchen ticket, cart still on screen. 12:43:43 job bcdcefd6, same £11.65, same
// three items, new check id, so the one live payment per check guard never fired.
// The customer gave up on that one ('108'), staff sent 7da9f45c at 12:45:49, and at
// 12:47:08 the same card paid the same bill again: R5739, refunded at 13:09.
//
// Fix 1 (the till) keeps the checkout on the card screen for the whole tender. THIS
// is fix 2, the server side net that catches every till, stale WebViews included:
// before terminal-job-create inserts a job it looks at the last few minutes on the
// same till or the same reader and refuses with a plain reason when the new job
// looks like a repeat. Staff can say "different customer" and go again; that
// confirmation is recorded on the job (check_draft.repeatAck).
//
// THREE TIERS, in the order they win:
//   live         the other job is still on the reader (claimed, tipping,
//                charging_unsent, charging). Today's TERMINAL_BUSY, now with the job
//                id, amount, time, ref and items, and `adoptable` when the SAME till
//                sent it, so the checkout can offer "Watch that payment" instead of
//                a second charge. Never overridable: cancel it on the machine first.
//   unfinished   the other job was approved inside 10 minutes and its sale is not
//                booked yet, or was booked in the background (closed_checks.source
//                'pos_send_to_terminal', the reconciler's stamp: a checkout that
//                finished on screen writes 'pos' or nothing). The items of that
//                sale are all in the new basket (a subset: R9926 was rung again as
//                R9927 with two waters added). Any amount. Staff must confirm.
//   same_basket  the other job was approved inside 5 minutes for the same amount
//                and the same items, and its sale WAS booked by a checkout. Two
//                customers buying the same flat white 4 minutes apart is normal
//                (a replay of 3 days of live sends: 13 hits, 12 of them a DIFFERENT
//                card, Leeds 28 Sep 10:44 three £3.85 flat whites 13 s apart in a
//                queue), so this NEVER refuses. It rides on the 200 body as
//                repeat_warning and the card screen shows it as advice.
//
// WHAT NEVER FIRES: a different till on a different reader; anything over 10
// minutes; a prior sale that was refunded or voided; the same amount for a
// different basket (Leeds, 30 Sep: £4.10 Latte then £4.10 Mocha 9 minutes later);
// the same check_key (that is a retry, and idx_tj_one_live_per_check owns it);
// simulated or training jobs; jobs still 'unknown' (a manager releases those);
// a prior from a source whose draft carries no items and never books under its own
// closed_check_id (split legs, kiosk, pay at table): two £10.00 split legs at 12:00
// looked like an unbooked £10.00 sale to the 12:06 customer, review 30 Sep.
//
// WHO IS CHECKED (the new send): the till checkout only. MPOS (MCardFlow.jsx) shows
// a 409 as a dead error with no button, so on a stale MPOS a refusal would block
// the card path for 10 minutes with no way through. MPOS sends are checked once
// MCardFlow learns the dialog. MPOS priors still count against a till send.
//
// STATUS VOCABULARY. A booked approved job is flipped to 'reconciled' by the device
// that booked it (1,431 of 1,527 rows in the last 7 days). Both mean "the card
// was charged" here.

/** How far back the caller should read and the widest tier looks. */
export const REPEAT_WINDOW_MS = 10 * 60_000;
/** The softer same basket warning only looks this far back. */
export const SAME_BASKET_WINDOW_MS = 5 * 60_000;
/** The after the fact alert (adyen-terminal-charge): same card, same amount, another check. */
export const SAME_CARD_WINDOW_MS = 15 * 60_000;
/** Statuses that mean "the reader is taking this payment now" (the busy index's set). */
export const LIVE_STATUSES = Object.freeze(['claimed', 'tipping', 'charging_unsent', 'charging']);
/** Statuses that mean "the card was charged". */
export const CHARGED_STATUSES = Object.freeze(['approved', 'reconciled']);
/**
 * check_draft.source values the repeat check runs FOR (the new send). Only the till checkout:
 * it is the one screen that can answer a 409 POSSIBLE_REPEAT with the three buttons. MPOS,
 * kiosk, QR, pay at table and split legs are not checked (see the header).
 */
export const REPEAT_CHECKED_SOURCES = Object.freeze(['pos_send_to_terminal']);
/**
 * check_draft.source values a PRIOR job must have to count for the approved tiers. These
 * drafts carry the basket and book under their own closed_check_id, so "not booked yet" and
 * "the same items" mean something. A split leg ('pos_split_leg', no items, closed_check_id
 * 'chk-split-…' that is never a closed_checks id), a kiosk or a pay at table job never do.
 */
export const REPEAT_PRIOR_SOURCES = Object.freeze(['pos_send_to_terminal', 'mpos_cloud_terminal']);
/** closed_checks.source values only ever written by a background (reconciler) booking. */
export const BACKGROUND_BOOKED_SOURCES = Object.freeze(['pos_send_to_terminal']);
/** Items named in a staff message before "and N more". */
export const SUMMARY_ITEMS = 4;

const TIER_RANK = { live: 3, unfinished: 2, same_basket: 1 };

function ms(v) {
  if (v == null) return NaN;
  if (typeof v === 'number') return v;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : NaN;
}

function draftOf(job) {
  const d = job && typeof job === 'object' ? job.check_draft : null;
  return d && typeof d === 'object' && !Array.isArray(d) ? d : {};
}

/** Should terminal-job-create run the repeat check for this draft at all? */
export function shouldCheckRepeat(checkDraft) {
  const src = checkDraft && typeof checkDraft === 'object' ? checkDraft.source : null;
  return typeof src === 'string' && REPEAT_CHECKED_SOURCES.includes(src);
}

/** Whole minor units of a job's bill (before any reader tip), or null. */
function dueMinorOf(job) {
  const n = Number(job?.due_minor);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

/** What the card was (or will be) asked for: the charge, else the due. */
function amountMinorOf(job) {
  const c = Number(job?.charge_minor);
  if (Number.isFinite(c) && c > 0) return Math.round(c);
  return dueMinorOf(job) ?? 0;
}

const normText = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
const normPrice = (p) => {
  const n = Number(p);
  return Number.isFinite(n) ? n.toFixed(2) : '?';
};
const qtyOf = (i) => {
  const n = Number(i?.qty);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 1;
};

/**
 * One basket line WITHOUT its quantity: name, unit price and the modifiers, so
 * "Cappuccino Big Boy, skinny, caramel" and the same drink with oat milk are
 * different lines. Voided lines are not lines.
 */
export function itemLineKey(item) {
  if (!item || typeof item !== 'object') return null;
  if (item.voided === true) return null;
  const name = normText(item.name || item.receiptName || item.kitchenName);
  if (!name) return null;
  const mods = (Array.isArray(item.mods) ? item.mods : [])
    .map((m) => `${normText(m?.name ?? m?.label)}@${normPrice(m?.price ?? 0)}`)
    .filter((m) => !m.startsWith('@'))
    .sort()
    .join(',');
  return `${name}|${normPrice(item.price)}|${mods}`;
}

/** The basket as a multiset: line key to total quantity. */
export function itemCounts(items) {
  const out = new Map();
  for (const it of Array.isArray(items) ? items : []) {
    const k = itemLineKey(it);
    if (!k) continue;
    out.set(k, (out.get(k) ?? 0) + qtyOf(it));
  }
  return out;
}

/** A stable text signature of the basket ('' when it has no lines). Equal signatures = the same basket. */
export function itemSignature(items) {
  return [...itemCounts(items).entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, q]) => `${q}x ${k}`).join('\n');
}

/** Every line of `prior` (with its quantity) is in `next`. An empty prior is NOT a subset (nothing to compare). */
export function isSubsetBasket(prior, next) {
  const a = itemCounts(prior);
  if (a.size === 0) return false;
  const b = itemCounts(next);
  for (const [k, q] of a) if ((b.get(k) ?? 0) < q) return false;
  return true;
}

/** Total quantity across the basket. */
export function itemQuantity(items) {
  let n = 0;
  for (const q of itemCounts(items).values()) n += q;
  return n;
}

/** "1x Cappuccino Big Boy, 1x Latte Big Boy, 1x Chocolonely and 2 more" for a staff message. */
export function itemSummary(items, max = SUMMARY_ITEMS) {
  const lines = [];
  for (const it of Array.isArray(items) ? items : []) {
    if (!itemLineKey(it)) continue;
    const name = String(it.name || it.receiptName || it.kitchenName).replace(/\s+/g, ' ').trim();
    lines.push(`${qtyOf(it)}x ${name}`);
  }
  if (lines.length === 0) return '';
  if (lines.length <= max) return lines.join(', ');
  return `${lines.slice(0, max).join(', ')} and ${lines.length - max} more`;
}

/**
 * Where the prior job's sale stands, from its closed_checks row (matched by
 * terminal_jobs.closed_check_id = closed_checks.id, the id the till pre-mints):
 *   'refunded'    refunded or voided: the customer has their money, no repeat
 *   'background'  booked by a reconciler (source 'pos_send_to_terminal'): the
 *                 checkout never finished it, nobody printed a ticket
 *   'checkout'    booked by the checkout that took it, the normal case
 *   'none'        approved, no row yet (the reconciler has not ticked)
 */
export function bookedState(booked) {
  if (!booked || typeof booked !== 'object') return 'none';
  if (booked.refunded === true || booked.voided === true || booked.status === 'refunded' || booked.status === 'voided') return 'refunded';
  if (typeof booked.source === 'string' && BACKGROUND_BOOKED_SOURCES.includes(booked.source)) return 'background';
  return 'checkout';
}

const CURRENCY_SYMBOL = { GBP: '£', USD: '$', EUR: '€' };
/** "£11.65", "$4.70"; an unknown currency prints its code. */
export function fmtMoney(minor, currency) {
  const code = String(currency || 'GBP').toUpperCase();
  const sym = CURRENCY_SYMBOL[code];
  const n = (Number(minor) || 0) / 100;
  return sym ? `${sym}${n.toFixed(2)}` : `${n.toFixed(2)} ${code}`;
}

/** "12:43" on the venue's wall clock. A bad zone falls back to Europe/London; a bad time is ''. */
export function fmtTime(iso, tz) {
  const t = ms(iso);
  if (!Number.isFinite(t)) return '';
  const opts = { hour: '2-digit', minute: '2-digit', hour12: false };
  let f;
  try { f = new Intl.DateTimeFormat('en-GB', { ...opts, timeZone: tz || 'Europe/London' }); }
  catch { f = new Intl.DateTimeFormat('en-GB', { ...opts, timeZone: 'Europe/London' }); }
  return f.format(new Date(t)).replace(/^24:/, '00:');
}

const BRAND_NAMES = { visa: 'Visa', mc: 'Mastercard', mastercard: 'Mastercard', amex: 'Amex', maestro: 'Maestro', discover: 'Discover', diners: 'Diners', jcb: 'JCB', cup: 'UnionPay', unionpay: 'UnionPay' };
/** "Visa ••9810", or '' when the job has no card block yet. */
export function fmtCard(card) {
  if (!card || typeof card !== 'object') return '';
  const brandKey = normText(card.brand);
  const brand = BRAND_NAMES[brandKey] ?? (brandKey ? brandKey.charAt(0).toUpperCase() + brandKey.slice(1) : '');
  const last4 = String(card.last4 ?? '').trim();
  if (!brand && !last4) return '';
  return [brand, last4 ? `••${last4}` : ''].filter(Boolean).join(' ');
}

/**
 * The prior job as the checkout needs to see it: what was charged, when, on what
 * card, for what, and where its sale stands. Nothing here is a secret the till
 * cannot already read from terminal-job-status.
 */
export function repeatDetail(job, booked = null, { now = Date.now() } = {}) {
  const d = draftOf(job);
  const items = Array.isArray(d.items) ? d.items : [];
  const settledAt = job?.settled_at ?? job?.charged_at ?? null;
  const sentAt = job?.dispatched_at ?? job?.created_at ?? null;
  const state = bookedState(booked);
  return {
    job_id: job?.id ?? null,
    status: job?.status ?? null,
    amount_minor: amountMinorOf(job),
    due_minor: dueMinorOf(job),
    currency: String(job?.currency || 'GBP').toUpperCase(),
    sent_at: sentAt,
    settled_at: settledAt,
    at: settledAt ?? sentAt,
    age_ms: Number.isFinite(ms(settledAt ?? sentAt)) ? Math.max(0, now - ms(settledAt ?? sentAt)) : null,
    ref: booked?.ref ?? d.orderRef ?? null,
    order_ref: d.orderRef ?? null,
    closed_check_id: job?.closed_check_id ?? null,
    table_label: d.tableLabel ?? d.tableId ?? null,
    items: itemSummary(items),
    item_count: itemQuantity(items),
    card: job?.card && (job.card.brand || job.card.last4) ? { brand: job.card.brand ?? null, last4: job.card.last4 ?? null } : null,
    pos_device_id: job?.pos_device_id ?? null,
    target_terminal_id: job?.target_terminal_id ?? null,
    source: d.source ?? null,
    booked: state,
  };
}

/**
 * Look for a repeat of `newReq` among `recentJobs` (terminal_jobs rows, newest or
 * oldest first, with an optional `booked` closed_checks row attached to each by the
 * caller). Returns null, or the strongest hit:
 *   { tier, job: repeatDetail, adoptable, same_items, subset_items, same_amount }
 *
 * @param {object} newReq  { job_id, check_key, location_id, pos_device_id, target_terminal_id,
 *                           due_minor, check_draft: { items, source } }
 * @param {Array<object>} recentJobs
 * @param {number} now epoch ms
 */
export function findPossibleRepeat(newReq, recentJobs, now = Date.now()) {
  if (!newReq || typeof newReq !== 'object') return null;
  const newItems = Array.isArray(draftOf(newReq).items) ? draftOf(newReq).items : [];
  const newSig = itemSignature(newItems);
  const newDue = dueMinorOf(newReq);
  const newDevice = newReq.pos_device_id ?? null;
  const newTerminal = newReq.target_terminal_id ?? null;

  let best = null;
  for (const job of Array.isArray(recentJobs) ? recentJobs : []) {
    if (!job || typeof job !== 'object' || !job.id) continue;
    if (newReq.job_id && job.id === newReq.job_id) continue;
    if (newReq.check_key && job.check_key === newReq.check_key) continue;   // a retry, not a repeat
    if (newReq.location_id && job.location_id && job.location_id !== newReq.location_id) continue;
    if (job.simulated === true || job.training === true) continue;
    const sameTill = !!newDevice && job.pos_device_id === newDevice;
    const sameReader = !!newTerminal && job.target_terminal_id === newTerminal;
    if (!sameTill && !sameReader) continue;

    const d = draftOf(job);
    const priorItems = Array.isArray(d.items) ? d.items : [];
    const priorSig = itemSignature(priorItems);
    const sameItems = !!newSig && !!priorSig && newSig === priorSig;
    const subsetItems = sameItems || isSubsetBasket(priorItems, newItems);
    const sameAmount = newDue != null && dueMinorOf(job) != null && dueMinorOf(job) === newDue;

    let tier = null;
    if (LIVE_STATUSES.includes(job.status)) {
      tier = 'live';
    } else if (CHARGED_STATUSES.includes(job.status)) {
      // Review 30 Sep: only a till or MPOS checkout draft can be "the same sale". A split leg
      // (no items, a closed_check_id that never books) or a kiosk job matched on the amount
      // alone and blocked the next £10.00 customer for 10 minutes. A partial leg (`partial`)
      // is one card of several on one bill, never a whole sale to repeat.
      if (!REPEAT_PRIOR_SOURCES.includes(d.source) || d.partial === true) continue;
      const settled = ms(job.settled_at ?? job.charged_at ?? job.updated_at ?? job.created_at);
      const age = Number.isFinite(settled) ? now - settled : Infinity;
      if (age > REPEAT_WINDOW_MS) continue;
      const state = bookedState(job.booked);
      if (state === 'refunded') continue;
      // No items on either side (an old draft shape of a checked source): the amount is all
      // there is to compare.
      const noItems = priorSig === '' || newSig === '';
      if ((state === 'none' || state === 'background') && (noItems ? sameAmount : subsetItems)) tier = 'unfinished';
      else if (age <= SAME_BASKET_WINDOW_MS && sameAmount && sameItems) tier = 'same_basket';
    }
    if (!tier) continue;

    const hit = {
      tier,
      job: repeatDetail(job, job.booked ?? null, { now }),
      // The same till sent it and its draft carries the order ref the checkout would book:
      // the checkout can mount its card screen on that job instead of sending another.
      adoptable: tier === 'live' && sameTill && d.source === 'pos_send_to_terminal',
      same_items: sameItems,
      subset_items: subsetItems,
      same_amount: sameAmount,
    };
    if (!best || TIER_RANK[tier] > TIER_RANK[best.tier]
        || (TIER_RANK[tier] === TIER_RANK[best.tier] && ms(job.created_at) > ms(best._created))) {
      best = { ...hit, _created: job.created_at };
    }
  }
  if (!best) return null;
  const { _created, ...out } = best;
  return out;
}

/** Plain English for staff, no dashes as punctuation. `tz` is the venue's zone. */
export function repeatMessage(hit, { tz } = {}) {
  if (!hit?.job) return '';
  const j = hit.job;
  const amt = fmtMoney(j.amount_minor, j.currency);
  const ref = j.ref ? `${j.ref}` : '';
  if (hit.tier === 'live') {
    const when = fmtTime(j.sent_at, tz);
    const forWhat = j.table_label ? `for ${j.table_label}` : 'for the order';
    return `The card machine is still taking ${amt} ${forWhat} sent at ${when}${ref ? ` (${ref})` : ''}. `
      + 'If it is this customer, do not send it again.';
  }
  const when = fmtTime(j.at, tz);
  const card = fmtCard(j.card);
  const paidOn = `on this card machine at ${when}${card ? ` (${card})` : ''}`;
  if (hit.tier === 'unfinished') {
    const what = hit.same_items ? 'same items' : `${j.item_count} of these items`;
    const refPart = ref ? `${ref}, ` : (j.booked === 'none' ? 'not booked yet, ' : '');
    return `${amt} was already paid ${paidOn}, ${refPart}${what}. Do not charge again.`;
  }
  return `${amt} for the same items was paid ${paidOn}${ref ? `, ${ref}` : ''}. `
    + 'If this is the same customer, press Cancel payment.';
}

/**
 * What terminal-job-create answers for a hit, or null when the job may go ahead: the
 * caller has already confirmed THIS job (body.repeat_ok_job_id equals the hit's job
 * id), or the hit is the same_basket tier, which only ever advises (repeatWarning). A
 * live tender is never overridable: the reader is busy, cancel it on the machine first.
 *
 * @returns {null | { status: 409, code: 'TERMINAL_BUSY'|'POSSIBLE_REPEAT', error: string, detail: object }}
 */
export function repeatRefusal(hit, repeatOkJobId = null, { tz } = {}) {
  if (!hit?.job?.job_id) return null;
  if (hit.tier === 'same_basket') return null;
  const acknowledged = typeof repeatOkJobId === 'string' && repeatOkJobId === hit.job.job_id;
  if (hit.tier !== 'live' && acknowledged) return null;
  const detail = { tier: hit.tier, adoptable: hit.adoptable === true, same_items: hit.same_items === true, subset_items: hit.subset_items === true, ...hit.job };
  if (hit.tier === 'live') {
    return { status: 409, code: 'TERMINAL_BUSY', error: repeatMessage(hit, { tz }), detail };
  }
  return { status: 409, code: 'POSSIBLE_REPEAT', error: repeatMessage(hit, { tz }), detail };
}

/**
 * The advisory for a same_basket hit, carried on terminal-job-create's 200 body as
 * `repeat_warning` and shown on the card screen while the customer pays. Null for every
 * other tier (those refuse, or were acknowledged). Precision on live data is about 1 in
 * 13, so this is a line of text next to Cancel payment, never a dialog and never a block.
 */
export function repeatWarning(hit, { tz } = {}) {
  if (!hit?.job?.job_id || hit.tier !== 'same_basket') return null;
  return { tier: 'same_basket', message: repeatMessage(hit, { tz }), same_items: hit.same_items === true, subset_items: hit.subset_items === true, ...hit.job };
}

/** The confirmation recorded on the new job's draft when staff said "different customer". */
export function repeatAckRecord(hit, { staffId = null, now = Date.now() } = {}) {
  return {
    jobId: hit?.job?.job_id ?? null,
    tier: hit?.tier ?? null,
    ref: hit?.job?.ref ?? null,
    staffId: staffId ?? null,
    at: new Date(now).toISOString(),
  };
}

/** brand+last4 of a settled job's card block, or null when the reader gave none. */
export function cardKeyOf(card) {
  if (!card || typeof card !== 'object') return null;
  const last4 = String(card.last4 ?? '').trim();
  if (!last4) return null;
  return `${normText(card.brand)}|${last4}`;
}

/**
 * After an approved settle: was the SAME card charged the SAME amount for ANOTHER
 * check at this venue inside 15 minutes? Returns the earlier job's repeatDetail or
 * null. This is the alert of last resort (activity feed), after the till side and
 * the create time check have both had their say. `recentApproved` are approved or
 * reconciled terminal_jobs rows at the venue, with optional `booked` attached.
 */
export function findSameCardRepeat(job, recentApproved, now = Date.now()) {
  const key = cardKeyOf(job?.card);
  if (!key) return null;
  const amount = amountMinorOf(job);
  if (!(amount > 0)) return null;
  const mine = ms(job.settled_at ?? job.charged_at ?? job.created_at);
  let best = null;
  for (const other of Array.isArray(recentApproved) ? recentApproved : []) {
    if (!other || other.id === job.id) continue;
    if (job.location_id && other.location_id && other.location_id !== job.location_id) continue;
    if (!CHARGED_STATUSES.includes(other.status)) continue;
    if (other.simulated === true || other.training === true) continue;
    if (other.closed_check_id && other.closed_check_id === job.closed_check_id) continue;
    if (cardKeyOf(other.card) !== key) continue;
    if (amountMinorOf(other) !== amount) continue;
    if (bookedState(other.booked) === 'refunded') continue;
    const t = ms(other.settled_at ?? other.charged_at ?? other.created_at);
    const ref = Number.isFinite(mine) ? mine : now;
    if (!Number.isFinite(t) || Math.abs(ref - t) > SAME_CARD_WINDOW_MS) continue;
    if (!best || t > ms(best.settled_at ?? best.charged_at ?? best.created_at)) best = other;
  }
  return best ? repeatDetail(best, best.booked ?? null, { now }) : null;
}

/** The activity feed row for a same card repeat, for adyen-terminal-charge to insert. */
export function sameCardAlert(job, prior, { tz } = {}) {
  const me = repeatDetail(job, null);
  const amt = fmtMoney(me.amount_minor, me.currency);
  const card = fmtCard(job?.card) || 'the same card';
  const first = `${prior.ref || 'a check'} at ${fmtTime(prior.at, tz)}`;
  const second = `${me.ref || 'a check'} at ${fmtTime(me.at, tz)}`;
  return {
    title: `Possible double charge: ${amt} twice on ${card}`,
    body: `${card} paid ${amt} for ${first} and again for ${second}. If it is one customer, refund one of them in History.`,
  };
}
