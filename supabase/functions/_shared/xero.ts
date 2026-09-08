// supabase/functions/_shared/xero.ts
//
// Xero OAuth 2.0 + Accounting API helpers for the multi-org integration: each venue
// (location) authorises its OWN Xero organisation, so we hold one token set per location
// and refresh on demand. Xero ROTATES the refresh token on every refresh — callers MUST
// persist the new refresh_token each time (getValidAccessToken does this).

// NB: Xero DEPRECATED the broad `accounting.transactions` scope on 2 Mar 2026 — apps
// created after that date get `invalid_scope` if they request it. Use the fine-grained
// replacements instead (accounting.invoices covers both sales ACCREC + supplier ACCPAY
// bills; banktransactions/manualjournals/payments cover the rest).
export const XERO_SCOPES = [
  'openid', 'profile', 'email', 'offline_access',
  'accounting.invoices', 'accounting.banktransactions', 'accounting.manualjournals', 'accounting.payments',
  'accounting.contacts', 'accounting.settings', 'accounting.attachments',
].join(' ');

const AUTHORIZE = 'https://login.xero.com/identity/connect/authorize';
const TOKEN_URL = 'https://identity.xero.com/connect/token';
const CONNECTIONS = 'https://api.xero.com/connections';
export const XERO_API = 'https://api.xero.com/api.xro/2.0';

const basic = (id: string, secret: string) => 'Basic ' + btoa(`${id}:${secret}`);

export function authorizeUrl(clientId: string, redirectUri: string, state: string): string {
  // Build the query manually: URLSearchParams encodes spaces as '+', but Xero's authorize
  // endpoint does NOT treat '+' as a space in the scope param and rejects it with
  // "invalid_scope". encodeURIComponent uses %20, which Xero accepts.
  const params: [string, string][] = [
    ['response_type', 'code'],
    ['client_id', clientId],
    ['redirect_uri', redirectUri],
    ['scope', XERO_SCOPES],
    ['state', state],
  ];
  return `${AUTHORIZE}?${params.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')}`;
}

export async function exchangeCode(clientId: string, clientSecret: string, redirectUri: string, code: string): Promise<any> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { Authorization: basic(clientId, clientSecret), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }).toString(),
  });
  if (!res.ok) throw new Error(`Xero token exchange failed: ${res.status} ${await res.text()}`);
  return res.json();
}

export async function refreshTokens(clientId: string, clientSecret: string, refreshToken: string): Promise<any> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { Authorization: basic(clientId, clientSecret), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }).toString(),
  });
  if (!res.ok) throw new Error(`Xero token refresh failed: ${res.status} ${await res.text()}`);
  return res.json();
}

export async function getConnections(accessToken: string): Promise<any[]> {
  const res = await fetch(CONNECTIONS, { headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Xero connections failed: ${res.status} ${await res.text()}`);
  return res.json();
}

/**
 * Return a valid access token + tenantId for a location, refreshing (and persisting the
 * rotated refresh token) if the stored access token is within 2 minutes of expiry.
 * `sb` is a service-role Supabase client. Throws if the venue isn't connected.
 */
export async function getValidAccessToken(sb: any, locationId: string, clientId: string, clientSecret: string): Promise<{ accessToken: string; tenantId: string; tenantName: string | null }> {
  const { data: c } = await sb.from('xero_connections').select('*').eq('location_id', locationId).maybeSingle();
  if (!c) throw new Error('Xero not connected for this location');
  const soon = Date.now() + 2 * 60 * 1000;
  if (new Date(c.expires_at).getTime() > soon) {
    return { accessToken: c.access_token, tenantId: c.tenant_id, tenantName: c.tenant_name };
  }
  const t = await refreshTokens(clientId, clientSecret, c.refresh_token);
  await sb.from('xero_connections').update({
    access_token: t.access_token,
    refresh_token: t.refresh_token,                 // rotated — must save the new one
    expires_at: new Date(Date.now() + (t.expires_in || 1800) * 1000).toISOString(),
    scopes: t.scope || c.scopes,
    updated_at: new Date().toISOString(),
  }).eq('location_id', locationId);
  return { accessToken: t.access_token, tenantId: c.tenant_id, tenantName: c.tenant_name };
}

/** Authenticated Accounting API call (adds Bearer + xero-tenant-id + JSON headers). */
export async function xeroApi(accessToken: string, tenantId: string, path: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(`${XERO_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'xero-tenant-id': tenantId,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Xero API ${path} failed: ${res.status} ${text}`);
  try { return JSON.parse(text); } catch { return text; }
}

// ── Signed state — stateless, tamper-proof binding of the connect flow to a location ──
const enc = new TextEncoder();
function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromB64url(s: string): string {
  s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; return atob(s);
}
async function hmac(secret: string, msg: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(msg))));
}
export async function signState(secret: string, payload: Record<string, unknown>): Promise<string> {
  const body = b64url(enc.encode(JSON.stringify(payload)));
  return `${body}.${await hmac(secret, body)}`;
}
export async function verifyState(secret: string, state: string): Promise<Record<string, any> | null> {
  const [body, sig] = (state || '').split('.');
  if (!body || !sig) return null;
  if (await hmac(secret, body) !== sig) return null;
  try { return JSON.parse(fromB64url(body)); } catch { return null; }
}
