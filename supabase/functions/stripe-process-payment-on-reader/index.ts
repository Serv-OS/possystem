// supabase/functions/stripe-process-payment-on-reader/index.ts
//
// Pure-REST card payment flow for network readers (BBPOS WisePOS E, S700).
// Replaces the broken Android bridge path entirely. Customer-facing UX —
// line items, tip prompt, card prompt — all happens on the reader screen.
//
// Flow:
//   1. Look up the assigned reader for the calling POS terminal
//   2. Look up the merchant's connected Stripe account
//   3. Create PaymentIntent on the connected account, with markup as
//      application_fee_amount and tipping config from per-location settings
//   4. Push cart line items to the reader screen via set_reader_display
//   5. Call process_payment_intent on the reader — reader prompts customer
//      for tip (if enabled) and card
//   6. Return the PI id so POS can poll for completion via stripe-poll-reader-action
//
// Body: {
//   pos_device_id: string         // ops devices.id of the calling POS/kiosk
//   amount_minor: number          // pre-tip amount in minor units (cents/pence)
//   currency: string              // 'gbp' | 'usd' etc.
//   line_items?: [{ description: string, amount: number, quantity: number }]
//   closed_check_id?: string      // optional, for our records
// }

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

  // Auth: caller must be a logged-in user (POS user / cashier)
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return json({ error: 'Unauthorized' }, 401);
  const { data: { user: caller } } = await opsAdmin.auth.getUser(authHeader.replace('Bearer ', ''));
  if (!caller) return json({ error: 'Invalid token' }, 401);

  let body: {
    pos_device_id?: string;
    amount_minor?: number;
    currency?: string;
    line_items?: Array<{ description: string; amount: number; quantity: number }>;
    closed_check_id?: string;
    skip_tipping?: boolean; // v5.5.269: kiosk collects tip in its own UI, skip reader prompt
    capture_method?: 'automatic' | 'manual'; // v5.5.324: 'manual' = pre-auth hold (bar tabs)
  };
  try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }
  const { pos_device_id, amount_minor, currency, line_items, closed_check_id, skip_tipping, capture_method } = body ?? {};
  // v5.5.324: bar-tab pre-authorisation. 'manual' creates a hold (auth) that is
  // captured later when the tab closes. Anything else (incl. undefined) stays
  // 'automatic' so every existing card payment is byte-for-byte unchanged.
  const captureMethod: 'automatic' | 'manual' = capture_method === 'manual' ? 'manual' : 'automatic';
  const isPreAuth = captureMethod === 'manual';
  if (!pos_device_id || !amount_minor || !currency) {
    return json({ error: 'pos_device_id, amount_minor, currency required' }, 400);
  }
  if (amount_minor < 30) return json({ error: 'amount_minor must be at least 30 (Stripe minimum)' }, 400);

  // 1. Resolve POS device → Ops location_id → Platform location_id
  const { data: posDevice } = await opsAdmin.from('devices')
    .select('id, location_id, name, type').eq('id', pos_device_id).maybeSingle();
  if (!posDevice) return json({ error: 'POS device not found' }, 404);
  if (!['pos', 'kiosk'].includes(posDevice.type ?? '')) {
    return json({ error: `device type "${posDevice.type}" cannot take payments` }, 400);
  }

  // Map ops location → platform location (via ops_location_id reverse lookup)
  const { data: platformLoc } = await platformAdmin.from('locations')
    .select('id, name, company_id').or(`ops_location_id.eq.${posDevice.location_id},id.eq.${posDevice.location_id}`)
    .maybeSingle();
  if (!platformLoc) return json({ error: 'Platform location not found for this POS device' }, 404);

  // 2. Find the network reader assigned to THIS pos device
  const { data: reader } = await platformAdmin.from('payment_devices')
    .select('id, stripe_reader_id, stripe_account_id, label, status, location_id')
    .eq('location_id', platformLoc.id)
    .eq('connection_kind', 'network')
    .eq('bound_pos_device_id', pos_device_id)
    .maybeSingle();
  if (!reader) {
    return json({
      error: 'No network reader is assigned to this POS terminal. Ask an admin to assign one in Back office → Card readers.',
      code: 'no_reader_assigned',
    }, 400);
  }

  // 3. Get merchant Stripe account + markup config
  const { data: msa } = await platformAdmin.from('merchant_stripe_accounts')
    .select('stripe_account_id, charges_enabled, payouts_enabled')
    .eq('location_id', platformLoc.id).maybeSingle();
  if (!msa?.stripe_account_id) return json({ error: 'Merchant Stripe account not linked' }, 400);
  if (!msa.charges_enabled) return json({ error: 'Merchant account cannot accept charges yet' }, 400);

  // Markup percent from location overrides → company defaults → platform defaults
  const { data: markupRow } = await platformAdmin.rpc('get_effective_markup', {
    p_location_id: platformLoc.id,
    p_channel: 'cardpresent',
  });
  const markupPct = Number(markupRow ?? 1.0);   // fallback 1%
  const application_fee_amount = Math.round(amount_minor * markupPct / 100);

  // Tipping config — pull from per-location settings (defaults to enabled)
  const { data: tipSettings } = await platformAdmin.from('location_reader_settings')
    .select('tipping_enabled, tip_percentages, allow_custom_tip')
    .eq('location_id', platformLoc.id).maybeSingle();
  // v5.5.269: skip_tipping overrides location settings — kiosk already collected tip in its UI
  // v5.5.324: a pre-auth hold never prompts for a tip (the tip is taken at close).
  const tippingEnabled = (skip_tipping || isPreAuth) ? false : (tipSettings?.tipping_enabled !== false);

  // 4. Create PaymentIntent on the connected account
  // payment_method_options.card_present.request_extended_authorization can be left default
  const piCreate: Stripe.PaymentIntentCreateParams = {
    amount: amount_minor,
    currency: currency.toLowerCase(),
    payment_method_types: ['card_present'],
    capture_method: captureMethod,  // v5.5.324: 'manual' for bar-tab pre-auth holds
    application_fee_amount,
    metadata: {
      location_id: platformLoc.id,
      pos_device_id,
      cashier_user_id: caller.id,
      ...(closed_check_id ? { closed_check_id } : {}),
    },
  };
  // Only set tipping when enabled — Stripe's Terminal Configuration handles the
  // tip UI on the reader; the PI itself just needs to be created with
  // capture_method=automatic and standard card_present.

  let pi: Stripe.PaymentIntent;
  try {
    pi = await stripe.paymentIntents.create(piCreate, { stripeAccount: msa.stripe_account_id });
  } catch (e) {
    return json({
      error: `Stripe rejected PaymentIntent: ${(e as Error).message}`,
      code: 'pi_create_failed',
    }, 400);
  }

  // 5. Push cart line items to reader screen (best-effort, non-fatal if it fails)
  if (line_items && line_items.length > 0) {
    try {
      await stripe.terminal.readers.setReaderDisplay(reader.stripe_reader_id, {
        type: 'cart',
        cart: {
          line_items: line_items.slice(0, 100).map(li => ({
            description: String(li.description ?? '').slice(0, 60),
            amount: Math.round(li.amount),
            quantity: Math.max(1, Math.min(999, Math.round(li.quantity ?? 1))),
          })),
          total: amount_minor,
          currency: currency.toLowerCase(),
        },
      }, { stripeAccount: msa.stripe_account_id });
    } catch (e) {
      console.warn('[stripe-process-payment-on-reader] set_reader_display failed (non-fatal):', (e as Error).message);
    }
  }

  // 6. Process the PaymentIntent on the reader — this triggers the reader UI
  // v5.5.174: pass process_config.tipping.amount_eligible so the reader
  // actually fires the tip prompt. Without this, even with tipping enabled
  // in BO + the Terminal Configuration assigned to the reader, the reader
  // skips the tip step because Stripe needs amount_eligible to compute the
  // % options against. Use the base bill amount as the eligible amount.
  // v5.5.272: When tipping is disabled (e.g. kiosk skip_tipping), we must
  // explicitly pass process_config.skip_tipping = true. Just omitting
  // process_config causes Stripe to fall back to the Terminal Configuration
  // assigned to the reader, which has tipping enabled globally — so the
  // reader still shows the tip prompt. skip_tipping overrides that.
  let action: Stripe.Terminal.Reader;
  try {
    const processParams: Record<string, unknown> = { payment_intent: pi.id };
    if (tippingEnabled) {
      processParams.process_config = { tipping: { amount_eligible: amount_minor } };
    } else {
      processParams.process_config = { skip_tipping: true };
    }
    action = await stripe.terminal.readers.processPaymentIntent(
      reader.stripe_reader_id,
      processParams as any,
      { stripeAccount: msa.stripe_account_id },
    );
  } catch (e) {
    // Best-effort cleanup: cancel the PI we just created so it doesn't leave
    // an orphan in requires_payment_method.
    try { await stripe.paymentIntents.cancel(pi.id, { stripeAccount: msa.stripe_account_id }); } catch { /* ignore */ }
    return json({
      error: `Reader rejected processPaymentIntent: ${(e as Error).message}. Confirm the reader is online and connected to power.`,
      code: 'reader_process_failed',
      payment_intent_id: pi.id,
    }, 400);
  }

  return json({
    success: true,
    payment_intent_id: pi.id,
    payment_intent_status: pi.status,
    amount_minor,
    application_fee_amount,
    markup_percent: markupPct,
    tipping_enabled: tippingEnabled,
    reader_id: reader.stripe_reader_id,
    reader_label: reader.label,
    reader_action_status: action.action?.status ?? 'in_progress',
    capture_method: captureMethod,           // v5.5.324: echo back so the client knows it's a hold
    stripe_account_id: msa.stripe_account_id, // v5.5.324: needed to capture/cancel the hold at close
  });
});
