// supabase/functions/_shared/venueDates.js
//
// 5.12.57 (US basics batch 8): DATES AND TIMES THE VENUE'S WAY. One set of helpers for every screen,
// receipt, text and email that shows a date or a time, so a US venue reads "Nov 3, 2026", 11/03/2026
// and "2:05 PM" and a UK venue reads "3 Nov 2026", 03/11/2026 and "14:05", exactly as it did.
//
// THE VENUE decides, never the laptop: the venue's currency (or its country, or a locale) picks the
// words (regionPack), and the venue's time zone picks the wall clock. A UK venue keeps the exact
// call the screens made before (toLocale...('en-GB', the same options)), so its words cannot move by
// a byte; a US venue gets 'en-US' with a 12 hour clock. Ireland reads as the UK did (en-GB), as before.
//
// PURE: one import (regionPack.js, itself pure), so the Back Office (src/lib/venueDates.js adds the
// active venue), the edge functions under Deno and node:test all share this copy.

import { regionOf, fmtDateNumeric } from './regionPack.js';

const COUNTRY_WORDS = { UK: 'UK', GB: 'UK', 'UNITED KINGDOM': 'UK', US: 'US', USA: 'US', 'UNITED STATES': 'US', IE: 'IE', IRL: 'IE', IRELAND: 'IE' };
const LOCALE_COUNTRY = { 'EN-US': 'US', 'EN-GB': 'UK', 'EN-IE': 'IE' };
const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * The venue's country, from whatever the caller has: a currency code ('USD'), a country ('US'), a
 * locale ('en-US'), or a venue row ({ country, currency }). Unknown reads as the UK, as before.
 * @returns {'UK'|'US'|'IE'}
 */
export function venueCountry(venue) {
  if (typeof venue === 'string') {
    const s = venue.trim().toUpperCase();
    if (LOCALE_COUNTRY[s]) return LOCALE_COUNTRY[s];
    if (COUNTRY_WORDS[s]) return COUNTRY_WORDS[s];
  }
  return regionOf(venue);
}

/** The locale a venue's words are written in: 'en-US' at a US venue, else 'en-GB' (what every screen used). */
export function venueLocale(venue) {
  return venueCountry(venue) === 'US' ? 'en-US' : 'en-GB';
}

/** Does the venue read a 12 hour clock (2:05 PM)? A US venue does; the UK and Ireland read 14:05. */
export function uses12h(venue) {
  return venueCountry(venue) === 'US';
}

const asDate = (d) => (d instanceof Date ? d : new Date(d));

// A US venue: en-US, 12 hour ('2:05 PM', never '02:05 PM' or the 24 hour clock a UK screen asked
// for), and the narrow space some browsers put before AM/PM made a plain one (texts and emails).
function usOpts(opts) {
  const o = { ...(opts || {}) };
  delete o.hour12;
  delete o.hourCycle;
  if (o.hour === '2-digit') o.hour = 'numeric';
  return o;
}
const plain = (s) => String(s).replace(/[\u202f\u00a0]/g, ' ');

/**
 * Date#toLocaleDateString the venue's way. A UK venue gets exactly toLocaleDateString('en-GB', opts),
 * so its words do not move; a US venue gets en-US. `d` is a Date or anything new Date() reads.
 */
export function localeDateString(d, opts, venue) {
  const date = asDate(d);
  return uses12h(venue) ? plain(date.toLocaleDateString('en-US', usOpts(opts))) : date.toLocaleDateString('en-GB', opts);
}
/** Date#toLocaleTimeString the venue's way ('14:05' at a UK venue as before, '2:05 PM' at a US one). */
export function localeTimeString(d, opts, venue) {
  const date = asDate(d);
  return uses12h(venue) ? plain(date.toLocaleTimeString('en-US', usOpts(opts))) : date.toLocaleTimeString('en-GB', opts);
}
/** Date#toLocaleString the venue's way. */
export function localeString(d, opts, venue) {
  const date = asDate(d);
  return uses12h(venue) ? plain(date.toLocaleString('en-US', usOpts(opts))) : date.toLocaleString('en-GB', opts);
}

/** The parts of an instant on a venue's wall clock, or null (no instant, or no zone). */
export function clockParts(ts, tz) {
  if (!tz) return null;
  const d = asDate(ts);
  if (ts == null || ts === '' || Number.isNaN(d.getTime())) return null;
  try {
    const p = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, // batch 8 ok: parts only
    }).formatToParts(d);
    const get = (t) => p.find((x) => x.type === t)?.value;
    let hh = parseInt(get('hour'), 10);
    if (hh === 24) hh = 0;   // some runtimes emit "24" at midnight
    return { y: Number(get('year')), m: Number(get('month')), d: Number(get('day')), hh, mm: parseInt(get('minute'), 10) };
  } catch { return null; }
}

/** The venue's calendar day of an instant, 'YYYY-MM-DD' (a plain date passes through), or ''. */
export function venueYmd(isoOrTs, tz) {
  if (typeof isoOrTs === 'string' && YMD.test(isoOrTs)) return isoOrTs;
  const p = clockParts(isoOrTs, tz);
  return p ? `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}` : '';
}

/**
 * A day in words: "3 Nov 2026" (UK, as the screens wrote it) or "Nov 3, 2026" (US).
 *   iso    'YYYY-MM-DD' (read as that calendar day, no clock) or an instant (read on opts.tz)
 *   opts   { venue, tz, weekday: false, year: true, month: 'short' }
 * An instant with no zone reads as '' (never a day from the wrong clock).
 */
export function dayText(iso, opts = {}) {
  const { venue = 'GBP', tz = null, weekday = false, year = true, month = 'short' } = opts || {};
  const ymd = venueYmd(iso, tz);
  const m = YMD.exec(ymd);
  if (!m) return '';
  const at = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12));
  const o = { timeZone: 'UTC', day: 'numeric', month };
  if (weekday) o.weekday = weekday === true ? 'short' : weekday;
  if (year) o.year = 'numeric';
  return localeDateString(at, o, venue);
}

/** A numeric date: 03/11/2026 (UK) or 11/03/2026 (US). A plain date, or an instant on tz. '' for nothing. */
export function dateNumeric(iso, venue = 'GBP', tz = null) {
  return fmtDateNumeric(venueYmd(iso, tz), venue);
}

/** A wall clock 'HH:MM' the venue's way: '14:05' (UK, as given) or '2:05 PM' (US). */
export function hhmmText(hhmm, venue = 'GBP') {
  const t = /^(\d{1,2}):(\d{2})/.exec(String(hhmm || ''));
  if (!t) return hhmm == null ? '' : String(hhmm);
  if (!uses12h(venue)) return String(hhmm).slice(0, t[0].length);
  const h = Number(t[1]) % 24;
  return `${((h + 11) % 12) + 1}:${t[2]} ${h < 12 ? 'AM' : 'PM'}`;
}

/**
 * A shift's span the venue's way (Peter 8.2, 4 Nov 2026: the rota grid at a US venue). A UK venue
 * reads start and finish exactly as given, joined by `sep` (the rota's en dash unless the caller
 * says): '17:00' + '23:00' = "17:00\u201323:00", byte for byte what it showed before. A US venue
 * reads "5:00 PM to 11:00 PM".
 */
export function spanText(start, finish, venue = 'GBP', sep = '\u2013') {
  if (!uses12h(venue)) return `${start ?? ''}${sep}${finish ?? ''}`;
  return `${hhmmText(start, venue)} to ${hhmmText(finish, venue)}`;
}

/**
 * The time of an instant on the venue's clock: '14:05' (UK) or '2:05 PM' (US). A plain 'HH:MM'
 * reads as given (hhmmText). No zone: '' (never the laptop's clock, never a fixed other city).
 */
export function timeText(iso, tz, venue = 'GBP') {
  if (typeof iso === 'string' && /^\d{1,2}:\d{2}(:\d{2})?$/.test(iso)) return hhmmText(iso, venue);
  const p = clockParts(iso, tz);
  if (!p) return '';
  return hhmmText(`${String(p.hh).padStart(2, '0')}:${String(p.mm).padStart(2, '0')}`, venue);
}

/** An instant as the venue's day and time: '3 Nov 2026 14:05' (UK) or 'Nov 3, 2026 2:05 PM' (US). */
export function dateTimeText(iso, tz, venue = 'GBP', opts = {}) {
  const t = timeText(iso, tz, venue);
  if (!t) return '';
  return `${dayText(iso, { ...opts, venue, tz })} ${t}`;
}

/** Today on the venue's clock, 'YYYY-MM-DD', or '' with no zone. */
export function venueToday(tz, now = new Date()) {
  return venueYmd(now, tz);
}

/**
 * The first day of the work week holding a plain date, for a week that starts on `startDow`
 * (0 = Sunday ... 6 = Saturday; 1 = Monday, what every week was before). 'YYYY-MM-DD'.
 */
export function weekStartYmd(iso, startDow = 1) {
  const m = YMD.exec(String(iso || '').slice(0, 10));
  if (!m) return '';
  const s = Number.isInteger(Number(startDow)) && Number(startDow) >= 0 && Number(startDow) <= 6 ? Number(startDow) : 1;
  const t = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() - s + 7) % 7));
  return t.toISOString().slice(0, 10);
}

/** A venue's work week start day (0 to 6) from its Workforce settings (Work week starts), Monday if unset. */
export function workweekStartDow(settings) {
  const d = Number(settings?.workweekStart);
  return Number.isInteger(d) && d >= 0 && d <= 6 ? d : 1;
}
