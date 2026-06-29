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
  // Paired device claimed to this location?
  const { data: dev } = await sb.from('ops_devices').select('id').eq('device_uid', user.id).eq('location_id', loc).not('claimed_at', 'is', null).maybeSingle();
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

    return json({
      ok: true, location_id: loc, venueName: locRow?.name || '', tz,
      money, floor, team: { punches, shifts: teamShifts, ratesMinor },
      generated_at: new Date().toISOString(),
    });
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
