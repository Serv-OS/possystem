/**
 * api/_userAuth.js: who is asking, for an api/ route that acts for one venue (v5.11.82, multi site
 * stock Drop 0, plan 7.7 and 9.6). The first api/ route to check a user's own sign in (the cron
 * routes check a shared secret), so the helper is small and plain: two HTTP calls with the PUBLIC
 * key and the caller's own token, the same calls the browser makes. This file holds no secret and
 * never sees the service key. Files starting with _ are not routes on Vercel.
 *
 *   1. The token is proven by Supabase Auth (GET /auth/v1/user with the public key). No token, or a
 *      token Auth does not accept: 401.
 *   2. A signed in (not anonymous) user must reach the venue named in the body: the database's
 *      stock_reach_locations() (20261021a: user_accessible_locations() plus Stock control 'all' in
 *      the login's own company), asked with the user's own token, so the database answers; before
 *      20261021a that function is missing and user_accessible_locations() answers instead. A venue
 *      outside the answer: 403.
 *   3. An anonymous session is refused (401) unless it is a Manager or Ops phone paired to that
 *      venue (ops_can_write(venue) with the session's own token: an active ops_devices row for this
 *      device at this venue). The Manager app scans a delivery note on the Kitchen tab from such a
 *      phone; a till, a kiosk, an online or QR customer session is refused.
 *
 * v5.11.104: the AI routes (api/ai.js, api/ai/menu-import.js) use the same helper through
 * requireUser(), which takes three choices the scan route does not need: a venue may be optional
 * (a signed in user is checked on their own, and the venue only when the body names one), the
 * device arm may be 'pos' (a till, kiosk or Ops phone BOUND to that venue: the database's
 * pos_accessible_location_keys(), the device arm of pos_can_access) or 'none' (a signed in person
 * only), and the sign in message names the feature. requireVenueUser() is unchanged for the scan.
 *
 * Pure apart from fetch, which the caller may pass in (node --test drives it with a stand in:
 * src/lib/stock/invoiceScanAuth.test.js, src/lib/aiEndpointAuth.test.js).
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const AUTH_TIMEOUT_MS = 6000;

/** The bearer token of a Node request ('' when there is none). */
export function bearerToken(req) {
  const h = req?.headers?.authorization ?? req?.headers?.Authorization ?? '';
  const m = /^Bearer\s+(.+)$/i.exec(String(h).trim());
  return m ? m[1].trim() : '';
}

/** The Ops project's address and public key for this deployment (the same values the web app is built with). */
export function supabaseEnv(env = globalThis.process?.env || {}) {
  const url = String(env.SUPABASE_URL || env.VITE_SUPABASE_URL || '').replace(/\/$/, '');
  const anon = String(env.SUPABASE_ANON_KEY || env.VITE_SUPABASE_ANON_KEY || '');
  return { url, anon };
}

// The function is missing (PostgREST PGRST202, Postgres 42883, or its words).
export function isMissingFunction(status, body) {
  const code = String(body?.code || '');
  const msg = String(body?.message || '');
  return code === 'PGRST202' || code === '42883' || (status === 404 && /function|schema cache/i.test(msg));
}

async function getJson(fetchImpl, url, init) {
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const t = ctl ? setTimeout(() => ctl.abort(), AUTH_TIMEOUT_MS) : null;
  try {
    const res = await fetchImpl(url, { ...init, ...(ctl ? { signal: ctl.signal } : {}) });
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    return { status: res.status, ok: res.ok, body };
  } finally {
    if (t) clearTimeout(t);
  }
}

// A set returning function's rows as plain strings (PostgREST answers ["a", "b"] for setof text; an
// object row is read by its first value).
export function idList(body) {
  if (!Array.isArray(body)) return [];
  return body.map((r) => (r && typeof r === 'object' ? Object.values(r)[0] : r)).filter((x) => x != null).map(String);
}

const SIGN_IN_SCAN = 'Sign in to Back Office to scan an invoice.';
const headersFor = (anon, token) => ({ apikey: anon, authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' });

/**
 * Who is asking, and may they act for this venue?
 *   locationId     the venue named in the body (null when the body names none)
 *   venueRequired  true: a missing or malformed venue is a 400 (the scan route); false: a signed in
 *                  user with no venue passes on their sign in alone (the AI routes)
 *   device         which anonymous sessions may pass, and only for the venue named:
 *                  'ops'  a Manager or Ops phone paired to it (ops_can_write)
 *                  'pos'  a till, kiosk or Ops phone bound to it (pos_accessible_location_keys)
 *                  'none' no anonymous session at all
 *   signInMessage  the 401 text
 * Returns { ok: true, user, via: 'reach' | 'user' | 'device' } or { ok: false, status, error }.
 */
export async function requireUser(req, { locationId = null, venueRequired = true, device = 'ops', signInMessage = SIGN_IN_SCAN, env, fetchImpl } = {}) {
  const f = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  const { url, anon } = supabaseEnv(env);
  if (!url || !anon || !f) return { ok: false, status: 500, error: 'This server cannot check who is signed in (the Supabase address or public key is not set).' };
  const token = bearerToken(req);
  if (!token) return { ok: false, status: 401, error: signInMessage };
  let who;
  try { who = await getJson(f, `${url}/auth/v1/user`, { method: 'GET', headers: headersFor(anon, token) }); }
  catch { return { ok: false, status: 503, error: 'Could not check who is signed in. Try again.' }; }
  const user = who.ok ? who.body : null;
  if (!user || !user.id) return { ok: false, status: 401, error: signInMessage };
  const loc = locationId == null || locationId === '' ? '' : String(locationId);
  if (venueRequired && !UUID_RE.test(loc)) return { ok: false, status: 400, error: 'location_id required' };
  if (loc && !UUID_RE.test(loc)) return { ok: false, status: 400, error: 'location_id must be a venue id' };

  if (user.is_anonymous === true) {
    // a device bound to this venue, and nothing else; a device with no venue named is nothing
    if (device === 'none' || !loc) return { ok: false, status: 401, error: signInMessage };
    try {
      if (device === 'pos') {
        const keys = await getJson(f, `${url}/rest/v1/rpc/pos_accessible_location_keys`, { method: 'POST', headers: headersFor(anon, token), body: '{}' });
        if (keys.ok && idList(keys.body).includes(loc)) return { ok: true, user, via: 'device' };
      } else {
        const dev = await getJson(f, `${url}/rest/v1/rpc/ops_can_write`, { method: 'POST', headers: headersFor(anon, token), body: JSON.stringify({ p_location_id: loc }) });
        if (dev.ok && dev.body === true) return { ok: true, user, via: 'device' };
      }
    } catch { return { ok: false, status: 503, error: 'Could not check this device. Try again.' }; }
    return { ok: false, status: 401, error: signInMessage };
  }

  if (!loc) return { ok: true, user, via: 'user' };
  let reach;
  try {
    reach = await getJson(f, `${url}/rest/v1/rpc/stock_reach_locations`, { method: 'POST', headers: headersFor(anon, token), body: '{}' });
    if (!reach.ok && isMissingFunction(reach.status, reach.body)) {
      reach = await getJson(f, `${url}/rest/v1/rpc/user_accessible_locations`, { method: 'POST', headers: headersFor(anon, token), body: '{}' });
    }
  } catch { return { ok: false, status: 503, error: 'Could not check which venues this login reaches. Try again.' }; }
  if (!reach.ok) return { ok: false, status: 503, error: 'Could not check which venues this login reaches. Try again.' };
  if (!idList(reach.body).includes(loc)) return { ok: false, status: 403, error: 'Not allowed: this login does not reach that venue.' };
  return { ok: true, user, via: 'reach' };
}

/**
 * May the bearer of this request act for this venue? The scan route's check, unchanged: a venue is
 * required, and the only anonymous session that passes is a Manager or Ops phone paired to it.
 * Returns { ok: true, user, via: 'reach' | 'device' } or { ok: false, status, error }.
 */
export async function requireVenueUser(req, { locationId = null, env, fetchImpl } = {}) {
  return requireUser(req, { locationId, venueRequired: true, device: 'ops', signInMessage: SIGN_IN_SCAN, env, fetchImpl });
}
