/**
 * _shared/venueDate.js: the VENUE's calendar, in words a UK venue reads. Pure: no I/O, no
 * imports, so Node's test runner loads it (src/lib/venueDate.test.js), the edge functions
 * import it under Deno (po-send) and src/lib/venueDate.js re-exports it for the browser.
 *
 * v5.11.65 (15 Oct 2026 stock audit). Every stock screen formatted dates with the browser's
 * locale and clock: counts were named "Count 10/15/2026" from a US laptop, timestamps sat
 * eight hours out, the Orders list and the Ops tablet printed the raw database string
 * "due 2026-10-16", and the supplier email said "requested delivery 2026-10-16". One helper
 * here, en-GB wording, the venue's timezone, used by all of them.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const YMD = /^(\d{4})-(\d{2})-(\d{2})/;
const DEFAULT_TZ = 'Europe/London';

const toDate = (ts) => {
  if (ts instanceof Date) return Number.isNaN(ts.getTime()) ? null : ts;
  if (ts == null || ts === '') return null;
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** The parts of an instant on the venue's wall clock: { y, m, d, hh, mm, dow } (dow 0 = Sun). */
export function partsInZone(ts, tz) {
  const d = toDate(ts);
  if (!d) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz || DEFAULT_TZ, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(d);
    const get = (t) => parts.find((p) => p.type === t)?.value;
    let hh = parseInt(get('hour'), 10);
    if (hh === 24) hh = 0;   // some runtimes emit "24" at midnight
    return {
      y: Number(get('year')), m: Number(get('month')), d: Number(get('day')),
      hh, mm: parseInt(get('minute'), 10), dow: DAYS.indexOf(get('weekday')),
    };
  } catch {
    return { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate(), hh: d.getHours(), mm: d.getMinutes(), dow: d.getDay() };
  }
}

/** The venue calendar day an instant falls on, 'YYYY-MM-DD'. */
export function ymdInZone(ts, tz) {
  const p = partsInZone(ts, tz);
  if (!p) return null;
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

/** A plain calendar day shifted by n days (no clock involved). */
export function addDaysYmd(ymd, n) {
  const m = YMD.exec(String(ymd || ''));
  if (!m) return null;
  const t = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + (Number(n) || 0)));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
}

/** The venue day n days before `now` (today when n is 0). */
export function daysAgoYmd(n, tz, now = new Date()) {
  const today = ymdInZone(now, tz);
  return today ? addDaysYmd(today, -(Number(n) || 0)) : null;
}

/**
 * A plain date 'YYYY-MM-DD' in words: '16 Oct 2026', or 'Thu 16 Oct 2026' with the weekday.
 * No clock is read, so the day never shifts whatever timezone the screen is in. Anything that
 * is not a plain date comes back unchanged (never an empty cell for a value that was there).
 */
export function fmtYmd(ymd, { weekday = false, year = true } = {}) {
  const m = YMD.exec(String(ymd || ''));
  if (!m) return ymd == null ? '' : String(ymd);
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  if (mo < 1 || mo > 12) return String(ymd);
  const dow = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
  const core = `${d} ${MONTHS[mo - 1]}${year ? ` ${y}` : ''}`;
  return weekday ? `${DAYS[dow]} ${core}` : core;
}

/** An instant as the venue's date: '16 Oct 2026'. '' for nothing. */
export function fmtVenueDate(ts, tz, opts = {}) {
  const ymd = ymdInZone(ts, tz);
  return ymd ? fmtYmd(ymd, opts) : '';
}

/** An instant as the venue's date and time: '16 Oct 2026 14:05'. '' for nothing. */
export function fmtVenueDateTime(ts, tz, opts = {}) {
  const p = partsInZone(ts, tz);
  if (!p) return '';
  const ymd = `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
  return `${fmtYmd(ymd, opts)} ${String(p.hh).padStart(2, '0')}:${String(p.mm).padStart(2, '0')}`;
}

/** The venue's wall clock time of an instant: '14:05'. */
export function fmtVenueTime(ts, tz) {
  const p = partsInZone(ts, tz);
  return p ? `${String(p.hh).padStart(2, '0')}:${String(p.mm).padStart(2, '0')}` : '';
}

const TYPE_WORD = { FULL: 'Full', SPOT: 'Spot check', AREA: 'By area', SUPPLIER: 'By supplier' };
/** The name a new stock count is born with: 'Count 15 Oct 2026 · Full' (the venue's day). */
export function countName(ts, tz, countType = 'FULL', storageArea = null) {
  const day = fmtVenueDate(ts, tz) || fmtYmd(String(ts || ''));
  const kind = storageArea ? String(storageArea) : (TYPE_WORD[String(countType || 'FULL').toUpperCase()] || 'Full');
  return `Count ${day} · ${kind}`;
}

/**
 * The instant (epoch ms) of a venue wall clock time: 'YYYY-MM-DD' at 'HH:MM' in tz. DST
 * correct: a guess in UTC is read back in the zone and corrected by the difference. Null for
 * a bad date or time.
 */
export function localToUtcMs(ymd, hhmm, tz) {
  const m = YMD.exec(String(ymd || ''));
  const t = /^(\d{1,2}):(\d{2})/.exec(String(hhmm || ''));
  if (!m || !t) return null;
  const hh = Number(t[1]), mm = Number(t[2]);
  if (hh > 23 || mm > 59) return null;
  const guess = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), hh, mm));
  const seen = partsInZone(guess, tz);
  if (!seen) return null;
  // minutes from the start of the guessed day to what the zone showed, signed, so a
  // day rollover either way still gives the right correction
  const wanted = hh * 60 + mm;
  const dayShift = (Date.UTC(seen.y, seen.m - 1, seen.d) - Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) / 60000;
  const got = dayShift + seen.hh * 60 + seen.mm;
  return guess.getTime() + (wanted - got) * 60000;
}

/**
 * A report range on the venue's business day: from the start of business on `fromYmd` to
 * the start of business on the day after `toYmd`, as ISO instants. businessDayStart is the
 * venue's 'HH:MM' (06:00 by default), so a sale at 01:00 belongs to the day before.
 */
export function venueRangeIso(fromYmd, toYmd, tz, businessDayStart = '06:00') {
  const start = /^\d{1,2}:\d{2}/.test(String(businessDayStart || '')) ? businessDayStart : '00:00';
  const a = localToUtcMs(fromYmd, start, tz);
  const b = localToUtcMs(addDaysYmd(toYmd, 1), start, tz);
  if (a == null || b == null) return null;
  return { fromIso: new Date(a).toISOString(), toIso: new Date(b).toISOString() };
}
