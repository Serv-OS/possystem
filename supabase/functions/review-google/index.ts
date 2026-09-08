// supabase/functions/review-google/index.ts
//
// One-click Google Business Profile connection. The platform owner registers ONE
// Google OAuth client (GOOGLE_OAUTH_CLIENT_ID/_SECRET) + gets API access approval
// once; then each venue's manager just clicks Connect → signs in → picks their
// location. Reviews then sync in (review-sync) and approved replies post back
// (review-reply) via the v4 API.
//   POST start        { ops_location_id, return_url? }  → { url }  (authed; opens Google consent)
//   GET  ?code&state                                    → OAuth redirect target: stores tokens, 302 back to BO
//   POST status       { ops_location_id }               → { configured, connected, location_title, needs_pick, available }
//   POST set_location { ops_location_id, location_name } → pick which GBP location
//   POST disconnect   { ops_location_id }
//
// Register this function's URL as the Authorized redirect URI in the Google
// OAuth client: <SUPABASE_URL>/functions/v1/review-google

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { googleConfigured, consentUrl, exchangeCode, accessTokenFrom, listLocations } from '../_shared/google-reviews.ts';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const BO_BASE = (Deno.env.get('REVIEW_BO_BASE') ?? 'https://possystem-liard.vercel.app').replace(/\/+$/, '');
const REDIRECT_URI = `${SUPABASE_URL}/functions/v1/review-google`;
const opsAdmin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { autoRefreshToken: false, persistSession: false } });
const platformAdmin = createClient(Deno.env.get('PLATFORM_SUPABASE_URL') ?? '', Deno.env.get('PLATFORM_SUPABASE_SERVICE_ROLE_KEY') ?? '', { auth: { autoRefreshToken: false, persistSession: false } });

async function authed(req: Request, ops: string): Promise<boolean> {
  const token = (req.headers.get('Authorization') ?? '').replace('Bearer ', '').trim();
  if (!token) return false;
  if (token === SERVICE_ROLE) return true;
  const { data: { user } } = await opsAdmin.auth.getUser(token);
  if (!user) return false;
  const { data: ul } = await opsAdmin.from('user_locations').select('location_id').eq('user_id', user.id).eq('location_id', ops).maybeSingle();
  if (ul) return true;
  const { data: p } = await opsAdmin.from('user_profiles').select('role').eq('id', user.id).maybeSingle();
  return p?.role === 'super_admin';
}
async function companyFor(ops: string) {
  const { data } = await platformAdmin.from('locations').select('company_id').or(`ops_location_id.eq.${ops},id.eq.${ops}`).maybeSingle();
  return data?.company_id ?? null;
}
const redirectTo = (url: string) => new Response(null, { status: 302, headers: { Location: url } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const url = new URL(req.url);

  // ── GET: the Google OAuth redirect lands here ─────────────────────────────
  if (req.method === 'GET') {
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state') || '';
    const err = url.searchParams.get('error');
    if (err) return redirectTo(`${BO_BASE}/?mode=office&google=error`);
    if (!code || !state) return redirectTo(`${BO_BASE}/?mode=office&google=error`);
    try {
      const { data: pending } = await opsAdmin.from('review_oauth_pending').select('location_id, company_id').eq('nonce', state).maybeSingle();
      if (!pending) return redirectTo(`${BO_BASE}/?mode=office&google=expired`);
      await opsAdmin.from('review_oauth_pending').delete().eq('nonce', state);
      const tok = await exchangeCode(code, REDIRECT_URI);
      if (!tok.refresh_token) return redirectTo(`${BO_BASE}/?mode=office&google=norefresh`);
      const locs = await listLocations(tok.access_token);
      const auto = locs.length === 1 ? locs[0] : null;
      await opsAdmin.from('review_google_tokens').upsert({
        location_id: pending.location_id, company_id: pending.company_id,
        refresh_token: tok.refresh_token, scope: tok.scope ?? null, available: locs,
        location_name: auto?.name ?? null, location_title: auto?.title ?? null,
        account_name: auto ? auto.name.split('/locations/')[0] : null,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'location_id' });
      if (auto) await enablePlatform(pending.location_id, pending.company_id, auto.name);
      return redirectTo(`${BO_BASE}/?mode=office&google=${auto ? 'connected' : 'pick'}`);
    } catch (e) {
      console.error('[review-google] callback', (e as Error).message);
      return redirectTo(`${BO_BASE}/?mode=office&google=error`);
    }
  }

  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);
  let body: any; try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }
  const action = String(body?.action ?? '').trim();
  const ops = String(body?.ops_location_id ?? '').trim();
  if (!ops) return json({ error: 'ops_location_id required' }, 400);
  if (!(await authed(req, ops))) return json({ error: 'no access to this location' }, 403);

  if (action === 'start') {
    if (!googleConfigured()) return json({ error: 'Google connection isn’t set up on the platform yet (missing OAuth credentials).' }, 400);
    const nonce = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
    await opsAdmin.from('review_oauth_pending').insert({ nonce, location_id: ops, company_id: await companyFor(ops) });
    return json({ url: consentUrl(REDIRECT_URI, nonce) });
  }

  if (action === 'status') {
    const { data: t } = await opsAdmin.from('review_google_tokens').select('location_name, location_title, available, connected_at').eq('location_id', ops).maybeSingle();
    return json({
      configured: googleConfigured(),
      connected: !!t,
      location_title: t?.location_title ?? null,
      needs_pick: !!t && !t.location_name && Array.isArray(t.available) && t.available.length > 1,
      available: t?.available ?? [],
    });
  }

  if (action === 'set_location') {
    const name = String(body.location_name ?? '').trim();
    const { data: t } = await opsAdmin.from('review_google_tokens').select('available, company_id').eq('location_id', ops).maybeSingle();
    if (!t) return json({ error: 'not connected' }, 400);
    const pick = (t.available ?? []).find((l: any) => l.name === name);
    if (!pick) return json({ error: 'unknown location' }, 400);
    await opsAdmin.from('review_google_tokens').update({ location_name: pick.name, location_title: pick.title, account_name: pick.name.split('/locations/')[0], updated_at: new Date().toISOString() }).eq('location_id', ops);
    await enablePlatform(ops, t.company_id, pick.name);
    return json({ ok: true, location_title: pick.title });
  }

  if (action === 'disconnect') {
    await opsAdmin.from('review_google_tokens').delete().eq('location_id', ops);
    await opsAdmin.from('review_platform_links').update({ enabled: false }).eq('location_id', ops).eq('platform', 'google');
    return json({ ok: true });
  }

  return json({ error: `unknown action: ${action}` }, 400);
});

// Mirror the connected location into review_platform_links so review-sync picks
// it up and the customer card's one-tap Google link resolves.
async function enablePlatform(ops: string, company: string | null, accountAndLocation: string) {
  const locId = accountAndLocation.split('/locations/').pop() ?? null;
  await opsAdmin.from('review_platform_links').upsert({
    location_id: ops, company_id: company, platform: 'google', enabled: true,
    external_place_id: locId, updated_at: new Date().toISOString(),
  }, { onConflict: 'location_id,platform' });
}
