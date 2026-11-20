// supabase/functions/_shared/staffIdRules.js (5.12.85, support ticket 20 Nov 2026: "Team members can't
// edit their NI number or date of birth on the app", Peter: "I cant even see these details in the app").
//
// One copy of the rules for a team member's own date of birth and ID number (NI number in the UK,
// SSN last 4 in the US): the staff-portal refuses a bad value and the staff app says why before it
// sends. Pure, no imports, tested in node (src/staff/staffIdRules.test.js).

// HMRC format: two prefix letters (first never D, F, I, Q, U or V; second never D, F, I, O, Q, U or V;
// the pair never BG, GB, NK, KN, TN, NT or ZZ), six digits, suffix A to D.
export const NI_RE = /^(?!BG|GB|NK|KN|TN|NT|ZZ)[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z]\d{6}[A-D]$/;

/** 'qq 12 34 56 c' -> 'QQ123456C' (what is stored). '' -> ''. */
export function normaliseNi(v) {
  return String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** 'QQ123456C' -> 'QQ 12 34 56 C' (what is shown). Anything else is shown as typed. */
export function formatNi(v) {
  const s = normaliseNi(v);
  if (!NI_RE.test(s)) return String(v || '');
  return `${s.slice(0, 2)} ${s.slice(2, 4)} ${s.slice(4, 6)} ${s.slice(6, 8)} ${s.slice(8)}`;
}

/** null when fine (an empty value is fine: it means "leave blank"), else the words for the person. */
export function niProblem(v) {
  const s = normaliseNi(v);
  if (!s) return null;
  if (!NI_RE.test(s)) return 'Enter a valid National Insurance number, like AB 12 34 56 C';
  return null;
}

/** SSN last 4: exactly four digits, or blank. */
export function ssnLast4Problem(v) {
  const d = String(v || '').replace(/\D/g, '');
  if (!d) return null;
  if (d.length !== 4 || String(v).trim().length !== 4) return 'Enter the last four digits of your SSN';
  return null;
}

const MIN_AGE = 13;    // the youngest anyone may legally work part time in the UK or the US
const MAX_AGE = 100;

/**
 * Date of birth as YYYY-MM-DD (the date input's value). Blank is fine. It must be a real calendar
 * date, in the past, and give an age between 13 and 100 on `today` (YYYY-MM-DD; defaults to now).
 */
export function dobProblem(v, today) {
  const s = String(v || '').trim();
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return 'Enter your date of birth';
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return 'That is not a real date';
  const t = String(today || new Date().toISOString().slice(0, 10));
  if (s >= t) return 'Your date of birth must be in the past';
  const age = ageOn(s, t);
  if (age < MIN_AGE) return `You must be at least ${MIN_AGE} to work here. Check the year.`;
  if (age > MAX_AGE) return 'Check the year of your date of birth';
  return null;
}

/** Whole years between two YYYY-MM-DD strings. */
export function ageOn(dob, today) {
  const [y, m, d] = String(dob).split('-').map(Number);
  const [ty, tm, td] = String(today).split('-').map(Number);
  let age = ty - y;
  if (tm < m || (tm === m && td < d)) age -= 1;
  return age;
}

/**
 * Which ID number this venue's payroll uses, from the region pack's payrollFields:
 * 'ni' (UK), 'ssn4' (US) or null (Ireland: date of birth only).
 */
export function idNumberKind(pack) {
  const f = (pack && pack.payrollFields) || [];
  if (f.includes('niNumber')) return 'ni';
  if (f.includes('ssnLast4')) return 'ssn4';
  return null;
}

export const ID_WORDS = { ni: 'NI number', ssn4: 'SSN last 4' };

/**
 * The new starter checklist step "Add your date of birth and NI number": what is still missing from
 * the wf_staff row { dob, ni_number, ssn_last4 } for this venue. { done, label, missing: [...] }.
 * This step is for the person (it sits in their list with an Add button); it never blocks a shift
 * claim: openOnboardingSteps and the database judge do not count it.
 */
export function idDetailsStep(staff, pack) {
  const kind = idNumberKind(pack);
  const missing = [];
  if (!staff || !staff.dob) missing.push('date of birth');
  if (kind === 'ni' && !(staff && staff.ni_number)) missing.push(ID_WORDS.ni);
  if (kind === 'ssn4' && !(staff && staff.ssn_last4)) missing.push(ID_WORDS.ssn4);
  const want = ['date of birth', ...(kind ? [ID_WORDS[kind]] : [])];
  return { done: missing.length === 0, label: `Add your ${want.join(' and ')}`, missing };
}
