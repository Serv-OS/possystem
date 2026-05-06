// supabase/functions/stripe-cancel-reader-action/index.ts
//
// POS calls this when the cashier wants to abort a card payment that's
// in-flight on the reader (customer walked away, taking too long, etc).
// Cancels both the reader action and the PaymentIntent.
//
// Body: { payment_intent_id, reader_id, location_id }

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import Stripe from 'https://esm.sh/stripe@14.21.0?target=denonext';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

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

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') ?? '', {
  apiVersion: '2024-06-20',
});

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return json({ error: 'Unauthorized' }, 401);
  const { data: { user: caller } } = await opsAdmin.auth.getUser(authHeader.replace('Bearer ', ''));
  if (!caller) return json({ error: 'Invalid token' }, 401);

  let body: { payment_intent_id?: string; reader_id?: string; location_id?: string };
  try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }
  const { payment_intent_id, reader_id, location_id } = body ?? {};
  if (!location_id) return json({ error: 'location_id required' }, 400);

  const { data: msa } = await platformAdmin.from('merchant_stripe_accounts')
    .select('stripe_account_id').eq('location_id', location_id).maybeSingle();
  if (!msa?.stripe_account_id) return json({ error: 'Merchant Stripe account not linked' }, 400);

  const errors: string[] = [];

  // 1. Cancel reader action (clears the reader screen)
  if (reader_id) {
    try {
      await stripe.terminal.readers.cancelAction(reader_id, undefined, {
        stripeAccount: msa.stripe_account_id,
      });
    } catch (e) {
      // If the reader has no action in progress, Stripe returns 400. That's fine.
      const msg = (e as Error).message;
      if (!msg.includes('no action') && !msg.includes('not found')) {
        errors.push(`reader: ${msg}`);
      }
    }
  }

  // 2. Cancel PaymentIntent (so the merchant doesn't accidentally capture later)
  if (payment_intent_id) {
    try {
      await stripe.paymentIntents.cancel(payment_intent_id, {
        stripeAccount: msa.stripe_account_id,
      });
    } catch (e) {
      errors.push(`pi: ${(e as Error).message}`);
    }
  }

  // 3. Clear the reader display (best effort)
  if (reader_id) {
    try {
      await stripe.terminal.readers.setReaderDisplay(reader_id, {
        type: 'cart',
        cart: { line_items: [], total: 0, currency: 'usd' },
      }, { stripeAccount: msa.stripe_account_id });
    } catch { /* non-fatal */ }
  }

  return json({ success: errors.length === 0, errors });
});
