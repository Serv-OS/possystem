// supabase/functions/gift-fulfill/index.ts
//
// Called by stripe-webhook-connect on checkout.session.completed for gift
// card purchases, OR from back office "Manual Fulfill" button.
// Issues the card (generates code, hashes, creates card + ledger entry)
// and sends the delivery email.
//
// Body: { purchase_id }
// Auth: service-role key (webhook) OR user JWT (back office)
//
// Idempotent: if the purchase is already fulfilled, returns success without
// re-issuing. This protects against duplicate webhook deliveries.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { argon2id } from 'https://esm.sh/hash-wasm@4.11.0';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), {
    status: s,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });

const opsAdmin = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const platformAdmin = createClient(
  Deno.env.get('PLATFORM_SUPABASE_URL') ?? '',
  Deno.env.get('PLATFORM_SUPABASE_SERVICE_ROLE_KEY') ?? '',
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const OPS_URL = Deno.env.get('SUPABASE_URL') ?? '';
const OPS_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
// Customer-facing domain for links in emails (e.g. balance check URL).
// Set via Supabase secrets: CUSTOMER_DOMAIN=serv-os.app (prod) or dev.serv-os.app (dev)
const CUSTOMER_DOMAIN = Deno.env.get('CUSTOMER_DOMAIN') ?? 'serv-os.app';

// ── Code generation (same as gift-card-utils.ts) ───────────────────────────
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 16;

function generateCode(): string {
  const bytes = new Uint8Array(CODE_LENGTH);
  crypto.getRandomValues(bytes);
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) code += ALPHABET[bytes[i] % ALPHABET.length];
  return code;
}

function formatCode(code: string): string {
  const clean = code.replace(/\s/g, '').toUpperCase();
  return clean.match(/.{1,4}/g)?.join(' ') ?? clean;
}

function codeLast4(code: string): string {
  return code.slice(-4);
}

async function hmacLookup(code: string, hmacSecret: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(hmacSecret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(code));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function hashValue(value: string): Promise<string> {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  return await argon2id({
    password: value, salt, parallelism: 1,
    iterations: 3, memorySize: 16384, hashLength: 32, outputType: 'encoded',
  });
}

function generateHmacSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ── Email template ─────────────────────────────────────────────────────────
interface EmailBranding {
  logo_url?: string | null;
  background?: string;
  foreground?: string;
  accent_color?: string;
}

function buildGiftCardEmail(opts: {
  senderName: string; recipientName: string; message: string | null;
  code: string; amountFormatted: string; expiresAt: string | null;
  venueName: string; balanceUrl: string; branding?: EmailBranding | null;
}): string {
  const { senderName, recipientName, message, code, amountFormatted, expiresAt, venueName, balanceUrl } = opts;
  const b = opts.branding || {};
  const bg = b.background || '#0e0e10';
  const fg = b.foreground || '#ffffff';
  const accent = b.accent_color || '#E8743C';
  const logoUrl = b.logo_url || null;
  // Derive a subtle foreground for secondary text on the header
  const fgSub = fg === '#ffffff' ? 'rgba(255,255,255,0.6)' : 'rgba(0,0,0,0.5)';
  // Derive accent text colour (dark on light accent, white on dark)
  const accentText = isLightColor(accent) ? '#0b0c10' : '#ffffff';

  const expiryLine = expiresAt
    ? `<p style="color:#888;font-size:13px;">Valid until ${new Date(expiresAt).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}</p>`
    : '';
  const messageLine = message
    ? `<div style="background:#f8f5f0;border-radius:12px;padding:16px 20px;margin:16px 0;font-style:italic;color:#555;">"${message}"</div>`
    : '';
  const logoBlock = logoUrl
    ? `<img src="${logoUrl}" alt="${venueName}" style="max-width:160px;max-height:64px;margin-bottom:16px;" />`
    : `<div style="font-size:36px;margin-bottom:12px;">🎁</div>`;

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f6;font-family:system-ui,-apple-system,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f6;padding:40px 20px;">
<tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#fff;border-radius:16px;overflow:hidden;">
  <tr><td style="background:${bg};padding:32px 24px;text-align:center;">
    ${logoBlock}
    <div style="color:${fg};font-size:22px;font-weight:800;">You've received a gift card!</div>
    <div style="color:${fgSub};font-size:14px;margin-top:6px;">From ${senderName} at ${venueName}</div>
  </td></tr>
  <tr><td style="padding:28px 24px;">
    ${messageLine}
    <div style="text-align:center;margin:24px 0;">
      <div style="font-size:13px;color:#888;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:8px;">Gift Card Value</div>
      <div style="font-size:36px;font-weight:800;color:#0e0e10;">${amountFormatted}</div>
    </div>
    <div style="background:#f8f5f0;border-radius:12px;padding:20px;text-align:center;margin:20px 0;">
      <div style="font-size:12px;color:#888;font-weight:600;margin-bottom:8px;">YOUR GIFT CARD CODE</div>
      <div style="font-size:22px;font-weight:800;font-family:monospace;letter-spacing:0.1em;color:#0e0e10;">${code}</div>
      <div style="font-size:12px;color:#888;margin-top:8px;">Present this code when ordering</div>
    </div>
    ${expiryLine}
    <div style="text-align:center;margin-top:24px;">
      <a href="${balanceUrl}" style="display:inline-block;padding:12px 28px;background:${accent};color:${accentText};border-radius:99px;font-weight:800;font-size:14px;text-decoration:none;">Check Balance</a>
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

function buildSenderConfirmEmail(opts: {
  amountFormatted: string; venueName: string; recipientName: string;
  recipientEmail: string; last4: string; branding?: EmailBranding | null;
}): string {
  const { amountFormatted, venueName, recipientName, recipientEmail, last4 } = opts;
  const b = opts.branding || {};
  const bg = b.background || '#0e0e10';
  const fg = b.foreground || '#ffffff';
  const logoUrl = b.logo_url || null;
  const logoBlock = logoUrl
    ? `<img src="${logoUrl}" alt="${venueName}" style="max-width:120px;max-height:48px;margin-bottom:12px;" />`
    : `<div style="font-size:32px;margin-bottom:8px;">✅</div>`;

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f4f4f6;font-family:system-ui,-apple-system,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f6;padding:40px 20px;">
<tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#fff;border-radius:16px;overflow:hidden;">
  <tr><td style="background:${bg};padding:28px 24px;text-align:center;">
    ${logoBlock}
    <div style="color:${fg};font-size:18px;font-weight:800;">Gift card sent!</div>
  </td></tr>
  <tr><td style="padding:24px;">
    <p style="color:#333;font-size:14px;line-height:1.6;">
      Your <b>${amountFormatted}</b> gift card for <b>${venueName}</b> has been emailed to <b>${recipientName}</b> at ${recipientEmail}.
    </p>
    <p style="color:#888;font-size:13px;">Card ending in ····${last4}</p>
  </td></tr>
  <tr><td style="padding:16px 24px;border-top:1px solid #eee;text-align:center;">
    <div style="font-size:11px;color:#aaa;">Powered by serv-os.app</div>
  </td></tr>
</table>
</td></tr>
</table>
</body></html>`;
}

/** Quick luminance check — returns true if the colour is "light" */
function isLightColor(hex: string): boolean {
  const c = hex.replace('#', '');
  const r = parseInt(c.substring(0, 2), 16);
  const g = parseInt(c.substring(2, 4), 16);
  const b = parseInt(c.substring(4, 6), 16);
  return (r * 299 + g * 587 + b * 114) / 1000 > 128;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  // Auth: accept service_role key (webhook) OR user JWT (back office)
  const authHeader = req.headers.get('Authorization') || '';
  const token = authHeader.replace('Bearer ', '');
  let callerUserId: string | null = null;
  if (token === OPS_SERVICE_KEY) {
    // Internal call from webhook handler — trusted
  } else {
    // Try user JWT auth (back office manual fulfill)
    const { data: { user } } = await opsAdmin.auth.getUser(token);
    if (!user) {
      return json({ error: 'Unauthorized' }, 401);
    }
    callerUserId = user.id;
  }

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }

  const purchaseId = body.purchase_id as string;
  if (!purchaseId) return json({ error: 'purchase_id required' }, 400);

  // Look up the purchase
  const { data: purchase } = await platformAdmin
    .from('gift_card_purchases')
    .select('*')
    .eq('id', purchaseId)
    .maybeSingle();

  if (!purchase) return json({ error: 'Purchase not found' }, 404);

  // If called via user JWT, verify user has access to this company
  if (callerUserId) {
    const { data: loc } = await platformAdmin
      .from('locations')
      .select('company_id')
      .eq('id', purchase.location_id)
      .maybeSingle();
    if (!loc || loc.company_id !== purchase.company_id) {
      return json({ error: 'Location/company mismatch' }, 403);
    }
  }

  // Idempotent: already fulfilled
  if (purchase.status === 'fulfilled') {
    return json({ ok: true, already_fulfilled: true, card_id: purchase.gift_card_id });
  }

  // Get or create brand config
  let { data: config } = await platformAdmin
    .from('gift_brand_config')
    .select('*')
    .eq('company_id', purchase.company_id)
    .maybeSingle();

  if (!config) {
    const hmacSecret = generateHmacSecret();
    const { data: newConfig, error: cfgErr } = await platformAdmin
      .from('gift_brand_config')
      .insert({ company_id: purchase.company_id, enabled: true, hmac_secret: hmacSecret })
      .select().single();
    if (cfgErr) return json({ error: `Config creation failed: ${cfgErr.message}` }, 500);
    config = newConfig;
  }

  // Generate code + hashes
  const code = generateCode();
  const normalized = code.toUpperCase();
  const last4 = codeLast4(normalized);
  const [codeHash, lookup] = await Promise.all([
    hashValue(normalized),
    hmacLookup(normalized, config.hmac_secret),
  ]);

  // Check collision
  const { data: existing } = await platformAdmin
    .from('gift_cards')
    .select('id')
    .eq('code_lookup', lookup)
    .maybeSingle();
  if (existing) return json({ error: 'Code collision — please retry' }, 500);

  // Compute expiry from brand config
  let expiresAt: string | null = null;
  if (config.default_expiry_months) {
    const d = new Date();
    d.setMonth(d.getMonth() + config.default_expiry_months);
    expiresAt = d.toISOString();
  }

  // Insert card (store plaintext code for back-office voucher/resend)
  const { data: card, error: cardErr } = await platformAdmin
    .from('gift_cards')
    .insert({
      company_id: purchase.company_id,
      code_hash: codeHash,
      code_lookup: lookup,
      code_last4: last4,
      code_plain: normalized,
      initial_amount_minor: purchase.amount_minor,
      balance_minor: purchase.amount_minor,
      status: 'active',
      expires_at: expiresAt,
      recipient_name: purchase.recipient_name,
      recipient_email: purchase.recipient_email,
      note: purchase.message || null,
      source: 'online',
    })
    .select('id')
    .single();

  if (cardErr) {
    return json({ error: `Card creation failed: ${cardErr.message}` }, 500);
  }

  // Insert ledger entry
  const { error: txErr } = await platformAdmin
    .from('gift_card_transactions')
    .insert({
      card_id: card.id,
      company_id: purchase.company_id,
      type: 'issue',
      amount_minor: purchase.amount_minor,
      balance_after_minor: purchase.amount_minor,
      location_id: purchase.location_id,
      channel: 'online',
      note: `Online purchase by ${purchase.sender_name}`,
    });

  if (txErr) {
    await platformAdmin.from('gift_cards').delete().eq('id', card.id);
    return json({ error: `Ledger entry failed: ${txErr.message}` }, 500);
  }

  // Update purchase → fulfilled (store plaintext code for resend capability)
  await platformAdmin
    .from('gift_card_purchases')
    .update({
      status: 'fulfilled',
      gift_card_id: card.id,
      code_last4: last4,
      fulfilled_code: normalized,
      fulfilled_at: new Date().toISOString(),
    })
    .eq('id', purchaseId);

  // Send delivery email via send-receipt edge function
  const currency = (config.currency || 'gbp').toLowerCase();
  const sym = currency === 'usd' ? '$' : '£';
  const amountFormatted = `${sym}${(purchase.amount_minor / 100).toFixed(2)}`;

  // Resolve venue name from location
  let venueName = 'our venue';
  try {
    const { data: loc } = await platformAdmin
      .from('locations')
      .select('name, online_slug')
      .eq('id', purchase.location_id)
      .maybeSingle();
    if (loc?.name) venueName = loc.name;

    // Build balance check URL
    const slug = loc?.online_slug || '';
    const balanceUrl = slug
      ? `https://${slug}.${CUSTOMER_DOMAIN}/gift/balance`
      : '';

    const html = buildGiftCardEmail({
      senderName: purchase.sender_name,
      recipientName: purchase.recipient_name,
      message: purchase.message,
      code: formatCode(code),
      amountFormatted,
      expiresAt,
      venueName,
      balanceUrl,
      branding: config.branding || null,
    });

    // Call send-receipt on Ops DB
    await fetch(`${OPS_URL}/functions/v1/send-receipt`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPS_SERVICE_KEY}`,
      },
      body: JSON.stringify({
        location_id: purchase.location_id,
        to: purchase.recipient_email,
        subject: `${purchase.sender_name} sent you a ${amountFormatted} gift card for ${venueName}!`,
        html,
      }),
    });
  } catch (emailErr) {
    // Email failure is non-fatal — the card is still issued
    console.error('[gift-fulfill] email send failed:', emailErr);
  }

  // Also email the sender a confirmation if they bought for someone else
  if (purchase.delivery_type === 'email' && purchase.sender_email !== purchase.recipient_email) {
    try {
      const senderHtml = buildSenderConfirmEmail({
        amountFormatted,
        venueName,
        recipientName: purchase.recipient_name,
        recipientEmail: purchase.recipient_email,
        last4,
        branding: config.branding || null,
      });

      await fetch(`${OPS_URL}/functions/v1/send-receipt`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${OPS_SERVICE_KEY}`,
        },
        body: JSON.stringify({
          location_id: purchase.location_id,
          to: purchase.sender_email,
          subject: `Your gift card for ${purchase.recipient_name} at ${venueName} is on its way!`,
          html: senderHtml,
        }),
      });
    } catch { /* non-fatal */ }
  }

  return json({
    ok: true,
    card_id: card.id,
    code_last4: last4,
    // Include full code for back-office manual fulfillment display
    ...(callerUserId ? { code: formatCode(code) } : {}),
  });
});
