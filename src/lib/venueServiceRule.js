// venueServiceRule.js: the venue's ONE table service charge rule (v5.11.81, 19 Oct 2026).
//
// Peter: the POS is central; every channel follows the till. A service charge is set on a device
// profile (Back Office, Device profiles: on or off, the rate, all tables or from N covers). Two
// channels did not follow any till:
//   - QR pay now and QR tabs charged their own percentage (Back Office, Online Ordering, the QR
//     service charge field), whatever the tables charged;
//   - Pay at table on the card reader charged the bill stamped by whichever till last published
//     the table, so the same table paid a different service charge depending on which till
//     touched it last.
// Both now take the venue's table service rule: the service charge switched on for table service
// at the venue, the master till's when it has one, else the first table service profile in Back
// Office order that has one. The database answers the same question (venue_service_rule,
// migration 20261020a), so the QR page, which cannot read device profiles, gets the same rule.
// The till's own checkout still charges its own profile's rule, as Peter designed it (a bar till
// may have none). PURE: imports only serviceCharge.js (itself pure), runs under node --test.

import { resolveServiceCharge } from './serviceCharge.js';

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

/** A rule in the shape resolveServiceCharge reads, or { enabled: false }. */
export function normaliseServiceRule(sc) {
  const on = sc && typeof sc === 'object' && (sc.enabled === true || String(sc.enabled).toLowerCase() === 'true');
  if (!on || !(num(sc.rate) > 0)) return { enabled: false };
  const applyTo = sc.applyTo === 'minCovers' ? 'minCovers' : 'all';
  return {
    enabled: true,
    rate: num(sc.rate),
    applyTo,
    minCovers: Math.max(1, Math.round(num(sc.minCovers) || (applyTo === 'minCovers' ? 1 : 8))),
  };
}

const profileRule = (p) => p?.serviceCharge ?? p?.service_charge ?? null;
// The database row's own master flag (device_profiles.is_master), never this device's answer.
const masterRow = (p) => p?.is_master === true;
const tableService = (p) => (p?.tableServiceEnabled ?? p?.table_service_enabled) !== false;
const sortOf = (p) => { const n = Number(p?.sortOrder ?? p?.sort_order); return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER; };
// A profile with no created_at sorts last, as the database's `nulls last` does.
const createdOf = (p) => { const c = p?.createdAt ?? p?.created_at; return c == null || c === '' ? '\uffff' : String(c); };

/**
 * The venue's table service rule from its device_profiles rows (as the database holds them): among the
 * table service profiles with a service charge switched on, the master first, then Back Office
 * order (sort_order, then created_at, then id). { enabled: false } when none charges one. The SQL
 * twin is public.venue_service_rule (20261020a), same order.
 */
export function pickVenueServiceRule(profiles) {
  const on = (Array.isArray(profiles) ? profiles : [])
    .filter((p) => p && tableService(p) && normaliseServiceRule(profileRule(p)).enabled);
  if (!on.length) return { enabled: false };
  on.sort((a, b) => (Number(masterRow(b)) - Number(masterRow(a)))
    || (sortOf(a) - sortOf(b))
    || (createdOf(a) < createdOf(b) ? -1 : createdOf(a) > createdOf(b) ? 1 : 0)
    || (String(a.id ?? '') < String(b.id ?? '') ? -1 : String(a.id ?? '') > String(b.id ?? '') ? 1 : 0));
  return normaliseServiceRule(profileRule(on[0]));
}

/**
 * The device config a Pay at table stamp is worked out with: the till's own config with the
 * venue's rule as its service charge. A rule not known yet (null or undefined: the database
 * update is not run, or the read failed) leaves the till's own config exactly as it is.
 */
export function withVenueServiceRule(deviceConfig, rule) {
  if (rule == null || typeof rule !== 'object') return deviceConfig;
  return { ...(deviceConfig || {}), serviceCharge: normaliseServiceRule(rule) };
}

/**
 * The QR service charge (major units) on a bill: the venue rule, read the till's way (dine in,
 * the covers given, never waived) on the goods after the automatic offers. Until the venue rule
 * is known (null: the database update is not run yet) the QR page's own percentage, as before.
 * Returns { amount, pct } where pct is the percentage shown on the bill.
 */
export function qrServiceCharge({ rule = null, legacyPct = 0, discountedSubtotal = 0, covers = 1 } = {}) {
  const goods = Math.max(0, num(discountedSubtotal));
  if (rule && typeof rule === 'object') {
    const r = resolveServiceCharge({ deviceConfig: { serviceCharge: normaliseServiceRule(rule) }, orderType: 'dine-in', covers: Math.max(1, Math.round(num(covers) || 1)), waived: false });
    return { amount: r > 0 ? +(goods * r).toFixed(2) : 0, pct: r > 0 ? +(r * 100).toFixed(4) : 0 };
  }
  const pct = Math.max(0, num(legacyPct));
  return { amount: pct > 0 ? +(goods * pct / 100).toFixed(2) : 0, pct };
}
