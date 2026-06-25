// supabase/functions/_shared/uber.ts
//
// Uber Direct client shared by the uber-* edge functions: OAuth2 client_credentials
// token (cached), endpoint-abstracted quote/create/cancel/status, free postcode
// geocoding (postcodes.io — no Google spend), and webhook HMAC verification.
//
// Docs verified Jun 2026. NOTE: the docs expose two endpoint families — the classic
// `/customers/{customer_id}/delivery_quotes` + `/deliveries`, and the newer
// `/v1/eats/deliveries/estimates` + `/orders`. We default to the classic family and
// keep the paths in one place (UBER_PATHS) so the exact shape can be locked against
// the live Uber Direct dashboard in sandbox without touching callers.

const HOSTS = {
  sandbox: { auth: 'https://sandbox-login.uber.com/oauth/v2/token', api: 'https://sandbox-api.uber.com' },
  prod:    { auth: 'https://auth.uber.com/oauth/v2/token',          api: 'https://api.uber.com' },
};

export const UBER_SCOPE = 'eats.deliveries';

export const UBER_PATHS = {
  quote:  (cid: string) => `/v1/customers/${cid}/delivery_quotes`,
  create: (cid: string) => `/v1/customers/${cid}/deliveries`,
  get:    (cid: string, id: string) => `/v1/customers/${cid}/deliveries/${id}`,
  cancel: (cid: string, id: string) => `/v1/customers/${cid}/deliveries/${id}/cancel`,
};

export class UberError extends Error {
  status: number; body: unknown;
  constructor(status: number, body: unknown) {
    super(`Uber ${status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
    this.status = status; this.body = body;
  }
}

// ── OAuth token cache (per env+clientId; 30-day tokens, refreshed early) ──────
type Cached = { token: string; expMs: number };
const _tokens = new Map<string, Cached>();

export async function getAccessToken(env: 'sandbox' | 'prod', clientId: string, clientSecret: string): Promise<string> {
  const key = `${env}:${clientId}`;
  const hit = _tokens.get(key);
  if (hit && hit.expMs - Date.now() > 60_000) return hit.token;

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'client_credentials',
    scope: UBER_SCOPE,
  });
  const res = await fetch(HOSTS[env].auth, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) throw new UberError(res.status, j);
  const ttlMs = (Number(j.expires_in) || 2_592_000) * 1000;
  _tokens.set(key, { token: j.access_token, expMs: Date.now() + ttlMs });
  return j.access_token;
}

async function uberFetch(env: 'sandbox' | 'prod', token: string, method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${HOSTS[env].api}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const parsed = text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : null;
  if (!res.ok) throw new UberError(res.status, parsed);
  return parsed;
}

// ── Geocoding (free, UK; no key, no Google spend) ────────────────────────────
// postcodes.io returns lat/lng for a UK postcode. Postcode-level accuracy is fine
// for a delivery radius + fee bands. Returns null if the postcode can't be resolved.
export async function geocodePostcode(postcode: string): Promise<{ lat: number; lng: number } | null> {
  const pc = String(postcode || '').trim();
  if (!pc) return null;
  try {
    const res = await fetch(`https://api.postcodes.io/postcodes/${encodeURIComponent(pc)}`);
    if (!res.ok) return null;
    const j = await res.json();
    const r = j?.result;
    if (r && Number.isFinite(r.latitude) && Number.isFinite(r.longitude)) {
      return { lat: r.latitude, lng: r.longitude };
    }
  } catch { /* network/parse — fall through */ }
  return null;
}

const R_MILES = 3958.7613;
const toRad = (d: number) => (d * Math.PI) / 180;
export function haversineMiles(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number | null {
  if (!a || !b || a.lat == null || b.lat == null) return null;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R_MILES * Math.asin(Math.min(1, Math.sqrt(h)));
}

// ── Address formatting for Uber (structured + coords; both families tolerate this) ──
function addrString(a: any): string {
  if (!a) return '';
  return [a.line1, a.line2, a.city, a.postcode, a.country || 'GB'].filter(Boolean).join(', ');
}

// ── Quote ────────────────────────────────────────────────────────────────────
export async function getQuote(opts: {
  env: 'sandbox' | 'prod'; token: string; customerId: string;
  pickup: any; dropoff: any; // address objects, ideally with lat/lng
}): Promise<any> {
  const { env, token, customerId, pickup, dropoff } = opts;
  const body: Record<string, unknown> = {
    pickup_address: addrString(pickup),
    dropoff_address: addrString(dropoff),
  };
  if (pickup?.lat != null) { body.pickup_latitude = pickup.lat; body.pickup_longitude = pickup.lng; }
  if (dropoff?.lat != null) { body.dropoff_latitude = dropoff.lat; body.dropoff_longitude = dropoff.lng; }
  return uberFetch(env, token, 'POST', UBER_PATHS.quote(customerId), body);
}

// ── Create delivery (slice 4 dispatch; included for completeness) ─────────────
export async function createDelivery(opts: {
  env: 'sandbox' | 'prod'; token: string; customerId: string; manifest: Record<string, unknown>;
}): Promise<any> {
  return uberFetch(opts.env, opts.token, 'POST', UBER_PATHS.create(opts.customerId), opts.manifest);
}
export async function getDelivery(env: 'sandbox' | 'prod', token: string, customerId: string, id: string): Promise<any> {
  return uberFetch(env, token, 'GET', UBER_PATHS.get(customerId, id));
}
export async function cancelDelivery(env: 'sandbox' | 'prod', token: string, customerId: string, id: string): Promise<any> {
  return uberFetch(env, token, 'POST', UBER_PATHS.cancel(customerId, id), {});
}

// ── Webhook signature (x-uber-signature: HMAC-SHA256 hex over the raw body) ────
async function hmacHex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function ceq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
/** Verify x-uber-signature (or x-postmates-signature) over the EXACT raw bytes. */
export async function verifyUberSignature(rawBody: string, header: string | null, signingKey: string): Promise<boolean> {
  if (!header || !signingKey) return false;
  const expected = await hmacHex(signingKey, rawBody);
  return ceq(header.trim().toLowerCase(), expected);
}
