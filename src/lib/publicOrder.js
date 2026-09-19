// src/lib/publicOrder.js: database fence stage 1, the customer pages (contract section 3).
//
// Pure helpers only (no Supabase, no fetch, no window): the callers inject rpc, invoke and the
// legacy writes, so node:test (publicOrder.test.js) covers every branch, including the fallback
// to today's direct inserts while the server functions do not exist yet.
//
// ORDER OF RELEASE: this release can go live before Peter runs 20260919a. Until then
// place_public_order, settle_qr_tab, order_track_row, qr_table_open_tabs, qr_tab_rounds,
// qr_tab_join, qr_table_tab_count and catering_day_load do not exist (PGRST202) and every
// caller runs the path the live app uses today. After 20260919b (tables closed to the public
// key) the direct path is refused, so the RPC path is the only one left.
//
// STAGE 1 CLEANUP (after 20260919b has run): delete every branch tagged
// "FENCE STAGE 1 FALLBACK" here and in the callers (grep that tag): legacyInsert, legacyRead,
// the proofUnavailable branch, and the direct reads they wrap.

import { isMissingRpc, isPermissionError } from './deviceFence.js';

/** How long the proof lookup keeps trying (the processor or webhook can lag a moment). */
export const PROOF_RETRY_MS = Object.freeze({ default: [0, 1200, 2500], adyen: [0, 2000, 4000, 6000] });

const sleepDefault = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Ask the payment-proof edge function for a proof, with a few retries.
 * invoke(body) resolves { status, data } (the function's JSON) or throws on a network error.
 * Resolves:
 *   { proofId, amountMinor }   the server saw the payment
 *   { unavailable: true }      the function or its table is not deployed yet (FENCE STAGE 1 FALLBACK)
 *   { failed: true, reason }   the payment could not be proven (the order is placed unpaid)
 */
export async function requestProofWithRetry({ invoke, body, delays, sleep = sleepDefault } = {}) {
  if (!invoke || !body || !body.payment_ref) return { failed: true, reason: 'missing' };
  const plan = delays || (body.processor === 'adyen' ? PROOF_RETRY_MS.adyen : PROOF_RETRY_MS.default);
  let last = { failed: true, reason: 'not_seen' };
  for (const wait of plan) {
    if (wait) await sleep(wait);
    let res;
    try { res = await invoke(body); } catch (e) { last = { failed: true, reason: 'network', message: e?.message }; continue; }
    const status = Number(res?.status || 0);
    const data = res?.data || {};
    if (status === 404 && !data.reason) return { unavailable: true };          // function not deployed
    if (data.reason === 'unsupported') return { unavailable: true };           // table not created
    if (data.ok && data.proof_id) return { proofId: data.proof_id, amountMinor: Number(data.amount_minor) || 0 };
    last = { failed: true, reason: data.reason || `http_${status}` };
    // Wrong venue, wrong kind, a refused payment: asking again will not change it.
    if (['other_venue', 'kind', 'processor', 'venue', 'payment_ref', 'no_account', 'rate', 'cancelled'].includes(data.reason)) break;
  }
  return last;
}

/**
 * The arguments place_public_order takes. The rows are passed as they are built today (same
 * keys); the server ignores what it does not read and forces status, paid, staff and the
 * server fields itself.
 */
export function buildPlaceOrderArgs({ locationId, order, check = null, proofIds = [] }) {
  return {
    p_location_id: locationId,
    p_order: order,
    p_check: check || null,
    p_proof_ids: (proofIds || []).filter(Boolean),
  };
}

/**
 * Place a customer order through place_public_order, falling back to today's direct insert.
 *
 * @param {Function} o.rpc            (name, args) => Promise<{data, error}>
 * @param {Function} o.legacyInsert   () => Promise<{ok, error}>, today's direct insert(s). FENCE STAGE 1 FALLBACK.
 * @param {boolean}  o.proofUnavailable  the payment-proof function or table is not deployed: while
 *                   money WAS taken, today's direct path is tried first so a paid order is not
 *                   marked unpaid only because a deploy is missing.
 * @param {boolean}  o.moneyTaken     a card, gift or loyalty payment was already taken
 * @returns {Promise<{ok, path, paid, unverified, trackToken, tabJoinCode, checkId, reason, message, idempotent}>}
 */
export async function placePublicOrderWithFallback({
  rpc, locationId, order, check = null, proofIds = [], proofUnavailable = false, moneyTaken = false,
  legacyInsert, retries = 3, sleep = sleepDefault,
} = {}) {
  const legacy = async () => {
    if (!legacyInsert) return { ok: false, path: 'legacy', reason: 'no_legacy', message: 'Could not save the order.' };
    let r;
    try { r = await legacyInsert(); } catch (e) { r = { ok: false, error: e }; }
    if (r && r.ok) return { ok: true, path: 'legacy', paid: !!moneyTaken, unverified: false, trackToken: null, tabJoinCode: r.tabJoinCode || null, checkId: r.checkId || null };
    return { ok: false, path: 'legacy', reason: isPermissionError(r?.error) ? 'refused' : 'error', message: r?.error?.message || 'Could not save the order.' };
  };

  // FENCE STAGE 1 FALLBACK: the proof function is not live yet but money was taken. Today's
  // direct path keeps the order paid; only if the database already refuses it (file 2 ran)
  // does the order go through the server function (placed, marked unverified).
  if (proofUnavailable && moneyTaken && legacyInsert) {
    const l = await legacy();
    if (l.ok || l.reason !== 'refused') return l;
  }

  const args = buildPlaceOrderArgs({ locationId, order, check, proofIds });
  let lastErr = null;
  for (let attempt = 0; attempt < Math.max(1, retries); attempt++) {
    if (attempt) await sleep(600 * attempt);
    let res;
    try { res = await rpc('place_public_order', args); } catch (e) { res = { error: e }; }
    const { data, error } = res || {};
    if (error && isMissingRpc(error)) return legacy();           // FENCE STAGE 1 FALLBACK
    if (error) { lastErr = error; continue; }                     // network or server blip: the RPC is idempotent per session and ref
    if (!data || data.ok !== true) {
      return { ok: false, path: 'rpc', reason: data?.reason || 'error', message: data?.message || null };
    }
    return {
      ok: true, path: 'rpc', paid: data.paid === true, unverified: data.payment_unverified === true,
      trackToken: data.track_token || null, tabJoinCode: data.tab_join_code || null,
      checkId: data.check_id || null, idempotent: data.idempotent === true, status: data.status || null,
    };
  }
  return { ok: false, path: 'rpc', reason: 'error', message: lastErr?.message || 'Could not save the order.' };
}

/**
 * Close a QR tab from the customer's phone after the card was captured (contract C10), falling
 * back to today's direct writes while settle_qr_tab does not exist. 'not_captured' (the
 * processor or its webhook has not shown the capture yet) is asked again a few times; the
 * capture already happened, so the caller must never tell the customer it failed to charge.
 */
export async function settleQrTabWithFallback({
  rpc, locationId, paymentIntentId, check = {}, proofIds = [], legacySettle, retries = 3, sleep = sleepDefault,
} = {}) {
  const args = { p_location_id: locationId, p_payment_intent_id: paymentIntentId, p_check: check || {}, p_proof_ids: (proofIds || []).filter(Boolean) };
  let last = { ok: false, path: 'rpc', reason: 'error' };
  for (let attempt = 0; attempt < Math.max(1, retries); attempt++) {
    if (attempt) await sleep(1500 * attempt);
    let res;
    try { res = await rpc('settle_qr_tab', args); } catch (e) { res = { error: e }; }
    const { data, error } = res || {};
    if (error && isMissingRpc(error)) {                       // FENCE STAGE 1 FALLBACK
      if (!legacySettle) return { ok: false, path: 'legacy', reason: 'no_legacy' };
      try { const l = await legacySettle(); return { ok: !!(l && l.ok), path: 'legacy', reason: l?.ok ? null : 'error' }; }
      catch (e) { return { ok: false, path: 'legacy', reason: 'error', message: e?.message }; }
    }
    if (error) { last = { ok: false, path: 'rpc', reason: 'error', message: error.message }; continue; }
    if (data && data.ok) return { ok: true, path: 'rpc', closed: Number(data.closed) || 0, booked: data.booked ?? null, shortfall: data.shortfall ?? null, alreadyClosed: data.reason === 'already_closed' };
    last = { ok: false, path: 'rpc', reason: data?.reason || 'error', message: data?.message || null };
    if (last.reason !== 'not_captured') break;
  }
  return last;
}

/**
 * The key a tracker link carries (contract C3): the tracking token from place_public_order,
 * else the QR tab's card payment id, else the last 4 digits of the phone (old links).
 */
export function chooseTrackKey({ trackToken, paymentIntentId, phone } = {}) {
  if (trackToken) return String(trackToken);
  if (paymentIntentId) return String(paymentIntentId);
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length >= 4 ? digits.slice(-4) : null;
}

/** Tracker link query string: ?track=REF&t=TOKEN (new) or ?track=REF&p=LAST4 (old links). */
export function trackLinkParams({ ref, trackToken, phone } = {}) {
  const q = new URLSearchParams();
  if (ref) q.set('track', String(ref));
  if (trackToken) q.set('t', String(trackToken));
  else {
    const last4 = chooseTrackKey({ phone });
    if (last4) q.set('p', last4);
  }
  return q.toString();
}

/** A table join code is digits only; old tabs have 4, new ones 6. */
export function normalizeJoinCode(code) {
  return String(code || '').replace(/\D/g, '').slice(0, 6);
}
export function joinCodeReady(code) {
  return normalizeJoinCode(code).length >= 4;
}

/**
 * qr_tab_rounds / qr_tab_join answer to the tab object the QR screens use today (the old
 * direct read built it from the first order_queue row's customer block plus every round).
 */
export function tabFromRoundsResult(result) {
  if (!result || !result.tab) return null;
  const t = result.tab;
  const rounds = Array.isArray(result.rounds) ? result.rounds : [];
  return {
    ...t,
    payment_intent_id: t.payment_intent_id || null,
    rounds,
    items: rounds.flatMap((r) => (Array.isArray(r.items) ? r.items : [])),
    total: rounds.reduce((s, r) => s + (Number(r.total) || 0), 0),
  };
}

/** qr_table_open_tabs rows: handles only, never payment ids, names or codes (contract C4). */
export function openTabsFromResult(rows) {
  return (Array.isArray(rows) ? rows : []).map((r) => ({
    tab_handle: r.tab_handle,
    tab_ref: r.tab_ref || null,
    table_label: r.table_label || null,
    opened_at: r.opened_at || null,
    processor: r.processor || null,
    total: Number(r.total) || 0,
    rounds: Number(r.rounds) || 0,
    has_join_code: r.has_join_code === true,
  }));
}

/**
 * What to do with the table's active_sessions row when QR rounds change (contract S1, tables
 * never lost): only a session QR made may be written or removed. A till's session is never
 * touched.
 */
export function qrSessionWriteAction({ existing, hasItems }) {
  const exists = !!(existing && existing.session);
  const isQr = exists && existing.session.source === 'qr';
  if (!hasItems) return isQr ? 'delete_qr' : 'skip';
  if (!exists) return 'insert';
  return isQr ? 'update_qr' : 'skip';
}

/** Words for an order placed but not proven paid (contract C1 step 4, C17). Never "pay again". */
export const UNVERIFIED_MESSAGE = 'Your order is in. The venue is confirming your payment.';

// ── Fix round (19 Sep 2026), docs/FENCE_STAGE_1_APP.md section 11 ─────────────────────────────

const toMinor = (v) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n > 0 ? n : 0; };

/**
 * C15: what an online order charges across card and gift card, in pence: the card amount (the
 * bill net of the promo code and the loyalty reward; auto discounts are already net) plus the gift
 * card. place_public_order counts it as the order's own total, and "paid" means verified card plus
 * gift money covers it.
 */
export function onlineChargedTotalMinor({ remainingMinor = 0, giftAppliedMinor = 0 } = {}) {
  return toMinor(remainingMinor) + toMinor(giftAppliedMinor);
}

/**
 * C15: the discounts the order declares (p_order.discounts). The server takes them off the value
 * of the lines to work out the amount due, and writes the result into customer.order_pricing for
 * staff to see. A loyalty discount counts only with a loyalty redemption proof.
 *   autoDiscounts: the auto discount records (value in pounds, label)
 *   promo:  { code, amountMinor }
 *   reward: { name, amountMinor }
 */
export function buildDeclaredDiscounts({ autoDiscounts = [], promo = null, reward = null } = {}) {
  const out = [];
  for (const d of Array.isArray(autoDiscounts) ? autoDiscounts : []) {
    const amt = toMinor(Math.round((Number(d && (d.value ?? d.amount)) || 0) * 100));
    if (amt > 0) out.push({ type: 'auto', label: String((d && (d.label || d.name)) || 'Offer').slice(0, 80), amount_minor: amt });
  }
  if (promo && toMinor(promo.amountMinor) > 0) out.push({ type: 'promo', label: String(promo.code || 'Promo').slice(0, 80), amount_minor: toMinor(promo.amountMinor) });
  if (reward && toMinor(reward.amountMinor) > 0) out.push({ type: 'loyalty', label: String(reward.name || 'Reward').slice(0, 80), amount_minor: toMinor(reward.amountMinor) });
  return out;
}

/**
 * C15: the ledger key loyalty-redeem writes for this order's redemption, which payment-proof reads
 * (points: redeem:<check>:<reward>, stamps: stampredeem:<check>:<program>).
 */
export function loyaltyProofKey(rewardApplied, checkId) {
  if (!rewardApplied) return null;
  if (rewardApplied.idempotency_key) return String(rewardApplied.idempotency_key);
  if (!checkId) return null;
  if (rewardApplied.stamp_program_id) return `stampredeem:${checkId}:${rewardApplied.stamp_program_id}`;
  if (rewardApplied.reward_id) return `redeem:${checkId}:${rewardApplied.reward_id}`;
  return null;
}

/** Resolve a promise, or null after ms (a slow step must never hold a paid order back). */
export function withinMs(promise, ms, sleep = sleepDefault) {
  return Promise.race([Promise.resolve(promise).catch(() => null), sleep(ms).then(() => null)]);
}

/**
 * C16, C19: plain words for a place_public_order refusal the customer can act on. Anything else
 * gets the page's own fallback words.
 */
export function publicOrderRefusalMessage(placed, fallback) {
  const r = placed && placed.reason;
  const m = placed && placed.message;
  if (r === 'tab_not_yours') return m || 'Ask the person who opened this tab for the table code.';
  if (r === 'locked') return m || 'Too many wrong codes. Ask a member of staff.';
  if (r === 'tab_closed') return m || 'This tab is already closed. Please start a new order.';
  if (r === 'tab_not_verified') return m || 'We could not confirm the card hold for this tab. Please ask a member of staff.';
  if (r === 'payment') return m || 'Please pay for your order to send it.';
  if (r === 'rate') return m || 'Too many orders right now. Please try again in a few minutes.';
  return fallback;
}

/**
 * C16: the table code a new round carries. Only a code this phone really holds (from the stash,
 * or from qr_tab_join / qr_tab_rounds as opener or member). Never a code made up in this page:
 * a wrong code counts towards the tab's lock (8 per hour).
 */
export function tabRoundJoinCode(existingTab) {
  if (!existingTab) return null;
  const c = existingTab.tab_join_code
    || (Array.isArray(existingTab.rounds) && existingTab.rounds[0] && existingTab.rounds[0].customer && existingTab.rounds[0].customer.tab_join_code)
    || null;
  const n = normalizeJoinCode(c);
  return n.length >= 4 ? n : null;
}

/**
 * C16: resume a stashed tab with the server's answer. qr_tab_rounds returns tab_join_code only to
 * the opener and members; to anyone else it is null. The code the stash holds is never
 * overwritten with that null (the resume screen keeps showing it).
 */
export function mergeResumeTab(stashed, serverTab) {
  const merged = { ...(stashed || {}), ...(serverTab || {}) };
  merged.tab_join_code = (serverTab && serverTab.tab_join_code) || (stashed && stashed.tab_join_code) || null;
  if (stashed && 'joined' in stashed) merged.joined = stashed.joined;
  return merged;
}

/** C17: how long the page keeps checking an unproven payment (about 3 minutes in total). */
export const VERIFY_DELAYS_MS = Object.freeze([4000, 8000, 12000, 16000, 20000, 30000, 40000, 50000]);

/**
 * C17: after place_public_order answered payment_unverified, keep checking in the background:
 * ask payment-proof again for the same payments, then verify_public_order_payment with the
 * proofs. Never asks the customer to pay again, and stops on an answer that cannot change.
 *
 * @param {Function} o.requestProof ({processor, kind, paymentRef}) => {proofId}|{failed}|{unavailable}
 * @param {Function} o.verify       (proofIds) => {data, error}  (verify_public_order_payment)
 * @param {Array}    o.reprove      [{processor, kind, paymentRef}]
 * @param {Array}    o.proofIds     proofs already had (sent again)
 * @returns {Promise<{verified: boolean, reason?: string, checkId?: string}>}
 */
export async function verifyPaymentInBackground({
  requestProof, verify, reprove = [], proofIds = [], delays = VERIFY_DELAYS_MS, sleep = sleepDefault, isMissing = isMissingRpc,
} = {}) {
  if (!verify) return { verified: false, reason: 'missing' };
  const known = new Set((proofIds || []).filter(Boolean));
  for (const wait of delays) {
    if (wait) await sleep(wait);
    for (const r of reprove || []) {
      if (!r || !r.paymentRef || !requestProof) continue;
      let p;
      try { p = await requestProof(r); } catch { p = null; }
      if (p && p.proofId) known.add(p.proofId);
      if (p && p.unavailable) return { verified: false, reason: 'unsupported' };
    }
    let res;
    try { res = await verify([...known]); } catch (e) { res = { error: e }; }
    const { data, error } = res || {};
    if (error) {
      if (isMissing(error)) return { verified: false, reason: 'unsupported' };
      continue;                                     // network: try again at the next step
    }
    if (data && data.ok && data.paid) return { verified: true, checkId: data.check_id || null };
    if (data && data.ok === false && ['not_found', 'no_check', 'no_session'].includes(data.reason)) {
      return { verified: false, reason: data.reason };
    }
  }
  return { verified: false, reason: 'timeout' };
}

/**
 * C17: is the tracker row still "being checked"? order_track_row answers payment_state; the old
 * direct read carries it in customer. A paid order is never "checking", whatever an older copy
 * of the customer block says.
 */
export function trackerPaymentChecking(row) {
  if (!row || row.paid === true) return false;
  const st = row.payment_state || (row.customer && row.customer.payment_state) || null;
  return st === 'checking' || !!(row.customer && row.customer.payment_unverified === true);
}
