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
//     number of days into last month (month), cut at the same time of day, with a reason word
//     (ok, new, no_sales_now, no_sales_then) so the screen never has to guess
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
// 5 Oct 2026 (Peter's decisions on multi site reporting):
//   • A day is the venue's BUSINESS day ("same as Back Office, Daily trading and Xero"): the
//     Platform locations row's business_day_start, read here beside the time zone.
//   • The currency is the Platform locations row's too. The Cabin, a dollar venue, was
//     labelled GBP (_shared/ownerSnapshot.js venueMeta).
//   • THE DETAIL CALL. POST { period, detail: '<ops location id>' | 'group', currency? } answers
//     { ok, api, period, detail } with the seven reports for that venue or the group
//     (_shared/ownerSnapshot.js buildOwnerDetail) and NO snapshot. A venue that is not this
//     login's is a 403.
//   • Every answer carries `api` and `features`. A function from before this change sends
//     neither, and ignores `detail` (it answers the plain snapshot): the app must look for
//     `detail` in the answer, and for 'compare' in `features`, before it shows either, and
//     say "needs a ServOS update" when they are missing.
//
// The reads and the sums live in _shared/ownerSnapshot.js (run by `npm test` against a stand
// in database); the date rules in _shared/ownerPeriod.js.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { secondStepRefusal } from '../_shared/second-step.ts';
import { ownerPeriod } from '../_shared/ownerPeriod.js';
import { buildOwnerSnapshot } from '../_shared/ownerSnapshot.js';
import { buildOwnerDetail, venueMeta, OWNER_API, OWNER_FEATURES } from '../_shared/ownerSnapshot.js';

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
    return json({ ok: true, api: OWNER_API, features: OWNER_FEATURES, period: none.period, locations: [], rollup: none.rollup, generated_at: new Date().toISOString() });
  }

  // Names, time zones, day starts and currencies from the Platform locations rows (matched on
  // ops_location_id, then on id for the legacy rows where the two are the same); the workforce
  // currency only as a fallback. A read that fails is an error: a venue is never put on a
  // guessed clock or a guessed currency without a word.
  const orFilter = opsIds.flatMap(id => [`ops_location_id.eq.${id}`, `id.eq.${id}`]).join(',') || 'id.is.null';
  const { data: plocs, error: plocErr } = await platformAdmin.from('locations').select('id, ops_location_id, name, timezone, currency, business_day_start').or(orFilter);
  if (plocErr) return json({ error: `Could not read the venues: ${plocErr.message}` }, 500);
  const { data: vsRows } = await opsAdmin.from('wf_venue_settings').select('location_id, currency').in('location_id', opsIds);
  const meta = venueMeta(opsIds, plocs ?? [], vsRows ?? []);

  try {
    // The detail call: one venue or the group, and nothing else.
    const target = typeof body?.detail === 'string' ? body.detail.trim() : '';
    if (target) {
      const out = await buildOwnerDetail({ ops: opsAdmin, opsIds, meta, target, currency: body?.currency, now: new Date(), period });
      if (!out) return json({ error: 'That venue is not one of yours' }, 403);
      return json({ ok: true, api: OWNER_API, features: OWNER_FEATURES, period: out.period, detail: out.detail, generated_at: new Date().toISOString() });
    }
    const snap = await buildOwnerSnapshot({ ops: opsAdmin, opsIds, meta, now: new Date(), period });
    return json({ ok: true, api: OWNER_API, features: OWNER_FEATURES, user: { id: user.id, email: user.email }, period: snap.period, locations: snap.locations, rollup: snap.rollup, generated_at: new Date().toISOString() });
  } catch (e) {
    // A read that failed is never shown as a day of zero sales.
    return json({ error: (e as Error)?.message || 'Could not build the snapshot' }, 500);
  }
});
