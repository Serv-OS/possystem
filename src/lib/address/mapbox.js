/**
 * mapbox.js — address autocomplete via the Mapbox Geocoding v6 API, behind a tiny provider
 * seam so we can swap to getAddress.io / OS later without touching the UI.
 *
 * Returns precise, geocodable addresses WITH coordinates so couriers (Stuart / Uber Direct)
 * get an exact dropoff instead of a fuzzy free-text string. The token is a PUBLIC Mapbox token
 * (pk.…) — frontend-safe and URL-restrictable. Set it as VITE_MAPBOX_TOKEN; with no token the
 * callers fall back to plain address fields (no regression).
 */

/** The platform Mapbox public token (set in Vercel env). '' when unset → autocomplete disabled. */
export function mapboxToken() {
  try { return (import.meta && import.meta.env && import.meta.env.VITE_MAPBOX_TOKEN) || ''; }
  catch { return ''; }
}

/** Normalise one Mapbox v6 feature → { id, label, line1, city, postcode, lat, lng }. Pure. */
export function normalizeMapboxFeature(f) {
  const p = (f && f.properties) || {};
  const c = p.context || {};
  const coords = (f && f.geometry && f.geometry.coordinates) || [];
  const lng = Number(coords[0]);
  const lat = Number(coords[1]);
  const line1 =
    (c.address && c.address.name) ||
    [c.address && c.address.address_number, c.address && c.address.street_name].filter(Boolean).join(' ') ||
    p.name || '';
  const city = (c.place && c.place.name) || (c.locality && c.locality.name) || (c.district && c.district.name) || '';
  const postcode = (c.postcode && c.postcode.name) || '';
  return {
    id: (f && (f.id || p.mapbox_id)) || `${lat},${lng}`,
    label: p.full_address || p.place_formatted || [line1, city, postcode].filter(Boolean).join(', '),
    line1, city, postcode,
    lat: Number.isFinite(lat) ? lat : null,
    lng: Number.isFinite(lng) ? lng : null,
  };
}

/**
 * Autocomplete addresses for a typed query. Returns [] when there's no token, the query is too
 * short, or on any error — callers degrade to manual entry. `proximity` ({lat,lng}) biases
 * results toward the venue.
 */
export async function searchAddresses(query, { token, country = 'gb', limit = 6, proximity } = {}) {
  const t = token || mapboxToken();
  const q = String(query || '').trim();
  if (!t || q.length < 3) return [];
  const params = new URLSearchParams({
    q, access_token: t, country, autocomplete: 'true', types: 'address', limit: String(limit), language: 'en',
  });
  if (proximity && Number.isFinite(proximity.lat) && Number.isFinite(proximity.lng)) {
    params.set('proximity', `${proximity.lng},${proximity.lat}`);
  }
  try {
    const res = await fetch(`https://api.mapbox.com/search/geocode/v6/forward?${params.toString()}`);
    if (!res.ok) return [];
    const j = await res.json();
    return (j.features || []).map(normalizeMapboxFeature).filter((a) => a.line1 || a.postcode);
  } catch { return []; }
}
