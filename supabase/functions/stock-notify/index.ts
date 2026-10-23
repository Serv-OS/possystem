// supabase/functions/stock-notify/index.ts
//
// MULTI SITE STOCK Drop 3 (contract 3.5, map 4.23, decision 3): the stock alert sender. pg_cron runs
// stock_notify_due() every minute inside the database; it stages what is due on each venue's own clock
// in the ledger stock_notify_sent (order by in 1 hour, approvals, counts due and missed, deliveries
// overdue, transfers waiting; price rises, unplaced invoices and second approvals are staged by the
// saves themselves) and only when rows wait does it post here with its vault key
// (stock_notify_cron_key).
//
// For each waiting row (at most 200 a run, oldest first): claim it (attempts moves on only for the
// run that read it), ask the database who gets it (stock_notify_targets), write the bell
// (activity_events, one row per bell site, kind stock_<kind>, ref_type 'stock', ref_id the Back Office
// route and focus), then the texts (send-sms) and emails (send-receipt) the map 4.23 table gives the
// kind (_shared/stockNotifyRules.js), then mark the row sent with the bell id. Nothing is sent twice:
// a row that is not waiting, or that another run claimed, is skipped. No ops_alerts row and no phone
// push (decision 3; Peter: SMS, email and the bell first).
//
// 5.11.100 (Drop 4b, contract 5): kind 'weekly', the weekly email. stock_notify_due stages one row per
// open site and one company row a week (on each venue's clock, after the count plan deadline). For it,
// this function asks stock_report_league (service role) for the row's sites and week, builds the email
// (stockNotifyRules.weeklyEmail: the company pack to head office, each site's own line to its managers,
// 'Count not in' where a count is late) and emails it. No bell and no text for weekly. Every other kind
// is sent exactly as before.
// MARKER 5.11.100 stock-notify weekly
//
//   POST (no body)  header x-cron-key: <the vault key>, or the service role bearer
//   answers { ok, sent, failed }
//
// ⚠ Edge functions deploy MANUALLY:
//   npx supabase functions deploy stock-notify --project-ref tbetcegmszzotrwdtqhi --no-verify-jwt

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { CRON_KEY_HEADER, isServiceRoleBearer } from '../_shared/cronKey.js';
import { cronAccess, sendable, planSend, bellRow, outcomeOf, channelsOf } from '../_shared/stockNotifyRules.js';

// the Back Office the alert email links to (the row in focus); APP_ORIGIN overrides it
const APP_ORIGIN = Deno.env.get('APP_ORIGIN') || 'https://app.serv-os.app';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const sb = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { autoRefreshToken: false, persistSession: false } });

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-key' };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });
const MAX_ROWS = 200;
const MAX_ATTEMPTS = 3;

async function invokeFn(name: string, body: unknown): Promise<boolean> {
  try {
    const r = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${SERVICE_ROLE}` },
      body: JSON.stringify(body),
    });
    return r.ok;
  } catch {
    return false;
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const service = isServiceRoleBearer(req.headers.get('Authorization'), SERVICE_ROLE);
  const key = String(req.headers.get(CRON_KEY_HEADER) ?? '').trim();
  const check = !service && key ? await sb.rpc('stock_notify_cron_ok', { p_key: key }) : null;
  const access = cronAccess({ service, key, check: check ? { data: check.data, error: check.error } : null });
  if (!access.ok) return json({ error: access.reason }, access.status);

  const { data: rows, error } = await sb.from('stock_notify_sent')
    .select('id, org_id, location_id, kind, ref, payload, status, attempts, created_at')
    .eq('status', 'waiting').order('created_at', { ascending: true }).order('id', { ascending: true }).limit(MAX_ROWS);
  if (error) return json({ error: `could not read the alerts: ${error.message}` }, 500);

  let sent = 0;
  let failed = 0;
  for (const row of rows ?? []) {
    if (!sendable(row)) continue;
    // Claim: only the run that moves attempts on from what it read sends this row.
    const attempts = (Number(row.attempts) || 0) + 1;
    const { data: claimed, error: claimErr } = await sb.from('stock_notify_sent').update({ attempts })
      .eq('id', row.id).eq('status', 'waiting').eq('attempts', Number(row.attempts) || 0).select('id');
    if (claimErr || !Array.isArray(claimed) || !claimed.length) continue;

    const { data: targets, error: tErr } = await sb.rpc('stock_notify_targets', { p_id: row.id });
    if (tErr) {
      await sb.from('stock_notify_sent').update({ last_error: `who to tell: ${tErr.message}`.slice(0, 500), ...(attempts >= MAX_ATTEMPTS ? { status: 'failed' } : {}) }).eq('id', row.id);
      if (attempts >= MAX_ATTEMPTS) failed++;
      continue;
    }
    // 5.11.100: the weekly email reads the week's league (service role) for the row's sites.
    const weekly = row.kind === 'weekly';
    let league: any = null;
    if (weekly) {
      const p = row.payload || {};
      const sites = row.location_id ? [row.location_id] : (Array.isArray(p.site_ids) ? p.site_ids : []);
      const { data: lg, error: lErr } = await sb.rpc('stock_report_league', { p_org: row.org_id, p_sites: sites, p_from: p.week_start, p_to: p.week_end, p_opts: null, p_after: null, p_limit: 1000 });
      if (lErr) {
        await sb.from('stock_notify_sent').update({ last_error: `the week's figures: ${lErr.message}`.slice(0, 500), ...(attempts >= MAX_ATTEMPTS ? { status: 'failed' } : {}) }).eq('id', row.id);
        if (attempts >= MAX_ATTEMPTS) failed++;
        continue;
      }
      league = lg;
    }
    const plan = planSend(row, targets || {}, { origin: APP_ORIGIN, league });
    if (!weekly && !plan.bell.length) {
      await sb.from('stock_notify_sent').update({ status: 'skipped', last_error: 'no site to tell' }).eq('id', row.id);
      continue;
    }

    // The bell first: it is the record that the alert went out.
    const bellIds: string[] = [];
    for (const loc of plan.bell) {
      const { data: ev, error: evErr } = await sb.from('activity_events').insert(bellRow(row.kind, row.payload || {}, loc)).select('id').single();
      if (!evErr && ev?.id) bellIds.push(String(ev.id));
    }
    const sendLoc = row.location_id || plan.bell[0] || (weekly && Array.isArray(row.payload?.site_ids) ? row.payload.site_ids[0] : undefined);
    let smsSent = 0;
    let emailSent = 0;
    for (const s of plan.sms) if (await invokeFn('send-sms', { to: s.to, message: s.text, location_id: sendLoc, type: 'status_update' })) smsSent++;
    for (const m of plan.email) if (await invokeFn('send-receipt', { location_id: sendLoc, to: m.to, subject: m.subject, html: m.html })) emailSent++;

    const out = outcomeOf({ bellIds, smsSent, smsTried: plan.sms.length, emailSent, emailTried: plan.email.length, emailOnly: !channelsOf(row.kind).bell });
    if (out.status === 'skipped') {
      await sb.from('stock_notify_sent').update({ status: 'skipped', last_error: out.error }).eq('id', row.id);
      continue;
    }
    if (out.status === 'sent') {
      await sb.from('stock_notify_sent').update({ status: 'sent', sent_at: new Date().toISOString(), bell_event_id: bellIds[0] ?? null, last_error: out.error }).eq('id', row.id);
      sent++;
    } else {
      await sb.from('stock_notify_sent').update({ last_error: out.error, ...(attempts >= MAX_ATTEMPTS ? { status: 'failed' } : {}) }).eq('id', row.id);
      if (attempts >= MAX_ATTEMPTS) failed++;
    }
  }
  return json({ ok: true, sent, failed });
});
