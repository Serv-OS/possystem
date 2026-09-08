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

  let body: { payment_intent_id?: string; reader_id?: string; location_id?: string; currency?: string };
  try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }
  const { payment_intent_id, reader_id, location_id, currency = 'gbp' } = body ?? {};
  if (!location_id) return json({ error: 'location_id required' }, 400);

  // Resolve platform location — location_id may be an ops ID or a platform ID.
  // Same mapping as stripe-process-payment-on-reader: try both.
  const { data: platformLoc } = await platformAdmin.from('locations')
    .select('id').or(`ops_location_id.eq.${location_id},id.eq.${location_id}`)
    .maybeSingle();
  const platLocId = platformLoc?.id || location_id;

  const { data: msa } = await platformAdmin.from('merchant_stripe_accounts')
    .select('stripe_account_id').eq('location_id', platLocId).maybeSingle();
  if (!msa?.stripe_account_id) return json({ error: 'Merchant Stripe account not linked' }, 400);

  const errors: string[] = [];
  let preActionStatus: string | null = null;
  let preActionType: string | null = null;
  let postActionStatus: string | null = null;
  let cancelAttempted = false;
  let cancelSucceeded = false;

  // v5.5.178: diagnose cancel by capturing reader state before AND after.
  if (reader_id) {
    try {
      const before = await stripe.terminal.readers.retrieve(reader_id, {
        stripeAccount: msa.stripe_account_id,
      });
      const a = (before as Stripe.Terminal.Reader)?.action;
      preActionStatus = a?.status ?? 'idle';
      preActionType   = a?.type ?? 'none';
      console.log('[cancel] reader pre-cancel:', preActionType, preActionStatus);
    } catch (e) { console.warn('[cancel] pre-retrieve:', (e as Error).message); }

    cancelAttempted = true;
    try {
      await stripe.terminal.readers.cancelAction(reader_id, undefined, {
        stripeAccount: msa.stripe_account_id,
      });
      cancelSucceeded = true;
    } catch (e) {
      const msg = (e as Error).message;
      if (!msg.includes('no action') && !msg.includes('not found')) {
        errors.push(`reader: ${msg}`);
      }
      console.log('[cancel] cancelAction:', msg);
    }

    try {
      const after = await stripe.terminal.readers.retrieve(reader_id, {
        stripeAccount: msa.stripe_account_id,
      });
      postActionStatus = (after as Stripe.Terminal.Reader)?.action?.status ?? 'idle';
      console.log('[cancel] reader post-cancel:', postActionStatus);
    } catch (e) { console.warn('[cancel] post-retrieve:', (e as Error).message); }
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

  // 3. Clear the reader display back to a neutral "Welcome" state.
  // v5.5.173: Stripe rejects setReaderDisplay with line_items: [] (must
  // have at least one item) — that's why cancels were leaving the reader
  // stuck on the failed/cancelled state. Send one zero-amount line as a
  // reset. Currency now respects the body param so non-USD venues don't
  // see a £ cart suddenly switch to $.
  if (reader_id) {
    try {
      await stripe.terminal.readers.setReaderDisplay(reader_id, {
        type: 'cart',
        cart: {
          line_items: [{ description: 'Welcome', amount: 0, quantity: 1 }],
          total: 0,
          currency: currency.toLowerCase(),
        },
      }, { stripeAccount: msa.stripe_account_id });
    } catch (e) { console.warn('[cancel] reset display failed:', (e as Error).message); }
  }

  return json({
    success: errors.length === 0,
    errors,
    diag: {
      cancel_attempted: cancelAttempted,
      cancel_succeeded: cancelSucceeded,
      pre_action_type: preActionType,
      pre_action_status: preActionStatus,
      post_action_status: postActionStatus,
    },
  });
});
