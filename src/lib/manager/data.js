// src/lib/manager/data.js — Manager app client data layer. Talks to the manager-snapshot edge fn
// (requireToken + location-fenced); the pure engines (floor/team/...) classify the result.
import { supabase } from '../supabase.js';
import { withTimeout, TimeoutError } from '../withTimeout.js';

/** A snapshot that has not answered by now never will (a phone that has been asleep). */
export const MANAGER_SNAPSHOT_TIMEOUT_MS = 15000;
export const MANAGER_UNREACHABLE =
  'Could not reach ServOS. Try again, or close and reopen the app.';

/** One-call snapshot for the paired venue: { ok, money, floor[], team{}, kitchen{}, ops{}, venueName, tz }. */
export async function fetchManagerSnapshot(opsLocationId) {
  if (!supabase || !opsLocationId) return { ok: false, error: 'offline' };
  // Same fault the Owner app had on 27 Sep 2026: on a woken phone this call can hang for
  // good, and the screen then sits on old figures with nothing to show for the refresh.
  try {
    const { data, error } = await withTimeout(
      supabase.functions.invoke('manager-snapshot', { body: { action: 'snapshot', ops_location_id: opsLocationId } }),
      MANAGER_SNAPSHOT_TIMEOUT_MS, 'Manager snapshot');
    if (error) return { ok: false, error: error.message };
    return data;
  } catch (e) {
    return { ok: false, error: e instanceof TimeoutError ? MANAGER_UNREACHABLE : (e?.message || 'Could not load') };
  }
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

/** Raise a purchase order for one supplier's below-par lines (Manager Kitchen tab). Same secure
 *  write path as approvals: device fence + server-verified PIN + wf_audit. lines:
 *  [{inventory_item_id, description, qty}]. Returns { ok, po_id, reference }. */
export async function managerRaisePO(opsLocationId, pin, { supplierId = null, supplierName = null, lines = [] } = {}) {
  if (!supabase || !opsLocationId) return { ok: false, error: 'offline' };
  const { data, error } = await supabase.functions.invoke('manager-approve', {
    body: { action: 'po.raise', ops_location_id: opsLocationId, pin: String(pin || ''), supplier_id: supplierId, supplier_name: supplierName, lines },
  });
  if (error) return { ok: false, error: error.message };
  return data;
}
