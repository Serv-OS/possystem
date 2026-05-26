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
const platformAdmin = PLATFORM_URL && PLATFORM_KEY
  ? createClient(PLATFORM_URL, PLATFORM_KEY)
  : null;

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
async function sendEmail(to: string, subject: string, html: string): Promise<boolean> {
  try {
    if (EMAIL_PROVIDER === 'resend' && RESEND_KEY) {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: EMAIL_FROM, to: [to], subject, html }),
      });
      return res.ok;
    }
    if (EMAIL_PROVIDER === 'postmark' && POSTMARK_KEY) {
      const res = await fetch('https://api.postmarkapp.com/email', {
        method: 'POST',
        headers: { 'X-Postmark-Server-Token': POSTMARK_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ From: EMAIL_FROM, To: to, Subject: subject, HtmlBody: html }),
      });
      return res.ok;
    }
    // 'log' provider — just audit, no real send
    return false;
  } catch {
    return false;
  }
}

// ── Welcome email HTML ───────────────────────────────────────────────
function buildWelcomeEmail(venueName: string, portalUrl: string, customerName?: string): string {
  const greeting = customerName ? `Hi ${customerName},` : 'Welcome!';
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f6;font-family:system-ui,-apple-system,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f6;padding:40px 20px;">
<tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#fff;border-radius:16px;overflow:hidden;">
  <tr><td style="background:#0e0e10;padding:32px 24px;text-align:center;">
    <div style="font-size:40px;margin-bottom:12px;">&#11088;</div>
    <div style="color:#fff;font-size:22px;font-weight:800;">Welcome to ${venueName}!</div>
    <div style="color:#aaa;font-size:14px;margin-top:6px;">Your loyalty account is ready</div>
  </td></tr>
  <tr><td style="padding:28px 24px;">
    <div style="font-size:16px;color:#333;line-height:1.6;">
      ${greeting}<br><br>
      Thanks for joining the <b>${venueName}</b> loyalty programme! You can now earn points every time you order, unlock exclusive rewards, and track your gift cards — all in one place.
    </div>
    <div style="text-align:center;margin:28px 0;">
      <a href="${portalUrl}" style="display:inline-block;padding:14px 32px;background:#E8743C;color:#fff;border-radius:99px;font-weight:800;font-size:15px;text-decoration:none;">View your loyalty account</a>
    </div>
    <div style="font-size:13px;color:#888;line-height:1.6;text-align:center;">
      Earn points on every order &bull; Redeem rewards &bull; Birthday treats &bull; Gift card balance
    </div>
  </td></tr>
  <tr><td style="padding:16px 24px;border-top:1px solid #eee;text-align:center;">
    <div style="font-size:11px;color:#aaa;">Powered by serv-os.app</div>
  </td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
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

  let smsSent = false;
  let emailSent = false;

  // ── 4. Send SMS ────────────────────────────────────────────────────
  if (customer.phone) {
    const e164 = toE164(customer.phone);
    const firstName = customer.name ? customer.name.split(' ')[0] : '';
    const greeting = firstName ? `Hi ${firstName}! ` : '';
    const link = portalUrl ? `\n\nView your account: ${portalUrl}` : '';
    const smsMsg = `${greeting}Welcome to ${venueName}! You're now earning loyalty points on every order. Earn rewards, track gift cards, and more.${link}`;

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

  // ── 5. Send email ──────────────────────────────────────────────────
  if (customer.email) {
    const html = buildWelcomeEmail(
      venueName,
      portalUrl,
      customer.name?.split(' ')[0] || undefined,
    );
    emailSent = await sendEmail(
      customer.email,
      `Welcome to ${venueName}!`,
      html,
    );

    // Audit log
    try {
      await opsAdmin.from('receipt_emails').insert({
        location_id,
        to_email: customer.email,
        subject: `Welcome to ${venueName}!`,
        status: emailSent ? 'sent' : 'failed',
        provider: EMAIL_PROVIDER,
      });
    } catch {}
  }

  return json({ sent: true, sms: smsSent, email: emailSent });
});
