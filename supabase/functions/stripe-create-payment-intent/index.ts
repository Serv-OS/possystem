// supabase/functions/stripe-create-payment-intent/index.ts
// Direct charge on a merchant's connected account, with platform
// application_fee_amount applied based on the channel-specific markup %
// resolved from merchant_stripe_accounts (per-merchant override) or
// platform_settings (global default).

import Stripe from 'https://esm.sh/stripe@14.21.0?target=denonext';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') ?? '', {
  apiVersion: '2024-06-20',
});

const opsAdmin = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  { auth: { autoRefreshToken: false, persistSession: false } },
);
const platformAdmin = createClient(
  Deno.env.get('PLATFORM_SUPABASE_URL') ?? '',
  Deno.env.get('PLATFORM_SUPABASE_SERVICE_ROLE_KEY') ?? '',
  { auth: { autoRefreshToken: false, persistSession: false } },
);

interface Body {
  location_id?: string;
  amount_minor?: number;
  currency?: 'gbp' | 'usd';
  channel?: 'card_present' | 'online';
  payment_method_types?: string[];
  capture_method?: 'automatic' | 'manual';
  closed_check_id?: string;
  description?: string;
  statement_descriptor_suffix?: string;
  metadata?: Record<string, string>;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return json({ error: 'Unauthorized' }, 401);

  const { data: { user: caller } } = await opsAdmin.auth.getUser(authHeader.replace('Bearer ', ''));
  if (!caller) return json({ error: 'Invalid token' }, 401);

  let body: Body;
  try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }

  const {
    location_id, amount_minor, currency,
    channel = 'online',
    payment_method_types, capture_method = 'automatic',
    closed_check_id, description, statement_descriptor_suffix,
    metadata = {},
  } = body;

  if (!location_id) return json({ error: 'location_id required' }, 400);
  if (!amount_minor || amount_minor <= 0) return json({ error: 'amount_minor must be > 0' }, 400);
  if (currency !== 'gbp' && currency !== 'usd') return json({ error: 'currency must be gbp or usd' }, 400);
  if (!payment_method_types?.length) return json({ error: 'payment_method_types required' }, 400);
  if (channel !== 'card_present' && channel !== 'online') {
    return json({ error: "channel must be 'card_present' or 'online'" }, 400);
  }

  const { data: msa, error: msaErr } = await platformAdmin.from('merchant_stripe_accounts')
    .select('stripe_account_id, charges_enabled')
    .eq('location_id', location_id).single();
  if (msaErr || !msa) return json({ error: 'location has no connected Stripe account' }, 400);
  if (!msa.charges_enabled) return json({ error: 'connected account cannot accept charges yet' }, 400);

  let markupPercent = 0;
  try {
    const { data: m } = await platformAdmin.rpc('get_effective_markup', {
      p_location_id: location_id, p_channel: channel,
    });
    markupPercent = Number(m ?? 0);
  } catch (e) {
    console.warn('[create-pi] get_effective_markup failed, defaulting to 0', e);
  }

  const applicationFeeMinor = Math.max(0, Math.round((amount_minor * markupPercent) / 100));

  let pi: Stripe.PaymentIntent;
  try {
    const piParams: Stripe.PaymentIntentCreateParams = {
      amount: amount_minor,
      currency,
      payment_method_types: payment_method_types as Stripe.PaymentIntentCreateParams.PaymentMethodType[],
      capture_method,
      description,
      statement_descriptor_suffix,
      metadata: {
        ...metadata,
        location_id,
        channel,
        markup_percent: String(markupPercent),
        application_fee_minor: String(applicationFeeMinor),
        ...(closed_check_id ? { closed_check_id } : {}),
        posup_user_id: caller.id,
      },
    };
    if (applicationFeeMinor > 0) piParams.application_fee_amount = applicationFeeMinor;

    pi = await stripe.paymentIntents.create(piParams, { stripeAccount: msa.stripe_account_id });
  } catch (e) {
    const err = e as Stripe.errors.StripeError;
    return json({ error: `stripe error: ${err.message}`, code: err.code, type: err.type }, 400);
  }

  return json({
    success: true,
    client_secret: pi.client_secret,
    payment_intent_id: pi.id,
    status: pi.status,
    stripe_account: msa.stripe_account_id,
    channel,
    markup_percent: markupPercent,
    application_fee_minor: applicationFeeMinor,
  });
});
