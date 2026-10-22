// supabase/functions/po-cutoff-run/index.ts
//
// MULTI SITE STOCK Drop 3 (contract 3.5): the order by runner's sender. pg_cron runs
// stock_po_cutoff_run() every minute inside the database: it moves approvals up at 60 and 30 minutes,
// marks orders "sent unapproved" at the order by time (company setting, on by default), and makes the
// standing orders. Every order that must be EMAILED lands in stock_po_send_jobs, and only then does the
// database post here with its vault key (po_cutoff_cron_key).
//
// This function reads the waiting jobs (at most 50 a run, oldest first), sends each through the ONE
// send path (_shared/poSend.ts, the same email po-send sends), and marks the job sent or tried again.
// Three failures (or a failure that cannot heal: no email on file) leave it failed and stage a
// 'sent_unapproved' alert: 'Could not email <supplier>. Phone them.' (stock-notify sends it).
// Nothing here moves a stock number; a sent order only counts as on order, as every SENT order does.
//
//   POST (no body)  header x-cron-key: <the vault key>, or the service role bearer
//   answers { ok, sent, failed }
//
// ⚠ Edge functions deploy MANUALLY:
//   npx supabase functions deploy po-cutoff-run --project-ref tbetcegmszzotrwdtqhi --no-verify-jwt

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { CRON_KEY_HEADER, isServiceRoleBearer } from '../_shared/cronKey.js';
import { cronAccess, sendJobStep } from '../_shared/stockNotifyRules.js';
import { sendPurchaseOrder } from '../_shared/poSend.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const sb = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { autoRefreshToken: false, persistSession: false } });

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-key' };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });
const MAX_JOBS = 50;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const service = isServiceRoleBearer(req.headers.get('Authorization'), SERVICE_ROLE);
  const key = String(req.headers.get(CRON_KEY_HEADER) ?? '').trim();
  const check = !service && key ? await sb.rpc('po_cutoff_cron_ok', { p_key: key }) : null;
  const access = cronAccess({ service, key, check: check ? { data: check.data, error: check.error } : null });
  if (!access.ok) return json({ error: access.reason }, access.status);

  // an approved order's job waits two minutes (not_before) so the screen's own send goes first
  const { data: jobs, error } = await sb.from('stock_po_send_jobs')
    .select('id, po_id, location_id, why, status, attempts, created_at')
    .eq('status', 'waiting').lte('not_before', new Date().toISOString())
    .order('created_at', { ascending: true }).order('id', { ascending: true }).limit(MAX_JOBS);
  if (error) return json({ error: `could not read the send list: ${error.message}` }, 500);

  let sent = 0;
  let failed = 0;
  const errors: string[] = [];
  for (const job of jobs ?? []) {
    let result: any;
    try {
      // only a DRAFT is sent: an order the screen emailed already, or one received or cancelled, is done
      result = await sendPurchaseOrder(sb, { poId: job.po_id, locationId: job.location_id, supabaseUrl: SUPABASE_URL, serviceKey: SERVICE_ROLE, onlyDraft: true });
    } catch (e) {
      result = { ok: false, error: String((e as Error)?.message || e) };
    }
    // An order the runner already put on the kitchen's list, or already received, has nothing to send.
    if (!result.ok && result.internal) result = { ok: false, error: result.error, final: true };
    const step = sendJobStep(job, result, new Date().toISOString());
    const { error: upErr } = await sb.from('stock_po_send_jobs').update(step.patch).eq('id', job.id).eq('status', 'waiting');
    if (upErr) errors.push(`job ${job.id}: ${upErr.message}`);
    if (result.ok) { sent++; continue; }
    if (step.patch.status === 'failed') failed++;
    if (step.alert) await stageFailedAlert(job, result.error);
  }
  if (errors.length) console.error('[po-cutoff-run]', errors.join('; '));
  return json({ ok: true, sent, failed });
});

// 'Could not email <supplier>. Phone them.' to the company editors (and the bell at the site), once.
async function stageFailedAlert(job: any, why: string) {
  try {
    const [{ data: po }, { data: loc }] = await Promise.all([
      sb.from('purchase_orders').select('reference, supplier_id').eq('id', job.po_id).maybeSingle(),
      sb.from('locations').select('org_id, name').eq('id', job.location_id).maybeSingle(),
    ]);
    if (!loc?.org_id) return;
    const { data: sup } = po?.supplier_id
      ? await sb.from('suppliers').select('name').eq('id', po.supplier_id).eq('location_id', job.location_id).maybeSingle()
      : { data: null };
    const supplier = sup?.name || 'the supplier';
    const { error } = await sb.from('stock_notify_sent').insert({
      org_id: loc.org_id, location_id: job.location_id, kind: 'sent_unapproved', ref: `${job.po_id}:email_failed`,
      payload: {
        title: `Could not email ${supplier}. Phone them.`,
        body: `${loc.name || 'A site'}: the order${po?.reference ? ` ${po.reference}` : ''} did not reach the supplier by email (${String(why || 'send failed').slice(0, 160)}).`,
        failed: true, po_id: job.po_id, supplier_name: supplier, site_name: loc.name || null, reference: po?.reference || null,
      },
    });
    // 23505: staged already (the ledger's unique key), which is the point
    if (error && String(error.code) !== '23505') console.error('[po-cutoff-run] alert', error.message);
  } catch (e) {
    console.error('[po-cutoff-run] alert', String((e as Error)?.message || e));
  }
}
