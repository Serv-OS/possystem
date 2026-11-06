// src/surfaces/website/reviewsOnPage.js (6 Nov 2026, 5.12.67)
//
// Peter: "Reviews on the website". Which reviews a page needs from the Review Manager, decided the
// same way on the server (api/_lib/website/reviewsForPage.js) and in the browser (WebsiteSurface).
// The read is review_feedback_public on Ops (anon): public reviews only, first name and last
// initial, never a contact detail. Peter (6 Nov 2026): "website reviews should be just a website
// builder element we can drag on if we choose". So there is NO site switch: a page with a Reviews
// block reads reviews, a page without one never does.

import { walkBlocks } from './blocks/schema.js';

export const MAX_REVIEWS = 24;

/** The widest ask of the page's Reviews blocks: { min, count }, or null when the page has none. */
export function reviewsAskOf(page) {
  let min = 6, count = 0, found = false;
  for (const b of walkBlocks(page && page.layout)) {
    if (b.type !== 'Reviews') continue;
    found = true;
    const p = b.props || {};
    const m = Math.min(5, Math.max(1, Math.round(Number(p.min_stars) || 4)));
    const c = Math.min(MAX_REVIEWS, Math.max(1, Math.round(Number(p.count) || 6)));
    if (m < min) min = m;
    if (c > count) count = c;
  }
  return found ? { min: Math.min(min, 5), count } : null;
}

/** The rows as the blocks read them: { rating, text, author, date, source }. */
export function reviewRowsForBlocks(rows) {
  return (Array.isArray(rows) ? rows : [])
    .filter((r) => r && Number(r.rating) >= 1 && String(r.comment || r.text || '').trim())
    .map((r) => ({ rating: Number(r.rating), text: String(r.comment || r.text || ''), author: String(r.author || 'Guest'), date: r.created_at || r.date || null, source: r.source || 'card' }))
    .slice(0, MAX_REVIEWS);
}
