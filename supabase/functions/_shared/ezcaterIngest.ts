// supabase/functions/_shared/ezcaterIngest.ts
//
// ONE WAY AN ezCater ANSWER BECOMES AN order_queue ROW, used by every path that reads an ezCater
// order:
//   * ezcater-webhook          a notification arrived
//   * ezcater-connect prefire  the till's catering release is about to fire it (re-ask first)
//   * ezcater-connect resync   staff pressed "Re-sync from ezCater"
//   * catering-release         the server backstop is about to fire it (re-ask first)
//
// The Supabase client and the ezCater fetch are passed in, so this file has no Deno globals and
// no remote imports and is unit tested under plain node (src/lib/ezcaterIngest.test.js).
//
// THE THREE RULES THIS FILE EXISTS FOR
//
//  1. A FIRED ORDER IS NEVER CHANGED SILENTLY. The row is read, planned (ezcaterWritePlan) and
//     written. Between the read and the write the release can claim kitchen_routed_at. So a plan
//     made for an UNFIRED row is written with `kitchen_routed_at is null` as a condition; when
//     that matches nothing the release won, the row is read again and planned as FIRED, which
//     never moves its time and stamps any change on customer.changedAfterFire for staff.
//
//  2. THE KITCHEN IS NEVER BLOCKED BY ezCater. The pre fire re-ask has a short timeout
//     (EZ_PREFIRE_TIMEOUT_MS). No answer, a failed answer, no token, anything: the order fires
//     as planned and is flagged (customer.ezcaterCheck.ok = false) so staff check ezCater.
//
//  3. A REPLACED ORDER STOPS. ezCater sends nothing for an order it cancels for replacement and
//     its schema has no field linking the two (see ezcaterCatering.js). So when a new order looks
//     like a replacement for one we hold, that one is re-asked at once, and it is re-asked again
//     right before it fires. Whatever ezCater says about THAT order decides.

import { getOrder } from './ezcater.ts';
import { orderToQueueRow, queuePayload, ezLifecycle, EZ_TERMINAL } from './ezcater-map.ts';
import { ezcaterWritePlan, prefireOutcome, likelyReplacement } from './ezcaterCatering.js';
import { DEFAULT_VENUE_TZ, EZ_COMMITTED, ezcaterPrepFor, cateringHoldReason, isEzcaterOrder } from './cateringRules.js';
import { matchQueueRow, MATCH_BUDGET_MS } from './ezcater-match-ingest.ts';

/** How long the pre fire re-ask may wait for ezCater before the order fires as planned. */
export const EZ_PREFIRE_TIMEOUT_MS = 4000;
/** Item matching budget on a re-ask. Shorter than a notification's: the kitchen is waiting. */
export const EZ_PREFIRE_MATCH_BUDGET_MS = 2500;
/** At most this many held orders are re-asked about when one new order arrives. */
export const EZ_REPLACEMENT_MAX_CHECKS = 5;

const EXISTING_COLUMNS = 'ref, source, type, status, sent_at, kitchen_routed_at, customer, event_date, collection_time, items, total';

// ── Reads ────────────────────────────────────────────────────────────────────

/**
 * The venue's clock and catering prep time: the SAME settings a ServOS catering order is timed
 * by. Timezone: Platform locations.timezone (on ops_location_id, then id), then Ops
 * locations.timezone, then Europe/London. Prep: catering_site_settings.prep_time_minutes, or the
 * fallback (EZ_PREP_FALLBACK_MINUTES) with prepFallback true when the venue has not set one.
 */
export async function readCateringVenue(sb: any, platform: any, opsLocationId: string): Promise<{
  timeZone: string; prepMinutes: number; prepFallback: boolean; prepSource: string; tzSource: string; hasCateringSettings: boolean;
}> {
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
    } catch (e) { console.warn('[ezcater] platform timezone read failed:', e instanceof Error ? e.message : String(e)); }
  }
  if (!timeZone) {
    try {
      const { data } = await sb.from('locations').select('timezone').eq('id', opsLocationId).maybeSingle();
      if (data?.timezone) { timeZone = data.timezone; tzSource = 'ops'; }
    } catch { /* default below */ }
  }
  let settings: any = null;
  try {
    const { data } = await sb.from('catering_site_settings').select('prep_time_minutes').eq('location_id', opsLocationId).maybeSingle();
    settings = data || null;
  } catch { /* no settings: the fallback below */ }
  const prep = ezcaterPrepFor(settings);
  return { timeZone: timeZone || DEFAULT_VENUE_TZ, tzSource, hasCateringSettings: !!settings, ...prep };
}

/**
 * The stored order_queue row, if any. kitchen_routed_at is the release's claim. Asked for
 * defensively: without the column the row reads as fired ('unknown'), so nothing ever moves the
 * fire time of an order it cannot prove is unfired.
 */
export async function readExisting(sb: any, locationId: string, ref: string): Promise<any | null> {
  const full = await sb.from('order_queue').select(EXISTING_COLUMNS).eq('location_id', locationId).eq('ref', ref).maybeSingle();
  if (!full.error) return full.data || null;
  const bare = await sb.from('order_queue').select('ref, source, type, status, sent_at, customer, items, total')
    .eq('location_id', locationId).eq('ref', ref).maybeSingle();
  return bare.data ? { ...bare.data, kitchen_routed_at: 'unknown' } : null;
}

/** The token and API address of one connection. api_url is read defensively (20260917 migration). */
export async function readConnection(sb: any, connId: string): Promise<any | null> {
  if (!connId) return null;
  const first = await sb.from('ezcater_connections').select('id, api_token, api_url').eq('id', connId).maybeSingle();
  if (!first.error) return first.data || null;
  const again = await sb.from('ezcater_connections').select('id, api_token').eq('id', connId).maybeSingle();
  return again.data || null;
}

/**
 * Everything needed to re-ask ezCater about one stored order, FENCED TO ITS VENUE: the caterer
 * must be mapped to this very location, so a caller can never read another venue's order.
 */
export async function ezcaterAccessFor(sb: any, locationId: string, ref: string, row: any = null): Promise<
  { ok: true; token: string; apiUrl: string | null; ezOrderId: string; catererUuid: string; priorLink: any }
  | { ok: false; why: string }
> {
  const { data: link } = await sb.from('ezcater_order_links')
    .select('ez_order_id, caterer_uuid, accepted_count, event_at').eq('location_id', locationId).eq('ref', ref).maybeSingle();
  const c = row?.customer || {};
  const ezOrderId = String(link?.ez_order_id || c.ezcater_order_id || (ref.startsWith('EZ-') ? ref.slice(3) : '')).trim();
  const catererUuid = String(link?.caterer_uuid || c.ezcater_caterer_id || '').trim();
  if (!ezOrderId) return { ok: false, why: 'this order has no ezCater id' };
  if (!catererUuid) return { ok: false, why: 'this order has no ezCater caterer' };
  const { data: cat } = await sb.from('ezcater_caterers')
    .select('connection_id, location_id, active').eq('caterer_uuid', catererUuid).maybeSingle();
  if (!cat || cat.location_id !== locationId) return { ok: false, why: 'that ezCater caterer is not mapped to this venue' };
  let conn = cat.connection_id ? await readConnection(sb, cat.connection_id) : null;
  if (!conn?.api_token) {
    const { data: any1 } = await sb.from('ezcater_connections').select('id')
      .eq('status', 'connected').order('connected_at', { ascending: true }).limit(1).maybeSingle();
    conn = any1?.id ? await readConnection(sb, any1.id) : null;
  }
  if (!conn?.api_token) return { ok: false, why: 'ezCater is not connected' };
  return { ok: true, token: conn.api_token, apiUrl: conn.api_url ?? null, ezOrderId, catererUuid, priorLink: link || null };
}

/**
 * Ask ezCater, but never for longer than ms. The fetch is aborted on the deadline, so a hung
 * connection costs the timeout and nothing more. Never throws.
 */
export async function fetchOrderWithin(
  fetchOrder: (signal: AbortSignal) => Promise<any>, ms: number,
): Promise<{ order: any; error: null; timedOut: false } | { order: null; error: string; timedOut: boolean }> {
  const ac = new AbortController();
  let timer: any = null;
  let timedOut = false;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { timedOut = true; try { ac.abort(); } catch { /* noop */ } reject(new Error(`no answer from ezCater within ${Math.round(ms / 1000)} seconds`)); }, ms);
  });
  try {
    const order = await Promise.race([fetchOrder(ac.signal), deadline]);
    if (!order?.uuid) return { order: null, error: 'ezCater returned no order', timedOut: false };
    return { order, error: null, timedOut: false };
  } catch (e) {
    const msg = timedOut ? `no answer from ezCater within ${Math.round(ms / 1000)} seconds` : (e instanceof Error ? e.message : String(e));
    return { order: null, error: msg.slice(0, 300), timedOut };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ── Items ────────────────────────────────────────────────────────────────────

const lname = (v: unknown) => String(v ?? '').trim().toLowerCase();

/**
 * A re-ask gets the lines fresh from ezCater, with no itemId until matching runs, and matching
 * is on a short budget. A line that is the SAME line as before (same place, same name, same
 * size) keeps the match it already had, so a slow menu read never turns a routed ticket into a
 * plain text one. A changed line is matched afresh or stays unmatched, never guessed.
 */
export function carryMatchedItems(newItems: any[], oldItems: any[]): any[] {
  const olds = Array.isArray(oldItems) ? oldItems : [];
  return (Array.isArray(newItems) ? newItems : []).map((line: any, i: number) => {
    const old = olds[i];
    if (!line || line.itemId || !old || !old.itemId) return line;
    if (lname(old.name) !== lname(line.name) || lname(old.sizeName) !== lname(line.sizeName)) return line;
    const oldMods = Array.isArray(old.mods) ? old.mods : [];
    const mods = (Array.isArray(line.mods) ? line.mods : []).map((m: any, j: number) => {
      const om = oldMods[j];
      if (!m || m.itemId || m.optionId || !om || lname(om.label) !== lname(m.label)) return m;
      return { ...m, itemId: om.itemId ?? null, optionId: om.optionId ?? null, ...(om.match ? { match: om.match } : {}) };
    });
    return { ...line, itemId: old.itemId, mods, ...(old.match ? { match: old.match } : {}) };
  });
}

// ── The write ────────────────────────────────────────────────────────────────

const isUniqueViolation = (err: any) => String(err?.code || '') === '23505' || /duplicate key/i.test(String(err?.message || ''));

/**
 * Write one ezCater answer through the write plan (rule 1 above). Returns the plan that was
 * actually written. Never throws for a database answer: { ok: false, error } instead.
 */
export async function writeEzcaterOrder(sb: any, args: {
  order: any; locationId: string;
  venue: { timeZone: string; prepMinutes: number; prepFallback?: boolean };
  priorLink?: any; eventAt?: string | null; requery?: boolean; nowIso: string;
  match?: { budgetMs?: number } | false;
  extraCustomer?: Record<string, unknown> | null;
  log?: (...a: unknown[]) => void;
}): Promise<{ ok: true; plan: any; payload: any; isNew: boolean; link: any; attempts: number } | { ok: false; error: string }> {
  const { order, locationId, venue, nowIso } = args;
  const log = args.log || (() => {});
  const { row, link } = orderToQueueRow(order, locationId, {
    priorAcceptedCount: Number(args.priorLink?.accepted_count) || 0,
    eventAt: args.eventAt ?? null,
    venue: { timeZone: venue.timeZone, prepMinutes: venue.prepMinutes, prepFallback: !!venue.prepFallback },
    requery: !!args.requery,
  });

  let queueRow = row;
  if (args.match !== false) {
    try {
      const m = await matchQueueRow(sb, locationId, row, { budgetMs: args.match?.budgetMs ?? MATCH_BUDGET_MS });
      queueRow = m.row;
      if (m.ran) log('items matched on', row.ref, `${m.matched}/${m.lines} lines`);
    } catch { queueRow = row; }
  }
  if (args.extraCustomer) queueRow = { ...queueRow, customer: { ...(queueRow.customer || {}), ...args.extraCustomer } };
  const terminal = EZ_TERMINAL.has(ezLifecycle(order));

  for (let attempt = 1; attempt <= 3; attempt++) {
    const existing = await readExisting(sb, locationId, row.ref);
    let planned = queueRow;
    if (existing && Array.isArray(existing.items)) planned = { ...queueRow, items: carryMatchedItems(queueRow.items, existing.items) };
    const plan = ezcaterWritePlan({ row: planned, existing, terminal, nowIso });
    const payload = queuePayload(plan.row, !existing, nowIso, { reschedule: plan.reschedule });

    if (!existing) {
      const { error } = await sb.from('order_queue').insert(payload);
      if (error && isUniqueViolation(error)) continue;   // written by a parallel notification: plan against it
      if (error) return { ok: false, error: `order_queue insert failed: ${error.message}` };
    } else if (!plan.fired) {
      // Only while the kitchen still does not have it. If the release claimed it since the read,
      // nothing matches, and the next pass plans it as FIRED.
      const { data, error } = await sb.from('order_queue').update(payload)
        .eq('location_id', locationId).eq('ref', row.ref).is('kitchen_routed_at', null).select('ref');
      if (error) return { ok: false, error: `order_queue update failed: ${error.message}` };
      if (!data?.length) { log('fired between read and write, planning again as fired:', row.ref); continue; }
    } else {
      const { error } = await sb.from('order_queue').update(payload).eq('location_id', locationId).eq('ref', row.ref);
      if (error) return { ok: false, error: `order_queue update failed: ${error.message}` };
    }

    // The link row. A re-ask only refreshes what ezCater told us now: it never rewrites the
    // notification history (event_at, modification_seen_at).
    if (args.requery) {
      const patch = {
        ez_lifecycle: link.ez_lifecycle, accepted_count: link.accepted_count, fire_at: link.fire_at,
        order_type: link.order_type, requeried_at: nowIso, updated_at: nowIso,
      };
      const { data: upd } = await sb.from('ezcater_order_links').update(patch)
        .eq('location_id', locationId).eq('ref', row.ref).select('ref');
      if (!upd?.length) await sb.from('ezcater_order_links').upsert({ ...link, requeried_at: nowIso, updated_at: nowIso }, { onConflict: 'location_id,ref' });
    } else {
      const { error: lErr } = await sb.from('ezcater_order_links').upsert({ ...link, updated_at: nowIso }, { onConflict: 'location_id,ref' });
      if (lErr) log('link upsert failed:', lErr.message);
    }
    return { ok: true, plan, payload, isNew: !existing, link, attempts: attempt };
  }
  return { ok: false, error: 'the order kept changing while it was being written, try again' };
}

// ── Cancelled for replacement ────────────────────────────────────────────────

/**
 * A new ezCater order has just been written. Any order we hold that looks like the one it
 * replaces is re-asked about NOW (rule 3). ezCater says it is dead: it is cancelled with
 * customer.replacedBy, so it never reaches the kitchen (or, if the kitchen already had it,
 * staff are told plainly to make the new one, not both). ezCater says it is live, or cannot be
 * asked: both orders are flagged for staff and the original is re-asked again before it fires.
 */
export async function checkReplacements(sb: any, args: {
  locationId: string; newRow: any; venue: { timeZone: string; prepMinutes: number; prepFallback?: boolean };
  nowIso: string; fetchFor: (access: any) => (signal: AbortSignal) => Promise<any>; timeoutMs?: number;
  log?: (...a: unknown[]) => void;
}): Promise<Array<{ ref: string; outcome: 'replaced' | 'flagged' | 'error'; ezcaterSays: string | null }>> {
  const { locationId, newRow, nowIso } = args;
  const log = args.log || (() => {});
  const out: Array<{ ref: string; outcome: 'replaced' | 'flagged' | 'error'; ezcaterSays: string | null }> = [];
  if (!newRow?.ref || String(newRow.status || '') === 'cancelled') return out;
  let q = sb.from('order_queue').select(EXISTING_COLUMNS)
    .eq('location_id', locationId).eq('source', 'ezcater').neq('ref', newRow.ref)
    .not('status', 'in', '(cancelled,collected)');
  if (newRow.event_date) {
    const d = new Date(`${newRow.event_date}T12:00:00Z`).getTime();
    const day = (k: number) => new Date(d + k * 86400000).toISOString().slice(0, 10);
    q = q.in('event_date', [day(-1), day(0), day(1)]);
  }
  const { data: cands, error } = await q.limit(200);
  if (error) { log('replacement candidates read failed:', error.message); return out; }
  const likely = (cands || []).filter((c: any) => likelyReplacement(newRow, c)).slice(0, EZ_REPLACEMENT_MAX_CHECKS);
  const newNumber = newRow.customer?.ezcater_order_number || null;

  for (const cand of likely) {
    const access = await ezcaterAccessFor(sb, locationId, cand.ref, cand);
    let says: string | null = null;
    if (access.ok) {
      const res = await fetchOrderWithin(args.fetchFor(access), args.timeoutMs ?? EZ_PREFIRE_TIMEOUT_MS);
      if (res.order) {
        says = ezLifecycle(res.order) || null;
        const dead = EZ_TERMINAL.has(says || '') || (!!says && !EZ_COMMITTED.has(says) && says !== 'submitted' && says !== 'draft');
        if (dead) {
          const w = await writeEzcaterOrder(sb, {
            order: res.order.lifecycle && EZ_TERMINAL.has(says || '') ? res.order : { ...res.order, lifecycle: { orderIsCurrently: 'cancelled_for_replacement' } },
            locationId, venue: args.venue, priorLink: access.priorLink, requery: true, nowIso, match: false,
            extraCustomer: { replacedBy: { ref: newRow.ref, orderNumber: newNumber, at: nowIso, ezcaterSaid: says } },
            log,
          });
          out.push({ ref: cand.ref, outcome: w.ok ? 'replaced' : 'error', ezcaterSays: says });
          continue;
        }
      }
    }
    // Live on ezCater, or ezCater could not be asked: both are flagged, neither is stopped.
    const flagOther = { ref: newRow.ref, orderNumber: newNumber, ezcaterSays: says, at: nowIso };
    const flagNew = { ref: cand.ref, orderNumber: cand.customer?.ezcater_order_number || null, ezcaterSays: null, at: nowIso };
    await sb.from('order_queue').update({ customer: { ...(cand.customer || {}), possibleReplacement: flagOther } })
      .eq('location_id', locationId).eq('ref', cand.ref);
    const fresh = await readExisting(sb, locationId, newRow.ref);
    if (fresh) {
      await sb.from('order_queue').update({ customer: { ...(fresh.customer || {}), possibleReplacement: flagNew } })
        .eq('location_id', locationId).eq('ref', newRow.ref);
    }
    out.push({ ref: cand.ref, outcome: 'flagged', ezcaterSays: says });
  }
  return out;
}

// ── The pre fire check ───────────────────────────────────────────────────────

export type PrefireResult = {
  fire: boolean;
  outcome: 'fire' | 'cancelled' | 'awaiting_ezcater_acceptance' | 'rescheduled' | 'fired' | 'missing' | 'collected' | string;
  checked: boolean;
  why?: string | null;
  row?: any;
};

/**
 * Right before an ezCater order fires, ask ezCater what it is NOW (ezCater recommends this,
 * because catering orders are edited for days and Dispatch moves the pickup time). The answer
 * goes through the same write; the result says whether to fire, and hands back the row as it is
 * now (fresh items and times) for the caller to route. The kitchen_routed_at claim stays with the
 * caller (routeKioskOrderPrints on the till, the claim in catering-release), so every order still
 * fires exactly once.
 *
 * NEVER BLOCKS THE KITCHEN (rule 2): no access, no answer in time, a failed answer or a failed
 * save all fire the order as planned, flagged for staff.
 */
export async function prefireCheck(sb: any, platform: any, args: {
  locationId: string; ref: string; nowIso?: string; timeoutMs?: number;
  fetchFor?: (access: any) => (signal: AbortSignal) => Promise<any>;
  log?: (...a: unknown[]) => void;
}): Promise<PrefireResult> {
  const nowIso = args.nowIso || new Date().toISOString();
  const nowMs = Date.parse(nowIso);
  const log = args.log || (() => {});
  const existing = await readExisting(sb, args.locationId, args.ref);
  if (!existing) return { fire: false, outcome: 'missing', checked: false };
  if (existing.kitchen_routed_at) return { fire: false, outcome: 'fired', checked: false, row: existing };
  const plannedHold = cateringHoldReason(existing);
  if (!isEzcaterOrder(existing)) return { fire: !plannedHold, outcome: plannedHold || 'fire', checked: false, row: existing };

  const fetchFor = args.fetchFor || ((a: any) => (signal: AbortSignal) => getOrder(a.token, a.ezOrderId, a.apiUrl, signal));

  // Fire as planned, and say so on the order. Only ever reached while unfired.
  const asPlanned = async (why: string): Promise<PrefireResult> => {
    log('pre fire check could not ask ezCater, firing as planned:', args.ref, why);
    const customer = { ...(existing.customer || {}), ezcaterCheck: { at: nowIso, ok: false, why } };
    await sb.from('order_queue').update({ customer })
      .eq('location_id', args.locationId).eq('ref', args.ref).is('kitchen_routed_at', null)
      .then(() => {}, () => {});
    return { fire: !plannedHold, outcome: plannedHold || 'fire', checked: false, why, row: { ...existing, customer } };
  };

  let access: any;
  try { access = await ezcaterAccessFor(sb, args.locationId, args.ref, existing); } catch (e) { return asPlanned(e instanceof Error ? e.message : String(e)); }
  if (!access.ok) return asPlanned(access.why);

  const res = await fetchOrderWithin(fetchFor(access), args.timeoutMs ?? EZ_PREFIRE_TIMEOUT_MS);
  if (!res.order) return asPlanned(res.timedOut ? 'ezCater did not answer in time' : `ezCater answered with an error: ${res.error}`);

  let venue;
  try { venue = await readCateringVenue(sb, platform, args.locationId); } catch (e) { return asPlanned('the venue settings could not be read'); }
  const w = await writeEzcaterOrder(sb, {
    order: res.order, locationId: args.locationId, venue, priorLink: access.priorLink, requery: true, nowIso,
    match: { budgetMs: EZ_PREFIRE_MATCH_BUDGET_MS },
    extraCustomer: { ezcaterCheck: { at: nowIso, ok: true, lifecycle: ezLifecycle(res.order) || null } },
    log,
  });
  if (!w.ok) return asPlanned(`the fresh answer could not be saved: ${w.error}`);
  if (w.plan.fired) return { fire: false, outcome: 'fired', checked: true, row: w.plan.row };
  const outcome = prefireOutcome(w.plan.row, nowMs, cateringHoldReason);
  const row = { ...existing, ...w.plan.row, sent_at: w.payload.sent_at ?? existing.sent_at, kitchen_routed_at: null };
  return { fire: outcome === 'fire', outcome, checked: true, row };
}

// ── Re-sync from ezCater (staff) ─────────────────────────────────────────────

/**
 * Re-ask ezCater about one stored order and rewrite it through the same write plan. Repairs a
 * row written by older code (HKX77V: 'prep', sent_at at the delivery time, the caterer's clock)
 * and catches a missed notification. Never moves an order that already fired: that path only
 * flags changes. ezcater_order_links.requeried_at records when.
 */
export async function resyncOrder(sb: any, platform: any, args: {
  locationId: string; ref: string; nowIso?: string; timeoutMs?: number;
  fetchFor?: (access: any) => (signal: AbortSignal) => Promise<any>;
  log?: (...a: unknown[]) => void;
}): Promise<{ ok: true; fired: boolean; changed: boolean; row: any; message: string } | { ok: false; error: string }> {
  const nowIso = args.nowIso || new Date().toISOString();
  const log = args.log || (() => {});
  const existing = await readExisting(sb, args.locationId, args.ref);
  if (!existing) return { ok: false, error: 'That order is not on this venue.' };
  if (!isEzcaterOrder(existing)) return { ok: false, error: 'That is not an ezCater order.' };
  const access = await ezcaterAccessFor(sb, args.locationId, args.ref, existing);
  if (!access.ok) return { ok: false, error: `Could not re-sync: ${access.why}.` };
  const fetchFor = args.fetchFor || ((a: any) => (signal: AbortSignal) => getOrder(a.token, a.ezOrderId, a.apiUrl, signal));
  const res = await fetchOrderWithin(fetchFor(access), args.timeoutMs ?? 10000);
  if (!res.order) return { ok: false, error: `Could not reach ezCater: ${res.error}. Nothing was changed.` };
  const venue = await readCateringVenue(sb, platform, args.locationId);
  const w = await writeEzcaterOrder(sb, {
    order: res.order, locationId: args.locationId, venue, priorLink: access.priorLink, requery: true, nowIso,
    extraCustomer: { resyncedAt: nowIso }, log,
  });
  if (!w.ok) return { ok: false, error: `Could not save: ${w.error}` };
  const r = w.plan.row;
  const before = `${existing.status}|${existing.sent_at}|${existing.event_date}|${existing.collection_time}`;
  const after = `${r.status}|${w.payload.sent_at ?? existing.sent_at}|${w.payload.event_date ?? existing.event_date}|${w.payload.collection_time ?? existing.collection_time}`;
  const changed = before !== after || !!w.plan.changedAfterFire;
  let message: string;
  if (w.plan.fired) {
    message = w.plan.changedAfterFire
      ? 'The kitchen already has this order, so its time was not moved. What changed on ezCater is shown on the order.'
      : 'The kitchen already has this order. ezCater shows no change.';
  } else if (r.status === 'cancelled') {
    message = r.customer?.replacedBy ? 'ezCater replaced this order. It will not go to the kitchen.' : 'ezCater says this order is cancelled. It will not go to the kitchen.';
  } else {
    const c = r.customer || {};
    message = `Up to date with ezCater. ${c.event_date ? `${c.event_date} ` : ''}${c.event_time || ''}, goes to the kitchen at ${c.fire_time || 'its fire time'}${c.prepFallback ? ' (60 minute fallback prep, set your catering prep time)' : ''}.`;
  }
  return { ok: true, fired: !!w.plan.fired, changed, row: r, message };
}
