// supabase/functions/_shared/ezcaterCatering.js
//
// What one ezCater notification does to an order that may already be in order_queue.
// Pure: no I/O, no Deno, no clock reads (the caller passes nowIso). Imported by
// ezcater-webhook/index.ts and unit tested from src/lib/ezcaterCatering.test.js.
//
// ezCater has no "modified" event: a changed order arrives as another accepted notification,
// a cancel as a cancelled one (a REJECTED is not a cancel, see EZ_DEAD in cateringRules.js),
// and an UNCANCEL sends nothing until the order is
// accepted again (ezCater, "Order Event Notification Flows": Submitted, Accepted, Cancelled,
// Uncancelled, Accepted sends submitted, accepted, cancelled, accepted). Whatever arrives, an
// ezCater order follows the same rules as a ServOS catering order:
//
//   NOT FIRED YET (kitchen_routed_at is null). The order is still held. A changed time moves the
//   kitchen fire time, the venue date and the venue time (reschedule), so it fires at the right
//   moment, and a fire time that is already past becomes NOW (fire now if due). A cancel marks it
//   cancelled: the advance list and the release both skip it. A later non terminal lifecycle
//   (the uncancel then accept flow) RESTORES it to the held catering state with a freshly
//   computed fire time. That includes an order we marked replaced (customer.replacedBy): the
//   mark is only ever written when ezCater itself said that order is cancelled, so a later
//   answer from ezCater that it is live again revives it, and the mark moves to
//   customer.replacedByCleared (review round 3: replacedBy is not sticky forever).
//
//   A fire moment that is ALREADY PAST when the order is (re)timed fires now. It is flagged
//   plainly as late (customer.lateFire) ONLY when a CHANGE moved it into the past (a Dispatch
//   pickup moved earlier, a longer prep time set later): review round 4. A routine pre fire
//   check, or the backstop firing a few minutes after the fire moment, is never "late".
//
//   A HELD order (not accepted on ezCater, and no staff "Send anyway") keeps its real fire moment
//   in sent_at even once it is past (review round 4): it is not due, it is held, and rewriting
//   sent_at to now on every re-ask made it never age out and always sort first.
//
//   ALREADY FIRED (kitchen_routed_at set, or unknown because the venue lacks the column). The
//   kitchen has the ticket, so the fire time, date and time the kitchen was given never move.
//   A fired order marked replaced stays cancelled and is never flagged 'uncancelled': staff were
//   told to make the new order instead, and flipping it back would have them make both.
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

// ezCater lifecycle values the caterer is committed to cooking. Kept in step with EZ_COMMITTED
// in cateringRules.js (a test pins the two equal); this file keeps no import of its own.
const COMMITTED = ['accepted', 'relish_finalized', 'ready', 'ready_for_pickup'];

// Markers that belong to the ROW, not to one ezCater answer. The write carries them across from
// the row as it is NOW (read inside the same guarded write, never from an earlier read) unless the
// new answer sets them itself.
const STICKY = [
  'replacedBy', 'possibleReplacement', 'ezcaterCheck', 'resyncedAt', 'ezcaterRecheck',
  'unacceptedAlert', 'replacementDismissed', 'replacedByCleared', 'lateFire', 'prepRecomputedAt',
  // Staff released a held order by hand (review round 4): it stays released whatever ezCater
  // answers next, unless ezCater says it is cancelled (a cancel always wins).
  'sendAnyway',
  // When the ezCater answer the row holds was read (review round 4, answerOlderThanRow). Every
  // answer sets its own; kept across anything else that writes the row.
  'ezcaterAnswer',
  // Written back after its row was deleted (review round 5, goneOrderPlan): stays for staff.
  'recreatedAfterDelete',
];

// Statuses staff reach by hand that an unfired row keeps. Anything else on an unfired row is
// what ezCater says it is (an old 'prep' on an order the kitchen never had, like HKX77V, is not
// progress: nobody cooked it).
const STAFF_PROGRESS = ['ready', 'done', 'collected'];

/**
 * The tills' and the cron's stale floor (cateringRules.js CATERING_STALE_FLOOR_MS, pinned equal by
 * a test; this file keeps no import of its own). A fire moment older than this is never auto fired.
 */
const STALE_FLOOR_MS = 2 * 60 * 60 * 1000;

/**
 * NEVER PUSH A DUE ORDER BACK (review round 5, item 4). A released, unfired order whose sent_at
 * has already passed (and is inside the stale floor) is due: the till's release or the backstop
 * fires it. When the new plan is also due now, the order keeps the sent_at it has. Rewriting it
 * to now (fire now if due) moved it LATER, so the cron's own backstop, which runs right after its
 * re-asks and fires rows 3 minutes past their sent_at, skipped it and fired it a run later.
 * A plan whose fire moment is still ahead (ezCater moved the order later) is kept as planned.
 * @param {string|null} prevSentAt  the row's sent_at as read
 * @param {string|null} planned     the planned fire moment (already "fire now if due")
 * @param {number} nowMs
 * @returns {string|null} the sent_at to write
 */
export function keepDueFireMoment(prevSentAt, planned, nowMs) {
  const p = msOf(prevSentAt);
  const f = msOf(planned);
  if (!Number.isFinite(p) || !Number.isFinite(f) || !Number.isFinite(nowMs)) return planned ?? null;
  if (p > nowMs || p < nowMs - STALE_FLOOR_MS) return planned;   // not due, or stale: unchanged rule
  if (f > nowMs) return planned;                                  // moved later, still ahead
  return p <= f ? new Date(p).toISOString() : planned;
}

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
/**
 * Released: committed on ezCater, or released by staff with "Send anyway" (a held order is not
 * "late", it is held, and its fire moment is not moved to now).
 */
const mayFireLife = (customer) => COMMITTED.includes(String(customer?.ezcater_lifecycle || '').toLowerCase()) || !!customer?.sendAnyway;

/**
 * Is this order being fired LATE BECAUSE OF A CHANGE? (review round 4). Only when its new kitchen
 * fire moment (fireAt) is more than a minute in the past AND a change moved it EARLIER than the
 * fire moment the order had before (prevFireAt: a Dispatch pickup moved earlier, a longer prep
 * time). A routine fire, a pre fire check at or after the fire moment, or the backstop a few
 * minutes after it, is never late: the fire moment did not move. No previous fire moment (a new
 * order) is not a change either. The same late moment is reported once: an earlier flag for the
 * same fire moment is kept as it was.
 * @param {{ fireAt: string|null, prevFireAt: string|null, nowIso: string, prevLate?: object|null }} a
 */
export function lateFirePlan({ fireAt, prevFireAt, nowIso, prevLate = null, acceptedLate = false }) {
  const f = msOf(fireAt);
  const was = msOf(prevFireAt);
  const now = msOf(nowIso);
  if (!Number.isFinite(f) || !Number.isFinite(now)) return null;
  if (f >= now - MINUTE) return null;          // not in the past
  const movedEarlier = Number.isFinite(was) && f < was - MINUTE;
  // A HELD order (not accepted on ezCater) accepted only after its fire moment had passed
  // (review round 5, item 3): it fires now, and it IS late, although its fire moment did not move.
  if (!movedEarlier && !acceptedLate) return null;   // not moved earlier by a change, not accepted late
  if (prevLate && prevLate.fireAt === fireAt) return prevLate;
  const minutesLate = Math.round((now - f) / MINUTE);
  if (!movedEarlier) {
    return { at: nowIso, fireAt, reason: 'accepted_late', minutesLate, ...(Number.isFinite(was) ? { wasFireAt: new Date(was).toISOString() } : {}) };
  }
  return { at: nowIso, fireAt, wasFireAt: new Date(was).toISOString(), minutesLate };
}

/**
 * Is `startedAtIso` (when OUR ezCater read began) older than the ezCater answer the row already
 * holds? (review round 4). An answer's truth lies somewhere between when its read began and
 * when it came back, so ours is only PROVABLY newer when it began after the row's answer came
 * back (customer.ezcaterAnswer.receivedAt). Anything else is older or overlapping, and must not
 * overwrite the row: a pre fire check that read "accepted" before a cancel was written would
 * otherwise revive the cancelled order. A row with no recorded answer (written by older code)
 * or a caller with no start time is not judged.
 */
export function answerOlderThanRow(existing, startedAtIso) {
  const started = msOf(startedAtIso);
  const had = msOf(existing?.customer?.ezcaterAnswer?.receivedAt);
  if (!Number.isFinite(started) || !Number.isFinite(had)) return false;
  return started < had;
}

/** Plain words for a late fire, for the Orders Hub, the advance list and the till alert. */
export function lateFireText(late) {
  if (!late || !late.fireAt) return null;
  const m = Number(late.minutesLate) || 0;
  if (late.reason === 'accepted_late') {
    return `Sent to the kitchen LATE: accepted on ezCater ${m} minute${m === 1 ? '' : 's'} after it was due in the kitchen. Check the kitchen can still make the ezCater time.`;
  }
  return `Sent to the kitchen LATE: it should have started ${m} minute${m === 1 ? '' : 's'} earlier (the pickup moved earlier or the prep time is longer). Check the kitchen can still make the ezCater time.`;
}

export function ezcaterWritePlan({ row, existing, terminal, nowIso }) {
  const nowMs = msOf(nowIso);
  if (!existing) {
    // A new order is never "late" (nothing moved it), and a held one keeps its real fire moment.
    const fire_at = terminal || !mayFireLife(row.customer) ? row.fire_at : fireNowIfDue(row.fire_at, nowMs, nowIso);
    return { row: { ...row, fire_at }, reschedule: false, fired: false, restored: false, changedAfterFire: null, late: false };
  }

  const fired = !!existing.kitchen_routed_at;
  const prevStatus = String(existing.status || '').toLowerCase();
  const wasCancelled = isCancelledStatus(prevStatus);
  const prevCustomer = existing.customer && typeof existing.customer === 'object' ? existing.customer : {};
  const customer = { ...(row.customer || {}) };
  for (const k of STICKY) {
    if (customer[k] === undefined && prevCustomer[k] !== undefined) customer[k] = prevCustomer[k];
  }
  // A REJECTED answer never downgrades an order that was accepted (a rejected modification: the
  // accepted order stands). The mapper catches it from the accepted count; this catches it from
  // the row itself, for a link that was never written or a count that was lost.
  const prevLife = String(prevCustomer.ezcater_lifecycle || '').toLowerCase();
  const saidNow = String(customer.ezcaterSays || '').toLowerCase();
  if (saidNow === 'rejected' && COMMITTED.includes(prevLife) && !COMMITTED.includes(String(customer.ezcater_lifecycle || '').toLowerCase())) {
    customer.ezcater_lifecycle = prevLife;
    customer.modificationRejected = true;
  }
  const replaced = !!customer.replacedBy;

  let status;
  if (terminal) status = 'cancelled';
  // A fired order we told staff was replaced stays cancelled: they were told to make the new one.
  else if (fired && wasCancelled && replaced) status = existing.status;
  else if (fired) status = wasCancelled ? 'prep' : existing.status;
  else status = STAFF_PROGRESS.includes(prevStatus) ? existing.status : row.status;

  const reschedule = !fired && !terminal;
  const restored = wasCancelled && status !== 'cancelled';
  // ezCater says the order is live again and the kitchen never had it: the replaced mark was about
  // an answer ezCater has since taken back. Kept for the record, no longer acted on.
  if (restored && replaced && !fired) {
    customer.replacedByCleared = { ...customer.replacedBy, clearedAt: nowIso, ezcaterSaid: saidNow || null };
    delete customer.replacedBy;
  }

  const kinds = [];
  if (fired) {
    if (terminal && !wasCancelled) kinds.push(replaced ? 'replaced' : 'cancelled');
    if (!terminal) {
      if (wasCancelled && !replaced) kinds.push('uncancelled');
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

  // Late: only for an order that is live, unfired, and whose fire moment a CHANGE just moved into
  // the past (lateFirePlan). A flag already raised for the same fire moment is kept; one for a
  // fire moment the order no longer has goes.
  // A held order (ezCater had not accepted it, no staff "Send anyway") that is released now: when
  // its fire moment has already passed it fires now AND is late (review round 5, item 3).
  let late = false;
  const live = !isCancelledStatus(String(status || '').toLowerCase()) && mayFireLife(customer);
  const wasHeld = !wasCancelled && !!prevLife && !mayFireLife(prevCustomer);
  if (reschedule && live) {
    const lf = lateFirePlan({ fireAt: row.fire_at, prevFireAt: prevCustomer.fireAt ?? null, nowIso, prevLate: prevCustomer.lateFire || null, acceptedLate: wasHeld });
    if (lf) { customer.lateFire = lf; late = true; }
    else if (!(prevCustomer.lateFire && prevCustomer.lateFire.fireAt === row.fire_at)) delete customer.lateFire;
  }

  // A released order whose fire moment is past fires now; a HELD one keeps its real fire moment
  // (review round 4), so it ages out of the re-ask windows and never sorts first for ever.
  // A RELEASED order ALREADY DUE (its sent_at passed, inside the stale floor) and still due keeps
  // its sent_at (review round 5, item 4): a re-ask rewriting it to now pushed it back behind the
  // backstop's grace window. Released means it was released before this write too: a held order
  // accepted now, or a restored (uncancelled) one, keeps the earlier rules (a past fire moment
  // becomes now).
  let fire_at = reschedule && live ? fireNowIfDue(row.fire_at, nowMs, nowIso) : row.fire_at;
  if (reschedule && live && !wasCancelled && !wasHeld && mayFireLife(prevCustomer)) fire_at = keepDueFireMoment(existing.sent_at, fire_at, nowMs);
  return { row: { ...row, status, customer, fire_at }, reschedule, fired, restored, changedAfterFire, late };
}

/**
 * AN ORDER WHOSE ROW IS GONE (review round 5, item 2). order_queue has no row for this ezCater
 * order, but ezcater_order_links does: the order was written before and its row was deleted
 * since (a till delete before round 5, a manual delete). The link survives the delete, and from
 * migration 20260918d it records what the kitchen had (kitchen_fired_at) and the row's last
 * status (queue_status), copied by a trigger on order_queue. A later notification must never
 * write such an order as a brand new unfired one, or the kitchen gets it a second time.
 *   { mode: 'new' }        no link: a genuinely new order
 *   { mode: 'unfired' }    the link tracks the kitchen and says it never had it: written as new
 *   { mode: 'cancelled' }  cancelled before it fired: written again as cancelled, never live
 *   { mode: 'skip' }       the kitchen had it (fired, or staff finished it): not written at all
 *   { mode: 'unknown' }    a link from before 20260918d cannot say: written back for staff to
 *                          see, marked as already sent (never printed again), with a warning
 * @param {object|null} link  the ezcater_order_links row, all columns
 */
export function goneOrderPlan(link) {
  if (!link) return { mode: 'new' };
  const st = String(link.queue_status || '').toLowerCase();
  if (link.kitchen_fired_at) return { mode: 'skip', why: 'fired' };
  if (st === 'collected' || STAFF_PROGRESS.includes(st)) return { mode: 'skip', why: st };
  if (isCancelledStatus(st)) return { mode: 'cancelled' };
  if (Object.prototype.hasOwnProperty.call(link, 'kitchen_fired_at')) return { mode: 'unfired' };
  return { mode: 'unknown' };
}

/** Plain words for an ezCater order written back after its row was deleted (goneOrderPlan). */
export function recreatedText(r) {
  if (!r) return null;
  if (r.was === 'cancelled') return `This order was cancelled and removed from ServOS earlier. ezCater sent it again${r.ezcaterSays ? ` (it says ${r.ezcaterSays})` : ''}, so it was put back as cancelled and NOT sent to the kitchen. Check ezCater, and use Re-sync from ezCater if it stands.`;
  return 'This order was removed from ServOS earlier and ezCater sent it again. ServOS cannot tell whether the kitchen already made it, so it was NOT sent to the kitchen again. Check with the kitchen, and send it by hand only if it was never made.';
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
  // Staff said these two are NOT a replacement pair (Undo): never flag them against each other again.
  const dismissed = (c, ref) => Array.isArray(c.replacementDismissed?.refs) && c.replacementDismissed.refs.includes(ref);
  if (dismissed(b, newRow.ref) || dismissed(a, other.ref)) return false;
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
  if (c.recreatedAfterDelete) out.push(recreatedText(c.recreatedAfterDelete));
  if (c.lateFire) out.push(lateFireText(c.lateFire));
  if (c.modificationRejected) {
    out.push('A change to this order was REJECTED on ezCater. The order as it was accepted still stands and still goes to the kitchen. Check ezCater for what the customer asked for.');
  }
  if (c.sendAnyway && !COMMITTED.includes(String(c.ezcater_lifecycle || '').toLowerCase())) {
    out.push(`Sent anyway by staff (${c.sendAnyway.byName || c.sendAnyway.by || 'staff'}) without ezCater's acceptance. Check ezCater that the order stands.`);
  } else if (c.unacceptedAlert && String(c.ezcater_lifecycle || '').toLowerCase() && !COMMITTED.includes(String(c.ezcater_lifecycle).toLowerCase())) {
    out.push(`Still NOT accepted on ezCater (ezCater says ${c.unacceptedAlert.lifecycle || c.ezcater_lifecycle}) and it is due in the kitchen${c.unacceptedAlert.fireTime ? ` at ${c.unacceptedAlert.fireTime}` : ''}. Accept it on ezCater, or it will not be sent.`);
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
