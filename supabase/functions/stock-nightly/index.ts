// supabase/functions/stock-nightly/index.ts
//
// The stock nightly run (v5.11.84, multi site stock Drop 0, plan 7.3 steps 12, 14, 15 and 18). Started
// by pg_cron job 'stock-nightly' at 03:40 UTC (public.stock_nightly_send(), migration 20261021a), which
// posts { "action": "run" } with the header x-cron-key: a random key kept only in the database vault
// (secret stock_nightly_cron_key) and checked by public.stock_nightly_cron_ok (service role only), so
// there is no second copy of the key to keep in step. The service role may start it too (a manual run).
// No one else: before 20261021a the check is missing and the run refuses (it has nothing to do then).
//
// What it does, each step on its own (a failed step is named in the answer, the rest still run):
//   1. The venue clock. Reads every Platform location (id, ops_location_id, timezone,
//      business_day_start) and sends them to venue_clock_sync, keyed by ops_location_id. The Ops copy
//      (venue_clock) is what stock day totals bucket by; the answer lists Ops venues with no clock and
//      venues whose Ops timezone differs from the Platform's (written to venue_clock.mismatch).
//   2. Day totals. For every Ops venue that holds stock, the last business day that has fully ended
//      on its own clock: stock_day_sums_rebuild and sales_day_sums_rebuild, then their checks
//      (stock totals equal the ledger; sales gross, discounts, voids and tax equal report_day_sums).
//   3. Set up health (v5.11.89, multi site stock Drop 1, 20261024a): for every venue that holds stock,
//      stock_nightly_health(p_location) runs the company list writer in check mode for that one site
//      and keeps what is out of step in stock_co_site_health (Inventory > Overview, All sites: Set up
//      health and its Fix). One call per venue, each under 8 s. It writes no site row and moves no
//      number. A database before 20261024a has no such function: the step is skipped and said so,
//      never counted as a failure. Any other failure is named and the run goes on.
//   4. Upkeep (stock_nightly_upkeep): PIN tries older than a day purged; a site item archived at zero
//      after Stop ordering when no live recipe there uses it; company rows left with no site archived.
// The answer is a summary, also written to the function log as one line ('[stock-nightly] summary').
//
// Reads are paged past the 1,000 row cap. Nothing here writes a table directly: every write is one of
// the database functions above, each service role only.
//
// Deploy (Peter): npx supabase functions deploy stock-nightly --project-ref tbetcegmszzotrwdtqhi --no-verify-jwt
// (no JWT: pg_net sends only the x-cron-key header).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { pagedRows } from '../_shared/pagedRows.js';
import { CRON_KEY_HEADER, isServiceRoleBearer } from '../_shared/cronKey.js';
import { NIGHTLY_KEY_CHECK, NIGHTLY_BUDGET_MS, NIGHTLY_CONCURRENCY, nightlyAccess, clockRows, nightlyDay, mapLimit, isUuid, isMissingFunction } from './rules.js';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const PLATFORM_URL = Deno.env.get('PLATFORM_SUPABASE_URL') ?? '';
const PLATFORM_KEY = Deno.env.get('PLATFORM_SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('PLATFORM_SERVICE_KEY') ?? '';

const ops = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { autoRefreshToken: false, persistSession: false } });
const platform = PLATFORM_URL && PLATFORM_KEY ? createClient(PLATFORM_URL, PLATFORM_KEY, { auth: { autoRefreshToken: false, persistSession: false } }) : null;

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-key' };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });
const errText = (e: unknown) => String((e as any)?.message || e || 'unknown error');

// One database call; a failure is an Error carrying the database's words.
async function call(fn: string, args: Record<string, unknown> = {}): Promise<any> {
  const { data, error } = await ops.rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data;
}

// Ops venues that hold stock (any stock item row, archived ones included), with their Ops timezone.
async function stockVenues(): Promise<{ id: string; timezone: string | null }[]> {
  const venues = await pagedRows('venues', () => ops.from('locations').select('id, timezone').order('id'));
  const held = await mapLimit(venues, 6, async (v: any) => {
    const { data, error } = await ops.from('inventory_items').select('id').eq('location_id', v.id).limit(1);
    if (error) throw new Error(`stock items at ${v.id}: ${error.message}`);
    return (data || []).length > 0;
  });
  const bad = held.find((h: any) => h && typeof h === 'object' && h.error);
  if (bad) throw new Error((bad as any).error);
  return venues.filter((_: any, i: number) => held[i] === true).map((v: any) => ({ id: v.id, timezone: v.timezone || null }));
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);
  let body: any = {};
  try { body = await req.json(); } catch { body = {}; }
  const action = String(body?.action ?? 'run');
  if (action !== 'run') return json({ error: `unknown action: ${action}` }, 400);

  // Who may start it: the service role, or the cron job's key (asked of the database).
  const service = isServiceRoleBearer(req.headers.get('Authorization'), SERVICE_ROLE);
  const key = String(req.headers.get(CRON_KEY_HEADER) ?? '').trim();
  const check = !service && key ? await ops.rpc(NIGHTLY_KEY_CHECK, { p_key: key }) : null;
  const access = nightlyAccess({ service, key, check: check ? { data: check.data, error: check.error } : null });
  if (!access.ok) {
    const words = access.reason === 'needs_database_update' ? 'This needs a database update (20261021a). Nothing was run.' : 'not authorised';
    return json({ error: words, reason: access.reason }, access.status);
  }

  const started = Date.now();
  const errors: string[] = [];
  const summary: Record<string, unknown> = { ok: true, by: access.by, started_at: new Date(started).toISOString() };

  // 1. The venue clock, from the Platform.
  try {
    if (!platform) throw new Error('the Platform database is not configured for this function (PLATFORM_SUPABASE_URL and its service key)');
    const plat = platform;
    const places = await pagedRows('Platform locations', () => plat.from('locations').select('id, ops_location_id, timezone, business_day_start').order('id'));
    const { rows, skipped } = clockRows(places);
    const synced = rows.length ? await call('venue_clock_sync', { p_rows: rows }) : { ok: true, upserted: 0, mismatches: [], missing: [] };
    summary.clock = { platform_locations: places.length, sent: rows.length, skipped, upserted: synced?.upserted ?? null, mismatches: synced?.mismatches ?? [], missing: synced?.missing ?? [] };
  } catch (e) {
    errors.push(`venue clock: ${errText(e)}`);
  }

  // 2. Day totals for the last fully ended business day of every venue that holds stock.
  let stockHolders: { id: string; timezone: string | null }[] | null = null;
  try {
    const venues = await stockVenues();
    stockHolders = venues;
    const ids = venues.map((v) => v.id);
    const clocks: Record<string, any> = {};
    if (ids.length) {
      const rows = await pagedRows('venue clocks', () => ops.from('venue_clock').select('location_id, timezone, day_start').in('location_id', ids).order('location_id'));
      for (const r of rows) clocks[r.location_id] = r;
    }
    const now = Date.now();
    const days = await mapLimit(venues, NIGHTLY_CONCURRENCY, async (v) => {
      const d = nightlyDay(now, clocks[v.id] || null, v.timezone);
      const out: Record<string, unknown> = { location_id: v.id, business_day: d.day, timezone: d.timezone, day_start: d.day_start, clock_known: d.clock_known };
      if (Date.now() - started > NIGHTLY_BUDGET_MS) { out.skipped = 'out of time: runs again tomorrow'; return out; }
      for (const [name, fn] of [['stock', 'stock_day_sums_rebuild'], ['sales', 'sales_day_sums_rebuild']] as const) {
        try { out[name] = await call(fn, { p_location: v.id, p_from: d.day, p_to: d.day }); } catch (e) { out[name] = { ok: false, error: errText(e) }; errors.push(`${fn} ${v.id} ${d.day}: ${errText(e)}`); }
      }
      for (const [name, fn] of [['stock_check', 'stock_day_sums_check'], ['sales_check', 'sales_day_sums_check']] as const) {
        try {
          const r = await call(fn, { p_location: v.id, p_day: d.day });
          out[name] = r;
          if (r && r.ok === false) errors.push(`${fn} ${v.id} ${d.day}: totals do not agree`);
        } catch (e) { out[name] = { ok: false, error: errText(e) }; errors.push(`${fn} ${v.id} ${d.day}: ${errText(e)}`); }
      }
      return out;
    });
    summary.days = days;
    summary.venues_with_stock = venues.length;
    const skippedVenues = days.filter((x: any) => x && x.skipped).map((x: any) => x.location_id).filter(isUuid);
    if (skippedVenues.length) errors.push(`out of time before ${skippedVenues.length} venue(s): ${skippedVenues.join(', ')}`);
  } catch (e) {
    errors.push(`day totals: ${errText(e)}`);
  }

  // 3. Set up health, one venue at a time (a few at once). Out of time: the rest wait for tomorrow.
  if (stockHolders && stockHolders.length) {
    let missing = false;
    const health = await mapLimit(stockHolders, NIGHTLY_CONCURRENCY, async (v) => {
      if (missing) return { location_id: v.id, skipped: 'needs database update' };
      if (Date.now() - started > NIGHTLY_BUDGET_MS) return { location_id: v.id, skipped: 'out of time: runs again tomorrow' };
      let data: any = null;
      let error: any = null;
      try { ({ data, error } = await ops.rpc('stock_nightly_health', { p_location: v.id })); } catch (e) { error = { message: errText(e) }; }
      if (error && isMissingFunction(error)) { missing = true; return { location_id: v.id, skipped: 'needs database update' }; }
      if (error) {
        console.warn(`[stock-nightly] set up health ${v.id}: ${errText(error)}`);
        errors.push(`stock_nightly_health ${v.id}: ${errText(error)}`);
        return { location_id: v.id, ok: false, error: errText(error) };
      }
      return { location_id: v.id, planned_writes: data?.planned_writes ?? null, recipe_planned_writes: data?.recipe_planned_writes ?? null };
    });
    summary.health = missing
      ? { skipped: 'This needs a database update (20261024a). Set up health was not checked.' }
      : { checked: health.filter((h: any) => h && !h.skipped && h.ok !== false).length,
          out_of_step: health.filter((h: any) => h && ((Number(h.planned_writes) || 0) + (Number(h.recipe_planned_writes) || 0)) > 0).map((h: any) => h.location_id),
          skipped: health.filter((h: any) => h && h.skipped).map((h: any) => h.location_id),
          venues: health };
  }

  // 4. Upkeep.
  try {
    summary.upkeep = await call('stock_nightly_upkeep');
  } catch (e) {
    errors.push(`upkeep: ${errText(e)}`);
  }

  summary.ok = errors.length === 0;
  summary.errors = errors;
  summary.ms = Date.now() - started;
  console.log(`[stock-nightly] summary ${JSON.stringify(summary)}`);
  return json(summary, 200);
});
