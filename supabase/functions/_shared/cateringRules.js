// supabase/functions/_shared/cateringRules.js
//
// ONE RULE FOR CATERING, WHEREVER THE ORDER CAME FROM.
//
// Pure decisions only. No I/O, no Deno, no Supabase, no clock reads that change the output:
// imported by the edge functions (ezcater-webhook, catering-release, order-notify, the courier
// dispatcher) AND by the app (src/lib/cateringRules.js re-exports it), and unit tested from
// src/lib/cateringRules.test.js under plain node. Keep it that way.
//
// WHY (Peter, 18 Sep 2026, after a live ezCater test order): "we need to ensure they follow the
// same rules as the rest of our catering system where they hit the POS at the right times and
// parameters set to fire into the kitchen as our own catering orders". Before this file every
// catering rule was written as source === 'catering', so an ezCater order (source 'ezcater')
// skipped all of them: it went into the live queue days early, never reached the Back Office
// advance list, was never released to the kitchen at its fire time, and order-notify sent OUR
// confirmation to ezCater's customer.
//
// THE RULES:
//   1. An ezCater order IS a catering order (isCateringSource). The CHANNEL stays visible
//      (cateringSourceLabel), so staff still see it came from ezCater.
//   2. The kitchen fire time is ONE rule (cateringFireMs): the moment the food must be ready,
//      minus the venue's catering prep_time_minutes (catering_site_settings). ServOS catering
//      checkout and the ezCater webhook both call it. Venue wall clock times are turned into
//      instants on the VENUE's timezone (wallTimeToInstantMs) and instants back into the venue's
//      date and time (venueWallClock), never the device's or the caterer's clock.
//   3. A held catering order is released to the kitchen by the normal release (the POS master's
//      releaseDueCateringOrders, then the catering-release cron as the backstop), which claims
//      kitchen_routed_at exactly once. cateringMayFire says which rows that release may fire.
//   4. We never book a ServOS courier for an ezCater order and never message its customer
//      (mayBookOurCourier, mayMessageCustomer). ezCater owns that customer relationship.

/** Every order_queue.source that is a catering order. */
export const CATERING_SOURCES = Object.freeze(['catering', 'ezcater']);

/** The IANA zone a venue with no timezone set runs on. Same default as src/lib/locationTime.js. */
export const DEFAULT_VENUE_TZ = 'Europe/London';

const norm = (v) => String(v ?? '').trim().toLowerCase();

/** True for a catering order from any channel (our own catering site, or ezCater). */
export function isCateringSource(source) {
  return CATERING_SOURCES.includes(norm(source));
}

/** True for an order that came from ezCater. The customer id is the fallback for a row whose source was lost. */
export function isEzcaterOrder(order) {
  if (!order || typeof order !== 'object') return false;
  if (norm(order.source) === 'ezcater') return true;
  const c = order.customer;
  return !!(c && typeof c === 'object' && String(c.ezcater_order_id ?? '').trim());
}

/** The channel name staff see for a catering order. Never hides that it came from ezCater. */
export function cateringSourceLabel(source) {
  const s = norm(source);
  if (s === 'ezcater') return 'ezCater';
  if (s === 'catering') return 'Catering';
  return null;
}

/** PostgREST list for .in('source', ...) and not.in filters: "(catering,ezcater)". */
export const CATERING_SOURCES_PG_LIST = `(${CATERING_SOURCES.join(',')})`;

/**
 * The PostgREST .or() filter for the LIVE queue: every row except a catering order whose kitchen
 * fire moment is still in the future. A held catering order lives in the database (Back Office
 * advance list) until the release fires it, so thousands of future bookings never load into
 * every till. NULL source is kept explicitly (a NULL never matches not.in).
 */
export function liveQueueOrFilter(nowIso) {
  return `source.is.null,source.not.in.${CATERING_SOURCES_PG_LIST},sent_at.lte.${nowIso}`;
}

/** True for a catering row whose fire moment is still ahead of nowMs: it stays out of the live queue. */
export function isFutureCatering(row, nowMs) {
  if (!row || !isCateringSource(row.source) || !row.sent_at) return false;
  if (row.status === 'collected') return false;
  const t = new Date(row.sent_at).getTime();
  return Number.isFinite(t) && t > nowMs;
}

// ── Venue clock ──────────────────────────────────────────────────────────────

const _dtf = new Map();
function partsIn(ms, tz) {
  let f = _dtf.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    _dtf.set(tz, f);
  }
  const p = {};
  f.formatToParts(new Date(ms)).forEach((x) => { if (x.type !== 'literal') p[x.type] = +x.value; });
  if (p.hour === 24) p.hour = 0;
  return p;
}

/**
 * A venue wall clock date + time to the real instant, on the venue's IANA zone.
 * Moved here verbatim from CateringCheckout.jsx (v5.5.610) so the storefront and the ezCater
 * webhook share it. With no zone the wall clock is read as UTC, exactly as before.
 */
export function wallTimeToInstantMs(dateStr, timeStr, tz) {
  if (!dateStr) return NaN;
  const [y, mo, d] = String(dateStr).split('-').map(Number);
  const [h, mi] = String(timeStr || '12:00').split(':').map(Number);
  const guess = Date.UTC(y, (mo || 1) - 1, d || 1, h || 0, mi || 0, 0);
  if (!tz) return guess;
  try {
    const p = partsIn(guess, tz);
    const seen = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    return guess - (seen - guess);   // shift the guess by the venue's offset at that wall time
  } catch { return guess; }
}

/**
 * An instant to the venue's own calendar date and clock time ('YYYY-MM-DD', 'HH:MM').
 * An unknown zone falls back to the default venue zone, never to the machine running this.
 */
export function venueWallClock(instantMs, tz) {
  const ms = typeof instantMs === 'number' ? instantMs : new Date(instantMs).getTime();
  if (!Number.isFinite(ms)) return null;
  const pad = (n) => String(n).padStart(2, '0');
  const zones = [tz, DEFAULT_VENUE_TZ].filter((z) => typeof z === 'string' && z.trim());
  for (const z of zones) {
    try {
      const p = partsIn(ms, z.trim());
      if (!p.year) continue;
      return { date: `${p.year}-${pad(p.month)}-${pad(p.day)}`, time: `${pad(p.hour)}:${pad(p.minute)}`, timeZone: z.trim() };
    } catch { /* invalid IANA name: try the default */ }
  }
  return null;
}

// ── The fire time ────────────────────────────────────────────────────────────

/** The venue's catering prep time in whole minutes. Blank or bad reads as 0, exactly as CateringCheckout did. */
export function cateringPrepMinutes(settings) {
  const n = Number(settings?.prep_time_minutes);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

/**
 * THE KITCHEN FIRE TIME for a catering order: the instant the food must be ready, minus the
 * venue's catering prep time (catering_site_settings.prep_time_minutes). NaN when the ready
 * instant is unknown. This is the only place the rule is written.
 */
export function cateringFireMs(readyMs, prepMinutes) {
  if (typeof readyMs !== 'number' || !Number.isFinite(readyMs)) return NaN;
  const prep = Number(prepMinutes);
  return readyMs - (Number.isFinite(prep) && prep > 0 ? prep : 0) * 60000;
}

// ── Release ──────────────────────────────────────────────────────────────────

/**
 * ezCater lifecycle values that mean the caterer is committed to cooking it. A submitted order
 * is not accepted yet (it can still be rejected in ezCater), so it is held, visible, and fires
 * the moment an accepted notification arrives. relish_finalized is the only event a Meal
 * Program order ever sends, so it counts as committed.
 */
export const EZ_COMMITTED = new Set(['accepted', 'relish_finalized', 'ready', 'ready_for_pickup']);

/** Why a catering row may NOT fire now, or null when the release may fire it. */
export function cateringHoldReason(row) {
  if (!row) return 'missing';
  const st = norm(row.status);
  if (st === 'cancelled' || st === 'canceled') return 'cancelled';
  if (st === 'collected') return 'collected';
  if (isEzcaterOrder(row)) {
    const life = norm(row.customer?.ezcater_lifecycle);
    if (life && !EZ_COMMITTED.has(life)) return 'awaiting_ezcater_acceptance';
  }
  return null;
}

/** The release (POS master or the catering-release cron) may fire this row. */
export function cateringMayFire(row) {
  return cateringHoldReason(row) === null;
}

/**
 * The sent_at window the POS master's release (store.releaseDueCateringOrders) reads: due now,
 * and not further back than the stale floor. A row whose fire moment is older than the floor
 * is never auto fired by a till (a long offline master must not dump a backlog into the
 * kitchen); it stays in the live queue and the Orders Hub for staff to send by hand.
 */
export function cateringReleaseWindow(nowMs, staleFloorMs) {
  return { fromIso: new Date(nowMs - staleFloorMs).toISOString(), toIso: new Date(nowMs).toISOString() };
}

/**
 * What the till release does with one unfired catering row right now:
 *   'fire'        due, inside the window, allowed to fire: routed to the kitchen this tick
 *   'future'      its fire moment is still ahead: held in the database, off the live queue
 *   'stale'       its fire moment is older than the stale floor: never auto fired by a till,
 *                 but it IS in the live queue (it is not future), so staff see it and send it
 *   a hold reason from cateringHoldReason (cancelled, collected, awaiting_ezcater_acceptance)
 * Mirrors the query in releaseDueCateringOrders plus its cateringMayFire check.
 */
export function cateringReleaseDecision(row, nowMs, staleFloorMs) {
  const hold = cateringHoldReason(row);
  if (hold) return hold;
  if (row.kitchen_routed_at) return 'fired';
  const t = new Date(row.sent_at).getTime();
  if (!Number.isFinite(t)) return 'stale';
  if (t > nowMs) return 'future';
  if (t < nowMs - staleFloorMs) return 'stale';
  return 'fire';
}

// ── The Back Office advance list ─────────────────────────────────────────────

/**
 * Does this row belong on the Back Office advance list? A catering order cancelled BEFORE it
 * fired has left the plan, so it goes. One cancelled AFTER the kitchen had it stays, so staff
 * can see the kitchen should stop.
 */
export function inAdvanceList(row) {
  if (!row) return false;
  const st = norm(row.status);
  if ((st === 'cancelled' || st === 'canceled') && !row.kitchen_routed_at) return false;
  return true;
}

/** The status word on the advance list. */
export function advanceListStatus(row) {
  const st = norm(row?.status);
  const change = row?.customer?.changedAfterFire;
  if (st === 'cancelled' || st === 'canceled') return row?.kitchen_routed_at ? 'Cancelled after kitchen' : 'Cancelled';
  if (change && Array.isArray(change.kinds) && change.kinds.length) return 'Changed after kitchen';
  if (st === 'done' || st === 'collected') return 'Completed';
  if (st === 'prep' || row?.kitchen_routed_at) return 'In kitchen';
  if (cateringHoldReason(row) === 'awaiting_ezcater_acceptance') return 'Awaiting ezCater acceptance';
  return 'Scheduled';
}

// ── What we never do for an ezCater order ────────────────────────────────────

/**
 * May ServOS book its OWN courier (Stuart / Uber Direct) for this order? Only for our own
 * catering or online delivery the customer chose courier delivery for. Never for ezCater: on a
 * DELIVERY order the caterer delivers with its own fleet, on a THIRD_PARTY_DELIVERY order ezCater
 * Dispatch sends the driver (ezCater Order Schema Reference, OrderTypeEnum).
 */
export function mayBookOurCourier(order) {
  if (!order || isEzcaterOrder(order)) return false;
  const c = order.customer || {};
  const type = norm(order.type || c.serviceType);
  return type === 'delivery' && c.delivery_mode === 'uber';
}

/** May ServOS send its own confirmation / ready messages to this order's customer? Never for ezCater. */
export function mayMessageCustomer(order) {
  return !isEzcaterOrder(order);
}
