// supabase/functions/marketing-webhook/index.ts
//
// Slice 2 — inbound events for the marketing sender. Public (verify_jwt=false) because providers and
// recipients POST/GET here directly. Two responsibilities:
//
//   (1) Unsubscribe / one-click List-Unsubscribe  — GET or POST ?action=unsubscribe&c=&ch=&t=
//       (t is an HMAC over "<customer_id>:<channel>" minted by marketing-send → no enumeration).
//       Adds a marketing_suppressions row + writes a withdrawal to the customer_consents ledger.
//
//   (2) Provider event webhooks  — POST ?provider=twilio|resend|postmark[&key=<secret>]
//       Updates marketing_messages status (delivered/opened/clicked/bounced/complained/failed) by
//       provider_message_id, and on bounce / spam-complaint / SMS "STOP" adds a suppression.
//
// Provider POSTs are gated by MARKETING_WEBHOOK_SECRET when that env is set (operator appends
// ?key=<secret> to the webhook URL). Proper per-provider signature verification can harden in slice 8.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const WEBHOOK_SECRET = Deno.env.get('MARKETING_WEBHOOK_SECRET') || '';
const opsAdmin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { autoRefreshToken: false, persistSession: false } });

const html = (b: string, s = 200) => new Response(b, { status: s, headers: { ...cors, 'Content-Type': 'text/html; charset=utf-8' } });
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

async function tokenFor(customerId: string, channel: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(SERVICE_ROLE), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${customerId}:${channel}`));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

function normAddr(channel: string, addr: string): string {
  return channel === 'email' ? addr.trim().toLowerCase() : addr.replace(/\s/g, '');
}

// Add a suppression (idempotent on the unique index) + best-effort consent withdrawal ledger row.
async function suppress(org_id: string, channel: string, address: string, reason: string, customer_id?: string | null, source = 'webhook') {
  const addr = normAddr(channel, address);
  await opsAdmin.from('marketing_suppressions').upsert(
    { org_id, channel, address: addr, reason, customer_id: customer_id || null, source },
    { onConflict: 'org_id,channel,address', ignoreDuplicates: true },
  );
  if (customer_id) {
    try {
      await opsAdmin.from('customer_consents').insert({ customer_id, org_id, channel, purpose: 'marketing', consented: false, source, method: reason });
    } catch (_e) { /* consent ledger is best-effort here */ }
  }
}

// Move marketing_messages status forward (engagement) or override (terminal failures).
const RANK: Record<string, number> = { queued: 0, sandbox: 0, sent: 1, delivered: 2, opened: 3, clicked: 4 };
async function setMessageStatus(providerMessageId: string, status: string, tsField?: string) {
  if (!providerMessageId) return null;
  const { data: row } = await opsAdmin.from('marketing_messages').select('id, org_id, channel, to_address, customer_id, status').eq('provider_message_id', providerMessageId).maybeSingle();
  if (!row) return null;
  const terminal = ['bounced', 'complained', 'failed'].includes(status);
  const upd: Record<string, unknown> = {};
  if (terminal || (RANK[status] ?? 99) > (RANK[row.status] ?? -1)) upd.status = status;
  if (tsField) upd[tsField] = new Date().toISOString();
  if (Object.keys(upd).length) await opsAdmin.from('marketing_messages').update(upd).eq('id', row.id);
  return row;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const url = new URL(req.url);
  const action = url.searchParams.get('action') || '';
  const provider = (url.searchParams.get('provider') || '').toLowerCase();

  // ---------- (1) UNSUBSCRIBE (GET human-click + POST one-click) ----------
  if (action === 'unsubscribe') {
    const c = url.searchParams.get('c') || '';
    const ch = (url.searchParams.get('ch') || 'email').toLowerCase();
    const t = url.searchParams.get('t') || '';
    if (!c || !['email', 'sms'].includes(ch) || !t) return html('<h2>Invalid unsubscribe link.</h2>', 400);
    if (t !== (await tokenFor(c, ch))) return html('<h2>This unsubscribe link is invalid or expired.</h2>', 403);
    const { data: cust } = await opsAdmin.from('customers').select('id, org_id, email, phone').eq('id', c).maybeSingle();
    if (!cust?.org_id) return html('<h2>Already unsubscribed.</h2>');
    const addr = ch === 'email' ? cust.email : cust.phone;
    if (addr) await suppress(cust.org_id, ch, addr, 'unsubscribe', cust.id, 'one_click');
    // POST one-click (RFC 8058) wants a bare 200; GET (human) gets a confirmation page.
    if (req.method === 'POST') return json({ ok: true });
    return html('<div style="font-family:system-ui;max-width:420px;margin:80px auto;text-align:center"><h2>You\'re unsubscribed</h2><p style="color:#666">You will no longer receive marketing messages on this channel. You can opt back in any time from your account.</p></div>');
  }

  // ---------- (2) PROVIDER EVENT WEBHOOKS (POST) ----------
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);
  if (WEBHOOK_SECRET && (url.searchParams.get('key') || '') !== WEBHOOK_SECRET) return json({ error: 'forbidden' }, 403);

  // Twilio posts form-encoded; Resend/Postmark post JSON.
  let payload: any = {};
  const ctype = req.headers.get('content-type') || '';
  try {
    if (ctype.includes('application/json')) payload = await req.json();
    else { const f = await req.formData(); for (const [k, v] of f.entries()) payload[k] = v; }
  } catch { /* leave empty */ }

  // --- Twilio: inbound SMS (STOP) + status callbacks ---
  if (provider === 'twilio') {
    const body = String(payload.Body || '').trim();
    const from = String(payload.From || '');
    const msgStatus = String(payload.MessageStatus || payload.SmsStatus || '');
    const sid = String(payload.MessageSid || payload.SmsSid || '');
    // Inbound STOP / unsubscribe keyword
    if (body && /^(stop|stopall|unsubscribe|cancel|end|quit)$/i.test(body)) {
      const { data: msgs } = await opsAdmin.from('marketing_messages').select('org_id, customer_id').eq('channel', 'sms').eq('to_address', normAddr('sms', from)).order('created_at', { ascending: false }).limit(50);
      const orgs = new Map<string, string | null>();
      for (const m of msgs ?? []) if (!orgs.has(m.org_id)) orgs.set(m.org_id, m.customer_id);
      for (const [org, cust] of orgs) await suppress(org, 'sms', from, 'stop', cust, 'sms_reply');
      // empty TwiML so Twilio doesn't auto-reply
      return new Response('<?xml version="1.0" encoding="UTF-8"?><Response/>', { status: 200, headers: { ...cors, 'Content-Type': 'text/xml' } });
    }
    // Delivery status callback
    if (sid && msgStatus) {
      const map: Record<string, string> = { delivered: 'delivered', undelivered: 'failed', failed: 'failed', sent: 'sent' };
      const mapped = map[msgStatus.toLowerCase()];
      if (mapped) {
        const row = await setMessageStatus(sid, mapped, mapped === 'delivered' ? 'delivered_at' : undefined);
        if (mapped === 'failed' && row?.org_id && row.to_address) await suppress(row.org_id, 'sms', row.to_address, 'bounce', row.customer_id, 'twilio_failed').catch(() => {});
      }
    }
    return json({ ok: true });
  }

  // --- Resend events ---
  if (provider === 'resend') {
    const type = String(payload.type || '');
    const id = String(payload?.data?.email_id || payload?.data?.id || '');
    const m: Record<string, [string, string?]> = {
      'email.delivered': ['delivered', 'delivered_at'],
      'email.opened': ['opened', 'opened_at'],
      'email.clicked': ['clicked', 'clicked_at'],
      'email.bounced': ['bounced'],
      'email.complained': ['complained'],
    };
    const hit = m[type];
    if (hit) {
      const row = await setMessageStatus(id, hit[0], hit[1]);
      if ((hit[0] === 'bounced' || hit[0] === 'complained') && row?.org_id && row.to_address) {
        await suppress(row.org_id, 'email', row.to_address, hit[0] === 'bounced' ? 'bounce' : 'complaint', row.customer_id, 'resend');
      }
    }
    return json({ ok: true });
  }

  // --- Postmark events ---
  if (provider === 'postmark') {
    const rt = String(payload.RecordType || '');
    const id = String(payload.MessageID || '');
    const m: Record<string, [string, string?]> = {
      Delivery: ['delivered', 'delivered_at'],
      Open: ['opened', 'opened_at'],
      Click: ['clicked', 'clicked_at'],
      Bounce: ['bounced'],
      SpamComplaint: ['complained'],
    };
    const hit = m[rt];
    if (hit) {
      const row = await setMessageStatus(id, hit[0], hit[1]);
      if ((hit[0] === 'bounced' || hit[0] === 'complained') && row?.org_id && row.to_address) {
        await suppress(row.org_id, 'email', row.to_address, hit[0] === 'bounced' ? 'bounce' : 'complaint', row.customer_id, 'postmark');
      }
    }
    return json({ ok: true });
  }

  return json({ error: 'unknown provider' }, 400);
});
