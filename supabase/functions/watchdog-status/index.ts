// supabase/functions/watchdog-status
//
// THE ONE THING THE WATCHDOG IS ALLOWED TO ASK.
//
// The watchdog runs on GitHub's machines (.github/workflows/watchdog.yml) so it
// is still alive when the database is not. But GitHub must not hold the keys to
// the kingdom to do that: a service-role key in a repo secret can read and
// rewrite every venue's data, and it would sit there forever for one job that
// only ever needs four counts.
//
// So GitHub holds a random token that can do exactly this and nothing else:
// count four things and say which venue they happened at. No order contents, no
// customer, no money, no names. Read-only, and it cannot be used for anything
// but this.
//
//   POST { windows: {...} }  with header  x-watchdog-token: <WATCHDOG_TOKEN>
//   → { ok: true, cardStranded: [{venue,count}], ticketsLost: [...], printStuck: [...], ordersOpen: [...] }
//   v5.11.94 adds otpNotReady: [{venue,count,detail}] (venues whose loyalty code texts are
//   refused; detail is the state, never a name or a provider message), otpAuditStale and
//   otpAuditIncomplete (null, or one line saying the nightly check did not run or did not finish).
//
// WHAT THE ANSWERS MEAN, because the watchdog decides what to shout from them:
//   200 ok:true         measured; findings inside
//   401 / 400           the WATCHDOG is wrong (bad token, bad request) — never an outage
//   503 ok:false db     the database did not answer US — this is the real thing
//
// That last line is the whole reason this function exists in this shape: a
// misconfigured watchdog must never be able to announce "the database is down".
// It did exactly that on its first live run (22 Sep 2026) and opened an issue
// saying the venues could not take card payments, when the truth was that its
// own key was missing.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-watchdog-token',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const TOKEN = Deno.env.get('WATCHDOG_TOKEN') ?? '';
const admin = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '', {
  auth: { autoRefreshToken: false, persistSession: false },
});

/** Compare without leaking the answer in the timing. */
function sameSecret(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const clamp = (n: unknown, lo: number, hi: number, fallback: number) => {
  const v = Number(n);
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : fallback;
};
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

type Row = { location_id?: string | null };

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ ok: false, error: 'POST only' }, 400);

  if (!TOKEN) return json({ ok: false, error: 'watchdog token not configured on the server' }, 401);
  if (!sameSecret(req.headers.get('x-watchdog-token') ?? '', TOKEN)) return json({ ok: false, error: 'bad token' }, 401);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* windows are optional */ }
  const w = (body?.windows ?? {}) as Record<string, Record<string, unknown>>;
  const cardOlder = clamp(w.card_stranded?.olderThan, 1, 1440, 10);
  const lostWithin = clamp(w.ticket_lost?.within, 1, 10080, 60);
  const printOlder = clamp(w.print_stuck?.olderThan, 1, 1440, 10);
  const openOlder = clamp(w.orders_open?.olderThan, 1, 1440, 45);
  const openWithin = clamp(w.orders_open?.within, 1, 10080, 1440);

  try {
    // 14 Oct 2026, Peter: "this is a test location we dont need notifications". A venue
    // flagged is_demo (migration 20261013a, the App Review demo venue) is left out of every
    // venue signal below. It is filtered IN the queries, not after them, so a demo venue with
    // hundreds of stuck test jobs can never use up the 500 row window and hide a real venue.
    // The database and watchdog signals still cover it: they are about the system, not a venue.
    const venuesRes = await admin.from('locations').select('id,name,is_demo').limit(500);
    if (venuesRes.error) return json({ ok: false, reason: 'db', detail: venuesRes.error.message }, 503);
    const demoIds = (venuesRes.data ?? []).filter((l) => l.is_demo === true).map((l) => String(l.id));
    // deno-lint-ignore no-explicit-any
    const realVenues = (q: any) => (demoIds.length ? q.not('location_id', 'in', `(${demoIds.join(',')})`) : q);

    const [strandedRes, lostRes, stuckRes, openRes] = await Promise.all([
      realVenues(admin.from('terminal_jobs').select('location_id'))
        .in('status', ['charging', 'charging_unsent']).lt('created_at', ago(cardOlder)).limit(500),
      realVenues(admin.from('print_jobs').select('location_id'))
        .eq('status', 'failed_permanent').gt('created_at', ago(lostWithin)).limit(500),
      realVenues(admin.from('print_jobs').select('location_id'))
        .in('status', ['pending', 'claimed']).lt('created_at', ago(printOlder)).limit(500),
      realVenues(admin.from('order_queue').select('location_id'))
        .not('status', 'in', '(collected,cancelled)')
        .lt('created_at', ago(openOlder)).gt('created_at', ago(openWithin)).limit(500),
    ]);

    for (const r of [strandedRes, lostRes, stuckRes, openRes]) {
      // The database answered with a complaint. Say WHICH, so a wrong query of
      // ours is never dressed up as a venue outage.
      if (r.error) return json({ ok: false, reason: 'db', detail: r.error.message }, 503);
    }

    // v5.11.77 central stock depletion (migration 20261018c): per venue, sales waiting over
    // stock_backlog.olderThan minutes for stock to come off, events that failed 8 times, and
    // held rows older than stock_held.olderThan minutes. The outbox table has no API grants, so
    // the service role reads it through stock_outbox_watch (SECURITY DEFINER, service role only).
    // Before the migration runs the function does not exist (PGRST202): that is not a fault,
    // no venue can be central yet, so the three lists are empty.
    const stockOlder = clamp(w.stock_backlog?.olderThan, 1, 1440, 10);
    const heldOlder = clamp(w.stock_held?.olderThan, 1, 10080, 60);
    const stockRes = await admin.rpc('stock_outbox_watch', { p_pending_older_min: stockOlder, p_held_older_min: heldOlder });
    const stockRows: Array<{ location_id: string; pending_old: number; dead: number; held_old: number }> =
      stockRes.error ? [] : ((stockRes.data as Array<{ location_id: string; pending_old: number; dead: number; held_old: number }>) ?? []);
    if (stockRes.error && !/stock_outbox_watch|PGRST202|does not exist/i.test(stockRes.error.message ?? '')) {
      return json({ ok: false, reason: 'db', detail: stockRes.error.message }, 503);
    }
    const stockBy = (pick: (r: { pending_old: number; dead: number; held_old: number }) => number): Row[] =>
      stockRows.filter((r) => !demoIds.includes(String(r.location_id))).flatMap((r) => Array.from({ length: Math.max(0, Number(pick(r)) || 0) }, () => ({ location_id: r.location_id })));

    const names = new Map<string, string>();
    for (const l of venuesRes.data ?? []) names.set(String(l.id), l.name ?? 'an unnamed venue');
    const byVenue = (rows: Row[] | null) => {
      const counts = new Map<string, number>();
      for (const r of rows ?? []) {
        const name = names.get(String(r.location_id)) ?? 'an unnamed venue';
        counts.set(name, (counts.get(name) ?? 0) + 1);
      }
      return [...counts.entries()].map(([venue, count]) => ({ venue, count }));
    };

    // v5.11.94 loyalty code texts (migration 20261022b). Venues whose sign in code texts are
    // refused (their own text service is not ready), and whether the nightly check (04:10 UTC)
    // ran and finished. These are read from two service role only tables. Unlike the counts
    // above, a failed read here is never a 503: a query of ours that is wrong must not wake
    // anybody saying the database is down. It is said as "could not be read", for the morning.
    const otpStaleMin = clamp(w.otp_audit_stale?.olderThan, 60, 10080, 26 * 60);
    const [otpRowsRes, otpRunRes] = await Promise.all([
      realVenues(admin.from('loyalty_otp_service_audit').select('location_id, state')).eq('ok', false).limit(500),
      admin.from('loyalty_otp_audit_runs').select('ran_at, ok, errors, skipped').is('company_id', null).eq('fix', true)
        .order('ran_at', { ascending: false }).limit(1),
    ]);
    const missingTable = (e: { code?: string; message?: string } | null) =>
      !!e && (e.code === 'PGRST205' || e.code === '42P01' || /could not find the table|does not exist/i.test(e.message ?? ''));
    let otpAuditStale: string | null = null;
    let otpAuditIncomplete: string | null = null;
    const otpByVenue = new Map<string, { venue: string; count: number; states: Set<string> }>();
    if (missingTable(otpRowsRes.error) || missingTable(otpRunRes.error)) {
      otpAuditStale = 'The nightly loyalty code text check is not installed: database update 20261022b has not run on the Ops database';
    } else if (otpRowsRes.error || otpRunRes.error) {
      otpAuditStale = `The nightly loyalty code text check could not be read: ${(otpRowsRes.error || otpRunRes.error)?.message ?? 'unknown'}`;
    } else {
      for (const r of (otpRowsRes.data ?? []) as Array<{ location_id: string; state: string }>) {
        const name = names.get(String(r.location_id)) ?? 'an unnamed venue';
        const v = otpByVenue.get(name) ?? { venue: name, count: 0, states: new Set<string>() };
        v.count += 1;
        v.states.add(String(r.state || ''));
        otpByVenue.set(name, v);
      }
      const last = ((otpRunRes.data ?? []) as Array<{ ran_at: string; ok: boolean; errors: unknown; skipped: number }>)[0];
      const lastAt = last ? new Date(last.ran_at).getTime() : NaN;
      if (!last) otpAuditStale = 'The nightly loyalty code text check has never run';
      else if (!Number.isFinite(lastAt) || lastAt < Date.now() - otpStaleMin * 60_000) {
        otpAuditStale = `The nightly loyalty code text check last ran ${Number.isFinite(lastAt) ? Math.round((Date.now() - lastAt) / 3_600_000) + ' hours ago' : 'at an unknown time'}`;
      } else if (!last.ok) {
        const errs = Array.isArray(last.errors) ? (last.errors as unknown[]).map(String) : [];
        if (errs.length) otpAuditIncomplete = errs.slice(0, 2).join('; ').slice(0, 240);
        else if (Number(last.skipped) > 0) otpAuditIncomplete = `${last.skipped} venue${Number(last.skipped) === 1 ? ' was' : 's were'} not reached in time`;
      }
    }

    return json({
      ok: true,
      at: new Date().toISOString(),
      venuesKnown: names.size,
      demoVenuesSkipped: demoIds.length,
      cardStranded: byVenue(strandedRes.data as Row[]),
      ticketsLost: byVenue(lostRes.data as Row[]),
      printStuck: byVenue(stuckRes.data as Row[]),
      ordersOpen: byVenue(openRes.data as Row[]),
      stockBacklog: byVenue(stockBy((r) => r.pending_old)),
      stockDead: byVenue(stockBy((r) => r.dead)),
      stockHeld: byVenue(stockBy((r) => r.held_old)),
      stockWatchAvailable: !stockRes.error,
      otpNotReady: [...otpByVenue.values()].map((v) => ({ venue: v.venue, count: v.count, detail: [...v.states].join(', ') })),
      otpAuditStale,
      otpAuditIncomplete,
    });
  } catch (e) {
    // Threw rather than answered: the database is not reachable from here.
    return json({ ok: false, reason: 'db', detail: String((e as Error)?.message || e) }, 503);
  }
});
