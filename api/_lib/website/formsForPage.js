// api/_lib/website/formsForPage.js
//
// 5.12.36 Marketing forms on the server rendered site: which forms a page shows (its Form blocks,
// top level or inside a Row column) and their public definitions, read from the Ops DB through
// marketing_form_public with the anon key. The read names the website's own venues, so a form id
// from another company paints nothing. Never throws: a failed or slow read leaves the form out
// (the block paints nothing) and the rest of the page renders.

import { formIdsOf, siteOpsLocationIds } from '../../../src/surfaces/website/formsOnPage.js';

export { formIdsOf, siteOpsLocationIds };

function withTimeout(p, ms) {
  let t;
  const late = new Promise((resolve) => { t = setTimeout(() => resolve({ data: null, error: { message: 'timeout' } }), ms); });
  return Promise.race([Promise.resolve(p), late]).finally(() => clearTimeout(t));
}

/** { [form id]: public form } for the page; {} when there are none or the reads failed. */
export async function formsForPage(opsClient, page, snapshot, { timeoutMs = 2500 } = {}) {
  const ids = formIdsOf(page);
  if (!ids.length || !opsClient) return {};
  const venues = siteOpsLocationIds(snapshot);
  if (!venues.length) return {};
  const out = {};
  await Promise.all(ids.map(async (id) => {
    try {
      const { data, error } = await withTimeout(opsClient.rpc('marketing_form_public', { p_form_id: id, p_location_ids: venues }), timeoutMs);
      if (!error && data && data.id) out[id] = data;
    } catch { /* left out */ }
  }));
  return out;
}
