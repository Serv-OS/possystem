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

/** Words for an order placed but not proven paid (contract C1 step 4). */
export const UNVERIFIED_MESSAGE = 'Your order is in. The venue will confirm your payment.';
