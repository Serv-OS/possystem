// supabase/functions/_shared/ezcaterMenuSyncRun.ts
//
// The "Sync ezCater menu" job for one venue, and the daily pass over every venue. The rules are
// in ezcaterMenuSync.ts; this file only reads, calls and writes. ezCater is reached through
// makeAsk(connection), passed in by ezcater-connect, so the job runs under node in the tests.
//
// Never throws. Every outcome is an object the Back Office can show in plain words.

import { readMatchInputs } from './ezcater-match-ingest.ts';
import {
  claimSync, finishSync, flattenMenus, planMenuSync, readCatererMenus, venueDate, writeSyncPlan,
  type EzAsk,
} from './ezcaterMenuSync.ts';

export const MIGRATION_FILE = '20260919m_OPS_ezcater_menu_sync_v1.sql';

export interface SyncResult {
  ok: boolean;
  /** ok | partial | error | busy | not_ready */
  status: string;
  message: string;
  counts?: Record<string, number>;
  optionsRead?: boolean;
  menus?: string[];
}

const s = (v: unknown): string => (v == null ? '' : String(v).trim());
const errText = (e: unknown) => (e instanceof Error ? e.message : String((e as any)?.message ?? e));

export async function runMenuSync(
  sb: any, locationId: string,
  opts: { reason: string; makeAsk: (conn: any) => EzAsk; nowMs?: number; isSchemaError?: (e: unknown) => boolean },
): Promise<SyncResult> {
  if (!sb || !locationId) return { ok: false, status: 'error', message: 'No venue.' };
  let claim: string | null = null;
  try {
    const c = await claimSync(sb, locationId, opts.reason);
    if (c.error) {
      console.warn('[ezcater-menu-sync] claim failed:', errText(c.error));
      return { ok: false, status: 'not_ready', message: `Menu sync is not switched on yet: run ${MIGRATION_FILE} first.` };
    }
    if (!c.claim) return { ok: false, status: 'busy', message: 'A menu sync for this venue is already running. Try again in a minute.' };
    claim = c.claim;
  } catch (e) {
    return { ok: false, status: 'not_ready', message: `Menu sync is not switched on yet: run ${MIGRATION_FILE} first. (${errText(e)})` };
  }

  const fail = async (message: string, status = 'error'): Promise<SyncResult> => {
    try { await finishSync(sb, locationId, claim as string, status, null, message); } catch { /* the claim goes stale */ }
    return { ok: false, status, message };
  };

  try {
    const nowMs = Number.isFinite(opts.nowMs as number) ? (opts.nowMs as number) : Date.now();
    const nowIso = new Date(nowMs).toISOString();

    const { data: cats, error: catErr } = await sb.from('ezcater_caterers')
      .select('caterer_uuid, connection_id, active').eq('location_id', locationId);
    if (catErr) return await fail('Could not read which ezCater caterers are linked to this venue.');
    const caterers = (Array.isArray(cats) ? cats : []).filter((c: any) => c && s(c.caterer_uuid) && s(c.connection_id) && c.active !== false);
    if (!caterers.length) return await fail('No ezCater caterer is linked to this venue yet.');

    const connIds = Array.from(new Set(caterers.map((c: any) => s(c.connection_id))));
    const { data: conns, error: connErr } = await sb.from('ezcater_connections')
      .select('id, api_token, api_url, status').in('id', connIds);
    if (connErr) return await fail('Could not read the ezCater connection.');
    const connById = new Map<string, any>();
    for (const c of Array.isArray(conns) ? conns : []) if (c && s(c.id) && s(c.api_token)) connById.set(s(c.id), c);

    const { data: loc } = await sb.from('locations').select('timezone').eq('id', locationId).maybeSingle();
    const today = venueDate(nowMs, s(loc?.timezone) || 'Europe/London');

    const input = await readMatchInputs(sb, locationId);
    if (!input.sizeIds) return await fail(`Menu sync is not switched on yet: run ${MIGRATION_FILE} first.`, 'not_ready');
    if (!input.linksOk) return await fail('Could not read the saved matches, so nothing was changed. Try again.');

    const menus: any[] = [];
    let read = 0;
    let optionsRead = true;
    const problems: string[] = [];
    for (const cat of caterers) {
      const conn = connById.get(s(cat.connection_id));
      if (!conn) { problems.push('a caterer has no working connection'); continue; }
      try {
        const got = await readCatererMenus(opts.makeAsk(conn), s(cat.caterer_uuid), today, opts.isSchemaError);
        menus.push(...got.menus);
        optionsRead = optionsRead && got.optionsRead;
        read++;
        // A menu ezCater listed as current but then sent back empty is a PARTIAL read, exactly
        // like one that failed: complete goes false below.
        if (got.missing) problems.push(`ezCater sent back no menu for ${got.missing} current menu${got.missing === 1 ? '' : 's'}`);
      } catch (e) {
        console.warn('[ezcater-menu-sync] menu read failed for', s(cat.caterer_uuid), ':', errText(e));
        problems.push('ezCater did not answer for one caterer: ' + errText(e));
      }
    }
    if (!read) return await fail(problems[0] || 'ezCater did not send a menu.');

    const entries = flattenMenus(menus);
    const plan = planMenuSync({
      entries, existing: input.links, ourItems: input.ourItems, ourGroups: input.ourGroups,
      locationId, nowIso, complete: problems.length === 0, menuOk: input.menuOk,
    });
    const wrote = await writeSyncPlan(sb, locationId, plan, nowIso);
    problems.push(...wrote.errors);

    const status = problems.length ? 'partial' : 'ok';
    const counts = { ...plan.counts, inserted: wrote.inserted, refreshed: wrote.refreshed, filled: wrote.filled, menus: menus.length };
    const bits = [
      `${plan.counts.items + plan.counts.sizes} items and sizes`,
      optionsRead ? `${plan.counts.options} options` : 'options could not be read',
      `${plan.counts.autoLinked} matched by exact name`,
      `${plan.counts.toDecide} for you to match`,
    ];
    if (!input.menuOk) bits.push('our menu could not be read whole, so nothing was matched automatically');
    const message = (menus.length ? 'Synced ' + bits.join(', ') + '.' : 'ezCater has no current menu for this venue.')
      + (problems.length ? ' Some of it did not complete: ' + problems[0] : '');
    await finishSync(sb, locationId, claim as string, status, counts, problems.length ? problems.join('; ').slice(0, 1000) : null);
    return { ok: true, status, message, counts, optionsRead, menus: menus.map((m) => s(m?.name)).filter(Boolean) };
  } catch (e) {
    console.warn('[ezcater-menu-sync] failed:', errText(e));
    return await fail('The menu sync failed: ' + errText(e));
  }
}

/** A venue is due when it has not synced well for 20 hours and has not tried in the last 3. */
export const DUE_AFTER_MS = 20 * 3600 * 1000;
export const RETRY_AFTER_MS = 3 * 3600 * 1000;

/** PURE: which venues are due, oldest first. */
export function dueLocations(locationIds: string[], syncRows: any[], nowMs: number): string[] {
  const byLoc = new Map<string, any>();
  for (const r of Array.isArray(syncRows) ? syncRows : []) if (r && s(r.location_id)) byLoc.set(s(r.location_id), r);
  const t = (v: unknown) => { const n = Date.parse(s(v)); return Number.isFinite(n) ? n : 0; };
  return Array.from(new Set(locationIds.map(s).filter(Boolean)))
    .filter((id) => {
      const r = byLoc.get(id);
      if (!r) return true;
      if (t(r.last_ok_at) > nowMs - DUE_AFTER_MS) return false;
      return t(r.started_at) <= nowMs - RETRY_AFTER_MS;
    })
    .sort((a, b) => t(byLoc.get(a)?.last_ok_at) - t(byLoc.get(b)?.last_ok_at));
}

/**
 * The daily pass's time budget. pg_cron reaches ezcater-connect through public.call_edge_fn,
 * whose pg_net request times out at 25 s (20260805b_edge_cron_bridge.sql); menu-translate keeps
 * its cron runs to 18 s for the same reason. No new venue is started once 18 s have gone, nor
 * when the slowest venue so far would not fit in what is left. Venues not reached stay due and
 * run on the next hour.
 */
export const CRON_BUDGET_MS = 18_000;

/**
 * The daily pass, called hourly by pg_cron: every venue with a mapped caterer that is due gets a
 * sync, one at a time, until the time budget is spent (the rest are due on the next hour).
 * `budgetMs` can only make the budget SMALLER than CRON_BUDGET_MS. `clock` and `runOne` are for
 * the tests.
 */
export async function runDueSyncs(
  sb: any, makeAsk: (conn: any) => EzAsk,
  opts: {
    budgetMs?: number; nowMs?: number; isSchemaError?: (e: unknown) => boolean;
    clock?: () => number;
    runOne?: (sb: any, locationId: string, o: any) => Promise<SyncResult>;
  } = {},
): Promise<{ ran: Array<{ location_id: string; status: string }>; due: number; left: number; stoppedForTime: boolean }> {
  const clock = typeof opts.clock === 'function' ? opts.clock : () => Date.now();
  const runOne = typeof opts.runOne === 'function' ? opts.runOne : runMenuSync;
  const started = clock();
  const budget = Number.isFinite(opts.budgetMs as number)
    ? Math.max(0, Math.min(opts.budgetMs as number, CRON_BUDGET_MS)) : CRON_BUDGET_MS;
  const nowMs = Number.isFinite(opts.nowMs as number) ? (opts.nowMs as number) : Date.now();
  const { data: cats } = await sb.from('ezcater_caterers').select('location_id, active').not('location_id', 'is', null);
  const locs = (Array.isArray(cats) ? cats : []).filter((c: any) => c && c.active !== false).map((c: any) => s(c.location_id));
  if (!locs.length) return { ran: [], due: 0, left: 0, stoppedForTime: false };
  const { data: rows, error } = await sb.from('ezcater_menu_syncs')
    .select('location_id, last_ok_at, started_at').in('location_id', Array.from(new Set(locs)));
  if (error) return { ran: [], due: 0, left: 0, stoppedForTime: false };
  const due = dueLocations(locs, rows || [], nowMs);
  const ran: Array<{ location_id: string; status: string }> = [];
  let slowest = 0;
  let stoppedForTime = false;
  for (const loc of due) {
    const spent = clock() - started;
    if (spent >= budget || (ran.length > 0 && spent + slowest > budget)) { stoppedForTime = true; break; }
    const t0 = clock();
    const r = await runOne(sb, loc, { reason: 'daily', makeAsk, isSchemaError: opts.isSchemaError });
    slowest = Math.max(slowest, clock() - t0);
    ran.push({ location_id: loc, status: r.status });
  }
  return { ran, due: due.length, left: due.length - ran.length, stoppedForTime };
}
