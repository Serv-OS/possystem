/**
 * Restaurant OS — Stripe capture endpoint for QR tabs (commit 3b)
 *
 * POST { paymentIntentId, stripeAccount, amountToCapture }
 *   → 200 { captured: true, amount, payment_intent }
 *
 * Captures a previously-pre-authorised PaymentIntent on a connected account.
 * Used by the operator's POS to close an open QR tab — the customer's card
 * was pre-authorised at tab open via captureMethod='manual'; this endpoint
 * captures the actual final amount (≤ pre-auth) when the tab closes.
 *
 * If amountToCapture > pre-authorised amount, Stripe will REJECT — the
 * operator must instead use /api/stripe-cancel-and-recharge (next commit)
 * which voids the auth and creates a fresh charge for the actual total.
 *
 * Required Vercel env: STRIPE_SECRET_KEY (the platform secret key, not the
 * connected account's key — the Stripe-Account header tells Stripe which
 * account to act on behalf of).
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  // v5.5.159: try common Stripe env var names so a venue using a non-default
  // name (e.g. STRIPE_API_KEY, STRIPE_TEST_KEY) still works.
  const key = process.env.STRIPE_SECRET_KEY
           || process.env.STRIPE_API_KEY
           || process.env.STRIPE_TEST_KEY
           || process.env.STRIPE_LIVE_KEY;
  if (!key) {
    // Surface ACTUAL Vercel env var names that look Stripe-related, so
    // the operator can see exactly what IS set vs what we're looking for
    // — saves the "I added it but it's not working" guessing game.
    const stripeEnvs = Object.keys(process.env).filter(k => /stripe/i.test(k));
    return res.status(500).json({
      error: 'Stripe not configured on Vercel. Add env var STRIPE_SECRET_KEY (your sk_test_… or sk_live_… key) under Vercel Dashboard → Settings → Environment Variables → Production AND Preview, then REDEPLOY (env vars only apply to new deploys).',
      vercelStripeEnvVarsFound: stripeEnvs.length ? stripeEnvs : 'none — confirm spelling and that you\'re editing the right Vercel project',
      hint: 'NB: Supabase Edge Function secrets and Vercel env vars are separate stores. Your existing in-store Stripe uses the Supabase store; this capture endpoint runs on Vercel and needs the key there too.',
    });
  }

  try {
    const { paymentIntentId, stripeAccount, amountToCapture } = req.body || {};
    if (!paymentIntentId) return res.status(400).json({ error: 'Missing paymentIntentId' });
    if (!stripeAccount)   return res.status(400).json({ error: 'Missing stripeAccount (connected account id)' });
    if (amountToCapture != null && (typeof amountToCapture !== 'number' || amountToCapture <= 0)) {
      return res.status(400).json({ error: 'amountToCapture must be a positive integer (minor units)' });
    }

    // v5.5.160: clamp the capture amount to the actual `amount_capturable`
    // on the PI before calling capture. Stripe REJECTS amount_to_capture >
    // authorized — and we'd rather capture what we can than fail outright.
    // The caller (operator force-close / customer self-close) then charges
    // the overage off_session via /api/stripe-charge-overage.
    let capturable = null;
    try {
      const piRes = await fetch(`https://api.stripe.com/v1/payment_intents/${encodeURIComponent(paymentIntentId)}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${key}`, 'Stripe-Account': stripeAccount },
      });
      const piData = await piRes.json();
      if (piRes.ok) {
        // amount_capturable = how much we can still capture (auth - already-captured)
        capturable = Number(piData.amount_capturable ?? piData.amount ?? 0);
      }
    } catch (e) { /* fall through — capture will surface the real error */ }

    let effectiveCapture = amountToCapture;
    let cappedFromOverage = false;
    if (capturable != null && amountToCapture != null && Math.round(amountToCapture) > capturable) {
      effectiveCapture = capturable;
      cappedFromOverage = true;
    }

    const params = new URLSearchParams();
    if (effectiveCapture != null) params.set('amount_to_capture', String(Math.round(effectiveCapture)));

    const r = await fetch(`https://api.stripe.com/v1/payment_intents/${encodeURIComponent(paymentIntentId)}/capture`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Stripe-Account': stripeAccount, // act on behalf of the connected account
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });
    const data = await r.json();
    if (!r.ok) {
      return res.status(r.status).json({
        error: data?.error?.message || 'Stripe capture failed',
        code: data?.error?.code || null,
        type: data?.error?.type || null,
      });
    }
    return res.status(200).json({
      captured: true,
      amount: data.amount,
      amount_received: data.amount_received,
      currency: data.currency,
      status: data.status,
      payment_intent: data.id,
      // v5.5.160: tells the caller how much of the requested total is still
      // outstanding so they can charge it as overage on the saved card.
      requested_amount: amountToCapture != null ? Math.round(amountToCapture) : null,
      captured_amount: data.amount,
      shortfall: cappedFromOverage ? (Math.round(amountToCapture) - data.amount) : 0,
      capped_from_overage: cappedFromOverage,
    });
  } catch (e) {
    console.error('[stripe-capture] failed:', e);
    return res.status(500).json({ error: e?.message || 'Internal error' });
  }
}
