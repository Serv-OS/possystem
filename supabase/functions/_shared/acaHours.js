// acaHours.js: health cover (ACA) hours for US venues, counted across every site a person works at
// (5.12.38). Pure: node --test and Deno.
//
// The Affordable Care Act, the monthly measurement method (IRS):
//   * an employee with 130 or more hours of service in a calendar month is FULL TIME that month;
//   * a company is an Applicable Large Employer (must offer health cover to full timers and file
//     1094-C and 1095-C) when its full time employees PLUS full time equivalents averaged 50 or more
//     over the prior calendar year. Full time equivalents: every other employee's hours in the month,
//     each capped at 120, added up and divided by 120.
// Hours of service at every linked site count together (one person, one employer). Approved and paid
// timesheets are the hours of service here (paid leave is not in them: the report says so).

const r1 = (n) => Math.round((Number(n) || 0) * 10) / 10;
export const ACA_FULL_TIME_MONTH = 130;
export const ACA_FTE_CAP = 120;
export const ACA_LARGE_EMPLOYER = 50;

/** The calendar months from `from` to `to` ('YYYY-MM'), oldest first. */
export function monthsBetween(from, to) {
  const out = [];
  let [y, m] = String(from).split('-').map(Number);
  const [ty, tm] = String(to).split('-').map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1; if (m > 12) { m = 1; y += 1; }
    if (out.length > 60) break;
  }
  return out;
}

/**
 * rows: [{ staff_id, location_id, hours, month ('YYYY-MM', the venue's own day) }] for the company.
 * staff: [{ id, person_id, location_id, name }] for the company.
 * here: the site whose report this is. months: monthsBetween(...). full: the complete months that
 * count toward "full time months" and the company average (default: every month but the last, the
 * month still running).
 * Returns { people: [...this site's records], company: { byMonth, average, large } }.
 */
export function acaReport({ rows = [], staff = [], here, months = [], full = months.slice(0, -1) }) {
  const fullSet = new Set(full);
  const personOf = {};
  for (const s of staff) personOf[s.id] = s.person_id || s.id;
  const monthSet = new Set(months);
  // Hours per person per month, all sites; and per record per month.
  const byPerson = {};
  const byRecord = {};
  for (const r of rows) {
    if (!monthSet.has(r.month)) continue;
    const h = Math.max(0, Number(r.hours) || 0);
    const p = personOf[r.staff_id] || r.staff_id;
    const bp = (byPerson[p] ??= {});
    bp[r.month] = (bp[r.month] || 0) + h;
    const br = (byRecord[r.staff_id] ??= {});
    br[r.month] = (br[r.month] || 0) + h;
  }
  const people = staff.filter((s) => s.location_id === here).map((s) => {
    const p = personOf[s.id];
    const all = byPerson[p] || {};
    const mine = byRecord[s.id] || {};
    const perMonth = months.map((m) => ({ month: m, hours: r1(all[m] || 0), here: r1(mine[m] || 0), fullTime: (all[m] || 0) >= ACA_FULL_TIME_MONTH }));
    const fullTimeMonths = perMonth.filter((x) => x.fullTime && fullSet.has(x.month)).length;
    return { staffId: s.id, name: s.name, linked: !!s.person_id, months: perMonth, fullTimeMonths };
  }).filter((x) => x.months.some((m) => m.hours > 0))
    .sort((a, b) => b.fullTimeMonths - a.fullTimeMonths || String(a.name).localeCompare(String(b.name)));

  const byMonth = {};
  for (const m of months) {
    let fullTime = 0, partHours = 0, employees = 0;
    for (const p of Object.keys(byPerson)) {
      const h = byPerson[p][m] || 0;
      if (h <= 0) continue;
      employees += 1;
      if (h >= ACA_FULL_TIME_MONTH) fullTime += 1; else partHours += Math.min(h, ACA_FTE_CAP);
    }
    const fte = Math.floor((partHours / ACA_FTE_CAP) * 100) / 100;
    byMonth[m] = { employees, fullTime, fte, total: Math.floor((fullTime + fte) * 100) / 100 };
  }
  const totals = full.filter((m) => byMonth[m]).map((m) => byMonth[m].total);
  const average = totals.length ? Math.floor((totals.reduce((a, b) => a + b, 0) / totals.length) * 100) / 100 : 0;
  return { people, company: { byMonth, average, large: average >= ACA_LARGE_EMPLOYER } };
}
