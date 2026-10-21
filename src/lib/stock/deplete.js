/**
 * deplete.js: the till's old sale stock path, retired (v5.11.90, the drainer release, 20261023a).
 *
 * The database books every channel. Every closed check from the till (every close path), the card
 * reader, the kiosk, online, QR, catering at its event time, pay at table, MPOS, HubRise and ezCater
 * reaches the stock outbox, and the pg_cron drainer takes its stock off through the one stock rule
 * (stock_explode in the database), books refunds and voids from the sale's own movements (food as
 * waste, sealed goods back only with returns_to_shelf), and keeps the day totals. The till never
 * posts sale stock any more, at any venue, in any mode.
 *
 * So every entry point here is a no op on purpose: no reads, no venue mode fetch, no posts, never a
 * throw into the sale path. The exports stay so callers do not break: store/index.js still calls
 * depleteForSale and reverseForSale on every close and refund (those calls do nothing), and the
 * kiosk's fingerprinted submitOrder still calls depleteForSaleServer (the card path guard keeps that
 * block byte for byte). Old builds that still post find the door in post_stock_movement answering
 * skipped central, and old kiosk builds that call the stock-deplete function are answered retired.
 *
 * History: v5.5.565 the till exploded its own recipes into SALE_DEPLETION and RETURN movements;
 * v5.11.77 (20261018c) the database took over at central venues; v5.11.78 (20261019) every venue
 * went central; this release retires the till path for the 'browser' back out too.
 */

/** Kept for callers and tests: there is no cached venue mode any more. */
export function invalidateVenueMode() { /* nothing is cached */ }

/**
 * The kiosk's submitOrder still calls this (its block is fingerprinted by the card path guard, so it
 * is not edited). The database books the kiosk's check itself.
 */
// eslint-disable-next-line no-unused-vars
export async function depleteForSaleServer(_check, _opts = {}) { /* the database books every channel's checks */ }

/** Kept for callers and tests: there is no cached recipe context any more. */
export function invalidateDepletionCtx() { /* nothing is cached */ }

/**
 * v5.11.79 (stock plan 11.5 item 2): the sale's own time, not the time a row was posted (an offline
 * till posts hours later). A time more than 10 minutes ahead of this clock, or none, is left to the
 * database clock. Pure; no longer used to post from here, kept for anything that dates a sale.
 */
export function saleTimeOf(check, nowMs = Date.now()) {
  const t = check?.closedAt ?? check?.closed_at;
  const ms = typeof t === 'number' ? t : (t ? Date.parse(t) : NaN);
  if (!Number.isFinite(ms) || ms > nowMs + 10 * 60 * 1000) return null;
  return new Date(ms).toISOString();
}

/** Retired: the database takes the sale's stock off from the booked check, on every channel. */
// eslint-disable-next-line no-unused-vars
export async function depleteForSale(_check) { /* the database books every channel's checks */ }

/** Retired: the database books the refund from the check's refunds[] entry, from the sale's own movements. */
// eslint-disable-next-line no-unused-vars
export async function reverseForSale(_check, _refundItems, _refundId) { /* the database books every refund */ }
