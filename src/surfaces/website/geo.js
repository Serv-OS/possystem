// src/surfaces/website/geo.js
//
// Find us helpers (ARCHITECTURE.md section 8). Coordinates come from locations.latitude/longitude
// when the venue filled them in, else from settings.geo[location_id] (geocoded once by the
// website-admin action geocode_locations, never at request time). Haversine runs in the browser
// after the visitor taps "Nearest shop" (geolocation is asked on tap, never on load).
// Plain JS, shared by SSR (address lists, map links) and React (sorting).

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

/** { lat, lng } for a snapshot location, or null when neither the row nor settings.geo has one. */
export function locationCoords(loc, settings) {
  if (!loc) return null;
  const lat = num(loc.latitude ?? loc.lat);
  const lng = num(loc.longitude ?? loc.lng);
  if (lat != null && lng != null) return { lat, lng };
  const geo = settings && settings.geo && typeof settings.geo === 'object' ? settings.geo[loc.id] : null;
  if (geo) {
    const glat = num(geo.lat ?? geo.latitude), glng = num(geo.lng ?? geo.longitude);
    if (glat != null && glng != null) return { lat: glat, lng: glng };
  }
  return null;
}

/** Great circle distance in km. */
export function haversineKm(a, b) {
  if (!a || !b) return null;
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/**
 * Locations sorted by distance from `here` ({lat,lng}); each gets `distance_km` (null when the venue
 * has no coordinates, those sort last in their original order). Without `here` the list is returned
 * in sort order unchanged.
 */
export function sortByDistance(locations, here, settings) {
  const list = Array.isArray(locations) ? locations.slice() : [];
  if (!here) return list;
  const withD = list.map((l, i) => ({ l, i, d: haversineKm(here, locationCoords(l, settings)) }));
  withD.sort((x, y) => {
    if (x.d == null && y.d == null) return x.i - y.i;
    if (x.d == null) return 1;
    if (y.d == null) return -1;
    return x.d - y.d;
  });
  return withD.map(({ l, d }) => ({ ...l, distance_km: d }));
}

/** A readable distance: '0.4 km' / '12 km'; '' when unknown. */
export function distanceText(km) {
  if (km == null || !Number.isFinite(km)) return '';
  return km < 10 ? `${km.toFixed(1)} km` : `${Math.round(km)} km`;
}

/** Google Maps directions link for a location (coordinates when known, else the address text). */
export function directionsUrl(loc, settings) {
  const c = locationCoords(loc, settings);
  const q = c ? `${c.lat},${c.lng}` : [loc && loc.name, addressText(loc)].filter(Boolean).join(', ');
  return q ? `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(q)}` : '';
}

/** One line of address from whatever the location row carries. */
export function addressText(loc) {
  if (!loc) return '';
  if (typeof loc.address === 'string') return loc.address.trim();
  const a = loc.address && typeof loc.address === 'object' ? loc.address : loc;
  const parts = [a.address_line1 ?? a.line1 ?? a.street, a.address_line2 ?? a.line2, a.city ?? a.town, a.region ?? a.county ?? a.state, a.postcode ?? a.postal_code ?? a.zip]
    .map((x) => (x == null ? '' : String(x).trim())).filter(Boolean);
  return parts.join(', ');
}

/** schema.org PostalAddress from the location row; null when there is nothing to say. */
export function postalAddress(loc) {
  if (!loc) return null;
  const a = loc.address && typeof loc.address === 'object' ? loc.address : loc;
  const street = a.address_line1 ?? a.line1 ?? a.street ?? (typeof loc.address === 'string' ? loc.address : null);
  const out = { '@type': 'PostalAddress' };
  if (street) out.streetAddress = String(street);
  if (a.city ?? a.town) out.addressLocality = String(a.city ?? a.town);
  if (a.region ?? a.county ?? a.state) out.addressRegion = String(a.region ?? a.county ?? a.state);
  if (a.postcode ?? a.postal_code ?? a.zip) out.postalCode = String(a.postcode ?? a.postal_code ?? a.zip);
  if (a.country) out.addressCountry = String(a.country);
  return Object.keys(out).length > 1 ? out : null;
}
