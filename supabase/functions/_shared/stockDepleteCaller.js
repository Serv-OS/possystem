// supabase/functions/_shared/stockDepleteCaller.js
//
// WHO MAY TAKE STOCK OFF THROUGH stock-deplete (18 Oct 2026, v5.11.76; multi site stock plan,
// Phase 0 "Fences", Appendix D). Pure, no Deno, no network: the function passes its clients in,
// and node:test drives every branch (src/lib/stock/stockDepleteFn.test.js).
//
// stock-deplete is public (deployed --no-verify-jwt) and posts stock movements with the SERVICE
// ROLE, so until now anyone holding the public key could take stock off any venue, or put it
// back (reverse), with any items and quantities they liked. A call is now served only for:
//   * the service role (another edge function, a future server queue);
//   * a session that can reach the venue, asked of the DATABASE as that session: the
//     stock_caller_reaches rule of migration 20261018a (a Back Office login of the venue or its
//     company, a super admin, or a till, kiosk or ops tablet BOUND to the venue). Until that
//     migration runs, the same set from accessible_location_ids (live since 20260927a), so the
//     function can be deployed before or after the SQL;
// Anything else is refused (403) before a single recipe is read.
//
// v5.11.77 (review 19 Oct): the third door, "an online, QR or catering order PAID at that venue"
// (a closed check with that id and source, not voided), is GONE. closed_checks takes inserts from
// the bare public key, so a stranger could write a check with source online and 100 of a dish and
// then have this function post it with the service role (probe A4: a bun 100 to 0). No genuine
// call ever used it: the online checkout has no venue session, so depleteForSaleServer stops
// before it calls (getActiveLocationSync is empty there). Online, QR and catering stock comes off
// in the database (20261018c), from the check and a payment proof written in the same step.

import { bearerOf, isMissingCheck } from './cronKey.js';

export { bearerOf };

export const REACH_CHECK = 'stock_caller_reaches';
export const REACH_FALLBACK = 'accessible_location_ids';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Every Ops venue id is a uuid; anything else is refused before it reaches a filter. */
export function isVenueId(v) {
  return typeof v === 'string' && UUID.test(v);
}

const firstValue = (r) => (r && typeof r === 'object' ? Object.values(r)[0] : r);

/**
 * Does the CALLER reach the venue? Asked of the database with the caller's own token, so the rule
 * is the database's (the same one post_stock_movement applies), never a copy of it. Any doubt is
 * no: an error, a refused token, a missing answer.
 * Fallback (before 20261018a): accessible_location_ids. A setof answer is capped at 1,000 rows by
 * the API, so a login reaching more than 1,000 venues (only a super admin today) could be missed
 * there; the migration's boolean rule has no such cap.
 */
export async function callerReachesVenue(callerDb, locationId) {
  if (!callerDb || !isVenueId(locationId)) return false;
  try {
    const { data, error } = await callerDb.rpc(REACH_CHECK, { p_location_id: locationId });
    if (!error) return data === true;
    if (!isMissingCheck(error)) return false;
  } catch {
    return false;
  }
  try {
    const { data, error } = await callerDb.rpc(REACH_FALLBACK);
    if (error || !Array.isArray(data)) return false;
    const want = locationId.toLowerCase();
    return data.some((r) => String(firstValue(r) ?? '').toLowerCase() === want);
  } catch {
    return false;
  }
}

const refuse = (status, reason, error) => ({ ok: false, status, reason, error });

/**
 * The whole decision for one request.
 *   authorization  the request's Authorization header
 *   serviceKey     the function's own service role key
 *   makeCallerDb   (token) => a client that talks to the database AS the caller
 *   body           the parsed request body
 * Returns { ok: true, via, locationId, checkId, items, orderType, reverse } or
 *         { ok: false, status, reason, error }.
 *   via 'service' | 'venue'
 */
export async function authoriseStockDeplete({ authorization, serviceKey, makeCallerDb, body }) {
  const locationId = String(body?.location_id || '');
  const checkId = String(body?.check_id || '');
  const items = Array.isArray(body?.items) ? body.items : [];
  const reverse = body?.reverse === true;
  const orderType = body?.order_type ? String(body.order_type) : null;
  if (!isVenueId(locationId) || !checkId || !items.length) {
    return refuse(400, 'bad_request', 'location_id (a venue id), check_id and items are required');
  }
  const base = { locationId, checkId };

  const token = bearerOf(authorization);
  const key = String(serviceKey || '');
  if (key && token === key) return { ok: true, via: 'service', ...base, items, orderType, reverse };

  if (token && typeof makeCallerDb === 'function') {
    let reaches = false;
    try { reaches = await callerReachesVenue(makeCallerDb(token), locationId); } catch { reaches = false; }
    if (reaches) return { ok: true, via: 'venue', ...base, items, orderType, reverse };
  }

  if (reverse) return refuse(403, 'reverse_needs_venue', 'Only the venue can put stock back');
  return refuse(403, 'not_this_venue', 'This device or login cannot take stock off at this venue');
}
