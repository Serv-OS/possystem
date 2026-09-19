// supabase/functions/_shared/businessDay.js
//
// THE VENUE BUSINESS DAY, for anything that books money by day (Xero today, QuickBooks
// next). Pure JS with no imports, so the edge functions and `npm test` load the same file.
//
// A business day is NOT a UTC day and NOT a calendar day. It runs from the venue's
// business_day_start on its own wall clock (platform locations.business_day_start, default
// 06:00, the same setting the Back Office sales reports use) to the same wall time the next
// day, in the venue's IANA zone (platform locations.timezone). So a UK bar's 00:40 sale on a
// Saturday in BST belongs to FRIDAY's takings, and a Utah venue's 19:00 sale is not pushed
// into tomorrow because UTC has already rolled over. Until v5.9.11 xero-sales used
// 00:00Z to 23:59Z, which put every UK after-midnight sale (and all of BST's first hour) on
// the wrong day.
//
// DST: every boundary is found from the zone's real offsets, never a fixed one. A start
// time the clocks skip (01:30 on a spring forward night) resolves to the first moment
// after the gap; a start time the clocks show twice (01:30 on a fall back night) resolves
// to the FIRST time it is shown. Days are contiguous by construction: a day ends exactly
// where the next begins, and businessDayOf() is defined from the same boundaries, so an
// instant can never belong to two days or to none.

export const DEFAULT_VENUE_TZ = 'Europe/London';
// platform locations.business_day_start defaults to '06:00' and src/lib/locationTime.js
// getLocationConfig falls back to it, so the accounting day matches what the reports show.
export const DEFAULT_DAY_START = '06:00';

const DAY_MS = 86400000;
const _fmt = new Map();

function formatter(tz) {
  let f = _fmt.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    _fmt.set(tz, f);
  }
  return f;
}

/** A usable IANA zone name, else the default venue zone. Never the machine's own zone. */
export function venueZone(tz) {
  const z = typeof tz === 'string' ? tz.trim() : '';
  if (!z) return DEFAULT_VENUE_TZ;
  try { formatter(z).format(0); return z; } catch { return DEFAULT_VENUE_TZ; }
}

/** 'HH:MM' (or 'H:MM', optional ':SS') to minutes after midnight; a bad value reads as the default start. */
export function dayStartMinutes(dayStart) {
  const m = /^\s*(\d{1,2}):(\d{2})(?::\d{2})?\s*$/.exec(String(dayStart ?? ''));
  if (m) {
    const h = Number(m[1]), mi = Number(m[2]);
    if (h < 24 && mi < 60) return h * 60 + mi;
  }
  return dayStartMinutes(DEFAULT_DAY_START);
}

/** The venue's wall clock at an instant: { ymd, minutes, ms } where ms is the wall time read as if it were UTC. */
export function wallClock(instantMs, tz) {
  const p = {};
  for (const x of formatter(venueZone(tz)).formatToParts(new Date(instantMs))) {
    if (x.type !== 'literal') p[x.type] = Number(x.value);
  }
  const hour = p.hour === 24 ? 0 : p.hour;
  const pad = (n) => String(n).padStart(2, '0');
  return {
    ymd: `${p.year}-${pad(p.month)}-${pad(p.day)}`,
    minutes: hour * 60 + p.minute,
    ms: Date.UTC(p.year, p.month - 1, p.day, hour, p.minute, p.second),
  };
}

// Offset of the zone at an instant, in ms (wall clock minus UTC). Whole seconds only.
function offsetAt(instantMs, tz) {
  const t = Math.floor(instantMs / 1000) * 1000;
  return wallClock(t, tz).ms - t;
}

/** 'YYYY-MM-DD' plus n calendar days. */
export function addDays(ymd, n) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export function isYmd(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const back = new Date(Date.UTC(y, m - 1, d));
  return back.getUTCFullYear() === y && back.getUTCMonth() === m - 1 && back.getUTCDate() === d;
}

/**
 * The instant a wall clock time happens in the venue zone. A time inside a spring forward
 * gap resolves to the first moment after the gap; a time shown twice resolves to the first.
 */
export function wallTimeToInstant(ymd, minutes, tz) {
  const zone = venueZone(tz);
  const [y, m, d] = ymd.split('-').map(Number);
  const wall = Date.UTC(y, m - 1, d, 0, minutes, 0);
  // Every offset the zone uses around this wall time (before and after any change that day).
  const offsets = [...new Set([offsetAt(wall - DAY_MS, zone), offsetAt(wall, zone), offsetAt(wall + DAY_MS, zone)])];
  const hits = offsets.map((o) => wall - o).filter((t) => wallClock(t, zone).ms === wall).sort((a, b) => a - b);
  if (hits.length) return hits[0];
  // In a gap: read the wall time with the offset in force BEFORE the change, which lands
  // just after the gap (01:30 on the UK spring forward night becomes 02:30 BST).
  return wall - offsetAt(wall - DAY_MS, zone);
}

/** Where business day `ymd` starts, as an instant (ms). */
export function businessDayStartMs(ymd, tz, dayStart) {
  return wallTimeToInstant(ymd, dayStartMinutes(dayStart), tz);
}

/**
 * Business day `ymd` as real instants: [fromIso, toIso). Query with gte(from) and lt(to).
 * Throws on a date that is not a real calendar date.
 */
export function businessDayWindow(ymd, tz, dayStart) {
  if (!isYmd(ymd)) throw new Error(`Not a date: ${ymd}`);
  const fromMs = businessDayStartMs(ymd, tz, dayStart);
  const toMs = businessDayStartMs(addDays(ymd, 1), tz, dayStart);
  return { ymd, fromMs, toMs, fromIso: new Date(fromMs).toISOString(), toIso: new Date(toMs).toISOString() };
}

/** The business day an instant belongs to. Uses the same boundaries as businessDayWindow. */
export function businessDayOf(instant, tz, dayStart) {
  const ms = instant instanceof Date ? instant.getTime() : typeof instant === 'number' ? instant : Date.parse(instant);
  if (!Number.isFinite(ms)) return null;
  let day = wallClock(ms, tz).ymd;
  // At most one step either way: the calendar date and the business day differ by the start time only.
  if (ms < businessDayStartMs(day, tz, dayStart)) day = addDays(day, -1);
  else if (ms >= businessDayStartMs(addDays(day, 1), tz, dayStart)) day = addDays(day, 1);
  return day;
}

/** The business day that is trading right now. */
export function currentBusinessDay(nowMs, tz, dayStart) {
  return businessDayOf(nowMs, tz, dayStart);
}

/** The most recent business day that has fully ended. The nightly post books this one. */
export function lastCompletedBusinessDay(nowMs, tz, dayStart) {
  return addDays(currentBusinessDay(nowMs, tz, dayStart), -1);
}

/** True once business day `ymd` has ended (its window closed at or before now). */
export function isBusinessDayOver(ymd, nowMs, tz, dayStart) {
  return nowMs >= businessDayWindow(ymd, tz, dayStart).toMs;
}
