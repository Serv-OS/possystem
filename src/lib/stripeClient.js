// src/lib/stripeClient.js
// Stripe.js loader for online card payments via Stripe Elements.
//
// For DIRECT charges on connected accounts, Stripe.js MUST be initialized
// with the connected account ID via { stripeAccount }. We cache one Stripe
// instance per connected account.
//
// Card-present (Terminal SDK on Sunmi) does NOT use this — Android SDK
// gets its connection token from the stripe-terminal-connection-token
// edge fn instead.

import { loadStripe } from '@stripe/stripe-js';

const PUBLISHABLE_KEY = import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY;
if (!PUBLISHABLE_KEY) {
  console.warn('[stripeClient] VITE_STRIPE_PUBLISHABLE_KEY not set');
}

const _byAccount = new Map();
let _platformPromise = null;

export function getStripeForAccount(connectedAccountId) {
  if (!PUBLISHABLE_KEY) return Promise.resolve(null);
  if (!connectedAccountId) {
    if (!_platformPromise) _platformPromise = loadStripe(PUBLISHABLE_KEY);
    return _platformPromise;
  }
  if (!_byAccount.has(connectedAccountId)) {
    _byAccount.set(
      connectedAccountId,
      loadStripe(PUBLISHABLE_KEY, { stripeAccount: connectedAccountId }),
    );
  }
  return _byAccount.get(connectedAccountId);
}

// Helper: call our edge function to create a PaymentIntent on a connected account
export async function createPaymentIntent({
  authToken,
  locationId,
  amountMinor,
  currency,
  channel = 'online',
  closedCheckId,
  description,
  paymentMethodTypes = ['card'],
  captureMethod = 'automatic',
  setupFutureUsage = undefined, // v5.5.160: 'off_session' = save card for later overage charge
  metadata = {},
}) {
  const baseUrl = import.meta.env.VITE_SUPABASE_URL;
  const res = await fetch(`${baseUrl}/functions/v1/stripe-create-payment-intent`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${authToken}`,
    },
    body: JSON.stringify({
      location_id: locationId,
      amount_minor: amountMinor,
      currency,
      channel,
      closed_check_id: closedCheckId,
      description,
      payment_method_types: paymentMethodTypes,
      capture_method: captureMethod,
      ...(setupFutureUsage ? { setup_future_usage: setupFutureUsage } : {}),
      metadata,
    }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`createPaymentIntent failed: ${res.status} ${txt}`);
  }
  return res.json();
}

// Helper: link an existing acct_... to a location (super_admin only)
export async function linkMerchantAccount({ authToken, locationId, stripeAccountId }) {
  const baseUrl = import.meta.env.VITE_SUPABASE_URL;
  const res = await fetch(`${baseUrl}/functions/v1/stripe-link-merchant`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${authToken}`,
    },
    body: JSON.stringify({
      location_id: locationId,
      stripe_account_id: stripeAccountId,
    }),
  });
  const json = await res.json();
  if (!res.ok || json.error) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json;
}
