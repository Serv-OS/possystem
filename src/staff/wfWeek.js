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
    const payDate = new Date(end); payDate.setDate(end.getDate() + Math.max(0, Number(cfg.payDay) || 0));
    return { startIso: ymd(start), endIso: ymd(end), payDateIso: ymd(payDate), label: `${fmtD(start)} – ${fmtD(end)}` };
  }

  // monthly (default — also the fallback when no anchor has been set yet)
  const sd = Math.min(28, Math.max(1, Number(cfg.payPeriodStartDay) || 1));
  let start = new Date(d.getFullYear(), d.getMonth(), sd);
  if (d.getDate() < sd) start = new Date(d.getFullYear(), d.getMonth() - 1, sd);
  const end = new Date(start.getFullYear(), start.getMonth() + 1, sd);
  end.setDate(end.getDate() - 1); // day before the next period starts
  // Pay day = first occurrence of that day-of-month on/after the period start
  // (0 → last day of the start month). Unset → assume paid on the period end.
  let payDate = end;
  if (cfg.payDay != null && cfg.payDay !== '') {
    const pd = Number(cfg.payDay);
    const at = m => pd === 0 ? new Date(start.getFullYear(), m + 1, 0) : new Date(start.getFullYear(), m, Math.min(28, Math.max(1, pd)));
    payDate = at(start.getMonth());
    if (payDate < start) payDate = at(start.getMonth() + 1);
  }
  return { startIso: ymd(start), endIso: ymd(end), payDateIso: ymd(payDate), label: `${fmtD(start)} – ${fmtD(end)}` };
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
