// ops-escalate — cron sweep that notifies + escalates unacknowledged Operations alerts.
//
// Reads ops_alerts (status='sent') and ops_notification_rules; when an alert is due for
// its next escalation rung (escalate_after_min × step), it sends SMS (send-sms) and/or
// email (send-receipt) to the rule's recipients and bumps escalation_step. In-app alerts
// already fire on creation (Realtime); this adds the out-of-band channels + the ladder.
// Food-safety alerts are never suppressed. Idempotent-ish via escalation_step.
//
// Scheduled by pg_cron (`ops-escalate-5min`, see 20260805b_edge_cron_bridge.sql).
// Service-role only, or the shared run-secret.
//
// 5 Aug 2026 — two defects fixed here, both of which made the escalation ladder a no-op:
//   1. Recipients were read as `staff_members.phone/email`. staff_members has NEITHER
//      column, so the select errored, `staff || []` swallowed it, and every role-based
//      rule resolved to zero people. Contact details live on the linked wf_staff HR
//      record; back-office users are in user_profiles. Both are now used.
//   2. escalation_step was bumped even when nothing was delivered, so a ladder nobody
//      received still climbed to MAX_STEPS and permanently disarmed the alert. A rung
//      is only counted when at least one message actually went out.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const sb = createClient(URL, SERVICE_ROLE);
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type, x-run-secret' };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'content-type': 'application/json' } });

const RANK: Record<string, number> = { none: 0, minor: 1, major: 2, critical: 3 };
const MAX_STEPS = 3;
// UK local → E.164 (07… → +447…), else assume already international.
const toE164 = (p: string) => {
  const d = (p || '').replace(/[^\d+]/g, '');
  if (d.startsWith('+')) return d;
  if (d.startsWith('07')) return '+44' + d.slice(1);
  if (d.startsWith('44')) return '+' + d;
  return d;
};

// Returns true only if the downstream function actually accepted the send. The old
// version swallowed every failure, so a Twilio/Resend outage looked like a delivery.
async function invokeFn(name: string, body: unknown): Promise<boolean> {
  try {
    const r = await fetch(`${URL}/functions/v1/${name}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${SERVICE_ROLE}` },
      body: JSON.stringify(body),
    });
    if (!r.ok) return false;
    const j = await r.json().catch(() => ({}));
    return j?.ok !== false && !j?.error;
  } catch (_) {
    return false;
  }
}

// Resolve a rule's recipients to {phones[], emails[]}. Entries: {phone}|{email}|{role}|{userId}.
//
// Contact details are NOT on staff_members (it has only id/name/role/pin/colour/…), so
// every path hops to wf_staff, the HR record, via wf_staff.pos_user_id. Back-office
// users come from user_profiles, fenced through user_locations — matching on
// user_profiles.role alone would sweep in hundreds of unrelated tenants' rows.
async function resolveRecipients(locationId: string, recipients: any[]) {
  const phones = new Set<string>(), emails = new Set<string>();
  const roles: string[] = [], userIds: string[] = [], problems: string[] = [];

  for (const r of recipients || []) {
    if (r?.phone) phones.add(toE164(r.phone));
    if (r?.email) emails.add(r.email);
    if (r?.role) roles.push(String(r.role));
    if (r?.userId) userIds.push(String(r.userId));
  }

  const addHr = (rows: any[] | null) => {
    for (const s of rows || []) {
      if (s?.mobile) phones.add(toE164(s.mobile));
      if (s?.email) emails.add(s.email);
    }
  };

  // Named individuals chosen in the rule editor are staff_members ids.
  if (userIds.length) {
    const { data, error } = await sb.from('wf_staff')
      .select('mobile, email').eq('location_id', locationId).in('pos_user_id', userIds);
    if (error) problems.push(`wf_staff by pos_user_id: ${error.message}`);
    addHr(data);
  }

  if (roles.length) {
    const lower = roles.map(r => r.toLowerCase());

    // (a) Workforce position key (chef, host, server…).
    const { data: wf, error: e1 } = await sb.from('wf_staff')
      .select('role_key, mobile, email').eq('location_id', locationId).neq('status', 'leaver');
    if (e1) problems.push(`wf_staff by role_key: ${e1.message}`);
    addHr((wf || []).filter((s: any) => lower.includes(String(s.role_key || '').toLowerCase())));

    // (b) POS role — what the rule editor actually offers (MOD, manager, Kitchen…).
    const { data: sm, error: e2 } = await sb.from('staff_members')
      .select('id, role').eq('location_id', locationId).eq('active', true);
    if (e2) problems.push(`staff_members: ${e2.message}`);
    const ids = (sm || []).filter((s: any) => lower.includes(String(s.role || '').toLowerCase())).map((s: any) => s.id);
    if (ids.length) {
      const { data: hr, error: e3 } = await sb.from('wf_staff')
        .select('mobile, email').eq('location_id', locationId).in('pos_user_id', ids);
      if (e3) problems.push(`wf_staff by POS role: ${e3.message}`);
      addHr(hr);
    }

    // (c) Back-office users with that role who have access to THIS venue.
    const { data: ul, error: e4 } = await sb.from('user_locations')
      .select('user_id').eq('location_id', locationId);
    if (e4) problems.push(`user_locations: ${e4.message}`);
    const uids = (ul || []).map((r: any) => r.user_id).filter(Boolean);
    if (uids.length) {
      const { data: up, error: e5 } = await sb.from('user_profiles').select('email, role').in('id', uids);
      if (e5) problems.push(`user_profiles: ${e5.message}`);
      for (const p of up || []) {
        if (p?.email && lower.includes(String(p.role || '').toLowerCase())) emails.add(p.email);
      }
    }
  }

  return { phones: [...phones].filter(Boolean), emails: [...emails].filter(Boolean), problems };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  // Auth: service-role bearer (internal) OR the shared run-secret the Vercel cron sends
  // (so the cron API route never has to hold the Supabase service-role key).
  const RUN_SECRET = Deno.env.get('OPS_ESCALATE_SECRET') ?? '';
  const auth = (req.headers.get('Authorization') ?? '').replace('Bearer ', '').trim();
  const runSec = req.headers.get('x-run-secret') ?? '';
  if (auth !== SERVICE_ROLE && !(RUN_SECRET && runSec === RUN_SECRET)) return json({ error: 'unauthorized' }, 401);

  const now = Date.now();
  const { data: alerts, error: alertsErr } = await sb.from('ops_alerts').select('*').eq('status', 'sent').limit(500);
  if (alertsErr) return json({ ok: false, error: `could not read ops_alerts: ${alertsErr.message}` }, 500);

  let notified = 0, escalated = 0, failed = 0;
  // Alerts that matched a rule but reached nobody. These deliberately do NOT advance
  // the ladder, so they keep reporting until the rule is given contactable recipients.
  const unreachable: unknown[] = [];

  for (const a of alerts ?? []) {
    // Person-targeted alert (maintenance assigned / resolved) → notify that staff member once.
    if (a.target_user_id) {
      if ((a.escalation_step ?? 0) > 0) continue;
      const { data: hr } = await sb.from('wf_staff')
        .select('mobile, email').eq('pos_user_id', a.target_user_id).maybeSingle();
      const msg = `ServOS: ${a.title}. ${a.body || ''}`;
      let sent = false;
      if (hr?.mobile) sent = await invokeFn('send-sms', { to: toE164(hr.mobile), message: msg, location_id: a.location_id, type: 'status_update' }) || sent;
      if (hr?.email) sent = await invokeFn('send-receipt', { location_id: a.location_id, to: hr.email, subject: `ServOS — ${a.title}`, html: `<p>${msg}</p>` }) || sent;
      if (!sent) {
        unreachable.push({ alert: a.id, title: a.title, reason: hr ? 'send failed' : 'assignee has no linked HR record with contact details' });
        failed++;
        continue;
      }
      await sb.from('ops_alerts').update({ escalation_step: 1 }).eq('id', a.id);
      notified++;
      continue;
    }

    const { data: rules } = await sb.from('ops_notification_rules')
      .select('*').eq('location_id', a.location_id).eq('active', true).eq('event_type', a.type);
    const rule = (rules || []).find((r: any) => RANK[a.severity] >= RANK[r.severity_min ?? 'major']);
    if (!rule) continue;                                   // no SMS/email rule → stays in-app only

    const channels: string[] = Array.isArray(rule.channels) ? rule.channels : ['inapp'];
    const wantsSms = channels.includes('sms'), wantsEmail = channels.includes('email');
    if (!wantsSms && !wantsEmail) continue;                // in-app only by design → no ladder to climb

    const elapsedMin = (now - new Date(a.created_at).getTime()) / 60000;
    const step = a.escalation_step ?? 0;
    if (step >= MAX_STEPS) continue;
    const dueAt = (rule.escalate_after_min ?? 15) * step;   // step 0 = send now, then every interval
    if (elapsedMin < dueAt) continue;

    const { phones, emails, problems } = await resolveRecipients(a.location_id, rule.recipients);
    const toSms = wantsSms ? phones : [], toEmail = wantsEmail ? emails : [];
    if (!toSms.length && !toEmail.length) {
      unreachable.push({
        alert: a.id, title: a.title, rule: rule.id, recipients: rule.recipients,
        reason: 'rule matched but resolved to zero contactable recipients',
        problems,
      });
      continue;                                            // ladder not advanced — nothing was delivered
    }

    const msg = `ServOS ALERT${step > 0 ? ` (escalation ${step})` : ''}: ${a.title}. ${a.body || ''} — acknowledge in Back Office.`;
    let delivered = 0;
    for (const to of toSms) if (await invokeFn('send-sms', { to, message: msg, location_id: a.location_id, type: 'status_update' })) delivered++;
    for (const to of toEmail) if (await invokeFn('send-receipt', { location_id: a.location_id, to, subject: `ServOS Operations alert — ${a.title}`, html: `<p>${msg}</p>` })) delivered++;

    if (!delivered) {
      unreachable.push({ alert: a.id, title: a.title, rule: rule.id, reason: 'every send failed', attempted: toSms.length + toEmail.length });
      failed++;
      continue;                                            // ladder not advanced
    }

    await sb.from('ops_alerts').update({ escalation_step: step + 1 }).eq('id', a.id);
    notified++; if (step > 0) escalated++;
  }

  return json({ ok: true, scanned: alerts?.length || 0, notified, escalated, failed, unreachable });
});
