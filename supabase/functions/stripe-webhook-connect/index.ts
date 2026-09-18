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
import { fulfilResponseRetryable } from '../_shared/giftFulfilPlan.ts';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') ?? '', {
  apiVersion: '2024-06-20',
});

const platformDb = createClient(
  Deno.env.get('PLATFORM_SUPABASE_URL') ?? '',
  Deno.env.get('PLATFORM_SUPABASE_SERVICE_ROLE_KEY') ?? '',
  { auth: { persistSession: false } },
);

const SECRET = Deno.env.get('STRIPE_CONNECT_WEBHOOK_SECRET');
const OPS_URL = Deno.env.get('SUPABASE_URL') ?? '';
const OPS_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

// A failure a later delivery can fix. Thrown by dispatch; the handler answers 503.
const RETRYABLE_PREFIX = 'retryable:';
class RetryableWebhookError extends Error {}

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
    if (insertErr.code !== '23505') {
      console.error('[stripe-webhook-connect] insert error', insertErr);
      return new Response('db error', { status: 500 });
    }
    // A repeat delivery. Normally a no-op; but when the first delivery failed in a way a retry
    // can fix (a gift card purchase whose card could not be issued yet), it was marked
    // 'retryable:' and answered 503 so Stripe would send it again: process it this time. A
    // checkout.session.completed that never finished (the isolate died mid way, no answer went
    // back, so Stripe retries) is processed again too: that branch is idempotent end to end.
    const { data: prior } = await platformDb.from('stripe_webhook_events')
      .select('processed_at, processing_error').eq('id', event.id).maybeSingle();
    const again = !prior?.processed_at && (
      String(prior?.processing_error || '').startsWith(RETRYABLE_PREFIX)
      || (!prior?.processing_error && event.type === 'checkout.session.completed'));
    if (!again) return new Response('ok (duplicate)', { status: 200 });
  }

  try {
    await dispatch(event, accountId);
    await platformDb.from('stripe_webhook_events')
      .update({ processed_at: new Date().toISOString(), processing_error: null }).eq('id', event.id);
  } catch (e) {
    if (e instanceof RetryableWebhookError) {
      // Lockdown step 1 (e): a paid gift card purchase with no card yet (card processor or our
      // database briefly unavailable). Answer non 2xx so Stripe delivers the event again (it
      // retries for up to 3 days); the duplicate check above lets that delivery through.
      console.error('[stripe-webhook-connect] retryable failure, asking Stripe to retry', event.type, e.message);
      await platformDb.from('stripe_webhook_events')
        .update({ processing_error: `${RETRYABLE_PREFIX} ${e.message}`.slice(0, 1000) }).eq('id', event.id);
      return new Response('retry later', { status: 503 });
    }
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
    case 'checkout.session.completed': {
      // v5.5.196: Gift card purchase fulfillment.
      // When a Checkout Session completes and its metadata has type=gift_card_purchase,
      // call the gift-fulfill edge function to issue the card and email it.
      const session = event.data.object as Stripe.Checkout.Session;
      const meta = session.metadata ?? {};
      // 18 Sep 2026: a completed session is not always a paid one (delayed payment methods send
      // checkout.session.async_payment_succeeded later). Only a paid session marks the purchase
      // paid; gift-fulfill asks Stripe again itself before issuing anything.
      if (meta.type === 'gift_card_purchase' && meta.purchase_id && (session as any).payment_status !== 'paid') {
        console.warn('[stripe-webhook-connect] gift purchase session completed but not paid yet:', meta.purchase_id, (session as any).payment_status);
      } else if (meta.type === 'gift_card_purchase' && meta.purchase_id) {
        console.log('[stripe-webhook-connect] fulfilling gift card purchase:', meta.purchase_id);
        // Update purchase status to 'paid' first
        await platformDb.from('gift_card_purchases')
          .update({ status: 'paid', stripe_payment_intent_id: (session as any).payment_intent })
          .eq('id', meta.purchase_id).eq('status', 'pending');   // never rewind a fulfilling or fulfilled purchase
        // Call gift-fulfill to issue + email. Lockdown step 1 (e): a failure a retry can fix (the
        // card processor or our database briefly down, a claim another attempt holds) makes
        // Stripe send the event again; gift-fulfill issues at most one card per purchase.
        let status = 0;
        let fulfillData: any = null;
        try {
          const fulfillRes = await fetch(`${OPS_URL}/functions/v1/gift-fulfill`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${OPS_SERVICE_KEY}`,
            },
            body: JSON.stringify({ purchase_id: meta.purchase_id }),
          });
          status = fulfillRes.status;
          fulfillData = await fulfillRes.json().catch(() => null);
        } catch (e) {
          console.error('[stripe-webhook-connect] gift-fulfill call error:', e);
        }
        if (status >= 200 && status < 300) {
          console.log('[stripe-webhook-connect] gift card fulfilled:', fulfillData);
        } else if (fulfilResponseRetryable(status, fulfillData)) {
          throw new RetryableWebhookError(`gift-fulfill ${status || 'unreachable'} for purchase ${meta.purchase_id}: ${fulfillData?.code || fulfillData?.error || ''}`);
        } else {
          console.error('[stripe-webhook-connect] gift-fulfill refused (final):', status, fulfillData);
        }
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
