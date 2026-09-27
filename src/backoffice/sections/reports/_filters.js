// v4.6.15: Period computation, check filters, and compare-period math.
// v4.6.24: Business-day-start + service-period support for reports.
// v5.10.2: every period is built on the VENUE's clock (config.timezone + businessDayStart),
//          never the browser's. Until then a manager in California looking at a London
//          venue got "Yesterday" = 06:30 to 06:29 Pacific, i.e. 14:30 to 14:29 London.
//          The day maths is the accounting layer's (supabase/functions/_shared/businessDay.js),
//          so the reports and the Xero day agree and DST nights come out right.
//
// Used by every report in the reporting suite.

import {
  venueZone, businessDayOf, businessDayStartMs, wallTimeToInstant, addDays, isYmd,
} from '../../../../supabase/functions/_shared/businessDay.js';

export const PERIODS = [
  { id:'today',      label:'Today'        },
  { id:'yesterday',  label:'Yesterday'    },
  { id:'this-week',  label:'This week'    },
  { id:'last-week',  label:'Last week'    },
  { id:'this-month', label:'This month'   },
  { id:'last-month', label:'Last month'   },
  { id:'last-7',     label:'Last 7 days'  },
  { id:'last-30',    label:'Last 30 days' },
  { id:'custom',     label:'Custom'       },
];

// v4.6.24: Build the filter row pills given the location config. Injects one
// pill per configured service period BEFORE the static list — most specific
// choices appear first. If config.shifts is empty, returns just PERIODS.
export function buildPeriods(config) {
  const shifts = config?.shifts || [];
  if (!shifts.length) return PERIODS;
  const serviceToday = shifts
    .filter(s => s.name && s.start && s.end)
    .map(s => ({
      id: `service:today:${s.id || s.name}`,
      label: `Today's ${s.name}`,
      isService: true,
      shift: s,
    }));
  return [...serviceToday, ...PERIODS];
}

// 'HH:MM' (or 'HH:MM:SS') to minutes after midnight; null when it is not a time.
function clockMinutes(hhmm) {
  const m = /^\s*(\d{1,2}):(\d{2})(?::\d{2})?\s*$/.exec(String(hhmm ?? ''));
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

// 0 = Monday … 6 = Sunday, for a calendar date (no clock involved).
function mondayIndex(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

// A calendar date as words, whatever the browser's zone ('2026-09-27' is Sun 27 Sep everywhere).
function dayText(ymd, opts) {
  if (!isYmd(ymd)) return '';
  return new Date(`${ymd}T12:00:00Z`).toLocaleDateString('en-GB', { ...opts, timeZone: 'UTC' });
}

// Returns { from, to, prevFrom, prevTo, fromDay, toDay, timeZone }. from/to are real instants
// (to is inclusive, the last ms before the next day starts); prev period is same length,
// immediately preceding. fromDay/toDay are the venue business days the range covers
// ('YYYY-MM-DD'): pass THOSE to anything that asks for dates, never format from/to.
// config = { businessDayStart: 'HH:MM', shifts: [{id,name,start,end}], timezone }
// (getLocationConfig). No timezone = Europe/London, the venue default, never the browser's
// zone. No businessDayStart = days start at the venue's midnight. nowMs is for tests.
export function getPeriodRange(periodId, custom, config = {}, nowMs = Date.now()) {
  const tz = venueZone(config?.timezone);
  const bds = config?.businessDayStart || '00:00';
  const today = businessDayOf(nowMs, tz, bds);
  const dayStart = (ymd) => businessDayStartMs(ymd, tz, bds);
  const withPrev = (fromMs, toMs, extra) => {
    const lengthMs = toMs - fromMs;
    const prevTo   = new Date(fromMs - 1);
    const prevFrom = new Date(prevTo.getTime() - lengthMs);
    return { from: new Date(fromMs), to: new Date(toMs), prevFrom, prevTo, timeZone: tz, ...extra };
  };
  // Whole business days fromDay..toDay (inclusive).
  const days = (fromDay, toDay) =>
    withPrev(dayStart(fromDay), dayStart(addDays(toDay, 1)) - 1, { fromDay, toDay });

  // Service-period range: pick today's instance of a named service, on the venue's wall clock.
  if (typeof periodId === 'string' && periodId.startsWith('service:today:')) {
    const key = periodId.slice('service:today:'.length);
    const shifts = config?.shifts || [];
    const shift  = shifts.find(s => s.id === key || s.name === key);
    const sMin = clockMinutes(shift?.start);
    const eMin = clockMinutes(shift?.end);
    if (shift && sMin != null && eMin != null) {
      let day = today;
      let from = wallTimeToInstant(day, sMin, tz);
      if (from > nowMs) {
        day = addDays(day, -1);
        from = wallTimeToInstant(day, sMin, tz);
      }
      // The end minute is included (15:00 means up to 15:00:59.999), as before.
      let to = wallTimeToInstant(day, eMin, tz) + 59999;
      if (to <= from) to = wallTimeToInstant(addDays(day, 1), eMin, tz) + 59999;
      return withPrev(from, to, { fromDay: day, toDay: day, kind:'service', shiftName: shift.name });
    }
  }

  // Custom dates are venue business days too, so "27 Sep" matches Yesterday on the 28th.
  const customDay = (v) => (isYmd(v) ? v : v ? businessDayOf(v, tz, bds) : null);

  switch (periodId) {
    case 'today':
      return days(today, today);
    case 'yesterday': {
      const y = addDays(today, -1);
      return days(y, y);
    }
    case 'this-week':
      return days(addDays(today, -mondayIndex(today)), today);
    case 'last-week': {
      const monday = addDays(today, -mondayIndex(today) - 7);
      return days(monday, addDays(monday, 6));
    }
    case 'this-month':
      return days(`${today.slice(0, 7)}-01`, today);
    case 'last-month': {
      const lastDay = addDays(`${today.slice(0, 7)}-01`, -1);
      return days(`${lastDay.slice(0, 7)}-01`, lastDay);
    }
    case 'last-7':
      return days(addDays(today, -6), today);
    case 'last-30':
      return days(addDays(today, -29), today);
    case 'custom':
      return days(customDay(custom?.from) || today, customDay(custom?.to) || today);
    default:
      return days(today, today);
  }
}

// The header text for a range, in the VENUE's dates and times (range from getPeriodRange).
export function periodLabel(periodId, custom, range) {
  if (typeof periodId === 'string' && periodId.startsWith('service:today:')) {
    if (!range) return '';
    const tz = venueZone(range.timeZone);
    const fmtTime = (d) => d.toLocaleTimeString('en-GB', { timeZone: tz, hour:'2-digit', minute:'2-digit' });
    return `${dayText(range.fromDay, { weekday:'short', day:'numeric', month:'short' })} \u00b7 ${fmtTime(range.from)}\u2013${fmtTime(range.to)}`;
  }
  if (periodId === 'custom' && custom?.from && custom?.to) {
    return `${dayText(range?.fromDay ?? custom.from)} \u2192 ${dayText(range?.toDay ?? custom.to)}`;
  }
  if (!range) return '';
  return range.fromDay === range.toDay
    ? dayText(range.fromDay, { weekday:'short', day:'numeric', month:'short' })
    : `${dayText(range.fromDay, { day:'numeric', month:'short' })} \u2192 ${dayText(range.toDay, { day:'numeric', month:'short' })}`;
}

// Apply server + order type + source filters (global filters live on the shell).
// v5.5.140: source filter — pos / kiosk / online / qr — for cross-channel report slicing.
export function applyFilters(checks, filters) {
  return (checks||[]).filter(c => {
    if (filters?.server    && filters.server    !== 'all' && (c.server || '') !== filters.server)        return false;
    if (filters?.orderType && filters.orderType !== 'all' && (c.orderType || 'dine-in') !== filters.orderType) return false;
    if (filters?.source    && filters.source    !== 'all' && (c.source || 'pos') !== filters.source)     return false;
    return true;
  });
}

// Signed percent change. Null when there's no prior data to compare.
export function pctDelta(current, previous) {
  if (!previous || !isFinite(previous) || previous === 0) return null;
  return ((current - previous) / Math.abs(previous)) * 100;
}

export function uniqueServers(checks) {
  const set = new Set();
  (checks||[]).forEach(c => { if (c.server) set.add(c.server); });
  return [...set].sort();
}

export function uniqueOrderTypes(checks) {
  const set = new Set();
  (checks||[]).forEach(c => set.add(c.orderType || 'dine-in'));
  return [...set].sort();
}

// v5.5.140: collect distinct order sources present in the data so the BO
// reports filter dropdown only shows options that exist (e.g. don't render
// "Online" if the venue has never had an online order). Returns sorted.
export function uniqueSources(checks) {
  const set = new Set();
  (checks||[]).forEach(c => set.add(c.source || 'pos'));
  return [...set].sort();
}

// v5.5.140: pretty labels + emoji for the source filter pills. Falls back to
// title-case of the raw value for unknown sources.
export const SOURCE_LABEL = {
  pos:      '🧾 POS',
  mpos:     '📲 Mobile POS',
  kiosk:    '📟 Kiosk',
  online:   '🌐 Online',
  qr:       '📱 QR Code',
  catering: '🍽 Catering',
  delivery: '🛵 Delivery',
  hubrise:  '🛵 Delivery apps',
};

// v4.6.24: Classify a check timestamp into one of the configured service
// periods. Returns the shift object (or null for "outside any service").
// Honors overnight services where end < start (e.g. late bar 22:00-02:00).
export function classifyShift(timestamp, shifts, businessDayStart = '00:00') {
  if (!timestamp || !shifts?.length) return null;
  const d = new Date(timestamp);
  const minutes = d.getHours() * 60 + d.getMinutes();
  for (const s of shifts) {
    if (!s.start || !s.end) continue;
    const [sh, sm] = s.start.split(':').map(Number);
    const [eh, em] = s.end.split(':').map(Number);
    const start = sh * 60 + sm;
    const end   = eh * 60 + em;
    const inside = end > start
      ? (minutes >= start && minutes < end)
      : (minutes >= start || minutes < end);
    if (inside) return s;
  }
  return null;
}
