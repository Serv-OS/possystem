// supabase/functions/adyen-create-session
//
// Checkout v72 /sessions for Web Drop-in v6 — online ordering, QR, catering,
// gift purchase (ADYEN_INTEGRATION_PLAN.md Phase 2, built ahead of keys).
//
// Platform-fee model: NOT computed here. The venue's STORE carries a split
// configuration profile (set from the admin portal at onboarding) that books
// our Commission on every payment — one source of truth for rates.
//
// Caller: authenticated OR anonymous session (kiosk/online use signInAnonymously,
// same contract as ryft-create-payment-session). Amount is the caller's ONLY in
// the sense that online carts are client-built; the closed check reconciliation
// and the AUTHORISATION webhook verify what was actually charged.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { adyenConfigured, checkoutBase, adyenFetch } from '../_shared/adyen.ts';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const opsAdmin = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '', { auth: { autoRefreshToken: false, persistSession: false } });
const platformAdmin = createClient(Deno.env.get('PLATFORM_SUPABASE_URL') ?? '', Deno.env.get('PLATFORM_SUPABASE_SERVICE_ROLE_KEY') ?? '', { auth: { autoRefreshToken: false, persistSession: false } });

const CLIENT_KEY = Deno.env.get('ADYEN_CLIENT_KEY') ?? '';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);
  if (!adyenConfigured()) return json({ error: 'Adyen not configured — set ADYEN_API_KEY' }, 503);

  const token = (req.headers.get('Authorization') ?? '').replace('Bearer ', '').trim();
  if (!token) return json({ error: 'unauthorized' }, 401);
  try {
    const { data } = await opsAdmin.auth.getUser(token);
    if (!data?.user?.id) return json({ error: 'unauthorized' }, 401);
  } catch { return json({ error: 'unauthorized' }, 401); }

  let body: any;
  try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }
  const amountMinor = Math.round(Number(body.amount_minor));
  const currency = String(body.currency || 'GBP').toUpperCase();
  const locationId = String(body.location_id || '');
  if (!locationId || !Number.isFinite(amountMinor) || amountMinor < 30) {
    return json({ error: 'location_id and amount_minor (≥30) required' }, 400);
  }

  // Resolve either id space (ops or platform), same dual idiom as the Ryft fns.
  let { data: ploc } = await platformAdmin.from('locations')
    .select('id, payment_processor, currency, country').eq('ops_location_id', locationId).maybeSingle();
  if (!ploc) {
    const fb = await platformAdmin.from('locations')
      .select('id, payment_processor, currency, country').eq('id', locationId).maybeSingle();
    ploc = fb.data ?? null;
  }
  if (!ploc) return json({ error: 'location not found' }, 404);
  if (ploc.payment_processor !== 'adyen') return json({ error: 'location is not on Adyen' }, 409);

  const { data: maa } = await platformAdmin.from('merchant_adyen_accounts')
    .select('merchant_account, store_id, receive_payments_ok').eq('location_id', ploc.id).maybeSingle();
  if (!maa?.merchant_account) return json({ error: 'venue has no Adyen account — onboarding incomplete' }, 409);
  if (!maa.receive_payments_ok) return json({ error: 'venue cannot receive payments yet — verification pending' }, 409);

  const reference = String(body.closed_check_id || body.order_ref || `so-${crypto.randomUUID()}`).slice(0, 80);
  const payload: any = {
    merchantAccount: maa.merchant_account,
    amount: { value: amountMinor, currency },
    reference,
    returnUrl: String(body.return_url || 'https://possystem-liard.vercel.app/'),
    countryCode: String(body.country || ploc.country || (currency === 'USD' ? 'US' : 'GB')),
    channel: 'Web',
    ...(maa.store_id ? { store: maa.store_id } : {}),
    ...(body.shopper_email ? { shopperEmail: String(body.shopper_email) } : {}),
    // Tokenization (QR tab overage / one-click reorder): store on request.
    ...(body.store_payment_method && body.shopper_reference ? {
      shopperReference: String(body.shopper_reference),
      storePaymentMethod: true,
      recurringProcessingModel: 'UnscheduledCardOnFile',
      shopperInteraction: 'Ecommerce',
    } : {}),
    // v968 review hardening: manual_capture is REFUSED for now. The old code sent
    // captureDelayHours:168 — which is Adyen's scheduled AUTO-capture delay, i.e.
    // an abandoned hold would have captured the customer's full amount at 7 days.
    // True holds arrive with the Phase-2 QR-tab design (authorisation + adjust +
    // explicit capture/cancel, mirrored on the terminal PreAuth path).
    metadata: {
      channel: String(body.channel || 'online').slice(0, 80),
      ops_location: String(locationId).slice(0, 80),
      ...(body.closed_check_id ? { closed_check_id: String(body.closed_check_id).slice(0, 80) } : {}),
    },
  };

  const res = await adyenFetch('POST', `${checkoutBase()}/sessions`, payload, { idempotencyKey: `sess:${reference}` });
  if (!res.ok) return json({ error: `adyen ${res.status}`, detail: res.data }, 502);

  return json({
    processor: 'adyen',
    session_id: res.data?.id,
    session_data: res.data?.sessionData,
    client_key: CLIENT_KEY || null,   // Drop-in needs it; configured with the other secrets
    environment: (Deno.env.get('ADYEN_ENV') ?? 'test') === 'live' ? 'live' : 'test',
    reference,
    amount_minor: amountMinor,
    currency,
  });
});
