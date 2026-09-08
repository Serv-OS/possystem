// src/staff/wfWeek.js
//
// Current-week model for the rota (Mon→Sun), date-based. Replaces the static
// seed week so shifts persist against real calendar dates (wf_shifts.shift_date).
// All dates are local-formatted YYYY-MM-DD (no UTC shift).

const LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** Local YYYY-MM-DD (avoids the toISOString UTC off-by-one). */
export function ymd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Monday of the week containing `ref`. */
export function weekStartOf(ref = new Date()) {
  const d = new Date(ref);
  d.setHours(0, 0, 0, 0);
  const dow = d.getDay();                 // 0=Sun … 6=Sat
  d.setDate(d.getDate() + (dow === 0 ? -6 : 1 - dow));
  return d;
}

/** Build a 7-day week descriptor from a Monday (or the current week). */
export function buildWeek(startDate) {
  const start = startDate ? new Date(startDate) : weekStartOf();
  start.setHours(0, 0, 0, 0);
  const todayIso = ymd(new Date());
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    const iso = ymd(d);
    return { iso, label: LABELS[i], dom: String(d.getDate()), isToday: iso === todayIso };
  });
  return { startIso: ymd(start), endIso: days[6].iso, days, todayIdx: days.findIndex(x => x.isToday) };
}

/** Shift a week by ±n weeks (returns a fresh descriptor). */
export function addWeeks(startIso, n) {
  const d = new Date(startIso + 'T00:00:00');
  d.setDate(d.getDate() + n * 7);
  return buildWeek(d);
}

/**
 * Pay period containing `ref`, from the venue's pay settings:
 *   monthly                       — runs startDay → (startDay−1) next month,
 *                                   e.g. 26 → 26th–25th; payDay = day-of-month
 *                                   wages land (0 = last day of the month).
 *   weekly|fortnightly|fourweekly — fixed-length periods rolled forward from
 *                                   payPeriodAnchor (the FIRST period's start,
 *                                   e.g. Fri 12 Jun → 12–25 Jun, 26 Jun–9 Jul…);
 *                                   payDay = days after the period ends.
 * Accepts a settings object; a bare number is treated as a legacy monthly
 * startDay. Returns { startIso, endIso, payDateIso, label }.
 */
const PERIOD_LEN = { weekly: 7, fortnightly: 14, fourweekly: 28 };
const fmtD = x => x.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

// ── Working days (England & Wales) ──────────────────────────────────────────
// For "paid on the last working day". Scotland (2 Jan, St Andrew's Day) and
// Northern Ireland (St Patrick's Day, Battle of the Boyne) differ — this is the
// England & Wales set and the Settings screen says so rather than implying UK-wide.

/** Easter Sunday for a Gregorian year (Anonymous Gregorian algorithm). */
function easterSunday(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  return new Date(y, Math.floor((h + l - 7 * m + 114) / 31) - 1, ((h + l - 7 * m + 114) % 31) + 1);
}

/** Nth (or last, n = -1) weekday `dow` of a month. */
function nthDow(y, month, dow, n) {
  if (n === -1) {
    const d = new Date(y, month + 1, 0);            // last day of the month
    d.setDate(d.getDate() - ((d.getDay() - dow + 7) % 7));
    return d;
  }
  const d = new Date(y, month, 1);
  d.setDate(1 + ((dow - d.getDay() + 7) % 7) + (n - 1) * 7);
  return d;
}

const _holidays = new Map();
/** England & Wales bank holidays for a year, as a Set of YYYY-MM-DD. */
function bankHolidays(year) {
  if (_holidays.has(year)) return _holidays.get(year);
  const easter = easterSunday(year);
  const rel = n => { const d = new Date(easter); d.setDate(easter.getDate() + n); return d; };
  const set = new Set([
    rel(-2),                          // Good Friday
    rel(1),                           // Easter Monday
    nthDow(year, 4, 1, 1),            // first Monday in May
    nthDow(year, 4, 1, -1),           // last Monday in May
    nthDow(year, 7, 1, -1),           // last Monday in August
  ].map(ymd));
  // Fixed dates get a substitute weekday when they land on a weekend; the
  // substitute is the next weekday not already taken (so 25/26 Dec on a
  // Sat/Sun become Mon 27 + Tue 28, which is the actual rule).
  [new Date(year, 0, 1), new Date(year, 11, 25), new Date(year, 11, 26)].forEach(d => {
    const s = new Date(d);
    while (s.getDay() === 0 || s.getDay() === 6 || set.has(ymd(s))) s.setDate(s.getDate() + 1);
    set.add(ymd(s));
  });
  _holidays.set(year, set);
  return set;
}

/** `d`, or the nearest working day before it (weekends + bank holidays skipped). */
export function prevWorkingDay(d) {
  const out = new Date(d);
  for (let i = 0; i < 21; i++) {                    // longest real run of non-working days is ~4
    const dow = out.getDay();
    if (dow !== 0 && dow !== 6 && !bankHolidays(out.getFullYear()).has(ymd(out))) return out;
    out.setDate(out.getDate() - 1);
  }
  return out;
}

export function payPeriod(cfg = {}, ref = new Date()) {
  if (typeof cfg === 'number' || typeof cfg === 'string') cfg = { payPeriodType: 'monthly', payPeriodStartDay: cfg };
  const type = cfg.payPeriodType || 'monthly';
  const d = new Date(ref); d.setHours(0, 0, 0, 0);

  const len = PERIOD_LEN[type];
  if (len && cfg.payPeriodAnchor) {
    const anchor = new Date(cfg.payPeriodAnchor + 'T00:00:00');
    const k = Math.floor(Math.round((d - anchor) / 86400000) / len);
    const start = new Date(anchor); start.setDate(anchor.getDate() + k * len);
    const end = new Date(start); end.setDate(start.getDate() + len - 1);
    let payDate = new Date(end); payDate.setDate(end.getDate() + Math.max(0, Number(cfg.payDay) || 0));
    if (cfg.payDayShift === 'prevWorkingDay') payDate = prevWorkingDay(payDate);
    return { startIso: ymd(start), endIso: ymd(end), payDateIso: ymd(payDate), label: `${fmtD(start)} – ${fmtD(end)}` };
  }

  // monthly (default — also the fallback when no anchor has been set yet)
  const sd = Math.min(28, Math.max(1, Number(cfg.payPeriodStartDay) || 1));
  let start = new Date(d.getFullYear(), d.getMonth(), sd);
  if (d.getDate() < sd) start = new Date(d.getFullYear(), d.getMonth() - 1, sd);
  const end = new Date(start.getFullYear(), start.getMonth() + 1, sd);
  end.setDate(end.getDate() - 1); // day before the next period starts
  // Pay day = that day-of-month (0 → last day) in the month the period ENDS,
  // plus an optional whole-month offset. Unset → assume paid on the period end.
  //
  // v5.5.989 — this used to resolve off the month the period STARTS, which is
  // identical for a 1st–31st period (start month == end month) but wrong for
  // every late-start period: a 23 Jul–22 Aug period with "paid on the last day"
  // resolved to 31 JULY, nine days before the period even closed. The end month
  // is the pay run the period belongs to.
  let payDate = end;
  if (cfg.payDay != null && cfg.payDay !== '') {
    const pd = Number(cfg.payDay);
    const base = new Date(end.getFullYear(), end.getMonth() + (Number(cfg.payDayMonthOffset) || 0), 1);
    const at = m => pd === 0
      ? new Date(base.getFullYear(), m + 1, 0)                                  // last day of month m
      : new Date(base.getFullYear(), m, Math.min(28, Math.max(1, pd)));
    payDate = at(base.getMonth());
    if (payDate < start) payDate = at(base.getMonth() + 1);                     // never before the period opens
  }
  if (cfg.payDayShift === 'prevWorkingDay') payDate = prevWorkingDay(payDate);
  return { startIso: ymd(start), endIso: ymd(end), payDateIso: ymd(payDate), label: `${fmtD(start)} – ${fmtD(end)}` };
}

/** Build a payPeriod() config from a venue settings row. The two working-day
 *  knobs live in the `settings` jsonb bag (same home as COGS%/overhead) rather
 *  than as their own columns. One builder so Timesheets, Payroll and the
 *  Settings preview can never disagree about which period payroll runs on. */
export function payCfgFrom(settings) {
  const bag = settings?.settings || {};
  return {
    payPeriodType: settings?.payPeriodType || 'monthly',
    payPeriodStartDay: settings?.payPeriodStartDay ?? 1,
    payPeriodAnchor: settings?.payPeriodAnchor || null,
    payDay: settings?.payDay ?? null,
    payDayMonthOffset: Number(bag.payDayMonthOffset) || 0,
    payDayShift: bag.payDayShift || 'none',
  };
}

/** Shift a pay period by ±n periods (calendar months or fixed lengths). */
export function shiftPayPeriod(cfg, currentStartIso, n) {
  if (typeof cfg === 'number' || typeof cfg === 'string') cfg = { payPeriodType: 'monthly', payPeriodStartDay: cfg };
  const d = new Date(currentStartIso + 'T00:00:00');
  const len = PERIOD_LEN[cfg?.payPeriodType || 'monthly'];
  if (len && cfg?.payPeriodAnchor) d.setDate(d.getDate() + n * len);
  else d.setMonth(d.getMonth() + n);
  return payPeriod(cfg, d);
}

/** Human label e.g. "9–15 Jun". */
export function weekRangeLabel(week) {
  const a = new Date(week.startIso + 'T00:00:00');
  const b = new Date(week.endIso + 'T00:00:00');
  const mon = d => d.toLocaleDateString('en-GB', { month: 'short' });
  return a.getMonth() === b.getMonth()
    ? `${a.getDate()}–${b.getDate()} ${mon(b)}`
    : `${a.getDate()} ${mon(a)} – ${b.getDate()} ${mon(b)}`;
}
