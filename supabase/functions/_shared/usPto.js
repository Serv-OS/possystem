// usPto.js: US paid time off accrual (5.12.51).
//
// No federal or Utah law requires paid time off, but most US restaurants give it by policy, the
// commonest shape being "1 hour of PTO for every N hours worked" with a yearly cap. ServOS keeps it in
// the same ledger as UK holiday (wf_holiday_accrual: accrual rows in, time off taken out), so balances,
// requests, approvals, the staff app and payroll's paid holiday all work as they do for UK venues.
//
// The settings (Workforce settings, US venues only; wf_venue_settings.settings):
//   ptoEnabled   on or off. OFF by default: nothing accrues until a venue switches it on.
//   ptoEvery     hours worked for each 1 hour of PTO (default 30, from 1 to 200).
//   ptoYearCap   most PTO hours one person can earn in a calendar year (blank = no cap).
// Who earns: hourly staff, the same rule as UK holiday (salaried staff are left out; their PTO, if any,
// is a fixed allowance). Each approved timesheet earns once (the ledger remembers its source sheet).
//
// PURE: no imports; runs under node --test and in Deno.

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** The venue's PTO rules from its settings. */
export function ptoRules(settings = null) {
  const s = settings || {};
  const every = Number(s.ptoEvery);
  const cap = Number(s.ptoYearCap);
  return {
    on: s.ptoEnabled === true,
    every: Number.isFinite(every) && every >= 1 && every <= 200 ? every : 30,
    yearCap: Number.isFinite(cap) && cap > 0 ? cap : null,
  };
}

/**
 * Ledger rows for timesheets not yet accrued.
 *   sheets:   [{ id, staff_id, actual_hours, effective_rate, currency, year }] approved, not yet in the ledger
 *   earned:   { `${staff_id}|${year}`: hours already accrued that calendar year }
 *   rules:    ptoRules(...)
 *   isHourly: (staff_id) => boolean
 * Returns [{ staff_id, source_timesheet_id, accrued_hours, accrued_pay, rate, currency, year }]. A person
 * at the yearly cap earns nothing more that year; the sheet that reaches the cap earns only up to it.
 */
export function ptoAccruals(sheets, earned = {}, rules = ptoRules(), isHourly = () => true) {
  if (!rules.on) return [];
  const rate = 1 / rules.every;
  const sofar = { ...earned };
  const out = [];
  const ordered = [...(sheets || [])].sort((a, b) => String(a.clock_in || '').localeCompare(String(b.clock_in || '')) || String(a.id).localeCompare(String(b.id)));
  for (const t of ordered) {
    const hrs = Number(t.actual_hours) || 0;
    if (hrs <= 0 || !isHourly(t.staff_id)) continue;
    const key = `${t.staff_id}|${t.year}`;
    let earn = r2(hrs * rate);
    if (rules.yearCap != null) earn = r2(Math.max(0, Math.min(earn, rules.yearCap - (sofar[key] || 0))));
    if (earn <= 0) continue;
    sofar[key] = r2((sofar[key] || 0) + earn);
    out.push({ staff_id: t.staff_id, source_timesheet_id: t.id, accrued_hours: earn,
      accrued_pay: t.effective_rate != null ? r2(earn * Number(t.effective_rate)) : null, rate: r2(rate * 10000) / 10000,
      currency: t.currency || null, year: t.year });
  }
  return out;
}
