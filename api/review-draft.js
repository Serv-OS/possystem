// api/review-draft.js — Vercel serverless: Claude drafts a review reply.
//
// Review Manager's AI assist. Given a piece of feedback + the venue voice, it
// drafts EITHER a public reply (for at/above-threshold reviews, card-origin or
// synced from a platform) OR a private recovery message (for under-threshold
// feedback). The output is always a DRAFT — a human approves/edits/regenerates
// in the Approval Queue before anything is posted or sent. Mirrors api/ai.js
// (same Anthropic key + version + model).

const GUARDRAILS = `You draft replies to customer reviews for a hospitality/retail venue. Rules:
- Write ONLY the reply text — no preamble, no "Here's a draft", no quotation marks, no markdown.
- Brand voice: warm, professional, specific. Reference concrete points from the customer's comment; never generic boilerplate.
- Never invent facts, offers, discounts, or commitments that aren't in the venue's settings/brand voice.
- Keep it concise: a public reply is 2–4 sentences; a private recovery message is 3–5 sentences.
- For a PUBLIC reply: thank them, acknowledge specifics, invite them back. Never expose any private complaint.
- For a PRIVATE recovery message: apologise sincerely, take ownership, offer a concrete make-good (e.g. invite back / put it right), and sign off from the manager. This is sent privately to the guest — it is NOT public.
- Match the requested tone if one is given.`;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'AI not configured' });

  const { feedback, venue, kind = 'public_reply', tone } = req.body || {};
  if (!feedback || typeof feedback.rating === 'undefined') return res.status(400).json({ error: 'feedback (with rating) required' });

  const isPrivate = kind === 'private_recovery';
  const venueName = venue?.name || 'the venue';
  const brandVoice = venue?.brand_voice ? `\nVenue brand voice / house style: ${venue.brand_voice}` : '';
  const platform = feedback.source_platform ? ` (left on ${feedback.source_platform})` : '';
  const name = feedback.customer_name ? feedback.customer_name : 'the customer';

  const userMsg = `Venue: ${venueName}${brandVoice}
Draft a ${isPrivate ? 'PRIVATE recovery message (sent privately to the guest, NOT public)' : 'PUBLIC reply to be posted on the review platform'}.
${tone ? `Tone: ${tone}.` : ''}
Customer: ${name}
Star rating: ${feedback.rating}/5${platform}
Their feedback: "${(feedback.comment || feedback.private_detail || '').toString().slice(0, 2000) || '(no written comment)'}"`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 500,
        system: GUARDRAILS,
        messages: [{ role: 'user', content: userMsg }],
      }),
    });
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      return res.status(response.status).json({ error: err.error?.message || 'Anthropic API error' });
    }
    const data = await response.json();
    const draft = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
    return res.status(200).json({ draft, kind, tone: tone || null });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
