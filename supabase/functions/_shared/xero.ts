// supabase/functions/_shared/xero.ts
//
// Xero OAuth 2.0 + Accounting API helpers for the multi-org integration: each venue
// (location) authorises its OWN Xero organisation, so we hold one token set per location
// and refresh on demand. Xero ROTATES the refresh token on every refresh — callers MUST
// persist the new refresh_token each time (getValidAccessToken does this).

import { pickTokenDonor } from './xeroTokens.js';

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
 *
 * v5.9.11 REFRESH RACE: Xero rotates the refresh token on every refresh, so two calls that
 * refresh at once (the nightly post while someone opens the mapping screen) used to both
 * spend the same refresh token and then both write, last write wins. If the loser's token
 * set was the one kept, the next refresh failed and the venue was silently disconnected.
 * Now the new tokens are saved with a compare and set on the refresh token we started from:
 * exactly one refresh lands. A caller that loses (its save matches no row, or Xero refuses
 * a token another call has just spent) re-reads the row and uses the winner's token.
 * 30 Sep 2026: the compare and set matches every row with that refresh token on the tenant
 * (venues sharing one Xero sign in rotate together), and a venue whose own refresh fails takes
 * over a sibling's newer set (same tenant, same Xero user) through `depth`.
 */
export async function getValidAccessToken(sb: any, locationId: string, clientId: string, clientSecret: string, depth = 0): Promise<{ accessToken: string; tenantId: string; tenantName: string | null }> {
  const readRow = async (loc: string) => {
    const { data, error } = await sb.from('xero_connections').select('*').eq('location_id', loc).maybeSingle();
    if (error) throw new Error(`Could not read the Xero connection: ${error.message}`);
    if (!data) throw new Error('Xero not connected for this location');
    return data;
  };
  const read = () => readRow(locationId);
  const fresh = (c: any) => new Date(c.expires_at).getTime() > Date.now() + 2 * 60 * 1000;
  const out = (c: any, token = c.access_token) => ({ accessToken: token, tenantId: c.tenant_id, tenantName: c.tenant_name });

  const c = await read();
  if (fresh(c)) return out(c);

  let t: any;
  try {
    t = await refreshTokens(clientId, clientSecret, c.refresh_token);
  } catch (e) {
    // Another call may have refreshed with this same token a moment ago. Use its result.
    await new Promise((r) => setTimeout(r, 400));
    const again = await read();
    if (again.refresh_token !== c.refresh_token && fresh(again)) return out(again);
    // 30 Sep 2026: venues on the same Xero organisation, connected by the same Xero user, share
    // one sign in. A newer sign in at a sibling supersedes this set, so take the sibling's
    // newest set over (refreshing it there if it needs it) instead of calling this venue
    // disconnected. Only a sibling on the same tenant AND the same Xero user is ever used.
    if (depth === 0) {
      const { data: sibs } = await sb.from('xero_connections').select('location_id,tenant_id,access_token,refresh_token,updated_at').eq('tenant_id', again.tenant_id).neq('location_id', locationId);
      const donor = pickTokenDonor(sibs || [], again);
      if (donor) {
        const got = await getValidAccessToken(sb, donor.location_id, clientId, clientSecret, depth + 1);
        const d = await readRow(donor.location_id);
        await sb.from('xero_connections').update({
          access_token: d.access_token, refresh_token: d.refresh_token, expires_at: d.expires_at, scopes: d.scopes || again.scopes, updated_at: new Date().toISOString(),
        }).eq('location_id', locationId).eq('refresh_token', again.refresh_token);
        return { accessToken: got.accessToken, tenantId: again.tenant_id, tenantName: again.tenant_name };
      }
    }
    throw e;
  }
  // Every row holding the refresh token we started from rotates together (the venues sharing
  // this sign in), in one compare and set: exactly one refresh lands.
  const { data: saved, error } = await sb.from('xero_connections').update({
    access_token: t.access_token,
    refresh_token: t.refresh_token,                 // rotated — must save the new one
    expires_at: new Date(Date.now() + (t.expires_in || 1800) * 1000).toISOString(),
    scopes: t.scope || c.scopes,
    updated_at: new Date().toISOString(),
  }).eq('tenant_id', c.tenant_id).eq('refresh_token', c.refresh_token).select('location_id');
  if (error) throw new Error(`Could not save the refreshed Xero token: ${error.message}`);
  if (saved && saved.some((r: any) => r.location_id === locationId)) return out(c, t.access_token);
  // Lost the race: another call saved its rotated set first. Ours is still a valid access
  // token for now, but the stored row is the one every later call will refresh from.
  const winner = await read();
  return fresh(winner) ? out(winner) : out(c, t.access_token);
}

/**
 * Authenticated Accounting API call (adds Bearer + xero-tenant-id + JSON headers).
 * `idempotencyKey` sets Xero's Idempotency-Key header (PUT and POST): a repeat with the same
 * key returns the first answer instead of creating a second record.
 */
export async function xeroApi(accessToken: string, tenantId: string, path: string, init: RequestInit & { idempotencyKey?: string } = {}): Promise<any> {
  const { idempotencyKey, ...rest } = init;
  // 30 Sep 2026: Xero allows 60 calls a minute and 5 at once per organisation, and several
  // sites can share one. A 429 waits for Xero's Retry-After (up to 30 seconds, twice), then
  // stops with a plain message. The Idempotency-Key makes the repeat of a PUT safe.
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${XERO_API}${path}`, {
      ...rest,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'xero-tenant-id': tenantId,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey.slice(0, 128) } : {}),
        ...(rest.headers || {}),
      },
    });
    const text = await res.text();
    if (res.status === 429) {
      const after = Number(res.headers.get('Retry-After'));
      const wait = Number.isFinite(after) && after >= 0 ? after : 5;
      if (attempt < 2 && wait <= 30) { await new Promise((r) => setTimeout(r, wait * 1000 + 250)); continue; }
      throw Object.assign(new Error('Xero is busy (too many requests for this organisation in the last minute). Nothing more was sent; press again in a minute.'), { status: 429 });
    }
    if (!res.ok) throw Object.assign(new Error(`Xero API ${path} failed: ${res.status} ${text}`), { status: res.status });
    try { return JSON.parse(text); } catch { return text; }
  }
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
