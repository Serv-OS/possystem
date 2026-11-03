// caOvertime.js: California daily overtime and meal break premium pay (5.12.53).
//
// California (Labor Code 510, 512, 226.7), adult non exempt staff, as ServOS works it:
//   * Over 8 hours in a WORKDAY: time and a half. Over 12 hours in a workday: double time.
//   * Over 40 hours in the work week: time and a half, counting only the hours that were not already
//     daily overtime or double time (an hour is never paid twice).
//   * The premium is on top of the straight time already paid: half the regular rate for each
//     overtime hour, the full regular rate for each double time hour. The regular rate is the week's
//     blend (every straight pay and pay premium, all linked sites), as federal overtime.
//   * MEAL BREAK PREMIUM: when a workday's shift was long enough to need a meal break (30 minutes past
//     5 hours, a second past 10) and the break clocked was shorter, the employee is owed one extra
//     hour of pay at the regular rate for that day (at most one a day for meal breaks).
// Not covered (shown in the documents): the seventh consecutive day rule, rest break premiums (rest
// breaks are paid and not clocked), alternative workweek schedules, minors.
//
// The setting: Workforce settings, State break rules = California, then California daily overtime and
// California meal break premium (both on unless switched off). US venues only.
//
// PURE: no imports but multiSiteOvertime.js and usBreaks.js; runs under node --test and in Deno.

import { prepareSheets } from './multiSiteOvertime.js';
import { usBreakRule, usMealBreakMins } from './usBreaks.js';

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const pennies = (n) => Math.round(Math.round((Number(n) || 0) * 1e6) / 1e4) / 100;

/** The venue's California rules from its settings (null when not a California venue). */
export function caRules(settings = null) {
  const s = settings || {};
  if (String(s.usBreaks?.state || '').toUpperCase() !== 'CA') return null;
  return { dailyOvertime: s.caDailyOvertime !== false, mealPremium: s.caMealPremium !== false };
}

/**
 * Like overtimeAcrossSites, with California's daily rules. sheets as overtimeAcrossSites (plus
 * break_taken minutes). Returns { [staff_id]: { regular, overtime, doubleTime, overtimePremium,
 * mealPremium, mealPremiumDays, otherSiteHours, regularRate } } for this site's records.
 */
export function caOvertimeAcrossSites(sheets, { tz = 'America/Los_Angeles', weekStartDow = 1, from = null, to = null, here = null, rules = { dailyOvertime: true, mealPremium: true } } = {}) {
  const rows = prepareSheets(sheets, { tz, weekStartDow, blend: 'rate' });
  const inPeriod = (day) => (!from || day >= from) && (!to || day <= to);
  const mine = (r) => !here || String(r.t.location_id || '') === String(here);
  const blend = {};
  for (const r of rows) {
    if (!r.week) continue;
    const b = blend[`${r.person}|${r.week}`] ??= { pay: 0, hours: 0 };
    b.pay += r.pay; b.hours += r.paidHrs;
  }
  const rateOf = (r) => { const b = blend[`${r.person}|${r.week}`]; return b && b.hours > 0 ? b.pay / b.hours : 0; };
  const dayRun = {}, weekReg = {}, out = {};
  const lineFor = (sid) => out[sid] ??= { regular: 0, overtime: 0, doubleTime: 0, overtimePremium: 0, mealPremium: 0, mealPremiumDays: 0, otherSiteHours: 0, w: 0, wh: 0 };
  const meal = usBreakRule({ usBreaks: { state: 'CA' } });
  const dayGross = {}, dayBreak = {}, daySite = {};
  const hereRecordOf = {};
  for (const r of rows) if (mine(r)) hereRecordOf[r.person] = r.t.staff_id;
  for (const r of rows) {
    if (!r.week || !r.day) continue;
    const dk = `${r.person}|${r.day}`, wk = `${r.person}|${r.week}`;
    const h = r.hrs, rate = rateOf(r);
    let dt = 0, dailyOt = 0;
    if (rules.dailyOvertime) {
      const before = dayRun[dk] || 0, after = before + h;
      dayRun[dk] = after;
      dt = Math.max(0, after - 12) - Math.max(0, before - 12);
      dailyOt = (Math.max(0, Math.min(after, 12) - 8)) - (Math.max(0, Math.min(before, 12) - 8));
    }
    let reg = h - dt - dailyOt;
    const wb = weekReg[wk] || 0, wa = wb + reg;
    weekReg[wk] = wa;
    const weeklyOt = Math.max(0, wa - 40) - Math.max(0, wb - 40);
    reg -= weeklyOt;
    const ot = dailyOt + weeklyOt;
    // Meal break facts per person per workday (all sites), judged once the day is known.
    dayGross[dk] = (dayGross[dk] || 0) + h + Math.max(0, Number(r.t.break_taken) || 0) / 60;
    dayBreak[dk] = (dayBreak[dk] || 0) + Math.max(0, Number(r.t.break_taken) || 0);
    if (mine(r)) daySite[dk] = { sid: r.t.staff_id, rate, day: r.day };
    if (!inPeriod(r.day)) continue;
    if (!mine(r)) { const hereSid = hereRecordOf[r.person]; if (hereSid) lineFor(hereSid).otherSiteHours += h; continue; }
    const o = lineFor(r.t.staff_id);
    o.regular += reg; o.overtime += ot; o.doubleTime += dt;
    o.overtimePremium += ot * rate * 0.5 + dt * rate;
    if (ot + dt > 0) { o.w += (ot + dt) * rate; o.wh += ot + dt; }
  }
  if (rules.mealPremium) {
    for (const [dk, site] of Object.entries(daySite)) {
      if (!site || !inPeriod(site.day)) continue;
      const due = usMealBreakMins(dayGross[dk] || 0, meal);
      if (due > 0 && (dayBreak[dk] || 0) < due) {
        const o = lineFor(site.sid);
        o.mealPremium += site.rate; o.mealPremiumDays += 1;
      }
    }
  }
  for (const o of Object.values(out)) {
    o.regularRate = o.wh > 0 ? Math.round((o.w / o.wh) * 10000) / 10000 : null;
    o.regular = r2(o.regular); o.overtime = r2(o.overtime); o.doubleTime = r2(o.doubleTime);
    o.overtimePremium = pennies(o.overtimePremium); o.mealPremium = pennies(o.mealPremium); o.otherSiteHours = r2(o.otherSiteHours);
    delete o.w; delete o.wh;
  }
  return out;
}
