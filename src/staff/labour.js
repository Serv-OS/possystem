// src/staff/labour.js
//
// Labour engine — the spine (Master Build Spec §3, decision #1).
//   effective rate → shift cost → wage by day → labour % vs target.
// Effective rate resolves: staff rateOverride → role age-band → role base →
// salaried hourly-equivalent (salaryAnnual / 52 / contracted week).
// NOTE: seed-first build computes client-side; production hardens pay compute to
// the server (spec: never trust client math for pay).

import { GROUPS, ROLES, FORECAST, LABOUR_TARGET } from './seed';

const CONTRACTED_WEEK = 40; // hours/week used for the salaried hourly-equivalent

/** Decimal hours between HH:MM strings, handling shifts past midnight. */
export function hoursOf(start, end) {
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  let mins = (eh * 60 + em) - (sh * 60 + sm);
  if (mins < 0) mins += 24 * 60;
  return mins / 60;
}

/** Effective hourly rate: override → role base/age-band → salaried equivalent. */
export function effectiveRate(staff, role) {
  if (staff && staff.rateOverride != null) return staff.rateOverride;
  if (role && role.rate != null) return role.rate;
  if (role && role.salary) return role.salary / 52 / CONTRACTED_WEEK;
  return 0;
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

export { FORECAST, LABOUR_TARGET };
