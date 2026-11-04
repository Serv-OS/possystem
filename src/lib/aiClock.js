// src/lib/aiClock.js
//
// 5.12.60 (US basics batch 8, the tail): the VENUE's clock for "today" and "which hour", not the
// laptop's. The AI tools (lib/aiTools.js) count today's checks from the venue's midnight and bucket
// them by the venue's hour; the Back Office greeting says good morning by the venue's hour. Before
// this both read the device: an owner in California asking a Leeds till about "today" got the
// Pacific day.
//
// NO ZONE: with no venue zone known (tz null) every helper reads the laptop's clock exactly as the
// code did before (setHours(0, 0, 0, 0), getHours()), so nothing moves until a zone is known.
//
// PURE: imports only the shared venueDates core, so node:test and the browser share this copy. The
// callers pass the active venue's zone (lib/venueDates.js zoneOr()) and its words (a currency code).

import { clockParts, hhmmText } from '../../supabase/functions/_shared/venueDates.js';

const asDate = (d) => (d instanceof Date ? new Date(d.getTime()) : new Date(d));

// The venue's wall clock minus UTC at an instant, in ms (negative west of Greenwich).
function offsetMs(ms, tz) {
  const w = clockParts(ms, tz);
  const wall = Date.UTC(w.y, w.m - 1, w.d, w.hh, w.mm);
  return wall - Math.floor(ms / 60000) * 60000;
}

/**
 * The start of the venue's day holding `now`: midnight in zone `tz`, as a Date. Clock changes
 * included (the offset is read again at the answer itself). No zone: the laptop's midnight, as before.
 */
export function venueDayStart(tz, now = new Date()) {
  const at = asDate(now);
  const p = tz ? clockParts(at, tz) : null;
  if (!p) {
    at.setHours(0, 0, 0, 0);   // laptop fallback: exactly what every tool did before a zone was known
    return at;
  }
  const ymdMs = Date.UTC(p.y, p.m - 1, p.d);
  let t = ymdMs - offsetMs(ymdMs, tz);
  t = ymdMs - offsetMs(t, tz);
  return new Date(t);
}

/** The hour (0 to 23) of an instant on the venue's clock. No zone: the laptop's hour, as before. */
export function venueHour(ts, tz) {
  const p = tz ? clockParts(ts, tz) : null;
  if (p) return p.hh;
  return asDate(ts).getHours();   // laptop fallback, as before
}

/** An hour bucket's label the venue's way: '14:00' at a UK venue (as before), '2:00 PM' at a US one. */
export function hourLabel(h, venue = 'GBP') {
  const hh = ((Number(h) % 24) + 24) % 24;
  return hhmmText(`${String(hh).padStart(2, '0')}:00`, venue);
}

/** 'morning' before 12, 'afternoon' before 17, else 'evening' (the Back Office greeting's rule, as before). */
export function dayPart(h) {
  return h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening';
}
