// src/lib/payments/ryft.js
//
// Client-side Ryft helpers — create a payment session via our edge function,
// and load the Ryft embedded SDK (ryft.min.js). Part of the dual-processor
// payment layer (see RYFT_INTEGRATION_PLAN.md). Stripe stays the default;
// Ryft is used where the location's processor is set to 'ryft'.

import { supabase, ensureAuthToken, isMock } from '../supabase';

const RYFT_SDK_URL = 'https://embedded.ryftpay.com/v2/ryft.min.js';
let _scriptPromise = null;

/** Inject ryft.min.js once; resolves with window.Ryft. */
export function loadRyft() {
  if (typeof window !== 'undefined' && window.Ryft) return Promise.resolve(window.Ryft);
  if (_scriptPromise) return _scriptPromise;
  _scriptPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = RYFT_SDK_URL;
    s.async = true;
    s.addEventListener('load', () => window.Ryft ? resolve(window.Ryft) : reject(new Error('Ryft SDK loaded but window.Ryft missing')));
    s.addEventListener('error', () => reject(new Error('Failed to load Ryft SDK')));
    document.head.appendChild(s);
  });
  return _scriptPromise;
}

/**
 * Create a Ryft payment session via the ryft-create-payment-session edge
 * function. Returns the normalised shape { processor, sessionId, clientSecret,
 * publicKey, accountId }. Ensures an auth session first so the function's auth
 * guard accepts the call (POS/online use an anonymous authenticated session).
 */
export async function createRyftSession({ amountMinor, currency = 'gbp', locationId, captureMethod = 'automatic', customerEmail, closedCheckId, channel = 'online', metadata = {} }) {
  if (isMock || !supabase) {
    return { processor: 'ryft', sessionId: 'ps_mock', clientSecret: 'mock_secret', publicKey: 'pk_mock', accountId: null, mock: true };
  }
  try { await ensureAuthToken(); } catch { /* invoke will still attach anon */ }
  const { data, error } = await supabase.functions.invoke('ryft-create-payment-session', {
    body: {
      amount_minor: amountMinor,
      currency,
      location_id: locationId || null,
      capture_method: captureMethod,
      customer_email: customerEmail || null,
      closed_check_id: closedCheckId || null,
      channel,
      metadata,
    },
  });
  if (error) {
    let msg = error.message || 'Could not start Ryft payment';
    try { const b = await error.context?.json?.(); if (b?.error) msg = b.error; } catch { /* keep */ }
    throw new Error(msg);
  }
  if (data?.error) throw new Error(data.error);
  if (!data?.clientSecret) throw new Error('Ryft session missing clientSecret');
  return data;
}

/**
 * Pull the stored-card identifiers Ryft returns on a manual-capture tab hold.
 * Needed to charge an overage off-session at close. Shape mirrors the
 * PaymentSession response: customerDetails.id (cus_) + paymentMethod
 * .tokenizedDetails.id (pmt_, .stored===true). Returns nulls if not present.
 */
export function readRyftStoredCard(ps) {
  const td = ps?.paymentMethod?.tokenizedDetails;
  return {
    sessionId: ps?.id || ps?.sessionId || null,
    customerId: ps?.customerDetails?.id || null,
    // Only surface the card id if Ryft actually STORED it — otherwise the close
    // path would try an off-session MIT on a card that can't be re-charged.
    storedCardId: (td?.stored === true && td?.id) ? td.id : null,
  };
}

/**
 * Drive the Ryft open-tab lifecycle (close paths) via the ryft-tab edge
 * function — the Ryft analogue of /api/stripe-capture & /api/stripe-charge-
 * overage. Kept on Supabase (not Vercel) so RYFT_SECRET_KEY lives in exactly
 * one place. `action` ∈ capture | void | overage.
 *   capture { location_id, payment_session_id, amount_minor }
 *   void    { location_id, payment_session_id }
 *   overage { location_id, previous_session_id, customer_id, stored_card_id, amount_minor, currency }
 */
export async function ryftTab(action, payload) {
  if (isMock || !supabase) return { success: true, mock: true };
  try { await ensureAuthToken(); } catch { /* invoke attaches anon */ }
  const { data, error } = await supabase.functions.invoke('ryft-tab', { body: { action, ...payload } });
  if (error) {
    let body = null;
    try { body = await error.context?.json?.(); } catch { /* keep */ }
    const e = new Error(body?.error || error.message || `ryft-tab ${action} failed`);
    e.code = body?.error; e.detail = body?.detail; e.status = error.context?.status;
    throw e;
  }
  if (data?.error) { const e = new Error(data.error); e.code = data.error; e.detail = data.detail; throw e; }
  return data;
}
