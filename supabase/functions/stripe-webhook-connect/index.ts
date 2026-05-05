// supabase/functions/stripe-webhook-connect/index.ts
// Connected-account Stripe webhooks. Deploy to Ops DB project.
// Stripe URL: https://tbetcegmszzotrwdtqhi.supabase.co/functions/v1/stripe-webhook-connect
// "Listen to events on Connected accounts" MUST be ticked on this endpoint.
//
// Required secrets:
//   STRIPE_SECRET_KEY
//   STRIPE_CONNECT_WEBHOOK_SECRET
//   PLATFORM_SUPABASE_URL
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

const SECRET = Deno.env.get('STRIPE_CONNECT_WEBHOOK_SECRET');

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });
  if (!SECRET) return new Response('STRIPE_CONNECT_WEBHOOK_SECRET not configured', { status: 500 });

  const sig = req.headers.get('stripe-signature');
  if (!sig) return new Response('missing stripe-signature', { status: 400 });

  const body = await req.text();
  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(body, sig, SECRET);
  } catch (e) {
    console.error('[stripe-webhook-connect] sig verify failed', e);
    return new Response(`bad signature: ${(e as Error).message}`, { status: 400 });
  }

  const accountId = (event as Stripe.Event & { account?: string }).account ?? null;

  const { error: insertErr } = await platformDb.from('stripe_webhook_events').insert({
    id: event.id, type: event.type, livemode: event.livemode, account_id: accountId, payload: event,
  });
  if (insertErr) {
    if (insertErr.code === '23505') return new Response('ok (duplicate)', { status: 200 });
    console.error('[stripe-webhook-connect] insert error', insertErr);
    return new Response('db error', { status: 500 });
  }

  try {
    await dispatch(event, accountId);
    await platformDb.from('stripe_webhook_events')
      .update({ processed_at: new Date().toISOString() }).eq('id', event.id);
  } catch (e) {
    console.error('[stripe-webhook-connect] handler error', event.type, e);
    await platformDb.from('stripe_webhook_events')
      .update({ processing_error: String(e) }).eq('id', event.id);
  }

  return new Response('ok', { status: 200 });
});

async function dispatch(event: Stripe.Event, accountId: string | null) {
  switch (event.type) {
    case 'account.updated': {
      const acct = event.data.object as Stripe.Account;
      await platformDb.from('merchant_stripe_accounts').update({
        charges_enabled: acct.charges_enabled,
        payouts_enabled: acct.payouts_enabled,
        details_submitted: acct.details_submitted,
        country: acct.country ?? null,
        default_currency: acct.default_currency ?? null,
        capabilities: acct.capabilities ?? {},
        requirements: acct.requirements ?? null,
        last_webhook_at: new Date().toISOString(),
      }).eq('stripe_account_id', acct.id);
      break;
    }
    case 'account.application.deauthorized': {
      if (accountId) {
        await platformDb.from('merchant_stripe_accounts').update({
          charges_enabled: false,
          payouts_enabled: false,
          last_webhook_at: new Date().toISOString(),
        }).eq('stripe_account_id', accountId);
      }
      break;
    }
    case 'capability.updated': {
      const cap = event.data.object as Stripe.Capability;
      if (accountId) {
        const { data: row } = await platformDb.from('merchant_stripe_accounts')
          .select('capabilities').eq('stripe_account_id', accountId).single();
        const capabilities = (row?.capabilities ?? {}) as Record<string, string>;
        capabilities[cap.id] = cap.status;
        await platformDb.from('merchant_stripe_accounts').update({
          capabilities, last_webhook_at: new Date().toISOString(),
        }).eq('stripe_account_id', accountId);
      }
      break;
    }
    case 'payment_intent.succeeded':
    case 'payment_intent.payment_failed':
    case 'charge.refunded':
      // Logged in stripe_webhook_events. Ops DB closed_check updates require
      // looking up locations.ops_db_url + ops_location_id and writing to that
      // tenant's Ops DB — deferred to next sprint. PI metadata.closed_check_id
      // will carry the link when the kiosk/POS payment flows are wired.
      break;
    default:
      console.log('[stripe-webhook-connect] unhandled event', event.type);
  }
}
