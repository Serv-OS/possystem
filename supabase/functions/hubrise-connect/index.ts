// supabase/functions/hubrise-connect/index.ts
//
// HubRise connection lifecycle for a venue:
//   POST { action }:
//     oauth_start      -> { url }      (BO opens it; operator authorizes at HubRise)
//     status           -> non-secret connection status for the BO
//     register_callbacks -> (re)register active+passive order callbacks
//     set_policy       -> auto_accept / default_prep_minutes
//     disconnect       -> revoke token + delete callbacks + drop the connection
//   GET ?action=oauth_callback&code&state  -> browser redirect target; exchanges the
//                       code, stores the connection, registers callbacks, redirects to BO.
//
// The access_token is written to hubrise_connections (service-role only) and never
// returned to the browser. Auth for POST actions: a signed-in Ops user WITH access to
// the location (user_locations) or super_admin, mirroring payments-onboard.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
  authorizeUrl, exchangeCode, revokeToken, getAccount, getLocation,
  createCallback, HUBRISE_SCOPE,
} from '../_shared/hubrise.ts';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const CLIENT_ID = Deno.env.get('HUBRISE_CLIENT_ID') ?? '';
const CLIENT_SECRET = Deno.env.get('HUBRISE_CLIENT_SECRET') ?? '';
const APP_BASE = Deno.env.get('HUBRISE_APP_BASE') ?? '';
const sb = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { autoRefreshToken: false, persistSession: false } });

const REDIRECT_URI = `${SUPABASE_URL}/functions/v1/hubrise-connect?action=oauth_callback`;
const WEBHOOK_URL = (loc: string) => `${SUPABASE_URL}/functions/v1/hubrise-webhook?loc=${encodeURIComponent(loc)}`;
const ORDER_EVENTS = { order: ['create', 'update'] };

function randState(): string {
  const a = new Uint8Array(24);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function requireAccess(req: Request, opsLocationId: string): Promise<{ ok: true; userId: string } | { ok: false; res: Response }> {
  const authHeader = req.headers.get('Authorization') || '';
  const token = authHeader.replace('Bearer ', '').trim();
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

/** Persist a connection from a token-exchange (or discovered personal token). */
async function storeConnection(opsLocationId: string, token: string, bound: any, userId: string) {
  // Discover/confirm the binding. The OAuth token response carries the ids; a personal
  // token may not, so fall back to GET /location + GET /account.
  let hubLocId = bound?.location_id || null;
  let hubLocName = bound?.location_name || null;
  let acctId = bound?.account_id || null;
  let acctName = bound?.account_name || null;
  let catId = bound?.catalog_id || null;
  let catName = bound?.catalog_name || null;
  let custListId = bound?.customer_list_id || null;
  let currency = 'GBP';
  try {
    const loc = await getLocation(token);
    hubLocId = hubLocId || loc?.id || null;
    hubLocName = hubLocName || loc?.name || null;
    acctId = acctId || loc?.account?.id || null;
    acctName = acctName || loc?.account?.name || null;
    if (loc?.account?.currency) currency = loc.account.currency;
  } catch { /* personal tokens may differ; non-fatal */ }
  if (!currency || currency === 'GBP') {
    try { const acct = await getAccount(token); if (acct?.currency) currency = acct.currency; } catch { /* ignore */ }
  }

  await sb.from('hubrise_connections').upsert({
    location_id: opsLocationId,
    access_token: token,
    scope: bound?.scope || HUBRISE_SCOPE,
    hubrise_account_id: acctId,
    account_name: acctName,
    hubrise_location_id: hubLocId,
    hubrise_location_name: hubLocName,
    hubrise_catalog_id: catId,
    hubrise_catalog_name: catName,
    hubrise_customer_list_id: custListId,
    currency,
    status: 'connected',
    last_error: null,
    connected_by: userId === 'service' ? null : userId,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'location_id' });

  await registerCallbacks(opsLocationId, token).catch((e) => console.warn('[hubrise-connect] callback register:', e?.message || e));
}

async function registerCallbacks(opsLocationId: string, token: string) {
  // HubRise has exactly ONE callback per connection (it has no id — GET/POST /callback
  // get/set the single config). Set it ACTIVE (url = our webhook). Do NOT also create a
  // "passive" one: a second POST would overwrite this and leave HubRise with nowhere to
  // push orders (that was the bug). Failed/missed deliveries still queue in
  // /callback/events, which hubrise-reconcile drains — so active-only is correct.
  await createCallback(token, WEBHOOK_URL(opsLocationId), ORDER_EVENTS);
  await sb.from('hubrise_connections').update({
    active_callback_id: 'active',
    passive_callback_id: null,
    callbacks_registered_at: new Date().toISOString(),
  }).eq('location_id', opsLocationId);
}

function publicStatus(c: any) {
  if (!c) return { connected: false };
  return {
    connected: c.status === 'connected',
    status: c.status,
    account_name: c.account_name,
    hubrise_account_id: c.hubrise_account_id,                 // expose id+name for ALL FOUR resources
    hubrise_location_name: c.hubrise_location_name,
    hubrise_location_id: c.hubrise_location_id,
    catalog_id: c.hubrise_catalog_id,
    catalog_name: c.hubrise_catalog_name,
    hubrise_customer_list_id: c.hubrise_customer_list_id,     // customer list — required by the integration sheet
    hubrise_customer_list_name: c.hubrise_customer_list_name || null,
    manager_url: 'https://manager.hubrise.com',               // link target for the BO "Manage in HubRise"
    currency: c.currency,
    callbacks_registered_at: c.callbacks_registered_at,
    catalog_pushed_at: c.catalog_pushed_at,
    catalog_push_error: c.catalog_push_error,
    inventory_synced_at: c.inventory_synced_at,
    last_event_at: c.last_event_at,
    last_reconcile_at: c.last_reconcile_at,
    last_error: c.last_error,
    auto_accept: c.auto_accept,
    default_prep_minutes: c.default_prep_minutes,
    auto_print_receipt: c.auto_print_receipt !== false,
    menu_ids: c.menu_ids || [],
    connected_at: c.connected_at,
  };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const url = new URL(req.url);

  // ── GET ?action=oauth_callback — browser redirect back from HubRise ──────────
  if (req.method === 'GET' && url.searchParams.get('action') === 'oauth_callback') {
    // v5.5.850: fail loudly if the redirect target isn't configured — Response.redirect
    // throws on a relative URL, which previously surfaced as an opaque 500 after authorize.
    if (!APP_BASE) return json({ error: 'HUBRISE_APP_BASE not configured' }, 500);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const fail = (msg: string) => Response.redirect(`${APP_BASE}${APP_BASE.includes('?') ? '&' : '?'}hubrise=error&msg=${encodeURIComponent(msg)}`, 302);
    if (!code || !state) return fail('missing code/state');
    const { data: pending } = await sb.from('hubrise_oauth_pending').select('*').eq('state', state).maybeSingle();
    if (!pending) return fail('invalid or expired state');
    await sb.from('hubrise_oauth_pending').delete().eq('state', state);
    try {
      const tok = await exchangeCode(CLIENT_ID, CLIENT_SECRET, code);
      if (!tok?.access_token) return fail('token exchange failed');
      await storeConnection(pending.location_id, tok.access_token, tok, pending.company_id ? 'service' : 'service');
      return Response.redirect(`${APP_BASE}${APP_BASE.includes('?') ? '&' : '?'}hubrise=connected`, 302);
    } catch (e) {
      return fail(e instanceof Error ? e.message : 'connect failed');
    }
  }

  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }
  const action = String(body?.action || '');
  const opsLocationId = String(body?.ops_location_id || body?.location_id || '');
  if (!action) return json({ error: 'action required' }, 400);
  if (!opsLocationId) return json({ error: 'ops_location_id required' }, 400);

  const access = await requireAccess(req, opsLocationId);
  if (!access.ok) return access.res;

  try {
    switch (action) {
      case 'oauth_start': {
        if (!CLIENT_ID) return json({ error: 'HubRise app not configured (HUBRISE_CLIENT_ID)' }, 500);
        const state = randState();
        await sb.from('hubrise_oauth_pending').insert({ state, location_id: opsLocationId });
        // No name passthrough at all. v5.5.850 pinned the connection/location name
        // to "ServOS"; HubRise's review then asked for it removed, because naming
        // the account is the customer's choice to make in their own HubRise
        // account, not ours to impose from the authorize URL.
        const u = authorizeUrl(CLIENT_ID, REDIRECT_URI, HUBRISE_SCOPE, state);
        return json({ ok: true, url: u });
      }
      // v5.5.850: connect_token removed — OAuth is the only connect path (per the HubRise
      // sign-off review; pasting arbitrary personal tokens is no longer offered).
      case 'register_callbacks': {
        const { data: c } = await sb.from('hubrise_connections').select('access_token').eq('location_id', opsLocationId).maybeSingle();
        if (!c?.access_token) return json({ error: 'not connected' }, 400);
        await registerCallbacks(opsLocationId, c.access_token);
        return json({ ok: true });
      }
      case 'set_policy': {
        const patch: any = { updated_at: new Date().toISOString() };
        if (typeof body?.auto_accept === 'boolean') patch.auto_accept = body.auto_accept;
        if (Number.isFinite(body?.default_prep_minutes)) patch.default_prep_minutes = Math.max(0, Math.round(body.default_prep_minutes));
        if (Array.isArray(body?.menu_ids)) patch.menu_ids = body.menu_ids.map(String);
        if (typeof body?.auto_print_receipt === 'boolean') patch.auto_print_receipt = body.auto_print_receipt;
        await sb.from('hubrise_connections').update(patch).eq('location_id', opsLocationId);
        return json({ ok: true });
      }
      case 'status': {
        const { data: c } = await sb.from('hubrise_connections').select('*').eq('location_id', opsLocationId).maybeSingle();
        return json({ ok: true, status: publicStatus(c) });
      }
      case 'disconnect': {
        const { data: c } = await sb.from('hubrise_connections').select('*').eq('location_id', opsLocationId).maybeSingle();
        if (c?.access_token) {
          // Stop pushes (set the callback passive) best-effort, then revoke the token
          // (which fully invalidates the connection anyway). No callback id to delete.
          await createCallback(c.access_token, null, ORDER_EVENTS).catch(() => {});
          if (CLIENT_ID && CLIENT_SECRET) await revokeToken(CLIENT_ID, CLIENT_SECRET, c.access_token);
        }
        await sb.from('hubrise_connections').delete().eq('location_id', opsLocationId);
        return json({ ok: true });
      }
      default:
        return json({ error: `unknown action: ${action}` }, 400);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return json({ error: msg }, 500);
  }
});
