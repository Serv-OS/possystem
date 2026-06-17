// send-receipt — provider-agnostic email-receipt dispatcher.
//
// Reads RECEIPT_EMAIL_PROVIDER env var to pick a backend. Defaults to 'log'
// (writes to receipt_emails with status='queued' but doesn't actually send) so
// the UI flow ships and works end-to-end before a provider is chosen.
//
// To plug in a real provider (Resend / Postmark / SendGrid / SES / Mailgun)
// just add a sender function below and set RECEIPT_EMAIL_PROVIDER + the
// matching API key secret. No UI/UX changes needed.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';
import { resolveSenderFrom, callerCanBrandForLocation, type Sender } from '../_shared/sending-domain.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const PROVIDER = (Deno.env.get('RECEIPT_EMAIL_PROVIDER') || 'log').toLowerCase();

const sb = createClient(SUPABASE_URL, SERVICE_ROLE);

// CORS — without these, browser-initiated invokes (offer letters, contracts,
// any front-end sendEmail) fail the preflight and the POST never reaches here,
// so no email is sent and no receipt_emails row is written. Must mirror send-sms.
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface RequestBody {
  location_id: string;
  check_id?: string;
  to: string;
  subject?: string;
  html: string;
  text?: string;
}

// Caller must be authenticated: service-role key (internal callers like
// gift-fulfill/gift-resend) or a valid signed-in user (BO/POS). Closes the open
// relay — previously anyone could POST arbitrary HTML email through the venue.
async function authorize(req: Request): Promise<boolean> {
  const token = (req.headers.get('Authorization') ?? '').replace('Bearer ', '').trim();
  if (!token) return false;
  if (token === SERVICE_ROLE) return true;
  try { const { data: { user } } = await sb.auth.getUser(token); return !!user; } catch { return false; }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'OPTIONS' && !(await authorize(req))) return json({ error: 'unauthorized' }, 401);
  if (req.method !== 'POST') return json({ error:'POST only' }, 405);
  let body: RequestBody;
  try { body = await req.json(); } catch { return json({ error:'invalid JSON' }, 400); }

  if (!body?.to || !body?.html || !body?.location_id) {
    return json({ error:'missing required fields: location_id, to, html' }, 400);
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.to)) {
    return json({ error:'invalid email address' }, 400);
  }

  // Insert audit row first — gives us a stable id even if dispatch fails
  const { data: row, error: insertErr } = await sb
    .from('receipt_emails')
    .insert({
      location_id: body.location_id,
      check_id: body.check_id || null,
      to_email: body.to,
      subject: body.subject || 'Your receipt',
      status: 'pending',
      provider: PROVIDER,
    })
    .select('id')
    .single();

  if (insertErr || !row) {
    return json({ error:`failed to log: ${insertErr?.message || 'unknown'}` }, 500);
  }

  try {
    let result: { provider_message_id?: string };
    // per-venue branded From — but ONLY for trusted callers (service-role / user with location access);
    // anonymous kiosk/online callers still send, from the platform default (no cross-tenant domain spoof).
    const branded = await callerCanBrandForLocation(req, sb, body.location_id, SERVICE_ROLE);
    const sender = await resolveSenderFrom(sb, branded ? body.location_id : null, Deno.env.get('RECEIPT_EMAIL_FROM') || 'receipts@posup.co.uk');
    switch (PROVIDER) {
      case 'resend':   result = await sendViaResend(body, sender); break;
      case 'postmark': result = await sendViaPostmark(body, sender); break;
      case 'sendgrid': result = await sendViaSendgrid(body, sender); break;
      case 'log':
      default:         result = await sendViaLog(body); break;
    }

    await sb.from('receipt_emails').update({
      status: PROVIDER === 'log' ? 'queued' : 'sent',
      sent_at: PROVIDER === 'log' ? null : new Date().toISOString(),
      provider_message_id: result.provider_message_id || null,
    }).eq('id', row.id);

    return json({ ok:true, id: row.id, provider: PROVIDER });
  } catch (e) {
    await sb.from('receipt_emails').update({
      status:'failed',
      error: (e as Error)?.message || String(e),
    }).eq('id', row.id);
    return json({ error:`send failed: ${(e as Error)?.message || e}`, id: row.id }, 502);
  }
});

// ── Provider implementations ────────────────────────────────────────────────
// 'log' — no real send, just confirm the audit row was written. Useful for
// shipping the UI before a provider is chosen.
async function sendViaLog(body: RequestBody) {
  console.log(`[send-receipt:log] would send to=${body.to} subject="${body.subject || 'Receipt'}" length=${body.html.length}`);
  return { provider_message_id: undefined };
}

// 'resend' — https://resend.com (recommended; clean API, generous free tier)
async function sendViaResend(body: RequestBody, sender: Sender) {
  const apiKey = Deno.env.get('RESEND_API_KEY');
  if (!apiKey) throw new Error('RESEND_API_KEY not set');
  const res = await fetch('https://api.resend.com/emails', {
    method:'POST',
    headers:{ 'authorization': `Bearer ${apiKey}`, 'content-type':'application/json' },
    body: JSON.stringify({
      from: sender.from, to: body.to, subject: body.subject || 'Your receipt',
      html: body.html, text: body.text, ...(sender.replyTo ? { reply_to: sender.replyTo } : {}),
    }),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(j?.message || `Resend HTTP ${res.status}`);
  return { provider_message_id: j?.id };
}

// 'postmark' — alternative provider with great deliverability
async function sendViaPostmark(body: RequestBody, sender: Sender) {
  const token = Deno.env.get('POSTMARK_API_TOKEN');
  if (!token) throw new Error('POSTMARK_API_TOKEN not set');
  const res = await fetch('https://api.postmarkapp.com/email', {
    method:'POST',
    headers:{ 'X-Postmark-Server-Token': token, 'content-type':'application/json' },
    body: JSON.stringify({
      From: sender.from, To: body.to, Subject: body.subject || 'Your receipt',
      HtmlBody: body.html, TextBody: body.text, ...(sender.replyTo ? { ReplyTo: sender.replyTo } : {}),
    }),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(j?.Message || `Postmark HTTP ${res.status}`);
  return { provider_message_id: j?.MessageID };
}

// 'sendgrid' — https://sendgrid.com (v3 Mail Send). 202 Accepted, message id in X-Message-Id header.
async function sendViaSendgrid(body: RequestBody, sender: Sender) {
  const key = Deno.env.get('SENDGRID_API_KEY');
  if (!key) throw new Error('SENDGRID_API_KEY not set');
  const content: Array<{ type: string; value: string }> = [{ type: 'text/plain', value: body.text || body.html.replace(/<[^>]+>/g, ' ').trim() || ' ' }];
  if (body.html) content.push({ type: 'text/html', value: body.html });
  const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: { 'authorization': `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ personalizations: [{ to: [{ email: body.to }] }], from: { email: sender.email, ...(sender.name ? { name: sender.name } : {}) }, ...(sender.replyTo ? { reply_to: { email: (sender.replyTo.match(/<([^>]+)>/)?.[1] || sender.replyTo).trim() } } : {}), subject: body.subject || 'Your receipt', content }),
  });
  if (!res.ok) { const t = await res.text().catch(() => ''); throw new Error(`SendGrid HTTP ${res.status} ${t.slice(0, 200)}`); }
  return { provider_message_id: res.headers.get('x-message-id') || undefined };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers:{ ...cors, 'content-type':'application/json' },
  });
}
