// ops-escalate — cron sweep that notifies + escalates unacknowledged Operations alerts.
//
// Reads ops_alerts (status='sent') and ops_notification_rules; when an alert is due for
// its next escalation rung (escalate_after_min × step), it sends SMS (send-sms) and/or
// email (send-receipt) to the rule's recipients and bumps escalation_step. In-app alerts
// already fire on creation (Realtime); this adds the out-of-band channels + the ladder.
// Food-safety alerts are never suppressed. Idempotent-ish via escalation_step.
//
// Schedule via Vercel cron or pg_cron (every ~3-5 min). Service-role only.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const sb = createClient(URL, SERVICE_ROLE);
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type' };
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

async function invokeFn(name: string, body: unknown) {
  try {
    await fetch(`${URL}/functions/v1/${name}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${SERVICE_ROLE}` },
      body: JSON.stringify(body),
    });
  } catch (_) { /* best-effort; never block the sweep */ }
}

// Resolve a rule's recipients to {phones[], emails[]}. Entries: {phone}|{email}|{role}.
async function resolveRecipients(locationId: string, recipients: any[]) {
  const phones = new Set<string>(), emails = new Set<string>();
  const roles: string[] = [];
  for (const r of recipients || []) {
    if (r?.phone) phones.add(toE164(r.phone));
    if (r?.email) emails.add(r.email);
    if (r?.role) roles.push(r.role);
  }
  if (roles.length) {
    const { data: staff } = await sb.from('staff_members').select('role, phone, email').eq('location_id', locationId).in('role', roles);
    (staff || []).forEach((s: any) => { if (s.phone) phones.add(toE164(s.phone)); if (s.email) emails.add(s.email); });
  }
  return { phones: [...phones], emails: [...emails] };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const auth = (req.headers.get('Authorization') ?? '').replace('Bearer ', '').trim();
  if (auth !== SERVICE_ROLE) return json({ error: 'service role only' }, 401);

  const now = Date.now();
  const { data: alerts } = await sb.from('ops_alerts').select('*').eq('status', 'sent').limit(500);
  let notified = 0, escalated = 0;

  for (const a of alerts ?? []) {
    const { data: rules } = await sb.from('ops_notification_rules')
      .select('*').eq('location_id', a.location_id).eq('active', true).eq('event_type', a.type);
    const rule = (rules || []).find((r: any) => RANK[a.severity] >= RANK[r.severity_min ?? 'major']);
    if (!rule) continue;                                   // no SMS/email rule → stays in-app only

    const elapsedMin = (now - new Date(a.created_at).getTime()) / 60000;
    const step = a.escalation_step ?? 0;
    if (step >= MAX_STEPS) continue;
    const dueAt = (rule.escalate_after_min ?? 15) * step;   // step 0 = send now, then every interval
    if (elapsedMin < dueAt) continue;

    const { phones, emails } = await resolveRecipients(a.location_id, rule.recipients);
    const channels: string[] = Array.isArray(rule.channels) ? rule.channels : ['inapp'];
    const msg = `ServOS ALERT${step > 0 ? ` (escalation ${step})` : ''}: ${a.title}. ${a.body || ''} — acknowledge in Back Office.`;

    if (channels.includes('sms')) for (const to of phones) await invokeFn('send-sms', { to, message: msg, location_id: a.location_id, type: 'status_update' });
    if (channels.includes('email')) for (const to of emails) await invokeFn('send-receipt', { location_id: a.location_id, to, subject: `ServOS Operations alert — ${a.title}`, html: `<p>${msg}</p>` });

    await sb.from('ops_alerts').update({ escalation_step: step + 1 }).eq('id', a.id);
    notified++; if (step > 0) escalated++;
  }

  return json({ ok: true, scanned: alerts?.length || 0, notified, escalated });
});
