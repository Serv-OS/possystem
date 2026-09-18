// supabase/functions/catering-release/index.ts
//
// SERVER-SIDE SAFETY NET for catering scheduled firing. Catering pre-orders are held in
// order_queue (source='catering', kitchen_routed_at NULL) with sent_at = the kitchen fire
// instant (the order's event time minus the venue's prep_time_minutes). The POS master
// device normally fires them at sent_at via routeKioskOrderPrints
// (full per-centre print + KDS, atomic kitchen_routed_at claim). THIS cron is the device-
// independent backstop: for any catering order whose fire time passed by more than GRACE_MIN
// and that NO device has fired (kitchen_routed_at still NULL), it atomically claims the row
// and drops a consolidated KDS ticket so the kitchen still sees it even if no POS was on.
//
// The grace window lets the POS master win the normal path first (it fires within ~60s, so a
// healthy venue never reaches this cron). Physical thermal tickets are produced by the venue's
// POS/print-agent (ESC/POS + routing are venue-local); the kitchen ALWAYS sees the order here
// via the KDS row + the claim, and the POS surfaces it once any device is on.
//
// Auth: service-role bearer, OR x-run-secret == CATERING_RELEASE_SECRET (the Vercel cron path).
//
// 18 Sep 2026: every CATERING source (_shared/cateringRules.js), so an ezCater order has the same
// backstop as one of ours. A cancelled order, or an ezCater order not yet accepted in ezCater, is
// never fired (cateringMayFire). A ServOS courier is never booked for an ezCater order
// (mayBookOurCourier): the caterer's own fleet or ezCater Dispatch delivers those.
//
// Also 18 Sep 2026 (review round 2):
//   * HELD rows (ezCater orders not accepted on ezCater) are filtered IN THE QUERY
//     (releasableOrFilter), so a pile of them sorted oldest first can never fill the batch and
//     starve the due orders behind them.
//   * A sent_at FLOOR (CATERING_STALE_FLOOR_MS, the tills' two hours): an order whose fire moment
//     is older than that is never auto fired by anything, it stays visible for staff to send.
//   * Every ezCater order is RE-ASKED right before it fires (prefireCheck, ezCater advises it):
//     a missed cancel, a replacement or a moved Dispatch pickup is caught. The re-ask has a
//     short timeout and NEVER blocks the kitchen: no answer means fire as planned, flagged.
//
// Review round 3 (same day):
//   * THE CRON SCALES (G). The pre fire re-asks run IN PARALLEL inside one time budget
//     (PREFIRE_BUDGET_MS, _shared/budget.js). An ezCater outage costs the budget once, not four
//     to seven seconds per order: every order the budget did not reach fires UNCHECKED, flagged
//     (customer.ezcaterCheck.ok = false), never late and never not at all.
//   * EARLIER PICKUP IS SEEN IN TIME (C). Before the release, each run re-asks upcoming ezCater
//     orders on a schedule (recheckUpcoming: every 15 minutes for those due in the next 4 hours,
//     once a day for the week ahead). A moved time moves sent_at; the till fires it (round 4:
//     this cron no longer fires those itself, and no longer re-times on prep, see below).
//   * HELD ORDERS ARE RE-ASKED (D). The scheduled re-ask includes held (not accepted) orders as
//     they near or pass their fire time: a missed accepted notification releases them; one still
//     not accepted is flagged for staff (customer.unacceptedAlert, a till alert).
//   * THE CLAIM CHECKS STATUS (E). The kitchen_routed_at claim also requires a releasable status
//     in the same UPDATE (not cancelled, not collected, not held), so a cancel landing between the
//     pre fire decision and the claim can never fire a cancelled order.
//
// Review round 4 (same day): WHERE AUTOMATIC BEHAVIOUR CAUSED A BUG, IT WAS REMOVED OR NARROWED.
//   * NO PREP SWEEP HERE ANY MORE. The every run re-time of unfired ezCater orders read a failed
//     catering settings read as "no prep set" and re-timed every order to the 60 minute fallback,
//     which cannot be undone. Orders are re-timed on a prep change ONLY when staff save Catering
//     settings (ezcater-connect 'recompute_prep'), and only with a successfully read, set prep.
//   * THIS CRON IS ONLY A BACKSTOP AGAIN. It fires only rows past the grace window that no till
//     has claimed, exactly as before this branch. The scheduled re-ask may move sent_at (so the
//     till's release fires it, printed and routed to production centres) but never makes this
//     cron fire a routine due order itself: its KDS only ticket has no printing and no routing.
//   * The "fired unchecked" flag is written inside the fire budget, in parallel, not in a serial
//     loop outside every budget.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { dispatchCourier } from '../_shared/delivery-dispatch.ts';
import {
  CATERING_SOURCES, CATERING_STALE_FLOOR_MS, cateringMayFire, mayBookOurCourier, cateringSourceLabel,
  isEzcaterOrder, releasableOrFilter, UNCLAIMABLE_STATUSES_PG,
} from '../_shared/cateringRules.js';
import { prefireCheck, recheckUpcoming, flagUnchecked } from '../_shared/ezcaterIngest.ts';
import { runWithBudget } from '../_shared/budget.js';

const URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const RUN_SECRET = Deno.env.get('CATERING_RELEASE_SECRET') ?? '';
const sb = createClient(URL, SERVICE_ROLE, { auth: { autoRefreshToken: false, persistSession: false } });
const PLATFORM_URL = Deno.env.get('PLATFORM_SUPABASE_URL') ?? '';
const PLATFORM_KEY = Deno.env.get('PLATFORM_SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('PLATFORM_SERVICE_KEY') ?? '';
const platform = PLATFORM_URL && PLATFORM_KEY
  ? createClient(PLATFORM_URL, PLATFORM_KEY, { auth: { autoRefreshToken: false, persistSession: false } })
  : null;

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type, x-run-secret' };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const GRACE_MIN = 3;     // let the POS master fire the normal routed version first
const BATCH = 200;
// Time budgets. Supabase's edge wall clock is 150 s; these three add up to well under it (100 s),
// and everything slow (ezCater, the unchecked flag, the claim and ticket) runs inside one of them.
const RECHECK_BUDGET_MS = 25_000;
const PREFIRE_BUDGET_MS = 30_000;
const PREFIRE_CONCURRENCY = 8;
const FIRE_CONCURRENCY = 8;
const FIRE_BUDGET_MS = 45_000;

const log = (...a: unknown[]) => console.log('[catering-release]', ...a);
const withTimeout = <T,>(p: Promise<T>, ms: number, fallback: T): Promise<T> => {
  let t: any = null;
  return Promise.race([p.catch(() => fallback), new Promise<T>((res) => { t = setTimeout(() => res(fallback), ms); })])
    .finally(() => { if (t) clearTimeout(t); });
};

const ROW_COLS = 'ref, location_id, source, status, type, total, items, customer, sent_at';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const auth = (req.headers.get('authorization') || '').replace('Bearer ', '').trim();
  const runSec = req.headers.get('x-run-secret') ?? '';
  if (auth !== SERVICE_ROLE && !(RUN_SECRET && runSec === RUN_SECRET)) return json({ error: 'unauthorized' }, 401);

  // 1) Scheduled re-asks of upcoming ezCater orders, held ones included (C, D). They may move
  // sent_at; they never fire anything and never make this run fire anything early (round 4).
  const rechecks = await withTimeout(recheckUpcoming(sb, platform, { budgetMs: RECHECK_BUDGET_MS - 2_000, log }), RECHECK_BUDGET_MS, []);
  const justChecked = new Set<string>();
  for (const r of rechecks) if (r.outcome === 'checked') justChecked.add(`${r.locationId}|${r.ref}`);

  // 2) THE BACKSTOP: due (fire time + grace passed, not older than the floor), not yet fired by
  // any device, not finished, not held. Oldest first. Nothing else is fired here.
  const cutoff = new Date(Date.now() - GRACE_MIN * 60_000).toISOString();
  const floor = new Date(Date.now() - CATERING_STALE_FLOOR_MS).toISOString();
  const { data, error } = await sb.from('order_queue')
    .select(ROW_COLS)
    .in('source', CATERING_SOURCES).is('kitchen_routed_at', null).not('status', 'in', '(collected,cancelled)')
    .or(releasableOrFilter())
    .lte('sent_at', cutoff)
    .gte('sent_at', floor)
    .order('sent_at', { ascending: true })
    .limit(BATCH);
  if (error) return json({ error: error.message }, 500);
  const rows: any[] = [...(data || [])];

  let held = 0;
  let rescheduled = 0;
  let unchecked = 0;
  const toFire: any[] = [];

  // 3) THE PRE FIRE RE-ASKS, IN PARALLEL, INSIDE ONE BUDGET (G). A row just re-asked this run is
  // not asked twice. Every ezCater row the budget did not reach fires unchecked, flagged (the flag
  // is written in fireOne, inside the fire budget).
  const releasable = rows.filter((r) => { if (!cateringMayFire(r)) { held++; return false; } return true; });
  const needCheck = releasable.filter((r) => isEzcaterOrder(r) && !justChecked.has(`${r.location_id}|${r.ref}`));
  const checks = await runWithBudget(needCheck, (r: any) => prefireCheck(sb, platform, { locationId: r.location_id, ref: r.ref, log }),
    { concurrency: PREFIRE_CONCURRENCY, budgetMs: PREFIRE_BUDGET_MS });
  const checkOf = new Map<string, any>();
  needCheck.forEach((r, i) => checkOf.set(`${r.location_id}|${r.ref}`, checks[i]));
  for (let row of releasable) {
    const res = checkOf.get(`${row.location_id}|${row.ref}`);
    if (res) {
      if (res.ok) {
        const pf = res.value;
        if (!pf.fire) {
          if (pf.outcome === 'rescheduled') rescheduled++; else held++;
          log('ezCater', row.ref, 'not fired:', pf.outcome);
          continue;
        }
        if (!pf.checked) unchecked++;
        if (pf.row) row = { ...row, items: pf.row.items || row.items, customer: pf.row.customer || row.customer, type: pf.row.type || row.type };
      } else {
        // The budget ran out, or the check threw. Never block the kitchen on the check.
        unchecked++;
        const why = res.skipped ? 'the ServOS check ran out of time before ezCater answered' : `the check failed: ${res.error}`;
        row = { ...row, _uncheckedWhy: why };
        log('ezCater', row.ref, 'firing unchecked:', why);
      }
    }
    toFire.push(row);
  }

  // 4) Claim and fire, a few at a time, inside the fire budget.
  const nowIso = new Date().toISOString();
  const fires = await runWithBudget(toFire, (row: any) => fireOne(row, nowIso), { concurrency: FIRE_CONCURRENCY, budgetMs: FIRE_BUDGET_MS });
  const fired = fires.filter((f: any) => f.ok && f.value === true).length;

  return json({ ok: true, scanned: rows.length, fired, held, rescheduled, unchecked, rechecked: rechecks.length });
});

/** Claim one row for the kitchen and drop its KDS ticket. true when this run fired it. */
async function fireOne(row: any, nowIso: string): Promise<boolean> {
  // An ezCater order going without its last check says so on the order, BEFORE the claim (the
  // flag only writes while unfired). Inside the fire budget and in parallel (round 4).
  if (row._uncheckedWhy) {
    const f = await flagUnchecked(sb, row.location_id, row.ref, row._uncheckedWhy, nowIso);
    if (f.row?.customer) row = { ...row, customer: f.row.customer };
  }
  // Atomic claim: only one firer (this cron OR a device) ever proceeds for a given order, and
  // ONLY while the order is still releasable (E): not cancelled, not collected, not held. A
  // cancel that landed after the checks above makes this match nothing.
  const claim = await sb.from('order_queue')
    .update({ kitchen_routed_at: new Date().toISOString() })
    .eq('ref', row.ref).eq('location_id', row.location_id).is('kitchen_routed_at', null)
    .not('status', 'in', UNCLAIMABLE_STATUSES_PG)
    .or(releasableOrFilter())
    .select('ref, type, items, customer');
  if (claim.error || !claim.data?.length) return false;   // a device claimed it, or it is no longer releasable
  // The row as claimed is the freshest: fire THAT (an update may have landed after our read).
  const got = claim.data[0];
  row = { ...row, type: got.type || row.type, items: got.items || row.items, customer: got.customer || row.customer };

  // v5.5.654: BULLETPROOF fire-time courier dispatch. We won the claim, so no POS device fired
  // this order → no device will dispatch the courier either. If it's an uber-mode delivery,
  // dispatch server-side now (idempotent on order_ref, so a device that comes online won't
  // double-send). Self-delivery just gets the KDS ticket below. Independent of KDS success.
  if (mayBookOurCourier(row)) {
    try {
      const { data: cfg } = await sb.from('venue_uber_config').select('*').eq('location_id', row.location_id).maybeSingle();
      if (cfg?.enabled) {
        const quote = { customerFeeMinor: Math.round(Number(row.customer.delivery_fee || 0) * 100), dropoff: row.customer.address || null, currency: 'GBP', quoteId: null };
        await dispatchCourier(sb, { loc: row.location_id, cfg, order: { ref: row.ref, items: row.items || [], total: row.total, customer: row.customer }, quote });
      }
    } catch (e) { console.warn('[catering-release] courier dispatch', row.ref, (e as Error)?.message); }
  }

  // Consolidated KDS ticket (all items, centre_id null → shows on the all-items KDS view).
  const label = cateringSourceLabel(row.source) || 'Catering';
  const who = row.customer?.name || label;
  const ticket = {
    id: `kds-cat-${row.ref}`,
    location_id: row.location_id,
    table_label: `${label} ${row.ref}`,
    items: row.items || [],
    status: 'pending', course: 'main', centre_id: null,
    server: who, covers: 1,
    sent_at: new Date().toISOString(),
  };
  // v5.8.66: order type, name, number and source for the redesigned KDS. Same shape as
  // buildTicketMeta in src/lib/kds/kdsTicket.js. Catering refs (CA-XXXXX) show in full.
  const meta = {
    v: 1, channel: row.source || 'catering', isTable: false,
    orderType: ['takeaway', 'collection', 'delivery'].includes(row.type) ? row.type : 'collection',
    customerName: row.customer?.name || null,
    // ezCater's own order number (HKX77V) is what the caterer and driver quote.
    orderNo: (isEzcaterOrder(row) && row.customer?.ezcater_order_number) || row.ref, source: label, staff: null,
    note: (typeof row.customer?.notes === 'string' && row.customer.notes.trim()) || null,
  };
  let { error: kErr } = await sb.from('kds_tickets').insert({ ...ticket, meta });
  // Before the kds_tickets.meta migration is run the column is missing: insert the
  // ticket exactly as before so the kitchen still gets the order.
  if (kErr && /PGRST204|42703/.test(`${kErr.code || ''} ${kErr.message || ''}`) && /meta/.test(kErr.message || '')) {
    ({ error: kErr } = await sb.from('kds_tickets').insert(ticket));
  }
  if (kErr) { console.warn('[catering-release] kds insert', row.ref, kErr.message); return false; }
  return true;
}
