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
//     right before it fires. Whatever ezCater says about THAT order decides, and ONLY a cancel is
//     proof it is dead (a 'rejected' is not: review round 3).
//
//  4. NO STALE OVERWRITES (review round 3). Every write to an existing order_queue row is
//     conditional on the row being exactly as it was read: `updated_at` is stamped by the
//     trg_order_queue_updated_at trigger on EVERY update from anyone (a till, Back Office, this
//     file), so `.eq('updated_at', <as read>)` matches nothing if anything wrote in between, and
//     the write is planned again from a fresh read. A flag write (patchCustomer) reads, changes
//     only its own keys, and writes with the same guard. Nothing writes a customer jsonb read
//     before a slow ezCater call.
//
//  5. NO OLDER ezCater ANSWER UNDOES A NEWER ONE (review round 4). The updated_at guard proves
//     only that the row did not change since the RE-read, not that our ezCater answer is newer
//     than one written meanwhile (a cancel landing while a pre fire check matched items). Every
//     answer is stamped on the row with when its read began and came back
//     (customer.ezcaterAnswer); an answer whose read began before the row's answer came back is
//     never written (writeEzcaterOrder), it is read again from ezCater or dropped.
//
//  6. THE BACKSTOP ONLY BACKS UP (review round 4). Nothing here fires an order. A re-ask may move
//     sent_at; the till's release fires it (printing and production centres), and the
//     catering-release cron fires only what the tills have not claimed after its grace window.

import { getOrder } from './ezcater.ts';
import { orderToQueueRow, queuePayload, ezLifecycle, EZ_TERMINAL } from './ezcater-map.ts';
import { ezcaterWritePlan, prefireOutcome, likelyReplacement, lateFirePlan, answerOlderThanRow } from './ezcaterCatering.js';
import {
  DEFAULT_VENUE_TZ, ezcaterPrepFor, cateringHoldReason, isEzcaterOrder,
  cateringFireMs, venueWallClock, CATERING_STALE_FLOOR_MS,
} from './cateringRules.js';
import { matchQueueRow, MATCH_BUDGET_MS } from './ezcater-match-ingest.ts';
import { runWithBudget } from './budget.js';

/** How long the pre fire re-ask may wait for ezCater before the order fires as planned. */
export const EZ_PREFIRE_TIMEOUT_MS = 4000;
/** Item matching budget on a re-ask. Shorter than a notification's: the kitchen is waiting. */
export const EZ_PREFIRE_MATCH_BUDGET_MS = 2500;
/** At most this many held orders are re-asked about when one new order arrives. */
export const EZ_REPLACEMENT_MAX_CHECKS = 5;

const EXISTING_COLUMNS = 'ref, location_id, source, type, status, sent_at, kitchen_routed_at, updated_at, customer, event_date, collection_time, items, total';

/** How many times a guarded write reads and plans again before giving up. */
const WRITE_ATTEMPTS = 4;

/**
 * One ezCater answer's time: when the read began and when it came back (review round 4). Written
 * on the row as customer.ezcaterAnswer, so a later write can tell whether ITS answer is newer
 * than the one the row already holds (answerOlderThanRow).
 */
export type EzAnswer = { startedAt: string; receivedAt: string };

// ── Reads ────────────────────────────────────────────────────────────────────

/**
 * The venue's clock and catering prep time: the SAME settings a ServOS catering order is timed
 * by. Timezone: Platform locations.timezone (on ops_location_id, then id), then Ops
 * locations.timezone, then Europe/London. Prep: catering_site_settings.prep_time_minutes, or the
 * fallback (EZ_PREP_FALLBACK_MINUTES) with prepFallback true when the venue has not set one.
 *
 * READ FAILURES ARE NOT "NOT SET" (review round 4). prepReadOk is false when the settings read
 * failed (an error answer or a throw), and tzReadOk is false when a timezone read failed and no
 * timezone was found. The fallback values are still returned, for a brand new order that needs
 * SOME time, but nothing may RE-TIME an order it already has on them: writeEzcaterOrder keeps
 * the order's own prep and clock, and recomputePrepForVenue changes nothing.
 */
export async function readCateringVenue(sb: any, platform: any, opsLocationId: string): Promise<{
  timeZone: string; prepMinutes: number; prepFallback: boolean; prepSource: string; tzSource: string; hasCateringSettings: boolean;
  prepReadOk: boolean; tzReadOk: boolean;
}> {
  let timeZone = '';
  let tzSource = 'default';
  let tzFailed = false;
  if (platform) {
    try {
      const a = await platform.from('locations').select('timezone').eq('ops_location_id', opsLocationId).maybeSingle();
      if (a?.error) tzFailed = true;
      let tz = a?.data?.timezone || '';
      if (!tz && !a?.data) {
        const b = await platform.from('locations').select('timezone').eq('id', opsLocationId).maybeSingle();
        if (b?.error) tzFailed = true;
        tz = b?.data?.timezone || '';
      }
      if (tz) { timeZone = tz; tzSource = 'platform'; }
    } catch (e) { tzFailed = true; console.warn('[ezcater] platform timezone read failed:', e instanceof Error ? e.message : String(e)); }
  }
  if (!timeZone) {
    try {
      const o = await sb.from('locations').select('timezone').eq('id', opsLocationId).maybeSingle();
      if (o?.error) tzFailed = true;
      if (o?.data?.timezone) { timeZone = o.data.timezone; tzSource = 'ops'; }
    } catch { tzFailed = true; }
  }
  let settings: any = null;
  let prepReadOk = true;
  try {
    const r = await sb.from('catering_site_settings').select('prep_time_minutes').eq('location_id', opsLocationId).maybeSingle();
    if (r?.error) { prepReadOk = false; console.warn('[ezcater] catering settings read failed:', r.error.message || String(r.error)); }
    else settings = r?.data || null;
  } catch (e) { prepReadOk = false; console.warn('[ezcater] catering settings read failed:', e instanceof Error ? e.message : String(e)); }
  const prep = ezcaterPrepFor(settings);
  return {
    timeZone: timeZone || DEFAULT_VENUE_TZ, tzSource, hasCateringSettings: !!settings, ...prep,
    prepReadOk, tzReadOk: !!timeZone || !tzFailed,
  };
}

/**
 * The venue an EXISTING order is re-timed on (review round 4): a setting whose read failed is
 * taken from the order itself (the prep and clock it was last timed with), never from the
 * fallback. A failed read changes nothing.
 */
export function venueForExisting(venue: any, existing: any): any {
  if (!existing) return venue;
  const c = existing.customer || {};
  let v = venue;
  if (venue?.prepReadOk === false && Number.isFinite(Number(c.prepMinutes)) && c.prepMinutes !== null && c.prepMinutes !== '') {
    v = { ...v, prepMinutes: Number(c.prepMinutes), prepFallback: !!c.prepFallback };
  }
  if (venue?.tzReadOk === false && c.venueTimeZone) v = { ...v, timeZone: String(c.venueTimeZone) };
  return v;
}

/**
 * The stored order_queue row, if any. kitchen_routed_at is the release's claim. Asked for
 * defensively: without the column the row reads as fired ('unknown'), so nothing ever moves the
 * fire time of an order it cannot prove is unfired.
 */
export async function readExisting(sb: any, locationId: string, ref: string): Promise<any | null> {
  const full = await sb.from('order_queue').select(EXISTING_COLUMNS).eq('location_id', locationId).eq('ref', ref).maybeSingle();
  if (!full.error) return full.data || null;
  const bare = await sb.from('order_queue').select('ref, location_id, source, type, status, sent_at, updated_at, customer, items, total')
    .eq('location_id', locationId).eq('ref', ref).maybeSingle();
  return bare.data ? { ...bare.data, kitchen_routed_at: 'unknown' } : null;
}

/**
 * THE GUARDED UPDATE (rule 4). Writes `payload` to one row only while it is exactly as `existing`
 * was read: the same updated_at (bumped by the trigger on every update), and, for a plan made for
 * an unfired row, kitchen_routed_at still null. { matched: false } means someone wrote in between:
 * read again and plan again. A row read without updated_at (it cannot happen on the baseline, the
 * column and its trigger are in 000_baseline_ops.sql) is guarded by kitchen_routed_at alone.
 */
export async function guardedUpdate(sb: any, locationId: string, ref: string, existing: any, payload: any,
  opts: { unfiredOnly?: boolean } = {}): Promise<{ matched: boolean; error: string | null }> {
  let q = sb.from('order_queue').update(payload).eq('location_id', locationId).eq('ref', ref);
  if (opts.unfiredOnly) q = q.is('kitchen_routed_at', null);
  if (existing?.updated_at) q = q.eq('updated_at', existing.updated_at);
  const { data, error } = await q.select('ref');
  if (error) return { matched: false, error: error.message || String(error) };
  return { matched: !!data?.length, error: null };
}

/**
 * Change ONLY some keys of one row's customer jsonb, never the rest (rule 4): read the row now,
 * let `change` return the new customer (or null to leave it alone), write it with the guard, and
 * start again from a fresh read if anything wrote in between. Never throws.
 */
export async function patchCustomer(sb: any, locationId: string, ref: string,
  change: (customer: any, row: any) => any | null,
  opts: { unfiredOnly?: boolean } = {}): Promise<{ ok: boolean; written: boolean; row: any | null; error?: string }> {
  for (let attempt = 1; attempt <= WRITE_ATTEMPTS; attempt++) {
    let row: any;
    try { row = await readExisting(sb, locationId, ref); } catch (e) { return { ok: false, written: false, row: null, error: e instanceof Error ? e.message : String(e) }; }
    if (!row) return { ok: true, written: false, row: null };
    if (opts.unfiredOnly && row.kitchen_routed_at) return { ok: true, written: false, row };
    const before = row.customer && typeof row.customer === 'object' ? row.customer : {};
    const next = change({ ...before }, row);
    if (!next) return { ok: true, written: false, row };
    const g = await guardedUpdate(sb, locationId, ref, row, { customer: next }, { unfiredOnly: !!opts.unfiredOnly });
    if (g.error) return { ok: false, written: false, row, error: g.error };
    if (g.matched) return { ok: true, written: true, row: { ...row, customer: next } };
  }
  return { ok: false, written: false, row: null, error: 'the order kept changing, try again' };
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
  // ONLY the caterer's own connection. There used to be a fallback to "the oldest connected row",
  // which on a multi tenant database is another company's ezCater token (review round 3, F).
  // A caterer with no connection of its own is not connected: the check fires as planned, flagged.
  const conn = cat.connection_id ? await readConnection(sb, cat.connection_id) : null;
  if (!conn?.api_token) return { ok: false, why: 'ezCater is not connected for this caterer' };
  return { ok: true, token: conn.api_token, apiUrl: conn.api_url ?? null, ezOrderId, catererUuid, priorLink: link || null };
}

/**
 * Ask ezCater, but never for longer than ms. The fetch is aborted on the deadline, so a hung
 * connection costs the timeout and nothing more. Never throws.
 */
export async function fetchOrderWithin(
  fetchOrder: (signal: AbortSignal) => Promise<any>, ms: number, clock: () => number = Date.now,
): Promise<{ order: any; error: null; timedOut: false; answer: EzAnswer } | { order: null; error: string; timedOut: boolean }> {
  const ac = new AbortController();
  let timer: any = null;
  let timedOut = false;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { timedOut = true; try { ac.abort(); } catch { /* noop */ } reject(new Error(`no answer from ezCater within ${Math.round(ms / 1000)} seconds`)); }, ms);
  });
  // When the read BEGAN and when it came back: the answer is true somewhere in between
  // (answerOlderThanRow, review round 4).
  const startedAt = new Date(clock()).toISOString();
  try {
    const order = await Promise.race([fetchOrder(ac.signal), deadline]);
    if (!order?.uuid) return { order: null, error: 'ezCater returned no order', timedOut: false };
    return { order, error: null, timedOut: false, answer: { startedAt, receivedAt: new Date(clock()).toISOString() } };
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
 *
 * NO OLDER ANSWER UNDOES A NEWER ONE (review round 4, rule 5). `answer` says when this ezCater
 * read began and came back, and is written on the row (customer.ezcaterAnswer). When the row
 * already holds an answer that came back after this read BEGAN (answerOlderThanRow), this answer
 * may be older than it: a pre fire check that read "accepted", then a cancel written while it
 * matched items, would otherwise revive the cancelled order. Such an answer is never written.
 * With `refetch` the order is read from ezCater again (a read that begins now is provably newer)
 * and that answer is planned instead; without it, or when the fresh read fails, nothing is
 * written and { stale: true } comes back with the row as it is (it already holds a newer answer).
 *
 * A VENUE SETTING THAT COULD NOT BE READ CHANGES NOTHING (review round 4): an existing order is
 * re-timed on its own last prep and clock when the read failed (venueForExisting).
 */
export async function writeEzcaterOrder(sb: any, args: {
  order: any; locationId: string;
  venue: { timeZone: string; prepMinutes: number; prepFallback?: boolean; prepReadOk?: boolean; tzReadOk?: boolean };
  priorLink?: any; eventAt?: string | null; requery?: boolean; nowIso: string;
  answer?: EzAnswer | null;
  refetch?: (() => Promise<{ order: any; answer: EzAnswer } | null>) | null;
  match?: { budgetMs?: number } | false;
  extraCustomer?: Record<string, unknown> | ((order: any) => Record<string, unknown>) | null;
  log?: (...a: unknown[]) => void;
}): Promise<{ ok: true; plan: any; payload: any; isNew: boolean; link: any; attempts: number; stale?: boolean; menuUnseen?: string[] } | { ok: false; error: string }> {
  const { locationId, nowIso } = args;
  const log = args.log || (() => {});
  let order = args.order;
  let answer: EzAnswer | null = args.answer || null;
  let refetches = 0;

  const build = (o: any, venue: any) => orderToQueueRow(o, locationId, {
    priorAcceptedCount: Number(args.priorLink?.accepted_count) || 0,
    eventAt: args.eventAt ?? null,
    venue: { timeZone: venue.timeZone, prepMinutes: venue.prepMinutes, prepFallback: !!venue.prepFallback },
    requery: !!args.requery,
  });

  // Item matching once, on the first answer. A later build (a fresh read, or the order's own
  // prep after a failed settings read) keeps what matching found for the same lines.
  const first = build(order, args.venue);
  let matched = first.row;
  // Published ezCater ids on this order that no synced menu row holds: ezCater republished its
  // menu. The caller re-syncs the menu AFTER the order is written, never before it.
  let menuUnseen: string[] = [];
  if (args.match !== false) {
    try {
      const m = await matchQueueRow(sb, locationId, first.row, { budgetMs: args.match?.budgetMs ?? MATCH_BUDGET_MS });
      matched = m.row || first.row;
      menuUnseen = Array.isArray(m.unseen) ? m.unseen : [];
      if (m.ran) log('items matched on', first.row.ref, `${m.matched}/${m.lines} lines`);
    } catch { matched = first.row; }
  }
  const ref = first.row.ref;

  for (let attempt = 1; attempt <= WRITE_ATTEMPTS; attempt++) {
    const existing = await readExisting(sb, locationId, ref);

    if (existing && answer && answerOlderThanRow(existing, answer.startedAt)) {
      const fresh = args.refetch && refetches < 2 ? await args.refetch().catch(() => null) : null;
      if (fresh?.order?.uuid && fresh.answer) {
        refetches++;
        order = fresh.order; answer = fresh.answer;
        log('the row holds a newer ezCater answer than ours, read ezCater again:', ref);
        attempt--;   // the fresh read is a new answer, not a failed write
        continue;
      }
      log('the row already holds a newer ezCater answer, ours was not written:', ref);
      const asIs = { ...existing, fire_at: existing.sent_at ?? null };
      return {
        ok: true, stale: true, isNew: false, attempts: attempt, payload: {}, link: null,
        plan: { row: asIs, reschedule: false, fired: !!existing.kitchen_routed_at, restored: false, changedAfterFire: null, late: false },
      };
    }

    const venue = venueForExisting(args.venue, existing);
    const built = (order === args.order && venue === args.venue) ? first : build(order, venue);
    const { link } = built;
    // The first build is exactly what matching ran on: its matched row goes in as it is. A later
    // build keeps the matches (and the match summary) for the lines that are the same lines.
    let queueRow = built === first ? matched : {
      ...built.row,
      items: carryMatchedItems(built.row.items, matched.items),
      customer: { ...(built.row.customer || {}), ...(matched.customer?.ezMatch ? { ezMatch: matched.customer.ezMatch } : {}) },
    };
    const extra: Record<string, unknown> = { ...((typeof args.extraCustomer === 'function' ? args.extraCustomer(order) : args.extraCustomer) || {}) };
    if (answer) extra.ezcaterAnswer = { startedAt: answer.startedAt, receivedAt: answer.receivedAt };
    if (Object.keys(extra).length) queueRow = { ...queueRow, customer: { ...(queueRow.customer || {}), ...extra } };
    const terminal = EZ_TERMINAL.has(ezLifecycle(order));

    let planned = queueRow;
    if (existing && Array.isArray(existing.items)) planned = { ...queueRow, items: carryMatchedItems(queueRow.items, existing.items) };
    const plan = ezcaterWritePlan({ row: planned, existing, terminal, nowIso });
    const payload = queuePayload(plan.row, !existing, nowIso, { reschedule: plan.reschedule });

    if (!existing) {
      const { error } = await sb.from('order_queue').insert(payload);
      if (error && isUniqueViolation(error)) continue;   // written by a parallel notification: plan against it
      if (error) return { ok: false, error: `order_queue insert failed: ${error.message}` };
    } else {
      // Rule 4: only while the row is exactly as read. For an unfired plan, also only while the
      // kitchen still does not have it: if the release claimed it since the read, nothing
      // matches, and the next pass plans it as FIRED. Any other write in between (an accepted
      // notification, a staff Undo, a flag) likewise means read again and plan again, and the
      // next pass also re-checks that this answer is still not older than the row's.
      const g = await guardedUpdate(sb, locationId, ref, existing, payload, { unfiredOnly: !plan.fired });
      if (g.error) return { ok: false, error: `order_queue update failed: ${g.error}` };
      if (!g.matched) { log('the order changed between read and write, planning again:', ref); continue; }
    }

    // The link row. A re-ask only refreshes what ezCater told us now: it never rewrites the
    // notification history (event_at, modification_seen_at).
    if (args.requery) {
      const patch = {
        ez_lifecycle: link.ez_lifecycle, accepted_count: link.accepted_count, fire_at: link.fire_at,
        order_type: link.order_type, requeried_at: nowIso, updated_at: nowIso,
      };
      const { data: upd } = await sb.from('ezcater_order_links').update(patch)
        .eq('location_id', locationId).eq('ref', ref).select('ref');
      if (!upd?.length) await sb.from('ezcater_order_links').upsert({ ...link, requeried_at: nowIso, updated_at: nowIso }, { onConflict: 'location_id,ref' });
    } else {
      const { error: lErr } = await sb.from('ezcater_order_links').upsert({ ...link, updated_at: nowIso }, { onConflict: 'location_id,ref' });
      if (lErr) log('link upsert failed:', lErr.message);
    }
    return { ok: true, plan, payload, isNew: !existing, link, attempts: attempt, menuUnseen };
  }
  return { ok: false, error: 'the order kept changing while it was being written, try again' };
}

/** A refetch for writeEzcaterOrder: read the order from ezCater again, within `ms`. */
export function refetchWith(fetchOrder: (signal: AbortSignal) => Promise<any>, ms: number, clock: () => number = Date.now) {
  return async () => {
    const r = await fetchOrderWithin(fetchOrder, ms, clock);
    return r.order ? { order: r.order, answer: (r as any).answer } : null;
  };
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
  nowIso: string; fetchFor: (access: any) => (signal: AbortSignal) => Promise<any>; timeoutMs?: number; clock?: () => number;
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
      const res = await fetchOrderWithin(args.fetchFor(access), args.timeoutMs ?? EZ_PREFIRE_TIMEOUT_MS, args.clock);
      if (res.order) {
        says = ezLifecycle(res.order) || null;
        // ONLY a cancel is proof the original is dead (review round 3). A 'rejected' can be a
        // rejected modification on an order that stands; anything else we do not know: both of
        // those only flag the two orders for staff.
        if (EZ_TERMINAL.has(says || '')) {
          // Written through the guarded write from a FRESH read, never from `cand` (read before the
          // ezCater call): an accepted notification that landed meanwhile is planned against. No
          // refetch: the replaced mark belongs to THIS answer. An answer older than the row's
          // (rule 5) is not written, and both orders are only flagged below.
          const w = await writeEzcaterOrder(sb, {
            order: res.order, answer: (res as any).answer, locationId, venue: args.venue, priorLink: access.priorLink, requery: true, nowIso, match: false,
            extraCustomer: { replacedBy: { ref: newRow.ref, orderNumber: newNumber, at: nowIso, ezcaterSaid: says } },
            log,
          });
          if (!(w.ok && w.stale)) {
            out.push({ ref: cand.ref, outcome: w.ok ? 'replaced' : 'error', ezcaterSays: says });
            continue;
          }
          says = null;
        }
      }
    }
    // Live on ezCater, or ezCater could not be asked: both are flagged, neither is stopped. Each
    // flag touches only possibleReplacement, on the row as it is NOW, with the guard (rule 4).
    const flagOther = { ref: newRow.ref, orderNumber: newNumber, ezcaterSays: says, at: nowIso };
    const flagNew = { ref: cand.ref, orderNumber: cand.customer?.ezcater_order_number || null, ezcaterSays: null, at: nowIso };
    await patchCustomer(sb, locationId, cand.ref, (c) => ({ ...c, possibleReplacement: flagOther }));
    await patchCustomer(sb, locationId, newRow.ref, (c) => ({ ...c, possibleReplacement: flagNew }));
    out.push({ ref: cand.ref, outcome: 'flagged', ezcaterSays: says });
  }
  return out;
}

/**
 * Staff UNDO of a replacement mark (review round 3: replacedBy is not sticky forever). Clears
 * replacedBy and possibleReplacement on this order and the other one, remembers the pair so the
 * two are never flagged against each other again (customer.replacementDismissed), and, when the
 * kitchen does not have the order yet, re-asks ezCater so the order becomes whatever ezCater
 * says it is now (live again, or still cancelled). An order the kitchen already has is never
 * moved: only its marks are cleared.
 */
export async function undoReplacement(sb: any, platform: any, args: {
  locationId: string; ref: string; by: string; nowIso?: string; timeoutMs?: number; clock?: () => number;
  fetchFor?: (access: any) => (signal: AbortSignal) => Promise<any>;
  log?: (...a: unknown[]) => void;
}): Promise<{ ok: true; message: string; resynced: boolean } | { ok: false; error: string }> {
  const nowIso = args.nowIso || new Date().toISOString();
  const existing = await readExisting(sb, args.locationId, args.ref);
  if (!existing) return { ok: false, error: 'That order is not on this venue.' };
  if (!isEzcaterOrder(existing)) return { ok: false, error: 'That is not an ezCater order.' };
  const c0 = existing.customer || {};
  const otherRef = String(c0.replacedBy?.ref || c0.possibleReplacement?.ref || '').trim();
  if (!otherRef) return { ok: false, error: 'This order is not marked as replaced.' };
  const dismiss = (c: any, pairRef: string) => {
    const refs = Array.isArray(c.replacementDismissed?.refs) ? c.replacementDismissed.refs : [];
    return { at: nowIso, by: args.by, refs: refs.includes(pairRef) ? refs : [...refs, pairRef] };
  };
  const mine = await patchCustomer(sb, args.locationId, args.ref, (c) => {
    const next = { ...c, replacementDismissed: dismiss(c, otherRef) };
    if (c.replacedBy) next.replacedByCleared = { ...c.replacedBy, clearedAt: nowIso, by: args.by };
    delete next.replacedBy; delete next.possibleReplacement;
    return next;
  });
  if (!mine.ok) return { ok: false, error: `Could not undo: ${mine.error || 'try again'}.` };
  await patchCustomer(sb, args.locationId, otherRef, (c) => {
    if (c.possibleReplacement?.ref !== args.ref && c.replacedBy?.ref !== args.ref) return { ...c, replacementDismissed: dismiss(c, args.ref) };
    const next = { ...c, replacementDismissed: dismiss(c, args.ref) };
    delete next.possibleReplacement;
    return next;
  });
  if (existing.kitchen_routed_at) {
    return { ok: true, resynced: false, message: 'Replacement mark cleared. The kitchen already has this order, so nothing else was changed.' };
  }
  const r = await resyncOrder(sb, platform, { locationId: args.locationId, ref: args.ref, nowIso, timeoutMs: args.timeoutMs, fetchFor: args.fetchFor, log: args.log, clock: args.clock });
  if (!r.ok) return { ok: true, resynced: false, message: `Replacement mark cleared. ${r.error} Press Re-sync from ezCater to bring it up to date.` };
  return { ok: true, resynced: true, message: `Replacement mark cleared. ${r.message}` };
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
  locationId: string; ref: string; nowIso?: string; timeoutMs?: number; clock?: () => number;
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
    // Only the check flag, on the row as it is NOW (rule 4), and only while it is unfired.
    const p = await flagUnchecked(sb, args.locationId, args.ref, why, nowIso);
    const now = p.row || existing;
    const hold = cateringHoldReason(now);
    return { fire: !hold, outcome: hold || 'fire', checked: false, why, row: now };
  };

  let access: any;
  try { access = await ezcaterAccessFor(sb, args.locationId, args.ref, existing); } catch (e) { return asPlanned(e instanceof Error ? e.message : String(e)); }
  if (!access.ok) return asPlanned(access.why);

  const res = await fetchOrderWithin(fetchFor(access), args.timeoutMs ?? EZ_PREFIRE_TIMEOUT_MS, args.clock);
  if (!res.order) return asPlanned(res.timedOut ? 'ezCater did not answer in time' : `ezCater answered with an error: ${res.error}`);

  let venue;
  try { venue = await readCateringVenue(sb, platform, args.locationId); } catch (e) { return asPlanned('the venue settings could not be read'); }
  // An answer older than the one the row now holds (a cancel written while we matched items) is
  // never written (rule 5): ezCater is read once more, and if that fails the row as it is decides.
  const w = await writeEzcaterOrder(sb, {
    order: res.order, answer: (res as any).answer, refetch: refetchWith(fetchFor(access), args.timeoutMs ?? EZ_PREFIRE_TIMEOUT_MS, args.clock),
    locationId: args.locationId, venue, priorLink: access.priorLink, requery: true, nowIso,
    match: { budgetMs: EZ_PREFIRE_MATCH_BUDGET_MS },
    extraCustomer: (o: any) => ({ ezcaterCheck: { at: nowIso, ok: true, lifecycle: ezLifecycle(o) || null } }),
    log,
  });
  if (!w.ok) return asPlanned(`the fresh answer could not be saved: ${w.error}`);
  if (w.plan.fired) return { fire: false, outcome: 'fired', checked: true, row: w.plan.row };
  const outcome = prefireOutcome(w.plan.row, nowMs, cateringHoldReason);
  const row = { ...existing, ...w.plan.row, sent_at: w.payload.sent_at ?? existing.sent_at, kitchen_routed_at: null };
  return { fire: outcome === 'fire', outcome, checked: true, row };
}

/** Customer keys that are CONTACT details: never sent back to a till by the pre fire answer. */
export const PREFIRE_CONTACT_KEYS = Object.freeze(['name', 'phone', 'email', 'address', 'buyerName', 'contact']);

/**
 * The row a pre fire answer hands back to the till (review round 4): what the kitchen needs
 * (items, type, times, the flags staff must see) and NO customer contact details. The till
 * already holds the row it read itself and merges this over it.
 */
export function prefireRowForTill(row: any): any | null {
  if (!row) return null;
  const customer = row.customer && typeof row.customer === 'object' ? { ...row.customer } : null;
  if (customer) for (const k of PREFIRE_CONTACT_KEYS) delete customer[k];
  return {
    ref: row.ref, type: row.type ?? null, source: row.source ?? 'ezcater', status: row.status,
    items: row.items || [], customer, sent_at: row.sent_at ?? null,
    collection_time: row.collection_time ?? null, event_date: row.event_date ?? null,
  };
}

// ── Re-sync from ezCater (staff) ─────────────────────────────────────────────

/**
 * Re-ask ezCater about one stored order and rewrite it through the same write plan. Repairs a
 * row written by older code (HKX77V: 'prep', sent_at at the delivery time, the caterer's clock)
 * and catches a missed notification. Never moves an order that already fired: that path only
 * flags changes. ezcater_order_links.requeried_at records when.
 */
export async function resyncOrder(sb: any, platform: any, args: {
  locationId: string; ref: string; nowIso?: string; timeoutMs?: number; clock?: () => number;
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
  const res = await fetchOrderWithin(fetchFor(access), args.timeoutMs ?? 10000, args.clock);
  if (!res.order) return { ok: false, error: `Could not reach ezCater: ${res.error}. Nothing was changed.` };
  const venue = await readCateringVenue(sb, platform, args.locationId);
  const w = await writeEzcaterOrder(sb, {
    order: res.order, answer: (res as any).answer, refetch: refetchWith(fetchFor(access), args.timeoutMs ?? 10000, args.clock),
    locationId: args.locationId, venue, priorLink: access.priorLink, requery: true, nowIso,
    extraCustomer: { resyncedAt: nowIso }, log,
  });
  if (!w.ok) return { ok: false, error: `Could not save: ${w.error}` };
  if (w.stale) return { ok: true, fired: !!w.plan.fired, changed: false, row: w.plan.row, message: 'The order changed while ezCater answered and already holds a newer answer. Nothing was changed.' };
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

// ── The check flag ───────────────────────────────────────────────────────────

/**
 * Mark an unfired order as going to the kitchen WITHOUT a last check with ezCater (no answer in
 * time, no token, the cron's time budget spent). Touches only customer.ezcaterCheck, on the row
 * as it is now, and only while the kitchen does not have it. Never throws.
 */
export async function flagUnchecked(sb: any, locationId: string, ref: string, why: string, nowIso: string) {
  try {
    return await patchCustomer(sb, locationId, ref, (c) => ({ ...c, ezcaterCheck: { at: nowIso, ok: false, why } }), { unfiredOnly: true });
  } catch (e) {
    return { ok: false, written: false, row: null, error: e instanceof Error ? e.message : String(e) };
  }
}

// ── Staff "Send anyway" (review round 4) ─────────────────────────────────────

/**
 * Staff release a HELD ezCater order (not accepted on ezCater) by hand, typically during an
 * ezCater outage when no accepted answer can arrive. Writes customer.sendAnyway = { at, by,
 * byName, lifecycle } on the row as it is now (rule 4), only while the kitchen does not have it,
 * and never on a cancelled or collected order (a cancel always wins). From then on the order is
 * released (cateringHoldReason) and fires through the normal release at its fire moment: the
 * till prints it; the cron backs it up. Who sent it is on the order and on every warning.
 */
export async function sendAnyway(sb: any, args: {
  locationId: string; ref: string; by: string; byName?: string | null; nowIso?: string;
}): Promise<{ ok: true; message: string; row: any } | { ok: false; error: string }> {
  const nowIso = args.nowIso || new Date().toISOString();
  let refusal: string | null = null;
  const p = await patchCustomer(sb, args.locationId, args.ref, (c, row) => {
    if (!isEzcaterOrder(row)) { refusal = 'That is not an ezCater order.'; return null; }
    const st = String(row.status || '').toLowerCase();
    if (st === 'cancelled' || st === 'canceled') { refusal = 'This order is cancelled on ezCater, so it cannot be sent.'; return null; }
    if (st === 'collected') { refusal = 'This order is already collected.'; return null; }
    if (cateringHoldReason(row) !== 'awaiting_ezcater_acceptance') { refusal = 'This order is not held, it goes to the kitchen at its time.'; return null; }
    return { ...c, sendAnyway: { at: nowIso, by: args.by, byName: args.byName || null, lifecycle: c.ezcater_lifecycle || null } };
  }, { unfiredOnly: true });
  if (!p.ok) return { ok: false, error: `Could not send it: ${p.error || 'try again'}.` };
  if (!p.row) return { ok: false, error: 'That order is not on this venue.' };
  if (p.row.kitchen_routed_at) return { ok: false, error: 'The kitchen already has this order.' };
  if (refusal) return { ok: false, error: refusal };
  return { ok: true, message: 'Released. It goes to the kitchen at its time, marked as sent without ezCater acceptance.', row: p.row };
}

// ── Scheduled re-asks (review round 3, C and D; narrowed in round 4) ─────────
//
// The pre fire check only runs at the OLD fire time. A Dispatch pickup moved EARLIER without a
// notification, or a missed accepted notification, was therefore only seen when it was already
// too late (or never: a held order is not released, so it was never re-asked at all). So the
// catering-release cron (every 5 minutes) also re-asks, in small bounded batches:
//   * every order due in the next EZ_RECHECK_NEAR_MS (or already due, down to the stale floor),
//     held ones included, when it was last re-asked more than EZ_RECHECK_NEAR_EVERY_MS ago;
//   * every order due within the week ahead, once a day.
// A re-ask NEVER FIRES ANYTHING and never tells the cron to (review round 4): it writes ezCater's
// answer through the same guarded write plan, so a moved time moves sent_at, and the till's
// release fires it (printing, production centres); the cron is only the backstop after its
// grace window. A held order keeps its real fire moment (no sent_at to now). A held order still
// not accepted as it nears or passes its fire time is flagged for staff (customer.unacceptedAlert).
// The batch is picked FAIRLY PER VENUE (pickRecheckBatch), released orders before held ones.

export const EZ_RECHECK_NEAR_MS = 4 * 60 * 60 * 1000;
export const EZ_RECHECK_NEAR_EVERY_MS = 15 * 60 * 1000;
export const EZ_RECHECK_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
export const EZ_RECHECK_WEEK_EVERY_MS = 24 * 60 * 60 * 1000;
/** How many orders one cron run re-asks, in total, from the two windows. */
export const EZ_RECHECK_NEAR_LIMIT = 20;
export const EZ_RECHECK_WEEK_LIMIT = 10;
/** How many due candidates are read per window, to pick fairly from (the pick is bounded above). */
export const EZ_RECHECK_READ_LIMIT = 500;
/** A held order this close to (or past) its fire time and still not accepted is shown to staff. */
export const EZ_UNACCEPTED_WARN_MS = 30 * 60 * 1000;

const msOf = (v: unknown) => { const t = v == null || v === '' ? NaN : new Date(v as any).getTime(); return Number.isFinite(t) ? t : NaN; };

/**
 * Is this unfired row due for a scheduled re-ask now? Pure. Mirrors the two query windows, so a
 * database that ignored the json filter still only re-asks what is due.
 */
export function needsRecheck(row: any, nowMs: number): boolean {
  if (!row || row.kitchen_routed_at) return false;
  const st = String(row.status || '').toLowerCase();
  if (st === 'cancelled' || st === 'canceled' || st === 'collected') return false;
  const fire = msOf(row.sent_at);
  if (!Number.isFinite(fire) || fire < nowMs - CATERING_STALE_FLOOR_MS || fire > nowMs + EZ_RECHECK_WEEK_MS) return false;
  const last = msOf(row.customer?.ezcaterRecheck?.at);
  const every = fire <= nowMs + EZ_RECHECK_NEAR_MS ? EZ_RECHECK_NEAR_EVERY_MS : EZ_RECHECK_WEEK_EVERY_MS;
  return !Number.isFinite(last) || nowMs - last >= every;
}

/**
 * THE FAIR PICK (review round 4). From rows already known to need a re-ask, choose at most
 * `limit`, taking turns across venues (one venue's pile of orders can never crowd out another
 * venue's next order), and within a venue released orders first, then by fire moment. Pure.
 */
export function pickRecheckBatch(rows: any[], limit: number): any[] {
  const byVenue = new Map<string, any[]>();
  for (const r of rows || []) {
    const k = String(r?.location_id || '');
    if (!k) continue;
    if (!byVenue.has(k)) byVenue.set(k, []);
    byVenue.get(k)!.push(r);
  }
  const rank = (r: any) => (cateringHoldReason(r) ? 1 : 0);
  for (const list of byVenue.values()) {
    list.sort((a, b) => rank(a) - rank(b) || (msOf(a.sent_at) || 0) - (msOf(b.sent_at) || 0));
  }
  // Venues in the order of their most pressing order, then round robin.
  const venues = [...byVenue.entries()].sort((a, b) => rank(a[1][0]) - rank(b[1][0]) || (msOf(a[1][0].sent_at) || 0) - (msOf(b[1][0].sent_at) || 0));
  const out: any[] = [];
  for (let i = 0; out.length < limit; i++) {
    let any = false;
    for (const [, list] of venues) {
      if (i < list.length) { out.push(list[i]); any = true; if (out.length >= limit) break; }
    }
    if (!any) break;
  }
  return out;
}

/** The unaccepted flag for a held order near or past its fire time, or null. The same fire moment is reported once. */
export function unacceptedAlertFor(row: any, nowMs: number, nowIso: string): any | null {
  if (!row || row.kitchen_routed_at || cateringHoldReason(row) !== 'awaiting_ezcater_acceptance') return null;
  // The order's own computed fire moment (customer.fireAt), not sent_at.
  const own = msOf(row.customer?.fireAt);
  const fire = Number.isFinite(own) ? own : msOf(row.sent_at);
  if (!Number.isFinite(fire) || fire > nowMs + EZ_UNACCEPTED_WARN_MS) return null;
  const prev = row.customer?.unacceptedAlert;
  const fireAt = new Date(fire).toISOString();
  if (prev && prev.fireAt === fireAt) return prev;
  return { at: nowIso, fireAt, fireTime: row.customer?.fire_time || null, lifecycle: row.customer?.ezcaterSays || row.customer?.ezcater_lifecycle || null };
}

export type RecheckResult = {
  ref: string; locationId: string;
  outcome: 'checked' | 'unreachable' | 'fired' | 'missing' | 'skipped' | 'stale' | 'error';
  lifecycle?: string | null; late?: boolean; unaccepted?: boolean; why?: string;
};

/**
 * Re-ask ezCater about ONE unfired order on the schedule. Never fires it, and says nothing that
 * would make anyone fire it early (review round 4): a moved time only moves sent_at.
 */
export async function recheckOrder(sb: any, platform: any, args: {
  locationId: string; ref: string; nowIso?: string; timeoutMs?: number; venue?: any; clock?: () => number;
  fetchFor?: (access: any) => (signal: AbortSignal) => Promise<any>;
  log?: (...a: unknown[]) => void;
}): Promise<RecheckResult> {
  const nowIso = args.nowIso || new Date().toISOString();
  const nowMs = Date.parse(nowIso);
  const base = { ref: args.ref, locationId: args.locationId };
  const existing = await readExisting(sb, args.locationId, args.ref);
  if (!existing) return { ...base, outcome: 'missing' };
  if (existing.kitchen_routed_at) return { ...base, outcome: 'fired' };
  if (!isEzcaterOrder(existing)) return { ...base, outcome: 'skipped' };
  const fetchFor = args.fetchFor || ((a: any) => (signal: AbortSignal) => getOrder(a.token, a.ezOrderId, a.apiUrl, signal));

  const unreachable = async (why: string): Promise<RecheckResult> => {
    // Record the attempt (so the batch moves on to other orders) and, for a held order near its
    // fire time, tell staff it is still not accepted as far as we know.
    let unaccepted = false;
    await patchCustomer(sb, args.locationId, args.ref, (c, row) => {
      const next = { ...c, ezcaterRecheck: { at: nowIso, ok: false, why } };
      const ua = unacceptedAlertFor({ ...row, customer: next }, nowMs, nowIso);
      if (ua) { next.unacceptedAlert = ua; unaccepted = true; }
      return next;
    }, { unfiredOnly: true });
    return { ...base, outcome: 'unreachable', why, unaccepted };
  };

  let access: any;
  try { access = await ezcaterAccessFor(sb, args.locationId, args.ref, existing); } catch (e) { access = { ok: false, why: e instanceof Error ? e.message : String(e) }; }
  if (!access.ok) return unreachable(access.why);
  const res = await fetchOrderWithin(fetchFor(access), args.timeoutMs ?? EZ_PREFIRE_TIMEOUT_MS, args.clock);
  if (!res.order) return unreachable(res.timedOut ? 'ezCater did not answer in time' : `ezCater answered with an error: ${res.error}`);
  const venue = args.venue || await readCateringVenue(sb, platform, args.locationId);
  const lifecycle = ezLifecycle(res.order) || null;
  // No refetch on a schedule: an answer older than the row's is dropped, the next run asks again.
  const w = await writeEzcaterOrder(sb, {
    order: res.order, answer: (res as any).answer, locationId: args.locationId, venue, priorLink: access.priorLink, requery: true, nowIso,
    match: { budgetMs: EZ_PREFIRE_MATCH_BUDGET_MS },
    extraCustomer: (o: any) => ({ ezcaterRecheck: { at: nowIso, ok: true, lifecycle: ezLifecycle(o) || null } }),
    log: args.log,
  });
  if (!w.ok) return { ...base, outcome: 'error', why: w.error, lifecycle };
  if (w.stale) return { ...base, outcome: 'stale', lifecycle };
  if (w.plan.fired) return { ...base, outcome: 'fired', lifecycle };
  const now = { ...existing, ...w.plan.row, sent_at: w.payload.sent_at ?? existing.sent_at, kitchen_routed_at: null };
  let unaccepted = false;
  const ua = unacceptedAlertFor(now, nowMs, nowIso);
  if (ua && ua !== now.customer?.unacceptedAlert) {
    const p = await patchCustomer(sb, args.locationId, args.ref, (c) => ({ ...c, unacceptedAlert: ua }), { unfiredOnly: true });
    unaccepted = p.written;
  } else if (ua) unaccepted = true;
  return { ...base, outcome: 'checked', lifecycle, late: !!w.plan.late, unaccepted };
}

/**
 * The scheduled batch: read what is due a re-ask in the two windows, pick FAIRLY PER VENUE
 * (pickRecheckBatch), and re-ask them IN PARALLEL inside one time budget. Never throws; a failed
 * read re-asks nothing.
 */
export async function recheckUpcoming(sb: any, platform: any, args: {
  nowIso?: string; budgetMs?: number; concurrency?: number; timeoutMs?: number; clock?: () => number;
  fetchFor?: (access: any) => (signal: AbortSignal) => Promise<any>;
  log?: (...a: unknown[]) => void;
} = {}): Promise<RecheckResult[]> {
  const nowIso = args.nowIso || new Date().toISOString();
  const nowMs = Date.parse(nowIso);
  const iso = (ms: number) => new Date(ms).toISOString();
  const cols = 'ref, location_id, source, status, sent_at, kitchen_routed_at, customer';
  const windowQuery = (from: number, to: number, everyMs: number) => sb.from('order_queue').select(cols)
    .eq('source', 'ezcater').is('kitchen_routed_at', null).not('status', 'in', '(cancelled,canceled,collected)')
    .gte('sent_at', iso(from)).lte('sent_at', iso(to))
    .or(`customer->ezcaterRecheck->>at.is.null,customer->ezcaterRecheck->>at.lt.${iso(nowMs - everyMs)}`)
    .order('sent_at', { ascending: true }).limit(EZ_RECHECK_READ_LIMIT);
  let rows: any[] = [];
  try {
    const [near, week] = await Promise.all([
      windowQuery(nowMs - CATERING_STALE_FLOOR_MS, nowMs + EZ_RECHECK_NEAR_MS, EZ_RECHECK_NEAR_EVERY_MS),
      windowQuery(nowMs + EZ_RECHECK_NEAR_MS + 1, nowMs + EZ_RECHECK_WEEK_MS, EZ_RECHECK_WEEK_EVERY_MS),
    ]);
    if (near.error) args.log?.('recheck near read failed:', near.error.message);
    if (week.error) args.log?.('recheck week read failed:', week.error.message);
    const due = (list: any[]) => (list || []).filter((r: any) => needsRecheck(r, nowMs));
    const nearPick = pickRecheckBatch(due(near.data), EZ_RECHECK_NEAR_LIMIT);
    const weekPick = pickRecheckBatch(due(week.data), EZ_RECHECK_WEEK_LIMIT);
    const seen = new Set<string>();
    for (const r of [...nearPick, ...weekPick]) {
      const k = `${r.location_id}|${r.ref}`;
      if (seen.has(k)) continue;
      seen.add(k); rows.push(r);
    }
  } catch (e) {
    args.log?.('recheck read failed:', e instanceof Error ? e.message : String(e));
    return [];
  }
  const venues = new Map<string, Promise<any>>();
  const venueFor = (loc: string) => { if (!venues.has(loc)) venues.set(loc, readCateringVenue(sb, platform, loc)); return venues.get(loc)!; };
  const results = await runWithBudget(rows, async (r: any) => recheckOrder(sb, platform, {
    locationId: r.location_id, ref: r.ref, nowIso, timeoutMs: args.timeoutMs, venue: await venueFor(r.location_id),
    fetchFor: args.fetchFor, log: args.log, clock: args.clock,
  }), { concurrency: args.concurrency ?? 6, budgetMs: args.budgetMs ?? 20000 });
  return results.map((x: any, i: number) => x.ok ? x.value : { ref: rows[i].ref, locationId: rows[i].location_id, outcome: 'skipped', why: x.error });
}

// ── A venue's catering prep time changed (review round 3, C; narrowed in round 4) ──
//
// ONLY when staff save Catering settings (ezcater-connect 'recompute_prep'), never from the cron:
// the cron's automatic sweep read a failed settings read as "no prep set" and re-timed every
// unfired ezCater order to the 60 minute fallback, which cannot be undone (review round 4).

/**
 * Re-time every UNFIRED ezCater order at a venue whose stored prep time differs from the venue's
 * catering prep time now: new fire moment = ezCater's ready time (customer.readyAt, an instant)
 * minus the prep, on the venue clock. No call to ezCater is needed.
 *
 * ONLY with a SUCCESSFULLY READ, EXPLICITLY SET prep time (review round 4): a failed read, or a
 * venue with no prep time set, changes nothing and says so ({ ok: false, why }). A released
 * order whose new fire moment is past fires now and is flagged late (the change moved it); a
 * held order keeps its real fire moment. Each order is written with the guard (rule 4), so an
 * order the kitchen took in the meantime is left alone. Bounded; never throws.
 */
export async function recomputePrepForVenue(sb: any, platform: any, args: {
  locationId: string; nowIso?: string; limit?: number; venue?: any; log?: (...a: unknown[]) => void;
}): Promise<{ ok: boolean; why?: string; checked: number; retimed: number; late: number; refs: string[] }> {
  const nowIso = args.nowIso || new Date().toISOString();
  const nowMs = Date.parse(nowIso);
  const out = { ok: true, checked: 0, retimed: 0, late: 0, refs: [] as string[] };
  let venue: any;
  try { venue = args.venue || await readCateringVenue(sb, platform, args.locationId); } catch { return { ...out, ok: false, why: 'the catering settings could not be read' }; }
  if (venue?.prepReadOk === false) return { ...out, ok: false, why: 'the catering settings could not be read, nothing was changed' };
  if (venue?.tzReadOk === false) return { ...out, ok: false, why: 'the venue timezone could not be read, nothing was changed' };
  const { data, error } = await sb.from('order_queue').select('ref, location_id, source, status, sent_at, kitchen_routed_at, customer')
    .eq('location_id', args.locationId).eq('source', 'ezcater').is('kitchen_routed_at', null)
    .not('status', 'in', '(cancelled,canceled,collected)')
    .gte('sent_at', new Date(nowMs - CATERING_STALE_FLOOR_MS).toISOString())
    .order('sent_at', { ascending: true }).limit(args.limit ?? 200);
  if (error) { args.log?.('prep recompute read failed:', error.message); return { ...out, ok: false, why: 'the orders could not be read' }; }
  if (!(data || []).length) return out;   // no ezCater order waiting: nothing to re-time
  if (venue?.prepFallback) return { ...out, ok: false, why: 'no catering prep time is set, nothing was changed' };
  for (const r of data || []) {
    out.checked++;
    const c = r.customer || {};
    if (Number(c.prepMinutes) === venue.prepMinutes && !c.prepFallback) continue;
    if (!Number.isFinite(msOf(c.readyAt))) continue;
    const res = await retimeForPrep(sb, args.locationId, r.ref, venue, nowIso);
    if (res.retimed) { out.retimed++; out.refs.push(r.ref); }
    if (res.late) out.late++;
  }
  return out;
}

async function retimeForPrep(sb: any, locationId: string, ref: string, venue: any, nowIso: string): Promise<{ retimed: boolean; late: boolean }> {
  const nowMs = Date.parse(nowIso);
  for (let attempt = 1; attempt <= WRITE_ATTEMPTS; attempt++) {
    const row = await readExisting(sb, locationId, ref);
    if (!row || row.kitchen_routed_at) return { retimed: false, late: false };
    const c = row.customer || {};
    const st = String(row.status || '').toLowerCase();
    if (st === 'cancelled' || st === 'canceled' || st === 'collected') return { retimed: false, late: false };
    if (Number(c.prepMinutes) === venue.prepMinutes && !c.prepFallback) return { retimed: false, late: false };
    const fireMs = cateringFireMs(msOf(c.readyAt), venue.prepMinutes);
    if (!Number.isFinite(fireMs)) return { retimed: false, late: false };
    const fireAt = new Date(fireMs).toISOString();
    const released = !cateringHoldReason(row);
    // Late only because THIS change moved the fire moment earlier, into the past (lateFirePlan).
    const late = released ? lateFirePlan({ fireAt, prevFireAt: c.fireAt ?? null, nowIso, prevLate: c.lateFire || null }) : null;
    const customer: any = {
      ...c, prepMinutes: venue.prepMinutes, prepFallback: false, fireAt,
      fire_time: venueWallClock(fireMs, venue.timeZone || c.venueTimeZone)?.time ?? c.fire_time ?? null,
      prepRecomputedAt: nowIso,
    };
    if (late) customer.lateFire = late;
    else if (!(c.lateFire && c.lateFire.fireAt === fireAt)) delete customer.lateFire;
    // A released order due now fires now; a held one keeps its real fire moment.
    const sent_at = released && fireMs < nowMs ? nowIso : fireAt;
    const g = await guardedUpdate(sb, locationId, ref, row, { customer, sent_at }, { unfiredOnly: true });
    if (g.error) return { retimed: false, late: false };
    if (g.matched) {
      await sb.from('ezcater_order_links').update({ fire_at: fireAt, updated_at: nowIso }).eq('location_id', locationId).eq('ref', ref).then(() => {}, () => {});
      return { retimed: true, late: !!late };
    }
  }
  return { retimed: false, late: false };
}
