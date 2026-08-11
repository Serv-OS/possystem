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

    // Live connection status for the admin portal — replaces a hardcoded
    // "coming soon" sign that outlived its truth within a week (v5.6.20).
    // No secrets in the response; merchant account NAME is admin-visible info.
    if (action === 'status') {
      return json({
        ok: true,
        configured: true,
        environment: ENV,
        merchantAccount: MERCHANT,
        clientKey: CLIENT_KEY,            // publishable — the card form needs it to render
        online: true,                     // slice 1a shipped — advanced flow + Drop-in
        inPerson: false,                  // awaits test terminals (slice 1b)
      });
    }

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

    // ── make_payment: the ADVANCED flow. Drop-in encrypts the card in the
    //    browser and hands us the blob; WE make the payment server-side with
    //    the API key. Adopted 11 Aug after the sessions flow's checkoutshopper
    //    /payments returned an unexplainable 403 (origin+key+role all verified
    //    good — a probe with invalid sessionData got 422, the real payment
    //    403, so the refusal sits deeper in Adyen's hosted stack). Server-side
    //    we see EVERY error in full, and this is the same path the terminal
    //    work needs anyway. ──────────────────────────────────────────────────
    if (action === 'make_payment') {
      const amount = Math.round(Number(body.amount_minor));
      if (!Number.isFinite(amount) || amount < 1) return json({ error: 'amount_minor must be a positive integer (pence)' }, 400);
      const reference = String(body.reference || '').slice(0, 80);
      if (!reference) return json({ error: 'reference required' }, 400);
      if (!body.payment_method || typeof body.payment_method !== 'object') {
        return json({ error: 'payment_method (the encrypted card from the form) required' }, 400);
      }
      const payment: Record<string, unknown> = {
        merchantAccount: MERCHANT,
        amount: { value: amount, currency: String(body.currency || 'GBP').toUpperCase() },
        reference,
        paymentMethod: body.payment_method,
        channel: 'Web',
        origin: String(body.origin || ''),
        returnUrl: String(body.return_url || 'https://dev.serv-os.app/'),
        shopperInteraction: 'Ecommerce',
      };
      if (body.browser_info) payment.browserInfo = body.browser_info;
      if (body.shopper_email) payment.shopperEmail = String(body.shopper_email);

      const res = await fetch(`${CHECKOUT_BASE}/v72/payments`, {
        method: 'POST',
        headers: { 'X-API-Key': API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify(payment),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        console.error('[adyen-checkout] payments failed:', res.status, JSON.stringify(j).slice(0, 500));
        return json({ error: j.message || `Adyen refused the payment (${res.status})`, errorCode: j.errorCode || null }, 502);
      }
      // resultCode: Authorised | Refused | RedirectShopper | IdentifyShopper | …
      // `action` present = 3DS or redirect step the client must run.
      return json({
        ok: true,
        resultCode: j.resultCode || null,
        pspReference: j.pspReference || null,
        refusalReason: j.refusalReason || null,
        action: j.action || null,
        merchantReference: reference,
      });
    }

    // ── payment_details: completes a 3DS/redirect flow started above ─────────
    if (action === 'payment_details') {
      if (!body.details) return json({ error: 'details required' }, 400);
      const res = await fetch(`${CHECKOUT_BASE}/v72/payments/details`, {
        method: 'POST',
        headers: { 'X-API-Key': API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ details: body.details }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) return json({ error: j.message || `Adyen refused (${res.status})` }, 502);
      return json({ ok: true, resultCode: j.resultCode || null, pspReference: j.pspReference || null, refusalReason: j.refusalReason || null, action: j.action || null });
    }

    return json({ error: `unknown action: ${action}` }, 400);
  } catch (e) {
    console.error('[adyen-checkout]', e);
    return json({ error: (e as Error).message || 'server error' }, 500);
  }
});
