// src/surfaces/website/hours.js
//
// Opening hours for the public site, built on the shared lib/openingHours.js (the same shape the
// online storefront and kiosk read: { weekly: { mon: [{open, close}] }, closedDates }).
// Venue clock invariant: "today" and "open now" are worked out in the venue's timezone, never the
// server's or the visitor's. Plain JS, used by SSR and React.

import { isOpenNow } from '../../lib/openingHours.js';

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const DAY_LABEL = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' };

/** The venue's weekday key (mon..sun) right now. Falls back to the runtime clock on a bad timezone. */
export function todayKey(timezone, now = new Date()) {
  try {
    const wd = new Intl.DateTimeFormat('en-GB', { timeZone: timezone || 'Europe/London', weekday: 'short' }).format(now);
    const k = wd.toLowerCase().slice(0, 3);
    return DAYS.includes(k) ? k : DAYS[(now.getDay() + 6) % 7];
  } catch {
    return DAYS[(now.getDay() + 6) % 7];
  }
}

function windowText(w) {
  if (!w || !w.open || !w.close) return '';
  return `${w.open} to ${w.close}`;
}

/**
 * Rows for an hours table: [{ key, label, text, today }]. `text` is 'Closed' when the day has no
 * window. todayFirst rotates the week so today leads. Missing hours → every day 'Hours not set'.
 */
export function hoursRows(hours, timezone, { todayFirst = true, now = new Date() } = {}) {
  const weekly = hours && hours.weekly && typeof hours.weekly === 'object' ? hours.weekly : null;
  const today = todayKey(timezone, now);
  const start = todayFirst ? DAYS.indexOf(today) : 0;
  const order = DAYS.slice(start).concat(DAYS.slice(0, start));
  return order.map((key) => {
    const wins = weekly && Array.isArray(weekly[key]) ? weekly[key].map(windowText).filter(Boolean) : null;
    let text;
    if (!weekly) text = 'Hours not set';
    else if (!wins || !wins.length) text = 'Closed';
    else text = wins.join(', ');
    return { key, label: DAY_LABEL[key], text, today: key === today };
  });
}

/** { open: bool, text: 'Open now' | 'Closed now' | '' } in the venue's timezone. Never throws. */
export function openStatus(hours, timezone, now = new Date()) {
  try {
    if (!hours || !hours.weekly) return { open: false, text: '' };
    const r = isOpenNow(hours, timezone || 'Europe/London', now);
    return { open: !!r.open, text: r.open ? 'Open now' : 'Closed now' };
  } catch {
    return { open: false, text: '' };
  }
}

/**
 * schema.org openingHoursSpecification rows from the weekly shape. Overnight windows keep their
 * literal closes (schema.org allows closes < opens to mean next day).
 */
export function openingHoursSpecification(hours) {
  const weekly = hours && hours.weekly && typeof hours.weekly === 'object' ? hours.weekly : null;
  if (!weekly) return [];
  const out = [];
  for (const key of DAYS) {
    const wins = Array.isArray(weekly[key]) ? weekly[key] : [];
    for (const w of wins) {
      if (!w || !w.open || !w.close) continue;
      out.push({ '@type': 'OpeningHoursSpecification', dayOfWeek: DAY_LABEL[key], opens: String(w.open), closes: String(w.close) });
    }
  }
  return out;
}
