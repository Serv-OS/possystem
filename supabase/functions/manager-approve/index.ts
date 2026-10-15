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
// v5.10.3: the audit row goes through the hash chain writer workforce-compute uses
// (_shared/wfAudit.js), and a row that did not save is answered, never dropped.
//
//   POST { action, ops_location_id, pin, target_id, decision?, heal? }   (token in Authorization)
//   actions: 'timesheet.approve' | 'timeoff.decide' (decision: 'approved' | 'denied')
//            'timesheet.clock_out' (v5.8.21: a manager clocks a member of staff out; the
//            hours/break/pay maths runs in workforce-clock via its service-role staff_id seam)
//            'po.raise' (an order for one supplier in that supplier's packs and prices, v5.11.64)
//            'po.receive' (goods in from the phone: stock, costs, temperature record, v5.11.64)
//   pin is optional for a Back Office user (user_locations / super_admin): that signed-in user
//   is the accountable operator instead.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { secondStepRefusal } from '../_shared/second-step.ts';
import { writeWfAudit } from '../_shared/wfAudit.js';
// v5.11.64: ONE copy of the purchasing rules with the Order pad (pack choice, pack content, net
// price, order totals, next delivery day) and ONE unit conversion engine with Back Office receiving.
import { nextDeliveryYmd, packContent, packsForBase, netPackPrice, poTotals, unreceivableLines, receiveRefusalText } from '../_shared/purchasingRules.js';
// v5.11.65: ONE moving average rule with Back Office receiving (applyReceipt); the inline copy here
// wrote 4.00 where Back Office wrote 1.20 when stock was below zero.
import { costAfterReceipt } from '../_shared/stockCosting.js';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const sb = createClient(Deno.env.get('SUPABASE_URL') ?? '', SERVICE_ROLE, { auth: { autoRefreshToken: false, persistSession: false } });
const nowIso = () => new Date().toISOString();
const r2 = (n: number) => Math.round(n * 100) / 100;
// the venue's calendar day (the same Intl reading manager-snapshot uses for `today`)
const ymd = (d: Date, tz: string) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
// A chilled delivery over this is rejected: the same threshold as the Ops Deliveries screen (ACCEPT_MAX).
const DELIVERY_ACCEPT_MAX_C = 8;

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

// v5.10.3: every row goes through the ONE chain writer (_shared/wfAudit.js). This used to insert
// with no prev_hash/row_hash and never read the insert error, so a row that did not save was
// silent. Returns the error, null when the row landed.
async function audit(loc: string, orgId: string | null, op: { id: string; name?: string }, action: string, entity: string, entityId: string, before: unknown, after: unknown): Promise<string | null> {
  const { error } = await writeWfAudit(sb, loc, orgId, action, {
    actorId: op.id, actorName: op.name || null, entity, entityId, before, after,
  });
  if (error) console.error(`[manager-approve] ${action} ${entityId}: ${error}`);
  return error;
}

// The action landed but its audit row did not. Answered as an error so the screen shows it (a 2xx
// with a flag reads as plain success), with done: true so a caller can tell it from a refusal.
// The words avoid "PIN", "approve" and "not allowed": the Manager app asks for the PIN again on
// those (ManagerTeam onResult, ManagerKitchen submitPO).
const auditFailed = (what: string, extra: Record<string, unknown> = {}) =>
  json({ error: `${what} stands, but its audit record did not save. Tell the owner.`, done: true, audit_failed: true, ...extra }, 500);

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const secondStepBlock = await secondStepRefusal(req); if (secondStepBlock) return secondStepBlock; // docs/SECOND_STEP.md
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
      // v5.10.3: name the sheet. On its own workforce-clock closes the person's NEWEST open sheet,
      // so with two open (Back Office can save one with no clock out) a tap on sheet A closed
      // sheet B and the audit named A. With timesheet_id it closes this one or refuses.
      const res = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/workforce-clock`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SERVICE_ROLE}` },
        body: JSON.stringify({ location_id: loc, staff_id: ts.staff_id, timesheet_id: ts.id, action: 'out' }),
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok || out?.error) return json({ error: out?.error || `clock-out failed (${res.status})` }, res.status >= 500 ? 502 : 400);
      // Read the sheet back: the audit records what was written, and a sheet still open here means
      // the clock out landed on another one (a workforce-clock older than v5.10.3 ignores the id).
      const { data: closed, error: backErr } = await sb.from('wf_timesheets')
        .select('clock_out, break_taken, actual_hours').eq('id', ts.id).eq('location_id', loc).maybeSingle();
      if (!backErr && !closed?.clock_out) return json({ error: 'the clock out did not close this timesheet; check this person\'s timesheets' }, 502);
      const auditErr = await audit(loc, ts.org_id, op, 'timesheet.manager_clock_out', 'wf_timesheets', ts.id,
        { clock_in: ts.clock_in, clock_out: null },
        { clock_out: closed?.clock_out ?? nowIso(), actual_hours: closed?.actual_hours ?? out.actualHours ?? null, break_taken: closed?.break_taken ?? out.breakMins ?? null, by: op.name ?? op.id });
      if (auditErr) return auditFailed('The clock out', { actualHours: out.actualHours ?? null, staff: out.staff ?? null });
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
      const auditErr = await audit(loc, ts.org_id, op, edit ? 'timesheet.edit_approve' : 'timesheet.approve', 'wf_timesheets', target_id, before, after);
      if (auditErr) return auditFailed('The timesheet sign off');
      return json({ ok: true });
    }

    if (action === 'timeoff.decide') {
      const status = decision === 'approved' ? 'approved' : decision === 'denied' ? 'denied' : null;
      if (!status) return json({ error: 'decision must be approved or denied' }, 400);
      const { data: lv } = await sb.from('wf_time_off').select('id, location_id, org_id, status').eq('id', target_id).maybeSingle();
      if (!lv || lv.location_id !== loc) return json({ error: 'time-off request not found for this location' }, 404);
      const { error } = await sb.from('wf_time_off').update({ status, decided_by: op.id, decided_at: nowIso() }).eq('id', target_id).eq('location_id', loc);
      if (error) return json({ error: error.message }, 400);
      const auditErr = await audit(loc, lv.org_id, op, `timeoff.${status}`, 'wf_time_off', target_id, { status: lv.status }, { status });
      if (auditErr) return auditFailed('The time off decision');
      return json({ ok: true });
    }

    // ── po.raise: a purchase order for one supplier from the Manager Kitchen tab. Writes the SAME
    //    purchase_orders/po_lines shape as the BO Order pad (service-role, loc-fenced, PIN-verified,
    //    audited), so goods-in / costs / invoice OCR flow through the existing stock system.
    //    v5.11.64: the line used to be written as 1 x 1 each at a price of 0, with the quantity in
    //    BASE units (32 eggs became 32 PACKS), no expected date and subtotal 0. The server now reads
    //    the supplier pack, the net pack price and the VAT rate exactly as the pad does (one copy of
    //    the rules in _shared/purchasingRules.js), dates the order to the supplier's next delivery
    //    day on the venue's calendar, and refuses, naming the item, when the supplier has no pack
    //    for it in Back Office. An older app that still sends `qty` in base units has it turned
    //    into whole packs (packsForBase), so neither side can make a wrong order. ──
    if (action === 'po.raise') {
      const supplierId = body.supplier_id || null;
      if (!supplierId) return json({ error: 'Pick a supplier for this order' }, 400);
      const lines = (Array.isArray(body.lines) ? body.lines : [])
        .filter((l: any) => l && l.inventory_item_id && (Number(l.qty_packs) > 0 || Number(l.qty) > 0))
        .slice(0, 200);
      if (!lines.length) return json({ error: 'no lines to order' }, 400);

      // TENANT FENCE: the service-role client bypasses RLS, and the FKs to suppliers/inventory_items
      // are NOT location-composite — so we MUST verify every referenced row belongs to THIS location
      // before inserting, else a manager at venue A could write a PO against venue B's supplier/items.
      const { data: sup } = await sb.from('suppliers').select('id, name, delivery_days').eq('id', supplierId).eq('location_id', loc).maybeSingle();
      if (!sup) return json({ error: 'supplier not found for this location' }, 400);
      const itemIds = [...new Set(lines.map((l: any) => l.inventory_item_id))] as string[];
      // wf_audit's (location_id, org_id) must be a real pair from locations (INVARIANTS), so the org
      // comes from the venue, before anything is written; the timezone gives the venue's "today".
      const [{ data: owned }, { data: packRows }, { data: rateRows }, { data: locRow }, { data: convRows }] = await Promise.all([
        sb.from('inventory_items').select('id, name, base_unit, default_supplier_id, purchase_tax_rate_id').eq('location_id', loc).in('id', itemIds),
        sb.from('supplier_products').select('id, inventory_item_id, supplier_id, pack_qty, inner_qty, inner_unit, pack_price, is_preferred, purchase_tax_rate_id, price_includes_tax')
          .eq('location_id', loc).eq('supplier_id', supplierId).in('inventory_item_id', itemIds).order('is_preferred', { ascending: false }).order('created_at').order('id'),
        sb.from('tax_rates').select('id, rate').eq('location_id', loc),
        sb.from('locations').select('org_id, timezone').eq('id', loc).maybeSingle(),
        sb.from('inventory_item_conversions').select('inventory_item_id, from_qty, from_unit, to_qty, to_unit').eq('location_id', loc).in('inventory_item_id', itemIds),
      ]);
      const itemBy: Record<string, any> = {};
      for (const it of owned ?? []) itemBy[it.id] = it;
      // the item's cross dimension bridges, so an older app's qty in BASE units divides by the pack
      // content in those units (a 3 kg need on a 1 x 2.5 kg pack is 2 packs, not 1200)
      const convByItem: Record<string, any[]> = {};
      for (const c of convRows ?? []) (convByItem[c.inventory_item_id] ??= []).push({ fromQty: Number(c.from_qty), fromUnit: c.from_unit, toQty: Number(c.to_qty), toUnit: c.to_unit });
      if (itemIds.some((id) => !itemBy[id])) return json({ error: 'one or more items are not from this location' }, 400);
      const orgId = locRow?.org_id || null;
      if (!orgId) return json({ error: 'could not raise the order' }, 400);
      const ratesById: Record<string, number> = {};
      for (const r of rateRows ?? []) ratesById[r.id] = Number(r.rate) || 0;
      // the camelCase pack shape the pad reads (src/lib/stock/data.js spFromRow)
      const packsBy: Record<string, any[]> = {};
      for (const p of packRows ?? []) {
        (packsBy[p.inventory_item_id] ??= []).push({
          id: p.id, supplierId: p.supplier_id, packQty: Number(p.pack_qty) || 1, innerQty: Number(p.inner_qty) || 0, innerUnit: p.inner_unit || 'each',
          packPrice: Number(p.pack_price) || 0, isPreferred: p.is_preferred === true,
          purchaseTaxRateId: p.purchase_tax_rate_id || null, priceIncludesTax: p.price_includes_tax === true,
        });
      }
      const poLines: any[] = [];
      const problems: string[] = [];
      for (const l of lines) {
        const item = itemBy[l.inventory_item_id];
        const mine = packsBy[item.id] || [];
        const preferred = mine.filter((p) => p.isPreferred);
        let sp: any = null;
        if (mine.length === 1) sp = mine[0];
        else if (mine.length > 1 && preferred.length === 1) sp = preferred[0];
        else if (mine.length > 1) { problems.push(`${item.name} has ${mine.length} packs from ${sup.name} and ${preferred.length ? 'more than one is' : 'none is'} marked preferred. Fix it under Stock, Suppliers.`); continue; }
        else { problems.push(`${item.name} has no pack from ${sup.name} in Back Office. Add one under Stock, Suppliers.`); continue; }
        if (!(packContent(sp) > 0)) { problems.push(`${item.name}: the pack from ${sup.name} has no size. Fix it under Stock, Suppliers.`); continue; }
        // qty_packs from a current app; an older app sends qty in BASE units, turned into whole packs
        const qtyPacks = Number(l.qty_packs) > 0 ? Math.ceil(Number(l.qty_packs)) : packsForBase(Number(l.qty) || 0, sp, { baseUnit: item.base_unit, itemConversions: convByItem[item.id] || [] });
        if (Number(l.qty_packs) <= 0 && qtyPacks === 0 && Number(l.qty) > 0) { problems.push(`${item.name}: the pack from ${sup.name} is in ${sp.innerUnit} and the item is counted in ${item.base_unit}, with no conversion between them. Add one on the item's Units tab.`); continue; }
        if (!(qtyPacks > 0)) continue;
        const taxId = sp.purchaseTaxRateId || item.purchase_tax_rate_id || null;
        const rate = taxId ? (ratesById[taxId] || 0) : 0;
        poLines.push({
          supplierProductId: sp.id, inventoryItemId: item.id, description: item.name, qtyPacks,
          packQty: sp.packQty, innerQty: sp.innerQty, innerUnit: sp.innerUnit,
          unitPrice: netPackPrice(sp, rate), purchaseTaxRateId: taxId,
        });
      }
      if (problems.length) return json({ error: problems.join(' ') }, 400);
      if (!poLines.length) return json({ error: 'no lines to order' }, 400);
      const { lineTaxes, subtotal, tax } = poTotals(poLines, ratesById);
      const venueToday = ymd(new Date(), locRow?.timezone || 'Europe/London');
      const expectedDate = (typeof body.expected_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.expected_date)) ? body.expected_date : nextDeliveryYmd(sup.delivery_days, venueToday);

      const reference = 'MGR-' + Date.now().toString(36).toUpperCase();
      const { data: po, error: poErr } = await sb.from('purchase_orders').insert({
        location_id: loc, supplier_id: supplierId, reference, status: 'SENT',
        ordered_at: nowIso(), updated_at: nowIso(),
        expected_date: expectedDate,
        notes: `Raised from the Manager app by ${op.name || 'manager'}`,
        subtotal: r2(subtotal), tax,
      }).select().single();
      // Generic error (don't echo the DB message — a verbatim FK error is a cross-tenant existence oracle).
      if (poErr || !po) { console.error('[po.raise] po insert', poErr?.message); return json({ error: 'could not raise the order' }, 400); }
      const lrows = poLines.map((l: any, i: number) => ({
        location_id: loc, po_id: po.id, inventory_item_id: l.inventoryItemId, supplier_product_id: l.supplierProductId,
        description: l.description, qty_packs: l.qtyPacks, pack_qty: l.packQty, inner_qty: l.innerQty,
        inner_unit: l.innerUnit, unit_price: l.unitPrice, qty_received: 0,
        purchase_tax_rate_id: l.purchaseTaxRateId, line_tax: lineTaxes[i], sort_order: i,
      }));
      const { error: lErr } = await sb.from('po_lines').insert(lrows);
      if (lErr) { await sb.from('purchase_orders').delete().eq('id', po.id); console.error('[po.raise] lines insert', lErr.message); return json({ error: 'could not raise the order' }, 400); }
      const auditErr = await audit(loc, orgId, op, 'po.raise', 'purchase_orders', po.id, null,
        { reference, supplier_id: supplierId, supplier_name: sup.name || body.supplier_name || null, lines: lrows.length, subtotal: r2(subtotal), tax, expected_date: expectedDate });
      if (auditErr) {
        // Unlike the approvals, raising again is not harmless (it makes a second order), so an
        // order with no record of who raised it is taken back (its lines go too, ON DELETE CASCADE).
        const { error: undoErr } = await sb.from('purchase_orders').delete().eq('id', po.id);
        if (undoErr) {
          console.error('[po.raise] undo after audit failure', undoErr.message);
          return json({ error: `Order ${reference} was raised, but its audit record did not save. Check Purchasing before raising it again, and tell the owner.`, done: true, audit_failed: true, po_id: po.id, reference }, 500);
        }
        return json({ error: 'could not raise the order: its audit record did not save' }, 500);
      }
      return json({ ok: true, po_id: po.id, reference, subtotal: r2(subtotal), tax, expected_date: expectedDate });
    }

    // ── po.receive (v5.11.64): goods in from the Manager app. target_id is the order. The phone
    //    cannot run Back Office receiving itself: purchase_orders, po_lines and item_cost_history are
    //    fenced by user_accessible_locations(), which refuses an anonymous (paired) session, so the
    //    Ops Deliveries screen showed "No deliveries due today" on every phone. This mirrors
    //    src/lib/stock/purchasing.js receivePurchaseOrder line by line, under the SAME idempotency
    //    key po:<poId>:<lineId>, so a receive from the phone and one from Back Office can never post
    //    the same stock twice, and the delivery temperature record is written as the Ops screen
    //    writes it (checkDelivery). A scanned delivery note is kept on the order as paperwork
    //    (supplier_invoices, status REVIEW), never a second stock post (attachInvoiceToPO rule).
    //    body: { accept?: boolean (default true), temperature_c?: number|null, rejection_reason?,
    //            receipts: [{ line_id, qty_packs, unit_price? }],
    //            scan?: { invoice_number?, invoice_date?, total?, image_base64?, media_type?, raw? } }
    if (action === 'po.receive') {
      const { data: po } = await sb.from('purchase_orders').select('*').eq('id', target_id).eq('location_id', loc).maybeSingle();
      if (!po) return json({ error: 'order not found for this location' }, 404);
      if (!['SENT', 'PARTIAL'].includes(po.status)) return json({ error: `this order is already ${String(po.status).toLowerCase()}` }, 409);
      const { data: lines } = await sb.from('po_lines').select('*').eq('location_id', loc).eq('po_id', po.id).order('sort_order').order('id');
      if (!lines?.length) return json({ error: 'the order has no lines' }, 400);
      const { data: locRow } = await sb.from('locations').select('org_id').eq('id', loc).maybeSingle();
      const orgId = locRow?.org_id || null;
      if (!orgId) return json({ error: 'could not receive the order' }, 400);
      const accept = body.accept !== false;
      const tempC = body.temperature_c == null || body.temperature_c === '' ? null : Number(body.temperature_c);
      if (tempC != null && !Number.isFinite(tempC)) return json({ error: 'the delivery temperature must be a number' }, 400);
      const inRange = tempC == null ? true : tempC <= DELIVERY_ACCEPT_MAX_C;

      // Receipts: [{ line_id, qty_packs, unit_price }]; a line not named receives 0 (shorted), exactly
      // receivePurchaseOrder's line by line mode. Read and checked BEFORE anything is written.
      const byLine: Record<string, any> = {};
      for (const r of (Array.isArray(body.receipts) ? body.receipts : [])) if (r && r.line_id != null) byLine[String(r.line_id)] = r;
      const itemIds = [...new Set(lines.map((l: any) => l.inventory_item_id).filter(Boolean))] as string[];
      const [{ data: items }, { data: convs }, { data: rateRows }] = await Promise.all([
        itemIds.length ? sb.from('inventory_items').select('id, name, base_unit, on_hand, current_cost, cost_method').eq('location_id', loc).in('id', itemIds) : Promise.resolve({ data: [] }),
        itemIds.length ? sb.from('inventory_item_conversions').select('*').eq('location_id', loc).in('inventory_item_id', itemIds) : Promise.resolve({ data: [] }),
        sb.from('tax_rates').select('id, rate').eq('location_id', loc),
      ]);
      const convBy: Record<string, any[]> = {};
      for (const c of convs ?? []) (convBy[c.inventory_item_id] ??= []).push({ fromQty: Number(c.from_qty), fromUnit: c.from_unit, toQty: Number(c.to_qty), toUnit: c.to_unit });
      const map: Record<string, any> = {};
      for (const it of items ?? []) {
        map[it.id] = { name: it.name, baseUnit: it.base_unit, conversions: convBy[it.id] || [], onHand: Number(it.on_hand) || 0,
          currentCost: it.current_cost == null ? 0 : Number(it.current_cost), costMethod: it.cost_method || 'MOVING_AVG' };
      }
      const ratesById: Record<string, number> = {};
      for (const r of rateRows ?? []) ratesById[r.id] = Number(r.rate) || 0;
      // REFUSE rather than half-happen: a line whose item is missing (or another venue's: the items
      // read is fenced to this location) or whose unit path fails cannot be represented, and
      // RECEIVED is terminal (purchasing.js lines 221 to 237).
      const { bad, perPackOf } = unreceivableLines(lines, map);
      if (accept && bad.length) return json({ error: receiveRefusalText(bad) }, 400);
      for (const l of lines) {
        const r = byLine[String(l.id)];
        if (r && r.qty_packs != null && r.qty_packs !== '' && !(Number(r.qty_packs) >= 0)) return json({ error: `${l.description || 'a line'}: the quantity received must be a number` }, 400);
        if (r && r.unit_price != null && r.unit_price !== '' && !(Number(r.unit_price) >= 0)) return json({ error: `${l.description || 'a line'}: the price must be a number` }, 400);
      }

      // Goods in record first, the same shape src/lib/ops/data.js checkDelivery writes.
      const { data: del, error: delErr } = await sb.from('deliveries').insert({
        location_id: loc, org_id: orgId, po_id: po.id, supplier_id: po.supplier_id || null,
        temperature_c: tempC, checked_by: null, checked_by_name: op.name || null, checked_at: nowIso(), status: 'pending',
      }).select('id').single();
      if (delErr || !del) { console.error('[po.receive] delivery insert', delErr?.message); return json({ error: 'could not start the goods in record' }, 400); }

      if (!accept) {
        // reject: no stock movement is ever posted; the order stays open for the supplier to put right
        const { error: rjErr } = await sb.from('deliveries').update({ status: 'rejected', in_range: inRange, rejection_reason: body.rejection_reason || `Over ${DELIVERY_ACCEPT_MAX_C} C on arrival` }).eq('id', del.id);
        if (rjErr) return json({ error: 'could not record the rejection' }, 400);
        const auditErr = await audit(loc, orgId, op, 'po.reject_delivery', 'purchase_orders', po.id, { status: po.status }, { delivery_id: del.id, temperature_c: tempC, by: op.name ?? op.id });
        if (auditErr) return auditFailed('The rejection', { rejected: true });
        return json({ ok: true, rejected: true });
      }

      let subtotal = 0, tax = 0;
      const shorted: any[] = [];
      let received = 0;
      for (const l of lines) {
        const item = map[l.inventory_item_id];
        const r = byLine[String(l.id)];
        const ordered = Number(l.qty_packs) || 0;
        const accepted = Math.max(0, Number(r?.qty_packs ?? 0) || 0);
        const price = r?.unit_price != null && r.unit_price !== '' ? Number(r.unit_price) : (Number(l.unit_price) || 0);
        const perPack = perPackOf[l.id];
        if (accepted > 0) {
          const recvBase = accepted * perPack;
          const unitCostPerBase = price / perPack;
          // applyReceipt (purchasing.js lines 50 to 80): a zero price moves the stock in at the item's
          // known cost and never re-costs it; a real price moves the average (or replaces it, LAST_COST).
          const priced = unitCostPerBase > 0;
          const { data: mv, error: mvErr } = await sb.rpc('post_stock_movement', {
            p_location_id: loc, p_inventory_item_id: l.inventory_item_id, p_qty_base: recvBase, p_movement_type: 'PURCHASE_RECEIPT',
            p_unit_cost: priced ? unitCostPerBase : (item.currentCost || 0), p_source_type: 'purchase_order', p_source_id: po.id,
            p_idempotency_key: `po:${po.id}:${l.id}`, p_occurred_at: null, p_created_by: null,
            p_notes: `Received in the Manager app by ${op.name || 'manager'}`,
          });
          if (mvErr) { console.error('[po.receive] movement', mvErr.message); return json({ error: `could not book ${l.description || 'a line'} into stock: ${mvErr.message}`, done: false }, 500); }
          const duplicate = !!(mv as any)?.duplicate;
          if (!duplicate && priced) {
            const newAvg = costAfterReceipt({ costMethod: item.costMethod, onHandQty: item.onHand, currentAvg: item.currentCost, receivedQty: recvBase, receivedUnitCost: unitCostPerBase });
            await sb.from('item_cost_history').update({ effective_to: nowIso() }).eq('location_id', loc).eq('inventory_item_id', l.inventory_item_id).is('effective_to', null);
            await sb.from('item_cost_history').insert({ location_id: loc, inventory_item_id: l.inventory_item_id, base_unit_cost: newAvg, source: 'PO_RECEIPT', effective_from: nowIso() });
            await sb.from('inventory_items').update({ current_cost: newAvg, updated_at: nowIso() }).eq('location_id', loc).eq('id', l.inventory_item_id);
            item.currentCost = newAvg;
          }
          if (!duplicate) item.onHand += recvBase;
          received++;
        }
        const rate = l.purchase_tax_rate_id ? (ratesById[l.purchase_tax_rate_id] || 0) : 0;
        const net = accepted * price;
        const lineTax = Math.round(net * rate * 100) / 100;
        subtotal += net; tax += lineTax;
        await sb.from('po_lines').update({ qty_received: accepted, unit_price: price, line_tax: lineTax }).eq('location_id', loc).eq('id', l.id);
        if (accepted < ordered) {
          shorted.push({
            location_id: loc, inventory_item_id: l.inventory_item_id, supplier_product_id: l.supplier_product_id || null,
            description: l.description, qty_packs: ordered - accepted, pack_qty: l.pack_qty, inner_qty: l.inner_qty, inner_unit: l.inner_unit,
            unit_price: price, qty_received: 0, purchase_tax_rate_id: l.purchase_tax_rate_id || null, sort_order: shorted.length,
          });
        }
      }
      await sb.from('purchase_orders').update({ status: 'RECEIVED', received_at: nowIso(), updated_at: nowIso(), subtotal: r2(subtotal), tax: r2(tax) }).eq('location_id', loc).eq('id', po.id);
      // Balance order for whatever the supplier shorted: born SENT so it counts as on order (purchasing.js lines 280 to 289).
      let balance: any = null;
      if (shorted.length) {
        const balLines = shorted.map((l) => ({ qtyPacks: l.qty_packs, unitPrice: l.unit_price, purchaseTaxRateId: l.purchase_tax_rate_id }));
        const bt = poTotals(balLines, ratesById);
        const { data: bal } = await sb.from('purchase_orders').insert({
          location_id: loc, supplier_id: po.supplier_id || null, status: 'SENT', reference: `${po.reference || 'PO'} balance`,
          ordered_at: nowIso(), updated_at: nowIso(), expected_date: null,
          notes: `Balance of shorted lines from ${po.reference || po.id}`, subtotal: r2(bt.subtotal), tax: bt.tax,
        }).select('id, reference').single();
        if (bal) {
          await sb.from('po_lines').insert(shorted.map((l, i) => ({ ...l, po_id: bal.id, line_tax: bt.lineTaxes[i] })));
          balance = bal;
        }
      }
      // Paperwork: the scanned note lives on the order, status REVIEW, never a second stock post.
      let invoiceId: string | null = null;
      if (body.scan && typeof body.scan === 'object') {
        const scan = body.scan;
        let imagePath: string | null = null;
        if (typeof scan.image_base64 === 'string' && scan.image_base64.length) {
          try {
            const mediaType = String(scan.media_type || 'image/jpeg');
            const ext = mediaType === 'application/pdf' ? 'pdf' : mediaType === 'image/png' ? 'png' : mediaType === 'image/webp' ? 'webp' : 'jpg';
            const path = `${loc}/po/${po.id}/${Date.now()}.${ext}`;
            const bytes = Uint8Array.from(atob(scan.image_base64), (c) => c.charCodeAt(0));
            const up = await sb.storage.from('invoice-scans').upload(path, bytes, { contentType: mediaType, upsert: false });
            if (!up.error) imagePath = path; else console.error('[po.receive] scan upload', up.error.message);
          } catch (e) { console.error('[po.receive] scan upload', String((e as Error)?.message || e)); }
        }
        const { data: inv } = await sb.from('supplier_invoices').insert({
          location_id: loc, po_id: po.id, supplier_id: po.supplier_id || null,
          invoice_number: scan.invoice_number ? String(scan.invoice_number) : null,
          invoice_date: (typeof scan.invoice_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(scan.invoice_date)) ? scan.invoice_date : null,
          total: scan.total == null || scan.total === '' || !Number.isFinite(Number(scan.total)) ? null : Number(scan.total),
          status: 'REVIEW', image_path: imagePath, raw_json: scan.raw ?? null,
        }).select('id').single();
        invoiceId = inv?.id || null;
      }
      const { error: accErr } = await sb.from('deliveries').update({ status: 'accepted', in_range: inRange, received_at: nowIso() }).eq('id', del.id);
      if (accErr) console.error('[po.receive] delivery accept', accErr.message);
      const auditErr = await audit(loc, orgId, op, 'po.receive', 'purchase_orders', po.id, { status: po.status },
        { status: 'RECEIVED', lines: lines.length, received, shorted: shorted.length, balance_reference: balance?.reference || null,
          temperature_c: tempC, in_range: inRange, delivery_id: del.id, invoice_id: invoiceId, scanned: !!body.scan, subtotal: r2(subtotal), tax: r2(tax), by: op.name ?? op.id });
      if (auditErr) return auditFailed('The receive', { received: true, balance_reference: balance?.reference || null });
      return json({ ok: true, received, shorted: shorted.length, balance_reference: balance?.reference || null, invoice_id: invoiceId, delivery_id: del.id });
    }

    return json({ error: 'unknown action' }, 400);
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
