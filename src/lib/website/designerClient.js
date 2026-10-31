// src/lib/website/designerClient.js: the browser's calls to /api/website-designer (v5.12.0).
//
// The same shape as every other AI call (src/lib/aiRequest.js): Authorization: Bearer <this Back
// Office session's token>, JSON body, and the server decides who may ask (api/website-designer.js:
// a signed in person whose companies own the site). The building is pure so node --test can drive
// it with a stand in token reader; the exports at the bottom wire the real session.

import { ensureAuthToken } from '../supabase';

export const DESIGNER_ENDPOINT = '/api/website-designer';

/** The fetch init for a designer POST: {site_id, message, mode, page_id?, layout?}. */
export async function buildDesignerRequest(body, { token: readToken } = {}) {
  let token = null;
  if (readToken) { try { token = (await readToken()) || null; } catch { token = null; } }
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  return { method: 'POST', headers, body: JSON.stringify(body || {}) };
}

/** The fetch init for the facts GET (no Claude call on the server). */
export async function buildFactsRequest({ token: readToken } = {}) {
  let token = null;
  if (readToken) { try { token = (await readToken()) || null; } catch { token = null; } }
  const headers = { accept: 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  return { method: 'GET', headers };
}

/** Read a JSON answer, with the server's plain reason on failure. Never throws. */
export async function readDesignerResponse(res) {
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  if (!res.ok) return { error: body?.error || `The designer could not answer (${res.status}).`, status: res.status };
  return { ...(body || {}), error: null, status: res.status };
}

/**
 * Ask the designer. Returns {reply, applied, pages_changed, errors, error}; `error` is set when the
 * request itself failed (not signed in, not allowed, server down).
 */
export async function designerRequest(body, { fetchImpl, token = ensureAuthToken } = {}) {
  const f = fetchImpl || fetch;
  try {
    const res = await f(DESIGNER_ENDPOINT, await buildDesignerRequest(body, { token }));
    return await readDesignerResponse(res);
  } catch (e) {
    return { error: e?.message || 'The designer could not be reached.', status: 0 };
  }
}

/** The facts the designer reads and the stored chat, without spending anything. */
export async function designerFacts(siteId, { fetchImpl, token = ensureAuthToken } = {}) {
  const f = fetchImpl || fetch;
  try {
    const res = await f(`${DESIGNER_ENDPOINT}?site_id=${encodeURIComponent(siteId || '')}`, await buildFactsRequest({ token }));
    return await readDesignerResponse(res);
  } catch (e) {
    return { error: e?.message || 'The designer could not be reached.', status: 0, facts: [], messages: [] };
  }
}
