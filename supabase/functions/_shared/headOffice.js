// supabase/functions/_shared/headOffice.js
//
// 5.12.56 HEAD OFFICE STAFF (UK and US). Peter, 3 Nov 2026: head office staff "dont need to clock in
// and out", "lets not share the costs of head office staff", and the head office is a tick on the
// person, not a site of its own (a site would make a subscription row and every till, menu and
// report would have to skip it).
//
//   * The switch: Workforce settings, Head office staff (settings.headOffice, off by default). Off,
//     nothing here applies and every screen reads exactly as before, even for a ticked person.
//   * The person: Workforce, Staff, a person, Head office (wf_staff.head_office) and their Annual
//     salary (wf_staff.salary_annual). They stay listed at the site they were added at.
//   * Pay: the salary for the pay period with no timesheets (headOfficePay below).
//   * Clock in: refused (they do not clock in), and they are left off the rota, so no timesheet and
//     no rota cost ever lands in the site's labour or labour %.
//   * Reports: the company view in the Owner app shows Head office as its own line (headOfficeCost),
//     never shared across the sites and never inside a site's labour %.
//
// One file, read by workforce-clock, workforce-compute, staff-portal and the Owner app snapshot, and
// by the Back Office through src/lib/headOffice.js, so the till, the staff app, payroll and the
// reports can never disagree about who is head office or what they cost.

/** The site's switch (wf_venue_settings.settings.headOffice). Only a real true switches it on. */
export function headOfficeOn(settings) {
  return !!settings && settings.headOffice === true;
}

/** A staff record that counts as head office at its site: the switch is on AND the person is ticked. */
export function isHeadOffice(staff, settings) {
  return headOfficeOn(settings) && !!staff && staff.head_office === true;
}

/** Pay periods in a year for each pay period type (Workforce settings, Pay period). */
export const PERIODS_PER_YEAR = { weekly: 52, fortnightly: 26, fourweekly: 13, semimonthly: 24, monthly: 12 };
/** The days a real period of each type can have; any other window is paid by the day. */
const PERIOD_DAYS = { weekly: [7, 7], fortnightly: [14, 14], fourweekly: [28, 28], semimonthly: [13, 16], monthly: [28, 31] };

const DAY = 86400000;
const dayMs = (iso) => Date.parse(`${String(iso).slice(0, 10)}T00:00:00Z`);
const daysIn = (fromIso, toIso) => Math.max(0, Math.round((dayMs(toIso) - dayMs(fromIso)) / DAY) + 1);
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/** A usable salary: a number above 0, else null. */
export function salaryOf(staff) {
  const s = Number(staff?.salary_annual);
  return Number.isFinite(s) && s > 0 ? s : null;
}

/**
 * Days of [from, to] the person was employed: on or after start_date, on or before leaver_date.
 * Both dates are plain 'YYYY-MM-DD' calendar days, the venue's own days (no time zone sums).
 */
export function employedDays({ from, to, startDate = null, leaverDate = null }) {
  let a = String(from).slice(0, 10), b = String(to).slice(0, 10);
  if (startDate && String(startDate).slice(0, 10) > a) a = String(startDate).slice(0, 10);
  if (leaverDate && String(leaverDate).slice(0, 10) < b) b = String(leaverDate).slice(0, 10);
  return a > b ? 0 : daysIn(a, b);
}

/**
 * The salary paid for one pay period.
 *   A full period: the year's salary divided by the periods in a year for the venue's pay period type
 *   (monthly: 12, semi monthly: 24, fortnightly: 26, four weekly: 13, weekly: 52), so every month pays
 *   the same whatever its length.
 *   A part period (started or left inside it): that amount times the days employed over the days in
 *   the period.
 *   A period type we do not know, or a window that is not one real period of the type (two months at
 *   once, a custom range): the salary times the days employed over 365.
 * Returns { pay, days, periodDays, basis } where basis is 'period', 'part' or 'days'. No salary: pay 0.
 */
export function headOfficePay({ salaryAnnual, from, to, periodType, startDate = null, leaverDate = null }) {
  const s = Number(salaryAnnual);
  const periodDays = daysIn(from, to);
  const days = employedDays({ from, to, startDate, leaverDate });
  if (!Number.isFinite(s) || s <= 0 || days === 0) return { pay: 0, days, periodDays, basis: 'period' };
  const perYear = PERIODS_PER_YEAR[periodType];
  const fits = perYear && periodDays >= PERIOD_DAYS[periodType][0] && periodDays <= PERIOD_DAYS[periodType][1];
  if (!fits) return { pay: round2(s * days / 365), days, periodDays, basis: 'days' };
  const full = s / perYear;
  if (days >= periodDays) return { pay: round2(full), days, periodDays, basis: 'period' };
  return { pay: round2(full * days / periodDays), days, periodDays, basis: 'part' };
}

/**
 * Head office cost for a report window (the Owner app's day, week to date or period): the salary of
 * every head office person spread evenly over the year (salary / 365 a day) for the days they were
 * employed in [from, to]. A cost for the company line only: never added to a site's labour.
 * staff: [{ salary_annual, start_date, leaver_date, status }]. Returns { cost, people }.
 */
export function headOfficeCost(staff, { from, to }) {
  let cost = 0, people = 0;
  for (const st of staff || []) {
    const s = salaryOf(st);
    if (!s) continue;
    const days = employedDays({ from, to, startDate: st.start_date, leaverDate: st.leaver_date });
    if (!days) continue;
    cost += s * days / 365;
    people += 1;
  }
  return { cost: round2(cost), people };
}

/** What the till and the staff app say when a head office person tries to clock in. */
export const HEAD_OFFICE_CLOCK_WORDS = 'Head office staff do not clock in. Your salary is paid each pay period.';

/** What the staff app says when a head office person tries to take an open shift. */
export const HEAD_OFFICE_SHIFT_WORDS = 'Head office staff do not take shifts. Your salary is paid each pay period.';
