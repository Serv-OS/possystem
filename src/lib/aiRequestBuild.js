// src/lib/aiRequestBuild.js: the request every AI call to api/ sends, pure (v5.11.104).
// src/lib/aiRequest.js wires it to this session's token and venue; node --test drives this file
// with stand ins (aiEndpointAuth.test.js).

/**
 * Build the fetch init for a POST to an AI route.
 * @param {object} body  the JSON body (location_id is added unless the caller set one)
 * @param {object} reads { token: async () => string|null, location: async () => string|null }
 */
export async function buildAiRequest(body, { token: readToken, location: readLocation } = {}) {
  let token = null;
  if (readToken) { try { token = (await readToken()) || null; } catch { token = null; } }
  let location = body?.location_id ?? null;
  if (location == null && readLocation) {
    try { location = (await readLocation()) || null; } catch { location = null; }
  }
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  return {
    method: 'POST',
    headers,
    body: JSON.stringify({ ...(body || {}), location_id: location }),
  };
}
