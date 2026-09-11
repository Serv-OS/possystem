// src/lib/orderScreen/keepPaidOrder.js
//
// Venue setting "Keep paid till orders in Orders Hub until they are collected"
// (locations.pos_settings.order_screen_keep_paid, Back Office, Order screens).
//
// Today a till walk in paid at the till is dropped from the queue at payment, so it
// never reaches Orders Hub or the order screen. With the setting on, a till order that
// is paid BEFORE it is ready stays queued, marked paid, until staff tap Collected.
// A ready order that is paid (pay on collection) is removed as before: the customer is
// taking the food now, so the screen shows it as Collected from the delete.
// Off by default: payment behaviour is then exactly what it was.
//
// NO imports, so node:test can load it.

const KEEP_STATUSES = ['received', 'prep'];
const KEEP_TYPES = ['dine-in', 'takeaway', 'collection', 'delivery'];

const isTillEntry = (entry) => !!entry && typeof entry === 'object' && (!entry.source || entry.source === 'pos');

/** True only for a till order (no source or 'pos') still in the kitchen (received or prep), with the setting on. */
export function shouldKeepPaidOrderInQueue({ enabled, orderType, entry } = {}) {
  if (enabled !== true) return false;
  if (!isTillEntry(entry)) return false;
  if (!KEEP_STATUSES.includes(entry.status)) return false;
  return KEEP_TYPES.includes(orderType);
}

/**
 * Marks a queue entry paid, on the entry and in customer. QueueSync persists the
 * customer jsonb, so OrdersHub isOrderPaid passes on Collected and never charges twice.
 */
export function markQueueEntryPaid(o) {
  return { ...o, paid: true, customer: { ...((o && o.customer) || {}), paid: true } };
}

/**
 * After a refund: the ref of a kept paid till order to take out of the queue, else null.
 * Only a FULL refund (check status 'refunded') of a check whose ref still has a paid till
 * entry. A refund that matches no queue entry, or a partial refund, changes nothing.
 */
export function paidQueueRefToClearOnRefund({ queue, ref, checkStatus } = {}) {
  if (checkStatus !== 'refunded' || !ref || !Array.isArray(queue)) return null;
  const entry = queue.find(o => o && o.ref === ref);
  if (!isTillEntry(entry)) return null;
  if (!(entry.paid === true || entry.customer?.paid === true)) return null;
  return ref;
}
