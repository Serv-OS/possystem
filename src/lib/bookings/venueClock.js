// src/lib/bookings/venueClock.js
//
// 16 Oct 2026 (Peter, demoing from California to a UK venue): every time and
// date on the host stand is the VENUE's, never the iPad's. The till already
// read the venue clock (buildScheduleCtx); the stand read the device clock, so
// in California every Late, Due, now line, walk in time and "Today" was 8
// hours behind the till, and after 16:00 Pacific the two disagreed on the date.
//
// Pure: no store, no React, no supabase. The hook useVenueClock (bits.jsx)
// ticks these every 30 seconds. `at` (a Date) is for tests only; production
// callers omit it and get the current instant.

import { buildScheduleCtx } from '../scheduleCtx.js';

export const VENUE_CLOCK_TICK_MS = 30000;

// { ymd: 'YYYY-MM-DD', nowMin: 0..1439, isoDay: 1..7 } on the venue's wall clock.
export function venueNow(timezone, at) {
  const c = buildScheduleCtx(timezone || 'Europe/London', at);
  return { ymd: c.ymd, nowMin: c.nowMinutes, isoDay: c.isoDay };
}

export const venueToday = (timezone, at) => venueNow(timezone, at).ymd;

// No date chosen counts as today (the diary's default).
export function isVenueToday(dateISO, timezone, at) {
  return !dateISO || dateISO === venueToday(timezone, at);
}

// Calendar arithmetic on a 'YYYY-MM-DD' string, in UTC so no device timezone
// or daylight saving change can move it.
export function shiftYmd(ymd, delta) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
  if (!m) return ymd;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + (Number(delta) || 0)));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

// 'Fri' / 'Fri 16 Oct' for a venue date, without the device timezone touching it.
export function ymdLabel(ymd, { long = false } = {}) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
  if (!m) return String(ymd || '');
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12));
  const opts = long
    ? { timeZone: 'UTC', weekday: 'short', day: '2-digit', month: 'short' }
    : { timeZone: 'UTC', weekday: 'short' };
  try { return d.toLocaleDateString('en-GB', opts); } catch { return ymd; }
}

// The n venue days ending on `endYmd`, oldest first: [{ iso, label }].
export function daysEnding(endYmd, n = 7) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const iso = shiftYmd(endYmd, -i);
    out.push({ iso, label: ymdLabel(iso) });
  }
  return out;
}

// 'HH:MM:SS' (or 'HH:MM') on the venue's wall clock.
export function venueClockText(timezone, at, { seconds = true } = {}) {
  const when = at instanceof Date ? at : new Date();
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone || 'Europe/London', hour: '2-digit', minute: '2-digit',
      ...(seconds ? { second: '2-digit' } : {}), hour12: false,
    }).format(when).replace(/^24/, '00');
  } catch {
    return when.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}) });
  }
}

// The next quarter hour strictly after nowMin, as minutes of the day (a walk
// in seated at 19:07 is booked at 19:15).
export const nextQuarterMin = (nowMin) => Math.ceil(((Number(nowMin) || 0) + 1) / 15) * 15;

// Midnight rollover: when the venue's day changes and the diary was showing
// the day that just ended, follow to the new day. A diary deliberately on
// another date stays where it is. Returns the date to load, or null.
export function rolloverTarget({ viewing, previousToday, today }) {
  if (!today || !previousToday || today === previousToday) return null;
  if (!viewing || viewing === previousToday) return today;
  return null;
}

// epoch ms -> minute of the day on the venue clock, for sessionsToBlocks (an
// open tab's seatedAt), so a California stand does not place a UK tab 8 hours out.
export const epochToVenueMin = (timezone) => (epochMs) => venueNow(timezone, new Date(Number(epochMs))).nowMin;
