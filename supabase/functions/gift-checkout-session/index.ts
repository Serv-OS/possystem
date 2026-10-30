// supabase/functions/gift-checkout-session/index.ts
//
// PUBLIC (no auth required) — starts an online gift card purchase at the venue's
// own Adyen store. The customer then pays IN-PAGE through AdyenPaymentForm.
//
// Body: {
//   company_id, location_id, amount_minor,
//   sender_name, sender_email, sender_phone?,
//   recipient_name, recipient_email, message?,
//   delivery_type, // 'email' | 'self'
//   success_url?, cancel_url?,   // accepted and ignored (an older page contract)
// }
//
// Returns: { processor: 'adyen', purchase_id, reference, location_id, currency, amount_minor }
//
// The purchase record is created in gift_card_purchases with status='pending'.
// On AUTHORISATION adyen-webhook reads the reference `gift:<purchase id>` and calls
// gift-fulfill, which proves the money against the adyen_payments ledger row.
//
// 29 Oct 2026 (Drop D): ServOS works with Adyen only. The Stripe Checkout Session path
// and the Ryft in-page session path are gone with those processors.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { giftReference } from '../_shared/giftAdyenRules.js';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), {
    status: s,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });

const platformAdmin = createClient(
  Deno.env.get('PLATFORM_SUPABASE_URL') ?? '',
  Deno.env.get('PLATFORM_SUPABASE_SERVICE_ROLE_KEY') ?? '',
  { auth: { autoRefreshToken: false, persistSession: false } },
);

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }

  const {
    company_id, location_id, amount_minor,
    sender_name, sender_email, sender_phone,
    recipient_name, recipient_email, message,
    delivery_type = 'email',
  } = body as any;

  // Validate required fields
  if (!company_id) return json({ error: 'company_id required' }, 400);
  if (!location_id) return json({ error: 'location_id required' }, 400);
  if (!amount_minor || Number(amount_minor) < 500)
    return json({ error: 'amount_minor must be at least 500 (£5.00)' }, 400);
  if (!sender_name || !sender_email)
    return json({ error: 'sender_name and sender_email required' }, 400);
  if (!recipient_name || !recipient_email)
    return json({ error: 'recipient_name and recipient_email required' }, 400);

  // Check gift cards are enabled for this company
  const { data: config } = await platformAdmin
    .from('gift_brand_config')
    .select('enabled, currency, min_card_value_minor, max_card_value_minor')
    .eq('company_id', company_id)
    .maybeSingle();

  if (!config || !config.enabled) {
    return json({ error: 'Gift cards not enabled for this venue' }, 403);
  }

  const amt = Number(amount_minor);
  if (amt < (config.min_card_value_minor || 500)) {
    return json({ error: `Amount below minimum` }, 400);
  }
  if (amt > (config.max_card_value_minor || 50000)) {
    return json({ error: `Amount exceeds maximum` }, 400);
  }

  // ── Adyen (29 Oct 2026, Drop D: the only processor) ──────────────────────
  // The venue's own Adyen store takes the money (the store id rides on the payment, so it
  // settles to that venue's balance account, as every online order does).
  const { data: maa } = await platformAdmin
    .from('merchant_adyen_accounts')
    .select('merchant_account, store_id, receive_payments_ok')
    .eq('location_id', location_id)
    .maybeSingle();
  if (!maa?.merchant_account || maa.receive_payments_ok === false) {
    return json({ error: 'Payments not configured for this venue' }, 400);
  }

  const { data: aPurchase, error: aErr } = await platformAdmin
    .from('gift_card_purchases')
    .insert({
      company_id, location_id, amount_minor: amt,
      currency: config.currency || 'gbp',
      sender_name, sender_email, sender_phone: sender_phone || null,
      recipient_name, recipient_email, message: message || null,
      delivery_type, status: 'pending', processor: 'adyen',
    })
    .select('id')
    .single();
  if (aErr) return json({ error: `Failed to create purchase record: ${aErr.message}` }, 500);

  // The customer pays IN-PAGE through AdyenPaymentForm (the same form online and QR use), which
  // runs the payment through adyen-checkout with THIS reference as Adyen's merchantReference.
  // THAT REFERENCE IS THE WHOLE FULFILMENT CONTRACT: adyen-webhook reads it on AUTHORISATION
  // and calls gift-fulfill, which proves the money against the ledger row for it. The amount
  // the browser sends is fenced twice (webhook and proof) against this row's amount_minor.
  return json({
    processor: 'adyen',
    purchase_id: aPurchase.id,
    reference: giftReference(aPurchase.id),
    location_id,
    currency: config.currency || 'gbp',
    amount_minor: amt,
  });
});
