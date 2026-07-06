// src/lib/signInAudit.js
//
// Append-only staff sign-in audit → staff_auth_events (who signed in / switched, how, approved by
// whom, on which device). Best-effort: never blocks or breaks a sign-in. Shared by the login screen
// (PINScreen) and the app-wide fast-user-switch.
import { supabase, isMock } from './supabase';

export function logSignIn(staffId, method, approvedBy) {
  if (isMock || !supabase) return;
  try {
    const paired = JSON.parse(localStorage.getItem('rpos-device') || 'null');
    const location_id = paired?.locationId;
    if (!location_id) return;
    supabase.from('staff_auth_events').insert({
      location_id,
      staff_id: staffId ? String(staffId) : null,
      method,
      device_id: paired?.deviceId || paired?.id || null,
      approved_by: approvedBy ? String(approvedBy) : null,
    }).then(() => {}, () => {});
  } catch { /* best-effort */ }
}
