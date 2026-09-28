// v4.6.15: Period computation, check filters, and compare-period math.
// v4.6.24: Business-day-start + service-period support for reports.
// v5.10.2: every period is built on the VENUE's clock (config.timezone + businessDayStart),
//          never the browser's. Until then a manager in California looking at a London
//          venue got "Yesterday" = 06:30 to 06:29 Pacific, i.e. 14:30 to 14:29 London.
//          The day maths is the accounting layer's (supabase/functions/_shared/businessDay.js),
//          so the reports and the Xero day agree and DST nights come out right.
//
// v5.10.3: and every BUCKET a sale is counted in (its day, its service, its hour on the
//          Daypart grid) is read on the venue's clock too: classifyShift, dayOfCheck,
//          rangeDays, daypartGrid, groupChecksByDay/ByService. The day or service a sale
//          belongs to is business time (venue zone + business_day_start), never the browser.
//
// v5.11.x: and the rest: mixSeries (Order types, Order sources), daySlot (Product mix),
//          workedTime (Servers, Tips), sumByVenueHour (Tips, KDS performance).
//
// Used by every report in the reporting suite.

import {
  venueZone, businessDayOf, businessDayStartMs, wallTimeToInstant, wallClock, addDays, isYmd,
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
export function dayText(ymd, opts) {
  if (!isYmd(ymd)) return '';
  return new Date(`${ymd}T12:00:00Z`).toLocaleDateString('en-GB', { ...opts, timeZone: 'UTC' });
}

// 0 = Sunday … 6 = Saturday, for a calendar date (no clock involved).
export function weekdayOf(ymd) {
  return (mondayIndex(ymd) + 1) % 7;
}

// The clock a venue's reports run on: { timeZone, dayStart } from its config
// (getLocationConfig). No timezone = Europe/London, never the browser's zone; no
// businessDayStart = the venue's midnight. A range from getPeriodRange has the same two
// keys, so either can be passed wherever a clock is asked for.
export function reportClock(config) {
  return { timeZone: venueZone(config?.timezone), dayStart: config?.businessDayStart || '00:00' };
}

// The venue business day ('YYYY-MM-DD') a check's instant belongs to; null when it has none.
export function dayOfCheck(ts, clock) {
  if (ts == null || ts === '') return null;
  return businessDayOf(ts, venueZone(clock?.timeZone), clock?.dayStart || '00:00');
}

// The hour (0 to 23) on the venue's wall clock at an instant; null when it is not one.
export function venueHour(ts, timeZone) {
  const ms = ts instanceof Date ? ts.getTime() : typeof ts === 'number' ? ts : Date.parse(ts);
  if (!Number.isFinite(ms)) return null;
  return Math.floor(wallClock(ms, timeZone).minutes / 60);
}

// Every business day of a range, fromDay..toDay inclusive: the day axis of a trend report.
export function rangeDays(range) {
  const out = [];
  if (!isYmd(range?.fromDay) || !isYmd(range?.toDay)) return out;
  for (let d = range.fromDay; d <= range.toDay && out.length < 3660; d = addDays(d, 1)) out.push(d);
  return out;
}

// The same number of business days immediately before the range: the compare axis.
export function prevRangeDays(range) {
  const days = rangeDays(range);
  return days.map((_, i) => addDays(range.fromDay, i - days.length));
}

// Instants of whole business days fromDay..toDay (to is the last ms before the next day).
function dayWindow(fromDay, toDay, tz, bds) {
  return [businessDayStartMs(fromDay, tz, bds), businessDayStartMs(addDays(toDay, 1), tz, bds) - 1];
}

// Instants of one service on `day`'s wall clock. The end minute is included (15:00 means
// up to 15:00:59.999), and a service that ends before it starts runs past midnight.
function serviceWindow(day, sMin, eMin, tz) {
  const from = wallTimeToInstant(day, sMin, tz);
  let to = wallTimeToInstant(day, eMin, tz) + 59999;
  if (to <= from) to = wallTimeToInstant(addDays(day, 1), eMin, tz) + 59999;
  return [from, to];
}

// Returns { from, to, prevFrom, prevTo, fromDay, toDay, timeZone, dayStart }. from/to are real instants
// (to is inclusive, the last ms before the next day starts); prev period is same length,
// immediately preceding. fromDay/toDay are the venue business days the range covers
// ('YYYY-MM-DD'): pass THOSE to anything that asks for dates, never format from/to.
// config = { businessDayStart: 'HH:MM', shifts: [{id,name,start,end}], timezone }
// (getLocationConfig). No timezone = Europe/London, the venue default, never the browser's
// zone. No businessDayStart = days start at the venue's midnight. nowMs is for tests.
export function getPeriodRange(periodId, custom, config = {}, nowMs = Date.now()) {
  const { timeZone: tz, dayStart: bds } = reportClock(config);
  const today = businessDayOf(nowMs, tz, bds);
  const withPrev = ([fromMs, toMs], extra) => {
    const lengthMs = toMs - fromMs;
    const prevTo   = new Date(fromMs - 1);
    const prevFrom = new Date(prevTo.getTime() - lengthMs);
    return { from: new Date(fromMs), to: new Date(toMs), prevFrom, prevTo, timeZone: tz, dayStart: bds, ...extra };
  };
  // Whole business days fromDay..toDay (inclusive).
  const days = (fromDay, toDay) => withPrev(dayWindow(fromDay, toDay, tz, bds), { fromDay, toDay });

  // Service-period range: pick today's instance of a named service, on the venue's wall clock.
  if (typeof periodId === 'string' && periodId.startsWith('service:today:')) {
    const key = periodId.slice('service:today:'.length);
    const shifts = config?.shifts || [];
    const shift  = shifts.find(s => s.id === key || s.name === key);
    const sMin = clockMinutes(shift?.start);
    const eMin = clockMinutes(shift?.end);
    if (shift && sMin != null && eMin != null) {
      let day = today;
      if (wallTimeToInstant(day, sMin, tz) > nowMs) day = addDays(day, -1);
      return withPrev(serviceWindow(day, sMin, eMin, tz), {
        fromDay: day, toDay: day, kind:'service', shiftName: shift.name, serviceStart: sMin, serviceEnd: eMin,
      });
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

// The same period read on ANOTHER venue's clock (config from getVenueClock): the same
// business days in that venue's own zone and day start, or for a service the same wall
// clock times on the same day there. Location compare reads every venue with it, so
// Leeds and Provo are each read over their own 27 Sep, never over the active venue's
// window. Returns { from, to, fromDay, toDay, timeZone, dayStart }, or null for no range.
export function venueRange(range, config) {
  if (!isYmd(range?.fromDay) || !isYmd(range?.toDay)) return null;
  const { timeZone, dayStart } = reportClock(config);
  const [from, to] = range.kind === 'service' && range.serviceStart != null && range.serviceEnd != null
    ? serviceWindow(range.fromDay, range.serviceStart, range.serviceEnd, timeZone)
    : dayWindow(range.fromDay, range.toDay, timeZone, dayStart);
  return { from: new Date(from), to: new Date(to), fromDay: range.fromDay, toDay: range.toDay, timeZone, dayStart };
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
// v5.10.3: on the VENUE's wall clock (timeZone = locationConfig.timezone; none = London).
// Until then it read the browser's getHours(), so Peter in California saw a London
// 12:30 lunch check as 04:30, outside every service. The business day start plays no
// part: a service is a wall clock window, whichever business day it falls in.
export function classifyShift(timestamp, shifts, timeZone) {
  if (!timestamp || !shifts?.length) return null;
  const ms = timestamp instanceof Date ? timestamp.getTime() : typeof timestamp === 'number' ? timestamp : Date.parse(timestamp);
  if (!Number.isFinite(ms)) return null;
  const minutes = wallClock(ms, timeZone).minutes;
  for (const s of shifts) {
    const start = clockMinutes(s?.start);
    const end   = clockMinutes(s?.end);
    if (start == null || end == null) continue;
    const inside = end > start
      ? (minutes >= start && minutes < end)
      : (minutes >= start || minutes < end);
    if (inside) return s;
  }
  return null;
}

// Daypart grid: revenue by weekday x hour, each check on the venue's clock. The hour is
// the venue's wall clock hour; the weekday is its BUSINESS day's, so with a 06:00 start a
// Saturday 01:30 sale counts in Friday's row at 1:00 (Friday night's trade).
// grid[dow][h] and byDow use Mon = 0. Voided checks do not count.
export function daypartGrid(checks, clock) {
  const grid   = Array.from({ length:7 }, () => Array(24).fill(0));
  const byHour = Array(24).fill(0);
  const byDow  = Array(7).fill(0);
  for (const c of checks || []) {
    if (c?.status === 'voided' || !c?.closedAt) continue;
    const day = dayOfCheck(c.closedAt, clock);
    const h   = venueHour(c.closedAt, clock?.timeZone);
    if (!day || h == null) continue;
    const dow = mondayIndex(day);
    const amt = c.total || 0;
    grid[dow][h] += amt;
    byHour[h]    += amt;
    byDow[dow]   += amt;
  }
  return { grid, byHour, byDow };
}

// Checks grouped by the business day they belong to, newest day first: [{ key, checks }].
export function groupChecksByDay(checks, clock) {
  const map = {};
  for (const c of checks || []) {
    const key = c?.closedAt ? dayOfCheck(c.closedAt, clock) : null;
    if (!key) continue;
    (map[key] ||= { key, checks: [] }).checks.push(c);
  }
  return Object.values(map).sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0));
}

// Checks grouped by (business day x service), newest day first and, within a day, the
// earliest service first: [{ key, dayKey, shift, checks }]. A check outside every service
// is left out (count those with classifyShift). A late bar check at 01:30 with a 06:00
// day start belongs to the previous business day's late bar.
export function groupChecksByService(checks, shifts, clock) {
  const map = {};
  for (const c of checks || []) {
    if (!c?.closedAt) continue;
    const shift = classifyShift(c.closedAt, shifts, clock?.timeZone);
    const dayKey = shift ? dayOfCheck(c.closedAt, clock) : null;
    if (!dayKey) continue;
    const key = `${dayKey}__${shift.id || shift.name}`;
    (map[key] ||= { key, dayKey, shift, checks: [] }).checks.push(c);
  }
  return Object.values(map).sort((a, b) => {
    if (a.dayKey !== b.dayKey) return a.dayKey < b.dayKey ? 1 : -1;
    return (a.shift.start || '') < (b.shift.start || '') ? -1 : 1;
  });
}

// v5.11.x: the rest of the reports onto the venue's clock (Order types, Order sources,
// Product mix, Servers, Tips, KDS performance, the Bookings chart's "today").

// A Date, an ISO string or epoch ms as epoch ms; null when it is not an instant.
function instantMs(ts) {
  if (ts == null || ts === '') return null;
  const ms = ts instanceof Date ? ts.getTime() : typeof ts === 'number' ? ts : Date.parse(ts);
  return Number.isFinite(ms) ? ms : null;
}

// Totals per hour of the venue's wall clock: out[h] (0 to 23) sums valueOf(row) over the
// rows whose instant, tsOf(row), falls in hour h there. A row with no instant is left out.
// Tips by hour, KDS bump times by hour.
export function sumByVenueHour(rows, tsOf, valueOf, timeZone) {
  const out = Array(24).fill(0);
  for (const r of rows || []) {
    const h = venueHour(instantMs(tsOf(r)), timeZone);
    if (h != null) out[h] += valueOf(r);
  }
  return out;
}

// The part of the day a sale was made in, on the venue's wall clock (Product mix): morning
// before 11:00, lunch to 15:00, afternoon to 17:00, dinner to 22:00, then late. No close
// time reads as 12:00, as it always has.
export function daySlot(ts, timeZone) {
  const h = venueHour(instantMs(ts), timeZone) ?? 12;
  return h < 11 ? 'morning' : h < 15 ? 'lunch' : h < 17 ? 'afternoon' : h < 22 ? 'dinner' : 'late';
}

// The time someone was seen working (Servers, Tips): first to last close on each business
// day, summed, and how many business days that is. A shift that runs past midnight is one
// day; the calendar split it in two and lost the time either side of midnight.
export function workedTime(closedAts, clock) {
  const spans = {};
  for (const ts of closedAts || []) {
    const ms = instantMs(ts);
    const day = ms == null ? null : dayOfCheck(ms, clock);
    if (!day) continue;
    const s = spans[day];
    if (!s) spans[day] = { first: ms, last: ms };
    else { s.first = Math.min(s.first, ms); s.last = Math.max(s.last, ms); }
  }
  const days = Object.values(spans);
  return { ms: days.reduce((t, s) => t + (s.last - s.first), 0), days: days.length };
}

// The time axis of a mix chart (Order types, Order sources). One bucket per venue business
// day; when every sale is on ONE business day, one per hour of the venue's wall clock, in
// the order the day runs (from the day start's hour, so a 01:30 late bar sale comes after
// 23:00, not before breakfast). A bucket is { key, total, [keyOf(check)]: revenue }; voided
// checks and checks with no close time are left out. Returns { series, xKeys, isHourly,
// types } (types = every keyOf seen). A day key is 'YYYY-MM-DD'; label it with dayText.
export function mixSeries(checks, keyOf, clock) {
  const live = [];
  for (const c of checks || []) {
    if (c?.status === 'voided' || !c?.closedAt) continue;
    const day = dayOfCheck(c.closedAt, clock);
    if (day) live.push({ c, day });
  }
  const isHourly = live.length > 0 && live.every(x => x.day === live[0].day);
  const series = {};
  const types = new Set();
  for (const { c, day } of live) {
    const key = isHourly ? String(venueHour(instantMs(c.closedAt), clock?.timeZone)) : day;
    const t = keyOf(c);
    types.add(t);
    const b = (series[key] ||= { key, total: 0 });
    b[t] = (b[t] || 0) + (c.total || 0);
    b.total += c.total || 0;
  }
  const startHour = Math.floor((clockMinutes(clock?.dayStart) ?? 0) / 60);
  const hourOfDay = (k) => (Number(k) - startHour + 24) % 24;
  const xKeys = Object.keys(series).sort((a, b) => (isHourly ? hourOfDay(a) - hourOfDay(b) : a < b ? -1 : a > b ? 1 : 0));
  return { series, xKeys, isHourly, types: [...types] };
}

// A mixSeries key as axis text: '13:00', or '27 Sep' (was new Date('2026-09-27') on the
// browser's clock, which reads 26 Sep anywhere west of London).
export function mixLabel(key, isHourly) {
  return isHourly ? `${key}:00` : dayText(key, { day:'numeric', month:'short' });
}
