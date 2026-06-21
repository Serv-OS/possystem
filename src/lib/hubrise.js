// src/lib/hubrise.js
//
// Thin client wrappers around the hubrise-* edge functions. supabase.functions.invoke
// auto-attaches the signed-in BO user's JWT; the edge functions enforce location access
// and hold the HubRise access token server-side (it never reaches the browser).

import { supabase } from './supabase';

async function call(fn, body) {
  const { data, error } = await supabase.functions.invoke(fn, { body });
  if (error) {
    let msg = error.message;
    try { const ctx = await error.context?.json?.(); if (ctx?.error) msg = ctx.error; } catch { /* ignore */ }
    throw new Error(msg || 'request failed');
  }
  if (data?.error) throw new Error(data.error);
  return data;
}

// ── Connection lifecycle (Back Office) ──────────────────────────────────────
export const hubriseStatus       = (locId) => call('hubrise-connect', { action: 'status', ops_location_id: locId });
export const hubriseOAuthStart   = (locId, locationName) => call('hubrise-connect', { action: 'oauth_start', ops_location_id: locId, location_name: locationName || '' });
export const hubriseConnectToken = (locId, accessToken) => call('hubrise-connect', { action: 'connect_token', ops_location_id: locId, access_token: accessToken });
export const hubriseSetPolicy    = (locId, patch) => call('hubrise-connect', { action: 'set_policy', ops_location_id: locId, ...patch });
export const hubriseSetMenus     = (locId, menuIds) => call('hubrise-connect', { action: 'set_policy', ops_location_id: locId, menu_ids: menuIds });
export const hubriseRegister     = (locId) => call('hubrise-connect', { action: 'register_callbacks', ops_location_id: locId });
export const hubriseDisconnect   = (locId) => call('hubrise-connect', { action: 'disconnect', ops_location_id: locId });

// ── Catalog + inventory ─────────────────────────────────────────────────────
export const hubrisePushCatalog  = (locId) => call('hubrise-catalog-push', { ops_location_id: locId });
export const hubriseResyncStock  = (locId) => call('hubrise-inventory-push', { ops_location_id: locId, full: true });
export const hubrisePushStock    = (locId, changes) => call('hubrise-inventory-push', { ops_location_id: locId, changes });

// ── Order status push-back (OrdersHub) ──────────────────────────────────────
// action: accept | prep | ready | collected | reject | cancel
export const hubrisePushStatus   = (locId, ref, action, opts = {}) =>
  call('hubrise-order-status', { ops_location_id: locId, ref, action, ...opts });

// ── Local "is this venue connected?" cache (gates best-effort instant pushes) ──
const CK = (locId) => `rpos-hubrise-connected-${locId}`;
export function setHubriseConnected(locId, on) {
  try { localStorage.setItem(CK(locId), on ? '1' : '0'); } catch { /* ignore */ }
}
export function isHubriseConnected(locId) {
  try { return localStorage.getItem(CK(locId)) === '1'; } catch { return false; }
}
