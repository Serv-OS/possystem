// The sites a booking report reads (16 Oct 2026), shared by BookingsReport and
// BookingPaymentsReport. The reports shell hands every ticked site with its OWN range (the same
// business days on that site's clock: src/lib/reportScope.js siteRange). Before the scope is in,
// or for a login with no scope, the signed in site is read over the shell's range.
// PURE: tested in bookingReportsUi.test.js.

import { reportClock, dayOfCheck } from './_filters.js';

/**
 * [{ id, name, currency, timezone, businessDayStart, isHome, range: { from, to, fromDay, toDay } }]
 *   sites   the shell's sites prop (may be empty)
 *   homeId  the signed in site, when sites is empty
 *   range   the shell's range (from, to, fromDay, toDay)
 */
export function bookingSites({ sites = [], homeId = null, range = null } = {}) {
  const list = Array.isArray(sites) ? sites.filter((s) => s && s.id && s.range) : [];
  if (list.length) return list;
  if (!homeId || !range) return [];
  return [{ id: String(homeId), name: 'This site', currency: null, timezone: range.timeZone || null, businessDayStart: range.dayStart || null, isHome: true, range }];
}

/** The venue business day of an instant, on one site's clock. */
export const siteDayOf = (site) => {
  const clock = reportClock({ timezone: site?.timezone || site?.range?.timeZone, businessDayStart: site?.businessDayStart || site?.range?.dayStart });
  return (iso) => (iso ? dayOfCheck(iso, clock) : '');
};

/** "19:42" on one site's clock. */
export const siteTimeOf = (site) => {
  const tz = site?.timezone || site?.range?.timeZone || 'Europe/London';
  return (iso) => {
    if (!iso) return '';
    try {
      return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));
    } catch { return ''; }
  };
};

/** The ISO bounds of a site's range for a created_at read. */
export function isoBounds(site) {
  const from = site?.range?.from instanceof Date ? site.range.from : new Date(site?.range?.from);
  const to = site?.range?.to instanceof Date ? site.range.to : new Date(site?.range?.to);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return null;
  return { from: from.toISOString(), to: to.toISOString() };
}
