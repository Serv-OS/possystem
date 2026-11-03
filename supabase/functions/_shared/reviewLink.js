// supabase/functions/_shared/reviewLink.js: the link in a review ask text (5.12.44).
// Pure, no imports, so node --test can load it.
//
// Peter 3 Nov 2026: the text pointed at the old temporary address (possystem-liard.vercel.app).
// A review ask now links to the venue's own ServOS address, <slug>.serv-os.app/review, the same
// card the Back Office shows (src/lib/customerUrl.js). A slug that cannot be a subdomain (or is a
// word ServOS keeps for itself) falls back to app.serv-os.app with the venue in the query.

export const REVIEW_CARD_ROOT = 'serv-os.app';

// Mirrors the reserved words in src/lib/customerHost.js that can never be a venue subdomain.
const RESERVED = new Set(['www', 'app', 'bo', 'admin', 'api', 'staging', 'stage', 'dev', 'test', 'preview', 'wifi', 'sites']);

export function reviewCardLink(slug, root = REVIEW_CARD_ROOT) {
  const s = String(slug ?? '').trim().toLowerCase();
  if (!s) return null;
  const r = String(root || REVIEW_CARD_ROOT).trim().replace(/^https?:\/\//, '').replace(/\/+$/, '') || REVIEW_CARD_ROOT;
  if (/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(s) && !RESERVED.has(s)) return `https://${s}.${r}/review`;
  return `https://app.${r}/?loc=${encodeURIComponent(s)}&surface=review`;
}
