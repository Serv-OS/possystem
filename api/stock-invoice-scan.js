/**
 * Stock — supplier invoice / delivery-note OCR (Claude vision).
 * Keeps the Anthropic key server-side (same pattern as api/ai.js). Provider is
 * swappable: change only this file to use a different vision model.
 *
 * POST { image: <base64 (no data: prefix)>, media_type: 'image/jpeg'|'image/png'|'application/pdf' }
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

const SYSTEM = `You extract structured data from a supplier invoice or delivery note for a UK hospitality business.
Return ONLY a single JSON object, no prose, no code fences. Shape:
{
  "supplier_name": string|null,
  "invoice_number": string|null,
  "invoice_date": "YYYY-MM-DD"|null,
  "currency": "GBP"|string|null,
  "lines": [ { "code": string|null, "description": string, "qty": number, "unit": string, "unit_price": number, "line_total": number } ],
  "subtotal": number|null, "tax": number|null, "total": number|null,
  "confidence": number  // 0-1 your overall confidence
}
Rules: qty is the number of packs/units billed; unit is the pack/measure word as printed (e.g. "case","kg","each","ltr"); unit_price is the price per that unit (ex-VAT if shown separately); line_total is the line's net amount. Use numbers (not strings) for money/quantities. If a field is missing use null. Never invent lines. code is the supplier's product code or SKU printed on the line (for example SKU-022-HAR), null when none is printed; never invent one.`;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  // v5.11.82: the sign in check comes before anything else is read or spent.
  const who = await requireVenueUser(req, { locationId: req.body?.location_id ?? null });
  if (!who.ok) return res.status(who.status).json({ error: who.error });
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'Invoice scanning not configured (no API key)' });

  const { image, media_type = 'image/jpeg' } = req.body || {};
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
        system: SYSTEM,
        messages: [{
          role: 'user',
          content: [block, { type: 'text', text: 'Extract this invoice as JSON per the schema.' }],
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
