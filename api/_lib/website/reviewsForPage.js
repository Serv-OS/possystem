// api/_lib/website/reviewsForPage.js
//
// 5.12.67 Reviews on the server rendered site: the public reviews a page's Reviews blocks show, read
// from the Ops DB through review_feedback_public with the anon key, fenced to the website's own
// venues. Only when the page carries a Reviews block (no site switch). Never throws: a failed or slow read leaves the
// block empty (it paints nothing) and the rest of the page renders.

import { reviewsAskOf, reviewRowsForBlocks } from '../../../src/surfaces/website/reviewsOnPage.js';
import { siteOpsLocationIds } from '../../../src/surfaces/website/formsOnPage.js';

function withTimeout(p, ms) {
  let t;
  const late = new Promise((resolve) => { t = setTimeout(() => resolve({ data: null, error: { message: 'timeout' } }), ms); });
  return Promise.race([Promise.resolve(p), late]).finally(() => clearTimeout(t));
}

/** The reviews for the page, newest first; [] when off, none asked for, or the read failed. */
export async function reviewsForPage(opsClient, page, snapshot, { timeoutMs = 2500 } = {}) {
  if (!opsClient) return [];
  const ask = reviewsAskOf(page);
  if (!ask) return [];
  const venues = siteOpsLocationIds(snapshot);
  if (!venues.length) return [];
  try {
    const { data, error } = await withTimeout(opsClient.rpc('review_feedback_public', { p_location_ids: venues, p_min: ask.min, p_limit: ask.count }), timeoutMs);
    if (error || !Array.isArray(data)) return [];
    return reviewRowsForBlocks(data);
  } catch { return []; }
}
