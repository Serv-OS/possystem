// send-welcome — Branded welcome SMS + email when a customer is first created.
//
// Called fire-and-forget from:
//   - loyalty-otp (new customer on first OTP login)
//   - customerLookup.js attributeOnlineOrder (new customer on first online order)
//
// Body: {
//   customer_id:  string  — ops customers.id
//   company_id:   string  — platform companies.id
//   location_id:  string  — ops locations.id (for slug + branding lookup)
// }
//
// Sends:
//   1. SMS with welcome message + portal signup link
//   2. Email (if customer has email) with branded HTML welcome
//
// v5.5.293: Now uses resolveAndRender() for customisable templates.
// Operators can edit these messages in Back Office → Messages → Loyalty.
//
// Deduplication: checks customers.welcome_sent_at — only sends once.
//
// Required secrets:
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER
//   OPS_SUPABASE_URL, OPS_SERVICE_KEY (ops DB)
//   PLATFORM_SUPABASE_URL, PLATFORM_SERVICE_KEY (platform DB)
//   CUSTOMER_DOMAIN (defaults to 'serv-os.app')
//   RECEIPT_EMAIL_PROVIDER, RESEND_API_KEY / POSTMARK_API_TOKEN (optional)
//   RECEIPT_EMAIL_FROM (defaults to 'hello@posup.co.uk')

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { resolveSenderFrom, callerCanBrandForLocation, type Sender } from '../_shared/sending-domain.ts';
import { resolveAndRender } from '../_shared/template-resolver.ts';
import { wrapInEmailHtml } from '../_shared/template-resolver.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const PLATFORM_URL = Deno.env.get('PLATFORM_SUPABASE_URL') ?? '';
const PLATFORM_KEY = Deno.env.get('PLATFORM_SERVICE_KEY') ?? '';
const CUSTOMER_DOMAIN = Deno.env.get('CUSTOMER_DOMAIN') ?? 'serv-os.app';

const TWILIO_SID = Deno.env.get('TWILIO_ACCOUNT_SID') ?? '';
const TWILIO_TOKEN = Deno.env.get('TWILIO_AUTH_TOKEN') ?? '';
const TWILIO_FROM = Deno.env.get('TWILIO_FROM_NUMBER') ?? '';

const EMAIL_PROVIDER = (Deno.env.get('RECEIPT_EMAIL_PROVIDER') || 'log').toLowerCase();
const EMAIL_FROM = Deno.env.get('RECEIPT_EMAIL_FROM') || 'hello@posup.co.uk';
const RESEND_KEY = Deno.env.get('RESEND_API_KEY') ?? '';
const POSTMARK_KEY = Deno.env.get('POSTMARK_API_TOKEN') ?? '';

const opsAdmin = createClient(SUPABASE_URL, SERVICE_ROLE);

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), {
    status: s,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });

// ── Phone normalization ──────────────────────────────────────────────
function toE164(phone: string): string {
  const clean = phone.replace(/\s/g, '');
  if (clean.startsWith('+')) return clean;
  if (clean.startsWith('0')) return '+44' + clean.slice(1);
  return '+' + clean;
}

// ── SMS via Twilio ───────────────────────────────────────────────────
async function sendSms(to: string, message: string): Promise<boolean> {
  if (!TWILIO_SID || !TWILIO_TOKEN || !TWILIO_FROM) return false;
  try {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + btoa(`${TWILIO_SID}:${TWILIO_TOKEN}`),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: to, From: TWILIO_FROM, Body: message }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ── Email via Resend / Postmark ──────────────────────────────────────
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
    // 'log' provider — just audit, no real send
    return false;
  } catch {
    return false;
  }
}

// ═════════════════════════════════════════════════════════════════════
// MAIN HANDLER
// ═════════════════════════════════════════════════════════════════════
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  let body: { customer_id: string; company_id: string; location_id: string };
  try { body = await req.json(); } catch { return json({ error: 'invalid JSON' }, 400); }

  const { customer_id, company_id, location_id } = body || {};
  if (!customer_id || !company_id || !location_id) {
    return json({ error: 'missing: customer_id, company_id, location_id' }, 400);
  }

  // ── 1. Atomic dedup: try to claim this customer's welcome slot ──────
  // Uses update-where-null pattern to prevent race conditions.
  const { data: claimed, error: claimErr } = await opsAdmin
    .from('customers')
    .update({ welcome_sent_at: new Date().toISOString() })
    .eq('id', customer_id)
    .is('welcome_sent_at', null)
    .select('id, name, phone, email')
    .maybeSingle();

  if (claimErr) return json({ error: claimErr.message }, 500);
  if (!claimed) return json({ skipped: true, reason: 'already sent or not found' });

  const customer = claimed;

  if (!customer.phone && !customer.email) {
    return json({ skipped: true, reason: 'no phone or email' });
  }

  // ── 2. Fetch venue info for branding ───────────────────────────────
  const { data: loc } = await opsAdmin
    .from('locations')
    .select('name, online_slug')
    .eq('id', location_id)
    .maybeSingle();

  const venueName = loc?.name || 'our venue';
  const slug = loc?.online_slug || '';
  const portalUrl = slug
    ? `https://${slug}.${CUSTOMER_DOMAIN}/account/register`
    : '';

  // ── 3. Build merge tag data ────────────────────────────────────────
  const firstName = customer.name ? customer.name.split(' ')[0] : '';
  const mergeData: Record<string, string> = {
    customer_name: firstName || 'there',
    venue_name: venueName,
    portal_url: portalUrl,
  };

  let smsSent = false;
  let emailSent = false;

  // ── 4. Send SMS (uses custom template if operator edited it) ───────
  if (customer.phone) {
    const e164 = toE164(customer.phone);

    // Resolve template: custom → default from message-types registry
    const rendered = await resolveAndRender(company_id, 'loyalty_welcome', 'sms', mergeData);
    const smsMsg = rendered?.body || `Hi ${firstName || 'there'}! Welcome to ${venueName}! You're now earning loyalty points on every order.`;

    smsSent = await sendSms(e164, smsMsg);

    // Audit log
    try {
      await opsAdmin.from('sms_messages').insert({
        location_id,
        to_phone: e164,
        message: smsMsg,
        type: 'welcome',
        reference_id: customer_id,
        status: smsSent ? 'sent' : 'failed',
      });
    } catch {}
  }

  // ── 5. Send email (uses custom template if operator edited it) ─────
  if (customer.email) {
    const rendered = await resolveAndRender(company_id, 'loyalty_welcome', 'email', mergeData);

    let subject: string;
    let html: string;

    if (rendered) {
      subject = rendered.subject || `Welcome to ${venueName}!`;
      html = wrapInEmailHtml(rendered.body, { venueName });
    } else {
      // Hardcoded fallback — should never hit if message-types.ts is up to date
      subject = `Welcome to ${venueName}!`;
      html = wrapInEmailHtml(
        `Hi ${firstName || 'there'},\n\nThanks for joining the ${venueName} loyalty programme! Earn points on every order, unlock rewards, and track gift cards.\n\n${portalUrl ? `View your account: ${portalUrl}` : ''}`,
        { venueName },
      );
    }

    // Branded From only for trusted callers (service-role / user with location access), else platform default.
    const branded = await callerCanBrandForLocation(req, opsAdmin, location_id, SERVICE_ROLE);
    const sender = await resolveSenderFrom(opsAdmin, branded ? location_id : null, EMAIL_FROM);
    emailSent = await sendEmail(customer.email, subject, html, sender);

    // Audit log
    try {
      await opsAdmin.from('receipt_emails').insert({
        location_id,
        to_email: customer.email,
        subject,
        status: emailSent ? 'sent' : 'failed',
        provider: EMAIL_PROVIDER,
      });
    } catch {}
  }

  return json({ sent: true, sms: smsSent, email: emailSent });
});
