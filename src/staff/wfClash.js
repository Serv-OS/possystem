// src/staff/wfClash.js
//
// Pure rota clash/warning logic — no imports, no Supabase, unit-testable
// (`npm test`). Two families of checks:
//   (1) HARD clash  — two shifts for the same person on the same day whose
//       times overlap. These BLOCK a save (split shifts are fine; overlap isn't).
//   (2) SOFT warnings — the person has APPROVED time off covering the date
//       (wf_time_off) or is marked unavailable that weekday (wf_availability).
//       These never block: the UI shows "⚠ …" and lets the manager place the
//       shift anyway.

// ── time helpers ────────────────────────────────────────────────────────────
export const toMins = hhmm => { const [h, m] = String(hhmm || '0:0').split(':').map(Number); return (h || 0) * 60 + (m || 0); };

/** [startMins, finishMins] with overnight finishes rolled past midnight. */
export const spanOf = (start, finish) => { const s = toMins(start); let f = toMins(finish); if (f <= s) f += 24 * 60; return [s, f]; };

/** Weekday index Mon=0 … Sun=6 for a local YYYY-MM-DD (matches wf_availability per_day.day). */
export const dayIdx = dateIso => (new Date(dateIso + 'T00:00:00').getDay() + 6) % 7;

// ── (1) hard shift-overlap clash ────────────────────────────────────────────
// Touching endpoints (…–17:00 then 17:00–…) are fine. `ignoreId` lets an edit
// ignore itself.
export function findClash(list, staffId, dateIso, start, finish, ignoreId) {
  const [s1, f1] = spanOf(start, finish);
  return (list || []).find(x => {
    if (x.staffId !== staffId || x.date !== dateIso || x.id === ignoreId) return false;
    const [s2, f2] = spanOf(x.start, x.finish);
    return s1 < f2 && s2 < f1;
  });
}

// ── (2) soft warnings: approved leave + weekly availability ─────────────────
/** First APPROVED wf_time_off row covering the date (inclusive), or null. */
export function approvedLeaveOn(timeOff, staffId, dateIso) {
  return (timeOff || []).find(l =>
    l.staffId === staffId && l.status === 'approved' &&
    l.startDate && l.endDate && l.startDate <= dateIso && dateIso <= l.endDate
  ) || null;
}

/** Availability state for that weekday: 'available' | 'unavailable' | 'preferred'. */
export function availabilityOn(availability, staffId, dateIso) {
  const row = (availability || []).find(a => a.staffId === staffId);
  const p = row?.perDay?.find(x => x.day === dayIdx(dateIso));
  return p?.state || 'available';
}

const LEAVE_LBL = { holiday: 'on holiday', sick: 'off sick', unpaid: 'on unpaid leave', parental: 'on parental leave' };
const DAY_PLURAL = ['Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays', 'Sundays'];

/**
 * Short, human warnings for placing `staffId` on `dateIso`.
 * Returns [] when clear — e.g. ["Jane is on holiday that day",
 * "Jane is marked unavailable on Tuesdays"].
 */
export function clashWarnings({ staffName, staffId, dateIso, timeOff, availability }) {
  const out = [];
  const first = (staffName || 'They').split(' ')[0];
  const leave = approvedLeaveOn(timeOff, staffId, dateIso);
  if (leave) out.push(`${first} is ${LEAVE_LBL[leave.type] || 'on approved leave'} that day`);
  if (availabilityOn(availability, staffId, dateIso) === 'unavailable') {
    out.push(`${first} is marked unavailable on ${DAY_PLURAL[dayIdx(dateIso)]}`);
  }
  return out;
}
