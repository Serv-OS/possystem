// v5.5.102 — Opening hours helpers.
// Shared by Back Office editor, kiosk surface, and online-ordering surface.
//
// Data shape stored on locations.opening_hours (jsonb):
//   {
//     weekly: {
//       mon: [{ open: "09:00", close: "17:00" }, ...],
//       tue: [...], wed: [...], thu: [...], fri: [...], sat: [...], sun: [...]
//     },
//     closedDates: ["2026-12-25", "2026-12-26", ...]   // YYYY-MM-DD in location TZ
//   }
//
// Multi-window per day supports lunch + dinner with a break (e.g. 11:30-15:00
// then 17:00-22:00). Empty array on a day = closed all day. Overnight windows
// (close <= open, e.g. late bar 22:00→02:00) are valid and treated as
// continuing into the next day.

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

// Default empty schedule used when a location has no opening_hours set.
export function emptyOpeningHours() {
  return {
    weekly: { sun:[], mon:[], tue:[], wed:[], thu:[], fri:[], sat:[] },
    closedDates: [],
  };
}

// Sensible default for a typical restaurant — open 11:30-22:00 every day.
export function defaultOpeningHours() {
  const window = [{ open: '11:30', close: '22:00' }];
  return {
    weekly: { sun:window, mon:window, tue:window, wed:window, thu:window, fri:window, sat:window },
    closedDates: [],
  };
}

// Return components in the location's timezone — works around JS Date being
// always-local. Uses the toLocaleString trick which is reliable across
// engines despite being slightly indirect.
function partsInTZ(date, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone, year:'numeric', month:'2-digit', day:'2-digit',
    weekday:'short', hour:'2-digit', minute:'2-digit', hour12:false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map(p => [p.type, p.value]));
  return {
    y: Number(parts.year),
    m: Number(parts.month),
    d: Number(parts.day),
    weekday: (parts.weekday || '').toLowerCase().slice(0, 3), // mon, tue, ...
    hh: Number(parts.hour),
    mm: Number(parts.minute),
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
    isoDate: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

function parseHHMM(s) {
  if (!s || typeof s !== 'string') return null;
  const [h, m] = s.split(':').map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
}

// Is `now` (a Date) inside any open window for the location's hours / tz?
// Returns { open, currentWindow, closesAt } so callers can show "Closes in 45 min".
export function isOpenNow(hours, timeZone = 'Europe/London', now = new Date()) {
  if (!hours?.weekly) return { open: false };
  const today = partsInTZ(now, timeZone);
  // Closed-date override — closed all day regardless of weekly schedule.
  if (Array.isArray(hours.closedDates) && hours.closedDates.includes(today.isoDate)) {
    return { open: false, reason: 'closed_date', closedDate: today.isoDate };
  }
  const todayWindows = hours.weekly[today.weekday] || [];
  for (const w of todayWindows) {
    const o = parseHHMM(w.open);
    const c = parseHHMM(w.close);
    if (o == null || c == null) continue;
    if (c > o) {
      // Same-day window
      if (today.minutes >= o && today.minutes < c) {
        return { open: true, opensAt: o, closesAtMinutes: c, window: w };
      }
    } else {
      // Overnight window (e.g. 22:00→02:00). Open if minutes >= open OR
      // we already crossed midnight and minutes < close.
      if (today.minutes >= o) {
        return { open: true, opensAt: o, closesAtMinutes: c + 24*60, window: w, overnight: true };
      }
    }
  }
  // Also check whether yesterday's overnight window is still active.
  const yesterday = partsInTZ(new Date(now.getTime() - 24*60*60*1000), timeZone);
  const yesterdayWindows = hours.weekly[yesterday.weekday] || [];
  for (const w of yesterdayWindows) {
    const o = parseHHMM(w.open);
    const c = parseHHMM(w.close);
    if (o == null || c == null || c > o) continue;
    if (today.minutes < c) {
      return { open: true, fromYesterday: true, closesAtMinutes: c, window: w };
    }
  }
  return { open: false };
}

// When does the location next open after `now`? Returns a Date in UTC, or
// null if the schedule is entirely empty for the lookahead window.
export function nextOpensAt(hours, timeZone = 'Europe/London', now = new Date(), lookaheadDays = 14) {
  if (!hours?.weekly) return null;
  // Walk day by day from "now" up to lookahead days. For each day, check
  // every window — return the first window-open that's strictly after now.
  for (let i = 0; i < lookaheadDays; i++) {
    const probe = new Date(now.getTime() + i * 24*60*60*1000);
    const parts = partsInTZ(probe, timeZone);
    if (Array.isArray(hours.closedDates) && hours.closedDates.includes(parts.isoDate)) continue;
    const dayWindows = hours.weekly[parts.weekday] || [];
    for (const w of dayWindows) {
      const o = parseHHMM(w.open);
      if (o == null) continue;
      // Only same-or-later minutes today; on subsequent days, every minute counts.
      if (i === 0 && o <= parts.minutes) continue;
      return resolveLocalDateTime(parts.isoDate, o, timeZone);
    }
  }
  return null;
}

// All open windows on a given calendar day (in the location's tz).
// Used by the online-ordering "pick a slot" picker.
export function getDayWindows(hours, timeZone = 'Europe/London', date = new Date()) {
  if (!hours?.weekly) return [];
  const parts = partsInTZ(date, timeZone);
  if (Array.isArray(hours.closedDates) && hours.closedDates.includes(parts.isoDate)) return [];
  return hours.weekly[parts.weekday] || [];
}

// Short human-readable summary: "Mon-Fri 9-5, Sat 10-9, Sun closed".
// Groups consecutive days that share the same window pattern.
export function formatHoursPreview(hours) {
  if (!hours?.weekly) return 'Hours not set';
  const order = ['mon','tue','wed','thu','fri','sat','sun'];
  const labels = { mon:'Mon', tue:'Tue', wed:'Wed', thu:'Thu', fri:'Fri', sat:'Sat', sun:'Sun' };
  const sig = (windows) => Array.isArray(windows) && windows.length === 0
    ? 'closed'
    : (windows || []).map(w => `${w.open}-${w.close}`).join(',');

  const groups = [];
  let cur = null;
  for (const d of order) {
    const s = sig(hours.weekly[d]);
    if (cur && cur.s === s) { cur.end = d; continue; }
    cur = { s, start: d, end: d };
    groups.push(cur);
  }
  return groups.map(g => {
    const range = g.start === g.end ? labels[g.start] : `${labels[g.start]}-${labels[g.end]}`;
    return `${range} ${g.s === 'closed' ? 'closed' : g.s.replace(/,/g, ' & ').replace(/-/g, '–')}`;
  }).join(', ');
}

// Build a UTC Date from a YYYY-MM-DD + minutes-since-midnight + tz.
// Trick: we form a local-time string in the target tz, parse it, then
// adjust by tz offset. JS doesn't have direct support for this so we
// iterate-once via the parts trick.
function resolveLocalDateTime(isoDate, minutes, timeZone) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const hh = Math.floor(minutes / 60);
  const mm = minutes % 60;
  // Build a tentative UTC date and then read its tz parts back to compute
  // the offset, so we can correct.
  const guess = new Date(Date.UTC(y, m - 1, d, hh, mm));
  const seen = partsInTZ(guess, timeZone);
  // Difference between what we wanted and what we got, in minutes.
  const wantedMinutes = hh * 60 + mm;
  const seenMinutes = seen.hh * 60 + seen.mm;
  let delta = wantedMinutes - seenMinutes;
  // Day rollovers — clamp delta into a sensible range.
  if (delta > 12 * 60)  delta -= 24 * 60;
  if (delta < -12 * 60) delta += 24 * 60;
  return new Date(guess.getTime() + delta * 60 * 1000);
}

// Convenience: format "Closed — opens Tue at 9:00 AM" style banner text.
export function closedBannerText(hours, timeZone = 'Europe/London', now = new Date()) {
  const next = nextOpensAt(hours, timeZone, now);
  if (!next) return "We're closed right now. Hours haven't been set.";
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone, weekday: 'long', hour: 'numeric', minute: '2-digit', hour12: true,
  });
  // If "next" is on the same calendar day in the tz, just show time.
  const nowParts = partsInTZ(now, timeZone);
  const nextParts = partsInTZ(next, timeZone);
  if (nowParts.isoDate === nextParts.isoDate) {
    return `We're closed. Opens today at ${fmt.format(next).split(', ').slice(-1)[0]}.`;
  }
  return `We're closed. Opens ${fmt.format(next).replace(',', ' at')}.`;
}

export const _DAY_KEYS = DAY_KEYS;
