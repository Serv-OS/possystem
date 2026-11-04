// src/staff/privateDetails.js (5.12.57, US basics batch 2, Peter 3 Nov 2026)
//
// Staff ID numbers and bank details (NI number, SSN last 4, tax reference, sort code, account number,
// account name) are read ONLY through the database door wf_staff_private_details (20261120a), which
// answers rows only for owners, admins and logins with Can see payroll details (Back Office, Team).
// loadStaff no longer reads them. Before 20261120a has run, the door does not exist and the old
// direct read is used, so nothing changes until the SQL runs; after it, the direct read is refused
// by the database for everyone, and the door decides.
//
// loadPrivateDetails(ids) -> { byId: { [staffId]: { niNumber, ssnLast4, taxRef, bankSortCode,
//   bankAccount, bankAccountName } }, hidden: boolean }. hidden = the caller may not see them (the
//   screens then show "Hidden" and never send those fields back, so a save cannot wipe them).

import { supabase } from '../lib/supabase';
import { privateAnswer } from './privateDetailsRules';

export { privateAnswer };

const missingDoor = (e) => /wf_staff_private_details|wf_staff_rates|PGRST202|42883|Could not find the function/i.test(`${e?.code || ''} ${e?.message || ''}`);

/** The private details of these staff records, for this login. Never throws. */
export async function loadPrivateDetails(ids) {
  const want = [...new Set((ids || []).filter(Boolean).map(String))];
  if (!want.length || !supabase) return { byId: {}, hidden: false };
  try {
    const { data, error } = await supabase.rpc('wf_staff_private_details', { p_staff_ids: want });
    if (!error) return privateAnswer(want, data);
    if (!missingDoor(error)) return { byId: {}, hidden: true };
    // Before 20261120a: the columns are still readable, exactly as before.
    const old = await supabase.from('wf_staff').select('id, ni_number, ssn_last4, tax_ref, bank_sort_code, bank_account, bank_account_name').in('id', want);
    if (old.error) return { byId: {}, hidden: true };
    return privateAnswer(want, old.data);
  } catch {
    return { byId: {}, hidden: true };
  }
}

/**
 * 5.12.59 (Peter's decision 2.5): pay rate overrides read through wf_staff_rates(location) (20261121a):
 * a site the login is assigned to, or any site of the company when the payroll door is open. Before
 * 20261121a the column is still readable and the old direct read is used. Returns
 * { byId: { [staffId]: rate }, hidden } where hidden = this site's rates are not for this login.
 */
export async function loadSiteRates(locationId) {
  if (!locationId || !supabase) return { byId: {}, hidden: false };
  try {
    const { data, error } = await supabase.rpc('wf_staff_rates', { p_location: locationId });
    if (!error) return { byId: ratesById(data), hidden: false };
    if (!missingDoor(error)) return { byId: {}, hidden: true };
    const old = await supabase.from('wf_staff').select('id, rate_override').eq('location_id', locationId);
    if (old.error) return { byId: {}, hidden: true };
    return { byId: ratesById((old.data || []).map((r) => ({ staff_id: r.id, rate_override: r.rate_override }))), hidden: false };
  } catch {
    return { byId: {}, hidden: true };
  }
}
function ratesById(rows) {
  const out = {};
  for (const r of rows || []) if (r && r.staff_id && r.rate_override != null) out[String(r.staff_id)] = Number(r.rate_override);
  return out;
}

/** The words a screen shows in place of a private value it may not see. */
export const HIDDEN_WORDS = 'Hidden (owner, admin or payroll details access only)';
