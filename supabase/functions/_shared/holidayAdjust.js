// supabase/functions/_shared/holidayAdjust.js (5.12.89)
//
// Holiday balances changed by hand: a correction, or a balance brought over from another site.
// One copy for workforce-compute (which writes the ledger) and the Back Office (which shows the
// same refusals before the round trip). Pure, no imports: node --test (src/staff/holidayAdjust.test.js).
//
// WHY (HR feedback, 23 Nov 2026): someone moved from one site to another and their accrued holiday
// stayed behind at the old site. The only button was Run accrual, so HR could not carry the hours
// over. The ledger (wf_holiday_accrual) has always allowed kind 'adjustment'; nothing wrote one.
// An adjustment is a new ledger line with who, when and why. Nothing is ever edited or deleted.

const round2 = (n) => Math.round(Number(n) * 100) / 100;
const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
const digits = (s) => String(s || '').replace(/\D/g, '').slice(-10);

export const MAX_ADJUST_HOURS = 500;

/** Why a hand correction cannot be saved, in words, or null. hours may be negative (take away). */
export function adjustProblem({ hours, note } = {}) {
  const h = Number(hours);
  if (!Number.isFinite(h) || round2(h) === 0) return 'Enter the hours to add or take away.';
  if (Math.abs(h) > MAX_ADJUST_HOURS) return `That is more than ${MAX_ADJUST_HOURS} hours. Check the number.`;
  if (norm(note).length < 3) return 'Say why, so the record explains itself later.';
  return null;
}

/** Why a move between sites cannot be saved, in words, or null. */
export function transferProblem({ hours, sourceBalance, sourceSite } = {}) {
  const h = Number(hours);
  if (!Number.isFinite(h) || round2(h) <= 0) return 'Enter the hours to bring over.';
  if (h > MAX_ADJUST_HOURS) return `That is more than ${MAX_ADJUST_HOURS} hours. Check the number.`;
  const left = round2(sourceBalance || 0);
  if (round2(h) > left + 0.005) return `Only ${left.toFixed(1)} hours are left at ${sourceSite || 'that site'}.`;
  return null;
}

/**
 * The company's other records that are the same person as `me`: linked (person_id), or the same
 * email, or the same mobile, or the same name AND date of birth. A name alone is never enough to
 * move hours. Leavers count (the usual case: they left the old site). records: wf_staff rows.
 */
export function samePersonRecords(me, records) {
  if (!me) return [];
  const myEmail = norm(me.email), myPhone = digits(me.mobile), myName = norm(me.name), myDob = String(me.dob || '').slice(0, 10);
  const out = [];
  for (const r of records || []) {
    if (!r || r.id === me.id) continue;
    let why = null;
    if (me.person_id && r.person_id && r.person_id === me.person_id) why = 'linked record';
    else if (myEmail && norm(r.email) === myEmail) why = 'same email';
    else if (myPhone.length >= 7 && digits(r.mobile) === myPhone) why = 'same mobile';
    else if (myName && myDob && norm(r.name) === myName && String(r.dob || '').slice(0, 10) === myDob) why = 'same name and date of birth';
    if (why) out.push({ ...r, why });
  }
  return out;
}

/** The two ledger notes for a move, so each site's line says where the hours went or came from. */
export function transferNotes({ hours, fromSite, toSite, note } = {}) {
  const h = round2(hours).toFixed(2);
  const tail = norm(note) ? `. ${String(note).trim()}` : '';
  return {
    out: `Moved ${h}h to ${toSite || 'another site'}${tail}`,
    in: `Brought over ${h}h from ${fromSite || 'another site'}${tail}`,
  };
}

/** Sum of a person's ledger rows (hours). rows: [{ accrued_hours }]. */
export function ledgerBalance(rows) {
  return round2((rows || []).reduce((a, r) => a + (Number(r.accrued_hours ?? r.accruedHours) || 0), 0));
}
