// multiSiteOvertime.js: US overtime for one person across every site they work at (5.12.36).
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
//
// PURE: no imports but payPremiums.js; runs under node --test and in Deno.

import { venueDay, workweekStart } from './payPremiums.js';

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const r4 = (n) => Math.round((Number(n) || 0) * 10000) / 10000;

/**
 * sheets: every approved or paid timesheet of the whole work weeks touching the period, at this site
 * AND at the person's other linked sites:
 *   { staff_id, person, location_id, actual_hours, paid_break_mins?, effective_rate?, premium_pay?,
 *     clock_in, tz? }
 *   person   the link (wf_staff.person_id), or the staff_id when the record is not linked
 *   tz       the sheet's own venue time zone (its venue day decides its week and its period)
 * weekly: 40 for the US federal rule; null or 0 = no overtime (the UK): returns null.
 * opts: { tz (default zone), weekStartDow (1 = Monday), from, to (the period, venue days), here (the
 *   site whose payroll this is; only its records are returned; null returns every record) }
 *
 * Returns { [staff_id]: { regular, overtime, otherSiteHours, overtimePremium, regularRate } }:
 *   regular, overtime   hours worked at this record's site in the period
 *   otherSiteHours      the same person's hours at their other sites in the period
 *   overtimePremium     the half time owed on this record's overtime hours, at each week's blend
 *   regularRate         the blend, weighted by this record's overtime hours (null with no overtime)
 * A record that is not linked reads exactly as overtimeSplit (payPremiums.js) always did, plus the
 * premium and the rate.
 */
export function overtimeAcrossSites(sheets, weekly, { tz = 'Europe/London', weekStartDow = 1, from = null, to = null, here = null } = {}) {
  if (!weekly) return null;
  const inPeriod = (day) => (!from || day >= from) && (!to || day <= to);
  const rows = (sheets || [])
    .filter((t) => t && t.staff_id)
    .map((t) => {
      const day = t.clock_in ? venueDay(t.clock_in, t.tz || tz) : null;
      const hrs = Math.max(0, Number(t.actual_hours) || 0);
      const paidHrs = hrs + Math.max(0, Number(t.paid_break_mins) || 0) / 60;
      const pay = paidHrs * (Number(t.effective_rate) || 0) + Math.max(0, Number(t.premium_pay) || 0);
      return {
        t, day, hrs, paidHrs, pay, ms: Date.parse(t.clock_in) || 0,
        person: String(t.person || t.staff_id),
        week: day ? workweekStart(day, weekStartDow) : null,
      };
    })
    .sort((a, b) => a.ms - b.ms || String(a.t.staff_id).localeCompare(String(b.t.staff_id)));

  // The blend for every person and week: all sites, all pay, all paid hours.
  const blend = {};
  for (const r of rows) {
    if (!r.week) continue;
    const k = `${r.person}|${r.week}`;
    const b = blend[k] ?? (blend[k] = { pay: 0, hours: 0 });
    b.pay += r.pay; b.hours += r.paidHrs;
  }
  const rateOf = (k) => (blend[k] && blend[k].hours > 0 ? blend[k].pay / blend[k].hours : 0);

  const out = {};
  const mine = (r) => !here || String(r.t.location_id || '') === String(here);
  const lineFor = (sid) => out[sid] ?? (out[sid] = { regular: 0, overtime: 0, otherSiteHours: 0, overtimePremium: 0, otRateWeight: 0 });
  const running = {};
  for (const r of rows) {
    const take = !r.day || inPeriod(r.day);
    let ot = 0;
    if (r.week) {
      const k = `${r.person}|${r.week}`;
      const before = running[k] || 0;
      const after = before + r.hrs;
      running[k] = after;
      ot = Math.max(0, after - weekly) - Math.max(0, before - weekly);
      if (take && mine(r) && ot > 0) {
        const o = lineFor(r.t.staff_id);
        const rate = rateOf(k);
        o.overtimePremium += ot * rate * 0.5;
        o.otRateWeight += ot * rate;
      }
    }
    if (!take) continue;
    if (mine(r)) {
      const o = lineFor(r.t.staff_id);
      o.regular += r.hrs - ot;
      o.overtime += ot;
    }
  }
  // The same person's hours at their other sites, shown on this site's line.
  if (here) {
    const hereRecordOf = {};
    for (const r of rows) if (mine(r)) hereRecordOf[r.person] = r.t.staff_id;
    for (const r of rows) {
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
