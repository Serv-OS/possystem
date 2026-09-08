// src/lib/manager/floor.js
//
// Pure floor-state classification for the ServOS Manager Reports tab. No I/O — unit-tested.
// The data layer maps `active_sessions` → the `session` shape below; this file only decides STATE.
//
// session: {
//   id, label, covers,
//   seatedAtMs : number | null,   // when the party was seated
//   lastFiredAtMs : number | null,// when the last course/order was fired (null = nothing fired yet)
//   hasOrder : boolean,           // anything ordered at all
//   status : string | null,       // raw session status ('active','bill','bill_req',…)
// }
//
// "stalled" (the §4.1 rule, configurable per venue):
//   • seated > stalledNoOrderMin with NO order fired, OR
//   • > stalledSinceCourseMin since the last course was fired.

export const DEFAULT_FLOOR_OPTS = { stalledNoOrderMin: 10, stalledSinceCourseMin: 25 };

const minsSince = (ms, nowMs) => (ms == null ? null : (nowMs - ms) / 60000);

/** Classify one session → 'dining' | 'held' | 'seated_no_order' | 'stalled' | 'unknown'. */
export function tableState(s, opts = {}, nowMs = Date.now()) {
  const o = { ...DEFAULT_FLOOR_OPTS, ...opts };
  if (!s || s.seatedAtMs == null) return 'unknown';
  if (s.status === 'bill' || s.status === 'bill_req') return 'held';

  const seatedMin = minsSince(s.seatedAtMs, nowMs);
  const hasOrder = !!s.hasOrder || s.lastFiredAtMs != null;

  if (!hasOrder) {
    return seatedMin > o.stalledNoOrderMin ? 'stalled' : 'seated_no_order';
  }
  // Has ordered: stalled if it's been too long since the last course fired.
  const sinceCourse = s.lastFiredAtMs != null ? minsSince(s.lastFiredAtMs, nowMs) : seatedMin;
  if (sinceCourse > o.stalledSinceCourseMin) return 'stalled';
  return 'dining';
}

/** Group sessions by state, each enriched with `state` + `waitMins` (mins since seated). */
export function classifyFloor(sessions, opts = {}, nowMs = Date.now()) {
  const out = { dining: [], held: [], seated_no_order: [], stalled: [], unknown: [] };
  (sessions || []).forEach((s) => {
    const state = tableState(s, opts, nowMs);
    const waitMins = s?.seatedAtMs != null ? Math.round((nowMs - s.seatedAtMs) / 60000) : null;
    (out[state] || out.unknown).push({ ...s, state, waitMins });
  });
  // Stalled list sorted worst-first (longest wait), for the "act now" panel.
  out.stalled.sort((a, b) => (b.waitMins || 0) - (a.waitMins || 0));
  return out;
}

/** Quick counts for the home/reports header. */
export function floorCounts(sessions, opts = {}, nowMs = Date.now()) {
  const g = classifyFloor(sessions, opts, nowMs);
  return {
    open: (sessions || []).length,
    dining: g.dining.length,
    held: g.held.length,
    seatedNoOrder: g.seated_no_order.length,
    stalled: g.stalled.length,
  };
}
