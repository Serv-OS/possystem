// supabase/functions/stock-nightly/rules.js
//
// The pure rules of the stock-nightly run (v5.11.84, multi site stock Drop 0, plan 7.3 step 15).
// No Deno, no network: node --test drives every branch (src/lib/stock/stockNightlyEdge.test.js) and
// stock-nightly/index.ts imports this file.
//
//   nightlyAccess   who may start the run: the service role, or the pg_cron job's x-cron-key, which
//                   the database checks (stock_nightly_cron_ok, service role only, 20261021a). Fails
//                   closed: no key, a wrong key, a failed check, or a database without the check
//                   (before 20261021a there is nothing for the run to do) all refuse.
//   clockRows       Platform locations to venue_clock_sync rows, keyed by the Platform row's
//                   ops_location_id (never the Platform id: three venues have different ids in the two
//                   databases). A row with no Ops id or no timezone is left out and named.
//   nightlyDay      the business day a venue rebuilds: the last one that has fully ended on its own
//                   clock (venue_clock, else the Ops timezone and 06:00, the house default start).
//   mapLimit        run an async step over a list, a few at a time.

import { lastCompletedBusinessDay, DEFAULT_DAY_START, DEFAULT_VENUE_TZ, venueZone } from '../_shared/businessDay.js';

export const NIGHTLY_KEY_CHECK = 'stock_nightly_cron_ok';
export const NIGHTLY_BUDGET_MS = 120000;   // venues not started by then are named as skipped
export const NIGHTLY_CONCURRENCY = 3;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);

// The check function is missing (PostgREST PGRST202, Postgres 42883, or its words).
export function isMissingFunction(error) {
  if (!error) return false;
  const code = String(error.code || '');
  const msg = String(error.message || '');
  return code === 'PGRST202' || code === '42883' || /could not find the function|function .*does not exist|schema cache/i.test(msg);
}

/**
 * service: the caller is the service role. key: the x-cron-key header ('' when none).
 * check: { data, error } from rpc(NIGHTLY_KEY_CHECK, { p_key: key }), or null when not asked.
 * Returns { ok, by, status, reason }.
 */
export function nightlyAccess({ service = false, key = '', check = null } = {}) {
  if (service) return { ok: true, by: 'service_role', status: 200, reason: null };
  if (!key) return { ok: false, by: null, status: 401, reason: 'no_cron_key' };
  if (check?.error && isMissingFunction(check.error)) return { ok: false, by: null, status: 503, reason: 'needs_database_update' };
  if (check?.error) return { ok: false, by: null, status: 401, reason: 'cron_key_check_failed' };
  if (check && check.data === true) return { ok: true, by: 'cron_key', status: 200, reason: null };
  return { ok: false, by: null, status: 401, reason: 'wrong_cron_key' };
}

/** 'HH:MM' (a Platform time column reads back 'HH:MM:SS'), or null when there is none. */
export function clockTime(v) {
  const m = /^\s*(\d{1,2}):(\d{2})/.exec(String(v ?? ''));
  if (!m) return null;
  const h = Number(m[1]); const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return `${String(h).padStart(2, '0')}:${m[2]}`;
}

/**
 * Platform rows [{ id, ops_location_id, timezone, business_day_start }] to venue_clock_sync rows.
 * Returns { rows, skipped: [{ platform_location_id, why }] }. One row per Ops venue (the first
 * Platform row that names it wins; a second is named as a duplicate).
 */
export function clockRows(platformRows) {
  const rows = [];
  const skipped = [];
  const seen = new Set();
  for (const p of platformRows || []) {
    const ops = p?.ops_location_id;
    if (!isUuid(ops)) { skipped.push({ platform_location_id: p?.id ?? null, why: 'no_ops_location' }); continue; }
    const tz = typeof p.timezone === 'string' ? p.timezone.trim() : '';
    if (!tz) { skipped.push({ platform_location_id: p.id ?? null, why: 'no_timezone' }); continue; }
    if (seen.has(ops)) { skipped.push({ platform_location_id: p.id ?? null, why: 'duplicate_ops_location' }); continue; }
    seen.add(ops);
    rows.push({ ops_location_id: ops, platform_location_id: isUuid(p.id) ? p.id : null, timezone: tz, business_day_start: clockTime(p.business_day_start) });
  }
  return { rows, skipped };
}

/**
 * The business day to rebuild for one venue: the last one that has fully ended at nowMs.
 * clock: the venue_clock row ({ timezone, day_start }) or null; opsTimezone: Ops locations.timezone.
 * Returns { day, timezone, day_start, clock_known }.
 */
export function nightlyDay(nowMs, clock, opsTimezone) {
  const known = !!(clock && clock.timezone);
  const timezone = venueZone(known ? clock.timezone : (opsTimezone || DEFAULT_VENUE_TZ));
  const dayStart = clockTime(known ? clock.day_start : null) || DEFAULT_DAY_START;
  return { day: lastCompletedBusinessDay(nowMs, timezone, dayStart), timezone, day_start: dayStart, clock_known: known };
}

/** Run fn over list with at most `limit` at once; results in list order. Never rejects for one item. */
export async function mapLimit(list, limit, fn) {
  const items = Array.isArray(list) ? list : [];
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try { out[i] = await fn(items[i], i); } catch (e) { out[i] = { error: String(e?.message || e) }; }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit || 1, items.length)) }, worker));
  return out;
}
