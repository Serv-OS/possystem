// src/lib/staffRoster.js
//
// Fresh POS sign-in roster (active staff with their card + method) for a location. Card matching for
// BOTH login and the fast user-switch must use CURRENT data — cards can be enrolled in Back Office
// mid-shift while a till stays logged in, so a cached list goes stale. Callers re-fetch on a miss.
import { supabase } from './supabase';

/** The paired device's ops location id (from the device-pairing localStorage record). */
export function pairedLocationId() {
  try { return JSON.parse(localStorage.getItem('rpos-device') || 'null')?.locationId || null; }
  catch { return null; }
}

/** Load active staff for sign-in: id/name/role/pin + nfcCardId + authMethod (camelCase, UI-ready). */
export async function loadStaffRoster(locationId = pairedLocationId()) {
  if (!supabase || !locationId) return [];
  const { data, error } = await supabase
    .from('staff_members')
    .select('id, name, role, pin, color, initials, permissions, active, nfc_card_id, auth_method')
    .eq('location_id', locationId).eq('active', true);
  if (error || !data) return [];
  return data.map((r) => ({
    id: r.id, name: r.name, role: r.role, pin: r.pin,
    color: r.color || '#3b82f6', initials: r.initials || (r.name || '?').slice(0, 2).toUpperCase(),
    permissions: Array.isArray(r.permissions) ? r.permissions : [],
    active: r.active, nfcCardId: r.nfc_card_id || null, authMethod: r.auth_method || 'pin',
  }));
}
