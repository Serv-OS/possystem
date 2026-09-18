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
//   * uncancelled is subscribable but never fires. The order comes back as a later accepted
//     (or rejected) notification, and the write plan RESTORES a cancelled, unfired order to the
//     held catering state with a fresh fire time (_shared/ezcaterCatering.js).
//   * cancelled for replacement sends NOTHING for the original. A new order that looks like its
//     replacement makes us re-ask ezCater about the original at once (checkReplacements), and
//     every ezCater order is re-asked again right before it fires (_shared/ezcaterIngest.ts).
//   * Meal Program (Club Soda) orders never send submitted or accepted, only
//     relish_finalized about 90 minutes before the event. It is a first sight
//     event like any other here.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { verifyEzcaterSignature, getOrder, isPermanent, isSchemaError } from '../_shared/ezcater.ts';
import { ezLifecycle, EZ_TERMINAL } from '../_shared/ezcater-map.ts';
import { readCateringVenue, readConnection, writeEzcaterOrder, checkReplacements, refetchWith } from '../_shared/ezcaterIngest.ts';
import { resyncForUnseen } from '../_shared/ezcaterMenuSync.ts';

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

// readConnection, readCateringVenue and the order write live in _shared/ezcaterIngest.ts, shared
// with the pre fire check and staff "Re-sync from ezCater", so all three write an order the same
// way. readConnection reads api_url defensively (20260917_OPS_ezcater_api_url.sql is run by hand).

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
    const conn = connId ? await readConnection(sb, connId) : null;
    const token = conn?.api_token || '';
    if (!token) {
      // Not strictly transient, but a retry costs nothing and self heals the
      // moment the operator reconnects. The reconciler replays either way.
      await failEvent('no ezCater API token for this caterer', 'error');
      return retry('not connected');
    }

    let order: any = null;
    // When this ezCater read began and came back (review round 4): a write never lets an older
    // answer undo a newer one already on the row (writeEzcaterOrder, answerOlderThanRow).
    const fetchStartedAt = new Date().toISOString();
    let answer: { startedAt: string; receivedAt: string } | null = null;
    try {
      // api_url is the sandbox address when the operator typed one, and null
      // (so, the live ezCater API) for every other connection.
      order = await getOrder(token, entityId, conn?.api_url ?? null);
      answer = { startedAt: fetchStartedAt, receivedAt: new Date().toISOString() };
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
    // catering prep time, and held until then. A venue with NO catering prep time set is timed
    // with the fallback (EZ_PREP_FALLBACK_MINUTES, 60) and the order says so, never with 0.
    const venue = await readCateringVenue(sb, platform, locationId);
    const lifecycle = ezLifecycle(order);
    const terminal = EZ_TERMINAL.has(lifecycle);
    if (venue.prepFallback) {
      console.warn('[ezcater-webhook] NO CATERING PREP TIME SET for', locationId,
        `- timing ${entityId} with the ${venue.prepMinutes} minute fallback. Set it in Back Office, Catering settings.`);
    }

    // 6) + 7) Item matching and the write, in _shared/ezcaterIngest.ts writeEzcaterOrder:
    //   * ITEM MATCHING cannot fail the order and cannot delay it (budgeted, swallows everything).
    //   * THE WRITE PLAN (_shared/ezcaterCatering.js): an order in preparation keeps its progress,
    //     a cancel wins, an uncancel then accept restores a cancelled unfired order; NOT fired yet
    //     means a changed time moves the fire time (a past one becomes now); ALREADY fired means
    //     nothing moves and any change is stamped on customer.changedAfterFire for staff.
    //   * THE RACE: a plan for an unfired row is written only while kitchen_routed_at is still
    //     null. If the release claimed it in between, the row is read again and planned as fired,
    //     so a fired order is never changed without staff being told.
    const writeNow = new Date().toISOString();
    const w = await writeEzcaterOrder(sb, {
      order, answer, locationId, venue, priorLink, eventAt, nowIso: writeNow,
      // The row already holds an answer newer than ours: read ezCater again, never write ours.
      refetch: refetchWith((signal: AbortSignal) => getOrder(token, entityId, conn?.api_url ?? null, signal), 10_000),
      log: (...a: unknown[]) => console.log('[ezcater-webhook]', ...a),
    });
    if (!w.ok) {
      await failEvent(w.error, 'error');
      return retry('queue write failed');
    }
    if (w.stale) {
      // The order already reflects a newer ezCater answer and ezCater could not be read again:
      // ask ezCater to send this notification again rather than write an older answer.
      await failEvent('the order holds a newer ezCater answer and ezCater could not be read again', 'error');
      return retry('stale answer');
    }
    const row = w.plan.row;
    console.log('[ezcater-webhook] timing', row.ref,
      `ready ${row.customer?.readyAt} (${row.customer?.readySource}), prep ${venue.prepMinutes} min`,
      `${venue.prepFallback ? '(FALLBACK, no catering prep set) ' : ''}fires ${w.payload.sent_at ?? '(unchanged)'} on ${venue.timeZone} (${venue.tzSource})`);
    if (w.link.accepted_count > 1) {
      console.warn('[ezcater-webhook] MODIFICATION on', row.ref,
        `- accepted seen ${w.link.accepted_count} times. Accepting this needs acceptModification: true.`);
    }
    if (w.plan.restored) console.warn('[ezcater-webhook] RESTORED after a cancel (uncancelled on ezCater):', row.ref);
    if (w.plan.changedAfterFire) {
      console.warn('[ezcater-webhook] CHANGED AFTER THE KITCHEN HAD IT:', row.ref, w.plan.changedAfterFire.kinds.join(', '));
    }

    // 8) CANCELLED FOR REPLACEMENT. ezCater sends nothing for the original, so a new, live order
    // that looks like a replacement for one we hold makes us re-ask ezCater about that one now.
    // Best effort and bounded: it can never fail or delay this order, which is already written.
    if (w.isNew && !terminal) {
      try {
        const found = await checkReplacements(sb, {
          locationId, newRow: row, venue, nowIso: writeNow,
          fetchFor: (a: any) => (signal: AbortSignal) => getOrder(a.token, a.ezOrderId, a.apiUrl, signal),
          log: (...a: unknown[]) => console.log('[ezcater-webhook]', ...a),
        });
        for (const f of found) console.warn('[ezcater-webhook] possible replacement:', row.ref, 'for', f.ref, f.outcome, `(ezCater says ${f.ezcaterSays ?? 'nothing'})`);
      } catch (e) {
        console.warn('[ezcater-webhook] replacement check failed, order unaffected:', e instanceof Error ? e.message : String(e));
      }
    }

    const nowIso = new Date().toISOString();
    if (cat.connection_id) {
      await sb.from('ezcater_connections')
        .update({ last_event_at: nowIso, last_error: null }).eq('id', cat.connection_id);
    }

    await sb.from('ezcater_events').update({
      status: 'processed', location_id: locationId, error: null, processed_at: nowIso,
    }).eq('notification_id', notificationId);

    // 9) EZCATER REPUBLISHED ITS MENU. The order carried published ids no synced menu row holds
    // (published ids change on every republish), so the menu is synced again, carrying every
    // saved match across by original id, then name. The order is ALREADY written: it matched by
    // name exactly as before, and nothing here can change or delay it. Background, and at most
    // once every 15 minutes per venue (_shared/ezcaterMenuSync.ts resyncForUnseen).
    if (w.menuUnseen?.length) {
      console.log('[ezcater-webhook]', row.ref, 'carries', w.menuUnseen.length, 'ezCater menu ids we have not synced, re-syncing the menu');
      const job = resyncForUnseen(sb, platform, locationId, w.menuUnseen, {
        log: (...a: unknown[]) => console.log('[ezcater-webhook menu sync]', ...a),
      }).then(
        (r: any) => console.log('[ezcater-webhook] menu re-sync:', r?.ok ? 'done' : (r?.skipped || r?.error || 'not run')),
        (e: unknown) => console.warn('[ezcater-webhook] menu re-sync failed, orders unaffected:', e instanceof Error ? e.message : String(e)),
      );
      // deno-lint-ignore no-explicit-any
      const rt = (globalThis as any).EdgeRuntime;
      if (rt?.waitUntil) rt.waitUntil(job);
    }

    // ezCater advises re-querying an order immediately before it goes to the kitchen. That is
    // done by the release (ezcater-connect prefire from the till, and catering-release), with a
    // short timeout that never blocks the kitchen: _shared/ezcaterIngest.ts prefireCheck.
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
