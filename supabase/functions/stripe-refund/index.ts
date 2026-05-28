// supabase/functions/stripe-refund/index.ts
//
// Issue a Stripe refund against a PaymentIntent on a connected merchant account.
// Called by the POS refundCheck() flow when the original payment was by card.
//
// Body: {
//   payment_intent_id: string   // the PI to refund (pi_...)
//   amount_minor: number        // refund amount in minor units (pence)
//   location_id: string         // ops location ID — used to resolve the connected Stripe account
//   reason?: string             // 'requested_by_customer' | 'duplicate' | 'fraudulent'
//   closed_check_id?: string    // for audit trail metadata
//   staff_id?: string           // who issued the refund
// }
//
// Returns: { ok, refund_id, amount, status }

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import Stripe from 'https://esm.sh/stripe@14.21.0?target=denonext';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

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

  // Auth
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return json({ error: 'Unauthorized' }, 401);
  const { data: { user: caller } } = await opsAdmin.auth.getUser(authHeader.replace('Bearer ', ''));
  if (!caller) return json({ error: 'Invalid token' }, 401);

  let body: {
    payment_intent_id?: string;
    amount_minor?: number;
    location_id?: string;
    reason?: string;
    closed_check_id?: string;
    staff_id?: string;
  };
  try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }

  const { payment_intent_id, amount_minor, location_id, reason, closed_check_id, staff_id } = body;

  if (!payment_intent_id) return json({ error: 'payment_intent_id required' }, 400);
  if (!amount_minor || amount_minor <= 0) return json({ error: 'amount_minor must be positive' }, 400);
  if (!location_id) return json({ error: 'location_id required' }, 400);

  // Resolve platform location from ops location_id
  const { data: platformLoc } = await platformAdmin.from('locations')
    .select('id')
    .or(`ops_location_id.eq.${location_id},id.eq.${location_id}`)
    .maybeSingle();
  if (!platformLoc) return json({ error: 'Platform location not found' }, 404);

  // Resolve connected Stripe account
  const { data: msa } = await platformAdmin.from('merchant_stripe_accounts')
    .select('stripe_account_id')
    .eq('location_id', platformLoc.id)
    .maybeSingle();
  if (!msa?.stripe_account_id) return json({ error: 'No Stripe account linked to this location' }, 400);

  try {
    // Create the refund on the connected account
    const refund = await stripe.refunds.create(
      {
        payment_intent: payment_intent_id,
        amount: amount_minor,
        reason: (reason as Stripe.RefundCreateParams.Reason) || 'requested_by_customer',
        metadata: {
          closed_check_id: closed_check_id || '',
          staff_id: staff_id || '',
          location_id: location_id,
          source: 'pos_refund',
        },
      },
      { stripeAccount: msa.stripe_account_id },
    );

    console.log(`[stripe-refund] Created refund ${refund.id} for PI ${payment_intent_id} — ${refund.amount} ${refund.currency} — status: ${refund.status}`);

    return json({
      ok: true,
      refund_id: refund.id,
      amount: refund.amount,
      currency: refund.currency,
      status: refund.status,
    });
  } catch (e) {
    const msg = (e as Error)?.message || String(e);
    console.error(`[stripe-refund] Failed for PI ${payment_intent_id}:`, msg);

    // Stripe errors often have a code — pass it through for debugging
    const stripeError = (e as any)?.raw;
    return json({
      error: `Stripe refund failed: ${msg}`,
      code: stripeError?.code || null,
    }, 502);
  }
});
