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
 * The PostgREST .or() filter for the LIVE queue: every row except a catering order that the
 * kitchen does not have and should not see yet:
 *   * its kitchen fire moment is still in the future (held in the database, Back Office advance
 *     list, until the release fires it, so thousands of future bookings never load into every
 *     till), or
 *   * it was CANCELLED before it ever fired. Without this a cancelled future order (an ezCater
 *     cancel, or one of ours cancelled in Back Office) loaded into every till the moment its old
 *     fire time passed. One cancelled AFTER firing still loads, so staff see the kitchen must stop.
 * NULL source is kept explicitly (a NULL never matches not.in).
 */
export function liveQueueOrFilter(nowIso) {
  return `source.is.null,source.not.in.${CATERING_SOURCES_PG_LIST},`
    + `and(sent_at.lte.${nowIso},or(status.neq.cancelled,kitchen_routed_at.not.is.null))`;
}

/** True for a catering row whose fire moment is still ahead of nowMs: it stays out of the live queue. */
export function isFutureCatering(row, nowMs) {
  if (!row || !isCateringSource(row.source) || !row.sent_at) return false;
  if (row.status === 'collected') return false;
  const t = new Date(row.sent_at).getTime();
  return Number.isFinite(t) && t > nowMs;
}

/** A catering row cancelled before the kitchen ever had it: never in the live queue. */
export function isCancelledUnfiredCatering(row) {
  if (!row || !isCateringSource(row.source)) return false;
  const st = norm(row.status);
  return (st === 'cancelled' || st === 'canceled') && !row.kitchen_routed_at;
}

/** The till's own mirror of liveQueueOrFilter, for realtime rows: true means keep it out. */
export function keptOutOfLiveQueue(row, nowMs) {
  return isFutureCatering(row, nowMs) || isCancelledUnfiredCatering(row);
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
 * THE FALLBACK PREP TIME for an ezCater order at a venue that has not set a catering prep time.
 *
 * A ServOS catering order cannot be placed at such a venue at all (CateringSettings refuses to
 * switch catering on without a prep time), but an ezCater order arrives whatever we have set.
 * Reading the gap as 0 would start the kitchen at the very moment the food must be handed over.
 * 60 minutes is the fallback, not the venue's online collection lead time: that lead time is
 * sized for a single online order (often 15 to 20 minutes), not for a catering tray for a room
 * of people, and starting a held catering order early is recoverable while starting it late is
 * not. It is shown as a warning on the ezCater Connect screen and on every order it timed, until
 * the venue sets its own catering prep time.
 */
export const EZ_PREP_FALLBACK_MINUTES = 60;

/**
 * The catering prep time a venue has actually SET: { minutes, isSet }. A saved 0 is a real
 * choice (the kitchen starts at the ready time), a missing row or a blank field is not set.
 */
export function cateringPrepSetting(settings) {
  const raw = settings?.prep_time_minutes;
  if (raw == null || raw === '') return { minutes: 0, isSet: false };
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return { minutes: 0, isSet: false };
  return { minutes: Math.round(n), isSet: true };
}

/**
 * The prep time an ezCater order is timed by, and where it came from. The venue's own catering
 * prep time whenever it is set, else EZ_PREP_FALLBACK_MINUTES with prepFallback true, so the
 * webhook, the Connect screen and the order can all say so.
 */
export function ezcaterPrepFor(settings) {
  const s = cateringPrepSetting(settings);
  if (s.isSet) return { prepMinutes: s.minutes, prepFallback: false, prepSource: 'catering_settings' };
  return { prepMinutes: EZ_PREP_FALLBACK_MINUTES, prepFallback: true, prepSource: 'fallback' };
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

/**
 * The ONLY ezCater lifecycle values that mean the order is dead. 'rejected' is NOT one of them
 * (review round 3, 18 Sep 2026). ezCater's documented flows ("Order Event Notification Flows"):
 *   * Submitted, Rejected sends submitted, rejected AND cancelled. The cancelled is what kills it.
 *   * Submitted, Accepted, Modified, Rejected sends submitted, accepted, rejected and NO
 *     cancelled: "rejected order modifications will not result in a canceled notification,
 *     ezCater is working behind the scenes to save the order". The accepted order stands.
 * So a rejected answer never cancels an order here; a cancelled one does.
 */
export const EZ_DEAD = new Set(['cancelled', 'canceled', 'cancelled_for_replacement']);

/**
 * What an ezCater lifecycle answer means for an order we may already have seen accepted.
 * A 'rejected' on an order that was accepted before is a rejected MODIFICATION: the order stays
 * accepted (committed, it still fires) and modificationRejected tells staff to check ezCater.
 * A 'rejected' on an order never accepted stays 'rejected', which is not committed, so it is
 * held and visible until ezCater's cancelled arrives. Every other value passes through.
 *   priorAccepted   accepted notifications seen before this answer (ezcater_order_links)
 *   prevLifecycle   the lifecycle stored on the row before this answer (customer.ezcater_lifecycle)
 */
export function ezEffectiveLifecycle(raw, { priorAccepted = 0, prevLifecycle = null } = {}) {
  const life = norm(raw);
  const prev = norm(prevLifecycle);
  if (life === 'rejected' && (Number(priorAccepted) >= 1 || EZ_COMMITTED.has(prev))) {
    return { lifecycle: EZ_COMMITTED.has(prev) ? prev : 'accepted', modificationRejected: true };
  }
  return { lifecycle: life, modificationRejected: false };
}

/**
 * Statuses a row must NOT have for anything to claim it for the kitchen. Used by BOTH
 * kitchen_routed_at claims (the till's routeKioskOrderPrints and the catering-release cron) in the
 * same UPDATE as `kitchen_routed_at is null`, together with releasableOrFilter, so a cancel (or
 * an ezCater order falling back to not accepted) landing between the pre fire decision and the
 * claim can never fire the order silently.
 */
export const UNCLAIMABLE_STATUSES_PG = '(cancelled,canceled,collected)';

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
 * The same hold rule as a PostgREST .or() filter, so the release queries never read held rows
 * at all: a batch of unaccepted ezCater orders sorted oldest first must never fill the page and
 * starve the due orders behind them. Mirrors cateringHoldReason: an ezCater row is held when its
 * lifecycle is set and not committed; any other source, or no lifecycle, may fire.
 */
export function releasableOrFilter() {
  return `source.neq.ezcater,customer->>ezcater_lifecycle.is.null,customer->>ezcater_lifecycle.in.(${[...EZ_COMMITTED].join(',')})`;
}

/**
 * How far back the catering-release cron looks. The same two hours as the tills'
 * STALE_ORDER_FLOOR_MS (src/sync/staleness.js, pinned equal by a test): an order whose fire
 * moment is older than that is never auto fired by anything, it stays visible for staff to send.
 */
export const CATERING_STALE_FLOOR_MS = 2 * 60 * 60 * 1000;

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
  if (st === 'cancelled' || st === 'canceled') {
    if (row?.customer?.replacedBy) return row?.kitchen_routed_at ? 'Replaced after kitchen' : 'Replaced';
    return row?.kitchen_routed_at ? 'Cancelled after kitchen' : 'Cancelled';
  }
  if (change && Array.isArray(change.kinds) && change.kinds.length) return 'Changed after kitchen';
  if (st === 'done' || st === 'collected') return 'Completed';
  if (st === 'prep' || row?.kitchen_routed_at) return 'In kitchen';
  if (cateringHoldReason(row) === 'awaiting_ezcater_acceptance') return 'Awaiting ezCater acceptance';
  return 'Scheduled';
}

// ── Catering capacity ────────────────────────────────────────────────────────

/**
 * One day's catering load for the capacity gate on our own catering site: { count, value,
 * otherCurrency }. Every catering order counts toward the COUNT, ezCater included. The VALUE
 * adds an order only in the venue's own catering currency: an ezCater order carries ezCater's
 * figures in ezCater's currency (customer.totals.currency), and a dollar total is never added to
 * a pound limit as if it were pounds. Such an order is counted in otherCurrency instead, so a
 * venue on value capacity still sees it. Nothing is ever converted.
 * rows: { source, status, total, currency } where currency is the row's own (null = the venue's).
 */
export function cateringDayLoad(rows, venueCurrency) {
  const venueCur = norm(venueCurrency) || 'gbp';
  let count = 0; let value = 0; let otherCurrency = 0;
  for (const r of rows || []) {
    if (!r || !isCateringSource(r.source)) continue;
    const st = norm(r.status);
    if (st === 'cancelled' || st === 'canceled') continue;
    count++;
    const cur = norm(r.currency) || venueCur;
    if (cur === venueCur) value += Number(r.total) || 0;
    else otherCurrency++;
  }
  return { count, value: Math.round(value * 100) / 100, otherCurrency };
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
