// shiftClockTarget.js: which site a staff app clock in lands at (5.12.54, UK and US).
//
// Peter, 3 Nov 2026: "when you click clock in it should clock them on the shift and location they are
// scheduled to work at." A person linked at several sites (wf_staff.person_id) has one staff app login,
// on one of their records. Before 5.12.54 every phone punch landed on that record's site.
//
// The rules (agreed 3 Nov 2026):
//   1. A published shift matches when now is from 60 minutes before its start to its finish, at ANY of
//      the person's linked sites. One match: clock in there (that site's record, shift, location check).
//      Two (back to back): the one starting soonest.
//   2. No match: ask which site, listing only their linked sites; a site whose setting is
//      clockInNoShift 'refuse' is not offered. A site the person picks is used.
//   3. One open shift at a time: already clocked in anywhere means no clock in; the answer names the
//      site and when, so the app can offer Clock out there.
// Clock out, breaks and cash tips follow the open sheet, wherever it is.
//
// PURE: no imports but payPremiums.js; runs under node --test and in Deno.

import { venueMidnightIso } from './payPremiums.js';

export const CLOCK_IN_WINDOW_MINS = 60;

const mins = (t) => { const [h, m] = String(t || '').split(':').map(Number); return (h || 0) * 60 + (m || 0); };

/** A shift's start and finish as instants (ms), in its site's time zone; a finish before the start is the next day. */
export function shiftSpan(shift, tz) {
  const day0 = Date.parse(venueMidnightIso(shift.shift_date, tz || 'Europe/London'));
  const s = mins(shift.start_time), f = mins(shift.finish_time);
  return { start: day0 + s * 60000, finish: day0 + (f > s ? f : f + 1440) * 60000 };
}

/**
 * records: [{ id, location_id, site, tz, noShift ('ask'|'refuse') }] the person's live records (login first)
 * shifts:  [{ id, staff_id, location_id, shift_date, start_time, finish_time }] published, around today
 * open:    [{ id, staff_id, location_id, clock_in }] sheets with no clock out, any of their records
 * Returns one of:
 *   { target: { staff_id, location_id, site, shift_id|null } }
 *   { openElsewhere: { staff_id, location_id, site, since } }
 *   { askSite: [{ location_id, site }] }
 *   { refused: 'no_shift' }
 */
export function pickClockTarget({ now = Date.now(), records = [], shifts = [], open = [], chosenSite = null, windowMins = CLOCK_IN_WINDOW_MINS } = {}) {
  const recById = Object.fromEntries(records.map((r) => [r.id, r]));
  const o = (open || []).find((x) => recById[x.staff_id]);
  if (o) { const r = recById[o.staff_id]; return { openElsewhere: { staff_id: o.staff_id, location_id: r.location_id, site: r.site, since: o.clock_in } }; }
  const live = (shifts || []).map((s) => {
    const r = recById[s.staff_id]; if (!r) return null;
    const sp = shiftSpan(s, r.tz);
    return now >= sp.start - windowMins * 60000 && now <= sp.finish ? { s, r, start: sp.start } : null;
  }).filter(Boolean).sort((a, b) => a.start - b.start);
  if (live.length) { const { s, r } = live[0]; return { target: { staff_id: r.id, location_id: r.location_id, site: r.site, shift_id: s.id } }; }
  const offer = records.filter((r) => r.noShift !== 'refuse');
  if (chosenSite) {
    const r = offer.find((x) => String(x.location_id) === String(chosenSite));
    if (r) return { target: { staff_id: r.id, location_id: r.location_id, site: r.site, shift_id: null } };
  }
  if (!offer.length) return { refused: 'no_shift' };
  if (offer.length === 1 && records.length === 1) return { target: { staff_id: offer[0].id, location_id: offer[0].location_id, site: offer[0].site, shift_id: null } };
  return { askSite: offer.map((r) => ({ location_id: r.location_id, site: r.site })) };
}
