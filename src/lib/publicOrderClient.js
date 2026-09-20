// src/lib/publicOrderClient.js: the customer pages' side of the database fence (contract C0 to C13).
//
// Thin wiring around the pure rules in publicOrder.js: a session first (C13), a payment proof
// from the payment-proof edge function (C0), then ONE server call instead of direct table
// writes. Every call falls back to today's path while the server side is not deployed yet
// (FENCE STAGE 1 FALLBACK, see publicOrder.js for the cleanup note).
import { supabase, ensureAuthToken } from './supabase';
import { requestProofWithRetry, placePublicOrderWithFallback, settleQrTabWithFallback, verifyPaymentInBackground } from './publicOrder';
import { isMissingRpc } from './deviceFence';

const FUNCTIONS_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1`;

/** A session for the customer (place_public_order and settle_qr_tab need one). Never throws. */
export async function ensureCustomerSession() {
  try { return await ensureAuthToken(); } catch (e) { console.warn('[publicOrder] no session:', e?.message); return null; }
}

/**
 * Ask the server to record proof of a payment. kind: 'card' | 'preauth' | 'capture' | 'gift' | 'loyalty'.
 * Resolves { proofId, amountMinor } | { unavailable: true } | { failed: true, reason }.
 */
export async function requestPaymentProof({ opsLocationId, processor, kind, paymentRef, delays }) {
  if (!paymentRef) return { failed: true, reason: 'missing' };
  const token = await ensureCustomerSession();
  if (!token) return { failed: true, reason: 'no_session' };
  return requestProofWithRetry({
    delays,
    body: { ops_location_id: String(opsLocationId), processor, kind, payment_ref: String(paymentRef) },
    invoke: async (body) => {
      const res = await fetch(`${FUNCTIONS_URL}/payment-proof`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      return { status: res.status, data };
    },
  });
}

/**
 * Place an online, QR or catering order (contract C1, C2, C8, C9, C11).
 * reprove (fix round, C17): the payments to ask proof for again when the server answers
 * payment_unverified: [{processor, kind, paymentRef}]. The page then keeps checking in the
 * background for about 3 minutes (startPaymentVerification) and never asks the customer to pay
 * again.
 */
export async function placePublicOrder({ opsLocationId, order, check = null, proofIds = [], proofUnavailable = false, moneyTaken = false, legacyInsert, reprove = null }) {
  await ensureCustomerSession();
  const placed = await placePublicOrderWithFallback({
    rpc: (name, args) => supabase.rpc(name, args),
    locationId: opsLocationId,
    order, check, proofIds, proofUnavailable, moneyTaken, legacyInsert,
  });
  if (placed && placed.ok && placed.unverified && placed.path === 'rpc' && order && order.ref) {
    startPaymentVerification({ opsLocationId, ref: order.ref, reprove: reprove || [], proofIds });
  }
  return placed;
}

const _verifying = new Set();

/**
 * C17: keep checking an unproven payment in the background (not tied to any screen: the checkout
 * closes as soon as the order is placed). When it is proven, window event
 * 'rpos-public-payment-verified' { ref } lets the page drop its "confirming" notice.
 */
export function startPaymentVerification({ opsLocationId, ref, reprove = [], proofIds = [] }) {
  if (!supabase || !opsLocationId || !ref) return null;
  const key = `${opsLocationId}:${ref}`;
  if (_verifying.has(key)) return null;
  _verifying.add(key);
  return verifyPaymentInBackground({
    reprove, proofIds,
    requestProof: (r) => requestPaymentProof({ opsLocationId, processor: r.processor, kind: r.kind, paymentRef: r.paymentRef, delays: [0] }),
    verify: (ids) => supabase.rpc('verify_public_order_payment', { p_location_id: String(opsLocationId), p_ref: String(ref), p_proof_ids: ids }),
  }).then((res) => {
    if (res && res.verified) {
      try { window.dispatchEvent(new CustomEvent('rpos-public-payment-verified', { detail: { ref, checkId: res.checkId || null } })); } catch { /* no window */ }
    }
    return res;
  }).catch(() => null).finally(() => { _verifying.delete(key); });
}

/** Close a QR tab after the capture (contract C10). */
export async function settleQrTab({ opsLocationId, paymentIntentId, check = {}, proofIds = [], legacySettle }) {
  await ensureCustomerSession();
  return settleQrTabWithFallback({
    rpc: (name, args) => supabase.rpc(name, args),
    locationId: opsLocationId, paymentIntentId, check, proofIds, legacySettle,
  });
}

/**
 * Call a read only customer RPC; when it does not exist yet run legacyRead (today's direct
 * read). FENCE STAGE 1 FALLBACK. Resolves { data, error, legacy }.
 */
export async function publicRead(name, args, legacyRead) {
  if (!supabase) return { data: null, error: null, legacy: false };
  let res;
  try { res = await supabase.rpc(name, args); } catch (e) { res = { data: null, error: e }; }
  if (res?.error && isMissingRpc(res.error) && legacyRead) {
    try { const l = await legacyRead(); return { data: l?.data ?? null, error: l?.error ?? null, legacy: true }; }
    catch (e) { return { data: null, error: e, legacy: true }; }
  }
  return { data: res?.data ?? null, error: res?.error ?? null, legacy: false };
}
