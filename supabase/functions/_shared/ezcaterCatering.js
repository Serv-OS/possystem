// supabase/functions/_shared/ezcaterCatering.js
//
// AN EZCATER ORDER IS FILED AS A SERVOS CATERING ORDER (Peter, 18 Sep 2026, "the simpler version").
//
// Pure functions only: no I/O, no Deno, no Supabase, no clock reads (the caller passes now).
// Imported by the ezCater webhook, the catering-release cron, order-notify, review-request and the
// courier dispatcher, and by the app through src/lib/ezcaterCatering.js. Tested from
// src/lib/ezcaterCatering.test.js under plain node.
//
// THE RULE. The webhook writes order_queue in EXACTLY the shape CateringCheckout.jsx writes for one
// of our own catering orders: source 'catering', status 'received', event_date and collection_time
// on the VENUE clock, sent_at = the kitchen fire time from cateringRules.js with the venue's own
// catering prep time, kitchen_routed_at null, paid true. So every catering path (the Back Office
// advance list, the till release, the catering-release cron, QueueSync's future catering test, the
// Orders Hub, capacity) handles it with no change of its own.
//
// It is marked as ezCater ONLY in the customer jsonb: customer.channel = 'ezcater', plus the ezCater
// order id and number. The few places that must treat it differently key on isEzcaterOrder:
//   * order-notify sends nothing (ezCater owns that customer)
//   * no ServOS courier is ever booked (the caterer or ezCater delivers)
//   * review-request never texts its customer
//   * money: ezCater collected it, so it never reads as unpaid and is never refunded through us
//   * an order ezCater has not accepted yet is HELD (never released to the kitchen)
//
// Deliberately NOT in v1 (see DECISIONS.md): scheduled re-asks of ezCater, a re-check of the order
// just before it fires, and detection of a "cancelled for replacement" order.

import { cateringFireMs, venueWallClock, wallTimeToInstantMs, DEFAULT_VENUE_TZ } from './cateringRules.js';

export const EZ_CHANNEL = 'ezcater';

/**
 * The prep time an ezCater order is timed by when the venue has NO catering prep time set. A
 * ServOS catering order cannot be taken at such a venue, but an ezCater order arrives anyway, and
 * reading the gap as 0 would start the kitchen at the moment the food must be handed over.
 * Flagged on the order (customer.prep_fallback) so staff can see it.
 */
export const EZ_PREP_FALLBACK_MINUTES = 60;

/** Lifecycle values that mean the caterer is committed to cooking it. */
export const EZ_COMMITTED = new Set([
  'accepted', 'relish_finalized', 'ready', 'ready_for_pickup', 'completed', 'fulfilled', 'delivered',
]);

/**
 * The ONLY lifecycle values that end an order. 'rejected' is NOT one: ezCater's documented flows
 * send a cancelled after a rejected NEW order, and a rejected MODIFICATION of an accepted order
 * sends no cancelled at all ("ezCater is working behind the scenes to save the order").
 */
export const EZ_DEAD = new Set(['cancelled', 'canceled', 'cancelled_for_replacement']);

export const FLAG_CHANGED_AFTER_FIRE = 'Changed on ezCater after it went to the kitchen: see ezCater';
export const FLAG_CANCELLED_AFTER_FIRE = 'Cancelled on ezCater after it went to the kitchen: stop this order';
export const AWAITING_LABEL = 'Awaiting ezCater acceptance';

const norm = (v) => String(v ?? '').trim().toLowerCase();

// ── Who is ezCater ───────────────────────────────────────────────────────────

/**
 * True for an order (order_queue row, till queue order or closed check) that came from ezCater.
 * Keyed on customer.channel, compared without case, so the one test row written before this
 * change (source 'ezcater', customer.channel 'ezCater') is covered too.
 */
export function isEzcaterOrder(order) {
  if (!order || typeof order !== 'object') return false;
  if (norm(order.source) === EZ_CHANNEL) return true;
  const c = order.customer;
  return !!(c && typeof c === 'object' && norm(c.channel) === EZ_CHANNEL);
}

/** May ServOS send its own confirmation or ready message to this order's customer? */
export function mayMessageCustomer(order) {
  return !isEzcaterOrder(order);
}

/** May ServOS book its own courier (Stuart / Uber Direct) for this order? Never for ezCater. */
export function mayBookOurCourier(order) {
  return !isEzcaterOrder(order);
}

/** May we take or refund money for this order through our own processors? Never for ezCater. */
export function mayTakeOrRefundMoney(order) {
  return !isEzcaterOrder(order);
}

/** ezCater collected the money, so an ezCater order is always paid, whatever flag a copy lost. */
export function isPrepaidByChannel(order) {
  return isEzcaterOrder(order);
}

// ── Labels staff see ─────────────────────────────────────────────────────────

/** 'ezCater' for an ezCater order, 'Catering' for one of ours, null for anything else. */
export function cateringChannelLabel(order) {
  if (isEzcaterOrder(order)) return 'ezCater';
  return norm(order?.source) === 'catering' ? 'Catering' : null;
}

/** The ezCater order number (what the caterer sees on ezCater), or null. */
export function ezcaterOrderNumber(order) {
  const n = order?.customer?.ezcater_order_number;
  const s = n == null ? '' : String(n).trim();
  return s || null;
}

/** The number staff call out: the ezCater order number when there is one, else our ref. */
export function cateringOrderNumber(order) {
  return (isEzcaterOrder(order) && ezcaterOrderNumber(order)) || order?.ref || null;
}

/** 'ezCater HKX77V' for an ezCater order, else null. */
export function ezcaterBadge(order) {
  if (!isEzcaterOrder(order)) return null;
  const n = ezcaterOrderNumber(order);
  return n ? `ezCater ${n}` : 'ezCater';
}

/** The plain flag staff must see on an ezCater order (changed or cancelled after firing), or null. */
export function ezcaterFlagText(order) {
  const f = order?.customer?.ezcater_flag;
  if (!f) return null;
  if (typeof f === 'string') return f;
  return typeof f.text === 'string' && f.text.trim() ? f.text : null;
}

// ── The hold ─────────────────────────────────────────────────────────────────

/** True while ezCater has not accepted this order: it must not be released to the kitchen. */
export function isAwaitingEzcaterAcceptance(order) {
  const c = order?.customer;
  return !!(c && typeof c === 'object' && c.ezcater_awaiting_acceptance === true);
}

/**
 * The PostgREST .or() filter the catering releases (the till's releaseDueCateringOrders and the
 * catering-release cron) add so a held ezCater order is never read for release. Every other row
 * has no such key (null) and passes.
 */
export const RELEASABLE_OR_FILTER =
  'customer->>ezcater_awaiting_acceptance.is.null,customer->>ezcater_awaiting_acceptance.neq.true';

/** Statuses a catering release never fires: finished, or cancelled before the kitchen had it. */
export const NOT_RELEASABLE_STATUSES_PG = '(collected,cancelled)';

/** The in memory mirror of the release filters, for tests and for anything holding a row. */
export function cateringMayRelease(row) {
  if (!row) return false;
  const st = norm(row.status);
  if (st === 'collected' || st === 'cancelled') return false;
  if (row.kitchen_routed_at) return false;
  return !isAwaitingEzcaterAcceptance(row);
}

/** The status word on the Back Office advance list. Ours read exactly as before. */
export function advanceStatusLabel(o) {
  if (!o) return 'Scheduled';
  const flag = ezcaterFlagText(o);
  if (o.status === 'cancelled') return flag ? 'Cancelled after kitchen' : 'Cancelled';
  if (flag) return 'Changed after kitchen';
  if (o.status === 'prep' || o.kitchen_routed_at) return 'In kitchen';
  if (o.status === 'done') return 'Completed';
  if (isAwaitingEzcaterAcceptance(o)) return AWAITING_LABEL;
  return 'Scheduled';
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

/**
 * What an ezCater lifecycle value means here:
 *   { dead }       cancelled: the order is over (the only terminal answer)
 *   { awaiting }   not accepted yet (submitted, draft, a rejected NEW order, anything unknown): held
 *   { committed }  accepted (or later): fires at its catering fire time
 * A 'rejected' for an order accepted before is a rejected MODIFICATION: the accepted order stands.
 */
export function ezLifecycleState(raw, { priorAccepted = 0, prevLifecycle = null } = {}) {
  const life = norm(raw);
  if (EZ_DEAD.has(life)) return { lifecycle: life, dead: true, awaiting: false, committed: false, modificationRejected: false };
  if (life === 'rejected' && (Number(priorAccepted) >= 1 || EZ_COMMITTED.has(norm(prevLifecycle)))) {
    return { lifecycle: 'accepted', dead: false, awaiting: false, committed: true, modificationRejected: true };
  }
  const committed = EZ_COMMITTED.has(life);
  return { lifecycle: life || null, dead: false, awaiting: !committed, committed, modificationRejected: false };
}

// ── Timing and the row ───────────────────────────────────────────────────────

/**
 * The prep time an ezCater order is timed by: the venue's catering prep time (the same field
 * CateringCheckout reads) when it is set, else EZ_PREP_FALLBACK_MINUTES, flagged.
 */
export function ezcaterPrep(settings) {
  const raw = settings?.prep_time_minutes;
  if (raw == null || raw === '' || !Number.isFinite(Number(raw)) || Number(raw) < 0) {
    return { prepMinutes: EZ_PREP_FALLBACK_MINUTES, prepFallback: true };
  }
  return { prepMinutes: Math.max(0, Number(raw) || 0), prepFallback: false };
}

const ms = (v) => { const t = Date.parse(String(v ?? '')); return Number.isFinite(t) ? t : NaN; };

/**
 * When the food is needed and when the kitchen starts, on the VENUE clock.
 *   event     ezCater's event.timestamp (when the customer expects the food): event_date and
 *             collection_time, the same two fields a ServOS catering order carries
 *   ready     catererHandoffFoodTime when ezCater sent one (on a delivery the food leaves before
 *             the event time), else the event time
 *   sent_at   cateringFireMs(ready, prep): the SAME rule as our checkout
 * mapped is the row orderToQueueRow built (fire_at = event.timestamp, customer.handoffAt).
 */
export function ezcaterCateringTiming(mapped, { venueTz, prepMinutes, nowMs }) {
  const tz = (typeof venueTz === 'string' && venueTz.trim()) ? venueTz.trim() : DEFAULT_VENUE_TZ;
  let eventMs = ms(mapped?.fire_at);
  // No parseable instant: read the mapper's own date and time on the venue clock instead.
  if (!Number.isFinite(eventMs) && mapped?.event_date) {
    eventMs = wallTimeToInstantMs(mapped.event_date, mapped.collection_time || '12:00', tz);
  }
  const handoffMs = ms(mapped?.customer?.handoffAt);
  const readyMs = Number.isFinite(handoffMs) ? handoffMs : eventMs;
  const fireMs = cateringFireMs(readyMs, prepMinutes);
  const ev = Number.isFinite(eventMs) ? venueWallClock(eventMs, tz) : null;
  const rd = Number.isFinite(readyMs) ? venueWallClock(readyMs, tz) : null;
  return {
    event_date: ev ? ev.date : (mapped?.event_date || null),
    collection_time: ev ? ev.time : (mapped?.collection_time || null),
    ready_time: rd ? rd.time : null,
    // CateringCheckout falls back to now when there is no event time. So does this.
    sent_at: new Date(Number.isFinite(fireMs) ? fireMs : nowMs).toISOString(),
    venueTz: tz,
  };
}

/** Catering line shape: every line carries the three fields CateringCheckout's lines do. */
function asCateringLine(l) {
  return { cat: null, cats: null, ...l, status: 'received', fired: false, course: 1 };
}

/**
 * The order_queue row for an ezCater order, in the ServOS catering shape. mapped is the row from
 * orderToQueueRow (after item matching). lifecycle is the raw ezCater lifecycle value.
 */
export function ezcaterCateringRow(mapped, {
  venueTz, prepMinutes, prepFallback = false, nowMs, priorAccepted = 0, prevLifecycle = null, lifecycle,
}) {
  const t = ezcaterCateringTiming(mapped, { venueTz, prepMinutes, nowMs });
  const state = ezLifecycleState(lifecycle ?? mapped?.customer?.ezcater_lifecycle, { priorAccepted, prevLifecycle });
  const type = mapped?.type === 'delivery' ? 'delivery' : 'collection';
  const c = mapped?.customer || {};
  const customer = {
    ...c,
    channel: EZ_CHANNEL,
    fulfilment: type,
    // Our order type words, so the kitchen ticket prints its customer block as it does for our
    // catering. ezCater's own word (DELIVERY, TAKEOUT, THIRD_PARTY_DELIVERY) is kept beside it.
    serviceType: type,
    ezcater_service_type: c.serviceType || null,
    event_date: t.event_date,
    event_time: t.collection_time,
    ready_time: t.ready_time,
    venueTimeZone: t.venueTz,
    prep_minutes: prepMinutes,
    prep_fallback: !!prepFallback,
    ezcater_lifecycle: state.lifecycle,
    ezcater_awaiting_acceptance: state.awaiting,
    ...(state.modificationRejected ? { ezcater_modification_rejected: true } : {}),
    paid: true,
    due: 0,
  };
  return {
    ref: mapped.ref,
    location_id: mapped.location_id,
    type,
    status: 'received',
    source: 'catering',
    event_date: t.event_date,
    collection_time: t.collection_time,
    is_asap: false,
    paid: true,
    items: (Array.isArray(mapped.items) ? mapped.items : []).map(asCateringLine),
    customer,
    total: mapped.total,
    sent_at: t.sent_at,
    kitchen_routed_at: null,
    payment_method: 'ezcater',
  };
}

/** What makes two versions of an order different for the kitchen. Links (itemId) are not. */
export function kitchenFingerprint(row) {
  const items = (Array.isArray(row?.items) ? row.items : []).map((l) => [
    String(l?.name || ''), Number(l?.qty) || 1, Number(l?.lineSubunits ?? Math.round((Number(l?.price) || 0) * 100)) || 0,
    (Array.isArray(l?.mods) ? l.mods : []).map((m) => `${m?.label || m?.name || ''}x${Number(m?.qty) || 1}`).join('|'),
    String(l?.notes || ''), String(l?.kitchenNote || ''),
  ]);
  return JSON.stringify([row?.type || null, Number(row?.total) || 0, row?.event_date || null, row?.collection_time || null, items]);
}

// ── The write plan ───────────────────────────────────────────────────────────

/**
 * What the webhook does with one notification, given the row it built and the row already there.
 *   next      the ezcaterCateringRow for this notification (never null)
 *   existing  the order_queue row now (ref, source, status, kitchen_routed_at, customer, items,
 *             total, type, event_date, collection_time), or null
 *   linkKnown true when ezcater_order_links already has this order (read BEFORE this run
 *             writes its own link): with no queue row that means it was finished, so nothing
 *             is written
 * Returns one of:
 *   { kind: 'skip', reason }
 *   { kind: 'insert', row }                  first sight of a live order
 *   { kind: 'unfired', patch }               before firing: items, times, totals in place, or a cancel
 *   { kind: 'fired', patch, flag }           after firing: the row is left alone, staff get a flag
 * 'unfired' writes are made only while kitchen_routed_at is still null; when that loses a race
 * the webhook re-reads the row and asks again, and gets 'fired'.
 */
export function ezcaterWritePlan({ next, existing, nowIso, linkKnown = false }) {
  const state = ezLifecycleState(next?.customer?.ezcater_lifecycle);
  const dead = EZ_DEAD.has(norm(next?.customer?.ezcater_lifecycle));

  if (!existing) {
    if (dead) return { kind: 'skip', reason: 'cancelled before we ever had it' };
    // NEVER BRING A FINISHED ORDER BACK. ezcater_order_links is written only AFTER a
    // notification has been handled, so a link with no queue row means we had this order and it
    // has since left the queue (staff collected or removed it). A later notification (a status
    // step, a repeat) must not write it again: that would put a fresh row in the queue with a
    // fire time in the past and the catering release would send the kitchen a second ticket.
    // The first notification of a new order has no link yet (its link is written after this
    // plan runs), so it still inserts.
    if (linkKnown) return { kind: 'skip', reason: 'already handled and no longer in the queue (finished), not brought back' };
    return { kind: 'insert', row: next };
  }
  // The live test order written before this change (source 'ezcater') stays exactly as it is.
  if (norm(existing.source) !== 'catering') return { kind: 'skip', reason: 'row written before ezCater orders were catering orders, left as it is' };
  // Cancelled is terminal. Nothing revives it.
  if (norm(existing.status) === 'cancelled') return { kind: 'skip', reason: 'already cancelled' };

  const fired = !!existing.kitchen_routed_at;
  const prevCustomer = existing.customer && typeof existing.customer === 'object' ? existing.customer : {};

  if (dead) {
    if (!fired) {
      return { kind: 'unfired', patch: { status: 'cancelled', customer: { ...prevCustomer, ezcater_lifecycle: state.lifecycle, ezcater_awaiting_acceptance: false } } };
    }
    const flag = { kind: 'cancelled_after_fire', text: FLAG_CANCELLED_AFTER_FIRE, at: nowIso };
    return { kind: 'fired', flag, patch: { status: 'cancelled', customer: { ...prevCustomer, ezcater_lifecycle: state.lifecycle, ezcater_flag: flag } } };
  }

  if (!fired) {
    // Before the kitchen has it: the order is simply replaced in place, fire time recomputed.
    // status is never touched here (staff progress stands); kitchen_routed_at is never written.
    const patch = { ...next };
    for (const k of ['ref', 'location_id', 'status', 'kitchen_routed_at']) delete patch[k];
    // The held past its fire time alert is once per order: its stamp survives the replace.
    if (prevCustomer.ezcater_hold_alerted_at) {
      patch.customer = { ...patch.customer, ezcater_hold_alerted_at: prevCustomer.ezcater_hold_alerted_at };
    }
    return { kind: 'unfired', patch };
  }

  // After the kitchen has it: the order itself is left alone.
  if (kitchenFingerprint(next) !== kitchenFingerprint(existing)) {
    const flag = { kind: 'changed_after_fire', text: FLAG_CHANGED_AFTER_FIRE, at: nowIso };
    return { kind: 'fired', flag, patch: { customer: { ...prevCustomer, ezcater_lifecycle: next.customer.ezcater_lifecycle, ezcater_flag: flag } } };
  }
  if (norm(prevCustomer.ezcater_lifecycle) !== norm(next.customer.ezcater_lifecycle)) {
    return { kind: 'fired', flag: null, patch: { customer: { ...prevCustomer, ezcater_lifecycle: next.customer.ezcater_lifecycle, ezcater_awaiting_acceptance: false } } };
  }
  return { kind: 'skip', reason: 'already in the kitchen, nothing changed' };
}

// ── Alerts staff must see ────────────────────────────────────────────────────

/**
 * The cancel alert (the red popup and the chime a HubRise cancel raises) for one order_queue
 * realtime event, or null. Two cases, nothing else:
 *   HubRise    a channel cancel, exactly as before (v5.5.550), whether or not it was routed
 *   ezCater    a catering row marked customer.channel 'ezcater' that turns cancelled AFTER it
 *              went to the kitchen (kitchen_routed_at set). One cancelled before the kitchen had
 *              it was never cooked, so it needs no alarm.
 * payload is the Supabase postgres_changes payload ({ eventType, new, old }). order_queue is
 * REPLICA IDENTITY FULL, so old carries the previous status and kitchen_routed_at.
 */
export function channelCancelAlert(payload) {
  if (!payload || payload.eventType !== 'UPDATE') return null;
  const n = payload.new;
  const o = payload.old || {};
  if (!n || n.status !== 'cancelled' || o.status === 'cancelled') return null;
  if (n.source === 'hubrise') {
    return {
      source: 'hubrise', kind: 'cancel',
      who: `${n.customer?.channel || 'HubRise'}`,
      ref: n.ref || '', total: 0, orderType: n.type || null, status: 'cancelled',
    };
  }
  if (norm(n.source) === 'catering' && isEzcaterOrder(n) && (n.kitchen_routed_at || o.kitchen_routed_at)) {
    return {
      source: 'catering', kind: 'cancel',
      who: ezcaterBadge(n) || 'ezCater',
      ref: n.ref || '', total: 0, orderType: n.type || null, status: 'cancelled',
    };
  }
  return null;
}

/**
 * HELD PAST ITS FIRE TIME. An ezCater order still awaiting acceptance on ezCater is correctly
 * never cooked, but when its fire time passes somebody must be told, once. The catering-release
 * cron reads candidates with the filters below, checks each with ezcaterHoldAlertDue, stamps
 * customer.ezcater_hold_alerted_at with a conditional update (so two runs never both win) and
 * writes one urgent activity entry.
 */
export function ezcaterHoldAlertDue(row, nowMs) {
  if (!row || norm(row.source) !== 'catering' || !isEzcaterOrder(row)) return false;
  if (!isAwaitingEzcaterAcceptance(row)) return false;
  if (row.kitchen_routed_at) return false;
  const st = norm(row.status);
  if (st === 'collected' || st === 'cancelled') return false;
  if (row.customer?.ezcater_hold_alerted_at) return false;
  const due = ms(row.sent_at);
  return Number.isFinite(due) && Number.isFinite(nowMs) && due <= nowMs;
}

/** The plain words of that alert. */
export function ezcaterHoldAlertText(row) {
  const n = ezcaterOrderNumber(row);
  const who = n ? `ezCater ${n}` : 'An ezCater order';
  return `${who} is due in the kitchen but has not been accepted on ezCater. Accept it on ezCater and it will fire.`;
}
