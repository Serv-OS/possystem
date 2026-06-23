// supabase/functions/catering-release/index.ts
//
// SERVER-SIDE SAFETY NET for catering scheduled firing. Catering pre-orders are held in
// order_queue (source='catering', kitchen_routed_at NULL) with sent_at = the kitchen fire
// instant. The POS master device normally fires them at sent_at via routeKioskOrderPrints
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
    .select('ref, location_id, items, customer, sent_at')
    .eq('source', 'catering').is('kitchen_routed_at', null).neq('status', 'collected')
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
      .select('ref');
    if (claim.error || !claim.data?.length) continue;   // a device just claimed it — leave the routed fire to them
    // Consolidated KDS ticket (all items, centre_id null → shows on the all-items KDS view).
    const who = row.customer?.name || 'Catering';
    const { error: kErr } = await sb.from('kds_tickets').insert({
      id: `kds-cat-${row.ref}`,
      location_id: row.location_id,
      table_label: `Catering ${row.ref}`,
      items: row.items || [],
      status: 'pending', course: 'main', centre_id: null,
      server: who, covers: 1,
      sent_at: new Date().toISOString(),
    });
    if (kErr) { console.warn('[catering-release] kds insert', row.ref, kErr.message); continue; }
    fired++;
  }
  return json({ ok: true, scanned: data?.length || 0, fired });
});
