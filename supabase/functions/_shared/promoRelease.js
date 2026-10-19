// supabase/functions/_shared/promoRelease.js
//
// v5.11.81 (19 Oct 2026): giving a promo code back when its order is fully refunded or voided.
// Pure, no imports: promo-redeem ships it and `npm test` (and the till, src/lib/promoRelease.js)
// loads the same rules.
//
// A one time code used on an order that was then refunded in full, or a catering pay later order
// that was cancelled before it was paid, stayed spent: the customer lost the code with no sale.
// promo-redeem action 'release' marks each use recorded against those orders at the venue as given
// back (promo_redemptions.released_at) and hands the use back to the code (promo_release_atomic).

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID_RE = /^[A-Za-z0-9:_\-.#]{1,120}$/;

/** The release request, checked: { ok, locationId, orderIds, orderRef, reason } or { ok: false, error }. */
export function promoReleaseRequest(body) {
  const b = body && typeof body === 'object' ? body : {};
  const locationId = String(b.location_id ?? '').trim();
  if (!UUID.test(locationId)) return { ok: false, error: 'location_id required' };
  const orderIds = [...new Set((Array.isArray(b.order_ids) ? b.order_ids : [])
    .map((x) => String(x ?? '').trim()).filter((x) => ID_RE.test(x)))].slice(0, 10);
  const ref = String(b.order_ref ?? '').trim();
  const orderRef = ID_RE.test(ref) ? ref : null;
  if (!orderIds.length && !orderRef) return { ok: false, error: 'order_ids or order_ref required' };
  const reason = String(b.reason ?? '').trim().slice(0, 200) || 'refund';
  return { ok: true, locationId, orderIds, orderRef, reason };
}

/**
 * The orders a fully refunded check's promo uses were recorded against: the check itself, and for
 * an order placed online, by QR or catering and paid later at the till, the order it was placed
 * under (the promo entry's redemptionOrderId, the customer's check_id). Empty when the check used
 * no promo code (nothing to ask).
 */
export function promoReleaseOrderIds(check) {
  const c = check && typeof check === 'object' ? check : {};
  const entries = (Array.isArray(c.discounts) ? c.discounts : [])
    .filter((d) => d && typeof d === 'object' && (d.source === 'promo' || d.type === 'promo') && d.code);
  const hasPromo = entries.length > 0 || !!c.promo?.code || !!c.customer?.promo_code;
  if (!hasPromo) return [];
  const ids = new Set();
  if (c.id) ids.add(String(c.id));
  for (const d of entries) if (d.redemptionOrderId) ids.add(String(d.redemptionOrderId));
  if (c.customer?.check_id) ids.add(String(c.customer.check_id));
  return [...ids].filter((x) => ID_RE.test(x)).slice(0, 10);
}
