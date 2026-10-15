// src/lib/kds/kdsAutoStatus.js
//
// Kitchen bump → order status (Peter, Coffee Boy, 30 Sep 2026: "for coffee shops we need a way to
// set the order to automatically mark as ready once it's bumped off, then another setting to say
// mark as collected once bumped too"). It fires when the LAST screen bumps (every kds_tickets row
// of the order is bumped), not the first (Peter's decision).
//
// Two venue settings in locations.pos_settings (Back Office, Order screens), off by default:
//   kds_auto_ready       "Mark ready when the kitchen bumps the order"
//   kds_auto_collected   "Also mark collected" (only counts when the first is on)
//
// Who writes: the KDS device whose bump was the last. It runs the SAME order_queue status write a
// tap on Orders Hub runs (status 'ready', then 'collected'), so the customer's ready message (the
// order_queue_notify trigger), the order screens (order_status_marks), HubRise and the tills all see
// exactly what a manual tap gives them. Two screens bumping at once cannot double fire: each step
// is a conditional update (status still in the step's `from` list), so the second one changes 0 rows.
//
// Collected only for an order that is PAID (orderPaymentState): Orders Hub refuses Collected for an
// unpaid order or a payment being checked, and so does this. Those stop at ready.
// No React, no Supabase: KDSSurface runs the steps this file returns.

import { orderPaymentState } from '../orderPayment.js';

/** order_queue statuses before ready. 'received' and 'prep' are what the app writes today. */
export const PRE_READY_STATUSES = Object.freeze(['received', 'prep', 'preparing', 'accepted']);

/** The two venue switches, from locations.pos_settings. Collected needs ready on. */
export function autoStatusSettings(posSettings) {
  const s = posSettings && typeof posSettings === 'object' && !Array.isArray(posSettings) ? posSettings : {};
  const ready = s.kds_auto_ready === true;
  return { ready, collected: ready && s.kds_auto_collected === true };
}

/** Every row of the order is bumped (and there is at least one row). */
export function allTicketsBumped(rows) {
  const list = Array.isArray(rows) ? rows : [];
  return list.length > 0 && list.every(r => (r?.status ?? r) === 'bumped');
}

/**
 * After this screen's bump landed: 'none' | 'ready' | 'collected'.
 *   ticketRows  every kds_tickets row of the order at the location (status per row)
 *   settings    autoStatusSettings(...)
 *   order       the order_queue row ({ status, source, paid, customer }), or null when the order
 *               has none (a table send, a bar round): then nothing to do.
 */
export function autoStatusAfterBump({ ticketRows, settings, order }) {
  const s = settings || { ready: false, collected: false };
  if (!s.ready || !order || !allTicketsBumped(ticketRows)) return 'none';
  const status = order.status || 'received';
  const paid = orderPaymentState(order) === 'paid';
  if (PRE_READY_STATUSES.includes(status)) return s.collected && paid ? 'collected' : 'ready';
  // Staff already tapped Ready by hand: the bump can still hand it over when the venue asks.
  if (status === 'ready') return s.collected && paid ? 'collected' : 'none';
  return 'none';
}

/**
 * The conditional status writes for a decision, in order. Each is applied only while the row is
 * still in `from`, which is what makes two screens racing safe.
 *   status  the order_queue status as read: an order staff already marked ready skips the ready
 *           step (review 30 Sep 2026: that step changed 0 rows, read as "gone", and the collected
 *           step never ran, so a hand marked order sat at Ready with the second switch on).
 */
export function autoStatusSteps(decision, status) {
  if (decision === 'ready') return [{ to: 'ready', from: [...PRE_READY_STATUSES] }];
  if (decision === 'collected') {
    if (status === 'ready') return [{ to: 'collected', from: ['ready'] }];
    return [{ to: 'ready', from: [...PRE_READY_STATUSES] }, { to: 'collected', from: ['ready'] }];
  }
  return [];
}

/**
 * True when a bumped ticket SHOULD have an order_queue row but carries no ref to find it by: a
 * till, kiosk or channel order written by a till on a build before 30 Sep 2026 (0 of 1,682 rows in
 * the week before stamped one). The KDS says so once, or the switch looks broken for no reason.
 * A table or bar tab send has no order_queue row and is rightly silent.
 */
export function bumpedWithoutRef(meta) {
  if (!meta || typeof meta !== 'object') return false;
  if (typeof meta.ref === 'string' && meta.ref.trim()) return false;
  if (meta.isTable === true) return false;
  return meta.channel !== 'table' && meta.channel !== 'bar';
}
