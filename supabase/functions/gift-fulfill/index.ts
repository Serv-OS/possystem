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
//
// Database fence stage 1 (19 Sep 2026, enforced always; first built on the parked lockdown
// branch). This used to issue a card for ANY purchase_id, paid or not, to any session, and hand a
// signed in caller the code; gift-checkout-session hands the purchase_id out before payment. Now:
//   * callers: the service role (stripe-webhook-connect, ryft-webhook) or staff for the
//     purchase's venue (Back Office "Fulfill"). Anybody else: 401/403 before anything happens.
//   * payment is proven by the PROCESSOR for every caller: the Stripe checkout session or the
//     Ryft payment session named on the purchase is fetched by id and must be paid (Stripe
//     'paid', Ryft 'Captured'), carry this purchase id in its metadata and cover the amount in
//     the purchase currency (_shared/giftPurchaseProof.ts). The purchase row is NOT proof: it is
//     writable with the Platform anon key until 20260919c (Platform file C) runs. Unproven:
//     402 payment_not_proven, nothing issued. Adyen has no online gift purchase flow, so it is
//     refused as unverifiable.
//   * one issuer: the row is claimed ('fulfilling') before a card is made, released on failure.
//   * the code is returned only to staff (Back Office shows it); the webhook gets last 4.
//
// 18 Sep 2026 (lockdown step 1, review item e):
//   * ONE card per purchase, whatever happens: the card's id is derived from the purchase id
//     (_shared/giftFulfilPlan.ts purchaseCardId), so a retry after a killed isolate or a stale
//     claim takeover finds the card already issued and finishes with it; the issue ledger row
//     has a fixed idempotency key. A second card can never be made for the same money.
//   * a processor outage is retryable: 503 { retryable: true } (the webhooks then make Stripe or
//     Ryft send the event again); a real "not paid" is still a final 402.
//   * the plaintext code is no longer copied onto gift_card_purchases (code_last4 only). It
//     lives on the card (gift_cards.code_plain, service role only).
//   * the buyer's CRM link reads the org from the Ops location (Platform locations has no org_id).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { argon2id } from 'https://esm.sh/hash-wasm@4.11.0';
import { secondStepRefusal } from '../_shared/second-step.ts';
import Stripe from 'https://esm.sh/stripe@14.21.0?target=denonext';
import { getPaymentSession } from '../_shared/ryft.ts';
import { callerIsStaffFor, recordAuthority } from '../_shared/loyalty-utils.ts';
import { authorityLogRow } from '../_shared/loyalty-authority.ts';
import { decideGiftFulfilAuthority } from '../_shared/gift-authority.ts';
import {
  stripeSessionProvesPurchase, ryftSessionProvesPurchase, purchaseProcessor, type ProofResult,
} from '../_shared/giftPurchaseProof.ts';
import {
  purchaseCardId, issueLedgerKey, proofReasonRetryable, processorErrorReason,
} from '../_shared/giftFulfilPlan.ts';

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

// ── Payment proof: ask the processor (round three) ─────────────────────────
async function provePurchasePaid(purchase: any): Promise<ProofResult> {
  const processor = purchaseProcessor(purchase);
  try {
    if (processor === 'stripe') {
      const secret = Deno.env.get('STRIPE_SECRET_KEY') ?? '';
      if (!secret) return { ok: false, reason: 'stripe_not_configured' };
      if (!purchase.stripe_session_id) return { ok: false, reason: 'no_processor_session' };
      // The venue's connected account, read from OUR table by the purchase's venue, never from
      // the (anon writable) purchase row: a session on some other account proves nothing here.
      const { data: msa } = await platformAdmin
        .from('merchant_stripe_accounts').select('stripe_account_id').eq('location_id', purchase.location_id).maybeSingle();
      if (!msa?.stripe_account_id) return { ok: false, reason: 'no_merchant_account' };
      const stripe = new Stripe(secret, { apiVersion: '2024-06-20' });
      const session = await stripe.checkout.sessions.retrieve(
        String(purchase.stripe_session_id),
        { stripeAccount: String(msa.stripe_account_id) },
      );
      return stripeSessionProvesPurchase(session, purchase);
    }
    if (processor === 'ryft') {
      if (!purchase.ryft_payment_session_id) return { ok: false, reason: 'no_processor_session' };
      // The venue's sub account, read from OUR table by the purchase's venue (never from the row).
      const { data: mra } = await platformAdmin
        .from('merchant_ryft_accounts').select('ryft_account_id').eq('location_id', purchase.location_id).maybeSingle();
      const got = await getPaymentSession(String(purchase.ryft_payment_session_id), mra?.ryft_account_id ? { accountId: mra.ryft_account_id } : {});
      if (!got.ok) return { ok: false, reason: `ryft_${got.status}` };
      return ryftSessionProvesPurchase(got.data, purchase);
    }
    return { ok: false, reason: 'processor_unverifiable' };
  } catch (e) {
    // An outage (network, 5xx, rate limit) is retryable; the processor refusing THIS request
    // (unknown session, wrong account) is final. See giftFulfilPlan.processorErrorReason.
    console.warn('[gift-fulfill] processor check failed:', (e as Error)?.message || e);
    return { ok: false, reason: processorErrorReason(e) };
  }
}

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
  const secondStepBlock = await secondStepRefusal(req); if (secondStepBlock) return secondStepBlock; // docs/SECOND_STEP.md
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  // Auth: accept service_role key (webhook) OR user JWT (back office)
  const authHeader = req.headers.get('Authorization') || '';
  const token = authHeader.replace('Bearer ', '');
  let callerUserId: string | null = null;
  let caller: any = null;
  const serviceRole = !!OPS_SERVICE_KEY && token === OPS_SERVICE_KEY;
  if (!serviceRole) {
    // Try user JWT auth (back office manual fulfill)
    const { data: { user } } = await opsAdmin.auth.getUser(token);
    if (!user) {
      return json({ error: 'Unauthorized' }, 401);
    }
    caller = user;
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

  // The purchase's company must be its venue's company, for EVERY caller (round three: the row
  // is anon writable, so a forged company_id must never get a card issued in another company).
  {
    const { data: loc } = await platformAdmin
      .from('locations')
      .select('company_id')
      .eq('id', purchase.location_id)
      .maybeSingle();
    if (!loc || loc.company_id !== purchase.company_id) {
      return json({ error: 'Location/company mismatch' }, 403);
    }
  }

  // ── Who may fulfil (18 Sep 2026, round three, enforced now) ────────────
  // Any session used to fulfil any purchase here and, as a signed in caller, be handed the code.
  // Callers: the processor webhooks (service role) and Back Office "Fulfill" (staff for the
  // purchase's venue, the database's access rule). Everybody else is refused.
  const staff = serviceRole ? false : await callerIsStaffFor(caller, String(purchase.location_id), String(purchase.company_id));
  const who = decideGiftFulfilAuthority({ serviceRole, user: caller, staff });
  if (!who.ok) {
    recordAuthority(authorityLogRow({
      fn: 'gift-fulfill', mode: 'enforce', outcome: 'refused',
      decision: { ok: false, reason: who.reason, callerKind: caller?.is_anonymous ? 'anonymous' : 'user_no_access' },
      user: caller, companyId: purchase.company_id, locationId: purchase.location_id,
    }));
    return json({ error: who.error, code: 'gift_fulfil_not_allowed', reason: who.reason }, who.status);
  }

  // Idempotent: already fulfilled
  if (purchase.status === 'fulfilled') {
    return json({ ok: true, already_fulfilled: true, card_id: purchase.gift_card_id });
  }

  // ── Payment proof (round three): asked of the PROCESSOR for every caller ──
  // gift_card_purchases can be written with the Platform anon key today, so its status, amount
  // and session ids prove nothing. The processor's own session, fetched by id, must say the money
  // was taken, carry THIS purchase id, and cover the amount (_shared/giftPurchaseProof.ts).
  const proof = await provePurchasePaid(purchase);
  if (!proof.ok) {
    console.warn('[gift-fulfill] payment not proven; NOT issuing', purchase.id, proof.reason);
    recordAuthority(authorityLogRow({
      fn: 'gift-fulfill', mode: 'enforce', outcome: 'refused',
      decision: { ok: false, reason: `payment_${proof.reason}`, callerKind: serviceRole ? 'service' : 'staff' },
      user: caller, companyId: purchase.company_id, locationId: purchase.location_id,
      detail: { purchase_id: purchase.id, processor: purchase.processor ?? null },
    }));
    // Lockdown step 1 (e): the processor could not be ASKED (outage). Nothing is issued, and the
    // answer says "try again" so the webhook makes Stripe or Ryft send the event again.
    if (proofReasonRetryable(proof.reason)) {
      return json({
        error: 'The card processor could not be reached to confirm this payment. It will be tried again.',
        code: 'processor_unavailable', reason: proof.reason, retryable: true,
      }, 503);
    }
    return json({
      error: 'The payment for this gift card has not been confirmed by the card processor, so no card was issued.',
      code: 'payment_not_proven', reason: proof.reason,
    }, 402);
  }

  // ── One issuer: claim the purchase before issuing ───────────────────────
  // The webhook and a Back Office "Fulfill" could both get here (the old idempotency was a read,
  // not a claim, so both issued a card). Only the caller that moves the row to 'fulfilling' goes
  // on. A claim older than 10 minutes (a crashed attempt) may be taken over.
  const claimedAt = new Date().toISOString();
  let { data: claimed } = await platformAdmin
    .from('gift_card_purchases')
    .update({ status: 'fulfilling', updated_at: claimedAt })
    .eq('id', purchaseId)
    .in('status', ['pending', 'paid'])
    .select('id');
  if (!claimed?.length) {
    const { data: now } = await platformAdmin.from('gift_card_purchases').select('status, updated_at, gift_card_id').eq('id', purchaseId).maybeSingle();
    if (now?.status === 'fulfilled') return json({ ok: true, already_fulfilled: true, card_id: now.gift_card_id });
    const stale = now?.status === 'fulfilling' && now.updated_at && (Date.now() - Date.parse(now.updated_at)) > 10 * 60 * 1000;
    if (stale) {
      ({ data: claimed } = await platformAdmin
        .from('gift_card_purchases')
        .update({ status: 'fulfilling', updated_at: claimedAt })
        .eq('id', purchaseId)
        .eq('status', 'fulfilling')
        .eq('updated_at', now.updated_at)
        .select('id'));
    }
    if (!claimed?.length) return json({ error: 'This purchase is already being fulfilled. Refresh in a minute.', code: 'fulfil_in_progress' }, 409);
  }
  // Put the claim back on any failure below, so the next attempt can finish the job.
  const releaseClaim = () => platformAdmin.from('gift_card_purchases')
    .update({ status: 'paid', updated_at: new Date().toISOString() })
    .eq('id', purchaseId).eq('status', 'fulfilling');

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
    if (cfgErr) { await releaseClaim(); return json({ error: `Config creation failed: ${cfgErr.message}` }, 500); }
    config = newConfig;
  }

  // ── One card per purchase (lockdown step 1, e) ──────────────────────────
  // The card id is derived from the purchase id, so the gift_cards primary key allows exactly one
  // card for this purchase. An earlier attempt that died after inserting the card (before the
  // purchase said 'fulfilled') left it here: finish the job with THAT card, never issue another.
  // No email has gone out for it yet (the email is sent only after the purchase is marked).
  const cardId = await purchaseCardId(purchase.id);
  const cardCols = 'id, code_plain, code_last4, expires_at';
  let { data: card } = await platformAdmin.from('gift_cards').select(cardCols).eq('id', cardId).maybeSingle();
  let issuedNow = false;

  if (!card) {
    // Generate code + hashes
    const code = generateCode();
    const normalized = code.toUpperCase();
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
    if (existing) { await releaseClaim(); return json({ error: 'Code collision, please retry', retryable: true }, 500); }

    // Compute expiry from brand config
    let expiresAt: string | null = null;
    if (config.default_expiry_months) {
      const d = new Date();
      d.setMonth(d.getMonth() + config.default_expiry_months);
      expiresAt = d.toISOString();
    }

    // Insert card, with the purchase's own card id. The plaintext code stays on the card only
    // (service role reads it for Back Office voucher and resend).
    // v5.5.220: recipient_phone set from sender_phone (self-purchase links to buyer)
    const { data: inserted, error: cardErr } = await platformAdmin
      .from('gift_cards')
      .insert({
        id: cardId,
        company_id: purchase.company_id,
        code_hash: codeHash,
        code_lookup: lookup,
        code_last4: codeLast4(normalized),
        code_plain: normalized,
        initial_amount_minor: purchase.amount_minor,
        balance_minor: purchase.amount_minor,
        status: 'active',
        expires_at: expiresAt,
        recipient_name: purchase.recipient_name,
        recipient_email: purchase.recipient_email,
        recipient_phone: purchase.sender_phone || null,
        note: purchase.message || null,
        source: 'online',
      })
      .select(cardCols)
      .single();

    if (cardErr) {
      // A racing attempt inserted this purchase's card first: use it.
      if (cardErr.code === '23505') {
        ({ data: card } = await platformAdmin.from('gift_cards').select(cardCols).eq('id', cardId).maybeSingle());
      }
      if (!card) { await releaseClaim(); return json({ error: `Card creation failed: ${cardErr.message}`, retryable: true }, 500); }
    } else {
      card = inserted;
      issuedNow = true;
    }
  }

  const normalized = String(card.code_plain || '').toUpperCase();
  const last4 = card.code_last4 || codeLast4(normalized);
  const expiresAt: string | null = card.expires_at ?? null;

  // Ledger entry, once per purchase (fixed idempotency key; a retry's duplicate is fine).
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
      idempotency_key: issueLedgerKey(purchase.id),
      note: `Online purchase by ${purchase.sender_name}`,
    });

  if (txErr && txErr.code !== '23505') {
    // Nothing has been emailed for this card, so taking it back is safe; the next attempt
    // recreates it under the same id.
    await platformAdmin.from('gift_cards').delete().eq('id', card.id);
    await releaseClaim(); return json({ error: `Ledger entry failed: ${txErr.message}`, retryable: true }, 500);
  }

  // Update purchase -> fulfilled. code_last4 only: the plaintext code is no longer copied here.
  const { error: doneErr } = await platformAdmin
    .from('gift_card_purchases')
    .update({
      status: 'fulfilled',
      gift_card_id: card.id,
      code_last4: last4,
      fulfilled_at: new Date().toISOString(),
    })
    .eq('id', purchaseId);
  if (doneErr) {
    // The card is issued and stays; the next attempt adopts it by id and finishes here.
    await releaseClaim();
    return json({ error: `Could not mark the purchase fulfilled: ${doneErr.message}`, retryable: true }, 503);
  }
  if (!issuedNow) console.log('[gift-fulfill] finished an earlier attempt with its own card', purchase.id, card.id);

  // v5.5.220: Create/link customer profile for the sender so the purchase
  // shows up in CRM and loyalty. Fire-and-forget — never block card issuance.
  if (purchase.sender_phone) {
    (async () => {
      try {
        const phoneN = normalisePhone(purchase.sender_phone);
        if (!phoneN) return;

        // Resolve org_id from the venue's OPS row (Platform locations has no org_id column, so
        // the old read here always failed and no buyer was ever linked).
        const { data: pl } = await platformAdmin
          .from('locations')
          .select('ops_location_id')
          .eq('id', purchase.location_id)
          .maybeSingle();
        if (!pl?.ops_location_id) return;
        const { data: locRow } = await opsAdmin
          .from('locations')
          .select('id, org_id')
          .eq('id', pl.ops_location_id)
          .maybeSingle();
        if (!locRow?.org_id) return;

        // Upsert customer by phone in ops DB
        const { data: existing } = await opsAdmin
          .from('customers')
          .select('id')
          .eq('org_id', locRow.org_id)
          .eq('phone', phoneN)
          .is('deleted_at', null)
          .maybeSingle();

        let customerId: string;
        if (existing) {
          customerId = existing.id;
          // Update name/email if they're blank
          await opsAdmin.from('customers')
            .update({
              name: purchase.sender_name,
              ...(purchase.sender_email ? { email: purchase.sender_email } : {}),
            })
            .eq('id', customerId)
            .is('name', null); // only update if name was null
        } else {
          const { data: newCust } = await opsAdmin
            .from('customers')
            .insert({
              org_id: locRow.org_id,
              name: purchase.sender_name,
              email: purchase.sender_email || null,
              phone: phoneN,
            })
            .select('id')
            .single();
          if (!newCust) return;
          customerId = newCust.id;
        }

        // Upsert customer_locations junction
        await opsAdmin.from('customer_locations')
          .upsert({
            customer_id: customerId,
            location_id: locRow.id,
          }, { onConflict: 'customer_id,location_id' });

        console.log('[gift-fulfill] customer linked:', customerId, phoneN);
      } catch (e) {
        console.warn('[gift-fulfill] customer link failed (non-fatal):', e);
      }
    })();
  }

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
      code: formatCode(normalized),
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
    ...(callerUserId ? { code: formatCode(normalized) } : {}),
  });
});

// ── Phone normalisation ──────────────────────────────────────────────────
function normalisePhone(raw: string): string | null {
  if (!raw) return null;
  const digits = String(raw).replace(/[^\d+]/g, '');
  if (!digits) return null;
  if (digits.startsWith('+')) return digits;
  if (digits.startsWith('07') && digits.length === 11) return '+44' + digits.slice(1);
  if (digits.startsWith('44')) return '+' + digits;
  return digits;
}
