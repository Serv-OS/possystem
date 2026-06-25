// supabase/functions/_shared/hubrise.ts
//
// HubRise API client + OAuth + HMAC verification + money helpers, shared by all
// hubrise-* edge functions. Pure fetch against https://api.hubrise.com/v1 with the
// X-Access-Token header; OAuth token exchange against manager.hubrise.com.
//
// Docs: https://www.hubrise.com/developers/api/ (authentication, catalogs, orders,
// callbacks, general-concepts). All money values are strings "<amount> <CCY>".

export const HUBRISE_API = 'https://api.hubrise.com/v1';
export const HUBRISE_MANAGER = 'https://manager.hubrise.com/oauth2/v1';

// Scope we request. HubRise requires ONE right per resource (listing a resource twice —
// e.g. orders.read AND orders.write — is rejected: "Resource type 'orders' specified more
// than once"). `write` includes read, so orders.write covers receiving + updating orders,
// catalog.write covers menu + inventory. customer_list.WRITE (not .read) per HubRise's
// guidance — future-proofs the connection so we can write the Customer List later without a
// re-consent; write includes read, so it still covers reading the embedded order customer.
export const HUBRISE_SCOPE = 'location[orders.write,catalog.write,customer_list.write]';

export class HubRiseError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown) {
    super(`HubRise ${status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
    this.status = status;
    this.body = body;
  }
}

async function parse(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}

/** Authenticated API call with the connection's access token. Throws HubRiseError on non-2xx. */
export async function hr(
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<any> {
  const res = await fetch(`${HUBRISE_API}${path}`, {
    method,
    headers: {
      'X-Access-Token': token,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const parsed = await parse(res);
  if (!res.ok) throw new HubRiseError(res.status, parsed);
  return parsed;
}

// ── OAuth ──────────────────────────────────────────────────────────────────

export function authorizeUrl(clientId: string, redirectUri: string, scope: string, state: string, extra: Record<string, string> = {}): string {
  const p = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, scope, state, ...extra });
  return `${HUBRISE_MANAGER}/authorize?${p.toString()}`;
}

/** Exchange an OAuth authorization code for an access token + the bound resource ids. */
export async function exchangeCode(clientId: string, clientSecret: string, code: string): Promise<any> {
  const basic = btoa(`${clientId}:${clientSecret}`);
  const res = await fetch(`${HUBRISE_MANAGER}/token`, {
    method: 'POST',
    headers: { 'Authorization': `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code }).toString(),
  });
  const parsed = await parse(res);
  if (!res.ok) throw new HubRiseError(res.status, parsed);
  return parsed; // { access_token, account_id, location_id, catalog_id, customer_list_id, *_name }
}

export async function revokeToken(clientId: string, clientSecret: string, token: string): Promise<void> {
  const basic = btoa(`${clientId}:${clientSecret}`);
  await fetch(`${HUBRISE_MANAGER}/revoke`, {
    method: 'POST',
    headers: { 'Authorization': `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token }).toString(),
  }).catch(() => {});
}

// ── Connection discovery ─────────────────────────────────────────────────────

export const getAccount = (token: string) => hr(token, 'GET', '/account');
export const getLocation = (token: string) => hr(token, 'GET', '/location');
export const getLocations = (token: string) => hr(token, 'GET', '/locations/');

// ── Callbacks ────────────────────────────────────────────────────────────────

// HubRise has exactly ONE callback per connection (no id). Per HubRise's guidance we only ever
// POST /callback (set the single config) right after obtaining the token — there is no need to
// GET it. (No GET /callback / GET /callbacks helper on purpose.)
/** Register the connection's single callback. url=null makes it PASSIVE (event log to poll). */
export function createCallback(token: string, url: string | null, events: Record<string, string[]>) {
  return hr(token, 'POST', '/callback', { url, events });
}

// Passive event log (durable replay / backfill)
export const listEvents = (token: string) => hr(token, 'GET', '/callback/events');
export const getEvent = (token: string, id: string) => hr(token, 'GET', `/callback/events/${id}`);
export const ackEvent = (token: string, id: string) => hr(token, 'DELETE', `/callback/events/${id}`);

// ── Catalog + inventory ──────────────────────────────────────────────────────

export function createLocationCatalog(token: string, name: string, data: unknown) {
  return hr(token, 'POST', '/location/catalogs', { name, data });
}
/** Whole-document replace of a catalog. */
export function putCatalog(token: string, catalogId: string, name: string, data: unknown) {
  return hr(token, 'PUT', `/catalogs/${catalogId}`, { name, data });
}
export const getCatalog = (token: string, catalogId: string) => hr(token, 'GET', `/catalogs/${catalogId}`);

/** Upload a binary image to a catalog and return its image id (for product.image_ids). */
export async function uploadCatalogImage(token: string, catalogId: string, bytes: Uint8Array, contentType: string): Promise<string | null> {
  const res = await fetch(`${HUBRISE_API}/catalogs/${catalogId}/images`, {
    method: 'POST',
    headers: { 'X-Access-Token': token, 'Content-Type': contentType || 'image/jpeg' },
    body: bytes,
  });
  if (!res.ok) return null;
  const j = await res.json().catch(() => null);
  return j?.id || null;
}

/** Incremental inventory update for the connected location. entries: [{sku_ref|option_ref, stock, expires_at?}] */
export function patchInventory(token: string, catalogId: string, entries: unknown[]) {
  return hr(token, 'PATCH', `/catalogs/${catalogId}/location/inventory`, entries);
}
export function putInventory(token: string, catalogId: string, entries: unknown[]) {
  return hr(token, 'PUT', `/catalogs/${catalogId}/location/inventory`, entries);
}

// ── Orders ───────────────────────────────────────────────────────────────────

export function getOrder(token: string, hubriseLocationId: string, orderId: string) {
  return hr(token, 'GET', `/locations/${hubriseLocationId}/orders/${orderId}`);
}
export function patchOrder(token: string, hubriseLocationId: string, orderId: string, body: Record<string, unknown>) {
  return hr(token, 'PATCH', `/locations/${hubriseLocationId}/orders/${orderId}`, body);
}
export function listOrders(token: string, hubriseLocationId: string, params: Record<string, string> = {}) {
  const q = new URLSearchParams(params).toString();
  return hr(token, 'GET', `/locations/${hubriseLocationId}/orders${q ? `?${q}` : ''}`);
}

// ── HMAC callback verification ───────────────────────────────────────────────

async function hmacRaw(secret: string, body: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return new Uint8Array(sig);
}
const toHex = (u8: Uint8Array) => [...u8].map((b) => b.toString(16).padStart(2, '0')).join('');
const toB64 = (u8: Uint8Array) => btoa(String.fromCharCode(...u8));
function ceq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Verify the X-HubRise-Hmac-SHA256 header against HMAC-SHA256(rawBody, client_secret).
 * Compute over the EXACT raw bytes — never re-serialize the JSON first. Accepts either a
 * hex or base64 encoding of the digest (docs show hexdigest; we tolerate both to be safe).
 * Constant-time compare.
 */
export async function verifyHmac(rawBody: string, header: string | null, clientSecret: string): Promise<boolean> {
  if (!header || !clientSecret) return false;
  const raw = await hmacRaw(clientSecret, rawBody);
  const got = header.trim();
  return ceq(got.toLowerCase(), toHex(raw)) || ceq(got, toB64(raw));
}

// ── Money helpers ────────────────────────────────────────────────────────────

/** number (major units, e.g. 9.8) -> "9.80 GBP" */
export function toMoney(amount: number | string, currency: string): string {
  const n = typeof amount === 'string' ? parseFloat(amount) : amount;
  return `${(Number.isFinite(n) ? n : 0).toFixed(2)} ${currency}`;
}

/** "8.90 EUR" -> { amount: 8.9, currency: "EUR" } (tolerant of plain numbers) */
export function parseMoney(s: unknown): { amount: number; currency: string | null } {
  if (s == null) return { amount: 0, currency: null };
  const str = String(s).trim();
  const m = str.match(/^(-?\d+(?:\.\d+)?)\s*([A-Z]{3})?$/);
  if (!m) return { amount: parseFloat(str) || 0, currency: null };
  return { amount: parseFloat(m[1]) || 0, currency: m[2] || null };
}
