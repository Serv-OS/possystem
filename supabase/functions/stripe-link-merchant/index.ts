// supabase/functions/stripe-link-merchant/index.ts
// Admin paste-acct flow: validate stripe_account_id with Stripe, upsert
// merchant_stripe_accounts + ensure billing_state row exists for the location.
//
// Auth: Ops DB user_profiles.role = 'super_admin' (matches existing create-user pattern).
// Body: { stripe_account_id: "acct_...", location_id: "uuid" }

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

// Ops DB client (auto-injected): used for caller auth + role check
const opsAdmin = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  { auth: { autoRefreshToken: false, persistSession: false } },
);

// Platform DB client: used for billing tables
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

  // Auth via Ops DB (matches create-user pattern)
  const { data: { user: caller } } = await opsAdmin.auth.getUser(authHeader.replace('Bearer ', ''));
  if (!caller) return json({ error: 'Invalid token' }, 401);

  const { data: profile } = await opsAdmin.from('user_profiles')
    .select('role').eq('id', caller.id).single();
  if (profile?.role !== 'super_admin') return json({ error: 'Requires super_admin' }, 403);

  let body: { stripe_account_id?: string; location_id?: string };
  try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }
  const { stripe_account_id, location_id } = body;
  if (!stripe_account_id || !location_id) return json({ error: 'stripe_account_id and location_id required' }, 400);
  if (!stripe_account_id.startsWith('acct_')) return json({ error: 'stripe_account_id must start with acct_' }, 400);

  // Resolve location + company_id from Platform DB
  const { data: loc, error: locErr } = await platformAdmin.from('locations')
    .select('id, company_id, name').eq('id', location_id).single();
  if (locErr || !loc) return json({ error: 'location not found in platform DB' }, 404);

  // Validate the account with Stripe
  let acct: Stripe.Account;
  try {
    acct = await stripe.accounts.retrieve(stripe_account_id);
  } catch (e) {
    return json({ error: `stripe account fetch failed: ${(e as Error).message}` }, 400);
  }

  // Upsert merchant_stripe_accounts
  const { error: msaErr } = await platformAdmin.from('merchant_stripe_accounts').upsert({
    location_id,
    company_id: loc.company_id,
    stripe_account_id: acct.id,
    link_method: 'admin_manual',
    charges_enabled: acct.charges_enabled,
    payouts_enabled: acct.payouts_enabled,
    details_submitted: acct.details_submitted,
    country: acct.country ?? null,
    default_currency: acct.default_currency ?? null,
    capabilities: acct.capabilities ?? {},
    requirements: acct.requirements ?? null,
    linked_at: new Date().toISOString(),
  }, { onConflict: 'location_id' });
  if (msaErr) return json({ error: `merchant_stripe_accounts upsert failed: ${msaErr.message}` }, 500);

  // Ensure billing_state row (idempotent)
  await platformAdmin.from('billing_state').upsert({
    location_id,
    company_id: loc.company_id,
    current_period_currency: (acct.default_currency === 'usd' ? 'usd' : 'gbp'),
  }, { onConflict: 'location_id' });

  return json({
    success: true,
    account: {
      id: acct.id,
      country: acct.country,
      default_currency: acct.default_currency,
      charges_enabled: acct.charges_enabled,
      payouts_enabled: acct.payouts_enabled,
      details_submitted: acct.details_submitted,
    },
  });
});
