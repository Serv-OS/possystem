// src/lib/posClockIn.js
//
// The till's side of clocking. Talks to workforce-clock, which owns shift
// linking, the pay-rate snapshot, statutory breaks and the pay maths — the same
// routine the clock tablet and the staff app both use. Nothing here computes
// money or writes a timesheet directly.
//
// The PIN travels with the request because workforce-clock validates it
// server-side against staff_members for that venue; the till never decides who
// somebody is for the purposes of pay.

import { supabase, isMock, ensureAuthToken } from './supabase';

const FN = () => `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/workforce-clock`;

async function call(body) {
  if (isMock || !supabase) return { ok: false, error: 'offline' };
  let token = null;
  try { token = await ensureAuthToken(); } catch { /* fall through to session */ }
  if (!token) {
    const { data } = await supabase.auth.getSession();
    token = data?.session?.access_token || null;
  }
  if (!token) return { ok: false, error: 'no session' };
  const res = await fetch(FN(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, error: j?.error || `HTTP ${res.status}`, status: res.status };
  return { ok: true, ...j };
}

/**
 * Clock state for a member about to be signed in, plus whether this venue wants
 * the till to offer a shift start. Never throws: a clock outage must not stop
 * anybody using the POS.
 */
export async function clockStatusForPos({ locationId, pin }) {
  if (!locationId || !pin) return null;
  try {
    const r = await call({ location_id: locationId, pin, action: 'status' });
    return r?.ok ? r : null;
  } catch { return null; }
}

/** Punch for a POS-signed-in member. `kind` is 'in' | 'out'. */
export async function clockPunchForPos({ locationId, pin }, kind) {
  if (!locationId || !pin) return { ok: false, error: 'missing venue or PIN' };
  try {
    return await call({ location_id: locationId, pin, action: kind });
  } catch (e) {
    return { ok: false, error: e?.message || 'Could not reach the clock' };
  }
}
