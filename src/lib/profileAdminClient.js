// src/lib/profileAdminClient.js
//
// profile-admin from the Back Office, with this app's own Supabase session (see profileAdmin.js).

import { supabase } from './supabase';
import { callProfileAdmin } from './profileAdmin';

const FUNCTIONS_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1`;

/** POST profile-admin { action, ...body } as the signed in Back Office user. No fallback. */
export function profileAdmin(action, body) {
  return callProfileAdmin(action, body, {
    functionsUrl: FUNCTIONS_URL,
    getSession: () => supabase.auth.getSession(),
  });
}
