/* global process */
/**
 * api/sop-text.js (5.12.62, 4 Nov 2026): the words of an SOP, read out of a PDF or a photo.
 *
 * POST { image: <base64, no data: prefix>, media_type: 'application/pdf'|'image/jpeg'|'image/png'|'image/webp', location_id }
 *  -> { text }
 *
 * The browser reads plain text files itself (lib/ops/sopText.js); only a PDF or a photo comes here.
 * The model transcribes the document as plain text, nothing added, so the assistant later answers
 * staff in the SOP's own words. Who may call it: a Back Office login of the venue or one of its
 * paired Operations tablets (requireVenueUser, the same door as the invoice scan).
 */

import { requireVenueUser } from './_userAuth.js';

const SYSTEM = `You transcribe a restaurant's standard operating procedure (SOP) document into plain text.
Write out every word of the document in reading order. Keep headings, numbered steps, bullet points and
tables (as simple lines). Do not summarise, do not add commentary, do not leave anything out. If part of
the page is unreadable write [unreadable] in its place. Output the text only.`;

const MEDIA = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/gif']);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const who = await requireVenueUser(req, { locationId: req.body?.location_id ?? null });
  if (!who.ok) return res.status(who.status).json({ error: who.error });
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'SOP reading not configured (no API key)' });

  const { image, media_type = 'application/pdf' } = req.body || {};
  if (!image || typeof image !== 'string') return res.status(400).json({ error: 'image (base64) required' });
  if (image.length > 8_500_000) return res.status(413).json({ error: 'File too large (max 6 MB)' });
  if (!MEDIA.has(media_type)) return res.status(400).json({ error: 'Send a PDF or a photo (JPG, PNG, WEBP)' });

  const block = media_type === 'application/pdf'
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: image } }
    : { type: 'image', source: { type: 'base64', media_type, data: image } };

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 16000,
        system: SYSTEM,
        messages: [{ role: 'user', content: [block, { type: 'text', text: 'Transcribe this SOP document as plain text.' }] }],
      }),
    });
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      return res.status(response.status).json({ error: err.error?.message || 'Could not read the file' });
    }
    const data = await response.json();
    const text = (data.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
    if (!text) return res.status(422).json({ error: 'No words could be read out of that file' });
    return res.status(200).json({ text });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
