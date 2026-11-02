// src/lib/manager/data.js — Manager app client data layer. Talks to the manager-snapshot edge fn
// (requireToken + location-fenced); the pure engines (floor/team/...) classify the result.
import { supabase } from '../supabase.js';
import { withTimeout, TimeoutError } from '../withTimeout.js';
import { approveErrorMessage } from './approveError.js';

/** A snapshot that has not answered by now never will (a phone that has been asleep). */
export const MANAGER_SNAPSHOT_TIMEOUT_MS = 15000;
export const MANAGER_UNREACHABLE =
  'Could not reach ServOS. Try again, or close and reopen the app.';
/** A manager-approve READ that has not answered by now never will (writes are never timed). */
export const MANAGER_APPROVE_TIMEOUT_MS = 20000;
export const MANAGER_READ_ACTIONS = new Set(['stock.areas', 'stock.count_open', 'stock.count_sheet', 'stock.items', 'stock.recipe_card']);

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
  // 5.12.25: the same woken phone fault as the snapshot, for the READS that come through here (a
  // stock count's area list and sheet, the item list, a recipe card, and opening a count, which
  // re uses its own draft for 18 hours). Without a timer a hung call left "Pick an area" on
  // Loading for good and a tapped area doing nothing. A WRITE (an approval, a save, waste) is
  // never timed: a lost reply must not look like a failed approval.
  const sent = supabase.functions.invoke('manager-approve', {
    body: { action, ops_location_id: opsLocationId, pin: String(pin || ''), target_id: targetId, ...extra },
  });
  try {
    const { data, error } = MANAGER_READ_ACTIONS.has(action)
      ? await withTimeout(sent, MANAGER_APPROVE_TIMEOUT_MS, `Manager ${action}`)
      : await sent;
    if (error) return { ok: false, error: await approveErrorMessage(error) };
    return data;
  } catch (e) {
    return { ok: false, error: e instanceof TimeoutError ? MANAGER_UNREACHABLE : (e?.message || 'Could not reach ServOS') };
  }
}

/** Raise a purchase order for one supplier's below-par lines (Manager Kitchen tab). Same secure
 *  write path as approvals: device fence + server-verified PIN + wf_audit. lines:
 *  [{inventory_item_id, description, qty_packs}] in the supplier pack (v5.11.64; an older app sent qty in
 *  base units and the server turns that into packs). Returns { ok, po_id, reference, subtotal, tax, expected_date }. */
export async function managerRaisePO(opsLocationId, pin, { supplierId = null, supplierName = null, lines = [] } = {}) {
  if (!supabase || !opsLocationId) return { ok: false, error: 'offline' };
  const { data, error } = await supabase.functions.invoke('manager-approve', {
    body: { action: 'po.raise', ops_location_id: opsLocationId, pin: String(pin || ''), supplier_id: supplierId, supplier_name: supplierName, lines },
  });
  if (error) return { ok: false, error: await approveErrorMessage(error) };
  return data;
}

/** Receive an order on the phone (Manager Kitchen tab, v5.11.64): manager-approve po.receive books the
 *  stock, costs, goods in temperature record and order status exactly as Back Office receiving does,
 *  under the same idempotency key, so a line can never be posted twice. receipts:
 *  [{ line_id, qty_packs, unit_price? }] (a line left out is shorted and goes on a balance order);
 *  scan: { invoice_number, invoice_date, total, image_base64, media_type, raw } or null.
 *  Returns { ok, received, shorted, balance_reference, invoice_id } or { ok: true, rejected: true }. */
export async function managerReceivePO(opsLocationId, pin, { poId, accept = true, temperatureC = null, rejectionReason = null, receipts = [], scan = null } = {}) {
  if (!supabase || !opsLocationId) return { ok: false, error: 'offline' };
  if (!poId) return { ok: false, error: 'No order to receive' };
  const { data, error } = await supabase.functions.invoke('manager-approve', {
    body: {
      action: 'po.receive', ops_location_id: opsLocationId, pin: String(pin || ''), target_id: poId,
      accept, temperature_c: temperatureC, rejection_reason: rejectionReason, receipts, scan,
    },
  });
  if (error) return { ok: false, error: await approveErrorMessage(error) };
  return data;
}
