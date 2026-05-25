// supabase/functions/gift-resend/index.ts
//
// v5.5.198: Re-send the gift card delivery email to the recipient.
//
// Called from the back office when an original email failed to deliver or
// the operator needs to resend. Reads the plaintext code from the
// gift_card_purchases.fulfilled_code column (stored at fulfillment time).
//
// Body: { card_id }
//
// Auth: Supabase Auth (back office user must belong to the card's company)
//
// For manually-issued cards (no purchase record), the code is not stored
// and cannot be resent — returns an error explaining this.

import {
  cors, json, platformAdmin, authenticateCaller, resolveCompanyForLocation,
} from '../_shared/gift-card-utils.ts';

const OPS_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const CUSTOMER_DOMAIN = Deno.env.get('CUSTOMER_DOMAIN') ?? 'serv-os.app';

// ── Format code into groups of 4 ─────────────────────────────────────────
function formatCode(code: string): string {
  const clean = code.replace(/\s/g, '').toUpperCase();
  return clean.match(/.{1,4}/g)?.join(' ') ?? clean;
}

// ── Build the gift card email HTML ────────────────────────────────────────
function buildGiftCardEmail(opts: {
  senderName: string; recipientName: string; message: string | null;
  code: string; amountFormatted: string; expiresAt: string | null;
  venueName: string; balanceUrl: string;
}): string {
  const { senderName, recipientName, message, code, amountFormatted, expiresAt, venueName, balanceUrl } = opts;
  const expiryLine = expiresAt
    ? `<p style="color:#888;font-size:13px;">Valid until ${new Date(expiresAt).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}</p>`
    : '';
  const messageLine = message
    ? `<div style="background:#f8f5f0;border-radius:12px;padding:16px 20px;margin:16px 0;font-style:italic;color:#555;">"${message}"</div>`
    : '';

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f6;font-family:system-ui,-apple-system,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f6;padding:40px 20px;">
<tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#fff;border-radius:16px;overflow:hidden;">
  <tr><td style="background:#0e0e10;padding:32px 24px;text-align:center;">
    <div style="font-size:40px;margin-bottom:12px;">&#127873;</div>
    <div style="color:#fff;font-size:22px;font-weight:800;">You've received a gift card!</div>
    <div style="color:#aaa;font-size:14px;margin-top:6px;">From ${senderName} at ${venueName}</div>
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
      <a href="${balanceUrl}" style="display:inline-block;padding:12px 28px;background:#E8743C;color:#0b0c10;border-radius:99px;font-weight:800;font-size:14px;text-decoration:none;">Check Balance</a>
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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  // Auth — back office user
  const authResult = await authenticateCaller(req);
  if (authResult instanceof Response) return authResult;
  const caller = authResult.user;

  // Parse body
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }

  // v5.5.207: resolve company via location_id (reliable) with user fallback
  const companyResult = await resolveCompanyForLocation(caller.id, body.location_id as string);
  if (companyResult instanceof Response) return companyResult;
  const companyId = companyResult;

  const cardId = body.card_id as string;
  if (!cardId) return json({ error: 'card_id required' }, 400);

  // Look up the card
  const { data: card } = await platformAdmin
    .from('gift_cards')
    .select('id, company_id, code_last4, initial_amount_minor, balance_minor, status, expires_at, issued_at, recipient_name, recipient_email, note')
    .eq('id', cardId)
    .eq('company_id', companyId)
    .maybeSingle();

  if (!card) return json({ error: 'Card not found' }, 404);
  if (!card.recipient_email) return json({ error: 'No recipient email on this card' }, 400);

  // Find the purchase record that has the plaintext code
  const { data: purchase } = await platformAdmin
    .from('gift_card_purchases')
    .select('id, fulfilled_code, sender_name, sender_email, recipient_name, recipient_email, message, amount_minor, location_id, currency')
    .eq('gift_card_id', cardId)
    .eq('company_id', companyId)
    .maybeSingle();

  if (!purchase) {
    return json({
      error: 'This card was issued manually (not via online purchase). The code cannot be resent because it is not stored after issuance. For manually issued cards, note the code at the time of issue.',
    }, 400);
  }

  if (!purchase.fulfilled_code) {
    return json({
      error: 'No code stored for this purchase. The card was issued before the resend feature was added. You will need to void this card and issue a new one.',
    }, 400);
  }

  // Get brand config for currency
  const { data: config } = await platformAdmin
    .from('gift_brand_config')
    .select('currency')
    .eq('company_id', companyId)
    .maybeSingle();

  const currency = (config?.currency || purchase.currency || 'gbp').toLowerCase();
  const sym = currency === 'usd' ? '$' : '£';
  const amountFormatted = `${sym}${(card.initial_amount_minor / 100).toFixed(2)}`;

  // Resolve venue name + slug from location
  let venueName = 'our venue';
  let balanceUrl = '';
  try {
    const { data: loc } = await platformAdmin
      .from('locations')
      .select('name, online_slug')
      .eq('id', purchase.location_id)
      .maybeSingle();
    if (loc?.name) venueName = loc.name;
    const slug = loc?.online_slug || '';
    balanceUrl = slug ? `https://${slug}.${CUSTOMER_DOMAIN}/gift/balance` : '';
  } catch { /* fallback to defaults */ }

  // Build email
  const html = buildGiftCardEmail({
    senderName: purchase.sender_name || 'Someone',
    recipientName: card.recipient_name || purchase.recipient_name || 'there',
    message: purchase.message || card.note || null,
    code: formatCode(purchase.fulfilled_code),
    amountFormatted,
    expiresAt: card.expires_at,
    venueName,
    balanceUrl,
  });

  // Send via send-receipt edge function on Ops DB
  const OPS_URL = Deno.env.get('SUPABASE_URL') ?? '';
  try {
    const emailRes = await fetch(`${OPS_URL}/functions/v1/send-receipt`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPS_SERVICE_KEY}`,
      },
      body: JSON.stringify({
        location_id: purchase.location_id,
        to: card.recipient_email,
        subject: `${purchase.sender_name || 'Someone'} sent you a ${amountFormatted} gift card for ${venueName}!`,
        html,
      }),
    });

    if (!emailRes.ok) {
      const errBody = await emailRes.text().catch(() => '');
      console.error('[gift-resend] email send failed:', emailRes.status, errBody);
      return json({ error: `Email send failed (HTTP ${emailRes.status})` }, 502);
    }
  } catch (err) {
    console.error('[gift-resend] email send error:', err);
    return json({ error: `Email send failed: ${err.message}` }, 502);
  }

  return json({ ok: true, sent_to: card.recipient_email });
});
