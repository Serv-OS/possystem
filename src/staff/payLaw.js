// src/staff/payLaw.js
//
// 5.12.57 (US basics, batch 4: pay and employment law). The words and the small rules that differ
// between a UK and a US venue in Workforce, the staff app and the Payroll report, in one place:
//   holidayWord     'Holiday' (UK holiday rules) or 'PTO' (US)
//   tipPoolName     'Tronc / tips' (UK) or 'Tip pool' (US), and the weight's name
//   payrollParts    a payroll line (or a run's totals) split into the parts the server's Total adds
//                   (workforce-compute payroll.period), so every row a screen shows adds up to Total
//   leaverBalanceWords  the leaver dialog's PTO balance words at a US venue
// Every function takes the region pack (or its country) as an argument, so a UK venue reads exactly
// what it read before. PURE: no imports, runs under node --test (src/lib/payLawBatch4.test.js).

/** Holiday rules of the UK kind (UK and Ireland: 12.07%, statutory days). No pack reads as the UK, as before. */
export const ukHoliday = (pack) => !pack || pack.holidayRules !== 'us';

/** The name of paid time off at the venue: 'Holiday' (UK) or 'PTO' (US). */
export function holidayWord(pack) {
  return ukHoliday(pack) ? 'Holiday' : 'PTO';
}

/** The same in a sentence: 'holiday' (UK) or 'PTO' (US). */
export function holidayWordLower(pack) {
  return ukHoliday(pack) ? 'holiday' : 'PTO';
}

/** The Workforce menu name for the tip pool: 'Tronc / tips' (UK, as before) or 'Tip pool' (US). */
export function tipPoolName(pack) {
  return pack && pack.country === 'US' ? 'Tip pool' : 'Tronc / tips';
}

/** The position's share weight: 'Tronc weight' (UK, as before) or 'Tip pool weight' (US). */
export function tipWeightName(pack) {
  return pack && pack.country === 'US' ? 'Tip pool weight' : 'Tronc weight';
}

const n = (v) => Number(v || 0);
const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

/**
 * A payroll line (or, with `totals: true`, a run's totals) split into the parts Total is made of:
 *   base       pay at the straight rate, plus a head office salary (line: salary; totals: head_office_salary)
 *   overtime   overtime premium (US, the half time on top)
 *   topUp      tip credit top up (US)
 *   meal       California meal break premium
 *   premium    pay premiums (weekend, bank holiday, night)
 *   holiday    holiday (UK) or PTO (US) pay
 *   tipsDirect, tipsPooled, tips
 *   other      anything Total holds that no part names (0 for every line the server writes today),
 *              so a row always adds up even if a new part is added later
 *   wages      total minus tips
 */
export function payrollParts(l = {}, { totals = false } = {}) {
  const tipsDirect = n(l.tips_direct), tipsPooled = n(l.tips_tronc);
  const tips = l.tips != null ? n(l.tips) : r2(tipsDirect + tipsPooled);
  const base = r2(n(l.pay) + (totals ? n(l.head_office_salary) : n(l.salary)));
  const parts = {
    base, overtime: r2(n(l.overtime_premium)), topUp: r2(n(l.tip_credit_topup)), meal: r2(n(l.meal_premium)),
    premium: r2(n(l.premium_pay)), holiday: r2(n(l.holiday_pay)), tipsDirect: r2(tipsDirect), tipsPooled: r2(tipsPooled), tips: r2(tips),
    total: r2(n(l.total)),
  };
  const named = parts.base + parts.overtime + parts.topUp + parts.meal + parts.premium + parts.holiday + parts.tips;
  parts.other = r2(parts.total - named);
  if (Math.abs(parts.other) < 0.005) parts.other = 0;
  parts.wages = r2(parts.total - parts.tips);
  return parts;
}

/** The wages of a closed run's totals (or a line): Total minus tips, every wage part included. */
export const wagesOf = (t = {}) => payrollParts(t, { totals: true }).wages;

/**
 * The wage columns a run needs beside Base pay, in order, each shown only when some line has it.
 * Holiday is named for the venue (Holiday or PTO). Returns [{ key, label }].
 */
export function payrollWageColumns(lines = [], pack = null) {
  const all = [
    { key: 'overtime', label: 'Overtime premium' },
    { key: 'topUp', label: 'Tip credit top up' },
    { key: 'meal', label: 'Meal break premium' },
    { key: 'premium', label: 'Premium pay' },
    { key: 'holiday', label: `${holidayWord(pack)} pay` },
    { key: 'other', label: 'Other pay' },
  ];
  const parts = (lines || []).map((l) => payrollParts(l));
  return all.filter((c) => parts.some((p) => Math.abs(p[c.key]) >= 0.005));
}

/**
 * The leaver dialog's words for a US venue's PTO balance: the balance, and that paying it out or
 * taking it back from final pay depends on state law (several states forbid a deduction), never an
 * instruction to recover it. null for a UK venue, whose dialog keeps its own words (Workforce.jsx).
 */
export function leaverBalanceWords({ name = 'This person', bal = 0, pack = null, accessNote = '' } = {}) {
  if (ukHoliday(pack)) return null;
  return bal > 0
    ? `${name} leaves with ${bal.toFixed(1)} hours of PTO not taken.\n\nWhether unused PTO is paid out in the final pay depends on your state's law and your PTO policy: check with your payroll provider BEFORE archiving.${accessNote}\n\nArchive now?`
    : `${name} leaves with a PTO balance of ${bal.toFixed(1)} hours (more taken than earned).\n\nWhether any of it can be taken back from the final pay depends on your state's law (several states do not allow it): check with your payroll provider before you deduct anything.${accessNote}\n\nArchive now?`;
}
