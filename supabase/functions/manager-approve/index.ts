// supabase/functions/manager-approve/index.ts
//
// Write actions for the ServOS Manager app (?mode=manager) that a PAIRED, ANONYMOUS device can't do
// directly (wf_* tables are RLS-fenced to Back Office users). Service-role writes, DOUBLE-fenced:
//   1) the DEVICE/caller must be authorized for the location — a claimed+active ops_device, OR a BO
//      user with user_locations, OR a super_admin (mirrors manager-snapshot's requireManager).
//   2) the ACTING OPERATOR is resolved SERVER-SIDE from the supplied PIN (re-matched against
//      staff_members for this location — never a client-supplied id) and must be approval-capable
//      — role Manager/Owner OR the manager_approvals permission.
// The PIN binds the approval to an accountable person on a shared device. Every action records that
// person as approver + appends a wf_audit row. Financial compute (tronc/accrual/payroll) stays in
// workforce-compute; this only flips approval state.
//
//   POST { action, ops_location_id, pin, target_id, decision?, heal? }   (token in Authorization)
//   actions: 'timesheet.approve' | 'timeoff.decide' (decision: 'approved' | 'denied')
//            'timesheet.clock_out' (v5.8.21: a manager clocks a member of staff out; the
//            hours/break/pay maths runs in workforce-clock via its service-role staff_id seam)
//   pin is optional for a Back Office user (user_locations / super_admin): that signed-in user
//   is the accountable operator instead.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const sb = createClient(Deno.env.get('SUPABASE_URL') ?? '', SERVICE_ROLE, { auth: { autoRefreshToken: false, persistSession: false } });
const nowIso = () => new Date().toISOString();

// v5.8.21: a signed-in Back Office user acting from the Workforce screens has no
// staff PIN. If the bearer is a user with access to the venue, they are the
// accountable operator (audit records their user id + email).
async function boOperator(req: Request, loc: string): Promise<{ id: string; name?: string; role?: string; permissions?: string[] } | null> {
  const token = (req.headers.get('Authorization') ?? '').replace('Bearer ', '');
  if (!token) return null;
  const { data: { user } } = await sb.auth.getUser(token);
  if (!user || user.is_anonymous) return null;
  const [{ data: ul }, { data: prof }] = await Promise.all([
    sb.from('user_locations').select('location_id').eq('user_id', user.id).eq('location_id', loc).maybeSingle(),
    sb.from('user_profiles').select('role, full_name').eq('id', user.id).maybeSingle(),
  ]);
  if (!ul && prof?.role !== 'super_admin') return null;
  return { id: user.id, name: (prof as any)?.full_name || user.email || 'Back Office user', role: 'manager', permissions: ['manager_approvals'] };
}

// Device/caller authorized for this location? (same fence as manager-snapshot)
async function deviceAuthorized(req: Request, loc: string): Promise<boolean> {
  const token = (req.headers.get('Authorization') ?? '').replace('Bearer ', '').trim();
  if (!token) return false;
  if (token === SERVICE_ROLE) return true;
  const { data: { user } } = await sb.auth.getUser(token);
  if (!user) return false;
  const { data: dev } = await sb.from('ops_devices').select('id').eq('device_uid', user.id).eq('location_id', loc).eq('active', true).not('claimed_at', 'is', null).maybeSingle();
  if (dev) return true;
  const [{ data: ul }, { data: prof }] = await Promise.all([
    sb.from('user_locations').select('location_id').eq('user_id', user.id).eq('location_id', loc).maybeSingle(),
    sb.from('user_profiles').select('role').eq('id', user.id).maybeSingle(),
  ]);
  return !!(ul || prof?.role === 'super_admin');
}

// Resolve the acting operator by PIN, SERVER-SIDE — never trust a client-supplied operator id. The
// shared paired device authenticates only the device; the approver's identity must be proven by their
// PIN at the moment of approval (the PIN is matched against staff_members for this location). Service
// role bypasses RLS so we read directly (the ops_pin_login RPC needs auth.uid(), which is null here).
async function resolveOperator(loc: string, pin: string): Promise<{ id: string; name?: string; role?: string; permissions?: string[] } | null> {
  if (!pin) return null;
  // Prefer an active row (active!==false treats NULL as active, matching ops_pin_login's coalesce) so a
  // stale inactive duplicate can't shadow a live PIN. PINs are effectively unique per location in practice.
  const { data: rows } = await sb.from('staff_members').select('id, name, role, permissions, active, org_id').eq('location_id', loc).eq('pin', String(pin)).limit(5);
  const op: any = (rows || []).find((r: any) => r.active !== false) || null;
  return op;
}
function canApprove(op: { role?: string; permissions?: string[] }): boolean {
  const role = String(op.role || '').toLowerCase();
  const perms = Array.isArray(op.permissions) ? op.permissions : [];
  return role === 'manager' || role === 'owner' || perms.includes('manager_approvals');
}

async function audit(loc: string, orgId: string | null, operatorId: string, name: string | undefined, action: string, entity: string, entityId: string, before: unknown, after: unknown) {
  await sb.from('wf_audit').insert({
    location_id: loc, org_id: orgId, actor_id: operatorId, actor_name: name || null,
    action, entity, entity_id: entityId, before, after,
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  let body: any; try { body = await req.json(); } catch { return json({ error: 'bad json' }, 400); }
  const { action, ops_location_id: loc, pin, target_id, decision, edit } = body || {};
  if (!loc) return json({ error: 'ops_location_id required' }, 400);
  if (!action) return json({ error: 'action required' }, 400);
  // po.raise creates a NEW entity (no target); the approve/decide actions operate on one.
  if (action !== 'po.raise' && !target_id) return json({ error: 'action and target_id required' }, 400);

  if (!(await deviceAuthorized(req, loc))) return json({ error: 'no access to this location' }, 403);
  const op = pin ? await resolveOperator(loc, pin) : await boOperator(req, loc);
  if (!op) return json({ error: pin ? 'PIN not recognised' : 'PIN required' }, 403);
  if (!canApprove(op)) return json({ error: 'not allowed to approve' }, 403);

  try {
    // ── v5.8.21 timesheet.clock_out ─────────────────────────────────────────
    // A manager ends someone's open shift (forgotten clock-out, staff gone home,
    // or a stale 190-hour sheet). The clock-out itself runs in workforce-clock
    // through its service-role staff_id seam, so the auto-break, statutory floor,
    // paid-break and pay maths stay the ONE implementation.
    if (action === 'timesheet.clock_out') {
      const { data: ts } = await sb.from('wf_timesheets')
        .select('id, org_id, staff_id, clock_in, clock_out, location_id').eq('id', target_id).eq('location_id', loc).maybeSingle();
      if (!ts) return json({ error: 'timesheet not found' }, 404);
      if (ts.clock_out) return json({ error: 'already clocked out' }, 409);
      const res = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/workforce-clock`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SERVICE_ROLE}` },
        body: JSON.stringify({ location_id: loc, staff_id: ts.staff_id, action: 'out' }),
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok || out?.error) return json({ error: out?.error || `clock-out failed (${res.status})` }, res.status >= 500 ? 502 : 400);
      await audit(loc, ts.org_id, op.id, op.name, 'timesheet.manager_clock_out', 'wf_timesheets', target_id,
        { clock_in: ts.clock_in, clock_out: null }, { clock_out: nowIso(), actual_hours: out.actualHours ?? null, by: op.name ?? op.id });
      return json({ ok: true, actualHours: out.actualHours ?? null, staff: out.staff ?? null });
    }

    if (action === 'timesheet.approve') {
      const { data: ts } = await sb.from('wf_timesheets')
        .select('id, location_id, org_id, status, clock_in, clock_out, break_taken, scheduled_hours, effective_rate')
        .eq('id', target_id).maybeSingle();
      if (!ts || ts.location_id !== loc) return json({ error: 'timesheet not found for this location' }, 404);
      const round2 = (n: number) => Math.round(n * 100) / 100;
      const patch: any = { status: 'approved', approved_by: op.id, approved_at: nowIso(), updated_at: nowIso() };
      const before = { status: ts.status, clock_in: ts.clock_in, clock_out: ts.clock_out, break_taken: ts.break_taken };
      // Optional manager edit (adjust start / end / break). Recompute hours + pay EXACTLY as clock-out
      // does (actual = grossHrs − break; pay = rate × actual; round2) so the record stays penny-correct.
      if (edit && (edit.clockIn || edit.clockOut || edit.breakMins != null)) {
        const clockIn = edit.clockIn || ts.clock_in;
        const clockOut = edit.clockOut || ts.clock_out;
        const breakTaken = edit.breakMins != null ? Math.max(0, Math.round(Number(edit.breakMins) || 0)) : (ts.break_taken || 0);
        patch.clock_in = clockIn; patch.clock_out = clockOut; patch.break_taken = breakTaken; patch.break_open_at = null;
        if (clockIn && clockOut) {
          const grossHrs = (new Date(clockOut).getTime() - new Date(clockIn).getTime()) / 3600000;
          const actual = round2(Math.max(0, grossHrs - breakTaken / 60));
          const scheduled = ts.scheduled_hours != null ? Number(ts.scheduled_hours) : null;
          patch.actual_hours = actual;
          patch.variance = scheduled != null ? round2(actual - scheduled) : null;
          patch.pay_amount = round2(actual * (ts.effective_rate != null ? Number(ts.effective_rate) : 0));
        }
      }
      const { error } = await sb.from('wf_timesheets').update(patch).eq('id', target_id).eq('location_id', loc);
      if (error) return json({ error: error.message }, 400);
      const after = { status: 'approved', clock_in: patch.clock_in ?? ts.clock_in, clock_out: patch.clock_out ?? ts.clock_out, break_taken: patch.break_taken ?? ts.break_taken };
      await audit(loc, ts.org_id, op.id, op.name, edit ? 'timesheet.edit_approve' : 'timesheet.approve', 'wf_timesheets', target_id, before, after);
      return json({ ok: true });
    }

    if (action === 'timeoff.decide') {
      const status = decision === 'approved' ? 'approved' : decision === 'denied' ? 'denied' : null;
      if (!status) return json({ error: 'decision must be approved or denied' }, 400);
      const { data: lv } = await sb.from('wf_time_off').select('id, location_id, org_id, status').eq('id', target_id).maybeSingle();
      if (!lv || lv.location_id !== loc) return json({ error: 'time-off request not found for this location' }, 404);
      const { error } = await sb.from('wf_time_off').update({ status, decided_by: op.id, decided_at: nowIso() }).eq('id', target_id).eq('location_id', loc);
      if (error) return json({ error: error.message }, 400);
      await audit(loc, lv.org_id, op.id, op.name, `timeoff.${status}`, 'wf_time_off', target_id, { status: lv.status }, { status });
      return json({ ok: true });
    }

    // Raise a purchase order per supplier from the Manager Kitchen tab. Writes the SAME
    // purchase_orders/po_lines shape as the BO Order Pad (service-role, loc-fenced, PIN-verified,
    // audited) — goods-in / costs / invoice OCR all flow through the existing stock system.
    // unit_price stays 0 at raise time (the Manager flow has no price data; receiving fills costs).
    if (action === 'po.raise') {
      const supplierId = body.supplier_id || null;
      const lines = (Array.isArray(body.lines) ? body.lines : [])
        .filter((l: any) => l && (l.inventory_item_id || l.description) && Number(l.qty) > 0)
        .slice(0, 200);
      if (!lines.length) return json({ error: 'no lines to order' }, 400);

      // TENANT FENCE: the service-role client bypasses RLS, and the FKs to suppliers/inventory_items
      // are NOT location-composite — so we MUST verify every referenced row belongs to THIS location
      // before inserting, else a manager at venue A could write a PO against venue B's supplier/items.
      if (supplierId) {
        const { data: sup } = await sb.from('suppliers').select('id').eq('id', supplierId).eq('location_id', loc).maybeSingle();
        if (!sup) return json({ error: 'supplier not found for this location' }, 400);
      }
      const itemIds = [...new Set(lines.map((l: any) => l.inventory_item_id).filter(Boolean))] as string[];
      if (itemIds.length) {
        const { data: owned } = await sb.from('inventory_items').select('id').eq('location_id', loc).in('id', itemIds);
        const ownedSet = new Set((owned ?? []).map((r: any) => r.id));
        if (itemIds.some((id) => !ownedSet.has(id))) return json({ error: 'one or more items are not from this location' }, 400);
      }

      const reference = 'MGR-' + Date.now().toString(36).toUpperCase();
      const { data: po, error: poErr } = await sb.from('purchase_orders').insert({
        location_id: loc, supplier_id: supplierId, reference, status: 'SENT',
        ordered_at: nowIso(), updated_at: nowIso(),
        expected_date: body.expected_date || null,
        notes: `Raised from the Manager app by ${op.name || 'manager'}`,
        subtotal: 0, tax: 0,
      }).select().single();
      // Generic error (don't echo the DB message — a verbatim FK error is a cross-tenant existence oracle).
      if (poErr || !po) { console.error('[po.raise] po insert', poErr?.message); return json({ error: 'could not raise the order' }, 400); }
      const lrows = lines.map((l: any, i: number) => ({
        location_id: loc, po_id: po.id, inventory_item_id: l.inventory_item_id || null,
        description: l.description || null, qty_packs: Number(l.qty) || 0, pack_qty: 1, inner_qty: 1,
        inner_unit: 'each', unit_price: 0, qty_received: 0, sort_order: i,
      }));
      const { error: lErr } = await sb.from('po_lines').insert(lrows);
      if (lErr) { await sb.from('purchase_orders').delete().eq('id', po.id); console.error('[po.raise] lines insert', lErr.message); return json({ error: 'could not raise the order' }, 400); }
      // wf_audit.org_id is NOT NULL — resolve it from the operator's staff row (fallback: locations).
      let orgId = (op as any).org_id || null;
      if (!orgId) { const { data: locRow } = await sb.from('locations').select('org_id').eq('id', loc).maybeSingle(); orgId = locRow?.org_id || null; }
      if (orgId) {
        await audit(loc, orgId, op.id, op.name, 'po.raise', 'purchase_orders', po.id, null,
          { reference, supplier_id: supplierId, supplier_name: body.supplier_name || null, lines: lrows.length });
      }
      return json({ ok: true, po_id: po.id, reference });
    }

    return json({ error: 'unknown action' }, 400);
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
