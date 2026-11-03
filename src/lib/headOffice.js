// src/lib/headOffice.js: the Back Office side of head office staff (5.12.56, UK and US). The rule lives
// in supabase/functions/_shared/headOffice.js (one copy for the till, the staff app, payroll and the
// Owner app); this adds the Back Office's camelCase staff shape and Workforce settings shape.
import { headOfficeOn, isHeadOffice } from '../../supabase/functions/_shared/headOffice.js';

export { headOfficeOn, headOfficePay, headOfficeCost, HEAD_OFFICE_CLOCK_WORDS } from '../../supabase/functions/_shared/headOffice.js';

/** Workforce settings (mapSettings) has the switch in its settings bag. */
export const headOfficeSwitchOn = (settings) => headOfficeOn(settings?.settings);

/** A Back Office staff member (mapStaff) who is head office at this site. */
export const isHeadOfficeStaff = (member, settings) => isHeadOffice({ head_office: member?.headOffice === true }, settings?.settings);

/** The staff who can go on the rota: everyone but head office (who are salaried and never clock in). */
export const rotaStaffOf = (staff, settings) => (staff || []).filter((m) => !isHeadOfficeStaff(m, settings));

/**
 * The Owner app company card's Head office line (5.12.56), from rollup.head_office: null when the
 * company has no head office staff. today: true on the Today view, else the period shown.
 * Returns { amount, words } where words follows the amount, e.g. "2 people · not in labour %".
 */
export function headOfficeLineView(ho, today) {
  if (!ho || typeof ho !== 'object') return null;
  const amount = Number(today ? ho.today : ho.period) || 0;
  const people = Number(ho.people) || 0;
  return { amount, words: `${people} ${people === 1 ? 'person' : 'people'} · not in labour %` };
}
