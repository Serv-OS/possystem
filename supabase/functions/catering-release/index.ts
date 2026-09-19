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

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { dispatchCourier } from '../_shared/delivery-dispatch.ts';
import {
  NOT_RELEASABLE_STATUSES_PG, RELEASABLE_OR_FILTER, mayBookOurCourier, isEzcaterOrder, ezcaterOrderNumber,
  ezcaterHoldAlertDue, ezcaterHoldAlertText,
} from '../_shared/ezcaterCatering.js';

const URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const RUN_SECRET = Deno.env.get('CATERING_RELEASE_SECRET') ?? '';
const sb = createClient(URL, SERVICE_ROLE, { auth: { autoRefreshToken: false, persistSession: false } });

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
  // Due (fire time + grace passed), not yet fired by any device, not finished. Oldest first.
  const { data, error } = await sb.from('order_queue')
    .select('ref, location_id, type, total, items, customer, sent_at')
    .eq('source', 'catering').is('kitchen_routed_at', null)
    // 18 Sep 2026: ezCater orders are catering orders. One cancelled before it fired, or not yet
    // accepted by ezCater, is never released. Our own rows carry no hold key: unchanged for them.
    .not('status', 'in', NOT_RELEASABLE_STATUSES_PG)
    .or(RELEASABLE_OR_FILTER)
    .lte('sent_at', cutoff)
    .order('sent_at', { ascending: true })
    .limit(BATCH);
  if (error) return json({ error: error.message }, 500);

  let fired = 0;
  for (const row of (data || [])) {
    // Atomic claim — only one firer (this cron OR a device) ever proceeds for a given order.
    const claim = await sb.from('order_queue')
      .update({ kitchen_routed_at: new Date().toISOString() })
      .eq('ref', row.ref).eq('location_id', row.location_id).is('kitchen_routed_at', null)
      // A cancel, or staff marking it collected, landing between the read above and this claim
      // must not reach the kitchen. The same statuses the read excludes.
      .not('status', 'in', NOT_RELEASABLE_STATUSES_PG)
      .select('ref');
    if (claim.error || !claim.data?.length) continue;   // a device just claimed it — leave the routed fire to them

    // v5.5.654: BULLETPROOF fire-time courier dispatch. We won the claim, so no POS device fired
    // this order → no device will dispatch the courier either. If it's an uber-mode delivery,
    // dispatch server-side now (idempotent on order_ref, so a device that comes online won't
    // double-send). Self-delivery just gets the KDS ticket below. Independent of KDS success.
    // Never for an ezCater order: the caterer or ezCater delivers it.
    if (row.type === 'delivery' && row.customer?.delivery_mode === 'uber' && mayBookOurCourier(row)) {
      try {
        const { data: cfg } = await sb.from('venue_uber_config').select('*').eq('location_id', row.location_id).maybeSingle();
        if (cfg?.enabled) {
          const quote = { customerFeeMinor: Math.round(Number(row.customer.delivery_fee || 0) * 100), dropoff: row.customer.address || null, currency: 'GBP', quoteId: null };
          await dispatchCourier(sb, { loc: row.location_id, cfg, order: { ref: row.ref, items: row.items || [], total: row.total, customer: row.customer }, quote });
        }
      } catch (e) { console.warn('[catering-release] courier dispatch', row.ref, (e as Error)?.message); }
    }

    // Consolidated KDS ticket (all items, centre_id null → shows on the all-items KDS view).
    const who = row.customer?.name || 'Catering';
    // An ezCater order shows ezCater and ezCater's own order number (customer.channel).
    const ez = isEzcaterOrder(row);
    const ezNo = ez ? ezcaterOrderNumber(row) : null;
    const ticket = {
      id: `kds-cat-${row.ref}`,
      location_id: row.location_id,
      table_label: `Catering ${ezNo || row.ref}`,
      items: row.items || [],
      status: 'pending', course: 'main', centre_id: null,
      server: who, covers: 1,
      sent_at: new Date().toISOString(),
    };
    // v5.8.66: order type, name, number and source for the redesigned KDS. Same shape as
    // buildTicketMeta in src/lib/kds/kdsTicket.js. Catering refs (CA-XXXXX) show in full.
    const meta = {
      v: 1, channel: 'catering', isTable: false,
      orderType: ['takeaway', 'collection', 'delivery'].includes(row.type) ? row.type : 'collection',
      customerName: row.customer?.name || null,
      orderNo: ezNo || row.ref, source: ez ? 'ezCater' : 'Catering', staff: null,
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

  // HELD PAST ITS FIRE TIME (18 Sep 2026). An ezCater order ezCater has not accepted is never
  // released above, correctly, but once its fire time passes somebody must be told. One urgent
  // activity entry per order, ever: customer.ezcater_hold_alerted_at is stamped first with a
  // conditional update, so two overlapping runs never both write it. Best effort: a failure
  // here never fails the release.
  let holdAlerts = 0;
  try {
    holdAlerts = await alertHeldEzcaterOrders();
  } catch (e) { console.warn('[catering-release] held ezCater alert', (e as Error)?.message); }

  return json({ ok: true, scanned: data?.length || 0, fired, holdAlerts });
});

async function alertHeldEzcaterOrders(): Promise<number> {
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const { data, error } = await sb.from('order_queue')
    .select('ref, location_id, source, status, sent_at, kitchen_routed_at, customer')
    .eq('source', 'catering').is('kitchen_routed_at', null)
    .not('status', 'in', NOT_RELEASABLE_STATUSES_PG)
    .eq('customer->>ezcater_awaiting_acceptance', 'true')
    .is('customer->>ezcater_hold_alerted_at', null)
    .lte('sent_at', nowIso)
    .order('sent_at', { ascending: true })
    .limit(BATCH);
  if (error) { console.warn('[catering-release] held ezCater read', error.message); return 0; }

  let n = 0;
  for (const row of (data || [])) {
    if (!ezcaterHoldAlertDue(row, nowMs)) continue;   // the pure rule, the filters above mirror it
    // Claim: only while still held, unrouted and not yet alerted.
    const claim = await sb.from('order_queue')
      .update({ customer: { ...(row.customer || {}), ezcater_hold_alerted_at: nowIso } })
      .eq('ref', row.ref).eq('location_id', row.location_id)
      .is('kitchen_routed_at', null)
      .eq('customer->>ezcater_awaiting_acceptance', 'true')
      .is('customer->>ezcater_hold_alerted_at', null)
      .select('ref');
    if (claim.error || !claim.data?.length) continue;
    const { error: aErr } = await sb.from('activity_events').insert({
      location_id: row.location_id, kind: 'order', severity: 'urgent',
      title: ezcaterHoldAlertText(row), body: null,
      ref_type: 'order', ref_id: row.ref,
    });
    if (aErr) {
      // Take the stamp back off so the next run tries again (only if it is still ours).
      console.warn('[catering-release] held ezCater alert write', row.ref, aErr.message);
      await sb.from('order_queue').update({ customer: row.customer || {} })
        .eq('ref', row.ref).eq('location_id', row.location_id)
        .eq('customer->>ezcater_hold_alerted_at', nowIso)
        .then(() => {}, () => {});
      continue;
    }
    n++;
  }
  return n;
}
