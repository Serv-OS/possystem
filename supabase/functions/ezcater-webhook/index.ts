// supabase/functions/ezcater-webhook/index.ts
//
// ezCater notification receiver (PUBLIC, authenticity is the X-Ezcater-Signature
// HMAC). Same shape as hubrise-webhook, with three differences that matter.
//
//  1. THE BODY IS A POINTER, NOT A PAYLOAD. Every ezCater notification carries
//     "payload": null. It gives us an id, an entity_id (the order), a parent_id
//     (the caterer) and a key. To see the order at all we have to call back with
//     a GraphQL order(id:) query, so ingest is a TWO LEGGED operation and the
//     second leg can fail on its own. The raw notification is therefore written
//     to ezcater_events BEFORE the fetch is attempted, so a failed fetch is
//     replayable forever. ezCater's retry policy is undocumented, which is
//     exactly why we refuse to depend on it.
//
//  2. THERE IS NO ?loc=. HubRise gets one callback per location so it can carry
//     the location in the URL. ezCater allows ONE subscriber per API user
//     covering many caterers, so the location is resolved from parent_id
//     through ezcater_caterers.
//
//  3. STATUS CODES ARE LOAD BEARING. Which codes ezCater treats as success or
//     permanent failure is undocumented, so the rule here is conservative:
//       200  handled, or deliberately ignored (unknown caterer, unmapped
//            caterer, permanently failed fetch). NEVER 4xx for these, a 4xx may
//            be read as a permanent rejection and the notification is gone.
//       401  bad or missing signature only. That is not ezCater retrying into a
//            wall, it is someone else knocking.
//       503  transient. The sender should retry, and the phase 3 reconciler
//            replays from ezcater_events regardless.
//
// ITEM MATCHING (step 6). We have no Menus API, so the venue types its ezCater
// menu into the Partner Portal by hand and the lines arrive with posItemId =
// null. _shared/ezcater-match-ingest.ts matches them to our menu by name before
// the order_queue write, so the ticket routes to a station, depletes stock and
// shows up in product mix. It can never fail an order: on any problem, including
// the window before Peter runs the 20260917 migration, the mapper's own row goes
// through unchanged and the ticket is plain text, exactly as it was before.
//
// Lifecycle quirks handled here:
//   * a MODIFICATION arrives as a SECOND accepted notification for the same
//     order id, because there is no modified event. accepted_count on
//     ezcater_order_links is the only signal, and it is what tells phase 2 to
//     send acceptModification: true.
//   * uncancelled is subscribable but never fires. Nothing waits on it.
//   * Meal Program (Club Soda) orders never send submitted or accepted, only
//     relish_finalized about 90 minutes before the event. It is a first sight
//     event like any other here.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { verifyEzcaterSignature, getOrder, isPermanent, isSchemaError } from '../_shared/ezcater.ts';
import { orderToQueueRow, queuePayload, ezLifecycle, EZ_TERMINAL } from '../_shared/ezcater-map.ts';
import { ezcaterWritePlan } from '../_shared/ezcaterCatering.js';
import { DEFAULT_VENUE_TZ, cateringPrepMinutes } from '../_shared/cateringRules.js';
import { matchQueueRow, MATCH_BUDGET_MS } from '../_shared/ezcater-match-ingest.ts';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, x-ezcater-signature',
};

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
// Optional fast path. When the operator has a single API user, the signing
// secret can live in the function config and we never touch the database before
// the body is proven authentic. Without it we fall back to the stored secrets.
const ENV_SECRET = Deno.env.get('EZCATER_SIGNING_SECRET') ?? '';
// The Platform DB holds locations.timezone, the venue clock (reference_venue_clock_invariant).
const PLATFORM_URL = Deno.env.get('PLATFORM_SUPABASE_URL') ?? '';
const PLATFORM_KEY = Deno.env.get('PLATFORM_SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('PLATFORM_SERVICE_KEY') ?? '';

const sb = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { autoRefreshToken: false, persistSession: false } });
const platform = PLATFORM_URL && PLATFORM_KEY
  ? createClient(PLATFORM_URL, PLATFORM_KEY, { auth: { autoRefreshToken: false, persistSession: false } })
  : null;

const ok = () => new Response('ok', { status: 200, headers: cors });
const retry = (why: string) => new Response(why, { status: 503, headers: cors });

const first = (...vals: unknown[]): string => {
  for (const v of vals) {
    if (v == null) continue;
    const s = String(v).trim();
    if (s) return s;
  }
  return '';
};

/** The signature header's own timestamp, as an ISO instant. Our monotonic guard. */
function sigTimestampIso(header: string | null): string | null {
  if (!header) return null;
  const ts = header.split('.')[0]?.trim();
  if (!ts || !/^\d+$/.test(ts)) return null;
  const raw = Number(ts);
  const ms = raw > 1e12 ? raw : raw * 1000;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Prove the body came from ezCater. The env secret is tried first so a healthy
 * single tenant install does no database work on an unauthenticated request.
 * Only if that is absent or fails do we try the stored subscriber secrets,
 * which is what a multi API user install needs.
 */
async function verifyBody(raw: string, header: string | null): Promise<{ ok: boolean; connectionId: string | null }> {
  if (!header) return { ok: false, connectionId: null };
  if (ENV_SECRET && await verifyEzcaterSignature(raw, header, ENV_SECRET)) {
    return { ok: true, connectionId: null };
  }
  const { data: conns } = await sb.from('ezcater_connections')
    .select('id, signing_secret').eq('status', 'connected').not('signing_secret', 'is', null).limit(20);
  for (const c of conns || []) {
    if (await verifyEzcaterSignature(raw, header, c.signing_secret)) return { ok: true, connectionId: c.id };
  }
  return { ok: false, connectionId: null };
}

/**
 * The token, and the API address to use it against.
 *
 * READ DEFENSIVELY. api_url arrives with 20260917_OPS_ezcater_api_url.sql, which
 * Peter runs by hand, and PostgREST fails the WHOLE select when it is asked for
 * a column that is not there. So it is asked for, and asked for again without it
 * if that is why it failed, exactly as the item matching screen does for
 * menu_items.item_code. Before that file runs, every order fetch still goes to
 * the live ezCater API, which is where it went before any of this existed.
 */
async function readConnection(connId: string): Promise<any | null> {
  const first = await sb.from('ezcater_connections').select('id, api_token, api_url').eq('id', connId).maybeSingle();
  if (!first.error) return first.data || null;
  const again = await sb.from('ezcater_connections').select('id, api_token').eq('id', connId).maybeSingle();
  return again.data || null;
}

/**
 * The venue's clock and catering prep time: the SAME settings a ServOS catering order is timed
 * by (CateringCheckout reads catering_site_settings.prep_time_minutes for this Ops location).
 *
 * Timezone, in order: Platform locations.timezone joined on ops_location_id (then on id, for
 * legacy rows where the two are equal), exactly as src/lib/locationTime.js resolves it; then
 * Ops locations.timezone, which is what catering_public_settings returns to the storefront;
 * then Europe/London. Never ezCater's own zone and never this function's UTC clock.
 *
 * Fail soft: a read that errors falls through to the next source, and no catering settings
 * row means a prep time of 0, the same answer CateringCheckout gives a blank setting.
 */
async function readCateringVenue(opsLocationId: string): Promise<{ timeZone: string; prepMinutes: number; tzSource: string; hasCateringSettings: boolean }> {
  let timeZone = '';
  let tzSource = 'default';
  if (platform) {
    try {
      const a = await platform.from('locations').select('timezone').eq('ops_location_id', opsLocationId).maybeSingle();
      let tz = a.data?.timezone || '';
      if (!tz && !a.data) {
        const b = await platform.from('locations').select('timezone').eq('id', opsLocationId).maybeSingle();
        tz = b.data?.timezone || '';
      }
      if (tz) { timeZone = tz; tzSource = 'platform'; }
    } catch (e) { console.warn('[ezcater-webhook] platform timezone read failed:', e instanceof Error ? e.message : String(e)); }
  }
  if (!timeZone) {
    try {
      const { data } = await sb.from('locations').select('timezone').eq('id', opsLocationId).maybeSingle();
      if (data?.timezone) { timeZone = data.timezone; tzSource = 'ops'; }
    } catch { /* default below */ }
  }
  let prepMinutes = 0;
  let hasCateringSettings = false;
  try {
    const { data } = await sb.from('catering_site_settings').select('prep_time_minutes').eq('location_id', opsLocationId).maybeSingle();
    if (data) { hasCateringSettings = true; prepMinutes = cateringPrepMinutes(data); }
  } catch { /* no settings: 0, as CateringCheckout */ }
  return { timeZone: timeZone || DEFAULT_VENUE_TZ, prepMinutes, tzSource, hasCateringSettings };
}

/**
 * The existing order_queue row, if any. kitchen_routed_at is the release's claim, so it is what
 * says whether the kitchen has this order yet. Asked for defensively: a venue without the column
 * still gets its order written, it simply cannot tell fired from not fired (and so never moves
 * the fire time of an order it cannot prove is unfired).
 */
async function readExisting(locationId: string, ref: string): Promise<any | null> {
  const full = await sb.from('order_queue')
    .select('ref, status, sent_at, kitchen_routed_at, customer, event_date, collection_time')
    .eq('location_id', locationId).eq('ref', ref).maybeSingle();
  if (!full.error) return full.data || null;
  const bare = await sb.from('order_queue')
    .select('ref, status, sent_at, customer')
    .eq('location_id', locationId).eq('ref', ref).maybeSingle();
  return bare.data ? { ...bare.data, kitchen_routed_at: 'unknown' } : null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return ok();

  const raw = await req.text();
  const sigHeader = req.headers.get('x-ezcater-signature');

  // 1) Authenticity. The ONLY 4xx this function ever returns.
  const verified = await verifyBody(raw, sigHeader);
  if (!verified.ok) return new Response('invalid signature', { status: 401, headers: cors });

  let note: any;
  try { note = JSON.parse(raw); } catch {
    // Signed by ezCater but unparseable. Their bug, and a 4xx would only make it
    // vanish, so log it and acknowledge.
    console.error('[ezcater-webhook] signed body was not JSON');
    return ok();
  }

  const notificationId = first(note?.id, note?.notification_id, note?.notificationId, note?.uuid);
  const entityId = first(note?.entity_id, note?.entityId);
  const parentId = first(note?.parent_id, note?.parentId);
  const eventKey = first(note?.key, note?.event, note?.event_type, note?.eventType);
  const eventAt = first(note?.created_at, note?.createdAt, note?.timestamp, note?.occurred_at)
    || sigTimestampIso(sigHeader) || new Date().toISOString();

  if (!notificationId) {
    console.warn('[ezcater-webhook] notification with no id, nothing to dedupe on:', eventKey || '(no key)');
    return ok();
  }

  try {
    // 2) DEDUPE AND DURABILITY, BEFORE ANY NETWORK CALL. The raw notification
    // lands here whole. If the order fetch below dies, this row is the replay.
    const { data: inserted, error: insErr } = await sb.from('ezcater_events').upsert({
      notification_id: notificationId,
      connection_id: verified.connectionId,
      caterer_uuid: parentId || null,
      event_key: eventKey || null,
      entity_id: entityId || null,
      raw: note,
      signature_valid: true,
      status: 'received',
    }, { onConflict: 'notification_id', ignoreDuplicates: true }).select('notification_id');
    if (insErr) {
      console.error('[ezcater-webhook] could not record notification:', insErr.message);
      return retry('event write failed');
    }

    const { data: prior } = await sb.from('ezcater_events')
      .select('status, attempts').eq('notification_id', notificationId).maybeSingle();
    if (!inserted?.length && prior?.status === 'processed') return ok();   // genuine duplicate
    await sb.from('ezcater_events')
      .update({ attempts: (Number(prior?.attempts) || 0) + 1 })
      .eq('notification_id', notificationId);

    const failEvent = async (msg: string, status: 'error' | 'skipped') => {
      await sb.from('ezcater_events')
        .update({ status, error: msg.slice(0, 2000) })
        .eq('notification_id', notificationId);
    };

    if (!entityId) {
      await failEvent(`no entity_id on notification (key=${eventKey || 'none'})`, 'skipped');
      return ok();
    }

    // 3) TENANT FENCE. parent_id is the caterer and it is the ONLY thing in the
    // notification that identifies a venue. An unknown caterer is recorded so
    // the Back Office mapping screen can offer it, then acknowledged. Never a
    // 4xx: ezCater may treat that as permanent and we would lose the chance to
    // replay once the operator maps it.
    const { data: cat } = await sb.from('ezcater_caterers')
      .select('caterer_uuid, connection_id, location_id, active')
      .eq('caterer_uuid', parentId).maybeSingle();

    if (!cat) {
      await sb.from('ezcater_caterers').upsert(
        { caterer_uuid: parentId, connection_id: verified.connectionId },
        { onConflict: 'caterer_uuid', ignoreDuplicates: true },
      );
      console.warn('[ezcater-webhook] unknown caterer', parentId, '- recorded for mapping, event held for replay');
      await failEvent(`unknown caterer ${parentId}`, 'skipped');
      return ok();
    }
    if (!cat.location_id || cat.active === false) {
      console.warn('[ezcater-webhook] caterer', parentId, 'is not mapped to a location, event held for replay');
      await failEvent(`caterer ${parentId} not mapped to a location`, 'skipped');
      return ok();
    }
    const locationId: string = cat.location_id;

    // 4) The second leg. Nothing above this line needed a token.
    // Guard the id before querying: a bare '' against a uuid column is a
    // Postgres type error, not an empty result.
    const connId = cat.connection_id || verified.connectionId || null;
    const conn = connId ? await readConnection(connId) : null;
    const token = conn?.api_token || '';
    if (!token) {
      // Not strictly transient, but a retry costs nothing and self heals the
      // moment the operator reconnects. The reconciler replays either way.
      await failEvent('no ezCater API token for this caterer', 'error');
      return retry('not connected');
    }

    let order: any = null;
    try {
      // api_url is the sandbox address when the operator typed one, and null
      // (so, the live ezCater API) for every other connection.
      order = await getOrder(token, entityId, conn?.api_url ?? null);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);

      // THE UNKNOWN FIELD ALARM. GraphQL throws the WHOLE query away over one
      // field it does not have, and answers 200 while doing it, so this failure
      // reads as "no orders" unless it is named out loud. The raw notification
      // is already in ezcater_events from step 2, so nothing is lost: fix the
      // query, replay the row, and the order still reaches the kitchen.
      if (isSchemaError(e)) {
        console.error(
          '[ezcater-webhook] EZCATER SCHEMA MISMATCH. The order query asks for a field ezCater does not have,',
          'so NOTHING was fetched. Order', entityId, 'is held in ezcater_events for replay. ezCater said:', msg,
        );
        await failEvent(`SCHEMA MISMATCH, order query rejected: ${msg}`, 'error');
        return ok();   // retrying the same bad query forever helps nobody
      }

      await failEvent(`order fetch failed: ${msg}`, 'error');
      // 404 / 403 / feature_not_enabled will never succeed on a retry. Ack so
      // ezCater stops, and leave the row for a human or the reconciler.
      if (isPermanent(e)) { console.error('[ezcater-webhook] permanent fetch failure', entityId, msg); return ok(); }
      return retry('order fetch failed');
    }
    if (!order?.uuid) {
      await failEvent('order query returned nothing', 'error');
      return retry('empty order');
    }

    // 5) Monotonic guard plus the modification count. A modification is a
    // SECOND accepted for an order we have already seen accepted, because
    // ezCater has no modified event.
    const { data: priorLink } = await sb.from('ezcater_order_links')
      .select('accepted_count, event_at, ez_lifecycle').eq('ez_order_id', order.uuid).maybeSingle();

    if (priorLink?.event_at && eventAt && new Date(eventAt) < new Date(priorLink.event_at)) {
      await sb.from('ezcater_events')
        .update({ status: 'processed', location_id: locationId, processed_at: new Date().toISOString() })
        .eq('notification_id', notificationId);
      return ok();   // stale retry, current state is newer
    }

    // THE CATERING RULE (18 Sep 2026). An ezCater order is timed exactly like a ServOS catering
    // order: on the venue's clock, fired to the kitchen at (food ready time) minus the venue's
    // catering prep time, and held until then. See ezCateringTiming in _shared/ezcater-map.ts.
    const venue = await readCateringVenue(locationId);
    const { row, link } = orderToQueueRow(order, locationId, {
      priorAcceptedCount: Number(priorLink?.accepted_count) || 0,
      eventAt,
      venue: { timeZone: venue.timeZone, prepMinutes: venue.prepMinutes },
    });
    console.log('[ezcater-webhook] timing', row.ref,
      `ready ${row.customer?.readyAt} (${row.customer?.readySource}), prep ${venue.prepMinutes} min`,
      `${venue.hasCateringSettings ? '' : '(no catering settings, so 0) '}fires ${row.fire_at} on ${venue.timeZone} (${venue.tzSource})`);

    const lifecycle = ezLifecycle(order);
    const terminal = EZ_TERMINAL.has(lifecycle);
    if (link.accepted_count > 1) {
      console.warn('[ezcater-webhook] MODIFICATION on', row.ref,
        `- accepted seen ${link.accepted_count} times. Accepting this needs acceptModification: true.`);
    }

    // 6) ITEM MATCHING. ezCater gave us no Menus API, so a Partner Portal line
    // arrives with posItemId = null and itemId null means no station routing, no
    // stock, no product mix. This fills itemId in from the venue's saved links
    // and, where one of our items has exactly that name and nothing else does,
    // saves a new link so the next order is instant.
    //
    // IT CANNOT FAIL THE ORDER, AND IT CANNOT DELAY IT. matchQueueRow swallows
    // everything, including the window before the 20260917_OPS_ezcater_item_links
    // migration is run, and returns the mapper's own row. It is also on a clock:
    // past MATCH_BUDGET_MS a slow menu read is abandoned and the order goes
    // through unmatched, which is a plain text ticket and exactly today. This
    // try is the second guard, not the first.
    let queueRow = row;
    try {
      const m = await matchQueueRow(sb, locationId, row, { budgetMs: MATCH_BUDGET_MS });
      queueRow = m.row;
      if (m.ran) {
        console.log('[ezcater-webhook] items matched on', row.ref,
          `- ${m.matched}/${m.lines} lines, ${m.inserted} new links, ${m.bumped} seen`);
      }
    } catch (e) {
      // Unreachable by construction. Here so it stays unreachable.
      console.warn('[ezcater-webhook] item matching threw, order continues unmatched:',
        e instanceof Error ? e.message : String(e));
      queueRow = row;
    }

    // 7) Upsert. onConflict is (location_id, ref): order_queue's primary key has
    // spanned both since 20260806k and a bare 'ref' throws 42P10, which is how
    // inbound channel orders got dropped on the floor once already.
    const existing = await readExisting(locationId, row.ref);

    // What this notification does to the row (_shared/ezcaterCatering.js, unit tested):
    //   * an order already in preparation keeps its progress, a cancellation always wins;
    //   * NOT fired yet (kitchen_routed_at null): a changed time moves the fire time, event date
    //     and time, a cancel just marks it cancelled (the advance list and the release skip it);
    //   * ALREADY fired: sent_at never moves, and any change (items, time, cancel) is stamped on
    //     customer.changedAfterFire so the Orders Hub and every till shows it plainly.
    const writeNow = new Date().toISOString();
    const plan = ezcaterWritePlan({ row: queueRow, existing, terminal, nowIso: writeNow });
    if (plan.changedAfterFire) {
      console.warn('[ezcater-webhook] CHANGED AFTER THE KITCHEN HAD IT:', row.ref, plan.changedAfterFire.kinds.join(', '));
    }

    const { error: qErr } = await sb.from('order_queue')
      .upsert(queuePayload(plan.row, !existing, writeNow, { reschedule: plan.reschedule }), { onConflict: 'location_id,ref' });
    if (qErr) {
      await failEvent(`order_queue upsert failed: ${qErr.message}`, 'error');
      return retry('queue write failed');
    }

    const nowIso = new Date().toISOString();
    const { error: lErr } = await sb.from('ezcater_order_links')
      .upsert({ ...link, updated_at: nowIso }, { onConflict: 'location_id,ref' });
    if (lErr) console.warn('[ezcater-webhook] link upsert failed:', lErr.message);

    if (cat.connection_id) {
      await sb.from('ezcater_connections')
        .update({ last_event_at: nowIso, last_error: null }).eq('id', cat.connection_id);
    }

    await sb.from('ezcater_events').update({
      status: 'processed', location_id: locationId, error: null, processed_at: nowIso,
    }).eq('notification_id', notificationId);

    // Reminder for phase 3, not a TODO in this file: ezCater explicitly advises
    // re-querying an order immediately before it goes to the kitchen, because
    // catering orders get edited for days and a "Cancelled for Replacement"
    // sends NO notification at all for the original. ezcater_order_links.fire_at
    // is the column that cron keys on, and it is now the KITCHEN fire instant.
    return ok();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[ezcater-webhook] unhandled:', msg);
    await sb.from('ezcater_events')
      .update({ status: 'error', error: msg.slice(0, 2000) })
      .eq('notification_id', notificationId).then(() => {}, () => {});
    return retry('error');
  }
});
