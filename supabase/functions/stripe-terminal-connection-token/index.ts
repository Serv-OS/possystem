// supabase/functions/stripe-terminal-connection-token/index.ts
// Issues a Stripe Terminal connection token scoped to the merchant's
// connected account. Stripe Terminal Android SDK calls this via TokenProvider
// before pairing with a reader (M2, WisePOS, S700, etc).

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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return json({ error: 'Unauthorized' }, 401);
  const { data: { user: caller } } = await opsAdmin.auth.getUser(authHeader.replace('Bearer ', ''));
  if (!caller) return json({ error: 'Invalid token' }, 401);

  let body: { location_id?: string };
  try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }
  if (!body.location_id) return json({ error: 'location_id required' }, 400);

  const { data: msa, error } = await platformAdmin.from('merchant_stripe_accounts')
    .select('stripe_account_id, charges_enabled')
    .eq('location_id', body.location_id).single();
  if (error || !msa) return json({ error: 'no connected stripe account' }, 400);
  if (!msa.charges_enabled) return json({ error: 'connected account cannot accept charges yet' }, 400);

  try {
    const token = await stripe.terminal.connectionTokens.create({}, { stripeAccount: msa.stripe_account_id });
    return json({ secret: token.secret });
  } catch (e) {
    return json({ error: `stripe error: ${(e as Error).message}` }, 400);
  }
});
