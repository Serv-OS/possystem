/**
 * stuart.js — pure helpers for the Stuart courier provider (UK last-mile API).
 * No I/O — unit-tested. The Deno network client (_shared/stuart.ts) mirrors mapStuartStatus
 * and the pricing normalisation so the server + client agree on shapes.
 *
 * Stuart returns money in MAJOR units (pounds, e.g. 5.50). The whole ServOS delivery pipeline
 * works in MINOR units (pence), so normaliseStuartPricing converts up-front.
 *
 * Docs: api-docs.stuart.com (verified Jun 2026). Exact request/response field names are locked
 * against the live self-serve sandbox during the first integration test.
 */

/** Stuart job/delivery status → ServOS canonical lifecycle (matches src/lib/delivery/status.js). */
const STUART_STATUS = {
  new: 'pending', searching: 'pending', scheduled: 'scheduled', pending: 'pending',
  in_progress: 'pickup', picking: 'pickup', almost_picking: 'pickup', waiting_at_pickup: 'pickup',
  delivering: 'dropoff', almost_delivering: 'dropoff', waiting_at_dropoff: 'dropoff',
  delivered: 'delivered', finished: 'delivered',
  cancelled: 'canceled', canceled: 'canceled', expired: 'canceled', voided: 'canceled', failed: 'canceled',
  returning: 'returned', returned: 'returned', returning_to_pickup: 'returned',
};
export function mapStuartStatus(raw) {
  if (!raw) return 'pending';
  return STUART_STATUS[String(raw).toLowerCase().trim()] || 'pending';
}

/**
 * Normalise a Stuart pricing response into the same shape normalizeUberQuote consumes:
 * { fee: <minor>, currency }. Stuart's amount is in pounds; tolerant of the field variants
 * (amount / amount_tax_included / price / pricing.{amount}). Returns null if unusable.
 */
export function normaliseStuartPricing(resp) {
  if (!resp || typeof resp !== 'object') return null;
  const p = resp.pricing && typeof resp.pricing === 'object' ? resp.pricing : resp;
  // The merchant's real cost is the WITH-TAX amount (Stuart's live pricing returns amount
  // [ex-VAT] + amount_with_tax). Prefer the tax-inclusive figure so the surcharge engine marks
  // up the true cash cost. Verified against the live sandbox (Jun 2026).
  const amt = p.amount_with_tax ?? p.amount_tax_included ?? p.price_tax_included ?? p.amount ?? p.price ?? null;
  if (amt == null) return null;            // Number(null) === 0 (finite!) — guard explicitly
  const n = Number(amt);
  if (!Number.isFinite(n)) return null;
  const currency = String(resp.currency || p.currency || 'GBP').toUpperCase();
  // Shape it like the Uber-classic quote so normalizeUberQuote can ingest it directly.
  return { fee: Math.max(0, Math.round(n * 100)), currency };
}

/** Extract the bits ServOS stores from a Stuart job (create/get/webhook payload), tolerant. */
export function parseStuartJob(r) {
  const d = r?.data || r || {};
  const job = d.job || d;
  const delivery = Array.isArray(job.deliveries) ? job.deliveries[0] : (d.delivery || null);
  const driver = delivery?.driver || job.driver || null;
  return {
    id: job.id != null ? String(job.id) : (delivery?.id != null ? String(delivery.id) : null),
    trackingUrl: delivery?.tracking_url || job.tracking_url || null,
    rawStatus: delivery?.status || job.status || null,
    courierName: driver ? [driver.firstname, driver.lastname].filter(Boolean).join(' ') || driver.name || null : null,
    courierPhone: driver?.phone || null,
    lat: driver?.latitude ?? driver?.location?.latitude ?? null,
    lng: driver?.longitude ?? driver?.location?.longitude ?? null,
  };
}
