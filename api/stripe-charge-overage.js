/**
 * Restaurant OS — Stripe overage-charge endpoint for QR open tabs (v5.5.160)
 *
 * POST { stripeAccount, paymentMethodId, amount, currency='gbp', description, metadata }
 *   → 200 { ok: true, payment_intent: id, status, amount }
 *   → 4xx { ok: false, error, code }
 *
 * Used when an open-tab's actual bill exceeds the pre-authorised amount.
 * Stripe REJECTS captures > authorised — so we cap the original capture at
 * the auth, then call this endpoint to charge the remainder off_session
 * on the same payment_method (saved at tab open via setup_future_usage='off_session').
 *
 * The payment_method must already be attached to the connected account's
 * customer (Stripe does this automatically when the PI was created with
 * setup_future_usage='off_session' and confirmed). This endpoint creates
 * a NEW PI with off_session=true + confirm=true so the customer doesn't
 * see a 3DS challenge — relies on the auth saved at tab open.
 *
 * If the off_session charge fails (insufficient funds, lost card, etc.)
 * the operator gets a clear error and must collect the overage another
 * way (terminal, cash, manual link).
 *
 * Required Vercel env: STRIPE_SECRET_KEY (platform secret key).
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  const key = process.env.STRIPE_SECRET_KEY
           || process.env.STRIPE_API_KEY
           || process.env.STRIPE_TEST_KEY
           || process.env.STRIPE_LIVE_KEY;
  if (!key) {
    return res.status(500).json({ ok: false, error: 'STRIPE_SECRET_KEY not set on Vercel' });
  }

  try {
    const {
      stripeAccount,
      paymentMethodId,
      amount,                // minor units (pence)
      currency = 'gbp',
      description = 'QR tab overage',
      metadata = {},
    } = req.body || {};

    if (!stripeAccount)   return res.status(400).json({ ok: false, error: 'Missing stripeAccount' });
    if (!paymentMethodId) return res.status(400).json({ ok: false, error: 'Missing paymentMethodId — tab was opened before v5.5.160 (no saved card on file). Collect overage via terminal or cash.' });
    if (!amount || typeof amount !== 'number' || amount <= 0) {
      return res.status(400).json({ ok: false, error: 'amount must be a positive integer (minor units)' });
    }

    const params = new URLSearchParams();
    params.set('amount', String(Math.round(amount)));
    params.set('currency', String(currency).toLowerCase());
    params.set('payment_method', String(paymentMethodId));
    params.set('confirm', 'true');
    params.set('off_session', 'true');
    params.set('description', String(description));
    params.set('payment_method_types[]', 'card');
    Object.entries(metadata).forEach(([k, v]) => {
      if (v != null) params.set(`metadata[${k}]`, String(v));
    });

    const r = await fetch('https://api.stripe.com/v1/payment_intents', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Stripe-Account': stripeAccount,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });
    const data = await r.json();
    if (!r.ok) {
      // Stripe wraps off_session declines in `payment_intent.last_payment_error`.
      // Surface a useful message either way.
      const errMsg = data?.error?.message
        || data?.payment_intent?.last_payment_error?.message
        || 'Stripe overage charge failed';
      return res.status(r.status).json({
        ok: false,
        error: errMsg,
        code: data?.error?.code || data?.payment_intent?.last_payment_error?.code || null,
        decline_code: data?.error?.decline_code || data?.payment_intent?.last_payment_error?.decline_code || null,
      });
    }
    if (data.status !== 'succeeded' && data.status !== 'requires_capture') {
      return res.status(402).json({
        ok: false,
        error: `Charge not completed (status=${data.status}). Customer's card likely needs re-authentication; collect overage another way.`,
        status: data.status,
      });
    }
    return res.status(200).json({
      ok: true,
      payment_intent: data.id,
      status: data.status,
      amount: data.amount,
      currency: data.currency,
    });
  } catch (e) {
    console.error('[stripe-charge-overage] failed:', e);
    return res.status(500).json({ ok: false, error: e?.message || 'Internal error' });
  }
}
