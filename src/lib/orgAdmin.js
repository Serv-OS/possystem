// src/lib/orgAdmin.js: the Company Admin screen's calls to the org-admin edge function (5 Nov 2026).
// The screen only asks; the function decides who may delete (ServOS staff with the second sign in
// step done), checks the typed name again and runs the wipe under the service role.
//
//   preview          { org_id }                     -> { org, locations, ops, platform, logins, ... }   nothing changes
//   delete_org       { org_id, name_typed }         -> the report of what went
//   preview_location { location_id }                -> { location, ops, platform, ... }
//   delete_location  { location_id, name_typed }    -> the report of what went
//
// Same shape as callUpdateEmails in lib/updateEmails.js.
import { supabase } from './supabase';
import { NEEDS_UPDATE_LINE } from './orgWipeRules';

const FUNCTIONS_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1`;

export async function callOrgAdmin(action, payload = {}) {
  if (!supabase) throw new Error('Not connected to the database.');
  const { data: session } = await supabase.auth.getSession();
  const token = session?.session?.access_token;
  if (!token) throw new Error('Sign in again, then try once more.');
  let res;
  try {
    res = await fetch(`${FUNCTIONS_URL}/org-admin`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ action, ...payload }),
    });
  } catch {
    // Also what an undeployed function looks like from a browser (its 404 carries no CORS header).
    throw new Error('Could not reach the delete service. Check the connection. If this is the first use, the org-admin function has to be deployed first. Nothing was deleted.');
  }
  const j = await res.json().catch(() => ({}));
  if (res.status === 404 || j.code === 'not_ready') { const e = new Error(j.error || NEEDS_UPDATE_LINE); e.notReady = true; throw e; }
  if (!res.ok || j.error) { const e = new Error(j.message || j.error || `HTTP ${res.status}`); e.code = j.code; e.detail = j.detail; throw e; }
  return j;
}
