// src/surfaces/website/formsOnPage.js
//
// 5.12.36 Marketing forms: which forms a website page shows (its Form blocks, top level or inside
// a Row column) and the website's own Ops venue ids, the fence marketing_form_public checks a
// form against. Plain JS: the server (api/_lib/website/formsForPage.js) and the browser
// (WebsiteSurface) read the same rules.

import { walkBlocks } from './blocks/schema.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MAX_FORMS_PER_PAGE = 6;

/** The form ids a page's Form blocks name, unique, at most 6. */
export function formIdsOf(page) {
  const ids = [];
  for (const b of walkBlocks(page && page.layout)) {
    const id = b.type === 'Form' && b.props ? String(b.props.form_id || '').toLowerCase() : '';
    if (UUID_RE.test(id) && !ids.includes(id)) ids.push(id);
    if (ids.length >= MAX_FORMS_PER_PAGE) break;
  }
  return ids;
}

/** The website's Ops venue ids (the fence the public read checks the form against). */
export function siteOpsLocationIds(snapshot) {
  const locs = snapshot && Array.isArray(snapshot.locations) ? snapshot.locations : [];
  return [...new Set(locs.map((l) => l && l.ops_location_id).filter((x) => UUID_RE.test(String(x || ''))))];
}
