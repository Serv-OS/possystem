// src/lib/locationAdmin.js
//
// Back Office writes to the PLATFORM locations row.
//
// Migration 20260805c Section B dropped `locations_anon_update` and revoked
// anon's UPDATE grant, because that policy was USING(true) WITH CHECK(true) —
// any holder of the anon key (which ships in the browser bundle) could rewrite
// every column of every venue. So the browser no longer writes that table at
// all: every write goes through the `location-admin` edge function under
// service_role, which verifies the signed-in user may access the location and
// enforces a column whitelist.
//
// CALLERS PASS THE OPS LOCATION ID, never a platform id. The function resolves
// the platform row itself (ops_location_id first, then legacy id) — trusting a
// client's claim about which ops location a platform row maps to is the exact
// pivot the dropped policy exposed.
//
// Each helper returns { data, error } so the call sites keep the same
// `if (err) / if (!data)` shape a PostgREST write gave them, and reports the
// outcome to saveHealth either way.

import { supabase } from './supabase';
import { reportSave } from './saveHealth';

// supabase-js turns a non-2xx invoke into a FunctionsHttpError whose message is
// a generic "non-2xx status code" — the real reason is in the response body.
// Unwrap it, or every server-side rejection reaches the UI as the same useless
// string and the call sites' slug / missing-migration hints stop matching.
async function unwrapError(error) {
  if (!error) return null;
  try {
    const body = await error.context?.json?.();
    const msg = body?.error || body?.message;
    if (msg) {
      // Keep the message EXACTLY the server's code when there's nothing to add
      // (LocationSettings matches on 'slug_taken'); append the offending field
      // and reason when the server named them.
      const detail = [body.field, body.detail].filter(Boolean).join(': ');
      return new Error(detail ? `${msg} — ${detail}` : String(msg));
    }
  } catch { /* body wasn't JSON — fall through to the transport error */ }
  return error;
}

async function call(entity, body) {
  if (!supabase) {
    const error = new Error('Not connected — sign in to the back office again.');
    reportSave(entity, error);
    return { data: null, error };
  }
  if (!body.ops_location_id) {
    const error = new Error('No location resolved for this session.');
    reportSave(entity, error);
    return { data: null, error };
  }
  let res;
  try {
    res = await supabase.functions.invoke('location-admin', { body });
  } catch (e) {
    reportSave(entity, e);
    return { data: null, error: e };
  }
  // A 2xx body can still carry { error } — that is a failed save, not a saved one.
  const failure = (await unwrapError(res.error))
    || (res.data?.error ? new Error(String(res.data.error)) : null);
  reportSave(entity, failure);
  return failure ? { data: null, error: failure } : { data: res.data, error: null };
}

/**
 * Whitelisted column write. `patch` keys must all be on the function's
 * LOCATION_FIELDS list — an unknown or denied key rejects the whole call
 * (400 unknown_field) rather than being silently dropped.
 * Resolves { data: <echo of the patched columns>, error }.
 */
export async function saveLocation(opsLocationId, patch) {
  const { data, error } = await call('location', {
    action: 'save_location',
    ops_location_id: opsLocationId,
    patch,
  });
  return { data: data?.location ?? null, error };
}

/**
 * Shallow server-side MERGE into online_branding. Menu appearance and the
 * Review card both write this jsonb; merging on the server means neither can
 * clobber the other's keys from a stale snapshot.
 * Resolves { data: <merged online_branding>, error }.
 */
export async function patchBranding(opsLocationId, patch) {
  const { data, error } = await call('menu appearance', {
    action: 'patch_branding',
    ops_location_id: opsLocationId,
    patch,
  });
  return { data: data?.online_branding ?? null, error };
}

/**
 * Force challenge_21_counter to 0. The caller cannot supply a value — an
 * arbitrary counter is a licensing knob (set it high and the prompt fires
 * early, low and it never fires).
 */
export async function resetChallenge21Counter(opsLocationId) {
  const { data, error } = await call('Challenge 21 counter', {
    action: 'reset_challenge21_counter',
    ops_location_id: opsLocationId,
  });
  return { data: data?.ok ? { counter: data.counter ?? 0 } : null, error };
}
