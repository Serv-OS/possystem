// supabase/functions/stripe-increment-authorization/index.ts
//
// "Step up" a bar-tab card pre-auth: raise the held amount on the EXISTING manual-capture
// PaymentIntent (the card was already collected on the reader at tab-open, so no re-tap).
// Used when a tab is about to exceed its hold and staff want to keep one running bill.
//
// Body: { payment_intent_id, location_id, amount_minor }  (amount_minor = the NEW total hold)
// Returns { ok:true, amount_minor } on success, or { ok:false, error } (HTTP 200) so the client
// can fall back gracefully — incremental authorization is card/issuer-dependent (not universal).
//
// Auth: any valid Supabase session (bar runs on a paired/anon device, like the other reader fns).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import Stripe from 'https://esm.sh/stripe@14.21.0?target=denonext';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const opsAdmin = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '', { auth: { autoRefreshToken: false, persistSession: false } });
const platformAdmin = createClient(Deno.env.get('PLATFORM_SUPABASE_URL') ?? '', Deno.env.get('PLATFORM_SUPABASE_SERVICE_ROLE_KEY') ?? '', { auth: { autoRefreshToken: false, persistSession: false } });
const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') ?? '', { apiVersion: '2024-06-20' });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return json({ error: 'Unauthorized' }, 401);
  const { data: { user: caller } } = await opsAdmin.auth.getUser(authHeader.replace('Bearer ', ''));
  if (!caller) return json({ error: 'Invalid token' }, 401);

  let body: { payment_intent_id?: string; location_id?: string; amount_minor?: number };
  try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }
  const { payment_intent_id, location_id, amount_minor } = body ?? {};
  if (!payment_intent_id || !location_id || !amount_minor) return json({ error: 'payment_intent_id, location_id and amount_minor required' }, 400);

  // Resolve the connected Stripe account (location_id may be an ops or platform id).
  const { data: platformLoc } = await platformAdmin.from('locations')
    .select('id').or(`ops_location_id.eq.${location_id},id.eq.${location_id}`).maybeSingle();
  const platLocId = platformLoc?.id || location_id;
  const { data: msa } = await platformAdmin.from('merchant_stripe_accounts')
    .select('stripe_account_id').eq('location_id', platLocId).maybeSingle();
  if (!msa?.stripe_account_id) return json({ error: 'Merchant Stripe account not linked' }, 400);

  try {
    const pi = await stripe.paymentIntents.incrementAuthorization(
      payment_intent_id,
      { amount: Math.round(amount_minor) },
      { stripeAccount: msa.stripe_account_id },
    );
    return json({ ok: true, amount_minor: pi.amount, status: pi.status });
  } catch (e) {
    // Card/issuer doesn't support incremental auth, PI already captured, etc. — surface it so
    // the client can fall back to "take payment / open a new tab" (HTTP 200, not an error code).
    return json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});
