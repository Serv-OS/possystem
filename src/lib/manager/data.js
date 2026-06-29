// src/lib/manager/data.js — Manager app client data layer. Talks to the manager-snapshot edge fn
// (requireToken + location-fenced); the pure engines (floor/team/...) classify the result.
import { supabase } from '../supabase.js';

/** One-call snapshot for the paired venue: { ok, money, floor[], team{}, kitchen{}, ops{}, venueName, tz }. */
export async function fetchManagerSnapshot(opsLocationId) {
  if (!supabase || !opsLocationId) return { ok: false, error: 'offline' };
  const { data, error } = await supabase.functions.invoke('manager-snapshot', { body: { action: 'snapshot', ops_location_id: opsLocationId } });
  if (error) return { ok: false, error: error.message };
  return data;
}

/** Manager write actions (approvals) via the double-fenced manager-approve edge fn. The approver is
 *  proven by their PIN (re-verified server-side against staff_members — never a client-supplied id) and
 *  must be approval-capable; the device must be authorised for the venue. The PIN gives accountable,
 *  tamper-evident audit attribution on a shared device.
 *  action: 'timesheet.approve' | 'timeoff.decide' (extra: { decision:'approved'|'denied' }). */
export async function managerApprove(opsLocationId, pin, action, targetId, extra = {}) {
  if (!supabase || !opsLocationId) return { ok: false, error: 'offline' };
  const { data, error } = await supabase.functions.invoke('manager-approve', {
    body: { action, ops_location_id: opsLocationId, pin: String(pin || ''), target_id: targetId, ...extra },
  });
  if (error) return { ok: false, error: error.message };
  return data;
}
