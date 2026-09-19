// supabase/functions/ezcater-connect/index.ts
//
// ezCater connection lifecycle, Back Office only. Mirrors hubrise-connect.
//
//   POST { action, ops_location_id }:
//     status         -> scrubbed connection status + the caterers on this location
//     connect_token  -> store the API token, create the subscriber, subscribe.
//                       api_url is optional: the sandbox address ezCater gave
//                       the owner. Empty, and every older connection, is the
//                       live API.
//     list_caterers  -> ask ezCater what this API user can see, cache it
//     map_caterer    -> point one caterer uuid at one ServOS location
//     unmap_caterer  -> clear that mapping
//     set_policy     -> per caterer auto_accept, per connection feature flags
//     resubscribe    -> tear down and recreate the event subscriptions
//     disconnect     -> delete the subscriptions and drop the connection
//     items_list     -> the ezCater item names seen on this venue, and what
//                       each one is matched to
//     items_save     -> match one of their names to one of ours, silence it, or
//                       clear it back to unmatched (after 20260919m: a synced row,
//                       by the key the sync gave it, update only)
//     menu_sync      -> "Sync ezCater menu": read the current ezCater menus of the
//                       venue's caterers into ezcater_item_links, one row per exact
//                       full name, exact names auto linked (_shared/ezcaterMenuSync.ts)
//   POST { action: 'menu_sync_due' } with the service role (pg_cron, hourly):
//                       the daily sync of every venue that is due
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
  caterers as listCaterers, subscribers as listSubscribers, createSubscriber, updateSubscriber,
  createSubscription, deleteSubscriptions, EZ_EVENTS, EzcaterError, isSchemaError,
  isSandboxApi, resolveEzcaterApi, ez,
} from '../_shared/ezcater.ts';
import { buildLinkKey } from '../_shared/ezcaterMatch.ts';
import {
  readAllLinks, isMissingSyncColumn, isSyncKey, LINK_PAGE_SIZE, lookAgainOf, fullNameOf,
} from '../_shared/ezcaterMenuSync.ts';
import { runMenuSync, runDueSyncs } from '../_shared/ezcaterMenuSyncRun.ts';

/** ezCater, as the menu sync asks it: one connection's token and address. */
const askFor = (conn: any) => (op: string, query: string, vars: Record<string, unknown> = {}) =>
  ez<any>(String(conn.api_token), op, query, vars, conn.api_url ?? null);

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const sb = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { autoRefreshToken: false, persistSession: false } });

// No ?loc= on purpose. ezCater allows one subscriber per API user covering many
// caterers, so the webhook resolves the location from the notification's
// parent_id instead of from its own URL.
const WEBHOOK_URL = `${SUPABASE_URL}/functions/v1/ezcater-webhook`;

/**
 * "That table is not there yet" rather than "that broke".
 *
 * 42P01 is Postgres undefined_table. PGRST205 is PostgREST failing to find the
 * table in its schema cache, which is also what a brand new table looks like
 * until the cache reloads. Both mean the operator has not run
 * 20260917_OPS_ezcater_item_links.sql yet, and the answer is an empty screen
 * with one plain line on it, not an error.
 */
function isAbsentTable(err: any): boolean {
  const code = String(err?.code || '');
  if (code === '42P01' || code === 'PGRST205') return true;
  const msg = String(err?.message || '').toLowerCase();
  return /relation .*does not exist/.test(msg) || msg.includes('could not find the table');
}

/**
 * "That COLUMN is not there yet", the same story one level down.
 *
 * 42703 is Postgres undefined_column and PGRST204 is PostgREST failing to find
 * the column in its schema cache. Both mean 20260917_OPS_ezcater_api_url.sql has
 * not been run, and naming that column in a write fails the WHOLE write, so it
 * is only ever named when the operator actually typed an address.
 */
function isAbsentColumn(err: any, column: string): boolean {
  const code = String(err?.code || '');
  const msg = String(err?.message || '').toLowerCase();
  if (code === '42703' || code === 'PGRST204') return true;
  return msg.includes(`column "${column}"`) || msg.includes(`'${column}' column`);
}

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
    // Which ezCater this venue is talking to. null is the live API, which is
    // also what every connection made before the api_url column existed reads
    // as. Back Office labels anything else Sandbox, in amber, so a test
    // connection can never sit there looking live.
    api_url: c.api_url ?? null,
    sandbox: isSandboxApi(c.api_url ?? null),
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

/** Every caterer uuid known for this connection. A subscription needs one. */
async function catererUuidsFor(connectionId: string): Promise<string[]> {
  const { data } = await sb.from('ezcater_caterers').select('caterer_uuid').eq('connection_id', connectionId);
  return (data || []).map((c: any) => String(c.caterer_uuid || '')).filter(Boolean);
}

/**
 * Create the subscriber and subscribe it to every event we want, FOR EVERY
 * CATERER.
 *
 * A subscription is per caterer per event: CreateSubscriptionFields takes
 * eventEntity, eventKey, parentEntity and parentId, and parentId is the caterer
 * uuid. There is no account wide subscription, so a caterer with no rows of its
 * own sends nothing at all however healthy the subscriber looks.
 *
 * webhookSecret is returned ONLY when the subscriber is first created. ezCater
 * allows one subscriber per API user, so on a reconnect we reuse the existing
 * one and CANNOT read its secret again: that is when EZCATER_SIGNING_SECRET has
 * to be set by hand, and it is said out loud rather than failing quietly.
 *
 * THE REUSED SUBSCRIBER IS ALSO POINTING SOMEWHERE ELSE. That is the part that
 * used to be missed. A subscriber created against an older project, an older
 * deploy or a colleague's test box keeps ITS webhookUrl, and reusing it without
 * looking left Back Office saying "connected" while every single notification
 * went to the old address and no order ever arrived. So the URL is compared and
 * repointed with updateSubscriber when it differs.
 *
 * Repointing does NOT touch the signing secret. UpdateSubscriberPayload returns
 * a Subscriber, which has no webhookSecret field, and ezCater state that webhook
 * secrets cannot be changed at present. So the secret stays exactly the one
 * issued at creation: still the right key, still not readable by us, still to be
 * set by hand as EZCATER_SIGNING_SECRET. Repointing fixes WHERE the events go,
 * never how they are signed.
 */
async function subscribe(
  connectionId: string, token: string, catererUuids: string[], label: string | null,
  endpoint: string | null = null,
): Promise<{
  subscriberId: string | null; secret: string | null; events: string[]; caterers: number;
  reused: boolean; repointed: boolean; webhookUrl: string | null; repointError: string | null;
}> {
  const name = `ServOS-${label || 'ezCater'}`.slice(0, 120);

  let subscriber: any = null;
  let reused = false;
  try {
    subscriber = await createSubscriber(token, WEBHOOK_URL, name, endpoint);
  } catch (e) {
    const existing = await listSubscribers(token, endpoint).catch(() => [] as any[]);
    subscriber = existing[0] || null;
    if (!subscriber) throw e;
    reused = true;
    console.warn('[ezcater-connect] this API user already has a subscriber,', subscriber.id,
      '- reusing it. Its webhook secret is only ever issued at creation, so set EZCATER_SIGNING_SECRET by hand.');
  }

  const subscriberId = subscriber?.id ? String(subscriber.id) : null;
  const secret = subscriber?.webhookSecret ? String(subscriber.webhookSecret) : null;

  // ── Repoint a reused subscriber that is aimed at the wrong webhook ────────
  let repointed = false;
  let repointError: string | null = null;
  let webhookUrl = subscriber?.webhookUrl ? String(subscriber.webhookUrl) : null;
  if (reused && subscriberId && webhookUrl !== WEBHOOK_URL) {
    try {
      const updated = await updateSubscriber(token, subscriberId, WEBHOOK_URL, name, endpoint);
      webhookUrl = updated?.webhookUrl ? String(updated.webhookUrl) : WEBHOOK_URL;
      repointed = true;
      console.warn('[ezcater-connect] reused subscriber', subscriberId,
        'was pointing at a different webhook. Repointed to ours. The signing secret is unchanged,',
        'ezCater only ever issues it at creation and cannot change it, so EZCATER_SIGNING_SECRET still has to match that original secret.');
    } catch (e) {
      // Do NOT claim a working connection. Every notification is still going to
      // the old address and the operator has to know that is why nothing arrives.
      repointError = e instanceof Error ? e.message : String(e);
      console.error('[ezcater-connect] could not repoint the reused subscriber', subscriberId,
        'away from its old webhook. NO ORDER WILL ARRIVE until this is fixed:', repointError);
    }
  } else if (!reused) {
    webhookUrl = WEBHOOK_URL;
  }

  const done = new Set<string>();
  let wired = 0;
  if (subscriberId) {
    for (const catererUuid of catererUuids) {
      let any = false;
      for (const ev of EZ_EVENTS) {
        // One failed event must not cost us the others. relish_finalized in
        // particular is the ONLY event a Meal Program order ever sends, so losing
        // it silently loses every Meal Program order.
        try { await createSubscription(token, subscriberId, catererUuid, ev, endpoint); done.add(ev); any = true; }
        catch (e) { console.warn('[ezcater-connect] subscribe', ev, 'for caterer', catererUuid, 'failed:', e instanceof Error ? e.message : String(e)); }
      }
      if (any) wired++;
    }
  }
  if (!catererUuids.length) {
    console.warn('[ezcater-connect] subscriber created but there are no caterers to subscribe for.',
      'No order will ever arrive until list_caterers finds one.');
  }

  const patch: any = {
    subscriber_id: subscriberId,
    // The URL ezCater ACTUALLY has, not the one we wish it had. Writing
    // WEBHOOK_URL here regardless is what made a misdirected subscriber look
    // healthy in Back Office.
    webhook_url: webhookUrl || WEBHOOK_URL,
    subscribed_events: [...done],
    updated_at: new Date().toISOString(),
  };
  // Never overwrite a working secret with the null a reused subscriber gives us.
  if (secret) patch.signing_secret = secret;
  if (repointError) {
    patch.status = 'error';
    patch.last_error = `Subscriber ${subscriberId} is still pointing at ${webhookUrl || 'an unknown webhook'}. No order can arrive. ${repointError}`;
  }
  await sb.from('ezcater_connections').update(patch).eq('id', connectionId);

  return { subscriberId, secret, events: [...done], caterers: wired, reused, repointed, webhookUrl, repointError };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }
  const action = String(body?.action || '');
  const opsLocationId = String(body?.ops_location_id || body?.location_id || '');
  if (!action) return json({ error: 'action required' }, 400);

  // The daily menu sync. pg_cron only (public.call_edge_fn sends the service role), never a
  // browser: it touches every venue.
  if (action === 'menu_sync_due') {
    const bearer = (req.headers.get('Authorization') || '').replace('Bearer ', '').trim();
    if (!bearer || bearer !== SERVICE_ROLE) return json({ error: 'Unauthorized' }, 401);
    try {
      const out = await runDueSyncs(sb, askFor, { isSchemaError });
      return json({ ok: true, ...out });
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  }
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

        // The API address, only when the operator typed one. Empty is the live
        // ezCater API and is what everyone gets by default.
        const apiUrl = String(body?.api_url || '').trim() || null;
        if (apiUrl) {
          // Refuse here as well as in the browser: this function is the fence,
          // and an https-only rule enforced only in the UI is not a rule. The
          // address is never logged, in case somebody pasted credentials in it.
          try { resolveEzcaterApi(apiUrl); }
          catch { return json({ error: 'The API address has to start with https://, because your ezCater token travels with every call. Leave it empty to use the live ezCater API.' }, 400); }
        }

        const row: Record<string, unknown> = {
          api_token: apiToken,
          label,
          webhook_url: WEBHOOK_URL,
          status: 'connected',
          connected_by: access.userId === 'service' ? null : access.userId,
        };
        if (apiUrl) row.api_url = apiUrl;

        const { data: conn, error } = await sb.from('ezcater_connections').insert(row).select('id').single();
        if (error || !conn?.id) {
          // Naming a column that is not there fails the WHOLE insert. Say which
          // file fixes it rather than quietly dropping the address and pointing
          // a sandbox token at the live API.
          if (apiUrl && isAbsentColumn(error, 'api_url')) {
            return json({ error: 'This database cannot store an API address yet. Run 20260917_OPS_ezcater_api_url.sql, or leave the API address empty to use the live ezCater API.' }, 400);
          }
          return json({ error: error?.message || 'could not store connection' }, 500);
        }

        // Prove the token before we claim success. A bad token here is the most
        // common setup failure and it is silent otherwise.
        let seen: any[] = [];
        try {
          seen = await listCaterers(apiToken, apiUrl);
        } catch (e) {
          const detail = e instanceof Error ? e.message : String(e);
          await sb.from('ezcater_connections')
            .update({ status: 'error', last_error: detail }).eq('id', conn.id);
          // Do not blame the operator's token for our own bad query.
          if (isSchemaError(e)) {
            console.error('[ezcater-connect] EZCATER SCHEMA MISMATCH on the caterers query:', detail);
            return json({ error: 'We asked ezCater for something their system does not have. This is our bug, not your token.', code: 'schema_mismatch' }, 400);
          }
          return json({ error: `ezCater rejected the token: ${detail}` }, 400);
        }

        // Caterer has uuid, name, storeNumber, live and address. There is no
        // brandName, so brand_name is left alone rather than written as null.
        for (const c of seen) {
          await sb.from('ezcater_caterers').upsert({
            caterer_uuid: String(c?.uuid || ''),
            connection_id: conn.id,
            caterer_name: c?.name || null,
            updated_at: new Date().toISOString(),
          }, { onConflict: 'caterer_uuid' });
        }

        const sub = await subscribe(
          conn.id, apiToken, seen.map((c: any) => String(c?.uuid || '')).filter(Boolean), label, apiUrl,
        );
        const { data: fresh } = await sb.from('ezcater_connections').select('*').eq('id', conn.id).maybeSingle();
        return json({
          ok: true,
          status: publicStatus(fresh),
          caterers: seen.map((c: any) => ({
            caterer_uuid: c?.uuid, caterer_name: c?.name, store_number: c?.storeNumber, live: c?.live,
          })),
          subscribed: sub.events,
          subscribed_caterers: sub.caterers,
          // True means we could not read a fresh webhook secret, because ezCater
          // only ever issues one at creation. Say so plainly in Back Office.
          reused_subscriber: sub.reused,
          // True means that reused subscriber was aimed at someone else's
          // webhook and we moved it to ours. The signing secret is UNCHANGED by
          // that move (ezCater cannot change one), so EZCATER_SIGNING_SECRET
          // must still be the secret issued when the subscriber was created.
          webhook_repointed: sub.repointed,
          webhook_url: sub.webhookUrl,
          // Non null means the subscriber is STILL pointing elsewhere. Back
          // Office must not show this as connected: no order will arrive.
          webhook_repoint_error: sub.repointError,
        });
      }

      case 'list_caterers': {
        const conn = await connectionForLocation(opsLocationId);
        if (!conn?.api_token) return json({ error: 'not connected' }, 400);
        const seen = await listCaterers(conn.api_token, conn.api_url ?? null);
        for (const c of seen) {
          await sb.from('ezcater_caterers').upsert({
            caterer_uuid: String(c?.uuid || ''),
            connection_id: conn.id,
            caterer_name: c?.name || null,
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
        // Deletion is scoped to the CATERER, not to the subscriber, so it has to
        // walk the caterers. Passing a subscriber id here deleted nothing.
        const uuids = await catererUuidsFor(conn.id);
        for (const catererUuid of uuids) {
          await deleteSubscriptions(conn.api_token, catererUuid, conn.api_url ?? null).catch((e: unknown) =>
            console.warn('[ezcater-connect] deleteSubscriptions', catererUuid, ':', e instanceof Error ? e.message : String(e)));
        }
        const sub = await subscribe(conn.id, conn.api_token, uuids, conn.label || null, conn.api_url ?? null);
        return json({
          ok: true, subscriber_id: sub.subscriberId, subscribed: sub.events, subscribed_caterers: sub.caterers,
          reused_subscriber: sub.reused,
          webhook_repointed: sub.repointed,
          webhook_url: sub.webhookUrl,
          webhook_repoint_error: sub.repointError,
        });
      }

      case 'disconnect': {
        const conn = await connectionForLocation(opsLocationId);
        if (conn?.api_token && conn?.id) {
          for (const catererUuid of await catererUuidsFor(conn.id)) {
            await deleteSubscriptions(conn.api_token, catererUuid, conn.api_url ?? null).catch(() => {});
          }
        }
        if (conn?.id) {
          // Cascades ezcater_caterers. ezcater_events and ezcater_order_links are
          // deliberately NOT cascaded: they are the audit trail of real orders
          // and real money, and they outlive the connection.
          await sb.from('ezcater_connections').delete().eq('id', conn.id);
        }
        return json({ ok: true });
      }

      // ── Item matching ───────────────────────────────────────────────────
      // ezcater_item_links is service role only (RLS on, no policies, revoked
      // from anon and authenticated), the same fence as ezcater_order_links.
      // These rows decide where food is routed and what stock is taken, so Back
      // Office reads and writes them HERE and never straight off the table.
      //
      // Both actions answer { enabled: false } when the table is not there,
      // because Peter runs 20260917_OPS_ezcater_item_links.sql by hand and the
      // screen has to work before he does.

      case 'items_list': {
        // PAGED: a synced menu passes PostgREST's 1000 row cap. The sync columns are asked for
        // first and dropped when 20260919m has not run yet (menu_sync_ready false).
        const base = 'kind, ez_key, ez_name, ez_group, menu_item_id, option_id, source, matched_by, seen_count, last_seen_at';
        // ez_only_size: the one size of a single size item, shown so staff never match blind.
        // decided_as: what a person saw when they saved the row, for "look again" below.
        let res = await readAllLinks(sb, opsLocationId, base + ', ez_size_name, ez_only_size, ez_category, synced_at, decided_as');
        let syncReady = true;
        if (!res.ok && isMissingSyncColumn(res.error)) {
          syncReady = false;
          res = await readAllLinks(sb, opsLocationId, base);
        }
        if (!res.ok) {
          if (isAbsentTable(res.error)) return json({ ok: true, enabled: false, links: [] });
          return json({ error: res.error?.message || 'could not read the matches' }, 500);
        }
        let lastSync: any = null;
        if (syncReady) {
          const { data: sy } = await sb.from('ezcater_menu_syncs')
            .select('status, started_at, finished_at, last_ok_at, counts, error')
            .eq('location_id', opsLocationId).maybeSingle();
          lastSync = sy || null;
        }
        // LOOK AGAIN: a staff decision on a synced row made for a different name than the row's
        // exact full name (carried over from before the sync). Worked out here, with the sync's
        // own name rules (lookAgainOf).
        const links = syncReady
          ? res.rows.map((r: any) => { const l = lookAgainOf(r); return { ...r, look_again: l.lookAgain, now_as: l.now }; })
          : res.rows;
        return json({
          ok: true, enabled: true, links, complete: res.complete,
          page_size: LINK_PAGE_SIZE, menu_sync_ready: syncReady, last_sync: lastSync,
        });
      }

      case 'menu_sync': {
        // Staff only: requireAccess above proved a signed in Back Office user of THIS venue (or
        // super_admin, or the service role). A paired till or a kiosk session has no such user.
        const out = await runMenuSync(sb, opsLocationId, { reason: 'staff', makeAsk: askFor, isSchemaError });
        // Always 200: { ok, status, message } is the answer, and the card shows message as is.
        return json(out);
      }

      case 'items_save': {
        // WHICH SIDE OF 20260919m. Before it, a save is exactly main's (a row keyed by the name,
        // the rules orders use then). After it, orders only use SYNCED rows, keyed by their exact
        // full name, so a save names a synced row by its key and only ever UPDATES it: it can
        // decide a row but never create one. A save of any other row after the migration comes
        // from a Back Office tab loaded before it (or before this release) and would decide a row
        // no order reads, so it is refused and the page asks to be reloaded.
        const probe = await sb.from('ezcater_item_links').select('synced_at').eq('location_id', opsLocationId).limit(1);
        if (probe.error && isAbsentTable(probe.error)) return json({ ok: true, enabled: false });
        if (probe.error && !isMissingSyncColumn(probe.error)) return json({ error: probe.error.message }, 500);
        const syncReady = !probe.error;

        const kind = body?.kind === 'option' ? 'option' : 'item';
        const ezName = String(body?.ez_name || '').trim();
        const ezGroup = kind === 'option' ? (String(body?.ez_group || '').trim() || null) : null;
        if (!ezName) return json({ error: 'ez_name required' }, 400);

        const ignored = body?.ignored === true;
        const menuItemId = ignored ? null : (String(body?.menu_item_id || '').trim() || null);
        const optionId = ignored ? null : (String(body?.option_id || '').trim() || null);
        if (kind === 'item' && optionId) return json({ error: 'an item cannot be matched to an option' }, 400);

        const syncedKey = String(body?.ez_key || '').trim();
        if (syncReady && (body?.synced !== true || !isSyncKey(syncedKey))) {
          return json({ error: 'This page is out of date. Reload it, then match again.', code: 'stale_page' }, 409);
        }
        if (!syncReady && body?.synced === true) {
          return json({ error: 'The menu sync is not switched on yet. Reload this page.', code: 'stale_page' }, 409);
        }

        // Verify the target is really ours AND really on this venue, so a bad
        // or stale id cannot be saved as a match that silently routes nothing.
        if (menuItemId) {
          // `not archived is true` and not `archived = false`: archived is null
          // on older rows and those are live items, not hidden ones.
          const { data: mi } = await sb.from('menu_items')
            .select('id').eq('location_id', opsLocationId).eq('id', menuItemId)
            .not('archived', 'is', true).maybeSingle();
          if (!mi) return json({ error: 'that item is not on this menu' }, 400);
        }
        if (optionId) {
          const { data: groups } = await sb.from('modifier_groups')
            .select('options').eq('location_id', opsLocationId);
          const found = (groups || []).some((g: any) =>
            (Array.isArray(g?.options) ? g.options : []).some((o: any) => o && String(o.id) === optionId));
          if (!found) return json({ error: 'that option is not on this menu' }, 400);
        }

        // matched_by carries WHO, and doubles as the "Not on our menu" marker.
        // A cleared row goes back to null, which is the same shape the webhook
        // writes when it first sees a name.
        const matchedBy = ignored ? 'ignored'
          : ((menuItemId || optionId) ? (access.userId === 'service' ? 'service' : access.userId) : null);

        if (syncReady) {
          // A SYNCED ROW, by the key the sync gave it. decided_as is what the person SAW (the
          // name, size or group their screen showed, sent back by the card), never read back
          // from the row: a match made for a different name than the row's exact full name is
          // then flagged to look at again (lookAgainOf), and orders do not use it until it is.
          const decidedAs = fullNameOf({
            kind, name: ezName, group: ezGroup || '', sizeName: kind === 'item' ? String(body?.seen_size || '').trim() : '',
          }).slice(0, 500);
          const { data: upd, error: uErr } = await sb.from('ezcater_item_links')
            .update({
              menu_item_id: menuItemId,
              option_id: optionId,
              source: 'manual',          // a person did this, so a later auto pass must not overrule it
              matched_by: matchedBy,
              decided_as: decidedAs,
              updated_at: new Date().toISOString(),
            })
            .eq('location_id', opsLocationId).eq('kind', kind).eq('ez_key', syncedKey)
            .not('synced_at', 'is', null)
            .select('ez_key');
          if (uErr) {
            if (isAbsentTable(uErr)) return json({ ok: true, enabled: false });
            return json({ error: uErr.message }, 500);
          }
          if (!Array.isArray(upd) || !upd.length) return json({ error: 'That ezCater item is not on the synced menu. Sync the menu, then try again.' }, 404);
          return json({ ok: true, enabled: true, ez_key: syncedKey });
        }

        // BEFORE 20260919m: exactly main's save. The key is rebuilt from the name with the SAME
        // rules the matcher uses at read time, never taken from the client. A key that did not
        // agree with its own name would be a row nothing ever looks up again.
        const ezKey = buildLinkKey({ name: ezName, groupLabel: ezGroup || '' }, kind);
        if (!ezKey) return json({ error: 'that name cannot be matched' }, 400);

        const { error } = await sb.from('ezcater_item_links').upsert({
          location_id: opsLocationId,
          kind,
          ez_key: ezKey,
          ez_name: ezName,
          ez_group: ezGroup,
          menu_item_id: menuItemId,
          option_id: optionId,
          source: 'manual',          // a person did this, so a later auto pass must not overrule it
          matched_by: matchedBy,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'location_id,kind,ez_key' });
        if (error) {
          if (isAbsentTable(error)) return json({ ok: true, enabled: false });
          return json({ error: error.message }, 500);
        }
        return json({ ok: true, enabled: true, ez_key: ezKey });
      }

      default:
        return json({ error: `unknown action: ${action}` }, 400);
    }
  } catch (e) {
    if (e instanceof EzcaterError) {
      // A field we ask for is not in their schema. Nothing the operator can do,
      // and nothing a retry can fix, so name it as ours in plain words and log
      // the field ezCater objected to for whoever fixes the query.
      if (isSchemaError(e)) {
        console.error('[ezcater-connect] EZCATER SCHEMA MISMATCH:', e.message);
        return json({
          error: 'We asked ezCater for something their system does not have. This is our bug, not your setup. Nothing was changed.',
          code: 'schema_mismatch',
        }, 400);
      }
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
