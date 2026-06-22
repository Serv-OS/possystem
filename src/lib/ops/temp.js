/**
 * ops/temp.js — pure temperature & scheduling engine for the Operations module.
 *
 * No I/O. Everything is authored/stored in °C (numeric); °F is display-only.
 * The breach rules here are the single source of truth for in-range vs out-of-range,
 * mirrored by a server-side check in the submit RPC so a tampered client can't pass
 * a breach silently (HACCP requirement).
 *
 * UK FSA / Safer Food Better Business defaults are built in and overridable per unit
 * in admin config — the floor app READS a unit's target band, it never defines it.
 */

// ── unit-of-measure (display only) ───────────────────────────────────────────
export const cToF = (c) => (Number(c) * 9) / 5 + 32;
export const fToC = (f) => ((Number(f) - 32) * 5) / 9;
const round1 = (n) => Math.round(Number(n) * 10) / 10;

/** Convert a stored °C value into the chosen display unit. Returns { value, unit, label }. */
export function displayTemp(valueC, unit = 'C') {
  if (valueC == null || !Number.isFinite(Number(valueC))) return { value: null, unit, label: '—' };
  const v = unit === 'F' ? round1(cToF(valueC)) : round1(valueC);
  return { value: v, unit, label: `${v}°${unit}` };
}
/** Parse a number the operator typed in the display unit back into stored °C. */
export function toStoredC(input, unit = 'C') {
  if (input == null || input === '') return null;   // Number('') is 0 — guard it
  const n = Number(input);
  if (!Number.isFinite(n)) return null;
  return unit === 'F' ? fToC(n) : n;
}

// ── FSA best-practice defaults per unit type (°C). Editable per unit in admin. ──
export const TYPE_DEFAULTS = {
  fridge:    { min: 1,    max: 5,   label: 'Fridge',     guidance: 'Chilled: keep at or below 5°C (food ≤8°C). Target 1–4°C.' },
  freezer:   { min: -25,  max: -18, label: 'Freezer',    guidance: 'Frozen: keep at or below −18°C (food ≤−15°C).' },
  cold_hold: { min: 0,    max: 8,   label: 'Cold hold',  guidance: 'Cold holding must stay below 8°C.' },
  hot_hold:  { min: 63,   max: 90,  label: 'Hot hold',   guidance: 'Hot holding must stay at or above 63°C.' },
  cooking:   { min: 75,   max: 200, label: 'Cooking',    guidance: 'Core temp ≥75°C (or 70°C for 2 min) when cooking/reheating.' },
  chill_down:{ min: 0,    max: 8,   label: 'Chill-down', guidance: 'Chill from 63°C to below 8°C within 90 minutes.' },
  delivery:  { min: 0,    max: 8,   label: 'Delivery',   guidance: 'Chilled deliveries ≤8°C; frozen ≤−15°C. Reject if over.' },
};
export const typeDefault = (type) => TYPE_DEFAULTS[type] || { min: null, max: null, label: type || 'Unit', guidance: '' };

// ── range / breach ───────────────────────────────────────────────────────────
/** In range when min ≤ reading ≤ max. Null bounds are open-ended. */
export function inRange(readingC, minC, maxC) {
  const r = Number(readingC);
  if (!Number.isFinite(r)) return false;
  if (minC != null && r < Number(minC)) return false;
  if (maxC != null && r > Number(maxC)) return false;
  return true;
}

/** Breach detail: { inRange, direction:'over'|'under'|null, deltaC } — deltaC is how far outside. */
export function breach(readingC, minC, maxC) {
  const r = Number(readingC);
  if (!Number.isFinite(r)) return { inRange: false, direction: null, deltaC: 0 };
  if (maxC != null && r > Number(maxC)) return { inRange: false, direction: 'over', deltaC: round1(r - Number(maxC)) };
  if (minC != null && r < Number(minC)) return { inRange: false, direction: 'under', deltaC: round1(Number(minC) - r) };
  return { inRange: true, direction: null, deltaC: 0 };
}

/**
 * Severity of a breach — drives whether it auto-raises a maintenance request.
 * 'minor' (<2°C out) · 'major' (≥2°C) · 'critical' (frozen losing freeze, or hot-hold
 * in the bacterial danger zone) → auto-maintenance on major+.
 */
export function breachSeverity(readingC, type, minC, maxC) {
  const b = breach(readingC, minC, maxC);
  if (b.inRange) return 'none';
  const r = Number(readingC);
  if (type === 'freezer' && r > -15) return 'critical';                 // food thawing
  if ((type === 'hot_hold' || type === 'cooking') && r < 63) return 'critical'; // danger zone
  return b.deltaC >= 2 ? 'major' : 'minor';
}
/** Major or critical breaches auto-raise maintenance + alert a manager. */
export const autoRaises = (severity) => severity === 'major' || severity === 'critical';

// ── scheduling: due / missed ─────────────────────────────────────────────────
/** 'HH:MM' → minutes since midnight (null if malformed). */
export function hhmmToMin(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}
/** Does a schedule run on this date? daysOfWeek = array of 0..6 (0=Sun); empty/null = every day. */
export function runsOnDay(daysOfWeek, date) {
  if (!Array.isArray(daysOfWeek) || daysOfWeek.length === 0) return true;
  return daysOfWeek.includes(new Date(date).getDay());
}

/**
 * Status of one scheduled check window.
 *   done     — a reading was logged for it
 *   upcoming — window hasn't opened yet
 *   due      — open now, within grace, not yet done
 *   missed   — past the grace period with no reading
 */
export function windowStatus({ windowMin, graceMin = 60, nowMin, satisfied }) {
  if (satisfied) return 'done';
  if (nowMin < windowMin) return 'upcoming';
  if (nowMin <= windowMin + graceMin) return 'due';
  return 'missed';
}

/** Roll a list of window statuses into counts + a headline state for a tile/ring. */
export function summarize(statuses) {
  const c = { done: 0, due: 0, missed: 0, upcoming: 0, total: statuses.length };
  statuses.forEach((s) => { c[s] = (c[s] || 0) + 1; });
  const required = c.done + c.due + c.missed;            // upcoming not yet required
  c.compliancePct = required > 0 ? Math.round((c.done / required) * 100) : 100;
  c.state = c.missed > 0 ? 'over' : c.due > 0 ? 'due' : 'done';   // coral / amber / green
  return c;
}

// ── escalation ───────────────────────────────────────────────────────────────
/**
 * How many escalation steps are due for an unacknowledged alert.
 * ladder = minutes after creation for each rung, e.g. [0, 15, 30] = alert now,
 * re-alert at 15m, escalate at 30m. Acknowledged alerts never escalate.
 */
export function escalationStepsDue({ createdAtMin, nowMin, acknowledged, ladder = [0, 15, 30] }) {
  if (acknowledged) return 0;
  const elapsed = nowMin - createdAtMin;
  return ladder.filter((m) => elapsed >= m).length;
}
