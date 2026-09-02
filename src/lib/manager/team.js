// src/lib/manager/team.js
//
// Pure live-team classification for the ServOS Manager Team tab. No I/O — unit-tested.
// The data layer maps wf_shifts + wf_timesheets → the shapes below; this file only decides STATE.
//
// shift:    { staffId, name, role, startMs, endMs }
// punch:    { staffId, inMs, outMs|null, breakMins, breakOpen }   (a clock-in/out for today)
//
// Thresholds align to UK working-time norms; both configurable per venue.

import { breakShortfall } from '../../staff/breaks.js';

export const DEFAULT_TEAM_OPTS = {
  noShowGraceMin: 15,     // a scheduled shift this far past start with no clock-in = no-show
};

const open = (p) => p && p.outMs == null;

/** Staff currently clocked in (open punch). */
export function onShiftNow(punches, nowMs = Date.now()) {
  return (punches || []).filter(open).map((p) => ({
    id: p.id || null,          // v5.8.21: timesheet id, so a manager can clock this person out
    staffId: p.staffId,
    onForMins: Math.max(0, Math.round((nowMs - p.inMs) / 60000)),
    onBreak: !!p.breakOpen,
  }));
}

/** Scheduled shifts whose start is past the grace window with no clock-in for that person. */
export function noShows(shifts, punches, opts = {}, nowMs = Date.now()) {
  const o = { ...DEFAULT_TEAM_OPTS, ...opts };
  const clockedInIds = new Set((punches || []).filter((p) => p.inMs != null).map((p) => p.staffId));
  return (shifts || [])
    .filter((sh) => sh.startMs != null && sh.startMs <= nowMs - o.noShowGraceMin * 60000 && (sh.endMs == null || sh.endMs > nowMs))
    .filter((sh) => !clockedInIds.has(sh.staffId))
    .map((sh) => ({ staffId: sh.staffId, name: sh.name, role: sh.role, lateMins: Math.round((nowMs - sh.startMs) / 60000) }));
}

/**
 * People currently on shift who are owed more break than they have had.
 *
 * v5.5.990 — this used to require the break to be exactly ZERO and hardcoded
 * 6 hours regardless of age, so someone who took five minutes at hour two and
 * then worked ten hours never appeared, and an under-18 never appeared at all.
 * It now uses the shared rule (staff/breaks.js) against time ON SHIFT, so a
 * partial break still leaves them owed the difference.
 *
 * Someone currently ON a break is skipped — they are taking it right now.
 */
export function breaksDue(punches, opts = {}, nowMs = Date.now()) {
  return (punches || [])
    .filter(open)
    .filter((p) => !p.breakOpen)
    .map((p) => {
      const sf = breakShortfall({
        grossHours: Math.max(0, (nowMs - p.inMs) / 3600000),
        breakMins: p.breakMins,
        dob: p.dob || null,
        policy: opts.policy || null,
      });
      return {
        staffId: p.staffId,
        workedMins: Math.max(0, Math.round((nowMs - p.inMs) / 60000) - (Number(p.breakMins) || 0)),
        owedMins: Math.max(sf.shortStatutory, sf.shortExpected),
        level: sf.level,
      };
    })
    .filter((p) => p.owedMins > 0);
}

/** Live labour cost so far today, in MINOR units (pennies). rateMinorPerHour keyed by staffId. */
export function liveLabourMinor(punches, ratesMinorPerHour, nowMs = Date.now()) {
  return (punches || []).reduce((sum, p) => {
    if (p.inMs == null) return sum;
    const endMs = p.outMs != null ? p.outMs : nowMs;
    const workedMins = Math.max(0, (endMs - p.inMs) / 60000 - (Number(p.breakMins) || 0));
    const rate = Number(ratesMinorPerHour?.[p.staffId]) || 0;
    return sum + Math.round((workedMins / 60) * rate);
  }, 0);
}
