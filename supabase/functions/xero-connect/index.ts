// supabase/functions/xero-connect/index.ts
//
// Xero connection lifecycle for a venue (location):
//   POST { action }:
//     oauth_start  { locationId, returnUrl } -> { url }   (BO opens it; operator authorises at Xero)
//     status       { locationId }            -> non-secret connection status for the BO
//     disconnect   { locationId }            -> revoke at Xero + delete the stored connection
//   GET ?code&state  -> Xero's redirect target; verifies state, exchanges the code, reads
//                       the authorised organisation, stores tokens, redirects back to the BO.
//
// Tokens live only in xero_connections (service-role only) and are never returned to the
// browser. POST actions require a signed-in Ops user WITH access to the location, mirroring
// hubrise-connect / payments-onboard. Deploy with --no-verify-jwt (GET callback is public).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { authorizeUrl, exchangeCode, getConnections, signState, verifyState, XERO_SCOPES } from '../_shared/xero.ts';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const CLIENT_ID = Deno.env.get('XERO_CLIENT_ID') ?? '';
const CLIENT_SECRET = Deno.env.get('XERO_CLIENT_SECRET') ?? '';
const APP_BASE = Deno.env.get('XERO_APP_BASE') || 'https://dev.serv-os.app';
const STATE_SECRET = SERVICE_ROLE || 'xero-state';
const sb = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { autoRefreshToken: false, persistSession: false } });

const REDIRECT_URI = `${SUPABASE_URL}/functions/v1/xero-connect`;

async function requireAccess(req: Request, opsLocationId: string): Promise<{ ok: true; userId: string } | { ok: false; res: Response }> {
  const token = (req.headers.get('Authorization') || '').replace('Bearer ', '').trim();
  if (!token) return { ok: false, res: json({ error: 'Unauthorized' }, 401) };
  if (token === SERVICE_ROLE) return { ok: true, userId: 'service' };
  const { data: { user: caller } } = await sb.auth.getUser(token);
  if (!caller) return { ok: false, res: json({ error: 'Invalid token' }, 401) };
  const [{ data: ul }, { data: prof }] = await Promise.all([
    sb.from('user_locations').select('location_id').eq('user_id', caller.id).eq('location_id', opsLocationId).maybeSingle(),
    sb.from('user_profiles').select('role').eq('id', caller.id).maybeSingle(),
  ]);
  if (!ul && prof?.role !== 'super_admin') return { ok: false, res: json({ error: 'No access to this location' }, 403) };
  return { ok: true, userId: caller.id };
}

function publicStatus(c: any) {
  if (!c) return { connected: false, configured: !!CLIENT_ID };
  return {
    connected: true,
    configured: !!CLIENT_ID,
    tenant_name: c.tenant_name,
    tenant_id: c.tenant_id,
    connected_at: c.created_at,
    scopes: c.scopes,
    manager_url: 'https://go.xero.com',
  };
}

function redirect(url: string): Response {
  return new Response(null, { status: 302, headers: { ...cors, Location: url } });
}
function withParam(u: string, k: string, v: string): string {
  return u + (u.includes('?') ? '&' : '?') + `${k}=${encodeURIComponent(v)}`;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const url = new URL(req.url);

  // ── GET = Xero OAuth callback (browser redirect) ──────────────────────────────
  if (req.method === 'GET') {
    const err = url.searchParams.get('error');
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state') || '';
    const payload = await verifyState(STATE_SECRET, state);
    const ret = (payload?.ret && typeof payload.ret === 'string') ? payload.ret : APP_BASE;
    if (err) return redirect(withParam(ret, 'xero', 'error'));
    if (!code || !payload || !payload.loc) return redirect(withParam(ret, 'xero', 'invalid'));
    // Freshness: state must be < 10 minutes old.
    if (!payload.ts || (Date.now() - Number(payload.ts)) > 10 * 60 * 1000) return redirect(withParam(ret, 'xero', 'expired'));
    try {
      const t = await exchangeCode(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI, code);
      const conns = await getConnections(t.access_token);
      const org = conns.find((x: any) => x.tenantType === 'ORGANISATION') || conns[0];
      if (!org) return redirect(withParam(ret, 'xero', 'no_org'));
      await sb.from('xero_connections').upsert({
        location_id: payload.loc,
        tenant_id: org.tenantId,
        tenant_name: org.tenantName || null,
        access_token: t.access_token,
        refresh_token: t.refresh_token,
        expires_at: new Date(Date.now() + (t.expires_in || 1800) * 1000).toISOString(),
        scopes: t.scope || XERO_SCOPES,
        connected_by: payload.uid && payload.uid !== 'service' ? payload.uid : null,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'location_id' });
      return redirect(withParam(ret, 'xero', 'connected'));
    } catch (e) {
      console.error('[xero-connect] callback', (e as Error)?.message || e);
      return redirect(withParam(ret, 'xero', 'error'));
    }
  }

  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  let body: any = {};
  try { body = await req.json(); } catch { /* ignore */ }
  const action = body.action;
  const locationId = body.locationId;
  if (!locationId) return json({ error: 'locationId required' }, 400);

  const acc = await requireAccess(req, locationId);
  if (!acc.ok) return acc.res;

  if (action === 'oauth_start') {
    if (!CLIENT_ID || !CLIENT_SECRET) return json({ error: 'Xero is not configured yet (missing XERO_CLIENT_ID / XERO_CLIENT_SECRET).' }, 400);
    const returnUrl = (typeof body.returnUrl === 'string' && body.returnUrl.startsWith('http')) ? body.returnUrl : APP_BASE;
    const state = await signState(STATE_SECRET, { loc: locationId, ret: returnUrl, uid: acc.userId, ts: Date.now(), n: crypto.randomUUID() });
    return json({ url: authorizeUrl(CLIENT_ID, REDIRECT_URI, state) });
  }

  if (action === 'status') {
    const { data: c } = await sb.from('xero_connections').select('*').eq('location_id', locationId).maybeSingle();
    return json(publicStatus(c));
  }

  if (action === 'disconnect') {
    const { data: c } = await sb.from('xero_connections').select('*').eq('location_id', locationId).maybeSingle();
    if (c) {
      // Best-effort revoke at Xero (delete the connection); ignore failures.
      try {
        const conns = await getConnections(c.access_token);
        const match = conns.find((x: any) => x.tenantId === c.tenant_id);
        if (match?.id) await fetch(`https://api.xero.com/connections/${match.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${c.access_token}` } });
      } catch { /* token may be stale; still drop our copy */ }
      await sb.from('xero_connections').delete().eq('location_id', locationId);
    }
    return json({ ok: true, connected: false });
  }

  return json({ error: 'Unknown action' }, 400);
});
