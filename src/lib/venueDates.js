// src/lib/venueDates.js
//
// 5.12.57 (US basics batch 8): dates and times the venue's way, in the browser. The rules live in
// supabase/functions/_shared/venueDates.js (one copy for the app and the edge functions); this file
// adds the venue the Back Office is on right now: its words from the active currency (as money and
// the region pack) and its clock from the active time zone, which the location loader sets from the
// venue's own row (lib/locationTime.js, beside the currency). Pass `venue` or `tz` to read another
// venue (a report across sites, a row with its own zone).
//
// NO ZONE YET: a UK venue (GBP) and an Irish one (EUR) each have one zone, so they read London or
// Dublin until the row is read, as every screen did; a US venue has six, so its times read '' until
// its zone is known (never a London or New York time shown as the venue's).

import { getActiveCurrencyCode } from './currency.js';
import * as core from '../../supabase/functions/_shared/venueDates.js';

export { venueCountry, venueLocale, uses12h, clockParts, venueYmd, weekStartYmd, workweekStartDow, hhmmText } from '../../supabase/functions/_shared/venueDates.js';

const TZ_KEY = 'rpos-active-timezone';
const ONE_ZONE = { UK: 'Europe/London', IE: 'Europe/Dublin' };

/** Remember the active venue's time zone (lib/locationTime.js calls this with the venue's row). */
export function setActiveTimezone(tz) {
  try {
    if (!tz || typeof tz !== 'string') return;
    new Intl.DateTimeFormat('en-GB', { timeZone: tz });   // throws on a zone the browser does not know
    localStorage.setItem(TZ_KEY, tz);
  } catch { /* unknown zone, or no storage */ }
}

/** The active venue's time zone: its own once read, else its country's only zone, else null (a US venue). */
export function activeTimezone() {
  try {
    const t = localStorage.getItem(TZ_KEY);
    if (t) return t;
  } catch { /* no storage */ }
  return ONE_ZONE[core.venueCountry(getActiveCurrencyCode())] || null;
}

/** A zone the caller has, or the active venue's. Never a fixed other city. */
export function zoneOr(tz) {
  return tz || activeTimezone();
}

const V = (venue) => venue ?? getActiveCurrencyCode();

/** Date#toLocaleDateString for the active venue (or `venue`): exactly en-GB at a UK venue. */
export const localeDateString = (d, opts, venue) => core.localeDateString(d, opts, V(venue));
/** Date#toLocaleTimeString for the active venue (or `venue`): 24 hour at a UK venue, 12 hour at a US one. */
export const localeTimeString = (d, opts, venue) => core.localeTimeString(d, opts, V(venue));
/** Date#toLocaleString for the active venue (or `venue`). */
export const localeString = (d, opts, venue) => core.localeString(d, opts, V(venue));

/** An instant as Date#toLocaleString on the venue's clock (tz, else the active venue's); '' with no zone. */
export function venueStamp(ts, opts, tz, venue) {
  const z = zoneOr(tz);
  return z ? core.localeString(ts, { ...(opts || {}), timeZone: z }, V(venue)) : '';
}

/** "3 Nov 2026" / "Nov 3, 2026". opts { venue, tz, weekday, year, month }; an instant reads on the venue zone. */
export function dayText(iso, opts = {}) {
  return core.dayText(iso, { ...opts, venue: V(opts?.venue), tz: zoneOr(opts?.tz) });
}
/** 03/11/2026 (UK) or 11/03/2026 (US). */
export function dateNumeric(iso, venue, tz) {
  return core.dateNumeric(iso, V(venue), zoneOr(tz));
}
/** '14:05' (UK) or '2:05 PM' (US) on the venue's clock ('' with no zone). */
export function timeText(iso, tz, venue) {
  return core.timeText(iso, zoneOr(tz), V(venue));
}
/** '3 Nov 2026 14:05' (UK) or 'Nov 3, 2026 2:05 PM' (US) on the venue's clock. */
export function dateTimeText(iso, tz, venue, opts) {
  return core.dateTimeText(iso, zoneOr(tz), V(venue), opts);
}
/** Today on the venue's clock, 'YYYY-MM-DD' ('' with no zone). */
export function venueToday(tz, now) {
  return core.venueToday(zoneOr(tz), now);
}
/** A wall clock 'HH:MM' for the active venue (or `venue`): as given at a UK venue, '5:00 PM' at a US one. */
export function venueHhmm(hhmm, venue) {
  return core.hhmmText(hhmm, V(venue));
}
