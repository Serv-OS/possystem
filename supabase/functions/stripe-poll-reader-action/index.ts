// supabase/functions/stripe-poll-reader-action/index.ts
//
// POS calls this every ~1s during a card payment to check whether the reader
// has finished collecting from the customer. Returns PI status + reader
// action status + any error.
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

  let body: { payment_intent_id?: string; location_id?: string; reader_id?: string };
  try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }
  const { payment_intent_id, location_id, reader_id } = body ?? {};
  if (!payment_intent_id || !location_id) {
    return json({ error: 'payment_intent_id and location_id required' }, 400);
  }

  const { data: msa } = await platformAdmin.from('merchant_stripe_accounts')
    .select('stripe_account_id').eq('location_id', location_id).maybeSingle();
  if (!msa?.stripe_account_id) return json({ error: 'Merchant Stripe account not linked' }, 400);

  // Fetch PaymentIntent — latest_charge expanded so a SUCCEEDED payment can return the
  // card-present receipt fields (scheme, last4, auth code, AID, CVM). UK card-scheme rules
  // require these on the printed receipt; Stripe exposes them exactly for that purpose.
  let pi: Stripe.PaymentIntent;
  try {
    pi = await stripe.paymentIntents.retrieve(payment_intent_id, { expand: ['latest_charge'] }, { stripeAccount: msa.stripe_account_id });
  } catch (e) {
    return json({ error: `Stripe could not fetch PI: ${(e as Error).message}` }, 400);
  }

  // Fetch Reader action (if we have the reader id) — gives us the reader-side
  // state which is more granular than PI status during collection.
  let readerAction: Stripe.Terminal.Reader.Action | null = null;
  let readerStatus: string | null = null;
  if (reader_id) {
    try {
      const r = await stripe.terminal.readers.retrieve(reader_id, { stripeAccount: msa.stripe_account_id });
      readerAction = (r.action as Stripe.Terminal.Reader.Action | null) ?? null;
      readerStatus = r.status ?? null;
    } catch (e) {
      console.warn('[poll] reader.retrieve failed:', (e as Error).message);
    }
  }

  // Card-present receipt block (UK card-scheme receipt requirements). Only present once the
  // charge exists (success). Every field is best-effort — a missing field never blocks the poll.
  let card: Record<string, unknown> | null = null;
  try {
    const ch = (typeof pi.latest_charge === 'object' ? pi.latest_charge : null) as Stripe.Charge | null;
    const cp = ch?.payment_method_details?.card_present as Stripe.Charge.PaymentMethodDetails.CardPresent | undefined;
    if (cp) {
      card = {
        brand: cp.brand ?? null,                                        // visa | mastercard | amex …
        last4: cp.last4 ?? null,
        read_method: cp.read_method ?? null,                            // contactless_emv | contact_emv | …
        auth_code: cp.receipt?.authorization_code ?? null,
        aid: cp.receipt?.dedicated_file_name ?? null,                   // EMV AID
        application_name: cp.receipt?.application_preferred_name ?? null,
        cvm: cp.receipt?.cardholder_verification_method ?? null,        // none | offline_pin | online_pin | signature
        account_type: cp.receipt?.account_type ?? null,
      };
    }
  } catch { /* receipt block is best-effort */ }

  return json({
    payment_intent_id: pi.id,
    payment_intent_status: pi.status,           // requires_payment_method | requires_confirmation | requires_action | processing | requires_capture | canceled | succeeded
    amount: pi.amount,
    amount_received: pi.amount_received,
    card,
    application_fee_amount: pi.application_fee_amount ?? 0,
    last_payment_error: pi.last_payment_error?.message ?? null,
    reader_action: readerAction ? {
      type: readerAction.type,
      status: readerAction.status,                                      // in_progress | succeeded | failed
      failure_code: readerAction.failure_code ?? null,
      failure_message: readerAction.failure_message ?? null,
    } : null,
    reader_status: readerStatus,
    // Convenience flags for the POS
    is_terminal_state: ['succeeded', 'canceled'].includes(pi.status)
      || (readerAction?.status === 'failed'),
    is_success: pi.status === 'succeeded',
  });
});
