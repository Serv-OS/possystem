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
 * Holiday pay accrued from hours actually worked (statutory 12.07% default).
 * Rounded to 2dp. Pair with accrual_rate stored on the row for auditability.
 */
export function accrueHolidayHours(actualHours, rate = DEFAULT_ACCRUAL_RATE) {
  if (!(actualHours > 0)) return 0;
  return Math.round(actualHours * rate * 100) / 100;
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
