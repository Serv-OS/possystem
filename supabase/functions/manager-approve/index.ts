// supabase/functions/manager-approve/index.ts
//
// Write actions for the ServOS Manager app (?mode=manager) that a PAIRED, ANONYMOUS device can't do
// directly (wf_* tables are RLS-fenced to Back Office users). Service-role writes, DOUBLE-fenced:
//   1) the DEVICE/caller must be authorized for the location — a claimed+active ops_device, OR a BO
//      user who reaches the venue (mirrors manager-snapshot's requireManager).
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
//            'swap.decide' (v5.11.101: a shift claim or swap waiting for a manager; decision:
//            'approved' | 'declined'; the database judge wf_swap_decide checks every rule again
//            under a lock, then the claimer and the person giving the shift up are texted)
//            'timesheet.clock_out' (v5.8.21: a manager clocks a member of staff out; the
//            hours/break/pay maths runs in workforce-clock via its service-role staff_id seam)
//            'po.raise' (an order for one supplier in that supplier's packs and prices, v5.11.64)
//            'po.receive' (goods in from the phone: stock, costs, temperature record, v5.11.64)
//            'stock.areas' | 'stock.items' | 'stock.count_open' | 'stock.count_sheet' | 'stock.count_save' |
//            'stock.count_approve' | 'stock.waste' (v5.11.84, multi site stock Drop 0: counting by
//            area and waste on the phone, re landed from Phase 1b; the steps live in _shared/stockPhone.js)
//            v5.11.96 (multi site stock Drop 3, contract 3.4): 'transfer.send' | 'transfer.request' |
//            'transfer.receive' | 'transfer.dispute' | 'kitchen.orders_in' | 'kitchen.plan' | 'kitchen.pick' |
//            'kitchen.done' | 'shop.buy' | 'waste.closedown' | 'forecast.edit'
//   pin is optional for a Back Office user who reaches the venue: that signed-in user is the
//   accountable operator instead (never for stock.count_approve, which always needs a manager PIN).
//
// v5.11.96 (multi site stock Drop 3, contract 3.4, decision 4): po.raise writes a DRAFT order, asks the
// database (stock_po_submit, as the service role with p_actor: the device and the PIN are proven here)
// whether it needs approval, goes to a central kitchen or is sent, and then EMAILS it through the one
// send path (_shared/poSend.ts), one site companies included: before this the phone marked an order
// SENT and no supplier ever heard of it. The expected day is the next delivery by the order by rule
// (an order after the cut off is for the following delivery, every company). po.receive refuses a
// central kitchen order (it arrives as a transfer). The new actions pass p_actor = { uid, name,
// staff_id, location_id } to the Drop 3 functions; every site they name is this venue.
//
// v5.11.84 (multi site stock Drop 0, plan 6.2 and 4.23): WHO REACHES THE VENUE, two answers.
//   * Every action: officeReachesVenue (_shared/stockOfficeReach.js), the database's own rule: a link
//     row, a super admin, or the owner of the venue's company. Owners who reach a site by the owner
//     rule were refused here before; nothing else widens.
//   * po.raise, po.receive and stock.* only: stockOfficeReachesVenue, which adds a login whose Stock
//     control is 'all' in the venue's own company. So such a login never gains timesheet.clock_out,
//     timesheet.approve or timeoff.decide at a site it is not linked to.
//   * The staff PIN rule for the phone's stock steps: any active staff PIN at the venue may open the
//     areas, the item list and a count, save figures and log waste; only stock.count_approve needs a
//     manager PIN (role manager or owner, or the manager_approvals permission).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { secondStepRefusal } from '../_shared/second-step.ts';
import { writeWfAudit } from '../_shared/wfAudit.js';
// v5.11.64: ONE copy of the purchasing rules with the Order pad (pack choice, pack content, net
// price, order totals, next delivery day) and ONE unit conversion engine with Back Office receiving.
// v5.11.96 (Drop 3): the order by rule (nextDelivery over the supplier's rules), never nextDeliveryYmd.
import { nextDelivery, rulesFromDeliveryDays, packContent, packsForBase, netPackPrice, poTotals, unreceivableLines, receiveRefusalText, poReceiptLines } from '../_shared/purchasingRules.js';
// v5.11.84: the two reach rules (everything / stock only) and the facts they read.
import { officeReachesVenue, stockOfficeReachesVenue, readOfficeReachFacts } from '../_shared/stockOfficeReach.js';
// v5.11.84: counting and waste on the phone (multi site stock Drop 0), one copy of the steps; liveOrAll
// leaves archived packs, bridges and supplier prices out (all rows before 20261021a).
import * as stockPhone from '../_shared/stockPhone.js';
// v5.11.96: the one purchase order email (po-send, po-cutoff-run and here).
import { sendPurchaseOrder } from '../_shared/poSend.ts';
// v5.11.101: open shifts and swaps. The rules' words and texts, and the one way staff are told.
import { problemText, textYours, textTaken, textDeclined } from '../_shared/openShiftRules.js';
import { regionPack } from '../_shared/regionPack.js';
import { notifyStaff } from '../_shared/staffNotify.ts';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const sb = createClient(Deno.env.get('SUPABASE_URL') ?? '', SERVICE_ROLE, { auth: { autoRefreshToken: false, persistSession: false } });
const nowIso = () => new Date().toISOString();
const r2 = (n: number) => Math.round(n * 100) / 100;
// the venue's calendar day (the same Intl reading manager-snapshot uses for `today`)
const ymd = (d: Date, tz: string) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
// the venue's wall clock 'HH:MM' (the order by rule compares it with the cut off)
const hmIn = (d: Date, tz: string) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
const plusDay = (ymdText: string) => new Date(Date.parse(`${ymdText}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
const isMissingTable = (e: any) => !!e && /42P01|PGRST205|42703|PGRST204|does not exist|Could not find the table/i.test(`${e.code || ''} ${e.message || ''}`);
const KITCHEN_ORDER_WORDS = 'This order arrives as a transfer from the central kitchen. Receive it in Transfers.';

// v5.11.89 (multi site stock Drop 1, map 4.3 Pause): an item paused at a site cannot be ordered
// there from the phone either. The words are the Order pad's (src/lib/stock/pauseRules.js
// pauseWords), built here the same way; pauseRules.test.js runs both and compares them.
// pause words (src/lib/stock/pauseRules.js): start
const PAUSE_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function pauseDay(v: unknown): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v ?? ''));
  if (!m) return '';
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return '';
  return `${day} ${PAUSE_MONTHS[month - 1]}`;
}
function pauseWordsOf(p: { siteName?: string; everywhere?: boolean; until?: string | null }): string {
  const site = String(p?.siteName ?? '').trim();
  const where = p?.everywhere ? 'everywhere' : (site ? `at ${site}` : '');
  const day = pauseDay(p?.until);
  return ['Paused', where, day ? `until ${day}` : ''].filter(Boolean).join(' ');
}
// pause words: end
const isMissingFn = (e: any) => !!e && /PGRST202|42883|could not find the function|function .* does not exist/i.test(`${e.code || ''} ${e.message || ''}`);
// A chilled delivery over this is rejected: the same threshold as the Ops Deliveries screen (ACCEPT_MAX).
const DELIVERY_ACCEPT_MAX_C = 8;

// The bearer of the request, read once: the service role, a signed in user, or nobody.
type Caller = { token: string; service: boolean; user: any | null };
async function callerOf(req: Request): Promise<Caller> {
  const token = (req.headers.get('Authorization') ?? '').replace('Bearer ', '').trim();
  if (!token) return { token: '', service: false, user: null };
  if (token === SERVICE_ROLE) return { token, service: true, user: null };
  const { data: { user } } = await sb.auth.getUser(token);
  return { token, service: false, user: user ?? null };
}

// The stock work a Stock control 'all' login may do at a site it is not linked to (plan 6.2).
// v5.11.96 (Drop 3): transfers, the central kitchen, shop buys, the fresh close down and forecast edits
// are stock work too.
const isStockAction = (action: string) => action === 'po.raise' || action === 'po.receive' || action.startsWith('stock.')
  || action.startsWith('transfer.') || action.startsWith('kitchen.') || action === 'shop.buy' || action === 'waste.closedown' || action === 'forecast.edit';
// Actions that make something new (no target record) or read the venue as a whole.
const NO_TARGET = new Set(['po.raise', 'transfer.send', 'transfer.request', 'kitchen.orders_in', 'kitchen.plan', 'kitchen.done', 'shop.buy', 'waste.closedown', 'forecast.edit']);
// Any active staff PIN opens these (reads, waste, the plan's Done ticks); everything else needs a manager PIN.
const STAFF_PIN_ACTIONS = new Set(['kitchen.orders_in', 'kitchen.plan', 'kitchen.done', 'waste.closedown']);


// Does this signed in Back Office user reach the venue? officeReachesVenue for every action;
// stockOfficeReachesVenue (adds Stock control 'all' in the venue's own company) for stock actions only.
async function officeReaches(user: any, loc: string, stockAction: boolean): Promise<boolean> {
  if (!user || user.is_anonymous) return false;
  const facts = await readOfficeReachFacts(sb, user, loc);
  return (stockAction ? stockOfficeReachesVenue(facts) : officeReachesVenue(facts)).ok;
}

// v5.8.21: a signed-in Back Office user acting from the Workforce screens has no
// staff PIN. If the bearer is a user who reaches the venue, they are the
// accountable operator (audit records their user id + email).
// v5.11.84: "reaches" is the database's rule (link, super admin, owner of the venue's company),
// plus Stock control 'all' for stock actions only.
async function boOperator(caller: Caller, loc: string, stockAction: boolean): Promise<{ id: string; name?: string; role?: string; permissions?: string[] } | null> {
  const user = caller.user;
  if (!user || user.is_anonymous) return null;
  if (!(await officeReaches(user, loc, stockAction))) return null;
  const { data: prof } = await sb.from('user_profiles').select('full_name').eq('id', user.id).maybeSingle();
  return { id: user.id, name: (prof as any)?.full_name || user.email || 'Back Office user', role: 'manager', permissions: ['manager_approvals'] };
}

// Device/caller authorized for this location? (same fence as manager-snapshot)
async function deviceAuthorized(caller: Caller, loc: string, stockAction: boolean): Promise<boolean> {
  if (caller.service) return true;
  const user = caller.user;
  if (!user) return false;
  const { data: dev } = await sb.from('ops_devices').select('id').eq('device_uid', user.id).eq('location_id', loc).eq('active', true).not('claimed_at', 'is', null).maybeSingle();
  if (dev) return true;
  return officeReaches(user, loc, stockAction);
}

// Resolve the acting operator by PIN, SERVER-SIDE — never trust a client-supplied operator id. The
// shared paired device authenticates only the device; the approver's identity must be proven by their
// PIN at the moment of approval (the PIN is matched against staff_members for this location). Service
// role bypasses RLS so we read directly (the ops_pin_login RPC needs auth.uid(), which is null here).
async function resolveOperator(loc: string, pin: string): Promise<{ id: string; name?: string; role?: string; permissions?: string[]; auth_user_id?: string | null } | null> {
  if (!pin) return null;
  // Prefer an active row (active!==false treats NULL as active, matching ops_pin_login's coalesce) so a
  // stale inactive duplicate can't shadow a live PIN. PINs are effectively unique per location in practice.
  const { data: rows } = await sb.from('staff_members').select('id, name, role, permissions, active, org_id, auth_user_id').eq('location_id', loc).eq('pin', String(pin)).limit(5);
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
  if (!NO_TARGET.has(String(action)) && !target_id) return json({ error: 'action and target_id required' }, 400);

  const stockAction = isStockAction(String(action));
  const caller = await callerOf(req);
  if (!(await deviceAuthorized(caller, loc, stockAction))) return json({ error: 'no access to this location' }, 403);
  // v5.11.80: a count approval always needs a manager PIN, a Back Office login included (the Back
  // Office's own approval goes through stock_approve_count_pin, with its five wrong tries rule).
  if (action === 'stock.count_approve' && !pin) return json({ error: 'PIN required' }, 403);
  const op = pin ? await resolveOperator(loc, pin) : await boOperator(caller, loc, stockAction);
  if (!op) return json({ error: pin ? 'PIN not recognised' : 'PIN required' }, 403);
  // v5.11.84 (plan 4.23): any active staff PIN at the venue opens the phone's stock steps (areas,
  // items, a count, saving figures, waste); only the count approval, and every other action, needs
  // a manager PIN.
  const staffPinEnough = (String(action).startsWith('stock.') && action !== 'stock.count_approve') || STAFF_PIN_ACTIONS.has(String(action));
  if (!staffPinEnough && !canApprove(op)) return json({ error: 'not allowed to approve' }, 403);

  // v5.11.96 (Drop 3): who acts, for the database's phone branch (service role only): the login when
  // a Back Office user acts, else the PIN holder's own login (staff_members.auth_user_id) so an order
  // they raise on a shared phone cannot be approved by them in Back Office; the PIN holder's staff id
  // when a PIN was given; and this venue.
  const pinLogin = pin && UUID.test(String((op as any).auth_user_id || '')) ? String((op as any).auth_user_id) : null;
  const actor = { uid: caller.user && !caller.user.is_anonymous ? caller.user.id : pinLogin, name: op.name || null, staff_id: pin ? op.id : null, location_id: loc };

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

    // ── v5.11.101 swap.decide: a manager approves or declines a shift claim or swap that waits for
    //    them (venue setting: need manager approval). The manager is proven here (PIN, or a Back Office
    //    login that reaches the venue); the database decides whether it can still happen. ──
    if (action === 'swap.decide') {
      const d = decision === 'approved' ? 'approved' : decision === 'declined' ? 'declined' : null;
      if (!d) return json({ error: 'decision must be approved or declined' }, 400);
      if (!UUID.test(String(target_id))) return json({ error: 'request not found' }, 404);
      const { data: r, error } = await sb.rpc('wf_swap_decide', { p_location_id: loc, p_request_id: target_id, p_decision: d, p_actor: { id: String(op.id), name: op.name || null } });
      if (error) return json({ error: error.message }, 500);
      if (!r?.ok) return json({ error: problemText(r?.code, 'manager'), code: r?.code }, 409);
      const [{ data: venue }, { data: shRow }] = await Promise.all([
        sb.from('locations').select('id, name, currency, org_id').eq('id', loc).maybeSingle(),
        r.shift_id ? sb.from('wf_shifts').select('shift_date, start_time, finish_time').eq('id', r.shift_id).maybeSingle() : Promise.resolve({ data: null }),
      ]);
      const ids = [r.to_staff_id, r.from_staff_id].filter(Boolean);
      const { data: people } = ids.length ? await sb.from('wf_staff').select('id, name, mobile').in('id', ids) : { data: [] };
      const who = (id: string) => (people || []).find((p: any) => p.id === id) || null;
      const auditErr = await audit(loc, venue?.org_id ?? null, op, `swap.${d}`, 'wf_swap_requests', String(target_id), { status: 'pending' }, { status: d === 'approved' ? 'approved' : 'declined', shift_id: r.shift_id, to_staff_id: r.to_staff_id, from_staff_id: r.from_staff_id, by: op.name ?? op.id });
      if (venue && shRow) {
        const country = regionPack({ currency: venue.currency }).country;
        const sh = { date: shRow.shift_date, start: String(shRow.start_time).slice(0, 5), finish: String(shRow.finish_time).slice(0, 5) };
        const taker = r.to_staff_id ? who(r.to_staff_id) : null;
        const giver = r.from_staff_id ? who(r.from_staff_id) : null;
        if (d === 'approved') {
          if (taker) await notifyStaff(venue, [taker], textYours(venue.name, sh, country), { ref: String(target_id) });
          if (giver) await notifyStaff(venue, [giver], textTaken(venue.name, taker?.name, sh, country), { ref: String(target_id) });
        } else {
          await notifyStaff(venue, [taker, giver].filter(Boolean) as any[], textDeclined(venue.name, sh, country), { ref: String(target_id) });
        }
      }
      if (auditErr) return auditFailed(d === 'approved' ? 'The swap' : 'The decline');
      return json({ ok: true, outcome: r.outcome });
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
      let { data: sup, error: supErr } = await sb.from('suppliers').select('id, name, delivery_days, cutoff_time').eq('id', supplierId).eq('location_id', loc).maybeSingle();
      if (supErr && isMissingTable(supErr)) ({ data: sup } = await sb.from('suppliers').select('id, name, delivery_days').eq('id', supplierId).eq('location_id', loc).maybeSingle());
      if (!sup) return json({ error: 'supplier not found for this location' }, 400);
      const itemIds = [...new Set(lines.map((l: any) => l.inventory_item_id))] as string[];
      // wf_audit's (location_id, org_id) must be a real pair from locations (INVARIANTS), so the org
      // comes from the venue, before anything is written; the timezone gives the venue's "today".
      // v5.11.84 (multi site stock Drop 0, plan 5.4): an archived supplier price or unit bridge is never
      // offered (archived_at comes with 20261021a; before it every row is read, as before).
      const [{ data: owned }, { data: packRows }, { data: rateRows }, { data: locRow }, { data: convRows }] = await Promise.all([
        sb.from('inventory_items').select('id, name, base_unit, default_supplier_id, purchase_tax_rate_id').eq('location_id', loc).in('id', itemIds),
        stockPhone.liveOrAll((live: boolean) => stockPhone.liveFilter(sb.from('supplier_products').select('id, inventory_item_id, supplier_id, pack_qty, inner_qty, inner_unit, pack_price, is_preferred, purchase_tax_rate_id, price_includes_tax')
          .eq('location_id', loc).eq('supplier_id', supplierId).in('inventory_item_id', itemIds), live).order('is_preferred', { ascending: false }).order('created_at').order('id')),
        sb.from('tax_rates').select('id, rate').eq('location_id', loc),
        sb.from('locations').select('org_id, timezone, name').eq('id', loc).maybeSingle(),
        stockPhone.liveOrAll((live: boolean) => stockPhone.liveFilter(sb.from('inventory_item_conversions').select('inventory_item_id, from_qty, from_unit, to_qty, to_unit').eq('location_id', loc).in('inventory_item_id', itemIds), live)),
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
      // v5.11.89 (Drop 1): a line of an item paused at this site today is refused, in the Order pad's
      // words, before anything is written. A database before Drop 1 has no pause, so nothing is refused;
      // any other failure of the read refuses the order rather than guessing.
      const { data: pausedRes, error: pausedErr } = await sb.rpc('stock_paused_items', { p_location: loc });
      if (pausedErr && !isMissingFn(pausedErr)) {
        console.error('[po.raise] paused items read', pausedErr.message);
        return json({ error: 'Could not check which items are paused. Try again.' }, 400);
      }
      const pausedBy: Record<string, any> = {};
      for (const r of (pausedErr ? [] : (pausedRes?.rows ?? []))) if (r && r.site_item_id) pausedBy[r.site_item_id] = r;
      const paused = itemIds.filter((id) => pausedBy[id])
        .map((id) => `${itemBy[id].name}: ${pauseWordsOf({ siteName: locRow?.name || '', everywhere: pausedBy[id].everywhere === true, until: pausedBy[id].until || null })}.`);
      if (paused.length) return json({ error: paused.join(' ') }, 400);
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
      const tz = locRow?.timezone || 'Europe/London';
      const venueToday = ymd(new Date(), tz);
      // v5.11.96 (Drop 3): the next delivery by the order by rule. The order pad context (the site's
      // rules and exceptions, multi site companies) first; else the supplier's delivery days and cut off
      // (rulesFromDeliveryDays, every company). After the cut off it is the following delivery.
      let next: any = null;
      {
        const { data: ctxRes, error: ctxErr } = await sb.rpc('stock_order_pad_context', { p_loc: loc, p_actor: actor });
        if (!ctxErr && ctxRes && Array.isArray((ctxRes as any).suppliers)) {
          const s0 = (ctxRes as any).suppliers.find((x: any) => x && x.supplier_id === supplierId);
          if (s0?.next?.delivery_day) next = { deliveryYmd: s0.next.delivery_day, orderByAt: s0.next.order_by_at || null, minutesLeft: s0.next.minutes_left ?? null };
        }
        if (!next) {
          const n = nextDelivery({ rules: rulesFromDeliveryDays(sup.delivery_days, (sup as any).cutoff_time ?? null), exceptions: [], nowVenue: { ymd: venueToday, hm: hmIn(new Date(), tz) } });
          if (n?.deliveryYmd) next = { deliveryYmd: n.deliveryYmd, orderByAt: n.orderByAt || null, minutesLeft: n.minutesLeft ?? null };
        }
      }
      // a supplier with no delivery days: tomorrow, as before
      const expectedDate = (typeof body.expected_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.expected_date)) ? body.expected_date : (next?.deliveryYmd || plusDay(venueToday));

      const reference = 'MGR-' + Date.now().toString(36).toUpperCase();
      // v5.11.96 (Drop 3): born DRAFT; stock_po_submit decides approval, kitchen or send.
      const { data: po, error: poErr } = await sb.from('purchase_orders').insert({
        location_id: loc, supplier_id: supplierId, reference, status: 'DRAFT',
        updated_at: nowIso(),
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
      const base = { po_id: po.id, reference, subtotal: r2(subtotal), tax, expected_date: expectedDate, order_by_at: next?.orderByAt || null };
      // v5.11.96 (Drop 3): the database's checks (paused lines, the maximum, the kitchen price, the
      // delivery fee, the approval limit). A database before Drop 3 has none: the order is sent.
      const { data: sub, error: subErr } = await sb.rpc('stock_po_submit', { p_po: po.id, p_section: 'purchasing', p_actor: actor });
      if (subErr && !isMissingFn(subErr)) {
        await sb.from('purchase_orders').delete().eq('id', po.id).eq('status', 'DRAFT');
        return json({ error: subErr.message || 'could not raise the order' }, 400);
      }
      const answer: any = subErr ? { send: true } : (sub || {});
      if (answer.ok === false || answer.error) {
        await sb.from('purchase_orders').delete().eq('id', po.id).eq('status', 'DRAFT');
        return json({ error: answer.error || 'the order was refused' }, 400);
      }
      if (answer.internal) return json({ ok: true, ...base, internal: true });
      if (answer.needs_approval) {
        return json({ ok: true, ...base, needs_approval: true, limit: answer.limit ?? null, amount: answer.amount ?? null,
          order_by_at: answer.order_by_at || base.order_by_at, approvers: Array.isArray(answer.approvers) ? answer.approvers : [] });
      }
      // Send: the one email path. A send that fails keeps the order on the books as sent, exactly as
      // the Back Office pad does (it still counts as on order), and says why.
      const sent = await sendPurchaseOrder(sb, { poId: po.id, locationId: loc, supabaseUrl: Deno.env.get('SUPABASE_URL') ?? '', serviceKey: SERVICE_ROLE,
        by: { uid: actor.uid, name: actor.name } });
      if (sent.ok) return json({ ok: true, ...base, emailed: true, to: sent.to });
      await sb.from('purchase_orders').update({ status: 'SENT', ordered_at: nowIso(), updated_at: nowIso() }).eq('location_id', loc).eq('id', po.id).eq('status', 'DRAFT');
      return json({ ok: true, ...base, emailed: false, email_error: sent.error || 'the email could not be sent' });
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
      // v5.11.96 (Drop 3): a central kitchen order is received only through its transfer.
      if (po.supplier_id) {
        const { data: supRow, error: supRowErr } = await sb.from('suppliers').select('company_ref').eq('id', po.supplier_id).eq('location_id', loc).maybeSingle();
        if (!supRowErr && supRow?.company_ref) {
          const { data: co, error: coErr } = await sb.from('stock_co_suppliers').select('internal_location_id').eq('id', supRow.company_ref).maybeSingle();
          if (!coErr && co?.internal_location_id) return json({ error: KITCHEN_ORDER_WORDS }, 409);
        }
      }
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
        // v5.11.84 (Drop 0): an archived unit bridge is not used for a new receive (every row before 20261021a)
        itemIds.length ? stockPhone.liveOrAll((live: boolean) => stockPhone.liveFilter(sb.from('inventory_item_conversions').select('*').eq('location_id', loc).in('inventory_item_id', itemIds), live)) : Promise.resolve({ data: [] }),
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

      // v5.11.79 (stock plan Phase 0, 11.5 item 3): every line's stock and cost in ONE database call
      // (stock_receive, 20261019b): items locked in id order, the average worked out from the LOCKED
      // on hand, the cost history keeping the supplier pack and the price paid per pack. Same keys
      // po:<order>:<line> as Back Office, so the two can never post one line twice.
      // v5.11.84 (multi site stock Drop 0, plan 5.4): the old line by line path (a movement, then the
      // average worked out here and written to item_cost_history and current_cost with no REVALUE) is
      // gone. It never ran once 20261019b was in. A database without the call books nothing and says so.
      {
        const rcpt: Record<string, any> = {};
        for (const [lineId, r] of Object.entries(byLine)) rcpt[lineId] = { qtyPacks: r?.qty_packs ?? 0, unitPrice: r?.unit_price };
        const stockLines = poReceiptLines(po.id, lines, { byLine: rcpt, perPackOf }).map((x: any) => ({
          key: x.key, item_id: x.item_id, qty_base: x.qty_base, unit_cost: x.unit_cost,
          supplier_product_id: x.supplier_product_id, pack_price: x.pack_price, pack_label: x.pack_label,
        }));
        if (stockLines.length) {
          const { data: rres, error: rErr } = await sb.rpc('stock_receive', {
            p_location_id: loc, p_source_type: 'purchase_order', p_source_id: po.id, p_lines: stockLines, p_area_id: null,
            p_notes: `Received in the Manager app by ${op.name || 'manager'}`,
          });
          const missing = rErr && /PGRST202|42883|could not find the function|does not exist/i.test(`${rErr.code || ''} ${rErr.message || ''}`);
          if (missing) return json({ error: 'could not book the order into stock: this needs a database update. Nothing was received. Ask ServOS to run it.', done: false }, 503);
          if (rErr) { console.error('[po.receive] stock_receive', rErr.message); return json({ error: `could not book the order into stock: ${rErr.message}`, done: false }, 500); }
          if ((rres as any)?.ok === false) return json({ error: (rres as any)?.error || 'the receive was refused', done: false }, 400);
        }
      }

      let subtotal = 0, tax = 0;
      const shorted: any[] = [];
      let received = 0;
      for (const l of lines) {
        const r = byLine[String(l.id)];
        const ordered = Number(l.qty_packs) || 0;
        const accepted = Math.max(0, Number(r?.qty_packs ?? 0) || 0);
        const price = r?.unit_price != null && r.unit_price !== '' ? Number(r.unit_price) : (Number(l.unit_price) || 0);
        if (accepted > 0) received++;
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

    // -- v5.11.84 stock on the phone (multi site stock Drop 0, plan 4.23, re landed from Phase 1b) --
    // Count by area with each figure's own time, saved as you go (one line per count, item and area:
    // a figure sent twice updates the line); approve in ONE database call (approve_stock_count,
    // 20261019b) with a manager PIN (checked above), the PIN holder stored on the count; waste through
    // stock_record_waste. Every step is fenced to this location by the service role reads.
    if (String(action).startsWith('stock.')) {
      const { data: locRow } = await sb.from('locations').select('org_id').eq('id', loc).maybeSingle();
      const orgId = locRow?.org_id || null;
      const who = op.name || 'manager';
      let out: any;
      if (action === 'stock.areas') out = await stockPhone.areas(sb, loc);
      else if (action === 'stock.count_open') out = await stockPhone.openCount(sb, loc, String(target_id), who);
      else if (action === 'stock.items') out = await stockPhone.items(sb, loc, Math.max(0, Number(body.offset) || 0));
      else if (action === 'stock.count_sheet') out = await stockPhone.sheet(sb, loc, String(target_id), Math.max(0, Number(body.offset) || 0));
      else if (action === 'stock.count_save') out = await stockPhone.save(sb, loc, String(target_id), body.entries, { sentAt: body.sent_at || null });
      else if (action === 'stock.count_approve') {
        out = await stockPhone.approve(sb, loc, String(target_id), who, { id: op.id, name: op.name || null });
        // first count of an item with no cost anywhere: answered (not refused) so the phone can name
        // the items and send the manager to Back Office, where a cost can be typed
        if (out?.code === 'needs_cost') return json({ ok: false, code: 'needs_cost', needs_cost: out.needs_cost || [], error: out.error }, 200);
        // v5.11.96 (Drop 3, I7): over the set value it waits for a second approval in Back Office
        // (answered, not refused: the phone shows 'Waiting for a second approval')
        if (out?.waiting) return json({ ok: false, waiting: out.waiting, error: out.error, variance_value: out.variance_value ?? null, limit: out.limit ?? null }, 200);
        if (!out?.error && out?.ok !== false) {
          if (!out?.duplicate && out?.pin_holder_saved === false) console.error(`[manager-approve] stock.count_approve ${target_id}: the PIN holder was not stored on the count`);
          const auditErr = await audit(loc, orgId, op, 'stock.count_approve', 'stock_counts', String(target_id), null, { by: who, posted: out?.posted ?? null, opening: out?.opening ?? null, duplicate: !!out?.duplicate });
          if (auditErr) return auditFailed('The count approval', { approved: true });
        }
      } else if (action === 'stock.waste') {
        // v5.11.96 (Drop 3, J5): waste over the venue's set value needs a manager PIN. The phone
        // proves it here and the database gets the PIN holder (approved_by_staff_*), never the PIN.
        // A manager PIN that opened the sheet counts; otherwise the phone asks for one (manager_pin).
        let approver: any = null;
        if (body.manager_pin) {
          const mgr = await resolveOperator(loc, String(body.manager_pin));
          if (!mgr || !canApprove(mgr)) return json({ ok: false, pin: 'wrong', error: 'That PIN is not a manager at this venue.' }, 200);
          approver = { id: mgr.id, name: mgr.name || null };
        }
        out = await stockPhone.waste(sb, loc, { ...body, item_id: target_id }, who, approver);
        if (out?.ok === false && out?.pin === 'needed' && !approver && pin && canApprove(op)) {
          out = await stockPhone.waste(sb, loc, { ...body, item_id: target_id }, who, { id: op.id, name: op.name || null });
        }
        if (out?.ok === false && out?.pin) return json({ ok: false, pin: out.pin, error: out.error, limit: out.limit ?? null }, 200);
        if (!out?.error && out?.ok !== false) {
          const auditErr = await audit(loc, orgId, op, 'stock.waste', 'waste_events', String(out?.id || target_id), null, { by: who, item: target_id, qty_base: body.qty_base, reason: body.reason || null });
          if (auditErr) return auditFailed('The waste', { recorded: true });
        }
      } else if (action === 'stock.recipe_card') {
        // v5.11.93 (multi site stock Drop 2, contract 3.6): the recipe card for staff (build, method,
        // allergens, kcal; never a cost), read as the service role for THIS venue only
        // (stock_recipe_card(p_loc, p_menu_item_id), migration 20261025a). target_id is the till
        // product. A staff PIN is enough, as for the other stock reads. Before 20261025a the
        // function is missing: said in words, never a throw. Nothing is written.
        const { data, error } = await sb.rpc('stock_recipe_card', { p_loc: loc, p_menu_item_id: String(target_id) });
        if (error) {
          const missing = /PGRST202|42883|could not find the function|does not exist/i.test(`${error.code || ''} ${error.message || ''}`);
          out = { error: missing ? 'Recipe cards need a database update (20261025a).' : (error.message || 'Could not read the recipe card') };
        } else if (data && typeof data === 'object' && (data as any).ok === false) {
          out = { error: (data as any).error || 'No recipe card here.' };
        } else {
          out = { card: data && typeof data === 'object' && !Array.isArray(data) ? data : null };
        }
      } else return json({ error: 'unknown action' }, 400);
      if (out?.error) return json({ error: out.error }, 400);
      if (out?.ok === false) return json({ error: out.error || 'not done' }, 400);
      return json({ ...out, ok: true });
    }

    // -- v5.11.96 (multi site stock Drop 3, contract 3.4): transfers, the central kitchen, shop buys,
    // the fresh close down and forecast edits on the phone. Each is ONE database call as the service
    // role with p_actor (this venue, the PIN holder or the login); the database checks the rest.
    if (action.startsWith('transfer.') || action.startsWith('kitchen.') || action === 'shop.buy' || action === 'waste.closedown' || action === 'forecast.edit') {
      const { data: locRow } = await sb.from('locations').select('org_id, timezone, name').eq('id', loc).maybeSingle();
      const orgId = locRow?.org_id || null;
      const tz = locRow?.timezone || 'Europe/London';
      const today = ymd(new Date(), tz);
      const day = typeof body.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.day) ? body.day : today;
      const who = op.name || 'manager';
      const rpc = async (fn: string, args: Record<string, unknown>) => {
        const { data, error } = await sb.rpc(fn, args);
        if (error) return { error: isMissingFn(error) ? 'This needs a database update (Drop 3). Nothing was changed.' : (error.message || 'not done') };
        if (data && typeof data === 'object' && !Array.isArray(data) && (data as any).ok === false) return { error: (data as any).error || 'not done', answer: data };
        return { data };
      };
      let res: any;
      let auditWhat: string | null = null;
      let auditAfter: any = null;
      if (action === 'transfer.send') {
        res = await phoneSendTransfer(loc, body, who);
        auditWhat = 'transfer.send'; auditAfter = { to: body.to_location_id || null, lines: Array.isArray(body.lines) ? body.lines.length : 0 };
      } else if (action === 'transfer.request') {
        res = await rpc('stock_request_transfer', { p_from: body.from_location_id || null, p_to: loc, p_lines: Array.isArray(body.lines) ? body.lines.slice(0, 300) : [], p_reason: body.reason || null, p_note: body.note || null, p_actor: actor });
        auditWhat = 'transfer.request'; auditAfter = { from: body.from_location_id || null };
      } else if (action === 'transfer.receive') {
        res = await phoneReceiveTransfer(loc, String(target_id), body, who);
        auditWhat = 'transfer.receive';
      } else if (action === 'transfer.dispute') {
        res = await rpc('stock_dispute_transfer', { p_transfer: String(target_id), p_note: String(body.note || ''), p_actor: actor });
        auditWhat = 'transfer.dispute'; auditAfter = { note: String(body.note || '').slice(0, 200) };
      } else if (action === 'kitchen.orders_in') {
        res = await rpc('stock_kitchen_orders_in', { p_kitchen: loc, p_day: day, p_actor: actor });
        if (!res.error) res = { data: { day, orders: Array.isArray(res.data) ? res.data : (res.data?.rows || []) } };
      } else if (action === 'kitchen.plan') {
        res = await rpc('stock_kitchen_plan', { p_kitchen: loc, p_day: day, p_actor: actor });
        if (!res.error) res = { data: { day, rows: Array.isArray(res.data) ? res.data : (res.data?.rows || []) } };
      } else if (action === 'kitchen.pick') {
        res = await rpc('stock_kitchen_pick', { p_po: String(target_id), p_lines: Array.isArray(body.lines) ? body.lines.slice(0, 300) : [], p_actor: actor });
        auditWhat = 'kitchen.pick';
      } else if (action === 'kitchen.done') {
        res = await rpc('stock_kitchen_tick', { p_kitchen: loc, p_recipe: body.recipe_id || target_id || null, p_qty: Number(body.qty), p_day: null, p_actor: actor });
      } else if (action === 'shop.buy') {
        res = await phoneShopBuy(loc, body, who, today);
        auditWhat = 'shop.buy'; auditAfter = { supplier_id: body.supplier_id || null, total: body.total ?? null };
      } else if (action === 'waste.closedown') {
        if (body.list) {
          res = await rpc('stock_fresh_closedown_list', { p_loc: loc, p_day: day, p_actor: actor });
          if (!res.error) res = { data: { day, rows: Array.isArray(res.data) ? res.data : (res.data?.rows || []) } };
        } else {
          let approver: any = null;
          if (body.manager_pin) {
            const mgr = await resolveOperator(loc, String(body.manager_pin));
            if (!mgr || !canApprove(mgr)) return json({ ok: false, pin: 'wrong', error: 'That PIN is not a manager at this venue.' }, 200);
            approver = { id: mgr.id, name: mgr.name || null };
          } else if (pin && canApprove(op)) approver = { id: op.id, name: op.name || null };
          res = await stockPhone.closeDown(sb, loc, body.lines, who, approver);
          if (res?.ok === false && res?.pin) return json({ ok: false, pin: res.pin, error: res.error, limit: res.limit ?? null }, 200);
          res = res?.error ? { error: res.error } : { data: res };
          auditWhat = 'waste.closedown'; auditAfter = { lines: Array.isArray(body.lines) ? body.lines.length : 0 };
        }
      } else if (action === 'forecast.edit') {
        if (body.read) res = { data: await phoneForecastRead(loc, day) };
        else {
          res = await rpc('stock_save_forecast', { p_loc: loc, p_days: Array.isArray(body.days) ? body.days.slice(0, 31) : [], p_hours: Array.isArray(body.hours) ? body.hours : null, p_actor: actor });
          auditWhat = 'forecast.edit'; auditAfter = { days: Array.isArray(body.days) ? body.days.length : 0 };
        }
      } else return json({ error: 'unknown action' }, 400);
      if (res?.error) return json({ error: res.error }, 400);
      if (auditWhat) {
        const data = res?.data;
        const id = String((data && (data.transfer_id || data.id || data.invoice_id)) || target_id || loc);
        const auditErr = await audit(loc, orgId, op, auditWhat, auditWhat.split('.')[0], id, null, { by: who, ...(auditAfter || {}) });
        // the words avoid "PIN", "approve" and "not allowed" (the app would ask for the PIN again)
        const what = ({ transfer: 'The transfer', kitchen: 'The pick', shop: 'The shop buy', waste: 'The close down', forecast: 'The forecast' } as Record<string, string>)[auditWhat.split('.')[0]] || 'It';
        if (auditErr) return auditFailed(`${what}`, { answer: data ?? null });
      }
      const data = res?.data;
      return json({ ...(data && typeof data === 'object' && !Array.isArray(data) ? data : { rows: data ?? null }), ok: true });
    }

    return json({ error: 'unknown action' }, 400);
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});

// -- v5.11.96 (Drop 3) phone steps that are more than one database call ------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// transfer.send: the Back Office createTransfer shape (a DRAFT and its lines at this venue), then the
// 'out' leg (stock leaves at this venue's cost, in transit). body: { to_location_id, reason?, note?,
// lines: [{ inventory_item_id, qty_base }] }. The other venue must be in the same company.
async function phoneSendTransfer(loc: string, body: any, who: string): Promise<any> {
  const to = String(body.to_location_id || '');
  if (!UUID.test(to) || to === loc) return { error: 'Pick the venue to send to.' };
  const lines = (Array.isArray(body.lines) ? body.lines : []).filter((l: any) => l && UUID.test(String(l.inventory_item_id || '')) && Number(l.qty_base) > 0).slice(0, 300);
  if (!lines.length) return { error: 'Add at least one line with a quantity.' };
  const { data: locs } = await sb.from('locations').select('id, org_id').in('id', [loc, to]);
  const orgOf: Record<string, string> = {};
  for (const l of locs ?? []) orgOf[l.id] = l.org_id;
  if (!orgOf[loc] || orgOf[loc] !== orgOf[to]) return { error: 'That venue is not in this company.' };
  const ids = [...new Set(lines.map((l: any) => String(l.inventory_item_id)))];
  const { data: items } = await sb.from('inventory_items').select('id, name, sku, base_unit').eq('location_id', loc).in('id', ids);
  const itemBy: Record<string, any> = {};
  for (const it of items ?? []) itemBy[it.id] = it;
  if (ids.some((id) => !itemBy[id])) return { error: 'One or more items are not at this venue.' };
  const reference = 'TR-' + Date.now().toString(36).toUpperCase();
  const { data: head, error: hErr } = await sb.from('stock_transfers').insert({
    location_id: loc, to_location_id: to, status: 'DRAFT', reference, note: body.note ? String(body.note).slice(0, 300) : null,
    created_by_name: who, ...(body.reason ? { reason: String(body.reason).slice(0, 60) } : {}),
  }).select('id').single();
  if (hErr || !head) return { error: 'Could not save the transfer.' };
  const rows = lines.map((l: any, i: number) => {
    const it = itemBy[String(l.inventory_item_id)];
    return { transfer_id: head.id, location_id: loc, to_location_id: to, inventory_item_id: it.id, name_snapshot: it.name || null,
      sku_snapshot: it.sku || null, base_unit: it.base_unit || null, qty_base: Number(l.qty_base), sort_order: i };
  });
  const { error: lErr } = await sb.from('stock_transfer_lines').insert(rows);
  if (lErr) { await sb.from('stock_transfers').delete().eq('id', head.id).eq('status', 'DRAFT'); return { error: 'Could not save the transfer lines.' }; }
  const { data: leg, error: legErr } = await sb.rpc('post_stock_transfer_leg', { p_transfer_id: head.id, p_leg: 'out', p_by_name: who });
  if (legErr || (leg as any)?.ok === false) return { error: `${reference} is saved but nothing moved: ${legErr?.message || (leg as any)?.error || 'refused'}. Open it in Back Office, Transfers.` };
  return { data: { transfer_id: head.id, reference, status: 'SENT' } };
}

// transfer.receive: a SENT transfer to this venue. Each line is matched to this venue's item (the
// kitchen pick and a request set it already; else by SKU, then by name), the received amount is
// written (body.lines [{ line_id, qty_received_base }], else as sent), then the 'in' leg.
async function phoneReceiveTransfer(loc: string, transferId: string, body: any, who: string): Promise<any> {
  const { data: t } = await sb.from('stock_transfers').select('id, status, to_location_id, reference').eq('id', transferId).maybeSingle();
  if (!t || t.to_location_id !== loc) return { error: 'Transfer not found for this venue.' };
  if (t.status !== 'SENT') return { error: `This transfer is ${String(t.status).toLowerCase()}.` };
  const { data: lines } = await sb.from('stock_transfer_lines').select('id, name_snapshot, sku_snapshot, qty_base, to_inventory_item_id, lot_code, use_by_at').eq('transfer_id', transferId).order('sort_order');
  const want: Record<string, number> = {};
  for (const r of (Array.isArray(body.lines) ? body.lines : [])) if (r && r.line_id != null && Number(r.qty_received_base) >= 0) want[String(r.line_id)] = Number(r.qty_received_base);
  const { data: mine } = await sb.from('inventory_items').select('id, name, sku').eq('location_id', loc).is('archived_at', null).limit(1000);
  const bySku: Record<string, string> = {};
  const byName: Record<string, string> = {};
  for (const it of mine ?? []) {
    if (it.sku) bySku[String(it.sku).trim().toLowerCase()] ??= it.id;
    if (it.name) byName[String(it.name).trim().toLowerCase()] ??= it.id;
  }
  const lots: any[] = [];
  for (const l of lines ?? []) {
    const match = l.to_inventory_item_id || (l.sku_snapshot && bySku[String(l.sku_snapshot).trim().toLowerCase()]) || (l.name_snapshot && byName[String(l.name_snapshot).trim().toLowerCase()]) || null;
    if (!match) return { error: `${l.name_snapshot || 'An item'} has no match here. Receive it in Back Office, Transfers.` };
    const got = want[String(l.id)] ?? Number(l.qty_base);
    const { error } = await sb.from('stock_transfer_lines').update({ to_inventory_item_id: match, qty_received_base: got, dropped: false }).eq('transfer_id', transferId).eq('id', l.id);
    if (error) return { error: 'Could not save what arrived.' };
    if (l.lot_code || l.use_by_at) lots.push({ name: l.name_snapshot, lot_code: l.lot_code || null, use_by_at: l.use_by_at || null });
  }
  const { data: leg, error: legErr } = await sb.rpc('post_stock_transfer_leg', { p_transfer_id: transferId, p_leg: 'in', p_by_name: who });
  if (legErr) return { error: legErr.message || 'The receive was refused.' };
  if ((leg as any)?.ok === false) return { error: (leg as any).error || 'The receive was refused.' };
  return { data: { transfer_id: transferId, reference: t.reference, received: true, lots } };
}

// shop.buy: bought at a shop and received with no order (stock_post_invoice with shop_buy true and a
// supplier row of this venue). body: { supplier_id, receipt_number?, total?, client_id?,
// lines: [{ inventory_item_id, qty_base, line_total }], scan?: { image_base64, media_type } }.
async function phoneShopBuy(loc: string, body: any, who: string, today: string): Promise<any> {
  const supplierId = String(body.supplier_id || '');
  if (!UUID.test(supplierId)) return { error: 'Pick the shop or supplier.' };
  const { data: sup } = await sb.from('suppliers').select('id').eq('id', supplierId).eq('location_id', loc).maybeSingle();
  if (!sup) return { error: 'supplier not found for this location' };
  const raw = (Array.isArray(body.lines) ? body.lines : []).filter((l: any) => l && UUID.test(String(l.inventory_item_id || '')) && Number(l.qty_base) > 0).slice(0, 100);
  if (!raw.length) return { error: 'Add what you bought.' };
  const ids = [...new Set(raw.map((l: any) => String(l.inventory_item_id)))];
  const { data: items } = await sb.from('inventory_items').select('id, name, base_unit').eq('location_id', loc).in('id', ids);
  const itemBy: Record<string, any> = {};
  for (const it of items ?? []) itemBy[it.id] = it;
  if (ids.some((id) => !itemBy[id])) return { error: 'one or more items are not from this location' };
  let imagePath: string | null = null;
  if (body.scan && typeof body.scan.image_base64 === 'string' && body.scan.image_base64.length) {
    try {
      const mediaType = String(body.scan.media_type || 'image/jpeg');
      const ext = mediaType === 'application/pdf' ? 'pdf' : mediaType === 'image/png' ? 'png' : mediaType === 'image/webp' ? 'webp' : 'jpg';
      const path = `${loc}/shop/${Date.now()}.${ext}`;
      const bytes = Uint8Array.from(atob(body.scan.image_base64), (c) => c.charCodeAt(0));
      const up = await sb.storage.from('invoice-scans').upload(path, bytes, { contentType: mediaType, upsert: false });
      if (!up.error) imagePath = path; else console.error('[shop.buy] receipt upload', up.error.message);
    } catch (e) { console.error('[shop.buy] receipt upload', String((e as Error)?.message || e)); }
  }
  const pLines: any[] = [];
  const receipts: any[] = [];
  let total = 0;
  raw.forEach((l: any, i: number) => {
    const it = itemBy[String(l.inventory_item_id)];
    const qty = Number(l.qty_base);
    const lineTotal = Math.max(0, Math.round((Number(l.line_total) || 0) * 100) / 100);
    total += lineTotal;
    pLines.push({ matched_item_id: it.id, description: it.name || null, qty, unit: it.base_unit || 'each', unit_price: qty > 0 ? Math.round((lineTotal / qty) * 10000) / 10000 : 0,
      line_total: lineTotal, purchase_tax_rate_id: null, line_tax: 0, flags: ['shop_buy'], supplier_product_id: null });
    receipts.push({ line_index: i, item_id: it.id, qty_base: qty, unit_cost: qty > 0 ? lineTotal / qty : 0, supplier_product_id: null, pack_price: null, pack_label: it.base_unit || null });
  });
  const { data, error } = await sb.rpc('stock_post_invoice', {
    p_location_id: loc,
    p_invoice: {
      client_id: typeof body.client_id === 'string' && UUID.test(body.client_id) ? body.client_id : null,
      supplier_id: supplierId, invoice_number: body.receipt_number ? String(body.receipt_number).slice(0, 60) : null, invoice_date: today,
      subtotal: Math.round(total * 100) / 100, tax: 0, total: body.total != null && Number.isFinite(Number(body.total)) ? Number(body.total) : Math.round(total * 100) / 100,
      raw_json: { source: 'manager_app', by: who }, image_path: imagePath, po_id: null, shop_buy: true,
    },
    p_lines: pLines, p_receipts: receipts, p_area_id: null,
  });
  if (error) return { error: isMissingFn(error) ? 'This needs a database update. Nothing was booked.' : (error.message || 'Could not book the shop buy.') };
  if ((data as any)?.ok === false) return { error: (data as any).error || 'The shop buy was refused.' };
  return { data: { ...(data && typeof data === 'object' ? data : {}), booked: raw.length } };
}

// forecast.edit with read: the saved forecast for the 7 days from `day` (stock_forecast_week is a
// Back Office read; the phone reads the same table as the service role, this venue only).
async function phoneForecastRead(loc: string, day: string): Promise<any> {
  const to = new Date(Date.parse(`${day}T00:00:00Z`) + 6 * 86400000).toISOString().slice(0, 10);
  let { data, error } = await sb.from('wf_sales_forecast').select('forecast_date, amount, reason, reason_note, edited_by_name')
    .eq('location_id', loc).gte('forecast_date', day).lte('forecast_date', to).order('forecast_date');
  if (error && isMissingTable(error)) ({ data } = await sb.from('wf_sales_forecast').select('forecast_date, amount').eq('location_id', loc).gte('forecast_date', day).lte('forecast_date', to).order('forecast_date'));
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(Date.parse(`${day}T00:00:00Z`) + i * 86400000).toISOString().slice(0, 10);
    const row = (data ?? []).find((r: any) => r.forecast_date === d) || null;
    days.push({ day: d, amount: row ? Number(row.amount) : null, reason: row?.reason || null, reason_note: row?.reason_note || null, edited_by_name: row?.edited_by_name || null });
  }
  return { days };
}
