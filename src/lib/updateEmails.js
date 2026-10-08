// src/lib/updateEmails.js: the Company Admin screen's calls to the update-emails-admin edge
// function (8 Oct 2026). The screen only asks; the function decides who may send (ServOS staff
// with the second sign in step done), picks the recipients again, renders the email again and
// writes the rows (public.update_emails, 20261008b_OPS_update_emails.sql).
//
//   recipients { company_ids?, owners_only?, include_staff? }   -> { recipients, count, companies, left }
//   test       { subject, body_md }                              -> { sent, to }   (the caller only)
//   send       { subject, body_md, company_ids?, owners_only?, include_staff?, expect_count, broadcast_id }
//                                                                -> { broadcast_id, sent, failed, skipped }
//   history    {}                                                -> { rows, companies }
//
// Same shape as callVenueMessages in admin/sections/AdminVenueMessages.jsx.
import { supabase } from './supabase';
import { NEEDS_UPDATE_LINE } from './updateEmailRules';

const FUNCTIONS_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1`;

export async function callUpdateEmails(action, payload = {}) {
  if (!supabase) throw new Error('Not connected to the database.');
  const { data: session } = await supabase.auth.getSession();
  const token = session?.session?.access_token;
  if (!token) throw new Error('Sign in again, then try once more.');
  let res;
  try {
    res = await fetch(`${FUNCTIONS_URL}/update-emails-admin`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ action, ...payload }),
    });
  } catch {
    // Also what an undeployed function looks like from a browser (its 404 carries no CORS header).
    throw new Error('Could not reach the email service. Check the connection. If this is the first use, the update-emails-admin function has to be deployed first.');
  }
  const j = await res.json().catch(() => ({}));
  // The function is not deployed yet (404 from the gateway), or the table is not there (409).
  if (res.status === 404 || j.code === 'not_ready') { const e = new Error(NEEDS_UPDATE_LINE); e.notReady = true; throw e; }
  if (!res.ok || j.error) { const e = new Error(j.message || j.error || `HTTP ${res.status}`); e.code = j.code; e.count = j.count; throw e; }
  return j;
}

export const newBroadcastId = () => (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : null);
