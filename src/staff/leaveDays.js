// src/staff/leaveDays.js
//
// Which days of a time-off request are ANNUAL LEAVE (deduct from the holiday
// balance) and which are just NORMAL DAYS OFF (they weren't going to work
// anyway)? A 7-day request from a Mon–Fri person is 5 days of holiday, not 7
// (Peter, 10 Aug). The system proposes; the approver can override any day.
//
// Signals per day, strongest first:
//   rota          they have a shift that day            → annual leave
//   availability  weekly pattern says unavailable       → normal day off
//   history       they usually work that weekday        → annual leave
//                 (≥40% of their recent worked weeks; <15% with enough
//                  history → day off)
//   contract      full-time / salaried → Mon–Fri        → annual leave
//   default       weekday on, weekend off — the least-wrong guess for a
//                 brand-new starter with no data, and always overridable
//
// Pure and dependency-light so it is unit-testable; the approval screen and
// anything later (the staff app request form) share one answer.

import { availabilityOn } from './wfClash.js';

/** Every date in the inclusive range, as YYYY-MM-DD. Capped at 62 days. */
export function eachDay(fromIso, toIso) {
  const out = [];
  const d = new Date(fromIso + 'T00:00:00');
  const end = new Date(toIso + 'T00:00:00');
  while (d <= end && out.length < 62) {
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
    d.setDate(d.getDate() + 1);
  }
  return out;
}

const dow = iso => new Date(iso + 'T00:00:00').getDay();           // 0=Sun … 6=Sat
const isWeekend = iso => { const d = dow(iso); return d === 0 || d === 6; };

/** Share of their recent worked weeks in which they worked each weekday.
 *  Returns { share: number[7 by getDay()], weeks } — weeks = distinct weeks
 *  with any work, the denominator. */
export function workedWeekdayShare(timesheets, staffId) {
  const weeksByDay = [new Set(), new Set(), new Set(), new Set(), new Set(), new Set(), new Set()];
  const allWeeks = new Set();
  (timesheets || []).forEach(t => {
    if (t.staffId !== staffId || !t.clockIn || !(Number(t.actualHours) > 0)) return;
    const d = new Date(t.clockIn);
    const monday = new Date(d); monday.setHours(0, 0, 0, 0);
    const g = monday.getDay(); monday.setDate(monday.getDate() + (g === 0 ? -6 : 1 - g));
    const wk = monday.toISOString().slice(0, 10);
    allWeeks.add(wk);
    weeksByDay[d.getDay()].add(wk);
  });
  const weeks = allWeeks.size;
  return { weeks, share: weeksByDay.map(s => (weeks ? s.size / weeks : 0)) };
}

/**
 * Propose the annual-leave / day-off split for a request.
 * Returns [{ date, leave, reason }] — `leave` true = annual leave.
 */
export function proposeLeaveDays({ from, to, staffId, shifts = [], availability = [], timesheets = [], contractType = null }) {
  const shiftDates = new Set((shifts || []).filter(s => s.staffId === staffId).map(s => s.date));
  const { weeks, share } = workedWeekdayShare(timesheets, staffId);
  const fullTime = contractType === 'fullTime' || contractType === 'salaried';

  return eachDay(from, to).map(date => {
    if (shiftDates.has(date)) return { date, leave: true, reason: 'rota' };
    if (availabilityOn(availability, staffId, date) === 'unavailable') return { date, leave: false, reason: 'availability' };
    if (weeks >= 4) {
      const s = share[dow(date)];
      if (s >= 0.4) return { date, leave: true, reason: 'history' };
      if (s < 0.15) return { date, leave: false, reason: 'history' };
    }
    if (fullTime) return { date, leave: !isWeekend(date), reason: 'contract' };
    return { date, leave: !isWeekend(date), reason: 'default' };
  });
}
