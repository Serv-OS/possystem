// supabase/functions/_shared/ezcaterCatering.js
//
// What one ezCater notification does to an order that may already be in order_queue.
// Pure: no I/O, no Deno, no clock reads (the caller passes nowIso). Imported by
// ezcater-webhook/index.ts and unit tested from src/lib/ezcaterCatering.test.js.
//
// ezCater has no "modified" event: a changed order arrives as another accepted notification,
// a cancel as a cancelled or rejected one. Whatever arrives, an ezCater order follows the same
// rules as a ServOS catering order:
//
//   NOT FIRED YET (kitchen_routed_at is null). The order is still held. A changed time moves the
//   kitchen fire time, the venue date and the venue time (reschedule), so it fires at the right
//   moment. A cancel marks it cancelled: the advance list and the release both skip it.
//
//   ALREADY FIRED (kitchen_routed_at set, or unknown because the venue lacks the column). The
//   kitchen has the ticket, so the fire time, date and time the kitchen was given never move.
//   Any change (items, time, cancel) is stamped on customer.changedAfterFire, which the Orders
//   Hub shows on the card and every till raises as an alert (src/lib/realtime.js), so staff see
//   it plainly instead of cooking the old order.
//
// Status: an order already in preparation keeps its progress, and a cancellation always wins.
// That is the rule the webhook had before this file, unchanged.

const MINUTE = 60000;

const msOf = (v) => {
  if (v == null || v === '') return NaN;
  const t = typeof v === 'number' ? v : new Date(v).getTime();
  return Number.isFinite(t) ? t : NaN;
};

/**
 * @param {object} args
 * @param {object} args.row       the mapper's row (orderToQueueRow, after item matching)
 * @param {object|null} args.existing  the order_queue row already stored, or null
 * @param {boolean} args.terminal ezCater says the order is dead (cancelled / rejected)
 * @param {string} args.nowIso    the write time
 * @returns {{ row: object, reschedule: boolean, fired: boolean, changedAfterFire: object|null }}
 */
export function ezcaterWritePlan({ row, existing, terminal, nowIso }) {
  if (!existing) return { row, reschedule: false, fired: false, changedAfterFire: null };

  const fired = !!existing.kitchen_routed_at;
  const wasCancelled = existing.status === 'cancelled';
  const status = terminal ? 'cancelled' : existing.status;
  const reschedule = !fired && !terminal;

  const prevCustomer = existing.customer && typeof existing.customer === 'object' ? existing.customer : {};
  const customer = { ...(row.customer || {}) };

  const kinds = [];
  if (fired) {
    if (terminal && !wasCancelled) kinds.push('cancelled');
    if (!terminal) {
      const nowMods = Number(customer.modificationCount) || 0;
      const prevMods = Number(prevCustomer.modificationCount) || 0;
      if (customer.modified && nowMods > prevMods) kinds.push('items');
      const newFire = msOf(row.fire_at);
      const oldFire = msOf(existing.sent_at);
      if (Number.isFinite(newFire) && Number.isFinite(oldFire) && Math.abs(newFire - oldFire) >= MINUTE) kinds.push('time');
    }
  }

  let changedAfterFire = null;
  if (kinds.length) {
    changedAfterFire = {
      at: nowIso,
      kinds,
      was: {
        event_date: existing.event_date ?? prevCustomer.event_date ?? null,
        time: existing.collection_time ?? prevCustomer.event_time ?? null,
        fire_at: existing.sent_at ?? null,
      },
      now: {
        event_date: row.event_date ?? null,
        time: row.collection_time ?? null,
        fire_at: row.fire_at ?? null,
      },
    };
    customer.changedAfterFire = changedAfterFire;
  } else if (prevCustomer.changedAfterFire) {
    // The customer jsonb is rewritten whole on every notification: keep an earlier change
    // visible until staff have dealt with the order.
    customer.changedAfterFire = prevCustomer.changedAfterFire;
  }

  return { row: { ...row, status, customer }, reschedule, fired, changedAfterFire };
}

/** Plain words for a change after firing, for the Orders Hub card and the till alert. */
export function changedAfterFireText(change) {
  if (!change || !Array.isArray(change.kinds) || !change.kinds.length) return null;
  if (change.kinds.includes('cancelled')) return 'Cancelled on ezCater after it went to the kitchen';
  const parts = [];
  if (change.kinds.includes('items')) parts.push('items');
  if (change.kinds.includes('time')) {
    const was = change.was?.time ? `${change.was.event_date ? `${change.was.event_date} ` : ''}${change.was.time}` : null;
    const now = change.now?.time ? `${change.now.event_date ? `${change.now.event_date} ` : ''}${change.now.time}` : null;
    parts.push(was && now ? `time (was ${was}, now ${now})` : 'time');
  }
  return `Changed on ezCater after it went to the kitchen: ${parts.join(' and ')}`;
}
