/**
 * Location-aware time utilities
 * 
 * "Today" for a restaurant is NOT midnight UTC or midnight device-local.
 * It's midnight in the location's timezone, shifted by the business_day_start.
 * 
 * businessDayStart: "06:00" means the new reporting day starts at 6am.
 * Checks closed between midnight and 6am belong to the PREVIOUS business day.
 */

import { platformSupabase, getLocationId } from './supabase';
import { setActiveCurrency } from './currency';
import { resolveLocalDateTime } from './openingHours';

// v5.5.11: per-location cache. The previous module-level cache returned the
// SAME config for every caller regardless of which location they were at.
// In a multi-location setup that's wrong — each location has its own
// timezone, business_day_start, and shifts schedule. We now key the cache
// by location id so each location gets its own config.
const _locationConfigCache = new Map();

export async function getLocationConfig(explicitLocationId = null) {
  // Resolve location id. The previous version did .from('locations').limit(1)
  // with no filter — it just pulled whichever location the DB happened to
  // return first. In multi-location, that's an unpredictable bug source for
  // shift boundaries (causes shifts to open/close at the wrong location's
  // business_day_start time).
  let locationId = explicitLocationId;
  if (!locationId) {
    try { locationId = await getLocationId(); } catch (e) { void e; }
  }
  if (!locationId || locationId === 'loc-demo') {
    // No real location — return fallback defaults so callers don't crash.
    return { timezone: 'Europe/London', businessDayStart: '06:00', shifts: [], collectionLeadMinutes: 30 };
  }

  if (_locationConfigCache.has(locationId)) {
    return _locationConfigCache.get(locationId);
  }

  // Cross-DB join — platform.locations.id ≠ ops.locations.id in general.
  // We must resolve via platform.locations.ops_location_id, NOT id, and we
  // must NOT fall back to .limit(1) which would return another tenant's
  // row when no match exists (active wrong-row-targeting bug).
  // Also include opening_hours in the select so kiosk + online surfaces
  // and any future hour-aware report can read the location's schedule
  // through the same cached config.
  if (platformSupabase) {
    try {
      const select = 'timezone, business_day_start, shifts, collection_lead_minutes, opening_hours, currency';
      // First try the right join key.
      const r1 = await platformSupabase.from('locations').select(select).eq('ops_location_id', locationId).maybeSingle();
      let row = r1.data;
      // Legacy rows may have id == ops_location_id (created before the join
      // column existed). Try matching on id ONLY when ops_location_id missed,
      // and ALWAYS scoped to one specific value (never .limit(1)).
      if (!row) {
        const r2 = await platformSupabase.from('locations').select(select).eq('id', locationId).maybeSingle();
        row = r2.data;
      }
      if (row) {
        // v5.5.326: resolve the location's currency at boot so money() formats
        // in the right symbol/code everywhere. Persisted to localStorage so it
        // survives reloads and resolves from the first render (no £→$ flash on
        // a configured device).
        setActiveCurrency(row.currency || 'GBP');
        const cfg = {
          timezone: row.timezone || 'Europe/London',
          businessDayStart: row.business_day_start || '06:00',
          shifts: row.shifts || [],
          opening_hours: row.opening_hours || null,
          collectionLeadMinutes: typeof row.collection_lead_minutes === 'number' ? row.collection_lead_minutes : 30,
          currency: row.currency || 'GBP',
        };
        _locationConfigCache.set(locationId, cfg);
        return cfg;
      }
    } catch (e) { console.warn('[locationTime] platform DB read failed:', e?.message); }
  }

  // Fallback defaults
  const fallback = { timezone: 'Europe/London', businessDayStart: '06:00', shifts: [], collectionLeadMinutes: 30 };
  _locationConfigCache.set(locationId, fallback);
  return fallback;
}

export function clearLocationConfigCache() {
  _locationConfigCache.clear();
}

/**
 * Get the start of the current business day in the location's timezone.
 * 
 * Example: timezone = 'Europe/London', businessDayStart = '06:00'
 * If it's currently 04:00 London time, today's business day HASN'T started yet,
 * so we return yesterday's 06:00 as the start.
 */
export function getBusinessDayStart(config) {
  const { timezone = 'Europe/London', businessDayStart = '06:00' } = config || {};
  const [startHour, startMin] = businessDayStart.split(':').map(Number);

  // Get current time in location timezone
  const now = new Date();
  const localeStr = now.toLocaleString('en-CA', { timeZone: timezone }); // en-CA gives YYYY-MM-DD format
  const [datePart, timePart] = localeStr.split(', ');
  const [year, month, day] = datePart.split('-').map(Number);
  const [hour, minute] = timePart.split(':').map(Number);

  // Build today's business day start in that timezone
  const todayStart = new Date(`${datePart}T${businessDayStart}:00`);

  // If we haven't reached today's business day start yet, use yesterday's
  const currentMinutes = hour * 60 + minute;
  const startMinutes   = startHour * 60 + startMin;

  if (currentMinutes < startMinutes) {
    todayStart.setDate(todayStart.getDate() - 1);
  }

  // Convert back to UTC for Supabase queries
  // We need to express "6am London time on 2026-04-16" as UTC
  const tzOffset = getTimezoneOffset(timezone, todayStart);
  const utcStart = new Date(todayStart.getTime() - tzOffset);
  return utcStart;
}

/**
 * Get timezone offset in ms for a given timezone at a specific date
 */
function getTimezoneOffset(timezone, date) {
  const utcStr = date.toLocaleString('en-US', { timeZone: 'UTC' });
  const tzStr  = date.toLocaleString('en-US', { timeZone: timezone });
  return new Date(utcStr) - new Date(tzStr);
}

/**
 * Get the currently active shift name based on location time
 */
export function getCurrentShift(config) {
  const { timezone = 'Europe/London', shifts = [] } = config || {};
  if (!shifts.length) return null;

  const now = new Date();
  const timeStr = now.toLocaleString('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false });
  const [h, m] = timeStr.split(':').map(Number);
  const currentMinutes = h * 60 + m;

  return shifts.find(s => {
    const [sh, sm] = s.start.split(':').map(Number);
    const [eh, em] = s.end.split(':').map(Number);
    const start = sh * 60 + sm;
    const end   = eh * 60 + em;
    return currentMinutes >= start && currentMinutes < end;
  }) || null;
}

// v5.7.31: buildScheduleCtx moved VERBATIM to scheduleCtx.js (pure, no
// supabase import) so checkTotals.js can load under Node's test runner.
// Re-exported here so all 25+ existing `from './locationTime'` imports are
// untouched. Behaviour identical.
export { buildScheduleCtx } from './scheduleCtx.js';

// ── venue-local bucketing of historical timestamps (v5.7.24) ─────────────────
// Formatters are cached per timezone — constructing Intl.DateTimeFormat inside
// a readings loop is expensive (same pattern as rankQuickPicks in quickRank.js).

const _minuteFmtCache = new Map();
/**
 * Minutes since midnight of a timestamp on the VENUE's wall clock. For comparing
 * historical readings against schedule windows (due/missed) — device-local
 * getHours() puts a reading in the wrong window on a wrong-tz machine.
 * Unknown tz id falls back to device-local minutes.
 */
export function minutesInTz(ts, timezone) {
  const d = ts instanceof Date ? ts : new Date(ts);
  if (isNaN(d.getTime())) return null;
  const tz = timezone || 'Europe/London';
  try {
    let fmt = _minuteFmtCache.get(tz);
    if (!fmt) {
      fmt = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false });
      _minuteFmtCache.set(tz, fmt);
    }
    const [h, m] = fmt.format(d).split(':').map(Number);
    return ((h === 24 ? 0 : h) * 60) + m; // some runtimes emit "24" at midnight
  } catch {
    return d.getHours() * 60 + d.getMinutes();
  }
}

const _ymdFmtCache = new Map();
/**
 * The VENUE-local calendar day (YYYY-MM-DD) a timestamp falls on — which
 * business day a reading belongs to, never the device's date.
 */
export function ymdInTz(ts, timezone) {
  const d = ts instanceof Date ? ts : new Date(ts);
  if (isNaN(d.getTime())) return null;
  const tz = timezone || 'Europe/London';
  try {
    let fmt = _ymdFmtCache.get(tz);
    if (!fmt) {
      fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
      _ymdFmtCache.set(tz, fmt);
    }
    return fmt.format(d);
  } catch {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
}

/**
 * The venue calendar day `ymd` as real instants: [fromIso, toIso) = venue
 * midnight to next venue midnight, DST-correct via resolveLocalDateTime.
 * Replaces the device-midnight todayBounds() in the ops due/missed views.
 */
export function venueDayBoundsIso(ymd, timezone) {
  const tz = timezone || 'Europe/London';
  const [y, m, d] = ymd.split('-').map(Number);
  const nextYmd = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
  return {
    fromIso: resolveLocalDateTime(ymd, 0, tz).toISOString(),
    toIso: resolveLocalDateTime(nextYmd, 0, tz).toISOString(),
  };
}

/**
 * Format a date/timestamp in the location's timezone
 */
export function formatInLocationTz(date, timezone, opts = {}) {
  return new Date(date).toLocaleString('en-GB', {
    timeZone: timezone || 'Europe/London',
    ...opts,
  });
}

/**
 * Get "today" start as a plain Date object for Supabase .gte() queries
 * Falls back to midnight UTC if config not loaded yet
 */
export function getTodayStartFallback() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

// ── Show item images setting ──────────────────────────────────────────────────
let _showItemImages = null;

export async function getShowItemImages(supabase, locationId) {
  if (_showItemImages !== null) return _showItemImages;
  try {
    const { data } = await supabase.from('locations').select('show_item_images').eq('id', locationId).single();
    _showItemImages = data?.show_item_images ?? false;
  } catch {
    _showItemImages = false;
  }
  return _showItemImages;
}

export function clearShowItemImagesCache() {
  _showItemImages = null;
}
