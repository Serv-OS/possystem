// src/lib/online/collectionSlots.js
//
// The ONE collection slot rule for online ordering (5.12.34). It lived inside OnlineCheckout.jsx;
// the menu page's Order timing sheet now needs the same list, so it moved here and both read it.
// Nothing in the rule changed.
//
// Slots are 15 minute steps inside the venue's opening windows, starting at the earliest step at
// or after now plus the lead, snapped to :00 / :15 / :30 / :45, for today plus maxDaysAhead days.

import { getDayWindows, resolveLocalDateTime } from '../openingHours.js';

// Advance a YYYY-MM-DD by one calendar day without touching real time, so DST
// transitions cannot skip or repeat a day.
export function nextIsoDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + 1));
  return dt.toISOString().slice(0, 10);
}

/**
 * Build the valid collection slots.
 * @param {object} location  the platform locations row (opening_hours is read)
 * @param {string} tz        the venue's time zone
 * @param {number} leadMin   minutes before the first slot (the quoted prep time)
 * @param {number} maxDaysAhead  0 = today only
 * @param {Date}   now       injectable for tests
 * @returns {{ iso: string, day: string, label: string }[]}
 */
export function buildCollectionSlots(location, tz, leadMin, maxDaysAhead = 7, now = new Date()) {
  const hours = location?.opening_hours;
  if (!hours?.weekly) return [];
  const out = [];
  const earliest = new Date(now.getTime() + (Number(leadMin) || 0) * 60_000);
  // Round up to next 15-min boundary
  const m = earliest.getMinutes();
  const ceil = Math.ceil(m / 15) * 15;
  earliest.setMinutes(ceil, 0, 0);

  // Walk the days ahead, generate slots inside open windows at or after earliest.
  // Days are advanced on the VENUE CALENDAR, not by adding 24h of real time:
  // across a DST change a 24h hop lands on the same date twice (or skips one),
  // which silently lost a whole day of bookable slots twice a year.
  const seen = new Set();
  let cursorIso = now.toLocaleDateString('en-CA', { timeZone: tz });
  const days = Math.max(0, Math.min(60, Number(maxDaysAhead) || 0)) + 1;   // today + N ahead
  for (let dayOffset = 0; dayOffset < days; dayOffset++) {
    const probe = resolveLocalDateTime(cursorIso, 12 * 60, tz);   // midday, safe from DST edges
    cursorIso = nextIsoDate(cursorIso);
    const windows = getDayWindows(hours, tz, probe);
    if (!windows.length) continue;
    const dayLabel = probe.toLocaleDateString('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short' });
    // v5.7.22: window times ("09:00") are VENUE wall-clock, so the slot
    // instants must be built in the venue's timezone. setHours() built them on
    // the customer's DEVICE clock, so a phone in another timezone was offered
    // slots shifted by the whole tz difference.
    const isoDate = probe.toLocaleDateString('en-CA', { timeZone: tz });
    for (const w of windows) {
      const [oh, om] = w.open.split(':').map(Number);
      const [ch, cm] = w.close.split(':').map(Number);
      const openMin  = oh * 60 + om;
      const closeMin = ch * 60 + cm;
      let cur = resolveLocalDateTime(isoDate, openMin, tz);
      // A window that closes at or before it opens runs past midnight ("17:00
      // to 01:00", or "12:00 to 00:00"). The close belongs to the NEXT day.
      // Without this the while-loop below never ran once, so a late-night venue
      // was offered no scheduled collection slots at all, and when it was shut
      // the ASAP chip is hidden too, so there was no way to order at all.
      const end = closeMin <= openMin
        ? resolveLocalDateTime(nextIsoDate(isoDate), closeMin, tz)
        : resolveLocalDateTime(isoDate, closeMin, tz);
      while (cur.getTime() < end.getTime()) {
        const iso = cur.toISOString();
        // Overnight windows overlap the next day's pass, so dedupe by instant.
        if (cur.getTime() >= earliest.getTime() && !seen.has(iso)) {
          seen.add(iso);
          out.push({
            iso,
            day: dayOffset === 0 ? 'Today' : (dayOffset === 1 ? 'Tomorrow' : dayLabel),
            label: cur.toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }),
          });
        }
        cur = new Date(cur.getTime() + 15 * 60_000);
      }
    }
    if (out.length >= 60) break; // reasonable upper bound
  }
  return out;
}
