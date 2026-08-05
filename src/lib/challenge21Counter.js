// src/lib/challenge21Counter.js
//
// The TILL's Challenge 21 counter — the licensing path.
//
// Migration 20260805c Section B dropped `locations_anon_update` and revoked
// anon's UPDATE grant on the PLATFORM `locations` table. Two of the writes that
// policy carried were not Back Office writes at all but live till writes: the
// +1 on every alcohol check (store.triggerChallenge21Check) and the reset to 0
// after an ID check (Challenge21Modal). Both now go through the
// `challenge21-counter` edge function under service_role.
//
// The till does NOT pass a location the server will trust — the function
// resolves the venue from this device's own paired `devices` row. opsLocationId
// travels for diagnostics (the function logs a mismatch) and never decides
// which venue is written.
//
// Both helpers return { data, error } and NEVER throw: the callers already
// report to saveHealth and toast the operator, and a throw out of a closed-check
// path would take the sale down with it.

import { supabase, ensureAuthToken } from './supabase';

const FN_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/challenge21-counter`;

async function call(action, opsLocationId) {
  if (!supabase) {
    return { data: null, error: new Error('Not connected — this device has no server session.') };
  }
  // A POS holds no Back Office login, so ensureAuthToken mints the anonymous
  // session the function fences the device row against. Fetch rather than
  // functions.invoke: the token may have been created microseconds ago and this
  // way the header carries the one we just resolved.
  let token;
  try { token = await ensureAuthToken(); } catch (e) { return { data: null, error: e }; }
  if (!token) return { data: null, error: new Error('Could not obtain auth token') };

  try {
    const res = await fetch(FN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ action, ops_location_id: opsLocationId || null }),
    });
    let body = {};
    try { body = await res.json(); } catch { /* empty or non-JSON body */ }
    // A 2xx body can still carry { error } — that is a counter that did not move.
    if (!res.ok || body?.error) {
      return { data: null, error: new Error(body?.error || `HTTP ${res.status}`) };
    }
    return { data: body, error: null };
  } catch (e) {
    return { data: null, error: e };
  }
}

/**
 * Record one alcohol sale. The increment is atomic server-side and the SERVER
 * decides whether the ID prompt is due (against the stored trigger threshold),
 * so a till running a stale config cannot conclude it is never due.
 * Resolves { data: { ok, counter, should_prompt }, error }.
 */
export async function bumpChallenge21(opsLocationId) {
  return call('bump', opsLocationId);
}

/**
 * Zero the counter after an ID check (or a logged refusal). The caller cannot
 * supply a value — an arbitrary counter is a licensing knob.
 * Resolves { data: { ok }, error }.
 */
export async function resetChallenge21(opsLocationId) {
  return call('reset', opsLocationId);
}
