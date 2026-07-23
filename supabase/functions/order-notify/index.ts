// order-notify — server-side order confirmation + order-ready messages (email + SMS).
//
// THE wiring for the Back Office → Messages "Orders" section. Called by a DB trigger on
// order_queue (see migration 20260803b_order_notify.sql):
//   INSERT                    → { ref, event: 'confirmed' }  (order placed — any channel)
//   UPDATE status → 'ready'   → { ref, event: 'ready' }      (staff marked ready in OrdersHub)
//
// Because it fires from the DATABASE, every order channel is covered with no client changes:
// online, kiosk, QR, POS phone orders — anything that writes order_queue. Exclusions:
//   - source 'hubrise' (3rd-party channels handle their own customer messaging)
//   - source 'catering' for 'confirmed' only (catering sends its own branded confirmation email)
//   - 'ready' is skipped for delivery orders (they get courier tracking SMS instead)
//
// Honors the Messages editor: a custom template's enabled=false SKIPS that channel entirely;
// otherwise the operator's custom wording (or the default) renders via resolveAndRender.
//
// Idempotent: claims notify_confirmed_at / notify_ready_at on the row BEFORE sending
// (claim-before-send, same pattern as kitchen_routed_at) so retries/races never double-text.
//
// No caller auth: the payload carries only a ref; the function acts ONLY on data it reads
// itself with the service role, and the claim columns cap sends at one per event per order.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { resolveAndRender, wrapInEmailHtml } from '../_shared/template-resolver.ts';
import { resolveSenderFrom, type Sender } from '../_shared/sending-domain.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const PLATFORM_URL = Deno.env.get('PLATFORM_SUPABASE_URL') ?? '';
const PLATFORM_KEY = Deno.env.get('PLATFORM_SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('PLATFORM_SERVICE_KEY') ?? '';

const EMAIL_PROVIDER = (Deno.env.get('RECEIPT_EMAIL_PROVIDER') || 'log').toLowerCase();
const EMAIL_FROM = Deno.env.get('RECEIPT_EMAIL_FROM') || 'hello@posup.co.uk';
const RESEND_KEY = Deno.env.get('RESEND_API_KEY') ?? '';
const POSTMARK_KEY = Deno.env.get('POSTMARK_API_TOKEN') ?? '';

const opsAdmin = createClient(SUPABASE_URL, SERVICE_ROLE);
const platformAdmin = createClient(PLATFORM_URL, PLATFORM_KEY);

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

function normalisePhone(raw: string): string | null {
  if (!raw) return null;
  const digits = String(raw).replace(/[^\d+]/g, '');
  if (!digits) return null;
  if (digits.startsWith('+')) return digits;
  if (digits.startsWith('07') && digits.length === 11) return '+44' + digits.slice(1);
  if (digits.startsWith('44')) return '+' + digits;
  return digits.length >= 10 ? '+' + digits : null;
}

function moneyFor(currency: string | null | undefined, amount: number): string {
  const sym = currency === 'USD' ? '$' : currency === 'EUR' ? '€' : '£';
  return `${sym}${Number(amount || 0).toFixed(2)}`;
}

// "2x Margherita Pizza\n1x Caesar Salad" from the order_queue items jsonb (shape-defensive).
function itemsText(items: unknown): string {
  if (!Array.isArray(items)) return '';
  return items
    .map((it: Record<string, unknown>) => {
      const qty = Number(it?.qty ?? it?.quantity ?? 1) || 1;
      const name = String(it?.name ?? it?.title ?? '').trim();
      return name ? `${qty}x ${name}` : '';
    })
    .filter(Boolean)
    .join('\n');
}

// SMS via the send-sms fn (service-role) so every send lands in the sms_messages audit table.
async function sendSmsViaFn(to: string, message: string, locationId: string, type: string): Promise<boolean> {
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/send-sms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SERVICE_ROLE}` },
      body: JSON.stringify({ to, message, location_id: locationId, type }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function sendEmail(to: string, subject: string, html: string, sender: Sender): Promise<boolean> {
  try {
    if (EMAIL_PROVIDER === 'resend' && RESEND_KEY) {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: sender.from, to: [to], subject, html, ...(sender.replyTo ? { reply_to: sender.replyTo } : {}) }),
      });
      return res.ok;
    }
    if (EMAIL_PROVIDER === 'postmark' && POSTMARK_KEY) {
      const res = await fetch('https://api.postmarkapp.com/email', {
        method: 'POST',
        headers: { 'X-Postmark-Server-Token': POSTMARK_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ From: sender.from, To: to, Subject: subject, HtmlBody: html, ...(sender.replyTo ? { ReplyTo: sender.replyTo } : {}) }),
      });
      return res.ok;
    }
    return false; // 'log' provider — no real send
  } catch {
    return false;
  }
}

// Is this channel explicitly disabled in the Messages editor? (resolveAndRender falls back to
// the DEFAULT when a custom row is disabled — but the toggle means "do not send at all".)
async function channelDisabled(companyId: string, messageType: string, channel: string): Promise<boolean> {
  try {
    const { data } = await platformAdmin
      .from('message_templates')
      .select('enabled')
      .eq('company_id', companyId)
      .eq('message_type', messageType)
      .eq('channel', channel)
      .maybeSingle();
    return data ? data.enabled === false : false;
  } catch {
    return false;
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }

  const ref = String(body.ref || '').trim();
  const event = String(body.event || '').trim(); // 'confirmed' | 'ready'
  if (!ref || (event !== 'confirmed' && event !== 'ready')) return json({ error: 'ref + event required' }, 400);

  // Load the order (service role — the ref is the only caller input we act on).
  const { data: order } = await opsAdmin.from('order_queue').select('*').eq('ref', ref).maybeSingle();
  if (!order) return json({ ok: true, skipped: 'order gone' });

  const source = String(order.source || '');
  if (source === 'hubrise') return json({ ok: true, skipped: '3rd-party channel' });
  if (event === 'confirmed' && source === 'catering') return json({ ok: true, skipped: 'catering has its own confirmation' });
  if (event === 'ready' && String(order.type || '') === 'delivery') return json({ ok: true, skipped: 'delivery uses courier tracking' });

  const customer = (order.customer || {}) as Record<string, unknown>;
  const phone = normalisePhone(String(customer.phone || ''));
  const email = String(customer.email || '').trim() || null;
  if (!phone && !email) return json({ ok: true, skipped: 'no contact details' });

  // Claim BEFORE sending — one notification per event per order, ever.
  const claimCol = event === 'confirmed' ? 'notify_confirmed_at' : 'notify_ready_at';
  const { data: claimed } = await opsAdmin
    .from('order_queue')
    .update({ [claimCol]: new Date().toISOString() })
    .eq('ref', ref)
    .is(claimCol, null)
    .select('ref');
  if (!claimed || claimed.length === 0) return json({ ok: true, skipped: 'already notified' });

  // Venue + company for branding/templates.
  const locationId = String(order.location_id || '');
  let venueName = 'our venue';
  let currency: string | null = null;
  try {
    const { data: loc } = await opsAdmin.from('locations').select('name, currency').eq('id', locationId).maybeSingle();
    if (loc?.name) venueName = loc.name;
    currency = (loc as Record<string, unknown>)?.currency as string | null;
  } catch { /* name is best-effort */ }
  let companyId: string | null = null;
  try {
    const { data: pl } = await platformAdmin
      .from('locations')
      .select('company_id')
      .or(`ops_location_id.eq.${locationId},id.eq.${locationId}`)
      .maybeSingle();
    if (pl?.company_id) companyId = String(pl.company_id);
  } catch { /* templates fall back to defaults */ }

  const firstName = String(customer.name || '').trim().split(' ')[0] || 'there';
  const mergeData: Record<string, string> = {
    customer_name: firstName,
    order_number: ref,
    venue_name: venueName,
    order_total: moneyFor(currency, Number(order.total || 0)),
    estimated_time: order.is_asap === false && order.collection_time ? String(order.collection_time) : '15-20',
    order_items: itemsText(order.items),
    collection_point: 'the counter',
  };

  const messageType = event === 'confirmed' ? 'order_confirmation' : 'order_ready';
  const result: Record<string, boolean> = {};

  // ── SMS ──
  if (phone) {
    const disabled = companyId ? await channelDisabled(companyId, messageType, 'sms') : false;
    if (!disabled) {
      let smsBody = '';
      if (companyId) {
        const rendered = await resolveAndRender(companyId, messageType, 'sms', mergeData);
        smsBody = rendered?.body || '';
      }
      if (!smsBody) {
        smsBody = event === 'confirmed'
          ? `Thanks ${firstName}! Order #${ref} confirmed at ${venueName}. Total: ${mergeData.order_total}.`
          : `Hi ${firstName}, your order #${ref} is ready for collection at ${venueName}!`;
      }
      result.sms = await sendSmsViaFn(phone, smsBody, locationId, messageType);
    }
  }

  // ── Email (order_confirmation only — order_ready is SMS-only in the registry) ──
  if (email && event === 'confirmed') {
    const disabled = companyId ? await channelDisabled(companyId, messageType, 'email') : false;
    if (!disabled) {
      let subject = `Order #${ref} confirmed — ${venueName}`;
      let bodyText = '';
      if (companyId) {
        const rendered = await resolveAndRender(companyId, messageType, 'email', mergeData);
        if (rendered?.body) {
          subject = rendered.subject || subject;
          bodyText = rendered.body;
        }
      }
      if (!bodyText) {
        bodyText = `Hi ${firstName},\n\nYour order #${ref} at ${venueName} has been confirmed.\n\n${mergeData.order_items}\n\nOrder total: ${mergeData.order_total}\n\nThank you for your order!`;
      }
      const sender = await resolveSenderFrom(opsAdmin, locationId, EMAIL_FROM);
      result.email = await sendEmail(email, subject, wrapInEmailHtml(bodyText, { venueName }), sender);
    }
  }

  console.log('[order-notify]', { ref, event, source, ...result });
  return json({ ok: true, ...result });
});
