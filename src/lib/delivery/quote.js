/**
 * quote.js — pure helpers for delivery quoting: distance/radius maths, Uber quote
 * normalisation (tolerant of both Uber Direct endpoint families), and staleness.
 * No I/O — unit-tested. The network orchestration lives in quoteService.js.
 */

const R_MILES = 3958.7613; // Earth radius in miles
const toRad = (d) => (d * Math.PI) / 180;

/** Great-circle distance in miles between two {lat,lng} points. */
export function haversineMiles(a, b) {
  if (!a || !b || a.lat == null || a.lng == null || b.lat == null || b.lng == null) return null;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R_MILES * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Within the venue's delivery radius? null distance (unknown) is treated as NOT within. */
export function withinRadiusMiles(distanceMiles, radiusMiles) {
  if (distanceMiles == null || !Number.isFinite(distanceMiles)) return false;
  return distanceMiles <= Number(radiusMiles || 0);
}

/** Coerce an Uber time value (epoch ms, epoch seconds, or ISO string) to epoch ms. */
export function toEpochMs(v) {
  if (v == null) return null;
  if (typeof v === 'number' && Number.isFinite(v)) {
    if (v > 1e12) return v;        // already ms
    if (v > 1e9) return v * 1000;  // seconds
    return null;                   // too small to be a real epoch
  }
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
}

/**
 * Normalise an Uber Direct quote response into one shape, tolerant of both endpoint
 * families:
 *   - classic /customers/{id}/delivery_quotes : { id, fee, currency, dropoff_eta, duration, expires }
 *   - eats /v1/eats/deliveries/estimates       : { estimate_id, delivery_fee:{total,currency_code}, etd, expires_at }
 * Fee is in MINOR units (pennies/cents) in both. Returns null on an unusable payload.
 */
export function normalizeUberQuote(resp, nowMs = Date.now()) {
  if (!resp || typeof resp !== 'object') return null;

  const feeMinor =
    resp.fee != null ? Number(resp.fee)
    : resp.delivery_fee && typeof resp.delivery_fee === 'object' ? Number(resp.delivery_fee.total)
    : resp.delivery_fee != null ? Number(resp.delivery_fee)
    : null;
  if (feeMinor == null || !Number.isFinite(feeMinor)) return null;

  const quoteId = resp.id || resp.estimate_id || resp.quote_id || null;
  const currency = (
    resp.currency ||
    resp.currency_code ||
    (resp.delivery_fee && resp.delivery_fee.currency_code) ||
    'GBP'
  ).toUpperCase();

  const expiresAtMs = toEpochMs(resp.expires_at ?? resp.expires ?? null);

  // ETA: prefer an explicit dropoff time; else a duration in minutes.
  const etaMs = toEpochMs(resp.dropoff_eta ?? resp.etd ?? null);
  let etaMinutes = null;
  if (etaMs != null) etaMinutes = Math.max(0, Math.round((etaMs - nowMs) / 60000));
  else if (resp.duration != null && Number.isFinite(Number(resp.duration))) etaMinutes = Math.round(Number(resp.duration));

  return {
    quoteId,
    feeMinor: Math.max(0, Math.round(feeMinor)),
    currency,
    etaMinutes,
    expiresAtMs,
  };
}

/**
 * A quote is stale if it has expired or is about to (within marginMs). Always re-quote
 * before dispatch if stale — never charge or dispatch on a stale quote. A null expiry is
 * treated as stale (unknown = don't trust).
 */
export function isQuoteStale(expiresAtMs, nowMs = Date.now(), marginMs = 30000) {
  if (expiresAtMs == null) return true;
  return expiresAtMs - nowMs <= marginMs;
}
