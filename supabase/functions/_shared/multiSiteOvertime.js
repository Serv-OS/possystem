// multiSiteOvertime.js: US overtime for one person across every site they work at (5.12.36, 5.12.38).
//
// Peter, 2 Nov 2026: "one member of staff might work at 2 sites or 3 sites, in the US overtime is
// calculated after they have worked 40 hours but they might work 20 hours at one site and 25 hours at
// another site. Then that is 5 hours over time."
//
// The rules (federal FLSA, the simple case every US venue follows unless a state adds more):
//   * Hours for one employer in one work week count as one total, whichever site they were worked at.
//     Sites linked as one person (wf_staff.person_id, 20261111a) are one employer's hours. Linking is
//     the choice: two companies that are truly separate employers do not link their records.
//   * The hours after the first 40 in the week are overtime, in the order they were worked. Each
//     overtime hour belongs to the site where it was worked (the site that crossed 40 pays for it).
//   * Overtime pays half the REGULAR RATE on top of the straight time already paid for the hour. With
//     different rates at different sites, the regular rate is the week's blend: every straight pay
//     and pay premium of the week, all sites, divided by every hour paid that week.
//   * Each timesheet's week is its OWN site's work week (its venue day in its time zone, its site's
//     Work week starts). Linked sites normally share both; when they do not, each sheet still lands
//     in one week, the same week for payroll and the reports.
//
// Two blends:
//   'rate'        hours x snapshotted rate + pay premium: payroll (never the client writable pay_amount)
//   'pay_amount'  the stored pay of the sheet: the reports' column, kept by the database
//                 (wf_ot_recompute, 20261112a), proven equal to sheetOvertime by a local Postgres test
//
// PURE: no imports but payPremiums.js; runs under node --test and in Deno.

import { venueDay, workweekStart } from './payPremiums.js';

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const r4 = (n) => Math.round((Number(n) || 0) * 10000) / 10000;
const textOrder = (a, b) => (a < b ? -1 : a > b ? 1 : 0);   // byte order, as Postgres "C"

/** Each sheet with its venue day, its week, its hours and its pay, in the order they were worked. */
function prepare(sheets, { tz, weekStartDow, blend }) {
  return (sheets || [])
    .filter((t) => t && t.staff_id)
    .map((t) => {
      const day = t.clock_in ? venueDay(t.clock_in, t.tz || tz) : null;
      const dow = Number.isInteger(Number(t.week_start_dow)) && t.week_start_dow !== null && t.week_start_dow !== '' ? Number(t.week_start_dow) : weekStartDow;
      const hrs = Math.max(0, Number(t.actual_hours) || 0);
      const paidHrs = hrs + Math.max(0, Number(t.paid_break_mins) || 0) / 60;
      const pay = blend === 'pay_amount'
        ? Math.max(0, Number(t.pay_amount) || 0)
        : paidHrs * (Number(t.effective_rate) || 0) + Math.max(0, Number(t.premium_pay) || 0);
      return {
        t, day, hrs, paidHrs, pay, ms: Date.parse(t.clock_in) || 0,
        person: String(t.person || t.staff_id),
        week: day ? workweekStart(day, dow) : null,
      };
    })
    .sort((a, b) => a.ms - b.ms || textOrder(String(a.t.staff_id), String(b.t.staff_id)) || textOrder(String(a.t.id ?? ''), String(b.t.id ?? '')));
}

/** The core: each sheet's overtime hours and its half time, at its person-week's blended rate. */
function walk(rows, weekly) {
  const blend = {};
  for (const r of rows) {
    if (!r.week) continue;
    const k = `${r.person}|${r.week}`;
    const b = blend[k] ?? (blend[k] = { pay: 0, hours: 0 });
    b.pay += r.pay; b.hours += r.paidHrs;
  }
  const running = {};
  return rows.map((r) => {
    if (!r.week) return { r, ot: 0, rate: 0, premium: 0 };
    const k = `${r.person}|${r.week}`;
    const before = running[k] || 0;
    const after = before + r.hrs;
    running[k] = after;
    const ot = Math.max(0, after - weekly) - Math.max(0, before - weekly);
    const rate = blend[k].hours > 0 ? blend[k].pay / blend[k].hours : 0;
    return { r, ot, rate, premium: ot > 0 ? r2(ot * rate * 0.5) : 0 };
  });
}

/**
 * Per timesheet: { [sheet id]: { overtime, premium } } for every sheet given (no period filter). The
 * reports' stored column (wf_timesheets.overtime_hours, overtime_premium) is exactly this with the
 * 'pay_amount' blend. weekly null or 0: null.
 */
export function sheetOvertime(sheets, weekly, { tz = 'Europe/London', weekStartDow = 1, blend = 'pay_amount' } = {}) {
  if (!weekly) return null;
  const out = {};
  for (const w of walk(prepare(sheets, { tz, weekStartDow, blend }), weekly)) {
    if (w.r.t.id == null) continue;
    out[w.r.t.id] = { overtime: r2(w.ot), premium: w.premium };
  }
  return out;
}

/**
 * Payroll: sheets of the whole work weeks touching the period, at this site AND the person's other
 * linked sites:
 *   { id?, staff_id, person, location_id, actual_hours, paid_break_mins?, effective_rate?, premium_pay?,
 *     pay_amount?, clock_in, tz?, week_start_dow? }
 *   person          the link (wf_staff.person_id), or the staff_id when the record is not linked
 *   tz, week_start_dow   the sheet's own site (default: opts.tz, opts.weekStartDow)
 * weekly: 40 for the US federal rule; null or 0 = no overtime (the UK): returns null.
 * opts: { tz, weekStartDow (1 = Monday), from, to (the period, venue days), here (the site whose
 *   payroll this is; only its records are returned; null returns every record), blend ('rate') }
 *
 * Returns { [staff_id]: { regular, overtime, otherSiteHours, overtimePremium, regularRate } }:
 *   regular, overtime   hours worked at this record's site in the period
 *   otherSiteHours      the same person's hours at their other sites in the period
 *   overtimePremium     the half time owed on this record's overtime hours (each sheet to the cent)
 *   regularRate         the blend, weighted by this record's overtime hours (null with no overtime)
 * A record that is not linked reads exactly as overtimeSplit (payPremiums.js) always did, plus the
 * premium and the rate.
 */
export function overtimeAcrossSites(sheets, weekly, { tz = 'Europe/London', weekStartDow = 1, from = null, to = null, here = null, blend = 'rate' } = {}) {
  if (!weekly) return null;
  const inPeriod = (day) => (!from || day >= from) && (!to || day <= to);
  const mine = (r) => !here || String(r.t.location_id || '') === String(here);
  const out = {};
  const lineFor = (sid) => out[sid] ?? (out[sid] = { regular: 0, overtime: 0, otherSiteHours: 0, overtimePremium: 0, otRateWeight: 0 });
  const walked = walk(prepare(sheets, { tz, weekStartDow, blend }), weekly);
  for (const { r, ot, rate, premium } of walked) {
    if (r.day && !inPeriod(r.day)) continue;
    if (!mine(r)) continue;
    const o = lineFor(r.t.staff_id);
    o.regular += r.hrs - ot;
    o.overtime += ot;
    if (ot > 0) { o.overtimePremium += premium; o.otRateWeight += ot * rate; }
  }
  // The same person's hours at their other sites, shown on this site's line.
  if (here) {
    const hereRecordOf = {};
    for (const { r } of walked) if (mine(r)) hereRecordOf[r.person] = r.t.staff_id;
    for (const { r } of walked) {
      if (mine(r) || !r.day || !inPeriod(r.day)) continue;
      const sid = hereRecordOf[r.person];
      if (sid) lineFor(sid).otherSiteHours += r.hrs;
    }
  }
  for (const o of Object.values(out)) {
    o.regularRate = o.overtime > 0 ? r4(o.otRateWeight / o.overtime) : null;
    o.regular = r2(o.regular); o.overtime = r2(o.overtime);
    o.otherSiteHours = r2(o.otherSiteHours); o.overtimePremium = r2(o.overtimePremium);
    delete o.otRateWeight;
  }
  return out;
}
