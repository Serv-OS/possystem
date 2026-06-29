// supabase/functions/manager-snapshot/index.ts
//
// Single-venue data engine for the ServOS Manager app (?mode=manager). One round trip returns the
// PAIRED location's "today" money + the live floor + live team, for a paired device (anon) or a BO
// user. Money mirrors owner-snapshot exactly (net = closed_checks.subtotal EX-VAT; pennies; VAT is
// a liability, never profit). The client classifies floor/team with the unit-tested engines in
// src/lib/manager/*. Service-role reads, fenced by location + caller.
//
//   POST { action:'snapshot', ops_location_id }  — token in Authorization header.
// Auth: the device claimed to THIS location (ops_devices.device_uid = auth.uid()), OR a BO user with
// user_locations for it, OR super_admin. Single venue only — multi-site rollups stay in Back Office.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const sb = createClient(Deno.env.get('SUPABASE_URL') ?? '', SERVICE_ROLE, { auth: { autoRefreshToken: false, persistSession: false } });

const r2 = (n: number) => Math.round(n * 100) / 100;
const ymd = (d: Date, tz: string) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const ms = (v: any) => { if (v == null) return null; const t = typeof v === 'number' ? v : Date.parse(v); return Number.isFinite(t) ? t : null; };

async function requireManager(req: Request, loc: string): Promise<{ ok: true } | { ok: false; res: Response }> {
  const token = (req.headers.get('Authorization') ?? '').replace('Bearer ', '').trim();
  if (!token) return { ok: false, res: json({ error: 'auth required' }, 401) };
  if (token === SERVICE_ROLE) return { ok: true };
  const { data: { user } } = await sb.auth.getUser(token);
  if (!user) return { ok: false, res: json({ error: 'invalid session' }, 401) };
  // Paired device claimed to this location (and not decommissioned)?
  const { data: dev } = await sb.from('ops_devices').select('id').eq('device_uid', user.id).eq('location_id', loc).eq('active', true).not('claimed_at', 'is', null).maybeSingle();
  if (dev) return { ok: true };
  // BO user with access, or super admin?
  const [{ data: ul }, { data: prof }] = await Promise.all([
    sb.from('user_locations').select('location_id').eq('user_id', user.id).eq('location_id', loc).maybeSingle(),
    sb.from('user_profiles').select('role').eq('id', user.id).maybeSingle(),
  ]);
  if (ul || prof?.role === 'super_admin') return { ok: true };
  return { ok: false, res: json({ error: 'no access to this location' }, 403) };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  let body: any; try { body = await req.json(); } catch { return json({ error: 'bad json' }, 400); }
  const loc = body?.ops_location_id;
  if (!loc) return json({ error: 'ops_location_id required' }, 400);
  const acc = await requireManager(req, loc); if (!acc.ok) return acc.res;

  try {
    // Venue metadata (timezone for "today", currency).
    const [{ data: vs }, { data: locRow }] = await Promise.all([
      sb.from('wf_venue_settings').select('currency, labour_target_pct').eq('location_id', loc).maybeSingle(),
      sb.from('locations').select('timezone, name').eq('id', loc).maybeSingle(),
    ]);
    const tz = locRow?.timezone || 'Europe/London';
    const currency = vs?.currency || 'GBP';
    const now = new Date();
    const today = ymd(now, tz);
    const startIso = new Date(now.getTime() - 36 * 3600 * 1000).toISOString(); // pad ±tz; filter to `today` below

    const [{ data: checks }, { data: fc }, { data: tsRows }, { data: shifts }, { data: staff }, { data: sess }] = await Promise.all([
      sb.from('closed_checks').select('subtotal, total, tip, status, voided, closed_at').eq('location_id', loc).gte('closed_at', startIso).limit(20000),
      sb.from('wf_sales_forecast').select('forecast_date, amount').eq('location_id', loc).eq('forecast_date', today).maybeSingle(),
      sb.from('wf_timesheets').select('staff_id, clock_in, clock_out, break_taken, break_open_at, pay_amount, status, effective_rate').eq('location_id', loc).gte('clock_in', startIso).limit(5000),
      sb.from('wf_shifts').select('staff_id, role_key, shift_date, start_time, finish_time, status').eq('location_id', loc).eq('shift_date', today).limit(2000),
      sb.from('wf_staff').select('id, name').eq('location_id', loc).limit(2000),
      sb.from('active_sessions').select('table_id, session').eq('location_id', loc).limit(2000),
    ]);

    // ── Money (today, venue-local) — net = subtotal (ex-VAT), exclude voided ──
    let net = 0, gross = 0, orders = 0, tips = 0;
    for (const c of checks ?? []) {
      if (c.voided || String(c.status || '') === 'voided') continue;
      if (ymd(new Date(c.closed_at), tz) !== today) continue;
      net += Number(c.subtotal) || 0; gross += Number(c.total) || 0; orders += 1; tips += Number(c.tip) || 0;
    }
    let labour = 0;
    for (const t of tsRows ?? []) {
      if (!['approved', 'paid'].includes(String(t.status))) continue;
      if (!t.clock_in || ymd(new Date(t.clock_in), tz) !== today) continue;
      labour += Number(t.pay_amount) || 0;
    }
    const forecast = Number(fc?.amount) || 0;
    const money = {
      currency,
      net: r2(net), gross: r2(gross), orders, tips: r2(tips),
      avgCheck: orders ? r2(net / orders) : 0,
      forecast: r2(forecast), forecastPct: forecast > 0 ? Math.round((net / forecast) * 100) : null,
      labour: r2(labour), labourPct: net > 0 ? r2((labour / net) * 100) : null,
      labourTargetPct: vs?.labour_target_pct != null ? Number(vs.labour_target_pct) : null,
    };

    // ── Floor (active_sessions.session jsonb → floor.js input shape) ──
    const floor = (sess ?? []).map((row: any) => {
      const s = row.session || {};
      const items = Array.isArray(s.items) ? s.items : [];
      const hasOrder = !!s.sentAt || items.some((i: any) => i.status === 'sent' || i.fired);
      return {
        id: row.table_id || s.id || null,
        label: row.table_id || 'Table',
        covers: Number(s.covers) || null,
        seatedAtMs: ms(s.seatedAt),
        lastFiredAtMs: ms(s.sentAt),
        hasOrder,
        status: s.status || null,
        server: s.server || null,
      };
    });

    // ── Team (timesheets + today's shifts → team.js input shape) ──
    const nameOf: Record<string, string> = {};
    for (const m of staff ?? []) nameOf[m.id] = m.name;
    const punches = (tsRows ?? [])
      .filter((t: any) => t.clock_in && ymd(new Date(t.clock_in), tz) === today)
      .map((t: any) => ({
        staffId: t.staff_id, name: nameOf[t.staff_id] || 'Staff',
        inMs: ms(t.clock_in), outMs: ms(t.clock_out),
        breakMins: Number(t.break_taken) || 0, breakOpen: !!t.break_open_at,
      }));
    const parseShiftMs = (date: string, time: string) => (date && time ? ms(`${date}T${time}`) : null);
    const teamShifts = (shifts ?? [])
      .filter((sh: any) => String(sh.status) === 'published')
      .map((sh: any) => ({
        staffId: sh.staff_id, name: nameOf[sh.staff_id] || 'Staff', role: sh.role_key || null,
        startMs: parseShiftMs(sh.shift_date, sh.start_time), endMs: parseShiftMs(sh.shift_date, sh.finish_time),
      }));
    const ratesMinor: Record<string, number> = {};
    for (const t of tsRows ?? []) if (t.effective_rate != null) ratesMinor[t.staff_id] = Math.round(Number(t.effective_rate) * 100);

    // ── Approvals inbox (pending) — completed-but-unapproved timesheets (last 14d) + pending time-off.
    //    Surfaced for the Team tab's approvals (the UI gates display on the team_approvals flag; writes
    //    go through the manager-approve edge fn). Isolated: never break the rest of the snapshot. ──
    let pendingTimesheets: any[] = [], pendingTimeOff: any[] = [];
    try {
      const since = new Date(now.getTime() - 14 * 24 * 3600 * 1000).toISOString();
      const [{ data: pts }, { data: pto }] = await Promise.all([
        sb.from('wf_timesheets').select('id, staff_id, clock_in, clock_out, break_taken, status')
          .eq('location_id', loc).gte('clock_in', since).not('clock_out', 'is', null)
          .not('status', 'in', '(approved,paid)').order('clock_in', { ascending: false }).limit(200),
        sb.from('wf_time_off').select('id, staff_id, type, start_date, end_date, days, note, status')
          .eq('location_id', loc).eq('status', 'pending').order('start_date', { ascending: true }).limit(200),
      ]);
      pendingTimesheets = (pts ?? []).map((t: any) => ({
        id: t.id, staffId: t.staff_id, name: nameOf[t.staff_id] || 'Staff',
        inMs: ms(t.clock_in), outMs: ms(t.clock_out), breakMins: Number(t.break_taken) || 0, status: t.status,
      }));
      pendingTimeOff = (pto ?? []).map((l: any) => ({
        id: l.id, staffId: l.staff_id, name: nameOf[l.staff_id] || 'Staff', type: l.type,
        startDate: l.start_date, endDate: l.end_date, days: Number(l.days) || 0, note: l.note || null,
      }));
    } catch { pendingTimesheets = []; pendingTimeOff = []; }

    // ── Kitchen: stock items below par/reorder, for one PO per supplier (read-only). Greenfield stock
    //    system (inventory_items + par_levels); only items WITH a par row are "managed" → kept. The
    //    client (kitchen.js belowPar/bySupplier) decides what's short. Isolated: a stock read failure
    //    must never break takings/floor/team, so default to []. ──
    let kitchenItems: any[] = [];
    try {
      const { data: pars } = await sb.from('par_levels')
        .select('inventory_item_id, par_level, reorder_point').eq('location_id', loc).limit(5000);
      const ids = (pars ?? []).map((p: any) => p.inventory_item_id).filter(Boolean);
      if (ids.length) {
        const [{ data: invs }, { data: sups }] = await Promise.all([
          sb.from('inventory_items').select('id, name, on_hand, default_supplier_id')
            .eq('location_id', loc).in('id', ids).is('archived_at', null),
          sb.from('suppliers').select('id, name').eq('location_id', loc).limit(2000),
        ]);
        const supName: Record<string, string> = {};
        for (const s of sups ?? []) supName[s.id] = s.name;
        const parBy: Record<string, any> = {};
        for (const p of pars ?? []) parBy[p.inventory_item_id] = p;
        kitchenItems = (invs ?? []).map((i: any) => {
          const p = parBy[i.id] || {};
          return {
            itemId: i.id, name: i.name,
            onHand: Number(i.on_hand) || 0,
            par: p.par_level != null ? Number(p.par_level) : null,
            reorderPoint: p.reorder_point != null ? Number(p.reorder_point) : null,
            supplier: i.default_supplier_id ? (supName[i.default_supplier_id] || null) : null,
            eightySixed: false,
          };
        });
      }
    } catch { kitchenItems = []; }

    // ── Ops: cheap headline counts for the Home tile (full detail lives in the Ops tab). Isolated. ──
    let ops = { openMaintenance: 0, activeAlerts: 0 };
    try {
      const [{ data: maint }, { data: al }] = await Promise.all([
        sb.from('maintenance_requests').select('status').eq('location_id', loc).limit(2000),
        sb.from('ops_alerts').select('id').eq('location_id', loc).eq('status', 'sent').limit(2000),
      ]);
      ops = {
        openMaintenance: (maint ?? []).filter((m: any) => !['resolved', 'cancelled'].includes(String(m.status))).length,
        activeAlerts: (al ?? []).length,
      };
    } catch { ops = { openMaintenance: 0, activeAlerts: 0 }; }

    // ── Kitchen incoming: open POs (SENT/PARTIAL) awaiting goods-in, with any delivery status. Read-only
    //    summary for the Kitchen tab; the actual goods-in check happens in Ops → Deliveries. Isolated. ──
    let kitchenDeliveries: any[] = [];
    try {
      const { data: pos } = await sb.from('purchase_orders')
        .select('id, reference, supplier_id, expected_date, status').eq('location_id', loc)
        .in('status', ['SENT', 'PARTIAL']).order('expected_date', { ascending: true }).limit(500);
      if ((pos ?? []).length) {
        const poIds = (pos ?? []).map((p: any) => p.id);
        const [{ data: dels }, { data: lines }, { data: sups }] = await Promise.all([
          sb.from('deliveries').select('po_id, status').eq('location_id', loc).in('po_id', poIds).limit(2000),
          sb.from('po_lines').select('po_id').in('po_id', poIds).limit(20000),
          sb.from('suppliers').select('id, name').eq('location_id', loc).limit(2000),
        ]);
        const delByPo: Record<string, string> = {};
        for (const d of dels ?? []) if (d.po_id && !delByPo[d.po_id]) delByPo[d.po_id] = d.status;
        const lineBy: Record<string, number> = {};
        for (const l of lines ?? []) lineBy[l.po_id] = (lineBy[l.po_id] || 0) + 1;
        const supName: Record<string, string> = {};
        for (const s of sups ?? []) supName[s.id] = s.name;
        kitchenDeliveries = (pos ?? []).map((p: any) => ({
          id: p.id, reference: p.reference || null,
          supplier: p.supplier_id ? (supName[p.supplier_id] || null) : null,
          lines: lineBy[p.id] || 0, expectedDate: p.expected_date || null,
          status: delByPo[p.id] || 'pending',   // pending | accepted | rejected
        }));
      }
    } catch { kitchenDeliveries = []; }

    return json({
      ok: true, location_id: loc, venueName: locRow?.name || '', tz,
      money, floor, team: { punches, shifts: teamShifts, ratesMinor, pendingTimesheets, pendingTimeOff },
      kitchen: { items: kitchenItems, deliveries: kitchenDeliveries },
      ops,
      generated_at: new Date().toISOString(),
    });
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
