// supabase/functions/_shared/marketingDeliver.ts (29 Oct 2026, v5.11.117)
//
// The campaign engine's batch sender. The same gates and records as marketing-send's single
// `send` (consent, suppression, reachability, merge tags, compliance footer, one marketing_messages
// row per recipient keyed by idempotency key), but IN PROCESS, for up to 100 recipients at a time,
// with ONE Resend batch request per batch. The engine used to call marketing-send over HTTP once per
// recipient, which the gateway rate limits (see _shared/campaignBatch.js).
//
// marketing-send keeps its single-recipient path for "send test" and workflows; a later tidy can
// make that path call deliverBatch with one recipient.
import { renderMergeTags, buildMergeContext } from './marketing-merge.ts';
import { resolveSenderForOrg, type Sender } from './sending-domain.ts';
import { resendBatchItems, SMS_GAP_MS } from './campaignBatch.js';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const EMAIL_PROVIDER = (Deno.env.get('RECEIPT_EMAIL_PROVIDER') || 'log').toLowerCase();
const EMAIL_FROM = Deno.env.get('MARKETING_EMAIL_FROM') || Deno.env.get('RECEIPT_EMAIL_FROM') || 'hello@posup.co.uk';
const RESEND_KEY = Deno.env.get('RESEND_API_KEY') || '';
const TWILIO_SID = Deno.env.get('TWILIO_ACCOUNT_SID') || '';
const TWILIO_TOKEN = Deno.env.get('TWILIO_AUTH_TOKEN') || '';
const TWILIO_FROM = Deno.env.get('TWILIO_FROM_NUMBER') || '';
const FORCE_SANDBOX = (Deno.env.get('MARKETING_SANDBOX') || '').toLowerCase() === 'true';
const WEBHOOK_BASE = (Deno.env.get('MARKETING_WEBHOOK_BASE') || `${SUPABASE_URL}/functions/v1/marketing-webhook`).replace(/\/$/, '');
const PREF_BASE = (Deno.env.get('MARKETING_PREF_BASE') || `${SUPABASE_URL}/functions/v1/marketing-preferences`).replace(/\/$/, '');

export type DeliverRecipient = { customer_id: string; idempotency_key: string; merge?: Record<string, unknown>; promo_code?: string | null; subject?: string | null };
export type DeliverResult = { customer_id: string; ok: boolean; status: string; message_id?: string | null; provider_message_id?: string | null; error?: string | null; deduped?: boolean };
export type DeliverParams = {
  org_id: string; channel: 'email' | 'sms'; campaign_id: string;
  subject?: string | null; html?: string | null; text?: string | null; sms_body?: string | null;
  recipients: DeliverRecipient[]; sandbox?: boolean;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const normAddr = (channel: string, addr: string) => channel === 'email' ? addr.trim().toLowerCase() : addr.replace(/\s/g, '');

async function hmacHex(message: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(SERVICE_ROLE), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}
const unsubUrl = async (customerId: string, channel: string) => `${WEBHOOK_BASE}?action=unsubscribe&c=${customerId}&ch=${channel}&t=${await hmacHex(`${customerId}:${channel}`)}`;
const prefUrl = async (customerId: string) => `${PREF_BASE}?c=${customerId}&t=${await hmacHex(`pref:${customerId}`)}`;

async function withRetry<T>(fn: () => Promise<T>, tries = 2): Promise<T> {
  let last: unknown;
  for (let i = 0; i <= tries; i++) {
    try { return await fn(); } catch (e) { last = e; if (i < tries) await sleep(400 * (i + 1)); }
  }
  throw last;
}

async function resendBatch(mails: { to: string; subject: string; html: string; text: string; listUnsub: string | null }[], sender: Sender): Promise<{ ids: (string | null)[] }> {
  if (!RESEND_KEY) throw new Error('RESEND_API_KEY not set');
  const items = resendBatchItems(mails, sender);
  const r = await withRetry(async () => {
    const res = await fetch('https://api.resend.com/emails/batch', {
      method: 'POST', headers: { Authorization: `Bearer ${RESEND_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify(items),
    });
    // 429 (rate limit) and 5xx are worth a retry; anything else is final for this batch.
    if (res.status === 429 || res.status >= 500) throw new Error(`Resend HTTP ${res.status}`);
    return res;
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.message || `Resend HTTP ${r.status}`);
  const data = Array.isArray(j?.data) ? j.data : [];
  return { ids: items.map((_, i) => data[i]?.id ?? null) };
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

export async function deliverBatch(sb: any, p: DeliverParams): Promise<DeliverResult[]> {
  const recips = (p.recipients || []).filter((r) => r && r.customer_id);
  if (!recips.length) return [];
  const channel = p.channel;
  const ids = [...new Set(recips.map((r) => r.customer_id))];

  // One read each: the customers, the messages already recorded for these keys, the suppressions,
  // the consent ledger. The single path did these per recipient.
  const [{ data: custs }, { data: already }, { data: consents }] = await Promise.all([
    sb.from('customers').select('id, org_id, first_name, last_name, name, email, phone, marketing_opt_in').eq('org_id', p.org_id).in('id', ids),
    sb.from('marketing_messages').select('id, status, provider_message_id, idempotency_key').in('idempotency_key', recips.map((r) => r.idempotency_key)),
    sb.from('customer_consents').select('customer_id, purpose, consented, created_at').in('customer_id', ids).in('channel', [channel, 'both']).order('created_at', { ascending: false }).limit(5000),
  ]);
  const cmap = new Map<string, any>((custs ?? []).map((c: any) => [c.id, c]));
  const dedupe = new Map<string, any>((already ?? []).map((m: any) => [m.idempotency_key, m]));
  const consentOf = new Map<string, boolean>();
  for (const row of consents ?? []) {
    if (consentOf.has(row.customer_id)) continue;
    // rows arrive newest first; the newest MARKETING row wins, else the newest row (as marketing-send)
    const mine = (consents ?? []).filter((r: any) => r.customer_id === row.customer_id);
    const marketing = mine.find((r: any) => /market/i.test(r.purpose || ''));
    consentOf.set(row.customer_id, !!(marketing ?? mine[0]).consented);
  }
  const addrOf = (r: DeliverRecipient) => {
    const c = cmap.get(r.customer_id);
    return channel === 'email' ? String(c?.email || '').trim() : String(c?.phone || '').replace(/\s/g, '');
  };
  const addrs = [...new Set(recips.map(addrOf).filter(Boolean).map((a) => normAddr(channel, a)))];
  const { data: sup } = addrs.length
    ? await sb.from('marketing_suppressions').select('address').eq('org_id', p.org_id).eq('channel', channel).in('address', addrs)
    : { data: [] };
  const suppressed = new Set((sup ?? []).map((s: any) => s.address));

  const emailLive = EMAIL_PROVIDER === 'resend' && !!RESEND_KEY;
  const smsLive = !!(TWILIO_SID && TWILIO_TOKEN && TWILIO_FROM);
  const live = channel === 'email' ? emailLive : smsLive;
  const sandbox = FORCE_SANDBOX || p.sandbox === true || !live;

  type Pending = { r: DeliverRecipient; address: string; subject: string; html: string; text: string; sms: string; link: string | null; preview: string };
  const results: DeliverResult[] = [];
  const rows: Record<string, unknown>[] = [];   // marketing_messages rows to insert, one per recipient
  const toSend: Pending[] = [];
  const baseRow = (r: DeliverRecipient, address: string) => ({
    org_id: p.org_id, customer_id: r.customer_id, channel, to_address: address || '(none)',
    campaign_id: p.campaign_id, promo_code: r.promo_code || null, idempotency_key: r.idempotency_key,
  });

  for (const r of recips) {
    const ex = dedupe.get(r.idempotency_key);
    if (ex) { results.push({ customer_id: r.customer_id, ok: true, status: ex.status, message_id: ex.id, provider_message_id: ex.provider_message_id, deduped: true }); continue; }
    const cust = cmap.get(r.customer_id);
    if (!cust) { results.push({ customer_id: r.customer_id, ok: false, status: 'unreachable', error: 'customer not found in this org' }); continue; }
    const address = addrOf(r);
    if (!address) { rows.push({ ...baseRow(r, address), status: 'unreachable', error: `no ${channel} address` }); results.push({ customer_id: r.customer_id, ok: false, status: 'unreachable' }); continue; }
    if (suppressed.has(normAddr(channel, address))) { rows.push({ ...baseRow(r, address), status: 'suppressed', subject: p.subject || null }); results.push({ customer_id: r.customer_id, ok: false, status: 'suppressed' }); continue; }
    const consent = consentOf.has(r.customer_id) ? consentOf.get(r.customer_id) : !!cust.marketing_opt_in;
    if (!consent) { rows.push({ ...baseRow(r, address), status: 'no_consent', subject: p.subject || null }); results.push({ customer_id: r.customer_id, ok: false, status: 'no_consent' }); continue; }

    const link = await unsubUrl(r.customer_id, channel);
    const prefs = channel === 'email' ? await prefUrl(r.customer_id) : null;
    const ctx = buildMergeContext(cust, { ...((r.merge || {}) as Record<string, string>), unsubscribe_url: link || '', preferences_url: prefs || '' });
    const subject = renderMergeTags(r.subject || p.subject || '', ctx);
    let html = renderMergeTags(p.html || '', ctx);
    let text = renderMergeTags(p.text || '', ctx);
    let sms = renderMergeTags(p.sms_body || p.text || '', ctx);
    if (channel === 'email' && link) {
      const prefsLink = prefs ? ` · <a href="${prefs}">Manage preferences</a>` : '';
      html += `\n<hr style="border:none;border-top:1px solid #e5e5e5;margin:24px 0 12px"><p style="font-size:12px;color:#888">You're receiving this because you opted in to marketing. <a href="${link}">Unsubscribe</a>${prefsLink}</p>`;
      if (text) text += `\n\n—\nUnsubscribe: ${link}${prefs ? `\nManage preferences: ${prefs}` : ''}`;
    }
    if (channel === 'sms' && sms && !/\bSTOP\b/i.test(sms)) sms += ' Reply STOP to opt out.';
    const preview = (channel === 'email' ? (text || html.replace(/<[^>]+>/g, ' ')) : sms).replace(/\s+/g, ' ').trim().slice(0, 280);
    toSend.push({ r, address, subject, html, text, sms, link, preview });
  }

  if (sandbox) {
    for (const s of toSend) { rows.push({ ...baseRow(s.r, s.address), status: 'sandbox', subject: s.subject || null, preview: s.preview, provider: 'sandbox' }); results.push({ customer_id: s.r.customer_id, ok: true, status: 'sandbox' }); }
  } else if (channel === 'email') {
    const sender = await resolveSenderForOrg(sb, p.org_id, EMAIL_FROM);
    let ids: (string | null)[] = [];
    let batchError: string | null = null;
    if (toSend.length) {
      try { ids = (await resendBatch(toSend.map((s) => ({ to: s.address, subject: s.subject || '(no subject)', html: s.html, text: s.text, listUnsub: s.link })), sender)).ids; }
      catch (e) { batchError = (e instanceof Error ? e.message : String(e)).slice(0, 500); }
    }
    toSend.forEach((s, i) => {
      if (batchError) { rows.push({ ...baseRow(s.r, s.address), status: 'failed', subject: s.subject || null, preview: s.preview, provider: EMAIL_PROVIDER, error: batchError }); results.push({ customer_id: s.r.customer_id, ok: false, status: 'failed', error: batchError }); }
      else { rows.push({ ...baseRow(s.r, s.address), status: 'sent', subject: s.subject || null, preview: s.preview, provider: EMAIL_PROVIDER, provider_message_id: ids[i] || null, sent_at: new Date().toISOString() }); results.push({ customer_id: s.r.customer_id, ok: true, status: 'sent', provider_message_id: ids[i] || null }); }
    });
  } else {
    for (const s of toSend) {
      try {
        const res = await sendSms(s.address, s.sms);
        rows.push({ ...baseRow(s.r, s.address), status: 'sent', subject: null, preview: s.preview, provider: 'twilio', provider_message_id: res.id || null, sent_at: new Date().toISOString() });
        results.push({ customer_id: s.r.customer_id, ok: true, status: 'sent', provider_message_id: res.id || null });
      } catch (e) {
        const msg = (e instanceof Error ? e.message : String(e)).slice(0, 500);
        rows.push({ ...baseRow(s.r, s.address), status: 'failed', preview: s.preview, provider: 'twilio', error: msg });
        results.push({ customer_id: s.r.customer_id, ok: false, status: 'failed', error: msg });
      }
      await sleep(SMS_GAP_MS);
    }
  }

  // One insert for the batch's records. A duplicate key (a parallel run recorded the same key first)
  // falls back to row by row so one clash cannot lose the other 99 records.
  if (rows.length) {
    const { data: ins, error } = await sb.from('marketing_messages').insert(rows).select('id, customer_id');
    const idOf = new Map<string, string>();
    if (!error) for (const m of ins ?? []) idOf.set(m.customer_id, m.id);
    else {
      for (const row of rows) {
        try {
          const { data: one } = await sb.from('marketing_messages').insert(row).select('id, customer_id').maybeSingle();
          if (one) idOf.set(one.customer_id, one.id);
        } catch { /* recorded by a parallel run; the send itself is not repeated */ }
      }
    }
    for (const r of results) if (!r.message_id && idOf.has(r.customer_id)) r.message_id = idOf.get(r.customer_id);
  }
  return results;
}
