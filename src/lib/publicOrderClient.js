// src/lib/publicOrderClient.js: the customer pages' side of the database fence (contract C0 to C13).
//
// Thin wiring around the pure rules in publicOrder.js: a session first (C13), a payment proof
// from the payment-proof edge function (C0), then ONE server call instead of direct table
// writes. Every call falls back to today's path while the server side is not deployed yet
// (FENCE STAGE 1 FALLBACK, see publicOrder.js for the cleanup note).
import { supabase, ensureAuthToken } from './supabase';
import { requestProofWithRetry, placePublicOrderWithFallback, settleQrTabWithFallback } from './publicOrder';
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
export async function requestPaymentProof({ opsLocationId, processor, kind, paymentRef }) {
  if (!paymentRef) return { failed: true, reason: 'missing' };
  const token = await ensureCustomerSession();
  if (!token) return { failed: true, reason: 'no_session' };
  return requestProofWithRetry({
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

/** Place an online, QR or catering order (contract C1, C2, C8, C9, C11). */
export async function placePublicOrder({ opsLocationId, order, check = null, proofIds = [], proofUnavailable = false, moneyTaken = false, legacyInsert }) {
  await ensureCustomerSession();
  return placePublicOrderWithFallback({
    rpc: (name, args) => supabase.rpc(name, args),
    locationId: opsLocationId,
    order, check, proofIds, proofUnavailable, moneyTaken, legacyInsert,
  });
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
