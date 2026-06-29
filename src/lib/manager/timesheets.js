// src/lib/manager/timesheets.js
//
// Pure timesheet anomaly flags for the ServOS Manager approvals inbox. No I/O — unit-tested.
// Approval/decline + payroll maths stay in wfData/workforce-compute (penny-exact, audited);
// this only surfaces flags so the manager can scan before approving.
//
// ts: { inMs, outMs|null, breakMins, scheduledMins|null, edited }

export const DEFAULT_TS_OPTS = { breakExpectedAfterMin: 360 /*6h*/, overtimeBufferMin: 15 };

/** Net worked minutes (clock-in→out, minus break). Uses `nowMs` if not clocked out. */
export function timesheetWorkedMins(ts, nowMs = Date.now()) {
  if (!ts || ts.inMs == null) return 0;
  const end = ts.outMs != null ? ts.outMs : nowMs;
  return Math.max(0, Math.round((end - ts.inMs) / 60000) - (Number(ts.breakMins) || 0));
}

/** Anomaly flags: 'clock_out_missing' | 'no_break' | 'overtime' | 'edited'. */
export function timesheetAnomalies(ts, opts = {}, nowMs = Date.now()) {
  const o = { ...DEFAULT_TS_OPTS, ...opts };
  const flags = [];
  if (!ts) return flags;
  if (ts.outMs == null) flags.push('clock_out_missing');
  const worked = timesheetWorkedMins(ts, nowMs);
  if (worked >= o.breakExpectedAfterMin && (Number(ts.breakMins) || 0) === 0) flags.push('no_break');
  if (ts.scheduledMins != null && worked > ts.scheduledMins + o.overtimeBufferMin) flags.push('overtime');
  if (ts.edited) flags.push('edited');
  return flags;
}
