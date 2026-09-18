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
//                       clear it back to unmatched
//
//     recompute_prep -> the venue's catering prep time changed: re-time every ezCater order
//                       the kitchen does not have yet (Back Office calls it after a save)
//
//   Three ORDER actions, each with its own fence (they are not Back Office only):
//     undo_replacement -> staff say two ezCater orders are NOT a replacement pair: clear the
//                       marks and let ezCater's current answer decide. Same fence as resync.
//     prefire        -> the till's catering release asks ezCater about one order right
//                       before firing it (ezCater advises this). Service role, staff of the
//                       venue, or a till paired to the venue. Answers { fire, outcome, row }
//                       and NEVER blocks the kitchen: no answer in time means fire as planned.
//     resync_order   -> staff "Re-sync from ezCater": re-ask ezCater about one order and
//                       rewrite it through the same write plan. Staff only: a Back Office user
//                       who is staff of the venue, or a till of the venue plus a staff PIN.
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
  isSandboxApi, resolveEzcaterApi,
} from '../_shared/ezcater.ts';
import { buildLinkKey } from '../_shared/ezcaterMatch.ts';
import { prefireCheck, resyncOrder, readCateringVenue, undoReplacement, recomputePrepForVenue } from '../_shared/ezcaterIngest.ts';
import { staffForLocation, deviceAtLocation, staffActor, platformLocation } from '../_shared/staffAuthority.ts';
import { EZ_PREP_FALLBACK_MINUTES } from '../_shared/cateringRules.js';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const sb = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { autoRefreshToken: false, persistSession: false } });
// Platform: company roles for the staff rule, and locations.timezone for the venue clock.
const PLATFORM_URL = Deno.env.get('PLATFORM_SUPABASE_URL') ?? '';
const PLATFORM_KEY = Deno.env.get('PLATFORM_SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('PLATFORM_SERVICE_KEY') ?? '';
const platform = PLATFORM_URL && PLATFORM_KEY
  ? createClient(PLATFORM_URL, PLATFORM_KEY, { auth: { autoRefreshToken: false, persistSession: false } })
  : null;

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

/** The bearer, as a user (or the service role). null when there is none or it is not valid. */
async function callerOf(req: Request): Promise<{ service: boolean; user: any | null }> {
  const token = (req.headers.get('Authorization') || '').replace('Bearer ', '').trim();
  if (!token) return { service: false, user: null };
  if (token === SERVICE_ROLE) return { service: true, user: null };
  try {
    const { data: { user } } = await sb.auth.getUser(token);
    return { service: false, user: user || null };
  } catch { return { service: false, user: null }; }
}

/**
 * Who may run a CONFIG action (connect_token, list_caterers, map_caterer, unmap_caterer,
 * set_policy, resubscribe, disconnect, items_list, items_save, recompute_prep, status): the
 * service role, or Back Office staff of this venue under the strict rule in
 * _shared/staffAuthority.ts (never an anonymous session; super_admin, a user_locations row for the
 * venue, or a company role that really grants it). user_profiles.location_id and org_id are NOT
 * trusted: any signed in user can write them on any row today (review round 3, F).
 */
async function requireAccess(req: Request, opsLocationId: string): Promise<{ ok: true; userId: string } | { ok: false; res: Response }> {
  const { service, user } = await callerOf(req);
  if (service) return { ok: true, userId: 'service' };
  if (!user) return { ok: false, res: json({ error: 'Unauthorized' }, 401) };
  if (!(await staffForLocation(sb, platform, user, opsLocationId))) return { ok: false, res: json({ error: 'No access to this location' }, 403) };
  return { ok: true, userId: user.id };
}

/** The company that owns an Ops location (Platform locations.company_id), or null. */
async function venueCompany(opsLocationId: string): Promise<string | null> {
  const loc = await platformLocation(platform, opsLocationId);
  return loc.companyId ? String(loc.companyId) : null;
}

/**
 * The company an ezCater connection belongs to: its company_id (written by connect_token from
 * this release on), else the company of a venue one of its caterers is mapped to (a connection
 * made before, whose company_id was never written). null when neither says.
 */
async function connectionCompany(conn: any): Promise<string | null> {
  if (!conn?.id) return null;
  if (conn.company_id) return String(conn.company_id);
  const { data: cats } = await sb.from('ezcater_caterers').select('location_id')
    .eq('connection_id', conn.id).not('location_id', 'is', null).limit(5);
  for (const c of cats || []) {
    const co = await venueCompany(String(c.location_id));
    if (co) return co;
  }
  return null;
}

/**
 * The connection serving a location: the one its mapped caterer belongs to, else a connected
 * row OF THE SAME COMPANY (the state every operator starts in, before any caterer is mapped).
 * NEVER another company's connection (review round 3, F): the old fallback was "the oldest
 * connected row", which let staff of one company see, map against, resubscribe or DISCONNECT
 * another company's ezCater. A venue whose company cannot be told gets null (not connected).
 */
async function connectionForLocation(opsLocationId: string): Promise<any | null> {
  const { data: cat } = await sb.from('ezcater_caterers')
    .select('connection_id').eq('location_id', opsLocationId).not('connection_id', 'is', null).limit(1).maybeSingle();
  if (cat?.connection_id) {
    const { data } = await sb.from('ezcater_connections').select('*').eq('id', cat.connection_id).maybeSingle();
    if (data) return data;
  }
  const company = await venueCompany(opsLocationId);
  if (!company) return null;
  const { data: rows } = await sb.from('ezcater_connections')
    .select('*').eq('status', 'connected').order('connected_at', { ascending: true }).limit(20);
  for (const c of rows || []) {
    if (await connectionCompany(c) === company) return c;
  }
  return null;
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
  if (!opsLocationId) return json({ error: 'ops_location_id required' }, 400);

  // ── Order actions, each with its own fence ──────────────────────────────────
  if (action === 'prefire' || action === 'resync_order' || action === 'undo_replacement') {
    const ref = String(body?.ref || '').trim();
    if (!ref) return json({ error: 'ref required' }, 400);
    const { service, user } = await callerOf(req);
    try {
      if (action === 'prefire') {
        // The till's own catering release. What it can do is bounded: re-ask ezCater about an
        // order of THIS venue and save what ezCater says. It never fires anything itself.
        const allowed = service || (!!user && (await staffForLocation(sb, platform, user, opsLocationId) || await deviceAtLocation(sb, user, opsLocationId)));
        if (!allowed) return json({ error: 'No access to this location' }, 403);
        const r = await prefireCheck(sb, platform, {
          locationId: opsLocationId, ref,
          log: (...a: unknown[]) => console.log('[ezcater-connect prefire]', ...a),
        });
        const row = r.row ? {
          ref: r.row.ref, type: r.row.type ?? null, source: r.row.source ?? 'ezcater', status: r.row.status,
          items: r.row.items || [], customer: r.row.customer || null, sent_at: r.row.sent_at ?? null,
          collection_time: r.row.collection_time ?? null, event_date: r.row.event_date ?? null,
        } : null;
        return json({ ok: true, fire: r.fire, outcome: r.outcome, checked: r.checked, why: r.why ?? null, row });
      }
      const who = service ? { ok: true as const, by: 'service' } : await staffActor(sb, platform, user, opsLocationId, body?.pin);
      if (!who.ok) return json({ error: who.error }, who.status);
      if (action === 'undo_replacement') {
        // Staff say these two ezCater orders are NOT a replacement pair. The marks are cleared
        // and, if the kitchen does not have it yet, the order becomes whatever ezCater says now.
        const u = await undoReplacement(sb, platform, {
          locationId: opsLocationId, ref, by: who.by,
          log: (...a: unknown[]) => console.log('[ezcater-connect undo]', ...a),
        });
        console.log('[ezcater-connect] undo replacement', ref, 'by', who.by, u.ok ? u.message : u.error);
        if (!u.ok) return json({ ok: false, error: u.error });
        return json({ ok: true, message: u.message, resynced: u.resynced });
      }
      const r = await resyncOrder(sb, platform, {
        locationId: opsLocationId, ref,
        log: (...a: unknown[]) => console.log('[ezcater-connect resync]', ...a),
      });
      console.log('[ezcater-connect] resync', ref, 'by', who.by, r.ok ? (r.fired ? 'fired order, not moved' : 'rewritten') : r.error);
      if (!r.ok) return json({ ok: false, error: r.error });
      return json({ ok: true, fired: r.fired, changed: r.changed, message: r.message, status: r.row?.status ?? null });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[ezcater-connect]', action, ref, msg);
      // A prefire that breaks must still let the kitchen have the order.
      if (action === 'prefire') return json({ ok: false, fire: true, outcome: 'fire', checked: false, why: 'the check failed', row: null });
      if (action === 'undo_replacement') return json({ ok: false, error: 'Could not undo. Nothing was changed.' });
      return json({ ok: false, error: 'Could not re-sync this order. Nothing was changed.' });
    }
  }

  const access = await requireAccess(req, opsLocationId);
  if (!access.ok) return access.res;

  try {
    switch (action) {
      case 'status': {
        const conn = await connectionForLocation(opsLocationId);
        // Caterers already on this venue, plus anything the webhook has seen but
        // nobody has mapped yet, so the operator can adopt it.
        // Unmapped caterers of THIS company's connection only: never another company's caterer
        // names, and never one this venue could then map and receive another company's orders.
        const [{ data: mine }, { data: unmapped }] = await Promise.all([
          sb.from('ezcater_caterers').select('*').eq('location_id', opsLocationId),
          conn?.id
            ? sb.from('ezcater_caterers').select('*').is('location_id', null).eq('connection_id', conn.id)
            : Promise.resolve({ data: [] as any[] }),
        ]);
        // No catering prep time set means every ezCater order here is timed with the fallback.
        // The Connect screen says so until the venue sets one.
        let cateringPrep: any = null;
        try {
          const v = await readCateringVenue(sb, platform, opsLocationId);
          cateringPrep = { set: !v.prepFallback, minutes: v.prepFallback ? null : v.prepMinutes, fallback_minutes: EZ_PREP_FALLBACK_MINUTES };
        } catch { cateringPrep = null; }
        return json({
          ok: true,
          status: publicStatus(conn),
          caterers: (mine || []).map(catererRow),
          unmapped: (unmapped || []).map(catererRow),
          catering_prep: cateringPrep,
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
          // The company this connection belongs to, so it is never used for another company's
          // venue (connectionForLocation, ezcaterAccessFor). Column from 20260825e_ezcater.sql.
          company_id: await venueCompany(opsLocationId),
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
        // The caterer must belong to THIS company's ezCater (review round 3, F): mapping another
        // company's caterer here would route that company's orders to this venue. A caterer
        // mapped to another venue is unmapped there first, never taken over.
        const { data: known } = await sb.from('ezcater_caterers')
          .select('connection_id, location_id').eq('caterer_uuid', catererUuid).maybeSingle();
        if (known?.location_id && known.location_id !== opsLocationId) {
          return json({ error: 'That ezCater caterer is mapped to another venue. Unmap it there first.' }, 409);
        }
        let connId: string | null = conn?.id || null;
        if (known?.connection_id && known.connection_id !== connId) {
          const { data: theirs } = await sb.from('ezcater_connections').select('*').eq('id', known.connection_id).maybeSingle();
          const [mineCo, theirCo] = await Promise.all([venueCompany(opsLocationId), connectionCompany(theirs)]);
          if (!mineCo || !theirCo || mineCo !== theirCo) return json({ error: 'That ezCater caterer belongs to another ezCater connection.' }, 403);
          connId = known.connection_id;
        }
        if (!connId) return json({ error: 'Connect ezCater for this venue first.' }, 400);
        const { error } = await sb.from('ezcater_caterers').upsert({
          caterer_uuid: catererUuid,
          connection_id: connId,
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

      // ── The venue's catering prep time changed (review round 3, C) ──────
      // Back Office calls this right after saving Catering settings. Every ezCater order the
      // kitchen does not have yet is re-timed on the new prep time (ready time minus prep);
      // one whose new fire moment is already past fires now and is flagged late. The
      // catering-release cron runs the same sweep every 5 minutes as the backstop.
      case 'recompute_prep': {
        const r = await recomputePrepForVenue(sb, platform, {
          locationId: opsLocationId,
          log: (...a: unknown[]) => console.log('[ezcater-connect recompute_prep]', ...a),
        });
        return json({ ok: true, checked: r.checked, retimed: r.retimed, late: r.late });
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
        const { data, error } = await sb.from('ezcater_item_links')
          .select('kind, ez_key, ez_name, ez_group, menu_item_id, option_id, source, matched_by, seen_count, last_seen_at')
          .eq('location_id', opsLocationId)
          .order('last_seen_at', { ascending: false, nullsFirst: false })
          .limit(1000);
        if (error) {
          if (isAbsentTable(error)) return json({ ok: true, enabled: false, links: [] });
          return json({ error: error.message }, 500);
        }
        return json({ ok: true, enabled: true, links: data || [] });
      }

      case 'items_save': {
        const kind = body?.kind === 'option' ? 'option' : 'item';
        const ezName = String(body?.ez_name || '').trim();
        const ezGroup = kind === 'option' ? (String(body?.ez_group || '').trim() || null) : null;
        if (!ezName) return json({ error: 'ez_name required' }, 400);

        // The key is rebuilt from the name with the SAME rules the matcher uses
        // at read time, never taken from the client. A key that did not agree
        // with its own name would be a row nothing ever looks up again.
        const ezKey = buildLinkKey({ name: ezName, groupLabel: ezGroup || '' }, kind);
        if (!ezKey) return json({ error: 'that name cannot be matched' }, 400);

        const ignored = body?.ignored === true;
        const menuItemId = ignored ? null : (String(body?.menu_item_id || '').trim() || null);
        const optionId = ignored ? null : (String(body?.option_id || '').trim() || null);
        if (kind === 'item' && optionId) return json({ error: 'an item cannot be matched to an option' }, 400);

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
