/**
 * Restaurant OS — Stripe Checkout session verifier (online ordering)
 *
 * POST { sessionId } → 200 { paid: true, ref, amountTotal, currency } | { paid:false, status }
 *
 * Called by the customer surface after Stripe redirects back to
 * `?paid=success&ref=...&session_id=...`. We re-check Stripe directly
 * (never trust the URL params alone — anyone could spoof them) before
 * promoting the order from 'awaiting_payment' to 'received' so the
 * kitchen picks it up.
 *
 * The order_queue update itself happens client-side using the same anon
 * key the rest of the surface uses (RLS allows the update). Server-side
 * is responsible for telling the truth about whether Stripe actually
 * collected the money.
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return res.status(500).json({ error: 'Stripe not configured. Set STRIPE_SECRET_KEY in Vercel env.' });

  try {
    const { sessionId } = req.body || {};
    if (!sessionId) return res.status(400).json({ error: 'Missing sessionId' });

    const r = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    const s = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: s?.error?.message || 'Stripe error' });

    const paid = s.payment_status === 'paid';
    return res.status(200).json({
      paid,
      status: s.payment_status,
      ref: s.metadata?.ref || s.client_reference_id || null,
      amountTotal: s.amount_total,
      currency: s.currency,
      paymentIntent: s.payment_intent,
    });
  } catch (e) {
    console.error('[stripe-verify] failed:', e);
    return res.status(500).json({ error: e?.message || 'Internal error' });
  }
}
