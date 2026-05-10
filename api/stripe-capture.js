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
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return res.status(500).json({ error: 'Stripe not configured. Set STRIPE_SECRET_KEY in Vercel env.' });

  try {
    const { paymentIntentId, stripeAccount, amountToCapture } = req.body || {};
    if (!paymentIntentId) return res.status(400).json({ error: 'Missing paymentIntentId' });
    if (!stripeAccount)   return res.status(400).json({ error: 'Missing stripeAccount (connected account id)' });
    if (amountToCapture != null && (typeof amountToCapture !== 'number' || amountToCapture <= 0)) {
      return res.status(400).json({ error: 'amountToCapture must be a positive integer (minor units)' });
    }

    const params = new URLSearchParams();
    if (amountToCapture != null) params.set('amount_to_capture', String(Math.round(amountToCapture)));

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
    });
  } catch (e) {
    console.error('[stripe-capture] failed:', e);
    return res.status(500).json({ error: e?.message || 'Internal error' });
  }
}
