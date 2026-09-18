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

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { dispatchCourier } from '../_shared/delivery-dispatch.ts';
import {
  CATERING_SOURCES, CATERING_STALE_FLOOR_MS, cateringMayFire, mayBookOurCourier, cateringSourceLabel,
  isEzcaterOrder, releasableOrFilter,
} from '../_shared/cateringRules.js';
import { prefireCheck } from '../_shared/ezcaterIngest.ts';

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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const auth = (req.headers.get('authorization') || '').replace('Bearer ', '').trim();
  const runSec = req.headers.get('x-run-secret') ?? '';
  if (auth !== SERVICE_ROLE && !(RUN_SECRET && runSec === RUN_SECRET)) return json({ error: 'unauthorized' }, 401);

  const cutoff = new Date(Date.now() - GRACE_MIN * 60_000).toISOString();
  const floor = new Date(Date.now() - CATERING_STALE_FLOOR_MS).toISOString();
  // Due (fire time + grace passed, not older than the floor), not yet fired by any device, not
  // finished, not held. Oldest first.
  const { data, error } = await sb.from('order_queue')
    .select('ref, location_id, source, status, type, total, items, customer, sent_at')
    .in('source', CATERING_SOURCES).is('kitchen_routed_at', null).not('status', 'in', '(collected,cancelled)')
    .or(releasableOrFilter())
    .lte('sent_at', cutoff)
    .gte('sent_at', floor)
    .order('sent_at', { ascending: true })
    .limit(BATCH);
  if (error) return json({ error: error.message }, 500);

  let fired = 0;
  let held = 0;
  let rescheduled = 0;
  let unchecked = 0;
  for (let row of (data || [])) {
    // Not accepted on ezCater yet: stays held and visible, fires once the accepted notification lands.
    if (!cateringMayFire(row)) { held++; continue; }
    // ezCater: ask ezCater what the order is NOW, then fire the answer (fresh items and times).
    if (isEzcaterOrder(row)) {
      try {
        const pf = await prefireCheck(sb, platform, {
          locationId: row.location_id, ref: row.ref,
          log: (...a: unknown[]) => console.log('[catering-release]', ...a),
        });
        if (!pf.fire) {
          if (pf.outcome === 'rescheduled') rescheduled++; else held++;
          console.log('[catering-release] ezCater', row.ref, 'not fired:', pf.outcome);
          continue;
        }
        if (!pf.checked) unchecked++;
        if (pf.row) row = { ...row, items: pf.row.items || row.items, customer: pf.row.customer || row.customer, type: pf.row.type || row.type };
      } catch (e) {
        // Never block the kitchen on the check.
        unchecked++;
        console.warn('[catering-release] ezCater check failed, firing as planned', row.ref, (e as Error)?.message);
      }
    }
    // Atomic claim: only one firer (this cron OR a device) ever proceeds for a given order.
    const claim = await sb.from('order_queue')
      .update({ kitchen_routed_at: new Date().toISOString() })
      .eq('ref', row.ref).eq('location_id', row.location_id).is('kitchen_routed_at', null)
      .select('ref');
    if (claim.error || !claim.data?.length) continue;   // a device just claimed it, leave the routed fire to them

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
    if (kErr) { console.warn('[catering-release] kds insert', row.ref, kErr.message); continue; }
    fired++;
  }
  return json({ ok: true, scanned: data?.length || 0, fired, held, rescheduled, unchecked });
});
