// supabase/functions/adyen-checkout/index.ts
//
// Adyen ONLINE payments (programme slice 1a) — Checkout API v72 sessions.
// The online checkout (OnlineCheckout.jsx → AdyenPaymentForm) asks for a
// session; Adyen's Drop-in completes the payment client-side; AUTHORISATION
// lands on adyen-webhook (stored raw, HMAC-verified) for reconciliation.
//
// Pattern-matched to the existing stripe-create-payment-intent contract:
// anonymous-auth'd customers call it, amounts arrive from the client (same
// trust model as Stripe/Ryft online today — the webhook records what was
// ACTUALLY paid, and orders reconcile on merchantReference = our order ref).
//
// Raw REST from Deno (X-API-Key) per the plan — the Adyen Node SDK has no
// Deno support. Secrets: ADYEN_API_KEY / ADYEN_MERCHANT_ACCOUNT / ADYEN_ENV /
// ADYEN_CLIENT_KEY (served to the client — it is a publishable key).

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const API_KEY = Deno.env.get('ADYEN_API_KEY') ?? '';
const MERCHANT = Deno.env.get('ADYEN_MERCHANT_ACCOUNT') ?? '';
const CLIENT_KEY = Deno.env.get('ADYEN_CLIENT_KEY') ?? '';
const ENV = (Deno.env.get('ADYEN_ENV') ?? 'test').toLowerCase();
const CHECKOUT_BASE = ENV === 'live' ? 'https://checkout-live.adyen.com' : 'https://checkout-test.adyen.com';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    if (!API_KEY || !MERCHANT || !CLIENT_KEY) return json({ error: 'Adyen is not configured on this environment' }, 500);
    const body = await req.json().catch(() => ({}));
    const action = body.action || 'create_session';

    if (action === 'create_session') {
      const amount = Math.round(Number(body.amount_minor));
      if (!Number.isFinite(amount) || amount < 1) return json({ error: 'amount_minor must be a positive integer (pence)' }, 400);
      const currency = String(body.currency || 'GBP').toUpperCase();
      const reference = String(body.reference || '').slice(0, 80);
      if (!reference) return json({ error: 'reference required (the order ref)' }, 400);

      const session: Record<string, unknown> = {
        merchantAccount: MERCHANT,
        amount: { value: amount, currency },
        reference,
        returnUrl: String(body.return_url || 'https://dev.serv-os.app/'),
        countryCode: String(body.country || 'GB').toUpperCase(),
        channel: 'Web',
      };
      if (body.shopper_email) session.shopperEmail = String(body.shopper_email);

      const res = await fetch(`${CHECKOUT_BASE}/v72/sessions`, {
        method: 'POST',
        headers: { 'X-API-Key': API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify(session),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        console.error('[adyen-checkout] sessions failed:', res.status, JSON.stringify(j).slice(0, 400));
        return json({ error: j.message || `Adyen refused the session (${res.status})` }, 502);
      }
      return json({
        ok: true,
        id: j.id,
        sessionData: j.sessionData,
        clientKey: CLIENT_KEY,
        environment: ENV,
        reference,
        amount: j.amount,
      });
    }

    return json({ error: `unknown action: ${action}` }, 400);
  } catch (e) {
    console.error('[adyen-checkout]', e);
    return json({ error: (e as Error).message || 'server error' }, 500);
  }
});
