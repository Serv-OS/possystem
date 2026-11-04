// src/staff/crossSiteRota.js: the rota for a person who works at several sites (5.12.38).
// Pure, imports only wfClash.js: node --test.
//
// Peter, 2 Nov 2026: "one member of staff might work at 2 sites or 3 sites". A person's records at
// different sites are linked (wf_staff.person_id, 20261111a). The rota at one site now sees their
// shifts at the others: a shift that overlaps one there is refused, and the week shows how many hours
// they already have elsewhere and when the week goes into overtime (US, over 40).

import { spanOf } from './wfClash.js';
import { hhmmText } from '../../supabase/functions/_shared/venueDates.js';

const LIVE = new Set(['draft', 'published']);
const hoursOfShift = (s) => {
  const [a, b] = spanOf(s.start, s.finish);
  return Math.max(0, (b - a) / 60 - (Number(s.breakMins) || 0) / 60);
};
const r2 = (n) => Math.round(n * 100) / 100;
const fmtH = (n) => `${r2(n)}`.replace(/\.0+$/, '');

/**
 * The person's shifts at their other sites, in this site's terms: staffId is THIS site's record of
 * the same person, so every rota check that keys on staffId sees them. Only draft and published.
 *   records    wf_staff rows at other sites: { id, person_id, location_id }
 *   shifts     wf_shifts rows of those records (mapped: { id, staffId, date, start, finish, breakMins, status })
 *   hereStaff  this site's staff ({ id, personId })
 *   siteNames  { location_id: name }
 */
export function mapLinkedShifts({ records = [], shifts = [], hereStaff = [], siteNames = {} } = {}) {
  const hereOf = {};
  for (const s of hereStaff || []) if (s?.personId) hereOf[s.personId] = s.id;
  const rec = {};
  for (const r of records || []) if (r?.id) rec[r.id] = r;
  const out = [];
  for (const sh of shifts || []) {
    const r = rec[sh?.staffId];
    const here = r && hereOf[r.person_id];
    if (!here || !LIVE.has(sh.status)) continue;
    out.push({
      id: `other-${sh.id}`, staffId: here, otherStaffId: sh.staffId, date: sh.date, start: sh.start, finish: sh.finish,
      breakMins: sh.breakMins || 0, status: sh.status, site: siteNames[r.location_id] || 'another site', locationId: r.location_id, otherSite: true,
    });
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.start < b.start ? -1 : 1));
}

/** The other site shift this one would overlap, or null. Touching ends are fine (split shifts). */
export function otherSiteClash(otherShifts, staffId, dateIso, start, finish) {
  const [s1, f1] = spanOf(start, finish);
  return (otherShifts || []).find((x) => {
    if (x.staffId !== staffId || x.date !== dateIso) return false;
    const [s2, f2] = spanOf(x.start, x.finish);
    return s1 < f2 && s2 < f1;
  }) || null;
}

/** The words for a refused overlap. */
export function otherSiteClashWords(clash, dayLabel, country = 'UK') {
  if (!clash) return '';
  // 5.12.57 batch 8: a US venue reads "5:00 PM to 11:00 PM"; a UK one reads the times as given.
  return `Clashes with their ${hhmmText(clash.start, country)} to ${hhmmText(clash.finish, country)} shift at ${clash.site}${dayLabel ? ` on ${dayLabel}` : ''}. Change the times, or move that shift first.`;
}

/**
 * The week line for a person with hours at other sites, or null when they have none:
 *   "Jane also has 12 h at Daybreak this week (44 h in all): 4 h overtime."
 * weekly: 40 for the US federal rule; null for the UK (no overtime part).
 */
export function weekHoursLine({ name, staffId, hereShifts = [], otherShifts = [], weekly = null, fromIso, toIso }) {
  const inWeek = (s) => s.staffId === staffId && LIVE.has(s.status) && (!fromIso || s.date >= fromIso) && (!toIso || s.date <= toIso);
  const others = (otherShifts || []).filter(inWeek);
  if (!others.length) return null;
  const other = others.reduce((t, s) => t + hoursOfShift(s), 0);
  const here = (hereShifts || []).filter(inWeek).reduce((t, s) => t + hoursOfShift(s), 0);
  const total = here + other;
  const sites = [...new Set(others.map((s) => s.site))].join(' and ');
  const first = String(name || 'They').split(' ')[0];
  let line = `${first} also has ${fmtH(other)} h at ${sites} this week (${fmtH(total)} h in all)`;
  if (weekly && total > weekly + 0.001) line += `: ${fmtH(total - weekly)} h overtime`;
  return `${line}.`;
}

/**
 * Other site shifts for the rota rules (checkProposed, fillCoverage): the same shape as this site's
 * shifts, in a section no section here is called, so they block overlaps, rest and weekly hours but
 * never count as cover at this site.
 */
export function asRuleShifts(otherShifts) {
  return (otherShifts || []).map((s) => ({ staffId: s.staffId, date: s.date, start: s.start, finish: s.finish, breakMins: s.breakMins || 0, section: `(at ${s.site})`, otherSite: true }));
}
