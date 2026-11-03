// src/staff/tillSites.js: data for Back Office, Team, Sites (5.12.39). Reads the company's till users
// in the shape staff/peopleAcrossSites.js reads (status from active), and calls the three database
// doors (20261113a). Reads work before the SQL has run (no person_id: nobody linked yet).

import { supabase, isMock } from '../lib/supabase';
import { asTillRecords } from './peopleAcrossSites';
export { asTillRecords };

/** The company's till users: [{ id, name, location_id, person_id, status }]. */
export async function tillRecords(orgId) {
  if (isMock || !supabase || !orgId) return [];
  const read = (cols) => supabase.from('staff_members').select(cols).eq('org_id', orgId).limit(3000);
  let { data, error } = await read('id, name, location_id, person_id, active');
  if (error && /person_id|42703|PGRST204/i.test(`${error.code || ''} ${error.message || ''}`)) ({ data, error } = await read('id, name, location_id, active'));
  if (error) { console.warn('[team] tillRecords:', error.message); return []; }
  return asTillRecords(data);
}

/** One of the three doors; throws with the database's words (and code) when refused. */
export async function tillDoor(fn, args) {
  if (!['wf_till_add_site', 'wf_till_link', 'wf_till_unlink'].includes(fn)) throw new Error('Unknown action');
  const { data, error } = await supabase.rpc(fn, args);
  if (error) { const e = new Error(error.message || 'That did not save'); e.code = error.code; throw e; }
  return data;
}
