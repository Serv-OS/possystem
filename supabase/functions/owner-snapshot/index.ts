// supabase/functions/owner-snapshot/index.ts
//
// The owner phone app's data engine. Given a back-office user's token it resolves
// every location they can access and returns a compact top-down snapshot for each,
// plus a combined rollup — in one round trip (mobile-friendly).
//
// Per location (venue-local "today"):
//   • net sales (closed_checks.subtotal, ex-VAT) + gross, orders, avg check, tips
//   • forecast (wf_sales_forecast) + % to forecast
//   • actual labour today (wf_timesheets, approved/paid) + labour % of sales
//   • same weekday last week (for a like-for-like read)
//   • week-to-date net sales vs the same span last week
//   • live: open orders (order_queue) + open tables (active_sessions)
//   • top items today (from closed_checks.items)
//
//   POST {}  — token in Authorization header; no body needed.
// Auth: any back-office user; locations fenced to user_locations (super_admin → all, capped).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const opsAdmin = createClient(Deno.env.get('SUPABASE_URL') ?? '', SERVICE_ROLE, { auth: { autoRefreshToken: false, persistSession: false } });
const platformAdmin = createClient(Deno.env.get('PLATFORM_SUPABASE_URL') ?? '', Deno.env.get('PLATFORM_SUPABASE_SERVICE_ROLE_KEY') ?? '', { auth: { autoRefreshToken: false, persistSession: false } });

const r2 = (n: number) => Math.round(n * 100) / 100;
const ymd = (d: Date, tz: string) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
// Monday-start week key for a venue-local date string.
function weekStartOf(ymdStr: string): string {
  const d = new Date(ymdStr + 'T00:00:00Z');
  const dow = (d.getUTCDay() + 6) % 7;   // Mon=0
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}
const addDays = (ymdStr: string, n: number) => { const d = new Date(ymdStr + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const LIVE_DONE = new Set(['collected', 'cancelled', 'canceled', 'rejected', 'refunded', 'completed', 'done', 'void', 'voided']);

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  const token = (req.headers.get('Authorization') ?? '').replace('Bearer ', '').trim();
  if (!token) return json({ error: 'auth required' }, 401);
  const { data: { user } } = await opsAdmin.auth.getUser(token);
  if (!user) return json({ error: 'invalid session' }, 401);

  // Accessible ops locations: user_locations, or every location for super_admin (capped).
  const { data: prof } = await opsAdmin.from('user_profiles').select('role').eq('id', user.id).maybeSingle();
  const isSuper = prof?.role === 'super_admin';
  let opsIds: string[] = [];
  if (isSuper) {
    const { data } = await opsAdmin.from('locations').select('id').limit(50);
    opsIds = (data ?? []).map((l: any) => l.id);
  } else {
    const { data } = await opsAdmin.from('user_locations').select('location_id').eq('user_id', user.id);
    opsIds = [...new Set((data ?? []).map((r: any) => r.location_id))];
  }
  if (!opsIds.length) return json({ ok: true, locations: [], rollup: emptyRollup(), generated_at: new Date().toISOString() });

  // Names + timezones (platform) and currencies (ops wf_venue_settings).
  const meta: Record<string, { name: string; tz: string; currency: string }> = {};
  const orFilter = opsIds.flatMap(id => [`ops_location_id.eq.${id}`, `id.eq.${id}`]).join(',') || 'id.is.null';
  const { data: plocs } = await platformAdmin.from('locations').select('id, ops_location_id, name, timezone').or(orFilter);
  for (const p of plocs ?? []) { const k = p.ops_location_id || p.id; if (k) meta[k] = { name: p.name || 'Location', tz: p.timezone || 'Europe/London', currency: 'GBP' }; }
  const { data: vsRows } = await opsAdmin.from('wf_venue_settings').select('location_id, currency').in('location_id', opsIds);
  for (const v of vsRows ?? []) { if (meta[v.location_id]) meta[v.location_id].currency = v.currency || 'GBP'; else meta[v.location_id] = { name: 'Location', tz: 'Europe/London', currency: v.currency || 'GBP' }; }
  for (const id of opsIds) { if (!meta[id]) meta[id] = { name: 'Location', tz: 'Europe/London', currency: 'GBP' }; }

  const now = new Date();
  // Widest window we need: start of LAST week (Monday) for any tz → today. Pad ±14h for tz.
  // Compute per-location day keys after fetching, but bound the SQL query generously.
  const earliest = new Date(now); earliest.setUTCDate(earliest.getUTCDate() - 21); // safe lower bound
  const startIso = earliest.toISOString();
  const endIso = new Date(now.getTime() + 14 * 3600 * 1000).toISOString();

  // ── Batched fetches across all accessible locations ──
  const [{ data: checks }, { data: fcRows }, { data: ts }, { data: oq }, { data: sess }] = await Promise.all([
    opsAdmin.from('closed_checks').select('location_id, subtotal, total, tip, status, voided, closed_at, items').in('location_id', opsIds).gte('closed_at', startIso).lte('closed_at', endIso).limit(50000),
    opsAdmin.from('wf_sales_forecast').select('location_id, forecast_date, amount').in('location_id', opsIds).gte('forecast_date', addDays(ymd(now, 'Europe/London'), -21)),
    opsAdmin.from('wf_timesheets').select('location_id, clock_in, pay_amount, status').in('location_id', opsIds).gte('clock_in', startIso).lte('clock_in', endIso).limit(50000),
    opsAdmin.from('order_queue').select('location_id, status').in('location_id', opsIds).limit(20000),
    opsAdmin.from('active_sessions').select('location_id').in('location_id', opsIds).limit(20000),
  ]);

  // Per-location day keys
  const day: Record<string, { today: string; lwToday: string; wkStart: string; lwStart: string; lwEnd: string }> = {};
  for (const id of opsIds) {
    const tz = meta[id].tz;
    const today = ymd(now, tz);
    const wkStart = weekStartOf(today);
    day[id] = { today, lwToday: addDays(today, -7), wkStart, lwStart: addDays(wkStart, -7), lwEnd: addDays(today, -7) };
  }

  // Aggregate sales/orders/tips per location per venue-local day + collect today's items
  type Agg = { net: number; gross: number; orders: number; tips: number };
  const byDay: Record<string, Record<string, Agg>> = {};   // loc -> day -> agg
  const todayItems: Record<string, Record<string, { name: string; qty: number; rev: number }>> = {};
  for (const c of checks ?? []) {
    if (c.voided || c.status === 'voided') continue;
    const id = c.location_id; const tz = meta[id]?.tz || 'Europe/London';
    const k = ymd(new Date(c.closed_at), tz);
    (byDay[id] ??= {});
    const a = (byDay[id][k] ??= { net: 0, gross: 0, orders: 0, tips: 0 });
    a.net += Number(c.subtotal) || 0; a.gross += Number(c.total) || 0; a.orders += 1; a.tips += Number(c.tip) || 0;
    if (k === day[id]?.today && Array.isArray(c.items)) {
      const ti = (todayItems[id] ??= {});
      for (const it of c.items) { if (it?.voided) continue; const nm = it?.name || 'Item'; const q = Number(it?.qty) || 1; const e = (ti[nm] ??= { name: nm, qty: 0, rev: 0 }); e.qty += q; e.rev += (Number(it?.price) || 0) * q; }
    }
  }

  // Forecast per loc/day
  const fc: Record<string, Record<string, number>> = {};
  for (const f of fcRows ?? []) { (fc[f.location_id] ??= {})[f.forecast_date] = Number(f.amount) || 0; }

  // Actual labour per loc, today (venue-local clock_in day)
  const labourToday: Record<string, number> = {};
  for (const t of ts ?? []) { if (!['approved', 'paid'].includes(t.status)) continue; const id = t.location_id; const tz = meta[id]?.tz || 'Europe/London'; if (ymd(new Date(t.clock_in), tz) === day[id]?.today) labourToday[id] = (labourToday[id] || 0) + (Number(t.pay_amount) || 0); }

  // Live orders + open tables
  const liveOrders: Record<string, number> = {};
  for (const o of oq ?? []) { if (LIVE_DONE.has(String(o.status || '').toLowerCase())) continue; liveOrders[o.location_id] = (liveOrders[o.location_id] || 0) + 1; }
  const openTables: Record<string, number> = {};
  for (const s of sess ?? []) { openTables[s.location_id] = (openTables[s.location_id] || 0) + 1; }

  const sumRange = (id: string, from: string, to: string) => {
    let net = 0; const dd = byDay[id] || {};
    for (const [k, a] of Object.entries(dd)) if (k >= from && k <= to) net += a.net;
    return r2(net);
  };

  const locations = opsIds.map((id) => {
    const d = day[id]; const dd = byDay[id] || {};
    const t = dd[d.today] || { net: 0, gross: 0, orders: 0, tips: 0 };
    const lwT = dd[d.lwToday] || { net: 0 };
    const forecast = fc[id]?.[d.today] ?? 0;
    const labour = labourToday[id] ?? 0;
    const wtd = sumRange(id, d.wkStart, d.today);
    const lwWtd = sumRange(id, d.lwStart, d.lwEnd);
    const top = Object.values(todayItems[id] || {}).sort((a, b) => b.qty - a.qty).slice(0, 5).map(x => ({ name: x.name, qty: x.qty, rev: r2(x.rev) }));
    return {
      ops_location_id: id, name: meta[id].name, currency: meta[id].currency, tz: meta[id].tz,
      today: {
        net_sales: r2(t.net), gross_sales: r2(t.gross), orders: t.orders, tips: r2(t.tips),
        avg_check: t.orders ? r2(t.net / t.orders) : 0,
        forecast: r2(forecast), forecast_pct: forecast > 0 ? Math.round(t.net / forecast * 100) : null,
        labour: r2(labour), labour_pct: t.net > 0 ? r2(labour / t.net * 100) : null,
        last_week_sales: r2(lwT.net),
      },
      wtd: { net_sales: wtd, last_week_net_sales: lwWtd, vs_last_week_pct: lwWtd > 0 ? Math.round((wtd - lwWtd) / lwWtd * 100) : null },
      live: { orders: liveOrders[id] || 0, tables: openTables[id] || 0 },
      top_items: top,
    };
  }).sort((a, b) => b.today.net_sales - a.today.net_sales);

  const rollup = locations.reduce((acc, l) => ({
    locations: acc.locations + 1,
    net_sales: r2(acc.net_sales + l.today.net_sales),
    forecast: r2(acc.forecast + l.today.forecast),
    orders: acc.orders + l.today.orders,
    tips: r2(acc.tips + l.today.tips),
    labour: r2(acc.labour + l.today.labour),
    live_orders: acc.live_orders + l.live.orders,
    open_tables: acc.open_tables + l.live.tables,
    wtd_net: r2(acc.wtd_net + l.wtd.net_sales),
    wtd_last_week: r2(acc.wtd_last_week + l.wtd.last_week_net_sales),
  }), emptyRollup());
  (rollup as any).forecast_pct = rollup.forecast > 0 ? Math.round(rollup.net_sales / rollup.forecast * 100) : null;
  (rollup as any).labour_pct = rollup.net_sales > 0 ? r2(rollup.labour / rollup.net_sales * 100) : null;
  (rollup as any).wtd_vs_last_week_pct = rollup.wtd_last_week > 0 ? Math.round((rollup.wtd_net - rollup.wtd_last_week) / rollup.wtd_last_week * 100) : null;

  return json({ ok: true, user: { id: user.id, email: user.email }, locations, rollup, generated_at: new Date().toISOString() });
});

function emptyRollup() {
  return { locations: 0, net_sales: 0, forecast: 0, orders: 0, tips: 0, labour: 0, live_orders: 0, open_tables: 0, wtd_net: 0, wtd_last_week: 0 };
}
