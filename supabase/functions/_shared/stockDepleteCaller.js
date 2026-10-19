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
//   * an online, QR or catering order PAID at that venue: a closed check with that id, at that
//     venue, from one of those sources, not voided. Its OWN stored lines are used, never the
//     caller's, and it can never reverse. So the most a stranger who learns a real check id can
//     do is book that order's stock once (the movement keys are per check and item).
// Anything else is refused (403) before a single recipe is read.

import { bearerOf, isMissingCheck } from './cronKey.js';

export { bearerOf };

export const REACH_CHECK = 'stock_caller_reaches';
export const REACH_FALLBACK = 'accessible_location_ids';
export const PUBLIC_ORDER_SOURCES = Object.freeze(['online', 'qr', 'catering']);

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

/** A stored closed check that is a paid online, QR or catering order at this venue. */
export function isPaidPublicOrder(check, locationId) {
  if (!check || typeof check !== 'object') return false;
  if (String(check.location_id || '').toLowerCase() !== String(locationId || '').toLowerCase()) return false;
  if (!PUBLIC_ORDER_SOURCES.includes(String(check.source || '').toLowerCase())) return false;
  if (check.voided === true) return false;
  return String(check.status || 'paid').toLowerCase() !== 'void';
}

/**
 * A check's own lines, in the shape the function explodes: the same rule as depleteForSaleServer
 * (src/lib/stock/deplete.js): voided lines and lines with no item are left out, a linked option
 * (a sub item with an itemId, never a kitchen instruction) rides along as a mod.
 */
export function itemsOfCheck(check) {
  const items = Array.isArray(check?.items) ? check.items : [];
  return items
    .filter((it) => it && typeof it === 'object' && !it.voided && it.itemId)
    .map((it) => ({
      itemId: String(it.itemId),
      qty: Number(it.qty) || 1,
      mods: (Array.isArray(it.mods) ? it.mods : [])
        .filter((m) => m && typeof m === 'object' && m.itemId && !m._instruction)
        .map((m) => ({ itemId: String(m.itemId), qty: Number(m.qty) || 1 })),
    }));
}

const refuse = (status, reason, error) => ({ ok: false, status, reason, error });

/**
 * The whole decision for one request.
 *   authorization  the request's Authorization header
 *   serviceKey     the function's own service role key
 *   makeCallerDb   (token) => a client that talks to the database AS the caller
 *   ops            the service role client (reads the stored check)
 *   body           the parsed request body
 * Returns { ok: true, via, locationId, checkId, items, orderType, reverse } or
 *         { ok: false, status, reason, error }.
 *   via 'service' | 'venue' | 'paid_order'
 */
export async function authoriseStockDeplete({ authorization, serviceKey, makeCallerDb, ops, body }) {
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

  let check = null;
  try {
    const { data, error } = await ops.from('closed_checks')
      .select('id, location_id, source, status, voided, items, order_type')
      .eq('id', checkId).eq('location_id', locationId).maybeSingle();
    if (!error) check = data;
  } catch {
    check = null;
  }
  if (isPaidPublicOrder(check, locationId)) {
    return { ok: true, via: 'paid_order', ...base, items: itemsOfCheck(check), orderType: check.order_type ? String(check.order_type) : orderType, reverse: false };
  }
  return refuse(403, 'not_this_venue', 'This device or login cannot take stock off at this venue');
}
