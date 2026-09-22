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
    const [venuesRes, strandedRes, lostRes, stuckRes, openRes] = await Promise.all([
      admin.from('locations').select('id,name').limit(500),
      admin.from('terminal_jobs').select('location_id')
        .in('status', ['charging', 'charging_unsent']).lt('created_at', ago(cardOlder)).limit(500),
      admin.from('print_jobs').select('location_id')
        .eq('status', 'failed_permanent').gt('created_at', ago(lostWithin)).limit(500),
      admin.from('print_jobs').select('location_id')
        .in('status', ['pending', 'claimed']).lt('created_at', ago(printOlder)).limit(500),
      admin.from('order_queue').select('location_id')
        .not('status', 'in', '(collected,cancelled)')
        .lt('created_at', ago(openOlder)).gt('created_at', ago(openWithin)).limit(500),
    ]);

    for (const r of [venuesRes, strandedRes, lostRes, stuckRes, openRes]) {
      // The database answered with a complaint. Say WHICH, so a wrong query of
      // ours is never dressed up as a venue outage.
      if (r.error) return json({ ok: false, reason: 'db', detail: r.error.message }, 503);
    }

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

    return json({
      ok: true,
      at: new Date().toISOString(),
      venuesKnown: names.size,
      cardStranded: byVenue(strandedRes.data as Row[]),
      ticketsLost: byVenue(lostRes.data as Row[]),
      printStuck: byVenue(stuckRes.data as Row[]),
      ordersOpen: byVenue(openRes.data as Row[]),
    });
  } catch (e) {
    // Threw rather than answered: the database is not reachable from here.
    return json({ ok: false, reason: 'db', detail: String((e as Error)?.message || e) }, 503);
  }
});
