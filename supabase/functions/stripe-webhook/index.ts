// supabase/functions/stripe-webhook/index.ts
// Platform-account Stripe webhooks. Deploy to Ops DB project (tbetcegmszzotrwdtqhi).
// Stripe URL: https://tbetcegmszzotrwdtqhi.supabase.co/functions/v1/stripe-webhook
//
// Required secrets:
//   STRIPE_SECRET_KEY
//   STRIPE_WEBHOOK_SECRET
//   PLATFORM_SUPABASE_URL              (yhzjgyrkyjabvhblqxzu's https URL)
//   PLATFORM_SUPABASE_SERVICE_ROLE_KEY

import Stripe from 'https://esm.sh/stripe@14.21.0?target=denonext';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') ?? '', {
  apiVersion: '2024-06-20',
});

const platformDb = createClient(
  Deno.env.get('PLATFORM_SUPABASE_URL') ?? '',
  Deno.env.get('PLATFORM_SUPABASE_SERVICE_ROLE_KEY') ?? '',
  { auth: { persistSession: false } },
);

const SECRET = Deno.env.get('STRIPE_WEBHOOK_SECRET');

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });
  if (!SECRET) return new Response('STRIPE_WEBHOOK_SECRET not configured', { status: 500 });

  const sig = req.headers.get('stripe-signature');
  if (!sig) return new Response('missing stripe-signature', { status: 400 });

  const body = await req.text();
  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(body, sig, SECRET);
  } catch (e) {
    console.error('[stripe-webhook] sig verify failed', e);
    return new Response(`bad signature: ${(e as Error).message}`, { status: 400 });
  }

  const { error: insertErr } = await platformDb.from('stripe_webhook_events').insert({
    id: event.id, type: event.type, livemode: event.livemode, account_id: null, payload: event,
  });
  if (insertErr) {
    if (insertErr.code === '23505') return new Response('ok (duplicate)', { status: 200 });
    console.error('[stripe-webhook] insert error', insertErr);
    return new Response('db error', { status: 500 });
  }

  // Platform-level events (payout/balance/etc.) — log only for now
  await platformDb.from('stripe_webhook_events')
    .update({ processed_at: new Date().toISOString() }).eq('id', event.id);

  return new Response('ok', { status: 200 });
});
