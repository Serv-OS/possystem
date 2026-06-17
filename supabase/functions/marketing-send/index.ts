// supabase/functions/marketing-send/index.ts
//
// Slice 2 — the unified marketing sender (channel abstraction over email + SMS).
// One entry point used by the campaign/trigger engine (slice 4), drip workflows (slice 6)
// and "send test" from the composer (slice 5). Every send:
//   1. resolves the recipient (customer row or explicit address),
//   2. enforces CONSENT (customer_consents ledger; fallback customers.marketing_opt_in)
//      and the SUPPRESSION list (STOP / unsubscribe / bounce / complaint),
//   3. renders merge tags,
//   4. sends via a provider adapter — or logs only in SANDBOX mode (the default until keys are set),
//   5. writes one auditable row to marketing_messages (idempotent on idempotency_key).
//
// Email adapter reuses the same provider plumbing/env as send-receipt (RECEIPT_EMAIL_PROVIDER =
// log|resend|postmark). SMS adapter uses the same Twilio env as send-sms. No new secrets required;
// with nothing configured everything runs in sandbox (logged, not sent) so the flow is safe to ship.
//
// Actions:
//   send     { channel, to:{customer_id?|email?|phone?}, subject?, html?, text?, sms_body?, merge?, ... }
//   preview  { channel, ...content, merge? }   → render only, no send, no log
//
// Auth: SERVICE_ROLE bearer (internal/cron) with body.org_id, OR a BO user JWT with access to
// body.ops_location_id (org resolved server-side). Mirrors marketing-admin.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { renderMergeTags, buildMergeContext } from '../_shared/marketing-merge.ts';
import { resolveSenderForOrg, type Sender } from '../_shared/sending-domain.ts';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const opsAdmin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { autoRefreshToken: false, persistSession: false } });

// --- provider config (reuses send-receipt / send-sms env) -------------------
const EMAIL_PROVIDER = (Deno.env.get('RECEIPT_EMAIL_PROVIDER') || 'log').toLowerCase();
const EMAIL_FROM = Deno.env.get('MARKETING_EMAIL_FROM') || Deno.env.get('RECEIPT_EMAIL_FROM') || 'hello@posup.co.uk';
const RESEND_KEY = Deno.env.get('RESEND_API_KEY') || '';
const POSTMARK_TOKEN = Deno.env.get('POSTMARK_API_TOKEN') || '';
const SENDGRID_KEY = Deno.env.get('SENDGRID_API_KEY') || '';
const TWILIO_SID = Deno.env.get('TWILIO_ACCOUNT_SID') || '';
const TWILIO_TOKEN = Deno.env.get('TWILIO_AUTH_TOKEN') || '';
const TWILIO_FROM = Deno.env.get('TWILIO_FROM_NUMBER') || '';
const FORCE_SANDBOX = (Deno.env.get('MARKETING_SANDBOX') || '').toLowerCase() === 'true';
// Unsubscribe/one-click lands on the marketing-webhook edge fn (public; verifies an HMAC token).
const WEBHOOK_BASE = (Deno.env.get('MARKETING_WEBHOOK_BASE') || `${SUPABASE_URL}/functions/v1/marketing-webhook`).replace(/\/$/, '');
// Customer preference centre (slice 8) — per-channel opt-in management.
const PREF_BASE = (Deno.env.get('MARKETING_PREF_BASE') || `${SUPABASE_URL}/functions/v1/marketing-preferences`).replace(/\/$/, '');

// --- auth + org resolution (mirror marketing-admin) -------------------------
async function authForOrg(req: Request, body: any): Promise<{ ok: boolean; org_id: string | null }> {
  const token = (req.headers.get('Authorization') ?? '').replace('Bearer ', '').trim();
  if (!token) return { ok: false, org_id: null };
  if (token === SERVICE_ROLE) {
    // Internal/cron caller: org must be supplied (directly or via location).
    if (body?.org_id) return { ok: true, org_id: String(body.org_id) };
    if (body?.ops_location_id) return { ok: true, org_id: await orgForLocation(String(body.ops_location_id)) };
    return { ok: false, org_id: null };
  }
  // BO user JWT: must have access to ops_location_id.
  const ops = String(body?.ops_location_id ?? '').trim();
  if (!ops) return { ok: false, org_id: null };
  const { data: { user } } = await opsAdmin.auth.getUser(token);
  if (!user) return { ok: false, org_id: null };
  const { data: ul } = await opsAdmin.from('user_locations').select('location_id').eq('user_id', user.id).eq('location_id', ops).maybeSingle();
  let allowed = !!ul;
  if (!allowed) {
    const { data: prof } = await opsAdmin.from('user_profiles').select('role').eq('id', user.id).maybeSingle();
    allowed = prof?.role === 'super_admin';
  }
  if (!allowed) return { ok: false, org_id: null };
  return { ok: true, org_id: await orgForLocation(ops) };
}
async function orgForLocation(opsLocationId: string): Promise<string | null> {
  const { data } = await opsAdmin.from('locations').select('org_id').eq('id', opsLocationId).maybeSingle();
  return data?.org_id ?? null;
}

// --- consent + suppression --------------------------------------------------
function normAddr(channel: string, addr: string): string {
  return channel === 'email' ? addr.trim().toLowerCase() : addr.replace(/\s/g, '');
}

async function hasConsent(customerId: string | null, channel: string, org_id: string): Promise<boolean> {
  if (!customerId) return false;
  const { data: rows } = await opsAdmin.from('customer_consents')
    .select('purpose, consented, created_at').eq('customer_id', customerId).eq('channel', channel)
    .order('created_at', { ascending: false }).limit(20);
  if (rows && rows.length) {
    const marketing = rows.find((r: any) => /market/i.test(r.purpose || ''));
    const latest = marketing ?? rows[0];
    return !!latest.consented;
  }
  // No consent ledger row for this channel → fall back to the legacy opt-in flag.
  const { data: c } = await opsAdmin.from('customers').select('marketing_opt_in').eq('id', customerId).eq('org_id', org_id).maybeSingle();
  return !!c?.marketing_opt_in;
}

async function isSuppressed(org_id: string, channel: string, addr: string): Promise<boolean> {
  const { data } = await opsAdmin.from('marketing_suppressions')
    .select('id').eq('org_id', org_id).eq('channel', channel).eq('address', normAddr(channel, addr)).maybeSingle();
  return !!data;
}

// --- unsubscribe token (HMAC; verified by marketing-webhook) ----------------
async function unsubToken(customerId: string, channel: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(SERVICE_ROLE), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${customerId}:${channel}`));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}
async function unsubUrl(customerId: string | null, channel: string): Promise<string | null> {
  if (!customerId) return null;
  return `${WEBHOOK_BASE}?action=unsubscribe&c=${customerId}&ch=${channel}&t=${await unsubToken(customerId, channel)}`;
}
async function prefUrl(customerId: string | null): Promise<string | null> {
  if (!customerId) return null;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(SERVICE_ROLE), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`pref:${customerId}`));
  const t = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
  return `${PREF_BASE}?c=${customerId}&t=${t}`;
}

// --- provider adapters ------------------------------------------------------
async function withRetry<T>(fn: () => Promise<T>, tries = 2): Promise<T> {
  let last: unknown;
  for (let i = 0; i <= tries; i++) {
    try { return await fn(); } catch (e) { last = e; if (i < tries) await new Promise((r) => setTimeout(r, 300 * (i + 1))); }
  }
  throw last;
}

async function sendEmail(to: string, subject: string, html: string, text: string, listUnsub: string | null, sender: Sender): Promise<{ id?: string }> {
  if (EMAIL_PROVIDER === 'resend') {
    if (!RESEND_KEY) throw new Error('RESEND_API_KEY not set');
    const headers: Record<string, string> = listUnsub ? { 'List-Unsubscribe': `<${listUnsub}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } : {};
    const r = await withRetry(() => fetch('https://api.resend.com/emails', {
      method: 'POST', headers: { Authorization: `Bearer ${RESEND_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: sender.from, to, subject, html, text, headers, ...(sender.replyTo ? { reply_to: sender.replyTo } : {}) }),
    }));
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j?.message || `Resend HTTP ${r.status}`);
    return { id: j?.id };
  }
  if (EMAIL_PROVIDER === 'postmark') {
    if (!POSTMARK_TOKEN) throw new Error('POSTMARK_API_TOKEN not set');
    const Headers = listUnsub ? [{ Name: 'List-Unsubscribe', Value: `<${listUnsub}>` }, { Name: 'List-Unsubscribe-Post', Value: 'List-Unsubscribe=One-Click' }] : [];
    const r = await withRetry(() => fetch('https://api.postmarkapp.com/email', {
      method: 'POST', headers: { 'X-Postmark-Server-Token': POSTMARK_TOKEN, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ From: sender.from, To: to, Subject: subject, HtmlBody: html, TextBody: text, MessageStream: 'broadcast', Headers, ...(sender.replyTo ? { ReplyTo: sender.replyTo } : {}) }),
    }));
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j?.Message || `Postmark HTTP ${r.status}`);
    return { id: j?.MessageID };
  }
  if (EMAIL_PROVIDER === 'sendgrid') {
    if (!SENDGRID_KEY) throw new Error('SENDGRID_API_KEY not set');
    const headers: Record<string, string> = listUnsub ? { 'List-Unsubscribe': `<${listUnsub}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } : {};
    // SendGrid requires non-empty content, plain part before html.
    const content = [{ type: 'text/plain', value: text || (html ? html.replace(/<[^>]+>/g, ' ').trim() || ' ' : ' ') }];
    if (html) content.push({ type: 'text/html', value: html });
    const r = await withRetry(() => fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST', headers: { Authorization: `Bearer ${SENDGRID_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ personalizations: [{ to: [{ email: to }] }], from: { email: sender.email, ...(sender.name ? { name: sender.name } : {}) }, ...(sender.replyTo ? { reply_to: { email: (sender.replyTo.match(/<([^>]+)>/)?.[1] || sender.replyTo).trim() } } : {}), subject: subject || ' ', content, ...(Object.keys(headers).length ? { headers } : {}) }),
    }));
    if (!r.ok) { const t = await r.text().catch(() => ''); throw new Error(`SendGrid HTTP ${r.status} ${t.slice(0, 200)}`); }
    return { id: r.headers.get('x-message-id') || undefined };   // 202 Accepted, id in header
  }
  throw new Error(`email provider '${EMAIL_PROVIDER}' is log-only`); // caught → treated as sandbox upstream
}

async function sendSms(to: string, body: string): Promise<{ id?: string }> {
  if (!TWILIO_SID || !TWILIO_TOKEN || !TWILIO_FROM) throw new Error('twilio not configured');
  const form = new URLSearchParams({ To: to, From: TWILIO_FROM, Body: body.slice(0, 1600) });
  const r = await withRetry(() => fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`, {
    method: 'POST', headers: { Authorization: 'Basic ' + btoa(`${TWILIO_SID}:${TWILIO_TOKEN}`), 'content-type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  }));
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.message || `Twilio HTTP ${r.status}`);
  return { id: j?.sid };
}

// --- main -------------------------------------------------------------------
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);
  let body: any; try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }
  const action = String(body?.action ?? 'send').trim();
  const channel = String(body?.channel ?? '').trim();
  if (!['email', 'sms'].includes(channel)) return json({ error: "channel must be 'email' or 'sms'" }, 400);

  // ---- preview: render only, no auth-sensitive data, no send ----
  if (action === 'preview') {
    const ctx = buildMergeContext(body?.to || {}, body?.merge || {});
    if (channel === 'email') {
      return json({ ok: true, subject: renderMergeTags(body?.subject || '', ctx), html: renderMergeTags(body?.html || '', ctx), text: renderMergeTags(body?.text || '', ctx) });
    }
    return json({ ok: true, sms_body: renderMergeTags(body?.sms_body || body?.text || '', ctx) });
  }
  if (action !== 'send') return json({ error: 'unknown action' }, 400);

  const auth = await authForOrg(req, body);
  if (!auth.ok) return json({ error: 'unauthorised' }, 403);
  const org_id = auth.org_id;
  if (!org_id) return json({ error: 'org could not be resolved' }, 400);

  // ---- resolve recipient ----
  const to = body?.to || {};
  let customer: any = null;
  if (to.customer_id) {
    const { data } = await opsAdmin.from('customers').select('id, org_id, first_name, last_name, name, email, phone, marketing_opt_in').eq('id', String(to.customer_id)).eq('org_id', org_id).maybeSingle();
    customer = data;
    if (!customer) return json({ error: 'customer not found in this org' }, 404);
  }
  const customerId: string | null = customer?.id ?? null;
  const address = channel === 'email'
    ? String(to.email || customer?.email || '').trim()
    : String(to.phone || customer?.phone || '').replace(/\s/g, '');

  const bypassConsent = body?.bypass_consent === true; // transactional override; never set for marketing blasts
  const idempotencyKey = body?.idempotency_key ? String(body.idempotency_key) : null;

  // ---- idempotency: never double-send ----
  if (idempotencyKey) {
    const { data: existing } = await opsAdmin.from('marketing_messages').select('id, status, provider_message_id').eq('idempotency_key', idempotencyKey).maybeSingle();
    if (existing) return json({ ok: true, deduped: true, message_id: existing.id, status: existing.status });
  }

  // common base row
  const base: Record<string, unknown> = {
    org_id, customer_id: customerId, channel, to_address: address || '(none)',
    campaign_id: body?.campaign_id || null, workflow_id: body?.workflow_id || null, template_id: body?.template_id || null,
    promo_code: body?.promo_code || null, idempotency_key: idempotencyKey,
  };
  const logRow = async (extra: Record<string, unknown>) => {
    const { data, error } = await opsAdmin.from('marketing_messages').insert({ ...base, ...extra }).select('id').maybeSingle();
    if (error && idempotencyKey && /duplicate key/i.test(error.message)) {
      const { data: ex } = await opsAdmin.from('marketing_messages').select('id, status').eq('idempotency_key', idempotencyKey).maybeSingle();
      return { id: ex?.id, deduped: true, status: ex?.status };
    }
    return { id: data?.id };
  };

  // ---- gate: reachability ----
  if (!address) {
    const r = await logRow({ status: 'unreachable', error: `no ${channel} address` });
    return json({ ok: false, status: 'unreachable', message_id: r.id });
  }
  // ---- gate: suppression (hard block, always) ----
  if (await isSuppressed(org_id, channel, address)) {
    const r = await logRow({ status: 'suppressed', subject: body?.subject || null });
    return json({ ok: false, status: 'suppressed', message_id: r.id });
  }
  // ---- gate: consent (skip only for explicit transactional bypass) ----
  if (!bypassConsent && !(await hasConsent(customerId, channel, org_id))) {
    const r = await logRow({ status: 'no_consent', subject: body?.subject || null });
    return json({ ok: false, status: 'no_consent', message_id: r.id });
  }

  // ---- render content ----
  const link = await unsubUrl(customerId, channel);
  const prefs = channel === 'email' ? await prefUrl(customerId) : null;
  const ctx = buildMergeContext(customer || to, { ...(body?.merge || {}), unsubscribe_url: link || '', preferences_url: prefs || '' });
  const subject = renderMergeTags(body?.subject || '', ctx);
  let html = renderMergeTags(body?.html || '', ctx);
  let text = renderMergeTags(body?.text || '', ctx);
  let smsBody = renderMergeTags(body?.sms_body || body?.text || '', ctx);

  // ---- compliance footers ----
  if (channel === 'email' && link) {
    const prefsLink = prefs ? ` · <a href="${prefs}">Manage preferences</a>` : '';
    html += `\n<hr style="border:none;border-top:1px solid #e5e5e5;margin:24px 0 12px"><p style="font-size:12px;color:#888">You're receiving this because you opted in to marketing. <a href="${link}">Unsubscribe</a>${prefsLink}.</p>`;
    if (text) text += `\n\n—\nUnsubscribe: ${link}${prefs ? `\nManage preferences: ${prefs}` : ''}`;
  }
  if (channel === 'sms' && smsBody && !/\bSTOP\b/i.test(smsBody)) smsBody += ' Reply STOP to opt out.';

  // ---- sandbox? (forced, or no real provider configured) ----
  const emailLive = EMAIL_PROVIDER === 'resend' ? !!RESEND_KEY : EMAIL_PROVIDER === 'postmark' ? !!POSTMARK_TOKEN : EMAIL_PROVIDER === 'sendgrid' ? !!SENDGRID_KEY : false;
  const smsLive = !!(TWILIO_SID && TWILIO_TOKEN && TWILIO_FROM);
  const live = channel === 'email' ? emailLive : smsLive;
  const sandbox = FORCE_SANDBOX || body?.sandbox === true || !live;

  const preview = (channel === 'email' ? (text || html.replace(/<[^>]+>/g, ' ')) : smsBody).replace(/\s+/g, ' ').trim().slice(0, 280);

  if (sandbox) {
    const r = await logRow({ status: 'sandbox', subject: subject || null, preview, provider: 'sandbox' });
    return json({ ok: true, status: 'sandbox', message_id: r.id, sent: false, would_send: { channel, to: address, subject } });
  }

  // ---- live send ----
  try {
    const sender = await resolveSenderForOrg(opsAdmin, org_id, EMAIL_FROM);   // per-org branded From, else platform default
    const res = channel === 'email'
      ? await sendEmail(address, subject || '(no subject)', html, text, link, sender)
      : await sendSms(address, smsBody);
    const r = await logRow({ status: 'sent', subject: subject || null, preview, provider: channel === 'email' ? EMAIL_PROVIDER : 'twilio', provider_message_id: res.id || null, sent_at: new Date().toISOString() });
    return json({ ok: true, status: 'sent', message_id: r.id, provider_message_id: res.id || null });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const r = await logRow({ status: 'failed', subject: subject || null, preview, provider: channel === 'email' ? EMAIL_PROVIDER : 'twilio', error: msg.slice(0, 500) });
    return json({ ok: false, status: 'failed', message_id: r.id, error: msg }, 502);
  }
});
