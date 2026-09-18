// supabase/functions/_shared/ezcaterCatering.js
//
// What one ezCater notification does to an order that may already be in order_queue.
// Pure: no I/O, no Deno, no clock reads (the caller passes nowIso). Imported by
// ezcater-webhook/index.ts and unit tested from src/lib/ezcaterCatering.test.js.
//
// ezCater has no "modified" event: a changed order arrives as another accepted notification,
// a cancel as a cancelled or rejected one, and an UNCANCEL sends nothing until the order is
// accepted again (ezCater, "Order Event Notification Flows": Submitted, Accepted, Cancelled,
// Uncancelled, Accepted sends submitted, accepted, cancelled, accepted). Whatever arrives, an
// ezCater order follows the same rules as a ServOS catering order:
//
//   NOT FIRED YET (kitchen_routed_at is null). The order is still held. A changed time moves the
//   kitchen fire time, the venue date and the venue time (reschedule), so it fires at the right
//   moment, and a fire time that is already past becomes NOW (fire now if due). A cancel marks it
//   cancelled: the advance list and the release both skip it. A later non terminal lifecycle
//   (the uncancel then accept flow) RESTORES it to the held catering state with a freshly
//   computed fire time. The one exception is an order ezCater replaced with a new order
//   (customer.replacedBy): that stays stopped whatever arrives, so the kitchen never makes both.
//
//   ALREADY FIRED (kitchen_routed_at set, or unknown because the venue lacks the column). The
//   kitchen has the ticket, so the fire time, date and time the kitchen was given never move.
//   Any change (items, time, cancel, uncancel, replaced) is stamped on customer.changedAfterFire,
//   which the Orders Hub shows on the card and every till raises as an alert
//   (src/lib/realtime.js), so staff see it plainly instead of cooking the old order.
//
//   A TIME CHANGE is judged against the order's OWN last ezCater times (customer.readyAt and
//   customer.eventAt as last written), never against sent_at. sent_at is our fire time: it is
//   frozen once fired and it moves with the venue's prep setting, so comparing with it repeated
//   the alert on every later notification and raised one for a prep setting change.
//
// Status: an order already in preparation keeps its progress, and a cancellation always wins.

const MINUTE = 60000;

const msOf = (v) => {
  if (v == null || v === '') return NaN;
  const t = typeof v === 'number' ? v : new Date(v).getTime();
  return Number.isFinite(t) ? t : NaN;
};

const isCancelledStatus = (st) => st === 'cancelled' || st === 'canceled';

// Markers that belong to the ROW, not to one ezCater answer. The customer jsonb is rewritten
// whole on every write, so these are carried across unless the new answer sets them itself.
const STICKY = ['replacedBy', 'possibleReplacement', 'ezcaterCheck', 'resyncedAt'];

// Statuses staff reach by hand that an unfired row keeps. Anything else on an unfired row is
// what ezCater says it is (an old 'prep' on an order the kitchen never had, like HKX77V, is not
// progress: nobody cooked it).
const STAFF_PROGRESS = ['ready', 'done', 'collected'];

/** A fire moment already past becomes now: an order due is fired now, never left behind. */
function fireNowIfDue(fireAt, nowMs, nowIso) {
  const f = msOf(fireAt);
  if (!Number.isFinite(f) || !Number.isFinite(nowMs)) return fireAt ?? null;
  return f < nowMs ? nowIso : fireAt;
}

/**
 * What the kitchen makes, as one comparable string: each line's name, size, quantity and options.
 * Prices and ids are left out, so a re-priced or re-matched line is not a change to the food.
 */
function itemsSignature(items) {
  if (!Array.isArray(items)) return null;
  return JSON.stringify(items.map((l) => [
    String(l?.name ?? '').trim().toLowerCase(), String(l?.sizeName ?? '').trim().toLowerCase(), Number(l?.qty) || 0,
    (Array.isArray(l?.mods) ? l.mods : []).map((m) => [String(m?.label ?? m?.name ?? '').trim().toLowerCase(), Number(m?.qty) || 0]),
    String(l?.notes ?? '').trim(),
  ]));
}

/** Did ezCater move the order's own times since we last wrote them? Needs a previous value. */
function timeMoved(prev, next) {
  for (const k of ['readyAt', 'eventAt']) {
    const a = msOf(prev?.[k]);
    const b = msOf(next?.[k]);
    if (Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) >= MINUTE) return true;
  }
  return false;
}

/**
 * @param {object} args
 * @param {object} args.row       the mapper's row (orderToQueueRow, after item matching)
 * @param {object|null} args.existing  the order_queue row already stored, or null
 * @param {boolean} args.terminal ezCater says the order is dead (cancelled / rejected)
 * @param {string} args.nowIso    the write time
 * @returns {{ row: object, reschedule: boolean, fired: boolean, restored: boolean, changedAfterFire: object|null }}
 */
export function ezcaterWritePlan({ row, existing, terminal, nowIso }) {
  const nowMs = msOf(nowIso);
  if (!existing) {
    const fire_at = terminal ? row.fire_at : fireNowIfDue(row.fire_at, nowMs, nowIso);
    return { row: { ...row, fire_at }, reschedule: false, fired: false, restored: false, changedAfterFire: null };
  }

  const fired = !!existing.kitchen_routed_at;
  const prevStatus = String(existing.status || '').toLowerCase();
  const wasCancelled = isCancelledStatus(prevStatus);
  const prevCustomer = existing.customer && typeof existing.customer === 'object' ? existing.customer : {};
  const customer = { ...(row.customer || {}) };
  for (const k of STICKY) {
    if (customer[k] === undefined && prevCustomer[k] !== undefined) customer[k] = prevCustomer[k];
  }
  const replaced = !!customer.replacedBy;

  let status;
  if (terminal) status = 'cancelled';
  else if (replaced && !fired) status = 'cancelled';
  else if (fired) status = wasCancelled ? 'prep' : existing.status;
  else status = STAFF_PROGRESS.includes(prevStatus) ? existing.status : row.status;

  const reschedule = !fired && !terminal && !replaced;
  const restored = wasCancelled && status !== 'cancelled';

  const kinds = [];
  if (fired) {
    if (terminal && !wasCancelled) kinds.push(replaced ? 'replaced' : 'cancelled');
    if (!terminal) {
      if (wasCancelled) kinds.push('uncancelled');
      // The food itself changed. Judged on the lines when both are known (a modification that
      // only moved the time is not an items change); the modification count otherwise.
      const was = itemsSignature(existing.items);
      const now = itemsSignature(row.items);
      if (was !== null && now !== null) { if (was !== now) kinds.push('items'); }
      else {
        const nowMods = Number(customer.modificationCount) || 0;
        const prevMods = Number(prevCustomer.modificationCount) || 0;
        if (customer.modified && nowMods > prevMods) kinds.push('items');
      }
      if (timeMoved(prevCustomer, customer)) kinds.push('time');
    }
  }

  let changedAfterFire = null;
  if (kinds.length) {
    changedAfterFire = {
      at: nowIso,
      kinds,
      was: {
        event_date: existing.event_date ?? prevCustomer.event_date ?? null,
        time: prevCustomer.event_time ?? existing.collection_time ?? null,
        ready_time: prevCustomer.ready_time ?? null,
        readyAt: prevCustomer.readyAt ?? null,
        fire_at: existing.sent_at ?? null,
      },
      now: {
        event_date: customer.event_date ?? row.event_date ?? null,
        time: customer.event_time ?? row.collection_time ?? null,
        ready_time: customer.ready_time ?? null,
        readyAt: customer.readyAt ?? null,
        fire_at: row.fire_at ?? null,
      },
      ...(kinds.includes('replaced') ? { replacedBy: customer.replacedBy } : {}),
    };
    customer.changedAfterFire = changedAfterFire;
  } else if (prevCustomer.changedAfterFire) {
    // Keep an earlier change visible until staff have dealt with the order.
    customer.changedAfterFire = prevCustomer.changedAfterFire;
  }
  if (restored) customer.restoredAt = nowIso;

  const fire_at = reschedule ? fireNowIfDue(row.fire_at, nowMs, nowIso) : row.fire_at;
  return { row: { ...row, status, customer, fire_at }, reschedule, fired, restored, changedAfterFire };
}

/**
 * What the pre fire check does with an unfired order once ezCater has answered and the write
 * plan has run on that answer (planRow = plan.row):
 *   'cancelled'                    ezCater says it is dead, or it was replaced: never fired
 *   'awaiting_ezcater_acceptance'  ezCater says it is not accepted (yet, or any more): held
 *   'rescheduled'                  ezCater moved it and its new fire moment is still ahead
 *   'fire'                         fire it now
 * holdReason is the release's own rule (cateringRules.js cateringHoldReason), passed in so this
 * file keeps no import of its own.
 */
export function prefireOutcome(planRow, nowMs, holdReason) {
  const st = String(planRow?.status || '').toLowerCase();
  if (isCancelledStatus(st)) return 'cancelled';
  const hold = holdReason ? holdReason(planRow) : null;
  if (hold) return hold;
  const f = msOf(planRow?.fire_at);
  if (Number.isFinite(f) && f > nowMs + MINUTE) return 'rescheduled';
  return 'fire';
}

// ── Cancelled for replacement ────────────────────────────────────────────────
//
// ezCater's Order has NO field that links a replacement to the order it replaces (Order Schema
// Reference: caterer, catererCart, deliveryId, event, isTaxExempt, lifecycle, orderCustomer,
// orderNumber, orderSourceType, taxableAddress, totals, uuid; nothing else), and "Cancelled for
// Replacement" sends NO notification for the original ("Order Event Notification Flows"). So the
// only proof that an original is dead is ezCater's own answer about THAT order, which is why it
// is re-asked (1) the moment a likely replacement arrives and (2) right before it would fire.
// likelyReplacement only decides which orders are worth re-asking about. It never stops an order
// on its own: two genuine orders for one office on one day are normal catering.

const digits = (v) => String(v ?? '').replace(/\D/g, '');
const flat = (v) => String(v ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Could `newRow` (just arrived) be ezCater's replacement for `other` (already stored)? Same
 * caterer, a different ezCater order, same order type, the same on site contact (phone, or name
 * when neither has a phone), the same delivery address on a delivery, and event times within
 * three hours of each other. Never a cancelled, collected or already replaced order.
 */
export function likelyReplacement(newRow, other) {
  if (!newRow || !other) return false;
  const a = newRow.customer || {}; const b = other.customer || {};
  if (String(other.source || '').toLowerCase() !== 'ezcater') return false;
  if (!a.ezcater_order_id || !b.ezcater_order_id || a.ezcater_order_id === b.ezcater_order_id) return false;
  const st = String(other.status || '').toLowerCase();
  if (isCancelledStatus(st) || st === 'collected' || b.replacedBy) return false;
  if (a.ezcater_caterer_id && b.ezcater_caterer_id && a.ezcater_caterer_id !== b.ezcater_caterer_id) return false;
  if ((newRow.type || '') !== (other.type || '')) return false;
  const pa = digits(a.phone); const pb = digits(b.phone);
  if (pa.length >= 7 || pb.length >= 7) { if (pa !== pb) return false; }
  else if (!flat(a.name) || flat(a.name) !== flat(b.name)) return false;
  if (newRow.type === 'delivery') {
    const ka = `${flat(a.address?.line1)}|${flat(a.address?.postcode)}`;
    const kb = `${flat(b.address?.line1)}|${flat(b.address?.postcode)}`;
    if (ka === '|' || ka !== kb) return false;
  }
  const ta = msOf(a.eventAt ?? a.readyAt); const tb = msOf(b.eventAt ?? b.readyAt);
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return false;
  return Math.abs(ta - tb) <= 3 * 60 * MINUTE;
}

/**
 * Plain words for staff about one ezCater order, for the Orders Hub and the advance list.
 * Empty when there is nothing to say.
 */
export function ezcaterOrderWarnings(row) {
  const c = row?.customer || {};
  const out = [];
  if (c.replacedBy) {
    out.push(`Replaced on ezCater by order ${c.replacedBy.orderNumber || c.replacedBy.ref}. ${row?.kitchen_routed_at ? 'The kitchen already had this one: make the new order, not both.' : 'Not sent to the kitchen.'}`);
  } else if (c.possibleReplacement) {
    const p = c.possibleReplacement;
    out.push(`ezCater order ${p.orderNumber || p.ref} is for the same customer, place and time. ${p.ezcaterSays ? `ezCater still lists this one as ${p.ezcaterSays}` : 'ezCater could not be asked about this one'}: check it is not a replacement before making both.`);
  }
  if (c.prepFallback) {
    out.push(`No catering prep time is set for this venue, so the kitchen was timed with ${c.prepMinutes ?? 60} minutes. Set it in Back Office, Catering settings.`);
  }
  if (c.ezcaterCheck && c.ezcaterCheck.ok === false) {
    out.push(`ezCater could not be reached to re-check this order before it went to the kitchen (${c.ezcaterCheck.why || 'no answer'}). Check ezCater for last minute changes.`);
  }
  return out;
}

/** Plain words for a change after firing, for the Orders Hub card and the till alert. */
export function changedAfterFireText(change) {
  if (!change || !Array.isArray(change.kinds) || !change.kinds.length) return null;
  if (change.kinds.includes('replaced')) {
    const by = change.replacedBy?.orderNumber || change.replacedBy?.ref;
    return `Replaced on ezCater${by ? ` by order ${by}` : ''} after it went to the kitchen: make the new order, not both`;
  }
  if (change.kinds.includes('cancelled')) return 'Cancelled on ezCater after it went to the kitchen';
  const parts = [];
  if (change.kinds.includes('uncancelled')) parts.push('uncancelled (it was cancelled, it is back on)');
  if (change.kinds.includes('items')) parts.push('items');
  if (change.kinds.includes('time')) {
    const was = change.was?.time ? `${change.was.event_date ? `${change.was.event_date} ` : ''}${change.was.time}` : null;
    const now = change.now?.time ? `${change.now.event_date ? `${change.now.event_date} ` : ''}${change.now.time}` : null;
    parts.push(was && now ? `time (was ${was}, now ${now})` : 'time');
  }
  return `Changed on ezCater after it went to the kitchen: ${parts.join(' and ')}`;
}
