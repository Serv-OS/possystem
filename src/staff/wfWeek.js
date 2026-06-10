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
 * Monthly pay period running from `startDay` of one month to (startDay-1) of the
 * next — e.g. startDay 26 → 26th to 25th. Returns the period containing `ref`.
 */
export function payPeriod(startDay = 1, ref = new Date()) {
  const sd = Math.min(28, Math.max(1, Number(startDay) || 1));
  const d = new Date(ref); d.setHours(0, 0, 0, 0);
  let start = new Date(d.getFullYear(), d.getMonth(), sd);
  if (d.getDate() < sd) start = new Date(d.getFullYear(), d.getMonth() - 1, sd);
  const end = new Date(start.getFullYear(), start.getMonth() + 1, sd);
  end.setDate(end.getDate() - 1); // day before the next period starts
  const fmt = x => x.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  return { startIso: ymd(start), endIso: ymd(end), label: `${fmt(start)} – ${fmt(end)}` };
}

/** Shift a monthly pay period by ±n months (returns a fresh period). */
export function shiftPayPeriod(startDay, currentStartIso, n) {
  const d = new Date(currentStartIso + 'T00:00:00');
  d.setMonth(d.getMonth() + n);
  return payPeriod(startDay, d);
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
