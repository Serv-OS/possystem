// supabase/functions/ezcater-connect/index.ts
//
// ezCater connection lifecycle, Back Office only. Mirrors hubrise-connect.
//
//   POST { action, ops_location_id }:
//     status         -> scrubbed connection status + the caterers on this location
//     connect_token  -> store the API token, create the subscriber, subscribe
//     list_caterers  -> ask ezCater what this API user can see, cache it
//     map_caterer    -> point one caterer uuid at one ServOS location
//     unmap_caterer  -> clear that mapping
//     set_policy     -> per caterer auto_accept, per connection feature flags
//     resubscribe    -> tear down and recreate the event subscriptions
//     disconnect     -> delete the subscriptions and drop the connection
//
// There is NO OAuth. ezCater issues a static token by email request, generated
// once in the Partner Portal, and it CANNOT be recovered if lost. So unlike
// HubRise there is no authorize redirect here, the operator pastes the token
// once. It is written to ezcater_connections (service role only, RLS with no
// policies) and every projection back to the browser is scrubbed. The token and
// the signing secret never leave this function.
//
// Shape difference worth remembering: the connection is keyed on the SUBSCRIBER,
// not on a location. One ezCater API user covers many caterers, and a caterer is
// what maps to a ServOS location.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
  caterers as listCaterers, createSubscriber, createSubscription,
  deleteSubscriptions, EZ_EVENTS, EzcaterError,
} from '../_shared/ezcater.ts';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const sb = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { autoRefreshToken: false, persistSession: false } });

// No ?loc= on purpose. ezCater allows one subscriber per API user covering many
// caterers, so the webhook resolves the location from the notification's
// parent_id instead of from its own URL.
const WEBHOOK_URL = `${SUPABASE_URL}/functions/v1/ezcater-webhook`;

/** Signed in Ops user with access to this location, or super_admin. Same fence as hubrise-connect. */
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

/**
 * The connection serving a location: the one its mapped caterer belongs to,
 * falling back to the single connected row when nothing is mapped yet (which is
 * the state every operator starts in).
 */
async function connectionForLocation(opsLocationId: string): Promise<any | null> {
  const { data: cat } = await sb.from('ezcater_caterers')
    .select('connection_id').eq('location_id', opsLocationId).not('connection_id', 'is', null).limit(1).maybeSingle();
  if (cat?.connection_id) {
    const { data } = await sb.from('ezcater_connections').select('*').eq('id', cat.connection_id).maybeSingle();
    if (data) return data;
  }
  const { data } = await sb.from('ezcater_connections')
    .select('*').eq('status', 'connected').order('connected_at', { ascending: true }).limit(1).maybeSingle();
  return data || null;
}

/** SCRUBBED projection. api_token and signing_secret must never appear here. */
function publicStatus(c: any) {
  if (!c) return { connected: false };
  return {
    connected: c.status === 'connected',
    status: c.status,
    connection_id: c.id,
    label: c.label,
    subscriber_id: c.subscriber_id,
    subscribed_events: c.subscribed_events || [],
    webhook_url: c.webhook_url,
    has_signing_secret: !!c.signing_secret,
    // null means ezCater has not told us either way. Both are commercial gates
    // that no amount of building can open, so the Back Office should say so
    // plainly rather than offering a button that always fails.
    accept_enabled: c.accept_enabled,
    menus_enabled: c.menus_enabled,
    last_event_at: c.last_event_at,
    last_reconcile_at: c.last_reconcile_at,
    last_error: c.last_error,
    connected_at: c.connected_at,
    portal_url: 'https://partner.ezcater.com',
  };
}

const catererRow = (c: any) => ({
  caterer_uuid: c.caterer_uuid,
  caterer_name: c.caterer_name,
  brand_name: c.brand_name,
  location_id: c.location_id,
  currency: c.currency,
  auto_accept: c.auto_accept,
  active: c.active,
  first_seen_at: c.first_seen_at,
  mapped_at: c.mapped_at,
});

/** Create the subscriber and subscribe it to every event we actually want. */
async function subscribe(connectionId: string, token: string): Promise<{ subscriberId: string | null; secret: string | null; events: string[] }> {
  const subscriber = await createSubscriber(token, WEBHOOK_URL);
  const subscriberId = subscriber?.uuid ? String(subscriber.uuid) : null;
  const secret = subscriber?.signingSecret ? String(subscriber.signingSecret) : null;
  const done: string[] = [];
  if (subscriberId) {
    for (const ev of EZ_EVENTS) {
      // One failed event must not cost us the others. relish_finalized in
      // particular is the ONLY event a Meal Program order ever sends, so losing
      // it silently loses every Meal Program order.
      try { await createSubscription(token, subscriberId, ev); done.push(ev); }
      catch (e) { console.warn('[ezcater-connect] subscribe', ev, 'failed:', e instanceof Error ? e.message : String(e)); }
    }
  }
  await sb.from('ezcater_connections').update({
    subscriber_id: subscriberId,
    signing_secret: secret,
    webhook_url: WEBHOOK_URL,
    subscribed_events: done,
    updated_at: new Date().toISOString(),
  }).eq('id', connectionId);
  return { subscriberId, secret, events: done };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
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
      case 'status': {
        const conn = await connectionForLocation(opsLocationId);
        // Caterers already on this venue, plus anything the webhook has seen but
        // nobody has mapped yet, so the operator can adopt it.
        const [{ data: mine }, { data: unmapped }] = await Promise.all([
          sb.from('ezcater_caterers').select('*').eq('location_id', opsLocationId),
          sb.from('ezcater_caterers').select('*').is('location_id', null),
        ]);
        return json({
          ok: true,
          status: publicStatus(conn),
          caterers: (mine || []).map(catererRow),
          unmapped: (unmapped || []).map(catererRow),
        });
      }

      case 'connect_token': {
        const apiToken = String(body?.api_token || '').trim();
        if (!apiToken) return json({ error: 'api_token required' }, 400);
        const label = String(body?.label || '').trim() || null;

        const { data: conn, error } = await sb.from('ezcater_connections').insert({
          api_token: apiToken,
          label,
          webhook_url: WEBHOOK_URL,
          status: 'connected',
          connected_by: access.userId === 'service' ? null : access.userId,
        }).select('id').single();
        if (error || !conn?.id) return json({ error: error?.message || 'could not store connection' }, 500);

        // Prove the token before we claim success. A bad token here is the most
        // common setup failure and it is silent otherwise.
        let seen: any[] = [];
        try {
          seen = await listCaterers(apiToken);
        } catch (e) {
          await sb.from('ezcater_connections')
            .update({ status: 'error', last_error: e instanceof Error ? e.message : String(e) }).eq('id', conn.id);
          return json({ error: `ezCater rejected the token: ${e instanceof Error ? e.message : String(e)}` }, 400);
        }

        for (const c of seen) {
          await sb.from('ezcater_caterers').upsert({
            caterer_uuid: String(c?.uuid || ''),
            connection_id: conn.id,
            caterer_name: c?.name || null,
            brand_name: c?.brandName || null,
            updated_at: new Date().toISOString(),
          }, { onConflict: 'caterer_uuid' });
        }

        const sub = await subscribe(conn.id, apiToken);
        const { data: fresh } = await sb.from('ezcater_connections').select('*').eq('id', conn.id).maybeSingle();
        return json({
          ok: true,
          status: publicStatus(fresh),
          caterers: seen.map((c: any) => ({ caterer_uuid: c?.uuid, caterer_name: c?.name, brand_name: c?.brandName })),
          subscribed: sub.events,
        });
      }

      case 'list_caterers': {
        const conn = await connectionForLocation(opsLocationId);
        if (!conn?.api_token) return json({ error: 'not connected' }, 400);
        const seen = await listCaterers(conn.api_token);
        for (const c of seen) {
          await sb.from('ezcater_caterers').upsert({
            caterer_uuid: String(c?.uuid || ''),
            connection_id: conn.id,
            caterer_name: c?.name || null,
            brand_name: c?.brandName || null,
            updated_at: new Date().toISOString(),
          }, { onConflict: 'caterer_uuid' });
        }
        const { data: all } = await sb.from('ezcater_caterers').select('*').eq('connection_id', conn.id);
        return json({ ok: true, caterers: (all || []).map(catererRow) });
      }

      case 'map_caterer': {
        // The fence is already applied: requireAccess proved the caller can
        // write to opsLocationId, and that is the ONLY location this can point
        // a caterer at. A caterer id from the request body can never be used to
        // route another tenant's orders here.
        const catererUuid = String(body?.caterer_uuid || '').trim();
        if (!catererUuid) return json({ error: 'caterer_uuid required' }, 400);
        const conn = await connectionForLocation(opsLocationId);
        const { error } = await sb.from('ezcater_caterers').upsert({
          caterer_uuid: catererUuid,
          connection_id: conn?.id || null,
          location_id: opsLocationId,
          caterer_name: body?.caterer_name || null,
          active: true,
          mapped_at: new Date().toISOString(),
          mapped_by: access.userId === 'service' ? null : access.userId,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'caterer_uuid' });
        if (error) return json({ error: error.message }, 500);
        return json({ ok: true });
      }

      case 'unmap_caterer': {
        const catererUuid = String(body?.caterer_uuid || '').trim();
        if (!catererUuid) return json({ error: 'caterer_uuid required' }, 400);
        // Scoped to THIS location, so one venue cannot unmap another's caterer.
        const { error } = await sb.from('ezcater_caterers')
          .update({ location_id: null, mapped_at: null, updated_at: new Date().toISOString() })
          .eq('caterer_uuid', catererUuid).eq('location_id', opsLocationId);
        if (error) return json({ error: error.message }, 500);
        return json({ ok: true });
      }

      case 'set_policy': {
        const patch: any = { updated_at: new Date().toISOString() };
        if (typeof body?.auto_accept === 'boolean') patch.auto_accept = body.auto_accept;
        if (typeof body?.active === 'boolean') patch.active = body.active;
        if (Object.keys(patch).length > 1) {
          const catererUuid = String(body?.caterer_uuid || '').trim();
          const q = sb.from('ezcater_caterers').update(patch).eq('location_id', opsLocationId);
          const { error } = catererUuid ? await q.eq('caterer_uuid', catererUuid) : await q;
          if (error) return json({ error: error.message }, 500);
        }
        // Feature gates are recorded, never inferred. They are whatever ezCater
        // told the operator in writing.
        const conn = await connectionForLocation(opsLocationId);
        if (conn?.id) {
          const cPatch: any = { updated_at: new Date().toISOString() };
          if (typeof body?.accept_enabled === 'boolean') cPatch.accept_enabled = body.accept_enabled;
          if (typeof body?.menus_enabled === 'boolean') cPatch.menus_enabled = body.menus_enabled;
          if (Object.keys(cPatch).length > 1) await sb.from('ezcater_connections').update(cPatch).eq('id', conn.id);
        }
        return json({ ok: true });
      }

      case 'resubscribe': {
        const conn = await connectionForLocation(opsLocationId);
        if (!conn?.api_token) return json({ error: 'not connected' }, 400);
        if (conn.subscriber_id) {
          await deleteSubscriptions(conn.api_token, conn.subscriber_id).catch((e: unknown) =>
            console.warn('[ezcater-connect] deleteSubscriptions:', e instanceof Error ? e.message : String(e)));
        }
        const sub = await subscribe(conn.id, conn.api_token);
        return json({ ok: true, subscriber_id: sub.subscriberId, subscribed: sub.events });
      }

      case 'disconnect': {
        const conn = await connectionForLocation(opsLocationId);
        if (conn?.api_token && conn?.subscriber_id) {
          await deleteSubscriptions(conn.api_token, conn.subscriber_id).catch(() => {});
        }
        if (conn?.id) {
          // Cascades ezcater_caterers. ezcater_events and ezcater_order_links are
          // deliberately NOT cascaded: they are the audit trail of real orders
          // and real money, and they outlive the connection.
          await sb.from('ezcater_connections').delete().eq('id', conn.id);
        }
        return json({ ok: true });
      }

      default:
        return json({ error: `unknown action: ${action}` }, 400);
    }
  } catch (e) {
    if (e instanceof EzcaterError) {
      // feature_not_enabled is the one an operator will actually hit. Accept and
      // reject is gated per brand by ezCater and no amount of retrying opens it,
      // so say that rather than showing a generic failure.
      const msg = e.code === 'feature_not_enabled'
        ? 'ezCater has not enabled this feature for your brand. Contact integrations@ezcater.com.'
        : e.message;
      return json({ error: msg, code: e.code }, e.status === 200 ? 400 : e.status);
    }
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
