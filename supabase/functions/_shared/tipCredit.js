// tipCredit.js: the US tip credit top up (5.12.47).
//
// Federal FLSA, the rule every US venue taking a tip credit must follow (Mozz, Provo, Utah):
//   * A tipped employee may be paid a cash wage below the minimum wage (federal $2.13 against $7.25)
//     only while their TIPS make up the difference. The check is made for each WORK WEEK on its own.
//   * If, in a work week, the cash wage plus the tips they kept comes to less than the minimum wage
//     for every hour they worked that week, the employer pays the shortfall: the TOP UP.
//   * Weeks are never averaged: a big tip week cannot cover a slow one.
//
// How ServOS works it:
//   * A week is a tip credit week for a person when any of their hourly timesheets that week is paid
//     below the site's minimum wage (Workforce settings, Minimum wage; federal $7.25 when blank, the
//     same setting overtime uses since 5.12.41). Salaried sheets never count.
//   * Owed = minimum wage x every hour paid that week (paid breaks included). Paid = the straight pay
//     of the week (hours x rate, pay premiums included) + the tips they kept that week (card tips on
//     their own checks and their share of pooled tips). Top up = owed less paid, never below 0.
//   * Overtime is not part of this: its premium is already worked out on the minimum wage (5.12.41),
//     so the straight time is the only part a tip credit can leave short.
//   * Tips counted are the tips ServOS knows: card tips. Cash tips are not recorded yet, so a person
//     with cash tips may be shown a top up that their cash tips would cover. That errs toward paying,
//     which is the safe side of the law.
//   * Each week belongs to the pay period holding its LAST day, so a week split by the period edge
//     is counted once, when it is complete.
//
// PURE: no imports but payPremiums.js; runs under node --test and in Deno.

import { venueDay, workweekStart } from './payPremiums.js';

// Money to the cent, the same half up rule as payroll (multiSiteOvertime pennies).
const pennies = (n) => Math.round(Math.round((Number(n) || 0) * 1e6) / 1e4) / 100;
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const plusDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

/**
 * sheets: [{ staff_id, hours, pay, rate, rate_source, clock_in, min_wage? }] the person's sheets for
 *         every work week touching the period. hours include paid breaks; pay is straight pay plus any
 *         pay premium. min_wage is that sheet's site minimum wage (default `minWage`).
 * tips:   [{ staff_id, amount, day }] tips kept, each on the venue day it was earned (YYYY-MM-DD).
 * Returns { [staff_id]: { topUp, weeks: [{ week, hours, pay, tips, owed, topUp }] } } for people with
 * at least one tip credit week ending in the period. Everyone else is left out.
 */
export function tipCreditTopUps(sheets, tips, { minWage = 7.25, tz = 'Europe/London', weekStartDow = 1, from = null, to = null } = {}) {
  const weeks = {};   // `${staff}|${weekStart}` -> bucket
  const bucket = (sid, ws) => weeks[`${sid}|${ws}`] ?? (weeks[`${sid}|${ws}`] = { sid, week: ws, hours: 0, pay: 0, tips: 0, tipped: false, floor: 0 });
  for (const t of sheets || []) {
    const day = t.day || venueDay(t.clock_in, tz);
    if (!day || !t.staff_id) continue;
    const b = bucket(t.staff_id, workweekStart(day, weekStartDow));
    const hrs = Number(t.hours) || 0;
    const floor = Number(t.min_wage ?? minWage) || minWage;
    b.hours += hrs;
    b.pay += Number(t.pay) || 0;
    b.floor = Math.max(b.floor, floor);
    if (t.rate_source !== 'salaried' && hrs > 0 && Number(t.rate) < floor - 1e-9) b.tipped = true;
  }
  for (const tip of tips || []) {
    if (!tip.staff_id || !tip.day) continue;
    const key = `${tip.staff_id}|${workweekStart(tip.day, weekStartDow)}`;
    if (weeks[key]) weeks[key].tips += Number(tip.amount) || 0;
  }
  const out = {};
  for (const b of Object.values(weeks)) {
    if (!b.tipped) continue;
    const last = plusDays(b.week, 6);
    if ((from && last < from) || (to && last > to)) continue;
    const owed = pennies(b.floor * b.hours);
    const paid = pennies(b.pay + b.tips);
    const topUp = Math.max(0, pennies(owed - paid));
    const line = out[b.sid] ?? (out[b.sid] = { topUp: 0, weeks: [] });
    line.weeks.push({ week: b.week, hours: r2(b.hours), pay: pennies(b.pay), tips: pennies(b.tips), owed, topUp });
    line.topUp = pennies(line.topUp + topUp);
  }
  for (const l of Object.values(out)) l.weeks.sort((a, b) => (a.week < b.week ? -1 : 1));
  return out;
}
