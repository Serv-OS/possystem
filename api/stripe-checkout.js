/**
 * Restaurant OS — Stripe Checkout session creator (online ordering)
 *
 * POST { ref, locationId, currency, items: [{name, qty, unitAmount}], returnUrl, cancelUrl, customerEmail }
 *  → 200 { url, sessionId }
 *
 * Uses Stripe REST directly (no SDK) — keeps the deploy footprint small.
 * Required Vercel env: STRIPE_SECRET_KEY.
 *
 * The client pre-writes the order_queue row with status='awaiting_payment'
 * BEFORE calling this endpoint, then redirects the customer to the returned
 * Stripe URL. After payment, Stripe redirects back to returnUrl with
 * ?session_id={CHECKOUT_SESSION_ID} — the customer surface verifies via
 * /api/stripe-verify and promotes status to 'received' so the kitchen
 * picks it up at sent_at.
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return res.status(500).json({ error: 'Stripe not configured. Set STRIPE_SECRET_KEY in Vercel env.' });

  try {
    const { ref, locationId, currency = 'gbp', items = [], returnUrl, cancelUrl, customerEmail } = req.body || {};
    if (!ref || !returnUrl || !cancelUrl) return res.status(400).json({ error: 'Missing ref / returnUrl / cancelUrl' });
    if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'No line items' });

    // Stripe accepts form-urlencoded. We flatten the line_items array using
    // their bracketed-key convention: line_items[0][price_data][...]=...
    const params = new URLSearchParams();
    params.set('mode', 'payment');
    // success_url MUST contain {CHECKOUT_SESSION_ID} so we can verify on return.
    const sep = returnUrl.includes('?') ? '&' : '?';
    params.set('success_url', `${returnUrl}${sep}paid=success&ref=${encodeURIComponent(ref)}&session_id={CHECKOUT_SESSION_ID}`);
    params.set('cancel_url',  `${cancelUrl}${cancelUrl.includes('?') ? '&' : '?'}paid=cancel&ref=${encodeURIComponent(ref)}`);
    if (customerEmail) params.set('customer_email', customerEmail);
    params.set('client_reference_id', ref);
    params.set('metadata[ref]', ref);
    if (locationId) params.set('metadata[location_id]', String(locationId));

    items.forEach((it, i) => {
      const unit = Math.round(Number(it.unitAmount) || 0); // pence
      const qty  = Math.max(1, Math.round(Number(it.qty) || 1));
      params.set(`line_items[${i}][quantity]`, String(qty));
      params.set(`line_items[${i}][price_data][currency]`, currency);
      params.set(`line_items[${i}][price_data][unit_amount]`, String(unit));
      params.set(`line_items[${i}][price_data][product_data][name]`, String(it.name || 'Item').slice(0, 250));
    });

    const r = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data?.error?.message || 'Stripe error', stripe: data?.error });
    return res.status(200).json({ url: data.url, sessionId: data.id });
  } catch (e) {
    console.error('[stripe-checkout] failed:', e);
    return res.status(500).json({ error: e?.message || 'Internal error' });
  }
}
