/**
 * status.js — map Uber Direct delivery statuses onto the ServOS delivery lifecycle.
 * Pure + unit-tested. Tolerant of both Uber endpoint families (classic delivery
 * statuses + the eats order_status / courier_trip status codes).
 *
 * ServOS lifecycle: pending | pickup | dropoff | delivered | canceled | returned
 */

const MAP = {
  // classic Uber Direct delivery statuses
  pending: 'pending',
  pickup: 'pickup',
  pickup_complete: 'dropoff',
  dropoff: 'dropoff',
  delivered: 'delivered',
  canceled: 'canceled',
  cancelled: 'canceled',
  returned: 'returned',
  // eats / courier-trip status codes
  scheduled: 'pending',
  en_route_to_pickup: 'pickup',
  arrived_at_pickup: 'pickup',
  en_route_to_dropoff: 'dropoff',
  arrived_at_dropoff: 'dropoff',
  completed: 'delivered',
  active: 'pickup',
  failed: 'canceled',
};

const TERMINAL = new Set(['delivered', 'canceled', 'returned']);

/** Uber status string → ServOS lifecycle. Unknown/empty → 'pending'. */
export function mapUberStatus(raw) {
  if (!raw) return 'pending';
  return MAP[String(raw).toLowerCase().trim()] || 'pending';
}

/** Is this ServOS lifecycle status terminal (no further courier updates expected)? */
export function isTerminalStatus(s) {
  return TERMINAL.has(s);
}

/** Human label for staff/customer display. */
export function statusLabel(s) {
  switch (s) {
    case 'pending':   return 'Finding a courier';
    case 'pickup':    return 'Courier heading to you';
    case 'dropoff':   return 'Out for delivery';
    case 'delivered': return 'Delivered';
    case 'canceled':  return 'Canceled';
    case 'returned':  return 'Returned';
    default:          return 'Pending';
  }
}
