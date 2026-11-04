/**
 * Stock — supplier invoice / delivery-note OCR (Claude vision).
 * Keeps the Anthropic key server-side (same pattern as api/ai.js). Provider is
 * swappable: change only this file to use a different vision model.
 *
 * POST { image: <base64 (no data: prefix)>, media_type: 'image/jpeg'|'image/png'|'application/pdf', currency?: 'GBP'|'USD'|'EUR' }
 * → { supplier_name, invoice_number, invoice_date, currency, lines:[{code, description, qty,
 *     unit, unit_price, line_total}], subtotal, tax, total, confidence }
 * v5.11.64: code is the supplier's product code as printed (null when none), so a line can be
 * matched by SKU before its name (purchasingRules.matchScannedLine).
 *
 * v5.11.82 (multi site stock Drop 0, plan 7.7 and 9.6): WHO MAY SCAN. Until now anyone on the
 * internet could post an image here and spend the vision key. Now the request must carry
 * `Authorization: Bearer <the session's access token>` and `location_id` in the body (the web app's
 * scanInvoice sends both): a signed in login that reaches that venue (stock_reach_locations(), else
 * user_accessible_locations(), asked with the login's own token), or a Manager or Ops phone paired
 * to that venue (the Manager app's Kitchen tab scans a delivery note). No token or any other
 * anonymous session: 401. A venue the login does not reach: 403. The check is api/_userAuth.js.
 */

import { requireVenueUser } from './_userAuth.js';
import { invoiceScanSystem, invoiceScanAsk } from '../src/lib/stock/invoiceScanPrompt.js';

// 5.12.57 (US basics batch 7): the text is the site's (src/lib/stock/invoiceScanPrompt.js). The body
// may carry currency (the site's: 'GBP' | 'USD' | 'EUR'); a US site is told the US, USD, sales tax
// and month first dates, so 03/11/2026 reads as 11 March. No currency: the UK text, as before.

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  // v5.11.82: the sign in check comes before anything else is read or spent.
  const who = await requireVenueUser(req, { locationId: req.body?.location_id ?? null });
  if (!who.ok) return res.status(who.status).json({ error: who.error });
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'Invoice scanning not configured (no API key)' });

  const { image, media_type = 'image/jpeg', currency = null } = req.body || {};
  const siteCurrency = typeof currency === 'string' && /^[A-Za-z]{3}$/.test(currency.trim()) ? currency.trim().toUpperCase() : null;
  if (!image || typeof image !== 'string') return res.status(400).json({ error: 'image (base64) required' });
  if (image.length > 8_000_000) return res.status(413).json({ error: 'Image too large (max ~6MB)' });

  const isPdf = media_type === 'application/pdf';
  const block = isPdf
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: image } }
    : { type: 'image', source: { type: 'base64', media_type, data: image } };

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 4096,
        system: invoiceScanSystem(siteCurrency),
        messages: [{
          role: 'user',
          content: [block, { type: 'text', text: invoiceScanAsk(siteCurrency) }],
        }],
      }),
    });
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      return res.status(response.status).json({ error: err.error?.message || 'Vision API error' });
    }
    const data = await response.json();
    const text = (data.content || []).filter(c => c.type === 'text').map(c => c.text).join('').trim();
    const jsonStr = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    let parsed;
    try { parsed = JSON.parse(jsonStr); }
    catch { return res.status(422).json({ error: 'Could not parse the invoice — try a clearer photo', raw: text.slice(0, 500) }); }
    return res.status(200).json(parsed);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
