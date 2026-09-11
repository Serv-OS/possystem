// src/lib/payments/venueTime.js
//
// Date and time text for the ServOS Payments tabs, always on the VENUE clock
// (platform locations.timezone, served by adyen-financial), never the
// viewer's device clock. A payment at 14:29 UTC on 10 Sep 2026 reads 15:29
// for a London venue, even when the owner looks from California.
//
// Formatters are cached per zone and style: building Intl.DateTimeFormat per
// table row is slow.

const cache = new Map();
function formatter(style, timeZone) {
  const key = `${style}|${timeZone}`;
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
  f = new Intl.DateTimeFormat(style === 'csv' || style === 'month' ? 'en-CA' : 'en-GB', { ...opts, timeZone });
  cache.set(key, f);
  return f;
}

const safeZone = (tz) => {
  if (typeof tz !== 'string' || !tz.trim()) return 'Europe/London';
  try { new Intl.DateTimeFormat('en-GB', { timeZone: tz.trim() }); return tz.trim(); } catch { return 'Europe/London'; }
};
const toDate = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const d = v instanceof Date ? v : new Date(v);
  return isNaN(d.getTime()) ? null : d;
};

// "10 Sept, 15:29" on the venue clock.
export function formatVenueWhen(iso, timeZone) {
  const d = toDate(iso);
  return d ? formatter('when', safeZone(timeZone)).format(d) : '—';
}

// "10 Sept 2026" on the venue clock.
export function formatVenueDate(iso, timeZone) {
  const d = toDate(iso);
  return d ? formatter('date', safeZone(timeZone)).format(d) : '—';
}

// "10 September 2026" on the venue clock.
export function formatVenueLongDate(iso, timeZone) {
  const d = toDate(iso);
  return d ? formatter('longDate', safeZone(timeZone)).format(d) : '—';
}

// "2026-09-10 15:29" on the venue clock, for CSV files.
export function formatVenueCsvWhen(iso, timeZone) {
  const d = toDate(iso);
  if (!d) return '';
  const parts = formatter('csv', safeZone(timeZone)).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t)?.value ?? '';
  const hour = get('hour') === '24' ? '00' : get('hour');
  return `${get('year')}-${get('month')}-${get('day')} ${hour}:${get('minute')}`;
}

// A calendar date with no time ('2026-09-10', a payout date) as "10 Sept 2026".
// It is a day, not an instant, so no zone shifts it.
export function formatCalendarDate(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ymd ?? ''));
  if (!m) return ymd ? String(ymd) : '—';
  return formatter('date', 'UTC').format(new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))));
}

// A 'YYYY-MM' month as "September 2026".
export function formatMonthLabel(ym) {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(String(ym ?? ''));
  if (!m) return String(ym ?? '');
  return formatter('monthLabel', 'UTC').format(new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1)));
}

// A zone id as plain words for screen text: 'Europe/London' reads 'London',
// 'America/Los_Angeles' reads 'Los Angeles'. CSV headers keep the zone id.
export const venueZoneLabel = (tz) => String(tz || 'Europe/London').split('/').pop().replace(/_/g, ' ');

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
  const parts = formatter('month', safeZone(timeZone)).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}`;
}
