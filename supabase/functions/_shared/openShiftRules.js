// supabase/functions/_shared/openShiftRules.js
//
// v5.11.101: OPEN SHIFTS AND SWAPS, the rules. A manager puts a shift on the rota with nobody on it
// (an open shift); a member of staff says "I can't do this shift" (it opens to everyone in their
// position, or is offered to one named colleague). Someone takes it. A venue setting decides
// whether that happens straight away or waits for a manager.
//
// WHO DECIDES: the database (20261031a_OPS_wf_open_shifts.sql, wf_shift_claim and wf_swap_decide)
// is the judge, inside one locked transaction, so two people tapping Claim at once can never both
// win. This file is the SAME rules in JavaScript, so the staff app can say why a shift cannot be
// taken before anyone taps, and so the texts read the same everywhere. The two are proven against
// one list of cases (supabase/tests/wf_open_shifts/cases.json): node:test runs this file over it
// (src/lib/openShiftRules.test.js) and the local Postgres harness runs the SQL over it (run.mjs).
//
// PURE: no imports. Times are the venue's wall clock: dates 'YYYY-MM-DD', times 'HH:MM'.

export const SWAP_MODES = ['manager', 'instant'];

/** The venue's setting: 'manager' (a manager approves every claim and swap, the default) or 'instant'. */
export function swapMode(settingsBag) {
  const m = settingsBag?.shiftSwaps?.approval;
  return m === 'instant' ? 'instant' : 'manager';
}

/** The most hours a week someone can reach by claiming, or null (no cap). */
export function claimHoursCap(settingsBag) {
  const n = Number(settingsBag?.shiftSwaps?.maxWeeklyHours);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 168) : null;
}

const toMins = (hhmm) => { const [h, m] = String(hhmm || '0:0').split(':').map(Number); return (h || 0) * 60 + (m || 0); };
const ordinal = (iso) => { const [y, mo, d] = String(iso).split('-').map(Number); return Math.floor(Date.UTC(y, (mo || 1) - 1, d || 1) / 86400000); };
/** [start, end) in minutes since 1970 on the wall clock; an end at or before the start is the next day. */
export function spanMins(date, start, finish) {
  const s = toMins(start); let f = toMins(finish); if (f <= s) f += 1440;
  const base = ordinal(date) * 1440;
  return [base + s, base + f];
}
/** Paid hours of a shift: its span less its break. */
export function shiftHours(sh) {
  if (sh?.computedHours != null && Number.isFinite(Number(sh.computedHours))) return Number(sh.computedHours);
  const [a, b] = spanMins(sh.date, sh.start, sh.finish);
  return Math.max(0, (b - a - (Number(sh.breakMins) || 0)) / 60);
}
/** Monday of the week of a date. */
export function weekMonday(iso) {
  const o = ordinal(iso); const dow = ((o + 3) % 7 + 7) % 7; // 1970-01-01 was a Thursday: Mon = 0
  const d = new Date((o - dow) * 86400000);
  return d.toISOString().slice(0, 10);
}
const DOW = ['Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays', 'Sundays'];
const dayIdx = (iso) => { const o = ordinal(iso); return ((o + 3) % 7 + 7) % 7; };   // Mon=0, as wf_availability

/** "Tue 28 Oct" (UK) or "Tue Oct 28" (US). */
export function dayWords(iso, country = 'UK') {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return String(iso || '');
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()];
  const mo = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()];
  return country === 'US' ? `${wd} ${mo} ${d.getUTCDate()}` : `${wd} ${d.getUTCDate()} ${mo}`;
}
/** "17:00" (UK) or "5:00pm" (US). */
export function timeWords(hhmm, country = 'UK') {
  const m = toMins(hhmm) % 1440;
  const h = Math.floor(m / 60), mi = String(m % 60).padStart(2, '0');
  if (country !== 'US') return `${String(h).padStart(2, '0')}:${mi}`;
  return `${((h + 11) % 12) + 1}:${mi}${h < 12 ? 'am' : 'pm'}`;
}
/** "Tue 28 Oct, 17:00 to 23:00" */
export function shiftWords(sh, country = 'UK') {
  return `${dayWords(sh.date, country)}, ${timeWords(sh.start, country)} to ${timeWords(sh.finish, country)}`;
}

/** Words for every code the database can answer (wf_shift_claim, wf_shift_drop, wf_swap_cancel,
 *  wf_swap_decline, wf_swap_decide). claimProblem builds fuller words where it knows more. */
export const PROBLEM_WORDS = {
  not_published: 'This shift is not on the published rota.',
  past: 'This shift has already started.',
  not_on_team: 'You are not on the team at this venue.',
  onboarding: 'Your onboarding is not finished yet. Finish it in the staff app (Tasks) first.',
  own: 'This is already your shift.',
  role: 'This shift needs someone in its position.',
  not_offered: 'This shift is no longer up for grabs.',
  offered_elsewhere: 'This shift was offered to someone else.',
  taken: 'Someone has already asked for this shift. A manager is deciding.',
  overlap: 'It overlaps another of your shifts.',
  leave: 'You are booked off on leave that day.',
  unavailable: 'You marked yourself unavailable that day. Change your availability first.',
  hours_cap: 'That would take you over the most hours a week.',
  not_yours: 'That is not your shift or your request.',
  already_up: 'This shift is already up for someone to take.',
  colleague: 'That colleague cannot take this shift (not active here, or a different position).',
  not_found: 'That request is no longer there.',
  not_pending: 'That request has already been decided.',
  shift_gone: 'The shift was deleted, so the request is closed.',
  self: 'You cannot decide a swap you are part of. Ask another manager.',
};

/** The same codes in a manager's words (about the person who asked, not to them). */
export const MANAGER_WORDS = {
  past: 'The shift has already started.',
  not_on_team: 'They are no longer on the team here.',
  onboarding: 'Their onboarding is not finished yet.',
  role: 'They are not in this shift\'s position.',
  not_offered: 'The shift has changed hands since they asked.',
  overlap: 'They now have another shift that overlaps it.',
  leave: 'They are booked off on leave that day.',
  unavailable: 'They are marked unavailable that day.',
  hours_cap: 'It would take them over the most hours a week.',
};

/** The words for a code, for an answer from the database. who: 'staff' (default) or 'manager'. */
export function problemText(code, who = 'staff') {
  if (who === 'manager' && MANAGER_WORDS[code]) return MANAGER_WORDS[code];
  return PROBLEM_WORDS[code] || 'That could not be done. Refresh and try again.';
}

/**
 * Why `claimer` cannot take `shift`, or null when they can. The FIRST reason, in this order (the
 * database checks in the same order and answers with the same code):
 *   not_published, past, not_on_team, onboarding, own, role, not_offered, offered_elsewhere, taken,
 *   overlap, leave, unavailable, hours_cap
 *
 * @param {object} c
 * @param {object} c.shift      { id, locationId, staffId|null, roleKey, date, start, finish, breakMins, status, computedHours }
 * @param {object} c.claimer    { id, locationId, status, roleKey }
 * @param {object|null} c.request  the shift's live request: { id, kind:'drop'|'offer'|'claim', status:'open'|'pending', fromStaffId, toStaffId }
 * @param {object[]} c.theirShifts  the claimer's other shifts (draft or published) around the date
 * @param {object[]} c.leave        the claimer's time off rows { status, startDate, endDate }
 * @param {object|null} c.availability  the claimer's wf_availability row { perDay:[{day,state}] }
 * @param {object} c.settings   wf_venue_settings.settings
 * @param {string} c.todayIso   the venue's date now
 * @param {number} c.nowMin     the venue's minute of the day now
 * @param {string} [c.roleLabel] the position's name, for the words
 * @param {string} [c.country]  'UK' | 'US' (the words for days and times)
 * @param {number|boolean} [c.onboardingOpen]  open onboarding steps (_shared/onboardingOpen.js): the
 *                              rota will not schedule them, so they cannot claim either
 * @returns {{code:string, text:string}|null}
 */
export function claimProblem(c) {
  const { shift, claimer, request } = c;
  const country = c.country || 'UK';
  if (!shift || shift.status !== 'published') return { code: 'not_published', text: 'This shift is not on the published rota.' };
  const [s0, s1] = spanMins(shift.date, shift.start, shift.finish);
  const now = ordinal(c.todayIso) * 1440 + (Number(c.nowMin) || 0);
  if (s0 <= now) return { code: 'past', text: 'This shift has already started.' };
  if (!claimer || claimer.status !== 'active' || claimer.locationId !== shift.locationId) {
    return { code: 'not_on_team', text: 'You are not on the team at this venue.' };
  }
  if (c.onboardingOpen) return { code: 'onboarding', text: PROBLEM_WORDS.onboarding };
  if (shift.staffId && shift.staffId === claimer.id) return { code: 'own', text: 'This is already your shift.' };
  if (shift.roleKey && claimer.roleKey !== shift.roleKey) {
    return { code: 'role', text: `This shift is for ${c.roleLabel || shift.roleKey}. It needs someone in that position.` };
  }
  if (shift.staffId) {
    // Someone's shift: only takeable while they have it up (dropped to everyone, or offered to you).
    if (!request || (request.status !== 'open' && request.status !== 'pending') || request.fromStaffId !== shift.staffId) {
      return { code: 'not_offered', text: PROBLEM_WORDS.not_offered };
    }
    if (request.kind === 'offer' && request.toStaffId && request.toStaffId !== claimer.id) {
      return { code: 'offered_elsewhere', text: 'This shift was offered to someone else.' };
    }
  }
  if (request && request.status === 'pending') {
    return { code: 'taken', text: 'Someone has already asked for this shift. A manager is deciding.' };
  }
  for (const o of c.theirShifts || []) {
    if (o.id === shift.id || o.staffId !== claimer.id) continue;
    if (o.status !== 'published' && o.status !== 'draft') continue;
    const [b0, b1] = spanMins(o.date, o.start, o.finish);
    if (s0 < b1 && b0 < s1) return { code: 'overlap', text: `It overlaps your shift on ${shiftWords(o, country)}.` };
  }
  const leave = (c.leave || []).find(l => l.status === 'approved' && l.startDate <= shift.date && shift.date <= l.endDate);
  if (leave) return { code: 'leave', text: 'You are booked off on leave that day.' };
  const state = (c.availability?.perDay || []).find(x => Number(x.day) === dayIdx(shift.date))?.state;
  if (state === 'unavailable') {
    return { code: 'unavailable', text: `You marked yourself unavailable on ${DOW[dayIdx(shift.date)]}. Change your availability first.` };
  }
  const cap = claimHoursCap(c.settings);
  if (cap) {
    const mon = weekMonday(shift.date);
    const sun = new Date((ordinal(mon) + 6) * 86400000).toISOString().slice(0, 10);
    const week = (c.theirShifts || [])
      .filter(o => o.id !== shift.id && o.staffId === claimer.id && (o.status === 'published' || o.status === 'draft') && o.date >= mon && o.date <= sun)
      .reduce((t, o) => t + shiftHours(o), 0);
    const total = Math.round((week + shiftHours(shift)) * 100) / 100;
    if (total > cap + 0.001) return { code: 'hours_cap', text: `That would take you to ${total}h this week, over the ${cap}h most a week.` };
  }
  return null;
}

/** Who should hear about an open shift: active staff at the venue in the position, not the owner. */
export function eligibleStaff(shift, staff, ownerId = null) {
  return (staff || []).filter(s => s && s.status === 'active' && s.id !== ownerId
    && s.locationId === shift.locationId && (!shift.roleKey || s.roleKey === shift.roleKey));
}

// ── The texts. Plain words, no dashes, no exclamation marks. ────────────────
const venueOf = (v) => String(v || '').trim() || 'your venue';
export const textOpenShift = (venue, sh, country) => `${venueOf(venue)}: an open shift is up for grabs, ${shiftWords(sh, country)}. Open the staff app to claim it.`;
export const textOffered = (venue, fromName, sh, country) => `${venueOf(venue)}: ${String(fromName || 'A colleague').split(' ')[0]} has offered you their shift, ${shiftWords(sh, country)}. Open the staff app to accept or decline.`;
export const textTaken = (venue, takerName, sh, country) => `${venueOf(venue)}: ${String(takerName || 'A colleague').split(' ')[0]} is now on your shift, ${shiftWords(sh, country)}. You are off it.`;
export const textYours = (venue, sh, country) => `${venueOf(venue)}: the shift ${shiftWords(sh, country)} is yours. See it in the staff app.`;
export const textAsked = (venue, sh, country) => `${venueOf(venue)}: your request for the shift ${shiftWords(sh, country)} is with a manager. We will text you when they decide.`;
export const textDeclined = (venue, sh, country) => `${venueOf(venue)}: a manager declined the change to the shift ${shiftWords(sh, country)}. Nothing has changed on the rota.`;
export const textOfferDeclined = (venue, name, sh, country) => `${venueOf(venue)}: ${String(name || 'Your colleague').split(' ')[0]} cannot take your shift, ${shiftWords(sh, country)}. It is still yours. You can offer it to someone else in the staff app.`;
export const textStillUp = (venue, name, sh, country) => `${venueOf(venue)}: a manager declined ${String(name || 'a colleague').split(' ')[0]} taking your shift, ${shiftWords(sh, country)}. It is still yours and still up for someone else to take.`;
