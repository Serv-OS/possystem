// cashTips.js: declared cash tips at clock out, US venues (5.12.49).
//
// US law: staff must report the cash tips they receive to their employer (IRS, at least monthly), the
// employer reports them as wages, and a tip credit may only lean on tips the employee actually kept.
// ServOS records card tips itself; cash tips are the employee's own declaration, asked at clock out
// (the Time Clock tablet and the staff app), kept on the timesheet (wf_timesheets.declared_cash_tips,
// 20261117a), shown and editable in Timesheets, totalled in Payroll and the US export, and counted
// toward the tip credit week.
//
// The setting: Workforce settings, Ask for cash tips at clock out. US venues only, on unless switched
// off. A UK (or any non US) venue is never asked and the server ignores any amount sent.
//
// PURE: no imports; runs under node --test and in Deno.

export const CASH_TIPS_MAX = 10000;

/** Should this venue ask for cash tips at clock out? Only a US venue, and only with the setting on. */
export function asksCashTips({ country = null, settings = null } = {}) {
  return country === 'US' && (settings?.askCashTips !== false);
}

/**
 * A declared amount from a person: '', null or undefined means "not asked / skipped" (null).
 * Returns { value } (a number to the cent, 0 allowed) or { error } in words.
 */
export function parseCashTips(input) {
  if (input === null || input === undefined) return { value: null };
  const s = String(input).trim().replace(/^\$/, '').replace(/,/g, '');
  if (s === '') return { value: null };
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return { error: 'Type the cash tips as dollars and cents, for example 24.50.' };
  const n = Math.round(Number(s) * 100) / 100;
  if (!(n >= 0) || n > CASH_TIPS_MAX) return { error: `That is more than ${CASH_TIPS_MAX} dollars. Check the amount.` };
  return { value: n };
}
