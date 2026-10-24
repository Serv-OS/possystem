// src/staff/wfWeek.js
//
// Current-week model for the rota (Mon→Sun), date-based. Replaces the static
// seed week so shifts persist against real calendar dates (wf_shifts.shift_date).
// All dates are local-formatted YYYY-MM-DD (no UTC shift).

import { publicHolidays } from '../../supabase/functions/_shared/publicHolidays.js';

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
// v5.11.101: the calendar moved to supabase/functions/_shared/publicHolidays.js
// (the bank holiday pay premium reads the same one); the set is unchanged.
// v5.11.101: a US venue skips US federal holidays instead (cfg.country, from payCfgFrom).

/** `d`, or the nearest working day before it (weekends + public holidays of the country skipped). */
export function prevWorkingDay(d, country = 'UK') {
  const out = new Date(d);
  for (let i = 0; i < 21; i++) {                    // longest real run of non-working days is ~4
    const dow = out.getDay();
    if (dow !== 0 && dow !== 6 && !publicHolidays(country, out.getFullYear()).has(ymd(out))) return out;
    out.setDate(out.getDate() - 1);
  }
  return out;
}

export function payPeriod(cfg = {}, ref = new Date()) {
  if (typeof cfg === 'number' || typeof cfg === 'string') cfg = { payPeriodType: 'monthly', payPeriodStartDay: cfg };
  const type = cfg.payPeriodType || 'monthly';
  const d = new Date(ref); d.setHours(0, 0, 0, 0);

  // v5.11.101: semi-monthly (US): the 1st to the 15th, then the 16th to the last day of the
  // month. payDay = days after the period ends (as the fixed lengths), moved to the working day
  // before when the venue asks for it. No anchor needed: the calendar fixes both halves.
  if (type === 'semimonthly') {
    const first = d.getDate() <= 15;
    const start = new Date(d.getFullYear(), d.getMonth(), first ? 1 : 16);
    const end = first ? new Date(d.getFullYear(), d.getMonth(), 15) : new Date(d.getFullYear(), d.getMonth() + 1, 0);
    let payDate = new Date(end); payDate.setDate(end.getDate() + Math.max(0, Number(cfg.payDay) || 0));
    if (cfg.payDayShift === 'prevWorkingDay') payDate = prevWorkingDay(payDate, cfg.country || 'UK');
    return { startIso: ymd(start), endIso: ymd(end), payDateIso: ymd(payDate), label: `${fmtD(start)} – ${fmtD(end)}` };
  }

  const len = PERIOD_LEN[type];
  if (len && cfg.payPeriodAnchor) {
    const anchor = new Date(cfg.payPeriodAnchor + 'T00:00:00');
    const k = Math.floor(Math.round((d - anchor) / 86400000) / len);
    const start = new Date(anchor); start.setDate(anchor.getDate() + k * len);
    const end = new Date(start); end.setDate(start.getDate() + len - 1);
    let payDate = new Date(end); payDate.setDate(end.getDate() + Math.max(0, Number(cfg.payDay) || 0));
    if (cfg.payDayShift === 'prevWorkingDay') payDate = prevWorkingDay(payDate, cfg.country || 'UK');
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
  if (cfg.payDayShift === 'prevWorkingDay') payDate = prevWorkingDay(payDate, cfg.country || 'UK');
  return { startIso: ymd(start), endIso: ymd(end), payDateIso: ymd(payDate), label: `${fmtD(start)} – ${fmtD(end)}` };
}

/** Build a payPeriod() config from a venue settings row. The two working-day
 *  knobs live in the `settings` jsonb bag (same home as COGS%/overhead) rather
 *  than as their own columns. One builder so Timesheets, Payroll and the
 *  Settings preview can never disagree about which period payroll runs on. */
export function payCfgFrom(settings, country) {
  const bag = settings?.settings || {};
  return {
    // v5.11.101: whose public holidays "the previous working day" skips ('UK' when not given).
    ...(country ? { country } : {}),
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
  if (cfg?.payPeriodType === 'semimonthly') {
    // Half months: step from the period's start (the 1st or the 16th) by n halves.
    const half = d.getDate() >= 16 ? 1 : 0;
    const k = d.getMonth() * 2 + half + n;
    const month = Math.floor(k / 2), second = ((k % 2) + 2) % 2 === 1;
    return payPeriod(cfg, new Date(d.getFullYear(), month, second ? 16 : 1));
  }
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
