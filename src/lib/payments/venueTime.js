// src/lib/payments/venueTime.js
//
// Date and time text for the ServOS Payments tabs, always on the VENUE clock
// (platform locations.timezone, served by adyen-financial), never the
// viewer's device clock. A payment at 14:29 UTC on 10 Sep 2026 reads 15:29
// for a London venue, even when the owner looks from California.
//
// Formatters are cached per zone and style: building Intl.DateTimeFormat per
// table row is slow.
//
// 5.12.57 (US basics batch 8): the words follow the venue (the active venue's currency, or the
// `venue` passed): a US venue reads "Sep 10, 3:29 PM" and "Sep 10, 2026"; a UK venue exactly as
// before. A missing zone is the venue's country's only zone (London, Dublin); a US venue with no
// zone reads '—' (never a London time shown as its own).

import { getActiveCurrencyCode } from '../currency.js';
import { venueCountry } from '../../../supabase/functions/_shared/venueDates.js';

const ONE_ZONE = { UK: 'Europe/London', IE: 'Europe/Dublin' };
const isUs = (venue) => venueCountry(venue ?? getActiveCurrencyCode()) === 'US';
const plain = (s) => String(s).replace(/[\u202f\u00a0]/g, ' ');

const cache = new Map();
function formatter(style, timeZone, us = false) {
  const key = `${style}|${timeZone}|${us ? 'US' : ''}`;
  let f = cache.get(key);
  if (f) return f;
  const opts = {
    when: { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' },
    date: { day: '2-digit', month: 'short', year: 'numeric' },
    longDate: { day: '2-digit', month: 'long', year: 'numeric' },
    csv: { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' },
    month: { year: 'numeric', month: '2-digit' },
    monthLabel: { month: 'long', year: 'numeric' },
  }[style];
  const machine = style === 'csv' || style === 'month';
  if (us && !machine) {
    // a US venue: month first and a 12 hour clock ("Sep 10, 3:29 PM")
    const o = { ...opts, timeZone };
    delete o.hourCycle;
    if (o.hour === '2-digit') o.hour = 'numeric';
    f = new Intl.DateTimeFormat('en-US', o);
  } else {
    f = new Intl.DateTimeFormat(machine ? 'en-CA' : 'en-GB', { ...opts, timeZone });
  }
  cache.set(key, f);
  return f;
}
const fmtUs = (style, tz, venue, d) => {
  const us = isUs(venue);
  const out = formatter(style, tz, us).format(d);
  return us ? plain(out) : out;
};

// The venue's zone, or the only zone of its country when none is given (null for a US venue).
const fallbackZone = (venue) => ONE_ZONE[venueCountry(venue ?? getActiveCurrencyCode())] || null;
const safeZone = (tz, venue) => {
  if (typeof tz !== 'string' || !tz.trim()) return fallbackZone(venue);
  try { new Intl.DateTimeFormat('en-GB', { timeZone: tz.trim() }); return tz.trim(); } catch { return fallbackZone(venue); }
};
const toDate = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const d = v instanceof Date ? v : new Date(v);
  return isNaN(d.getTime()) ? null : d;
};

// "10 Sept, 15:29" on the venue clock ("Sep 10, 3:29 PM" at a US venue).
export function formatVenueWhen(iso, timeZone, venue) {
  const d = toDate(iso);
  const tz = safeZone(timeZone, venue);
  return d && tz ? fmtUs('when', tz, venue, d) : '—';
}

// "10 Sept 2026" on the venue clock ("Sep 10, 2026" at a US venue).
export function formatVenueDate(iso, timeZone, venue) {
  const d = toDate(iso);
  const tz = safeZone(timeZone, venue);
  return d && tz ? fmtUs('date', tz, venue, d) : '—';
}

// "10 September 2026" on the venue clock ("September 10, 2026" at a US venue).
export function formatVenueLongDate(iso, timeZone, venue) {
  const d = toDate(iso);
  const tz = safeZone(timeZone, venue);
  return d && tz ? fmtUs('longDate', tz, venue, d) : '—';
}

// "2026-09-10 15:29" on the venue clock, for CSV files (the same at every venue: a machine date).
export function formatVenueCsvWhen(iso, timeZone, venue) {
  const d = toDate(iso);
  const tz = safeZone(timeZone, venue);
  if (!d || !tz) return '';
  const parts = formatter('csv', tz).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t)?.value ?? '';
  const hour = get('hour') === '24' ? '00' : get('hour');
  return `${get('year')}-${get('month')}-${get('day')} ${hour}:${get('minute')}`;
}

// A calendar date with no time ('2026-09-10', a payout date) as "10 Sept 2026" ("Sep 10, 2026" US).
// It is a day, not an instant, so no zone shifts it.
export function formatCalendarDate(ymd, venue) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ymd ?? ''));
  if (!m) return ymd ? String(ymd) : '—';
  return fmtUs('date', 'UTC', venue, new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))));
}

// A 'YYYY-MM' month as "September 2026".
export function formatMonthLabel(ym, venue) {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(String(ym ?? ''));
  if (!m) return String(ym ?? '');
  return fmtUs('monthLabel', 'UTC', venue, new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1)));
}

// A zone id as plain words for screen text: 'Europe/London' reads 'London',
// 'America/Los_Angeles' reads 'Los Angeles'. CSV headers keep the zone id.
// 5.12.57: no zone is the active venue's country's only zone ('London' at a UK venue, as before).
export const venueZoneLabel = (tz, venue) => String(tz || fallbackZone(venue) || 'UTC').split('/').pop().replace(/_/g, ' ');

// `count` 'YYYY-MM' months counting back from `fromYm` (itself first), for a
// month picker. [] for a bad month.
export function recentMonths(fromYm, count = 24) {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(String(fromYm ?? ''));
  if (!m) return [];
  const out = [];
  let y = Number(m[1]);
  let mo = Number(m[2]);
  for (let i = 0; i < Math.max(0, count); i++) {
    out.push(`${y}-${String(mo).padStart(2, '0')}`);
    mo -= 1;
    if (mo === 0) { mo = 12; y -= 1; }
  }
  return out;
}

// The current 'YYYY-MM' on the venue clock.
export function venueMonthNow(timeZone, now = new Date()) {
  const d = toDate(now) ?? new Date();
  const parts = formatter('month', safeZone(timeZone) || 'UTC').formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}`;
}
