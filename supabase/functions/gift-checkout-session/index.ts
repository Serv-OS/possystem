// supabase/functions/gift-checkout-session/index.ts
//
// PUBLIC (no auth required) — creates a Stripe Checkout Session for purchasing
// a gift card. Payment goes through the merchant's connected Stripe account
// (direct charge) with platform application_fee.
//
// Body: {
//   company_id, location_id, amount_minor,
//   sender_name, sender_email,
//   recipient_name, recipient_email, message?,
//   delivery_type, // 'email' | 'self'
//   success_url, cancel_url,
// }
//
// Returns: { checkout_url, session_id, purchase_id }
//
// The purchase record is created in gift_card_purchases with status='pending'.
// On successful payment, stripe-webhook-connect fires checkout.session.completed
// → calls gift-fulfill to issue the card and email it.

import Stripe from 'https://esm.sh/stripe@14.21.0?target=denonext';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), {
    status: s,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') ?? '', {
  apiVersion: '2024-06-20',
});

const platformAdmin = createClient(
  Deno.env.get('PLATFORM_SUPABASE_URL') ?? '',
  Deno.env.get('PLATFORM_SUPABASE_SERVICE_ROLE_KEY') ?? '',
  { auth: { autoRefreshToken: false, persistSession: false } },
);

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }

  const {
    company_id, location_id, amount_minor,
    sender_name, sender_email, sender_phone,
    recipient_name, recipient_email, message,
    delivery_type = 'email',
    success_url, cancel_url,
  } = body as any;

  // Validate required fields
  if (!company_id) return json({ error: 'company_id required' }, 400);
  if (!location_id) return json({ error: 'location_id required' }, 400);
  if (!amount_minor || Number(amount_minor) < 500)
    return json({ error: 'amount_minor must be at least 500 (£5.00)' }, 400);
  if (!sender_name || !sender_email)
    return json({ error: 'sender_name and sender_email required' }, 400);
  if (!recipient_name || !recipient_email)
    return json({ error: 'recipient_name and recipient_email required' }, 400);
  if (!success_url || !cancel_url)
    return json({ error: 'success_url and cancel_url required' }, 400);

  // Check gift cards are enabled for this company
  const { data: config } = await platformAdmin
    .from('gift_brand_config')
    .select('enabled, currency, min_card_value_minor, max_card_value_minor')
    .eq('company_id', company_id)
    .maybeSingle();

  if (!config || !config.enabled) {
    return json({ error: 'Gift cards not enabled for this venue' }, 403);
  }

  const amt = Number(amount_minor);
  if (amt < (config.min_card_value_minor || 500)) {
    return json({ error: `Amount below minimum` }, 400);
  }
  if (amt > (config.max_card_value_minor || 50000)) {
    return json({ error: `Amount exceeds maximum` }, 400);
  }

  // ── PROCESSOR GATE (v5.5.911) ──────────────────────────────────────────────
  // Gift cards were Stripe-only: the lookup just below hard-requires a
  // merchant_stripe_accounts row, so a Ryft venue could never sell one. Ryft has no
  // hosted checkout page, so its customers pay IN-PAGE via the embedded SDK — the same
  // component online / QR / catering already use.
  //
  // The decision is made HERE, on the server, not in the browser: the amount and the
  // purchase_id then come from us and cannot be forged by a customer editing a request.
  //
  // FAIL-SAFE: anything other than a definitive 'ryft' — lookup error, missing row,
  // column unset — falls through to the Stripe path, which behaves exactly as it always
  // has. A blip must never take a working venue's gift sales offline.
  let processor = 'stripe';
  try {
    const { data: locRow } = await platformAdmin
      .from('locations').select('payment_processor').eq('id', location_id).maybeSingle();
    if (locRow?.payment_processor === 'ryft') processor = 'ryft';
  } catch { /* stay on stripe */ }

  if (processor === 'ryft') {
    const { data: mra } = await platformAdmin
      .from('merchant_ryft_accounts')
      .select('ryft_account_id, charges_enabled')
      .eq('location_id', location_id)
      .maybeSingle();
    if (!mra?.ryft_account_id || mra.charges_enabled === false) {
      return json({ error: 'Payments not configured for this venue' }, 400);
    }

    const { data: rPurchase, error: rErr } = await platformAdmin
      .from('gift_card_purchases')
      .insert({
        company_id, location_id, amount_minor: amt,
        currency: config.currency || 'gbp',
        sender_name, sender_email, sender_phone: sender_phone || null,
        recipient_name, recipient_email, message: message || null,
        delivery_type, status: 'pending', processor: 'ryft',
      })
      .select('id')
      .single();
    if (rErr) return json({ error: `Failed to create purchase record: ${rErr.message}` }, 500);

    // Reuse ryft-create-payment-session verbatim — sub-account routing and the platform
    // markup live there, and duplicating fee maths is how the two drift apart. It is
    // auth-gated, and this page is public (anon key, no user JWT), which is exactly why
    // the call is made server-to-server with the service-role key.
    try {
      const r = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/ryft-create-payment-session`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''}`,
        },
        body: JSON.stringify({
          location_id,
          amount_minor: amt,
          currency: config.currency || 'gbp',
          channel: 'online',
          capture_method: 'automatic',
          customer_email: sender_email,
          // THIS METADATA IS THE WHOLE FULFILMENT CONTRACT. ryft-webhook reads it on
          // PaymentSession.captured and calls gift-fulfill. Change these two keys and a
          // paying customer silently receives no card.
          metadata: { type: 'gift_card_purchase', purchase_id: rPurchase.id },
        }),
      });
      const sess = await r.json();
      if (!r.ok || !sess?.clientSecret) throw new Error(sess?.error || 'Could not start Ryft payment');

      await platformAdmin.from('gift_card_purchases')
        .update({ ryft_payment_session_id: sess.sessionId })
        .eq('id', rPurchase.id);

      return json({
        processor: 'ryft',
        purchase_id: rPurchase.id,
        sessionId: sess.sessionId,
        clientSecret: sess.clientSecret,
        publicKey: sess.publicKey,
        accountId: sess.accountId,
        status: sess.status,
        currency: config.currency || 'gbp',
        amount_minor: amt,
      });
    } catch (e) {
      // Never strand a pending purchase row for a payment that was never started —
      // it would sit in Back Office looking like a customer who paid and got nothing.
      await platformAdmin.from('gift_card_purchases').delete().eq('id', rPurchase.id);
      return json({ error: `Payment setup failed: ${(e as Error).message}` }, 500);
    }
  }

  // Look up the merchant's Stripe account for this location
  const { data: msa } = await platformAdmin
    .from('merchant_stripe_accounts')
    .select('stripe_account_id, charges_enabled')
    .eq('location_id', location_id)
    .maybeSingle();

  if (!msa || !msa.charges_enabled) {
    return json({ error: 'Payments not configured for this venue' }, 400);
  }

  // Get platform markup for online channel
  let markupPercent = 0;
  try {
    const { data: m } = await platformAdmin.rpc('get_effective_markup', {
      p_location_id: location_id, p_channel: 'online',
    });
    markupPercent = Number(m ?? 0);
  } catch { /* default 0 */ }

  const applicationFeeMinor = Math.max(0, Math.round((amt * markupPercent) / 100));

  // Create purchase record
  const { data: purchase, error: purchaseErr } = await platformAdmin
    .from('gift_card_purchases')
    .insert({
      company_id,
      location_id,
      amount_minor: amt,
      currency: config.currency || 'gbp',
      sender_name,
      sender_email,
      sender_phone: sender_phone || null,
      recipient_name,
      recipient_email,
      message: message || null,
      delivery_type,
      status: 'pending',
      processor: 'stripe',
    })
    .select('id')
    .single();

  if (purchaseErr) {
    return json({ error: `Failed to create purchase record: ${purchaseErr.message}` }, 500);
  }

  // Create Stripe Checkout Session on the merchant's connected account
  const currency = (config.currency || 'gbp').toLowerCase();
  const currencySymbol = currency === 'usd' ? '$' : '£';
  const amountMajor = (amt / 100).toFixed(2);

  try {
    const sessionParams: Stripe.Checkout.SessionCreateParams = {
      mode: 'payment',
      line_items: [{
        price_data: {
          currency,
          product_data: {
            name: `Gift Card — ${currencySymbol}${amountMajor}`,
            description: `Gift card for ${recipient_name}`,
          },
          unit_amount: amt,
        },
        quantity: 1,
      }],
      customer_email: sender_email,
      success_url,
      cancel_url,
      metadata: {
        type: 'gift_card_purchase',
        purchase_id: purchase.id,
        company_id,
        location_id,
        amount_minor: String(amt),
      },
      payment_intent_data: {
        metadata: {
          type: 'gift_card_purchase',
          purchase_id: purchase.id,
        },
        ...(applicationFeeMinor > 0
          ? { application_fee_amount: applicationFeeMinor }
          : {}),
      },
    };

    const session = await stripe.checkout.sessions.create(
      sessionParams,
      { stripeAccount: msa.stripe_account_id },
    );

    // Update purchase with stripe session ID
    await platformAdmin
      .from('gift_card_purchases')
      .update({ stripe_session_id: session.id, stripe_account_id: msa.stripe_account_id })
      .eq('id', purchase.id);

    return json({
      checkout_url: session.url,
      session_id: session.id,
      purchase_id: purchase.id,
    });
  } catch (e) {
    // Clean up purchase record on Stripe error
    await platformAdmin.from('gift_card_purchases').delete().eq('id', purchase.id);
    const err = e as Stripe.errors.StripeError;
    return json({ error: `Payment setup failed: ${err.message}` }, 500);
  }
});
