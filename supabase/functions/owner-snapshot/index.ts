// supabase/functions/owner-snapshot/index.ts
//
// The owner phone app's data engine. Given a back-office user's token it resolves
// every location they can access and returns a compact top-down snapshot for each,
// plus a combined rollup — in one round trip (mobile-friendly).
//
// Per location, on the venue's own clock, for the period asked for (2 Oct 2026, Peter: "On the
// owner app I want to be able to have quick filters for today, this week, this month."):
//   • net sales (ex-VAT) + VAT + gross, orders, avg check, tips. Sales are what customers paid
//     for the goods after discounts and comps, per check like the Daily trading report
//     (_shared/snapshotSales.js, 27 Sep 2026). Never the shelf subtotal, never total.
//   • forecast for the same days (wf_sales_forecast) + % to forecast
//   • actual labour (wf_timesheets, approved/paid) + labour % of sales
//   • the comparison: same weekday last week (today), the same span last week (week), the same
//     number of days into last month (month)
//   • top items for the period (from closed_checks.items)
//   • live: open orders (order_queue) + open tables (active_sessions), always now
// plus everything it answered before the filters (today, wtd, top_items), whatever the period,
// so an older app still reads it.
//
//   POST { period?: 'today' | 'week' | 'month' }, token in the Authorization header. No body,
//   or any other value, means today. The answer echoes `period` (the app uses the echo to tell a
//   function from before the filters) and gives each venue its `range` of venue-local dates.
// Auth: any back-office user; locations fenced to user_locations (super_admin → all, capped).
//
// The reads and the sums live in _shared/ownerSnapshot.js (run by `npm test` against a stand
// in database); the date rules in _shared/ownerPeriod.js.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { secondStepRefusal } from '../_shared/second-step.ts';
import { ownerPeriod } from '../_shared/ownerPeriod.js';
import { buildOwnerSnapshot } from '../_shared/ownerSnapshot.js';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const opsAdmin = createClient(Deno.env.get('SUPABASE_URL') ?? '', SERVICE_ROLE, { auth: { autoRefreshToken: false, persistSession: false } });
const platformAdmin = createClient(Deno.env.get('PLATFORM_SUPABASE_URL') ?? '', Deno.env.get('PLATFORM_SUPABASE_SERVICE_ROLE_KEY') ?? '', { auth: { autoRefreshToken: false, persistSession: false } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const secondStepBlock = await secondStepRefusal(req); if (secondStepBlock) return secondStepBlock; // docs/SECOND_STEP.md
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  // An app from before the filters posts {} (or nothing): that is today.
  const body = await req.json().catch(() => ({}));
  const period = ownerPeriod(body?.period);

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
  if (!opsIds.length) {
    const none = await buildOwnerSnapshot({ ops: opsAdmin, opsIds: [], meta: {}, period });
    return json({ ok: true, period: none.period, locations: [], rollup: none.rollup, generated_at: new Date().toISOString() });
  }

  // Names + timezones (platform) and currencies (ops wf_venue_settings).
  const meta: Record<string, { name: string; tz: string; currency: string }> = {};
  const orFilter = opsIds.flatMap(id => [`ops_location_id.eq.${id}`, `id.eq.${id}`]).join(',') || 'id.is.null';
  const { data: plocs } = await platformAdmin.from('locations').select('id, ops_location_id, name, timezone').or(orFilter);
  for (const p of plocs ?? []) { const k = p.ops_location_id || p.id; if (k) meta[k] = { name: p.name || 'Location', tz: p.timezone || 'Europe/London', currency: 'GBP' }; }
  const { data: vsRows } = await opsAdmin.from('wf_venue_settings').select('location_id, currency').in('location_id', opsIds);
  for (const v of vsRows ?? []) { if (meta[v.location_id]) meta[v.location_id].currency = v.currency || 'GBP'; else meta[v.location_id] = { name: 'Location', tz: 'Europe/London', currency: v.currency || 'GBP' }; }
  for (const id of opsIds) { if (!meta[id]) meta[id] = { name: 'Location', tz: 'Europe/London', currency: 'GBP' }; }

  try {
    const snap = await buildOwnerSnapshot({ ops: opsAdmin, opsIds, meta, now: new Date(), period });
    return json({ ok: true, user: { id: user.id, email: user.email }, period: snap.period, locations: snap.locations, rollup: snap.rollup, generated_at: new Date().toISOString() });
  } catch (e) {
    // A read that failed is never shown as a day of zero sales.
    return json({ error: (e as Error)?.message || 'Could not build the snapshot' }, 500);
  }
});
