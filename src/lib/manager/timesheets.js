// src/lib/manager/timesheets.js
//
// Pure timesheet anomaly flags for the ServOS Manager approvals inbox. No I/O — unit-tested.
// Approval/decline + payroll maths stay in wfData/workforce-compute (penny-exact, audited);
// this only surfaces flags so the manager can scan before approving.
//
// ts: { inMs, outMs|null, breakMins, scheduledMins|null, edited }

import { breakShortfall } from '../../staff/breaks.js';

export const DEFAULT_TS_OPTS = { overtimeBufferMin: 15 };

/** Net worked minutes (clock-in→out, minus break). Uses `nowMs` if not clocked out. */
export function timesheetWorkedMins(ts, nowMs = Date.now()) {
  if (!ts || ts.inMs == null) return 0;
  const end = ts.outMs != null ? ts.outMs : nowMs;
  return Math.max(0, Math.round((end - ts.inMs) / 60000) - (Number(ts.breakMins) || 0));
}

/** Time ON SHIFT in hours, break included — what the statutory break test needs. */
function grossHoursOf(ts, nowMs) {
  if (!ts || ts.inMs == null) return 0;
  const end = ts.outMs != null ? ts.outMs : nowMs;
  return Math.max(0, (end - ts.inMs) / 3600000);
}

/**
 * Anomaly flags: 'clock_out_missing' | 'short_break' | 'overtime' | 'edited'.
 *
 * v5.5.990 — 'no_break' became 'short_break'. The old rule required the break
 * to be exactly ZERO and hardcoded a 6-hour threshold with no regard for age,
 * so a five-minute break on a ten-hour shift raised nothing at all, and an
 * under-18 never triggered. It now uses the shared rule in staff/breaks.js.
 *
 * `opts.policy` (from venueBreakPolicy) and `ts.dob` / `ts.plannedBreakMins`
 * sharpen it when the caller has them; without them it still enforces the
 * statutory minimum, which is strictly better than the old zero-break test.
 */
export function timesheetAnomalies(ts, opts = {}, nowMs = Date.now()) {
  const o = { ...DEFAULT_TS_OPTS, ...opts };
  const flags = [];
  if (!ts) return flags;
  if (ts.outMs == null) flags.push('clock_out_missing');
  const worked = timesheetWorkedMins(ts, nowMs);
  const sf = breakShortfall({
    grossHours: grossHoursOf(ts, nowMs),
    breakMins: ts.breakMins,
    dob: ts.dob || null,
    plannedBreakMins: ts.plannedBreakMins ?? null,
    policy: o.policy || null,
  });
  if (sf.level !== 'none') flags.push('short_break');
  if (ts.scheduledMins != null && worked > ts.scheduledMins + o.overtimeBufferMin) flags.push('overtime');
  if (ts.edited) flags.push('edited');
  return flags;
}

/** The full break verdict for a manager row, when you need the numbers and not
 *  just the flag (how short, and against what). Same rule as the flag above. */
export function timesheetBreakShortfall(ts, opts = {}, nowMs = Date.now()) {
  if (!ts) return breakShortfall();
  return breakShortfall({
    grossHours: grossHoursOf(ts, nowMs),
    breakMins: ts.breakMins,
    dob: ts.dob || null,
    plannedBreakMins: ts.plannedBreakMins ?? null,
    policy: opts.policy || null,
  });
}
