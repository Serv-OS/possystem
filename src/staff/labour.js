// src/staff/labour.js
//
// Labour engine — the spine (Master Build Spec §3, decision #1).
//   effective rate → shift cost → wage by day → labour % vs target.
// Effective rate resolves: staff rateOverride → role age-band → role base →
// salaried hourly-equivalent (salaryAnnual / 52 / contracted week).
// NOTE: seed-first build computes client-side; production hardens pay compute to
// the server (spec: never trust client math for pay).

import { GROUPS, ROLES, FORECAST, LABOUR_TARGET } from './seed';

// Fallback salaried divisor when neither the staff record nor the role stores a
// contracted week. The real value is persisted (wf_staff.contracted_week /
// wf_roles.contracted_week) and snapshotted onto each pay row so historical pay
// is reproducible — this constant only covers un-configured legacy data.
const CONTRACTED_WEEK = 40;

// UK statutory holiday accrual: 5.6 weeks / (52 − 5.6) = 12.07% of hours worked.
// Stored per venue (wf_venue_settings.accrual_rate); this is the default.
export const DEFAULT_ACCRUAL_RATE = 0.1207;

/** Decimal hours between HH:MM strings, handling shifts past midnight. */
export function hoursOf(start, end) {
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  let mins = (eh * 60 + em) - (sh * 60 + sm);
  if (mins < 0) mins += 24 * 60;
  return mins / 60;
}

/**
 * Resolve the effective hourly rate AND its provenance, so the result can be
 * snapshotted onto a shift/timesheet for audit (cost = rate × hours, re-derivable).
 * Precedence: staff override → role base rate → salaried hourly-equivalent.
 * The salaried divisor reads the stored contracted week (staff → role → fallback).
 * @returns {{rate:number, source:'override'|'base'|'salaried'|'none', contractedWeek:number}}
 */
export function resolveRate(staff, role, contractedWeekFallback) {
  const cw = (staff && staff.contractedWeek)
    || (role && role.contractedWeek)
    || contractedWeekFallback
    || CONTRACTED_WEEK;
  if (staff && staff.rateOverride != null) return { rate: staff.rateOverride, source: 'override', contractedWeek: cw };
  if (role && role.rate != null) return { rate: role.rate, source: 'base', contractedWeek: cw };
  if (role && role.salary) return { rate: role.salary / 52 / cw, source: 'salaried', contractedWeek: cw };
  return { rate: 0, source: 'none', contractedWeek: cw };
}

/** Effective hourly rate (number only; see resolveRate for provenance). */
export function effectiveRate(staff, role, contractedWeekFallback) {
  return resolveRate(staff, role, contractedWeekFallback).rate;
}

/**
 * v5.5.970 — DATE-AWARE rate resolution for future-dated pay changes.
 * `changes` = wf_rate_changes rows (camelCase via wfData.loadRateChanges).
 * Only rows still status 'scheduled' are considered: once the daily applier
 * lands a change on the live rate card, resolveRate already returns it — and
 * respecting an 'applied' row here would stomp any later manual edit.
 * Rules: a scheduled STAFF change acts like an override for that person; a
 * scheduled ROLE change applies via the role unless the person has a live
 * manual override (overrides beat role rates, matching resolveRate).
 */
export function resolveRateOn(staff, role, dateIso, changes, contractedWeekFallback) {
  const base = resolveRate(staff, role, contractedWeekFallback);
  if (!dateIso || !Array.isArray(changes) || changes.length === 0) return base;
  const due = changes
    .filter(c => c.status === 'scheduled' && c.effectiveFrom && c.effectiveFrom <= dateIso)
    .sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : a.effectiveFrom > b.effectiveFrom ? -1 : 0));
  const staffCh = staff ? due.find(c => c.targetKind === 'staff' && c.staffId === staff.id && c.newRate != null) : null;
  if (staffCh) return { rate: Number(staffCh.newRate), source: 'scheduled', contractedWeek: base.contractedWeek };
  if (staff && staff.rateOverride != null) return base;   // live manual override wins over role-level schedules
  const roleCh = role ? due.find(c => c.targetKind === 'role' && c.roleKey === role.key) : null;
  if (roleCh) {
    if (roleCh.newRate != null) return { rate: Number(roleCh.newRate), source: 'scheduled', contractedWeek: base.contractedWeek };
    if (roleCh.newSalaryAnnual != null) {
      return { rate: Number(roleCh.newSalaryAnnual) / 52 / base.contractedWeek, source: 'scheduled', contractedWeek: base.contractedWeek };
    }
  }
  return base;
}

/**
 * Holiday pay accrued from hours actually worked (statutory 12.07% default).
 * Rounded to 2dp. Pair with accrual_rate stored on the row for auditability.
 */
export function accrueHolidayHours(actualHours, rate = DEFAULT_ACCRUAL_RATE) {
  if (!(actualHours > 0)) return 0;
  return Math.round(actualHours * rate * 100) / 100;
}

// UK statutory holiday for salaried / regular-hours staff: 5.6 weeks ≈ 28 days
// (for a 5-day week). Hourly/irregular staff accrue at 12.07% instead.
export const FIXED_HOLIDAY_DAYS = 28;

/**
 * Is this person paid hourly (accrues holiday at 12.07%) or salaried (fixed days)?
 * Salaried = contract_type 'salaried', or a salaried role with no hourly rate.
 */
export function isHourly(staff, role) {
  if (staff && staff.contractType === 'salaried') return false;
  if (staff && staff.rateOverride != null) return true;
  if (role && role.rate != null) return true;
  if (role && role.salary != null && role.rate == null) return false;
  return true; // default: hourly (accrues)
}

/**
 * UK statutory rest break due for a worked stretch (Working Time Regulations
 * 1998, reg 12): adults get a 20-min uninterrupted break when working MORE
 * than 6 hours; under-18s (young workers) get 30 mins when working more than
 * 4.5 hours. The break need not be paid — that's venue policy. Returns the
 * minutes due (0 if none). `dob` optional ISO date for the under-18 rule.
 */
export function statutoryBreakMins(workedHours, dob) {
  const hrs = Number(workedHours) || 0;
  if (dob) {
    const age = (Date.now() - new Date(dob + 'T00:00:00').getTime()) / (365.25 * 86400000);
    if (age < 18 && hrs > 4.5) return 30;
  }
  return hrs > 6 ? 20 : 0;
}

/**
 * Average hours per worked day — what "a day" of holiday is worth for
 * variable-hours staff. UK-compliant method (Employment Rights Act reference
 * period, as amended April 2020; gov.uk "Calculating holiday pay for workers
 * without fixed hours or pay"):
 *   - look at the last 52 WEEKS in which the person actually worked,
 *   - SKIP whole weeks with no work (they don't dilute the average),
 *   - look back no further than 104 weeks,
 *   - if they've worked fewer than 52 weeks, use however many they have.
 * Average = total hours in those weeks ÷ total days worked in those weeks.
 * (The old 12-week/3-month rule was replaced in April 2020.)
 */
export function avgHoursPerDay(timesheets, refDate = new Date()) {
  // Local date of the clock-in — toISOString() is UTC and can shift evening
  // clock-ins onto the wrong day depending on the device timezone.
  const localYmd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  // Monday of the week containing a date — weeks are Mon–Sun.
  const weekStartOf = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); const dow = x.getDay(); x.setDate(x.getDate() + (dow === 0 ? -6 : 1 - dow)); return x; };

  const byDay = {};
  (timesheets || []).forEach(t => {
    const hrs = Number(t.actualHours || 0);
    if (!t.clockIn || hrs <= 0) return;
    byDay[localYmd(new Date(t.clockIn))] = (byDay[localYmd(new Date(t.clockIn))] || 0) + hrs;
  });

  // Bucket worked days into weeks.
  const weeks = {}; // weekStartIso -> { hours, days }
  Object.entries(byDay).forEach(([iso, hrs]) => {
    const wk = localYmd(weekStartOf(new Date(iso + 'T00:00:00')));
    const b = weeks[wk] || (weeks[wk] = { hours: 0, days: 0 });
    b.hours += hrs; b.days += 1;
  });

  // Most recent first; cap lookback at 104 weeks; take up to 52 WORKED weeks.
  const horizon = new Date(refDate); horizon.setDate(horizon.getDate() - 104 * 7);
  const horizonIso = localYmd(weekStartOf(horizon));
  const used = Object.keys(weeks).filter(wk => wk >= horizonIso).sort().reverse().slice(0, 52);
  if (!used.length) return 0;
  const total = used.reduce((a, wk) => ({ hours: a.hours + weeks[wk].hours, days: a.days + weeks[wk].days }), { hours: 0, days: 0 });
  if (!total.days) return 0;
  return Math.round((total.hours / total.days) * 100) / 100;
}

/** Wage cost per day across the roster → 7-element array (Mon→Sun). */
export function wageByDay(groups = GROUPS, roles = ROLES) {
  const wage = new Array(7).fill(0);
  groups.forEach(g => g.staff.forEach(s => {
    const role = roles[s.role];
    for (let i = 0; i < 7; i++) {
      const c = s.days[i];
      if (Array.isArray(c)) wage[i] += hoursOf(c[0], c[1]) * effectiveRate(s, role);
    }
  }));
  return wage;
}

/** labour % = wage ÷ sales. */
export function labourPct(wage, sales) { return sales > 0 ? wage / sales : 0; }

// ── Tronc engine (UK Tipping Act, spec §3) ──────────────────────────────────
// units = hours × role points; pointValue = pool / Σunits; payout = units × pointValue.
// Money is allocated to the PENNY using the largest-remainder method so the sum
// of rounded payouts equals the pool exactly (no drift, no "lost" pence). The
// run carries totalPaid + residual; residual MUST be 0.00 after reconciliation.
export function troncRun(pool, rows) {
  const poolCents = Math.round((Number(pool) || 0) * 100);
  const totalUnits = rows.reduce((a, r) => a + r.pts * r.hrs, 0);

  if (poolCents <= 0 || totalUnits <= 0) {
    const lines = rows.map(r => ({ ...r, units: r.pts * r.hrs, sharePct: 0, payout: 0 }));
    return { totalUnits, pointValue: 0, lines, totalPaid: 0, residual: +(Number(pool) || 0).toFixed(2) };
  }

  // Exact (fractional) cents per line, then floor + distribute the remainder.
  const calc = rows.map((r, i) => {
    const units = r.pts * r.hrs;
    const exact = (poolCents * units) / totalUnits;
    const floor = Math.floor(exact);
    return { i, units, sharePct: units / totalUnits, exact, floor, frac: exact - Math.floor(exact) };
  });

  const cents = calc.map(c => c.floor);
  let remainder = poolCents - cents.reduce((a, c) => a + c, 0); // whole pennies still to assign
  // Largest fractional part wins; tie-break on more units, then stable index.
  const order = [...calc].sort((a, b) => b.frac - a.frac || b.units - a.units || a.i - b.i);
  for (let k = 0; k < remainder; k++) cents[order[k % order.length].i] += 1;

  const lines = calc.map((c, idx) => ({
    ...rows[idx], units: c.units, sharePct: c.sharePct, payout: cents[idx] / 100,
  }));
  const totalPaid = cents.reduce((a, c) => a + c, 0) / 100;
  return {
    totalUnits,
    pointValue: poolCents / 100 / totalUnits,
    lines,
    totalPaid,
    residual: +((poolCents / 100) - totalPaid).toFixed(2), // 0.00 when reconciled
  };
}

// Timesheet variance vs scheduled (spec: flag beyond ±10 min ≈ ±0.17h).
export function tsVariance(actual, scheduled) {
  const v = actual - scheduled;
  return { v, cls: v > 0.05 ? 'over' : (v < -0.05 ? 'under' : 'exact') };
}

export { FORECAST, LABOUR_TARGET };
